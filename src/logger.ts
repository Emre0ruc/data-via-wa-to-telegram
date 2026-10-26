import { pino, type LevelWithSilent, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: LevelWithSilent): Logger {
  return pino({
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

// Baileys logs protocol internals (and sometimes message nodes) at info/debug,
// so it never gets more verbose than warn. If the app is quieter, follow the app.
export function createBaileysLogger(parent: Logger): Logger {
  const level = parent.isLevelEnabled('warn') ? 'warn' : parent.level;
  return parent.child({ module: 'baileys' }, { level });
}
