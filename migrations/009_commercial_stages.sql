ALTER TABLE crm_customer_stages DROP CONSTRAINT crm_customer_stages_stage_check;
UPDATE crm_customer_stages SET stage='service_in_progress',updated_at=now() WHERE stage='customer';
ALTER TABLE crm_customer_stages ADD CONSTRAINT crm_customer_stages_stage_check
  CHECK(stage IN ('new','qualified','proposal','service_in_progress','service_delivered','recurring','churn'));
