CREATE TABLE message_decisions (
  tenant_id uuid NOT NULL,
  message_id uuid NOT NULL,
  message_revision integer NOT NULL,
  analysis_id uuid NOT NULL,
  taxonomy_version text NOT NULL,
  settings_version integer NOT NULL,
  decision jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,message_id,message_revision,taxonomy_version,settings_version),
  FOREIGN KEY(tenant_id,message_id,message_revision) REFERENCES message_revisions(tenant_id,message_id,revision),
  FOREIGN KEY(tenant_id,analysis_id) REFERENCES analysis_runs(tenant_id,id)
);
ALTER TABLE message_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_decisions USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON message_decisions TO motor_app;
CREATE INDEX decisions_pending_lookup ON message_decisions(tenant_id,message_id,message_revision,settings_version);
CREATE INDEX facts_customer ON facts(tenant_id,customer_id,created_at);
CREATE INDEX cases_conversation ON cases(tenant_id,conversation_id,state);
