ALTER TABLE crm_customer_stages DROP CONSTRAINT crm_customer_stages_stage_check;
ALTER TABLE crm_customer_stages ADD CONSTRAINT crm_customer_stages_stage_check
  CHECK(stage IN ('new','qualified','proposal','service_in_progress','service_delivered','recurring','churn','disqualified','personal_contact'));
