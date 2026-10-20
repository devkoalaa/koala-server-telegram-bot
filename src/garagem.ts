import { config } from "./config.ts";
import { escapeHtml } from "./format.ts";

// Garagem (fundo da troca de carro, garagem.devkoala.com). O bot chama a API
// do app pela rede interna "db" com a chave GARAGEM_BOT_CHAVE. As contas ficam
// no app (public/calculo.js, servido em /api/resumo); aqui só formatamos.

const APP_URL = "https://garagem.devkoala.com";

type Resumo = {
  fundo: number;
  unoLiquido: number;
  poder: number;
  meta: number;
  pct: number;
  alvo: string | null;
  previsao: { meses: number | null; mes: string | null };
  semana: { valor: number; meta: number; faltam: number; seguidas: number };
  parcelas: { restantes: number; total: number; valor: number };
};

type Aporte = { id: string; data: string; valor: number; nota: string };

export const garagemAtivo = () => Boolean(config.garagemBotChave);

async function chamar<T>(metodo: string, caminho: string, corpo?: unknown): Promise<T> {
  const resp = await fetch(config.garagemUrl + caminho, {
    method: metodo,
    headers: {
      authorization: `Bearer ${config.garagemBotChave}`,
      ...(corpo === undefined ? {} : { "content-type": "application/json" }),
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await resp.json().catch(() => ({}))) as { erro?: string };
  if (!resp.ok) throw new Error(json.erro ?? `Garagem respondeu ${resp.status}`);
  return json as T;
}

const brl = (v: number) => {
  const centavos = Math.round(Math.abs(v) * 100);
  return (
    (v < 0 ? "−" : "") +
    "R$ " +
    (centavos / 100).toLocaleString("pt-BR", { minimumFractionDigits: centavos % 100 ? 2 : 0, maximumFractionDigits: 2 })
  );
};

const barra = (pct: number) => {
  const cheios = Math.round(pct * 10);
  return "▓".repeat(cheios) + "░".repeat(10 - cheios);
};

const hojeSP = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: config.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/** "1000", "1.000", "1.000,50", "R$ 1500", "1,5k" → número; null se não der. */
export function parseValor(texto: string): number | null {
  let s = texto.trim().toLowerCase().replace(/^r\$/, "");
  let mult = 1;
  if (s.endsWith("k")) {
    mult = 1000;
    s = s.slice(0, -1);
  }
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const valor = Math.round(Number(s) * mult * 100) / 100;
  return valor > 0 && valor < 1e7 ? valor : null;
}

/** "/guardar R$ 1.000 semana automotiva" → { valor: 1000, nota: "semana automotiva" } */
export function valorENota(args: string): { valor: number | null; nota: string } {
  const partes = args.trim().split(/\s+/).filter(Boolean);
  if (partes[0]?.toLowerCase() === "r$") partes.shift();
  if (partes.length === 0) return { valor: null, nota: "" };
  return { valor: parseValor(partes[0]), nota: partes.slice(1).join(" ").slice(0, 200) };
}

export async function registrarAporte(valor: number, nota: string): Promise<{ aporte: Aporte; html: string }> {
  const aporte = await chamar<Aporte>("POST", "/api/aportes", { valor, data: hojeSP(), nota });
  const r = await chamar<Resumo>("GET", "/api/resumo");
  const s = r.semana;
  const bateuAgora = valor > 0 && s.valor >= s.meta && s.valor - valor < s.meta;

  const linhas = [
    valor > 0
      ? `💰 <b>Guardado: ${brl(valor)}</b>${nota ? ` — ${escapeHtml(nota)}` : ""}`
      : `↩️ <b>Retirada: ${brl(-valor)}</b>${nota ? ` — ${escapeHtml(nota)}` : ""}`,
    "",
    `${barra(r.pct)} ${Math.round(r.pct * 100)}% da meta`,
    `Poder de compra: <b>${brl(r.poder)}</b> de ${brl(r.meta)}`,
    r.previsao.mes ? `Previsão: <b>${r.previsao.mes}</b>` : "Previsão: mais de 10 anos no ritmo atual",
  ];
  if (bateuAgora) {
    linhas.push("", `✅ <b>Meta da semana batida!</b>${s.seguidas > 1 ? ` ${s.seguidas} semanas seguidas 🔥` : ""}`);
  } else if (valor > 0 && s.faltam > 0) {
    linhas.push("", `Faltam ${brl(s.faltam)} para fechar a semana.`);
  }
  return { aporte, html: linhas.join("\n") };
}

export async function desfazerAporte(id: string): Promise<void> {
  await chamar("DELETE", `/api/aportes/${encodeURIComponent(id)}`);
}

export async function pagarParcela(pagas: 1 | -1): Promise<{ restantes: number; total: number }> {
  return chamar("POST", "/api/parcela", { pagas });
}

export async function fundoMessage(): Promise<string> {
  const r = await chamar<Resumo>("GET", "/api/resumo");
  const s = r.semana;
  const semana =
    s.faltam === 0
      ? `✅ ${brl(s.valor)} — semana batida`
      : `${brl(s.valor)} de ${brl(s.meta)} · faltam ${brl(s.faltam)}`;
  return [
    "<b>🚗 Garagem — fundo da troca</b>",
    "",
    `${barra(r.pct)} <b>${Math.round(r.pct * 100)}%</b>`,
    `Poder de compra: <b>${brl(r.poder)}</b>`,
    `  fundo ${brl(r.fundo)} + Uno líquido ${brl(r.unoLiquido)}`,
    `Meta: ${brl(r.meta)}${r.alvo ? ` — ${escapeHtml(r.alvo)}` : ""}`,
    r.previsao.mes
      ? `Previsão: <b>${r.previsao.mes}</b>${r.previsao.meses ? ` (${r.previsao.meses} meses)` : ""}`
      : "Previsão: mais de 10 anos no ritmo atual",
    "",
    `Semana: ${semana}`,
    s.seguidas > 0 ? `Sequência: ${s.seguidas} semana${s.seguidas > 1 ? "s" : ""} 🔥` : "Sequência: começa nesta semana",
    `Parcelas do Uno: faltam ${r.parcelas.restantes} de ${r.parcelas.total}`,
    "",
    `<a href="${APP_URL}">Abrir o Garagem</a>`,
  ].join("\n");
}

/** Lembrete de sexta: só quando a semana ainda não fechou. */
export async function lembreteSemana(): Promise<string | null> {
  const r = await chamar<Resumo>("GET", "/api/resumo");
  const s = r.semana;
  if (s.faltam === 0) return null;
  return [
    `💰 <b>Faltam ${brl(s.faltam)} para fechar a semana</b> do fundo da troca.`,
    s.seguidas > 0
      ? `Você está com ${s.seguidas} semana${s.seguidas > 1 ? "s" : ""} seguida${s.seguidas > 1 ? "s" : ""}, não deixa cair! 🔥`
      : s.valor > 0
        ? `Já entrou ${brl(s.valor)} de ${brl(s.meta)}.`
        : "Ainda não entrou nada nesta semana.",
    "",
    `Responda com <code>/guardar ${s.faltam.toLocaleString("pt-BR")}</code> quando separar o dinheiro.`,
  ].join("\n");
}
