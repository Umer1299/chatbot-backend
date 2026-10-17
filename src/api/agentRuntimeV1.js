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
  saveAgentKnowledge,
  deleteAgentKnowledge,
} from "../services/agentKnowledge.js";
import {
  issueCredential,
  validateOrigins,
} from "../services/websiteDeployment.js";
import { getEmbedding } from "../services/aiService.js";
const bad = () => Object.assign(new Error("Invalid request"), { status: 400 });
const clash = () =>
  Object.assign(new Error("Agent not ready"), { status: 409 });
const view =
  "id,business_id,agent_id,public_id,channel,status,allowed_origins,credential_version,created_at,updated_at";
function exact(body, allowed) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => !allowed.includes(k))
  )
    throw bad();
  return body;
}
async function check(req, db, edit = true) {
  await businessAccess(req.accountUser.id, req.params.businessId, { db, edit });
  businessId(req.params.agentId);
  const r = await db.query(
    "SELECT id,status FROM agents WHERE id=$1 AND business_id=$2",
    [req.params.agentId, req.params.businessId],
  );
  if (!r.rows[0]) throw resourceNotFound();
  return r.rows[0];
}
async function mutation(req, client) {
  const b = await businessAccess(req.accountUser.id, req.params.businessId, {
    db: client,
  });
  await client.query(
    "SELECT id FROM chatflow_organization WHERE id=$1 FOR UPDATE",
    [b.agency_id],
  );
  await client.query("SELECT id FROM businesses WHERE id=$1 FOR SHARE", [b.id]);
  await businessAccess(req.accountUser.id, b.id, { db: client, edit: true });
}
async function deployment(req, client, lock = false) {
  businessId(req.params.deploymentId);
  const r = await client.query(
    `SELECT ${view},credential_hash FROM website_deployments WHERE id=$1 AND business_id=$2 AND agent_id=$3${lock ? " FOR UPDATE" : ""}`,
    [req.params.deploymentId, req.params.businessId, req.params.agentId],
  );
  if (!r.rows[0]) throw resourceNotFound();
  return r.rows[0];
}
function safeDeployment(row) {
  const { credential_hash, ...safe } = row;
  return safe;
}
export function createAgentRuntimeRouter({
  db = pool,
  embed = getEmbedding,
} = {}) {
  const router = Router(),
    root = "/businesses/:businessId/agents/:agentId";
  router.post(
    root + "/knowledge",
    asyncHandler(async (req, res) => {
      const body = exact(req.body, ["source_key", "text"]);
      await check(req, db);
      const result = await saveAgentKnowledge({
        businessId: req.params.businessId,
        agentId: req.params.agentId,
        sourceKey: body.source_key,
        text: body.text,
        db,
        embed,
        authorize: (client) => mutation(req, client),
      });
      res
        .status(result.status === "completed" ? 201 : 200)
        .json({ success: true, ...result });
    }),
  );
  router.get(
    root + "/knowledge",
    asyncHandler(async (req, res) => {
      await check(req, db);
      const r = await db.query(
        `SELECT s.id,s.source_key,s.content_hash,s.created_at,s.updated_at,count(c.id)::int AS chunks
      FROM agent_knowledge_sources s LEFT JOIN agent_knowledge_chunks c ON c.source_id=s.id AND c.business_id=s.business_id AND c.agent_id=s.agent_id
      WHERE s.business_id=$1 AND s.agent_id=$2 GROUP BY s.id ORDER BY s.created_at,s.id`,
        [req.params.businessId, req.params.agentId],
      );
      res.json({ knowledge: r.rows });
    }),
  );
  router.delete(
    root + "/knowledge/:knowledgeId",
    asyncHandler(async (req, res) => {
      await check(req, db);
      businessId(req.params.knowledgeId);
      await deleteAgentKnowledge({
        businessId: req.params.businessId,
        agentId: req.params.agentId,
        sourceId: req.params.knowledgeId,
        db,
        authorize: (client) => mutation(req, client),
      });
      res.json({ success: true });
    }),
  );
  router.post(
    root + "/deployments",
    asyncHandler(async (req, res) => {
      const body = exact(req.body, ["allowed_origins"]);
      const origins = validateOrigins(body.allowed_origins);
      const issued = issueCredential();
      const row = await inTransaction(async (client) => {
        await mutation(req, client);
        if ((await check(req, client)).status === "archived") throw clash();
        return (
          await client.query(
            `INSERT INTO website_deployments(business_id,agent_id,allowed_origins,credential_hash)
        VALUES($1,$2,$3::jsonb,$4) RETURNING ${view}`,
            [
              req.params.businessId,
              req.params.agentId,
              JSON.stringify(origins),
              issued.verifier,
            ],
          )
        ).rows[0];
      }, db);
      res.status(201).json({ deployment: row, token: issued.token });
    }),
  );
  router.get(
    root + "/deployments",
    asyncHandler(async (req, res) => {
      await check(req, db);
      const rows = (
        await db.query(
          `SELECT ${view} FROM website_deployments WHERE business_id=$1 AND agent_id=$2 ORDER BY created_at,id`,
          [req.params.businessId, req.params.agentId],
        )
      ).rows;
      res.json({ deployments: rows });
    }),
  );
  router.patch(
    root + "/deployments/:deploymentId",
    asyncHandler(async (req, res) => {
      const body = exact(req.body, ["status", "allowed_origins"]);
      if (
        !Object.keys(body).length ||
        (body.status !== undefined &&
          !["active", "paused"].includes(body.status))
      )
        throw bad();
      const origins =
        body.allowed_origins === undefined
          ? undefined
          : validateOrigins(body.allowed_origins);
      const result = await inTransaction(async (client) => {
        await mutation(req, client);
        const agent = await check(req, client);
        const current = await deployment(req, client, true);
        if (body.status === "active") {
          if (agent.status !== "active") throw clash();
          const valid = await client.query(
            `SELECT c.agent_id FROM agent_configs c JOIN model_configs m ON m.model_id=c.model_id
          WHERE c.agent_id=$1 AND c.business_id=$2 AND c.status='active' AND m.provider=c.provider AND m.is_active=true`,
            [agent.id, req.params.businessId],
          );
          if (!valid.rows.length) throw clash();
        }
        const r = await client.query(
          `UPDATE website_deployments SET status=$1,allowed_origins=$2::jsonb,updated_at=now() WHERE id=$3 AND business_id=$4 AND agent_id=$5 RETURNING ${view}`,
          [
            body.status ?? current.status,
            JSON.stringify(origins ?? current.allowed_origins),
            current.id,
            current.business_id,
            current.agent_id,
          ],
        );
        return r.rows[0];
      }, db);
      res.json({ deployment: result });
    }),
  );
  for (const action of ["rotate", "revoke"])
    router.post(
      root + "/deployments/:deploymentId/" + action,
      asyncHandler(async (req, res) => {
        exact(req.body || {}, []);
        const issued = issueCredential();
        const result = await inTransaction(async (client) => {
          await mutation(req, client);
          await check(req, client);
          const old = await deployment(req, client, true);
          return (
            await client.query(
              `UPDATE website_deployments SET credential_hash=$1,credential_version=credential_version+1,
        status=$2,updated_at=now() WHERE id=$3 AND business_id=$4 AND agent_id=$5 RETURNING ${view}`,
              [
                issued.verifier,
                action === "revoke" ? "paused" : old.status,
                old.id,
                old.business_id,
                old.agent_id,
              ],
            )
          ).rows[0];
        }, db);
        res.json({
          deployment: result,
          ...(action === "rotate" ? { token: issued.token } : {}),
        });
      }),
    );
  router.get(
    root + "/conversations",
    asyncHandler(async (req, res) => {
      await check(req, db);
      const rows = (
        await db.query(
          "SELECT id,deployment_id,created_at,updated_at FROM agent_chat_sessions WHERE business_id=$1 AND agent_id=$2 ORDER BY created_at DESC LIMIT 100",
          [req.params.businessId, req.params.agentId],
        )
      ).rows;
      res.json({ conversations: rows });
    }),
  );
  router.get(
    root + "/conversations/:sessionId",
    asyncHandler(async (req, res) => {
      await check(req, db);
      const r = await db.query(
        "SELECT id,deployment_id,created_at,updated_at FROM agent_chat_sessions WHERE business_id=$1 AND agent_id=$2 AND id=$3",
        [req.params.businessId, req.params.agentId, req.params.sessionId],
      );
      if (!r.rows[0]) throw resourceNotFound();
      const messages = (
        await db.query(
          "SELECT id,role,content,created_at FROM agent_chat_messages WHERE business_id=$1 AND agent_id=$2 AND session_id=$3 ORDER BY created_at,id LIMIT 100",
          [req.params.businessId, req.params.agentId, req.params.sessionId],
        )
      ).rows;
      res.json({ conversation: r.rows[0], messages });
    }),
  );
  for (const [path, table, field] of [
    ["leads", "agent_leads", "leads"],
    ["inquiries", "agent_inquiries", "inquiries"],
  ])
    router.get(
      root + "/" + path,
      asyncHandler(async (req, res) => {
        await check(req, db);
        const rows = (
          await db.query(
            `SELECT * FROM ${table} WHERE business_id=$1 AND agent_id=$2 ORDER BY created_at DESC LIMIT 100`,
            [req.params.businessId, req.params.agentId],
          )
        ).rows;
        res.json({ [field]: rows });
      }),
    );
  return router;
}
export default createAgentRuntimeRouter();
