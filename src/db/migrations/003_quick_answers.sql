CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS quick_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  normalized_key TEXT NOT NULL,
  embedding vector(1536),
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quick_answers_business
  ON quick_answers(business_id);

CREATE INDEX IF NOT EXISTS idx_quick_answers_normalized_key
  ON quick_answers(business_id, normalized_key);

CREATE INDEX IF NOT EXISTS idx_quick_answers_embedding
  ON quick_answers
  USING hnsw (embedding vector_cosine_ops);
