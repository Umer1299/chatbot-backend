-- Serialize legacy business knowledge mutations without holding pooled clients
-- across embedding-provider calls or retry delays.
BEGIN;
SELECT pg_advisory_xact_lock(145008);
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM chatflow_schema_migrations WHERE version='013') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM chatflow_schema_migrations WHERE version='012') THEN
    RAISE EXCEPTION 'Migration 012 must be applied first';
  END IF;
  CREATE TABLE legacy_knowledge_mutation_claims (
    business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    claim_token uuid NOT NULL UNIQUE,
    claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    CHECK(expires_at>claimed_at)
  );
  CREATE INDEX legacy_knowledge_mutation_claims_expiry
    ON legacy_knowledge_mutation_claims(expires_at);
  INSERT INTO chatflow_schema_migrations(version) VALUES ('013');
END $migration$;
COMMIT;
