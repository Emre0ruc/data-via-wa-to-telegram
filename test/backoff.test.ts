import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DisconnectReason } from 'baileys';
import { backoffDelay } from '../src/core/backoff.js';
import { reconnectDelay } from '../src/whatsapp/connection.js';

const noJitter = { initialMs: 5_000, maxMs: 600_000, jitter: 0 };

describe('backoffDelay', () => {
  it('doubles from the initial delay', () => {
    assert.deepEqual([0, 1, 2, 3, 4].map((a) => backoffDelay(a, noJitter)), [5_000, 10_000, 20_000, 40_000, 80_000]);
  });

  it('is capped at maxMs, also for huge attempt numbers', () => {
    assert.equal(backoffDelay(7, noJitter), 600_000); // 5 s * 2^7 = 640 s > 600 s
    assert.equal(backoffDelay(10_000, noJitter), 600_000);
  });

  it('spreads by +/- jitter but never above maxMs', () => {
    const opts = { initialMs: 1_000, maxMs: 600_000, jitter: 0.2 };
    assert.equal(backoffDelay(0, { ...opts, random: () => 0 }), 800);
    assert.equal(backoffDelay(0, { ...opts, random: () => 1 }), 1_200);
    assert.equal(backoffDelay(20, { ...opts, random: () => 1 }), 600_000);
  });

  it('treats a negative attempt like the first one', () => {
    assert.equal(backoffDelay(-3, noJitter), 5_000);
  });
});

describe('reconnectDelay (WhatsApp)', () => {
  it('never reconnects after a logout or when another instance took over', () => {
    assert.equal(reconnectDelay(DisconnectReason.loggedOut, 0), undefined);
    assert.equal(reconnectDelay(DisconnectReason.connectionReplaced, 5), undefined);
  });

  it('reconnects at once after the first 515 (pairing), but backs off if 515 repeats', () => {
    assert.equal(reconnectDelay(DisconnectReason.restartRequired, 0), 0);
    const second = reconnectDelay(DisconnectReason.restartRequired, 1);
    assert.ok(second !== undefined && second >= 8_000, `got ${second}`);
  });

  it('backs off for ordinary drops, up to about 10 minutes', () => {
    const first = reconnectDelay(DisconnectReason.connectionLost, 0);
    assert.ok(first !== undefined && first >= 4_000 && first <= 6_000, `got ${first}`);
    assert.ok((reconnectDelay(undefined, 50) ?? 0) <= 600_000);
    assert.ok((reconnectDelay(undefined, 50) ?? 0) >= 480_000);
  });
});
