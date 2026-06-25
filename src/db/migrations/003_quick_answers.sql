CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS quick_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  normalized_key TEXT,
  embedding vector(1536),
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE quick_answers ADD COLUMN IF NOT EXISTS normalized_key TEXT;
ALTER TABLE quick_answers ADD COLUMN IF NOT EXISTS embedding vector(1536);
ALTER TABLE quick_answers ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;
ALTER TABLE quick_answers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE quick_answers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

UPDATE quick_answers
SET normalized_key = lower(regexp_replace(regexp_replace(question, '[’'']', '', 'g'), '[^a-zA-Z0-9]+', ' ', 'g'))
WHERE normalized_key IS NULL OR normalized_key = '';

UPDATE quick_answers SET active = true WHERE active IS NULL;

ALTER TABLE quick_answers ALTER COLUMN normalized_key SET DEFAULT '';
ALTER TABLE quick_answers ALTER COLUMN active SET DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_quick_answers_business
  ON quick_answers(business_id);

CREATE INDEX IF NOT EXISTS idx_quick_answers_normalized_key
  ON quick_answers(business_id, normalized_key);

CREATE INDEX IF NOT EXISTS idx_quick_answers_embedding
  ON quick_answers
  USING hnsw (embedding vector_cosine_ops);
