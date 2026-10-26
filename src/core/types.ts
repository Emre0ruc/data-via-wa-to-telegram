// The only contract between the whatsapp and telegram modules.
// Neither module knows about the other; both only know this type.

export type RelayMessageType = 'text' | 'image' | 'video' | 'voice' | 'document';

// Largest file the relay carries: the Telegram Bot API upload limit. Bigger media is
// replaced by a short notice instead of being downloaded.
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

export type RelayMedia = {
  path: string; // temporary file under data/media
  mimeType: string;
  fileName?: string;
  size: number;
};

export type RelayMessage = {
  id: string; // WhatsApp message ID
  timestamp: number; // unix ms
  type: RelayMessageType;
  text?: string; // message text or media caption
  media?: RelayMedia;
};
