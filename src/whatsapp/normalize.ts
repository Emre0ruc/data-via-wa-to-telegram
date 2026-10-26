import { rm } from 'node:fs/promises';
import path from 'node:path';
import { getContentType, normalizeMessageContent, toNumber, type WAMessage } from 'baileys';
import { MAX_MEDIA_BYTES, type RelayMessage, type RelayMessageType } from '../core/types.js';
import type { Logger } from '../logger.js';
import { downloadMedia, mediaFileName, type DownloadMedia } from './media.js';

export type NormalizeOptions = {
  mediaDir: string;
  logger: Logger;
  download?: DownloadMedia; // injectable for tests
};

// Content type for logging (e.g. "conversation", "imageMessage"), never the content itself.
export function messageType(msg: WAMessage): string {
  return getContentType(normalizeMessageContent(msg.message)) ?? 'unknown';
}

// Unwraps ephemeral/view-once wrappers, then reads plain or extended (link, formatting) text.
export function extractText(msg: WAMessage): string | undefined {
  const content = normalizeMessageContent(msg.message);
  return content?.conversation || content?.extendedTextMessage?.text || undefined;
}

// Baileys errors can carry the whole message (Boom.data), so only name and status are logged.
function describeError(err: unknown): { name: string; status?: number } {
  const e = err as { name?: unknown; status?: unknown; output?: { statusCode?: unknown } } | null;
  const status = e?.output?.statusCode ?? e?.status;
  return {
    name: typeof e?.name === 'string' ? e.name : typeof err,
    ...(typeof status === 'number' ? { status } : {}),
  };
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type MediaInfo = {
  type: Extract<RelayMessageType, 'image' | 'document'>;
  label: string; // used in the "not relayed" notice
  waType: string; // for logs
  mimeType: string;
  announcedSize: number; // 0 if WhatsApp did not say
  caption?: string;
  fileName?: string;
};

// Returns undefined for anything that is not relayed (unsupported type, failed download).
// Never throws.
export async function normalize(
  msg: WAMessage,
  options: NormalizeOptions,
): Promise<RelayMessage | undefined> {
  const { mediaDir, logger, download = downloadMedia } = options;
  const log = logger.child({ module: 'whatsapp' });

  const id = msg.key.id;
  if (!id) return undefined;

  // WhatsApp sends seconds, sometimes as a protobuf Long; toNumber handles both (0 if missing).
  const seconds = toNumber(msg.messageTimestamp);
  const timestamp = seconds > 0 ? seconds * 1000 : Date.now();

  const text = extractText(msg);
  if (text !== undefined) return { id, timestamp, type: 'text', text };

  const content = normalizeMessageContent(msg.message);
  let info: MediaInfo | undefined;
  if (content?.imageMessage) {
    const image = content.imageMessage;
    info = {
      type: 'image',
      label: 'Photo',
      waType: 'imageMessage',
      mimeType: image.mimetype || 'image/jpeg',
      announcedSize: toNumber(image.fileLength),
      caption: image.caption || undefined,
    };
  } else if (content?.documentMessage) {
    const doc = content.documentMessage;
    info = {
      type: 'document',
      label: 'Document',
      waType: 'documentMessage',
      mimeType: doc.mimetype || 'application/octet-stream',
      announcedSize: toNumber(doc.fileLength),
      caption: doc.caption || undefined,
      fileName: doc.fileName || doc.title || undefined,
    };
  }
  if (!info) {
    log.info({ id, type: messageType(msg) }, 'self-chat message not relayed (unsupported type)');
    return undefined;
  }

  const { caption, fileName, mimeType } = info;
  const tooLarge = (bytes: number): RelayMessage => ({
    id,
    timestamp,
    type: 'text',
    text: `[${info.label} not relayed${fileName ? `: ${fileName}` : ''}, ${formatMb(bytes)} is over the ${formatMb(MAX_MEDIA_BYTES)} limit]`
      + (caption ? `\n${caption}` : ''),
  });

  // Check the announced size first, so oversized files are never downloaded.
  if (info.announcedSize > MAX_MEDIA_BYTES) return tooLarge(info.announcedSize);

  const filePath = path.join(mediaDir, mediaFileName(id, mimeType, fileName));
  let size: number;
  try {
    size = await download(msg, filePath);
  } catch (err) {
    log.error({ id, type: info.waType, error: describeError(err) }, 'media download failed, message dropped');
    return undefined;
  }
  if (size > MAX_MEDIA_BYTES) {
    await rm(filePath, { force: true });
    return tooLarge(size);
  }
  return {
    id,
    timestamp,
    type: info.type,
    text: caption,
    media: { path: filePath, mimeType, size, ...(fileName ? { fileName } : {}) },
  };
}
