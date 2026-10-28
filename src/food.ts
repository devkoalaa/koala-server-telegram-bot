import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import pg from "pg";
import { z } from "zod";
import { config } from "./config.ts";
import { escapeHtml } from "./format.ts";

// Diário alimentar: o dono manda o que comeu ou bebeu (texto, foto ou foto com
// legenda) e a API do Claude estima porções, calorias e macros. O resultado é
// gravado direto em food_logs do koala-fit, com um botão Desfazer que apaga os
// itens daquela mensagem. Diferente do relatório da balança, aqui o Claude não
// roda no host: é uma chamada à API com saída estruturada, e o bot valida os
// números antes de gravar.

export const MEALS = [
  "Café da manhã",
  "Lanche da manhã",
  "Almoço",
  "Lanche da tarde",
  "Pré-treino",
  "Pós-treino",
  "Jantar",
  "Ceia",
] as const;

const ItemSchema = z.object({
  description: z.string(),
  quantity: z.string(),
  kcal: z.number(),
  protein_g: z.number(),
  carbs_g: z.number(),
  fat_g: z.number(),
  fiber_g: z.number(),
  water_ml: z.number(),
});

const AnalysisSchema = z.object({
  kind: z.enum(["food", "scale_report", "other"]),
  // Texto livre no schema (o SDK transforma enums em dica); normalizado em mealOf().
  meal: z.string().nullable(),
  eaten_at: z.string().nullable(),
  items: z.array(ItemSchema),
  reply: z.string(),
});

type Analysis = z.infer<typeof AnalysisSchema>;

/** Uma das refeições conhecidas (comparação sem acento/caixa), ou null. */
function mealOf(value: string | null): string | null {
  const key = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  return value ? (MEALS.find((m) => key(m) === key(value)) ?? null) : null;
}
type Item = z.infer<typeof ItemSchema>;

export type FoodImage = { data: Buffer; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" };

const SYSTEM = `Você registra o diário alimentar do Herbert no app Koala Fit. Ele manda pelo Telegram o que comeu ou bebeu: em texto, em foto, ou foto com uma descrição dele.

Para cada alimento ou bebida, estime a quantidade e calcule kcal, proteína, carboidrato, gordura e fibra (em gramas) e água (ml).

Como estimar:
- Use tabelas brasileiras (TACO/IBGE) e o rótulo de marcas brasileiras quando a marca for citada ou aparecer na foto. Se houver tabela nutricional visível, use os números dela.
- A descrição dele tem prioridade sobre o que você vê na foto. Quando faltar quantidade, estime pela foto (tamanho do prato, talheres, embalagem) ou pela porção brasileira comum.
- Em "quantity", escreva a quantidade que você usou, com medida caseira e gramas ou ml quando fizer sentido: "4 col. de sopa (100 g)", "1 lata (350 ml)".
- Um item por alimento: arroz, feijão e frango são três itens. Bebidas também são itens.
- Conte o óleo, a manteiga e o açúcar do preparo típico (arroz, refogados, frituras, café adoçado). Ele prefere números realistas a otimistas.
- water_ml é o volume de bebidas não alcoólicas (água, café, chá, suco, refrigerante, leite). Para comida e bebida alcoólica, 0. Água pura tem kcal 0.

Outros campos:
- kind: "food" quando a mensagem relata algo que ele comeu ou bebeu. "scale_report" quando a imagem é um print de relatório de balança de bioimpedância (peso, gordura, músculo; o app OKOK costuma estar em chinês), e não comida. "other" para o resto: perguntas, conversa, foto sem comida. Em "scale_report" e "other", items fica vazio.
- meal: uma destas refeições, escrita igual: ${MEALS.join(", ")}. Deduza do texto ("no almoço") ou da hora. null se não der para saber.
- eaten_at: preencha só se ele disser que foi em outra hora ou dia ("ontem no jantar", "às 7h"), no formato YYYY-MM-DDTHH:MM, horário de São Paulo. Senão, null.
- reply: em português, de 1 a 3 frases curtas, sem markdown. Em "food", diga as suposições que fez (porção estimada, preparo) e, quando ajudar, uma observação curta sobre as metas do dia. Em "other", se for pergunta sobre a dieta, responda com base no que já foi registrado hoje e nas metas; se não for, diga que você registra comidas e bebidas. Se ele pedir para corrigir um registro anterior, registre o que ele mandou agora e diga para tocar em Desfazer no registro errado.

Contexto: Herbert tem 28 anos, 1,80 m, cerca de 116 kg e 37% de gordura. O objetivo é perder gordura mantendo o músculo, com dieta de déficit e proteína alta.`;

let client: Anthropic | null = null;

export function foodEnabled(): boolean {
  return config.anthropicApiKey !== "";
}

const reader = new pg.Pool({ connectionString: config.koalaFitDatabaseUrl, max: 1 });
const writer = new pg.Pool({ connectionString: config.koalaFitWriterDatabaseUrl, max: 1 });

type Goals = {
  id: string;
  kcal_goal: number | null;
  protein_goal_g: number | null;
  carbs_goal_g: number | null;
  fat_goal_g: number | null;
  fiber_goal_g: number | null;
  water_goal_ml: number | null;
};

async function userGoals(): Promise<Goals> {
  const { rows } = await reader.query<Goals>(
    `select id, kcal_goal, protein_goal_g, carbs_goal_g, fat_goal_g, fiber_goal_g, water_goal_ml
       from users order by created_at limit 1`,
  );
  if (!rows[0]) throw new Error("Nenhum usuário no koala-fit");
  return rows[0];
}

type LoggedRow = {
  meal: string | null;
  description: string;
  quantity: string | null;
  kcal: number;
  protein_g: string | null;
  carbs_g: string | null;
  fat_g: string | null;
  fiber_g: string | null;
  water_ml: number | null;
  time: string;
};

async function todayRows(userId: string): Promise<LoggedRow[]> {
  const { rows } = await writer.query<LoggedRow>(
    `select meal, description, quantity, kcal, protein_g, carbs_g, fat_g, fiber_g, water_ml,
            to_char(eaten_at at time zone $2, 'HH24:MI') as time
       from food_logs
      where user_id = $1 and date = (now() at time zone $2)::date
      order by eaten_at`,
    [userId, config.timeZone],
  );
  return rows;
}

type Totals = { kcal: number; protein: number; carbs: number; fat: number; fiber: number; water: number };

function totalsOf(rows: LoggedRow[]): Totals {
  const t: Totals = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, water: 0 };
  for (const r of rows) {
    t.kcal += r.kcal;
    t.protein += Number(r.protein_g ?? 0);
    t.carbs += Number(r.carbs_g ?? 0);
    t.fat += Number(r.fat_g ?? 0);
    t.fiber += Number(r.fiber_g ?? 0);
    t.water += r.water_ml ?? 0;
  }
  return t;
}

function nowLocal(): string {
  return new Date().toLocaleString("pt-BR", {
    timeZone: config.timeZone,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function contextText(text: string, goals: Goals, rows: LoggedRow[]): string {
  const t = totalsOf(rows);
  const logged = rows.length
    ? rows.map((r) => `- ${r.time} ${r.meal ?? ""}: ${r.description} (${r.quantity ?? "?"}) ${r.kcal} kcal, P ${r.protein_g ?? 0} g`).join("\n")
    : "(nada ainda)";
  return [
    `Agora: ${nowLocal()} (São Paulo).`,
    `Metas do dia: ${goals.kcal_goal ?? "?"} kcal, proteína ${goals.protein_goal_g ?? "?"} g, carboidrato ${goals.carbs_goal_g ?? "?"} g, gordura ${goals.fat_goal_g ?? "?"} g, fibra ${goals.fiber_goal_g ?? "?"} g, água ${goals.water_goal_ml ?? "?"} ml.`,
    `Já registrado hoje:\n${logged}`,
    `Total de hoje até agora: ${t.kcal} kcal, proteína ${Math.round(t.protein)} g, água ${t.water} ml.`,
    "",
    `Mensagem do Herbert: ${text.trim() || "(só a foto, sem descrição)"}`,
  ].join("\n");
}

/** Pede ao Claude a análise da mensagem (texto e/ou imagem). */
async function analyze(text: string, image: FoodImage | null, goals: Goals, rows: LoggedRow[]): Promise<Analysis> {
  client ??= new Anthropic({ apiKey: config.anthropicApiKey });
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (image) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.data.toString("base64") },
    });
  }
  content.push({ type: "text", text: contextText(text, goals, rows) });

  let response;
  try {
    response = await client.beta.messages.parse({
      model: config.foodModel,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{ role: "user", content }],
      output_config: { effort: "medium", format: betaZodOutputFormat(AnalysisSchema) },
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error("A chave da API do Claude (ANTHROPIC_API_KEY) foi recusada.");
    if (err instanceof Anthropic.RateLimitError) throw new Error("Limite de uso da API do Claude atingido. Tente de novo daqui a pouco.");
    if (err instanceof Anthropic.APIError) throw new Error(`A API do Claude falhou (HTTP ${err.status ?? "?"}).`);
    if (err instanceof Error && err.name.includes("Zod")) throw new Error("O Claude não devolveu uma análise válida.");
    throw err;
  }
  if (response.stop_reason === "refusal") throw new Error("O Claude recusou analisar essa mensagem.");
  if (!response.parsed_output) throw new Error("O Claude não devolveu uma análise válida.");
  return response.parsed_output;
}

type Limit = { key: keyof Item; label: string; max: number };

// Limites por item: rejeitam leituras absurdas (um zero a mais), não julgam a dieta.
const LIMITS: Limit[] = [
  { key: "kcal", label: "calorias", max: 4000 },
  { key: "protein_g", label: "proteína", max: 300 },
  { key: "carbs_g", label: "carboidrato", max: 600 },
  { key: "fat_g", label: "gordura", max: 300 },
  { key: "fiber_g", label: "fibra", max: 100 },
  { key: "water_ml", label: "água", max: 5000 },
];

function validateItems(items: Item[]): Item[] {
  if (items.length === 0) throw new Error("Não identifiquei nenhum alimento na mensagem.");
  if (items.length > 30) throw new Error("Itens demais numa mensagem só; mande em partes.");
  for (const item of items) {
    if (!item.description.trim()) throw new Error("Um dos itens veio sem descrição.");
    for (const l of LIMITS) {
      const v = item[l.key];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > l.max) {
        throw new Error(`Valor de ${l.label} fora do esperado em "${item.description}": ${String(v)}`);
      }
    }
  }
  return items;
}

/** Hora informada pelo Claude, se for válida e dos últimos 3 dias; senão null (= agora). */
function validEatenAt(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  // Compara como horário local de São Paulo (UTC−3, sem horário de verão).
  const ts = Date.parse(`${value}:00-03:00`);
  if (!Number.isFinite(ts)) return null;
  const now = Date.now();
  if (ts > now + 15 * 60_000 || ts < now - 3 * 86_400_000) return null;
  return value;
}

export type FoodResult =
  | { kind: "saved"; html: string }
  | { kind: "scale_report" }
  | { kind: "other"; html: string };

/** Analisa a mensagem e, se for comida, grava os itens ligados a `messageId`. */
export async function logFood(text: string, image: FoodImage | null, messageId: number): Promise<FoodResult> {
  const goals = await userGoals();
  const before = await todayRows(goals.id);
  const analysis = await analyze(text, image, goals, before);

  if (analysis.kind === "scale_report") return { kind: "scale_report" };
  if (analysis.kind === "other") return { kind: "other", html: `💬 ${escapeHtml(analysis.reply)}` };

  const items = validateItems(analysis.items);
  const meal = mealOf(analysis.meal);
  const eatenAt = validEatenAt(analysis.eaten_at);
  const source = image ? "telegram-foto" : "telegram";
  const localTs = `coalesce($2::timestamp, (now() at time zone '${config.timeZone}')::timestamp(0))`;

  const db = await writer.connect();
  try {
    await db.query("begin");
    for (const item of items) {
      await db.query(
        `insert into food_logs (id, user_id, eaten_at, date, meal, description, quantity, kcal,
                                protein_g, carbs_g, fat_g, fiber_g, water_ml, source, telegram_message_id)
         values (gen_random_uuid(), $1, ${localTs} at time zone '${config.timeZone}', ${localTs}::date,
                 $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          goals.id,
          eatenAt,
          meal,
          item.description.trim(),
          item.quantity.trim() || null,
          Math.round(item.kcal),
          round1(item.protein_g),
          round1(item.carbs_g),
          round1(item.fat_g),
          round1(item.fiber_g),
          item.water_ml > 0 ? Math.round(item.water_ml) : null,
          source,
          messageId,
        ],
      );
    }
    await db.query("commit");
  } catch (err) {
    await db.query("rollback");
    throw err;
  } finally {
    db.release();
  }

  const after = await todayRows(goals.id);
  const lines = [`🍽️ <b>${escapeHtml(meal ?? "Registrado")}</b>${eatenAt ? ` · ${escapeHtml(formatEatenAt(eatenAt))}` : ""}`];
  for (const item of items) {
    lines.push(`• ${escapeHtml(item.description)} (${escapeHtml(item.quantity)}): <b>${Math.round(item.kcal)} kcal</b> · P ${fmt(item.protein_g)} g`);
  }
  if (analysis.reply.trim()) lines.push("", `<i>${escapeHtml(analysis.reply.trim())}</i>`);
  // Um registro de outro dia não mexe no total de hoje.
  lines.push("", eatenAt && !isToday(eatenAt) ? "<i>Fora do total de hoje (outro dia).</i>" : dayTotalsHtml(totalsOf(after), goals));
  return { kind: "saved", html: lines.join("\n") };
}

/** Apaga os itens gravados a partir de uma mensagem; devolve quantos eram. */
export async function undoFood(messageId: number): Promise<number> {
  const goals = await userGoals();
  const { rowCount } = await writer.query("delete from food_logs where user_id = $1 and telegram_message_id = $2", [
    goals.id,
    messageId,
  ]);
  return rowCount ?? 0;
}

/** /dieta: o que foi registrado hoje, por refeição, e os totais contra as metas. */
export async function dayMessage(): Promise<string> {
  const goals = await userGoals();
  const rows = await todayRows(goals.id);
  if (rows.length === 0) {
    return "🍽️ Nada registrado hoje. Mande o que comeu ou bebeu, em texto ou foto.";
  }
  const byMeal = new Map<string, LoggedRow[]>();
  for (const r of rows) byMeal.set(r.meal ?? "Outros", [...(byMeal.get(r.meal ?? "Outros") ?? []), r]);
  const lines = ["<b>🍽️ Hoje</b>"];
  for (const [meal, items] of byMeal) {
    const kcal = items.reduce((sum, r) => sum + r.kcal, 0);
    lines.push("", `<b>${escapeHtml(meal)}</b> · ${kcal} kcal`);
    for (const r of items) lines.push(`• ${r.time} ${escapeHtml(r.description)}: ${r.kcal} kcal`);
  }
  lines.push("", dayTotalsHtml(totalsOf(rows), goals), "", '<a href="https://fit.devkoala.com/alimentacao">Abrir no Koala Fit</a>');
  return lines.join("\n");
}

function dayTotalsHtml(t: Totals, goals: Goals): string {
  const kcalLine = goals.kcal_goal
    ? `<b>Hoje:</b> ${num(t.kcal)} / ${num(goals.kcal_goal)} kcal (${
        t.kcal > goals.kcal_goal ? `${num(t.kcal - goals.kcal_goal)} acima` : `faltam ${num(goals.kcal_goal - t.kcal)}`
      })`
    : `<b>Hoje:</b> ${num(t.kcal)} kcal`;
  const part = (label: string, value: number, goal: number | null, unit: string) =>
    `${label} ${num(Math.round(value))}${goal ? ` / ${num(goal)}` : ""} ${unit}`;
  return [
    kcalLine,
    [part("Proteína", t.protein, goals.protein_goal_g, "g"), part("Carbo", t.carbs, goals.carbs_goal_g, "g"), part("Gordura", t.fat, goals.fat_goal_g, "g")].join(" · "),
    [part("Fibra", t.fiber, goals.fiber_goal_g, "g"), part("Água", t.water, goals.water_goal_ml, "ml")].join(" · "),
  ].join("\n");
}

function isToday(localIso: string): boolean {
  return localIso.slice(0, 10) === new Date().toLocaleDateString("sv-SE", { timeZone: config.timeZone });
}

function formatEatenAt(localIso: string): string {
  const [date, time] = localIso.split("T");
  const [, m, d] = date.split("-");
  return isToday(localIso) ? time : `${d}/${m} ${time}`;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function fmt(v: number): string {
  return v.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
}

function num(v: number): string {
  return v.toLocaleString("pt-BR");
}
