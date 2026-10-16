-- Durable cache generations change in the SAME transaction as knowledge writes,
-- including partial uploads, re-scrapes, and out-of-process database writers.
BEGIN;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS knowledge_revision BIGINT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION bump_knowledge_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE businesses SET knowledge_revision=knowledge_revision+1
    WHERE id IN (SELECT DISTINCT business_id FROM new_chunks);
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE businesses SET knowledge_revision=knowledge_revision+1
    WHERE id IN (SELECT DISTINCT business_id FROM old_chunks);
  ELSE
    UPDATE businesses SET knowledge_revision=knowledge_revision+1
    WHERE id IN (SELECT business_id FROM old_chunks UNION SELECT business_id FROM new_chunks);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS knowledge_revision_insert ON knowledge_chunks;
CREATE TRIGGER knowledge_revision_insert AFTER INSERT ON knowledge_chunks
  REFERENCING NEW TABLE AS new_chunks FOR EACH STATEMENT EXECUTE FUNCTION bump_knowledge_revision();
DROP TRIGGER IF EXISTS knowledge_revision_update ON knowledge_chunks;
CREATE TRIGGER knowledge_revision_update AFTER UPDATE ON knowledge_chunks
  REFERENCING OLD TABLE AS old_chunks NEW TABLE AS new_chunks FOR EACH STATEMENT EXECUTE FUNCTION bump_knowledge_revision();
DROP TRIGGER IF EXISTS knowledge_revision_delete ON knowledge_chunks;
CREATE TRIGGER knowledge_revision_delete AFTER DELETE ON knowledge_chunks
  REFERENCING OLD TABLE AS old_chunks FOR EACH STATEMENT EXECUTE FUNCTION bump_knowledge_revision();
COMMIT;
