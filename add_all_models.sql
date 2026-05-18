BEGIN;

UPDATE model_configs
SET min_plan = 'trial',
    is_active = true,
    updated_at = NOW();

INSERT INTO model_configs (
  model_id, display_name, branded_name, provider, api_model_id, min_plan, is_active, sort_order
) VALUES
  ('gpt-5.5', 'GPT-5.5', 'AI [GPT-5.5]', 'openai', 'gpt-5.5', 'trial', true, 10),
  ('gpt-5.5-pro', 'GPT-5.5 Pro', 'AI [GPT-5.5 Pro]', 'openai', 'gpt-5.5-pro', 'trial', true, 11),
  ('gpt-5.4', 'GPT-5.4', 'AI [GPT-5.4]', 'openai', 'gpt-5.4', 'trial', true, 12),
  ('gpt-5.4-pro', 'GPT-5.4 Pro', 'AI [GPT-5.4 Pro]', 'openai', 'gpt-5.4-pro', 'trial', true, 13),
  ('gpt-5.4-mini', 'GPT-5.4 Mini', 'AI [GPT-5.4 Mini]', 'openai', 'gpt-5.4-mini', 'trial', true, 14),
  ('gpt-5.4-nano', 'GPT-5.4 Nano', 'AI [GPT-5.4 Nano]', 'openai', 'gpt-5.4-nano', 'trial', true, 15),
  ('gpt-5-mini', 'GPT-5 Mini', 'AI [GPT-5 Mini]', 'openai', 'gpt-5-mini', 'trial', true, 16),
  ('gpt-5-nano', 'GPT-5 Nano', 'AI [GPT-5 Nano]', 'openai', 'gpt-5-nano', 'trial', true, 17),
  ('gpt-4o', 'GPT-4o', 'AI [GPT-4o]', 'openai', 'gpt-4o', 'trial', true, 18),
  ('gpt-4.1', 'GPT-4.1', 'AI [GPT-4.1]', 'openai', 'gpt-4.1', 'trial', true, 20),
  ('gpt-4.1-mini', 'GPT-4.1 Mini', 'AI [GPT-4.1 Mini]', 'openai', 'gpt-4.1-mini', 'trial', true, 21),
  ('gpt-4.1-nano', 'GPT-4.1 Nano', 'AI [GPT-4.1 Nano]', 'openai', 'gpt-4.1-nano', 'trial', true, 22),
  ('gpt-4-turbo', 'GPT-4 Turbo', 'AI [GPT-4 Turbo]', 'openai', 'gpt-4-turbo', 'trial', true, 23),
  ('gpt-4', 'GPT-4', 'AI [GPT-4]', 'openai', 'gpt-4', 'trial', true, 24),
  ('claude-opus-4-7', 'Claude Opus 4.7', 'Advanced AI [Claude Opus 4.7]', 'anthropic', 'claude-opus-4-20250514', 'trial', true, 30),
  ('claude-opus-4-6', 'Claude Opus 4.6', 'Advanced AI [Claude Opus 4.6]', 'anthropic', 'claude-opus-4-20250514', 'trial', true, 31),
  ('claude-sonnet-4-6', 'Claude Sonnet 4.6', 'Advanced AI [Claude Sonnet 4.6]', 'anthropic', 'claude-sonnet-4-6', 'trial', true, 32),
  ('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 'Fast AI [Claude Haiku 4.5]', 'anthropic', 'claude-haiku-4-5-20251001', 'trial', true, 33),
  ('claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', 'Advanced AI [Claude Sonnet 4.5]', 'anthropic', 'claude-sonnet-4-5-20250929', 'trial', true, 34),
  ('claude-opus-4-5-20251101', 'Claude Opus 4.5', 'Advanced AI [Claude Opus 4.5]', 'anthropic', 'claude-opus-4-5-20251101', 'trial', true, 35),
  ('gpt-4o-mini', 'GPT-4o Mini', 'AI [GPT-4o Mini]', 'openai', 'gpt-4o-mini', 'trial', true, 19)
ON CONFLICT (model_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  branded_name = EXCLUDED.branded_name,
  provider = EXCLUDED.provider,
  api_model_id = EXCLUDED.api_model_id,
  min_plan = 'trial',
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = NOW();

COMMIT;
