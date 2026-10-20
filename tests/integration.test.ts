import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, defaultSettings } from '../src/config.js';
import { Database } from '../src/db.js';
import { acceptWebhook, processInbox } from '../src/ingest.js';
import { buildApp } from '../src/app.js';
import { enqueue, JobRuntime } from '../src/jobs.js';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

Object.assign(process.env, parseEnv(readFileSync('.env', 'utf8')));
const config = loadConfig();
const tenantId = randomUUID();
const otherTenantId = randomUUID();
const db = new Database(config.DATABASE_URL);
const admin = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL });
let connectionId: string;
const sample = { key: { id: 'test-message', remoteJid: '5511900000000@s.whatsapp.net', fromMe: false }, message: { conversation: 'Quanto custa o curso?' }, messageTimestamp: 1700000000 };

beforeAll(async () => {
  for (const id of [tenantId, otherTenantId]) {
    await admin.query('INSERT INTO tenant_directory(id,name) VALUES($1,$2)', [id, 'integration-test']);
    await admin.query('INSERT INTO tenant_settings(tenant_id,settings) VALUES($1,$2)', [id, defaultSettings]);
  }
  const result = await db.tx(tenantId, transaction => transaction.query("INSERT INTO connections(tenant_id,instance_name) VALUES($1,'test') RETURNING id", [tenantId]));
  connectionId = result.rows[0].id;
});

afterAll(async () => {
  for (const id of [tenantId, otherTenantId]) {
    for (const table of ['export_deliveries', 'export_consumers', 'confirmed_payments', 'commitment_facts', 'commitments', 'message_decisions', 'evidence_links', 'review_tasks', 'facts', 'cases', 'analysis_runs', 'media_assets', 'message_revisions', 'message_tombstones', 'messages', 'identity_aliases', 'conversations', 'customers', 'workflow_jobs', 'inbox_events', 'sync_manifest', 'sync_runs', 'audit_events', 'outbox_events', 'connections', 'tenant_settings', 'tenant_directory']) {
      await admin.query(`DELETE FROM ${table} WHERE ${table === 'tenant_directory' ? 'id' : 'tenant_id'}=$1`, [id]);
    }
  }
  await db.close();
  await admin.end();
});

async function deliver(event: string, data: unknown) {
  await acceptWebhook(db, tenantId, connectionId, { instance: 'test', event, data, apikey: 'never-store-this' });
  const pending = await db.tx(tenantId, transaction => transaction.query("SELECT id FROM inbox_events WHERE status='pending'"));
  for (const item of pending.rows) await processInbox(db, tenantId, item.id);
}

describe('durable ingestion', () => {
  it('stores one logical message on ten deliveries, without secrets', async () => {
    for (let attempt = 0; attempt < 10; attempt++) await deliver('messages.upsert', sample);
    const result = await db.tx(tenantId, async transaction => ({ messages: (await transaction.query('SELECT * FROM messages')).rows, events: (await transaction.query('SELECT * FROM inbox_events')).rows }));
    expect(result.messages).toHaveLength(1);
    expect(result.events).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('never-store-this');
  });
  it('isolates tenants at database level even without an application WHERE clause', async () => {
    const rows = await db.tx(otherTenantId, transaction => transaction.query('SELECT * FROM messages'));
    expect(rows.rowCount).toBe(0);
    expect((await db.pool.query('SELECT * FROM messages')).rowCount).toBe(0);
    await expect(db.tx(otherTenantId, transaction => transaction.query('INSERT INTO customers(tenant_id) VALUES($1)', [tenantId]))).rejects.toThrow();
  });
  it('drops group content before durable inbox storage', async () => {
    await deliver('messages.upsert', { ...sample, key: { ...sample.key, remoteJid: '1@g.us' }, message: { conversation: 'group-secret' } });
    const rows = await db.tx(tenantId, transaction => transaction.query('SELECT payload FROM inbox_events'));
    expect(JSON.stringify(rows.rows)).not.toContain('group-secret');
  });
  it('does not deduplicate distinct messages by identical text', async () => {
    await deliver('messages.upsert', { ...sample, key: { ...sample.key, id: 'second-message' } });
    expect((await db.tx(tenantId, transaction => transaction.query('SELECT * FROM messages'))).rowCount).toBe(2);
  });
  it('recognizes LID aliases without duplicating an existing message', async () => {
    await deliver('messages.upsert', { ...sample, key: { ...sample.key, remoteJid: '123456789@lid', remoteJidAlt: sample.key.remoteJid } });
    expect((await db.tx(tenantId, transaction => transaction.query('SELECT * FROM messages'))).rowCount).toBe(2);
  });
  it('preserves revisions and prevents an old upsert from undoing an edit', async () => {
    await deliver('messages.edited', { key: sample.key, editedMessage: { conversation: 'Valor corrigido' } });
    await deliver('messages.upsert', { ...sample, extra: 'replay' });
    const rows = await db.tx(tenantId, transaction => transaction.query('SELECT * FROM messages WHERE source_id=$1', [sample.key.id]));
    expect(rows.rows[0].body).toBe('Valor corrigido');
    expect(rows.rows[0].revision).toBe(2);
  });
  it('does not resurrect a deleted message, even on a new delivery fingerprint', async () => {
    await deliver('messages.delete', sample.key);
    await deliver('messages.upsert', { ...sample, extra: 'changed-envelope' });
    const rows = await db.tx(tenantId, transaction => transaction.query('SELECT * FROM messages WHERE source_id=$1', [sample.key.id]));
    expect(rows.rows[0].deleted_at).not.toBeNull();
    expect(rows.rows[0].body).toBeNull();
  });
  it('supports deletion before the message arrives', async () => {
    const key = { ...sample.key, id: 'delete-first' };
    await deliver('messages.delete', key);
    await deliver('messages.upsert', { ...sample, key });
    expect((await db.tx(tenantId, transaction => transaction.query("SELECT * FROM messages WHERE source_id='delete-first'"))).rowCount).toBe(0);
  });
  it('authenticates HTTP before accessing tenant data', async () => {
    const app = buildApp({ ...config, TENANT_ID: tenantId }, db);
    expect((await app.inject({ url: '/v1/status' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/webhooks/evolution/${connectionId}`, payload: { instance: 'test' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/status', headers: { authorization: `Bearer ${config.ADMIN_TOKEN}` } })).statusCode).toBe(200);
    await app.close();
  });
  it('dispatches durable jobs and recovers expired leases through Redis', async () => {
    await db.tx(tenantId, async transaction => {
      await transaction.query("UPDATE workflow_jobs SET state='completed'");
      await enqueue(transaction, tenantId, 'test', 'recover-me', {});
      await transaction.query("UPDATE workflow_jobs SET state='running',lease_until=now()-interval '1 minute' WHERE kind='test'");
    });
    const queueName = `test-${randomUUID()}`;
    let calls = 0;
    const runtime = new JobRuntime(db, config, async job => {
      expect(job.kind).toBe('test');
      calls++;
    }, { queueName, tenantIds: [tenantId] });
    try {
      await runtime.dispatch();
      const timeout = Date.now() + 8000;
      let completed = false;
      while (!completed && Date.now() < timeout) {
        const result = await db.tx(tenantId, transaction => transaction.query("SELECT state FROM workflow_jobs WHERE kind='test'"));
        completed = result.rows[0]?.state === 'completed';
        if (!completed) await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(completed).toBe(true);
      expect(calls).toBe(1);
    } finally {
      await runtime.close();
      const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
      for (const lane of ['live','history','analysis','media','export','general']) {
        const queue = new Queue(`${queueName}-${lane}`, { connection: redis });
        await queue.obliterate({ force: true });
        await queue.close();
      }
      await redis.quit();
    }
  });
});
