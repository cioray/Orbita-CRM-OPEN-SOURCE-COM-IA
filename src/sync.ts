import type { Database } from './db.js';
import type { Evolution } from './evolution.js';
import { applyMessage } from './ingest.js';
import { enqueue, type WorkItem } from './jobs.js';
import { normalizeMessage } from './normalize.js';
import { AppError, hash, record } from './util.js';

export async function startSync(db: Database, tenantId: string, connectionId: string, from = '2009-01-01T00:00:00Z', to = new Date().toISOString()): Promise<string> {
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(from) >= Date.parse(to)) throw new AppError('invalid_sync_range');
  return db.tx(tenantId, async transaction => {
    await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`sync/${connectionId}`]);
    const active = await transaction.query("SELECT id FROM sync_runs WHERE connection_id=$1 AND state IN ('pending','running')", [connectionId]);
    if (active.rows[0]) return active.rows[0].id as string;
    const connection = await transaction.query('SELECT id FROM connections WHERE id=$1 AND enabled', [connectionId]);
    if (!connection.rowCount) throw new AppError('connection_not_found', 404);
    const created = await transaction.query('INSERT INTO sync_runs(tenant_id,connection_id,from_time,to_time) VALUES($1,$2,$3,$4) RETURNING id', [tenantId, connectionId, from, to]);
    const runId = created.rows[0].id as string;
    await enqueue(transaction, tenantId, 'sync', `${runId}-1-1`, { runId, pass: 1, page: 1 }, 80);
    return runId;
  });
}

export async function processSync(db: Database, evolution: Evolution, job: WorkItem): Promise<void> {
  const runId = String(job.payload.runId);
  const run = await db.tx(job.tenant_id, async transaction => {
    const result = await transaction.query('SELECT sync_runs.*,connections.instance_name FROM sync_runs JOIN connections ON connections.id=sync_runs.connection_id AND connections.tenant_id=sync_runs.tenant_id WHERE sync_runs.id=$1', [runId]);
    return result.rows[0];
  });
  if (!run || !['pending', 'running'].includes(run.state) || Number(job.payload.pass) !== run.pass || Number(job.payload.page) !== run.page) return;
  const page = await evolution.messages(run.instance_name, new Date(run.from_time).toISOString(), new Date(run.to_time).toISOString(), run.page);
  await db.tx(job.tenant_id, async transaction => {
    const locked = await transaction.query('SELECT * FROM sync_runs WHERE id=$1 FOR UPDATE', [runId]);
    const current = locked.rows[0];
    if (!current || current.pass !== run.pass || current.page !== run.page || !['pending', 'running'].includes(current.state)) return;
    let accepted = 0;
    let ignored = 0;
    for (const item of page.records) {
      const message = normalizeMessage(item);
      if (!message) { ignored++; continue; }
      if (message.occurredAt && (Date.parse(message.occurredAt) < new Date(run.from_time).getTime() || Date.parse(message.occurredAt) > new Date(run.to_time).getTime())) throw new AppError('evolution_timestamp_filter_mismatch');
      const sourceKey = hash([message.jid, message.sourceId, message.fromMe]);
      await transaction.query(`INSERT INTO sync_manifest(tenant_id,run_id,pass,source_key,content_hash) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(tenant_id,run_id,pass,source_key) DO UPDATE SET content_hash=EXCLUDED.content_hash`, [job.tenant_id, runId, run.pass, sourceKey, message.contentHash]);
      if (await applyMessage(transaction, job.tenant_id, run.connection_id, message, 'history')) accepted++;
    }
    await transaction.query(`UPDATE sync_runs SET state='running',source_total=$2,scanned=scanned+$3,accepted=accepted+$4,ignored=ignored+$5,
      checkpoint=$6 WHERE id=$1`, [runId, page.total, page.records.length, accepted, ignored, { page: run.page, pass: run.pass, lastBatchAt: new Date().toISOString() }]);
    if (run.page < page.pages && page.records.length) {
      await transaction.query('UPDATE sync_runs SET page=page+1 WHERE id=$1', [runId]);
      await enqueue(transaction, job.tenant_id, 'sync', `${runId}-${run.pass}-${run.page + 1}`, { runId, pass: run.pass, page: run.page + 1 }, 80);
      return;
    }
    let differences: number | null = null;
    if (run.pass > 1) {
      const result = await transaction.query(`SELECT count(*) AS total FROM (
        (SELECT source_key,content_hash FROM sync_manifest WHERE run_id=$1 AND pass=$2 EXCEPT SELECT source_key,content_hash FROM sync_manifest WHERE run_id=$1 AND pass=$3)
        UNION ALL
        (SELECT source_key,content_hash FROM sync_manifest WHERE run_id=$1 AND pass=$3 EXCEPT SELECT source_key,content_hash FROM sync_manifest WHERE run_id=$1 AND pass=$2)
      ) AS differences`, [runId, run.pass, run.pass - 1]);
      differences = Number(result.rows[0].total);
    }
    const count = await transaction.query('SELECT count(*) AS total FROM sync_manifest WHERE run_id=$1 AND pass=$2', [runId, run.pass]);
    if (differences === 0 || run.pass >= 3) {
      await transaction.query(`UPDATE sync_runs SET state=$2,completed_at=now(),report=$3 WHERE id=$1`, [runId, differences === 0 ? 'reconciled_observation' : 'incomplete', {
        privateMessagesObserved: Number(count.rows[0].total), sourceTotalAllChats: page.total, passes: run.pass, differences,
        coverage: 'available_source_only', guaranteesCompleteWhatsAppHistory: false,
        paginationLimitation: 'timestamp_order_without_stable_id_tiebreaker',
        conclusion: differences === 0 ? 'Two scans observed the same private message identities and content hashes; not a source snapshot guarantee.' : 'Scans did not converge; reconciliation remains necessary.'
      }]);
    } else {
      await transaction.query('UPDATE sync_runs SET pass=pass+1,page=1 WHERE id=$1', [runId]);
      await enqueue(transaction, job.tenant_id, 'sync', `${runId}-${run.pass + 1}-1`, { runId, pass: run.pass + 1, page: 1 }, 80);
    }
  });
}
