import { config } from "./config.ts";

// Tiny wall-clock scheduler in the server's timezone. A 30s tick is plenty
// for minute-level jobs, and the "last fired" key keeps each job to one run
// per slot even though several ticks land inside the same minute.

type Job = {
  name: string;
  hour: number;
  minute: number;
  weekday?: number; // 0 = domingo … 6 = sábado; omit for every day
  run: () => Promise<void>;
};

const parts = new Intl.DateTimeFormat("en-CA", {
  timeZone: config.timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function now() {
  const p = Object.fromEntries(parts.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: WEEKDAYS.indexOf(p.weekday),
  };
}

export function parseTime(value: string): { hour: number; minute: number } {
  const [hour, minute] = value.split(":").map(Number);
  if (!(hour >= 0 && hour < 24 && minute >= 0 && minute < 60)) {
    throw new Error(`Horário inválido: ${value} (use HH:MM)`);
  }
  return { hour, minute };
}

export function startScheduler(jobs: Job[]) {
  const lastRun = new Map<string, string>();
  setInterval(() => {
    const t = now();
    for (const job of jobs) {
      if (job.hour !== t.hour || job.minute !== t.minute) continue;
      if (job.weekday !== undefined && job.weekday !== t.weekday) continue;
      if (lastRun.get(job.name) === t.date) continue;
      lastRun.set(job.name, t.date);
      job.run().catch((err) => console.error(`Job ${job.name} falhou:`, err));
    }
  }, 30_000);
  for (const job of jobs) {
    const day = job.weekday === undefined ? "todo dia" : WEEKDAYS[job.weekday];
    console.log(`Agendado: ${job.name} (${day} ${String(job.hour).padStart(2, "0")}:${String(job.minute).padStart(2, "0")})`);
  }
}
