import { ConfigError, loadConfig } from './config.js';

function main(): void {
  const config = loadConfig();
  // Phase 1: only prove the config loads. Never print the token.
  console.log(
    `Config OK: chatId=${config.telegramChatId} dataDir=${config.dataDir} ` +
      `logLevel=${config.logLevel} privatePrefix=${config.privatePrefix}`,
  );
}

try {
  main();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
