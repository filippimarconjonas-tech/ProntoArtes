# Landing page — Zé da Reciclagem (coleta de eletrônicos)

Página única e autocontida (`index.html`, sem dependências além da fonte Inter do Google Fonts).
Fica fora de `public/` de propósito: **não** é publicada no Worker da Pronto Artes.
Para publicar, suba o `index.html` em qualquer hospedagem estática (Cloudflare Pages, Netlify, Hostinger etc.).

## Colar em um editor (Elementor, WordPress, construtores de site)
Copie tudo de `<script>` (config) até antes de `</body>` e cole em um widget/bloco de **HTML personalizado**.
- Todo o CSS fica restrito a `#zeda-lp` e `#zeda-lp-overlay`, então o tema do site não altera botões, títulos e fontes.
- A página se estica sozinha para a largura total da tela, mesmo dentro de um container estreito
  (ainda assim, prefira deixar a seção do editor em "largura total" e sem espaçamento).
- O popup e os botões flutuantes são movidos para o `<body>` para não ficarem cortados.
- O popup de saída não abre dentro do editor/preview, nem nos primeiros 10 segundos.

## Fotos
As fotos vêm do Unsplash (licença gratuita, uso comercial permitido), carregadas por
`https://unsplash.com/photos/<ID>/download?w=<largura>`. Se alguma não carregar, aparece um fundo verde com o ícone de reciclagem.
Para trocar, substitua o `src` da `<img>` (o ideal é usar fotos reais da equipe, do caminhão e das coletas):

| Onde | ID Unsplash | Conteúdo |
|---|---|---|
| Topo | `bHR2emO4iL0` | celulares e aparelhos antigos |
| Faixa "O que coletamos" | `QTEYDK99qig` | notebook quebrado |
| Card Residências | `okgMMgpliIk` | computador antigo em casa |
| Card Condomínios | `q8kR_ie6WnI` | caixas em uma van |
| Card Empresas | `ia7q0rlqRfA` | sala com equipamentos de TI |
| Como funciona | `a85IYeAXgxU` | pessoa carregando caixas na van |
| Fundo de Empresas | `H8rKjwyj1Og` | placa de circuito |
| Por que reciclar | `oFTsjMfZ76A` | placa de circuito antiga |

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
