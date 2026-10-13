/**
 * Regras do CRM: pipelines, etapas e qualificação dos leads.
 * Usado pelo Worker e enviado ao painel em GET /api/admin/config.
 */

export const PIPELINES = {
  vendas: {
    label: "Funil de vendas",
    stages: [
      { id: "novo", label: "Novo lead", hint: "Entrou pelo site e ainda não recebeu contato. Meta: responder em até 15 min." },
      { id: "atendimento", label: "Em atendimento", hint: "Primeiro contato feito no WhatsApp, entendendo a necessidade." },
      { id: "orcamento", label: "Orçamento enviado", hint: "Fotos, medidas, valores e frete enviados." },
      { id: "negociacao", label: "Negociação / follow-up", hint: "Tirando dúvidas, ajustando frete, prazo ou forma de pagamento." },
      { id: "pagamento", label: "Aguardando pagamento", hint: "Link da loja Tray ou chave PIX enviado ao cliente." },
      { id: "ganho", label: "Venda fechada", hint: "Pagamento confirmado no site Tray ou no WhatsApp." },
      { id: "perdido", label: "Perdido", hint: "Não comprou. Registre o motivo." }
    ]
  },
  nutricao: {
    label: "Nutrição (Lead C)",
    stages: [
      { id: "pesquisando", label: "Só pesquisando", hint: "Lead C: ainda sem prazo de compra." },
      { id: "conteudo", label: "Conteúdo enviado", hint: "Catálogo, fotos de ambientes e promoções enviados." },
      { id: "reaquecido", label: "Reaquecido", hint: "Voltou a demonstrar interesse — mova para o funil de vendas." },
      { id: "sem_interesse", label: "Sem interesse", hint: "Pediu para não receber contato ou não respondeu." }
    ]
  }
};

export const POST_STAGES = [
  { id: "pago", label: "Pedido pago" },
  { id: "separacao", label: "Separação / produção" },
  { id: "enviado", label: "Enviado" },
  { id: "entregue", label: "Entregue" },
  { id: "recompra", label: "Avaliação / recompra" }
];

export const CANAIS_FECHAMENTO = [
  { id: "site_tray", label: "Site (Tray)" },
  { id: "whatsapp", label: "WhatsApp da loja" }
];

export const MOTIVOS_PERDA = [
  "Preço",
  "Valor do frete",
  "Prazo de entrega",
  "Parou de responder",
  "Comprou em outro lugar",
  "Só estava pesquisando",
  "Produto indisponível",
  "Outro"
];

export const FAIXAS = {
  A: { label: "A — Quente", hint: "Compra agora ou em até 30 dias" },
  B: { label: "B — Morno", hint: "Compra em 1 a 3 meses" },
  C: { label: "C — Frio", hint: "Só pesquisando" }
};

const norm = (s) => (s || "").toString().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Faixa pela intenção de compra declarada no formulário. */
export function faixaFromPrazo(prazo) {
  const p = norm(prazo);
  if (!p) return "B"; // sem resposta de prazo: tratar como morno até o vendedor confirmar
  if (p.includes("imediat") || p.includes("agora") || p.includes("30 dias")) return "A";
  if (p.includes("1 a 3") || p.includes("mes")) return "B";
  if (p.includes("pesquis")) return "C";
  return "B";
}

/** Perfil comercial pelo tipo de espaço. */
export function perfilFromEspaco(espaco) {
  const e = norm(espaco);
  if (e.includes("arquitet") || e.includes("paisag")) return "Profissional";
  if (e.includes("comerc") || e.includes("condom") || e.includes("public") || e.includes("prefeit")) return "B2B";
  return "Consumidor final";
}

/**
 * Score 0–100 para ordenar leads dentro da mesma faixa.
 * Prazo pesa mais; perfil, produto escolhido e detalhes do projeto completam.
 */
export function scoreLead(l) {
  let s = 0;
  const p = norm(l.prazo);
  if (p.includes("imediat") || p.includes("agora")) s += 50;
  else if (p.includes("30 dias")) s += 40;
  else if (p.includes("1 a 3")) s += 20;
  else if (!p) s += 15;

  const e = norm(l.espaco);
  if (e.includes("arquitet") || e.includes("public") || e.includes("prefeit")) s += 20;
  else if (e.includes("comerc") || e.includes("condom") || e.includes("fazenda") || e.includes("haras") || e.includes("sitio")) s += 15;
  else if (e) s += 10;

  if (l.produto) s += 10;
  if (norm(l.interesse).includes("kit")) s += 10;
  if (l.email) s += 5;
  if (l.mensagem && l.mensagem.length > 10) s += 5;
  if (l.envios > 1) s += Math.min(15, (l.envios - 1) * 5);
  return Math.min(100, s);
}

export function qualify(l) {
  const faixa = faixaFromPrazo(l.prazo);
  return { faixa, score: scoreLead(l), perfil: perfilFromEspaco(l.espaco) };
}

/** Onde um lead novo entra, conforme a faixa. */
export function entryPoint(faixa) {
  return faixa === "C" ? { pipeline: "nutricao", stage: "pesquisando" } : { pipeline: "vendas", stage: "novo" };
}

export function stageExists(pipeline, stage) {
  return !!PIPELINES[pipeline]?.stages.some((s) => s.id === stage);
}

export function stageLabel(pipeline, stage) {
  return PIPELINES[pipeline]?.stages.find((s) => s.id === stage)?.label || stage;
}

/** Normaliza telefone para só dígitos com DDI 55. */
export function normalizePhone(v) {
  let d = (v || "").replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) d = "55" + d;
  return d;
}
