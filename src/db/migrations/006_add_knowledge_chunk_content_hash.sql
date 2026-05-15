ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS content_hash TEXT;

UPDATE knowledge_chunks
SET content_hash = md5(content)
WHERE content_hash IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_business_content_hash
  ON knowledge_chunks(business_id, content_hash);
