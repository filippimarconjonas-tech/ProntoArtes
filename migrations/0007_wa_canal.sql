-- Número da loja pelo qual o cliente escreveu por último (a loja tem mais de um WhatsApp)
ALTER TABLE leads ADD COLUMN wa_phone_id TEXT;   -- phone_number_id da Meta
ALTER TABLE leads ADD COLUMN wa_canal TEXT;      -- número exibido, ex.: 5524988370399
