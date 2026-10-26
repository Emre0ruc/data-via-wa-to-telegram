import { Api, GrammyError, HttpError } from 'grammy';
import type { RelayMessage } from '../core/types.js';
import type { Logger } from '../logger.js';

// Telegram's limit for a single text message.
export const MAX_MESSAGE_LENGTH = 4096;

export type TelegramSenderOptions = {
  token: string;
  chatId: number;
  logger: Logger;
};

export type TelegramSender = {
  send(msg: RelayMessage): Promise<void>;
};

// grammY errors are unsafe to log as-is: GrammyError.payload holds the message text, and
// HttpError.error is the raw fetch error whose message contains the request URL (with the
// bot token). This carries only what is safe to log.
export class TelegramError extends Error {
  override name = 'TelegramError';
  readonly code: number | undefined;
  readonly retryAfter: number | undefined; // seconds, set on 429 Too Many Requests

  constructor(message: string, code?: number, retryAfter?: number) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function toSafeError(err: unknown): TelegramError {
  if (err instanceof GrammyError) {
    return new TelegramError(
      `${err.method} failed: ${err.error_code} ${err.description}`,
      err.error_code,
      err.parameters.retry_after,
    );
  }
  if (err instanceof HttpError) {
    // grammY leaves the URL out of this message unless sensitiveLogs is enabled (it is not).
    return new TelegramError(err.message);
  }
  return new TelegramError(`unexpected ${err instanceof Error ? err.name : typeof err} from Telegram client`);
}

// Splits at a newline or space near the limit when possible, never inside an emoji
// (a UTF-16 surrogate pair). Telegram counts length in UTF-16 units, like String.length.
export function splitText(text: string, max = MAX_MESSAGE_LENGTH): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    const atSeparator = cut >= max / 2;
    if (!atSeparator) {
      cut = max;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut--;
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(atSeparator ? cut + 1 : cut);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

export async function createTelegramSender(options: TelegramSenderOptions): Promise<TelegramSender> {
  const { token, chatId, logger } = options;
  const log = logger.child({ module: 'telegram' });

  // Api only makes outgoing calls. There is deliberately no Bot/bot.start(): nothing polls
  // for updates, so the bot cannot receive commands from anyone.
  const api = new Api(token);

  try {
    const me = await api.getMe();
    // Fails at startup (instead of on the first relayed message) if TELEGRAM_CHAT_ID is
    // wrong or the bot was never /start-ed in that chat. Read-only: sends nothing.
    await api.getChat(chatId);
    log.info({ bot: me.username }, 'telegram bot ready');
  } catch (err) {
    throw toSafeError(err);
  }

  return {
    async send(msg) {
      if (msg.type !== 'text' || !msg.text) {
        throw new TelegramError(`unsupported message type: ${msg.type}`);
      }
      // Plain text, no parse_mode: characters like * or _ are sent as-is and cannot break formatting.
      for (const part of splitText(msg.text)) {
        try {
          await api.sendMessage(chatId, part);
        } catch (err) {
          throw toSafeError(err);
        }
      }
    },
  };
}
