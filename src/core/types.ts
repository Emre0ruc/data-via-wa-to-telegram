// The only contract between the whatsapp and telegram modules.
// Neither module knows about the other; both only know this type.

export type RelayMessageType = 'text' | 'image' | 'video' | 'voice' | 'document';

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
