import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import { containerLogs, containerName, listContainers } from "./docker.ts";
import { cpuPercent, disk, loadAverage, memory, uptimeSeconds } from "./host.ts";
import { bytes, dateTime, duration, escapeHtml, percent } from "./format.ts";

// Telegram rejects messages over 4096 chars; leave room for the HTML wrapper.
const MAX_LOG_CHARS = 3800;
// The backup timer runs daily at 03:00 (+ up to 10 min jitter).
const BACKUP_STALE_HOURS = 26;

export async function statusMessage(): Promise<string> {
  const [cpu, mem, dsk, load, uptime, containers] = await Promise.all([
    cpuPercent(),
    memory(),
    disk(),
    loadAverage(),
    uptimeSeconds(),
    listContainers(),
  ]);

  const lines = containers.map((c) => {
    const icon = c.State === "running" ? "🟢" : "🔴";
    return `${icon} <b>${escapeHtml(containerName(c))}</b> — ${escapeHtml(c.Status)}`;
  });

  return [
    "<b>🖥️ koala-server</b>",
    `CPU: ${cpu.toFixed(0)}% · load ${load}`,
    `RAM: ${bytes(mem.used)} / ${bytes(mem.total)} (${percent(mem.used, mem.total)})`,
    `Disco: ${bytes(dsk.used)} / ${bytes(dsk.total)} (${percent(dsk.used, dsk.total)})`,
    `Ligado há ${duration(uptime)}`,
    "",
    "<b>📦 Containers</b>",
    ...lines,
  ].join("\n");
}

export async function backupMessage(): Promise<string> {
  const files = (await readdir(config.backupsDir)).filter((f) => f.endsWith(".dump"));
  if (files.length === 0) return "⚠️ Nenhum backup encontrado no servidor.";

  // Files are named <database>_<YYYY-MM-DD_HHMM>.dump; keep the newest per database.
  const latest = new Map<string, { file: string; mtime: Date; size: number }>();
  for (const file of files) {
    const db = file.replace(/_\d{4}-\d{2}-\d{2}_\d{4}\.dump$/, "");
    const info = await stat(path.join(config.backupsDir, file));
    const current = latest.get(db);
    if (!current || info.mtime > current.mtime) {
      latest.set(db, { file, mtime: info.mtime, size: info.size });
    }
  }

  const lines = [...latest.entries()].map(([db, b]) => {
    const ageHours = (Date.now() - b.mtime.getTime()) / 3_600_000;
    const icon = ageHours > BACKUP_STALE_HOURS ? "⚠️" : "✅";
    return `${icon} <b>${escapeHtml(db)}</b> — ${dateTime(b.mtime)} (há ${duration(ageHours * 3600)}), ${bytes(b.size)}`;
  });

  return [
    "<b>💾 Último backup por banco</b>",
    ...lines,
    "",
    `${files.length} arquivo(s) locais · cópia diária no Google Drive às 3h`,
  ].join("\n");
}

export async function logsMessage(name: string, tail: number): Promise<string> {
  let logs = (await containerLogs(name, tail)).trim();
  if (!logs) return `📄 <b>${escapeHtml(name)}</b> não tem logs recentes.`;
  if (logs.length > MAX_LOG_CHARS) logs = "…" + logs.slice(-MAX_LOG_CHARS);
  return `📄 <b>${escapeHtml(name)}</b> (últimas ${tail} linhas)\n<pre>${escapeHtml(logs)}</pre>`;
}
