ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS file_id TEXT;

CREATE INDEX IF NOT EXISTS idx_chunks_business_file_id
  ON knowledge_chunks(business_id, file_id);
