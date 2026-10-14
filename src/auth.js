/**
 * Autenticação do painel /admin: senha com PBKDF2 e sessão em cookie HttpOnly.
 */

const ITERATIONS = 100000;
const SESSION_DAYS = 30;
export const COOKIE = "pa_session";

const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => new Uint8Array(hex.match(/.{2}/g).map((h) => parseInt(h, 16)));

export async function hashPassword(password, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS }, key, 256);
  return { hash: toHex(bits), salt: toHex(salt) };
}

function safeEqual(a, b) {
  const ab = enc.encode(a), bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(ab, bb);
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export async function verifyPassword(password, user) {
  const { hash } = await hashPassword(password, user.pass_salt);
  return safeEqual(hash, user.pass_hash);
}

async function sha256(text) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export async function createSession(env, userId) {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), userId, expires).run();
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export async function getSessionUser(request, env) {
  const token = readCookie(request, COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  return env.DB.prepare(
    `SELECT u.id, u.username, u.name FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(await sha256(token)).first();
}

export async function destroySession(request, env) {
  const token = readCookie(request, COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Bloqueia o IP após 8 tentativas erradas em 15 minutos. */
export async function tooManyAttempts(env, ip) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes')"
  ).bind(ip).first();
  return (row?.n || 0) >= 8;
}

export async function recordFailedAttempt(env, ip) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO login_attempts (ip) VALUES (?)").bind(ip),
    env.DB.prepare("DELETE FROM login_attempts WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')")
  ]);
}
