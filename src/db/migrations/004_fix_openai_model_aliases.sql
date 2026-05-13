-- Normalize legacy GPT-5.x aliases to currently supported OpenAI API model IDs.
-- This prevents runtime 400 errors such as: "Invalid model ID: gpt-5.4-pro".

UPDATE model_configs
SET api_model_id = CASE model_id
  WHEN 'gpt-5.5' THEN 'gpt-5'
  WHEN 'gpt-5.5-pro' THEN 'gpt-5-pro'
  WHEN 'gpt-5.4' THEN 'gpt-5'
  WHEN 'gpt-5.4-pro' THEN 'gpt-5-pro'
  WHEN 'gpt-5.4-mini' THEN 'gpt-5-mini'
  WHEN 'gpt-5.4-nano' THEN 'gpt-5-nano'
  ELSE api_model_id
END
WHERE provider = 'openai'
  AND model_id IN (
    'gpt-5.5', 'gpt-5.5-pro',
    'gpt-5.4', 'gpt-5.4-pro',
    'gpt-5.4-mini', 'gpt-5.4-nano'
  );
