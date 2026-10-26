import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { downloadMediaMessage, type WAMessage } from 'baileys';

const DOWNLOAD_TIMEOUT_MS = 2 * 60_000;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};

// The file on disk is always named after the message ID (never the sender-supplied name,
// which could contain path separators). The extension comes from the original name if it
// has a sane one, otherwise from the MIME type.
export function mediaFileName(id: string, mimeType: string, originalName?: string): string {
  const safeId = id.replace(/[^A-Za-z0-9_-]/g, '_');
  const fromName = originalName ? path.extname(originalName).slice(1).toLowerCase() : '';
  const ext = /^[a-z0-9]{1,10}$/.test(fromName) ? fromName : (EXTENSIONS[mimeType] ?? 'bin');
  return `${safeId}.${ext}`;
}

// Creates the media folder and removes leftovers from a previous run. Only plain files
// directly inside it are deleted, never folders, so a misconfigured path can't wipe anything.
export async function prepareMediaDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile()) await rm(path.join(dir, entry.name), { force: true });
  }
}

export type DownloadMedia = (msg: WAMessage, filePath: string) => Promise<number>;

// Streams straight to disk, so a large file never sits in memory. Returns the size in bytes.
export const downloadMedia: DownloadMedia = async (msg, filePath) => {
  try {
    // No reupload context on purpose: re-requesting expired media sends a request to the phone.
    const stream = await downloadMediaMessage(msg, 'stream', {
      options: { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) },
    });
    await pipeline(stream, createWriteStream(filePath, { mode: 0o600 }));
    return (await stat(filePath)).size;
  } catch (err) {
    await rm(filePath, { force: true });
    throw err;
  }
};
