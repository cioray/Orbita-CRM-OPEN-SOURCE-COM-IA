import { z } from 'zod';
import type { Database } from './db.js';
import { AppError, record } from './util.js';

export const ReviewResolution = z.object({
  action: z.enum(['accept', 'reject', 'correct']),
  actor: z.string().min(2).max(100),
  expectedCaseRevision: z.number().int().positive().optional(),
  state: z.enum(['new', 'triage', 'in_progress', 'waiting_business', 'waiting_customer', 'resolved', 'cancelled', 'reopened']).optional(),
  value: z.object({ amount: z.string().regex(/^\d{1,15}\.\d{2}$/), currency: z.literal('BRL') }).optional(),
  note: z.string().max(2000).default('')
}).strict();

export async function resolveReview(db: Database, tenantId: string, taskId: string, input: z.infer<typeof ReviewResolution>) {
  return db.tx(tenantId, async transaction => {
    const task = (await transaction.query('SELECT * FROM review_tasks WHERE id=$1 FOR UPDATE', [taskId])).rows[0];
    if (!task) throw new AppError('review_not_found', 404);
    if (task.state !== 'pending') throw new AppError('review_already_resolved', 409);
    const proposal = record(task.proposal);
    if (task.fact_id) {
      const fact = (await transaction.query('SELECT * FROM facts WHERE id=$1 FOR UPDATE', [task.fact_id])).rows[0];
      if (!fact || fact.publication_state === 'invalidated') throw new AppError('evidence_invalidated', 409);
      const state = input.action === 'reject' ? 'rejected' : 'human_reviewed';
      const value = input.value ? { ...fact.value, ...input.value, confirmation: 'human_reviewed_statement_not_bank_confirmation' } : fact.value;
      await transaction.query('UPDATE facts SET publication_state=$2,value=$3 WHERE id=$1', [task.fact_id, state, value]);
      await transaction.query(`INSERT INTO outbox_events(tenant_id,event_type,aggregate_id,revision,payload) VALUES($1,'fact.reviewed',$2,1,$3) ON CONFLICT DO NOTHING`, [tenantId, task.fact_id, { factId: task.fact_id, state, value }]);
    }
    if (task.case_id && input.action !== 'reject') {
      const expectedRevision = input.expectedCaseRevision ?? Number(proposal.baseCaseRevision);
      if (!Number.isSafeInteger(expectedRevision)) throw new AppError('case_revision_required');
      const nextState = input.state ?? proposal.state;
      if (!['new', 'triage', 'in_progress', 'waiting_business', 'waiting_customer', 'resolved', 'cancelled', 'reopened'].includes(String(nextState))) throw new AppError('invalid_case_state');
      if (proposal.messageId) {
        const evidence = (await transaction.query('SELECT revision,deleted_at FROM messages WHERE id=$1', [proposal.messageId])).rows[0];
        if (!evidence || evidence.deleted_at || evidence.revision !== proposal.messageRevision) throw new AppError('evidence_changed', 409);
      }
      const updated = await transaction.query(`UPDATE cases SET state=$2,revision=revision+1,manual_override=true,updated_at=now() WHERE id=$1 AND revision=$3 RETURNING revision`, [task.case_id, nextState, expectedRevision]);
      if (!updated.rowCount) throw new AppError('case_revision_conflict', 409);
      await transaction.query("INSERT INTO outbox_events(tenant_id,event_type,aggregate_id,revision,payload) VALUES($1,'case.state_changed',$2,$3,$4)", [tenantId, task.case_id, updated.rows[0].revision, { caseId: task.case_id, state: nextState, decisionSource: 'human' }]);
    }
    await transaction.query("UPDATE review_tasks SET state='resolved',resolution=$2,resolved_by=$3,resolved_at=now() WHERE id=$1", [taskId, input, input.actor]);
    await transaction.query("INSERT INTO audit_events(tenant_id,actor,action,target,metadata) VALUES($1,$2,'review_resolved',$3,$4)", [tenantId, input.actor, taskId, { action: input.action }]);
    return { resolved: true };
  });
}
