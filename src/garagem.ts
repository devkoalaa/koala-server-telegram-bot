import { config } from "./config.ts";
import { escapeHtml } from "./format.ts";

// Garagem (fundo da troca de carro, garagem.devkoala.com). O bot chama a API
// do app pela rede interna "db" com a chave GARAGEM_BOT_CHAVE. As contas ficam
// no app (public/calculo.js, servido em /api/resumo); aqui só formatamos.

const APP_URL = "https://garagem.devkoala.com";

type Resumo = {
  fundo: number;
  /** Cofrinho do Mercado Pago lido pelo Open Finance, quando escolhido no app. */
  cofrinho: { nome: string; saldo: number; lidoEm: string } | null;
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

type Aviso =
  | { tipo: "entrada"; dados: { valor: number; data: string; de: string; conta: string } }
  | { tipo: "aporte"; dados: { valor: number; data: string; cofrinho: string } }
  | { tipo: "compra"; dados: { valor: number; data: string; loja: string; parcela: string | null; cartao: string } }
  | { tipo: "conexao"; dados: { status: string; contas: string[] } }
  | { tipo: "consentimento"; dados: { ate: string; contas: string[] } };

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

const diaMes = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

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
  if (r.cofrinho) {
    linhas.push("", `<i>Quando o movimento aparecer no cofrinho ${escapeHtml(r.cofrinho.nome)}, ele é ligado a este lançamento.</i>`);
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
    r.cofrinho
      ? `  cofrinho ${escapeHtml(r.cofrinho.nome)} ${brl(r.fundo)} + Uno líquido ${brl(r.unoLiquido)}`
      : `  fundo ${brl(r.fundo)} + Uno líquido ${brl(r.unoLiquido)}`,
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

/**
 * Avisos novos do Open Finance (o Garagem sincroniza com o banco e guarda os
 * avisos; aqui buscamos e montamos uma mensagem só). null quando não há nada.
 */
export async function avisosOpenFinance(): Promise<string | null> {
  const { avisos } = await chamar<{ avisos: Aviso[] }>("POST", "/api/avisos/pegar");
  if (avisos.length === 0) return null;
  const r = await chamar<Resumo>("GET", "/api/resumo");
  const s = r.semana;
  const blocos: string[] = [];

  const entradas = avisos.filter((a) => a.tipo === "entrada");
  if (entradas.length) {
    const linhas = entradas.map(
      ({ dados: d }) => `💸 Caiu <b>${brl(d.valor)}</b> no ${escapeHtml(d.conta)} — Pix de ${escapeHtml(d.de)} (${diaMes(d.data)})`,
    );
    if (s.faltam === 0) linhas.push("A semana do fundo já está batida ✅");
    else if (r.cofrinho) linhas.push(`Separe <b>${brl(s.faltam)}</b> no cofrinho <b>${escapeHtml(r.cofrinho.nome)}</b> pra fechar a semana.`);
    else linhas.push(`Guardou? Registre com <code>/guardar ${s.faltam.toLocaleString("pt-BR")}</code>.`);
    blocos.push(linhas.join("\n"));
  }

  const aportes = avisos.filter((a) => a.tipo === "aporte");
  if (aportes.length) {
    const linhas = aportes.map(({ dados: d }) =>
      d.valor > 0
        ? `🐷 <b>${brl(d.valor)}</b> entrou no cofrinho ${escapeHtml(d.cofrinho)} (${diaMes(d.data)})`
        : `↩️ <b>${brl(-d.valor)}</b> saiu do cofrinho ${escapeHtml(d.cofrinho)} (${diaMes(d.data)})`,
    );
    linhas.push(
      "Registrado no Garagem automaticamente.",
      "",
      `${barra(r.pct)} ${Math.round(r.pct * 100)}% da meta · semana ${s.faltam === 0 ? "batida ✅" : `faltam ${brl(s.faltam)}`}`,
    );
    blocos.push(linhas.join("\n"));
  }

  const compras = avisos.filter((a) => a.tipo === "compra");
  if (compras.length) {
    const linhas = compras.map(
      ({ dados: d }) =>
        `💳 <b>${brl(d.valor)}</b> no cartão — ${escapeHtml(d.loja)}${d.parcela ? ` (parcela ${d.parcela})` : ""} · ${diaMes(d.data)}`,
    );
    linhas.push("Isso estava no dinheiro livre da semana? Veja em “Esta semana” no Garagem.");
    blocos.push(linhas.join("\n"));
  }

  for (const a of avisos) {
    if (a.tipo === "conexao") {
      blocos.push(
        `⚠️ A conexão do Open Finance (${escapeHtml(a.dados.contas.join(", "))}) está com problema: ${escapeHtml(a.dados.status)}.\nReconecte em meu.pluggy.ai.`,
      );
    } else if (a.tipo === "consentimento") {
      const dias = Math.max(0, Math.ceil((Date.parse(a.dados.ate) - Date.now()) / 864e5));
      blocos.push(
        `🔑 A autorização do Open Finance (${escapeHtml(a.dados.contas.join(", "))}) vence em ${dias} dia${dias === 1 ? "" : "s"} (${diaMes(a.dados.ate.slice(0, 10))}).\nRenove em meu.pluggy.ai.`,
      );
    }
  }

  return blocos.length ? blocos.join("\n\n") : null;
}

type Agora = {
  agenda: { tipo: string; titulo: string; detalhe?: string; valor?: number; dias?: number }[];
  plano: { esperado: number; linhas: { rotulo: string; valor: number; falta: number }[]; sobra: number };
};

/** /agora: o que fazer e para onde vai o próximo pagamento. */
export async function agoraMessage(): Promise<string> {
  const { agenda, plano } = await chamar<Agora>("GET", "/api/agora");
  const prazo = (d?: number) =>
    d === undefined ? "" : d < 0 ? ` · venceu há ${-d} dia(s)` : d === 0 ? " · vence hoje" : ` · vence em ${d} dia${d === 1 ? "" : "s"}`;
  const [agora, ...resto] = agenda;
  const linhas = agora
    ? [
        "<b>👉 Agora</b>",
        `<b>${escapeHtml(agora.titulo)}</b>${agora.valor ? ` — ${brl(agora.valor)}` : ""}${prazo(agora.dias)}`,
        ...(agora.detalhe ? [escapeHtml(agora.detalhe)] : []),
      ]
    : ["<b>👉 Agora</b>", "Tudo em dia 🎉"];
  if (resto.length) {
    linhas.push("", "<b>Depois</b>", ...resto.map((i) => `• ${escapeHtml(i.titulo)}${i.valor ? ` — ${brl(i.valor)}` : ""}${prazo(i.dias)}`));
  }
  linhas.push("", `<b>💰 Próximo pagamento</b> (média ${brl(plano.esperado)})`);
  for (const l of plano.linhas) linhas.push(`• ${escapeHtml(l.rotulo)}: ${brl(l.valor)}${l.falta > 0.5 ? ` (faltam ${brl(l.falta)})` : ""}`);
  if (plano.sobra > 0) linhas.push(`• Sobra → fundo da troca: ${brl(plano.sobra)}`);
  linhas.push("", `<a href="${APP_URL}">Abrir o Garagem</a>`);
  return linhas.join("\n");
}
