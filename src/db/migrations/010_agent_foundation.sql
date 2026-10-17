-- Management foundation only: no legacy routing, policies or resource ownership changes.
BEGIN;
SELECT pg_advisory_xact_lock(145008);
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM chatflow_schema_migrations WHERE version='010') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM chatflow_schema_migrations WHERE version='009') THEN
    RAISE EXCEPTION 'Migration 009 must be applied first';
  END IF;
  CREATE TABLE agents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
    description text NOT NULL DEFAULT '' CHECK (length(description)<=4000),
    purpose text NOT NULL DEFAULT 'general' CHECK (purpose IN ('general','lead_generation','customer_support','receptionist','appointment_booking','sales')),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
    public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id,business_id)
  );
  CREATE INDEX agents_business ON agents(business_id,created_at,id);
  CREATE TABLE agent_configs (
    agent_id uuid PRIMARY KEY,
    business_id uuid NOT NULL,
    version integer NOT NULL DEFAULT 1 CHECK (version>0),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active')),
    system_prompt text NOT NULL DEFAULT '' CHECK (length(system_prompt)<=32000),
    welcome_message text NOT NULL DEFAULT '' CHECK (length(welcome_message)<=4000),
    starter_prompts jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(starter_prompts)='array'),
    provider text CHECK (provider IN ('openai','anthropic')),
    model_id text REFERENCES model_configs(model_id) ON DELETE RESTRICT,
    temperature numeric NOT NULL DEFAULT 0.7 CHECK (temperature BETWEEN 0 AND 2),
    generation_settings jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(generation_settings)='object'),
    capabilities jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(capabilities)='array'),
    lead_capture jsonb NOT NULL DEFAULT '{"enabled":false,"fields":[]}' CHECK (jsonb_typeof(lead_capture)='object'),
    escalation jsonb NOT NULL DEFAULT '{"enabled":false}' CHECK (jsonb_typeof(escalation)='object'),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (agent_id,business_id) REFERENCES agents(id,business_id) ON DELETE RESTRICT,
    CHECK ((model_id IS NULL)=(provider IS NULL)),
    CHECK (status<>'active' OR (model_id IS NOT NULL AND length(btrim(system_prompt))>0))
  );
  -- An explicit mapping, not an authorization grant or a public route. Old config stays authoritative.
  ALTER TABLE businesses ADD CONSTRAINT businesses_id_bot_scope UNIQUE(id,bot_id);
  CREATE TABLE legacy_agent_mappings (
    business_id uuid PRIMARY KEY,
    bot_id text NOT NULL UNIQUE,
    agent_id uuid NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (business_id,bot_id) REFERENCES businesses(id,bot_id) ON DELETE RESTRICT,
    FOREIGN KEY (agent_id,business_id) REFERENCES agents(id,business_id) ON DELETE RESTRICT
  );
  -- Preserve legacy values verbatim in their original tables; do not import unvalidated settings.
  WITH inserted AS (
    INSERT INTO agents(business_id,name)
    SELECT id,left(business_name,180)||' — Legacy agent' FROM businesses RETURNING id,business_id
  ) INSERT INTO legacy_agent_mappings(business_id,bot_id,agent_id)
    SELECT i.business_id,b.bot_id,i.id FROM inserted i JOIN businesses b ON b.id=i.business_id;
  INSERT INTO agent_configs(agent_id,business_id) SELECT agent_id,business_id FROM legacy_agent_mappings;
  INSERT INTO chatflow_schema_migrations(version) VALUES ('010');
END $migration$;

CREATE OR REPLACE FUNCTION chatflow_guard_agent_identity() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF NEW.id<>OLD.id OR NEW.business_id<>OLD.business_id OR NEW.public_id<>OLD.public_id THEN
    RAISE EXCEPTION 'Agent identity is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.status='archived' AND NEW.status<>'archived' THEN
    RAISE EXCEPTION 'Archived agents cannot be restored' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $body$;
DROP TRIGGER IF EXISTS chatflow_guard_agent_identity ON agents;
CREATE TRIGGER chatflow_guard_agent_identity BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION chatflow_guard_agent_identity();
COMMIT;
