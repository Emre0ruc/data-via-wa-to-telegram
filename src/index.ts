import path from 'node:path';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { startWhatsApp } from './whatsapp/connection.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const whatsapp = await startWhatsApp({
    sessionDir: path.join(config.dataDir, 'session'),
    logger,
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    whatsapp
      .stop()
      .catch((err: unknown) => logger.error({ err }, 'error during shutdown'))
      .finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
});
