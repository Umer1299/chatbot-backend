CREATE TABLE IF NOT EXISTS quick_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  normalized_question TEXT NOT NULL,
  answer TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  priority INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  embedding vector(1536),
  match_count INTEGER DEFAULT 0,
  last_matched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quick_answers_business_id
  ON quick_answers(business_id);

CREATE INDEX IF NOT EXISTS idx_quick_answers_business_active
  ON quick_answers(business_id, is_active);

CREATE UNIQUE INDEX IF NOT EXISTS idx_quick_answers_business_normalized_active
  ON quick_answers(business_id, normalized_question)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_quick_answers_embedding
  ON quick_answers USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_chunks_business
  ON knowledge_chunks(business_id);

CREATE INDEX IF NOT EXISTS idx_chunks_embedding
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
