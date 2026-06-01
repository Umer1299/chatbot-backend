ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_chunks_business_file_id
  ON knowledge_chunks(business_id, ((metadata->>'file_id')));
