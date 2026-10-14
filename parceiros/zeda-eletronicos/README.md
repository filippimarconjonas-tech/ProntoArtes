# Landing page — Zé da Reciclagem (coleta de eletrônicos)

Página única e autocontida (`index.html`, sem dependências além da fonte Inter do Google Fonts).
Fica fora de `public/` de propósito: **não** é publicada no Worker da Pronto Artes.
Para publicar, suba o `index.html` em qualquer hospedagem estática (Cloudflare Pages, Netlify, Hostinger etc.).

## Configuração (topo do `index.html`, `window.ZEDA_CONFIG`)
- `whatsapp` — número que recebe os leads (`5521990380320`)
- `leadEndpoint` — URL opcional que recebe cada lead em JSON (planilha, CRM, Make/Zapier/n8n). Vazio = só abre o WhatsApp
- `exitIntent` — popup de saída no desktop (1x por sessão)

## Fluxo de conversão
Todo CTA de WhatsApp abre um popup de qualificação em 3 passos:
1. Perfil (casa / condomínio / empresa / escola-órgão) + itens a descartar
2. Quantidade + prazo (+ certificado de destinação e cuidado com dados, para empresas)
3. Nome, WhatsApp e bairro/cidade (+ empresa)

Ao enviar, o lead vai para o `leadEndpoint` (se houver) e o visitante cai no WhatsApp com a mensagem já preenchida.
O formulário do rodapé faz o mesmo. Cada lead recebe uma faixa:
- **A — Quente:** condomínio/empresa/órgão, volume grande ou coleta recorrente
- **B — Morno:** residência com prazo definido
- **C — Frio:** "só pesquisando"

## Rastreamento
Eventos no `dataLayer` (GTM): `lead_form_open`, `lead_step`, `generate_lead` (com `origem`, `perfil`, `faixa`).
Se o Meta Pixel estiver instalado, dispara `Lead` e `LeadFormOpen`. UTMs, gclid e fbclid vão junto com o lead.
