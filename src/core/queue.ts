import type { Logger } from '../logger.js';
import type { RelayMessage } from './types.js';

// The queue does not know where messages go; index.ts plugs in the Telegram sender.
export type Deliver = (msg: RelayMessage) => Promise<void>;

// A message, or one still being prepared (e.g. media downloading). undefined = nothing to send.
export type QueueItem = RelayMessage | Promise<RelayMessage | undefined>;

export type RelayQueue = {
  // Preparation runs in parallel, delivery stays in push order.
  push(item: QueueItem): void;
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

  const deliverOne = async (item: Promise<RelayMessage | undefined>): Promise<void> => {
    let msg: RelayMessage | undefined;
    try {
      msg = await item;
      if (!msg) return;
      await deliver(msg);
      log.info({ id: msg.id, type: msg.type }, 'relayed');
    } catch (err) {
      // deliver() must throw log-safe errors (see TelegramError): no message text, no token.
      log.error({ id: msg?.id, type: msg?.type, err }, 'relay failed, message dropped');
    } finally {
      pending--;
    }
  };

  return {
    push(item) {
      if (closed) {
        log.warn({ id: 'id' in item ? item.id : undefined }, 'queue closed, message dropped');
        return;
      }
      const ready = Promise.resolve(item);
      // Mark a rejection as handled now; deliverOne reports it when its turn comes.
      // Without this, a failure while earlier messages are still sending crashes Node.
      ready.catch(() => {});
      pending++;
      tail = tail.then(() => deliverOne(ready));
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
