-- Additive identity relationships. No legacy ownership is inferred/backfilled.
BEGIN;
SELECT pg_advisory_xact_lock(145008);
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM chatflow_schema_migrations WHERE version='009') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM chatflow_schema_migrations WHERE version='008') THEN
    RAISE EXCEPTION 'Migration 008 must be applied first';
  END IF;

  ALTER TABLE businesses ALTER COLUMN bubble_user_id DROP NOT NULL;
  -- Existing UNIQUE bubble_user_id and bot_id constraints remain unchanged.
  ALTER TABLE chatflow_user ADD CONSTRAINT chatflow_user_status CHECK (status IN ('active','disabled'));
  CREATE UNIQUE INDEX chatflow_user_email_normalized ON chatflow_user(lower(email));
  CREATE UNIQUE INDEX chatflow_account_provider_identity ON chatflow_account("providerId","accountId");
  ALTER TABLE chatflow_member ADD CONSTRAINT chatflow_member_role CHECK (role IN ('owner','admin','member'));
  ALTER TABLE chatflow_member ADD CONSTRAINT chatflow_member_one_per_agency UNIQUE ("organizationId","userId");
  ALTER TABLE chatflow_member ADD CONSTRAINT chatflow_member_scope UNIQUE (id,"userId","organizationId");
  ALTER TABLE chatflow_invitation ADD CONSTRAINT chatflow_invitation_role CHECK (role IN ('owner','admin','member'));
  CREATE INDEX chatflow_invitation_pending ON chatflow_invitation("organizationId",lower(email)) WHERE status='pending';

  CREATE TABLE agency_businesses (
    business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE RESTRICT,
    agency_id text NOT NULL REFERENCES chatflow_organization(id) ON DELETE RESTRICT,
    created_by text NOT NULL REFERENCES chatflow_user(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id,agency_id)
  );
  CREATE INDEX agency_businesses_agency ON agency_businesses(agency_id,business_id);
  CREATE TABLE business_memberships (
    business_id uuid NOT NULL,
    agency_id text NOT NULL,
    user_id text NOT NULL REFERENCES chatflow_user(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('viewer','editor')),
    grant_kind text NOT NULL CHECK (grant_kind IN ('client','agency_staff')),
    agency_member_id text,
    created_by text NOT NULL REFERENCES chatflow_user(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id,user_id),
    FOREIGN KEY (business_id,agency_id) REFERENCES agency_businesses(business_id,agency_id) ON DELETE CASCADE,
    FOREIGN KEY (agency_member_id,user_id,agency_id) REFERENCES chatflow_member(id,"userId","organizationId") ON DELETE CASCADE,
    CHECK ((grant_kind='client' AND agency_member_id IS NULL) OR (grant_kind='agency_staff' AND agency_member_id IS NOT NULL))
  );
  CREATE INDEX business_memberships_user ON business_memberships(user_id,business_id);
  CREATE INDEX business_memberships_agency_member ON business_memberships(agency_member_id);

  INSERT INTO chatflow_schema_migrations(version) VALUES ('009');
END $migration$;

-- Serialize all membership changes on the organization row, protecting the last
-- owner even when two different owners concurrently demote/remove themselves.
CREATE OR REPLACE FUNCTION chatflow_guard_agency_owner() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE scope_id text;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW."organizationId"<>OLD."organizationId" OR NEW."userId"<>OLD."userId") THEN
    RAISE EXCEPTION 'Membership identity is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN scope_id:=NEW."organizationId"; ELSE scope_id:=OLD."organizationId"; END IF;
  PERFORM id FROM chatflow_organization WHERE id=scope_id FOR UPDATE;
  IF TG_OP<>'INSERT' AND OLD.role='owner' AND (TG_OP='DELETE' OR NEW.role<>'owner') THEN
    IF NOT EXISTS (SELECT 1 FROM chatflow_member WHERE "organizationId"=scope_id AND role='owner' AND id<>OLD.id) THEN
      RAISE EXCEPTION 'Agency must retain an owner' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $body$;
DROP TRIGGER IF EXISTS chatflow_guard_agency_owner ON chatflow_member;
CREATE TRIGGER chatflow_guard_agency_owner BEFORE INSERT OR UPDATE OR DELETE ON chatflow_member
  FOR EACH ROW EXECUTE FUNCTION chatflow_guard_agency_owner();

CREATE OR REPLACE FUNCTION chatflow_remove_staff_access() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  DELETE FROM business_memberships WHERE agency_id=OLD."organizationId" AND user_id=OLD."userId";
  RETURN OLD;
END $body$;
DROP TRIGGER IF EXISTS chatflow_remove_staff_access ON chatflow_member;
CREATE TRIGGER chatflow_remove_staff_access AFTER DELETE ON chatflow_member
  FOR EACH ROW EXECUTE FUNCTION chatflow_remove_staff_access();
COMMIT;
