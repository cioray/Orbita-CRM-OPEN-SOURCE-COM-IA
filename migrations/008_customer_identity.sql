CREATE VIEW crm_customer_identity WITH (security_invoker=true) AS
SELECT c.tenant_id,c.id,
  COALESCE(NULLIF(c.profile->>'name',''),NULLIF(c.display_name,''),contact_name.name) AS display_name,
  COALESCE(telephone.phone,CASE WHEN c.profile->>'phone' ~ '^\+?[1-9][0-9]{7,14}$' THEN regexp_replace(c.profile->>'phone','[^0-9]','','g') END) AS phone
FROM customers c
LEFT JOIN LATERAL (
  SELECT split_part(split_part(a.source_jid,'@',1),':',1) AS phone
  FROM conversations cv JOIN identity_aliases a ON a.tenant_id=cv.tenant_id AND a.conversation_id=cv.id
  WHERE cv.tenant_id=c.tenant_id AND cv.customer_id=c.id AND cv.deleted_at IS NULL
    AND a.source_jid ~ '^[1-9][0-9]{7,14}(:[0-9]+)?@s\.whatsapp\.net$'
  ORDER BY cv.last_message_at DESC NULLS LAST,a.source_jid LIMIT 1
) telephone ON true
LEFT JOIN LATERAL (
  SELECT NULLIF(m.raw->>'pushName','') AS name
  FROM conversations cv JOIN messages m ON m.tenant_id=cv.tenant_id AND m.conversation_id=cv.id
  WHERE cv.tenant_id=c.tenant_id AND cv.customer_id=c.id AND cv.deleted_at IS NULL
    AND m.deleted_at IS NULL AND m.from_me=false AND NULLIF(m.raw->>'pushName','') IS NOT NULL
  ORDER BY m.occurred_at DESC NULLS LAST,m.id LIMIT 1
) contact_name ON true;
GRANT SELECT ON crm_customer_identity TO motor_app;
