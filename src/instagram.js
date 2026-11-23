/**
 * Instagram da loja (@pronto.artes) no CRM: direct e comentários em posts.
 *
 * Usa a "Instagram API com login do Instagram" (graph.instagram.com), sem precisar de Página do Facebook.
 * - Conectar: /admin › Instagram › "Conectar Instagram" → login do Instagram → /api/instagram/callback
 *   troca o code por um token de longa duração (60 dias, renovado pelo cron) e assina o webhook da conta.
 * - Webhook: GET/POST /api/instagram/webhook (campos messages e comments do app da Meta).
 * - Responder: direct (até 24h depois da última mensagem da pessoa), comentário público ou
 *   resposta privada no direct a um comentário (uma por comentário, até 7 dias).
 */

import { getSettings, setSettings } from "./settings.js";

const GRAPH = "https://graph.instagram.com/v23.0";
const SCOPES = ["instagram_business_basic", "instagram_business_manage_messages", "instagram_business_manage_comments"];
const KEYS = ["instagram_app_id", "instagram_app_secret", "instagram_token", "instagram_token_expires", "instagram_user_id",
  "instagram_username", "instagram_name", "instagram_verify_token", "instagram_connected_at", "instagram_last_webhook",
  "instagram_last_error", "instagram_oauth_state"];
const JANELA_DM_MS = 24 * 3600 * 1000;
const JANELA_PRIVADA_MS = 7 * 24 * 3600 * 1000;

const now = () => new Date().toISOString();
const enc = new TextEncoder();
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

export class IgError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

export async function igConfig(env) {
  const s = await getSettings(env, KEYS);
  return {
    appId: s.instagram_app_id || "",
    appSecret: env.INSTAGRAM_APP_SECRET || s.instagram_app_secret || "",
    token: s.instagram_token || "",
    expires: s.instagram_token_expires || null,
    userId: s.instagram_user_id || "",
    username: s.instagram_username || "",
    name: s.instagram_name || "",
    verifyToken: s.instagram_verify_token || "",
    connectedAt: s.instagram_connected_at || null,
    lastWebhook: s.instagram_last_webhook || null,
    lastError: s.instagram_last_error || null,
    state: s.instagram_oauth_state || ""
  };
}

async function igFetch(url, init = {}) {
  const res = await fetch(url, init);
  let data = null;
  try { data = await res.json(); } catch { /* sem corpo */ }
  if (!res.ok || data?.error || data?.error_message) {
    const e = data?.error || {};
    const msg = e.message || data?.error_message || `HTTP ${res.status}`;
    const extra = [e.error_user_title, e.error_user_msg].filter(Boolean).join(" — ");
    throw new IgError("erro_instagram", `${msg}${e.code ? " (código " + e.code + (e.error_subcode ? "/" + e.error_subcode : "") + ")" : ""}${extra ? ": " + extra : ""}`);
  }
  return data;
}

async function api(env, path, { method = "GET", json, params } = {}) {
  const cfg = await igConfig(env);
  if (!cfg.token) throw new IgError("instagram_desconectado", "Conecte o Instagram em /admin › Instagram.");
  const url = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const init = { method, headers: { authorization: "Bearer " + cfg.token } };
  if (json) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(json); }
  return igFetch(url, init);
}

/* ------------------------------------------------------------------
   Conexão (login do Instagram)
   ------------------------------------------------------------------ */

export function redirectUri(origin) { return origin + "/api/instagram/callback"; }

export async function saveInstagramSettings(env, body) {
  const vals = {};
  if (body.app_id !== undefined) vals.instagram_app_id = String(body.app_id || "").replace(/\D/g, "") || null;
  const secret = String(body.app_secret || "").trim();
  if (secret && !/^[0-9a-f]{32}$/i.test(secret)) throw new IgError("app_secret_invalido", "A chave secreta do app do Instagram tem 32 caracteres (0-9, a-f).");
  if (secret) vals.instagram_app_secret = secret;
  const cur = await getSettings(env, ["instagram_verify_token"]);
  if (!cur.instagram_verify_token) vals.instagram_verify_token = hex(24);
  await setSettings(env, vals);
}

/** Link do login do Instagram (o state protege o retorno contra outro site). */
export async function authUrl(env, origin) {
  const cfg = await igConfig(env);
  if (!cfg.appId || !cfg.appSecret) throw new IgError("instagram_sem_app", "Cadastre o ID e a chave secreta do app do Instagram.");
  const state = hex(16);
  await setSettings(env, { instagram_oauth_state: state });
  const u = new URL("https://www.instagram.com/oauth/authorize");
  u.searchParams.set("client_id", cfg.appId);
  u.searchParams.set("redirect_uri", redirectUri(origin));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPES.join(","));
  u.searchParams.set("state", state);
  u.searchParams.set("enable_fb_login", "0");
  return u.toString();
}

/** Volta do login: troca o code por token de 60 dias, lê a conta e assina o webhook. */
export async function handleInstagramCallback(request, env, isLogged) {
  const url = new URL(request.url);
  const back = (s, msg) => Response.redirect(new URL("/admin#instagram", url).toString() + "?ig=" + s + (msg ? "&msg=" + encodeURIComponent(msg.slice(0, 300)) : ""), 302);
  if (!(await isLogged(request))) return back("erro", "Entre no CRM antes de conectar o Instagram.");
  const cfg = await igConfig(env);
  if (url.searchParams.get("error")) return back("erro", url.searchParams.get("error_description") || url.searchParams.get("error"));
  if (!cfg.state || url.searchParams.get("state") !== cfg.state) return back("erro", "Link de conexão expirado. Clique em Conectar de novo.");
  const code = String(url.searchParams.get("code") || "").replace(/#_$/, "");
  if (!code) return back("erro", "O Instagram não devolveu o código de autorização.");
  try {
    await setSettings(env, { instagram_oauth_state: null });
    const curto = await igFetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cfg.appId, client_secret: cfg.appSecret, grant_type: "authorization_code", redirect_uri: redirectUri(url.origin), code }).toString()
    });
    const longo = await igFetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(cfg.appSecret)}&access_token=${encodeURIComponent(curto.access_token)}`);
    await salvarToken(env, longo);
    const me = await api(env, "/me", { params: { fields: "user_id,username,name" } });
    await api(env, "/me/subscribed_apps", { method: "POST", params: { subscribed_fields: "messages,comments" } });
    await setSettings(env, {
      instagram_user_id: String(me.user_id || me.id || ""), instagram_username: me.username || null, instagram_name: me.name || null,
      instagram_connected_at: now(), instagram_last_error: null
    });
    return back("ok");
  } catch (err) {
    await setSettings(env, { instagram_last_error: JSON.stringify({ etapa: "conexão", erro: err.message, em: now() }) }).catch(() => {});
    return back("erro", err.message);
  }
}

async function salvarToken(env, r) {
  await setSettings(env, {
    instagram_token: r.access_token,
    instagram_token_expires: r.expires_in ? new Date(Date.now() + Number(r.expires_in) * 1000).toISOString() : null
  });
}

/** Cron: renova o token quando faltam menos de 20 dias (o da Meta vale 60). */
export async function refreshInstagramToken(env) {
  const cfg = await igConfig(env);
  if (!cfg.token || !cfg.expires) return;
  if (Date.parse(cfg.expires) - Date.now() > 20 * 86400000) return;
  const r = await igFetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(cfg.token)}`);
  await salvarToken(env, r);
}

export async function disconnectInstagram(env) {
  await setSettings(env, { instagram_token: null, instagram_token_expires: null, instagram_connected_at: null });
}

export async function instagramStatus(env, origin) {
  const cfg = await igConfig(env);
  const c = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM ig_contacts) AS conversas, (SELECT COALESCE(SUM(unread),0) FROM ig_contacts) AS nao_lidas"
  ).first().catch(() => ({ conversas: 0, nao_lidas: 0 }));
  return {
    app_id: cfg.appId,
    tem_app_secret: !!cfg.appSecret,
    conectado: !!cfg.token,
    conectado_em: cfg.connectedAt,
    usuario: cfg.username,
    nome: cfg.name,
    token_expira: cfg.expires,
    redirect_uri: redirectUri(origin),
    callback_url: origin + "/api/instagram/webhook",
    verify_token: cfg.verifyToken,
    ultima_notificacao: cfg.lastWebhook,
    ultimo_erro: cfg.lastError,
    ...c
  };
}

/* ------------------------------------------------------------------
   Webhook
   ------------------------------------------------------------------ */

async function validSignature(request, raw, secret) {
  const header = request.headers.get("x-hub-signature-256") || "";
  if (!secret || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(raw));
  const expected = "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const a = enc.encode(expected), b = enc.encode(header);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const ANEXOS = { image: "imagem", video: "vídeo", audio: "áudio", file: "arquivo", share: "post compartilhado", story_mention: "menção no story", reel: "reel", ig_reel: "reel" };

function textoDm(msg) {
  const anexos = (msg.attachments || []).map((a) => "[" + (ANEXOS[a.type] || a.type || "anexo") + "]");
  if (msg.reply_to?.story) anexos.unshift("[resposta ao story]");
  return [msg.text || "", ...anexos].filter(Boolean).join(" ").slice(0, 2000);
}

/** Grava a mensagem uma vez só (a Meta reenvia notificações) e atualiza a conversa. Devolve false se já existia. */
async function gravar(env, m) {
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO ig_messages (id, ig_id, kind, direction, text, attachment, media_id, media_link, parent_id, reply_mode, user, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(m.id, m.ig_id, m.kind, m.direction, m.text ?? null, m.attachment ?? null, m.media_id ?? null, m.media_link ?? null,
    m.parent_id ?? null, m.reply_mode ?? null, m.user ?? null, m.at).run();
  if (!r.meta?.changes) return false;
  const entrada = m.direction === "in";
  await env.DB.prepare(
    `INSERT INTO ig_contacts (ig_id, username, name, last_at, last_text, last_kind, last_inbound_at, last_dm_inbound_at, last_outbound_at, unread)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(ig_id) DO UPDATE SET
       username = COALESCE(?2, username), name = COALESCE(?3, name),
       last_at = CASE WHEN last_at IS NULL OR ?4 >= last_at THEN ?4 ELSE last_at END,
       last_text = CASE WHEN last_at IS NULL OR ?4 >= last_at THEN ?5 ELSE last_text END,
       last_kind = CASE WHEN last_at IS NULL OR ?4 >= last_at THEN ?6 ELSE last_kind END,
       last_inbound_at = CASE WHEN ?7 IS NOT NULL AND (last_inbound_at IS NULL OR ?7 > last_inbound_at) THEN ?7 ELSE last_inbound_at END,
       last_dm_inbound_at = CASE WHEN ?8 IS NOT NULL AND (last_dm_inbound_at IS NULL OR ?8 > last_dm_inbound_at) THEN ?8 ELSE last_dm_inbound_at END,
       last_outbound_at = CASE WHEN ?9 IS NOT NULL AND (last_outbound_at IS NULL OR ?9 > last_outbound_at) THEN ?9 ELSE last_outbound_at END,
       unread = CASE WHEN ?10 = 1 THEN unread + 1 ELSE 0 END`
  ).bind(m.ig_id, m.username ?? null, m.name ?? null, m.at, (m.text || m.attachment || "").slice(0, 200), m.kind,
    entrada ? m.at : null, entrada && m.kind === "dm" ? m.at : null, entrada ? null : m.at, entrada ? 1 : 0).run();
  return true;
}

/** Nome e @ de quem mandou direct (a Meta só libera para quem já falou com a conta). */
async function perfil(env, igId) {
  const c = await env.DB.prepare("SELECT username FROM ig_contacts WHERE ig_id = ?").bind(igId).first();
  if (c?.username) return;
  try {
    const p = await api(env, "/" + encodeURIComponent(igId), { params: { fields: "name,username" } });
    await env.DB.prepare("UPDATE ig_contacts SET username = COALESCE(?, username), name = COALESCE(?, name) WHERE ig_id = ?")
      .bind(p.username || null, p.name || null, igId).run();
  } catch (err) { console.error("ig_perfil", err.message); }
}

/** Link do post comentado (guardado uma vez por post). */
async function linkDoPost(env, mediaId) {
  if (!mediaId) return null;
  const ja = await env.DB.prepare("SELECT media_link FROM ig_messages WHERE media_id = ? AND media_link IS NOT NULL LIMIT 1").bind(mediaId).first();
  if (ja) return ja.media_link;
  try { return (await api(env, "/" + encodeURIComponent(mediaId), { params: { fields: "permalink" } }))?.permalink || null; }
  catch { return null; }
}

const quando = (t) => {
  const n = Number(t);
  if (!n) return now();
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
};

async function processar(env, body) {
  const cfg = await igConfig(env);
  const conta = cfg.userId;
  const depois = [];
  for (const entry of body.entry || []) {
    const dono = String(entry.id || conta);
    // Direct
    for (const ev of entry.messaging || []) {
      const msg = ev.message;
      if (!msg?.mid || msg.is_deleted || msg.is_unsupported) continue;
      const daLoja = !!msg.is_echo || String(ev.sender?.id) === dono;
      const igId = String(daLoja ? ev.recipient?.id : ev.sender?.id || "");
      if (!igId || igId === dono) continue;
      const novo = await gravar(env, {
        id: msg.mid, ig_id: igId, kind: "dm", direction: daLoja ? "out" : "in", text: textoDm(msg),
        attachment: (msg.attachments || [])[0]?.type || null, at: quando(ev.timestamp)
      });
      if (novo && !daLoja) depois.push(() => perfil(env, igId));
    }
    // Comentários nos posts
    for (const ch of entry.changes || []) {
      if (ch.field !== "comments" && ch.field !== "live_comments") continue;
      const v = ch.value || {};
      if (!v.id || !v.from?.id) continue;
      const daLoja = String(v.from.id) === dono;
      const mediaId = v.media?.id ? String(v.media.id) : null;
      let igId = String(v.from.id);
      if (daLoja) {
        // Resposta da loja (pelo app ou pelo CRM): fica na conversa de quem fez o comentário respondido
        const pai = v.parent_id ? await env.DB.prepare("SELECT ig_id FROM ig_messages WHERE id = ?").bind(String(v.parent_id)).first() : null;
        if (!pai) continue;
        igId = pai.ig_id;
      }
      await gravar(env, {
        id: String(v.id), ig_id: igId, kind: "comentario", direction: daLoja ? "out" : "in", text: String(v.text || "").slice(0, 2000),
        username: daLoja ? null : v.from.username || null, media_id: mediaId, media_link: await linkDoPost(env, mediaId),
        parent_id: v.parent_id ? String(v.parent_id) : null, reply_mode: daLoja ? "publico" : null, at: quando(entry.time)
      });
    }
  }
  for (const f of depois) await f();
}

export async function handleInstagramWebhook(request, env, deps = {}) {
  const url = new URL(request.url);
  const cfg = await igConfig(env);
  if (request.method === "GET") {
    if (url.searchParams.get("hub.mode") === "subscribe" && cfg.verifyToken && url.searchParams.get("hub.verify_token") === cfg.verifyToken) {
      return new Response(url.searchParams.get("hub.challenge") || "", { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }
  if (request.method !== "POST") return new Response("OK");
  const raw = await request.text();
  if (!(await validSignature(request, raw, cfg.appSecret))) return new Response("Assinatura inválida", { status: 401 });
  let body;
  try { body = JSON.parse(raw); } catch { return new Response("OK"); }
  await setSettings(env, { instagram_last_webhook: now() });
  const job = processar(env, body).catch(async (err) => {
    console.error("instagram_webhook_error", err?.stack || err?.message);
    await setSettings(env, { instagram_last_error: JSON.stringify({ etapa: "notificação", erro: err.message, em: now() }) }).catch(() => {});
  });
  if (deps.waitUntil) deps.waitUntil(job); else await job;
  return new Response("OK");
}

/* ------------------------------------------------------------------
   Caixa de entrada do CRM
   ------------------------------------------------------------------ */

export async function listConversas(env) {
  const { results } = await env.DB.prepare(
    `SELECT ig_id, username, name, lead_id, last_at, last_text, last_kind, last_inbound_at, last_dm_inbound_at, last_outbound_at, unread
       FROM ig_contacts ORDER BY last_at DESC LIMIT 300`
  ).all();
  return results;
}

export async function getConversa(env, igId) {
  const contato = await env.DB.prepare("SELECT * FROM ig_contacts WHERE ig_id = ?").bind(igId).first();
  if (!contato) return null;
  const { results } = await env.DB.prepare(
    "SELECT id, kind, direction, text, attachment, media_id, media_link, parent_id, reply_mode, user, created_at FROM ig_messages WHERE ig_id = ? ORDER BY created_at, rowid"
  ).bind(igId).all();
  if (contato.unread) await env.DB.prepare("UPDATE ig_contacts SET unread = 0 WHERE ig_id = ?").bind(igId).run();
  // Respostas privadas já feitas (a Meta aceita uma por comentário)
  const respondidos = new Set(results.filter((m) => m.reply_mode === "privado" && m.parent_id).map((m) => m.parent_id));
  const agora = Date.now();
  return {
    contato: { ...contato, unread: 0 },
    mensagens: results.map((m) => ({
      ...m,
      pode_privada: m.kind === "comentario" && m.direction === "in" && !respondidos.has(m.id) && agora - Date.parse(m.created_at) < JANELA_PRIVADA_MS
    })),
    pode_dm: !!contato.last_dm_inbound_at && agora - Date.parse(contato.last_dm_inbound_at) < JANELA_DM_MS
  };
}

/**
 * Resposta da loja pelo CRM.
 * modo "dm": direct (janela de 24h) · "publico": responde o comentário no post · "privado": direct a partir de um comentário
 */
export async function responder(env, igId, body, user) {
  const text = String(body.text || "").trim();
  if (!text) throw new IgError("texto_vazio", "Escreva a mensagem.");
  if (text.length > 1000) throw new IgError("texto_longo", "O Instagram aceita até 1.000 caracteres.");
  const conv = await getConversa(env, igId);
  if (!conv) throw new IgError("not_found", "Conversa não encontrada.");
  const modo = ["dm", "publico", "privado"].includes(body.modo) ? body.modo : "dm";
  const at = now();

  if (modo === "dm") {
    if (!conv.pode_dm) throw new IgError("fora_da_janela", "O Instagram só permite responder no direct até 24h depois da última mensagem da pessoa. Responda o comentário no post ou aguarde ela escrever de novo.");
    const r = await api(env, "/me/messages", { method: "POST", json: { recipient: { id: igId }, message: { text } } });
    await gravar(env, { id: r.message_id || "crm-" + hex(8), ig_id: igId, kind: "dm", direction: "out", text, user, at });
    return { ok: true };
  }

  const alvo = conv.mensagens.find((m) => m.id === String(body.comment_id || "") && m.kind === "comentario" && m.direction === "in");
  if (!alvo) throw new IgError("comentario_nao_encontrado", "Escolha o comentário que você quer responder.");
  if (modo === "publico") {
    const r = await api(env, "/" + encodeURIComponent(alvo.id) + "/replies", { method: "POST", params: { message: text } });
    await gravar(env, { id: r.id || "crm-" + hex(8), ig_id: igId, kind: "comentario", direction: "out", text, media_id: alvo.media_id, media_link: alvo.media_link, parent_id: alvo.id, reply_mode: "publico", user, at });
    return { ok: true };
  }
  if (!alvo.pode_privada) throw new IgError("privada_indisponivel", "Este comentário já recebeu resposta no direct ou tem mais de 7 dias.");
  const r = await api(env, "/me/messages", { method: "POST", json: { recipient: { comment_id: alvo.id }, message: { text } } });
  await gravar(env, { id: r.message_id || "crm-" + hex(8), ig_id: igId, kind: "dm", direction: "out", text, parent_id: alvo.id, reply_mode: "privado", user, at });
  return { ok: true };
}

/** Conversa no formato da IA (mais antigas primeiro). */
export function paraIa(conv) {
  return conv.mensagens.slice(-40).map((m) => ({
    de: m.direction === "in" ? "cliente" : "loja",
    texto: (m.kind === "comentario" ? (m.direction === "in" ? "[comentário no post] " : "[resposta no post] ") : "") + (m.text || m.attachment || ""),
    em: m.created_at
  }));
}

/**
 * Foto de perfil de quem mandou direct (a Meta só libera para quem já falou com a conta; quem só comentou fica com a letra).
 * O link da foto do Instagram expira: o CRM busca de novo e guarda a imagem no cache da Cloudflare por 1 dia
 * (a ausência de foto fica 6h no cache, para não consultar a API a cada atualização da tela).
 */
export async function fotoPerfil(env, igId) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request("https://ig-foto.cache/" + encodeURIComponent(igId));
  const semFoto = () => new Response(null, { status: 404, headers: { "cache-control": "private, max-age=21600" } });
  const comFoto = (buf, tipo) => new Response(buf, { headers: { "content-type": tipo, "cache-control": "private, max-age=86400" } });
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit.headers.get("x-sem-foto") ? semFoto() : comFoto(await hit.arrayBuffer(), hit.headers.get("content-type") || "image/jpeg");
  }
  let buf = null, tipo = "image/jpeg";
  try {
    const p = await api(env, "/" + encodeURIComponent(igId), { params: { fields: "profile_pic" } });
    if (p?.profile_pic) {
      const img = await fetch(p.profile_pic);
      tipo = img.headers.get("content-type") || tipo;
      if (img.ok && tipo.startsWith("image/")) buf = await img.arrayBuffer();
    }
  } catch (err) {
    if (err?.code === "instagram_desconectado") return semFoto(); // sem guardar: volta a funcionar ao reconectar
  }
  if (cache) {
    await cache.put(key, buf
      ? new Response(buf, { headers: { "content-type": tipo, "cache-control": "public, max-age=86400" } })
      : new Response("", { headers: { "x-sem-foto": "1", "cache-control": "public, max-age=21600" } }));
  }
  return buf ? comFoto(buf, tipo) : semFoto();
}
