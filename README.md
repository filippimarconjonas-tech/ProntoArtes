# Pronto Artes — Landing page

Landing page única da Pronto Artes (ferro fundido: chafarizes, postes, esculturas, vasos, lenheiros e mobiliário urbano), publicada no Cloudflare Worker `prontoartes` a cada push na `main`.

## Estrutura
- `public/` — site estático (`index.html`, `assets/css`, `assets/js`, `assets/img`)
- `public/admin/` + `public/assets/admin/` — painel do CRM (login e app)
- `src/crm.js` — pipelines, etapas e regras de qualificação (faixas A/B/C e score)
- `src/auth.js` — login (PBKDF2) e sessões
- `migrations/` — schema do banco D1 `prontoartes-crm`
- `public/assets/js/config.js` — número do WhatsApp, endpoint de leads, opções de interesse, popup de saída
- `src/worker.js` — serve o site e recebe os leads em `POST /api/lead`
- `wrangler.jsonc` — configuração do Worker

## Fluxo de conversão
Todo CTA de WhatsApp abre um popup de qualificação em 2 passos (interesse → espaço → prazo → nome/WhatsApp/cidade).
Ao enviar, o lead vai para `/api/lead` e o visitante é levado ao WhatsApp com a mensagem já preenchida com as respostas.
O formulário do rodapé faz o mesmo.

## CRM (/admin)
Todo lead do site é gravado no banco D1 e aparece em `/admin` (login e senha).

**Qualificação automática** (pela pergunta "Quando pretende comprar?"):
- **A — Quente:** agora ou em até 30 dias → Funil de vendas › Novo lead
- **B — Morno:** de 1 a 3 meses → Funil de vendas › Novo lead
- **C — Frio:** só pesquisando → Nutrição › Só pesquisando

O **score (0–100)** ordena os leads dentro da faixa: prazo, perfil (arquiteto/paisagista, comércio, órgão público, fazenda),
produto escolhido, kit, e-mail, descrição do projeto e reenvios. A faixa pode ser ajustada manualmente na ficha do lead.

**Pipelines**
- *Funil de vendas:* Novo lead → Em atendimento → Orçamento enviado → Negociação/follow-up → Aguardando pagamento → Venda fechada / Perdido
- *Nutrição (Lead C):* Só pesquisando → Conteúdo enviado → Reaquecido → Sem interesse
- *Pós-venda:* Pedido pago → Separação/produção → Enviado → Entregue → Avaliação/recompra

"Venda fechada" exige o canal (site Tray ou WhatsApp da loja) e aceita valor e nº do pedido Tray; "Perdido" exige o motivo.
Um lead que envia o formulário de novo é atualizado (não duplica) e, se estava em nutrição ou perdido, volta para o funil de vendas.
Leads que chamam direto no WhatsApp entram sozinhos pela integração abaixo (ou em "+ Novo lead").

## WhatsApp (Cloud API em coexistência)
- Webhook: `/api/whatsapp/webhook` (campos `messages` e `smb_message_echoes`), assinatura validada com a chave secreta do app.
- Credenciais são cadastradas em `/admin` › WhatsApp e ficam na tabela `settings` do D1 (nunca no repositório).
- "Salvar e conectar" cadastra o webhook e assina a conta; "Conectar número da loja" roda o Cadastro incorporado
  da Meta em modo coexistência (exige app aprovado como Provedor de Tecnologia e um Configuration ID do Login do Facebook para Empresas).

## Atendimento com IA (Claude)
`/admin` › Atendimento IA. A chave da API fica no Secret `ANTHROPIC_API_KEY` do Worker (Cloudflare › Settings › Variables and Secrets), nunca no repositório.
- **Modos:** desligado (só sob demanda) · rascunho (cada mensagem do cliente gera uma sugestão na ficha do lead; o vendedor revisa e envia) ·
  automático fora do horário (seg–sex 8h–18h, sáb 8h–13h30; dentro do horário deixa rascunho) · automático sempre.
- Usa o catálogo importado (preço da loja, medidas, descrição, link), as respostas do formulário e a conversa do WhatsApp do lead.
- Regras fixas: nunca dá desconto, nunca promete prazo, nunca informa frete, nunca confirma cor/peça sob medida. O texto "Informações da loja" é editável no painel.
- Quando o cliente precisa de vendedor (orçamento, frete, prazo, desconto, fechamento, reclamação, pedido de atendente), a IA avisa o cliente,
  pausa a si mesma no lead, marca follow-up e registra o motivo no histórico.
- A IA também pausa no lead quando a equipe responde por conta própria (app do WhatsApp ou texto livre no CRM). Reative na ficha do lead.
- Simulador no painel para testar sem enviar nada; consumo de tokens do mês aparece no status.
- Código: `src/ai.js` (modelo `claude-opus-5-5`, esforço baixo, cache de 1h do prompt, saída em JSON e fallback automático do servidor em caso de recusa).
  O catálogo vai enxuto (uma linha por produto); a descrição completa é consultada pela ferramenta `ver_produtos` só quando o cliente pergunta.

## Catálogo de produtos
`/admin` › Produtos: importa a planilha exportada da Tray (Produtos › Exportar, CSV). Cria ou atualiza pelo código do produto
(preço, promoção com datas, estoque, medidas, descrição, fotos, link). A landing lê `/api/products` e monta a vitrine
com os mais vendidos de cada linha (só quando o catálogo cobre ao menos 4 linhas; senão mantém a vitrine fixa do `main.js`).

## Loja Tray
`/admin` › Loja Tray: endereço da API (`https://…/web_api`), consumer key/secret do aplicativo Tray e o `code` de autorização da loja.
- Pedido aguardando pagamento → lead em *Aguardando pagamento*; pago → *Venda fechada (Site Tray)* com valor e nº do pedido;
  enviado/entregue → pós-venda. Cancelado só gera aviso no histórico.
- Cada pedido fica ligado ao seu lead (tabela `tray_orders`); pedido novo é ligado pelo telefone ou e-mail do cliente. Cliente que já fechou outra venda gera nova oportunidade (recompra). Reprocessar um pedido sem mudança de status não altera nada.
- Notificações: `/api/tray/webhook?key=…` (URL exibida no painel). Responde 200 na hora e processa em seguida; pedidos são sempre relidos na API da Tray.
- Sincronização automática a cada 30 minutos (Cron Trigger em `wrangler.jsonc`) recupera notificações que falharam. O último erro aparece no painel.

## Páginas legais
`/privacidade` e `/exclusao-de-dados` — usar nos campos de URL do app na Meta.

Novas migrações: `npx wrangler d1 migrations apply prontoartes-crm --remote`.

## Receber os leads também fora do CRM (opcional)
No painel da Cloudflare → Workers → `prontoartes` → Settings → Variables and Secrets, crie `LEAD_WEBHOOK_URL`
com a URL que deve receber cada lead em JSON (Google Apps Script/Planilha, Make, Zapier, n8n, RD Station, CRM).
Sem essa variável os leads aparecem apenas nos logs do Worker (Observability).

## Rastreamento
Cole GTM / Meta Pixel / TikTok Pixel no `<head>` do `public/index.html`. Eventos disparados:
`lead_form_open`, `lead_form_step2`, `generate_lead` (+ `fbq Lead`, `ttq SubmitForm`), `product_filter`, `scroll_depth`.
UTMs, gclid e fbclid são capturados e enviados junto com o lead.

## Rodar localmente
```bash
npx wrangler dev
```
