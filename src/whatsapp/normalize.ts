import { getContentType, normalizeMessageContent, toNumber, type WAMessage } from 'baileys';
import type { RelayMessage } from '../core/types.js';

// Content type for logging (e.g. "conversation", "imageMessage"), never the content itself.
export function messageType(msg: WAMessage): string {
  return getContentType(normalizeMessageContent(msg.message)) ?? 'unknown';
}

// Unwraps ephemeral/view-once wrappers, then reads plain or extended (link, formatting) text.
export function extractText(msg: WAMessage): string | undefined {
  const content = normalizeMessageContent(msg.message);
  return content?.conversation || content?.extendedTextMessage?.text || undefined;
}

// Returns undefined for anything we don't relay yet (media comes in phase 5).
export function normalize(msg: WAMessage): RelayMessage | undefined {
  const id = msg.key.id;
  if (!id) return undefined;

  const text = extractText(msg);
  if (text === undefined) return undefined;

  // WhatsApp sends seconds, sometimes as a protobuf Long; toNumber handles both (0 if missing).
  const seconds = toNumber(msg.messageTimestamp);
  return {
    id,
    timestamp: seconds > 0 ? seconds * 1000 : Date.now(),
    type: 'text',
    text,
  };
}
