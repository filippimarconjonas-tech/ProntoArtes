-- Mensagens do WhatsApp já processadas (a Meta reenvia webhooks em caso de falha)
CREATE TABLE IF NOT EXISTS wa_messages (
  id TEXT PRIMARY KEY,
  lead_id INTEGER,
  direction TEXT NOT NULL,          -- in (cliente) / out (loja, pelo app)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE leads ADD COLUMN last_inbound_at TEXT;
ALTER TABLE leads ADD COLUMN last_outbound_at TEXT;
