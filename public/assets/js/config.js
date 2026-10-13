/* Configurações editáveis da landing page */
window.PA_CONFIG = {
  // Número que recebe os leads no WhatsApp (DDI + DDD + número, só dígitos)
  whatsapp: "5524988370399",

  // Endpoint que recebe o lead antes do redirecionamento ao WhatsApp.
  // O Worker (src/worker.js) responde em /api/lead e repassa para o
  // LEAD_WEBHOOK_URL configurado nas variáveis do Cloudflare.
  // Deixe "" para desativar o envio e apenas abrir o WhatsApp.
  leadEndpoint: "/api/lead",

  // Opções de interesse usadas no popup e no formulário do rodapé
  interests: [
    "Chafarizes e fontes",
    "Postes e iluminação de jardim",
    "Esculturas e ornamentos",
    "Vasos e ânforas",
    "Lenheiros e lareiras externas",
    "Mobiliário urbano, tampões e grelhas",
    "Kit para jardim (vários itens)",
    "Ainda não sei / quero ajuda"
  ],

  // Popup de saída (desktop): abre uma vez por sessão quando o mouse sai da página
  exitIntent: true
};
