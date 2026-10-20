import { randomUUID } from 'node:crypto';
import type { Database } from './db.js';
import { AppError } from './util.js';

export async function pollExports(db: Database, tenantId: string, consumerId: string, limit: number) {
  return db.tx(tenantId, async transaction => {
    const consumer = await transaction.query('SELECT id FROM export_consumers WHERE id=$1', [consumerId]);
    if (!consumer.rowCount) throw new AppError('export_consumer_not_found', 404);
    await transaction.query(`INSERT INTO export_deliveries(tenant_id,consumer_id,event_id)
      SELECT $1,$2,id FROM outbox_events ON CONFLICT DO NOTHING`, [tenantId, consumerId]);
    const events = (await transaction.query(`SELECT event_id FROM export_deliveries WHERE consumer_id=$1 AND
      (state='pending' OR (state='leased' AND lease_until<now())) ORDER BY event_id LIMIT $2 FOR UPDATE SKIP LOCKED`, [consumerId, limit])).rows;
    const results = [];
    for (const event of events) {
      const leaseToken = randomUUID();
      await transaction.query("UPDATE export_deliveries SET state='leased',lease_token=$3,lease_until=now()+interval '2 minutes',attempts=attempts+1 WHERE consumer_id=$1 AND event_id=$2", [consumerId, event.event_id, leaseToken]);
      const payload = (await transaction.query('SELECT * FROM outbox_events WHERE id=$1', [event.event_id])).rows[0];
      results.push({ ...payload, schemaVersion: 1, idempotencyKey: event.event_id, leaseToken });
    }
    return results;
  });
}

export async function acknowledgeExport(db: Database, tenantId: string, consumerId: string, eventId: string, leaseToken: string, externalId: string | null) {
  return db.tx(tenantId, async transaction => {
    const existing = (await transaction.query('SELECT * FROM export_deliveries WHERE consumer_id=$1 AND event_id=$2 FOR UPDATE', [consumerId, eventId])).rows[0];
    if (!existing || existing.lease_token !== leaseToken) throw new AppError('delivery_lease_mismatch', 409);
    if (existing.state === 'acknowledged') return { acknowledged: true, duplicate: true };
    if (existing.state !== 'leased' || new Date(existing.lease_until).getTime() < Date.now()) throw new AppError('delivery_lease_expired', 409);
    await transaction.query("UPDATE export_deliveries SET state='acknowledged',acknowledged_at=now(),external_id=$3 WHERE consumer_id=$1 AND event_id=$2", [consumerId, eventId, externalId]);
    return { acknowledged: true, duplicate: false };
  });
}
