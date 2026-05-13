-- Ensure Claude model IDs requested by product are present and active.
-- Safe for existing deployments: upserts by model_id.

INSERT INTO model_configs (
  model_id, display_name, branded_name,
  provider, api_model_id, min_plan, is_active, sort_order
) VALUES
  ('claude-opus-4-7', 'Claude Opus 4.7', 'Claude Opus 4.7', 'anthropic', 'claude-opus-4-7', 'trial', true, 16),
  ('claude-opus-4-6', 'Claude Opus 4.6', 'Claude Opus 4.6', 'anthropic', 'claude-opus-4-6', 'trial', true, 17),
  ('claude-sonnet-4-6', 'Claude Sonnet 4.6', 'Claude Sonnet 4.6', 'anthropic', 'claude-sonnet-4-6', 'trial', true, 18),
  ('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 'Claude Haiku 4.5', 'anthropic', 'claude-haiku-4-5-20251001', 'trial', true, 19),
  ('claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', 'Claude Sonnet 4.5', 'anthropic', 'claude-sonnet-4-5-20250929', 'trial', true, 20),
  ('claude-opus-4-5-20251101', 'Claude Opus 4.5', 'Claude Opus 4.5', 'anthropic', 'claude-opus-4-5-20251101', 'trial', true, 21)
ON CONFLICT (model_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  branded_name = EXCLUDED.branded_name,
  provider = EXCLUDED.provider,
  api_model_id = EXCLUDED.api_model_id,
  min_plan = EXCLUDED.min_plan,
  is_active = EXCLUDED.is_active,
  sort_order = EXCLUDED.sort_order;
