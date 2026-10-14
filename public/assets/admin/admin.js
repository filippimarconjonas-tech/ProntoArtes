(function () {
  "use strict";

  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };

  var S = { config: null, leads: [], q: "", faixa: "", view: "dashboard", dias: 30, openId: null };

  /* ---------------- utilidades ---------------- */
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var brl = function (v) { return (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }); };
  var num = function (v) { return (v || 0).toLocaleString("pt-BR"); };
  function fmtDate(iso, withTime) {
    if (!iso) return "—";
    var d = new Date(iso);
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: withTime ? undefined : "2-digit" }) +
      (withTime ? " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "");
  }
  function ago(iso) {
    if (!iso) return "";
    var m = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 60) return Math.round(m) + " min";
    if (m < 1440) return Math.round(m / 60) + " h";
    return Math.round(m / 1440) + " d";
  }
  function phoneFmt(d) {
    d = (d || "").replace(/^55/, "");
    if (d.length === 11) return "(" + d.slice(0, 2) + ") " + d.slice(2, 7) + "-" + d.slice(7);
    if (d.length === 10) return "(" + d.slice(0, 2) + ") " + d.slice(2, 6) + "-" + d.slice(6);
    return d;
  }
  function toLocalInput(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    var p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function fromLocalInput(v) { return v ? new Date(v).toISOString() : null; }
  function firstName(n) { return (n || "").trim().split(/\s+/)[0] || ""; }

  var ERR = {
    informe_canal_fechamento: "Informe o canal de fechamento (site Tray ou WhatsApp).",
    informe_motivo_perda: "Informe o motivo da perda.",
    nome_e_whatsapp_obrigatorios: "Nome e WhatsApp com DDD são obrigatórios.",
    whatsapp_invalido: "WhatsApp inválido.",
    valor_invalido: "Valor inválido.",
    senha_atual_incorreta: "Senha atual incorreta.",
    senha_curta: "A nova senha precisa ter pelo menos 10 caracteres.",
    store_url_invalida: "Endereço da loja inválido: use https://www.prontoartes.com.br",
    api_address_invalido: "Endereço da API inválido: deve começar com https:// e terminar em /web_api.",
    app_secret_invalido: "Chave secreta inválida: são 32 caracteres (0-9, a-f).",
    token_invalido: "Token inválido: começa com “EA”."
  };

  function toast(msg, err) {
    var t = $("#toast");
    t.textContent = msg;
    t.classList.toggle("is-err", !!err);
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, 3200);
  }

  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || "GET", headers: {} };
    if (opts.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return fetch("/api/admin" + path, init).then(function (r) {
      if (r.status === 401) { location.reload(); throw new Error("401"); }
      return r.json().then(function (d) {
        if (!d.ok) { var e = new Error(d.error || "erro"); e.code = d.error; e.serverMessage = d.message; throw e; }
        return d;
      });
    });
  }
  function fail(e) { if (e.message !== "401") toast(ERR[e.code] || e.serverMessage || "Algo deu errado: " + (e.code || e.message), true); }

  /* ---------------- dados ---------------- */
  function stageInfo(pipeline, stage) {
    var p = S.config.pipelines[pipeline];
    var s = p && p.stages.filter(function (x) { return x.id === stage; })[0];
    return { pipeline: p ? p.label : pipeline, stage: s ? s.label : stage };
  }
  function postLabel(id) { var s = S.config.postStages.filter(function (x) { return x.id === id; })[0]; return s ? s.label : "—"; }
  function canalLabel(id) { var s = S.config.canais.filter(function (x) { return x.id === id; })[0]; return s ? s.label : "—"; }

  function filtered() {
    var q = S.q.toLowerCase().trim();
    var qd = q.replace(/\D/g, "");
    return S.leads.filter(function (l) {
      if (S.faixa && l.faixa !== S.faixa) return false;
      if (!q) return true;
      var hay = [l.nome, l.cidade, l.produto, l.interesse, l.origem, l.utm_source].join(" ").toLowerCase();
      return hay.indexOf(q) >= 0 || (qd.length >= 4 && (l.whatsapp || "").indexOf(qd) >= 0);
    });
  }

  function loadLeads() {
    return api("/leads").then(function (d) {
      S.leads = d.leads;
      updateCounts();
    });
  }

  function updateCounts() {
    var open = function (l) { return ["ganho", "perdido", "sem_interesse"].indexOf(l.stage) < 0; };
    var c = {
      vendas: S.leads.filter(function (l) { return l.pipeline === "vendas" && open(l); }).length,
      nutricao: S.leads.filter(function (l) { return l.pipeline === "nutricao" && open(l); }).length,
      posvenda: S.leads.filter(function (l) { return l.stage === "ganho" && l.post_stage && l.post_stage !== "recompra"; }).length
    };
    Object.keys(c).forEach(function (k) { var el = $('[data-count="' + k + '"]'); if (el) el.textContent = c[k] || ""; });
  }

  /* ---------------- roteamento ---------------- */
  var TITLES = { dashboard: "Painel", vendas: "Funil de vendas", nutricao: "Nutrição — Leads C", posvenda: "Pós-venda", lista: "Todos os leads", whatsapp: "Integração WhatsApp", modelos: "Modelos de mensagem", tray: "Integração Loja Tray" };

  function route() {
    var v = (location.hash || "#dashboard").slice(1).split("?")[0];
    if (!TITLES[v]) v = "dashboard";
    S.view = v;
    $("#view-title").textContent = TITLES[v];
    $$(".side__nav a").forEach(function (a) { a.classList.toggle("is-on", a.getAttribute("data-view") === v); });
    render();
  }

  function render() {
    var v = S.view;
    if (v === "dashboard") return renderDashboard();
    if (v === "vendas" || v === "nutricao") return renderBoard(v);
    if (v === "posvenda") return renderPostSale();
    if (v === "whatsapp") return renderWhatsApp();
    if (v === "modelos") return renderTemplates();
    if (v === "tray") return renderTray();
    return renderList();
  }

  /* ---------------- painel ---------------- */
  function bars(rows, labelKey, valKey, cls, extra) {
    if (!rows.length) return '<p class="empty">Sem dados no período.</p>';
    var max = Math.max.apply(null, rows.map(function (r) { return r[valKey] || 0; })) || 1;
    return '<div class="bars ' + (cls || "") + '">' + rows.map(function (r) {
      return '<div class="bar"><span class="bar__label" title="' + esc(r[labelKey]) + '">' + esc(r[labelKey]) + "</span>" +
        '<span class="bar__track"><span class="bar__fill" style="width:' + ((r[valKey] || 0) / max * 100).toFixed(1) + '%"></span></span>' +
        '<span class="bar__val">' + (extra ? extra(r) : num(r[valKey])) + "</span></div>";
    }).join("") + "</div>";
  }

  function renderDashboard() {
    var view = $("#view");
    view.innerHTML = '<p class="empty">Carregando…</p>';
    api("/stats?dias=" + S.dias).then(function (d) {
      var t = d.totais || {};
      var ganhos = t.ganhos || 0, leads = t.leads || 0;
      var conv = leads ? (ganhos / leads * 100).toFixed(1) : "0";
      var ticket = ganhos ? (t.receita || 0) / ganhos : 0;
      var sla = d.sla || {};
      var fx = { A: {}, B: {}, C: {} };
      d.porFaixa.forEach(function (r) { fx[r.faixa] = r; });

      var funnelRows = S.config.pipelines.vendas.stages.map(function (s) {
        var r = d.porEtapa.filter(function (x) { return x.pipeline === "vendas" && x.stage === s.id; })[0] || {};
        return { label: s.label, n: r.n || 0, valor: r.valor || 0 };
      });
      var canalRows = d.porCanal.map(function (r) { return { label: canalLabel(r.canal), n: r.n, receita: r.receita }; });
      var max = Math.max.apply(null, d.porDia.map(function (r) { return r.n; }).concat([1]));

      view.innerHTML =
        '<div class="dash-head"><p class="muted">Indicadores dos leads que entraram nos últimos ' + S.dias + ' dias.</p>' +
        '<label class="fld" style="margin:0"><select id="dias">' +
          [7, 30, 90, 365].map(function (n) { return '<option value="' + n + '"' + (n === S.dias ? " selected" : "") + ">Últimos " + n + " dias</option>"; }).join("") +
        "</select></label></div>" +
        '<div class="kpis">' +
          kpi("Leads", num(leads), num(t.hoje) + " hoje") +
          kpi("Em aberto", num(t.abertos), "nos funis") +
          kpi("Vendas", num(ganhos), conv + "% de conversão") +
          kpi("Receita", brl(t.receita), "ticket " + brl(ticket)) +
          kpi("Sem contato", num(sla.sem_contato), num(sla.atrasados) + " há mais de 15 min", (sla.atrasados || 0) > 0) +
          kpi("Follow-ups", num(sla.followups_hoje), "para hoje ou atrasados", (sla.followups_hoje || 0) > 0) +
        "</div>" +
        '<div class="panels">' +
          '<div class="panel"><h3>Qualificação dos leads</h3><div class="fxrow">' +
            ["A", "B", "C"].map(function (k) {
              var r = fx[k] || {};
              var c = r.n ? ((r.ganhos || 0) / r.n * 100).toFixed(0) : 0;
              return '<div class="fxbox fx-' + k + '"><small>' + esc(S.config.faixas[k].label) + "</small><strong>" + num(r.n) + "</strong><small>" + c + "% viraram venda</small></div>";
            }).join("") +
          "</div><p class=\"muted\" style=\"margin:10px 0 0;font-size:12px\">A: compra agora/30 dias · B: 1 a 3 meses · C: só pesquisando</p></div>" +
          '<div class="panel"><h3>Funil de vendas (atual)</h3>' + bars(funnelRows, "label", "n", "funnel") + "</div>" +
          '<div class="panel"><h3>Vendas por canal</h3>' + bars(canalRows, "label", "n", "", function (r) { return num(r.n) + " · " + brl(r.receita); }) + "</div>" +
          '<div class="panel panel--wide"><h3>Leads por dia</h3>' +
            (d.porDia.length ? '<div class="spark">' + d.porDia.map(function (r) {
              return '<i style="height:' + (r.n / max * 100) + '%" title="' + esc(fmtDate(r.dia + "T12:00:00Z")) + ": " + r.n + ' leads"></i>';
            }).join("") + "</div>" : '<p class="empty">Sem leads no período.</p>') + "</div>" +
          '<div class="panel"><h3>Motivos de perda</h3>' + bars(d.perdas.map(function (r) { return { label: r.motivo || "Não informado", n: r.n }; }), "label", "n") + "</div>" +
          '<div class="panel"><h3>Origem (UTM)</h3>' + bars(d.porOrigem, "origem", "n", "", function (r) { return num(r.n) + (r.ganhos ? " · " + r.ganhos + "✓" : ""); }) + "</div>" +
          '<div class="panel"><h3>Interesse</h3>' + bars(d.porInteresse, "interesse", "n") + "</div>" +
          '<div class="panel"><h3>Tempo de resposta</h3><p style="font-size:26px;font-weight:700;margin:0">' +
            (sla.min_primeiro_contato != null ? Math.round(sla.min_primeiro_contato) + " min" : "—") +
          '</p><p class="muted" style="margin:4px 0 0">Média entre a entrada do lead e o primeiro avanço de etapa.</p></div>' +
        "</div>";
      $("#dias").addEventListener("change", function (e) { S.dias = +e.target.value; renderDashboard(); });
    }).catch(fail);
  }
  function kpi(label, val, sub, alert) {
    return '<div class="kpi' + (alert ? " kpi--alert" : "") + '"><small>' + label + "</small><strong>" + val + "</strong><span>" + esc(sub) + "</span></div>";
  }

  /* ---------------- kanban ---------------- */
  var FAIXA_ORDER = { A: 0, B: 1, C: 2 };
  function sortLeads(list) {
    return list.sort(function (a, b) {
      return (FAIXA_ORDER[a.faixa] - FAIXA_ORDER[b.faixa]) || (b.score - a.score) || (a.created_at < b.created_at ? -1 : 1);
    });
  }

  function cardTags(l) {
    var tags = [];
    var nowIso = new Date().toISOString();
    if (l.pipeline === "vendas" && l.stage === "novo") {
      var mins = (Date.now() - new Date(l.created_at).getTime()) / 60000;
      tags.push('<span class="tag' + (mins > 15 ? " tag--late" : "") + '">Sem contato · ' + ago(l.created_at) + "</span>");
    }
    if (l.next_followup_at && ["ganho", "perdido", "sem_interesse"].indexOf(l.stage) < 0) {
      var due = l.next_followup_at <= nowIso;
      var today = new Date(l.next_followup_at).toDateString() === new Date().toDateString();
      tags.push('<span class="tag' + (due ? " tag--late" : today ? " tag--due" : "") + '">Follow-up ' + fmtDate(l.next_followup_at, true) + "</span>");
    }
    if (l.last_inbound_at && (!l.last_outbound_at || l.last_inbound_at > l.last_outbound_at) && ["ganho", "perdido", "sem_interesse"].indexOf(l.stage) < 0) {
      tags.push('<span class="tag tag--late">Cliente aguardando · ' + ago(l.last_inbound_at) + "</span>");
    }
    if (l.valor) tags.push('<span class="tag tag--val">' + brl(l.valor) + "</span>");
    if (l.perfil && l.perfil !== "Consumidor final") tags.push('<span class="tag">' + esc(l.perfil) + "</span>");
    if (l.canal_entrada === "whatsapp") tags.push('<span class="tag">WhatsApp direto</span>');
    if (l.canal_entrada === "tray") tags.push('<span class="tag">Comprou na loja</span>');
    if (l.envios > 1) tags.push('<span class="tag">' + l.envios + " envios</span>");
    if (l.stage === "perdido" && l.motivo_perda) tags.push('<span class="tag">' + esc(l.motivo_perda) + "</span>");
    if (l.stage === "ganho" && l.canal_fechamento) tags.push('<span class="tag">' + esc(canalLabel(l.canal_fechamento)) + "</span>");
    return tags.join("");
  }

  function cardHtml(l) {
    return '<article class="card f-' + esc(l.faixa) + '" draggable="true" data-id="' + l.id + '">' +
      '<div class="card__top"><span class="card__name">' + esc(l.nome) + '</span><span class="fx fx-' + esc(l.faixa) + '" title="Score ' + l.score + '">' + esc(l.faixa) + "</span></div>" +
      '<div class="card__meta">' + esc(l.produto || l.interesse || "Interesse não informado") + "</div>" +
      '<div class="card__meta">' + esc(l.cidade || "") + (l.cidade ? " · " : "") + esc(l.prazo || "prazo n/i") + "</div>" +
      '<div class="card__tags">' + cardTags(l) + "</div></article>";
  }

  function renderBoard(pipeline) {
    var p = S.config.pipelines[pipeline];
    var list = filtered().filter(function (l) { return l.pipeline === pipeline; });
    $("#view").innerHTML = '<div class="board" data-pipeline="' + pipeline + '">' + p.stages.map(function (s) {
      var items = sortLeads(list.filter(function (l) { return l.stage === s.id; }));
      var soma = items.reduce(function (a, l) { return a + (l.valor || 0); }, 0);
      return '<section class="col col--' + s.id + '" data-stage="' + s.id + '">' +
        '<header class="col__head"><h3><span>' + esc(s.label) + "</span><span>" + items.length + "</span></h3>" +
        "<p>" + esc(s.hint) + "</p>" + (soma ? '<div class="col__sum">' + brl(soma) + "</div>" : "") + "</header>" +
        '<div class="col__list">' + (items.map(cardHtml).join("") || '<p class="empty" style="padding:4px">Nenhum lead</p>') + "</div></section>";
    }).join("") + "</div>";
    bindBoard(function (id, stage) { moveLead(id, pipeline, stage); });
  }

  function renderPostSale() {
    var list = filtered().filter(function (l) { return l.stage === "ganho"; });
    $("#view").innerHTML = '<p class="muted" style="margin:0 0 12px">Vendas fechadas (site Tray ou WhatsApp) acompanhadas até a entrega e a recompra.</p>' +
      '<div class="board">' + S.config.postStages.map(function (s) {
        var items = list.filter(function (l) { return (l.post_stage || "pago") === s.id; })
          .sort(function (a, b) { return a.stage_changed_at < b.stage_changed_at ? -1 : 1; });
        var soma = items.reduce(function (a, l) { return a + (l.valor || 0); }, 0);
        return '<section class="col" data-stage="' + s.id + '"><header class="col__head"><h3><span>' + esc(s.label) + "</span><span>" + items.length + "</span></h3>" +
          (soma ? '<div class="col__sum">' + brl(soma) + "</div>" : "") + "</header>" +
          '<div class="col__list">' + (items.map(cardHtml).join("") || '<p class="empty" style="padding:4px">Nenhum pedido</p>') + "</div></section>";
      }).join("") + "</div>";
    bindBoard(function (id, stage) {
      patchLead(id, { post_stage: stage }).then(function () { toast("Pós-venda atualizado"); });
    });
  }

  function bindBoard(onDrop) {
    var dragId = null;
    $$(".card").forEach(function (c) {
      c.addEventListener("click", function () { openLead(+c.getAttribute("data-id")); });
      c.addEventListener("dragstart", function (e) {
        dragId = +c.getAttribute("data-id");
        c.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(dragId));
      });
      c.addEventListener("dragend", function () { c.classList.remove("dragging"); });
    });
    $$(".col").forEach(function (col) {
      col.addEventListener("dragover", function (e) { e.preventDefault(); col.classList.add("is-over"); });
      col.addEventListener("dragleave", function () { col.classList.remove("is-over"); });
      col.addEventListener("drop", function (e) {
        e.preventDefault();
        col.classList.remove("is-over");
        var id = dragId || +e.dataTransfer.getData("text/plain");
        if (id) onDrop(id, col.getAttribute("data-stage"));
        dragId = null;
      });
    });
  }

  /* ---------------- integração WhatsApp ---------------- */
  var WA_DEFAULTS = { phone_number_id: "1322084644326604", waba_id: "28707169048949738" };

  function renderWhatsApp(result) {
    var view = $("#view");
    if (!result) view.innerHTML = '<p class="empty">Carregando…</p>';
    api("/whatsapp").then(function (st) {
      var conectado = !!st.conectado_em;
      view.innerHTML =
        '<div class="panels" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">' +
        '<div class="panel"><h3>Status</h3><dl class="answers">' +
          row("Situação", conectado ? "✅ Conectado em " + fmtDate(st.conectado_em, true) : "⏳ Aguardando conexão") +
          row("Número", st.numero ? st.numero + (st.nome_verificado ? " · " + st.nome_verificado : "") : "") +
          row("Último webhook", st.ultimo_webhook ? fmtDate(st.ultimo_webhook, true) + " (há " + ago(st.ultimo_webhook) + ")" : "nenhum ainda") +
          row("Mensagens recebidas", num(st.recebidas)) +
          row("Respostas da loja", num(st.enviadas)) +
          row("Envio pelo CRM", st.tem_token_envio ? "✅ ativo" : "⏳ cadastre o token permanente") +
        "</dl>" +
        '<p class="muted" style="font-size:12.5px;margin:12px 0 0">Cada conversa nova no WhatsApp da loja vira lead em <strong>Funil de vendas › Novo lead</strong>. ' +
        "Quando a equipe responde pelo app, o lead passa para <strong>Em atendimento</strong>. Mensagens de quem já é lead entram no histórico.</p></div>" +

        '<div class="panel"><h3>Número da loja (coexistência)</h3>' +
          '<p class="muted" style="font-size:12.5px;margin:0 0 12px">Conecta o (24) 98837-0399 à API <strong>sem tirar o número do WhatsApp Business App</strong>. ' +
          "Exige o app aprovado como Provedor de Tecnologia e uma configuração de “Login do Facebook para Empresas” do tipo Cadastro incorporado do WhatsApp.</p>" +
          '<form id="es-form">' +
            '<label class="fld"><span>Configuration ID (Login do Facebook para Empresas)</span><input name="config_id" inputmode="numeric" value="' + esc(st.config_id || "") + '" placeholder="Ex.: 1234567890123456"></label>' +
            '<div class="modal__actions" style="justify-content:flex-start"><button type="button" class="btn btn--ghost" id="es-save">Salvar</button>' +
            '<button type="button" class="btn btn--wa" id="es-start"' + (!st.app_id || !st.config_id ? " disabled" : "") + ">Conectar número da loja</button></div>" +
            '<p class="form-msg" id="es-msg">' + (!st.app_id ? "Preencha o App ID em Credenciais da Meta." : !st.config_id ? "Preencha o Configuration ID para liberar o botão." : "") + "</p>" +
          "</form></div>" +

        '<div class="panel"><h3>Credenciais da Meta</h3><form id="wa-form">' +
          '<label class="fld"><span>App ID (Meta for Developers › seu app › topo da página)</span><input name="app_id" inputmode="numeric" value="' + esc(st.app_id || "") + '" placeholder="Opcional se o token funcionar"></label>' +
          '<label class="fld"><span>Phone Number ID</span><input name="phone_number_id" value="' + esc(st.phone_number_id || WA_DEFAULTS.phone_number_id) + '"></label>' +
          '<label class="fld"><span>ID da conta do WhatsApp Business</span><input name="waba_id" value="' + esc(st.waba_id || WA_DEFAULTS.waba_id) + '"></label>' +
          '<label class="fld"><span>Chave secreta do aplicativo ' + (st.tem_app_secret ? "(salva ✓ — preencha só para trocar)" : "") + '</span><input name="app_secret" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore readonly placeholder="' + (st.tem_app_secret ? "••••••••" : "Cole aqui") + '"></label>' +
          '<label class="fld"><span>Token de acesso ' + (st.tem_access_token ? "(salvo ✓)" : "(usado só para conectar; é apagado depois)") + '</span><input name="access_token" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore readonly placeholder="' + (st.tem_access_token ? "••••••••" : "Cole o token EAAB…") + '"></label>' +
          '<label class="fld"><span>Token permanente — Usuário do sistema ' + (st.tem_token_envio ? "(salvo ✓)" : "(para enviar mensagens e criar modelos)") + '</span><input name="system_token" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore readonly placeholder="' + (st.tem_token_envio ? "••••••••" : "Cole o token EAAB… do Usuário do sistema") + '"></label>' +
          '<div class="modal__actions" style="justify-content:flex-start"><button class="btn btn--ghost" name="acao" value="salvar">Salvar</button><button class="btn btn--wa" name="acao" value="conectar">Salvar e conectar</button></div>' +
          '<p class="form-msg"></p>' +
        "</form></div>" +

        '<div class="panel"><h3>Dados do webhook (configuração manual)</h3><dl class="answers">' +
          row("URL de callback", st.callback_url) + row("Verify token", st.verify_token || "gerado ao salvar") + row("Campos", "messages, smb_message_echoes") +
        '</dl><p class="muted" style="font-size:12.5px;margin:10px 0 0">O botão “Salvar e conectar” já cadastra isso na Meta. Use estes dados só se precisar configurar manualmente em Meta for Developers › WhatsApp › Configuração.</p></div>' +

        (result ? '<div class="panel panel--wide"><h3>Resultado da conexão</h3><ul class="timeline">' + result.steps.map(function (s) {
          return '<li class="' + (s.ok ? "t-etapa" : "t-nota") + '"><time>' + (s.ok ? "✅" : "❌") + " " + esc(s.label) + "</time>" + esc(s.detail) + "</li>";
        }).join("") + "</ul></div>" : "") +
        "</div>";

      bindEmbeddedSignup(st);
      var form = $("#wa-form");
      $$("input[readonly]", form).forEach(function (i) { i.addEventListener("focus", function () { i.removeAttribute("readonly"); }); });
      var clicked = "salvar";
      $$("button[name=acao]", form).forEach(function (b) { b.addEventListener("click", function () { clicked = b.value; }); });
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var msg = $(".form-msg", form);
        msg.textContent = "";
        $$("button", form).forEach(function (b) { b.disabled = true; });
        var secret = form.app_secret.value.trim(), token = form.access_token.value.trim();
        var sysToken = form.system_token.value.trim();
        if (sysToken && !/^EA[A-Za-z0-9]{50,}$/.test(sysToken)) {
          msg.textContent = "O token permanente começa com “EA” e é bem longo.";
          $$("button", form).forEach(function (b) { b.disabled = false; });
          return;
        }
        if (secret && !/^[0-9a-f]{32}$/i.test(secret)) {
          msg.textContent = "A chave secreta do aplicativo tem 32 letras/números (0-9, a-f). Confira se o navegador não preencheu o campo sozinho.";
          $$("button", form).forEach(function (b) { b.disabled = false; });
          return;
        }
        if (token && !/^EA[A-Za-z0-9]{50,}$/.test(token)) {
          msg.textContent = "O token da Meta começa com “EA” e é bem longo. Confira se o navegador não preencheu o campo sozinho.";
          $$("button", form).forEach(function (b) { b.disabled = false; });
          return;
        }
        var body = { app_id: form.app_id.value, phone_number_id: form.phone_number_id.value, waba_id: form.waba_id.value, app_secret: secret, access_token: token, system_token: sysToken };
        api("/whatsapp", { method: "POST", body: body }).then(function () {
          if (clicked !== "conectar") { toast("Credenciais salvas"); renderWhatsApp(); return; }
          msg.style.color = "var(--soft)";
          msg.textContent = "Conectando com a Meta…";
          return api("/whatsapp/connect", { method: "POST", body: {} }).then(function (r) {
            toast(r.conectado ? "WhatsApp conectado!" : "A conexão não terminou — veja os detalhes abaixo", !r.conectado);
            renderWhatsApp(r);
            updateWaDot();
          });
        }).catch(function (err) {
          fail(err);
          $$("button", form).forEach(function (b) { b.disabled = false; });
        });
      });
    }).catch(fail);
  }

  /* Embedded Signup (Meta) em modo coexistência com o WhatsApp Business App */
  function loadFbSdk(appId) {
    return new Promise(function (resolve, reject) {
      if (window.FB) return resolve(window.FB);
      window.fbAsyncInit = function () {
        window.FB.init({ appId: appId, autoLogAppEvents: true, xfbml: false, version: "v23.0" });
        resolve(window.FB);
      };
      var sc = document.createElement("script");
      sc.src = "https://connect.facebook.net/pt_BR/sdk.js";
      sc.async = true; sc.defer = true; sc.crossOrigin = "anonymous";
      sc.onerror = function () { reject(new Error("Não foi possível carregar o SDK da Meta (bloqueador de anúncios?).")); };
      document.body.appendChild(sc);
    });
  }

  function bindEmbeddedSignup(st) {
    var msg = $("#es-msg");
    $("#es-save").addEventListener("click", function () {
      api("/whatsapp", { method: "POST", body: { config_id: $("#es-form").config_id.value } })
        .then(function () { toast("Configuration ID salvo"); renderWhatsApp(); }).catch(fail);
    });
    $("#es-start").addEventListener("click", function () {
      var btn = this;
      btn.disabled = true;
      msg.style.color = "var(--soft)";
      msg.textContent = "Abrindo o cadastro da Meta…";
      var session = null;
      function onMessage(ev) {
        if (!/(^|\.)facebook\.com$/.test(new URL(ev.origin).hostname)) return;
        try {
          var d = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
          if (d && d.type === "WA_EMBEDDED_SIGNUP") {
            if (/^FINISH/.test(d.event || "")) session = d.data || {};
            else if (d.event === "CANCEL") msg.textContent = "Cadastro cancelado" + (d.data && d.data.current_step ? " na etapa " + d.data.current_step : "") + ".";
            else if (d.event === "ERROR") msg.textContent = "A Meta informou um erro: " + ((d.data && d.data.error_message) || "desconhecido");
          }
        } catch (e) { /* mensagens de outros scripts */ }
      }
      window.addEventListener("message", onMessage);

      loadFbSdk(st.app_id).then(function (FB) {
        FB.login(function (resp) {
          var code = resp && resp.authResponse && resp.authResponse.code;
          if (!code) { window.removeEventListener("message", onMessage); btn.disabled = false; if (!msg.textContent || /Abrindo/.test(msg.textContent)) msg.textContent = "Cadastro não concluído."; return; }
          var tries = 0;
          (function waitSession() {
            if (!session && tries++ < 20) return setTimeout(waitSession, 250);
            window.removeEventListener("message", onMessage);
            if (!session || !session.phone_number_id) { msg.textContent = "A Meta não devolveu o número selecionado. Tente de novo."; btn.disabled = false; return; }
            msg.textContent = "Finalizando a conexão…";
            api("/whatsapp/embedded", { method: "POST", body: { code: code, phone_number_id: session.phone_number_id, waba_id: session.waba_id } })
              .then(function (r) {
                toast(r.conectado ? "Número da loja conectado!" : "A conexão não terminou — veja os detalhes", !r.conectado);
                renderWhatsApp(r); updateWaDot();
              }).catch(function (e) { fail(e); btn.disabled = false; });
          })();
        }, {
          config_id: st.config_id,
          response_type: "code",
          override_default_response_type: true,
          extras: { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" }
        });
      }).catch(function (e) { msg.textContent = e.message; btn.disabled = false; window.removeEventListener("message", onMessage); });
    });
  }

  function updateWaDot() {
    api("/whatsapp").then(function (st) { var d = $("#wa-dot"); if (d) d.textContent = st.conectado_em ? "" : "!"; }).catch(function () {});
  }

  /* ---------------- modelos de mensagem ---------------- */
  var TPL_CACHE = null;
  var TPL_SUGESTOES = [
    { name: "followup_orcamento", category: "MARKETING", body: "Olá, {{1}}! Aqui é da Pronto Artes. Conseguiu avaliar o orçamento do {{2}} que enviamos? Se quiser, ajustamos frete e forma de pagamento para você.", examples: ["Ana", "Chafariz 3 Quedas"], footer: "Pronto Artes · Arte que decora" },
    { name: "boas_vindas_lead", category: "MARKETING", body: "Olá, {{1}}! Recebemos seu contato pelo site da Pronto Artes. Para te ajudar com o orçamento, pode me dizer as medidas do espaço e a cidade de entrega?", examples: ["Ana"], footer: "Pronto Artes · Arte que decora" },
    { name: "pedido_enviado", category: "UTILITY", body: "Olá, {{1}}! Seu pedido {{2}} da Pronto Artes foi enviado. Código de rastreio: {{3}}.", examples: ["Ana", "12345", "BR123456789"], footer: "" }
  ];
  var STATUS_TPL = { APPROVED: "✅ Aprovado", PENDING: "⏳ Em análise", REJECTED: "❌ Rejeitado", PAUSED: "⏸ Pausado", DISABLED: "⛔ Desativado" };

  function loadTemplates(force) {
    if (TPL_CACHE && !force) return Promise.resolve(TPL_CACHE);
    return api("/whatsapp/templates").then(function (d) { TPL_CACHE = d.templates; return TPL_CACHE; });
  }

  function renderTemplates() {
    var view = $("#view");
    view.innerHTML = '<p class="empty">Carregando modelos…</p>';
    loadTemplates(true).then(function (list) {
      view.innerHTML = '<div class="panels" style="grid-template-columns:minmax(0,1.2fr) minmax(0,1fr)">' +
        '<div class="panel"><h3>Modelos da conta (' + list.length + ")</h3>" +
          (list.length ? '<div class="table-wrap" style="box-shadow:none"><table><thead><tr><th>Nome</th><th>Status</th><th>Categoria</th><th>Texto</th><th></th></tr></thead><tbody>' +
            list.map(function (t) {
              return "<tr><td>" + esc(t.name) + "<br><small class=\"muted\">" + esc(t.language) + "</small></td><td>" + esc(STATUS_TPL[t.status] || t.status) +
                (t.rejected_reason ? "<br><small class=\"muted\">" + esc(t.rejected_reason) + "</small>" : "") + "</td><td>" + esc(t.category) +
                '</td><td class="trunc" style="white-space:normal;max-width:320px">' + esc(t.body) + '</td><td><button class="btn btn--danger btn--sm" data-del-tpl="' + esc(t.name) + '">Excluir</button></td></tr>';
            }).join("") + "</tbody></table></div>" : '<p class="empty">Nenhum modelo ainda.</p>') +
          '<p class="muted" style="font-size:12.5px;margin:10px 0 0">Modelos são exigidos pelo WhatsApp para iniciar conversa ou responder depois de 24h sem mensagem do cliente. A Meta analisa cada modelo (geralmente em minutos).</p>' +
        "</div>" +
        '<div class="panel"><h3>Criar modelo</h3>' +
          '<p class="muted" style="font-size:12.5px;margin:0 0 10px">Sugestões: ' + TPL_SUGESTOES.map(function (t, i) { return '<button type="button" class="btn btn--ghost btn--sm" data-sug="' + i + '" style="margin:2px">' + esc(t.name) + "</button>"; }).join("") + "</p>" +
          '<form id="tpl-form">' +
            '<div class="grid2"><label class="fld"><span>Nome (minúsculas e _)</span><input name="name" required pattern="[a-z0-9_]+" placeholder="followup_orcamento"></label>' +
            '<label class="fld"><span>Categoria</span><select name="category"><option value="MARKETING">Marketing (ofertas, follow-up)</option><option value="UTILITY">Utilidade (pedido, entrega)</option></select></label></div>' +
            '<label class="fld"><span>Texto — use {{1}}, {{2}}… para variáveis</span><textarea name="body" rows="5" required placeholder="Olá, {{1}}! …"></textarea></label>' +
            '<div id="tpl-examples"></div>' +
            '<label class="fld"><span>Rodapé (opcional)</span><input name="footer" maxlength="60" placeholder="Pronto Artes · Arte que decora"></label>' +
            '<div class="modal__actions" style="justify-content:flex-start"><button class="btn btn--primary">Enviar para aprovação da Meta</button></div>' +
            '<p class="form-msg"></p>' +
          "</form></div></div>";

      var form = $("#tpl-form");
      function syncExamples(values) {
        var n = (form.body.value.match(/\{\{\d+\}\}/g) || []).length;
        var box = $("#tpl-examples");
        var cur = $$("input", box).map(function (i) { return i.value; });
        box.innerHTML = Array.apply(null, Array(n)).map(function (_, i) {
          var v = values ? values[i] : cur[i];
          return '<label class="fld"><span>Exemplo para {{' + (i + 1) + '}}</span><input data-ex value="' + esc(v || "") + '" required></label>';
        }).join("");
      }
      form.body.addEventListener("input", function () { syncExamples(); });
      $$("[data-sug]", view).forEach(function (b) {
        b.addEventListener("click", function () {
          var t = TPL_SUGESTOES[+b.getAttribute("data-sug")];
          form.name.value = t.name; form.category.value = t.category; form.body.value = t.body; form.footer.value = t.footer;
          syncExamples(t.examples);
        });
      });
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var btn = $("button.btn--primary", form), msg = $(".form-msg", form);
        btn.disabled = true; msg.textContent = "";
        api("/whatsapp/templates", { method: "POST", body: {
          name: form.name.value, category: form.category.value, body: form.body.value, footer: form.footer.value,
          examples: $$("[data-ex]", form).map(function (i) { return i.value; })
        } }).then(function (r) {
          toast("Modelo enviado — status: " + (STATUS_TPL[r.status] || r.status));
          renderTemplates();
        }).catch(function (err) { btn.disabled = false; msg.textContent = err.serverMessage || ERR[err.code] || err.code; });
      });
      $$("[data-del-tpl]", view).forEach(function (b) {
        b.addEventListener("click", function () {
          var name = b.getAttribute("data-del-tpl");
          if (!confirm("Excluir o modelo " + name + " na Meta?")) return;
          api("/whatsapp/templates/" + encodeURIComponent(name), { method: "DELETE", body: {} })
            .then(function () { toast("Modelo excluído"); renderTemplates(); }).catch(fail);
        });
      });
    }).catch(function (err) {
      view.innerHTML = '<div class="panel"><h3>Modelos de mensagem</h3><p class="empty">' + esc(err.serverMessage || ERR[err.code] || err.code) +
        '</p><p><a class="btn btn--ghost btn--sm" href="#whatsapp">Ir para WhatsApp</a></p></div>';
    });
  }

  /* Envio de WhatsApp na ficha do lead */
  function waSendSection(l) {
    var open = l.last_inbound_at && (Date.now() - new Date(l.last_inbound_at).getTime()) < 864e5;
    return '<div class="d-sec"><h3>Enviar WhatsApp pelo CRM</h3>' +
      '<p class="muted" style="font-size:12.5px;margin:0 0 8px">' + (open
        ? "✅ Janela de 24h aberta (cliente escreveu há " + ago(l.last_inbound_at) + "): pode mandar texto livre."
        : "⏳ Fora da janela de 24h: use um modelo aprovado para iniciar a conversa.") + "</p>" +
      (open ? '<form id="wa-text" class="note-form"><textarea name="text" placeholder="Escreva a mensagem…" required></textarea><button class="btn btn--wa">Enviar</button></form>' : "") +
      '<form id="wa-tpl"><div class="grid2"><label class="fld"><span>Modelo</span><select name="template"><option value="">Carregando…</option></select></label><div id="wa-tpl-params"></div></div>' +
      '<p class="muted" id="wa-tpl-preview" style="font-size:12.5px;white-space:pre-wrap"></p>' +
      '<button class="btn btn--wa btn--sm">Enviar modelo</button> <span class="form-msg" id="wa-tpl-msg"></span></form></div>';
  }

  function bindWaSend(l) {
    var textForm = $("#wa-text");
    if (textForm) textForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var t = textForm.text.value.trim(); if (!t) return;
      $("button", textForm).disabled = true;
      api("/leads/" + l.id + "/whatsapp", { method: "POST", body: { text: t } })
        .then(function () { toast("Mensagem enviada"); loadLeads().then(function () { render(); openLead(l.id); }); })
        .catch(function (err) { $("button", textForm).disabled = false; fail(err); });
    });

    var f = $("#wa-tpl"), sel = f.template, params = $("#wa-tpl-params"), prev = $("#wa-tpl-preview"), msg = $("#wa-tpl-msg");
    var list = [];
    function refresh() {
      var t = list.filter(function (x) { return x.name + "|" + x.language === sel.value; })[0];
      if (!t) { params.innerHTML = ""; prev.textContent = ""; return; }
      var defaults = [firstName(l.nome), l.produto || l.interesse || "", ""];
      params.innerHTML = Array.apply(null, Array(t.vars)).map(function (_, i) {
        return '<label class="fld"><span>{{' + (i + 1) + '}}</span><input data-p value="' + esc(defaults[i] || "") + '"></label>';
      }).join("");
      var upd = function () {
        var vals = $$("[data-p]", params).map(function (i) { return i.value; });
        prev.textContent = t.body.replace(/\{\{(\d+)\}\}/g, function (m, n) { return vals[n - 1] || m; });
      };
      $$("[data-p]", params).forEach(function (i) { i.addEventListener("input", upd); });
      upd();
    }
    loadTemplates().then(function (all) {
      list = all.filter(function (t) { return t.status === "APPROVED"; });
      sel.innerHTML = list.length ? list.map(function (t) { return '<option value="' + esc(t.name + "|" + t.language) + '">' + esc(t.name) + " (" + esc(t.language) + ")</option>"; }).join("")
        : '<option value="">Nenhum modelo aprovado</option>';
      refresh();
    }).catch(function (err) {
      sel.innerHTML = '<option value="">Indisponível</option>';
      msg.textContent = err.serverMessage || ERR[err.code] || "";
    });
    sel.addEventListener("change", refresh);
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!sel.value) return;
      var parts = sel.value.split("|");
      var btn = $("button", f); btn.disabled = true; msg.textContent = "";
      api("/leads/" + l.id + "/whatsapp", { method: "POST", body: {
        template: parts[0], language: parts[1], params: $$("[data-p]", params).map(function (i) { return i.value; }), preview: prev.textContent
      } }).then(function () { toast("Modelo enviado"); loadLeads().then(function () { render(); openLead(l.id); }); })
        .catch(function (err) { btn.disabled = false; msg.textContent = err.serverMessage || ERR[err.code] || err.code; });
    });
  }

  /* ---------------- integração Loja Tray ---------------- */
  function renderTray(result) {
    var view = $("#view");
    var q = (location.hash.split("?")[1] || "");
    if (q) {
      var flag = new URLSearchParams(q).get("tray");
      history.replaceState(null, "", location.pathname + "#tray");
      if (flag === "ok") toast("Loja Tray autorizada! Clique em “Salvar e sincronizar pedidos”.");
      else if (flag === "erro") toast("A Tray devolveu o code, mas a autorização falhou. Confira consumer key e secret.", true);
      else if (flag === "sem_code") toast("A Tray não devolveu o code. Tente autorizar de novo.", true);
    }
    if (!result) view.innerHTML = '<p class="empty">Carregando…</p>';
    api("/tray").then(function (st) {
      view.innerHTML = '<div class="panels" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">' +
        '<div class="panel"><h3>Status</h3><dl class="answers">' +
          row("Situação", st.autorizada ? "✅ Loja autorizada" : "⏳ Aguardando autorização") +
          row("Última sincronização", st.ultima_sincronizacao ? fmtDate(st.ultima_sincronizacao, true) : "nunca") +
          row("Última notificação", st.ultima_notificacao ? fmtDate(st.ultima_notificacao, true) : "nenhuma ainda") +
        "</dl>" +
        '<p class="muted" style="font-size:12.5px;margin:12px 0 0">Pedido criado na loja → lead em <strong>Aguardando pagamento</strong>. Pagamento aprovado → <strong>Venda fechada (Site Tray)</strong> com valor e nº do pedido, e o pós-venda acompanha o status (enviado, entregue). ' +
        "O lead é encontrado pelo telefone ou e-mail do cliente; quem comprou direto na loja vira lead com origem “Loja Tray”.</p></div>" +

        '<div class="panel"><h3>Credenciais da API Tray</h3><form id="tray-form">' +
          '<label class="fld"><span>Endereço da loja</span><input name="store_url" value="' + esc(st.store_url || "") + '" placeholder="https://www.prontoartes.com.br"></label>' +
          '<label class="fld"><span>Endereço da API da loja (api_address)</span><input name="api_address" value="' + esc(st.api_address || "") + '" placeholder="Preenchido sozinho ao autorizar na loja"></label>' +
          '<label class="fld"><span>Consumer key ' + (st.tem_consumer_key ? "(salva ✓)" : "") + '</span><input name="consumer_key" type="password" autocomplete="new-password" data-lpignore="true" readonly placeholder="' + (st.tem_consumer_key ? "••••••••" : "Do aplicativo na Tray") + '"></label>' +
          '<label class="fld"><span>Consumer secret ' + (st.tem_consumer_secret ? "(salvo ✓)" : "") + '</span><input name="consumer_secret" type="password" autocomplete="new-password" data-lpignore="true" readonly placeholder="' + (st.tem_consumer_secret ? "••••••••" : "Do aplicativo na Tray") + '"></label>' +
          (st.consumer_key && st.callback_url ? '<p style="margin:4px 0 14px"><a class="btn btn--wa btn--sm" target="_blank" rel="noopener" href="' +
            esc(st.store_url + "/auth.php?response_type=code&consumer_key=" + encodeURIComponent(st.consumer_key) + "&callback=" + encodeURIComponent(st.callback_url)) +
            '">Autorizar na loja Tray ↗</a> <small class="muted">abre a Tray; ao confirmar, o code volta sozinho para o CRM</small></p>'
            : '<p class="muted" style="font-size:12.5px;margin:0 0 12px">Salve o consumer key e o secret para liberar o botão “Autorizar na loja Tray”.</p>') +
          '<label class="fld"><span>Code de autorização (manual, se precisar)</span><input name="code" autocomplete="off" placeholder="' + (st.autorizada ? "Já autorizada — preencha só para reautorizar" : "Gerado ao autorizar o app na loja") + '"></label>' +
          '<div class="modal__actions" style="justify-content:flex-start"><button class="btn btn--ghost" name="acao" value="salvar">Salvar</button><button class="btn btn--primary" name="acao" value="sync">Salvar e sincronizar pedidos</button></div>' +
          '<p class="form-msg"></p>' +
        "</form></div>" +

        '<div class="panel"><h3>URL de notificação (webhook)</h3>' +
          (st.webhook_url ? '<p style="word-break:break-all;font-size:13px;background:#faf7f3;padding:10px;border-radius:8px">' + esc(st.webhook_url) + "</p>" : '<p class="empty">Gerada ao salvar as credenciais.</p>') +
          (st.callback_url ? '<p class="muted" style="font-size:12.5px;margin:12px 0 4px">URL de retorno (callback) — se o cadastro do aplicativo na Tray pedir:</p><p style="word-break:break-all;font-size:13px;background:#faf7f3;padding:10px;border-radius:8px">' + esc(st.callback_url) + "</p>" : "") +
          '<p class="muted" style="font-size:12.5px">Cadastre esta URL no aplicativo da Tray como URL de notificação, com o escopo de <strong>pedidos</strong>. Assim cada pedido criado ou atualizado chega ao CRM na hora; o botão de sincronizar continua disponível como reforço.</p></div>' +

        (result ? '<div class="panel panel--wide"><h3>Resultado</h3><ul class="timeline">' + result.steps.map(function (s) {
          return '<li class="' + (s.ok ? "t-etapa" : "t-nota") + '"><time>' + (s.ok ? "✅" : "❌") + " " + esc(s.label) + "</time>" + esc(s.detail) + "</li>";
        }).join("") + "</ul>" +
        (result.pedidos && result.pedidos.length ? '<div class="table-wrap" style="box-shadow:none;margin-top:12px"><table><thead><tr><th>Pedido</th><th>Status na Tray</th><th>Lead</th><th>O que foi feito</th></tr></thead><tbody>' +
          result.pedidos.map(function (r) {
            return "<tr><td>" + esc(r.pedido) + "</td><td>" + esc(r.status || "") + "</td><td>" + (r.lead_id ? '<a href="#" data-open-lead="' + r.lead_id + '">#' + r.lead_id + "</a>" : "—") +
              '</td><td style="white-space:normal">' + esc(r.acao) + "</td></tr>";
          }).join("") + "</tbody></table></div>" : "") +
        "</div>" : "") + "</div>";

      $$("[data-open-lead]", view).forEach(function (a) {
        a.addEventListener("click", function (e) { e.preventDefault(); openLead(+a.getAttribute("data-open-lead")); });
      });
      var form = $("#tray-form");
      $$("input[readonly]", form).forEach(function (i) { i.addEventListener("focus", function () { i.removeAttribute("readonly"); }); });
      var clicked = "salvar";
      $$("button[name=acao]", form).forEach(function (b) { b.addEventListener("click", function () { clicked = b.value; }); });
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var msg = $(".form-msg", form);
        msg.textContent = "";
        $$("button", form).forEach(function (b) { b.disabled = true; });
        api("/tray", { method: "POST", body: { store_url: form.store_url.value, api_address: form.api_address.value, consumer_key: form.consumer_key.value, consumer_secret: form.consumer_secret.value, code: form.code.value } })
          .then(function () {
            if (clicked !== "sync") { toast("Credenciais salvas"); renderTray(); return; }
            msg.style.color = "var(--soft)";
            msg.textContent = "Conectando com a Tray e lendo pedidos…";
            return api("/tray/sync", { method: "POST", body: {} }).then(function (r) {
              toast(r.conectado ? "Pedidos sincronizados" : "A sincronização não terminou — veja os detalhes", !r.conectado);
              return loadLeads().then(function () { renderTray(r); });
            });
          }).catch(function (err) {
            msg.textContent = err.serverMessage || ERR[err.code] || err.code;
            $$("button", form).forEach(function (b) { b.disabled = false; });
          });
      });
    }).catch(fail);
  }

  /* ---------------- lista ---------------- */
  function renderList() {
    var list = filtered();
    $("#view").innerHTML = '<div class="table-wrap"><table><thead><tr>' +
      "<th>Entrada</th><th>Faixa</th><th>Nome</th><th>WhatsApp</th><th>Cidade</th><th>Interesse / produto</th><th>Prazo</th><th>Etapa</th><th>Valor</th><th>Origem</th>" +
      "</tr></thead><tbody>" + (list.map(function (l) {
        var si = stageInfo(l.pipeline, l.stage);
        return '<tr data-id="' + l.id + '"><td>' + fmtDate(l.created_at, true) + '</td><td><span class="fx fx-' + esc(l.faixa) + '">' + esc(l.faixa) + "</span> " + l.score +
          "</td><td>" + esc(l.nome) + "</td><td>" + esc(phoneFmt(l.whatsapp)) + "</td><td>" + esc(l.cidade || "") +
          '</td><td class="trunc">' + esc(l.produto || l.interesse || "") + "</td><td>" + esc(l.prazo || "") +
          "</td><td>" + esc(si.stage) + (l.stage === "ganho" && l.post_stage ? " · " + esc(postLabel(l.post_stage)) : "") +
          "</td><td>" + (l.valor ? brl(l.valor) : "") + '</td><td class="trunc">' + esc(l.utm_source || l.origem || "") + "</td></tr>";
      }).join("") || '<tr><td colspan="10" class="empty">Nenhum lead encontrado.</td></tr>') + "</tbody></table></div>";
    $$("tbody tr[data-id]").forEach(function (tr) { tr.addEventListener("click", function () { openLead(+tr.getAttribute("data-id")); }); });
  }

  /* ---------------- ações em leads ---------------- */
  function patchLead(id, body) {
    return api("/leads/" + id, { method: "PATCH", body: body }).then(function (d) {
      var i = S.leads.findIndex(function (l) { return l.id === id; });
      if (i >= 0) S.leads[i] = Object.assign(S.leads[i], d.lead);
      updateCounts();
      if (!$("#drawer").hidden && S.openId === id) openLead(id);
      render();
      return d;
    }).catch(function (e) { fail(e); render(); throw e; });
  }

  function moveLead(id, pipeline, stage) {
    var l = S.leads.filter(function (x) { return x.id === id; })[0];
    if (!l || (l.pipeline === pipeline && l.stage === stage)) return;
    if (stage === "ganho") return askWon(l, pipeline);
    if (stage === "perdido") return askLost(l, pipeline);
    patchLead(id, { pipeline: pipeline, stage: stage }).then(function () {
      toast("Movido para " + stageInfo(pipeline, stage).stage);
    }).catch(function () {});
  }

  function askWon(l, pipeline) {
    openModal(
      "<h2>Venda fechada — " + esc(l.nome) + "</h2>" +
      '<form id="won-form">' +
        '<label class="fld"><span>Onde a venda foi finalizada?</span><select name="canal_fechamento" required>' +
          '<option value="">Selecione</option>' +
          S.config.canais.map(function (c) { return '<option value="' + c.id + '"' + (l.canal_fechamento === c.id ? " selected" : "") + ">" + esc(c.label) + "</option>"; }).join("") +
        "</select></label>" +
        '<div class="grid2"><label class="fld"><span>Valor da venda (R$)</span><input name="valor" inputmode="decimal" value="' + (l.valor != null ? String(l.valor).replace(".", ",") : "") + '" placeholder="Ex.: 4.491,00"></label>' +
        '<label class="fld"><span>Nº do pedido Tray</span><input name="pedido_tray" placeholder="Se foi pelo site"></label></div>' +
        '<p class="form-msg"></p><div class="modal__actions"><button type="button" class="btn btn--ghost" data-close-modal>Cancelar</button><button class="btn btn--primary">Confirmar venda</button></div>' +
      "</form>");
    $("#won-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var f = e.target;
      if (!f.canal_fechamento.value) { $(".form-msg", f).textContent = "Selecione o canal."; return; }
      patchLead(l.id, { pipeline: pipeline, stage: "ganho", canal_fechamento: f.canal_fechamento.value, valor: f.valor.value, pedido_tray: f.pedido_tray.value })
        .then(function () { closeModal(); toast("Venda registrada! 🎉"); }).catch(function () {});
    });
  }

  function askLost(l, pipeline) {
    openModal(
      "<h2>Marcar como perdido — " + esc(l.nome) + "</h2>" +
      '<form id="lost-form"><label class="fld"><span>Motivo da perda</span><select name="motivo_perda" required><option value="">Selecione</option>' +
        S.config.motivos.map(function (m) { return "<option>" + esc(m) + "</option>"; }).join("") +
      '</select></label><p class="form-msg"></p><div class="modal__actions"><button type="button" class="btn btn--ghost" data-close-modal>Cancelar</button><button class="btn btn--danger">Marcar como perdido</button></div></form>');
    $("#lost-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var v = e.target.motivo_perda.value;
      if (!v) { $(".form-msg", e.target).textContent = "Selecione o motivo."; return; }
      patchLead(l.id, { pipeline: pipeline, stage: "perdido", motivo_perda: v })
        .then(function () { closeModal(); toast("Lead marcado como perdido"); }).catch(function () {});
    });
  }

  /* ---------------- detalhe do lead ---------------- */
  function stageOptions(l) {
    return Object.keys(S.config.pipelines).map(function (pk) {
      var p = S.config.pipelines[pk];
      return '<optgroup label="' + esc(p.label) + '">' + p.stages.map(function (s) {
        var v = pk + ":" + s.id;
        return '<option value="' + v + '"' + (l.pipeline === pk && l.stage === s.id ? " selected" : "") + ">" + esc(s.label) + "</option>";
      }).join("") + "</optgroup>";
    }).join("");
  }

  function openLead(id) {
    S.openId = id;
    var body = $("#drawer-body");
    body.innerHTML = '<p class="empty">Carregando…</p>';
    $("#drawer").hidden = false;
    api("/leads/" + id).then(function (d) {
      var l = d.lead;
      var si = stageInfo(l.pipeline, l.stage);
      var msg = "Olá, " + firstName(l.nome) + "! Aqui é da Pronto Artes. Recebemos seu contato pelo site" +
        (l.produto ? " sobre o " + l.produto : l.interesse ? " sobre " + l.interesse.toLowerCase() : "") + ". Posso te ajudar?";
      var wa = "https://wa.me/" + encodeURIComponent(l.whatsapp) + "?text=" + encodeURIComponent(msg);

      body.innerHTML =
        '<div class="d-head"><span class="fx fx-' + esc(l.faixa) + '">' + esc(l.faixa) + '</span><h2 id="drawer-title">' + esc(l.nome) + "</h2></div>" +
        '<p class="d-sub">' + esc(S.config.faixas[l.faixa] ? S.config.faixas[l.faixa].hint : "") + " · score " + l.score + " · " + esc(l.perfil || "") +
          "<br>" + esc(si.pipeline) + " › <strong>" + esc(si.stage) + "</strong> há " + ago(l.stage_changed_at || l.created_at) + "</p>" +
        '<div class="d-actions">' +
          '<a class="btn btn--wa" href="' + esc(wa) + '" target="_blank" rel="noopener">WhatsApp ' + esc(phoneFmt(l.whatsapp)) + "</a>" +
          (l.email ? '<a class="btn btn--ghost" href="mailto:' + esc(l.email) + '">E-mail</a>' : "") +
          '<a class="btn btn--ghost" href="https://www.prontoartes.com.br" target="_blank" rel="noopener">Loja Tray</a>' +
        "</div>" +

        '<form id="lead-edit">' +
          '<div class="grid2">' +
            '<label class="fld"><span>Etapa</span><select name="etapa">' + stageOptions(l) + "</select></label>" +
            '<label class="fld"><span>Faixa</span><select name="faixa">' +
              '<option value="auto"' + (!l.faixa_manual ? " selected" : "") + ">Automática (" + esc(l.faixa) + ")</option>" +
              ["A", "B", "C"].map(function (k) { return '<option value="' + k + '"' + (l.faixa_manual && l.faixa === k ? " selected" : "") + ">" + esc(S.config.faixas[k].label) + "</option>"; }).join("") +
            "</select></label>" +
            '<label class="fld"><span>Próximo follow-up</span><input type="datetime-local" name="next_followup_at" value="' + toLocalInput(l.next_followup_at) + '"></label>' +
            '<label class="fld"><span>Valor (R$)</span><input name="valor" inputmode="decimal" value="' + (l.valor != null ? String(l.valor).replace(".", ",") : "") + '"></label>' +
            '<label class="fld"><span>Canal de fechamento</span><select name="canal_fechamento"><option value="">—</option>' +
              S.config.canais.map(function (c) { return '<option value="' + c.id + '"' + (l.canal_fechamento === c.id ? " selected" : "") + ">" + esc(c.label) + "</option>"; }).join("") +
            "</select></label>" +
            '<label class="fld"><span>Nº pedido Tray</span><input name="pedido_tray" value="' + esc(l.pedido_tray || "") + '"></label>' +
            (l.stage === "ganho" ? '<label class="fld"><span>Pós-venda</span><select name="post_stage">' +
              S.config.postStages.map(function (s) { return '<option value="' + s.id + '"' + (l.post_stage === s.id ? " selected" : "") + ">" + esc(s.label) + "</option>"; }).join("") +
            "</select></label>" : "") +
            (l.stage === "perdido" ? '<label class="fld"><span>Motivo da perda</span><select name="motivo_perda">' +
              S.config.motivos.map(function (m) { return "<option" + (l.motivo_perda === m ? " selected" : "") + ">" + esc(m) + "</option>"; }).join("") +
            "</select></label>" : "") +
          "</div>" +
          '<div class="modal__actions" style="justify-content:flex-start"><button class="btn btn--primary">Salvar alterações</button></div>' +
        "</form>" +

        '<div class="d-sec"><h3>Respostas do formulário</h3><dl class="answers">' +
          row("Produto", l.produto) + row("Interesse", l.interesse) + row("Espaço", l.espaco) + row("Prazo", l.prazo) +
          row("Cidade", l.cidade) + row("E-mail", l.email) + row("Projeto", l.mensagem) +
        "</dl></div>" +

        '<div class="d-sec"><h3>Origem</h3><dl class="answers">' +
          row("Entrada", fmtDate(l.created_at, true)) + row("Canal", l.canal_entrada) + row("Formulário", l.origem) +
          row("UTM source", l.utm_source) + row("UTM medium", l.utm_medium) + row("UTM campaign", l.utm_campaign) +
          row("UTM content", l.utm_content) + row("UTM term", l.utm_term) + row("Google Ads", l.gclid ? "gclid ✓" : "") +
          row("Meta Ads", l.fbclid ? "fbclid ✓" : "") + row("Referência", l.referrer) + row("Envios", l.envios) +
        "</dl></div>" +

        '<div class="d-sec"><h3>Dados de contato</h3><form id="contact-edit"><div class="grid2">' +
          '<label class="fld"><span>Nome</span><input name="nome" value="' + esc(l.nome) + '"></label>' +
          '<label class="fld"><span>WhatsApp</span><input name="whatsapp" value="' + esc(phoneFmt(l.whatsapp)) + '"></label>' +
          '<label class="fld"><span>Cidade</span><input name="cidade" value="' + esc(l.cidade || "") + '"></label>' +
          '<label class="fld"><span>E-mail</span><input name="email" value="' + esc(l.email || "") + '"></label>' +
          '<label class="fld"><span>Produto</span><input name="produto" value="' + esc(l.produto || "") + '"></label>' +
          '<label class="fld"><span>Prazo</span><select name="prazo">' +
            ["", "Imediatamente", "Em até 30 dias", "Em 1 a 3 meses", "Só pesquisando"].map(function (p) {
              return '<option value="' + p + '"' + ((l.prazo || "") === p ? " selected" : "") + ">" + (p || "Não informado") + "</option>";
            }).join("") + "</select></label>" +
        '</div><button class="btn btn--ghost btn--sm">Salvar contato</button></form></div>' +

        waSendSection(l) +

        '<div class="d-sec"><h3>Histórico e notas</h3>' +
          '<form class="note-form" id="note-form"><textarea name="text" placeholder="Registrar conversa, proposta enviada, objeção…" required></textarea><button class="btn btn--primary">Anotar</button></form>' +
          '<ul class="timeline">' + d.events.map(function (ev) {
            var who = ev.type === "tray" ? " · 🛒 Loja Tray" : ev.type === "whatsapp_in" ? " · 💬 Cliente" : ev.type === "whatsapp_out" ? " · 🏪 Loja (WhatsApp)" : ev.user ? " · " + esc(ev.user) : "";
            return '<li class="t-' + esc(ev.type) + '"><time>' + fmtDate(ev.created_at, true) + who + "</time>" + esc(ev.text) + "</li>";
          }).join("") + "</ul></div>" +

        '<div class="d-sec"><button class="btn btn--danger btn--sm" id="del-lead">Excluir lead</button></div>';

      $("#lead-edit").addEventListener("submit", function (e) {
        e.preventDefault();
        var f = e.target;
        var parts = f.etapa.value.split(":");
        var payload = {
          faixa: f.faixa.value,
          next_followup_at: fromLocalInput(f.next_followup_at.value),
          valor: f.valor.value,
          canal_fechamento: f.canal_fechamento.value,
          pedido_tray: f.pedido_tray.value
        };
        if (f.post_stage) payload.post_stage = f.post_stage.value;
        if (f.motivo_perda) payload.motivo_perda = f.motivo_perda.value;
        var changingStage = parts[0] !== l.pipeline || parts[1] !== l.stage;
        if (changingStage && parts[1] === "ganho" && !payload.canal_fechamento) {
          patchLead(l.id, payload).then(function () { askWon(Object.assign({}, l, payload), parts[0]); }).catch(function () {});
          return;
        }
        if (changingStage && parts[1] === "perdido") {
          patchLead(l.id, payload).then(function () { askLost(l, parts[0]); }).catch(function () {});
          return;
        }
        if (changingStage) { payload.pipeline = parts[0]; payload.stage = parts[1]; }
        patchLead(l.id, payload).then(function () { toast("Lead atualizado"); }).catch(function () {});
      });

      bindWaSend(l);

      $("#contact-edit").addEventListener("submit", function (e) {
        e.preventDefault();
        var f = e.target;
        patchLead(l.id, { nome: f.nome.value, whatsapp: f.whatsapp.value, cidade: f.cidade.value, email: f.email.value, produto: f.produto.value, prazo: f.prazo.value })
          .then(function () { toast("Contato atualizado"); }).catch(function () {});
      });

      $("#note-form").addEventListener("submit", function (e) {
        e.preventDefault();
        var text = e.target.text.value.trim();
        if (!text) return;
        api("/leads/" + l.id + "/notes", { method: "POST", body: { text: text } }).then(function () { openLead(l.id); }).catch(fail);
      });

      $("#del-lead").addEventListener("click", function () {
        if (!confirm("Excluir definitivamente o lead " + l.nome + "?")) return;
        api("/leads/" + l.id, { method: "DELETE", body: {} }).then(function () {
          S.leads = S.leads.filter(function (x) { return x.id !== l.id; });
          closeDrawer(); updateCounts(); render(); toast("Lead excluído");
        }).catch(fail);
      });
    }).catch(fail);
  }
  function row(k, v) { return v == null || v === "" ? "" : "<dt>" + esc(k) + "</dt><dd>" + esc(v) + "</dd>"; }

  function closeDrawer() { $("#drawer").hidden = true; S.openId = null; }

  /* ---------------- modais ---------------- */
  function openModal(html) {
    $("#modal-body").innerHTML = html;
    $("#modal").hidden = false;
    var first = $("#modal-body input, #modal-body select");
    if (first) setTimeout(function () { first.focus(); }, 20);
  }
  function closeModal() { $("#modal").hidden = true; $("#modal-body").innerHTML = ""; }

  function newLeadModal() {
    openModal(
      "<h2>Novo lead</h2><form id=\"new-form\">" +
      '<div class="grid2"><label class="fld"><span>Nome *</span><input name="nome" required></label>' +
      '<label class="fld"><span>WhatsApp com DDD *</span><input name="whatsapp" inputmode="tel" required placeholder="(24) 98888-7777"></label>' +
      '<label class="fld"><span>Cidade/UF</span><input name="cidade"></label>' +
      '<label class="fld"><span>Como chegou?</span><select name="canal_entrada"><option value="whatsapp">Chamou no WhatsApp</option><option value="manual">Outro (telefone, loja, indicação)</option></select></label>' +
      '<label class="fld"><span>Prazo de compra</span><select name="prazo"><option value="">Não informado</option><option>Imediatamente</option><option>Em até 30 dias</option><option>Em 1 a 3 meses</option><option>Só pesquisando</option></select></label>' +
      '<label class="fld"><span>Espaço</span><select name="espaco"><option value="">Não informado</option><option>Casa / residência</option><option>Sítio, fazenda ou haras</option><option>Comércio / condomínio</option><option>Projeto de arquitetura / paisagismo</option><option>Órgão público / prefeitura</option></select></label></div>' +
      '<label class="fld"><span>Interesse</span><select name="interesse"><option value="">Não informado</option>' +
        ["Chafarizes e fontes", "Postes e iluminação de jardim", "Esculturas e ornamentos", "Vasos e ânforas", "Lenheiros e lareiras externas", "Mobiliário urbano, tampões e grelhas", "Kit para jardim (vários itens)", "Ainda não sei / quero ajuda"]
          .map(function (o) { return "<option>" + o + "</option>"; }).join("") + "</select></label>" +
      '<label class="fld"><span>Produto</span><input name="produto"></label>' +
      '<label class="fld"><span>Observações</span><textarea name="mensagem" rows="2"></textarea></label>' +
      '<p class="form-msg"></p><div class="modal__actions"><button type="button" class="btn btn--ghost" data-close-modal>Cancelar</button><button class="btn btn--primary">Criar lead</button></div></form>');
    $("#new-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var f = e.target, data = {};
      ["nome", "whatsapp", "cidade", "canal_entrada", "prazo", "espaco", "interesse", "produto", "mensagem"].forEach(function (k) { data[k] = f[k].value; });
      api("/leads", { method: "POST", body: data }).then(function (r) {
        closeModal();
        toast(r.duplicate ? "Já existia um lead com esse WhatsApp — atualizado." : "Lead criado");
        return loadLeads().then(function () { render(); openLead(r.id); });
      }).catch(function (err) { $(".form-msg", f).textContent = ERR[err.code] || "Não foi possível salvar."; });
    });
  }

  function passwordModal() {
    openModal('<h2>Alterar senha</h2><form id="pw-form">' +
      '<label class="fld"><span>Senha atual</span><input type="password" name="atual" autocomplete="current-password" required></label>' +
      '<label class="fld"><span>Nova senha (mín. 10 caracteres)</span><input type="password" name="nova" autocomplete="new-password" minlength="10" required></label>' +
      '<p class="form-msg"></p><div class="modal__actions"><button type="button" class="btn btn--ghost" data-close-modal>Cancelar</button><button class="btn btn--primary">Salvar</button></div></form>');
    $("#pw-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var f = e.target;
      api("/password", { method: "POST", body: { atual: f.atual.value, nova: f.nova.value } })
        .then(function () { closeModal(); toast("Senha alterada"); })
        .catch(function (err) { $(".form-msg", f).textContent = ERR[err.code] || "Não foi possível alterar."; });
    });
  }

  /* ---------------- init ---------------- */
  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-close-drawer]")) closeDrawer();
    if (e.target.closest("[data-close-modal]")) closeModal();
    var a = e.target.closest("[data-action]");
    if (!a) return;
    var act = a.getAttribute("data-action");
    if (act === "new-lead") newLeadModal();
    if (act === "password") passwordModal();
    if (act === "logout") api("/logout", { method: "POST", body: {} }).then(function () { location.replace("/admin"); }).catch(function () { location.replace("/admin"); });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (!$("#modal").hidden) closeModal(); else if (!$("#drawer").hidden) closeDrawer();
  });

  var searchT;
  $("#search").addEventListener("input", function (e) {
    clearTimeout(searchT);
    searchT = setTimeout(function () {
      S.q = e.target.value;
      if (S.view === "dashboard" && S.q) location.hash = "#lista"; else render();
    }, 200);
  });
  $$("#faixa-filter button").forEach(function (b) {
    b.addEventListener("click", function () {
      S.faixa = b.getAttribute("data-faixa");
      $$("#faixa-filter button").forEach(function (x) { x.classList.toggle("is-on", x === b); });
      if (S.view === "dashboard") location.hash = "#vendas"; else render();
    });
  });
  window.addEventListener("hashchange", route);

  Promise.all([api("/config"), api("/me"), loadLeads()]).then(function (r) {
    S.config = r[0];
    $("#me").textContent = "(" + r[1].user.username + ")";
    route();
    updateWaDot();
  }).catch(fail);

  // Atualiza a cada 60s para mostrar leads novos (sem atrapalhar quem está editando)
  setInterval(function () {
    if (!$("#drawer").hidden || !$("#modal").hidden || document.hidden) return;
    var before = S.leads.length;
    loadLeads().then(function () {
      if (S.leads.length > before) toast((S.leads.length - before) + " novo(s) lead(s)");
      if (S.view !== "dashboard") render();
    }).catch(function () {});
  }, 60000);
})();
