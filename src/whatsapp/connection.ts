import { mkdir } from 'node:fs/promises';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type BaileysEventMap,
  type WASocket,
} from 'baileys';
import QRCode from 'qrcode';
import { createBaileysLogger, type Logger } from '../logger.js';

export type MessagesUpsertHandler = (
  event: BaileysEventMap['messages.upsert'],
  sock: WASocket,
) => void;

export type WhatsAppOptions = {
  sessionDir: string;
  logger: Logger;
  onMessagesUpsert?: MessagesUpsertHandler;
};

export type WhatsAppConnection = {
  stop(): Promise<void>;
};

// Phase 2: fixed delay. Exponential backoff comes in phase 4.
const RECONNECT_DELAY_MS = 5_000;

// Reconnecting after these would either never succeed (logged out) or fight
// another instance that uses the same session (connection replaced).
const FATAL_DISCONNECTS = new Set<number>([
  DisconnectReason.loggedOut,
  DisconnectReason.connectionReplaced,
]);

// Baileys reports disconnect reasons as Boom errors: error.output.statusCode.
function disconnectStatusCode(error: Error | undefined): number | undefined {
  return (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
}

async function printQr(qr: string): Promise<void> {
  // Written straight to stdout, not to the logger: the QR payload is pairing material.
  process.stdout.write(await QRCode.toString(qr, { type: 'terminal', small: true }));
}

export async function startWhatsApp(options: WhatsAppOptions): Promise<WhatsAppConnection> {
  const { sessionDir, logger, onMessagesUpsert } = options;
  const log = logger.child({ module: 'whatsapp' });
  const baileysLogger = createBaileysLogger(logger);

  // The session files grant full access to the account: owner-only permissions.
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  let sock: WASocket | undefined;
  let stopped = false;
  let reconnectTimer: NodeJS.Timeout | undefined;

  const connect = (): void => {
    const s = makeWASocket({
      auth: state,
      logger: baileysLogger,
      // Read-only: never show as online, never request the full chat history.
      // The default recent/bootstrap sync stays on: Baileys needs it for LID mappings,
      // and those history messages arrive via 'messaging-history.set', which we ignore.
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    sock = s;

    s.ev.on('creds.update', () => {
      saveCreds().catch((err: unknown) => log.error({ err }, 'failed to save credentials'));
    });

    s.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        log.info('scan the QR code below with WhatsApp > Linked devices > Link a device');
        printQr(qr).catch((err: unknown) => log.error({ err }, 'failed to render QR code'));
      }

      if (connection === 'open') {
        log.info('connected to WhatsApp');
        return;
      }
      if (connection !== 'close' || stopped) return;

      const code = disconnectStatusCode(lastDisconnect?.error);
      if (code !== undefined && FATAL_DISCONNECTS.has(code)) {
        log.error(
          { code },
          code === DisconnectReason.loggedOut
            ? 'session logged out; delete the session folder and restart to pair again'
            : 'session opened elsewhere (another instance running?); not reconnecting',
        );
        return;
      }

      // 515 right after pairing is expected: WhatsApp asks for a fresh connection.
      const delayMs = code === DisconnectReason.restartRequired ? 0 : RECONNECT_DELAY_MS;
      log.warn({ code, delayMs }, 'connection closed, reconnecting');
      reconnectTimer = setTimeout(connect, delayMs);
    });

    if (onMessagesUpsert) {
      s.ev.on('messages.upsert', (event) => {
        try {
          onMessagesUpsert(event, s);
        } catch (err) {
          log.error({ err }, 'messages.upsert handler failed');
        }
      });
    }
  };

  connect();

  return {
    async stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      // end() closes the socket but keeps the session. Never call logout(): it unlinks the device.
      await sock?.end(undefined);
    },
  };
}
