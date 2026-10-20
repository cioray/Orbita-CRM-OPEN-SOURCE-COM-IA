CREATE TABLE conversation_catalog (
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  analysis_id uuid NOT NULL,
  settings_version integer NOT NULL,
  taxonomy_version text NOT NULL,
  subject text NOT NULL CHECK(subject IN ('support','finance','sales','personal')),
  finance text NOT NULL CHECK(finance IN ('customer_owes','business_owes','no_active_debt')),
  status text NOT NULL CHECK(status IN ('first_contact','already_served','in_progress')),
  mood text NOT NULL CHECK(mood IN ('neutral','dissatisfied','satisfied')),
  confidence jsonb NOT NULL,
  decision jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,conversation_id,analysis_id),
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),
  FOREIGN KEY(tenant_id,analysis_id) REFERENCES analysis_runs(tenant_id,id)
);
ALTER TABLE conversation_catalog ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversation_catalog USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON conversation_catalog TO motor_app;

UPDATE tenant_settings
SET settings = jsonb_build_object(
  'segments', settings->'segments',
  'review', COALESCE(settings->'review','{"mode":"manual","confidenceThreshold":0.95,"allowedAutoLabels":[]}'::jsonb),
  'analysis', '{"provider":"openrouter","model":"typesafe/jev-1.14","enabled":true}'::jsonb,
  'audio', '{"provider":"unconfigured","model":"","language":"pt"}'::jsonb,
  'documents', '{"provider":"local","model":"","maxBytes":20971520}'::jsonb,
  'debounceSeconds', COALESCE(settings->'debounceSeconds','20'::jsonb),
  'maxWaitSeconds', COALESCE(settings->'maxWaitSeconds','60'::jsonb),
  'retentionDays', settings->'retentionDays'
);

