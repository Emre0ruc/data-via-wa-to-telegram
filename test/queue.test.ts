import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createQueue } from '../src/core/queue.js';
import type { RelayMessage } from '../src/core/types.js';
import { captureLogger, silentLogger, sleep } from './helpers.js';

const m = (id: string, text = id): RelayMessage => ({ id, timestamp: 0, type: 'text', text });

describe('queue: ordering', () => {
  it('delivers in push order even when earlier deliveries are slower', async () => {
    const got: string[] = [];
    const delays: Record<string, number> = { a: 60, b: 5, c: 30 };
    const q = createQueue(async (msg) => {
      await sleep(delays[msg.id] ?? 0);
      got.push(msg.id);
    }, silentLogger);
    q.push(m('a'));
    q.push(m('b'));
    q.push(m('c'));
    await q.close(1000);
    assert.deepEqual(got, ['a', 'b', 'c']);
  });

  it('does not let a message overtake one that is still being prepared (media download)', async () => {
    const got: string[] = [];
    const q = createQueue(async (msg) => void got.push(msg.id), silentLogger);
    q.push(sleep(80).then(() => m('photo')));
    q.push(m('text-after'));
    await q.close(1000);
    assert.deepEqual(got, ['photo', 'text-after']);
  });

  it('keeps messages pushed after the queue went idle or between microtasks', async () => {
    const got: string[] = [];
    const q = createQueue(async (msg) => {
      await sleep(10);
      got.push(msg.id);
    }, silentLogger);
    q.push(m('a'));
    await sleep(15);
    q.push(m('b'));
    await Promise.resolve();
    q.push(m('c'));
    await q.close(1000);
    assert.deepEqual(got, ['a', 'b', 'c']);
  });
});

describe('queue: failures', () => {
  it('drops a failed message and keeps going', async () => {
    const got: string[] = [];
    const q = createQueue(async (msg) => {
      if (msg.id === 'b') throw new Error('boom');
      got.push(msg.id);
    }, silentLogger);
    q.push(m('a'));
    q.push(m('b'));
    q.push(m('c'));
    await q.close(1000);
    assert.deepEqual(got, ['a', 'c']);
  });

  it('survives rejected and empty items without an unhandled rejection', async () => {
    let unhandled = 0;
    const onUnhandled = () => void unhandled++;
    process.on('unhandledRejection', onUnhandled);
    try {
      const got: string[] = [];
      const q = createQueue(async (msg) => {
        await sleep(50);
        got.push(msg.id);
      }, silentLogger);
      q.push(m('a'));
      q.push(Promise.reject(new Error('prepare failed'))); // rejects while 'a' is still sending
      q.push(Promise.resolve(undefined));
      q.push(m('b'));
      await q.close(1000);
      await sleep(20);
      assert.deepEqual(got, ['a', 'b']);
      assert.equal(unhandled, 0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('logs the ID and the error, never the message text', async () => {
    const { logger, output } = captureLogger();
    const q = createQueue(async () => {
      throw new Error('safe description');
    }, logger);
    q.push(m('ID1', 'SECRET BODY'));
    await q.close(1000);
    assert.match(output(), /ID1/);
    assert.match(output(), /safe description/);
    assert.doesNotMatch(output(), /SECRET BODY/);
  });
});

describe('queue: close', () => {
  it('waits for pending messages', async () => {
    let done = false;
    const q = createQueue(async () => {
      await sleep(50);
      done = true;
    }, silentLogger);
    q.push(m('a'));
    await q.close(1000);
    assert.equal(done, true);
  });

  it('gives up after the timeout', async () => {
    const q = createQueue(() => new Promise<void>(() => {}), silentLogger);
    q.push(m('a'));
    const start = Date.now();
    await q.close(100);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 95 && elapsed < 500, `elapsed ${elapsed} ms`);
  });

  it('drops messages pushed after close', async () => {
    const got: string[] = [];
    const q = createQueue(async (msg) => void got.push(msg.id), silentLogger);
    await q.close(1000);
    q.push(m('late'));
    await sleep(20);
    assert.deepEqual(got, []);
  });
});
