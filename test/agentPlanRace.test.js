import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

const businessId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const deploymentId = "33333333-3333-4333-8333-333333333333";
let accessReads = 0;
let downgradeAt = 2;
let writes = 0;
mock.module("../src/db/pool.js", { defaultExport: {} });
mock.module("../src/services/redis.js", { namedExports: { redisClient: null } });
mock.module("../src/services/aiService.js", { namedExports: { getEmbedding: async () => null } });
mock.module("../src/services/agencyAccess.js", {
  namedExports: {
    businessAccess: async () => ({
      id: businessId,
      agency_id: "agency",
      // A billing downgrade commits while the mutation waits for the business lock.
      plan: ++accessReads < downgradeAt ? "professional" : "trial",
    }),
    businessId: (value) => value,
    inTransaction: async (work, db) => work(db),
    resourceNotFound: () => Object.assign(new Error("Missing"), { status: 404 }),
  },
});
const { createAgentRouter } = await import("../src/api/agentsV1.js");
const { createAgentRuntimeRouter } = await import("../src/api/agentRuntimeV1.js");
const db = {
  async query(sql) {
    if (/^UPDATE /.test(sql)) { writes++; throw Error("Unauthorized update"); }
    if (/FROM agents WHERE id/.test(sql)) return { rows: [{ id: agentId, status: "active", business_id: businessId }] };
    if (/FROM website_deployments WHERE/.test(sql)) return { rows: [{ id: deploymentId, business_id: businessId, agent_id: agentId, status: "paused", allowed_origins: ["https://client.example"] }] };
    if (/FROM agent_configs c JOIN model_configs m/.test(sql)) return { rows: [{ min_plan: "professional" }] };
    if (/FROM model_configs WHERE/.test(sql)) return { rows: [{ model_id: "claude-sonnet", min_plan: "professional" }] };
    return { rows: [{ id: businessId }] };
  },
};
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.accountUser = { id: "owner" }; next(); });
app.use("/api/v1", createAgentRouter({ db }), createAgentRuntimeRouter({ db }));
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
after(() => new Promise((resolve) => server.close(resolve)));
const root = `http://127.0.0.1:${server.address().port}/api/v1/businesses/${businessId}/agents/${agentId}`;
async function request(path, method, body) {
  accessReads = 0;
  downgradeAt = 2;
  const response = await fetch(root + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const detail = await response.text();
  if (response.status === 500) throw new Error(detail);
  assert.equal(accessReads, path.startsWith("/deployments") ? 3 : 2, "authorization rechecks after taking the business lock");
  return response.status;
}
test("agent activation uses the downgraded post-lock plan", async () => {
  assert.equal(await request("", "PATCH", { status: "active" }), 409);
  assert.equal(writes, 0);
});
test("config update uses the downgraded post-lock plan", async () => {
  assert.equal(await request("/config", "PUT", {
    expected_version: 1, status: "active", system_prompt: "Assistant",
    welcome_message: "Hi", starter_prompts: [], provider: "anthropic",
    model_id: "claude-sonnet", temperature: 0.7, generation_settings: {},
    capabilities: [], lead_capture: { enabled: false, fields: [] },
    escalation: { enabled: false },
  }), 400);
  assert.equal(writes, 0);
});
test("website activation uses the downgraded post-lock plan", async () => {
  assert.equal(await request(`/deployments/${deploymentId}`, "PATCH", { status: "active" }), 409);
  assert.equal(writes, 0);
});
