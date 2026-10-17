import { Router } from "express";
import pool from "../db/pool.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import {
  businessAccess,
  businessId,
  inTransaction,
  resourceNotFound,
} from "../services/agencyAccess.js";
import {
  agentCreate,
  agentPatch,
  configInput,
  validate,
} from "../services/agentValidation.js";
import { agentModelAllowed } from "../services/agentModelAccess.js";
const conflict = () =>
  Object.assign(new Error("Agent state or configuration version conflict"), {
    status: 409,
  });
export function createAgentRouter({ db = pool } = {}) {
  const router = Router();
  const root = "/businesses/:businessId/agents";
  async function access(req, client, edit = false) {
    const b = await businessAccess(req.accountUser.id, req.params.businessId, {
      db: client,
    });
    if (edit) {
      // Same organization lock order as business/member management; recheck grants after locking.
      await client.query(
        "SELECT id FROM chatflow_organization WHERE id=$1 FOR UPDATE",
        [b.agency_id],
      );
      await client.query("SELECT id FROM businesses WHERE id=$1 FOR SHARE", [
        b.id,
      ]);
      await businessAccess(req.accountUser.id, b.id, {
        db: client,
        edit: true,
      });
    }
    return b;
  }
  async function agent(req, client, lock = false) {
    businessId(req.params.agentId);
    const { rows } = await client.query(
      `SELECT * FROM agents WHERE id=$1 AND business_id=$2${lock ? " FOR UPDATE" : ""}`,
      [req.params.agentId, req.params.businessId],
    );
    if (!rows[0]) throw resourceNotFound();
    return rows[0];
  }
  router.get(
    root,
    asyncHandler(async (req, res) => {
      await access(req, db);
      const { rows } = await db.query(
        "SELECT * FROM agents WHERE business_id=$1 ORDER BY created_at,id",
        [req.params.businessId],
      );
      res.json({ agents: rows });
    }),
  );
  router.post(
    root,
    asyncHandler(async (req, res) => {
      const data = validate(agentCreate, req.body);
      // New agents cannot start active without a separately validated configuration.
      if (data.status === "active") throw conflict();
      const row = await inTransaction(async (client) => {
        await access(req, client, true);
        const { rows } = await client.query(
          "INSERT INTO agents(business_id,name,description,purpose,status) VALUES ($1,$2,$3,$4,$5) RETURNING *",
          [
            req.params.businessId,
            data.name,
            data.description ?? "",
            data.purpose ?? "general",
            data.status ?? "draft",
          ],
        );
        await client.query(
          "INSERT INTO agent_configs(agent_id,business_id) VALUES ($1,$2)",
          [rows[0].id, rows[0].business_id],
        );
        return rows[0];
      }, db);
      res.status(201).json({ agent: row });
    }),
  );
  router.get(
    root + "/:agentId",
    asyncHandler(async (req, res) => {
      await access(req, db);
      res.json({ agent: await agent(req, db) });
    }),
  );
  router.patch(
    root + "/:agentId",
    asyncHandler(async (req, res) => {
      const data = validate(agentPatch, req.body);
      const row = await inTransaction(async (client) => {
        const business = await access(req, client, true);
        const current = await agent(req, client, true);
        if (current.status === "archived") throw conflict();
        if (data.status === "active") {
          const { rows } = await client.query(
            `SELECT m.min_plan FROM agent_configs c JOIN model_configs m ON m.model_id=c.model_id AND m.provider=c.provider AND m.is_active=true WHERE c.agent_id=$1 AND c.business_id=$2 AND c.status='active'`,
            [current.id, current.business_id],
          );
          if (!rows.length || !agentModelAllowed(business.plan, rows[0].min_plan)) throw conflict();
        }
        const keys = Object.keys(data);
        return (
          await client.query(
            `UPDATE agents SET ${keys.map((k, i) => k + "=$" + (i + 1)).join(",")},updated_at=now() WHERE id=$${keys.length + 1} AND business_id=$${keys.length + 2} RETURNING *`,
            [...Object.values(data), current.id, current.business_id],
          )
        ).rows[0];
      }, db);
      res.json({ agent: row });
    }),
  );
  router.get(
    root + "/:agentId/config",
    asyncHandler(async (req, res) => {
      // Viewer permission intentionally exposes metadata only, not prompts/configuration.
      await businessAccess(req.accountUser.id, req.params.businessId, {
        db,
        edit: true,
      });
      await agent(req, db);
      const { rows } = await db.query(
        "SELECT * FROM agent_configs WHERE agent_id=$1 AND business_id=$2",
        [req.params.agentId, req.params.businessId],
      );
      if (!rows[0]) throw resourceNotFound();
      res.json({ config: rows[0] });
    }),
  );
  router.put(
    root + "/:agentId/config",
    asyncHandler(async (req, res) => {
      const { expected_version, ...data } = validate(configInput, req.body);
      const row = await inTransaction(async (client) => {
        const business = await access(req, client, true);
        const current = await agent(req, client, true);
        if (current.status === "archived") throw conflict();
        if (data.model_id) {
          const result = await client.query(
            "SELECT model_id,min_plan FROM model_configs WHERE model_id=$1 AND provider=$2 AND is_active=true FOR SHARE",
            [data.model_id, data.provider],
          );
          if (!result.rows.length || !agentModelAllowed(business.plan, result.rows[0].min_plan))
            throw Object.assign(new Error("Unsupported model/provider"), {
              status: 400,
            });
        }
        const jsonFields = new Set([
          "starter_prompts",
          "generation_settings",
          "capabilities",
          "lead_capture",
          "escalation",
        ]);
        const keys = Object.keys(data);
        const { rows } = await client.query(
          `UPDATE agent_configs SET ${keys.map((k, i) => k + "=$" + (i + 1)).join(",")},version=version+1,updated_at=now() WHERE agent_id=$${keys.length + 1} AND business_id=$${keys.length + 2} AND version=$${keys.length + 3} RETURNING *`,
          [
            ...keys.map((k) =>
              jsonFields.has(k) ? JSON.stringify(data[k]) : data[k],
            ),
            current.id,
            current.business_id,
            expected_version,
          ],
        );
        if (!rows[0]) throw conflict();
        // Editing a live management configuration into draft pauses readiness, never activates it.
        if (data.status === "draft" && current.status === "active")
          await client.query(
            "UPDATE agents SET status='paused',updated_at=now() WHERE id=$1 AND business_id=$2",
            [current.id, current.business_id],
          );
        return rows[0];
      }, db);
      res.json({ config: row });
    }),
  );
  return router;
}
export default createAgentRouter();
