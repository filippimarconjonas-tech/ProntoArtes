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
