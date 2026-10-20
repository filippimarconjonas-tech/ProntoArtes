-- Pedidos da Tray ligados aos leads (um lead pode ter vários pedidos)
CREATE TABLE IF NOT EXISTS tray_orders (
  pedido TEXT PRIMARY KEY,           -- nº do pedido na Tray
  lead_id INTEGER NOT NULL,
  status TEXT,                       -- último status processado
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tray_orders_lead ON tray_orders(lead_id);
