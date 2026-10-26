import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { WAMessage } from 'baileys';
import { mediaFileName, prepareMediaDir, type DownloadMedia } from '../src/whatsapp/media.js';
import { extractText, messageType, normalize } from '../src/whatsapp/normalize.js';
import { captureLogger, silentLogger } from './helpers.js';

const MB = 1024 * 1024;
const TS = 1761480000; // seconds

const wa = (id: string | undefined, message: object | null, extra: object = {}): WAMessage =>
  ({ key: { id }, messageTimestamp: TS, message, ...extra }) as WAMessage;

const wrapped = (wrapper: string, inner: object) => ({ [wrapper]: { message: inner } });

// Fake downloader: writes a tiny file and reports `bytes` as its size.
function fakeDownload(bytes: number): DownloadMedia & { calls: number } {
  const fn = async (_msg: WAMessage, filePath: string) => {
    fn.calls++;
    await writeFile(filePath, 'x');
    return bytes;
  };
  fn.calls = 0;
  return fn;
}

let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'relay-test-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('extractText / messageType', () => {
  it('reads plain and extended text', () => {
    assert.equal(extractText(wa('A', { conversation: 'plain' })), 'plain');
    assert.equal(extractText(wa('A', { extendedTextMessage: { text: 'link https://x.y' } })), 'link https://x.y');
  });

  it('unwraps disappearing messages', () => {
    assert.equal(extractText(wa('A', wrapped('ephemeralMessage', { conversation: 'gone soon' }))), 'gone soon');
    assert.equal(messageType(wa('A', wrapped('ephemeralMessage', { conversation: 'x' }))), 'conversation');
  });

  it('treats empty text, captions and missing content as no text', () => {
    assert.equal(extractText(wa('A', { conversation: '' })), undefined);
    assert.equal(extractText(wa('A', { imageMessage: { caption: 'cap' } })), undefined);
    assert.equal(extractText(wa('A', null)), undefined);
  });

  it('names the content type for logs', () => {
    assert.equal(messageType(wa('A', { imageMessage: {} })), 'imageMessage');
    assert.equal(messageType(wa('A', null)), 'unknown');
  });
});

describe('normalize: text', () => {
  const opts = () => ({ mediaDir: dir, privatePrefix: '#gizli', logger: silentLogger });

  it('builds a text RelayMessage with a millisecond timestamp', async () => {
    assert.deepEqual(await normalize(wa('A1', { conversation: 'hey' }), opts()), {
      id: 'A1',
      timestamp: TS * 1000,
      type: 'text',
      text: 'hey',
    });
  });

  it('accepts a protobuf Long timestamp', async () => {
    // Shaped like protobufjs' Long (what Baileys' toNumber reads), without depending on 'long'.
    const long = { low: TS, high: 0, unsigned: true, toNumber: () => TS };
    const m = wa('A2', { conversation: 'x' }, { messageTimestamp: long });
    assert.equal((await normalize(m, opts()))?.timestamp, TS * 1000);
  });

  it('falls back to now when the timestamp is missing', async () => {
    const before = Date.now();
    const r = await normalize(wa('A3', { conversation: 'x' }, { messageTimestamp: undefined }), opts());
    assert.ok(r && r.timestamp >= before);
  });

  it('drops messages without an ID', async () => {
    assert.equal(await normalize(wa(undefined, { conversation: 'x' }), opts()), undefined);
  });

  it('drops unsupported types (e.g. stickers, video)', async () => {
    assert.equal(await normalize(wa('A4', { stickerMessage: {} }), opts()), undefined);
    assert.equal(await normalize(wa('A5', { videoMessage: {} }), opts()), undefined);
  });
});

describe('normalize: photos', () => {
  it('downloads a photo and keeps its caption', async () => {
    const download = fakeDownload(2 * MB);
    const r = await normalize(
      wa('P1', { imageMessage: { mimetype: 'image/jpeg', fileLength: 2 * MB, caption: 'beach' } }),
      { mediaDir: dir, privatePrefix: '#gizli', logger: silentLogger, download },
    );
    assert.equal(r?.type, 'image');
    assert.equal(r?.text, 'beach');
    assert.deepEqual(r?.media, { path: path.join(dir, 'P1.jpg'), mimeType: 'image/jpeg', size: 2 * MB });
    assert.ok(existsSync(path.join(dir, 'P1.jpg')));
    assert.equal(download.calls, 1);
  });

  it('relays view-once photos like normal ones', async () => {
    const r = await normalize(
      wa('P2', wrapped('viewOnceMessageV2', { imageMessage: { mimetype: 'image/jpeg', viewOnce: true } })),
      { mediaDir: dir, privatePrefix: '#gizli', logger: silentLogger, download: fakeDownload(MB) },
    );
    assert.equal(r?.type, 'image');
    assert.equal(r?.text, undefined);
  });

  it('never downloads a photo announced over the limit; sends a notice with the caption', async () => {
    const download = fakeDownload(60 * MB);
    const r = await normalize(wa('P3', { imageMessage: { fileLength: 60 * MB, caption: 'huge' } }), {
      mediaDir: dir, privatePrefix: '#gizli',
      logger: silentLogger,
      download,
    });
    assert.equal(download.calls, 0);
    assert.deepEqual(r, {
      id: 'P3',
      timestamp: TS * 1000,
      type: 'text',
      text: '[Photo not relayed, 60.0 MB is over the 50.0 MB limit]\nhuge',
    });
  });

  it('deletes a download that turns out to be over the limit', async () => {
    const r = await normalize(wa('P4', { imageMessage: {} }), {
      mediaDir: dir, privatePrefix: '#gizli',
      logger: silentLogger,
      download: fakeDownload(51 * MB),
    });
    assert.equal(r?.type, 'text');
    assert.ok(!existsSync(path.join(dir, 'P4.jpg')));
  });

  it('drops a failed download and logs only id + error name (Baileys errors can carry the message)', async () => {
    const { logger, output } = captureLogger();
    const failing: DownloadMedia = async () => {
      throw Object.assign(new Error('boom'), { name: 'TimeoutError', data: { caption: 'SECRET CAPTION' } });
    };
    const r = await normalize(wa('P5', { imageMessage: { caption: 'SECRET CAPTION' } }), {
      mediaDir: dir, privatePrefix: '#gizli',
      logger,
      download: failing,
    });
    assert.equal(r, undefined);
    assert.match(output(), /P5/);
    assert.match(output(), /TimeoutError/);
    assert.doesNotMatch(output(), /SECRET/);
  });
});

describe('normalize: documents', () => {
  it('keeps the original file name for Telegram, names the file on disk after the ID', async () => {
    const r = await normalize(
      wa('D1', { documentMessage: { fileName: 'Fatura Ekim.pdf', mimetype: 'application/pdf', fileLength: 300_000 } }),
      { mediaDir: dir, privatePrefix: '#gizli', logger: silentLogger, download: fakeDownload(300_000) },
    );
    assert.equal(r?.type, 'document');
    assert.deepEqual(r?.media, {
      path: path.join(dir, 'D1.pdf'),
      mimeType: 'application/pdf',
      size: 300_000,
      fileName: 'Fatura Ekim.pdf',
    });
  });

  it('uses the title when there is no file name, and the caption of a wrapped document', async () => {
    const r = await normalize(
      wa('D2', wrapped('documentWithCaptionMessage', { documentMessage: { title: 'notes', mimetype: 'text/plain', caption: 'read me' } })),
      { mediaDir: dir, privatePrefix: '#gizli', logger: silentLogger, download: fakeDownload(10) },
    );
    assert.equal(r?.media?.fileName, 'notes');
    assert.equal(r?.text, 'read me');
  });

  it('works without any name', async () => {
    const r = await normalize(wa('D3', { documentMessage: { mimetype: 'application/zip' } }), {
      mediaDir: dir, privatePrefix: '#gizli',
      logger: silentLogger,
      download: fakeDownload(10),
    });
    assert.equal(r?.media?.fileName, undefined);
    assert.equal(r?.media?.path, path.join(dir, 'D3.bin'));
  });

  it('sends a notice with the file name when over the limit', async () => {
    const download = fakeDownload(700 * MB);
    const r = await normalize(
      wa('D4', { documentMessage: { fileName: 'big.iso', fileLength: 700 * MB, caption: 'c' } }),
      { mediaDir: dir, privatePrefix: '#gizli', logger: silentLogger, download },
    );
    assert.equal(download.calls, 0);
    assert.equal(r?.text, '[Document not relayed: big.iso, 700.0 MB is over the 50.0 MB limit]\nc');
  });

  it('keeps a photo sent "as document" a document (original quality)', async () => {
    const r = await normalize(wa('D5', { documentMessage: { fileName: 'photo.jpg', mimetype: 'image/jpeg' } }), {
      mediaDir: dir, privatePrefix: '#gizli',
      logger: silentLogger,
      download: fakeDownload(5 * MB),
    });
    assert.equal(r?.type, 'document');
  });
});

describe('mediaFileName', () => {
  it('maps known MIME types, falls back to .bin', () => {
    assert.equal(mediaFileName('3EB0ABC', 'image/png'), '3EB0ABC.png');
    assert.equal(mediaFileName('A', 'image/heic'), 'A.bin');
  });

  it('takes a sane extension from the original name', () => {
    assert.equal(mediaFileName('A', 'application/octet-stream', 'Rapor 2026.DOCX'), 'A.docx');
    assert.equal(mediaFileName('A', 'application/pdf', 'no-extension'), 'A.pdf');
    assert.equal(mediaFileName('A', 'text/plain', 'x.weird ext!'), 'A.bin');
  });

  it('never lets the ID or the original name escape the media folder', () => {
    assert.equal(mediaFileName('../../etc/x', 'image/jpeg'), '______etc_x.jpg');
    assert.equal(mediaFileName('A', 'text/plain', '../../evil.sh'), 'A.sh');
  });
});

describe('prepareMediaDir', () => {
  it('removes leftover files but never folders', async () => {
    const media = path.join(dir, 'prep');
    await mkdir(path.join(media, 'keep-me'), { recursive: true });
    await writeFile(path.join(media, 'leftover.jpg'), 'x');
    await prepareMediaDir(media);
    assert.deepEqual(await readdir(media), ['keep-me']);
  });

  it('creates the folder when missing', async () => {
    const media = path.join(dir, 'new', 'media');
    await prepareMediaDir(media);
    assert.ok(existsSync(media));
  });
});

describe('normalize: private prefix', () => {
  it('drops a private text and logs only id + type', async () => {
    const { logger, output } = captureLogger();
    const r = await normalize(wa('S1', { conversation: '  #Gizli şifrem 1234' }), {
      mediaDir: dir,
      privatePrefix: '#gizli',
      logger,
    });
    assert.equal(r, undefined);
    assert.match(output(), /private message not relayed/);
    assert.match(output(), /S1/);
    assert.doesNotMatch(output(), /şifrem|1234/);
  });

  it('drops a photo with a private caption without downloading it', async () => {
    const download = fakeDownload(MB);
    const r = await normalize(wa('S2', { imageMessage: { caption: '#gizli kimlik' } }), {
      mediaDir: dir,
      privatePrefix: '#gizli',
      logger: silentLogger,
      download,
    });
    assert.equal(r, undefined);
    assert.equal(download.calls, 0);
  });

  it('drops a document with a private caption without downloading it', async () => {
    const download = fakeDownload(MB);
    const r = await normalize(
      wa('S3', wrapped('documentWithCaptionMessage', { documentMessage: { fileName: 'pasaport.pdf', caption: '#GİZLİ' } })),
      { mediaDir: dir, privatePrefix: '#gizli', logger: silentLogger, download },
    );
    assert.equal(r, undefined);
    assert.equal(download.calls, 0);
  });

  it('sends no "too large" notice for an oversized private file (the notice would leak the caption)', async () => {
    const r = await normalize(wa('S4', { documentMessage: { fileName: 'x.iso', fileLength: 900 * MB, caption: '#gizli' } }), {
      mediaDir: dir,
      privatePrefix: '#gizli',
      logger: silentLogger,
      download: fakeDownload(900 * MB),
    });
    assert.equal(r, undefined);
  });

  it('still relays media without a caption, and captions that only mention the prefix later', async () => {
    const opts = { mediaDir: dir, privatePrefix: '#gizli', logger: silentLogger, download: fakeDownload(MB) };
    assert.equal((await normalize(wa('S5', { imageMessage: {} }), opts))?.type, 'image');
    assert.equal((await normalize(wa('S6', { imageMessage: { caption: 'not #gizli' } }), opts))?.type, 'image');
  });
});
