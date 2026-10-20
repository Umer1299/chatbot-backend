-- Serialize agent turns without holding a pool client across provider calls.
BEGIN;
SELECT pg_advisory_xact_lock(145008);
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM chatflow_schema_migrations WHERE version='012') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM chatflow_schema_migrations WHERE version='011') THEN
    RAISE EXCEPTION 'Migration 011 must be applied first';
  END IF;
  CREATE TABLE agent_chat_turn_claims (
    session_id text PRIMARY KEY CHECK(length(session_id) BETWEEN 1 AND 200),
    business_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    deployment_id uuid NOT NULL,
    claim_token uuid NOT NULL UNIQUE,
    claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    CHECK(expires_at>claimed_at),
    FOREIGN KEY(deployment_id,business_id,agent_id)
      REFERENCES website_deployments(id,business_id,agent_id) ON DELETE CASCADE
  );
  CREATE INDEX agent_chat_turn_claims_expiry ON agent_chat_turn_claims(expires_at);
  INSERT INTO chatflow_schema_migrations(version) VALUES ('012');
END $migration$;
COMMIT;
