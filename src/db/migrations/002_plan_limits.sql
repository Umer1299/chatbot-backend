ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_plan_check;

ALTER TABLE businesses
  ADD CONSTRAINT businesses_plan_check
  CHECK (plan IN ('free', 'trial', 'professional', 'growth', 'agency'));

ALTER TABLE businesses
  ALTER COLUMN plan SET DEFAULT 'free';

CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_business_session_unique
  ON leads(business_id, session_id)
  WHERE session_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_monthly_lead_limit()
RETURNS trigger AS $$
DECLARE
  business_plan TEXT;
  month_count INTEGER;
BEGIN
  SELECT plan INTO business_plan FROM businesses WHERE id = NEW.business_id;

  IF business_plan IN ('free', 'trial') THEN
    IF NEW.session_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM leads WHERE business_id = NEW.business_id AND session_id = NEW.session_id
    ) THEN
      RETURN NEW;
    END IF;

    SELECT COUNT(*)::int INTO month_count
    FROM leads
    WHERE business_id = NEW.business_id
      AND created_at >= date_trunc('month', COALESCE(NEW.created_at, NOW()))
      AND created_at < date_trunc('month', COALESCE(NEW.created_at, NOW())) + INTERVAL '1 month';

    IF month_count >= 5 THEN
      RAISE EXCEPTION 'monthly_lead_limit_reached';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_monthly_lead_limit ON leads;

CREATE TRIGGER trg_enforce_monthly_lead_limit
  BEFORE INSERT ON leads
  FOR EACH ROW
  EXECUTE FUNCTION enforce_monthly_lead_limit();
