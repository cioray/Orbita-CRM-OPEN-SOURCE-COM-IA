import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import pg from 'pg';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {loadConfig,defaultSettings} from '../src/config.js';
import {Database} from '../src/db.js';
import {Evolution} from '../src/evolution.js';
import {buildApp} from '../src/app.js';
import {syncContactIdentities} from '../src/contact-identity.js';

Object.assign(process.env,parseEnv(readFileSync('.env','utf8')));
const config=loadConfig();const tenantId=randomUUID();
const db=new Database(config.DATABASE_URL);
const admin=new pg.Pool({connectionString:process.env.DATABASE_ADMIN_URL});
const app=buildApp({...config,TENANT_ID:tenantId},db);
const headers={authorization:`Bearer ${config.ADMIN_TOKEN}`};
const evolution=new Evolution(config);
let connectionId:string;let customerId:string;let otherId:string;let conflictId:string;
const lid='100000000000001@lid';const phone='5511998765432';const otherPhone='5511987654321';
beforeAll(async()=>{
  await admin.query("INSERT INTO tenant_directory(id,name,active) VALUES($1,'contact-test',false)",[tenantId]);
  await admin.query('INSERT INTO tenant_settings(tenant_id,settings) VALUES($1,$2)',[tenantId,defaultSettings]);
  await db.tx(tenantId,async tx=>{
    connectionId=(await tx.query("INSERT INTO connections(tenant_id,instance_name) VALUES($1,'contact-test') RETURNING id",[tenantId])).rows[0].id;
    const ids=[];
    for(const jid of [lid,`${otherPhone}@s.whatsapp.net`,'100000000000002@lid']){
      const id=(await tx.query('INSERT INTO customers(tenant_id,display_name) VALUES($1,$2) RETURNING id',[tenantId,jid.split('@')[0]])).rows[0].id;
      const cv=(await tx.query('INSERT INTO conversations(tenant_id,connection_id,source_jid,customer_id) VALUES($1,$2,$3,$4) RETURNING id',[tenantId,connectionId,jid,id])).rows[0].id;
      await tx.query("INSERT INTO identity_aliases(tenant_id,connection_id,source_jid,conversation_id,proof) VALUES($1,$2,$3,$4,'test')",[tenantId,connectionId,jid,cv]);ids.push(id);
    }
    [customerId,otherId,conflictId]=ids;
  });
});
afterAll(async()=>{
  vi.restoreAllMocks();await app.close();
  for(const table of ['audit_events','crm_records','identity_aliases','conversations','customers','connections','tenant_settings','tenant_directory'])await admin.query(`DELETE FROM ${table} WHERE ${table==='tenant_directory'?'id':'tenant_id'}=$1`,[tenantId]);
  await db.close();await admin.end();
});
const profile=async(id=customerId)=>(await app.inject({url:`/v1/workspace/customers/${id}`,headers})).json().customer;

it('automatically imports names and explicit LID/phone evidence without creating or merging customers',async()=>{
  vi.spyOn(evolution,'request').mockImplementation(async path=>path.includes('findContacts')?[
    {remoteJid:lid,pushName:'Ana Silva'},{remoteJid:`${otherPhone}@s.whatsapp.net`,pushName:'Outro cliente'},
    {remoteJid:'120363000000@g.us',pushName:'Grupo não é cliente'},{remoteJid:'100000000000002@lid',pushName:'100000000000002'}
  ]:[
    {remoteJid:lid,lastMessage:{key:{remoteJid:lid,remoteJidAlt:`${phone}@s.whatsapp.net`}}},
    {remoteJid:'100000000000002@lid',lastMessage:{key:{remoteJid:'100000000000002@lid',remoteJidAlt:`${otherPhone}@s.whatsapp.net`}}}
  ]);
  const result=await syncContactIdentities(db,evolution,tenantId);
  expect(result.failed).toBe(0);expect(result.conflicts).toBe(1);
  expect((await profile()).display_name).toBe('Ana Silva');expect((await profile()).phone).toBe(phone);
  expect((await profile(conflictId)).phone).toBeNull();expect((await profile(conflictId)).display_name).toBeNull();
  expect(Number((await db.tx(tenantId,tx=>tx.query('SELECT count(*) AS total FROM customers'))).rows[0].total)).toBe(3);
  const revision=(await profile()).identity_revision;
  expect((await syncContactIdentities(db,evolution,tenantId)).updated).toBe(0);
  expect((await profile()).identity_revision).toBe(revision);
});

it('edits identity with validation, collision protection, audit and precedence over automatic updates',async()=>{
  const before=await profile();
  const payload={expectedRevision:before.identity_revision,name:'Ana — cliente VIP',phone:'+55 (21) 99876-5432'};
  const save=await app.inject({url:`/v1/workspace/customers/${customerId}/identity`,method:'PATCH',headers,payload});
  expect(save.statusCode,save.body).toBe(200);
  await syncContactIdentities(db,evolution,tenantId);
  expect((await profile()).display_name).toBe(payload.name);expect((await profile()).phone).toBe('5521998765432');
  expect((await app.inject({url:`/v1/workspace/customers/${customerId}/identity`,method:'PATCH',headers,payload})).statusCode).toBe(409);
  const current=await profile();
  expect((await app.inject({url:`/v1/workspace/customers/${customerId}/identity`,method:'PATCH',headers,payload:{...payload,expectedRevision:current.identity_revision,phone:`+${otherPhone}`}})).statusCode).toBe(409);
  for(const invalid of [{name:'100000000000001',phone:''},{name:'Ana',phone:'123'}])expect((await app.inject({url:`/v1/workspace/customers/${customerId}/identity`,method:'PATCH',headers,payload:{expectedRevision:current.identity_revision,...invalid}})).statusCode).toBe(400);
  const cleared=await app.inject({url:`/v1/workspace/customers/${customerId}/identity`,method:'PATCH',headers,payload:{expectedRevision:current.identity_revision,name:'',phone:''}});
  expect(cleared.statusCode,cleared.body).toBe(200);
  expect((await profile()).display_name).toBe('Ana Silva');expect((await profile()).phone).toBe(phone);
  expect((await db.tx(tenantId,tx=>tx.query("SELECT id FROM audit_events WHERE action='customer_identified'"))).rowCount).toBe(2);
});

it('preserves existing identities when the provider fails or returns an invalid contract',async()=>{
  vi.mocked(evolution.request).mockResolvedValue({unexpected:true});
  expect((await syncContactIdentities(db,evolution,tenantId)).failed).toBe(1);
  expect((await profile()).display_name).toBe('Ana Silva');expect((await profile()).phone).toBe(phone);
});
