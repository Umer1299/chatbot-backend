-- Additive only. Do not infer an allow-all policy from a missing settings row.
-- Apply through the reviewed staging/release process, not at application startup.
CREATE TABLE IF NOT EXISTS chatbot_settings (
  namespace TEXT PRIMARY KEY,
  settings JSONB NOT NULL CHECK (
    jsonb_typeof(settings) = 'object'
    AND settings ? 'allowedDomains'
    AND jsonb_typeof(settings->'allowedDomains') = 'array'
  ),
  revision UUID NOT NULL,
  deleted BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
