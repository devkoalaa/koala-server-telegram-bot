import { Bot, InlineKeyboard, type Context } from "grammy";
import { config } from "./config.ts";
import { askClaude, claudeBusy, splitMessage } from "./claude.ts";
import { backupMessage, dailySummaryMessage, logsMessage, statusMessage } from "./commands.ts";
import { containerName, listContainers, restartContainer } from "./docker.ts";
import { trainingReminder, weeklySummary } from "./fitness.ts";
import {
  archiveProduct,
  dayMessage,
  foodEnabled,
  logFood,
  productsList,
  undoFood,
  undoProduct,
  type FoodImage,
} from "./food.ts";
import { escapeHtml } from "./format.ts";
import {
  agoraMessage,
  avisosOpenFinance,
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
  { command: "dieta", description: "O que você comeu hoje e quanto falta para as metas" },
  { command: "produtos", description: "Produtos com rótulo cadastrado (marque o que acabou)" },
  { command: "agora", description: "O que fazer agora e para onde vai o próximo pagamento (Garagem)" },
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
      "💰 Garagem: /agora, /guardar, /retirar, /fundo e /parcela.",
      "🍽️ Mande o que comeu ou bebeu, em texto ou foto (com ou sem descrição), para registrar no diário.",
      "📦 Mande a foto da tabela nutricional de um produto para cadastrar; depois é só citar ele.",
      "⚖️ Mande o print do relatório da balança (de preferência como arquivo) para salvar no Koala Fit.",
    ].join("\n"),
  ),
);

bot.command("status", (ctx) => withErrors(ctx, async () => reply(ctx, await statusMessage())));

bot.command("backup", (ctx) => withErrors(ctx, async () => reply(ctx, await backupMessage())));

bot.command("resumo", (ctx) => withErrors(ctx, async () => reply(ctx, await dailySummaryMessage())));

bot.command("semana", (ctx) => withErrors(ctx, async () => reply(ctx, await weeklySummary())));

bot.command("dieta", (ctx) =>
  withErrors(ctx, async () => {
    await ctx.reply(await dayMessage(), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  }),
);

async function productsKeyboard(): Promise<{ html: string; keyboard?: InlineKeyboard }> {
  const { html, products } = await productsList();
  if (products.length === 0) return { html };
  const keyboard = new InlineKeyboard();
  for (const p of products) keyboard.text(`🗑️ Acabou: ${p.name}`, `product-archive:${p.id}`).row();
  return { html, keyboard };
}

bot.command("produtos", (ctx) =>
  withErrors(ctx, async () => {
    const { html, keyboard } = await productsKeyboard();
    await reply(ctx, html, keyboard);
  }),
);

bot.callbackQuery(/^product-archive:([0-9a-f-]{36})$/, (ctx) =>
  withErrors(ctx, async () => {
    const name = await archiveProduct(ctx.match[1]);
    await ctx.answerCallbackQuery({ text: name ? `${name} saiu da lista` : "Já tinha saído da lista" });
    const { html, keyboard } = await productsKeyboard();
    await ctx.editMessageText(html, { parse_mode: "HTML", reply_markup: keyboard });
  }),
);

bot.callbackQuery(/^product-undo:([0-9a-f-]{36})$/, (ctx) =>
  withErrors(ctx, async () => {
    const undone = await undoProduct(ctx.match[1]);
    await ctx.answerCallbackQuery({ text: undone ? "Desfeito" : "Já não estava cadastrado" });
    await ctx.editMessageText(undone ? "↩️ Cadastro desfeito: a lista de produtos voltou a ser a de antes." : "↩️ Nada a desfazer.");
  }),
);

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

bot.command("agora", (ctx) =>
  withErrors(ctx, async () => reply(ctx, garagemAtivo() ? await agoraMessage() : SEM_GARAGEM)),
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

// ---------- Imagens: comida ou relatório da balança ----------

const FOOD_MEDIA_TYPES: Record<string, FoodImage["mediaType"]> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};
// Limite da API do Claude por imagem.
const MAX_FOOD_IMAGE_BYTES = 5 * 1024 * 1024;

async function readScaleReport(ctx: Context, url: string, filePath: string, messageId: number, fromPhoto: boolean) {
  if (scaleBusy()) return reply(ctx, "⏳ Ainda estou lendo o relatório anterior, espera ele terminar.");
  const id = await saveReportImage(url, filePath, messageId);
  await reply(ctx, "⚖️ Lendo o relatório da balança…");
  // Not awaited, like /claude: reading takes a while and would block other updates.
  extractReport(id)
    .then((report) =>
      reply(
        ctx,
        reportMessage(report, fromPhoto),
        new InlineKeyboard().text("✅ Salvar", `scale-save:${id}`).text("❌ Descartar", `scale-discard:${id}`),
      ),
    )
    .catch((err) => reply(ctx, `❌ Não consegui ler o relatório: ${escapeHtml(err instanceof Error ? err.message : String(err))}`))
    .catch((err) => console.error("Falha ao responder relatório da balança:", err));
}

/**
 * Registra comida a partir de texto e/ou imagem. Roda sem await (a API leva
 * alguns segundos); se o Claude disser que a imagem é um relatório da balança,
 * cai no fluxo da balança.
 */
function registerFood(ctx: Context, text: string, image: FoodImage | null, messageId: number, onScaleReport?: () => Promise<void>) {
  logFood(text, image, messageId)
    .then(async (result) => {
      if (result.kind === "scale_report") {
        if (onScaleReport) return onScaleReport();
        return reply(ctx, "Isso parece um relatório da balança.");
      }
      if (result.kind === "other") return reply(ctx, result.html);
      if (result.kind === "product") {
        return ctx.reply(result.html, {
          parse_mode: "HTML",
          reply_parameters: { message_id: messageId },
          reply_markup: new InlineKeyboard().text("↩️ Desfazer", `product-undo:${result.productId}`),
        });
      }
      await ctx.reply(result.html, {
        parse_mode: "HTML",
        reply_parameters: { message_id: messageId },
        reply_markup: new InlineKeyboard().text("↩️ Desfazer", `food-undo:${messageId}`),
      });
    })
    .catch((err) => reply(ctx, `❌ Não consegui registrar: ${escapeHtml(err instanceof Error ? err.message : String(err))}`))
    .catch((err) => console.error("Falha ao responder registro de comida:", err));
}

// A photo, or an image sent as a file (keeps full resolution). With the
// Claude API configured, photos and captioned images go through the food
// diary first; an image file without caption is still treated as a scale
// report straight away (the help text asks for scale prints as files).
bot.on(["message:photo", "message:document"], async (ctx) => {
  const doc = ctx.message.document;
  if (doc && !doc.mime_type?.startsWith("image/")) {
    return reply(ctx, "Mande uma imagem (foto ou arquivo): comida para o diário ou o relatório da balança.");
  }
  const caption = ctx.message.caption ?? "";
  const messageId = ctx.message.message_id;

  await withErrors(ctx, async () => {
    const file = await ctx.getFile();
    if (!file.file_path) throw new Error("O Telegram não devolveu o arquivo");
    const filePath = file.file_path;
    const url = `https://api.telegram.org/file/bot${config.botToken}/${filePath}`;

    if (!foodEnabled() || (doc && !caption.trim())) {
      return readScaleReport(ctx, url, filePath, messageId, !doc);
    }

    const mediaType = FOOD_MEDIA_TYPES[filePath.split(".").pop()?.toLowerCase() ?? ""] ?? "image/jpeg";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download da imagem falhou (HTTP ${res.status})`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_FOOD_IMAGE_BYTES) {
      return reply(ctx, "Imagem grande demais (máx. 5 MB). Mande como foto, não como arquivo.");
    }
    await ctx.replyWithChatAction("typing");
    registerFood(ctx, caption, { data, mediaType }, messageId, () => readScaleReport(ctx, url, filePath, messageId, !doc));
  });
});

bot.callbackQuery(/^food-undo:(\d+)$/, (ctx) =>
  withErrors(ctx, async () => {
    const removed = await undoFood(Number(ctx.match[1]));
    await ctx.answerCallbackQuery({ text: removed > 0 ? "Desfeito" : "Já não estava registrado" });
    await ctx.editMessageText(
      removed > 0 ? `↩️ Desfeito: ${removed === 1 ? "o item saiu" : `os ${removed} itens saíram`} do diário.` : "↩️ Nada a desfazer.",
    );
  }),
);

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

// Por último, depois de todos os comandos: texto solto (sem comando) = algo que comeu ou bebeu, ou uma pergunta sobre a dieta.
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return reply(ctx, "Comando desconhecido. Veja /help.");
  if (!foodEnabled()) {
    return reply(ctx, "⚠️ Diário alimentar não configurado: falta ANTHROPIC_API_KEY no .env do bot.");
  }
  await ctx.replyWithChatAction("typing");
  registerFood(ctx, text, null, ctx.message.message_id);
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

if (garagemAtivo()) {
  // Avisos do Open Finance que o Garagem preparou (Pix recebido, cofrinho do
  // fundo, conexão com o banco). O banco só atualiza 1 vez por dia, então
  // 10 minutos de atraso aqui não fazem diferença.
  setInterval(() => {
    avisosOpenFinance()
      .then((message) => (message ? sendToOwner(message) : undefined))
      .catch((err) => console.error("Avisos do Garagem falharam:", err));
  }, 10 * 60_000);
}

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
