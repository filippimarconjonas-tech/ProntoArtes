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
  "tray_access_token", "tray_refresh_token", "tray_token_expires", "tray_webhook_key", "tray_last_sync", "tray_last_webhook", "tray_last_error"];

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
    lastWebhook: s.tray_last_webhook || null,
    lastError: (() => { try { return s.tray_last_error ? JSON.parse(s.tray_last_error) : null; } catch { return null; } })()
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
    throw Object.assign(new TrayError("erro_tray", `Tray respondeu ${res.status}: ${msg}`), { status: res.status });
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

/**
 * O plano gratuito do Workers permite 50 chamadas externas por execução.
 * A sincronização reserva uma folga e conta cada chamada à Tray.
 */
const LIMITE_CHAMADAS = 44;
class SemOrcamento extends Error {}

async function api(env, path, orcamento) {
  if (orcamento) {
    if (orcamento.resta <= 0) throw new SemOrcamento();
    orcamento.resta--;
  }
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
const POST_LABEL = { pago: "Pedido pago", separacao: "Separação / produção", enviado: "Enviado", entregue: "Entregue" };

/**
 * Aplica um pedido da Tray ao CRM. Idempotente: cada pedido fica ligado ao seu lead na tabela
 * tray_orders, e reprocessar um pedido sem mudança de status não altera nada.
 */
const PROCESSANDO = "__processando";

async function applyOrder(env, orderId, deps, opts = {}) {
  const id = String(orderId);
  // 1º: pedido já ligado a um lead (que ainda existe)
  const map = await env.DB.prepare("SELECT lead_id, status FROM tray_orders WHERE pedido = ?").bind(id).first();
  const lead = map?.lead_id ? await env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(map.lead_id).first() : null;
  // A lista de pedidos já traz o status: pedido conhecido sem mudança não gasta chamada à Tray
  if (lead && opts.statusLista != null && map.status === opts.statusLista) return { pedido: id, status: opts.statusLista, lead_id: lead.id, acao: "sem mudanças" };
  if (lead) return applyOrderInner(env, id, deps, opts, map, lead);

  // Pedido sem lead: reserva o pedido antes de criar o lead. A Tray manda "insert" e "update" do mesmo
  // pedido quase juntos; só quem reservar processa (reserva com mais de 2 min é considerada abandonada).
  const abandonada = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const r = await env.DB.prepare(
    `INSERT INTO tray_orders (pedido, lead_id, status) VALUES (?, 0, ?)
     ON CONFLICT(pedido) DO UPDATE SET lead_id = 0, status = excluded.status, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE tray_orders.status <> excluded.status OR tray_orders.updated_at < ?`
  ).bind(id, PROCESSANDO, abandonada).run();
  if (!r.meta?.changes) return { pedido: id, status: opts.statusLista || "", acao: "já em processamento por outra notificação" };
  try {
    const out = await applyOrderInner(env, id, deps, opts, null, null);
    if (!out.lead_id) await env.DB.prepare("DELETE FROM tray_orders WHERE pedido = ? AND lead_id = 0").bind(id).run();
    return out;
  } catch (err) {
    await env.DB.prepare("DELETE FROM tray_orders WHERE pedido = ? AND lead_id = 0").bind(id).run();
    throw err;
  }
}

async function applyOrderInner(env, orderId, deps, { orcamento = null } = {}, map, lead) {
  // "Pedido completo" já traz o cliente: uma chamada por pedido. Se a loja não tiver essa consulta,
  // volta para pedido + cliente (e não tenta de novo nesta sincronização).
  let full = null;
  if (!orcamento?.semCompleto) {
    try { full = await api(env, `/orders/${encodeURIComponent(orderId)}/complete`, orcamento); }
    catch (err) {
      if (!(err instanceof TrayError) || err.status !== 404) throw err;
      if (orcamento) orcamento.semCompleto = true;
    }
  }
  if (!full?.Order) full = await api(env, `/orders/${encodeURIComponent(orderId)}`, orcamento);
  const o = full?.Order;
  if (!o) throw new TrayError("pedido_nao_encontrado", `Pedido ${orderId} não encontrado na Tray.`);

  const pedido = String(o.id);
  const total = Number(o.total) || null;
  const status = o.status || "";
  const cls = classify(status);
  if (lead && map.status === status) return { pedido, status, lead_id: lead.id, acao: "sem mudanças" };

  if (!lead) {
    if (cls.kind === "cancelado" || cls.kind === "outro") return { pedido, status, acao: "ignorado (sem lead e pedido não pago)" };
    let c = o.Customer || full.Customer || null;
    if (!c && o.customer_id) {
      try { c = (await api(env, `/customers/${encodeURIComponent(o.customer_id)}`, orcamento))?.Customer || null; }
      catch (err) { if (err instanceof SemOrcamento) throw err; }
    }
    const phone = normalizePhone(c?.cellphone || c?.phone || "");
    const email = (c?.email || "").trim().toLowerCase();

    // 2º: telefone; 3º: e-mail
    if (phone.length >= 12) lead = await env.DB.prepare("SELECT * FROM leads WHERE whatsapp = ? ORDER BY id DESC LIMIT 1").bind(phone).first();
    if (!lead && email) lead = await env.DB.prepare("SELECT * FROM leads WHERE lower(email) = ? ORDER BY id DESC LIMIT 1").bind(email).first();

    // Cliente que já fechou outra venda: este pedido é uma recompra e vira nova oportunidade
    let recompra = false;
    if (lead && lead.stage === "ganho" && lead.pedido_tray && lead.pedido_tray !== pedido) {
      recompra = true;
      lead = null;
    }

    if (!lead) {
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
  }

  if (map) {
    // Outra notificação do mesmo pedido pode ter chegado junto: só uma aplica a mudança de status
    const u = await env.DB.prepare("UPDATE tray_orders SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE pedido = ? AND status = ?")
      .bind(status, pedido, map.status).run();
    if (!u.meta?.changes) return { pedido, status, lead_id: lead.id, acao: "já atualizado por outra notificação" };
  }

  const at = now();
  const sets = {};
  const events = [];
  if (!map || map.lead_id !== lead.id) events.push(`Pedido Tray nº ${pedido} vinculado (${status}).`);
  if (cls.kind !== "cancelado" && lead.pedido_tray !== pedido) sets.pedido_tray = pedido;
  if (total && cls.kind !== "cancelado" && lead.valor !== total) sets.valor = total;

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
      events.push(`Pós-venda: ${POST_LABEL[cls.post]} (pedido ${pedido}: ${status}).`);
    }
  }

  if (cls.kind === "cancelado") events.push(`Pedido ${pedido} cancelado na Tray (${status}). Revise a etapa do lead.`);
  else if (map && map.status !== status && !events.length) events.push(`Pedido ${pedido}: status na Tray mudou para ${status}.`);

  if (Object.keys(sets).length) {
    sets.updated_at = at;
    const keys = Object.keys(sets);
    await env.DB.prepare(`UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).bind(...keys.map((k) => sets[k]), lead.id).run();
  }
  await env.DB.prepare(
    `INSERT INTO tray_orders (pedido, lead_id, status) VALUES (?, ?, ?)
     ON CONFLICT(pedido) DO UPDATE SET lead_id = excluded.lead_id, status = excluded.status, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(pedido, lead.id, status).run();
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

  // A Tray exige resposta 200 em toda notificação: responde na hora e processa em seguida.
  // Se falhar, o erro fica registrado no painel e a sincronização automática (a cada 30 min) recupera o pedido.
  if (String(data.scope_name || "").toLowerCase() === "order" && data.scope_id) {
    const pedido = String(data.scope_id);
    const job = applyOrder(env, pedido, deps)
      .then((r) => console.log("tray_order", JSON.stringify(r)))
      .catch(async (err) => {
        console.error("tray_webhook_error", pedido, err.message);
        await setSettings(env, { tray_last_error: JSON.stringify({ pedido, erro: err.message, em: now() }) }).catch(() => {});
      });
    if (deps.waitUntil) deps.waitUntil(job); else await job;
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
    ultima_notificacao: cfg.lastWebhook,
    ultimo_erro: cfg.lastError
  };
}

export async function saveTraySettings(env, body) {
  const vals = {};
  // Campos vazios mantêm o valor salvo (o api_address chega sozinho pela autorização;
  // um formulário aberto antes de autorizar não pode apagá-lo)
  const a = String(body.api_address || "").trim().replace(/\/+$/, "");
  if (a && !/^https:\/\/[^\s]+\/web_api$/i.test(a)) throw new TrayError("api_address_invalido", "O endereço da API deve começar com https:// e terminar em /web_api.");
  if (a) vals.tray_api_address = a;
  const u = String(body.store_url || "").trim().replace(/\/+$/, "");
  if (u && !/^https:\/\/[a-z0-9.-]+$/i.test(u)) throw new TrayError("store_url_invalida", "O endereço da loja deve ser como https://www.prontoartes.com.br");
  if (u) vals.tray_store_url = u;
  const cur = await getSettings(env, ["tray_webhook_key", "tray_store_url"]);
  // Trocou de loja (ex.: teste → produção): a autorização e o api_address antigos não valem para a nova
  if (u && cur.tray_store_url && u !== cur.tray_store_url) {
    Object.assign(vals, { tray_api_address: null, tray_code: null, tray_access_token: null, tray_refresh_token: null, tray_token_expires: null });
  }
  for (const [field, key] of [["consumer_key", "tray_consumer_key"], ["consumer_secret", "tray_consumer_secret"]]) {
    const v = String(body[field] || "").trim();
    if (v) vals[key] = v;
  }
  const code = String(body.code || "").trim();
  if (code) Object.assign(vals, { tray_code: code, tray_access_token: null, tray_refresh_token: null, tray_token_expires: null });
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

  // Do mais antigo para o mais novo: a recompra segue a ordem real das compras
  const pedidos = [];
  const orcamento = { resta: LIMITE_CHAMADAS - 2 }; // token + lista
  let pendentes = 0;
  for (const o of [...orders].reverse()) {
    if (pendentes) { pendentes++; pedidos.push({ pedido: String(o.id), status: o.status, acao: "fica para a próxima sincronização" }); continue; }
    try { pedidos.push(await applyOrder(env, o.id, deps, { statusLista: o.status ?? null, orcamento })); }
    catch (err) {
      if (err instanceof SemOrcamento) { pendentes = 1; pedidos.push({ pedido: String(o.id), status: o.status, acao: "fica para a próxima sincronização" }); }
      else pedidos.push({ pedido: String(o.id), status: o.status, acao: "erro: " + err.message });
    }
  }
  if (pendentes) steps.push({ label: "Limite por sincronização", ok: false, detail: `${pendentes} pedido(s) ficaram para depois: clique em sincronizar de novo para continuar.` });
  await setSettings(env, { tray_last_sync: now() });
  return { ok: true, steps, pedidos: pedidos.reverse() };
}

export { TrayError };

/** Sincronização automática (Cron Trigger do Worker): recupera pedidos cujas notificações falharam. */
export async function scheduledTraySync(env, deps) {
  const cfg = await trayConfig(env);
  if (!cfg.api || !(cfg.token || cfg.refresh)) return; // loja ainda não autorizada
  const r = await syncTray(env, deps);
  const mudou = r.pedidos.filter((p) => p.lead_id && p.acao !== "sem mudanças").length;
  console.log("tray_cron", JSON.stringify({ ok: r.ok, pedidos: r.pedidos.length, mudou, passos: r.steps.filter((s) => !s.ok) }));
}
