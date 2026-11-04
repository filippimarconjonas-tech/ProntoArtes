/**
 * Avisos para a equipe no WhatsApp, enviados pelo número do CRM:
 *   - quando a IA, respondendo sozinha, passa um cliente para um vendedor;
 *   - quando um cliente está esperando resposta há alguns minutos, no horário da equipe.
 * Fora da janela de 24h com o número da equipe o WhatsApp só aceita modelo aprovado,
 * por isso o envio usa o modelo "aviso_equipe" (criado ao salvar) e, se ele falhar, tenta texto livre.
 */

import { getSettings, setSettings } from "./settings.js";
import { waConfig, graph } from "./whatsapp.js";
import { createTemplate, listTemplates } from "./wa-api.js";
import { horarioEquipe } from "./ai.js";

export const MODELO_AVISO = "aviso_equipe";
const MODELO_TEXTO = "🔔 Aviso do CRM Pronto Artes: {{1}}. Abra o CRM para responder o cliente.";
const KEYS = ["avisos_numeros", "avisos_minutos"];
const PADRAO_NUMEROS = "5524981153336"; // Josi
const JANELA_AGUARDANDO_H = 3; // não avisa de quem espera há mais tempo que isso (evita uma enxurrada de avisos antigos)

const telefone = (d) => {
  const m = String(d || "").match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(d || "");
};

export async function avisosConfig(env) {
  const s = await getSettings(env, KEYS);
  const bruto = s.avisos_numeros == null ? PADRAO_NUMEROS : s.avisos_numeros;
  const numeros = String(bruto).split(/[,;\n]+/).map((n) => n.replace(/\D/g, "")).filter((n) => n.length >= 12);
  const minutos = Math.min(Math.max(parseInt(s.avisos_minutos || "10", 10) || 10, 3), 240);
  return { numeros, minutos };
}

export async function avisosStatus(env) {
  const cfg = await avisosConfig(env);
  let modelo = null;
  try {
    const t = (await listTemplates(env)).find((x) => x.name === MODELO_AVISO);
    modelo = t ? t.status : "nao_criado";
  } catch (err) { modelo = "erro: " + err.message; }
  return { ...cfg, numeros_fmt: cfg.numeros.map(telefone), modelo };
}

/** Salva números e minutos e cria o modelo de aviso na Meta se ainda não existir. */
export async function saveAvisos(env, body) {
  const vals = {};
  if (body.numeros !== undefined) {
    vals.avisos_numeros = String(body.numeros || "").split(/[,;\n]+/)
      .map((n) => n.replace(/\D/g, "")).filter(Boolean)
      .map((n) => (n.length <= 11 ? "55" + n : n)).join(",");
  }
  if (body.minutos !== undefined) vals.avisos_minutos = String(Math.min(Math.max(parseInt(body.minutos, 10) || 10, 3), 240));
  await setSettings(env, vals);
  const existentes = await listTemplates(env);
  if (!existentes.some((t) => t.name === MODELO_AVISO)) {
    await createTemplate(env, { name: MODELO_AVISO, category: "UTILITY", body: MODELO_TEXTO, examples: ["Cliente aguardando: Maria Clara, há 10 min"] });
  }
  return avisosStatus(env);
}

/** Manda o aviso para cada número da equipe: modelo aprovado; se falhar, texto livre (vale com a janela de 24h aberta). */
export async function enviarAviso(env, texto) {
  const { numeros } = await avisosConfig(env);
  const cfg = await waConfig(env);
  if (!numeros.length) return { enviados: 0, erro: "nenhum número da equipe cadastrado" };
  if (!cfg.apiToken || !cfg.phoneNumberId) return { enviados: 0, erro: "WhatsApp do CRM não conectado" };
  const t = String(texto || "").replace(/\s+/g, " ").trim().slice(0, 900); // parâmetro de modelo não aceita quebra de linha
  let enviados = 0, erro = null;
  for (const to of numeros) {
    try {
      await graph(`/${cfg.phoneNumberId}/messages`, { method: "POST", token: cfg.apiToken, json: {
        messaging_product: "whatsapp", to, type: "template",
        template: { name: MODELO_AVISO, language: { code: "pt_BR" }, components: [{ type: "body", parameters: [{ type: "text", text: t }] }] }
      } });
      enviados++;
    } catch (errModelo) {
      try {
        await graph(`/${cfg.phoneNumberId}/messages`, { method: "POST", token: cfg.apiToken, json: {
          messaging_product: "whatsapp", to, type: "text", text: { body: "🔔 " + t }
        } });
        enviados++;
      } catch { erro = errModelo.message; }
    }
  }
  return { enviados, erro };
}

async function registrarAviso(env, leadId, texto, r, logEvent) {
  await logEvent(env, leadId, "aviso", r.enviados
    ? "🔔 Aviso enviado à equipe no WhatsApp: " + texto
    : "🔔 Não foi possível avisar a equipe no WhatsApp: " + (r.erro || "erro"), "CRM");
}

/** A IA (respondendo sozinha) pediu um vendedor. */
export async function avisarTransferencia(env, lead, motivo, logEvent) {
  const texto = `${lead.nome || "Cliente"} pediu um vendedor${motivo ? " (" + motivo + ")" : ""}, WhatsApp ${telefone(lead.whatsapp)}`;
  try {
    await registrarAviso(env, lead.id, texto, await enviarAviso(env, texto), logEvent);
  } catch (err) {
    console.error("aviso_transferencia_error", err?.message);
  }
}

/**
 * Cron a cada 5 minutos: no horário da equipe, avisa (uma vez por mensagem do cliente) quem está
 * esperando resposta há mais de N minutos. Vários clientes vão juntos em um aviso só.
 */
export async function verificarAguardando(env, logEvent) {
  if (!horarioEquipe()) return;
  const { numeros, minutos } = await avisosConfig(env);
  if (!numeros.length) return;
  const agora = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT id, nome, whatsapp, last_inbound_at FROM leads
      WHERE last_inbound_at IS NOT NULL AND (last_outbound_at IS NULL OR last_outbound_at < last_inbound_at)
        AND last_inbound_at <= ? AND last_inbound_at >= ?
        AND stage NOT IN ('ganho', 'perdido', 'sem_interesse')
        AND NOT EXISTS (SELECT 1 FROM lead_events e WHERE e.lead_id = leads.id AND e.type = 'aviso' AND e.created_at >= leads.last_inbound_at)
      ORDER BY last_inbound_at LIMIT 8`
  ).bind(new Date(agora - minutos * 60000).toISOString(), new Date(agora - JANELA_AGUARDANDO_H * 3600000).toISOString()).all();
  const leads = results.filter((l) => !numeros.includes(l.whatsapp));
  if (!leads.length) return;

  const espera = (l) => Math.round((agora - Date.parse(l.last_inbound_at)) / 60000) + " min";
  const texto = leads.length === 1
    ? `Cliente aguardando: ${leads[0].nome || telefone(leads[0].whatsapp)}, há ${espera(leads[0])}`
    : `${leads.length} clientes aguardando: ` + leads.map((l) => `${l.nome || telefone(l.whatsapp)} (${espera(l)})`).join(" · ");
  const r = await enviarAviso(env, texto);
  for (const l of leads) await registrarAviso(env, l.id, texto, r, logEvent);
}
