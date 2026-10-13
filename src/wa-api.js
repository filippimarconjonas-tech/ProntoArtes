/**
 * Envio de mensagens e gestão de modelos (templates) pela WhatsApp Cloud API.
 * Usa o token de Usuário do sistema cadastrado em /admin › WhatsApp.
 */

import { waConfig, graph } from "./whatsapp.js";

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
  } else {
    const text = String(body.text || "").trim().slice(0, 4096);
    if (!text) throw new ApiError("mensagem_vazia");
    if (!within24h(lead.last_inbound_at)) throw new ApiError("fora_da_janela_24h",
      "O cliente não mandou mensagem nas últimas 24h. Pela regra do WhatsApp, use um modelo aprovado.");
    payload = { messaging_product: "whatsapp", recipient_type: "individual", to: lead.whatsapp, type: "text", text: { preview_url: false, body: text } };
    resumo = text;
  }

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
