import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database,Transaction} from './db.js';
import {AppError} from './util.js';

const Amount=z.string().regex(/^\d{1,15}\.\d{2}$/);
const cents=(value:string)=>BigInt(value.replace('.',''));
export const ServiceFinanceInput=z.object({recordId:z.uuid().optional(),expectedRevision:z.number().int().positive().optional(),customerId:z.uuid(),title:z.string().min(1).max(200),description:z.string().max(10000).default(''),amount:Amount,receivedTotal:Amount,dueAt:z.iso.date().nullable().default(null),state:z.enum(['open','in_progress','completed','cancelled']),evidenceMessageId:z.uuid().optional(),stageAfterSave:z.enum(['service_in_progress','service_delivered']).optional()}).strict().refine(input=>cents(input.receivedTotal)<=cents(input.amount),{message:'received_exceeds_service_amount',path:['receivedTotal']});
export const FinancialEditInput=z.object({expectedRevision:z.number().int().positive(),title:z.string().min(1).max(200),amount:Amount,receivedTotal:Amount,dueAt:z.iso.date().nullable(),serviceId:z.uuid().nullable(),state:z.enum(['confirmed','cancelled','disputed'])}).strict().refine(input=>cents(input.receivedTotal)<=cents(input.amount),{message:'received_exceeds_service_amount',path:['receivedTotal']});

export async function setReceivedTotal(tx:Transaction,tenantId:string,commitmentId:string,total:string){
  const previous=(await tx.query('SELECT COALESCE(sum(amount),0)::numeric(18,2)::text AS total FROM confirmed_payments WHERE commitment_id=$1 AND voided_at IS NULL',[commitmentId])).rows[0].total;
  if(cents(previous)===cents(total))return;
  await tx.query("UPDATE confirmed_payments SET voided_at=now(),void_reason='Correção manual do total recebido no CRM' WHERE commitment_id=$1 AND voided_at IS NULL",[commitmentId]);
  if(cents(total)>0n)await tx.query(`INSERT INTO confirmed_payments(tenant_id,commitment_id,amount,confirmed_by,confirmation_source,external_ref,occurred_at) VALUES($1,$2,$3,'crm-admin','human',$4,now())`,[tenantId,commitmentId,total,`crm-payment-${randomUUID()}`]);
}

export async function syncServiceCommitment(tx:Transaction,tenantId:string,service:Record<string,any>){
  const previous=(await tx.query('SELECT * FROM commitments WHERE service_id=$1 FOR UPDATE',[service.id])).rows[0];
  if(!previous&&!['in_progress','completed'].includes(service.state))return null;
  if(service.amount===null||service.amount===undefined)throw new AppError('service_price_required',400);
  const paid=(await tx.query('SELECT COALESCE(sum(amount),0)::numeric(18,2)::text AS total FROM confirmed_payments WHERE commitment_id=$1 AND voided_at IS NULL',[previous?.id??null])).rows[0].total;
  if(cents(paid)>cents(String(service.amount)))throw new AppError('service_amount_below_received',409);
  const result=await tx.query(`INSERT INTO commitments(tenant_id,customer_id,service_id,title,amount,confirmed_by,external_ref,state)
    VALUES($1,$2,$3,$4,$5,'crm-admin',$6,$7) ON CONFLICT(tenant_id,service_id) DO UPDATE SET title=EXCLUDED.title,amount=EXCLUDED.amount,state=EXCLUDED.state,revision=commitments.revision+1 RETURNING *`,[tenantId,service.customer_id,service.id,service.title,service.amount,`service-${service.id}`,service.state==='cancelled'?'cancelled':'confirmed']);
  return result.rows[0];
}

export async function saveServiceFinance(db:Database,tenantId:string,input:z.infer<typeof ServiceFinanceInput>){
  return db.tx(tenantId,async tx=>{
    if(!(await tx.query('SELECT id FROM customers WHERE id=$1',[input.customerId])).rowCount)throw new AppError('customer_not_found',404);
    if(input.evidenceMessageId&&!(await tx.query('SELECT 1 FROM messages m JOIN conversations cv ON cv.id=m.conversation_id AND cv.tenant_id=m.tenant_id WHERE m.id=$1 AND cv.customer_id=$2',[input.evidenceMessageId,input.customerId])).rowCount)throw new AppError('invalid_customer_evidence',400);
    let service;
    let previousState:string|null=null;
    if(input.recordId){
      service=(await tx.query("SELECT * FROM crm_records WHERE id=$1 AND customer_id=$2 AND kind='service' FOR UPDATE",[input.recordId,input.customerId])).rows[0];
      if(!service)throw new AppError('service_not_found',404);
      previousState=service.state;
      if(!input.expectedRevision||service.revision!==input.expectedRevision)throw new AppError('service_revision_conflict',409);
      service=(await tx.query('UPDATE crm_records SET title=$2,description=$3,amount=$4,state=$5,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',[service.id,input.title,input.description,input.amount,input.state])).rows[0];
    }else service=(await tx.query(`INSERT INTO crm_records(tenant_id,customer_id,kind,title,description,amount,state,evidence_message_id) VALUES($1,$2,'service',$3,$4,$5,$6,$7) RETURNING *`,[tenantId,input.customerId,input.title,input.description,input.amount,input.state,input.evidenceMessageId??null])).rows[0];
    const existing=(await tx.query('SELECT * FROM commitments WHERE service_id=$1 FOR UPDATE',[service.id])).rows[0];
    const commitment=existing?
      (await tx.query('UPDATE commitments SET title=$2,amount=$3,due_at=$4,state=$5,revision=revision+1 WHERE id=$1 RETURNING *',[existing.id,input.title,input.amount,input.dueAt,input.state==='cancelled'?'cancelled':'confirmed'])).rows[0]:
      (await tx.query(`INSERT INTO commitments(tenant_id,customer_id,service_id,title,amount,due_at,state,confirmed_by,external_ref) VALUES($1,$2,$3,$4,$5,$6,$7,'crm-admin',$8) RETURNING *`,[tenantId,input.customerId,service.id,input.title,input.amount,input.dueAt,input.state==='cancelled'?'cancelled':'confirmed',`service-${service.id}`])).rows[0];
    await setReceivedTotal(tx,tenantId,commitment.id,input.receivedTotal);
    const nextStage=input.stageAfterSave??(previousState!==input.state?(input.state==='in_progress'?'service_in_progress':input.state==='completed'?'service_delivered':null):null);
    if(nextStage){
      if((nextStage==='service_in_progress'&&input.state!=='in_progress')||(nextStage==='service_delivered'&&input.state!=='completed'))throw new AppError('service_stage_mismatch',400);
      await tx.query('INSERT INTO crm_customer_stages(tenant_id,customer_id,stage) VALUES($1,$2,$3) ON CONFLICT(tenant_id,customer_id) DO UPDATE SET stage=EXCLUDED.stage,updated_at=now()',[tenantId,input.customerId,nextStage]);
    }
    await tx.query("INSERT INTO audit_events(tenant_id,actor,action,target,metadata) VALUES($1,'crm-admin','service_finance_saved',$2,$3)",[tenantId,service.id,{amount:input.amount,receivedTotal:input.receivedTotal,state:input.state,commitmentId:commitment.id}]);
    await tx.query("INSERT INTO outbox_events(tenant_id,event_type,aggregate_id,revision,payload) VALUES($1,'financial.updated',$2,$3,$4)",[tenantId,commitment.id,commitment.revision,{customerId:input.customerId,serviceId:service.id,amount:input.amount,receivedTotal:input.receivedTotal,state:commitment.state}]);
    return {service,commitment};
  });
}

export async function editFinancialCommitment(db:Database,tenantId:string,id:string,input:z.infer<typeof FinancialEditInput>){
  return db.tx(tenantId,async tx=>{
    const targetService=input.serviceId?(await tx.query("SELECT * FROM crm_records WHERE id=$1 AND kind='service' FOR UPDATE",[input.serviceId])).rows[0]:null;
    const commitment=(await tx.query('SELECT * FROM commitments WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!commitment)throw new AppError('commitment_not_found',404);
    if(commitment.revision!==input.expectedRevision)throw new AppError('financial_revision_conflict',409);
    if(input.serviceId&&(!targetService||targetService.customer_id!==commitment.customer_id))throw new AppError('service_customer_mismatch',400);
    if(input.serviceId&&(await tx.query('SELECT 1 FROM commitments WHERE service_id=$1 AND id<>$2',[input.serviceId,id])).rowCount)throw new AppError('service_already_linked',409);
    const updated=(await tx.query('UPDATE commitments SET title=$2,amount=$3,due_at=$4,state=$5,service_id=$6,revision=revision+1 WHERE id=$1 RETURNING *',[id,input.title,input.amount,input.dueAt,input.state,input.serviceId])).rows[0];
    if(targetService)await tx.query("UPDATE crm_records SET title=$2,amount=$3,state=CASE WHEN $4='cancelled' THEN 'cancelled' ELSE state END,revision=revision+1,updated_at=now() WHERE id=$1",[targetService.id,input.title,input.amount,input.state]);
    await setReceivedTotal(tx,tenantId,id,input.receivedTotal);
    await tx.query("INSERT INTO audit_events(tenant_id,actor,action,target,metadata) VALUES($1,'crm-admin','financial_commitment_edited',$2,$3)",[tenantId,id,{previous:commitment,input}]);
    await tx.query("INSERT INTO outbox_events(tenant_id,event_type,aggregate_id,revision,payload) VALUES($1,'financial.updated',$2,$3,$4)",[tenantId,id,updated.revision,{customerId:commitment.customer_id,serviceId:input.serviceId,amount:input.amount,receivedTotal:input.receivedTotal,state:input.state}]);
    return updated;
  });
}
