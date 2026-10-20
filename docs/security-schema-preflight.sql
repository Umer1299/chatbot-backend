-- Read-only audit. Review results before applying pending migrations 005/006/007.
-- Counts only: no visitor contact data is returned.
SELECT COUNT(*) AS sessions_without_business FROM sessions WHERE business_id IS NULL;
SELECT COUNT(*) AS messages_without_owner_or_session FROM messages
 WHERE business_id IS NULL OR session_id IS NULL;
SELECT COUNT(*) AS mismatched_message_sessions FROM messages m
 LEFT JOIN sessions s ON s.id=m.session_id AND s.business_id=m.business_id
 WHERE m.session_id IS NOT NULL AND m.business_id IS NOT NULL AND s.id IS NULL;
SELECT COUNT(*) AS mismatched_lead_sessions FROM leads l
 LEFT JOIN sessions s ON s.id=l.session_id AND s.business_id=l.business_id
 WHERE l.session_id IS NOT NULL AND s.id IS NULL;
SELECT COUNT(*) AS mismatched_inquiry_sessions FROM inquiries i
 LEFT JOIN sessions s ON s.id=i.session_id AND s.business_id=i.business_id
 WHERE i.session_id IS NOT NULL AND s.id IS NULL;
SELECT COUNT(*) AS mismatched_session_leads FROM sessions s
 JOIN leads l ON l.id=s.lead_id
 WHERE l.business_id IS DISTINCT FROM s.business_id;
SELECT COUNT(*) AS duplicate_global_pipeline_stages FROM (
 SELECT industry, stage_key FROM pipeline_stages WHERE business_id IS NULL
 GROUP BY industry, stage_key HAVING COUNT(*)>1
) duplicates;

SELECT COUNT(*) AS orphaned_knowledge_businesses FROM knowledge_chunks k
 LEFT JOIN businesses b ON b.id=k.business_id WHERE b.id IS NULL;
-- Catalog-only shape checks: IF NOT EXISTS is not a schema repair mechanism.
SELECT tablename, indexname, indexdef FROM pg_indexes
 WHERE schemaname=current_schema() AND tablename IN ('sessions','messages','chatbot_settings');
SELECT conrelid::regclass AS table_name, conname, convalidated, pg_get_constraintdef(oid) AS definition
 FROM pg_constraint WHERE connamespace=(SELECT oid FROM pg_namespace WHERE nspname=current_schema())
 AND conname IN ('messages_session_business_fk','messages_tenant_required','sessions_tenant_required');
