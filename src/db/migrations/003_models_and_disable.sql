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

-- Seed models using ONLY confirmed IDs from the codebase
-- Confirmed: gpt-4o-mini, claude-sonnet-4-5
INSERT INTO model_configs (
  model_id, display_name, branded_name,
  provider, api_model_id, min_plan, is_active, sort_order
) VALUES
  (
    'gpt-4o-mini',
    'GPT-4o Mini',
    'Standard AI [GPT-4o Mini]',
    'openai',
    'gpt-4o-mini',
    'trial',
    true,
    1
  ),
  (
    'gpt-4o',
    'GPT-4o',
    'Professional AI [GPT-4o]',
    'openai',
    -- TODO: Replace with actual gpt-4o model ID when confirmed
    'TODO-gpt-4o-model-id',
    'growth',
    false,   -- inactive until confirmed
    2
  ),
  (
    'claude-sonnet',
    'Claude Sonnet',
    'Advanced AI [Claude Sonnet]',
    'anthropic',
    'claude-sonnet-4-5',
    'professional',
    true,
    3
  ),
  (
    'claude-opus',
    'Claude Opus',
    'Premium AI [Claude Opus]',
    'anthropic',
    -- TODO: Replace with actual claude-opus model ID when confirmed
    'TODO-claude-opus-model-id',
    'agency',
    false,   -- inactive until confirmed
    4
  )
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
