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

describe('queue: retries', () => {
  const fast = { initialMs: 5, maxMs: 20, jitter: 0 };
  const always = () => ({ retry: true as const });
  const transient = (msg: string) => Object.assign(new Error(msg), { transient: true });
  const onlyTransient = (err: unknown) =>
    (err as { transient?: boolean }).transient ? { retry: true as const } : { retry: false as const };

  it('retries transient failures until delivery succeeds', async () => {
    let calls = 0;
    const q = createQueue(async () => {
      if (++calls < 3) throw transient('offline');
    }, silentLogger, { retryDecision: onlyTransient, backoff: fast });
    q.push(m('a'));
    await sleep(100);
    await q.close(1000);
    assert.equal(calls, 3);
  });

  it('gives up at once on a non-retryable error', async () => {
    let calls = 0;
    const q = createQueue(async () => {
      calls++;
      throw new Error('chat not found');
    }, silentLogger, { retryDecision: onlyTransient, backoff: fast });
    q.push(m('a'));
    await q.close(1000);
    assert.equal(calls, 1);
  });

  it('honors the wait time the error asks for (Telegram 429 retry_after)', async () => {
    const times: number[] = [];
    const q = createQueue(async () => {
      times.push(Date.now());
      if (times.length === 1) throw new Error('429');
    }, silentLogger, { retryDecision: () => ({ retry: true, afterMs: 60 }), backoff: fast });
    q.push(m('a'));
    await sleep(150);
    await q.close(1000);
    assert.equal(times.length, 2);
    const gap = times[1]! - times[0]!;
    assert.ok(gap >= 55, `waited only ${gap} ms`);
  });

  it('gives up after retrying for maxRetryMs', async () => {
    let calls = 0;
    const q = createQueue(async () => {
      calls++;
      throw new Error('still offline');
    }, silentLogger, { retryDecision: always, backoff: fast, maxRetryMs: 50 });
    q.push(m('a'));
    await sleep(150);
    const before = calls;
    await sleep(60);
    assert.equal(calls, before, 'no attempts after giving up');
    assert.ok(calls >= 2);
    await q.close(1000);
  });

  it('keeps the order: later messages wait while one is being retried', async () => {
    const got: string[] = [];
    let failures = 2;
    const q = createQueue(async (msg) => {
      if (msg.id === 'a' && failures-- > 0) throw new Error('offline');
      got.push(msg.id);
    }, silentLogger, { retryDecision: always, backoff: fast });
    q.push(m('a'));
    q.push(m('b'));
    await sleep(100);
    await q.close(1000);
    assert.deepEqual(got, ['a', 'b']);
  });

  it('close() cuts a long retry wait short', async () => {
    const q = createQueue(async () => {
      throw new Error('offline');
    }, silentLogger, { retryDecision: always, backoff: { initialMs: 60_000, maxMs: 60_000 } });
    q.push(m('a'));
    await sleep(20); // first attempt failed, now waiting 60 s
    const start = Date.now();
    await q.close(5_000);
    assert.ok(Date.now() - start < 1_000, 'close must not wait for the retry delay');
  });

  it('runs onSettled once per message, after success or after giving up', async () => {
    const settled: string[] = [];
    let calls = 0;
    const q = createQueue(async (msg) => {
      if (msg.id === 'retry-then-ok' && ++calls < 2) throw new Error('offline');
      if (msg.id === 'hopeless') throw Object.assign(new Error('blocked'), { fatal: true });
    }, silentLogger, {
      retryDecision: (err) => ((err as { fatal?: boolean }).fatal ? { retry: false } : { retry: true }),
      backoff: fast,
      onSettled: (msg) => void settled.push(msg.id),
    });
    q.push(m('retry-then-ok'));
    q.push(m('hopeless'));
    q.push(Promise.resolve(undefined)); // nothing to settle
    await sleep(100);
    await q.close(1000);
    assert.deepEqual(settled, ['retry-then-ok', 'hopeless']);
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
