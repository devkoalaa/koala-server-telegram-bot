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
  dailySummaryTime: process.env.DAILY_SUMMARY_TIME ?? "08:00",
  trainingReminderTime: process.env.TRAINING_REMINDER_TIME ?? "18:00",
  // Sundays.
  weeklySummaryTime: process.env.WEEKLY_SUMMARY_TIME ?? "20:00",
};

if (!Number.isSafeInteger(config.allowedChatId)) {
  throw new Error("ALLOWED_CHAT_ID precisa ser um número");
}
