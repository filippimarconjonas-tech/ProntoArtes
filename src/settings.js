/** Configurações guardadas no D1 (tabela settings). Variáveis de ambiente têm prioridade. */

export async function getSettings(env, keys) {
  const out = {};
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM settings WHERE key IN (${keys.map(() => "?").join(",")})`
  ).bind(...keys).all();
  for (const r of results) out[r.key] = r.value;
  return out;
}

export async function setSettings(env, values) {
  const stmts = Object.entries(values).map(([k, v]) =>
    v == null
      ? env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(k)
      : env.DB.prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"
        ).bind(k, String(v))
  );
  if (stmts.length) await env.DB.batch(stmts);
}
