import type { Logger } from '../logger.js';
import type { RelayMessage } from './types.js';

// The queue does not know where messages go; index.ts plugs in the Telegram sender.
export type Deliver = (msg: RelayMessage) => Promise<void>;

export type RelayQueue = {
  push(msg: RelayMessage): void;
  // Stops accepting messages and waits up to timeoutMs for the pending ones.
  close(timeoutMs: number): Promise<void>;
};

// Phase 3: in-memory and best effort. A failed message is logged and dropped;
// phase 4 replaces this with a persistent outbox and retries.
export function createQueue(deliver: Deliver, logger: Logger): RelayQueue {
  const log = logger.child({ module: 'queue' });
  // Every message is chained onto the previous one, so delivery is strictly in order.
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  let closed = false;

  const deliverOne = async (msg: RelayMessage): Promise<void> => {
    try {
      await deliver(msg);
      log.info({ id: msg.id, type: msg.type }, 'relayed');
    } catch (err) {
      // deliver() must throw log-safe errors (see TelegramError): no message text, no token.
      log.error({ id: msg.id, type: msg.type, err }, 'relay failed, message dropped');
    } finally {
      pending--;
    }
  };

  return {
    push(msg) {
      if (closed) {
        log.warn({ id: msg.id }, 'queue closed, message dropped');
        return;
      }
      pending++;
      tail = tail.then(() => deliverOne(msg));
    },

    async close(timeoutMs) {
      closed = true;
      if (pending === 0) return;
      log.info({ pending }, 'waiting for pending messages');

      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      });
      const hitTimeout = await Promise.race([tail.then(() => false), timedOut]);
      clearTimeout(timer);
      if (hitTimeout) log.warn({ pending }, 'shutdown timeout, pending messages dropped');
    },
  };
}
