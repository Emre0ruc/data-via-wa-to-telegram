import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GrammyError, HttpError } from 'grammy';
import { splitText, TelegramError, toSafeError } from '../src/telegram/sender.js';
import { captureLogger } from './helpers.js';

describe('splitText', () => {
  it('keeps short text whole, returns nothing for empty text', () => {
    assert.deepEqual(splitText('short', 10), ['short']);
    assert.deepEqual(splitText('', 10), []);
  });

  it('splits at a space or newline near the limit and drops that separator', () => {
    assert.deepEqual(splitText('aaaa bbbb cccc', 10), ['aaaa bbbb', 'cccc']);
    assert.deepEqual(splitText('aaaaaaa\nbbbbbbb', 10), ['aaaaaaa', 'bbbbbbb']);
  });

  it('cuts hard when there is no separator in the second half', () => {
    assert.deepEqual(splitText('aaaaaaaaaaaaaaa', 10), ['aaaaaaaaaa', 'aaaaa']);
    assert.deepEqual(splitText('a b aaaaaaaaaaaa', 10), ['a b aaaaaa', 'aaaaaa']);
  });

  it('never splits an emoji (UTF-16 surrogate pair)', () => {
    const text = 'aaaaaaaaa😀bbb'; // the emoji sits at UTF-16 indexes 9-10
    const parts = splitText(text, 10);
    assert.deepEqual(parts, ['aaaaaaaaa', '😀bbb']);
    assert.equal(parts.join(''), text);
  });

  it("uses Telegram's 4096 limit by default", () => {
    assert.deepEqual(splitText('x'.repeat(4096 * 2 + 5)).map((p) => p.length), [4096, 4096, 5]);
  });
});

// grammY errors carry secrets: GrammyError.payload has the message text, and HttpError.error
// is the raw fetch error whose message contains the request URL with the bot token.
describe('toSafeError', () => {
  const TOKEN = '123456:SECRET-TOKEN';

  function assertNoSecrets(err: TelegramError): void {
    const { logger, output } = captureLogger();
    logger.error({ err }, 'relay failed');
    const everything = JSON.stringify({ ...err, message: err.message, stack: err.stack }) + output();
    assert.doesNotMatch(everything, /SECRET/);
  }

  it('keeps method, code and description of an API error, drops the payload', () => {
    const err = new GrammyError(
      "Call to 'sendMessage' failed!",
      { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
      'sendMessage',
      { chat_id: 1, text: 'SECRET BODY' },
    );
    const safe = toSafeError(err);
    assert.ok(safe instanceof TelegramError);
    assert.equal(safe.message, 'sendMessage failed: 400 Bad Request: chat not found');
    assert.equal(safe.code, 400);
    assert.equal(safe.retryAfter, undefined);
    assertNoSecrets(safe);
  });

  it('carries retry_after from a 429', () => {
    const err = new GrammyError(
      "Call to 'sendMessage' failed!",
      { ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } },
      'sendMessage',
      { text: 'SECRET BODY' },
    );
    assert.equal(toSafeError(err).retryAfter, 7);
  });

  it('drops the inner fetch error (and the token in its URL) from a network error', () => {
    const inner = new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed, reason: ECONNRESET`);
    const err = new HttpError("Network request for 'sendMessage' failed!", inner);
    const safe = toSafeError(err);
    assert.equal(safe.message, "Network request for 'sendMessage' failed!");
    assert.equal(safe.code, undefined);
    assertNoSecrets(safe);
  });

  it('describes anything else only by its type', () => {
    assert.equal(toSafeError('x').message, 'unexpected string from Telegram client');
    assert.equal(toSafeError(new TypeError('SECRET')).message, 'unexpected TypeError from Telegram client');
  });
});
