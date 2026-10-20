import Fastify from 'fastify';
import { z } from 'zod';
import { type Config, SettingsSchema } from './config.js';
import { Database } from './db.js';
import { Evolution } from './evolution.js';
import { acceptWebhook } from './ingest.js';
import { startSync } from './sync.js';
import { AppError, record, sanitize, secretMatches } from './util.js';
import { resolveReview, ReviewResolution } from './business.js';
import { enqueue } from './jobs.js';
import { randomUUID } from 'node:crypto';
import { acknowledgeExport, pollExports } from './exports.js';
import { CommitmentInput, PaymentInput, confirmPayment, createCommitment, financialSummary } from './finance.js';
import { workspaceRoutes } from './workspace.js';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const Id = z.uuid();
const Page = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), after: z.uuid().optional() });

export function buildApp(config: Config, db: Database) {
  const sessions=new Map<string,number>();
  const tickets=new Map<string,number>();
  const app = Fastify({ logger: { level: 'info', redact: ['req.headers.authorization', 'req.headers.apikey', 'req.headers.x-motor-secret'] }, bodyLimit: 32 * 1024 * 1024, disableRequestLogging: true });
  const evolution = new Evolution(config);
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'validation_error', issues: error.issues.map(issue => ({ path: issue.path, code: issue.code })) });
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: error.code });
    const status = Number(record(error).statusCode);
    request.log.error({ event: 'request_error', code: record(error).code, requestId: request.id });
    return reply.code(status >= 400 && status < 500 ? status : 500).send({ error: 'request_failed', requestId: request.id });
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/health/') || request.url.startsWith('/webhooks/')) return;
    if (request.url === '/crm' || request.url.startsWith('/crm/')) {
      if(request.method!=='GET' && request.headers.origin && request.headers.origin!==`http://${request.headers.host}`) return reply.code(403).send({error:'invalid_origin'});
      return;
    }
    const session=request.headers.cookie?.split(';').map(part=>part.trim()).find(part=>part.startsWith('crm_session='))?.slice(12);
    if(session && (sessions.get(session)??0)>Date.now()) {
      if(request.method!=='GET' && request.headers.origin!==`http://${request.headers.host}`) return reply.code(403).send({error:'invalid_origin'});
      return;
    }
    if (!secretMatches(request.headers.authorization, `Bearer ${config.ADMIN_TOKEN}`)) return reply.code(401).send({ error: 'unauthorized' });
  });
  app.post('/v1/workspace/access-link',async ()=>{
    const ticket=randomUUID();
    for(const [key,expiry] of tickets) if(expiry<Date.now())tickets.delete(key);
    tickets.set(ticket,Date.now()+60000);
    return {path:`/crm/#/acesso/${ticket}`};
  });
  app.post('/crm/session',async (request,reply)=>{
    const input=z.object({token:z.string().optional(),ticket:z.string().optional()}).strict().parse(request.body);
    const validTicket=input.ticket && (tickets.get(input.ticket)??0)>Date.now();
    if(input.ticket)tickets.delete(input.ticket);
    if(!validTicket && !secretMatches(input.token,config.ADMIN_TOKEN))return reply.code(401).send({error:'Credencial inválida ou link expirado.'});
    for(const [key,expiry] of sessions) if(expiry<Date.now())sessions.delete(key);
    const session=randomUUID();sessions.set(session,Date.now()+8*60*60*1000);
    reply.header('Set-Cookie',`crm_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
    return {authenticated:true};
  });
  app.post('/crm/logout',async(request,reply)=>{
    const session=request.headers.cookie?.split(';').map(part=>part.trim()).find(part=>part.startsWith('crm_session='))?.slice(12);
    if(session)sessions.delete(session);
    reply.header('Set-Cookie','crm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return {loggedOut:true};
  });
  const uiRoot=fileURLToPath(new URL('../web/dist/',import.meta.url));
  if(existsSync(uiRoot)) {
    void app.register(fastifyStatic,{root:uiRoot,prefix:'/crm/'});
    app.get('/crm',async (_request,reply)=>reply.redirect('/crm/'));
  }
  workspaceRoutes(app,db,config);
  app.get('/health/live', async () => ({ status: 'alive', service: 'motor-crm' }));
  app.get('/health/ready', async (_request, reply) => {
    try { await db.pool.query('SELECT 1'); return { status: 'ready' }; }
    catch { return reply.code(503).send({ status: 'database_unavailable' }); }
  });
  app.get('/', async () => ({ service: 'MotorCRM', version: '0.1.0', interface: 'API', status: '/v1/status' }));
  app.post('/webhooks/evolution/:connectionId', async (request, reply) => {
    if (!secretMatches(request.headers['x-motor-secret'], config.WEBHOOK_SECRET)) return reply.code(401).send({ error: 'invalid_webhook_secret' });
    const connectionId = Id.parse(record(request.params).connectionId);
    const result = await acceptWebhook(db, config.TENANT_ID, connectionId, request.body);
    return reply.code(202).send(result);
  });
  app.get('/v1/status', async () => db.tx(config.TENANT_ID, async transaction => {
    const messages = await transaction.query('SELECT count(*) AS total,count(*) FILTER(WHERE deleted_at IS NOT NULL) AS deleted FROM messages');
    const conversations = await transaction.query('SELECT count(*) AS total FROM conversations');
    const jobs = await transaction.query('SELECT kind,state,count(*) AS total FROM workflow_jobs GROUP BY kind,state');
    const media = await transaction.query('SELECT kind,status,count(*) AS total FROM media_assets GROUP BY kind,status');
    return { messages: messages.rows[0], conversations: Number(conversations.rows[0].total), jobs: jobs.rows, media: media.rows,
      providers: { openrouter: !!process.env.OPENROUTER_API_KEY, typesafe: !!process.env.TYPESAFE_API_KEY, openai: !!process.env.OPENAI_API_KEY, gemini: !!process.env.GEMINI_API_KEY },
      scope: { privateChatsOnly: true, maxConnections: 10, documentMaxBytes: 20 * 1024 * 1024, crm: 'not_selected', financialConfirmation: 'human_or_authorized_system' } };
  }));
  app.get('/v1/connections', async () => db.tx(config.TENANT_ID, async transaction => (await transaction.query('SELECT * FROM connections ORDER BY created_at')).rows));
  app.post('/v1/connections', async request => {
    const input = z.object({ instanceName: z.string().min(1).max(100) }).strict().parse(request.body);
    return db.tx(config.TENANT_ID, async transaction => {
      await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`connections/${config.TENANT_ID}`]);
      const count = await transaction.query('SELECT count(*) AS total FROM connections');
      if (Number(count.rows[0].total) >= 10) throw new AppError('connection_limit_reached', 409);
      const result = await transaction.query("INSERT INTO connections(tenant_id,instance_name,catalog_since) VALUES($1,$2,now()-interval '30 days') RETURNING *", [config.TENANT_ID, input.instanceName]);
      return result.rows[0];
    });
  });
  app.post('/v1/connections/:id/webhook', async request => {
    const id = Id.parse(record(request.params).id);
    const connection = await db.tx(config.TENANT_ID, async transaction => (await transaction.query('SELECT * FROM connections WHERE id=$1', [id])).rows[0]);
    if (!connection) throw new AppError('connection_not_found', 404);
    const previous = await evolution.webhook(connection.instance_name);
    if (previous.enabled && typeof previous.url === 'string' && !previous.url.endsWith(`/webhooks/evolution/${id}`)) throw new AppError('existing_webhook_requires_manual_coexistence', 409);
    await db.tx(config.TENANT_ID, transaction => transaction.query("INSERT INTO audit_events(tenant_id,actor,action,target,metadata) VALUES($1,'admin','configure_webhook',$2,$3)", [config.TENANT_ID, id, sanitize(previous)]));
    await evolution.configureWebhook(connection.instance_name, id);
    return { configured: true };
  });
  app.post('/v1/connections/:id/sync-runs', async (request, reply) => {
    const id = Id.parse(record(request.params).id);
    const input = z.object({ from: z.iso.datetime().optional(), to: z.iso.datetime().optional() }).strict().parse(request.body ?? {});
    const runId = await startSync(db, config.TENANT_ID, id, input.from, input.to);
    return reply.code(202).send({ runId });
  });
  app.get('/v1/sync-runs', async () => db.tx(config.TENANT_ID, async transaction => (await transaction.query('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 50')).rows));
  app.get('/v1/settings', async () => db.tx(config.TENANT_ID, async transaction => (await transaction.query('SELECT version,settings FROM tenant_settings')).rows[0]));
  app.put('/v1/settings', async request => {
    const input = z.object({ expectedVersion: z.number().int().positive(), settings: SettingsSchema }).strict().parse(request.body);
    return db.tx(config.TENANT_ID, async transaction => {
      const updated = await transaction.query('UPDATE tenant_settings SET settings=$1,version=version+1,updated_at=now() WHERE version=$2 RETURNING version,settings', [input.settings, input.expectedVersion]);
      if (!updated.rowCount) throw new AppError('settings_version_conflict', 409);
      await transaction.query("UPDATE workflow_jobs SET state='pending',attempts=0,available_at=now(),dispatched_at=NULL WHERE state='blocked'");
      await transaction.query("INSERT INTO audit_events(tenant_id,actor,action,target,metadata) VALUES($1,'admin','settings_updated','settings',$2)", [config.TENANT_ID, { version: updated.rows[0].version }]);
      return updated.rows[0];
    });
  });
  for (const [route, table] of [['customers', 'customers'], ['conversations', 'conversations'], ['cases', 'cases'], ['review-tasks', 'review_tasks'], ['media', 'media_assets'], ['events', 'outbox_events']] as const) {
    app.get(`/v1/${route}`, async request => {
      const page = Page.parse(request.query);
      return db.tx(config.TENANT_ID, async transaction => {
        const rows = (await transaction.query(`SELECT * FROM ${table} WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2`, [page.after ?? null, page.limit + 1])).rows;
        const more = rows.length > page.limit;
        const data = rows.slice(0, page.limit);
        return { data, nextCursor: more ? data.at(-1)?.id : null };
      });
    });
  }
  app.get('/v1/conversations/:id/messages', async request => {
    const id = Id.parse(record(request.params).id);
    const page = Page.parse(request.query);
    return db.tx(config.TENANT_ID, async transaction => {
      const rows = (await transaction.query(`SELECT id,source_id,from_me,kind,body,occurred_at,reply_to,revision,status,deleted_at FROM messages
        WHERE conversation_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`, [id, page.after ?? null, page.limit + 1])).rows;
      return { data: rows.slice(0, page.limit), nextCursor: rows.length > page.limit ? rows[page.limit - 1]?.id : null };
    });
  });
  app.get('/v1/conversations/:id/catalog', async request => {
    const id = Id.parse(record(request.params).id);
    return db.tx(config.TENANT_ID, async transaction => (await transaction.query(`SELECT * FROM conversation_catalog WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1`, [id])).rows[0] ?? null);
  });
  app.get('/v1/jobs', async request => {
    const input = z.object({ state: z.enum(['failed', 'blocked', 'pending', 'running', 'completed']).default('failed') }).parse(request.query);
    return db.tx(config.TENANT_ID, async transaction => (await transaction.query('SELECT id,kind,state,attempts,error_code,created_at FROM workflow_jobs WHERE state=$1 ORDER BY created_at DESC LIMIT 100', [input.state])).rows);
  });
  app.post('/v1/export-consumers', async request => {
    const input=z.object({name:z.string().min(1).max(100)}).strict().parse(request.body);
    return db.tx(config.TENANT_ID, async transaction => (await transaction.query('INSERT INTO export_consumers(tenant_id,name) VALUES($1,$2) ON CONFLICT(tenant_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING *',[config.TENANT_ID,input.name])).rows[0]);
  });
  app.post('/v1/export-consumers/:id/poll', async request => {
    const input=z.object({limit:z.number().int().min(1).max(100).default(50)}).parse(request.body ?? {});
    return { events: await pollExports(db,config.TENANT_ID,Id.parse(record(request.params).id),input.limit) };
  });
  app.post('/v1/export-consumers/:id/ack', async request => {
    const input=z.object({eventId:z.uuid(),leaseToken:z.uuid(),externalId:z.string().max(200).nullable().default(null)}).strict().parse(request.body);
    return acknowledgeExport(db,config.TENANT_ID,Id.parse(record(request.params).id),input.eventId,input.leaseToken,input.externalId);
  });
  app.post('/v1/commitments', async request => createCommitment(db,config.TENANT_ID,CommitmentInput.parse(request.body)));
  app.post('/v1/commitments/:id/payments', async request => confirmPayment(db,config.TENANT_ID,Id.parse(record(request.params).id),PaymentInput.parse(request.body)));
  app.get('/v1/customers/:id/financial', async request => financialSummary(db,config.TENANT_ID,Id.parse(record(request.params).id)));
  app.get('/v1/customers/:id', async request => {
    const id = Id.parse(record(request.params).id);
    return db.tx(config.TENANT_ID, async transaction => {
      const customer = (await transaction.query('SELECT * FROM customers WHERE id=$1', [id])).rows[0];
      if (!customer) throw new AppError('customer_not_found', 404);
      const conversations = (await transaction.query('SELECT * FROM conversations WHERE customer_id=$1', [id])).rows;
      const cases = (await transaction.query('SELECT * FROM cases WHERE customer_id=$1 ORDER BY updated_at DESC', [id])).rows;
      const facts = (await transaction.query(`SELECT facts.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('messageId',message_id,'messageRevision',message_revision,'spanStart',span_start,'spanEnd',span_end))
        FROM evidence_links WHERE fact_id=facts.id),'[]') AS evidence FROM facts WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 500`, [id])).rows;
      return { ...customer, conversations, cases, facts, financialBalance: { confirmed: null, reason: 'No authoritative accounting source connected; mentions are not balances.' } };
    });
  });
  app.get('/v1/customers/:id/cases', async request => {
    const id = Id.parse(record(request.params).id);
    return db.tx(config.TENANT_ID, async transaction => (await transaction.query('SELECT * FROM cases WHERE customer_id=$1 ORDER BY updated_at DESC', [id])).rows);
  });
  app.get('/v1/cases/:id/facts', async request => {
    const id = Id.parse(record(request.params).id);
    return db.tx(config.TENANT_ID, async transaction => (await transaction.query('SELECT * FROM facts WHERE case_id=$1 ORDER BY created_at', [id])).rows);
  });
  app.post('/v1/review-tasks/:id/resolution', async request => resolveReview(db, config.TENANT_ID, Id.parse(record(request.params).id), ReviewResolution.parse(request.body)));
  app.post('/v1/analysis-runs', async (request, reply) => {
    const input = z.object({ conversationId: z.uuid() }).strict().parse(request.body);
    return db.tx(config.TENANT_ID, async transaction => {
      const conversation = (await transaction.query('SELECT revision FROM conversations WHERE id=$1', [input.conversationId])).rows[0];
      if (!conversation) throw new AppError('conversation_not_found', 404);
      await enqueue(transaction, config.TENANT_ID, 'analyze', `manual-${randomUUID()}`, { conversationId: input.conversationId, revision: String(conversation.revision) }, 10);
      return reply.code(202).send({ queued: true });
    });
  });
  app.get('/v1/sync-runs/:id', async request => {
    const id = Id.parse(record(request.params).id);
    return db.tx(config.TENANT_ID, async transaction => {
      const run = (await transaction.query('SELECT * FROM sync_runs WHERE id=$1', [id])).rows[0];
      if (!run) throw new AppError('sync_run_not_found', 404);
      return run;
    });
  });
  app.post('/v1/jobs/:id/retry', async request => {
    const id = Id.parse(record(request.params).id);
    return db.tx(config.TENANT_ID, async transaction => {
      const result = await transaction.query("UPDATE workflow_jobs SET state='pending',attempts=0,available_at=now(),dispatched_at=NULL WHERE id=$1 AND state IN ('failed','blocked') RETURNING id", [id]);
      if (!result.rowCount) throw new AppError('job_not_retryable', 409);
      return { queued: true };
    });
  });
  return app;
}
