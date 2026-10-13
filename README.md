# Pronto Artes — Landing page

Landing page única da Pronto Artes (ferro fundido: chafarizes, postes, esculturas, vasos, lenheiros e mobiliário urbano), publicada no Cloudflare Worker `prontoartes` a cada push na `main`.

## Estrutura
- `public/` — site estático (`index.html`, `assets/css`, `assets/js`, `assets/img`)
- `public/assets/js/config.js` — número do WhatsApp, endpoint de leads, opções de interesse, popup de saída
- `src/worker.js` — serve o site e recebe os leads em `POST /api/lead`
- `wrangler.jsonc` — configuração do Worker

## Fluxo de conversão
Todo CTA de WhatsApp abre um popup de qualificação em 2 passos (interesse → espaço → prazo → nome/WhatsApp/cidade).
Ao enviar, o lead vai para `/api/lead` e o visitante é levado ao WhatsApp com a mensagem já preenchida com as respostas.
O formulário do rodapé faz o mesmo.

## Receber os leads
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
