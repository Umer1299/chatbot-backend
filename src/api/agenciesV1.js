import { Router } from "express";
import { randomUUID } from "node:crypto";
import pool from "../db/pool.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import {
  agencyAccess,
  businessAccess,
  inTransaction,
} from "../services/agencyAccess.js";

const industries = new Set([
  "construction",
  "web_agency",
  "real_estate",
  "healthcare",
  "law_firm",
  "other",
]);
const badRequest = () =>
  Object.assign(new Error("Invalid request"), { status: 400 });
function text(value, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw badRequest();
  return value.trim();
}
function metadata(body, create = false) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw badRequest();
  const allowed = new Set([
    "business_name",
    "industry",
    "website_url",
    "owner_email",
    "owner_phone",
    "timezone",
    "primary_color",
  ]);
  if (Object.keys(body).some((k) => !allowed.has(k))) throw badRequest();
  const data = {};
  for (const key of Object.keys(body)) {
    const value = text(body[key], key === "website_url" ? 2048 : 200);
    if (key === "industry" && !industries.has(value)) throw badRequest();
    if (key === "owner_email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      throw badRequest();
    if (key === "primary_color" && !/^#[0-9a-f]{6}$/i.test(value))
      throw badRequest();
    if (key === "timezone") {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
      } catch {
        throw badRequest();
      }
    }
    if (key === "website_url") {
      let url;
      try {
        url = new URL(value);
      } catch {
        throw badRequest();
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw badRequest();
    }
    data[key] = value;
  }
  if (create && (!data.business_name || !data.industry || !data.owner_email))
    throw badRequest();
  if (!Object.keys(data).length) throw badRequest();
  return data;
}

export function createAgencyRouter({ db = pool } = {}) {
  const router = Router();
  router.get(
    "/agencies",
    asyncHandler(async (req, res) => {
      const result = await db.query(
        `SELECT o.id,o.name,o.slug,o.logo,m.role FROM chatflow_organization o
      JOIN chatflow_member m ON m."organizationId"=o.id WHERE m."userId"=$1 ORDER BY o.id`,
        [req.accountUser.id],
      );
      res.json({ agencies: result.rows });
    }),
  );
  router.get(
    "/agencies/:agencyId",
    asyncHandler(async (req, res) =>
      res.json({
        agency: await agencyAccess(req.accountUser.id, req.params.agencyId, {
          db,
        }),
      }),
    ),
  );
  router.post(
    "/agencies/:agencyId/businesses",
    asyncHandler(async (req, res) => {
      const data = metadata(req.body, true);
      const created = await inTransaction(async (client) => {
        await agencyAccess(req.accountUser.id, req.params.agencyId, {
          db: client,
          manage: true,
          lock: true,
        });
        const keys = Object.keys(data),
          values = Object.values(data),
          bot = `bot_${randomUUID().replaceAll("-", "")}`;
        const result = await client.query(
          `INSERT INTO businesses (${keys.join(",")},bot_id) VALUES (${keys.map((_, i) => "$" + (i + 1)).join(",")},$${keys.length + 1}) RETURNING id`,
          [...values, bot],
        );
        const id = result.rows[0].id;
        await client.query(
          "INSERT INTO agency_businesses(business_id,agency_id,created_by) VALUES ($1,$2,$3)",
          [id, req.params.agencyId, req.accountUser.id],
        );
        return businessAccess(req.accountUser.id, id, { db: client });
      }, db);
      res.status(201).json({ business: created });
    }),
  );
  router.get(
    "/agencies/:agencyId/businesses",
    asyncHandler(async (req, res) => {
      await agencyAccess(req.accountUser.id, req.params.agencyId, { db });
      const result = await db.query(
        `SELECT b.id FROM businesses b JOIN agency_businesses ab ON ab.business_id=b.id
      JOIN chatflow_member m ON m."organizationId"=ab.agency_id AND m."userId"=$2
      LEFT JOIN business_memberships bm ON bm.business_id=b.id AND bm.user_id=$2
      WHERE ab.agency_id=$1 AND b.active=true AND (m.role IN ('owner','admin') OR bm.user_id IS NOT NULL) ORDER BY b.id`,
        [req.params.agencyId, req.accountUser.id],
      );
      // Return only explicitly allowed businesses; ordinary staff have no inherited client access.
      res.json({
        businesses: await Promise.all(
          result.rows.map((r) =>
            businessAccess(req.accountUser.id, r.id, { db }),
          ),
        ),
      });
    }),
  );
  router.get(
    "/businesses",
    asyncHandler(async (req, res) => {
      const result = await db.query(
        `SELECT DISTINCT ab.business_id AS id FROM agency_businesses ab
      LEFT JOIN chatflow_member m ON m."organizationId"=ab.agency_id AND m."userId"=$1
      LEFT JOIN business_memberships bm ON bm.business_id=ab.business_id AND bm.user_id=$1
      JOIN businesses b ON b.id=ab.business_id AND b.active=true
      WHERE m.role IN ('owner','admin') OR bm.user_id IS NOT NULL ORDER BY id`,
        [req.accountUser.id],
      );
      res.json({
        businesses: await Promise.all(
          result.rows.map((r) =>
            businessAccess(req.accountUser.id, r.id, { db }),
          ),
        ),
      });
    }),
  );
  router.get(
    "/businesses/:businessId",
    asyncHandler(async (req, res) =>
      res.json({
        business: await businessAccess(
          req.accountUser.id,
          req.params.businessId,
          { db },
        ),
      }),
    ),
  );
  router.patch(
    "/businesses/:businessId",
    asyncHandler(async (req, res) => {
      const data = metadata(req.body);
      const business = await inTransaction(async (client) => {
        // Lock the managing organization before permission reads, serializing with member/role changes.
        const row = await businessAccess(
          req.accountUser.id,
          req.params.businessId,
          { db: client },
        );
        await client.query(
          "SELECT id FROM chatflow_organization WHERE id=$1 FOR UPDATE",
          [row.agency_id],
        );
        await businessAccess(req.accountUser.id, row.id, {
          db: client,
          edit: true,
        });
        const keys = Object.keys(data);
        await client.query(
          `UPDATE businesses SET ${keys.map((k, i) => k + "=$" + (i + 1)).join(",")},updated_at=NOW() WHERE id=$${keys.length + 1}`,
          [...Object.values(data), row.id],
        );
        return businessAccess(req.accountUser.id, row.id, { db: client });
      }, db);
      res.json({ business });
    }),
  );
  router.get(
    "/businesses/:businessId/members",
    asyncHandler(async (req, res) => {
      const business = await businessAccess(
        req.accountUser.id,
        req.params.businessId,
        { db },
      );
      await agencyAccess(req.accountUser.id, business.agency_id, {
        db,
        manage: true,
      });
      const result = await db.query(
        `SELECT bm.user_id,bm.role,bm.grant_kind,u.name,u.email FROM business_memberships bm
      JOIN chatflow_user u ON u.id=bm.user_id WHERE bm.business_id=$1 ORDER BY bm.user_id`,
        [business.id],
      );
      res.json({ members: result.rows });
    }),
  );
  router.put(
    "/businesses/:businessId/members/:userId",
    asyncHandler(async (req, res) => {
      if (
        !["viewer", "editor"].includes(req.body?.role) ||
        Object.keys(req.body).some((k) => k !== "role")
      )
        throw badRequest();
      const result = await inTransaction(async (client) => {
        const business = await businessAccess(
          req.accountUser.id,
          req.params.businessId,
          { db: client },
        );
        await agencyAccess(req.accountUser.id, business.agency_id, {
          db: client,
          manage: true,
          lock: true,
        });
        const target = await client.query(
          "SELECT id FROM chatflow_user WHERE id=$1 AND status='active' AND \"emailVerified\"=true FOR SHARE",
          [req.params.userId],
        );
        if (!target.rows[0]) throw badRequest();
        const member = await client.query(
          'SELECT id FROM chatflow_member WHERE "organizationId"=$1 AND "userId"=$2',
          [business.agency_id, req.params.userId],
        );
        return client.query(
          `INSERT INTO business_memberships(business_id,agency_id,user_id,role,grant_kind,agency_member_id,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (business_id,user_id) DO UPDATE
        SET role=EXCLUDED.role,grant_kind=EXCLUDED.grant_kind,agency_member_id=EXCLUDED.agency_member_id RETURNING user_id,role,grant_kind`,
          [
            business.id,
            business.agency_id,
            req.params.userId,
            req.body.role,
            member.rows[0] ? "agency_staff" : "client",
            member.rows[0]?.id || null,
            req.accountUser.id,
          ],
        );
      }, db);
      res.json({ member: result.rows[0] });
    }),
  );
  router.delete(
    "/businesses/:businessId/members/:userId",
    asyncHandler(async (req, res) => {
      await inTransaction(async (client) => {
        const business = await businessAccess(
          req.accountUser.id,
          req.params.businessId,
          { db: client },
        );
        await agencyAccess(req.accountUser.id, business.agency_id, {
          db: client,
          manage: true,
          lock: true,
        });
        await client.query(
          "DELETE FROM business_memberships WHERE business_id=$1 AND user_id=$2",
          [business.id, req.params.userId],
        );
      }, db);
      res.json({ success: true });
    }),
  );
  return router;
}
export default createAgencyRouter();
