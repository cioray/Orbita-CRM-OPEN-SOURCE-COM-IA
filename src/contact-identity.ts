import {z} from 'zod';
import type {Database} from './db.js';
import type {Evolution} from './evolution.js';
import {AppError,record} from './util.js';
import {isPrivateJid} from './normalize.js';

export function contactName(value:unknown):string|null{
  if(typeof value!=='string')return null;
  const name=value.trim();
  return name&&name.length<=200&&!/^[+\d\s().-]+$/.test(name)&&!/@(lid|g\.us|s\.whatsapp\.net)$/.test(name)&&!/^[a-f\d]{8}-[a-f\d-]{27,}$/i.test(name)?name:null;
}
const phoneFromJid=(jid:string)=>/^[1-9][0-9]{7,14}(:[0-9]+)?@s\.whatsapp\.net$/.test(jid)?jid.split('@')[0]!.split(':')[0]!:null;
export const ContactIdentityInput=z.object({expectedRevision:z.number().int().positive(),name:z.string().trim().max(200).refine(value=>!value||contactName(value)!==null),phone:z.string().trim().max(40).transform(value=>value.replace(/[\s().-]/g,'')).refine(value=>!value||/^\+[1-9][0-9]{7,14}$/.test(value))}).strict();

export async function identifyCustomer(db:Database,tenantId:string,id:string,input:z.infer<typeof ContactIdentityInput>){
  return db.tx(tenantId,async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact-identity/${tenantId}`]);
    const customer=(await tx.query('SELECT * FROM customers WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!customer||!(await tx.query('SELECT id FROM crm_customer_identity WHERE id=$1',[id])).rowCount)throw new AppError('customer_not_found',404);
    if(customer.identity_revision!==input.expectedRevision)throw new AppError('identity_revision_conflict',409);
    const phone=input.phone.replace(/^\+/,'');
    if(phone&&(await tx.query('SELECT id FROM crm_customer_identity WHERE phone=$1 AND id<>$2 LIMIT 1',[phone,id])).rowCount)throw new AppError('phone_already_identified',409);
    await tx.query("UPDATE customers SET profile=(profile-'name'-'phone')||$2::jsonb,identity_revision=identity_revision+1 WHERE id=$1",[id,{...(input.name?{name:input.name}:{}),...(phone?{phone}:{})}]);
    await tx.query("INSERT INTO audit_events(tenant_id,actor,action,target,metadata) VALUES($1,'crm-admin','customer_identified',$2,$3)",[tenantId,id,{previous:{name:customer.profile.name,phone:customer.profile.phone},name:input.name,phone}]);
    return (await tx.query('SELECT * FROM crm_customer_identity WHERE id=$1',[id])).rows[0];
  });
}

export async function syncContactIdentities(db:Database,evolution:Evolution,tenantId:string){
  const connections=await db.tx(tenantId,async tx=>(await tx.query('SELECT id,instance_name FROM connections WHERE enabled')).rows);
  const report={connections:0,updated:0,mappings:0,conflicts:0,failed:0};
  for(const connection of connections){
    try{
      const [contacts,chats]=await Promise.all(['findContacts','findChats'].map(path=>evolution.request(`/chat/${path}/${encodeURIComponent(connection.instance_name)}`,{where:{}})));
      if(!Array.isArray(contacts)||!Array.isArray(chats))throw new AppError('evolution_contacts_contract_invalid',502);
      const result=await db.tx(tenantId,async tx=>{
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact-identity/${tenantId}`]);
        const names=new Map<string,string>();
        const pairs=new Map<string,Set<string>>();
        const addPair=(value:unknown)=>{
          const key=record(value);const jid=key.remoteJid;const alt=key.remoteJidAlt;
          if(!isPrivateJid(jid)||!isPrivateJid(alt))return;
          const lid=jid.endsWith('@lid')?jid:alt.endsWith('@lid')?alt:null;
          const phone=phoneFromJid(jid)||phoneFromJid(alt);
          if(lid&&phone){const phones=pairs.get(lid)||new Set<string>();phones.add(phone);pairs.set(lid,phones);}
        };
        for(const raw of contacts){const item=record(raw);if(!isPrivateJid(item.remoteJid)||item.isGroup===true)continue;const name=contactName(item.pushName);if(name)names.set(item.remoteJid,name);}
        for(const raw of chats){const item=record(raw);if(!isPrivateJid(item.remoteJid))continue;const message=record(item.lastMessage);addPair(message.key);const name=contactName(item.pushName)||(!record(message.key).fromMe?contactName(message.pushName):null);if(name&&!names.has(item.remoteJid))names.set(item.remoteJid,name);}
        const keys=(await tx.query("SELECT DISTINCT raw->'key' AS key FROM messages WHERE connection_id=$1 AND deleted_at IS NULL AND raw->'key'->>'remoteJidAlt' IS NOT NULL",[connection.id])).rows;
        for(const row of keys)addPair(row.key);
        const conversations=(await tx.query(`SELECT cv.id,cv.customer_id,cv.source_jid,ARRAY(SELECT source_jid FROM identity_aliases WHERE connection_id=cv.connection_id AND conversation_id=cv.id) AS aliases FROM crm_private_conversations cv WHERE connection_id=$1`,[connection.id])).rows;
        let updated=0,mappings=0,conflicts=0;
        for(const conversation of conversations){
          const aliases=[conversation.source_jid,...conversation.aliases] as string[];
          const name=aliases.map(jid=>names.get(jid)).find(Boolean);
          const phones=new Set<string>();
          for(const jid of aliases){const phone=phoneFromJid(jid);if(phone)phones.add(phone);for(const mapped of pairs.get(jid)||[])phones.add(mapped);}
          let phone=phones.size===1?[...phones][0]:null;
          if(phones.size>1){conflicts++;phone=null;}
          if(phone){
            const jid=`${phone}@s.whatsapp.net`;
            const inserted=await tx.query("INSERT INTO identity_aliases(tenant_id,connection_id,source_jid,conversation_id,proof) VALUES($1,$2,$3,$4,'provider_remote_jid_alt') ON CONFLICT DO NOTHING RETURNING source_jid",[tenantId,connection.id,jid,conversation.id]);
            const owner=(await tx.query('SELECT conversation_id FROM identity_aliases WHERE connection_id=$1 AND source_jid=$2',[connection.id,jid])).rows[0];
            if(owner?.conversation_id!==conversation.id){conflicts++;phone=null;}else mappings+=inserted.rowCount||0;
          }
          const changes={...(name?{evolution_name:name}:{}),...(phone?{evolution_phone:phone}:{})};
          if(Object.keys(changes).length){const result=await tx.query('UPDATE customers SET profile=profile||$2::jsonb,identity_revision=identity_revision+1 WHERE id=$1 AND NOT profile @> $2::jsonb',[conversation.customer_id,changes]);updated+=result.rowCount||0;}
        }
        await tx.query("INSERT INTO audit_events(tenant_id,actor,action,target,metadata) VALUES($1,'system','contact_identity_sync',$2,$3)",[tenantId,connection.id,{updated,mappings,conflicts,providerContacts:contacts.length}]);
        return {updated,mappings,conflicts};
      });
      report.connections++;report.updated+=result.updated;report.mappings+=result.mappings;report.conflicts+=result.conflicts;
    }catch{report.failed++;}
  }
  return report;
}

export function startContactIdentitySync(db:Database,evolution:Evolution,tenantId:string){
  let running:Promise<unknown>|null=null;
  const run=()=>{if(!running)running=syncContactIdentities(db,evolution,tenantId).then(report=>console.log(JSON.stringify({event:'contact_identity_sync',...report}))).catch(()=>console.error(JSON.stringify({event:'contact_identity_sync_failed'}))).finally(()=>{running=null;});};
  const timer=setInterval(run,10*60*1000);timer.unref();run();
  return async()=>{clearInterval(timer);await running;};
}
