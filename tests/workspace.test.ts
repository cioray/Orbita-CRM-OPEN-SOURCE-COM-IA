import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { loadConfig,defaultSettings } from '../src/config.js';
import { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';

Object.assign(process.env,parseEnv(readFileSync('.env','utf8')));
const config=loadConfig();
const tenantId=randomUUID();
const otherTenantId=randomUUID();
const db=new Database(config.DATABASE_URL);
const admin=new pg.Pool({connectionString:process.env.DATABASE_ADMIN_URL});
const app=buildApp({...config,TENANT_ID:tenantId},db);
const headers={authorization:`Bearer ${config.ADMIN_TOKEN}`};
let customerId:string;
let taskId:string;
beforeAll(async()=>{
  for(const id of [tenantId,otherTenantId]){
    await admin.query("INSERT INTO tenant_directory(id,name,active) VALUES($1,'workspace-test',false)",[id]);
    await admin.query('INSERT INTO tenant_settings(tenant_id,settings) VALUES($1,$2)',[id,defaultSettings]);
  }
  customerId=(await db.tx(tenantId,tx=>tx.query("INSERT INTO customers(tenant_id,display_name) VALUES($1,'Cliente de teste') RETURNING id",[tenantId]))).rows[0].id;
});
afterAll(async()=>{
  await app.close();
  for(const id of [tenantId,otherTenantId])for(const table of ['outbox_events','confirmed_payments','commitments','audit_events','crm_tasks','crm_records','crm_customer_stages','identity_aliases','conversations','customers','connections','tenant_settings','tenant_directory'])await admin.query(`DELETE FROM ${table} WHERE ${table==='tenant_directory'?'id':'tenant_id'}=$1`,[id]);
  await db.close();await admin.end();
});
describe('CRM workspace',()=>{
  it('excludes legacy groups from customers, records, tasks, profiles and overview',async()=>{
    const groupId=await db.tx(tenantId,async tx=>{
      const connection=(await tx.query("INSERT INTO connections(tenant_id,instance_name) VALUES($1,'group-test') RETURNING id",[tenantId])).rows[0].id;
      const customer=(await tx.query("INSERT INTO customers(tenant_id,display_name) VALUES($1,'Grupo de teste') RETURNING id",[tenantId])).rows[0].id;
      await tx.query("INSERT INTO conversations(tenant_id,connection_id,source_jid,customer_id) VALUES($1,$2,'120363000000000@g.us',$3)",[tenantId,connection,customer]);
      await tx.query("INSERT INTO crm_records(tenant_id,customer_id,kind,title) VALUES($1,$2,'opportunity','Grupo não é lead')",[tenantId,customer]);
      await tx.query("INSERT INTO crm_tasks(tenant_id,customer_id,title,due_at) VALUES($1,$2,'Grupo não é tarefa de cliente',now())",[tenantId,customer]);
      return customer;
    });
    try{
      const customers=(await app.inject({url:'/v1/workspace/customers',headers})).json();
      expect(customers.data.some((customer:any)=>customer.id===groupId)).toBe(false);
      expect((await app.inject({url:`/v1/workspace/customers/${groupId}`,headers})).statusCode).toBe(404);
      expect((await app.inject({url:'/v1/workspace/records?kind=opportunity',headers})).json()).toHaveLength(0);
      expect((await app.inject({url:'/v1/workspace/tasks',headers})).json()).toHaveLength(0);
      expect(Number((await app.inject({url:'/v1/workspace/overview',headers})).json().counts.customers)).toBe(1);
    }finally{
      await db.tx(tenantId,async tx=>{
        for(const table of ['crm_tasks','crm_records','conversations'])await tx.query(`DELETE FROM ${table} WHERE customer_id=$1`,[groupId]);
        await tx.query('DELETE FROM customers WHERE id=$1',[groupId]);
      });
    }
  });
  it('resolves the real phone from aliases and searches formatted phone numbers',async()=>{
    await db.tx(tenantId,async tx=>{
      const connection=(await tx.query("INSERT INTO connections(tenant_id,instance_name) VALUES($1,'identity-test') RETURNING id",[tenantId])).rows[0];
      const conversation=(await tx.query("INSERT INTO conversations(tenant_id,connection_id,source_jid,customer_id) VALUES($1,$2,'100000000000001@lid',$3) RETURNING id",[tenantId,connection.id,customerId])).rows[0];
      await tx.query("INSERT INTO identity_aliases(tenant_id,connection_id,source_jid,conversation_id,proof) VALUES($1,$2,'5511998765432@s.whatsapp.net',$3,'test')",[tenantId,connection.id,conversation.id]);
    });
    const response=await app.inject({url:'/v1/workspace/customers?search='+encodeURIComponent('+55 (11) 99876-5432'),headers});
    expect(response.statusCode).toBe(200);
    expect(response.json().data[0].phone).toBe('5511998765432');
    expect(response.json().data[0].display_name).toBe('Cliente de teste');
    expect((await db.tx(otherTenantId,tx=>tx.query('SELECT * FROM crm_customer_identity'))).rowCount).toBe(0);
  });
  it('creates an Evolution instance and forwards connection controls through the server',async()=>{
    const remote=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(JSON.stringify({base64:'data:image/png;base64,test-qr'}),{status:200,headers:{'Content-Type':'application/json'}}));
    try{
      const created=await app.inject({url:'/v1/workspace/whatsapp',method:'POST',headers,payload:{name:'workspace-test',create:true}});
      expect(created.statusCode).toBe(200);
      const instanceId=created.json().id;
      expect(remote.mock.calls[0]?.[0]).toContain('/instance/create');
      const qr=await app.inject({url:`/v1/workspace/whatsapp/${instanceId}/connect`,method:'POST',headers,payload:{}});
      expect(qr.json().base64).toBe('data:image/png;base64,test-qr');
      for(const action of ['restart','disconnect','delete']){
        const result=await app.inject({url:`/v1/workspace/whatsapp/${instanceId}/action`,method:'POST',headers,payload:{action}});
        expect(result.statusCode).toBe(200);
        const call=remote.mock.calls.at(-1);
        expect(call?.[0]).toContain(`/instance/${action==='disconnect'?'logout':action}/workspace-test`);
        expect(call?.[1]?.method).toBe(action==='restart'?'POST':'DELETE');
      }
      expect((await db.tx(tenantId,tx=>tx.query('SELECT enabled FROM connections WHERE id=$1',[instanceId]))).rows[0].enabled).toBe(false);
    }finally{remote.mockRestore();}
  });
  it('lists live Evolution state without exposing remote credentials',async()=>{
    const remote=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify([{name:'mock-instance',connectionStatus:'open',token:'remote-secret-never-exposed',profileName:'Workspace test'}]),{status:200,headers:{'Content-Type':'application/json'}}));
    try{
      const response=await app.inject({url:'/v1/workspace/whatsapp',headers});
      expect(response.statusCode).toBe(200);
      expect(response.json()[0].state).toBe('open');
      expect(response.body).not.toContain('remote-secret-never-exposed');
      expect(remote.mock.calls[0]?.[0]).toContain('/instance/fetchInstances');
    }finally{remote.mockRestore();}
  });
  it('authenticates API requests and prevents cross-origin session use',async()=>{
    expect((await app.inject('/v1/workspace/tasks')).statusCode).toBe(401);
    const login=await app.inject({url:'/crm/session',method:'POST',payload:{token:config.ADMIN_TOKEN}});
    expect(login.statusCode).toBe(200);
    const cookie=String(login.headers['set-cookie']).split(';')[0];
    expect((await app.inject({url:'/v1/workspace/tasks',headers:{cookie}})).statusCode).toBe(200);
    expect((await app.inject({url:'/v1/workspace/tasks',method:'POST',headers:{cookie,origin:'https://foreign.example'},payload:{}})).statusCode).toBe(403);
  });
  it('accepts a one-time access link only once',async()=>{
    const response=await app.inject({url:'/v1/workspace/access-link',method:'POST',headers,payload:{}});
    const ticket=response.json().path.split('/').at(-1);
    expect((await app.inject({url:'/crm/session',method:'POST',payload:{ticket}})).statusCode).toBe(200);
    expect((await app.inject({url:'/crm/session',method:'POST',payload:{ticket}})).statusCode).toBe(401);
  });
  it('persists customer tasks and lists the same records in a calendar range',async()=>{
    const result=await app.inject({url:'/v1/workspace/tasks',method:'POST',headers,payload:{title:'Retorno de proposta',customerId,dueAt:'2026-10-22T13:00:00.000Z',priority:'high'}});
    expect(result.statusCode).toBe(200);taskId=result.json().id;
    const tasks=(await app.inject({url:'/v1/workspace/tasks?from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z',headers})).json();
    expect(tasks).toHaveLength(1);expect(tasks[0].customer_id).toBe(customerId);
    expect((await app.inject({url:`/v1/workspace/tasks/${taskId}`,method:'PATCH',headers,payload:{state:'completed'}})).json().state).toBe('completed');
  });
  it('isolates tasks and rejects references to customers in another tenant',async()=>{
    expect((await db.tx(otherTenantId,tx=>tx.query('SELECT * FROM crm_tasks'))).rowCount).toBe(0);
    await expect(db.tx(otherTenantId,tx=>tx.query("INSERT INTO crm_tasks(tenant_id,customer_id,title,due_at) VALUES($1,$2,'invalid',now())",[otherTenantId,customerId]))).rejects.toThrow();
  });
  it('stores services and stages without changing message history or inferring revenue',async()=>{
    const created=await app.inject({url:'/v1/workspace/records',method:'POST',headers,payload:{customerId,kind:'service',title:'Implantação',description:'Entrega registrada manualmente.',amount:250}});
    expect(created.statusCode).toBe(200);
    await app.inject({url:`/v1/workspace/records/${created.json().id}`,method:'PATCH',headers,payload:{state:'completed'}});
    await app.inject({url:`/v1/workspace/customers/${customerId}/stage`,method:'PUT',headers,payload:{stage:'service_delivered'}});
    const profile=(await app.inject({url:`/v1/workspace/customers/${customerId}`,headers})).json();
    expect(profile.customer.stage).toBe('service_delivered');expect(Number(profile.customer.service_count)).toBe(1);expect(Number(profile.customer.revenue)).toBe(0);expect(Number(profile.customer.pending_revenue)).toBe(250);
    expect((await db.tx(tenantId,tx=>tx.query('SELECT count(*) FROM messages'))).rows[0].count).toBe('0');
  });
});
