import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { Evolution } from './evolution.js';
import { AppError, record } from './util.js';
import {ContactIdentityInput,identifyCustomer} from './contact-identity.js';
import {ServiceFinanceInput,FinancialEditInput,saveServiceFinance,editFinancialCommitment,syncServiceCommitment} from './service-finance.js';

const CustomerView = `SELECT c.id,identity.display_name,identity.phone,c.identity_revision,c.created_at,
  cv.id AS conversation_id,cv.source_jid,cv.last_message_at,
  cat.subject,cat.finance,cat.status,cat.mood,cat.created_at AS catalog_at,cat.decision,
  COALESCE(st.stage,'new') AS stage,
  (SELECT count(*) FROM crm_records r WHERE r.customer_id=c.id AND r.kind='request') AS request_count,
  (SELECT count(*) FROM crm_records r WHERE r.customer_id=c.id AND r.kind='service' AND r.state='completed') AS service_count,
  (SELECT COALESCE(sum(p.amount),0) FROM confirmed_payments p JOIN commitments cm ON cm.id=p.commitment_id AND cm.tenant_id=p.tenant_id WHERE cm.customer_id=c.id AND p.voided_at IS NULL) AS revenue,
  (SELECT COALESCE(sum(cm.amount-COALESCE(p.paid,0)),0) FROM commitments cm LEFT JOIN LATERAL (SELECT sum(amount) AS paid FROM confirmed_payments WHERE commitment_id=cm.id AND voided_at IS NULL) p ON true WHERE cm.customer_id=c.id AND cm.state='confirmed') AS pending_revenue
  FROM customers c
  JOIN crm_customer_identity identity ON identity.id=c.id AND identity.tenant_id=c.tenant_id
  LEFT JOIN LATERAL (SELECT * FROM crm_private_conversations WHERE customer_id=c.id ORDER BY last_message_at DESC NULLS LAST LIMIT 1) cv ON true
  LEFT JOIN LATERAL (SELECT * FROM conversation_catalog WHERE conversation_id=cv.id ORDER BY created_at DESC LIMIT 1) cat ON true
  LEFT JOIN crm_customer_stages st ON st.customer_id=c.id AND st.tenant_id=c.tenant_id`;

export function workspaceRoutes(app: FastifyInstance, db: Database, config: Config) {
  const evo = new Evolution(config);
  const idOf = (params: unknown) => z.uuid().parse(record(params).id);
  app.patch('/v1/workspace/customers/:id/identity',async request=>identifyCustomer(db,config.TENANT_ID,idOf(request.params),ContactIdentityInput.parse(request.body)));
  app.get('/v1/workspace/customers', async request => {
    const query = z.object({ search: z.string().max(150).default(''), stage: z.string().max(40).default(''), status: z.string().max(40).default(''), paid:z.enum(['all','yes','no']).default('all'),limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    return db.tx(config.TENANT_ID, async tx => {
      const result = await tx.query(`SELECT result.*,count(*) OVER() AS total FROM (${CustomerView}) result WHERE ($1='' OR COALESCE(display_name,'') ILIKE '%'||$1||'%' OR phone ILIKE '%'||regexp_replace($1,'[^0-9]','','g')||'%' AND regexp_replace($1,'[^0-9]','','g')<>'') AND ($2='' OR stage=$2) AND ($3='' OR status=$3) AND ($6='all' OR ($6='yes' AND revenue>0) OR ($6='no' AND revenue=0)) ORDER BY last_message_at DESC NULLS LAST,id LIMIT $4 OFFSET $5`, [query.search,query.stage,query.status,query.limit,query.offset,query.paid]);
      return { data: result.rows, total: Number(result.rows[0]?.total ?? 0) };
    });
  });
  app.get('/v1/workspace/overview', async () => db.tx(config.TENANT_ID, async tx => {
    const counts = (await tx.query(`SELECT
      (SELECT count(*) FROM crm_customer_identity) AS customers,
      (SELECT count(*) FROM messages WHERE deleted_at IS NULL AND conversation_id IN (SELECT id FROM crm_private_conversations)) AS messages,
      (SELECT count(DISTINCT conversation_id) FROM conversation_catalog WHERE conversation_id IN (SELECT id FROM crm_private_conversations)) AS cataloged,
      (SELECT count(*) FROM crm_tasks WHERE state='pending' AND (customer_id IS NULL OR customer_id IN (SELECT id FROM crm_customer_identity))) AS pending_tasks,
      (SELECT count(*) FROM crm_records WHERE kind='service' AND state='completed' AND customer_id IN (SELECT id FROM crm_customer_identity)) AS completed_services,
      (SELECT COALESCE(sum(p.amount),0) FROM confirmed_payments p JOIN commitments cm ON cm.id=p.commitment_id AND cm.tenant_id=p.tenant_id JOIN crm_customer_identity ci ON ci.id=cm.customer_id AND ci.tenant_id=cm.tenant_id WHERE p.voided_at IS NULL) AS revenue,
      (SELECT COALESCE(sum(cm.amount-COALESCE(p.paid,0)),0) FROM commitments cm LEFT JOIN LATERAL (SELECT sum(amount) AS paid FROM confirmed_payments WHERE commitment_id=cm.id AND voided_at IS NULL) p ON true WHERE cm.state='confirmed' AND cm.customer_id IN (SELECT id FROM crm_customer_identity)) AS pending_revenue`)).rows[0];
    const distribution = (await tx.query(`SELECT status,mood,subject,count(*) AS total FROM (SELECT DISTINCT ON (conversation_id) * FROM conversation_catalog WHERE conversation_id IN (SELECT id FROM crm_private_conversations) ORDER BY conversation_id,created_at DESC) latest GROUP BY status,mood,subject`)).rows;
    const activity = (await tx.query(`SELECT date_trunc('day',occurred_at) AS day,count(*) FILTER(WHERE from_me=false) AS incoming,count(*) FILTER(WHERE from_me=true) AS outgoing FROM messages WHERE deleted_at IS NULL AND conversation_id IN (SELECT id FROM crm_private_conversations) AND occurred_at>=now()-interval '14 days' GROUP BY 1 ORDER BY 1`)).rows;
    return { counts, distribution, activity };
  }));
  app.get('/v1/workspace/customers/:id', async request => db.tx(config.TENANT_ID, async tx => {
    const id = idOf(request.params);
    const customer = (await tx.query(`${CustomerView} WHERE c.id=$1`, [id])).rows[0];
    if (!customer) throw new AppError('customer_not_found',404);
    const conversations = (await tx.query('SELECT id,source_jid,last_message_at,analysis_status FROM crm_private_conversations WHERE customer_id=$1 ORDER BY last_message_at DESC NULLS LAST',[id])).rows;
    const records = (await tx.query('SELECT r.*,m.conversation_id AS evidence_conversation_id FROM crm_records r LEFT JOIN messages m ON m.id=r.evidence_message_id AND m.tenant_id=r.tenant_id WHERE r.customer_id=$1 ORDER BY r.created_at DESC LIMIT 200',[id])).rows;
    const tasks = (await tx.query('SELECT * FROM crm_tasks WHERE customer_id=$1 ORDER BY due_at LIMIT 100',[id])).rows;
    return { customer, conversations, records, tasks };
  }));
  app.put('/v1/workspace/customers/:id/stage', async request => {
    const id = idOf(request.params);
    const input=z.object({stage:z.enum(['new','qualified','proposal','service_in_progress','service_delivered','recurring','churn','disqualified','personal_contact'])}).strict().parse(request.body);
    return db.tx(config.TENANT_ID,async tx => {
      if(input.stage==='service_in_progress'){
        const services=(await tx.query("SELECT * FROM crm_records WHERE customer_id=$1 AND kind='service' AND state IN ('open','in_progress') FOR UPDATE",[id])).rows;
        if(services.length!==1)throw new AppError('service_details_required',409);
        const service=(await tx.query("UPDATE crm_records SET state='in_progress',revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *",[services[0].id])).rows[0];
        await syncServiceCommitment(tx,config.TENANT_ID,service);
      }
      return (await tx.query(`INSERT INTO crm_customer_stages(tenant_id,customer_id,stage) VALUES($1,$2,$3) ON CONFLICT(tenant_id,customer_id) DO UPDATE SET stage=EXCLUDED.stage,updated_at=now() RETURNING *`,[config.TENANT_ID,id,input.stage])).rows[0];
    });
  });
  app.get('/v1/workspace/messages/:id', async request => {
    const id=idOf(request.params);
    const query=z.object({before:z.iso.datetime().optional(),focus:z.uuid().optional()}).parse(request.query);
    return db.tx(config.TENANT_ID,async tx => {
      const rows=(await tx.query(`SELECT id,from_me,body,kind,occurred_at FROM messages WHERE conversation_id=$1 AND conversation_id IN (SELECT id FROM crm_private_conversations) AND deleted_at IS NULL AND ($2::timestamptz IS NULL OR occurred_at<$2) AND ($3::uuid IS NULL OR occurred_at BETWEEN (SELECT occurred_at-interval '1 hour' FROM messages WHERE id=$3 AND conversation_id=$1) AND (SELECT occurred_at+interval '1 hour' FROM messages WHERE id=$3 AND conversation_id=$1)) ORDER BY occurred_at DESC NULLS LAST,id DESC LIMIT 100`,[id,query.before??null,query.focus??null])).rows;
      return {data:rows.reverse(),nextBefore:rows.length===100?rows[0]?.occurred_at:null};
    });
  });
  app.get('/v1/workspace/conversations/:id/customer',async request=>db.tx(config.TENANT_ID,async tx=>{
    const result=await tx.query(`${CustomerView} WHERE c.id=(SELECT customer_id FROM crm_private_conversations WHERE id=$1)`,[idOf(request.params)]);
    if(!result.rowCount)throw new AppError('conversation_not_found',404);
    return result.rows[0];
  }));
  app.get('/v1/workspace/tasks',async request => {
    const query=z.object({from:z.iso.datetime().optional(),to:z.iso.datetime().optional()}).parse(request.query);
    return db.tx(config.TENANT_ID,async tx => (await tx.query(`SELECT t.*,c.display_name,c.phone FROM crm_tasks t LEFT JOIN crm_customer_identity c ON c.id=t.customer_id AND c.tenant_id=t.tenant_id WHERE (t.customer_id IS NULL OR c.id IS NOT NULL) AND ($1::timestamptz IS NULL OR due_at>=$1) AND ($2::timestamptz IS NULL OR due_at<$2) ORDER BY due_at LIMIT 500`,[query.from??null,query.to??null])).rows);
  });
  app.post('/v1/workspace/tasks',async request => {
    const input=z.object({title:z.string().min(1).max(200),description:z.string().max(5000).default(''),customerId:z.uuid().nullable().default(null),dueAt:z.iso.datetime(),priority:z.enum(['normal','high']).default('normal')}).strict().parse(request.body);
    return db.tx(config.TENANT_ID,async tx => (await tx.query(`INSERT INTO crm_tasks(tenant_id,customer_id,title,description,due_at,priority) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[config.TENANT_ID,input.customerId,input.title,input.description,input.dueAt,input.priority])).rows[0]);
  });
  app.patch('/v1/workspace/tasks/:id',async request => {
    const input=z.object({state:z.enum(['pending','completed']).optional(),dueAt:z.iso.datetime().optional()}).strict().refine(value=>value.state||value.dueAt).parse(request.body);
    return db.tx(config.TENANT_ID,async tx => {
      const result=await tx.query('UPDATE crm_tasks SET state=COALESCE($2,state),due_at=COALESCE($3,due_at) WHERE id=$1 RETURNING *',[idOf(request.params),input.state??null,input.dueAt??null]);
      if(!result.rowCount) throw new AppError('task_not_found',404);
      return result.rows[0];
    });
  });
  app.get('/v1/workspace/records',async request => {
    const query=z.object({kind:z.enum(['request','service','opportunity','note']).optional()}).parse(request.query);
    return db.tx(config.TENANT_ID,async tx => (await tx.query(`SELECT r.*,c.display_name,c.phone FROM crm_records r JOIN crm_customer_identity c ON c.id=r.customer_id AND c.tenant_id=r.tenant_id WHERE ($1::text IS NULL OR r.kind=$1) ORDER BY updated_at DESC LIMIT 200`,[query.kind??null])).rows);
  });
  app.post('/v1/workspace/records',async request => {
    const input=z.object({customerId:z.uuid(),kind:z.enum(['request','service','opportunity','note']),title:z.string().min(1).max(200),description:z.string().max(10000).default(''),amount:z.number().min(0).optional(),evidenceMessageId:z.uuid().optional()}).strict().parse(request.body);
    return db.tx(config.TENANT_ID,async tx => {
      if(input.evidenceMessageId && !(await tx.query(`SELECT 1 FROM messages m JOIN conversations cv ON cv.id=m.conversation_id AND cv.tenant_id=m.tenant_id WHERE m.id=$1 AND cv.customer_id=$2`,[input.evidenceMessageId,input.customerId])).rowCount) throw new AppError('invalid_customer_evidence',400);
      return (await tx.query(`INSERT INTO crm_records(tenant_id,customer_id,kind,title,description,amount,evidence_message_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[config.TENANT_ID,input.customerId,input.kind,input.title,input.description,input.amount??null,input.evidenceMessageId??null])).rows[0];
    });
  });
  app.patch('/v1/workspace/records/:id',async request => {
    const input=z.object({state:z.enum(['open','in_progress','completed','cancelled'])}).strict().parse(request.body);
    return db.tx(config.TENANT_ID,async tx => {
      const result=await tx.query('UPDATE crm_records SET state=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',[idOf(request.params),input.state]);
      if(!result.rowCount) throw new AppError('record_not_found',404);
      if(result.rows[0].kind==='service')await syncServiceCommitment(tx,config.TENANT_ID,result.rows[0]);
      return result.rows[0];
    });
  });
  app.get('/v1/workspace/service-finance/:id',async request=>db.tx(config.TENANT_ID,async tx=>{
    const service=(await tx.query("SELECT * FROM crm_records WHERE id=$1 AND kind='service'",[idOf(request.params)])).rows[0];
    if(!service)throw new AppError('service_not_found',404);
    const commitment=(await tx.query(`SELECT cm.*,COALESCE((SELECT sum(amount) FROM confirmed_payments WHERE commitment_id=cm.id AND voided_at IS NULL),0)::numeric(18,2)::text AS paid FROM commitments cm WHERE service_id=$1`,[service.id])).rows[0]??null;
    return {service,commitment};
  }));
  app.post('/v1/workspace/service-finance',async request=>saveServiceFinance(db,config.TENANT_ID,ServiceFinanceInput.parse(request.body)));
  app.patch('/v1/workspace/finance/:id',async request=>editFinancialCommitment(db,config.TENANT_ID,idOf(request.params),FinancialEditInput.parse(request.body)));
  app.get('/v1/workspace/whatsapp',async () => {
    const connections=await db.tx(config.TENANT_ID,async tx => (await tx.query('SELECT id,instance_name,catalog_since,enabled FROM connections ORDER BY created_at')).rows);
    const remote=await evo.request('/instance/fetchInstances');
    const instances=Array.isArray(remote)?remote:[];
    return instances.map(value=>{
      const item=record(value); const nested=record(item.instance);
      const name=String(item.name??nested.instanceName??'');
      const local=connections.find(connection=>connection.instance_name===name);
      return {name,state:item.connectionStatus??nested.status??'unknown',profileName:item.profileName??null,owner:item.ownerJid??null,localId:local?.id??null,catalogSince:local?.catalog_since??null,counts:record(item._count)};
    });
  });
  app.post('/v1/workspace/whatsapp',async request => {
    const input=z.object({name:z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),create:z.boolean().default(true)}).strict().parse(request.body);
    return db.tx(config.TENANT_ID,async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`connections/${config.TENANT_ID}`]);
      if(Number((await tx.query('SELECT count(*) FROM connections')).rows[0].count)>=10) throw new AppError('connection_limit_reached',409);
      if((await tx.query('SELECT 1 FROM connections WHERE instance_name=$1',[input.name])).rowCount) throw new AppError('instance_already_registered',409);
      if(input.create) await evo.request('/instance/create',{instanceName:input.name,integration:'WHATSAPP-BAILEYS',qrcode:true});
      const connection=(await tx.query("INSERT INTO connections(tenant_id,instance_name,catalog_since) VALUES($1,$2,now()-interval '30 days') RETURNING id",[config.TENANT_ID,input.name])).rows[0];
      return {id:connection.id,name:input.name};
    });
  });
  app.post('/v1/workspace/whatsapp/:id/connect',async request => {
    const connection=await db.tx(config.TENANT_ID,async tx => (await tx.query('SELECT instance_name FROM connections WHERE id=$1',[idOf(request.params)])).rows[0]);
    if(!connection) throw new AppError('connection_not_found',404);
    const result=record(await evo.request(`/instance/connect/${encodeURIComponent(connection.instance_name)}`));
    return {base64:typeof result.base64==='string'?result.base64:null,pairingCode:result.pairingCode??null,count:result.count??null};
  });
  app.post('/v1/workspace/whatsapp/:id/action',async request => {
    const input=z.object({action:z.enum(['restart','disconnect','delete'])}).strict().parse(request.body);
    const connection=await db.tx(config.TENANT_ID,async tx => (await tx.query('SELECT id,instance_name FROM connections WHERE id=$1',[idOf(request.params)])).rows[0]);
    if(!connection)throw new AppError('connection_not_found',404);
    const route=input.action==='disconnect'?'logout':input.action;
    await evo.request(`/instance/${route}/${encodeURIComponent(connection.instance_name)}`,undefined,input.action==='restart'?'POST':'DELETE');
    await db.tx(config.TENANT_ID,async tx=>{
      if(input.action==='delete')await tx.query("UPDATE connections SET enabled=false,state='removed' WHERE id=$1",[connection.id]);
      await tx.query("INSERT INTO audit_events(tenant_id,actor,action,target) VALUES($1,'crm-admin',$2,$3)",[config.TENANT_ID,`whatsapp_${input.action}`,connection.id]);
    });
    return {completed:true};
  });
}
