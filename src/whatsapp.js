/**
 * Webhook da WhatsApp Cloud API (Meta) — número em coexistência com o WhatsApp Business App.
 *
 * GET  /api/whatsapp/webhook  → verificação do webhook (hub.challenge)
 * POST /api/whatsapp/webhook  → eventos:
 *   - messages            : mensagem do cliente → cria ou atualiza o lead
 *   - smb_message_echoes  : mensagem enviada pela equipe no app → marca o primeiro contato
 *
 * Credenciais: cadastradas no painel /admin › WhatsApp (tabela settings do D1).
 * Também podem vir de Secrets do Worker (WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET), que têm prioridade.
 */

import { normalizePhone, stageLabel, PIPELINES } from "./crm.js";
import { getSettings, setSettings } from "./settings.js";

const GRAPH = "https://graph.facebook.com/v23.0";
const KEYS = ["whatsapp_system_token", "whatsapp_business_token", "whatsapp_config_id", "whatsapp_app_id", "whatsapp_phone_number_id", "whatsapp_waba_id", "whatsapp_app_secret", "whatsapp_access_token", "whatsapp_verify_token", "whatsapp_connected_at", "whatsapp_display_phone", "whatsapp_verified_name"];

export async function waConfig(env) {
  const s = await getSettings(env, KEYS);
  return {
    appId: s.whatsapp_app_id || "",
    configId: s.whatsapp_config_id || "",
    phoneNumberId: s.whatsapp_phone_number_id || "",
    wabaId: s.whatsapp_waba_id || "",
    appSecret: env.WHATSAPP_APP_SECRET || s.whatsapp_app_secret || "",
    accessToken: s.whatsapp_access_token || "",
    // Token para enviar mensagens e gerenciar modelos: Usuário do sistema (permanente) ou o do Cadastro incorporado
    apiToken: env.WHATSAPP_SYSTEM_TOKEN || s.whatsapp_system_token || s.whatsapp_business_token || "",
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || s.whatsapp_verify_token || "",
    connectedAt: s.whatsapp_connected_at || null,
    displayPhone: s.whatsapp_display_phone || null,
    verifiedName: s.whatsapp_verified_name || null
  };
}

const enc = new TextEncoder();
const now = () => new Date().toISOString();

/**
 * O WhatsApp entrega números de celular brasileiros antigos sem o nono dígito
 * (ex.: 552488887777). Padroniza para 13 dígitos, igual aos leads do site.
 */
export function normalizeWaId(waId) {
  const d = String(waId || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("55") && /[6-9]/.test(d[4])) return d.slice(0, 4) + "9" + d.slice(4);
  return normalizePhone(d);
}

function messageText(m) {
  if (!m) return "";
  switch (m.type) {
    case "text": return m.text?.body || "";
    case "button": return m.button?.text || "";
    case "interactive": return m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || "[resposta interativa]";
    case "image": return "[imagem]" + (m.image?.caption ? " " + m.image.caption : "");
    case "video": return "[vídeo]" + (m.video?.caption ? " " + m.video.caption : "");
    case "document": return "[documento]" + (m.document?.caption ? " " + m.document.caption : "");
    case "audio": return "[áudio]";
    case "sticker": return "[figurinha]";
    case "location": return "[localização]";
    case "contacts": return "[contato compartilhado]";
    case "reaction": return "[reação " + (m.reaction?.emoji || "") + "]";
    default: return "[" + (m.type || "mensagem") + "]";
  }
}

async function validSignature(request, raw, secret) {
  const header = request.headers.get("x-hub-signature-256") || "";
  if (!header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(raw));
  const expected = "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const a = enc.encode(expected), b = enc.encode(header);
  if (a.length !== b.length) return false;
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function alreadyProcessed(env, id) {
  return !!(await env.DB.prepare("SELECT 1 FROM wa_messages WHERE id = ?").bind(id).first());
}

async function markProcessed(env, id, leadId, direction) {
  await env.DB.prepare("INSERT OR IGNORE INTO wa_messages (id, lead_id, direction) VALUES (?, ?, ?)").bind(id, leadId, direction).run();
}

/** Mensagem do cliente. */
async function handleInbound(env, m, contact, deps) {
  if (!m?.id || !m.from || await alreadyProcessed(env, m.id)) return;
  const phone = normalizeWaId(m.from);
  const text = messageText(m).slice(0, 1000);
  const name = (contact?.profile?.name || "").trim();
  const at = m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : now();

  const lead = await env.DB.prepare("SELECT * FROM leads WHERE whatsapp = ? ORDER BY id DESC LIMIT 1").bind(phone).first();
  let leadId;

  if (!lead) {
    const ref = m.referral || null; // anúncio Click-to-WhatsApp
    const r = await deps.upsertLead(env, {
      nome: name || "Contato WhatsApp",
      whatsapp: phone,
      mensagem: text,
      origem: ref ? "Anúncio Click-to-WhatsApp" : "WhatsApp direto",
      utm_source: ref ? "meta_ads" : null,
      utm_medium: ref ? "click_to_whatsapp" : null,
      utm_campaign: ref?.headline || null,
      utm_content: ref?.source_id || null,
      fbclid: ref?.ctwa_clid || null,
      referrer: ref?.source_url || null
    }, { canal: "whatsapp" });
    leadId = r.id;
  } else {
    leadId = lead.id;
    let move = null;
    if (lead.stage === "perdido") move = { pipeline: "vendas", stage: "novo" };
    else if (lead.pipeline === "nutricao" && ["pesquisando", "conteudo", "sem_interesse"].includes(lead.stage)) move = { pipeline: "nutricao", stage: "reaquecido" };

    if (move) {
      await env.DB.prepare("UPDATE leads SET pipeline = ?, stage = ?, stage_changed_at = ?, lost_at = NULL WHERE id = ?")
        .bind(move.pipeline, move.stage, now(), leadId).run();
      await deps.logEvent(env, leadId, "etapa",
        `Voltou a falar no WhatsApp: ${stageLabel(lead.pipeline, lead.stage)} → ${PIPELINES[move.pipeline].label} › ${stageLabel(move.pipeline, move.stage)}`);
    }
    if (name && /^Contato WhatsApp$/.test(lead.nome)) {
      await env.DB.prepare("UPDATE leads SET nome = ? WHERE id = ?").bind(name, leadId).run();
    }
  }

  await env.DB.prepare("UPDATE leads SET last_inbound_at = ?, updated_at = ? WHERE id = ?").bind(at, now(), leadId).run();
  await deps.logEvent(env, leadId, "whatsapp_in", text);
  await markProcessed(env, m.id, leadId, "in");
  if (m.type !== "reaction") deps.onInbound?.(leadId, at);
}

/** Mensagem enviada pela equipe no WhatsApp Business App (coexistência). */
async function handleEcho(env, m, deps) {
  if (!m?.id || !m.to || await alreadyProcessed(env, m.id)) return;
  const phone = normalizeWaId(m.to);
  const at = m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : now();
  const lead = await env.DB.prepare("SELECT * FROM leads WHERE whatsapp = ? ORDER BY id DESC LIMIT 1").bind(phone).first();
  if (!lead) { await markProcessed(env, m.id, null, "out"); return; }

  if (lead.pipeline === "vendas" && lead.stage === "novo") {
    await env.DB.prepare("UPDATE leads SET stage = 'atendimento', stage_changed_at = ? WHERE id = ?").bind(now(), lead.id).run();
    await deps.logEvent(env, lead.id, "etapa", "Novo lead → Em atendimento (primeira resposta pelo WhatsApp da loja)");
  }
  await env.DB.prepare(
    "UPDATE leads SET last_outbound_at = ?, first_contact_at = COALESCE(first_contact_at, ?), updated_at = ? WHERE id = ?"
  ).bind(at, at, now(), lead.id).run();
  await deps.logEvent(env, lead.id, "whatsapp_out", messageText(m).slice(0, 1000));
  await markProcessed(env, m.id, lead.id, "out");
  await deps.onHumanReply?.(lead.id);
}

export async function handleWhatsAppWebhook(request, env, deps) {
  const url = new URL(request.url);

  const cfg = await waConfig(env);

  if (request.method === "GET") {
    const ok = cfg.verifyToken &&
      url.searchParams.get("hub.mode") === "subscribe" &&
      url.searchParams.get("hub.verify_token") === cfg.verifyToken;
    return ok
      ? new Response(url.searchParams.get("hub.challenge") || "", { headers: { "content-type": "text/plain" } })
      : new Response("Forbidden", { status: 403 });
  }

  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!cfg.appSecret) return new Response("Webhook não configurado", { status: 503 });

  const raw = await request.text();
  if (!(await validSignature(request, raw, cfg.appSecret))) return new Response("Assinatura inválida", { status: 401 });

  let payload;
  try { payload = JSON.parse(raw); } catch { return new Response("JSON inválido", { status: 400 }); }

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      if (change.field === "messages") {
        const contacts = v.contacts || [];
        for (const m of v.messages || []) {
          const contact = contacts.find((c) => c.wa_id === m.from) || contacts[0];
          await handleInbound(env, m, contact, deps);
        }
      } else if (change.field === "smb_message_echoes") {
        for (const m of v.message_echoes || []) await handleEcho(env, m, deps);
      }
    }
  }

  await env.DB.prepare(
    "INSERT INTO wa_messages (id, lead_id, direction) VALUES ('_last_webhook', NULL, 'meta') ON CONFLICT(id) DO UPDATE SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"
  ).run();
  return new Response("OK");
}

export async function whatsappStatus(env, origin) {
  const cfg = await waConfig(env);
  const last = await env.DB.prepare(
    "SELECT (SELECT created_at FROM wa_messages WHERE id = '_last_webhook') AS ultimo_webhook, " +
    "(SELECT MAX(created_at) FROM wa_messages WHERE direction = 'in') AS ultima_recebida, " +
    "(SELECT COUNT(*) FROM wa_messages WHERE direction = 'in') AS recebidas, " +
    "(SELECT COUNT(*) FROM wa_messages WHERE direction = 'out') AS enviadas"
  ).first();
  return {
    app_id: cfg.appId,
    config_id: cfg.configId,
    phone_number_id: cfg.phoneNumberId,
    waba_id: cfg.wabaId,
    tem_app_secret: !!cfg.appSecret,
    tem_access_token: !!cfg.accessToken,
    tem_token_envio: !!cfg.apiToken,
    callback_url: origin + "/api/whatsapp/webhook",
    verify_token: cfg.verifyToken,
    conectado_em: cfg.connectedAt,
    numero: cfg.displayPhone,
    nome_verificado: cfg.verifiedName,
    ...last
  };
}

/** Salva IDs e credenciais vindas do painel. Campos secretos vazios mantêm o valor atual. */
export async function saveWhatsAppSettings(env, body) {
  const vals = {};
  const id = (v) => String(v || "").replace(/\D/g, "");
  if (body.config_id !== undefined) vals.whatsapp_config_id = id(body.config_id) || null;
  if (body.app_id !== undefined) vals.whatsapp_app_id = id(body.app_id) || null;
  if (body.phone_number_id !== undefined) vals.whatsapp_phone_number_id = id(body.phone_number_id) || null;
  if (body.waba_id !== undefined) vals.whatsapp_waba_id = id(body.waba_id) || null;
  const secret = String(body.app_secret || "").trim();
  const token = String(body.access_token || "").trim();
  if (secret && !/^[0-9a-f]{32}$/i.test(secret)) throw Object.assign(new Error("app_secret_invalido"), { code: "app_secret_invalido" });
  if (token && !/^EA[A-Za-z0-9]{50,}$/.test(token)) throw Object.assign(new Error("token_invalido"), { code: "token_invalido" });
  const sysToken = String(body.system_token || "").trim();
  if (sysToken && !/^EA[A-Za-z0-9]{50,}$/.test(sysToken)) throw Object.assign(new Error("token_invalido"), { code: "token_invalido" });
  if (sysToken) vals.whatsapp_system_token = sysToken;
  if (secret) vals.whatsapp_app_secret = secret;
  if (token) vals.whatsapp_access_token = token;
  const cur = await getSettings(env, ["whatsapp_verify_token"]);
  if (!cur.whatsapp_verify_token) {
    vals.whatsapp_verify_token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  await setSettings(env, vals);
}

export async function graph(path, { method = "GET", token, form, json } = {}) {
  const url = new URL(GRAPH + path);
  const init = { method, headers: {} };
  if (token) init.headers.authorization = "Bearer " + token;
  if (form) {
    init.headers["content-type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(form).toString();
  }
  if (json) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(json);
  }
  const res = await fetch(url, init);
  let data = null;
  try { data = await res.json(); } catch { /* sem corpo */ }
  if (!res.ok || data?.error) {
    const e = data?.error;
    if (!e) throw new Error(`HTTP ${res.status}`);
    // A Meta coloca a explicação útil em error_user_title/error_user_msg e error_data.details
    const extra = [e.error_user_title, e.error_user_msg, e.error_data?.details].filter(Boolean).join(" — ");
    throw new Error(`${e.message}${e.code ? " (código " + e.code + (e.error_subcode ? "/" + e.error_subcode : "") + ")" : ""}${extra ? ": " + extra : ""}`);
  }
  return data;
}

/**
 * Conecta o número ao CRM pela Graph API:
 * 1. identifica o app do token  2. confere o número  3. cadastra o webhook do app
 * 4. assina a conta do WhatsApp Business no app  5. confirma a assinatura
 * Ao final apaga o token (não é necessário para receber mensagens).
 */
export async function connectWhatsApp(env, origin) {
  const cfg = await waConfig(env);
  // Token de configuração (temporário) ou, se não houver, o token permanente do Usuário do sistema
  const tok = cfg.accessToken || cfg.apiToken;
  const steps = [];
  const step = async (label, fn) => {
    try {
      const detail = await fn();
      steps.push({ label, ok: true, detail: detail || "" });
      return true;
    } catch (err) {
      steps.push({ label, ok: false, detail: err.message });
      return false;
    }
  };

  const missing = [
    !cfg.phoneNumberId && "Phone Number ID",
    !cfg.wabaId && "ID da conta do WhatsApp Business",
    !cfg.appSecret && "Chave secreta do aplicativo",
    !cfg.verifyToken && "Verify token",
    !cfg.appId && !tok && "App ID ou token de acesso"
  ].filter(Boolean);
  if (missing.length) return { ok: false, steps: [{ label: "Credenciais", ok: false, detail: "Faltando: " + missing.join(", ") }] };

  let appId = cfg.appId || null;
  const callback = origin + "/api/whatsapp/webhook";
  const tokenStep = async (label, fn) => tok
    ? step(label, fn)
    : (steps.push({ label, ok: false, detail: "Pulado: sem token de acesso." }), false);

  if (appId) {
    steps.push({ label: "Identificar o aplicativo da Meta", ok: true, detail: "App ID informado: " + appId });
  } else {
    await step("Identificar o aplicativo da Meta", async () => {
      try {
        const app = await graph("/app", { token: tok });
        appId = app.id;
        return `${app.name || "App"} (ID ${app.id})`;
      } catch (first) {
        const dbg = await graph(`/debug_token?input_token=${encodeURIComponent(tok)}`, { token: tok })
          .catch(() => { throw new Error(first.message + " — informe o App ID no campo acima para continuar."); });
        appId = dbg.data?.app_id;
        if (!appId) throw new Error("Não foi possível identificar o app pelo token. Informe o App ID.");
        return `${dbg.data.application || "App"} (ID ${appId})`;
      }
    });
    if (appId) await setSettings(env, { whatsapp_app_id: appId });
  }

  await tokenStep("Conferir o número de WhatsApp", async () => {
    const n = await graph(`/${cfg.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,platform_type,is_on_biz_app`, { token: tok });
    await setSettings(env, { whatsapp_display_phone: n.display_phone_number || null, whatsapp_verified_name: n.verified_name || null });
    return `${n.display_phone_number || ""} · ${n.verified_name || ""}` +
      (n.is_on_biz_app === true ? " · coexistência com o app ativa" : n.is_on_biz_app === false ? " · número NÃO está no WhatsApp Business App" : "") +
      (n.quality_rating ? ` · qualidade ${n.quality_rating}` : "");
  });

  const hookOk = !appId
    ? (steps.push({ label: "Cadastrar o webhook do aplicativo", ok: false, detail: "Pulado: App ID desconhecido." }), false)
    : await step("Cadastrar o webhook do aplicativo (usa só a chave secreta)", async () => {
    await graph(`/${appId}/subscriptions`, {
      method: "POST",
      form: {
        object: "whatsapp_business_account",
        callback_url: callback,
        verify_token: cfg.verifyToken,
        fields: "messages,smb_message_echoes",
        include_values: "true",
        access_token: `${appId}|${cfg.appSecret}`
      }
    });
    return callback + " · campos: messages, smb_message_echoes";
  });

  const subOk = await tokenStep("Assinar a conta do WhatsApp Business", async () => {
    await graph(`/${cfg.wabaId}/subscribed_apps`, { method: "POST", token: tok });
    return "Conta " + cfg.wabaId + " assinada";
  });

  if (subOk) await step("Confirmar assinatura", async () => {
    const r = await graph(`/${cfg.wabaId}/subscribed_apps`, { token: tok });
    const apps = (r.data || []).map((a) => a.whatsapp_business_api_data?.name || a.whatsapp_business_api_data?.id || "app");
    if (!apps.length) throw new Error("Nenhum app assinado na conta.");
    return "Apps assinados: " + apps.join(", ");
  });

  const ok = hookOk && subOk;
  if (ok) {
    await setSettings(env, { whatsapp_connected_at: new Date().toISOString(), ...(cfg.accessToken ? { whatsapp_access_token: null } : {}) });
    if (cfg.accessToken) steps.push({ label: "Segurança", ok: true, detail: "Token temporário de configuração apagado do banco. O token permanente continua salvo para envio de mensagens." });
  }
  return { ok, steps };
}

/**
 * Conclui o Embedded Signup em modo coexistência (número que continua no WhatsApp Business App).
 * Recebe do painel o "code" do Login do Facebook e os IDs devolvidos pelo fluxo da Meta.
 */
export async function completeEmbeddedSignup(env, origin, body) {
  const cfg = await waConfig(env);
  const steps = [];
  const step = async (label, fn) => {
    try { steps.push({ label, ok: true, detail: (await fn()) || "" }); return true; }
    catch (err) { steps.push({ label, ok: false, detail: err.message }); return false; }
  };
  const phoneId = String(body.phone_number_id || "").replace(/\D/g, "");
  const wabaId = String(body.waba_id || "").replace(/\D/g, "");
  const code = String(body.code || "");
  if (!cfg.appId || !cfg.appSecret) return { ok: false, steps: [{ label: "Credenciais", ok: false, detail: "Informe o App ID e a chave secreta do aplicativo." }] };
  if (!code || !phoneId || !wabaId) return { ok: false, steps: [{ label: "Retorno da Meta", ok: false, detail: "O fluxo da Meta não devolveu o código ou os IDs do número. Tente novamente." }] };

  let token = null;
  if (!await step("Gerar acesso da empresa", async () => {
    const r = await graph(`/oauth/access_token?client_id=${cfg.appId}&client_secret=${encodeURIComponent(cfg.appSecret)}&code=${encodeURIComponent(code)}`);
    token = r.access_token;
    if (!token) throw new Error("A Meta não devolveu o token.");
    return "Token da empresa gerado";
  })) return { ok: false, steps };

  let display = null, name = null;
  await step("Conferir o número", async () => {
    const n = await graph(`/${phoneId}?fields=display_phone_number,verified_name,is_on_biz_app,platform_type`, { token });
    display = n.display_phone_number || null;
    name = n.verified_name || null;
    return `${display || phoneId} · ${name || ""}` + (n.is_on_biz_app ? " · coexistência com o WhatsApp Business App ativa" : "");
  });

  const subOk = await step("Assinar a conta do WhatsApp Business no app", async () => {
    await graph(`/${wabaId}/subscribed_apps`, { method: "POST", token });
    return "Conta " + wabaId + " assinada";
  });

  await step("Conferir o webhook do aplicativo", async () => {
    await graph(`/${cfg.appId}/subscriptions`, {
      method: "POST",
      form: {
        object: "whatsapp_business_account",
        callback_url: origin + "/api/whatsapp/webhook",
        verify_token: cfg.verifyToken,
        fields: "messages,smb_message_echoes",
        include_values: "true",
        access_token: `${cfg.appId}|${cfg.appSecret}`
      }
    });
    return "messages, smb_message_echoes";
  });

  if (subOk) {
    await setSettings(env, {
      whatsapp_phone_number_id: phoneId,
      whatsapp_waba_id: wabaId,
      whatsapp_display_phone: display,
      whatsapp_verified_name: name,
      whatsapp_business_token: token,
      // O token permanente salvo antes é de outro portfólio (número de teste) e não acessa esta conta:
      // a partir daqui vale o token da empresa gerado pelo Cadastro incorporado (não expira)
      whatsapp_system_token: null,
      whatsapp_connected_at: new Date().toISOString()
    });
    steps.push({ label: "Pronto", ok: true, detail: "Número da loja conectado. Mensagens novas passam a entrar no CRM." });
  }
  return { ok: subOk, steps };
}
