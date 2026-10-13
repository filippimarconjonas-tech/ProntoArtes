-- CRM Pronto Artes — schema inicial

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  name TEXT,
  pass_hash TEXT NOT NULL,
  pass_salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip, created_at);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- dados do contato
  nome TEXT NOT NULL,
  whatsapp TEXT NOT NULL,          -- só dígitos, com DDI 55
  cidade TEXT,
  email TEXT,

  -- respostas do formulário
  produto TEXT,
  interesse TEXT,
  espaco TEXT,
  prazo TEXT,
  mensagem TEXT,

  -- qualificação
  faixa TEXT NOT NULL DEFAULT 'B',  -- A / B / C
  faixa_manual INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  perfil TEXT,                      -- Consumidor final / Profissional / B2B

  -- funil
  pipeline TEXT NOT NULL DEFAULT 'vendas',   -- vendas / nutricao
  stage TEXT NOT NULL DEFAULT 'novo',
  stage_changed_at TEXT,
  post_stage TEXT,                  -- pós-venda (quando ganho)
  next_followup_at TEXT,
  first_contact_at TEXT,

  -- fechamento
  valor REAL,
  canal_fechamento TEXT,            -- site_tray / whatsapp
  pedido_tray TEXT,
  motivo_perda TEXT,
  won_at TEXT,
  lost_at TEXT,

  -- origem
  origem TEXT,
  canal_entrada TEXT,               -- site / whatsapp / manual
  pagina TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
  gclid TEXT, fbclid TEXT, referrer TEXT,
  ip_pais TEXT,
  envios INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_leads_whatsapp ON leads(whatsapp);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(pipeline, stage);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);

CREATE TABLE IF NOT EXISTS lead_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  type TEXT NOT NULL,               -- criado / reenvio / etapa / nota / campo
  text TEXT,
  user TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_lead ON lead_events(lead_id, created_at);
