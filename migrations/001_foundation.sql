CREATE TABLE tenant_directory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenant_directory(id),
  version integer NOT NULL DEFAULT 1,
  settings jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connections (
  tenant_id uuid NOT NULL REFERENCES tenant_directory(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  instance_name text NOT NULL,
  state text NOT NULL DEFAULT 'unknown',
  enabled boolean NOT NULL DEFAULT true,
  last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,instance_name)
);

CREATE TABLE inbox_events (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  fingerprint text NOT NULL,
  event_type text NOT NULL,
  source text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,connection_id) REFERENCES connections(tenant_id,id),
  UNIQUE(tenant_id,connection_id,fingerprint)
);

CREATE TABLE customers (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  display_name text,
  role text NOT NULL DEFAULT 'unknown',
  profile jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id)
);

CREATE TABLE conversations (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  source_jid text NOT NULL,
  customer_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  last_message_at timestamptz,
  first_message_at timestamptz,
  analysis_status text NOT NULL DEFAULT 'pending',
  analysis_revision bigint NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,connection_id) REFERENCES connections(tenant_id,id),
  FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id),
  UNIQUE(tenant_id,connection_id,source_jid)
);

CREATE TABLE identity_aliases (
  tenant_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  source_jid text NOT NULL,
  conversation_id uuid NOT NULL,
  proof text NOT NULL,
  PRIMARY KEY(tenant_id,connection_id,source_jid),
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id)
);

CREATE TABLE messages (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  source_id text NOT NULL,
  source_jid text NOT NULL,
  from_me boolean NOT NULL,
  kind text NOT NULL,
  body text,
  occurred_at timestamptz,
  source_timestamp bigint,
  reply_to text,
  revision integer NOT NULL DEFAULT 1,
  content_hash text NOT NULL,
  raw jsonb NOT NULL DEFAULT '{}',
  status text,
  deleted_at timestamptz,
  edited_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,connection_id) REFERENCES connections(tenant_id,id),
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),
  UNIQUE(tenant_id,connection_id,source_jid,source_id,from_me)
);
CREATE INDEX messages_conversation_time ON messages(tenant_id,conversation_id,occurred_at,id);

CREATE TABLE message_revisions (
  tenant_id uuid NOT NULL,
  message_id uuid NOT NULL,
  revision integer NOT NULL,
  content_hash text NOT NULL,
  body text,
  kind text NOT NULL,
  event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,message_id,revision),
  FOREIGN KEY(tenant_id,message_id) REFERENCES messages(tenant_id,id)
);

CREATE TABLE message_tombstones (
  tenant_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  source_jid text NOT NULL,
  source_id text NOT NULL,
  from_me boolean NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,connection_id,source_jid,source_id,from_me),
  FOREIGN KEY(tenant_id,connection_id) REFERENCES connections(tenant_id,id)
);

CREATE TABLE workflow_jobs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  dedup_key text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  priority integer NOT NULL DEFAULT 10,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  dispatched_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,kind,dedup_key)
);
CREATE INDEX jobs_pending ON workflow_jobs(tenant_id,state,available_at,priority);

CREATE TABLE sync_runs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  from_time timestamptz NOT NULL,
  to_time timestamptz NOT NULL,
  page integer NOT NULL DEFAULT 1,
  pass integer NOT NULL DEFAULT 1,
  source_total bigint,
  scanned bigint NOT NULL DEFAULT 0,
  accepted bigint NOT NULL DEFAULT 0,
  ignored bigint NOT NULL DEFAULT 0,
  checkpoint jsonb NOT NULL DEFAULT '{}',
  report jsonb NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,connection_id) REFERENCES connections(tenant_id,id)
);

CREATE TABLE sync_manifest (
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  pass integer NOT NULL,
  source_key text NOT NULL,
  content_hash text NOT NULL,
  PRIMARY KEY(tenant_id,run_id,pass,source_key),
  FOREIGN KEY(tenant_id,run_id) REFERENCES sync_runs(tenant_id,id)
);

CREATE TABLE media_assets (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL,
  message_revision integer NOT NULL,
  kind text NOT NULL,
  mime_type text,
  filename text,
  declared_bytes bigint,
  stored_bytes bigint,
  sha256 text,
  storage_key text,
  status text NOT NULL DEFAULT 'pending',
  provider text,
  model text,
  extracted_text text,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,message_id) REFERENCES messages(tenant_id,id),
  UNIQUE(tenant_id,message_id,message_revision)
);

CREATE TABLE analysis_runs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  base_revision bigint NOT NULL,
  settings_version integer NOT NULL,
  taxonomy_version text NOT NULL,
  model text NOT NULL,
  input_hash text NOT NULL,
  input jsonb NOT NULL,
  result jsonb,
  state text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id)
);

CREATE TABLE cases (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  category text NOT NULL,
  state text NOT NULL DEFAULT 'new',
  title text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  manual_override boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id),
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id)
);

CREATE TABLE facts (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  case_id uuid,
  analysis_id uuid,
  kind text NOT NULL,
  value jsonb NOT NULL,
  publication_state text NOT NULL DEFAULT 'proposed',
  dedup_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id),
  FOREIGN KEY(tenant_id,case_id) REFERENCES cases(tenant_id,id),
  FOREIGN KEY(tenant_id,analysis_id) REFERENCES analysis_runs(tenant_id,id),
  UNIQUE(tenant_id,dedup_key)
);

CREATE TABLE evidence_links (
  tenant_id uuid NOT NULL,
  fact_id uuid NOT NULL,
  message_id uuid NOT NULL,
  message_revision integer NOT NULL,
  span_start integer,
  span_end integer,
  PRIMARY KEY(tenant_id,fact_id,message_id,message_revision),
  FOREIGN KEY(tenant_id,fact_id) REFERENCES facts(tenant_id,id),
  FOREIGN KEY(tenant_id,message_id,message_revision) REFERENCES message_revisions(tenant_id,message_id,revision)
);

CREATE TABLE review_tasks (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  analysis_id uuid,
  fact_id uuid,
  case_id uuid,
  reason text NOT NULL,
  proposal jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  resolution jsonb,
  resolved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,analysis_id) REFERENCES analysis_runs(tenant_id,id),
  FOREIGN KEY(tenant_id,fact_id) REFERENCES facts(tenant_id,id),
  FOREIGN KEY(tenant_id,case_id) REFERENCES cases(tenant_id,id)
);

CREATE TABLE outbox_events (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  revision bigint NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,event_type,aggregate_id,revision)
);

CREATE TABLE audit_events (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  actor text NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id)
);

DO $$
DECLARE table_name text;
BEGIN
  FOR table_name IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('tenant_directory','schema_migrations') LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO motor_app', table_name);
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA public TO motor_app;
GRANT SELECT ON tenant_directory TO motor_app;
