/**
 * Pronto Artes — Worker da landing page.
 * - Serve os arquivos estáticos de ./public
 * - POST /api/lead: recebe o lead do formulário e repassa para LEAD_WEBHOOK_URL
 */

const FIELDS = [
  "nome", "whatsapp", "cidade", "email", "produto", "interesse", "espaco", "prazo", "mensagem",
  "origem", "pagina", "data", "utm_source", "utm_medium", "utm_campaign", "utm_term",
  "utm_content", "gclid", "fbclid", "referrer"
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

async function handleLead(request, env, ctx) {
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  let input;
  try {
    input = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  // Mantém apenas os campos conhecidos, como texto curto
  const lead = {};
  for (const key of FIELDS) {
    if (input[key] != null && input[key] !== "") lead[key] = String(input[key]).slice(0, 1000);
  }

  const digits = (lead.whatsapp || "").replace(/\D/g, "");
  if (!lead.nome || digits.length < 10 || digits.length > 13) {
    return json({ ok: false, error: "invalid_lead" }, 422);
  }

  lead.recebido_em = new Date().toISOString();
  lead.ip_pais = request.cf?.country || "";

  console.log("lead", JSON.stringify(lead));

  if (env.LEAD_WEBHOOK_URL) {
    ctx.waitUntil(
      fetch(env.LEAD_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(lead)
      }).catch((err) => console.error("webhook_error", err?.message))
    );
  }

  return json({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/lead") return handleLead(request, env, ctx);
    if (url.pathname.startsWith("/api/")) return json({ ok: false, error: "not_found" }, 404);
    return env.ASSETS.fetch(request);
  }
};
