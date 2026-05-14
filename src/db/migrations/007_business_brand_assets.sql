ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS brand_logo_url TEXT;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS brand_favicon_url TEXT;
