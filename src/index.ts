import { Bot, InlineKeyboard, type Context } from "grammy";
import { config } from "./config.ts";
import { backupMessage, logsMessage, statusMessage } from "./commands.ts";
import { containerName, listContainers, restartContainer } from "./docker.ts";
import { escapeHtml } from "./format.ts";

const DEFAULT_LOG_LINES = 30;
const MAX_LOG_LINES = 200;

const COMMANDS = [
  { command: "status", description: "Estado do servidor (CPU, RAM, disco) e dos containers" },
  { command: "backup", description: "Quando foi o último backup de cada banco e o tamanho" },
  { command: "logs", description: "Últimas linhas de log de um container — ex.: /logs koala-fit 50" },
  { command: "restart", description: "Reinicia um container, com confirmação — ex.: /restart koala-fit" },
];

const bot = new Bot(config.botToken);

// The bot can restart containers, so anything not from the owner's chat is
// dropped without a reply — strangers can't even tell the bot is alive.
bot.use(async (ctx, next) => {
  if (ctx.chat?.id === config.allowedChatId) return next();
});

async function reply(ctx: Context, html: string, keyboard?: InlineKeyboard) {
  await ctx.reply(html, { parse_mode: "HTML", reply_markup: keyboard });
}

async function withErrors(ctx: Context, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    console.error(err);
    await reply(ctx, `❌ Erro: ${escapeHtml(err instanceof Error ? err.message : String(err))}`);
  }
}

async function containerPicker(action: "logs" | "restart"): Promise<InlineKeyboard> {
  const keyboard = new InlineKeyboard();
  for (const c of await listContainers()) {
    const name = containerName(c);
    keyboard.text(name, `${action}:${name}`).row();
  }
  return keyboard;
}

function confirmRestart(name: string): InlineKeyboard {
  return new InlineKeyboard().text("✅ Reiniciar", `restart-yes:${name}`).text("Cancelar", "cancel");
}

bot.command(["start", "help"], (ctx) =>
  reply(
    ctx,
    [
      "<b>🐨 Koala Server</b>",
      "",
      ...COMMANDS.map((c) => `/${c.command} — ${escapeHtml(c.description)}`),
    ].join("\n"),
  ),
);

bot.command("status", (ctx) => withErrors(ctx, async () => reply(ctx, await statusMessage())));

bot.command("backup", (ctx) => withErrors(ctx, async () => reply(ctx, await backupMessage())));

bot.command("logs", (ctx) =>
  withErrors(ctx, async () => {
    const [name, lines] = ctx.match.trim().split(/\s+/).filter(Boolean);
    if (!name) return reply(ctx, "Escolha o container:", await containerPicker("logs"));
    const tail = Math.min(Number(lines) || DEFAULT_LOG_LINES, MAX_LOG_LINES);
    await reply(ctx, await logsMessage(name, tail));
  }),
);

bot.command("restart", (ctx) =>
  withErrors(ctx, async () => {
    const name = ctx.match.trim();
    if (!name) return reply(ctx, "Qual container reiniciar?", await containerPicker("restart"));
    await reply(ctx, `Reiniciar <b>${escapeHtml(name)}</b>?`, confirmRestart(name));
  }),
);

bot.callbackQuery(/^logs:(.+)$/, (ctx) =>
  withErrors(ctx, async () => {
    await ctx.answerCallbackQuery();
    await reply(ctx, await logsMessage(ctx.match[1], DEFAULT_LOG_LINES));
  }),
);

bot.callbackQuery(/^restart:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(`Reiniciar <b>${escapeHtml(ctx.match[1])}</b>?`, {
    parse_mode: "HTML",
    reply_markup: confirmRestart(ctx.match[1]),
  });
});

bot.callbackQuery(/^restart-yes:(.+)$/, (ctx) =>
  withErrors(ctx, async () => {
    const name = ctx.match[1];
    await ctx.answerCallbackQuery({ text: "Reiniciando…" });
    await ctx.editMessageText(`🔄 Reiniciando <b>${escapeHtml(name)}</b>…`, { parse_mode: "HTML" });
    await restartContainer(name);
    await reply(ctx, `✅ <b>${escapeHtml(name)}</b> reiniciado.`);
  }),
);

bot.callbackQuery("cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Cancelado.");
});

bot.catch((err) => console.error("Erro não tratado:", err.error));

// Registers the "/" menu (with descriptions) straight from the code, so it
// never drifts from what the bot actually handles. It's scoped to the owner's
// chat only, and the global menu is cleared so nobody else sees the list.
await bot.api.deleteMyCommands();
await bot.api.setMyCommands(COMMANDS, { scope: { type: "chat", chat_id: config.allowedChatId } });

const stop = () => bot.stop();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

await bot.start({
  onStart: (me) => console.log(`Bot @${me.username} rodando`),
});
