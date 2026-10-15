-- Catálogo de produtos (importado da Tray: planilha agora, API depois)
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,               -- Código produto na Tray
  nome TEXT NOT NULL,
  categoria TEXT,
  preco REAL,                        -- preço de venda
  preco_promo REAL,                  -- 0/NULL = sem promoção
  promo_inicio TEXT,
  promo_fim TEXT,
  estoque INTEGER,
  disponivel INTEGER NOT NULL DEFAULT 1,
  exibir INTEGER NOT NULL DEFAULT 1,
  peso_g REAL,
  comprimento REAL, largura REAL, altura REAL,
  vendidos INTEGER DEFAULT 0,
  descricao TEXT,                    -- texto limpo (sem HTML)
  url TEXT,
  imagens TEXT,                      -- JSON com as URLs
  origem TEXT,                       -- planilha / api
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_products_categoria ON products(categoria);
