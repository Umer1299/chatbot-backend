CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS businesses (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bubble_user_id        TEXT UNIQUE NOT NULL,
  business_name         TEXT NOT NULL,
  industry              TEXT NOT NULL CHECK (industry IN (
                          'construction','web_agency',
                          'real_estate','healthcare',
                          'law_firm','other'
                        )),
  website_url           TEXT,
  bot_id                TEXT UNIQUE NOT NULL,
  primary_color         TEXT DEFAULT '#6366f1',
  owner_email           TEXT NOT NULL,
  owner_phone           TEXT,
  timezone              TEXT DEFAULT 'America/Chicago',
  booking_type          TEXT DEFAULT 'simple_slots'
                          CHECK (booking_type IN (
                            'simple_slots','calendly'
                          )),
  calendly_link         TEXT,
  availability_slots    JSONB DEFAULT '{}',
  escalation_email      TEXT,
  plan                  TEXT DEFAULT 'trial'
                          CHECK (plan IN (
                            'trial','professional',
                            'growth','agency'
                          )),
  onboarding_complete   BOOLEAN DEFAULT FALSE,
  active                BOOLEAN DEFAULT TRUE,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_businesses_bot_id 
  ON businesses(bot_id);

CREATE INDEX IF NOT EXISTS idx_businesses_bubble_user 
  ON businesses(bubble_user_id);

CREATE TABLE IF NOT EXISTS bot_configs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID NOT NULL 
                          REFERENCES businesses(id) 
                          ON DELETE CASCADE,

  detected_industry     TEXT,
  detected_services     JSONB DEFAULT '[]',
  detected_location     TEXT,
  detection_confidence  DECIMAL(3,2),

  content_quality_score INTEGER DEFAULT 0,
  missing_fields        JSONB DEFAULT '{}',
  auto_generated_fields JSONB DEFAULT '{}',

  selected_agents       TEXT[] DEFAULT '{}',
  system_prompt         TEXT,
  prompt_version        INTEGER DEFAULT 1,
  template_version      TEXT DEFAULT '1.0.0',

  welcome_message       TEXT,
  starter_prompts       JSONB DEFAULT '[]',
  is_draft              BOOLEAN DEFAULT TRUE,

  active                BOOLEAN DEFAULT FALSE,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_configs_business_unique
  ON bot_configs(business_id);

CREATE INDEX IF NOT EXISTS idx_bot_configs_business 
  ON bot_configs(business_id);

CREATE INDEX IF NOT EXISTS idx_bot_configs_active 
  ON bot_configs(business_id, active) 
  WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID NOT NULL 
                          REFERENCES businesses(id) 
                          ON DELETE CASCADE,
  content               TEXT NOT NULL,
  embedding             vector(1536),
  source_url            TEXT,
  source_type           TEXT DEFAULT 'website'
                          CHECK (source_type IN (
                            'website','owner_upload',
                            'manual_text'
                          )),
  chunk_index           INTEGER,
  word_count            INTEGER,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chunks_business 
  ON knowledge_chunks(business_id);

CREATE INDEX IF NOT EXISTS idx_chunks_embedding 
  ON knowledge_chunks 
  USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS scrape_jobs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID NOT NULL 
                          REFERENCES businesses(id) 
                          ON DELETE CASCADE,
  url                   TEXT NOT NULL,
  status                TEXT DEFAULT 'queued'
                          CHECK (status IN (
                            'queued','scraping',
                            'processing','embedding',
                            'analyzing','validating',
                            'generating','complete','failed'
                          )),
  progress_step         TEXT,
  progress_percent      INTEGER DEFAULT 0,
  pages_scraped         INTEGER,
  chunks_created        INTEGER,
  detected_industry     TEXT,

  content_quality_score INTEGER,
  missing_fields        JSONB DEFAULT '{}',
  auto_generated_fields JSONB DEFAULT '{}',
  has_critical_gaps     BOOLEAN DEFAULT FALSE,

  welcome_message       TEXT,
  starter_prompts       JSONB DEFAULT '[]',
  system_prompt_draft   TEXT,

  result                JSONB,
  error_message         TEXT,
  retry_count           INTEGER DEFAULT 0,
  queued_at             TIMESTAMPTZ DEFAULT NOW(),
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_scrape_jobs_status 
  ON scrape_jobs(status);

CREATE INDEX IF NOT EXISTS idx_scrape_jobs_business 
  ON scrape_jobs(business_id);

CREATE TABLE IF NOT EXISTS leads (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID NOT NULL 
                          REFERENCES businesses(id) 
                          ON DELETE CASCADE,
  session_id            TEXT,

  full_name             TEXT,
  phone                 TEXT,
  email                 TEXT,
  company_name          TEXT,

  lead_score            TEXT CHECK (lead_score IN (
                          'hot','warm','cold'
                        )),
  score_reasons         TEXT[] DEFAULT '{}',
  ai_summary            TEXT,
  project_details       TEXT,

  industry              TEXT NOT NULL,
  industry_data         JSONB DEFAULT '{}',
  budget_range          TEXT,
  is_decision_maker     BOOLEAN,

  calendly_link_shown   BOOLEAN DEFAULT FALSE,
  appointment_scheduled BOOLEAN DEFAULT FALSE,

  status                TEXT DEFAULT 'new',
  status_updated_at     TIMESTAMPTZ DEFAULT NOW(),

  follow_up_date        DATE,
  follow_up_note        TEXT,
  follow_up_reminder_sent BOOLEAN DEFAULT FALSE,

  owner_notes           TEXT,
  tags                  TEXT[] DEFAULT '{}',
  estimated_value       DECIMAL(12,2),
  actual_value          DECIMAL(12,2),

  urgency_flag          BOOLEAN DEFAULT FALSE,
  urgency_reason        TEXT,
  escalation_sent_at    TIMESTAMPTZ,

  source                TEXT DEFAULT 'website_chatbot',
  source_page_url       TEXT,
  agents_used           TEXT[] DEFAULT '{}',

  owner_notified_at     TIMESTAMPTZ,
  hot_lead_reminder_sent BOOLEAN DEFAULT FALSE,

  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_business 
  ON leads(business_id);

CREATE INDEX IF NOT EXISTS idx_leads_score 
  ON leads(business_id, lead_score);

CREATE INDEX IF NOT EXISTS idx_leads_status 
  ON leads(business_id, status);

CREATE INDEX IF NOT EXISTS idx_leads_created 
  ON leads(business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_leads_followup 
  ON leads(follow_up_date) 
  WHERE follow_up_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leads_hot_uncontacted 
  ON leads(business_id, created_at) 
  WHERE lead_score = 'hot' 
  AND status = 'new' 
  AND hot_lead_reminder_sent = FALSE;

CREATE INDEX IF NOT EXISTS idx_leads_industry_data 
  ON leads USING GIN (industry_data);

CREATE TABLE IF NOT EXISTS sessions (
  id                    TEXT PRIMARY KEY,
  business_id           UUID REFERENCES businesses(id),
  lead_id               UUID REFERENCES leads(id),
  page_url              TEXT,
  current_phase         INTEGER DEFAULT 1,
  collected_data        JSONB DEFAULT '{}',
  status                TEXT DEFAULT 'active'
                          CHECK (status IN (
                            'active','completed',
                            'abandoned','escalated'
                          )),
  lead_captured         BOOLEAN DEFAULT FALSE,
  started_at            TIMESTAMPTZ DEFAULT NOW(),
  last_activity_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_business 
  ON sessions(business_id);

CREATE INDEX IF NOT EXISTS idx_sessions_active 
  ON sessions(status, last_activity_at) 
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_sessions_lead 
  ON sessions(lead_id);

CREATE TABLE IF NOT EXISTS messages (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            TEXT REFERENCES sessions(id),
  business_id           UUID REFERENCES businesses(id),
  role                  TEXT NOT NULL 
                          CHECK (role IN ('user','assistant')),
  content               TEXT NOT NULL,
  agent_phase           INTEGER,
  agent_id              TEXT,
  tokens_used           INTEGER,
  model_used            TEXT,
  latency_ms            INTEGER,
  was_escalation        BOOLEAN DEFAULT FALSE,
  was_quick_reply       BOOLEAN DEFAULT FALSE,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_session 
  ON messages(session_id);

CREATE INDEX IF NOT EXISTS idx_messages_business 
  ON messages(business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID REFERENCES businesses(id),
  lead_id               UUID REFERENCES leads(id),
  type                  TEXT NOT NULL,
  channel               TEXT NOT NULL,
  recipient             TEXT NOT NULL,
  subject               TEXT,
  body                  TEXT,
  status                TEXT DEFAULT 'sent',
  sent_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_business 
  ON notifications(business_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID REFERENCES businesses(id),
  industry              TEXT NOT NULL,
  stage_key             TEXT NOT NULL,
  stage_label           TEXT NOT NULL,
  stage_order           INTEGER NOT NULL,
  stage_color           TEXT DEFAULT '#6366f1',
  is_won_stage          BOOLEAN DEFAULT FALSE,
  is_lost_stage         BOOLEAN DEFAULT FALSE,
  UNIQUE(business_id, industry, stage_key)
);

INSERT INTO pipeline_stages 
  (business_id, industry, stage_key, stage_label,
   stage_order, stage_color, is_won_stage, is_lost_stage)
VALUES
  (NULL,'construction','new','New Lead',1,'#6366f1',FALSE,FALSE),
  (NULL,'construction','site_visit_scheduled','Visit Scheduled',2,'#f97316',FALSE,FALSE),
  (NULL,'construction','site_visit_completed','Visit Done',3,'#eab308',FALSE,FALSE),
  (NULL,'construction','quote_sent','Quote Sent',4,'#3b82f6',FALSE,FALSE),
  (NULL,'construction','follow_up','Following Up',5,'#8b5cf6',FALSE,FALSE),
  (NULL,'construction','won','Won 🎉',6,'#22c55e',TRUE,FALSE),
  (NULL,'construction','lost','Lost',7,'#ef4444',FALSE,TRUE),

  (NULL,'web_agency','new','New Lead',1,'#6366f1',FALSE,FALSE),
  (NULL,'web_agency','discovery_scheduled','Call Scheduled',2,'#f97316',FALSE,FALSE),
  (NULL,'web_agency','discovery_completed','Call Done',3,'#eab308',FALSE,FALSE),
  (NULL,'web_agency','proposal_sent','Proposal Sent',4,'#3b82f6',FALSE,FALSE),
  (NULL,'web_agency','negotiation','Negotiating',5,'#8b5cf6',FALSE,FALSE),
  (NULL,'web_agency','won','Won 🎉',6,'#22c55e',TRUE,FALSE),
  (NULL,'web_agency','lost','Lost',7,'#ef4444',FALSE,TRUE),

  (NULL,'real_estate','new','New Lead',1,'#6366f1',FALSE,FALSE),
  (NULL,'real_estate','viewing_scheduled','Viewing Scheduled',2,'#f97316',FALSE,FALSE),
  (NULL,'real_estate','viewing_completed','Viewed',3,'#eab308',FALSE,FALSE),
  (NULL,'real_estate','offer_made','Offer Made',4,'#3b82f6',FALSE,FALSE),
  (NULL,'real_estate','won','Completed 🎉',5,'#22c55e',TRUE,FALSE),
  (NULL,'real_estate','lost','Lost',6,'#ef4444',FALSE,TRUE),

  (NULL,'healthcare','new','New Patient',1,'#6366f1',FALSE,FALSE),
  (NULL,'healthcare','appointment_confirmed','Confirmed',2,'#f97316',FALSE,FALSE),
  (NULL,'healthcare','attended','Attended',3,'#22c55e',TRUE,FALSE),
  (NULL,'healthcare','no_show','No Show',4,'#ef4444',FALSE,FALSE),
  (NULL,'healthcare','cancelled','Cancelled',5,'#ef4444',FALSE,TRUE),

  (NULL,'law_firm','new','New Enquiry',1,'#6366f1',FALSE,FALSE),
  (NULL,'law_firm','consultation_scheduled','Consult Scheduled',2,'#f97316',FALSE,FALSE),
  (NULL,'law_firm','conflict_check','Conflict Check',3,'#eab308',FALSE,FALSE),
  (NULL,'law_firm','retainer_sent','Retainer Sent',4,'#3b82f6',FALSE,FALSE),
  (NULL,'law_firm','won','Client Retained 🎉',5,'#22c55e',TRUE,FALSE),
  (NULL,'law_firm','lost','Lost',6,'#ef4444',FALSE,TRUE)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS analytics_daily (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID REFERENCES businesses(id),
  date                  DATE NOT NULL,
  total_sessions        INTEGER DEFAULT 0,
  completed_sessions    INTEGER DEFAULT 0,
  abandoned_sessions    INTEGER DEFAULT 0,
  total_leads           INTEGER DEFAULT 0,
  hot_leads             INTEGER DEFAULT 0,
  warm_leads            INTEGER DEFAULT 0,
  cold_leads            INTEGER DEFAULT 0,
  appointments_shown    INTEGER DEFAULT 0,
  leads_won             INTEGER DEFAULT 0,
  revenue_won           DECIMAL(12,2) DEFAULT 0,
  avg_response_ms       INTEGER,
  total_tokens_used     INTEGER DEFAULT 0,
  lead_capture_rate     DECIMAL(5,2),
  UNIQUE(business_id, date)
);

CREATE INDEX IF NOT EXISTS idx_analytics_business_date 
  ON analytics_daily(business_id, date DESC);
