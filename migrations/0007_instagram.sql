-- Instagram: direct e comentários da conta @pronto.artes

-- Cada pessoa que falou com a loja no Instagram (direct ou comentário)
CREATE TABLE IF NOT EXISTS ig_contacts (
  ig_id TEXT PRIMARY KEY,            -- id da pessoa no Instagram (IGSID)
  username TEXT,
  name TEXT,
  lead_id INTEGER,                   -- lead do CRM ligado a esta pessoa (opcional)
  last_at TEXT,                      -- última mensagem (de qualquer lado)
  last_text TEXT,
  last_kind TEXT,                    -- dm / comentario
  last_inbound_at TEXT,
  last_dm_inbound_at TEXT,           -- janela de 24h do direct conta a partir daqui
  last_outbound_at TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ig_contacts_last ON ig_contacts(last_at);

-- Mensagens do direct e comentários (id da Meta: mid do direct ou id do comentário)
CREATE TABLE IF NOT EXISTS ig_messages (
  id TEXT PRIMARY KEY,
  ig_id TEXT NOT NULL,               -- pessoa da conversa
  kind TEXT NOT NULL,                -- dm / comentario
  direction TEXT NOT NULL,           -- in (cliente) / out (loja)
  text TEXT,
  attachment TEXT,                   -- tipo do anexo do direct (imagem, vídeo, story…)
  media_id TEXT,                     -- post comentado
  media_link TEXT,                   -- link do post
  parent_id TEXT,                    -- comentário respondido
  reply_mode TEXT,                   -- resposta da loja a comentário: publico / privado
  user TEXT,                         -- quem respondeu pelo CRM
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ig_messages_contact ON ig_messages(ig_id, created_at);
