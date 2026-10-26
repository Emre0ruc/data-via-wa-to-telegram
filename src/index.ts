import { rm } from 'node:fs/promises';
import path from 'node:path';
import { ConfigError, loadConfig } from './config.js';
import { createQueue } from './core/queue.js';
import { createLogger } from './logger.js';
import { createTelegramSender, TelegramError } from './telegram/sender.js';
import { startWhatsApp } from './whatsapp/connection.js';
import { selfChatMessages } from './whatsapp/filter.js';
import { prepareMediaDir } from './whatsapp/media.js';
import { normalize } from './whatsapp/normalize.js';

// How long shutdown waits for queued messages to reach Telegram.
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  // Telegram first: a bad token or chat ID stops us before we connect to WhatsApp.
  const telegram = await createTelegramSender({
    token: config.telegramBotToken,
    chatId: config.telegramChatId,
    logger,
  });
  const mediaDir = path.join(config.dataDir, 'media');
  await prepareMediaDir(mediaDir);

  const queue = createQueue(async (msg) => {
    try {
      await telegram.send(msg);
    } finally {
      // Temporary files go away whether or not the send worked (no retries before phase 4).
      if (msg.media) await rm(msg.media.path, { force: true });
    }
  }, logger);

  const whatsapp = await startWhatsApp({
    sessionDir: path.join(config.dataDir, 'session'),
    logger,
    onMessagesUpsert: (event, sock) => {
      // Anything that is not a live self-chat message is dropped here, unlogged.
      for (const msg of selfChatMessages(event, sock.user)) {
        queue.push(normalize(msg, { mediaDir, logger }));
      }
    },
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    // WhatsApp first so no new messages arrive, then let the queue drain.
    whatsapp
      .stop()
      .catch((err: unknown) => logger.error({ err }, 'error while closing WhatsApp'))
      .then(() => queue.close(SHUTDOWN_TIMEOUT_MS))
      .finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const TELEGRAM_HINTS: Record<number, string> = {
  401: 'Check TELEGRAM_BOT_TOKEN.',
  400: 'Check TELEGRAM_CHAT_ID (npm run chat-id) and that you sent /start to the bot.',
  403: 'The bot is blocked in that chat. Unblock it and send /start.',
};

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else if (err instanceof TelegramError) {
    const hint = err.code !== undefined ? TELEGRAM_HINTS[err.code] : undefined;
    console.error(`Telegram check failed: ${err.message}${hint ? `\n${hint}` : ''}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
