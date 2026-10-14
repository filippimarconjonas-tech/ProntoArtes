/**
 * Integração com a loja Tray: pedidos da loja atualizam o CRM.
 *
 * - Autorização: API da Tray com consumer_key/consumer_secret do aplicativo + "code" da loja
 *   (POST {api_address}/auth). O access_token expira e é renovado com o refresh_token.
 * - Notificações: a Tray chama /api/tray/webhook?key=... com scope_name=order e scope_id=<pedido>.
 *   O pedido é sempre buscado na API (fonte da verdade), então a notificação em si não é confiável.
 * - Sincronização manual: /admin › Tray › "Sincronizar pedidos recentes".
 */

import { normalizePhone } from "./crm.js";
import { getSettings, setSettings } from "./settings.js";

const KEYS = ["tray_store_url", "tray_api_address", "tray_consumer_key", "tray_consumer_secret", "tray_code",
  "tray_access_token", "tray_refresh_token", "tray_token_expires", "tray_webhook_key", "tray_last_sync", "tray_last_webhook"];

const now = () => new Date().toISOString();

async function trayConfig(env) {
  const s = await getSettings(env, KEYS);
  return {
    store: (s.tray_store_url || "https://www.prontoartes.com.br").replace(/\/+$/, ""),
    api: (s.tray_api_address || "").replace(/\/+$/, ""),
    key: s.tray_consumer_key || "",
    secret: s.tray_consumer_secret || "",
    code: s.tray_code || "",
    token: s.tray_access_token || "",
    refresh: s.tray_refresh_token || "",
    expires: s.tray_token_expires || "",
    webhookKey: s.tray_webhook_key || "",
    lastSync: s.tray_last_sync || null,
    lastWebhook: s.tray_last_webhook || null
  };
}

class TrayError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

async function trayFetch(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* resposta não-JSON */ }
  if (!res.ok) {
    const msg = data?.message || data?.causes?.join?.(" ") || data?.error || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new TrayError("erro_tray", `Tray respondeu ${res.status}: ${msg}`);
  }
  return data;
}

function saveTokens(env, r) {
  return setSettings(env, {
    tray_access_token: r.access_token,
    tray_refresh_token: r.refresh_token || null,
    // A Tray devolve "date_expiration_access_token" no formato "AAAA-MM-DD HH:MM:SS" (horário de Brasília)
    tray_token_expires: r.date_expiration_access_token ? new Date(r.date_expiration_access_token.replace(" ", "T") + "-03:00").toISOString() : null
  });
}

/** Troca o "code" da loja pelo access_token. */
async function authorize(env, cfg) {
  const body = new URLSearchParams({ consumer_key: cfg.key, consumer_secret: cfg.secret, code: cfg.code });
  const r = await trayFetch(`${cfg.api}/auth`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  if (!r?.access_token) throw new TrayError("erro_tray", "A Tray não devolveu o access_token. Confira o code (ele vale por pouco tempo e só pode ser usado uma vez).");
  await saveTokens(env, r);
  return r.access_token;
}

/** Devolve um access_token válido, renovando quando estiver perto de expirar. */
async function accessToken(env) {
  const cfg = await trayConfig(env);
  if (!cfg.api) throw new TrayError("tray_nao_configurada", "Cadastre o endereço da API da loja.");
  if (cfg.token && cfg.expires && Date.parse(cfg.expires) - Date.now() > 5 * 60 * 1000) return { cfg, token: cfg.token };
  if (cfg.refresh) {
    try {
      const r = await trayFetch(`${cfg.api}/auth?refresh_token=${encodeURIComponent(cfg.refresh)}`);
      if (r?.access_token) { await saveTokens(env, r); return { cfg, token: r.access_token }; }
    } catch { /* tenta o code abaixo */ }
  }
  if (cfg.key && cfg.secret && cfg.code) return { cfg, token: await authorize(env, cfg) };
  throw new TrayError("tray_nao_autorizada", "A loja ainda não foi autorizada. Preencha as credenciais e clique em Conectar.");
}

async function api(env, path) {
  const { cfg, token } = await accessToken(env);
  const sep = path.includes("?") ? "&" : "?";
  return trayFetch(`${cfg.api}${path}${sep}access_token=${encodeURIComponent(token)}`);
}

/* --------------------------------------------------------------
   Status do pedido → etapa do CRM
   -------------------------------------------------------------- */
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();

function classify(status) {
  const s = norm(status);
  if (/CANCEL|ESTORN|DEVOLV/.test(s)) return { kind: "cancelado" };
  if (/ENTREGUE|FINALIZ|CONCLU/.test(s)) return { kind: "pago", post: "entregue" };
  if (/ENVIADO|TRANSPORT|DESPACH/.test(s)) return { kind: "pago", post: "enviado" };
  if (/A ENVIAR|SEPARA|PRODUC|PREPARA|FATURA|PRONTO/.test(s)) return { kind: "pago", post: "separacao" };
  if (/APROVAD|PAGO|CONFIRMAD/.test(s)) return { kind: "pago", post: "pago" };
  if (/AGUARDANDO|PENDENTE|EM ANALISE|ABERTO/.test(s)) return { kind: "aguardando" };
  return { kind: "outro" };
}

const POST_ORDER = ["pago", "separacao", "enviado", "entregue", "recompra"];

/**
 * Aplica um pedido da Tray ao CRM. Idempotente: reprocessar o mesmo pedido não duplica nada.
 */
async function applyOrder(env, orderId, deps) {
  const o = (await api(env, `/orders/${encodeURIComponent(orderId)}`))?.Order;
  if (!o) throw new TrayError("pedido_nao_encontrado", `Pedido ${orderId} não encontrado na Tray.`);
  const c = o.customer_id ? (await api(env, `/customers/${encodeURIComponent(o.customer_id)}`).catch(() => null))?.Customer : null;

  const pedido = String(o.id);
  const total = Number(o.total) || null;
  const status = o.status || "";
  const cls = classify(status);
  const phone = normalizePhone(c?.cellphone || c?.phone || "");
  const email = (c?.email || "").trim().toLowerCase();

  // 1º: lead que já tem este pedido; 2º: telefone; 3º: e-mail
  let lead = await env.DB.prepare("SELECT * FROM leads WHERE pedido_tray = ? ORDER BY id DESC LIMIT 1").bind(pedido).first();
  if (!lead && phone.length >= 12) lead = await env.DB.prepare("SELECT * FROM leads WHERE whatsapp = ? ORDER BY id DESC LIMIT 1").bind(phone).first();
  if (!lead && email) lead = await env.DB.prepare("SELECT * FROM leads WHERE lower(email) = ? ORDER BY id DESC LIMIT 1").bind(email).first();

  // Cliente que já fechou outra venda: este pedido é uma recompra e vira nova oportunidade
  let recompra = false;
  if (lead && lead.stage === "ganho" && lead.pedido_tray && lead.pedido_tray !== pedido) {
    recompra = true;
    lead = null;
  }

  if (!lead) {
    if (cls.kind === "cancelado" || cls.kind === "outro") return { pedido, status, acao: "ignorado (sem lead e pedido não pago)" };
    if (phone.length < 12) return { pedido, status, acao: "ignorado (cliente sem telefone)" };
    const r = await deps.upsertLead(env, {
      nome: c?.name || "Cliente Tray",
      whatsapp: phone,
      email: email || null,
      cidade: [c?.city, c?.state].filter(Boolean).join("/") || null,
      origem: recompra ? "Recompra na loja Tray" : "Loja Tray (comprou direto no site)"
    }, { canal: "tray" });
    lead = await env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(r.id).first();
  }

  const at = now();
  const sets = {};
  const events = [];
  if (lead.pedido_tray !== pedido) { sets.pedido_tray = pedido; events.push(`Pedido Tray nº ${pedido} vinculado (${status}).`); }
  if (total && lead.valor !== total) sets.valor = total;

  if (cls.kind === "aguardando" && !["pagamento", "ganho"].includes(lead.stage)) {
    Object.assign(sets, { pipeline: "vendas", stage: "pagamento", stage_changed_at: at, canal_fechamento: "site_tray" });
    events.push(`Pedido ${pedido} criado na loja (${status}) → Aguardando pagamento.`);
  }

  if (cls.kind === "pago") {
    if (lead.stage !== "ganho") {
      Object.assign(sets, { pipeline: "vendas", stage: "ganho", stage_changed_at: at, won_at: at, lost_at: null, canal_fechamento: "site_tray" });
      events.push(`Pagamento do pedido ${pedido} confirmado na Tray (${status}) → Venda fechada.`);
    }
    const cur = POST_ORDER.indexOf(lead.post_stage || "");
    if (POST_ORDER.indexOf(cls.post) > cur) {
      sets.post_stage = cls.post;
      if (lead.stage === "ganho") events.push(`Pós-venda atualizado pela Tray: ${status}.`);
    }
  }

  if (cls.kind === "cancelado" && lead.pedido_tray === pedido) {
    events.push(`Pedido ${pedido} cancelado na Tray (${status}). Revise a etapa do lead.`);
  }

  if (Object.keys(sets).length) {
    sets.updated_at = at;
    const keys = Object.keys(sets);
    await env.DB.prepare(`UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).bind(...keys.map((k) => sets[k]), lead.id).run();
  }
  for (const text of events) await deps.logEvent(env, lead.id, "tray", text, "Tray");
  return { pedido, status, lead_id: lead.id, acao: events.length ? events.join(" ") : "sem mudanças" };
}

/* --------------------------------------------------------------
   Rotas
   -------------------------------------------------------------- */

/** Notificação da Tray (POST form-urlencoded). */
export async function handleTrayWebhook(request, env, deps) {
  const url = new URL(request.url);
  const cfg = await trayConfig(env);
  if (!cfg.webhookKey || url.searchParams.get("key") !== cfg.webhookKey) return new Response("Forbidden", { status: 403 });
  if (request.method !== "POST") return new Response("OK");

  const ct = request.headers.get("content-type") || "";
  const data = ct.includes("json") ? await request.json().catch(() => ({})) : Object.fromEntries(await request.formData().catch(() => new FormData()));
  await setSettings(env, { tray_last_webhook: now() });

  if (String(data.scope_name || "").toLowerCase() === "order" && data.scope_id) {
    try {
      const r = await applyOrder(env, data.scope_id, deps);
      console.log("tray_order", JSON.stringify(r));
    } catch (err) {
      console.error("tray_webhook_error", err.message);
      return new Response("Erro", { status: 500 }); // a Tray tenta de novo
    }
  }
  return new Response("OK");
}

export async function trayStatus(env, origin) {
  const cfg = await trayConfig(env);
  return {
    store_url: cfg.store,
    consumer_key: cfg.key, // identificação pública do app (não é segredo); usada no link de autorização
    callback_url: cfg.webhookKey ? `${origin}/api/tray/callback/${cfg.webhookKey}` : null,
    api_address: cfg.api,
    tem_consumer_key: !!cfg.key,
    tem_consumer_secret: !!cfg.secret,
    autorizada: !!(cfg.token || cfg.refresh),
    token_expira: cfg.expires || null,
    webhook_url: cfg.webhookKey ? `${origin}/api/tray/webhook?key=${cfg.webhookKey}` : null,
    ultima_sincronizacao: cfg.lastSync,
    ultima_notificacao: cfg.lastWebhook
  };
}

export async function saveTraySettings(env, body) {
  const vals = {};
  if (body.api_address !== undefined) {
    let a = String(body.api_address || "").trim().replace(/\/+$/, "");
    if (a && !/^https:\/\/[^\s]+\/web_api$/i.test(a)) throw new TrayError("api_address_invalido", "O endereço da API deve começar com https:// e terminar em /web_api.");
    vals.tray_api_address = a || null;
  }
  if (body.store_url !== undefined) {
    const u = String(body.store_url || "").trim().replace(/\/+$/, "");
    if (u && !/^https:\/\/[a-z0-9.-]+$/i.test(u)) throw new TrayError("store_url_invalida", "O endereço da loja deve ser como https://www.prontoartes.com.br");
    vals.tray_store_url = u || null;
  }
  for (const [field, key] of [["consumer_key", "tray_consumer_key"], ["consumer_secret", "tray_consumer_secret"]]) {
    const v = String(body[field] || "").trim();
    if (v) vals[key] = v;
  }
  const code = String(body.code || "").trim();
  if (code) Object.assign(vals, { tray_code: code, tray_access_token: null, tray_refresh_token: null, tray_token_expires: null });
  const cur = await getSettings(env, ["tray_webhook_key"]);
  if (!cur.tray_webhook_key) vals.tray_webhook_key = [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await setSettings(env, vals);
}

/**
 * Retorno da autorização na loja (auth.php da Tray redireciona para cá com code e api_address).
 * A chave no caminho garante que só o link gerado pelo painel é aceito.
 */
export async function handleTrayCallback(request, env, key) {
  const url = new URL(request.url);
  const cfg = await trayConfig(env);
  if (!cfg.webhookKey || key !== cfg.webhookKey) return new Response("Forbidden", { status: 403 });
  const code = url.searchParams.get("code") || "";
  const apiAddress = (url.searchParams.get("api_address") || "").replace(/\/+$/, "");
  const back = (status) => Response.redirect(new URL(`/admin#tray`, url).toString() + `?tray=${status}`, 302);
  if (!code || !/^https:\/\/[^\s]+\/web_api$/i.test(apiAddress)) return back("sem_code");
  await setSettings(env, { tray_code: code, tray_api_address: apiAddress, tray_access_token: null, tray_refresh_token: null, tray_token_expires: null });
  try {
    await authorize(env, { ...cfg, code, api: apiAddress });
    return back("ok");
  } catch (err) {
    console.error("tray_callback_error", err.message);
    return back("erro");
  }
}

/** Testa a conexão e processa os pedidos mais recentes. */
export async function syncTray(env, deps, limit = 30) {
  const steps = [];
  try {
    await accessToken(env);
    steps.push({ label: "Autorização na Tray", ok: true, detail: "Acesso à API liberado" });
  } catch (err) {
    steps.push({ label: "Autorização na Tray", ok: false, detail: err.message });
    return { ok: false, steps, pedidos: [] };
  }

  let orders = [];
  try {
    const r = await api(env, `/orders?limit=${limit}&sort=id_desc`);
    orders = (r?.Orders || []).map((x) => x.Order).filter(Boolean);
    steps.push({ label: "Ler pedidos", ok: true, detail: `${orders.length} pedido(s) mais recentes` });
  } catch (err) {
    steps.push({ label: "Ler pedidos", ok: false, detail: err.message });
    return { ok: false, steps, pedidos: [] };
  }

  const pedidos = [];
  for (const o of orders) {
    try { pedidos.push(await applyOrder(env, o.id, deps)); }
    catch (err) { pedidos.push({ pedido: String(o.id), status: o.status, acao: "erro: " + err.message }); }
  }
  await setSettings(env, { tray_last_sync: now() });
  return { ok: true, steps, pedidos };
}

export { TrayError };
