import { describe, expect, it } from 'vitest';
import { eventRecords, isPrivateJid, normalizeMessage } from '../src/normalize.js';
import { hash, sanitize, secretMatches } from '../src/util.js';

const message = { key: { id: 'one', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false }, message: { conversation: 'Olá 👋' }, messageTimestamp: 1700000000 };

describe('private message normalization', () => {
  it('rejects groups, status, broadcasts and malformed identities', () => {
    for (const jid of ['123@g.us', 'status@broadcast', 'x@s.whatsapp.net', '123@newsletter', '123']) expect(isPrivateJid(jid)).toBe(false);
    expect(isPrivateJid('12345@lid')).toBe(true);
    expect(normalizeMessage({ ...message, key: { ...message.key, remoteJid: '123@g.us' } })).toBeNull();
    expect(normalizeMessage({ ...message, key: { ...message.key, remoteJid: '120363000000000@g.us', participant:'12345@lid', participantAlt:'5511999999999@s.whatsapp.net', remoteJidAlt:'5511999999999@s.whatsapp.net' } })).toBeNull();
  });
  it('keeps direction and source identity independent of content', () => {
    expect(normalizeMessage(message)).toMatchObject({ sourceId: 'one', fromMe: false, body: 'Olá 👋', kind: 'text' });
    expect(normalizeMessage({ ...message, key: { ...message.key, fromMe: true } })?.fromMe).toBe(true);
  });
  it('unwraps audio and document captions', () => {
    const result = normalizeMessage({ ...message, message: { documentWithCaptionMessage: { message: { documentMessage: { mimetype: 'application/pdf', fileLength: '1234', caption: 'Contrato', fileName: 'contrato.pdf' } } } } });
    expect(result).toMatchObject({ kind: 'document', body: 'Contrato', media: { mime: 'application/pdf', bytes: 1234 } });
  });
  it('handles edit payloads without inventing source time', () => {
    expect(normalizeMessage({ key: message.key, editedMessage: { conversation: 'Corrigido' } })).toMatchObject({ body: 'Corrigido', occurredAt: null });
  });
  it('normalizes single and batched events', () => {
    expect(eventRecords({ messages: [message] })).toEqual([message]);
    expect(eventRecords(message)).toEqual([message]);
  });
});

describe('secret handling and deduplication', () => {
  it('strips transport credentials recursively without stripping message keys', () => {
    expect(sanitize({ apikey: 'secret', data: { authorization: 'secret', key: { id: 'one' }, base64: 'bytes' } })).toEqual({ data: { key: { id: 'one' } } });
  });
  it('canonicalizes object order, preserving array order and revisions', () => {
    expect(hash({ name: 'one', status: 'read' })).toBe(hash({ status: 'read', name: 'one' }));
    expect(hash({ name: 'one', status: 'read' })).not.toBe(hash({ name: 'one', status: 'sent' }));
  });
  it('compares secrets without accepting absent values', () => {
    expect(secretMatches('test', 'test')).toBe(true);
    expect(secretMatches(undefined, 'test')).toBe(false);
    expect(secretMatches('bad', 'test')).toBe(false);
  });
});
