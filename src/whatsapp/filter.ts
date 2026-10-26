import {
  getContentType,
  jidNormalizedUser,
  normalizeMessageContent,
  type BaileysEventMap,
  type Contact,
  type WAMessage,
} from 'baileys';

// Our own account can show up as a phone-number JID (...@s.whatsapp.net) or a LID (...@lid).
// Both are normalized (device suffix like ":12" stripped) so they compare exactly.
export function ownJids(user: Contact | undefined): Set<string> {
  const jids = new Set<string>();
  for (const jid of [user?.id, user?.lid]) {
    const normalized = jidNormalizedUser(jid ?? undefined);
    if (normalized) jids.add(normalized);
  }
  return jids;
}

export function isSelfChatMessage(msg: WAMessage, own: Set<string>): boolean {
  if (msg.key.fromMe !== true) return false;
  // remoteJidAlt carries the other addressing form (LID <-> phone number) when WhatsApp sends both.
  return [msg.key.remoteJid, msg.key.remoteJidAlt].some((jid) => {
    const normalized = jidNormalizedUser(jid ?? undefined);
    return normalized !== '' && own.has(normalized);
  });
}

// Only live messages ('notify'). 'append' covers history and messages queued while offline.
export function selfChatMessages(
  event: BaileysEventMap['messages.upsert'],
  user: Contact | undefined,
): WAMessage[] {
  if (event.type !== 'notify') return [];
  const own = ownJids(user);
  if (own.size === 0) return [];
  return event.messages.filter((msg) => isSelfChatMessage(msg, own));
}

// Content type for logging (e.g. "conversation", "imageMessage"), never the content itself.
export function messageType(msg: WAMessage): string {
  return getContentType(normalizeMessageContent(msg.message)) ?? 'unknown';
}

export function extractText(msg: WAMessage): string | undefined {
  const content = normalizeMessageContent(msg.message);
  return content?.conversation || content?.extendedTextMessage?.text || undefined;
}
