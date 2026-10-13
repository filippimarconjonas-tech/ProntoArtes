(function () {
  "use strict";

  var CFG = window.PA_CONFIG || {};
  var CDN = "https://images.tcdn.com.br/img/img_prod/830812/";

  /* ------------------------------------------------------------------
     Produtos em destaque (dados da loja prontoartes.com.br)
     ------------------------------------------------------------------ */
  var PRODUCTS = [
    { cat: "chafariz", name: "Chafariz Deusa Base Anjo", from: true, price: 8990, img: "assets/img/chafariz-deusa.webp", tag: "Lançamento" },
    { cat: "chafariz", name: "Chafariz 3 Quedas Flores — Fonte de Água", price: 6990, img: CDN + "chafariz_3_quedas_flores_meu_jardim_fonte_de_agua_ferro_fundido_48015189_1_03ca79b70939e273b2b9082ccba2f122.png" },
    { cat: "chafariz", name: "Chafariz de Parede Santa Fonte", price: 5520, img: CDN + "chafariz_de_parede_santa_fonte_ferro_fundido_1_20260203133204_c20e425840e5.jpeg", tag: "Lançamento" },
    { cat: "chafariz", name: "Chafariz de Parede Cara de Leão", price: 3990, img: CDN + "chafariz_de_parede_cara_de_leo_jardim_ferro_fundid_1_20260417162550_78b22694fa11.jpeg" },
    { cat: "poste", name: "Poste de Jardim Minha Casa", price: 1980, img: "assets/img/poste-minha-casa.webp", tag: "Oferta" },
    { cat: "poste", name: "Poste Paris Jardim Fazenda", price: 5990, img: CDN + "poste_paris_jardim_fazenda_iluminao_ferro_fundido_2_20260213144830_6a55e8dff92c.jpeg" },
    { cat: "poste", name: "Aplique Juart Luminária Tocheiro", price: 1290, img: CDN + "aplique_juart_luminria_jardim_tocheiro_ferro_fundi_1_20260304140252_8e776de7e70b.jpeg" },
    { cat: "escultura", name: "Escultura Cachorro Galgo — O Par", price: 2790, img: "assets/img/galgo-par.webp", tag: "Destaque", gold: true },
    { cat: "escultura", name: "Cachorro Dobermann — O Par", old: 4990, price: 4240, img: CDN + "cachorro_dobermann_o_par_escultura_ferro_fundido_pronto_artes_57248655_1_3660780afb6895a890b71feb23df43cb.png", tag: "-15% OFF" },
    { cat: "escultura", name: "Boneco Jockey Cavalo Antiquário", price: 3200, img: CDN + "boneco_jockey_decorar_em_ferro_fundido_cavalo_anti_2_20260417152358_3c008470ef23.jpeg" },
    { cat: "vaso", name: "Vaso Ânfora Bode — Jardim Exótico", price: 4990, img: "assets/img/anfora-bode.webp", tag: "Lançamento" },
    { cat: "vaso", name: "Vaso Holanda com Base 140 cm", price: 4900, img: CDN + "vaso_holanda_com_base_em_ferro_fundido_140cm_1_20260514153851_7e7b94988efd.jpeg" },
    { cat: "vaso", name: "Vaso Arcos da Lapa — O Par com Base", price: 6200, img: CDN + "vaso_arcos_da_lapa_par_base_flores_ferro_fundido_4_20260519095454_3fe2e3d5c0d4.jpeg" },
    { cat: "lenheiro", name: "Lenheiro Itatiaia Lareira 70×64 cm", price: 1800, img: CDN + "lenheiro_itatiaia_lareira_70x64cm_externa_ferro_fu_1_20260514140230_44fb8f7773ac.jpeg" },
    { cat: "lenheiro", name: "Lenheiro Fazenda 80 cm Lareira Externa", price: 3290, img: CDN + "lenheiro_fazenda_80cm_lareira_externa_fogo_inverno_1_20260520102435_913bd2eaa27b.jpeg" },
    { cat: "kit", name: "Kit Jardim de Haras — Cavalo + Fonte", price: 10190, img: CDN + "kit_jardim_de_haras_cavalo_fonte_de_agua_ferro_fundido_pronto_57248923_1_e738e0907a1c95e299d9b7612fcbe626.jpeg", tag: "Kit" },
    { cat: "kit", name: "Kit Minha Fazenda — Poste Paris + Vaso Inglês", price: 12990, img: CDN + "kit_minha_fazenda_poste_paris_vaso_ingles_completo_promocao_57248871_1_ddead8787282bbf247a8ad47bbc04450.jpeg", tag: "Kit" },
    { cat: "kit", name: "Kit Meu Jardim — Lenheiro + Poltronas", price: 4690, img: CDN + "kit_meu_jardim_8_1_lenheiro_urupema_2_poltronas_de_ferro_fundido_pronto_artes_57248717_1_19f6d4006ba425a941a0958e34f54369.png", tag: "Kit" }
  ];

  var CAT_INTEREST = {
    chafariz: "Chafarizes e fontes",
    poste: "Postes e iluminação de jardim",
    escultura: "Esculturas e ornamentos",
    vaso: "Vasos e ânforas",
    lenheiro: "Lenheiros e lareiras externas",
    kit: "Kit para jardim (vários itens)"
  };

  var brl = function (v) {
    return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  };
  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };

  /* ------------------------------------------------------------------
     Rastreamento (GTM / Meta / TikTok, se instalados)
     ------------------------------------------------------------------ */
  function track(event, data) {
    data = data || {};
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(Object.assign({ event: event }, data));
    try {
      if (event === "generate_lead") {
        if (typeof window.fbq === "function") window.fbq("track", "Lead", { content_category: data.interesse || "" });
        if (window.ttq && typeof window.ttq.track === "function") window.ttq.track("SubmitForm");
      }
      if (event === "lead_form_open" && typeof window.fbq === "function") {
        window.fbq("trackCustom", "LeadFormOpen", { origem: data.origem || "" });
      }
    } catch (e) { /* ignora erros de pixels */ }
  }

  /* UTMs / origem do tráfego — guardadas na sessão */
  var UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"];
  function getUtms() {
    var stored = {};
    try { stored = JSON.parse(sessionStorage.getItem("pa_utms") || "{}"); } catch (e) {}
    var params = new URLSearchParams(location.search);
    UTM_KEYS.forEach(function (k) { if (params.get(k)) stored[k] = params.get(k); });
    if (!stored.referrer && document.referrer) stored.referrer = document.referrer;
    try { sessionStorage.setItem("pa_utms", JSON.stringify(stored)); } catch (e) {}
    return stored;
  }
  var UTMS = getUtms();

  /* ------------------------------------------------------------------
     Render dos produtos + filtros
     ------------------------------------------------------------------ */
  function renderProducts() {
    var grid = $("#product-grid");
    if (!grid) return;
    grid.innerHTML = PRODUCTS.map(function (p, i) {
      var pix = Math.round(p.price * 0.9 * 100) / 100;
      var installments = Math.min(6, Math.max(1, Math.floor(p.price / 350)));
      var tag = p.tag ? '<span class="product__tag' + (p.gold ? " product__tag--gold" : "") + '">' + p.tag + "</span>" : "";
      return (
        '<article class="product" data-cat="' + p.cat + '">' +
          '<div class="product__img">' + tag +
            '<img src="' + p.img + '" alt="' + p.name + ' em ferro fundido" loading="lazy" decoding="async">' +
          "</div>" +
          '<div class="product__body">' +
            '<h3 class="product__name">' + p.name + "</h3>" +
            (p.old ? '<span class="product__old">' + brl(p.old) + "</span>" : "") +
            '<span class="product__price">' + (p.from ? '<small style="color:var(--ink-soft)">a partir de</small>' : "") + brl(pix) + "<small>no PIX (10% off)</small></span>" +
            '<span class="product__inst">ou ' + brl(p.price) + " em até " + installments + "x sem juros</span>" +
            '<button class="btn btn--wa btn--sm" data-lead-open data-origin="produto" data-product-index="' + i + '">' +
              '<svg class="ico" aria-hidden="true"><use href="#i-wa"/></svg><span>Quero este</span>' +
            "</button>" +
          "</div>" +
        "</article>"
      );
    }).join("");
  }

  function initFilters() {
    $$(".filter").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var f = btn.getAttribute("data-filter");
        $$(".filter").forEach(function (b) {
          var active = b === btn;
          b.classList.toggle("is-active", active);
          b.setAttribute("aria-selected", active ? "true" : "false");
        });
        $$(".product").forEach(function (card) {
          card.hidden = f !== "all" && card.getAttribute("data-cat") !== f;
        });
        track("product_filter", { filtro: f });
      });
    });
  }

  /* ------------------------------------------------------------------
     Máscara de telefone BR
     ------------------------------------------------------------------ */
  function maskPhone(v) {
    var d = v.replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "").slice(0, 11);
    if (d.length <= 2) return d.length ? "(" + d : "";
    if (d.length <= 6) return "(" + d.slice(0, 2) + ") " + d.slice(2);
    if (d.length <= 10) return "(" + d.slice(0, 2) + ") " + d.slice(2, 6) + "-" + d.slice(6);
    return "(" + d.slice(0, 2) + ") " + d.slice(2, 7) + "-" + d.slice(7);
  }
  function validPhone(v) {
    var d = v.replace(/\D/g, "");
    return d.length === 10 || d.length === 11;
  }
  function initMasks() {
    $$('[data-mask="phone"]').forEach(function (el) {
      el.addEventListener("input", function () { el.value = maskPhone(el.value); });
    });
  }

  /* ------------------------------------------------------------------
     Envio do lead + WhatsApp
     ------------------------------------------------------------------ */
  function buildWaMessage(lead) {
    var lines = ["Olá, Pronto Artes! Vim pelo site e gostaria de um orçamento."];
    lines.push("");
    lines.push("*Nome:* " + lead.nome);
    if (lead.cidade) lines.push("*Cidade:* " + lead.cidade);
    if (lead.produto) lines.push("*Produto:* " + lead.produto);
    if (lead.interesse) lines.push("*Interesse:* " + lead.interesse);
    if (lead.espaco) lines.push("*Espaço:* " + lead.espaco);
    if (lead.prazo) lines.push("*Prazo:* " + lead.prazo);
    if (lead.mensagem) lines.push("*Projeto:* " + lead.mensagem);
    return lines.join("\n");
  }

  function waUrl(lead) {
    return "https://wa.me/" + (CFG.whatsapp || "5524988370399") + "?text=" + encodeURIComponent(buildWaMessage(lead));
  }

  function sendLead(lead) {
    if (!CFG.leadEndpoint) return;
    var body = JSON.stringify(lead);
    try {
      // keepalive garante o envio mesmo que a página seja trocada pelo WhatsApp
      fetch(CFG.leadEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
        keepalive: true
      }).catch(function () {});
    } catch (e) {
      if (navigator.sendBeacon) navigator.sendBeacon(CFG.leadEndpoint, new Blob([body], { type: "application/json" }));
    }
  }

  function goToWhatsApp(lead) {
    var url = waUrl(lead);
    sendLead(lead);
    track("generate_lead", { origem: lead.origem, interesse: lead.interesse, espaco: lead.espaco, prazo: lead.prazo });
    try { localStorage.setItem("pa_lead_sent", "1"); } catch (e) {}
    // Abre em nova aba no desktop; no celular abre o app direto
    var isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    var win = isMobile ? null : window.open(url, "_blank");
    if (win) { try { win.opener = null; } catch (e) {} }
    else window.location.href = url;
    return url;
  }

  function leadBase(origin) {
    return Object.assign({
      origem: origin || "",
      pagina: location.href.split("#")[0],
      data: new Date().toISOString()
    }, UTMS);
  }

  /* ------------------------------------------------------------------
     Popup de qualificação (2 passos)
     ------------------------------------------------------------------ */
  var modal = $("#lead-modal");
  var form = $("#lead-form");
  var state = { origin: "", product: "", lastFocus: null };

  function fillInterestChips() {
    var box = $("#chips-interesse");
    box.innerHTML = (CFG.interests || []).map(function (opt, i) {
      return '<label class="chip"><input type="radio" name="interesse" value="' + opt + '"' + (i === 0 ? " required" : "") + "><span>" + opt + "</span></label>";
    }).join("");

    var select = $("#f-interesse");
    if (select) {
      (CFG.interests || []).forEach(function (opt) {
        var o = document.createElement("option");
        o.value = o.textContent = opt;
        select.appendChild(o);
      });
    }
  }

  function setStep(n) {
    $$(".step-pane", form).forEach(function (p) { p.hidden = p.getAttribute("data-step") !== String(n); });
    $("#lead-progress").style.width = n === 1 ? "50%" : "100%";
    var first = $('.step-pane[data-step="' + n + '"] input:not([type=hidden]), .step-pane[data-step="' + n + '"] button', form);
    if (first && n === 2) setTimeout(function () { first.focus(); }, 30);
  }

  function openModal(opts) {
    opts = opts || {};
    state.origin = opts.origin || "";
    state.product = opts.product || "";
    state.lastFocus = document.activeElement;

    form.reset();
    $$(".is-invalid", form).forEach(function (el) { el.classList.remove("is-invalid"); });
    $$(".form__msg", form).forEach(function (el) { el.textContent = ""; el.classList.remove("is-ok"); });

    var title = $("#lead-title"), sub = $("#lead-sub");
    if (opts.exit) {
      title.textContent = "Antes de sair: ganhe 10% no PIX";
      sub.textContent = "Conte o que procura e receba fotos, medidas e frete para sua cidade direto no WhatsApp.";
    } else {
      title.textContent = "Fale com um especialista";
      sub.textContent = "Responda 2 passos rápidos e continue no WhatsApp com o atendimento certo para você.";
    }

    var wrap = $("#lead-product-wrap");
    wrap.hidden = !state.product;
    $("#lead-product").textContent = state.product;

    if (opts.interest) {
      var radio = $$('input[name="interesse"]', form).filter(function (r) { return r.value === opts.interest; })[0];
      if (radio) radio.checked = true;
    }

    setStep(1);
    modal.hidden = false;
    document.body.classList.add("modal-open");
    setTimeout(function () { var c = $(".modal__close", modal); if (c) c.focus(); }, 30);
    track("lead_form_open", { origem: state.origin, produto: state.product });
  }

  function closeModal() {
    modal.hidden = true;
    document.body.classList.remove("modal-open");
    if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
  }

  function radioValue(name) {
    var r = $('input[name="' + name + '"]:checked', form);
    return r ? r.value : "";
  }

  function validateStep1() {
    var ok = true;
    ["interesse", "espaco", "prazo"].forEach(function (name) {
      var box = $('.chips[data-name="' + name + '"]', form);
      var has = !!radioValue(name);
      box.classList.toggle("is-invalid", !has);
      if (!has) ok = false;
    });
    var msg = $('.step-pane[data-step="1"] .form__msg', form);
    msg.textContent = ok ? "" : "Escolha uma opção em cada pergunta para continuar.";
    return ok;
  }

  function validateFields(scope, msgEl) {
    var ok = true;
    $$("input[required], select[required]", scope).forEach(function (el) {
      var valid;
      if (el.type === "checkbox") valid = el.checked;
      else if (el.getAttribute("data-mask") === "phone") valid = validPhone(el.value);
      else valid = el.value.trim().length >= 2;
      el.classList.toggle("is-invalid", !valid);
      if (!valid) ok = false;
    });
    var email = $('input[type="email"]', scope);
    if (email && email.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) {
      email.classList.add("is-invalid");
      ok = false;
    }
    if (msgEl) msgEl.textContent = ok ? "" : "Confira os campos destacados.";
    return ok;
  }

  function initModal() {
    document.addEventListener("click", function (e) {
      var trigger = e.target.closest("[data-lead-open]");
      if (!trigger) return;
      e.preventDefault();
      var idx = trigger.getAttribute("data-product-index");
      var product = idx !== null ? PRODUCTS[+idx] : null;
      openModal({
        origin: trigger.getAttribute("data-origin") || "",
        product: product ? product.name : "",
        interest: product ? CAT_INTEREST[product.cat] : trigger.getAttribute("data-interest")
      });
    });

    $$("[data-close]", modal).forEach(function (el) { el.addEventListener("click", closeModal); });
    document.addEventListener("keydown", function (e) {
      if (modal.hidden) return;
      if (e.key === "Escape") closeModal();
      if (e.key === "Tab") {
        var f = $$("button, input, select, textarea, a[href]", modal).filter(function (el) { return el.offsetParent !== null && !el.disabled; });
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    form.addEventListener("change", function (e) {
      if (e.target.type === "radio") {
        var box = e.target.closest(".chips");
        if (box) box.classList.remove("is-invalid");
      }
    });

    $("[data-next]", form).addEventListener("click", function () {
      if (validateStep1()) {
        setStep(2);
        track("lead_form_step2", { origem: state.origin, interesse: radioValue("interesse") });
      }
    });
    $("[data-prev]", form).addEventListener("click", function () { setStep(1); });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var pane = $('.step-pane[data-step="2"]', form);
      var msg = $(".form__msg", pane);
      if (!validateStep1()) { setStep(1); return; }
      if (!validateFields(pane, msg)) return;

      var lead = Object.assign(leadBase("popup:" + state.origin), {
        nome: form.nome.value.trim(),
        whatsapp: form.whatsapp.value.trim(),
        cidade: form.cidade.value.trim(),
        produto: state.product,
        interesse: radioValue("interesse"),
        espaco: radioValue("espaco"),
        prazo: radioValue("prazo")
      });
      var url = goToWhatsApp(lead);
      msg.classList.add("is-ok");
      msg.innerHTML = 'Pronto! Se o WhatsApp não abriu, <a href="' + url + '" target="_blank" rel="noopener">clique aqui</a>.';
    });
  }

  /* ------------------------------------------------------------------
     Formulário do rodapé
     ------------------------------------------------------------------ */
  function initFooterForm() {
    var f = $("#footer-form");
    if (!f) return;
    var started = false;
    f.addEventListener("focusin", function () {
      if (!started) { started = true; track("lead_form_open", { origem: "rodape" }); }
    });
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = $(".form__msg", f);
      msg.classList.remove("is-ok");
      if (!validateFields(f, msg)) return;
      var lead = Object.assign(leadBase("rodape"), {
        nome: f.nome.value.trim(),
        whatsapp: f.whatsapp.value.trim(),
        cidade: f.cidade.value.trim(),
        email: f.email.value.trim(),
        interesse: f.interesse.value,
        mensagem: f.mensagem.value.trim()
      });
      var url = goToWhatsApp(lead);
      msg.classList.add("is-ok");
      msg.innerHTML = 'Recebemos seus dados! Se o WhatsApp não abriu, <a href="' + url + '" target="_blank" rel="noopener">clique aqui</a>.';
    });
  }

  /* ------------------------------------------------------------------
     Extras de conversão
     ------------------------------------------------------------------ */
  function initMobileBar() {
    var bar = $(".mobilebar");
    var hero = $(".hero");
    if (!bar || !hero || !("IntersectionObserver" in window)) { if (bar) bar.classList.add("is-visible"); return; }
    var footerForm = $("#contato");
    var heroVisible = true, footerVisible = false;
    var update = function () { bar.classList.toggle("is-visible", !heroVisible && !footerVisible); };
    new IntersectionObserver(function (en) { heroVisible = en[0].isIntersecting; update(); }, { threshold: 0.15 }).observe(hero);
    if (footerForm) new IntersectionObserver(function (en) { footerVisible = en[0].isIntersecting; update(); }, { threshold: 0.1 }).observe(footerForm);
  }

  function initExitIntent() {
    if (!CFG.exitIntent || window.matchMedia("(max-width: 900px)").matches) return;
    var shown = false;
    try { shown = sessionStorage.getItem("pa_exit") === "1" || localStorage.getItem("pa_lead_sent") === "1"; } catch (e) {}
    if (shown) return;
    var armed = false;
    setTimeout(function () { armed = true; }, 8000); // só depois de 8s na página
    document.addEventListener("mouseout", function (e) {
      if (!armed || shown || e.relatedTarget || e.clientY > 10 || !modal.hidden) return;
      shown = true;
      try { sessionStorage.setItem("pa_exit", "1"); } catch (err) {}
      openModal({ origin: "exit-intent", exit: true });
    });
  }

  function initTopbar() {
    var track = $(".topbar__track");
    if (track && window.matchMedia("(max-width: 900px)").matches) {
      track.innerHTML += track.innerHTML; // duplica para o letreiro contínuo
    }
  }

  function initScrollTracking() {
    var marks = [25, 50, 75, 100], sent = {};
    window.addEventListener("scroll", function () {
      var h = document.documentElement;
      var pct = (h.scrollTop + window.innerHeight) / h.scrollHeight * 100;
      marks.forEach(function (m) {
        if (pct >= m && !sent[m]) { sent[m] = true; track("scroll_depth", { percentual: m }); }
      });
    }, { passive: true });
  }

  /* init */
  renderProducts();
  fillInterestChips();
  initFilters();
  initMasks();
  initModal();
  initFooterForm();
  initMobileBar();
  initExitIntent();
  initTopbar();
  initScrollTracking();
  var y = $("#year"); if (y) y.textContent = new Date().getFullYear();
})();
