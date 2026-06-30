CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  session_id TEXT,
  inquiry_type TEXT NOT NULL DEFAULT 'general',
  status TEXT NOT NULL DEFAULT 'new',
  priority TEXT NOT NULL DEFAULT 'normal',
  full_name TEXT,
  phone TEXT,
  email TEXT,
  company_name TEXT,
  preferred_contact_method TEXT,
  contact_reason TEXT,
  message_summary TEXT,
  department_or_route TEXT,
  existing_customer BOOLEAN DEFAULT false,
  urgency_flag BOOLEAN DEFAULT false,
  urgency_reason TEXT,
  ai_summary TEXT,
  raw_data JSONB DEFAULT '{}'::jsonb,
  agents_used TEXT[] DEFAULT ARRAY[]::TEXT[],
  source TEXT NOT NULL DEFAULT 'website_chatbot',
  owner_notes TEXT,
  assigned_to TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS session_id TEXT;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS inquiry_type TEXT NOT NULL DEFAULT 'general';
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new';
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS company_name TEXT;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS preferred_contact_method TEXT;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS contact_reason TEXT;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS message_summary TEXT;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS department_or_route TEXT;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS existing_customer BOOLEAN DEFAULT false;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS urgency_flag BOOLEAN DEFAULT false;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS urgency_reason TEXT;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS ai_summary TEXT;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS raw_data JSONB DEFAULT '{}'::jsonb;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS agents_used TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'website_chatbot';
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS owner_notes TEXT;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS assigned_to TEXT;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS idx_inquiries_business_session
  ON inquiries(business_id, session_id)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inquiries_business_created
  ON inquiries(business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inquiries_business_status
  ON inquiries(business_id, status);

CREATE INDEX IF NOT EXISTS idx_inquiries_business_type
  ON inquiries(business_id, inquiry_type);

CREATE INDEX IF NOT EXISTS idx_inquiries_business_priority
  ON inquiries(business_id, priority);
