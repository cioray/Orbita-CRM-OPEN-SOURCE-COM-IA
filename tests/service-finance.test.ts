import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import pg from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {loadConfig,defaultSettings} from '../src/config.js';
import {Database} from '../src/db.js';
import {buildApp} from '../src/app.js';

Object.assign(process.env,parseEnv(readFileSync('.env','utf8')));
const config=loadConfig();
const tenantId=randomUUID();
const db=new Database(config.DATABASE_URL);
const admin=new pg.Pool({connectionString:process.env.DATABASE_ADMIN_URL});
const app=buildApp({...config,TENANT_ID:tenantId},db);
const headers={authorization:`Bearer ${config.ADMIN_TOKEN}`};
let customerId:string;
beforeAll(async()=>{
  await admin.query("INSERT INTO tenant_directory(id,name,active) VALUES($1,'finance-test',false)",[tenantId]);
  await admin.query('INSERT INTO tenant_settings(tenant_id,settings) VALUES($1,$2)',[tenantId,defaultSettings]);
  customerId=(await db.tx(tenantId,tx=>tx.query("INSERT INTO customers(tenant_id,display_name) VALUES($1,'Finance test') RETURNING id",[tenantId]))).rows[0].id;
});
afterAll(async()=>{
  await app.close();
  for(const table of ['outbox_events','confirmed_payments','commitments','audit_events','crm_records','crm_customer_stages','customers','tenant_settings','tenant_directory'])await admin.query(`DELETE FROM ${table} WHERE ${table==='tenant_directory'?'id':'tenant_id'}=$1`,[tenantId]);
  await db.close();await admin.end();
});
const profile=async()=>(await app.inject({url:`/v1/workspace/customers/${customerId}`,headers})).json().customer;
const readService=async(id:string)=>(await app.inject({url:`/v1/workspace/service-finance/${id}`,headers})).json();

it('tracks pending revenue, partial/full advance and audited corrections without duplicate receipts',async()=>{
  const payload={customerId,title:'Implantação',amount:'1000.00',receivedTotal:'0.00',state:'in_progress'};
  const created=await app.inject({url:'/v1/workspace/service-finance',method:'POST',headers,payload});
  expect(created.statusCode,created.body).toBe(200);
  const serviceId=created.json().service.id;
  const commitmentId=created.json().commitment.id;
  expect((await profile()).stage).toBe('service_in_progress');
  expect(Number((await profile()).pending_revenue)).toBe(1000);
  for(const receivedTotal of ['300.00','1000.00','1000.00','200.00']){
    const current=await readService(serviceId);
    const saved=await app.inject({url:'/v1/workspace/service-finance',method:'POST',headers,payload:{...payload,recordId:serviceId,expectedRevision:current.service.revision,receivedTotal}});
    expect(saved.statusCode,saved.body).toBe(200);
    expect(saved.json().commitment.id).toBe(commitmentId);
    const customer=await profile();
    expect(Number(customer.revenue)).toBe(Number(receivedTotal));
    expect(Number(customer.pending_revenue)).toBe(1000-Number(receivedTotal));
  }
  const payments=await db.tx(tenantId,tx=>tx.query('SELECT voided_at FROM confirmed_payments WHERE commitment_id=$1',[commitmentId]));
  expect(payments.rows.filter(payment=>!payment.voided_at)).toHaveLength(1);
  expect(payments.rows.filter(payment=>payment.voided_at)).toHaveLength(2);
  const completed=await app.inject({url:`/v1/workspace/records/${serviceId}`,method:'PATCH',headers,payload:{state:'completed'}});
  expect(completed.statusCode,completed.body).toBe(200);
  expect(Number((await profile()).pending_revenue)).toBe(800);
  const current=await readService(serviceId);
  const edit={expectedRevision:current.commitment.revision,title:'Projeto revisado',amount:'1500.00',receivedTotal:'250.00',dueAt:'2026-11-01',serviceId,state:'confirmed'};
  const updated=await app.inject({url:`/v1/workspace/finance/${commitmentId}`,method:'PATCH',headers,payload:edit});
  expect(updated.statusCode,updated.body).toBe(200);
  expect((await readService(serviceId)).service.title).toBe(edit.title);
  expect(Number((await profile()).pending_revenue)).toBe(1250);
  expect((await app.inject({url:`/v1/workspace/finance/${commitmentId}`,method:'PATCH',headers,payload:edit})).statusCode).toBe(409);
  expect((await app.inject({url:`/v1/workspace/finance/${commitmentId}`,method:'PATCH',headers,payload:{...edit,expectedRevision:updated.json().revision,receivedTotal:'1501.00'}})).statusCode).toBe(400);
  const cancelled=await app.inject({url:`/v1/workspace/finance/${commitmentId}`,method:'PATCH',headers,payload:{...edit,expectedRevision:updated.json().revision,state:'cancelled'}});
  expect(cancelled.statusCode,cancelled.body).toBe(200);
  expect(Number((await profile()).pending_revenue)).toBe(0);
  expect(Number((await profile()).revenue)).toBe(250);
});

it('requires service details before starting work and rolls back an unpriced service transition',async()=>{
  expect((await app.inject({url:`/v1/workspace/customers/${customerId}/stage`,method:'PUT',headers,payload:{stage:'service_in_progress'}})).statusCode).toBe(409);
  const created=await app.inject({url:'/v1/workspace/records',method:'POST',headers,payload:{customerId,kind:'service',title:'Sem preço'}});
  expect(created.statusCode,created.body).toBe(200);
  const response=await app.inject({url:`/v1/workspace/records/${created.json().id}`,method:'PATCH',headers,payload:{state:'in_progress'}});
  expect(response.statusCode,response.body).toBe(400);
  expect((await readService(created.json().id)).service.state).toBe('open');
});

it('creates one pending commitment when a priced service enters the in-progress stage',async()=>{
  const client=(await db.tx(tenantId,tx=>tx.query("INSERT INTO customers(tenant_id,display_name) VALUES($1,'Stage test') RETURNING id",[tenantId]))).rows[0].id;
  const service=await app.inject({url:'/v1/workspace/records',method:'POST',headers,payload:{customerId:client,kind:'service',title:'Serviço contratado',amount:450}});
  for(let attempt=0;attempt<2;attempt++){
    const result=await app.inject({url:`/v1/workspace/customers/${client}/stage`,method:'PUT',headers,payload:{stage:'service_in_progress'}});
    expect(result.statusCode,result.body).toBe(200);
  }
  const rows=(await db.tx(tenantId,tx=>tx.query('SELECT * FROM commitments WHERE customer_id=$1',[client]))).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].service_id).toBe(service.json().id);
  const customer=(await app.inject({url:`/v1/workspace/customers/${client}`,headers})).json().customer;
  expect(Number(customer.revenue)).toBe(0);
  expect(Number(customer.pending_revenue)).toBe(450);
});
