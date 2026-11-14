import pg from "pg";
import { config } from "./config.ts";
import { escapeHtml } from "./format.ts";

// CS2 Recap (cs2recap.com): números de uso para o /cs2. Lê o banco cs2_smokes com o
// usuário telegram_bot, que só enxerga algumas colunas (datas, contagens e nomes;
// nada de códigos da Steam nem do Discord). Entrada = quando ganhou acesso às partidas
// (as contas antigas têm o cadastro da época do site só de smokes).

const pool = config.cs2RecapDatabaseUrl ? new pg.Pool({ connectionString: config.cs2RecapDatabaseUrl, max: 2 }) : null;

const umami = config.umamiDatabaseUrl ? new pg.Pool({ connectionString: config.umamiDatabaseUrl, max: 1 }) : null;

export const cs2RecapAtivo = () => pool !== null;

// Visitas (Umami): pessoas = sessões anônimas distintas; event_type 1 = página vista.
const VISITAS = `
  select
    count(distinct session_id) filter (where created_at >= now() - interval '1 day')::int as pessoas_dia,
    count(*) filter (where created_at >= now() - interval '1 day')::int as paginas_dia,
    count(distinct session_id)::int as pessoas_semana,
    count(*)::int as paginas_semana
  from website_event where hostname = 'cs2recap.com' and event_type = 1 and created_at >= now() - interval '7 days'`;
const ORIGENS = `
  select coalesce(nullif(referrer_domain, ''), 'direto') as origem, count(distinct session_id)::int as pessoas
  from website_event where hostname = 'cs2recap.com' and event_type = 1 and created_at >= now() - interval '7 days'
    and coalesce(referrer_domain, '') not in ('cs2recap.com', 'www.cs2recap.com')
  group by 1 order by 2 desc limit 5`;

async function visitasLinhas(): Promise<string[]> {
  if (!umami) return [];
  try {
    const [{ rows: [v] }, { rows: origens }] = await Promise.all([
      umami.query<{ pessoas_dia: number; paginas_dia: number; pessoas_semana: number; paginas_semana: number }>(VISITAS),
      umami.query<{ origem: string; pessoas: number }>(ORIGENS),
    ]);
    return [
      `👀 Visitas: <b>${v.pessoas_dia}</b> pessoas (${v.paginas_dia} páginas) em 24 h · <b>${v.pessoas_semana}</b> (${v.paginas_semana}) em 7 dias`,
      ...(origens.length ? [`↗️ Vieram de: ${origens.map((o) => `${escapeHtml(o.origem)} ${o.pessoas}`).join(" · ")}`] : []),
    ];
  } catch {
    return ["👀 Visitas: Umami indisponível"];
  }
}

type Resumo = {
  usuarios: number; novos_dia: number; novos_semana: number; novos_mes: number;
  vistos_dia: number; vistos_semana: number; primeiro_visto: Date | null; jogaram_semana: number;
  importando: number; importacao_erro: number;
  partidas: number; jogadas_semana: number; na_fila: number; falharam: number;
  grupos: number; em_grupo: number; discord: number; chat_steam: number; chat_enviados: number;
  coletor: Date | null; chat_bot: Date | null;
};

const RESUMO = `
  select
    (select count(*) from users)::int as usuarios,
    (select count(*) from users where coalesce("accessGrantedAt", "createdAt") >= now() - interval '1 day')::int as novos_dia,
    (select count(*) from users where coalesce("accessGrantedAt", "createdAt") >= now() - interval '7 days')::int as novos_semana,
    (select count(*) from users where coalesce("accessGrantedAt", "createdAt") >= now() - interval '30 days')::int as novos_mes,
    (select count(*) from users where "lastSeenAt" >= now() - interval '1 day')::int as vistos_dia,
    (select count(*) from users where "lastSeenAt" >= now() - interval '7 days')::int as vistos_semana,
    (select min("lastSeenAt") from users) as primeiro_visto,
    (select count(distinct u.id) from users u join match_players p on p."steamId" = u."steamId"
       join tracked_matches m on m.id = p."matchId" where m.status = 'READY' and m."playedAt" >= now() - interval '7 days')::int as jogaram_semana,
    (select count(*) from match_tracking where enabled)::int as importando,
    (select count(*) from match_tracking where enabled and "lastError" is not null)::int as importacao_erro,
    (select count(*) from tracked_matches where status = 'READY')::int as partidas,
    (select count(*) from tracked_matches where status = 'READY' and "playedAt" >= now() - interval '7 days')::int as jogadas_semana,
    (select count(*) from tracked_matches where status in ('PENDING', 'PROCESSING'))::int as na_fila,
    (select count(*) from tracked_matches where status = 'FAILED')::int as falharam,
    (select count(*) from groups)::int as grupos,
    (select count(distinct "userId") from group_members)::int as em_grupo,
    (select count(*) from users where "discordId" is not null)::int as discord,
    (select count(*) from users where "steamBotFriendAt" is not null)::int as chat_steam,
    (select count(*) from steam_chat_messages where status = 'SENT')::int as chat_enviados,
    (select "heartbeatAt" from tracking_worker where id = 'collector') as coletor,
    (select "heartbeatAt" from tracking_worker where id = 'steam-chat') as chat_bot`;

const dia = (d: Date) => d.toLocaleDateString("pt-BR", { timeZone: config.timeZone, day: "2-digit", month: "2-digit" });
const online = (d: Date | null) => (d && Date.now() - d.getTime() < 2 * 60_000 ? "🟢" : "🔴");

export async function cs2RecapMessage(): Promise<string> {
  if (!pool) return "🎯 <b>CS2 Recap</b>: falta CS2_RECAP_DATABASE_URL no .env do bot.";
  const [{ rows: [r] }, { rows: ultimos }, visitas] = await Promise.all([
    pool.query<Resumo>(RESUMO),
    pool.query<{ username: string; createdAt: Date; lastSeenAt: Date | null }>(
      `select username, coalesce("accessGrantedAt", "createdAt") as "createdAt", "lastSeenAt" from users order by 2 desc limit 5`),
    visitasLinhas(),
  ]);
  const desde = r.primeiro_visto ? ` <i>(contando desde ${dia(r.primeiro_visto)})</i>` : "";
  return [
    `🎯 <b>CS2 Recap</b> — cs2recap.com`,
    "",
    ...visitas,
    `👥 <b>${r.usuarios}</b> contas · +${r.novos_dia} hoje · +${r.novos_semana} na semana · +${r.novos_mes} no mês`,
    `🟢 Abriram o site: <b>${r.vistos_dia}</b> em 24 h · <b>${r.vistos_semana}</b> em 7 dias${desde}`,
    `🎮 Jogaram (partida importada): <b>${r.jogaram_semana}</b> em 7 dias`,
    `📥 Importação ligada: <b>${r.importando}</b>${r.importacao_erro ? ` · ⚠️ ${r.importacao_erro} com erro` : ""}`,
    `🏆 Partidas: <b>${r.partidas}</b> importadas · ${r.jogadas_semana} na semana` +
      (r.na_fila ? ` · ${r.na_fila} na fila` : "") + (r.falharam ? ` · ${r.falharam} falharam` : ""),
    `👪 Grupos: <b>${r.grupos}</b> · ${r.em_grupo} pessoas em algum grupo`,
    `🔗 Discord: <b>${r.discord}</b> vinculados · chat da Steam: <b>${r.chat_steam}</b> (${r.chat_enviados} resumos enviados)`,
    `${online(r.coletor)} Coletor · ${online(r.chat_bot)} Bot do chat da Steam`,
    "",
    "🆕 <b>Últimos cadastros</b>",
    ...ultimos.map((u) => `• ${escapeHtml(u.username)} — ${dia(u.createdAt)}${u.lastSeenAt ? ` · visto ${dia(u.lastSeenAt)}` : ""}`),
  ].join("\n");
}
