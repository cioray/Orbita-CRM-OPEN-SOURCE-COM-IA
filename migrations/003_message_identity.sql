CREATE UNIQUE INDEX message_logical_identity ON messages(tenant_id,connection_id,conversation_id,source_id,from_me);
