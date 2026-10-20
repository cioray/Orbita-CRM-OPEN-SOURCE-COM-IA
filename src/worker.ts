import { loadConfig } from './config.js';
import { Database } from './db.js';
import { Evolution } from './evolution.js';
import { processInbox } from './ingest.js';
import { JobRuntime } from './jobs.js';
import { processSync } from './sync.js';
import { AppError } from './util.js';
import { analyzeConversation } from './analysis.js';
import { processMedia } from './media.js';

const config = loadConfig();
const db = new Database(config.DATABASE_URL);
const evolution = new Evolution(config);
const runtime = new JobRuntime(db, config, async job => {
  if (job.kind === 'inbox') return processInbox(db, job.tenant_id, String(job.payload.eventId));
  if (job.kind === 'sync') return processSync(db, evolution, job);
  if (job.kind === 'analyze') return analyzeConversation(db, job);
  if (job.kind === 'media') return processMedia(db, config, job);
  throw new AppError(`configuration_handler_${job.kind}`, 503);
});
runtime.start();
console.log(JSON.stringify({ event: 'worker_started' }));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  void runtime.close().then(() => db.close()).then(() => process.exit(0));
});
