CREATE TABLE crm_tasks (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  due_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','completed')),
  priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','high')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id)
);
CREATE INDEX crm_tasks_due ON crm_tasks(tenant_id,due_at);
CREATE TABLE crm_records (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('request','service','opportunity','note')),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','in_progress','completed','cancelled')),
  amount numeric(18,2) CHECK(amount>=0),
  evidence_message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id),
  FOREIGN KEY(tenant_id,evidence_message_id) REFERENCES messages(tenant_id,id)
);
CREATE TABLE crm_customer_stages (
  tenant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  stage text NOT NULL CHECK(stage IN ('new','qualified','proposal','customer','recurring')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,customer_id),
  FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id)
);
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['crm_tasks','crm_records','crm_customer_stages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',table_name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO motor_app',table_name);
  END LOOP;
END $$;
