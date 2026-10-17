import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import express from "express";
mock.module("../src/db/pool.js", { defaultExport: {} });
const { createAccountAuth } = await import("../src/auth/accountAuth.js");
const { accountHandler, accountIdentity } =
  await import("../src/middleware/accountAuth.js");
const { createAgencyRouter } = await import("../src/api/agenciesV1.js");
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
      for (const file of [
        "008_account_auth.sql",
        "009_agency_business_access.sql",
      ])
        await admin.query(
          await readFile(
            new URL("../src/db/migrations/" + file, import.meta.url),
            "utf8",
          ),
        );
      db = new pg.Pool({
        connectionString: testUrl,
        max: 8,
        options: `-c search_path=${schema},public`,
      });
      const app = express();
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
        "008/009 replay preserves legacy data/configs, nullable unique Bubble IDs and relationships",
        async () => {
          for (const file of [
            "008_account_auth.sql",
            "009_agency_business_access.sql",
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
            2,
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
