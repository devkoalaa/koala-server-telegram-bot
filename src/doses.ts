import pg from "pg";
import { config } from "./config.ts";
import { escapeHtml } from "./format.ts";

// Doses semanais (dose_logs do koala-fit). O comando /dose fica fora do menu
// do bot e as mensagens não dizem do que se trata: é discreto de propósito.
// No app, a tela abre com 5 toques no título da Evolução.

const INTERVAL_DAYS = 7;
const writer = new pg.Pool({ connectionString: config.koalaFitWriterDatabaseUrl, max: 1 });
const reader = new pg.Pool({ connectionString: config.koalaFitDatabaseUrl, max: 1 });
const TODAY = `(now() at time zone '${config.timeZone}')::date`;

async function userId(): Promise<string> {
  const { rows } = await reader.query<{ id: string }>("select id from users order by created_at limit 1");
  if (!rows[0]) throw new Error("Nenhum usuário no koala-fit");
  return rows[0].id;
}

type DoseRow = { dose_mg: string; notes: string | null; when: string; date: string };

async function recentDoses(uid: string, limit: number): Promise<DoseRow[]> {
  const { rows } = await writer.query<DoseRow>(
    `select dose_mg, notes, to_char(date, 'YYYY-MM-DD') as date,
            to_char(taken_at at time zone $2, 'DD/MM HH24:MI') as "when"
       from dose_logs where user_id = $1 order by taken_at desc limit $3`,
    [uid, config.timeZone, limit],
  );
  return rows;
}

function mg(value: number | string): string {
  return `${Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} mg`;
}

function nextDate(lastIso: string): string {
  const d = new Date(`${lastIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + INTERVAL_DAYS);
  return d.toISOString().slice(0, 10);
}

function br(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

/** "2,5 barriga, enjoo leve" → dose 2.5 e o resto como observação. */
export function parseDose(text: string): { doseMg: number; notes: string | null } | null {
  const match = text.trim().match(/^(\d+(?:[.,]\d+)?)\s*(?:mg)?\b[\s,;-]*(.*)$/i);
  if (!match) return null;
  const doseMg = Number(match[1].replace(",", "."));
  if (!Number.isFinite(doseMg) || doseMg <= 0 || doseMg > 50) return null;
  return { doseMg, notes: match[2].trim() || null };
}

/** Grava a dose ligada à mensagem; devolve a resposta em HTML. */
export async function logDose(doseMg: number, notes: string | null, messageId: number): Promise<string> {
  const uid = await userId();
  const before = await recentDoses(uid, 1);
  await writer.query(
    `insert into dose_logs (id, user_id, taken_at, date, dose_mg, notes, telegram_message_id)
     values (gen_random_uuid(), $1, now(), ${TODAY}, $2, $3, $4)`,
    [uid, doseMg, notes, messageId],
  );
  const [last] = await recentDoses(uid, 1);
  const lines = [`✅ Dose registrada: <b>${mg(doseMg)}</b> · ${last.when}`];
  if (notes) lines.push(`<i>${escapeHtml(notes)}</i>`);
  if (before[0] && Number(before[0].dose_mg) !== doseMg) lines.push(`Antes: ${mg(before[0].dose_mg)}`);
  lines.push(`Próxima: <b>${br(nextDate(last.date))}</b>`);
  return lines.join("\n");
}

export async function undoDose(messageId: number): Promise<boolean> {
  const uid = await userId();
  const { rowCount } = await writer.query("delete from dose_logs where user_id = $1 and telegram_message_id = $2", [
    uid,
    messageId,
  ]);
  return (rowCount ?? 0) > 0;
}

/** /dose sem número: últimas doses e a próxima. */
export async function dosesSummary(): Promise<string> {
  const uid = await userId();
  const rows = await recentDoses(uid, 6);
  if (rows.length === 0) {
    return "Nenhuma dose registrada. Use <code>/dose 2,5</code> (e, se quiser, observações depois do número).";
  }
  const lines = ["<b>Doses</b>", ""];
  for (const r of rows) lines.push(`• ${r.when} — ${mg(r.dose_mg)}${r.notes ? ` · ${escapeHtml(r.notes)}` : ""}`);
  lines.push("", `Próxima: <b>${br(nextDate(rows[0].date))}</b>`);
  return lines.join("\n");
}

/** Lembrete do dia: só quando já passaram 7 dias ou mais da última dose e nada foi registrado hoje. */
export async function doseReminder(): Promise<string | null> {
  const uid = await userId();
  const { rows } = await reader.query<{ days: number }>(
    `select (${TODAY} - max(date))::int as days from dose_logs where user_id = $1 having count(*) > 0`,
    [uid],
  );
  const days = rows[0]?.days;
  if (days === undefined || days < INTERVAL_DAYS) return null;
  const late = days - INTERVAL_DAYS;
  return late === 0
    ? "⏰ Hoje é dia da dose semanal. Depois, é só mandar <code>/dose</code> com a quantidade."
    : `⏰ A dose semanal está atrasada ${late} ${late === 1 ? "dia" : "dias"}. Mande <code>/dose</code> quando tomar.`;
}
