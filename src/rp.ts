import { config } from "./config.ts";
import { escapeHtml } from "./format.ts";

// Koala RP Lab (FiveM de laboratório, repo koala-rp-lab). O FXServer responde
// info.json e players.json pela rede interna "db". Os avisos de entrada e saída
// vêm do próprio jogo (koala-core) pelo /notify.

type Info = { server: string; resources: string[]; vars: Record<string, string> };
type JogadorFx = { id: number; name: string; ping: number };

async function buscar<T>(caminho: string): Promise<T> {
  const resp = await fetch(config.rpLabUrl + caminho, { signal: AbortSignal.timeout(5_000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as T;
}

export async function rpMessage(): Promise<string> {
  let info: Info;
  let jogadores: JogadorFx[];
  try {
    [info, jogadores] = await Promise.all([buscar<Info>("/info.json"), buscar<JogadorFx[]>("/players.json")]);
  } catch (err) {
    return `🎮 <b>Koala RP Lab</b>: fora do ar (${escapeHtml(err instanceof Error ? err.message : String(err))})`;
  }
  const build = /v1\.0\.0\.(\d+)/.exec(info.server)?.[1] ?? info.server;
  const linhas = [`🎮 <b>Koala RP Lab</b> — ${jogadores.length}/${info.vars.sv_maxClients ?? "?"} online`];
  for (const j of [...jogadores].sort((a, b) => a.id - b.id)) {
    linhas.push(`• ${escapeHtml(j.name)} <i>(id ${j.id}, ${j.ping} ms)</i>`);
  }
  linhas.push(
    "",
    `Versão <code>${escapeHtml((info.vars.koala_commit ?? "?").slice(0, 7))}</code> · FXServer ${escapeHtml(build)} · ${info.resources.length} resources`,
    "<code>connect koala-rp-lab.devkoala.com:30120</code>",
  );
  return linhas.join("\n");
}
