import pool from "../db/pool.js";
export const agencyManagers = new Set(["owner", "admin"]);
export const resourceNotFound = () =>
  Object.assign(new Error("Resource not found"), { status: 404 });
export const forbidden = () =>
  Object.assign(new Error("Permission denied"), { status: 403 });
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function businessId(value) {
  if (!uuidPattern.test(value || "")) throw resourceNotFound();
  return value;
}

export async function agencyAccess(
  userId,
  agencyId,
  { db = pool, manage = false, lock = false } = {},
) {
  if (typeof agencyId !== "string" || agencyId.length > 128)
    throw resourceNotFound();
  if (lock)
    await db.query(
      "SELECT id FROM chatflow_organization WHERE id=$1 FOR UPDATE",
      [agencyId],
    );
  const { rows } = await db.query(
    `SELECT o.id,o.name,o.slug,o.logo,o.metadata,m.role
    FROM chatflow_organization o JOIN chatflow_member m ON m."organizationId"=o.id
    WHERE o.id=$1 AND m."userId"=$2`,
    [agencyId, userId],
  );
  if (!rows[0]) throw resourceNotFound();
  if (manage && !agencyManagers.has(rows[0].role)) throw forbidden();
  return rows[0];
}

export async function businessAccess(
  userId,
  id,
  { db = pool, edit = false } = {},
) {
  businessId(id);
  const { rows } = await db.query(
    `SELECT b.id,b.business_name,b.industry,b.website_url,b.bot_id,b.owner_email,
      b.owner_phone,b.timezone,b.primary_color,b.active,ab.agency_id,
      am.role AS agency_role,bm.role AS business_role
    FROM businesses b JOIN agency_businesses ab ON ab.business_id=b.id
    LEFT JOIN chatflow_member am ON am."organizationId"=ab.agency_id AND am."userId"=$2
    LEFT JOIN business_memberships bm ON bm.business_id=b.id AND bm.user_id=$2
    WHERE b.id=$1 AND b.active=true
      AND (am.role IN ('owner','admin') OR bm.user_id IS NOT NULL)`,
    [id, userId],
  );
  if (!rows[0]) throw resourceNotFound();
  if (
    edit &&
    !agencyManagers.has(rows[0].agency_role) &&
    rows[0].business_role !== "editor"
  )
    throw forbidden();
  return rows[0];
}

export async function inTransaction(work, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
