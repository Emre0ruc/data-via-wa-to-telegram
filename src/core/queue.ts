import type { Logger } from '../logger.js';
import { backoffDelay, type BackoffOptions } from './backoff.js';
import type { RelayMessage } from './types.js';

// The queue does not know where messages go; index.ts plugs in the Telegram sender.
export type Deliver = (msg: RelayMessage) => Promise<void>;

// Whether a delivery error is worth retrying, decided by the module that knows the error
// (e.g. Telegram: network trouble yes, "chat not found" no). afterMs overrides the backoff.
export type RetryDecision = { retry: false } | { retry: true; afterMs?: number };

export type QueueOptions = {
  retryDecision?: (err: unknown) => RetryDecision; // default: never retry
  backoff?: BackoffOptions;
  maxRetryMs?: number; // give up on a message after retrying this long
  // Runs once per message when it is done for good: delivered or given up (e.g. delete media).
  onSettled?: (msg: RelayMessage) => Promise<void> | void;
};

// A message, or one still being prepared (e.g. media downloading). undefined = nothing to send.
export type QueueItem = RelayMessage | Promise<RelayMessage | undefined>;

export type RelayQueue = {
  // Preparation runs in parallel, delivery stays in push order.
  push(item: QueueItem): void;
  // Stops accepting messages, cuts short any retry wait, and waits up to timeoutMs for the
  // message being sent.
  close(timeoutMs: number): Promise<void>;
};

const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 5_000, maxMs: 10 * 60_000 };
const DEFAULT_MAX_RETRY_MS = 24 * 60 * 60_000;

// In memory: retries survive outages but not a restart (the phase 4 outbox fixes that).
// Strictly in order: while a message waits for its retry, the ones behind it wait too.
export function createQueue(deliver: Deliver, logger: Logger, options: QueueOptions = {}): RelayQueue {
  const {
    retryDecision = () => ({ retry: false }),
    backoff = DEFAULT_BACKOFF,
    maxRetryMs = DEFAULT_MAX_RETRY_MS,
    onSettled,
  } = options;
  const log = logger.child({ module: 'queue' });
  // Every message is chained onto the previous one, so delivery is strictly in order.
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  let closed = false;
  const closing = new AbortController();

  // Resolves after ms, or right away once close() is called.
  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (closing.signal.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      closing.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });

  const deliverWithRetries = async (msg: RelayMessage): Promise<void> => {
    const startedAt = Date.now();
    for (let attempt = 0; ; attempt++) {
      try {
        await deliver(msg);
        log.info({ id: msg.id, type: msg.type, attempts: attempt + 1 }, 'relayed');
        return;
      } catch (err) {
        // deliver() must throw log-safe errors (see TelegramError): no message text, no token.
        const decision = retryDecision(err);
        const reason = !decision.retry
          ? 'not retryable'
          : closed
            ? 'shutting down'
            : Date.now() - startedAt >= maxRetryMs
              ? 'retried too long'
              : undefined;
        if (reason) {
          log.error({ id: msg.id, type: msg.type, attempts: attempt + 1, reason, err }, 'relay failed, message dropped');
          return;
        }
        const delayMs = (decision.retry && decision.afterMs) || backoffDelay(attempt, backoff);
        log.warn({ id: msg.id, type: msg.type, attempt: attempt + 1, delayMs, err }, 'relay failed, will retry');
        await wait(delayMs);
      }
    }
  };

  const deliverOne = async (item: Promise<RelayMessage | undefined>): Promise<void> => {
    let msg: RelayMessage | undefined;
    try {
      msg = await item;
      if (msg) await deliverWithRetries(msg);
    } catch (err) {
      log.error({ id: msg?.id, err }, 'message could not be prepared, dropped');
    } finally {
      pending--;
      if (msg && onSettled) {
        try {
          await onSettled(msg);
        } catch (err) {
          log.error({ id: msg.id, err }, 'cleanup after relay failed');
        }
      }
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
      closing.abort();
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
