-- Atendimento com IA (Claude)
ALTER TABLE leads ADD COLUMN ai_draft TEXT;          -- resposta sugerida aguardando aprovação
ALTER TABLE leads ADD COLUMN ai_draft_at TEXT;
ALTER TABLE leads ADD COLUMN ai_pausada INTEGER NOT NULL DEFAULT 0; -- 1 = humano assumiu, IA não responde sozinha

-- Consumo da API (tokens) para acompanhar o custo no painel
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  lead_id INTEGER,
  tipo TEXT,                       -- rascunho / automatico / simulador / teste
  modelo TEXT,
  input_tokens INTEGER, output_tokens INTEGER,
  cache_read INTEGER, cache_write INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);
