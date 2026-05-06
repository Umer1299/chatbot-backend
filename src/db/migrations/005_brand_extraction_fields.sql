ALTER TABLE bot_configs
  ADD COLUMN IF NOT EXISTS brand_logo_url TEXT,
  ADD COLUMN IF NOT EXISTS brand_favicon_url TEXT,
  ADD COLUMN IF NOT EXISTS brand_primary_color TEXT,
  ADD COLUMN IF NOT EXISTS brand_secondary_color TEXT,
  ADD COLUMN IF NOT EXISTS brand_fonts JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS brand_welcome_message TEXT,
  ADD COLUMN IF NOT EXISTS brand_starter_prompts JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS brand_status TEXT DEFAULT 'pending' CHECK (brand_status IN ('pending', 'approved'));

ALTER TABLE scrape_jobs
  ADD COLUMN IF NOT EXISTS is_refresh BOOLEAN DEFAULT FALSE;
