import path from 'node:path';
import { Api, GrammyError, HttpError, InputFile } from 'grammy';
import type { RelayMessage } from '../core/types.js';
import type { Logger } from '../logger.js';

// Telegram's limits for a text message, a media caption, and sendPhoto uploads.
export const MAX_MESSAGE_LENGTH = 4096;
export const MAX_CAPTION_LENGTH = 1024;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

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

export function toSafeError(err: unknown): TelegramError {
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

  // Plain text, no parse_mode: characters like * or _ are sent as-is and cannot break formatting.
  const sendText = async (text: string): Promise<void> => {
    for (const part of splitText(text)) {
      await api.sendMessage(chatId, part);
    }
  };

  type Media = NonNullable<RelayMessage['media']>;

  // Sends the file with `upload`, captioned when the text fits. A longer text goes out as a
  // separate message right after the file.
  const sendWithCaption = async (
    msg: RelayMessage,
    upload: (other: { caption?: string }) => Promise<void>,
  ): Promise<void> => {
    const caption = msg.text && msg.text.length <= MAX_CAPTION_LENGTH ? msg.text : undefined;
    await upload(caption ? { caption } : {});
    if (msg.text && !caption) await sendText(msg.text);
  };

  // An InputFile can be uploaded only once, so every attempt builds a fresh one.
  // Documents keep their original name in Telegram; photos use the on-disk name.
  const inputFile = (media: Media) => new InputFile(media.path, media.fileName ?? path.basename(media.path));

  const sendDocument = (msg: RelayMessage, media: Media) =>
    sendWithCaption(msg, async (other) => {
      await api.sendDocument(chatId, inputFile(media), other);
    });

  const sendImage = (msg: RelayMessage, media: Media) =>
    sendWithCaption(msg, async (other) => {
      if (media.size <= MAX_PHOTO_BYTES) {
        try {
          await api.sendPhoto(chatId, inputFile(media), other);
          return;
        } catch (err) {
          // 400 = Telegram refused this as a photo (dimensions, format). Anything else is real.
          if (!(err instanceof GrammyError && err.error_code === 400)) throw err;
          log.warn({ id: msg.id, reason: err.description }, 'photo rejected, sending as document');
        }
      }
      // Too big for sendPhoto (e.g. WhatsApp HD) or refused: a document keeps the original file.
      await api.sendDocument(chatId, inputFile(media), other);
    });

  return {
    async send(msg) {
      try {
        if (msg.type === 'text' && msg.text) return await sendText(msg.text);
        if (msg.type === 'image' && msg.media) return await sendImage(msg, msg.media);
        if (msg.type === 'document' && msg.media) return await sendDocument(msg, msg.media);
      } catch (err) {
        throw toSafeError(err);
      }
      throw new TelegramError(`unsupported message type: ${msg.type}`);
    },
  };
}
