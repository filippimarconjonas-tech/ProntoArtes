/**
 * Pronto Artes — Worker da landing page + CRM.
 * - Serve os arquivos estáticos de ./public
 * - POST /api/lead: recebe o lead do site, qualifica (faixa A/B/C) e grava no CRM (D1)
 * - /admin: painel do CRM com login
 * - /api/admin/*: API do painel (exige sessão)
 */

import {
  PIPELINES, POST_STAGES, CANAIS_FECHAMENTO, MOTIVOS_PERDA, FAIXAS,
  qualify, scoreLead, entryPoint, stageExists, stageLabel, normalizePhone
} from "./crm.js";
import {
  hashPassword, verifyPassword, createSession, getSessionUser, destroySession,
  tooManyAttempts, recordFailedAttempt
} from "./auth.js";
import { importTrayCsv, listProductsAdmin, listProductsPublic } from "./products.js";
import { handleTrayWebhook, handleTrayCallback, trayStatus, saveTraySettings, syncTray, scheduledTraySync, syncProdutosTray, scheduledProdutosTray } from "./tray.js";
import { sendToLead, listTemplates, createTemplate, deleteTemplate } from "./wa-api.js";
import { handleWhatsAppWebhook, whatsappStatus, saveWhatsAppSettings, connectWhatsApp, completeEmbeddedSignup } from "./whatsapp.js";
import {
  aiStatus, saveAiSettings, testAi, simulateAi, draftForLead, sendDraft, discardDraft, setLeadAi,
  pauseOnHumanReply, onInboundMessage
} from "./ai.js";

const FORM_FIELDS = ["nome", "whatsapp", "cidade", "email", "produto", "interesse", "espaco", "prazo", "mensagem"];
const TRACK_FIELDS = ["origem", "pagina", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "referrer"];

const now = () => new Date().toISOString();
const CRON_CATALOGO = "0 9 * * *"; // 06:00 em Brasília (igual ao wrangler.jsonc)

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

const clean = (v, max = 1000) => (v == null || v === "" ? null : String(v).trim().slice(0, max) || null);

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

async function logEvent(env, leadId, type, text, user) {
  await env.DB.prepare("INSERT INTO lead_events (lead_id, type, text, user) VALUES (?, ?, ?, ?)")
    .bind(leadId, type, text, user || null).run();
}

/* ------------------------------------------------------------------
   Entrada de leads (site e, futuramente, WhatsApp)
   ------------------------------------------------------------------ */

/**
 * Grava o lead no CRM. Se já existe um lead em aberto com o mesmo WhatsApp,
 * atualiza o existente (reenvio) em vez de duplicar.
 */
async function upsertLead(env, input, { canal = "site", user = null } = {}) {
  const lead = {};
  for (const k of FORM_FIELDS) lead[k] = clean(input[k]);
  for (const k of TRACK_FIELDS) lead[k] = clean(input[k]);
  lead.whatsapp = normalizePhone(lead.whatsapp);

  const existing = await env.DB.prepare(
    "SELECT * FROM leads WHERE whatsapp = ? AND stage != 'ganho' ORDER BY id DESC LIMIT 1"
  ).bind(lead.whatsapp).first();

  if (existing) {
    const merged = { ...existing };
    for (const k of FORM_FIELDS) if (lead[k]) merged[k] = lead[k];
    merged.envios = (existing.envios || 1) + 1;
    const q = qualify(merged);
    const faixa = existing.faixa_manual ? existing.faixa : q.faixa;
    let { pipeline, stage } = existing;
    let moved = "";

    // Lead perdido ou em nutrição que volta com intenção de compra → reabre no funil de vendas
    if (stage === "perdido" || (pipeline === "nutricao" && faixa !== "C")) {
      ({ pipeline, stage } = entryPoint(faixa));
      moved = ` Movido para ${PIPELINES[pipeline].label} › ${stageLabel(pipeline, stage)}.`;
    }

    await env.DB.prepare(
      `UPDATE leads SET nome=?, cidade=?, email=?, produto=?, interesse=?, espaco=?, prazo=?, mensagem=?,
        faixa=?, score=?, perfil=?, envios=?, pipeline=?, stage=?,
        stage_changed_at = CASE WHEN stage != ? OR pipeline != ? THEN ? ELSE stage_changed_at END,
        updated_at=? WHERE id=?`
    ).bind(
      merged.nome, merged.cidade, merged.email, merged.produto, merged.interesse, merged.espaco, merged.prazo, merged.mensagem,
      faixa, q.score, q.perfil, merged.envios, pipeline, stage, stage, pipeline, now(), now(), existing.id
    ).run();

    const resumo = [lead.produto && `Produto: ${lead.produto}`, lead.interesse && `Interesse: ${lead.interesse}`, lead.prazo && `Prazo: ${lead.prazo}`]
      .filter(Boolean).join(" · ");
    await logEvent(env, existing.id, "reenvio", `Enviou o formulário novamente (${lead.origem || canal}). ${resumo}.${moved}`, user);
    return { id: existing.id, duplicate: true };
  }

  const q = qualify({ ...lead, envios: 1 });
  const { pipeline, stage } = entryPoint(q.faixa);
  const r = await env.DB.prepare(
    `INSERT INTO leads (nome, whatsapp, cidade, email, produto, interesse, espaco, prazo, mensagem,
      faixa, score, perfil, pipeline, stage, stage_changed_at, canal_entrada,
      origem, pagina, utm_source, utm_medium, utm_campaign, utm_term, utm_content, gclid, fbclid, referrer, ip_pais)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    lead.nome, lead.whatsapp, lead.cidade, lead.email, lead.produto, lead.interesse, lead.espaco, lead.prazo, lead.mensagem,
    q.faixa, q.score, q.perfil, pipeline, stage, now(), canal,
    lead.origem, lead.pagina, lead.utm_source, lead.utm_medium, lead.utm_campaign, lead.utm_term, lead.utm_content,
    lead.gclid, lead.fbclid, lead.referrer, clean(input.ip_pais)
  ).run();
  const id = r.meta.last_row_id;
  await logEvent(env, id, "criado",
    `Lead criado (${canal}${lead.origem ? " · " + lead.origem : ""}). Faixa ${q.faixa} · score ${q.score} · ${q.perfil}.`, user);
  return { id, duplicate: false };
}

async function handlePublicLead(request, env, ctx) {
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const input = await readJson(request);
  if (!input) return json({ ok: false, error: "invalid_json" }, 400);

  const digits = String(input.whatsapp || "").replace(/\D/g, "");
  if (!clean(input.nome) || digits.length < 10 || digits.length > 13) {
    return json({ ok: false, error: "invalid_lead" }, 422);
  }
  input.ip_pais = request.cf?.country || "";

  let result = null;
  try {
    result = await upsertLead(env, input, { canal: "site" });
  } catch (err) {
    console.error("crm_error", err?.message);
  }
  console.log("lead", JSON.stringify({ ...input, crm_id: result?.id }));

  if (env.LEAD_WEBHOOK_URL) {
    ctx.waitUntil(
      fetch(env.LEAD_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, crm_id: result?.id, recebido_em: now() })
      }).catch((err) => console.error("webhook_error", err?.message))
    );
  }
  return json({ ok: true });
}

/* ------------------------------------------------------------------
   API do painel
   ------------------------------------------------------------------ */

const EDITABLE = [
  "nome", "cidade", "email", "produto", "interesse", "espaco", "prazo", "mensagem",
  "valor", "canal_fechamento", "pedido_tray", "motivo_perda", "next_followup_at", "post_stage"
];

const FIELD_LABELS = {
  nome: "Nome", cidade: "Cidade", email: "E-mail", produto: "Produto", interesse: "Interesse", espaco: "Espaço",
  prazo: "Prazo", mensagem: "Projeto", valor: "Valor", canal_fechamento: "Canal de fechamento",
  pedido_tray: "Pedido Tray", motivo_perda: "Motivo da perda", next_followup_at: "Próximo follow-up",
  post_stage: "Pós-venda", faixa: "Faixa", whatsapp: "WhatsApp"
};

async function updateLead(env, id, body, user) {
  const lead = await env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first();
  if (!lead) return json({ ok: false, error: "not_found" }, 404);

  const sets = {};
  const events = [];

  for (const k of EDITABLE) {
    if (!(k in body)) continue;
    let v = body[k];
    if (k === "valor") {
      const t = String(v ?? "").replace(/[^\d.,-]/g, "");
      v = t === "" ? null : Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
    }
    else v = clean(v);
    if (k === "valor" && v != null && !Number.isFinite(v)) return json({ ok: false, error: "valor_invalido" }, 400);
    if (k === "post_stage" && v && !POST_STAGES.some((s) => s.id === v)) return json({ ok: false, error: "post_stage_invalido" }, 400);
    if (k === "canal_fechamento" && v && !CANAIS_FECHAMENTO.some((c) => c.id === v)) return json({ ok: false, error: "canal_invalido" }, 400);
    if ((lead[k] ?? null) !== v) {
      sets[k] = v;
      const shown = k === "post_stage" ? POST_STAGES.find((s) => s.id === v)?.label
        : k === "canal_fechamento" ? CANAIS_FECHAMENTO.find((c) => c.id === v)?.label
        : k === "next_followup_at" && v ? new Date(v).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })
        : k === "valor" && v != null ? v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : v;
      events.push(["campo", `${FIELD_LABELS[k]}: ${shown ?? "—"}`]);
    }
  }

  if ("whatsapp" in body) {
    const w = normalizePhone(body.whatsapp);
    if (w.length < 12) return json({ ok: false, error: "whatsapp_invalido" }, 400);
    if (w !== lead.whatsapp) { sets.whatsapp = w; events.push(["campo", `WhatsApp: ${w}`]); }
  }

  if ("faixa" in body) {
    if (body.faixa === "auto") {
      if (lead.faixa_manual) {
        sets.faixa_manual = 0;
        sets.faixa = qualify({ ...lead, ...sets }).faixa;
        events.push(["campo", `Faixa automática: ${sets.faixa}`]);
      }
    } else if (FAIXAS[body.faixa] && body.faixa !== lead.faixa) {
      sets.faixa = body.faixa;
      sets.faixa_manual = 1;
      events.push(["campo", `Faixa alterada manualmente para ${body.faixa}`]);
    }
  } else if (!lead.faixa_manual && ("prazo" in sets)) {
    sets.faixa = qualify({ ...lead, ...sets }).faixa;
  }

  // Mudança de etapa / pipeline
  const pipeline = body.pipeline || lead.pipeline;
  const stage = body.stage || lead.stage;
  if (pipeline !== lead.pipeline || stage !== lead.stage) {
    if (!stageExists(pipeline, stage)) return json({ ok: false, error: "etapa_invalida" }, 400);
    const final = { ...lead, ...sets };
    if (stage === "ganho" && !final.canal_fechamento) return json({ ok: false, error: "informe_canal_fechamento" }, 400);
    if (stage === "perdido" && !final.motivo_perda) return json({ ok: false, error: "informe_motivo_perda" }, 400);

    sets.pipeline = pipeline;
    sets.stage = stage;
    sets.stage_changed_at = now();
    if (!lead.first_contact_at && !(pipeline === "vendas" && stage === "novo") && !(pipeline === "nutricao" && stage === "pesquisando")) {
      sets.first_contact_at = now();
    }
    if (stage === "ganho") { sets.won_at = now(); if (!final.post_stage) sets.post_stage = "pago"; sets.lost_at = null; }
    if (stage === "perdido") sets.lost_at = now();
    if (lead.stage === "ganho" && stage !== "ganho") { sets.won_at = null; sets.post_stage = null; }
    if (lead.stage === "perdido" && stage !== "perdido") { sets.lost_at = null; }

    const from = `${PIPELINES[lead.pipeline]?.label} › ${stageLabel(lead.pipeline, lead.stage)}`;
    const to = `${PIPELINES[pipeline].label} › ${stageLabel(pipeline, stage)}`;
    events.unshift(["etapa", lead.pipeline === pipeline ? `${stageLabel(lead.pipeline, lead.stage)} → ${stageLabel(pipeline, stage)}` : `${from} → ${to}`]);
  }

  if (!Object.keys(sets).length) return json({ ok: true, lead });

  sets.score = scoreLead({ ...lead, ...sets });
  sets.updated_at = now();
  const keys = Object.keys(sets);
  await env.DB.prepare(`UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .bind(...keys.map((k) => sets[k]), id).run();
  for (const [type, text] of events) await logEvent(env, id, type, text, user.username);

  const updated = await env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first();
  return json({ ok: true, lead: updated });
}

async function stats(env, days) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b);
  const [totais, porFaixa, porEtapa, porCanal, porOrigem, porInteresse, porDia, perdas, sla] = await env.DB.batch([
    q(`SELECT COUNT(*) AS leads,
          SUM(CASE WHEN stage='ganho' THEN 1 ELSE 0 END) AS ganhos,
          SUM(CASE WHEN stage='ganho' THEN COALESCE(valor,0) ELSE 0 END) AS receita,
          SUM(CASE WHEN stage='perdido' THEN 1 ELSE 0 END) AS perdidos,
          SUM(CASE WHEN stage NOT IN ('ganho','perdido','sem_interesse') THEN 1 ELSE 0 END) AS abertos,
          SUM(CASE WHEN created_at >= strftime('%Y-%m-%dT03:00:00','now','-3 hours') THEN 1 ELSE 0 END) AS hoje
        FROM leads WHERE created_at >= ?`, since),
    q(`SELECT faixa, COUNT(*) AS n, SUM(CASE WHEN stage='ganho' THEN 1 ELSE 0 END) AS ganhos,
          SUM(CASE WHEN stage='ganho' THEN COALESCE(valor,0) ELSE 0 END) AS receita
        FROM leads WHERE created_at >= ? GROUP BY faixa`, since),
    q(`SELECT pipeline, stage, COUNT(*) AS n, SUM(COALESCE(valor,0)) AS valor FROM leads GROUP BY pipeline, stage`),
    q(`SELECT canal_fechamento AS canal, COUNT(*) AS n, SUM(COALESCE(valor,0)) AS receita
        FROM leads WHERE stage='ganho' AND won_at >= ? GROUP BY canal_fechamento`, since),
    q(`SELECT COALESCE(utm_source, CASE WHEN referrer IS NOT NULL THEN 'referência' ELSE 'direto' END) AS origem,
          COUNT(*) AS n, SUM(CASE WHEN stage='ganho' THEN 1 ELSE 0 END) AS ganhos
        FROM leads WHERE created_at >= ? GROUP BY 1 ORDER BY n DESC LIMIT 8`, since),
    q(`SELECT COALESCE(interesse,'Não informado') AS interesse, COUNT(*) AS n FROM leads WHERE created_at >= ? GROUP BY 1 ORDER BY n DESC LIMIT 8`, since),
    q(`SELECT substr(created_at,1,10) AS dia, COUNT(*) AS n FROM leads WHERE created_at >= ? GROUP BY dia ORDER BY dia`, since),
    q(`SELECT motivo_perda AS motivo, COUNT(*) AS n FROM leads WHERE stage='perdido' AND lost_at >= ? GROUP BY motivo_perda ORDER BY n DESC`, since),
    q(`SELECT COUNT(*) AS sem_contato,
          SUM(CASE WHEN created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes') THEN 1 ELSE 0 END) AS atrasados,
          (SELECT COUNT(*) FROM leads WHERE next_followup_at IS NOT NULL AND next_followup_at <= strftime('%Y-%m-%dT02:59:59','now','-3 hours','+1 day')
             AND stage NOT IN ('ganho','perdido','sem_interesse')) AS followups_hoje,
          (SELECT AVG((julianday(first_contact_at) - julianday(created_at)) * 1440) FROM leads WHERE first_contact_at IS NOT NULL AND created_at >= ?) AS min_primeiro_contato
        FROM leads WHERE pipeline='vendas' AND stage='novo'`, since)
  ]);
  return {
    dias: days,
    totais: totais.results[0],
    porFaixa: porFaixa.results,
    porEtapa: porEtapa.results,
    porCanal: porCanal.results,
    porOrigem: porOrigem.results,
    porInteresse: porInteresse.results,
    porDia: porDia.results,
    perdas: perdas.results,
    sla: sla.results[0]
  };
}

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  // Evita injeção de fórmulas ao abrir no Excel/Sheets
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",;\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

async function exportCsv(env) {
  const { results } = await env.DB.prepare("SELECT * FROM leads ORDER BY created_at DESC").all();
  const cols = ["id", "created_at", "nome", "whatsapp", "cidade", "email", "faixa", "score", "perfil", "pipeline", "stage", "post_stage",
    "produto", "interesse", "espaco", "prazo", "mensagem", "valor", "canal_fechamento", "pedido_tray", "motivo_perda",
    "next_followup_at", "origem", "canal_entrada", "utm_source", "utm_medium", "utm_campaign", "envios"];
  const lines = [cols.join(";"), ...results.map((r) => cols.map((c) => csvCell(r[c])).join(";"))];
  return new Response("﻿" + lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="leads-prontoartes-${now().slice(0, 10)}.csv"`,
      "cache-control": "no-store"
    }
  });
}

async function handleAdminApi(request, env, url) {
  const path = url.pathname.replace(/^\/api\/admin/, "") || "/";
  const method = request.method;
  const ip = request.headers.get("cf-connecting-ip") || "local";

  // Rotas sem sessão
  if (path === "/login" && method === "POST") {
    if (await tooManyAttempts(env, ip)) return json({ ok: false, error: "muitas_tentativas" }, 429);
    const body = await readJson(request);
    const username = clean(body?.username, 80)?.toLowerCase();
    const user = username && await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
    if (!user || !(await verifyPassword(String(body.password || ""), user))) {
      await recordFailedAttempt(env, ip);
      return json({ ok: false, error: "credenciais_invalidas" }, 401);
    }
    const cookie = await createSession(env, user.id);
    return json({ ok: true, user: { username: user.username, name: user.name } }, 200, { "set-cookie": cookie });
  }
  if (path === "/logout" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": await destroySession(request, env) });
  }

  const user = await getSessionUser(request, env);
  if (!user) return json({ ok: false, error: "nao_autenticado" }, 401);

  // Escritas exigem JSON (proteção extra contra CSRF, além do SameSite=Lax)
  if (method !== "GET" && !(request.headers.get("content-type") || "").includes("application/json")) {
    return json({ ok: false, error: "content_type" }, 415);
  }

  if (path === "/me") return json({ ok: true, user });

  if (path === "/config") {
    return json({ ok: true, pipelines: PIPELINES, postStages: POST_STAGES, canais: CANAIS_FECHAMENTO, motivos: MOTIVOS_PERDA, faixas: FAIXAS });
  }

  if (path === "/stats") {
    const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get("dias") || "30", 10) || 30));
    return json({ ok: true, ...(await stats(env, days)) });
  }

  if (path === "/export.csv") return exportCsv(env);

  if (path === "/password" && method === "POST") {
    const body = await readJson(request);
    const full = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
    if (!(await verifyPassword(String(body?.atual || ""), full))) return json({ ok: false, error: "senha_atual_incorreta" }, 400);
    const nova = String(body?.nova || "");
    if (nova.length < 10) return json({ ok: false, error: "senha_curta" }, 400);
    const { hash, salt } = await hashPassword(nova);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?").bind(hash, salt, user.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id)
    ]);
    const cookie = await createSession(env, user.id);
    return json({ ok: true }, 200, { "set-cookie": cookie });
  }

  if (path === "/whatsapp" && method === "GET") return json({ ok: true, ...(await whatsappStatus(env, url.origin)) });
  if (path === "/whatsapp" && method === "POST") {
    try {
      await saveWhatsAppSettings(env, (await readJson(request)) || {});
    } catch (err) {
      if (err.code) return json({ ok: false, error: err.code }, 400);
      throw err;
    }
    return json({ ok: true, ...(await whatsappStatus(env, url.origin)) });
  }
  if (path.startsWith("/whatsapp/templates") || /^\/leads\/\d+\/whatsapp$/.test(path)) {
    try {
      if (path === "/whatsapp/templates" && method === "GET") return json({ ok: true, templates: await listTemplates(env) });
      if (path === "/whatsapp/templates" && method === "POST") return json({ ok: true, ...(await createTemplate(env, (await readJson(request)) || {})) });
      const tm = path.match(/^\/whatsapp\/templates\/([a-z0-9_]+)$/);
      if (tm && method === "DELETE") { await deleteTemplate(env, tm[1]); return json({ ok: true }); }
      const lm = path.match(/^\/leads\/(\d+)\/whatsapp$/);
      if (lm && method === "POST") {
        const lead = await env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(+lm[1]).first();
        if (!lead) return json({ ok: false, error: "not_found" }, 404);
        const body = (await readJson(request)) || {};
        const r = await sendToLead(env, lead, body, user.username, logEvent);
        if (body.text) await pauseOnHumanReply(env, lead.id);
        return json({ ok: true, ...r });
      }
    } catch (err) {
      return json({ ok: false, error: err.code || "erro_meta", message: err.message }, 400);
    }
  }

  if (path === "/ia" && method === "GET") return json({ ok: true, ...(await aiStatus(env)) });
  if (path.startsWith("/ia") || /^\/leads\/\d+\/ia\//.test(path)) {
    try {
      const body = method === "POST" ? (await readJson(request)) || {} : {};
      if (path === "/ia" && method === "POST") { await saveAiSettings(env, body); return json({ ok: true, ...(await aiStatus(env)) }); }
      if (path === "/ia/teste" && method === "POST") return json({ ok: true, ...(await testAi(env)) });
      if (path === "/ia/simular" && method === "POST") return json({ ok: true, ...(await simulateAi(env, body)) });
      const im = path.match(/^\/leads\/(\d+)\/ia\/(sugerir|enviar|descartar|ativa)$/);
      if (im && method === "POST") {
        const lead = await env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(+im[1]).first();
        if (!lead) return json({ ok: false, error: "not_found" }, 404);
        if (im[2] === "sugerir") return json({ ok: true, ...(await draftForLead(env, lead, logEvent)) });
        if (im[2] === "enviar") return json({ ok: true, ...(await sendDraft(env, lead, body.text, user.username, logEvent)) });
        if (im[2] === "descartar") { await discardDraft(env, lead.id); return json({ ok: true }); }
        await setLeadAi(env, lead.id, !!body.ativa, user.username, logEvent);
        return json({ ok: true });
      }
    } catch (err) {
      if (err.code) return json({ ok: false, error: err.code, message: err.message }, 400);
      throw err;
    }
  }

  if (path === "/products" && method === "GET") return json({ ok: true, products: await listProductsAdmin(env) });
  if (path === "/products/tray" && method === "POST") {
    try {
      const body = (await readJson(request)) || {};
      return json({ ok: true, ...(await syncProdutosTray(env, { gravar: !!body.gravar })) });
    } catch (err) {
      if (err.code) return json({ ok: false, error: err.code, message: err.message }, 400);
      throw err;
    }
  }
  if (path === "/products/import" && method === "POST") {
    const body = await readJson(request);
    const csv = String(body?.csv || "");
    if (csv.length < 20) return json({ ok: false, error: "planilha_vazia" }, 400);
    if (csv.length > 20 * 1024 * 1024) return json({ ok: false, error: "planilha_grande" }, 400);
    const r = await importTrayCsv(env, csv);
    return r.erro ? json({ ok: false, error: "planilha_invalida", message: r.erro }, 400) : json({ ok: true, ...r });
  }

  if (path === "/tray" && method === "GET") return json({ ok: true, ...(await trayStatus(env, url.origin)) });
  if (path === "/tray" && method === "POST") {
    try {
      await saveTraySettings(env, (await readJson(request)) || {});
    } catch (err) {
      if (err.code) return json({ ok: false, error: err.code, message: err.message }, 400);
      throw err;
    }
    return json({ ok: true, ...(await trayStatus(env, url.origin)) });
  }
  if (path === "/tray/sync" && method === "POST") {
    const r = await syncTray(env, { upsertLead, logEvent });
    console.log("tray_sync", JSON.stringify(r.steps));
    return json({ ok: true, conectado: r.ok, steps: r.steps, pedidos: r.pedidos, status: await trayStatus(env, url.origin) });
  }

  if (path === "/whatsapp/embedded" && method === "POST") {
    const r = await completeEmbeddedSignup(env, url.origin, (await readJson(request)) || {});
    console.log("whatsapp_embedded", JSON.stringify(r));
    return json({ ok: true, conectado: r.ok, steps: r.steps, status: await whatsappStatus(env, url.origin) });
  }
  if (path === "/whatsapp/connect" && method === "POST") {
    const r = await connectWhatsApp(env, url.origin);
    console.log("whatsapp_connect", JSON.stringify(r));
    return json({ ok: true, conectado: r.ok, steps: r.steps, status: await whatsappStatus(env, url.origin) });
  }

  if (path === "/leads" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT id, created_at, updated_at, nome, whatsapp, cidade, produto, interesse, espaco, prazo, faixa, score, perfil,
              pipeline, stage, stage_changed_at, post_stage, next_followup_at, valor, canal_fechamento, motivo_perda,
              origem, canal_entrada, utm_source, envios, first_contact_at, last_inbound_at, last_outbound_at,
              ai_pausada, CASE WHEN ai_draft IS NULL THEN 0 ELSE 1 END AS ai_rascunho
         FROM leads ORDER BY created_at DESC LIMIT 2000`
    ).all();
    return json({ ok: true, leads: results });
  }

  if (path === "/leads" && method === "POST") {
    const body = await readJson(request);
    if (!clean(body?.nome) || normalizePhone(body?.whatsapp).length < 12) return json({ ok: false, error: "nome_e_whatsapp_obrigatorios" }, 400);
    const canal = body.canal_entrada === "whatsapp" ? "whatsapp" : "manual";
    const r = await upsertLead(env, { ...body, origem: body.origem || (canal === "whatsapp" ? "WhatsApp direto" : "Cadastro manual") }, { canal, user: user.username });
    return json({ ok: true, ...r });
  }

  const m = path.match(/^\/leads\/(\d+)(\/notes)?$/);
  if (m) {
    const id = parseInt(m[1], 10);
    if (m[2] && method === "POST") {
      const body = await readJson(request);
      const text = clean(body?.text, 4000);
      if (!text) return json({ ok: false, error: "nota_vazia" }, 400);
      await logEvent(env, id, "nota", text, user.username);
      await env.DB.prepare("UPDATE leads SET updated_at = ? WHERE id = ?").bind(now(), id).run();
      return json({ ok: true });
    }
    if (method === "GET") {
      const lead = await env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first();
      if (!lead) return json({ ok: false, error: "not_found" }, 404);
      const { results: events } = await env.DB.prepare("SELECT * FROM lead_events WHERE lead_id = ? ORDER BY created_at DESC, id DESC").bind(id).all();
      return json({ ok: true, lead, events });
    }
    if (method === "PATCH") return updateLead(env, id, (await readJson(request)) || {}, user);
    if (method === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM lead_events WHERE lead_id = ?").bind(id),
        env.DB.prepare("DELETE FROM tray_orders WHERE lead_id = ?").bind(id),
        env.DB.prepare("DELETE FROM leads WHERE id = ?").bind(id)
      ]);
      return json({ ok: true });
    }
  }

  return json({ ok: false, error: "not_found" }, 404);
}

/* ------------------------------------------------------------------
   Páginas do /admin
   ------------------------------------------------------------------ */

async function serveAdminPage(request, env, url) {
  const user = await getSessionUser(request, env);
  const page = user ? "/admin/app" : "/admin/login";
  const res = await env.ASSETS.fetch(new Request(new URL(page, url), { headers: request.headers }));
  const out = new Response(res.body, res);
  out.headers.set("cache-control", "no-store");
  out.headers.set("x-robots-tag", "noindex, nofollow");
  out.headers.set("x-frame-options", "DENY");
  out.headers.set("referrer-policy", "same-origin");
  return out;
}

export default {
  // Cron Triggers (wrangler.jsonc): pedidos da Tray a cada 30 minutos; catálogo uma vez por dia
  async scheduled(event, env, ctx) {
    const job = event.cron === CRON_CATALOGO
      ? scheduledProdutosTray(env).catch((err) => console.error("tray_produtos_cron_error", err?.message))
      : scheduledTraySync(env, { upsertLead, logEvent }).catch((err) => console.error("tray_cron_error", err?.message));
    ctx.waitUntil(job);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === "/api/lead") return handlePublicLead(request, env, ctx);
    if (p === "/api/products" && request.method === "GET") {
      const products = await listProductsPublic(env).catch(() => []);
      return json({ ok: true, products }, 200, { "cache-control": "public, max-age=300" });
    }
    const tcb = p.match(/^\/api\/tray\/callback\/([0-9a-f]+)$/);
    if (tcb) return handleTrayCallback(request, env, tcb[1]);
    if (p === "/api/tray/webhook") {
      try {
        return await handleTrayWebhook(request, env, { upsertLead, logEvent, waitUntil: (p) => ctx.waitUntil(p) });
      } catch (err) {
        console.error("tray_error", err?.stack || err?.message);
        return new Response("Erro", { status: 500 });
      }
    }
    if (p === "/api/whatsapp/webhook") {
      try {
        return await handleWhatsAppWebhook(request, env, {
          upsertLead, logEvent,
          onInbound: (leadId, at) => ctx.waitUntil(onInboundMessage(env, leadId, at, logEvent).catch((err) => console.error("ia_error", err?.message))),
          onHumanReply: (leadId) => pauseOnHumanReply(env, leadId)
        });
      } catch (err) {
        console.error("whatsapp_error", err?.stack || err?.message);
        return new Response("Erro", { status: 500 });
      }
    }
    if (p.startsWith("/api/admin/") || p === "/api/admin") {
      try {
        return await handleAdminApi(request, env, url);
      } catch (err) {
        console.error("admin_error", err?.stack || err?.message);
        return json({ ok: false, error: "erro_interno" }, 500);
      }
    }
    if (p.startsWith("/api/")) return json({ ok: false, error: "not_found" }, 404);

    if (p === "/admin" || p.startsWith("/admin/")) {
      if (p !== "/admin" && p !== "/admin/") return Response.redirect(new URL("/admin", url), 302);
      return serveAdminPage(request, env, url);
    }

    return env.ASSETS.fetch(request);
  }
};
