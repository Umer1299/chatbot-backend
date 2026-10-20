-- Additive only. Existing inconsistent records are retained for an explicit review.
BEGIN;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_to TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_id_business ON sessions(id, business_id);
CREATE INDEX IF NOT EXISTS idx_messages_business_session_created
  ON messages(business_id, session_id, created_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='messages_session_business_fk'
                 AND conrelid='messages'::regclass) THEN
    ALTER TABLE messages ADD CONSTRAINT messages_session_business_fk
      FOREIGN KEY (session_id, business_id) REFERENCES sessions(id, business_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='messages_tenant_required'
                 AND conrelid='messages'::regclass) THEN
    ALTER TABLE messages ADD CONSTRAINT messages_tenant_required
      CHECK (session_id IS NOT NULL AND business_id IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sessions_tenant_required'
                 AND conrelid='sessions'::regclass) THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_tenant_required
      CHECK (business_id IS NOT NULL) NOT VALID;
  END IF;
END $$;
COMMIT;
