/**
 * Envio de mensagens e gestão de modelos (templates) pela WhatsApp Cloud API.
 * Usa o token de Usuário do sistema cadastrado em /admin › WhatsApp.
 */

import { waConfig, graph } from "./whatsapp.js";
import { precoAtual } from "./products.js";

const reais = (v) => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

// Tipos aceitos pelo WhatsApp e limites de tamanho (MB)
const TIPOS_MIDIA = {
  "image/jpeg": ["image", "imagem", 5], "image/png": ["image", "imagem", 5],
  "video/mp4": ["video", "vídeo", 16], "video/3gpp": ["video", "vídeo", 16],
  "application/pdf": ["document", "documento", 100]
};

class ApiError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

async function requireConfig(env) {
  const cfg = await waConfig(env);
  if (!cfg.apiToken) throw new ApiError("sem_token_envio", "Cadastre o token permanente (Usuário do sistema) em WhatsApp.");
  if (!cfg.phoneNumberId || !cfg.wabaId) throw new ApiError("whatsapp_nao_configurado", "Conecte o número do WhatsApp primeiro.");
  return cfg;
}

const within24h = (iso) => !!iso && Date.now() - new Date(iso).getTime() < 24 * 3600 * 1000;

/** Envia texto livre (dentro da janela de 24h) ou um modelo aprovado para o lead. */
export async function sendToLead(env, lead, body, user, logEvent) {
  const cfg = await requireConfig(env);
  let payload, resumo;

  if (body.template) {
    const params = Array.isArray(body.params) ? body.params.map((t) => String(t ?? "").slice(0, 1000)) : [];
    payload = {
      messaging_product: "whatsapp",
      to: lead.whatsapp,
      type: "template",
      template: {
        name: String(body.template),
        language: { code: String(body.language || "pt_BR") },
        ...(params.length ? { components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] } : {})
      }
    };
    resumo = `[modelo ${body.template}] ` + (body.preview ? String(body.preview).slice(0, 900) : params.join(" · "));
  } else if (body.produto) {
    if (!within24h(lead.last_inbound_at)) throw new ApiError("fora_da_janela_24h",
      "O cliente não mandou mensagem nas últimas 24h. Pela regra do WhatsApp, use um modelo aprovado.");
    const p = await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(String(body.produto)).first();
    if (!p) throw new ApiError("produto_nao_encontrado", "Produto não encontrado no catálogo.");
    const { preco, de } = precoAtual(p);
    const legenda = [p.nome, preco ? (de ? `De ${reais(de)} por ${reais(preco)}` : reais(preco)) : "", p.url || ""].filter(Boolean).join("\n");
    const foto = (JSON.parse(p.imagens || "[]") || []).find((u) => /^https:\/\//.test(u));
    payload = foto
      ? { messaging_product: "whatsapp", to: lead.whatsapp, type: "image", image: { link: foto, caption: legenda.slice(0, 1024) } }
      : { messaging_product: "whatsapp", to: lead.whatsapp, type: "text", text: { preview_url: true, body: legenda } };
    resumo = (foto ? "[foto do produto] " : "") + legenda;
  } else {
    const text = String(body.text || "").trim().slice(0, 4096);
    if (!text) throw new ApiError("mensagem_vazia");
    if (!within24h(lead.last_inbound_at)) throw new ApiError("fora_da_janela_24h",
      "O cliente não mandou mensagem nas últimas 24h. Pela regra do WhatsApp, use um modelo aprovado.");
    payload = { messaging_product: "whatsapp", recipient_type: "individual", to: lead.whatsapp, type: "text", text: { preview_url: false, body: text } };
    resumo = text;
  }

  return enviar(env, cfg, lead, payload, resumo, user, logEvent);
}

/** Envia o payload pela Cloud API e registra no lead (histórico, último envio, etapa). */
async function enviar(env, cfg, lead, payload, resumo, user, logEvent) {
  const r = await graph(`/${cfg.phoneNumberId}/messages`, { method: "POST", token: cfg.apiToken, json: payload });
  const msgId = r.messages?.[0]?.id || null;
  const at = new Date().toISOString();
  const stmts = [
    env.DB.prepare("UPDATE leads SET last_outbound_at = ?, first_contact_at = COALESCE(first_contact_at, ?), updated_at = ? WHERE id = ?").bind(at, at, at, lead.id)
  ];
  if (msgId) stmts.push(env.DB.prepare("INSERT OR IGNORE INTO wa_messages (id, lead_id, direction) VALUES (?, ?, 'out')").bind(msgId, lead.id));
  await env.DB.batch(stmts);
  await logEvent(env, lead.id, "whatsapp_out", resumo + " (enviado pelo CRM)", user);

  if (lead.pipeline === "vendas" && lead.stage === "novo") {
    await env.DB.prepare("UPDATE leads SET stage = 'atendimento', stage_changed_at = ? WHERE id = ?").bind(at, lead.id).run();
    await logEvent(env, lead.id, "etapa", "Novo lead → Em atendimento (mensagem enviada pelo CRM)", user);
  }
  return { id: msgId };
}

export async function listTemplates(env) {
  const cfg = await requireConfig(env);
  const r = await graph(`/${cfg.wabaId}/message_templates?fields=name,status,category,language,components,rejected_reason&limit=200`, { token: cfg.apiToken });
  return (r.data || []).map((t) => {
    const body = (t.components || []).find((c) => c.type === "BODY");
    return {
      name: t.name, status: t.status, category: t.category, language: t.language,
      body: body?.text || "", vars: ((body?.text || "").match(/\{\{\d+\}\}/g) || []).length,
      footer: (t.components || []).find((c) => c.type === "FOOTER")?.text || "",
      rejected_reason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null
    };
  });
}

export async function createTemplate(env, body) {
  const cfg = await requireConfig(env);
  const name = String(body.name || "").trim().toLowerCase();
  if (!/^[a-z0-9_]{1,512}$/.test(name)) throw new ApiError("nome_modelo_invalido", "Use só letras minúsculas, números e _ no nome.");
  const category = ["MARKETING", "UTILITY"].includes(body.category) ? body.category : "MARKETING";
  const text = String(body.body || "").trim();
  if (!text) throw new ApiError("texto_modelo_vazio");
  const vars = (text.match(/\{\{\d+\}\}/g) || []).length;
  const examples = Array.isArray(body.examples) ? body.examples.map(String) : [];
  if (vars && examples.filter(Boolean).length < vars) throw new ApiError("exemplos_faltando", "Preencha um exemplo para cada variável {{n}}.");

  const components = [{ type: "BODY", text, ...(vars ? { example: { body_text: [examples.slice(0, vars)] } } : {}) }];
  const footer = String(body.footer || "").trim();
  if (footer) components.push({ type: "FOOTER", text: footer.slice(0, 60) });

  const r = await graph(`/${cfg.wabaId}/message_templates`, {
    method: "POST", token: cfg.apiToken,
    json: { name, category, language: body.language || "pt_BR", components }
  });
  return { id: r.id, status: r.status, category: r.category };
}

export async function deleteTemplate(env, name) {
  const cfg = await requireConfig(env);
  await graph(`/${cfg.wabaId}/message_templates?name=${encodeURIComponent(name)}`, { method: "DELETE", token: cfg.apiToken });
}

/**
 * Entrega ao painel uma mídia recebida (foto, áudio, vídeo, documento), buscando na Meta na hora.
 * Repassa o cabeçalho Range para o áudio/vídeo poder tocar no navegador.
 */
export async function midiaResponse(env, mediaId, request) {
  const cfg = await requireConfig(env);
  const info = await graph(`/${mediaId}`, { token: cfg.apiToken });
  if (!info.url) throw new ApiError("midia_indisponivel");
  const headers = { authorization: `Bearer ${cfg.apiToken}`, "user-agent": "Mozilla/5.0 ProntoArtesCRM" };
  const range = request.headers.get("range");
  if (range) headers.range = range;
  const r = await fetch(info.url, { headers });
  if (!r.ok && r.status !== 206) throw new ApiError("midia_indisponivel");
  const out = new Headers({ "content-type": info.mime_type || r.headers.get("content-type") || "application/octet-stream", "cache-control": "private, max-age=86400" });
  for (const h of ["content-length", "content-range", "accept-ranges"]) if (r.headers.get(h)) out.set(h, r.headers.get(h));
  return new Response(r.body, { status: r.status, headers: out });
}

/** Envia foto, vídeo ou PDF escolhido no painel: sobe o arquivo para a Meta e manda pelo número do CRM. */
export async function sendMediaToLead(env, lead, file, caption, user, logEvent) {
  const cfg = await requireConfig(env);
  if (!file || typeof file === "string" || !file.size) throw new ApiError("arquivo_vazio", "Escolha um arquivo.");
  const tipo = TIPOS_MIDIA[file.type];
  if (!tipo) throw new ApiError("tipo_nao_aceito", "Envie foto (JPG ou PNG), vídeo (MP4) ou PDF.");
  const [kind, label, maxMb] = tipo;
  if (file.size > maxMb * 1024 * 1024) throw new ApiError("arquivo_grande", `O WhatsApp aceita ${label} de até ${maxMb} MB.`);
  if (!within24h(lead.last_inbound_at)) throw new ApiError("fora_da_janela_24h",
    "O cliente não mandou mensagem nas últimas 24h. Pela regra do WhatsApp, use um modelo aprovado.");

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", file.type);
  form.append("file", file, file.name || "arquivo");
  const up = await graph(`/${cfg.phoneNumberId}/media`, { method: "POST", token: cfg.apiToken, body: form });
  if (!up.id) throw new ApiError("upload_falhou", "A Meta não aceitou o arquivo.");

  const legenda = String(caption || "").trim().slice(0, 1024);
  const media = { id: up.id, ...(legenda ? { caption: legenda } : {}), ...(kind === "document" ? { filename: file.name || "documento.pdf" } : {}) };
  const payload = { messaging_product: "whatsapp", to: lead.whatsapp, type: kind, [kind]: media };
  const resumo = `[${label} #m${up.id}]` + (kind === "document" && file.name ? " " + file.name : "") + (legenda ? " " + legenda : "");
  return enviar(env, cfg, lead, payload, resumo, user, logEvent);
}
