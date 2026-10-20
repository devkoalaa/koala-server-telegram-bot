import { Bot, InlineKeyboard, type Context } from "grammy";
import { config } from "./config.ts";
import { askClaude, claudeBusy, splitMessage } from "./claude.ts";
import { backupMessage, dailySummaryMessage, logsMessage, statusMessage } from "./commands.ts";
import { containerName, listContainers, restartContainer } from "./docker.ts";
import { trainingReminder, weeklySummary } from "./fitness.ts";
import { escapeHtml } from "./format.ts";
import {
  desfazerAporte,
  fundoMessage,
  garagemAtivo,
  lembreteSemana,
  pagarParcela,
  registrarAporte,
  valorENota,
} from "./garagem.ts";
import { startNotifyServer } from "./notify-server.ts";
import {
  discardPendingReport,
  extractReport,
  pruneReportImages,
  reportMessage,
  saveReportImage,
  savePendingReport,
  scaleBusy,
} from "./scale.ts";
import { parseTime, startScheduler } from "./scheduler.ts";
import { startSiteChecks } from "./sites.ts";

const DEFAULT_LOG_LINES = 30;
const MAX_LOG_LINES = 200;

const COMMANDS = [
  { command: "status", description: "Estado do servidor, dos containers e dos sites" },
  { command: "backup", description: "Quando foi o último backup de cada banco e o tamanho" },
  { command: "logs", description: "Últimas linhas de log de um container — ex.: /logs koala-fit 50" },
  { command: "restart", description: "Reinicia um container, com confirmação — ex.: /restart koala-fit" },
  { command: "resumo", description: "Resumo do servidor (o mesmo que chega todo dia de manhã)" },
  { command: "semana", description: "Resumo da semana de treinos no Koala Fit" },
  { command: "guardar", description: "Guarda dinheiro no fundo da troca — ex.: /guardar 1000 semana automotiva" },
  { command: "retirar", description: "Tira dinheiro do fundo — ex.: /retirar 800 serasa" },
  { command: "fundo", description: "Como está o fundo da troca de carro (Garagem)" },
  { command: "parcela", description: "Marca uma parcela do Uno como paga" },
  { command: "claude", description: "Pergunta ao Claude sobre o código dos projetos (só leitura)" },
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
      "",
      "💰 Fundo da troca: /guardar, /retirar, /fundo e /parcela.",
      "⚖️ Mande o print do relatório da balança (de preferência como arquivo) para salvar no Koala Fit.",
    ].join("\n"),
  ),
);

bot.command("status", (ctx) => withErrors(ctx, async () => reply(ctx, await statusMessage())));

bot.command("backup", (ctx) => withErrors(ctx, async () => reply(ctx, await backupMessage())));

bot.command("resumo", (ctx) => withErrors(ctx, async () => reply(ctx, await dailySummaryMessage())));

bot.command("semana", (ctx) => withErrors(ctx, async () => reply(ctx, await weeklySummary())));

// ---------- Garagem (fundo da troca de carro) ----------

const SEM_GARAGEM = "⚠️ Garagem não configurado: falta GARAGEM_BOT_CHAVE no .env do bot.";

const atalhosGuardar = () =>
  new InlineKeyboard()
    .text("R$ 500", "garagem-guardar:500")
    .text("R$ 1.000", "garagem-guardar:1000")
    .text("R$ 1.500", "garagem-guardar:1500");

async function guardar(ctx: Context, valor: number, nota: string) {
  const { aporte, html } = await registrarAporte(valor, nota);
  await reply(ctx, html, new InlineKeyboard().text("↩️ Desfazer", `garagem-desfazer:${aporte.id}`));
}

bot.command("guardar", (ctx) =>
  withErrors(ctx, async () => {
    if (!garagemAtivo()) return reply(ctx, SEM_GARAGEM);
    const { valor, nota } = valorENota(ctx.match);
    if (valor === null) {
      return reply(ctx, "Quanto guardar? Toque num valor ou mande <code>/guardar 1000 semana automotiva</code>.", atalhosGuardar());
    }
    await guardar(ctx, valor, nota);
  }),
);

bot.command("retirar", (ctx) =>
  withErrors(ctx, async () => {
    if (!garagemAtivo()) return reply(ctx, SEM_GARAGEM);
    const { valor, nota } = valorENota(ctx.match);
    if (valor === null) return reply(ctx, "Uso: <code>/retirar 800 serasa</code>");
    await guardar(ctx, -valor, nota);
  }),
);

bot.command("fundo", (ctx) =>
  withErrors(ctx, async () => reply(ctx, garagemAtivo() ? await fundoMessage() : SEM_GARAGEM)),
);

bot.command("parcela", (ctx) =>
  withErrors(ctx, async () => {
    if (!garagemAtivo()) return reply(ctx, SEM_GARAGEM);
    await reply(
      ctx,
      "Marcar <b>uma parcela do Uno</b> como paga?",
      new InlineKeyboard().text("✅ Paguei", "garagem-parcela:1").text("Cancelar", "cancel"),
    );
  }),
);

bot.callbackQuery(/^garagem-guardar:(\d+)$/, (ctx) =>
  withErrors(ctx, async () => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup();
    await guardar(ctx, Number(ctx.match[1]), "");
  }),
);

bot.callbackQuery(/^garagem-desfazer:(.+)$/, (ctx) =>
  withErrors(ctx, async () => {
    await desfazerAporte(ctx.match[1]);
    await ctx.answerCallbackQuery({ text: "Desfeito" });
    await ctx.editMessageText("↩️ Lançamento desfeito — nada ficou no fundo.");
  }),
);

bot.callbackQuery(/^garagem-parcela:(1|-1)$/, (ctx) =>
  withErrors(ctx, async () => {
    const pagas = ctx.match[1] === "1" ? 1 : -1;
    const { restantes, total } = await pagarParcela(pagas);
    await ctx.answerCallbackQuery();
    const texto =
      pagas === -1
        ? `↩️ Desfeito. Faltam <b>${restantes}</b> de ${total} parcelas.`
        : restantes === 0
          ? "🎉 <b>Uno quitado!</b> Daqui pra frente a parcela vai pro fundo."
          : `✅ Parcela marcada. Faltam <b>${restantes}</b> de ${total}.`;
    await ctx.editMessageText(texto, {
      parse_mode: "HTML",
      reply_markup: pagas === 1 ? new InlineKeyboard().text("↩️ Desfazer", "garagem-parcela:-1") : undefined,
    });
  }),
);

bot.command("claude", async (ctx) => {
  const prompt = ctx.match.trim();
  if (!prompt) {
    return reply(ctx, "Uso: <code>/claude sua pergunta</code>\nEx.: /claude como o koala-fit calcula a sequência?");
  }
  if (claudeBusy()) return reply(ctx, "⏳ Ainda estou com a pergunta anterior, espera ela terminar.");

  await reply(ctx, "🤖 Pensando… (pode levar alguns minutos)");
  // Not awaited: grammY processes updates one at a time, so blocking here for
  // minutes would freeze every other command until Claude answers.
  askClaude(prompt)
    .then(async (answer) => {
      for (const part of splitMessage(answer)) {
        await ctx.reply(part, { link_preview_options: { is_disabled: true } });
      }
    })
    .catch((err) => reply(ctx, `❌ Claude falhou: ${escapeHtml(err instanceof Error ? err.message : String(err))}`))
    .catch((err) => console.error("Falha ao responder /claude:", err));
});

// Scale report: a photo, or an image sent as a file (keeps full resolution).
bot.on(["message:photo", "message:document"], async (ctx) => {
  const doc = ctx.message.document;
  if (doc && !doc.mime_type?.startsWith("image/")) {
    return reply(ctx, "Pra importar o relatório da balança, mande uma imagem (foto ou arquivo).");
  }
  if (scaleBusy()) return reply(ctx, "⏳ Ainda estou lendo o relatório anterior, espera ele terminar.");

  await withErrors(ctx, async () => {
    const file = await ctx.getFile();
    if (!file.file_path) throw new Error("O Telegram não devolveu o arquivo");
    const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
    const id = await saveReportImage(url, file.file_path, ctx.message.message_id);
    await reply(ctx, "⚖️ Lendo o relatório da balança…");
    // Not awaited, like /claude: reading takes a while and would block other updates.
    extractReport(id)
      .then((report) =>
        reply(
          ctx,
          reportMessage(report, !doc),
          new InlineKeyboard().text("✅ Salvar", `scale-save:${id}`).text("❌ Descartar", `scale-discard:${id}`),
        ),
      )
      .catch((err) => reply(ctx, `❌ Não consegui ler o relatório: ${escapeHtml(err instanceof Error ? err.message : String(err))}`))
      .catch((err) => console.error("Falha ao responder relatório da balança:", err));
  });
});

bot.callbackQuery(/^scale-save:(.+)$/, (ctx) =>
  withErrors(ctx, async () => {
    const saved = await savePendingReport(ctx.match[1]);
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup();
    await reply(
      ctx,
      saved
        ? '✅ Salvo no Koala Fit. <a href="https://fit.devkoala.com/evolucao">Ver evolução</a>'
        : "⌛ Esse relatório expirou (o bot reiniciou). Mande a imagem de novo.",
    );
  }),
);

bot.callbackQuery(/^scale-discard:(.+)$/, async (ctx) => {
  discardPendingReport(ctx.match[1]);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Relatório descartado — nada foi salvo.");
});

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

async function sendToOwner(text: string, html = true) {
  await bot.api.sendMessage(config.allowedChatId, text, {
    parse_mode: html ? "HTML" : undefined,
    link_preview_options: { is_disabled: true },
  });
}

startNotifyServer(config.notifyPort, sendToOwner);
startSiteChecks((html) => sendToOwner(html));

startScheduler([
  {
    name: "resumo diário",
    ...parseTime(config.dailySummaryTime),
    run: async () => sendToOwner(await dailySummaryMessage()),
  },
  {
    name: "lembrete de treino",
    ...parseTime(config.trainingReminderTime),
    run: async () => {
      const message = await trainingReminder();
      if (message) await sendToOwner(message);
    },
  },
  {
    name: "resumo semanal",
    ...parseTime(config.weeklySummaryTime),
    weekday: 0,
    run: async () => sendToOwner(await weeklySummary()),
  },
  {
    name: "lembrete do fundo da troca",
    ...parseTime(config.garagemReminderTime),
    weekday: 5,
    run: async () => {
      if (!garagemAtivo()) return;
      const message = await lembreteSemana();
      if (message) await sendToOwner(message);
    },
  },
  {
    name: "limpeza de relatórios da balança",
    hour: 3,
    minute: 30,
    run: async () => {
      const removed = await pruneReportImages();
      if (removed > 0) console.log(`Relatórios da balança apagados: ${removed}`);
    },
  },
]);

const stop = () => bot.stop();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

await bot.start({
  onStart: (me) => console.log(`Bot @${me.username} rodando`),
});
