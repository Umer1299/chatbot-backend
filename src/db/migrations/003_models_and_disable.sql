-- ─────────────────────────────────────────────────
-- model_configs: database-driven model definitions
-- Add new models by inserting rows — no code changes needed
-- api_model_id = actual value sent to the provider API
-- model_id = internal identifier used in this backend
-- ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS model_configs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id      TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  branded_name  TEXT NOT NULL,
  provider      TEXT NOT NULL
                  CHECK (provider IN ('anthropic', 'openai')),
  api_model_id  TEXT NOT NULL,
  min_plan      TEXT NOT NULL
                  CHECK (min_plan IN ('trial', 'professional', 'growth', 'agency')),
  is_active     BOOLEAN DEFAULT TRUE,
  sort_order    INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Seed model catalog
INSERT INTO model_configs (
  model_id, display_name, branded_name,
  provider, api_model_id, min_plan, is_active, sort_order
) VALUES
  ('gpt-5.5', 'GPT-5.5', 'OpenAI GPT-5.5', 'openai', 'gpt-5.5', 'trial', true, 1),
  ('gpt-5.5-pro', 'GPT-5.5 Pro', 'OpenAI GPT-5.5 Pro', 'openai', 'gpt-5.5-pro', 'trial', true, 2),
  ('gpt-5.4', 'GPT-5.4', 'OpenAI GPT-5.4', 'openai', 'gpt-5.4', 'trial', true, 3),
  ('gpt-5.4-pro', 'GPT-5.4 Pro', 'OpenAI GPT-5.4 Pro', 'openai', 'gpt-5.4-pro', 'trial', true, 4),
  ('gpt-5.4-mini', 'GPT-5.4 Mini', 'OpenAI GPT-5.4 Mini', 'openai', 'gpt-5.4-mini', 'trial', true, 5),
  ('gpt-5.4-nano', 'GPT-5.4 Nano', 'OpenAI GPT-5.4 Nano', 'openai', 'gpt-5.4-nano', 'trial', true, 6),
  ('gpt-5-mini', 'GPT-5 Mini', 'OpenAI GPT-5 Mini', 'openai', 'gpt-5-mini', 'trial', true, 7),
  ('gpt-5-nano', 'GPT-5 Nano', 'OpenAI GPT-5 Nano', 'openai', 'gpt-5-nano', 'trial', true, 8),
  ('gpt-4o', 'GPT-4o', 'OpenAI GPT-4o', 'openai', 'gpt-4o', 'trial', true, 9),
  ('gpt-4o-mini', 'GPT-4o Mini', 'OpenAI GPT-4o Mini', 'openai', 'gpt-4o-mini', 'trial', true, 10),
  ('gpt-4.1', 'GPT-4.1', 'OpenAI GPT-4.1', 'openai', 'gpt-4.1', 'trial', true, 11),
  ('gpt-4.1-mini', 'GPT-4.1 Mini', 'OpenAI GPT-4.1 Mini', 'openai', 'gpt-4.1-mini', 'trial', true, 12),
  ('gpt-4.1-nano', 'GPT-4.1 Nano', 'OpenAI GPT-4.1 Nano', 'openai', 'gpt-4.1-nano', 'trial', true, 13),
  ('gpt-4-turbo', 'GPT-4 Turbo', 'OpenAI GPT-4 Turbo', 'openai', 'gpt-4-turbo', 'trial', true, 14),
  ('gpt-4', 'GPT-4', 'OpenAI GPT-4', 'openai', 'gpt-4', 'trial', true, 15),
  ('claude-opus-4-7', 'Claude Opus 4.7', 'Claude Opus 4.7', 'anthropic', 'claude-opus-4-7', 'trial', true, 16),
  ('claude-opus-4-6', 'Claude Opus 4.6', 'Claude Opus 4.6', 'anthropic', 'claude-opus-4-6', 'trial', true, 17),
  ('claude-sonnet-4-6', 'Claude Sonnet 4.6', 'Claude Sonnet 4.6', 'anthropic', 'claude-sonnet-4-6', 'trial', true, 18),
  ('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 'Claude Haiku 4.5', 'anthropic', 'claude-haiku-4-5-20251001', 'trial', true, 19),
  ('claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', 'Claude Sonnet 4.5', 'anthropic', 'claude-sonnet-4-5-20250929', 'trial', true, 20),
  ('claude-opus-4-5-20251101', 'Claude Opus 4.5', 'Claude Opus 4.5', 'anthropic', 'claude-opus-4-5-20251101', 'trial', true, 21),
  -- Legacy aliases kept for backward compatibility
  ('claude-sonnet', 'Claude Sonnet', 'Claude Sonnet (Legacy Alias)', 'anthropic', 'claude-sonnet-4-5-20250929', 'trial', true, 22),
  ('claude-opus', 'Claude Opus', 'Claude Opus (Legacy Alias)', 'anthropic', 'claude-opus-4-5-20251101', 'trial', true, 23)
ON CONFLICT (model_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_model_configs_active
  ON model_configs(min_plan, is_active)
  WHERE is_active = TRUE;

-- ─────────────────────────────────────────────────
-- Add model + disable columns to businesses
-- ─────────────────────────────────────────────────

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS selected_model   TEXT
    DEFAULT 'gpt-4o-mini',
  ADD COLUMN IF NOT EXISTS is_disabled      BOOLEAN
    DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS disabled_reason  TEXT,
  ADD COLUMN IF NOT EXISTS disabled_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS disabled_by      TEXT
    CHECK (disabled_by IN ('bubble', 'admin'));

-- ─────────────────────────────────────────────────
-- Add selected_model to bot_configs
-- ─────────────────────────────────────────────────

ALTER TABLE bot_configs
  ADD COLUMN IF NOT EXISTS selected_model TEXT
    DEFAULT 'gpt-4o-mini';

CREATE INDEX IF NOT EXISTS idx_businesses_disabled
  ON businesses(is_disabled)
  WHERE is_disabled = TRUE;
