/**
 * Catálogo de produtos: importação da planilha exportada da Tray e listagens
 * para o painel, a landing page e (futuramente) a IA de atendimento.
 */

/** CSV da Tray: separador ";", campos entre aspas, aspas escapadas como "". */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ";") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

const num = (v) => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s);
  return Number.isFinite(n) ? n : null;
};
const yes = (v) => /^(sim|s|1|true|yes)$/i.test(String(v ?? "").trim());

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ccedil: "ç", Ccedil: "Ç", atilde: "ã", Atilde: "Ã",
  otilde: "õ", Otilde: "Õ", aacute: "á", Aacute: "Á", eacute: "é", Eacute: "É", iacute: "í", Iacute: "Í", oacute: "ó",
  Oacute: "Ó", uacute: "ú", Uacute: "Ú", acirc: "â", Acirc: "Â", ecirc: "ê", Ecirc: "Ê", ocirc: "ô", Ocirc: "Ô", agrave: "à",
  Agrave: "À", uuml: "ü", ordm: "º", ordf: "ª", deg: "°", times: "×", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘",
  ldquo: "“", rdquo: "”", bull: "•", middot: "·", reg: "®", copy: "©", trade: "™" };

export function htmlToText(html) {
  return String(html || "")
    .replace(/<(br|\/p|\/li|\/h\d)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&([a-zA-Z]+);/g, (m, n) => ENTITIES[n] ?? m)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
    .slice(0, 6000);
}

const dateBr = (v) => {
  const m = String(v || "").match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

/** Importa a planilha "Exportar produtos" da Tray. Atualiza produtos existentes pelo código. */
export async function importTrayCsv(env, text) {
  const rows = parseCsv(text);
  const col = (r, ...names) => { for (const n of names) if (r[n] !== undefined) return r[n]; return ""; };
  const items = [];
  for (const r of rows) {
    const id = String(col(r, "Código produto", "Codigo produto", "id")).trim();
    const nome = String(col(r, "Nome produto", "nome")).trim();
    if (!id || !nome) continue;
    const imgs = ["Imagem principal", "Imagem 2", "Imagem 3", "Imagem 4"].map((k) => String(r[k] || "").trim()).filter(Boolean);
    const extra = String(r["Imagens adicionais"] || "").split(/[|,;\s]+/).filter((u) => /^https?:\/\//.test(u));
    const promo = num(col(r, "Preço promoção", "Preco promocao"));
    items.push({
      id, nome,
      categoria: String(col(r, "Nome categoria")).trim() || null,
      preco: num(col(r, "Preço venda", "Preco venda")),
      preco_promo: promo && promo > 0 ? promo : null,
      promo_inicio: dateBr(r["Inicio promoção"]),
      promo_fim: dateBr(r["Fim promoção"]),
      estoque: num(r["Estoque atual"]),
      disponivel: yes(r["Disponível"]) ? 1 : 0,
      exibir: yes(r["Exibir na loja"]) ? 1 : 0,
      peso_g: num(r["Peso"]),
      comprimento: num(r["Comprimento"]), largura: num(r["Largura"]), altura: num(r["Altura"]),
      vendidos: num(r["Quantidade vendida"]) || 0,
      descricao: htmlToText(r["Descrição grande"]),
      url: String(r["Endereço do Produto (URL Tray)"] || "").trim() || null,
      imagens: JSON.stringify([...new Set([...imgs, ...extra])].slice(0, 8))
    });
  }
  if (!items.length) return { importados: 0, erro: "Nenhum produto encontrado. Confira se é a planilha de produtos exportada da Tray." };

  const cols = Object.keys(items[0]);
  const sql = `INSERT INTO products (${cols.join(", ")}, origem, updated_at) VALUES (${cols.map(() => "?").join(", ")}, 'planilha', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(", ")}, origem = 'planilha', updated_at = excluded.updated_at`;
  for (let i = 0; i < items.length; i += 50) {
    await env.DB.batch(items.slice(i, i + 50).map((it) => env.DB.prepare(sql).bind(...cols.map((c) => it[c]))));
  }
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM products").first();
  return { importados: items.length, total: total?.n || items.length };
}

/** Preço vigente: promoção ativa (dentro das datas, quando houver) ou preço de venda. */
export function precoAtual(p, hoje = new Date().toISOString().slice(0, 10)) {
  const promoOk = p.preco_promo && p.preco_promo > 0 && p.preco_promo < (p.preco || Infinity) &&
    (!p.promo_inicio || p.promo_inicio <= hoje) && (!p.promo_fim || p.promo_fim >= hoje);
  return promoOk ? { preco: p.preco_promo, de: p.preco } : { preco: p.preco, de: null };
}

export async function listProductsAdmin(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, nome, categoria, preco, preco_promo, promo_inicio, promo_fim, estoque, disponivel, exibir, vendidos, url, imagens, updated_at FROM products ORDER BY categoria, nome"
  ).all();
  return results.map((p) => ({ ...p, imagens: JSON.parse(p.imagens || "[]"), ...precoAtual(p) }));
}

/** Catálogo público (landing page): só produtos visíveis e disponíveis, sem dados internos. */
export async function listProductsPublic(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, nome, categoria, preco, preco_promo, promo_inicio, promo_fim, vendidos, url, imagens FROM products WHERE exibir = 1 AND disponivel = 1 ORDER BY vendidos DESC, nome"
  ).all();
  return results.map((p) => {
    const { preco, de } = precoAtual(p);
    return { id: p.id, nome: p.nome, categoria: p.categoria, preco, de, url: p.url, imagem: JSON.parse(p.imagens || "[]")[0] || null };
  }).filter((p) => p.preco > 0);
}
