import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Config } from './config.js';
import type { Database, Transaction } from './db.js';
import { AppError, type JsonRecord } from './util.js';

export interface WorkItem { tenant_id: string; id: string; kind: string; payload: JsonRecord; lease_token: string; attempts: number }

export async function enqueue(transaction: Transaction, tenantId: string, kind: string, dedupKey: string, payload: unknown, priority = 10, delaySeconds = 0): Promise<void> {
  await transaction.query(`INSERT INTO workflow_jobs(tenant_id,kind,dedup_key,payload,priority,available_at)
    VALUES($1,$2,$3,$4,$5,now()+$6*interval '1 second') ON CONFLICT DO NOTHING`, [tenantId, kind, dedupKey, payload, priority, delaySeconds]);
}

export function queueConnection(redisUrl: string) {
  const parsed = new URL(redisUrl);
  return { host: parsed.hostname, port: Number(parsed.port || 6379), password: parsed.password || undefined, maxRetriesPerRequest: null };
}

export class JobRuntime {
  private readonly redis: Redis;
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];
  private readonly tenantIds: string[];
  private timer?: NodeJS.Timeout;
  private dispatching = false;
  private closing = false;
  constructor(private readonly db: Database, config: Config, handler: (job: WorkItem) => Promise<void>, private readonly options: { queueName?: string; tenantIds?: string[] } = {}) {
    const connection = new Redis(queueConnection(config.REDIS_URL));
    this.redis = connection;
    this.tenantIds = options.tenantIds ?? [config.TENANT_ID];
    connection.on('error', () => console.error(JSON.stringify({ event: 'redis_connection_error' })));
    const queueName = options.queueName ?? 'motor-work';
    for (const [lane, concurrency] of [['live', 2], ['history', 1], ['analysis', 2], ['media', 2], ['export', 1], ['general', 1]] as const) {
    const queue = new Queue(`${queueName}-${lane}`, { connection });
    this.queues.set(lane, queue);
    const worker = new Worker(`${queueName}-${lane}`, async queueJob => {
      const { tenantId, jobId } = queueJob.data as { tenantId: string; jobId: string };
      const claimed = await this.db.tx(tenantId, async transaction => {
        const result = await transaction.query<WorkItem>(`UPDATE workflow_jobs SET state='running',lease_token=$3,lease_until=now()+interval '5 minutes',attempts=attempts+1
          WHERE tenant_id=$1 AND id=$2 AND state='pending' AND available_at<=now() RETURNING *`, [tenantId, jobId, randomUUID()]);
        return result.rows[0];
      });
      if (!claimed) return;
      const heartbeat = setInterval(() => {
        void this.db.tx(tenantId, transaction => transaction.query("UPDATE workflow_jobs SET lease_until=now()+interval '5 minutes' WHERE id=$1 AND lease_token=$2 AND state='running'", [jobId, claimed.lease_token])).catch(() => undefined);
      }, 30000);
      try {
        await handler(claimed);
        await this.db.tx(tenantId, transaction => transaction.query("UPDATE workflow_jobs SET state='completed',completed_at=now(),lease_until=NULL WHERE id=$1 AND lease_token=$2", [jobId, claimed.lease_token]));
      } catch (error) {
        const code = error instanceof AppError ? error.code : 'unexpected_worker_error';
        const state = code.startsWith('configuration_') ? 'blocked' : error instanceof AppError && !error.retryable ? 'failed' : claimed.attempts >= 6 ? 'failed' : 'pending';
        const delay = Math.min(300, 2 ** claimed.attempts * 3);
        await this.db.tx(tenantId, transaction => transaction.query(`UPDATE workflow_jobs SET state=$3,error_code=$4,lease_until=NULL,dispatched_at=NULL,
          available_at=now()+$5*interval '1 second' WHERE id=$1 AND lease_token=$2`, [jobId, claimed.lease_token, state, code, delay]));
        console.error(JSON.stringify({ event: 'job_error', kind: claimed.kind, jobId, code }));
      } finally {
        clearInterval(heartbeat);
      }
    }, { connection, concurrency });
    worker.on('error', () => console.error(JSON.stringify({ event: 'queue_worker_unavailable', lane })));
    queue.on('error', () => console.error(JSON.stringify({ event: 'queue_dispatch_unavailable', lane })));
    this.workers.push(worker);
    }
  }
  async dispatch(): Promise<void> {
    if (this.dispatching || this.closing) return;
    this.dispatching = true;
    try {
      for (const tenantId of this.tenantIds) {
        const jobs = await this.db.tx(tenantId, async transaction => {
          await transaction.query("UPDATE workflow_jobs SET state='pending',lease_until=NULL,dispatched_at=NULL WHERE state='running' AND lease_until<now()");
          const result = await transaction.query<{ id: string; kind: string; priority: number }>(`SELECT id,kind,priority FROM workflow_jobs
            WHERE state='pending' AND available_at<=now() AND (dispatched_at IS NULL OR dispatched_at<now()-interval '30 seconds') ORDER BY priority,available_at LIMIT 100`);
          return result.rows;
        });
        for (const job of jobs) {
          const lane = job.kind === 'inbox' ? 'live' : job.kind === 'sync' ? 'history' : job.kind === 'analyze' ? 'analysis' : job.kind === 'media' ? 'media' : job.kind === 'export' ? 'export' : 'general';
          await this.queues.get(lane)!.add('run', { tenantId, jobId: job.id }, { jobId: `${tenantId}-${job.id}`, priority: job.priority, removeOnComplete: true, removeOnFail: 100 });
          await this.db.tx(tenantId, transaction => transaction.query('UPDATE workflow_jobs SET dispatched_at=now() WHERE id=$1', [job.id]));
        }
      }
    } finally { this.dispatching = false; }
  }
  start(): void {
    this.timer = setInterval(() => { void this.dispatch().catch(() => console.error(JSON.stringify({ event: 'dispatch_failed' }))); }, 1500);
    void this.dispatch().catch(() => undefined);
  }
  async close(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all(this.workers.map(worker => worker.close()));
    await Promise.all([...this.queues.values()].map(queue => queue.close()));
    await this.redis.quit();
  }
}
