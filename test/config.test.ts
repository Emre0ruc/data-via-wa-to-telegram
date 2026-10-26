import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ConfigError, loadBotToken, loadConfig } from '../src/config.js';

const valid = { TELEGRAM_BOT_TOKEN: '123456:ABC-def_ghi', TELEGRAM_CHAT_ID: '-100123456' };

function configError(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.message;
  }
  assert.fail('expected a ConfigError');
}

describe('loadConfig', () => {
  it('applies defaults', () => {
    assert.deepEqual(loadConfig(valid), {
      telegramBotToken: '123456:ABC-def_ghi',
      telegramChatId: -100123456,
      dataDir: path.resolve('./data'),
      logLevel: 'info',
      privatePrefix: '#gizli',
    });
  });

  it('treats empty values as unset, so defaults apply (PRIVATE_PREFIX= does not disable the filter)', () => {
    const config = loadConfig({ ...valid, DATA_DIR: '', LOG_LEVEL: '  ', PRIVATE_PREFIX: '' });
    assert.equal(config.dataDir, path.resolve('./data'));
    assert.equal(config.logLevel, 'info');
    assert.equal(config.privatePrefix, '#gizli');
  });

  it('resolves DATA_DIR to an absolute path', () => {
    assert.equal(loadConfig({ ...valid, DATA_DIR: './elsewhere' }).dataDir, path.resolve('./elsewhere'));
  });

  it('reports missing required variables', () => {
    const message = configError(() => loadConfig({}));
    assert.match(message, /TELEGRAM_BOT_TOKEN: missing/);
    assert.match(message, /TELEGRAM_CHAT_ID: missing/);
  });

  it('reports every invalid variable at once, without their values', () => {
    const message = configError(() =>
      loadConfig({ TELEGRAM_BOT_TOKEN: 'secret-oops', TELEGRAM_CHAT_ID: 'abc', LOG_LEVEL: 'verbose' }),
    );
    assert.match(message, /TELEGRAM_BOT_TOKEN: does not look like a bot token/);
    assert.match(message, /TELEGRAM_CHAT_ID: must be a numeric chat ID/);
    assert.match(message, /LOG_LEVEL:/);
    assert.ok(!message.includes('secret-oops'), 'token value must not appear');
  });

  it('rejects chat IDs that would lose precision', () => {
    const message = configError(() => loadConfig({ ...valid, TELEGRAM_CHAT_ID: '99999999999999999999' }));
    assert.match(message, /TELEGRAM_CHAT_ID: is out of range/);
  });
});

describe('loadBotToken', () => {
  it('needs only the token (used by npm run chat-id)', () => {
    assert.equal(loadBotToken({ TELEGRAM_BOT_TOKEN: valid.TELEGRAM_BOT_TOKEN }), valid.TELEGRAM_BOT_TOKEN);
  });

  it('still validates the token', () => {
    assert.match(configError(() => loadBotToken({})), /TELEGRAM_BOT_TOKEN: missing/);
    assert.match(configError(() => loadBotToken({ TELEGRAM_BOT_TOKEN: 'nope' })), /does not look like/);
  });
});
