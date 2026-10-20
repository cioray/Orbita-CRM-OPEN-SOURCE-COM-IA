ALTER TABLE crm_records ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE commitments ADD COLUMN service_id uuid;
ALTER TABLE commitments ADD CONSTRAINT commitments_service_fk FOREIGN KEY(tenant_id,service_id) REFERENCES crm_records(tenant_id,id);
ALTER TABLE commitments ADD CONSTRAINT commitments_service_unique UNIQUE(tenant_id,service_id);
ALTER TABLE confirmed_payments ADD COLUMN voided_at timestamptz;
ALTER TABLE confirmed_payments ADD COLUMN void_reason text;
CREATE INDEX payments_active_commitment ON confirmed_payments(tenant_id,commitment_id) WHERE voided_at IS NULL;
INSERT INTO commitments(tenant_id,customer_id,service_id,title,amount,confirmed_by,external_ref)
SELECT tenant_id,customer_id,id,title,amount,'crm-service-migration','service-'||id::text FROM crm_records
WHERE kind='service' AND state IN ('in_progress','completed') AND amount IS NOT NULL
ON CONFLICT(tenant_id,external_ref) DO NOTHING;
