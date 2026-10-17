import { test } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
mock.module("../src/db/pool.js", { defaultExport: {} });
const { accountSettings } = await import("../src/auth/accountAuth.js");
const { checkAccountOrigin, accountIdentity, accountHandler } =
  await import("../src/middleware/accountAuth.js");
const secret = "test-only-012345678901234567890123456789";
const valid = {
  ACCOUNT_AUTH_URL: "https://api.example.test",
  ACCOUNT_AUTH_SECRET: secret,
  ACCOUNT_TRUSTED_ORIGINS: "https://app.example.test,https://api.example.test",
  NODE_ENV: "production",
};

test("account configuration requires a separate secret and exact HTTPS production origins", () => {
  assert.equal(accountSettings(valid).production, true);
  for (const changes of [
    { ACCOUNT_AUTH_SECRET: "" },
    { ACCOUNT_TRUSTED_ORIGINS: "" },
    { ACCOUNT_TRUSTED_ORIGINS: "https://*.example.test" },
    { ACCOUNT_AUTH_URL: "http://api.example.test" },
    {
      ACCOUNT_TRUSTED_ORIGINS:
        "http://app.example.test,https://api.example.test",
    },
  ])
    assert.throws(() => accountSettings({ ...valid, ...changes }));
});
test("new cookie management mutations require trusted Origin and JSON; legacy server APIs are untouched", () => {
  const auth = { options: { trustedOrigins: ["https://app.example.test"] } };
  assert.doesNotThrow(() =>
    checkAccountOrigin({ method: "GET", headers: {} }, auth),
  );
  for (const origin of [
    undefined,
    "null",
    "https://attackerexample.test",
    "https://app.example.test.evil.test",
    "https://user@app.example.test",
  ])
    assert.throws(
      () =>
        checkAccountOrigin(
          {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
          },
          auth,
        ),
      { status: 403 },
    );
  assert.throws(
    () =>
      checkAccountOrigin(
        {
          method: "POST",
          headers: {
            origin: "https://app.example.test",
            "content-type": "text/plain",
          },
        },
        auth,
      ),
    { status: 415 },
  );
  assert.doesNotThrow(() =>
    checkAccountOrigin(
      {
        method: "PUT",
        headers: {
          origin: "https://app.example.test",
          "content-type": "application/json",
        },
      },
      auth,
    ),
  );
});
test("new identity middleware rejects legacy JWT-only, revoked, unverified and disabled sessions", async () => {
  for (const identity of [
    null,
    { user: { id: "u", status: "active", emailVerified: false } },
    { user: { id: "u", status: "disabled", emailVerified: true } },
  ]) {
    let error;
    const auth = {
      options: { trustedOrigins: [] },
      api: { getSession: async () => identity },
    };
    await accountIdentity(() => auth)(
      {
        method: "GET",
        headers: { authorization: "Bearer legacy-business-token" },
      },
      {},
      (e) => {
        error = e;
      },
    );
    assert.equal(error.status, 401);
  }
});
test("new identity comes from live library session lookup, never client-supplied roles", async () => {
  const auth = {
    options: { trustedOrigins: [] },
    api: {
      getSession: async (args) => {
        assert.equal(args.headers.get("x-chatflow-client-ip"), "203.0.113.1");
        assert.deepEqual(args.query, {
          disableCookieCache: true,
          disableRefresh: true,
        });
        return {
          user: { id: "u", status: "active", emailVerified: true },
          session: { id: "s" },
        };
      },
    },
  };
  const req = {
    method: "GET",
    headers: { "x-chatflow-client-ip": "forged" },
    ip: "203.0.113.1",
    body: { userId: "attacker", role: "owner" },
  };
  let error;
  await accountIdentity(() => auth)(req, {}, (e) => {
    error = e;
  });
  assert.equal(error, undefined);
  assert.equal(req.accountUser.id, "u");
  assert.equal(req.accountSession.id, "s");
});
test("raw server-only member insertion, organization deletion and unknown account endpoints are not exposed", async () => {
  for (const path of [
    "/organization/add-member",
    "/organization/delete",
    "/delete-user",
    "/change-email",
    "/organization/create-role",
  ]) {
    let status;
    const res = {
      status(code) {
        status = code;
        return this;
      },
      json() {},
    };
    await accountHandler(() => {
      throw Error("Must not initialize auth");
    })({ method: "POST", path: "/api/account" + path }, res, assert.fail);
    assert.equal(status, 404);
  }
});
