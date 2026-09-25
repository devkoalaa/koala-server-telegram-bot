import pg from "pg";
import { config } from "./config.ts";
import { escapeHtml } from "./format.ts";

// Read-only access to the koala-fit database (role "telegram_bot" only has
// SELECT). The app is single-user today, so everything targets its only user.

const pool = new pg.Pool({ connectionString: config.koalaFitDatabaseUrl, max: 2 });

const WEEKDAY_CODES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAY_PT = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

// Calendar dates are computed in SQL in America/Sao_Paulo, the same way the
// app stores workouts.date.
const TODAY = `(now() at time zone 'America/Sao_Paulo')::date`;
// Monday of the current week (the app's weeks start on Monday).
const WEEK_START = `date_trunc('week', ${TODAY})::date`;

export async function koalaFitUser() {
  const { rows } = await pool.query<{ id: string; name: string | null; weekly_goal: number }>(
    "select id, name, weekly_goal from users order by created_at limit 1",
  );
  if (!rows[0]) throw new Error("Nenhum usuário no koala-fit");
  return rows[0];
}

/** Message for today's reminder, or null when today isn't a training day or it's already logged. */
export async function trainingReminder(): Promise<string | null> {
  const u = await koalaFitUser();
  const { rows } = await pool.query<{ dow: number; scheduled: boolean; done: boolean; streak: number | null }>(
    `with today as (select ${TODAY} as d)
     select extract(dow from d)::int as dow,
            exists(select 1 from training_schedule
                   where user_id = $1
                     and weekday::text = ($2::text[])[extract(dow from d)::int + 1]) as scheduled,
            exists(select 1 from workouts where user_id = $1 and date = d) as done,
            (select current_streak from streak_state where user_id = $1) as streak
       from today`,
    [u.id, WEEKDAY_CODES],
  );
  const r = rows[0];
  if (!r.scheduled || r.done) return null;

  const streak = r.streak ?? 0;
  return [
    `🏋️ <b>Hoje (${WEEKDAY_PT[r.dow]}) é dia de treino</b> e ainda não tem nada registrado.`,
    streak > 0
      ? `Sua sequência está em <b>${streak}</b> — não deixa ela cair! 🔥`
      : "Bora começar uma sequência nova hoje? 💪",
    "",
    '<a href="https://fit.devkoala.xyz">Abrir o Koala Fit</a>',
  ].join("\n");
}

export async function weeklySummary(): Promise<string> {
  const u = await koalaFitUser();
  const params = [u.id];

  const [workouts, volume, cardio, topExercises, weight, streak] = await Promise.all([
    pool.query<{ count: number; minutes: number | null }>(
      `select count(*)::int as count, sum(duration_minutes)::int as minutes
         from workouts where user_id = $1 and date >= ${WEEK_START}`,
      params,
    ),
    pool.query<{ sets: number; volume: string | null }>(
      `select count(*)::int as sets, sum(s.reps * s.weight_kg) as volume
         from sets s join workouts w on w.id = s.workout_id
        where w.user_id = $1 and w.date >= ${WEEK_START}`,
      params,
    ),
    pool.query<{ seconds: number | null; meters: string | null }>(
      `select sum(c.duration_seconds)::int as seconds, sum(c.distance_meters) as meters
         from cardio_sessions c join workouts w on w.id = c.workout_id
        where w.user_id = $1 and w.date >= ${WEEK_START}`,
      params,
    ),
    pool.query<{ name: string; volume: string }>(
      `select e.name, sum(s.reps * s.weight_kg) as volume
         from sets s join workouts w on w.id = s.workout_id join exercises e on e.id = s.exercise_id
        where w.user_id = $1 and w.date >= ${WEEK_START}
        group by e.name having sum(s.reps * s.weight_kg) > 0
        order by volume desc limit 3`,
      params,
    ),
    // "current" only counts if weighed this week; otherwise there's no change to report.
    pool.query<{ current: string | null; previous: string | null; latest: string | null }>(
      `select (select weight_kg from body_weight_logs where user_id = $1 and date >= ${WEEK_START}
                order by date desc limit 1) as current,
              (select weight_kg from body_weight_logs where user_id = $1 and date < ${WEEK_START}
                order by date desc limit 1) as previous,
              (select weight_kg from body_weight_logs where user_id = $1
                order by date desc limit 1) as latest`,
      params,
    ),
    pool.query<{ current_streak: number; longest_streak: number }>(
      "select current_streak, longest_streak from streak_state where user_id = $1",
      params,
    ),
  ]);

  const w = workouts.rows[0];
  const goalIcon = w.count >= u.weekly_goal ? "🎯" : "📉";
  const lines = [
    `<b>📊 Resumo da semana${u.name ? `, ${escapeHtml(u.name)}` : ""}</b>`,
    "",
    `${goalIcon} Treinos: <b>${w.count}</b> de ${u.weekly_goal} da meta` +
      (w.minutes ? ` · ${w.minutes} min no total` : ""),
  ];

  const v = volume.rows[0];
  if (v.sets > 0) {
    lines.push(`🏋️ ${v.sets} séries · ${Math.round(Number(v.volume ?? 0)).toLocaleString("pt-BR")} kg de volume`);
  }
  if (topExercises.rows.length > 0) {
    lines.push(
      "   Mais volume: " +
        topExercises.rows
          .map((e) => `${escapeHtml(e.name)} (${Math.round(Number(e.volume)).toLocaleString("pt-BR")} kg)`)
          .join(", "),
    );
  }

  const c = cardio.rows[0];
  if (c.seconds) {
    const km = Number(c.meters ?? 0) / 1000;
    lines.push(`🏃 Cardio: ${Math.round(c.seconds / 60)} min` + (km > 0 ? ` · ${km.toFixed(1)} km` : ""));
  }

  const wt = weight.rows[0];
  if (wt.current) {
    const diff = wt.previous ? Number(wt.current) - Number(wt.previous) : null;
    const diffText = diff === null ? "" : ` (${diff > 0 ? "+" : ""}${diff.toFixed(1)} kg na semana)`;
    lines.push(`⚖️ Peso: ${Number(wt.current).toFixed(1)} kg${diffText}`);
  } else if (wt.latest) {
    lines.push(`⚖️ Peso: ${Number(wt.latest).toFixed(1)} kg (sem pesagem nesta semana)`);
  }

  const s = streak.rows[0];
  if (s) lines.push(`🔥 Sequência: ${s.current_streak} (recorde ${s.longest_streak})`);

  if (w.count === 0) lines.push("", "Semana sem treinos registrados — a próxima é uma nova chance. 💪");

  return lines.join("\n");
}
