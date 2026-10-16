-- Read-only audit. Review results before deploying 005_security_boundaries.sql.
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
