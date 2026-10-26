import { jidNormalizedUser, type BaileysEventMap, type Contact, type WAMessage } from 'baileys';

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

// Case-insensitive the Turkish way: GİZLİ and gizli match, and dotless ı is folded to i so
// GIZLI (typed on an English keyboard) matches too. NFC so composed/decomposed letters agree.
function fold(s: string): string {
  return s.normalize('NFC').toLocaleLowerCase('tr').replace(/ı/g, 'i');
}

// Whitespace plus invisible characters that sneak in with copy-paste (zero-width, BOM).
const LEADING_BLANKS = /^[\s\u200B-\u200D\u2060\uFEFF]+/;

// True if the text (a message or a media caption) starts with the private prefix. Errs on
// the side of not relaying: leading blanks are ignored and "#gizlilik" counts as private too.
export function isPrivate(text: string | undefined, prefix: string): boolean {
  if (!text) return false;
  const p = fold(prefix.trim());
  return p !== '' && fold(text.replace(LEADING_BLANKS, '')).startsWith(p);
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
