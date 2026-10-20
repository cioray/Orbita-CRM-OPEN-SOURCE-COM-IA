import { z } from 'zod';
import type { Database } from './db.js';
import { AppError } from './util.js';

const Decimal = z.string().regex(/^\d{1,15}\.\d{2}$/);
export const CommitmentInput = z.object({ customerId: z.uuid(), caseId: z.uuid().optional(), title: z.string().min(1).max(200), amount: Decimal, currency: z.literal('BRL'), dueAt: z.iso.date().optional(), actor: z.string().min(2).max(100), externalRef: z.string().min(1).max(200), factIds: z.array(z.uuid()).max(100).default([]) }).strict();
export const PaymentInput = z.object({ amount: Decimal.refine(value => BigInt(value.replace('.', '')) > 0n), actor: z.string().min(2).max(100), externalRef: z.string().min(1).max(200), occurredAt: z.iso.datetime(), confirmationSource: z.enum(['human','external_system']) }).strict();

export async function createCommitment(db: Database, tenantId: string, input: z.infer<typeof CommitmentInput>) {
  return db.tx(tenantId, async transaction => {
    const customer = await transaction.query('SELECT id FROM customers WHERE id=$1', [input.customerId]);
    if (!customer.rowCount) throw new AppError('customer_not_found', 404);
    if (input.caseId && !(await transaction.query('SELECT 1 FROM cases WHERE id=$1 AND customer_id=$2', [input.caseId, input.customerId])).rowCount) throw new AppError('case_customer_mismatch');
    for (const factId of input.factIds) {
      if (!(await transaction.query("SELECT 1 FROM facts WHERE id=$1 AND customer_id=$2 AND publication_state NOT IN ('invalidated','rejected')", [factId, input.customerId])).rowCount) throw new AppError('invalid_financial_evidence');
    }
    const created = await transaction.query(`INSERT INTO commitments(tenant_id,customer_id,case_id,title,amount,currency,due_at,confirmed_by,external_ref)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING *`, [tenantId,input.customerId,input.caseId ?? null,input.title,input.amount,input.currency,input.dueAt ?? null,input.actor,input.externalRef]);
    if (!created.rowCount) {
      const existing = (await transaction.query('SELECT * FROM commitments WHERE external_ref=$1', [input.externalRef])).rows[0];
      if (existing.customer_id !== input.customerId || existing.amount !== input.amount) throw new AppError('financial_idempotency_conflict',409);
      return existing;
    }
    const commitment = created.rows[0];
    for (const factId of input.factIds) await transaction.query('INSERT INTO commitment_facts(tenant_id,commitment_id,fact_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [tenantId,commitment.id,factId]);
    await transaction.query("INSERT INTO audit_events(tenant_id,actor,action,target) VALUES($1,$2,'commitment_confirmed',$3)", [tenantId,input.actor,commitment.id]);
    await transaction.query("INSERT INTO outbox_events(tenant_id,event_type,aggregate_id,revision,payload) VALUES($1,'commitment.confirmed',$2,1,$3)", [tenantId,commitment.id,{commitmentId:commitment.id,customerId:input.customerId,amount:input.amount,currency:input.currency}]);
    return commitment;
  });
}

export async function confirmPayment(db: Database, tenantId: string, commitmentId: string, input: z.infer<typeof PaymentInput>) {
  return db.tx(tenantId, async transaction => {
    const commitment = (await transaction.query("SELECT * FROM commitments WHERE id=$1 AND state='confirmed' FOR UPDATE", [commitmentId])).rows[0];
    if (!commitment) throw new AppError('confirmed_commitment_not_found',404);
    const payment = await transaction.query(`INSERT INTO confirmed_payments(tenant_id,commitment_id,amount,confirmed_by,confirmation_source,external_ref,occurred_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING *`, [tenantId,commitmentId,input.amount,input.actor,input.confirmationSource,input.externalRef,input.occurredAt]);
    if (!payment.rowCount) {
      const existing = (await transaction.query('SELECT * FROM confirmed_payments WHERE external_ref=$1', [input.externalRef])).rows[0];
      if (existing.commitment_id !== commitmentId || existing.amount !== input.amount) throw new AppError('financial_idempotency_conflict',409);
      return existing;
    }
    await transaction.query("INSERT INTO audit_events(tenant_id,actor,action,target) VALUES($1,$2,'payment_confirmed',$3)", [tenantId,input.actor,payment.rows[0].id]);
    await transaction.query("INSERT INTO outbox_events(tenant_id,event_type,aggregate_id,revision,payload) VALUES($1,'payment.confirmed',$2,1,$3)", [tenantId,payment.rows[0].id,{paymentId:payment.rows[0].id,commitmentId,amount:input.amount}]);
    return payment.rows[0];
  });
}

export async function financialSummary(db: Database, tenantId: string, customerId: string) {
  return db.tx(tenantId, async transaction => {
    const commitments = (await transaction.query(`SELECT commitments.*,COALESCE(payments.paid,0)::numeric(18,2)::text AS paid,
      (amount-COALESCE(payments.paid,0))::numeric(18,2)::text AS balance,
      (due_at<CURRENT_DATE AND amount>COALESCE(payments.paid,0) AND state='confirmed') AS overdue
      FROM commitments LEFT JOIN LATERAL (SELECT sum(amount) AS paid FROM confirmed_payments WHERE commitment_id=commitments.id AND voided_at IS NULL) payments ON true
      WHERE customer_id=$1 ORDER BY created_at`, [customerId])).rows;
    return { currency:'BRL',basis:'human_or_authorized_system_confirmations',commitments,unconfirmedMentionsExcluded:true };
  });
}
