function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variável de ambiente ${name} não definida`);
  return value;
}

export const config = {
  botToken: required("BOT_TOKEN"),
  // Only this chat may talk to the bot; every other update is dropped.
  allowedChatId: Number(required("ALLOWED_CHAT_ID")),
  dockerSocket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
  // Host's ~/backups/local, mounted read-only. It lives on the host's root
  // filesystem, so statfs() on it also reports the root disk usage.
  backupsDir: process.env.BACKUPS_DIR ?? "/backups",
  timeZone: process.env.TZ ?? "America/Sao_Paulo",
  // Read-only role on the koala-fit database (training reminder + weekly summary).
  koalaFitDatabaseUrl: required("KOALA_FIT_DATABASE_URL"),
  notifyPort: Number(process.env.NOTIFY_PORT ?? 8081),
  // Public sites checked from outside (see src/sites.ts).
  siteCheckIntervalSeconds: Number(process.env.SITE_CHECK_INTERVAL_SECONDS ?? 60),
  // /claude: SSH into the host with a key restricted to a read-only wrapper.
  claudeSshHost: process.env.CLAUDE_SSH_HOST ?? "host.docker.internal",
  claudeSshKey: process.env.CLAUDE_SSH_KEY ?? "/ssh/id_ed25519",
  // Scale reports: images are saved here (host's
  // ~/apps/koala-server-telegram-bot/scale-reports) and read by Claude through
  // a second key pinned to ~/bin/claude-scale.
  scaleReportsDir: process.env.SCALE_REPORTS_DIR ?? "/scale-reports",
  scaleSshKey: process.env.SCALE_SSH_KEY ?? "/ssh/id_ed25519_scale",
  scaleReportsRetentionDays: Number(process.env.SCALE_REPORTS_RETENTION_DAYS ?? 30),
  // Role that may only write body_composition_logs, body_weight_logs and
  // food_logs (diário alimentar).
  koalaFitWriterDatabaseUrl: required("KOALA_FIT_WRITER_DATABASE_URL"),
  // Diário alimentar (src/food.ts): chave da API do Claude. Sem ela, texto
  // solto é ignorado e toda imagem vai para o relatório da balança, como antes.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  foodModel: process.env.FOOD_MODEL ?? "claude-opus-5-5",
  // Garagem (fundo da troca de carro): API interna e chave do bot. Sem a
  // chave, os comandos do Garagem só avisam que não estão configurados.
  garagemUrl: process.env.GARAGEM_URL ?? "http://garagem:3003",
  garagemBotChave: process.env.GARAGEM_BOT_CHAVE ?? "",
  // Sextas: lembrete quando a semana do fundo ainda não fechou.
  garagemReminderTime: process.env.GARAGEM_REMINDER_TIME ?? "19:00",
  dailySummaryTime: process.env.DAILY_SUMMARY_TIME ?? "08:00",
  trainingReminderTime: process.env.TRAINING_REMINDER_TIME ?? "18:00",
  // Sundays.
  weeklySummaryTime: process.env.WEEKLY_SUMMARY_TIME ?? "20:00",
};

if (!Number.isSafeInteger(config.allowedChatId)) {
  throw new Error("ALLOWED_CHAT_ID precisa ser um número");
}
