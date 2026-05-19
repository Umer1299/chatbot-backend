-- Merge duplicate leads by business_id + email (case-insensitive), then enforce uniqueness.
WITH ranked AS (
  SELECT id, business_id, lower(email) AS normalized_email, updated_at, created_at,
    ROW_NUMBER() OVER (
      PARTITION BY business_id, lower(email)
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    ) AS rn
  FROM leads
  WHERE email IS NOT NULL
), survivors AS (
  SELECT business_id, normalized_email, id AS keep_id
  FROM ranked
  WHERE rn = 1
), duplicates AS (
  SELECT r.id AS duplicate_id, s.keep_id
  FROM ranked r
  JOIN survivors s ON s.business_id = r.business_id AND s.normalized_email = r.normalized_email
  WHERE r.rn > 1
)
UPDATE sessions s
SET lead_id = d.keep_id
FROM duplicates d
WHERE s.lead_id = d.duplicate_id;

DELETE FROM leads l
USING (
  SELECT id
  FROM (
    SELECT id,
      ROW_NUMBER() OVER (
        PARTITION BY business_id, lower(email)
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      ) AS rn
    FROM leads
    WHERE email IS NOT NULL
  ) t
  WHERE rn > 1
) d
WHERE l.id = d.id;

CREATE UNIQUE INDEX IF NOT EXISTS leads_business_email_unique
ON leads (business_id, lower(email))
WHERE email IS NOT NULL;
