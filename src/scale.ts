import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { runOnHost } from "./claude.ts";
import { config } from "./config.ts";
import { koalaFitUser } from "./fitness.ts";
import { escapeHtml } from "./format.ts";

// Scale reports: the owner forwards the bioimpedance report (a screenshot of
// the OKOK app, in Chinese) and the bot saves it to scaleReportsDir. Claude
// reads it through ~/bin/claude-scale — whose prompt, tool (Read on that one
// file) and JSON schema are fixed on the host — and the bot validates the
// numbers and shows them with Save/Discard buttons. Only on Save does the
// writer role insert into koala-fit's body_composition_logs (and today's
// body_weight_logs). Claude itself never touches the database.

type FieldKey =
  | "weight_kg" | "bmi" | "body_fat_pct" | "fat_mass_kg" | "lean_mass_kg" | "muscle_mass_kg"
  | "muscle_pct" | "skeletal_muscle_kg" | "skeletal_muscle_pct" | "bone_mass_kg" | "water_pct"
  | "water_kg" | "protein_pct" | "visceral_fat" | "bmr_kcal" | "body_age" | "score";

type Field = { key: FieldKey; label: string; unit: string; min: number; max: number; integer?: boolean };

// Order = order in the confirmation message. min/max reject misreads (a
// dropped decimal point, a delta read as the value) rather than judge health.
const FIELDS: Field[] = [
  { key: "weight_kg", label: "Peso", unit: "kg", min: 20, max: 300 },
  { key: "bmi", label: "IMC", unit: "", min: 10, max: 80 },
  { key: "body_fat_pct", label: "Gordura corporal", unit: "%", min: 2, max: 75 },
  { key: "fat_mass_kg", label: "Massa de gordura", unit: "kg", min: 1, max: 200 },
  { key: "lean_mass_kg", label: "Massa magra", unit: "kg", min: 10, max: 200 },
  { key: "muscle_mass_kg", label: "Massa muscular", unit: "kg", min: 10, max: 200 },
  { key: "muscle_pct", label: "Músculo", unit: "%", min: 10, max: 95 },
  { key: "skeletal_muscle_kg", label: "Músculo esquelético", unit: "kg", min: 5, max: 120 },
  { key: "skeletal_muscle_pct", label: "Músculo esquelético", unit: "%", min: 5, max: 80 },
  { key: "bone_mass_kg", label: "Massa óssea", unit: "kg", min: 0.5, max: 10 },
  { key: "water_pct", label: "Água", unit: "%", min: 20, max: 80 },
  { key: "water_kg", label: "Água", unit: "kg", min: 5, max: 150 },
  { key: "protein_pct", label: "Proteína", unit: "%", min: 3, max: 40 },
  { key: "visceral_fat", label: "Gordura visceral", unit: "", min: 1, max: 60 },
  { key: "bmr_kcal", label: "Metabolismo basal", unit: "kcal", min: 500, max: 5000, integer: true },
  { key: "body_age", label: "Idade corporal", unit: "anos", min: 5, max: 120, integer: true },
  { key: "score", label: "Nota da balança", unit: "/100", min: 0, max: 100, integer: true },
];

export type ScaleReport = {
  /** Local São Paulo time as printed on the report, YYYY-MM-DDTHH:MM:SS. */
  measuredAt: string | null;
  values: Partial<Record<FieldKey, number>>;
  warnings: string[];
};

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

let running = false;
// Extracted reports waiting for Save/Discard, by report id (the file name
// without extension). In memory only: after a restart the image is still on
// disk, but the owner has to send it again.
const pending = new Map<string, ScaleReport>();

export function scaleBusy(): boolean {
  return running;
}

/** Downloads the image and saves it as <local date>_<time>_<messageId>.<ext>; returns the report id. */
export async function saveReportImage(url: string, filePath: string, messageId: number): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download da imagem falhou (HTTP ${res.status})`);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const stamp = new Date()
    .toLocaleString("sv-SE", { timeZone: config.timeZone })
    .replace(" ", "_")
    .replaceAll(":", "");
  const id = `${stamp}_${messageId}`;
  await mkdir(config.scaleReportsDir, { recursive: true });
  await writeFile(
    path.join(config.scaleReportsDir, `${id}.${IMAGE_EXTENSIONS.has(ext) ? ext : "jpg"}`),
    Buffer.from(await res.arrayBuffer()),
  );
  return id;
}

/** Runs Claude on the saved image and keeps the validated result pending confirmation. */
export async function extractReport(id: string): Promise<ScaleReport> {
  const file = (await readdir(config.scaleReportsDir)).find((f) => f.startsWith(`${id}.`));
  if (!file) throw new Error("Imagem não encontrada");

  running = true;
  let raw: unknown;
  try {
    raw = JSON.parse(await runOnHost(config.scaleSshKey, file));
  } finally {
    running = false;
  }
  const report = validate(raw);
  pending.set(id, report);
  return report;
}

function validate(raw: unknown): ScaleReport {
  if (typeof raw !== "object" || raw === null) throw new Error("Resposta do Claude em formato inesperado");
  const data = raw as Record<string, unknown>;
  if (data.is_scale_report !== true) throw new Error("Não parece um relatório da balança");

  const values: ScaleReport["values"] = {};
  const warnings: string[] = [];
  for (const f of FIELDS) {
    const v = data[f.key];
    if (v === null || v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < f.min || v > f.max) {
      warnings.push(`${f.label} (${f.unit || "valor"}) ignorado: ${escapeHtml(String(v))} fora da faixa esperada`);
      continue;
    }
    values[f.key] = f.integer ? Math.round(v) : v;
  }
  if (values.weight_kg === undefined) throw new Error("Não consegui ler o peso no relatório");

  // Cross-checks: fat mass should match weight × fat %, and lean = weight − fat.
  const { weight_kg: w, body_fat_pct: pct, fat_mass_kg: fat, lean_mass_kg: lean } = values;
  if (pct !== undefined && fat !== undefined && Math.abs((w * pct) / 100 - fat) > 1.5) {
    warnings.push("Massa de gordura não bate com peso × gordura %: confira os valores");
  }
  if (fat !== undefined && lean !== undefined && Math.abs(w - fat - lean) > 1.5) {
    warnings.push("Massa magra + gordura não somam o peso: confira os valores");
  }

  let measuredAt: string | null = null;
  if (typeof data.measured_at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(data.measured_at)) {
    measuredAt = data.measured_at;
  } else {
    warnings.push("Data da medição não encontrada: vou usar a hora atual");
  }
  return { measuredAt, values, warnings };
}

function formatValue(f: Field, v: number): string {
  const text = v.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  if (f.unit === "/100" || f.unit === "%") return `${text}${f.unit}`;
  return f.unit ? `${text} ${f.unit}` : text;
}

export function reportMessage(report: ScaleReport, fromPhoto: boolean): string {
  const when = report.measuredAt
    ? new Date(`${report.measuredAt}Z`).toLocaleString("pt-BR", { timeZone: "UTC", dateStyle: "short", timeStyle: "short" })
    : "agora";
  const lines = [`<b>⚖️ Relatório da balança — ${when}</b>`, ""];
  for (const f of FIELDS) {
    const v = report.values[f.key];
    if (v !== undefined) lines.push(`${escapeHtml(f.label)}: <b>${formatValue(f, v)}</b>`);
  }
  const missing = FIELDS.filter((f) => report.values[f.key] === undefined).length;
  if (report.warnings.length > 0) lines.push("", ...report.warnings.map((w) => `⚠️ ${w}`));
  if (fromPhoto && missing > 0) {
    lines.push("", "💡 O Telegram reduz fotos. Se faltou algo, reenvie o print como <i>arquivo</i>.");
  }
  lines.push("", "Salvar no Koala Fit?");
  return lines.join("\n");
}

const writer = new pg.Pool({ connectionString: config.koalaFitWriterDatabaseUrl, max: 1 });

const COLUMNS: Record<FieldKey, string> = {
  weight_kg: "weight_kg", bmi: "bmi", body_fat_pct: "body_fat_pct", fat_mass_kg: "fat_mass_kg",
  lean_mass_kg: "lean_mass_kg", muscle_mass_kg: "muscle_mass_kg", muscle_pct: "muscle_pct",
  skeletal_muscle_kg: "skeletal_muscle_kg", skeletal_muscle_pct: "skeletal_muscle_pct",
  bone_mass_kg: "bone_mass_kg", water_pct: "water_pct", water_kg: "water_kg", protein_pct: "protein_pct",
  visceral_fat: "visceral_fat", bmr_kcal: "bmr_kcal", body_age: "body_age", score: "score",
};

/** Writes a pending report; returns false if it's no longer pending (restart or already handled). */
export async function savePendingReport(id: string): Promise<boolean> {
  const report = pending.get(id);
  if (!report) return false;
  const u = await koalaFitUser();

  const cols = FIELDS.map((f) => COLUMNS[f.key]);
  const values = FIELDS.map((f) => report.values[f.key] ?? null);
  // $1 user, $2 local measured_at (or null → now), $3… metric values.
  const localTs = `coalesce($2::timestamp, (now() at time zone '${config.timeZone}')::timestamp(0))`;
  const client = await writer.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into body_composition_logs (id, user_id, measured_at, date, ${cols.join(", ")}, source)
       values (gen_random_uuid(), $1, ${localTs} at time zone '${config.timeZone}', ${localTs}::date,
               ${cols.map((_, i) => `$${i + 3}`).join(", ")}, 'okok')
       on conflict (user_id, measured_at) do update
         set ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}`,
      [u.id, report.measuredAt, ...values],
    );
    // Same one-per-day upsert the app does when weight is logged by hand.
    await client.query(
      `insert into body_weight_logs (id, user_id, date, weight_kg)
       values (gen_random_uuid(), $1, ${localTs}::date, $3)
       on conflict (user_id, date) do update set weight_kg = excluded.weight_kg`,
      [u.id, report.measuredAt, report.values.weight_kg],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
  pending.delete(id);
  return true;
}

export function discardPendingReport(id: string): void {
  pending.delete(id);
}

/** Deletes report images older than the retention period. */
export async function pruneReportImages(): Promise<number> {
  const cutoff = Date.now() - config.scaleReportsRetentionDays * 86_400_000;
  let removed = 0;
  let files: string[];
  try {
    files = await readdir(config.scaleReportsDir);
  } catch {
    return 0;
  }
  for (const file of files) {
    const full = path.join(config.scaleReportsDir, file);
    if ((await stat(full)).mtimeMs < cutoff) {
      await unlink(full);
      removed++;
    }
  }
  return removed;
}
