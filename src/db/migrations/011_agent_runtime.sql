-- Isolated agent runtime tables. No legacy row is reclassified or modified.
BEGIN;
SELECT pg_advisory_xact_lock(145008);
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM chatflow_schema_migrations WHERE version='011') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM chatflow_schema_migrations WHERE version='010') THEN
    RAISE EXCEPTION 'Migration 010 must be applied first';
  END IF;
  ALTER TABLE agents ADD COLUMN knowledge_revision bigint NOT NULL DEFAULT 0 CHECK (knowledge_revision>=0);
  CREATE TABLE website_deployments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    channel text NOT NULL DEFAULT 'website' CHECK(channel='website'),
    status text NOT NULL DEFAULT 'paused' CHECK(status IN ('active','paused')),
    allowed_origins jsonb NOT NULL CHECK(jsonb_typeof(allowed_origins)='array' AND jsonb_array_length(allowed_origins)>0),
    credential_hash bytea NOT NULL UNIQUE CHECK(octet_length(credential_hash)=32),
    credential_version integer NOT NULL DEFAULT 1 CHECK(credential_version>0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (agent_id,business_id) REFERENCES agents(id,business_id) ON DELETE RESTRICT,
    UNIQUE(id,business_id,agent_id)
  );
  CREATE INDEX website_deployments_agent ON website_deployments(business_id,agent_id,id);
  CREATE TABLE agent_knowledge_sources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    source_key text NOT NULL CHECK(length(source_key) BETWEEN 1 AND 100),
    content_hash text NOT NULL CHECK(length(content_hash)=64),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(agent_id,business_id) REFERENCES agents(id,business_id) ON DELETE RESTRICT,
    UNIQUE(agent_id,source_key), UNIQUE(id,business_id,agent_id)
  );
  CREATE INDEX agent_knowledge_sources_business ON agent_knowledge_sources(business_id,agent_id,id);
  CREATE TABLE agent_knowledge_chunks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id uuid NOT NULL,
    business_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    content text NOT NULL,
    embedding vector(1536) NOT NULL,
    chunk_index integer NOT NULL CHECK(chunk_index>=0),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(source_id,business_id,agent_id) REFERENCES agent_knowledge_sources(id,business_id,agent_id) ON DELETE CASCADE,
    UNIQUE(source_id,chunk_index)
  );
  CREATE INDEX agent_knowledge_chunks_scope ON agent_knowledge_chunks(business_id,agent_id,source_id);
  CREATE INDEX agent_knowledge_chunks_vector ON agent_knowledge_chunks USING hnsw (embedding vector_cosine_ops);
  CREATE TABLE agent_chat_sessions (
    id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    business_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    deployment_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(deployment_id,business_id,agent_id) REFERENCES website_deployments(id,business_id,agent_id) ON DELETE RESTRICT,
    UNIQUE(id,business_id,agent_id,deployment_id)
  );
  CREATE INDEX agent_sessions_scope ON agent_chat_sessions(business_id,agent_id,created_at DESC);
  CREATE TABLE agent_chat_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id text NOT NULL,
    business_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    deployment_id uuid NOT NULL,
    role text NOT NULL CHECK(role IN ('user','assistant')),
    content text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(session_id,business_id,agent_id,deployment_id) REFERENCES agent_chat_sessions(id,business_id,agent_id,deployment_id) ON DELETE RESTRICT
  );
  CREATE INDEX agent_messages_history ON agent_chat_messages(business_id,agent_id,session_id,created_at DESC,id DESC);
  CREATE TABLE agent_leads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id text NOT NULL,
    business_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    deployment_id uuid NOT NULL,
    full_name text,
    email text,
    phone text,
    source_message text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(session_id,business_id,agent_id,deployment_id) REFERENCES agent_chat_sessions(id,business_id,agent_id,deployment_id) ON DELETE RESTRICT,
    UNIQUE(business_id,agent_id,session_id)
  );
  CREATE INDEX agent_leads_scope ON agent_leads(business_id,agent_id,created_at DESC);
  CREATE TABLE agent_inquiries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id text NOT NULL,
    business_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    deployment_id uuid NOT NULL,
    message_summary text NOT NULL,
    status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','open','closed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(session_id,business_id,agent_id,deployment_id) REFERENCES agent_chat_sessions(id,business_id,agent_id,deployment_id) ON DELETE RESTRICT,
    UNIQUE(business_id,agent_id,session_id)
  );
  CREATE INDEX agent_inquiries_scope ON agent_inquiries(business_id,agent_id,created_at DESC);
  INSERT INTO chatflow_schema_migrations(version) VALUES ('011');
END $migration$;
CREATE OR REPLACE FUNCTION bump_agent_knowledge_revision() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF TG_OP='INSERT' THEN
    UPDATE agents SET knowledge_revision=knowledge_revision+1 WHERE id IN (SELECT DISTINCT agent_id FROM new_chunks);
  ELSIF TG_OP='DELETE' THEN
    UPDATE agents SET knowledge_revision=knowledge_revision+1 WHERE id IN (SELECT DISTINCT agent_id FROM old_chunks);
  ELSE
    UPDATE agents SET knowledge_revision=knowledge_revision+1 WHERE id IN
      (SELECT agent_id FROM old_chunks UNION SELECT agent_id FROM new_chunks);
  END IF;
  RETURN NULL;
END $body$;
DROP TRIGGER IF EXISTS agent_knowledge_revision_insert ON agent_knowledge_chunks;
CREATE TRIGGER agent_knowledge_revision_insert AFTER INSERT ON agent_knowledge_chunks REFERENCING NEW TABLE AS new_chunks FOR EACH STATEMENT EXECUTE FUNCTION bump_agent_knowledge_revision();
DROP TRIGGER IF EXISTS agent_knowledge_revision_update ON agent_knowledge_chunks;
CREATE TRIGGER agent_knowledge_revision_update AFTER UPDATE ON agent_knowledge_chunks REFERENCING OLD TABLE AS old_chunks NEW TABLE AS new_chunks FOR EACH STATEMENT EXECUTE FUNCTION bump_agent_knowledge_revision();
DROP TRIGGER IF EXISTS agent_knowledge_revision_delete ON agent_knowledge_chunks;
CREATE TRIGGER agent_knowledge_revision_delete AFTER DELETE ON agent_knowledge_chunks REFERENCING OLD TABLE AS old_chunks FOR EACH STATEMENT EXECUTE FUNCTION bump_agent_knowledge_revision();
COMMIT;
