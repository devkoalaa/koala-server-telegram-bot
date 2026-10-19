import https from "node:https";
import type { TLSSocket } from "node:tls";
import { config } from "./config.ts";
import { dateTime, duration, escapeHtml } from "./format.ts";

// External checks of the public sites, the way a visitor sees them (DNS →
// Caddy → TLS → app). Replaces Uptime Kuma. A site is only reported down after
// FAILS_BEFORE_ALERT consecutive failures, so a deploy or a slow response
// doesn't page anyone; recovery is reported with how long it was out.

const TIMEOUT_MS = 15_000;
const FAILS_BEFORE_ALERT = 3;
const CERT_WARN_DAYS = 14;
const MAX_BODY_BYTES = 512 * 1024;

type Probe = { status: number; body: string; certExpiry?: Date };

type Site = {
  name: string;
  url: string;
  /** WebSocket endpoint: success is the 101 upgrade. */
  websocket?: boolean;
  /** Extra check on a 2xx/3xx response; return an error message or null. */
  check?: (probe: Probe) => string | null;
};

const jsonField = (field: string) => (p: Probe) => {
  try {
    return JSON.parse(p.body)[field] === true ? null : `"${field}" não está true`;
  } catch {
    return "resposta não é JSON";
  }
};

const SITES: Site[] = [
  { name: "Koala Fit", url: "https://fit.devkoala.com/login" },
  { name: "Wallet", url: "https://wallet.devkoala.com/healthz" },
  { name: "Portfólio", url: "https://devkoala.com/", check: (p) => (p.body.includes("Herbert") ? null : "página sem o conteúdo esperado") },
  { name: "Favela League", url: "https://favelaleague.devkoala.com/" },
  { name: "Rádio — transmissão", url: "https://radio.devkoala.com/api/nowplaying/koala", check: jsonField("is_online") },
  { name: "Rádio — estúdio", url: "https://radio.devkoala.com/studio-api/health", check: jsonField("ok") },
  { name: "Relay do Automotiva", url: "https://relay-automotiva.devkoala.com/ws", websocket: true },
];

type State = {
  failures: number;
  alerted: boolean;
  downSince?: Date;
  lastError?: string;
  lastMs?: number;
  certExpiry?: Date;
  certWarnedOn?: string;
};

const states = new Map<string, State>(SITES.map((s) => [s.name, { failures: 0, alerted: false }]));

function certOf(socket: unknown): Date | undefined {
  const validTo = (socket as TLSSocket).getPeerCertificate?.()?.valid_to;
  return validTo ? new Date(validTo) : undefined;
}

function probe(site: Site): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "user-agent": "koala-server-bot/health" };
    if (site.websocket) {
      Object.assign(headers, {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64"),
      });
    }
    const req = https.request(site.url, { headers, timeout: TIMEOUT_MS }, (res) => {
      const certExpiry = certOf(res.socket);
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > MAX_BODY_BYTES) res.destroy();
      });
      res.on("close", () => resolve({ status: res.statusCode ?? 0, body, certExpiry }));
    });
    req.on("upgrade", (res, socket) => {
      const certExpiry = certOf(socket);
      socket.destroy();
      resolve({ status: res.statusCode ?? 101, body: "", certExpiry });
    });
    req.on("timeout", () => req.destroy(new Error(`sem resposta em ${TIMEOUT_MS / 1000}s`)));
    req.on("error", reject);
    req.end();
  });
}

async function checkSite(site: Site): Promise<{ error: string | null; ms: number; certExpiry?: Date }> {
  const started = Date.now();
  try {
    const p = await probe(site);
    const ms = Date.now() - started;
    if (site.websocket && p.status !== 101) return { error: `WebSocket recusado (HTTP ${p.status})`, ms, certExpiry: p.certExpiry };
    if (!site.websocket && p.status >= 400) return { error: `HTTP ${p.status}`, ms, certExpiry: p.certExpiry };
    return { error: site.check?.(p) ?? null, ms, certExpiry: p.certExpiry };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message, ms: Date.now() - started };
  }
}

type Send = (html: string) => Promise<void>;

async function runChecks(send: Send) {
  const today = new Date().toISOString().slice(0, 10);
  await Promise.all(
    SITES.map(async (site) => {
      const state = states.get(site.name)!;
      const { error, ms, certExpiry } = await checkSite(site);
      state.lastMs = ms;
      if (certExpiry) state.certExpiry = certExpiry;

      if (error) {
        state.failures++;
        state.lastError = error;
        state.downSince ??= new Date();
        if (state.failures >= FAILS_BEFORE_ALERT && !state.alerted) {
          state.alerted = true;
          await send(
            `🔴 <b>${escapeHtml(site.name)}</b> fora do ar\n${escapeHtml(error)}\n` +
              `Desde ${dateTime(state.downSince)} · ${escapeHtml(site.url)}`,
          );
        }
      } else {
        if (state.alerted) {
          const out = (Date.now() - state.downSince!.getTime()) / 1000;
          await send(`✅ <b>${escapeHtml(site.name)}</b> voltou — ficou fora ${duration(out)}`);
        }
        Object.assign(state, { failures: 0, alerted: false, downSince: undefined, lastError: undefined });
      }

      if (state.certExpiry && state.certWarnedOn !== today) {
        const days = Math.floor((state.certExpiry.getTime() - Date.now()) / 86_400_000);
        if (days < CERT_WARN_DAYS) {
          state.certWarnedOn = today;
          await send(`⚠️ Certificado de <b>${escapeHtml(site.name)}</b> vence em ${days} dia(s) (${dateTime(state.certExpiry)}). A renovação automática deveria ter feito isso.`);
        }
      }
    }),
  );
}

export function startSiteChecks(send: Send) {
  const tick = () => runChecks(send).catch((err) => console.error("Verificação dos sites falhou:", err));
  setTimeout(tick, 20_000);
  setInterval(tick, config.siteCheckIntervalSeconds * 1000);
  console.log(`Verificando ${SITES.length} sites a cada ${config.siteCheckIntervalSeconds}s`);
}

/** Lines for /status. */
export function sitesStatusLines(): string[] {
  return SITES.map((site) => {
    const s = states.get(site.name)!;
    const name = escapeHtml(site.name);
    if (s.lastMs === undefined) return `⚪ <b>${name}</b> — ainda não verificado`;
    if (s.failures === 0) return `🟢 <b>${name}</b> — ${s.lastMs} ms`;
    const icon = s.alerted ? "🔴" : "🟡";
    const since = s.downSince ? ` desde ${dateTime(s.downSince)}` : "";
    return `${icon} <b>${name}</b> — ${escapeHtml(s.lastError ?? "falha")}${since}`;
  });
}
