import type { Database, Transaction } from './db.js';
import { enqueue } from './jobs.js';
import { eventName, eventRecords, isPrivateJid, normalizeMessage, type NormalizedMessage } from './normalize.js';
import { AppError, hash, record, sanitize, string, type JsonRecord } from './util.js';

const messageEvents = new Set(['messages.set', 'messages.upsert', 'send.message', 'messages.edited']);
const keyEvents = new Set(['messages.delete', 'messages.update', 'send.message.update']);

export async function acceptWebhook(db: Database, tenantId: string, connectionId: string, body: unknown) {
  const envelope = record(body);
  const type = eventName(envelope.event);
  return db.tx(tenantId, async transaction => {
    const connections = await transaction.query('SELECT instance_name FROM connections WHERE id=$1 AND enabled', [connectionId]);
    if (!connections.rowCount) throw new AppError('connection_not_found', 404);
    if (envelope.instance !== connections.rows[0].instance_name) throw new AppError('instance_mismatch', 403);
    let payload: unknown;
    let ignored = 0;
    let status = 'pending';
    if (messageEvents.has(type)) {
      const all = eventRecords(envelope.data);
      const accepted = all.filter(item => normalizeMessage(item) !== null);
      ignored = all.length - accepted.length;
      payload = accepted.map(item => sanitize(item));
    } else if (keyEvents.has(type)) {
      const all = eventRecords(envelope.data);
      const accepted = all.filter(item => {
        const data = record(item);
        const key = record(data.key ?? data);
        return isPrivateJid(key.remoteJid) && !!string(key.id ?? data.keyId);
      });
      ignored = all.length - accepted.length;
      payload = accepted.map(item => sanitize(item));
    } else if (type === 'connection.update') {
      payload = { state: string(record(envelope.data).state) ?? 'unknown' };
    } else {
      status = 'quarantined';
      payload = { fields: Object.keys(record(envelope.data)) };
    }
    await transaction.query('UPDATE connections SET last_event_at=now() WHERE id=$1', [connectionId]);
    if (Array.isArray(payload) && payload.length === 0) return { accepted: 0, ignored, duplicate: false };
    const fingerprint = hash({ type, payload });
    const inserted = await transaction.query(`INSERT INTO inbox_events(tenant_id,connection_id,fingerprint,event_type,source,payload,status)
      VALUES($1,$2,$3,$4,'webhook',$5,$6) ON CONFLICT DO NOTHING RETURNING id`, [tenantId, connectionId, fingerprint, type, JSON.stringify(payload), status]);
    if (inserted.rows[0] && status === 'pending') await enqueue(transaction, tenantId, 'inbox', inserted.rows[0].id, { eventId: inserted.rows[0].id }, 1);
    return { accepted: Array.isArray(payload) ? payload.length : 1, ignored, duplicate: !inserted.rowCount, quarantined: status === 'quarantined' };
  });
}

async function resolveConversation(transaction: Transaction, tenantId: string, connectionId: string, message: NormalizedMessage): Promise<string> {
  await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${tenantId}/${connectionId}/${message.jid}`]);
  const aliases = [message.jid, message.alternateJid].filter(Boolean);
  const linked = await transaction.query('SELECT DISTINCT conversation_id FROM identity_aliases WHERE connection_id=$1 AND source_jid=ANY($2)', [connectionId, aliases]);
  let conversationId = linked.rows[0]?.conversation_id as string | undefined;
  if (linked.rowCount && linked.rowCount > 1) {
    const own = await transaction.query('SELECT conversation_id FROM identity_aliases WHERE connection_id=$1 AND source_jid=$2', [connectionId, message.jid]);
    conversationId = own.rows[0]?.conversation_id;
    await transaction.query("INSERT INTO audit_events(tenant_id,actor,action,target,metadata) VALUES($1,'system','identity_conflict',$2,$3)", [tenantId, connectionId, { aliases }]);
  }
  if (!conversationId) {
    const customer = await transaction.query('INSERT INTO customers(tenant_id,display_name) VALUES($1,$2) RETURNING id', [tenantId, message.displayName]);
    const conversation = await transaction.query('INSERT INTO conversations(tenant_id,connection_id,source_jid,customer_id) VALUES($1,$2,$3,$4) RETURNING id', [tenantId, connectionId, message.jid, customer.rows[0].id]);
    conversationId = conversation.rows[0].id as string;
  }
  for (const alias of aliases) await transaction.query(`INSERT INTO identity_aliases(tenant_id,connection_id,source_jid,conversation_id,proof)
    VALUES($1,$2,$3,$4,'provider_key') ON CONFLICT DO NOTHING`, [tenantId, connectionId, alias, conversationId]);
  return conversationId;
}

export async function invalidateMessageFacts(transaction: Transaction, tenantId: string, messageId: string): Promise<void> {
  const invalidated = await transaction.query(`UPDATE facts SET publication_state='invalidated' WHERE id IN
    (SELECT fact_id FROM evidence_links WHERE message_id=$1) AND publication_state<>'invalidated' RETURNING id`, [messageId]);
  for (const fact of invalidated.rows) {
    await transaction.query(`INSERT INTO outbox_events(tenant_id,event_type,aggregate_id,revision,payload) VALUES($1,'fact.invalidated',$2,1,$3) ON CONFLICT DO NOTHING`, [tenantId, fact.id, { factId: fact.id, reason: 'source_changed' }]);
    await transaction.query("UPDATE review_tasks SET state='invalidated' WHERE fact_id=$1 AND state='pending'", [fact.id]);
  }
}

export async function applyMessage(transaction: Transaction, tenantId: string, connectionId: string, message: NormalizedMessage, source: string, eventId: string | null = null): Promise<boolean> {
  if (!isPrivateJid(message.jid)) return false;
  const tombstone = await transaction.query('SELECT 1 FROM message_tombstones WHERE connection_id=$1 AND source_jid=ANY($2) AND source_id=$3 AND from_me=$4', [connectionId, [message.jid, message.alternateJid].filter(Boolean), message.sourceId, message.fromMe]);
  if (tombstone.rowCount) return false;
  const conversationId = await resolveConversation(transaction, tenantId, connectionId, message);
  const previousResult = await transaction.query('SELECT * FROM messages WHERE connection_id=$1 AND conversation_id=$2 AND source_id=$3 AND from_me=$4 FOR UPDATE', [connectionId, conversationId, message.sourceId, message.fromMe]);
  const previous = previousResult.rows[0];
  if (previous?.deleted_at || previous?.content_hash === message.contentHash) return false;
  if (previous?.edited_at && source !== 'edit') return false;
  if (previous && source === 'history' && previous.source_timestamp !== null && message.sourceTimestamp !== null && Number(previous.source_timestamp) > message.sourceTimestamp) return false;
  const saved = await transaction.query(`INSERT INTO messages(tenant_id,connection_id,conversation_id,source_id,source_jid,from_me,kind,body,occurred_at,source_timestamp,reply_to,content_hash,raw,edited_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,CASE WHEN $14 THEN now() ELSE NULL END)
    ON CONFLICT(tenant_id,connection_id,conversation_id,source_id,from_me) DO UPDATE SET
    body=EXCLUDED.body,kind=EXCLUDED.kind,content_hash=EXCLUDED.content_hash,raw=EXCLUDED.raw,
    revision=messages.revision+1,updated_at=now(),edited_at=COALESCE(EXCLUDED.edited_at,messages.edited_at)
    RETURNING id,revision`, [tenantId, connectionId, conversationId, message.sourceId, message.jid, message.fromMe, message.kind, message.body, message.occurredAt, message.sourceTimestamp, message.replyTo, message.contentHash, message.raw, source === 'edit']);
  const stored = saved.rows[0];
  await transaction.query(`INSERT INTO message_revisions(tenant_id,message_id,revision,content_hash,body,kind,event_id) VALUES($1,$2,$3,$4,$5,$6,$7)`, [tenantId, stored.id, stored.revision, message.contentHash, message.body, message.kind, eventId]);
  if (previous) await invalidateMessageFacts(transaction, tenantId, stored.id);
  const changed = await transaction.query(`UPDATE conversations SET revision=revision+1,analysis_status='pending',
    first_message_at=LEAST(first_message_at,$2::timestamptz),last_message_at=GREATEST(last_message_at,$2::timestamptz) WHERE id=$1 RETURNING revision`, [conversationId, message.occurredAt]);
  if (message.media && (message.kind === 'audio' || message.kind === 'document')) {
    const asset = await transaction.query(`INSERT INTO media_assets(tenant_id,message_id,message_revision,kind,mime_type,filename,declared_bytes)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`, [tenantId, stored.id, stored.revision, message.kind, message.media.mime, message.media.filename, message.media.bytes]);
    if (asset.rows[0]) await enqueue(transaction, tenantId, 'media', asset.rows[0].id, { mediaId: asset.rows[0].id }, source === 'history' ? 60 : 5);
  }
  await transaction.query("UPDATE workflow_jobs SET state='superseded',completed_at=now() WHERE kind='analyze' AND state='pending' AND payload->>'conversationId'=$1", [conversationId]);
  await enqueue(transaction, tenantId, 'analyze', `${conversationId}-${changed.rows[0].revision}`, { conversationId, revision: String(changed.rows[0].revision), live: source !== 'history' }, source === 'history' ? 50 : 10, 20);
  return true;
}

async function applyKeyEvent(transaction: Transaction, tenantId: string, connectionId: string, type: string, raw: unknown): Promise<void> {
  const data = record(raw);
  const key = record(data.key ?? data);
  const jid = string(key.remoteJid);
  const sourceId = string(key.id ?? data.keyId);
  if (!isPrivateJid(jid) || !sourceId) return;
  const fromMe = typeof key.fromMe === 'boolean' ? key.fromMe : null;
  if (type === 'messages.delete') {
    for (const direction of fromMe === null ? [true, false] : [fromMe]) {
      await transaction.query(`INSERT INTO message_tombstones(tenant_id,connection_id,source_jid,source_id,from_me) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [tenantId, connectionId, jid, sourceId, direction]);
    }
    const deleted = await transaction.query(`UPDATE messages SET deleted_at=now(),body=NULL,raw='{}',updated_at=now() WHERE connection_id=$1 AND source_jid=$2 AND source_id=$3 AND ($4::boolean IS NULL OR from_me=$4) AND deleted_at IS NULL RETURNING id,conversation_id`, [connectionId, jid, sourceId, fromMe]);
    for (const message of deleted.rows) {
      await invalidateMessageFacts(transaction, tenantId, message.id);
      await transaction.query('UPDATE message_revisions SET body=NULL WHERE message_id=$1', [message.id]);
      const conversation = await transaction.query("UPDATE conversations SET revision=revision+1,analysis_status='pending' WHERE id=$1 RETURNING revision", [message.conversation_id]);
      await enqueue(transaction, tenantId, 'analyze', `${message.conversation_id}-${conversation.rows[0].revision}`, { conversationId: message.conversation_id, revision: String(conversation.rows[0].revision) });
    }
    return;
  }
  const status = string(data.status ?? record(data.update).status);
  const order = ['PENDING', 'SERVER_ACK', 'DELIVERY_ACK', 'READ', 'PLAYED'];
  if (!status || !order.includes(status)) return;
  await transaction.query(`UPDATE messages SET status=$5 WHERE connection_id=$1 AND source_jid=$2 AND source_id=$3
    AND ($4::boolean IS NULL OR from_me=$4) AND (status IS NULL OR array_position($6::text[],status)<array_position($6::text[],$5))`, [connectionId, jid, sourceId, fromMe, status, order]);
}

export async function processInbox(db: Database, tenantId: string, eventId: string): Promise<void> {
  await db.tx(tenantId, async transaction => {
    const found = await transaction.query('SELECT * FROM inbox_events WHERE id=$1 FOR UPDATE', [eventId]);
    const event = found.rows[0];
    if (!event || event.status !== 'pending') return;
    if (messageEvents.has(event.event_type)) {
      for (const item of eventRecords(event.payload)) {
        const message = normalizeMessage(item);
        if (message) await applyMessage(transaction, tenantId, event.connection_id, message, event.event_type === 'messages.edited' ? 'edit' : 'live', eventId);
      }
    } else if (keyEvents.has(event.event_type)) {
      for (const item of eventRecords(event.payload)) await applyKeyEvent(transaction, tenantId, event.connection_id, event.event_type, item);
    } else if (event.event_type === 'connection.update') {
      await transaction.query('UPDATE connections SET state=$2 WHERE id=$1', [event.connection_id, record(event.payload).state]);
    }
    await transaction.query("UPDATE inbox_events SET status='processed',processed_at=now() WHERE id=$1", [eventId]);
  });
}
