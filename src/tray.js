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
import { htmlToText } from "./products.js";

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
  // Guarda a última notificação recebida (evidência para a homologação da Tray)
  await setSettings(env, {
    tray_last_webhook: now(),
    tray_last_webhook_payload: JSON.stringify({ recebido_em: now(), metodo: request.method, content_type: ct, campos: data }).slice(0, 4000)
  });

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
  const q = url.searchParams;
  const code = q.get("code") || "";
  // O auth.php manda api_address; a instalação pela loja de aplicativos pode mandar outros nomes
  // (api_host, url, store_host). Último recurso: o endereço da loja salvo no CRM + /web_api.
  const comoApi = (v) => {
    let t = String(v || "").trim().replace(/\/+$/, "");
    if (!t) return "";
    if (!/^https?:\/\//i.test(t)) t = "https://" + t;
    t = t.replace(/^http:\/\//i, "https://");
    return /\/web_api$/i.test(t) ? t : t + "/web_api";
  };
  const apiAddress = [q.get("api_address"), q.get("api_host"), q.get("url"), q.get("store_host"), cfg.store]
    .map(comoApi).find((t) => /^https:\/\/[^\s/]+(\/[^\s]*)?\/web_api$/i.test(t)) || "";
  // Diagnóstico: quais parâmetros a Tray mandou (valores mascarados)
  await setSettings(env, {
    tray_last_callback: JSON.stringify({ em: now(), params: Object.fromEntries([...q].map(([k, v]) => [k, ["code", "token", "ctx"].includes(k) ? (v ? v.slice(0, 4) + "***" : "") : v.slice(0, 200)])) })
  });
  const back = (status) => Response.redirect(new URL(`/admin#tray`, url).toString() + `?tray=${status}`, 302);
  // A instalação pela loja de aplicativos volta sem code (só url/store/adm_user): o code vem ao clicar em "Acessar"
  if (!code && (q.has("store") || q.has("url") || q.has("adm_user"))) return back("instalado");
  if (!code || !apiAddress) return back("sem_code");
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

/* --------------------------------------------------------------
   Catálogo de produtos pela API (substitui a planilha)
   -------------------------------------------------------------- */

/** Loja de teste da Tray: o catálogo dela não pode ir para a vitrine nem para a IA. */
export const lojaDeTeste = (url) => /corpsuite|commercesuite|lojateste/i.test(String(url || ""));

const numero = (v) => {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) && String(v ?? "").trim() !== "" ? n : null;
};
const sim = (v) => v === true || v === 1 || /^(1|s|sim|true|yes)$/i.test(String(v ?? "").trim());
const dataTray = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v || "")) && !String(v).startsWith("0000") ? String(v).slice(0, 10) : null);

function produtoDaTray(p, categorias) {
  const promo = numero(p.promotional_price);
  const imagens = (Array.isArray(p.ProductImage) ? p.ProductImage : [])
    .map((i) => i?.https || i?.http).filter((u) => /^https?:\/\//.test(u || ""));
  return {
    id: String(p.id),
    nome: String(p.name || "").trim(),
    categoria: categorias[String(p.category_id)] || p.category_name || null,
    preco: numero(p.price),
    preco_promo: promo && promo > 0 ? promo : null,
    promo_inicio: dataTray(p.start_promotion),
    promo_fim: dataTray(p.end_promotion),
    estoque: numero(p.stock),
    disponivel: "available" in p ? (sim(p.available) ? 1 : 0) : 1,
    // "Exibir na loja" da planilha = available_in_store na API
    exibir: "available_in_store" in p ? (sim(p.available_in_store) ? 1 : 0) : "display" in p ? (sim(p.display) ? 1 : 0) : 1,
    peso_g: numero(p.weight),
    comprimento: numero(p.length), largura: numero(p.width), altura: numero(p.height),
    vendidos: numero(p.quantity_sold), // nem toda loja devolve; se faltar, mantém o valor atual
    // A listagem da Tray não traz a descrição: null mantém a descrição já salva
    descricao: "description" in p ? htmlToText(p.description) : null,
    url: p.url?.https || p.url?.http || null,
    imagens: JSON.stringify([...new Set(imagens)].slice(0, 8))
  };
}

/**
 * Lê o catálogo na API da Tray. Com gravar = false (loja de teste ou "Testar leitura"), só devolve
 * um resumo e uma amostra para conferir os campos; com gravar = true atualiza a tabela products.
 */
export async function syncProdutosTray(env, { gravar = false } = {}) {
  const cfg = await trayConfig(env);
  if (gravar && lojaDeTeste(cfg.store)) throw new TrayError("loja_de_teste", "Esta é a loja de teste da Tray: o catálogo dela não é gravado (use \"Testar leitura\").");
  const orcamento = { resta: LIMITE_CHAMADAS - 1 };

  // Categorias (id → nome)
  const categorias = {};
  for (let page = 1; page <= 5; page++) {
    const r = await api(env, `/categories?limit=50&page=${page}`, orcamento).catch((err) => { if (err instanceof SemOrcamento) throw err; return null; });
    const lista = (r?.Categories || []).map((x) => x.Category).filter(Boolean);
    for (const c of lista) categorias[String(c.id)] = c.name;
    if (lista.length < 50) break;
  }

  // Produtos, de 50 em 50
  const produtos = [];
  let total = null, campos = [], completo = false;
  try {
    for (let page = 1; page <= 40; page++) {
      const r = await api(env, `/products?limit=50&page=${page}`, orcamento);
      const lista = (r?.Products || []).map((x) => x.Product).filter(Boolean);
      if (page === 1) { total = numero(r?.paging?.total); campos = lista[0] ? Object.keys(lista[0]) : []; }
      produtos.push(...lista);
      if (lista.length < 50 || (total != null && produtos.length >= total)) { completo = true; break; }
    }
  } catch (err) {
    if (!(err instanceof SemOrcamento)) throw err;
  }

  const itens = produtos.map((p) => produtoDaTray(p, categorias)).filter((it) => it.id && it.nome);
  const ids = itens.map((it) => it.id);
  let emComum = 0;
  for (let i = 0; i < ids.length; i += 90) {
    const lote = ids.slice(i, i + 90);
    const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM products WHERE id IN (${lote.map(() => "?").join(",")})`).bind(...lote).first();
    emComum += r?.n || 0;
  }
  const resumo = {
    loja: cfg.store,
    loja_de_teste: lojaDeTeste(cfg.store),
    lidos: itens.length,
    total_na_tray: total,
    completo,
    categorias: Object.keys(categorias).length,
    ja_no_catalogo: emComum,
    campos,
    amostra: itens.slice(0, 5).map(({ descricao, imagens, ...it }) => ({ ...it, descricao: (descricao || "").slice(0, 160), imagens: JSON.parse(imagens).length }))
  };
  if (!gravar) return { ...resumo, gravado: false };

  const cols = Object.keys(itens[0] || {});
  if (cols.length) {
    const manter = ["vendidos", "descricao"]; // campos que a Tray pode não devolver: mantém o valor atual
    const upd = cols.filter((c) => c !== "id").map((c) => (manter.includes(c) ? `${c} = COALESCE(excluded.${c}, products.${c})` : `${c} = excluded.${c}`)).join(", ");
    const sql = `INSERT INTO products (${cols.join(", ")}, origem, updated_at) VALUES (${cols.map(() => "?").join(", ")}, 'api', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(id) DO UPDATE SET ${upd}, origem = 'api', updated_at = excluded.updated_at`;
    for (let i = 0; i < itens.length; i += 50) {
      await env.DB.batch(itens.slice(i, i + 50).map((it) => env.DB.prepare(sql).bind(...cols.map((c) => it[c]))));
    }
  }
  // Leitura completa: o que não veio da Tray sai da vitrine e das respostas da IA
  let ocultados = 0;
  if (completo && ids.length) {
    const r = await env.DB.prepare(`UPDATE products SET exibir = 0 WHERE exibir = 1 AND id NOT IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).run();
    ocultados = r.meta?.changes || 0;
  }
  // Descrição completa (GET /products/:id) dos produtos que ainda não têm, com as chamadas que sobraram
  let descricoes = 0;
  const { results: semDescricao } = await env.DB.prepare(
    `SELECT id FROM products WHERE exibir = 1 AND (descricao IS NULL OR descricao = '') AND id IN (SELECT value FROM json_each(?)) LIMIT ?`
  ).bind(JSON.stringify(ids), Math.max(0, orcamento.resta)).all();
  for (const { id } of semDescricao) {
    try {
      const d = (await api(env, `/products/${encodeURIComponent(id)}`, orcamento))?.Product?.description;
      await env.DB.prepare("UPDATE products SET descricao = ? WHERE id = ?").bind(htmlToText(d) || null, id).run();
      descricoes++;
    } catch (err) {
      if (err instanceof SemOrcamento) break;
    }
  }
  const faltam = await env.DB.prepare("SELECT COUNT(*) AS n FROM products WHERE exibir = 1 AND (descricao IS NULL OR descricao = '')").first();
  await setSettings(env, { tray_products_sync: now() });
  return { ...resumo, gravado: true, ocultados, descricoes_buscadas: descricoes, sem_descricao: faltam?.n || 0 };
}

/** Atualização diária do catálogo (só na loja real e autorizada). */
export async function scheduledProdutosTray(env) {
  const cfg = await trayConfig(env);
  if (!cfg.api || !(cfg.token || cfg.refresh) || lojaDeTeste(cfg.store)) return;
  const r = await syncProdutosTray(env, { gravar: true });
  console.log("tray_produtos_cron", JSON.stringify({ lidos: r.lidos, completo: r.completo, ocultados: r.ocultados }));
}

/* --------------------------------------------------------------
   Evidências para a homologação da Tray
   -------------------------------------------------------------- */

const SENSIVEIS = /^(access_token|refresh_token|code|consumer_key|consumer_secret|cpf|cnpj|rg|email|phone|cellphone|telephone|zip_code|address|number|complement|neighborhood|token|password)$/i;

/** Esconde tokens e dados pessoais, mantendo a estrutura da resposta. */
function mascarar(v, chave = "") {
  if (Array.isArray(v)) return v.map((x) => mascarar(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mascarar(x, k)]));
  // "code" também é o código HTTP nas respostas (ex.: 200): só esconde quando parece um code de autorização
  if (SENSIVEIS.test(chave) && v != null && String(v) !== "" && !(chave === "code" && /^\d{3}$/.test(String(v)))) {
    const t = String(v);
    return t.length <= 4 ? "***" : t.slice(0, 2) + "***" + t.slice(-2);
  }
  return v;
}

/** Corta listas longas para o documento não ficar gigante. */
function resumir(v, max = 2) {
  if (Array.isArray(v)) return v.slice(0, max).map((x) => resumir(x, max)).concat(v.length > max ? [`… (+${v.length - max} itens omitidos)`] : []);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resumir(x, max)]));
  return typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "… (texto cortado)" : v;
}

/**
 * Chama uma vez cada rota usada pela integração e guarda requisição e resposta (mascaradas)
 * em settings.tray_evidencias. A renovação do token é real: o token novo é salvo.
 */
export async function coletarEvidencias(env) {
  const cfg = await trayConfig(env);
  if (!cfg.api) throw new TrayError("tray_nao_configurada", "Cadastre e autorize a loja primeiro.");
  const base = cfg.api;
  const itens = [];

  async function chamar(nome, metodo, path, { usaToken = true } = {}) {
    const tk = usaToken ? (await accessToken(env)).token : null;
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${base}${path}${usaToken ? `${sep}access_token=${encodeURIComponent(tk)}` : ""}`, { method: metodo });
    const texto = await res.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { /* não-JSON */ }
    itens.push({
      nome, metodo,
      url: `${base}${path}${usaToken ? `${sep}access_token=***` : ""}`.replace(/refresh_token=[^&]+/, "refresh_token=***"),
      status: res.status,
      response: json != null ? resumir(mascarar(json)) : texto.slice(0, 1000)
    });
    return json;
  }

  // 1) Renovação do token (mesmo formato de resposta do POST /auth)
  if (cfg.refresh) {
    const r = await chamar("Renovação do token de acesso", "GET", `/auth?refresh_token=${encodeURIComponent(cfg.refresh)}`, { usaToken: false });
    if (r?.access_token) await saveTokens(env, r);
  }
  // 2) Catálogo
  await chamar("Listar categorias", "GET", "/categories?limit=50&page=1");
  const lp = await chamar("Listar produtos", "GET", "/products?limit=50&page=1");
  const pid = lp?.Products?.[0]?.Product?.id;
  if (pid) await chamar("Consultar produto (descrição completa)", "GET", `/products/${encodeURIComponent(pid)}`);
  // 3) Pedidos e clientes
  const lo = await chamar("Listar pedidos", "GET", "/orders?limit=30&sort=id_desc");
  const oid = lo?.Orders?.[0]?.Order?.id;
  if (oid) {
    const oc = await chamar("Consultar pedido completo", "GET", `/orders/${encodeURIComponent(oid)}/complete`);
    const o = await chamar("Consultar pedido", "GET", `/orders/${encodeURIComponent(oid)}`);
    const cid = oc?.Order?.customer_id || o?.Order?.customer_id;
    if (cid) await chamar("Consultar cliente", "GET", `/customers/${encodeURIComponent(cid)}`);
  }

  const s = await getSettings(env, ["tray_last_webhook_payload"]);
  const resultado = {
    gerado_em: now(),
    loja: cfg.store,
    api_address: base,
    ultima_notificacao: s.tray_last_webhook_payload ? JSON.parse(s.tray_last_webhook_payload) : null,
    rotas: itens
  };
  await setSettings(env, { tray_evidencias: JSON.stringify(resultado) });
  return { ok: true, rotas: itens.map((i) => ({ nome: i.nome, metodo: i.metodo, status: i.status })), tem_notificacao: !!resultado.ultima_notificacao };
}
