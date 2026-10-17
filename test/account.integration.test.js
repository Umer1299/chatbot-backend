import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import express from "express";
import jwt from "jsonwebtoken";
mock.module("../src/db/pool.js", { defaultExport: {} });
mock.module("../src/services/redis.js", {
  namedExports: { redisClient: null },
});
const { createAccountAuth } = await import("../src/auth/accountAuth.js");
const { accountHandler, accountIdentity } =
  await import("../src/middleware/accountAuth.js");
const { createAgencyRouter } = await import("../src/api/agenciesV1.js");
const { createAgentRouter } = await import("../src/api/agentsV1.js");
const { createAgentRuntimeRouter } =
  await import("../src/api/agentRuntimeV1.js");
const { createAgentChatRouter } = await import("../src/api/agentChat.js");
const testUrl = process.env.TEST_DATABASE_URL;

test(
  "isolated Better Auth and agency/business PostgreSQL integration",
  {
    skip:
      !testUrl &&
      "TEST_DATABASE_URL not configured; requires isolated PostgreSQL CI",
  },
  async (t) => {
    const url = new URL(testUrl);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    assert.equal(url.pathname, "/chatflow_security_test");
    const { default: pg } = await import("pg");
    const admin = new pg.Client({ connectionString: testUrl });
    await admin.connect();
    const schema = `identity_test_${randomUUID().replaceAll("-", "")}`;
    let db, server;
    const outbox = [];
    const modelCalls = [],
      ragCache = new Map();
    let redisDown = false,
      embeddingDown = false;
    const fakeEmbed = async () =>
      embeddingDown ? null : [1, ...Array(1535).fill(0)];
    const fakeComplete = async (input) => {
      modelCalls.push(input);
      return input.systemPrompt.includes("Sales assistant")
        ? "Sales response"
        : "Support response";
    };
    const cache = {
      get: async (key) => {
        if (redisDown) throw Error("Redis down");
        return ragCache.get(key) || null;
      },
      setex: async (key, ttl, value) => {
        if (redisDown) throw Error("Redis down");
        ragCache.set(key, value);
      },
    };
    try {
      await admin.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
      await admin.query("CREATE EXTENSION IF NOT EXISTS vector");
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`SET search_path TO ${schema},public`);
      for (const file of [
        "001_initial_schema.sql",
        "002_plan_limits.sql",
        "003_models_and_disable.sql",
        "003_quick_answers.sql",
        "004_inquiries.sql",
        "005_security_boundaries.sql",
        "006_durable_chatbot_settings.sql",
        "007_knowledge_cache_revision.sql",
      ])
        await admin.query(
          await readFile(
            new URL("../src/db/migrations/" + file, import.meta.url),
            "utf8",
          ),
        );
      const legacy = randomUUID();
      await admin.query(
        `INSERT INTO businesses(id,bubble_user_id,business_name,industry,owner_email,bot_id) VALUES ($1,'verified-legacy-subject','Legacy','other','legacy@example.test','legacy-bot')`,
        [legacy],
      );
      await admin.query(
        `INSERT INTO bot_configs(business_id,active) VALUES ($1,true)`,
        [legacy],
      );
      await admin.query(
        "INSERT INTO sessions(id,business_id) VALUES ('legacy-history',$1)",
        [legacy],
      );
      await admin.query(
        "INSERT INTO messages(session_id,business_id,role,content,agent_id) VALUES ('legacy-history',$1,'user','Retain customer history','legacy-phase-label')",
        [legacy],
      );
      await admin.query(
        "INSERT INTO knowledge_chunks(business_id,content) VALUES ($1,'Retain customer knowledge')",
        [legacy],
      );
      await admin.query(
        "INSERT INTO leads(business_id,session_id,industry) VALUES ($1,'legacy-history','other')",
        [legacy],
      );
      await admin.query(
        "INSERT INTO inquiries(business_id,session_id) VALUES ($1,'legacy-history')",
        [legacy],
      );
      const historyTables = [
        "businesses",
        "bot_configs",
        "sessions",
        "messages",
        "knowledge_chunks",
        "leads",
        "inquiries",
        "chatbot_settings",
      ];
      const historicSnapshot = {};
      for (const table of historyTables)
        historicSnapshot[table] = (
          await admin.query(`SELECT * FROM ${table}`)
        ).rows;
      for (const file of [
        "008_account_auth.sql",
        "009_agency_business_access.sql",
        "010_agent_foundation.sql",
        "011_agent_runtime.sql",
      ])
        await admin.query(
          await readFile(
            new URL("../src/db/migrations/" + file, import.meta.url),
            "utf8",
          ),
        );
      for (const table of historyTables)
        assert.deepEqual(
          (await admin.query(`SELECT * FROM ${table}`)).rows.map((row) =>
            table === "businesses"
              ? Object.fromEntries(
                  Object.entries(row).filter(
                    ([key]) => key !== "knowledge_revision",
                  ),
                )
              : row,
          ),
          historicSnapshot[table],
          table + " preserved by identity/agent migrations",
        );
      db = new pg.Pool({
        connectionString: testUrl,
        max: 8,
        options: `-c search_path=${schema},public`,
      });
      const app = express();
      // This loopback peer represents the platform-sanitized ingress in this test.
      app.set("trust proxy", ["127.0.0.1/32"]);
      server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });
      const base = `http://127.0.0.1:${server.address().port}`;
      const auth = createAccountAuth({
        database: db,
        settings: {
          baseURL: base,
          secret: "integration-only-012345678901234567890123456789",
          trustedOrigins: [base],
          production: false,
        },
        sendEmail: async (email) => {
          outbox.push(email);
        },
      });
      app.all(
        "/api/account/*",
        accountHandler(() => auth),
      ); // Must precede body parser.
      app.use(express.json());
      app.use(
        "/api/v1",
        accountIdentity(() => auth),
        createAgencyRouter({ db }),
        createAgentRouter({ db }),
        createAgentRuntimeRouter({ db, embed: fakeEmbed }),
      );
      app.use(
        "/api/agent-chat",
        createAgentChatRouter({
          db,
          embed: fakeEmbed,
          complete: fakeComplete,
          cache,
          enabled: true,
        }),
      );
      app.use((error, req, res, next) =>
        res.status(error.status || 500).json({ error: "Operation rejected" }),
      );
      const call = async (
        path,
        { method = "GET", body, cookie, origin = base } = {},
      ) => {
        const response = await fetch(base + path, {
          method,
          redirect: "manual",
          headers: {
            origin,
            "content-type": "application/json",
            ...(cookie ? { cookie } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const raw = await response.text();
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
        return {
          status: response.status,
          body: data,
          headers: response.headers,
        };
      };
      // Each fixture is an independent user/IP scenario. Keep production library
      // throttles enabled; reset only this disposable schema's quota rows.
      t.beforeEach(async () => {
        await db.query("DELETE FROM chatflow_rate_limit");
      });
      const register = async (name) => {
        await db.query("DELETE FROM chatflow_rate_limit");
        const email = name + "@example.test",
          password = "Example-long-passphrase-43!";
        const signup = await call("/api/account/sign-up/email", {
          method: "POST",
          body: { name, email, password, status: "disabled" },
        });
        assert.equal(signup.status, 200, JSON.stringify(signup.body));
        const row = (
          await db.query("SELECT * FROM chatflow_user WHERE email=$1", [email])
        ).rows[0];
        assert.equal(row.status, "active");
        assert.equal(row.emailVerified, false);
        const mail = outbox.find((e) => e.to === email);
        assert.ok(mail);
        assert.equal(
          (await fetch(mail.url, { redirect: "manual" })).status,
          302,
        );
        const login = await call("/api/account/sign-in/email", {
          method: "POST",
          body: { email, password },
        });
        assert.equal(login.status, 200, JSON.stringify(login.body));
        const cookie = login.headers
          .getSetCookie()
          .map((c) => c.split(";")[0])
          .join("; ");
        assert.ok(cookie);
        return { id: row.id, email, password, cookie };
      };
      let owner, outsider, staff, client, agency, otherAgency, business, second;
      await t.test(
        "real registration, email verification, password sign-in and HttpOnly session",
        async () => {
          const email = "unverified@example.test",
            password = "Example-long-passphrase-43!";
          assert.equal(
            (
              await call("/api/account/sign-up/email", {
                method: "POST",
                body: { name: "Unverified", email, password },
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await call("/api/account/sign-in/email", {
                method: "POST",
                body: { email, password },
              })
            ).status,
            403,
          );
          owner = await register("owner");
          outsider = await register("outsider");
          staff = await register("staff");
          client = await register("client");
          const session = await call("/api/account/get-session", {
            cookie: owner.cookie,
          });
          assert.equal(session.status, 200);
          assert.equal(session.body.user.id, owner.id);
          assert.equal(session.body.user.emailVerified, true);
          const login = await call("/api/account/sign-in/email", {
            method: "POST",
            body: { email: owner.email, password: owner.password },
          });
          assert.match(login.headers.getSetCookie().join(";"), /HttpOnly/i);
          assert.match(login.headers.getSetCookie().join(";"), /SameSite=Lax/i);
          assert.ok(
            (
              await db.query(
                'SELECT password FROM chatflow_account WHERE "userId"=$1',
                [owner.id],
              )
            ).rows.every((r) => r.password !== owner.password),
          );
          assert.ok(
            (
              await call("/api/account/sign-in/email", {
                method: "POST",
                body: {
                  email: owner.email,
                  password: "wrong-password-attempt",
                },
              })
            ).status >= 400,
          );
        },
      );
      await t.test(
        "native library sign-in throttle remains enabled",
        async () => {
          const statuses = [];
          for (let i = 0; i < 5; i++)
            statuses.push(
              (
                await call("/api/account/sign-in/email", {
                  method: "POST",
                  body: {
                    email: owner.email,
                    password: "wrong-password-attempt",
                  },
                })
              ).status,
            );
          assert.ok(statuses.includes(401));
          assert.equal(statuses.at(-1), 429);
        },
      );
      await t.test(
        "native auth quotas isolate clients behind the configured trusted ingress",
        async () => {
          const request = async (ip, password, spoof) => {
            const response = await fetch(base + "/api/account/sign-in/email", {
              method: "POST",
              headers: {
                origin: base,
                "content-type": "application/json",
                "x-forwarded-for": ip,
                "x-chatflow-client-ip": spoof,
              },
              body: JSON.stringify({ email: owner.email, password }),
            });
            await response.text();
            return response.status;
          };
          for (let i = 0; i < 5; i++)
            await request(
              "198.51.100.10",
              "wrong-password-attempt",
              "forged-" + i,
            );
          assert.equal(
            await request("198.51.100.10", owner.password, "another-forged"),
            429,
          );
          assert.equal(
            await request("198.51.100.11", owner.password, "another-forged"),
            200,
          );
        },
      );
      await t.test(
        "verified owners create agencies, list/view/update; foreign users cannot view agency data",
        async () => {
          const result = await call("/api/account/organization/create", {
            method: "POST",
            cookie: owner.cookie,
            body: { name: "Zavia Prime", slug: "zavia-prime" },
          });
          assert.equal(result.status, 200, JSON.stringify(result.body));
          agency = result.body.id;
          const other = await call("/api/account/organization/create", {
            method: "POST",
            cookie: outsider.cookie,
            body: { name: "Other", slug: "other-agency" },
          });
          assert.equal(other.status, 200);
          otherAgency = other.body.id;
          assert.equal(
            (await call("/api/v1/agencies/" + agency, { cookie: owner.cookie }))
              .status,
            200,
          );
          assert.equal(
            (
              await call("/api/v1/agencies/" + agency, {
                cookie: outsider.cookie,
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await call(
                "/api/account/organization/get-full-organization?organizationId=" +
                  agency,
                { cookie: outsider.cookie },
              )
            ).status >= 400,
            true,
          );
          assert.equal(
            (
              await call("/api/account/organization/update", {
                method: "POST",
                cookie: owner.cookie,
                body: {
                  organizationId: agency,
                  data: { name: "Zavia Prime Agency" },
                },
              })
            ).status,
            200,
          );
          assert.equal(
            (await call("/api/v1/agencies", { cookie: owner.cookie })).body
              .agencies.length,
            1,
          );
        },
      );
      await t.test(
        "owner creates multiple client businesses atomically with real UUIDs and no fake legacy identities",
        async () => {
          const results = await Promise.all(
            ["Construction", "Healthcare"].map((name) =>
              call(`/api/v1/agencies/${agency}/businesses`, {
                method: "POST",
                cookie: owner.cookie,
                body: {
                  business_name: name,
                  industry: "other",
                  owner_email: client.email,
                },
              }),
            ),
          );
          assert.ok(
            results.every((r) => r.status === 201),
            JSON.stringify(results),
          );
          business = results[0].body.business;
          second = results[1].body.business;
          assert.notEqual(business.id, second.id);
          assert.notEqual(business.bot_id, second.bot_id);
          const rows = (
            await db.query(
              "SELECT bubble_user_id FROM businesses WHERE id=ANY($1::uuid[])",
              [[business.id, second.id]],
            )
          ).rows;
          assert.ok(rows.every((r) => r.bubble_user_id === null));
          assert.equal(
            (
              await call(`/api/v1/agencies/${agency}/businesses`, {
                cookie: owner.cookie,
              })
            ).body.businesses.length,
            2,
          );
          assert.equal(
            (
              await call("/api/v1/businesses/" + business.id, {
                cookie: outsider.cookie,
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await call(`/api/v1/agencies/${agency}/businesses`, {
                cookie: outsider.cookie,
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM agency_businesses WHERE agency_id=$1",
                [agency],
              )
            ).rows[0].n,
            2,
          );
        },
      );
      let invite;
      await t.test(
        "invitations require the correct verified recipient; acceptance cannot be transferred",
        async () => {
          const result = await call("/api/account/organization/invite-member", {
            method: "POST",
            cookie: owner.cookie,
            body: {
              organizationId: agency,
              email: staff.email,
              role: "member",
            },
          });
          assert.equal(result.status, 200, JSON.stringify(result.body));
          invite = result.body.id;
          assert.ok(
            (
              await call("/api/account/organization/accept-invitation", {
                method: "POST",
                cookie: outsider.cookie,
                body: { invitationId: invite },
              })
            ).status >= 400,
          );
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int n FROM chatflow_member WHERE "organizationId"=$1 AND "userId"=$2',
                [agency, outsider.id],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await call("/api/account/organization/accept-invitation", {
                method: "POST",
                cookie: staff.cookie,
                body: { invitationId: invite },
              })
            ).status,
            200,
          );
        },
      );
      await t.test(
        "ordinary staff cannot inherit every client, escalate roles or grant themselves access",
        async () => {
          assert.equal(
            (
              await call(`/api/v1/agencies/${agency}/businesses`, {
                cookie: staff.cookie,
              })
            ).body.businesses.length,
            0,
          );
          assert.equal(
            (
              await call("/api/v1/businesses/" + business.id, {
                cookie: staff.cookie,
              })
            ).status,
            404,
          );
          const member = (
            await db.query(
              'SELECT id FROM chatflow_member WHERE "organizationId"=$1 AND "userId"=$2',
              [agency, staff.id],
            )
          ).rows[0];
          assert.ok(
            (
              await call("/api/account/organization/update-member-role", {
                method: "POST",
                cookie: staff.cookie,
                body: {
                  organizationId: agency,
                  memberId: member.id,
                  role: "owner",
                },
              })
            ).status >= 400,
          );
          assert.ok(
            (
              await call(
                `/api/v1/businesses/${business.id}/members/${staff.id}`,
                {
                  method: "PUT",
                  cookie: staff.cookie,
                  body: { role: "editor" },
                },
              )
            ).status >= 400,
          );
          assert.ok(
            (
              await call("/api/account/organization/invite-member", {
                method: "POST",
                cookie: staff.cookie,
                body: {
                  organizationId: agency,
                  email: "escalate@example.test",
                  role: "owner",
                },
              })
            ).status >= 400,
          );
          assert.equal(
            (
              await db.query("SELECT role FROM chatflow_member WHERE id=$1", [
                member.id,
              ])
            ).rows[0].role,
            "member",
          );
        },
      );
      await t.test(
        "admins can manage clients but cannot promote themselves to owner",
        async () => {
          const member = (
            await db.query(
              'SELECT id FROM chatflow_member WHERE "organizationId"=$1 AND "userId"=$2',
              [agency, staff.id],
            )
          ).rows[0];
          assert.equal(
            (
              await call("/api/account/organization/update-member-role", {
                method: "POST",
                cookie: owner.cookie,
                body: {
                  organizationId: agency,
                  memberId: member.id,
                  role: "admin",
                },
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await call("/api/v1/businesses/" + second.id, {
                cookie: staff.cookie,
              })
            ).status,
            200,
          );
          assert.ok(
            (
              await call("/api/account/organization/update-member-role", {
                method: "POST",
                cookie: staff.cookie,
                body: {
                  organizationId: agency,
                  memberId: member.id,
                  role: "owner",
                },
              })
            ).status >= 400,
          );
          assert.equal(
            (
              await call("/api/account/organization/update-member-role", {
                method: "POST",
                cookie: owner.cookie,
                body: {
                  organizationId: agency,
                  memberId: member.id,
                  role: "member",
                },
              })
            ).status,
            200,
          );
        },
      );
      await t.test(
        "the verified invitation recipient can reject an invitation without joining the agency",
        async () => {
          const invitation = await call(
            "/api/account/organization/invite-member",
            {
              method: "POST",
              cookie: outsider.cookie,
              body: {
                organizationId: otherAgency,
                email: client.email,
                role: "member",
              },
            },
          );
          assert.equal(invitation.status, 200);
          assert.ok(
            (
              await call("/api/account/organization/reject-invitation", {
                method: "POST",
                cookie: staff.cookie,
                body: { invitationId: invitation.body.id },
              })
            ).status >= 400,
          );
          assert.equal(
            (
              await call("/api/account/organization/reject-invitation", {
                method: "POST",
                cookie: client.cookie,
                body: { invitationId: invitation.body.id },
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await db.query(
                "SELECT status FROM chatflow_invitation WHERE id=$1",
                [invitation.body.id],
              )
            ).rows[0].status,
            "rejected",
          );
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int n FROM chatflow_member WHERE "organizationId"=$1 AND "userId"=$2',
                [otherAgency, client.id],
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        "verified client and staff grants isolate resources; edits and member listing enforce roles",
        async () => {
          for (const [user, role] of [
            [client, "viewer"],
            [staff, "editor"],
          ])
            assert.equal(
              (
                await call(
                  `/api/v1/businesses/${business.id}/members/${user.id}`,
                  { method: "PUT", cookie: owner.cookie, body: { role } },
                )
              ).status,
              200,
            );
          assert.equal(
            (
              await call("/api/v1/businesses/" + business.id, {
                cookie: client.cookie,
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await call("/api/v1/businesses/" + second.id, {
                cookie: client.cookie,
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await call("/api/v1/agencies/" + agency, {
                cookie: client.cookie,
              })
            ).status,
            404,
          );
          assert.equal(
            (await call("/api/v1/businesses", { cookie: client.cookie })).body
              .businesses.length,
            1,
          );
          assert.equal(
            (
              await call(`/api/v1/businesses/${business.id}`, {
                method: "PATCH",
                cookie: client.cookie,
                body: { business_name: "Forbidden" },
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await call(`/api/v1/businesses/${business.id}`, {
                method: "PATCH",
                cookie: staff.cookie,
                body: { business_name: "Allowed staff edit" },
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await call(`/api/v1/businesses/${business.id}`, {
                method: "PATCH",
                cookie: owner.cookie,
                body: { bubble_user_id: "forged" },
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await call(`/api/v1/businesses/${business.id}/members`, {
                cookie: owner.cookie,
              })
            ).body.members.length,
            2,
          );
          assert.ok(
            (
              await call(`/api/v1/businesses/${business.id}/members`, {
                cookie: client.cookie,
              })
            ).status >= 400,
          );
        },
      );
      let firstAgent, otherAgent, agentConfig;
      const agentsPath = () => `/api/v1/businesses/${business.id}/agents`;
      await t.test(
        "owner creates multiple independent agents; staff editor can create, ungranted staff cannot",
        async () => {
          const results = await Promise.all(
            ["Lead agent", "Support agent"].map((name) =>
              call(agentsPath(), {
                method: "POST",
                cookie: owner.cookie,
                body: { name },
              }),
            ),
          );
          assert.deepEqual(
            results.map((r) => r.status),
            [201, 201],
          );
          firstAgent = results[0].body.agent;
          otherAgent = results[1].body.agent;
          assert.notEqual(firstAgent.public_id, otherAgent.public_id);
          assert.equal(firstAgent.status, "draft");
          const configs = (
            await db.query("SELECT * FROM agent_configs WHERE business_id=$1", [
              business.id,
            ])
          ).rows;
          assert.equal(configs.length, 2);
          assert.ok(
            configs.every(
              (c) =>
                c.version === 1 &&
                c.status === "draft" &&
                c.system_prompt === "",
            ),
          );
          assert.equal(
            (
              await call(agentsPath(), {
                method: "POST",
                cookie: staff.cookie,
                body: { name: "Editor agent" },
              })
            ).status,
            201,
          );
          assert.equal(
            (
              await call(`/api/v1/businesses/${second.id}/agents`, {
                method: "POST",
                cookie: staff.cookie,
                body: { name: "Forbidden" },
              })
            ).status,
            404,
          );
        },
      );
      await t.test(
        "agent metadata viewers cannot create, edit or read/update configuration; strangers and foreign IDs are rejected",
        async () => {
          assert.equal(
            (await call(agentsPath(), { cookie: client.cookie })).body.agents
              .length,
            3,
          );
          assert.equal(
            (
              await call(agentsPath() + "/" + firstAgent.id, {
                cookie: client.cookie,
              })
            ).status,
            200,
          );
          for (const [path, method, body] of [
            [agentsPath(), "POST", { name: "Forbidden" }],
            [
              agentsPath() + "/" + firstAgent.id,
              "PATCH",
              { name: "Forbidden" },
            ],
            [agentsPath() + "/" + firstAgent.id + "/config", "GET", undefined],
            [agentsPath() + "/" + firstAgent.id + "/config", "PUT", {}],
          ]) {
            const r = await call(path, { cookie: client.cookie, method, body });
            assert.ok([400, 403].includes(r.status));
          }
          for (const cookie of [outsider.cookie, undefined])
            assert.equal(
              (await call(agentsPath(), { cookie })).status,
              cookie ? 404 : 401,
            );
          for (const suffix of ["", "/config"])
            assert.equal(
              (
                await call(
                  `/api/v1/businesses/${second.id}/agents/${firstAgent.id}${suffix}`,
                  { cookie: owner.cookie },
                )
              ).status,
              404,
            );
          assert.equal(
            (
              await call(agentsPath() + "/" + firstAgent.id, {
                method: "PATCH",
                cookie: owner.cookie,
                body: { business_id: second.id },
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await call(agentsPath(), {
                method: "POST",
                cookie: owner.cookie,
                body: { name: "Bad", public_id: randomUUID() },
              })
            ).status,
            400,
          );
        },
      );
      const configBody = (version = 1) => ({
        expected_version: version,
        status: "active",
        system_prompt: "Only use this agent configuration.",
        welcome_message: "Hello",
        starter_prompts: ["Can you help?"],
        provider: "openai",
        model_id: "gpt-4o-mini",
        temperature: 0.7,
        generation_settings: { max_output_tokens: 1024 },
        capabilities: ["lead_capture"],
        lead_capture: { enabled: true, fields: ["email"] },
        escalation: { enabled: false },
      });
      await t.test(
        "configuration validates settings, secrets and model/provider; viewer writes cannot mutate data",
        async () => {
          const path = agentsPath() + "/" + firstAgent.id + "/config";
          for (const changes of [
            { api_key: "secret" },
            { business_id: second.id },
            { provider: "anthropic" },
            { model_id: "gpt-4o" },
            { generation_settings: { unknown: true } },
            { lead_capture: { enabled: true, fields: ["password"] } },
            { system_prompt: "", status: "active" },
          ])
            assert.equal(
              (
                await call(path, {
                  method: "PUT",
                  cookie: owner.cookie,
                  body: { ...configBody(), ...changes },
                })
              ).status,
              400,
            );
          assert.equal(
            (
              await call(path, {
                method: "PUT",
                cookie: client.cookie,
                body: configBody(),
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await call(agentsPath() + "/" + firstAgent.id, {
                method: "PATCH",
                cookie: owner.cookie,
                body: { status: "active" },
              })
            ).status,
            409,
          );
          const saved = await call(path, {
            method: "PUT",
            cookie: staff.cookie,
            body: configBody(),
          });
          assert.equal(saved.status, 200, JSON.stringify(saved));
          agentConfig = saved.body.config;
          assert.equal(agentConfig.version, 2);
          assert.equal(
            (
              await call(agentsPath() + "/" + otherAgent.id + "/config", {
                cookie: owner.cookie,
              })
            ).body.config.system_prompt,
            "",
          );
          assert.equal(
            (
              await call(agentsPath() + "/" + firstAgent.id, {
                cookie: owner.cookie,
              })
            ).body.agent.status,
            "draft",
          );
        },
      );
      await t.test(
        "concurrent configuration saves use optimistic versions; activation is explicit and draft saves pause readiness",
        async () => {
          const path = agentsPath() + "/" + firstAgent.id + "/config";
          const saves = await Promise.all(
            ["A", "B"].map((system_prompt) =>
              call(path, {
                method: "PUT",
                cookie: owner.cookie,
                body: { ...configBody(2), system_prompt },
              }),
            ),
          );
          assert.deepEqual(saves.map((r) => r.status).sort(), [200, 409]);
          assert.equal(
            (await call(path, { cookie: owner.cookie })).body.config.version,
            3,
          );
          assert.equal(
            (
              await call(agentsPath() + "/" + firstAgent.id, {
                method: "PATCH",
                cookie: owner.cookie,
                body: { status: "active" },
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await call(path, {
                method: "PUT",
                cookie: owner.cookie,
                body: { ...configBody(3), status: "draft" },
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await call(agentsPath() + "/" + firstAgent.id, {
                cookie: owner.cookie,
              })
            ).body.agent.status,
            "paused",
          );
        },
      );
      await t.test(
        "archival is non-destructive and terminal; config edits cannot reactivate archived agents",
        async () => {
          const path = agentsPath() + "/" + otherAgent.id;
          assert.equal(
            (
              await call(path, {
                method: "PATCH",
                cookie: owner.cookie,
                body: { status: "archived" },
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await call(path + "/config", {
                method: "PUT",
                cookie: owner.cookie,
                body: configBody(),
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await call(path, {
                method: "PATCH",
                cookie: owner.cookie,
                body: { status: "active" },
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await call(path, {
                method: "PATCH",
                cookie: owner.cookie,
                body: { name: "Reactivation attempt" },
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM agent_configs WHERE agent_id=$1",
                [otherAgent.id],
              )
            ).rows[0].n,
            1,
          );
          await assert.rejects(
            db.query("UPDATE agents SET status='active' WHERE id=$1", [
              otherAgent.id,
            ]),
            { code: "23514" },
          );
        },
      );
      await t.test(
        "tenant-coupled agent constraints reject cross-business config/mapping and immutable identity changes",
        async () => {
          await assert.rejects(
            db.query(
              "UPDATE agent_configs SET business_id=$1 WHERE agent_id=$2",
              [second.id, firstAgent.id],
            ),
            { code: "23503" },
          );
          await assert.rejects(
            db.query("UPDATE agents SET business_id=$1 WHERE id=$2", [
              second.id,
              firstAgent.id,
            ]),
            { code: "23514" },
          );
          await assert.rejects(
            db.query("UPDATE agents SET public_id=$1 WHERE id=$2", [
              randomUUID(),
              firstAgent.id,
            ]),
            { code: "23514" },
          );
          await assert.rejects(
            db.query(
              "INSERT INTO legacy_agent_mappings(business_id,bot_id,agent_id) VALUES ($1,$2,$3)",
              [second.id, second.bot_id, firstAgent.id],
            ),
            { code: "23503" },
          );
        },
      );
      await t.test(
        "legacy mapping is draft and preserves bot config, IDs and revision without granting agency access",
        async () => {
          const row = (
            await db.query(
              "SELECT a.*,m.bot_id,c.version,c.system_prompt FROM legacy_agent_mappings m JOIN agents a ON a.id=m.agent_id JOIN agent_configs c ON c.agent_id=a.id WHERE m.business_id=$1",
              [legacy],
            )
          ).rows[0];
          assert.equal(row.bot_id, "legacy-bot");
          assert.equal(row.status, "draft");
          assert.equal(row.version, 1);
          assert.equal(row.system_prompt, "");
          assert.equal(
            (
              await call(`/api/v1/businesses/${legacy}/agents`, {
                cookie: owner.cookie,
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await db.query(
                "SELECT active FROM bot_configs WHERE business_id=$1",
                [legacy],
              )
            ).rows[0].active,
            true,
          );
          const before = (
            await db.query(
              "SELECT * FROM legacy_agent_mappings ORDER BY business_id",
            )
          ).rows;
          await db.query(
            await readFile(
              new URL(
                "../src/db/migrations/010_agent_foundation.sql",
                import.meta.url,
              ),
              "utf8",
            ),
          );
          assert.deepEqual(
            (
              await db.query(
                "SELECT * FROM legacy_agent_mappings ORDER BY business_id",
              )
            ).rows,
            before,
          );
        },
      );
      await t.test(
        "legacy JWTs and inactive businesses cannot use agent APIs",
        async () => {
          const response = await fetch(base + agentsPath(), {
            headers: {
              origin: base,
              authorization:
                "Bearer " +
                jwt.sign(
                  { business_id: business.id, sub: business.id },
                  "legacy-test-key",
                ),
            },
          });
          assert.equal(response.status, 401);
          await db.query("UPDATE businesses SET active=false WHERE id=$1", [
            second.id,
          ]);
          try {
            for (const method of ["GET", "POST"])
              assert.equal(
                (
                  await call(`/api/v1/businesses/${second.id}/agents`, {
                    cookie: owner.cookie,
                    method,
                    ...(method === "POST"
                      ? { body: { name: "Inactive" } }
                      : {}),
                  })
                ).status,
                404,
              );
          } finally {
            await db.query("UPDATE businesses SET active=true WHERE id=$1", [
              second.id,
            ]);
          }
        },
      );
      await t.test(
        "Phase 3B: two website agents have isolated prompts, knowledge, conversations and outcomes",
        async () => {
          const make = async (name, purpose, prompt, lead) => {
            const a = await call(`/api/v1/businesses/${business.id}/agents`, {
              method: "POST",
              cookie: owner.cookie,
              body: { name, purpose },
            });
            assert.equal(a.status, 201, JSON.stringify(a.body));
            const id = a.body.agent.id,
              root = `/api/v1/businesses/${business.id}/agents/${id}`;
            const config = {
              ...configBody(),
              system_prompt: prompt,
              lead_capture: {
                enabled: lead,
                fields: ["name", "email", "phone"],
              },
              capabilities: lead ? ["lead_capture"] : [],
            };
            assert.equal(
              (
                await call(root + "/config", {
                  method: "PUT",
                  cookie: owner.cookie,
                  body: config,
                })
              ).status,
              200,
            );
            assert.equal(
              (
                await call(root, {
                  method: "PATCH",
                  cookie: owner.cookie,
                  body: { status: "active" },
                })
              ).status,
              200,
            );
            const dep = await call(root + "/deployments", {
              method: "POST",
              cookie: owner.cookie,
              body: { allowed_origins: [base] },
            });
            assert.equal(dep.status, 201, JSON.stringify(dep.body));
            assert.equal(
              (
                await call(root + "/deployments/" + dep.body.deployment.id, {
                  method: "PATCH",
                  cookie: owner.cookie,
                  body: { status: "active" },
                })
              ).status,
              200,
            );
            return {
              id,
              root,
              token: dep.body.token,
              deployment: dep.body.deployment.id,
            };
          };
          const sales = await make(
              "Sales",
              "lead_generation",
              "Sales assistant",
              true,
            ),
            support = await make(
              "Support",
              "customer_support",
              "Support assistant",
              false,
            );
          const chat = async (
            agent,
            sessionId,
            message,
            stream = false,
            token = agent.token,
            origin = base,
          ) => {
            const response = await fetch(
              base + `/api/agent-chat?stream=${stream}`,
              {
                method: "POST",
                headers: {
                  origin,
                  "x-agent-token": token,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ sessionId, message }),
              },
            );
            const raw = await response.text();
            return {
              status: response.status,
              raw,
              body: stream ? raw : JSON.parse(raw),
            };
          };
          const beforeLegacy = {};
          for (const table of [
            "sessions",
            "messages",
            "knowledge_chunks",
            "leads",
            "inquiries",
          ])
            beforeLegacy[table] = (
              await db.query(`SELECT count(*)::int n FROM ${table}`)
            ).rows[0].n;
          const add = async (agent, source_key, text) =>
            call(agent.root + "/knowledge", {
              method: "POST",
              cookie: owner.cookie,
              body: { source_key, text },
            });
          assert.equal(
            (
              await add(
                sales,
                "pricing",
                "Sales pricing is 250 pounds; we build websites and CRM systems.",
              )
            ).status,
            201,
          );
          assert.equal(
            (
              await add(
                support,
                "returns",
                "Support returns allow a refund in 14 days; troubleshoot login using reset.",
              )
            ).status,
            201,
          );
          const revisions = async () =>
            (
              await db.query(
                "SELECT id,knowledge_revision FROM agents WHERE id=ANY($1::uuid[])",
                [sales.id, support.id],
              )
            ).rows;
          const initialRevisions = await revisions();
          const aRev = String(
              initialRevisions.find((r) => r.id === sales.id)
                .knowledge_revision,
            ),
            bRev = String(
              initialRevisions.find((r) => r.id === support.id)
                .knowledge_revision,
            );
          assert.ok(Number(aRev) > 0 && Number(bRev) > 0);
          assert.equal(
            (await call(sales.root + "/knowledge", { cookie: owner.cookie }))
              .body.knowledge.length,
            1,
          );
          assert.equal(
            (await call(support.root + "/knowledge", { cookie: owner.cookie }))
              .body.knowledge.length,
            1,
          );
          const resultA = await chat(
            sales,
            "sales-visitor",
            "Please quote me; I am Alex Customer, alex@example.test",
          );
          const resultB = await chat(
            support,
            "support-visitor",
            "My return has a problem, please help with a refund",
            true,
          );
          assert.equal(resultA.status, 200, JSON.stringify(resultA));
          assert.equal(resultA.body.reply, "Sales response");
          assert.equal(resultB.status, 200, resultB.raw);
          assert.match(resultB.raw, /Support response/);
          assert.match(resultB.raw, /data: \[DONE\]/);
          assert.ok(modelCalls[0].systemPrompt.includes("Sales assistant"));
          assert.ok(modelCalls[0].systemPrompt.includes("Sales pricing"));
          assert.ok(!modelCalls[0].systemPrompt.includes("Support returns"));
          assert.ok(modelCalls[1].systemPrompt.includes("Support assistant"));
          assert.ok(modelCalls[1].systemPrompt.includes("Support returns"));
          assert.ok(!modelCalls[1].systemPrompt.includes("Sales pricing"));
          assert.equal(modelCalls[0].messages.length, 1);
          assert.equal(modelCalls[1].messages.length, 1);
          assert.equal(
            (await call(sales.root + "/leads", { cookie: owner.cookie })).body
              .leads.length,
            1,
          );
          assert.equal(
            (await call(support.root + "/leads", { cookie: owner.cookie })).body
              .leads.length,
            0,
          );
          assert.equal(
            (await call(support.root + "/inquiries", { cookie: owner.cookie }))
              .body.inquiries.length,
            1,
          );
          assert.equal(
            (await call(sales.root + "/inquiries", { cookie: owner.cookie }))
              .body.inquiries.length,
            0,
          );
          assert.equal(
            (
              await call(sales.root + "/conversations/sales-visitor", {
                cookie: owner.cookie,
              })
            ).body.messages.length,
            2,
          );
          assert.equal(
            (
              await call(support.root + "/conversations/sales-visitor", {
                cookie: owner.cookie,
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await call(
                `/api/v1/businesses/${second.id}/agents/${sales.id}/leads`,
                { cookie: owner.cookie },
              )
            ).status,
            404,
          );
          assert.equal(
            (await call(sales.root + "/leads", { cookie: client.cookie }))
              .status,
            403,
          );
          assert.equal(
            (
              await chat(
                support,
                "sales-visitor",
                "Support should not inherit sales",
              )
            ).status,
            403,
          );
          assert.equal(
            (
              await chat(
                sales,
                "support-visitor",
                "Sales should not inherit support",
              )
            ).status,
            403,
          );
          assert.equal(
            (
              await chat(
                sales,
                "sales-visitor",
                "Token substitution",
                false,
                support.token,
              )
            ).status,
            403,
          );
          assert.equal(
            (
              await chat(
                sales,
                "new-origin",
                "Hello",
                false,
                sales.token,
                "https://attacker.test",
              )
            ).status,
            403,
          );
          assert.equal(
            (await chat(sales, "sales-visitor", "Follow up question")).status,
            200,
          );
          assert.ok(
            modelCalls
              .at(-1)
              .messages.some((m) => m.content === "Sales response"),
          );
          assert.ok(
            !modelCalls
              .at(-1)
              .messages.some((m) => m.content === "Support response"),
          );
          const oldToken = sales.token;
          const rotated = await call(
            sales.root + "/deployments/" + sales.deployment + "/rotate",
            { method: "POST", cookie: owner.cookie, body: {} },
          );
          assert.equal(rotated.status, 200);
          sales.token = rotated.body.token;
          assert.equal(
            (await chat(sales, "expired-token", "Hello", false, oldToken))
              .status,
            403,
          );
          assert.equal((await chat(sales, "new-token", "Hello")).status, 200);
          assert.equal(
            (
              await call(sales.root, {
                method: "PATCH",
                cookie: owner.cookie,
                body: { status: "paused" },
              })
            ).status,
            200,
          );
          const paused = await chat(sales, "paused-agent", "Hello", true);
          assert.equal(paused.status, 200);
          assert.match(paused.raw, /isDisabled/);
          assert.equal(
            (await chat(support, "still-support", "My return has an issue"))
              .status,
            200,
          );
          assert.equal(
            (
              await call(
                sales.root + "/deployments/" + sales.deployment + "/revoke",
                { method: "POST", cookie: owner.cookie, body: {} },
              )
            ).status,
            200,
          );
          assert.equal((await chat(sales, "revoked", "Hello")).status, 403);
          assert.equal(
            (await chat(support, "still-active", "My return has an issue"))
              .status,
            200,
          );
          for (const id of [
            "expired-token",
            "new-origin",
            "paused-agent",
            "revoked",
          ])
            assert.equal(
              (
                await db.query(
                  "SELECT count(*)::int n FROM agent_chat_sessions WHERE id=$1",
                  [id],
                )
              ).rows[0].n,
              0,
            );
          for (const table of Object.keys(beforeLegacy))
            assert.equal(
              (await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]
                .n,
              beforeLegacy[table],
              table + " legacy unchanged",
            );
          redisDown = true;
          assert.equal(
            (await chat(support, "redis-down", "My return has an issue"))
              .status,
            200,
          );
          redisDown = false;
          embeddingDown = true;
          const status = await chat(
            support,
            "embedding-down",
            "Unique embedding failure prompt",
          );
          assert.ok(status.status >= 500);
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM agent_chat_sessions WHERE id='embedding-down'",
              )
            ).rows[0].n,
            0,
          );
          embeddingDown = false;
          const source = (
            await call(sales.root + "/knowledge", { cookie: owner.cookie })
          ).body.knowledge[0];
          await assert.rejects(
            db.query(
              "UPDATE agent_knowledge_chunks SET agent_id=$1 WHERE source_id=$2",
              [support.id, source.id],
            ),
            { code: "23503" },
          );
          await assert.rejects(
            db.query(
              "UPDATE agent_chat_messages SET agent_id=$1 WHERE session_id=$2",
              [support.id, "sales-visitor"],
            ),
            { code: "23503" },
          );
          assert.equal(
            (
              await call(support.root + "/knowledge/" + source.id, {
                method: "DELETE",
                cookie: owner.cookie,
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await add(
                sales,
                "pricing",
                "Sales updated pricing is 300 pounds.",
              )
            ).status,
            201,
          );
          const rev2 = await revisions();
          assert.ok(
            BigInt(rev2.find((r) => r.id === sales.id).knowledge_revision) >
              BigInt(aRev),
          );
          assert.equal(
            String(rev2.find((r) => r.id === support.id).knowledge_revision),
            bRev,
          );
          assert.equal(
            (
              await call(sales.root + "/knowledge/" + source.id, {
                method: "DELETE",
                cookie: owner.cookie,
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM agent_knowledge_chunks WHERE agent_id=$1",
                [sales.id],
              )
            ).rows[0].n,
            0,
          );
          assert.ok(
            (
              await db.query(
                "SELECT count(*)::int n FROM agent_knowledge_chunks WHERE agent_id=$1",
                [support.id],
              )
            ).rows[0].n > 0,
          );
        },
      );
      await t.test(
        "concurrent grants retain one row; tenant-coupled foreign keys reject invalid ownership",
        async () => {
          const results = await Promise.all(
            Array.from({ length: 4 }, () =>
              call(`/api/v1/businesses/${business.id}/members/${client.id}`, {
                method: "PUT",
                cookie: owner.cookie,
                body: { role: "viewer" },
              }),
            ),
          );
          assert.ok(results.every((r) => r.status === 200));
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM business_memberships WHERE business_id=$1 AND user_id=$2",
                [business.id, client.id],
              )
            ).rows[0].n,
            1,
          );
          await assert.rejects(
            db.query(
              "INSERT INTO agency_businesses(business_id,agency_id,created_by) VALUES ($1,$2,$3)",
              [business.id, otherAgency, outsider.id],
            ),
            { code: "23505" },
          );
          await assert.rejects(
            db.query(
              "UPDATE business_memberships SET agency_id=$1 WHERE business_id=$2",
              [otherAgency, business.id],
            ),
            { code: "23503" },
          );
        },
      );
      await t.test(
        "removing agency staff revokes explicit business access without touching client grants",
        async () => {
          const member = (
            await db.query(
              'SELECT id FROM chatflow_member WHERE "organizationId"=$1 AND "userId"=$2',
              [agency, staff.id],
            )
          ).rows[0];
          assert.equal(
            (
              await call("/api/account/organization/remove-member", {
                method: "POST",
                cookie: owner.cookie,
                body: { organizationId: agency, memberIdOrEmail: member.id },
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await call("/api/v1/businesses/" + business.id, {
                cookie: staff.cookie,
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await call("/api/v1/businesses/" + business.id, {
                cookie: client.cookie,
              })
            ).status,
            200,
          );
        },
      );
      await t.test(
        "last owner cannot leave or demote; concurrent SQL demotions cannot remove every owner",
        async () => {
          const member = (
            await db.query(
              'SELECT id FROM chatflow_member WHERE "organizationId"=$1 AND "userId"=$2',
              [agency, owner.id],
            )
          ).rows[0];
          assert.ok(
            (
              await call("/api/account/organization/leave", {
                method: "POST",
                cookie: owner.cookie,
                body: { organizationId: agency },
              })
            ).status >= 400,
          );
          assert.ok(
            (
              await call("/api/account/organization/update-member-role", {
                method: "POST",
                cookie: owner.cookie,
                body: {
                  organizationId: agency,
                  memberId: member.id,
                  role: "member",
                },
              })
            ).status >= 400,
          );
          await db.query(
            `INSERT INTO chatflow_member(id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'owner',now())`,
            [randomUUID(), agency, staff.id],
          );
          const results = await Promise.allSettled(
            [owner.id, staff.id].map((id) =>
              db.query(
                `UPDATE chatflow_member SET role='member' WHERE "organizationId"=$1 AND "userId"=$2`,
                [agency, id],
              ),
            ),
          );
          assert.equal(
            results.filter((r) => r.status === "fulfilled").length,
            1,
          );
          assert.equal(
            (
              await db.query(
                `SELECT count(*)::int n FROM chatflow_member WHERE "organizationId"=$1 AND role='owner'`,
                [agency],
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        "expired/revoked sessions and disabled accounts fail immediately; legacy bearer is never a user session",
        async () => {
          const signed = await call("/api/account/sign-in/email", {
            method: "POST",
            body: { email: outsider.email, password: outsider.password },
          });
          const cookie = signed.headers
            .getSetCookie()
            .map((c) => c.split(";")[0])
            .join("; ");
          await db.query(
            'UPDATE chatflow_session SET "expiresAt"=now()-interval \'1 day\' WHERE "userId"=$1',
            [outsider.id],
          );
          assert.equal(
            (await call("/api/v1/agencies", { cookie })).status,
            401,
          );
          assert.equal((await call("/api/v1/agencies")).status, 401);
          const legacyToken = jwt.sign(
            { businessId: legacy, bubbleUserId: "verified-legacy-subject" },
            "isolated-legacy-signing-secret",
            {
              algorithm: "HS256",
              issuer: "chatflow-api",
              audience: "chatflow-dashboard",
              subject: legacy,
              expiresIn: "1h",
            },
          );
          const legacyOnly = await fetch(base + "/api/v1/agencies", {
            headers: { origin: base, authorization: "Bearer " + legacyToken },
          });
          assert.equal(legacyOnly.status, 401);
          await db.query(
            "UPDATE chatflow_user SET status='disabled' WHERE id=$1",
            [client.id],
          );
          assert.equal(
            (
              await call("/api/v1/businesses/" + business.id, {
                cookie: client.cookie,
              })
            ).status,
            401,
          );
          assert.ok(
            (
              await call("/api/account/sign-in/email", {
                method: "POST",
                body: { email: client.email, password: client.password },
              })
            ).status >= 400,
          );
          await db.query(
            "UPDATE chatflow_user SET status='active' WHERE id=$1",
            [client.id],
          );
          assert.equal(
            (
              await call("/api/account/sign-out", {
                method: "POST",
                cookie: client.cookie,
                body: {},
              })
            ).status,
            200,
          );
          assert.equal(
            (await call("/api/v1/businesses", { cookie: client.cookie }))
              .status,
            401,
          );
        },
      );
      await t.test(
        "password reset uses library tokens, revokes sessions and rejects unsafe origins",
        async () => {
          const signed = await call("/api/account/sign-in/email", {
            method: "POST",
            body: { email: client.email, password: client.password },
          });
          const cookie = signed.headers
            .getSetCookie()
            .map((c) => c.split(";")[0])
            .join("; ");
          assert.equal(
            (
              await call("/api/account/request-password-reset", {
                method: "POST",
                body: {
                  email: client.email,
                  redirectTo: base + "/reset-password",
                },
              })
            ).status,
            200,
          );
          const mail = outbox
            .filter((e) => e.to === client.email && e.subject.includes("Reset"))
            .at(-1);
          assert.ok(mail);
          const callback = await fetch(mail.url, { redirect: "manual" });
          assert.equal(callback.status, 302);
          const token = new URL(
            callback.headers.get("location"),
            base,
          ).searchParams.get("token");
          assert.ok(token);
          assert.equal(
            (
              await call("/api/account/reset-password", {
                method: "POST",
                body: { token, newPassword: "New-long-passphrase-98!" },
              })
            ).status,
            200,
          );
          assert.equal(
            (await call("/api/v1/businesses", { cookie })).status,
            401,
          );
          assert.ok(
            (
              await call("/api/account/sign-in/email", {
                method: "POST",
                body: { email: client.email, password: client.password },
              })
            ).status >= 400,
          );
          assert.equal(
            (
              await call("/api/account/sign-in/email", {
                method: "POST",
                origin: "https://attacker.test",
                body: {
                  email: client.email,
                  password: "New-long-passphrase-98!",
                },
              })
            ).status,
            403,
          );
        },
      );
      await t.test(
        "native session revocation cannot revoke another user's session",
        async () => {
          const login = await call("/api/account/sign-in/email", {
            method: "POST",
            body: { email: client.email, password: "New-long-passphrase-98!" },
          });
          assert.equal(login.status, 200);
          const cookie = login.headers
            .getSetCookie()
            .map((c) => c.split(";")[0])
            .join("; ");
          const ownerSession = await call("/api/account/get-session", {
            cookie: owner.cookie,
          });
          assert.equal(ownerSession.status, 200);
          await call("/api/account/revoke-session", {
            method: "POST",
            cookie,
            body: { token: ownerSession.body.session.token },
          });
          assert.equal(
            (await call("/api/account/get-session", { cookie: owner.cookie }))
              .status,
            200,
          );
          const ownSession = await call("/api/account/get-session", { cookie });
          assert.equal(
            (
              await call("/api/account/revoke-session", {
                method: "POST",
                cookie,
                body: { token: ownSession.body.session.token },
              })
            ).status,
            200,
          );
          assert.equal(
            (await call("/api/v1/businesses", { cookie })).status,
            401,
          );
        },
      );
      await t.test(
        "008/009/010 replay preserves legacy data/configs, nullable unique Bubble IDs and relationships",
        async () => {
          for (const file of [
            "008_account_auth.sql",
            "009_agency_business_access.sql",
            "010_agent_foundation.sql",
            "011_agent_runtime.sql",
          ])
            await db.query(
              await readFile(
                new URL("../src/db/migrations/" + file, import.meta.url),
                "utf8",
              ),
            );
          const row = (
            await db.query(
              "SELECT bubble_user_id,bot_id FROM businesses WHERE id=$1",
              [legacy],
            )
          ).rows[0];
          assert.deepEqual(row, {
            bubble_user_id: "verified-legacy-subject",
            bot_id: "legacy-bot",
          });
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM bot_configs WHERE business_id=$1",
                [legacy],
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM agency_businesses WHERE agency_id=$1",
                [agency],
              )
            ).rows[0].n,
            2,
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM chatflow_schema_migrations",
              )
            ).rows[0].n,
            4,
          );
        },
      );
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      if (db) await db.end();
      await admin.query("SET search_path TO public");
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
