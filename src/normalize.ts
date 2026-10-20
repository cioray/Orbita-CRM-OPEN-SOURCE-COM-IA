import { hash, record, sanitize, string, type JsonRecord } from './util.js';

export interface NormalizedMessage {
  sourceId: string;
  jid: string;
  alternateJid: string | null;
  fromMe: boolean;
  kind: string;
  body: string | null;
  occurredAt: string | null;
  sourceTimestamp: number | null;
  replyTo: string | null;
  displayName: string | null;
  contentHash: string;
  raw: JsonRecord;
  media: null | { mime: string | null; filename: string | null; bytes: number | null };
}

export const isPrivateJid = (jid: unknown): jid is string => typeof jid === 'string' && /^(\d+)(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(jid);

function numeric(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number(record(value).low);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function unwrap(input: JsonRecord): JsonRecord {
  let current = input;
  for (let depth = 0; depth < 6; depth++) {
    const wrapped = current.ephemeralMessage ?? current.viewOnceMessage ?? current.viewOnceMessageV2 ?? current.documentWithCaptionMessage;
    const next = record(record(wrapped).message);
    if (!Object.keys(next).length) break;
    current = next;
  }
  return current;
}

export function normalizeMessage(input: unknown): NormalizedMessage | null {
  const raw = record(sanitize(input));
  const key = record(raw.key);
  const sourceId = string(key.id);
  const jid = string(key.remoteJid);
  if (!sourceId || !isPrivateJid(jid) || typeof key.fromMe !== 'boolean') return null;
  const content = unwrap(record(raw.editedMessage ?? raw.message));
  let kind = 'unsupported';
  let body = string(content.conversation) ?? string(record(content.extendedTextMessage).text);
  let media: NormalizedMessage['media'] = null;
  let context = record(record(content.extendedTextMessage).contextInfo ?? raw.contextInfo);
  if (body !== null) kind = 'text';
  for (const [field, mediaKind] of [['audioMessage', 'audio'], ['documentMessage', 'document'], ['imageMessage', 'image'], ['videoMessage', 'video'], ['stickerMessage', 'sticker']] as const) {
    if (!content[field]) continue;
    const data = record(content[field]);
    kind = mediaKind;
    body = string(data.caption);
    context = record(data.contextInfo ?? context);
    media = { mime: string(data.mimetype), filename: string(data.fileName), bytes: numeric(data.fileLength) };
    break;
  }
  if (content.reactionMessage) {
    kind = 'reaction';
    body = string(record(content.reactionMessage).text);
    context = { stanzaId: record(record(content.reactionMessage).key).id };
  }
  const timestamp = numeric(raw.messageTimestamp);
  const occurredAt = timestamp !== null && timestamp < 8640000000000 ? new Date(timestamp * 1000).toISOString() : null;
  return {
    sourceId, jid, alternateJid: isPrivateJid(key.remoteJidAlt) ? key.remoteJidAlt : null,
    fromMe: key.fromMe, kind, body, occurredAt, sourceTimestamp: timestamp,
    replyTo: string(context.stanzaId), displayName: key.fromMe ? null : string(raw.pushName),
    contentHash: hash({ kind, body, content }), raw, media
  };
}

export function eventRecords(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const object = record(data);
  if (Array.isArray(object.messages)) return object.messages;
  return [data];
}

export function eventName(value: unknown): string {
  return (string(value) ?? 'unknown').toLowerCase().replace(/[_-]/g, '.');
}
