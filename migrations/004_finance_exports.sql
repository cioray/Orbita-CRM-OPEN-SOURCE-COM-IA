CREATE TABLE commitments (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  case_id uuid,
  title text NOT NULL,
  amount numeric(18,2) NOT NULL CHECK(amount>=0),
  currency text NOT NULL DEFAULT 'BRL' CHECK(currency='BRL'),
  due_at date,
  state text NOT NULL DEFAULT 'confirmed' CHECK(state IN ('confirmed','cancelled','disputed')),
  revision integer NOT NULL DEFAULT 1,
  confirmed_by text NOT NULL,
  external_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,external_ref),
  FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id),
  FOREIGN KEY(tenant_id,case_id) REFERENCES cases(tenant_id,id)
);
CREATE TABLE commitment_facts (
  tenant_id uuid NOT NULL,
  commitment_id uuid NOT NULL,
  fact_id uuid NOT NULL,
  PRIMARY KEY(tenant_id,commitment_id,fact_id),
  FOREIGN KEY(tenant_id,commitment_id) REFERENCES commitments(tenant_id,id),
  FOREIGN KEY(tenant_id,fact_id) REFERENCES facts(tenant_id,id)
);
CREATE TABLE confirmed_payments (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  commitment_id uuid NOT NULL,
  amount numeric(18,2) NOT NULL CHECK(amount>0),
  confirmed_by text NOT NULL,
  confirmation_source text NOT NULL CHECK(confirmation_source IN ('human','external_system')),
  external_ref text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,external_ref),
  FOREIGN KEY(tenant_id,commitment_id) REFERENCES commitments(tenant_id,id)
);
CREATE TABLE export_consumers (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,name)
);
CREATE TABLE export_deliveries (
  tenant_id uuid NOT NULL,
  consumer_id uuid NOT NULL,
  event_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  acknowledged_at timestamptz,
  external_id text,
  PRIMARY KEY(tenant_id,consumer_id,event_id),
  FOREIGN KEY(tenant_id,consumer_id) REFERENCES export_consumers(tenant_id,id),
  FOREIGN KEY(tenant_id,event_id) REFERENCES outbox_events(tenant_id,id)
);
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['commitments','commitment_facts','confirmed_payments','export_consumers','export_deliveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',table_name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO motor_app',table_name);
  END LOOP;
END $$;
