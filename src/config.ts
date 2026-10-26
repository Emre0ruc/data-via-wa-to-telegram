import path from 'node:path';
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

// Empty values in .env (e.g. `DATA_DIR=`) arrive as "", treat them as unset
// so defaults apply and required fields report "missing".
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema);

const botToken = optional(
  z
    .string({ error: 'missing' })
    .regex(/^\d+:[A-Za-z0-9_-]+$/, 'does not look like a bot token (expected 123456:ABC-...)'),
);

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: botToken,
  TELEGRAM_CHAT_ID: optional(
    z
      .string({ error: 'missing' })
      .regex(/^-?\d+$/, 'must be a numeric chat ID')
      .transform(Number)
      .refine(Number.isSafeInteger, 'is out of range'),
  ),
  DATA_DIR: optional(z.string().default('./data')),
  LOG_LEVEL: optional(z.enum(LOG_LEVELS).default('info')),
  PRIVATE_PREFIX: optional(z.string().default('#gizli')),
});

export type Config = {
  telegramBotToken: string;
  telegramChatId: number;
  dataDir: string;
  logLevel: (typeof LOG_LEVELS)[number];
  privatePrefix: string;
};

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch (err) {
    // No .env file is fine (e.g. Docker passes variables directly).
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function parseEnv<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.output<T> {
  if (env === process.env) loadDotEnv();

  const result = schema.safeParse(env);
  if (!result.success) {
    // Only report variable names and reasons, never the values (they may be secrets).
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(
      `Invalid configuration:\n${lines.join('\n')}\nSee .env.example for the expected variables.`,
    );
  }
  return result.data;
}

// For the chat-id helper, which runs before TELEGRAM_CHAT_ID is known.
export function loadBotToken(env: NodeJS.ProcessEnv = process.env): string {
  return parseEnv(z.object({ TELEGRAM_BOT_TOKEN: botToken }), env).TELEGRAM_BOT_TOKEN;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = parseEnv(envSchema, env);
  return {
    telegramBotToken: e.TELEGRAM_BOT_TOKEN,
    telegramChatId: e.TELEGRAM_CHAT_ID,
    dataDir: path.resolve(e.DATA_DIR),
    logLevel: e.LOG_LEVEL,
    privatePrefix: e.PRIVATE_PREFIX,
  };
}
