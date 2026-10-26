import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BaileysEventMap, Contact, WAMessage } from 'baileys';
import { isPrivate, ownJids, selfChatMessages } from '../src/whatsapp/filter.js';

const me: Contact = { id: '905551112233:12@s.whatsapp.net', lid: '123456789012345:12@lid' };

const msg = (key: Partial<WAMessage['key']>): WAMessage =>
  ({ key: { id: 'X', ...key }, message: { conversation: 'hi' } }) as WAMessage;

const passes = (
  m: WAMessage,
  type: BaileysEventMap['messages.upsert']['type'] = 'notify',
  user: Contact | undefined = me,
): boolean => selfChatMessages({ messages: [m], type }, user).length === 1;

describe('ownJids', () => {
  it('normalizes both the phone-number JID and the LID (device suffix stripped)', () => {
    assert.deepEqual([...ownJids(me)], ['905551112233@s.whatsapp.net', '123456789012345@lid']);
  });

  it('is empty when the user is not known yet', () => {
    assert.equal(ownJids(undefined).size, 0);
  });
});

describe('selfChatMessages: passes', () => {
  it('own phone-number JID', () => {
    assert.ok(passes(msg({ fromMe: true, remoteJid: '905551112233@s.whatsapp.net' })));
  });

  it('own LID', () => {
    assert.ok(passes(msg({ fromMe: true, remoteJid: '123456789012345@lid' })));
  });

  it('unknown LID whose remoteJidAlt is our phone-number JID', () => {
    assert.ok(passes(msg({ fromMe: true, remoteJid: '999@lid', remoteJidAlt: '905551112233@s.whatsapp.net' })));
  });
});

describe('selfChatMessages: drops', () => {
  const cases: [string, WAMessage][] = [
    ['our message to someone else', msg({ fromMe: true, remoteJid: '905559998877@s.whatsapp.net' })],
    ['not fromMe, even in our own JID', msg({ fromMe: false, remoteJid: '905551112233@s.whatsapp.net' })],
    ['fromMe missing', msg({ remoteJid: '905551112233@s.whatsapp.net' })],
    ['our message in a group', msg({ fromMe: true, remoteJid: '120363000000@g.us', participant: '905551112233@s.whatsapp.net' })],
    ['our status update', msg({ fromMe: true, remoteJid: 'status@broadcast' })],
    ['a number that only starts like ours', msg({ fromMe: true, remoteJid: '9055511122334@s.whatsapp.net' })],
    ['same digits on a different server', msg({ fromMe: true, remoteJid: '905551112233@lid' })],
    ['null remoteJid', msg({ fromMe: true, remoteJid: null })],
  ];
  for (const [name, m] of cases) {
    it(name, () => assert.equal(passes(m), false));
  }

  it("'append' messages (history, offline queue)", () => {
    assert.equal(passes(msg({ fromMe: true, remoteJid: '905551112233@s.whatsapp.net' }), 'append'), false);
  });

  it('anything while our own identity is unknown', () => {
    const event = { messages: [msg({ fromMe: true, remoteJid: '905551112233@s.whatsapp.net' })], type: 'notify' as const };
    assert.equal(selfChatMessages(event, undefined).length, 0);
  });

  it('a LID chat when our own LID is unknown', () => {
    assert.equal(passes(msg({ fromMe: true, remoteJid: '123456789012345@lid' }), 'notify', { id: me.id }), false);
  });
});

describe('isPrivate', () => {
  const P = '#gizli';

  it('matches the prefix at the start', () => {
    assert.ok(isPrivate('#gizli şifrem 1234', P));
    assert.ok(isPrivate('#gizli', P));
  });

  it('ignores leading whitespace and invisible characters', () => {
    assert.ok(isPrivate('   #gizli x', P));
    assert.ok(isPrivate('\n\t#gizli x', P));
    assert.ok(isPrivate('\u00A0#gizli x', P), 'no-break space');
    assert.ok(isPrivate('\u200B#gizli x', P), 'zero-width space');
    assert.ok(isPrivate('\uFEFF#gizli x', P), 'BOM');
  });

  it('is case-insensitive the Turkish way, including dotless/dotted I', () => {
    for (const t of ['#Gizli x', '#GİZLİ x', '#GIZLI x', '#gızlı x', '#GiZlİ x']) {
      assert.ok(isPrivate(t, P), t);
    }
  });

  it('treats decomposed letters like composed ones', () => {
    const decomposed = '#GI\u0307ZLI\u0307 x'; // I + combining dot above, instead of İ
    assert.ok(isPrivate(decomposed, P));
  });

  it('also catches words that start with the prefix (errs on the side of not relaying)', () => {
    assert.ok(isPrivate('#gizlilik ayarları', P));
  });

  it('does not match the prefix elsewhere in the text', () => {
    assert.equal(isPrivate('bu #gizli değil', P), false);
    assert.equal(isPrivate('gizli', P), false, 'no #');
    assert.equal(isPrivate('# gizli', P), false, 'space inside the prefix');
  });

  it('handles empty input and odd prefixes', () => {
    assert.equal(isPrivate(undefined, P), false);
    assert.equal(isPrivate('', P), false);
    assert.equal(isPrivate('anything', '   '), false, 'blank prefix matches nothing');
    assert.ok(isPrivate('#GİZLİ x', ' #Gizli '), 'configured prefix is trimmed and folded too');
  });
});
