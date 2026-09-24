import { readFile, statfs } from "node:fs/promises";
import { config } from "./config.ts";

// /proc inside a container still reports host-wide load, memory and CPU
// counters, so no extra host mounts are needed for these.

async function cpuTimes(): Promise<{ idle: number; total: number }> {
  const line = (await readFile("/proc/stat", "utf8")).split("\n")[0];
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = values[3] + (values[4] ?? 0);
  return { idle, total: values.reduce((sum, v) => sum + v, 0) };
}

export async function cpuPercent(sampleMs = 500): Promise<number> {
  const a = await cpuTimes();
  await new Promise((r) => setTimeout(r, sampleMs));
  const b = await cpuTimes();
  const total = b.total - a.total;
  return total === 0 ? 0 : (100 * (total - (b.idle - a.idle))) / total;
}

export async function memory(): Promise<{ used: number; total: number }> {
  const info = await readFile("/proc/meminfo", "utf8");
  const kb = (key: string) => Number(info.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? 0) * 1024;
  const total = kb("MemTotal");
  return { used: total - kb("MemAvailable"), total };
}

export async function disk(): Promise<{ used: number; total: number }> {
  const s = await statfs(config.backupsDir);
  const total = s.blocks * s.bsize;
  return { used: total - s.bfree * s.bsize, total };
}

export async function loadAverage(): Promise<string> {
  return (await readFile("/proc/loadavg", "utf8")).split(" ").slice(0, 3).join(" ");
}

export async function uptimeSeconds(): Promise<number> {
  return Number((await readFile("/proc/uptime", "utf8")).split(" ")[0]);
}
