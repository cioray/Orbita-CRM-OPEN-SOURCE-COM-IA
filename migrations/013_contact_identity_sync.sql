ALTER TABLE customers ADD COLUMN identity_revision integer NOT NULL DEFAULT 1;
CREATE FUNCTION crm_identity_name(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
SELECT CASE WHEN length(btrim(value)) BETWEEN 1 AND 200
  AND btrim(value) !~ '^[+0-9[:space:]().-]+$'
  AND btrim(value) !~ '@(lid|g\.us|s\.whatsapp\.net)$'
  AND btrim(value) !~* '^[a-f0-9]{8}-[a-f0-9-]{27,}$'
THEN btrim(value) END
$$;
CREATE OR REPLACE VIEW crm_customer_identity WITH (security_invoker=true) AS
SELECT c.tenant_id,c.id,
  COALESCE(crm_identity_name(c.profile->>'name'),crm_identity_name(c.profile->>'evolution_name'),crm_identity_name(c.display_name),contact_name.name) AS display_name,
  COALESCE(CASE WHEN c.profile->>'phone' ~ '^\+?[1-9][0-9]{7,14}$' THEN regexp_replace(c.profile->>'phone','[^0-9]','','g') END,telephone.phone) AS phone
FROM customers c
LEFT JOIN LATERAL (
  SELECT split_part(split_part(a.source_jid,'@',1),':',1) AS phone
  FROM crm_private_conversations cv JOIN identity_aliases a ON a.tenant_id=cv.tenant_id AND a.conversation_id=cv.id
  WHERE cv.tenant_id=c.tenant_id AND cv.customer_id=c.id
    AND a.source_jid ~ '^[1-9][0-9]{7,14}(:[0-9]+)?@s\.whatsapp\.net$'
  ORDER BY cv.last_message_at DESC NULLS LAST,a.source_jid LIMIT 1
) telephone ON true
LEFT JOIN LATERAL (
  SELECT crm_identity_name(m.raw->>'pushName') AS name
  FROM crm_private_conversations cv JOIN messages m ON m.tenant_id=cv.tenant_id AND m.conversation_id=cv.id
  WHERE cv.tenant_id=c.tenant_id AND cv.customer_id=c.id
    AND m.deleted_at IS NULL AND m.from_me=false AND crm_identity_name(m.raw->>'pushName') IS NOT NULL
  ORDER BY m.occurred_at DESC NULLS LAST,m.id LIMIT 1
) contact_name ON true
WHERE NOT EXISTS (
  SELECT 1 FROM conversations cv WHERE cv.tenant_id=c.tenant_id AND cv.customer_id=c.id AND cv.source_jid LIKE '%@g.us'
) OR EXISTS (
  SELECT 1 FROM crm_private_conversations cv WHERE cv.tenant_id=c.tenant_id AND cv.customer_id=c.id
);
GRANT SELECT ON crm_customer_identity TO motor_app;

