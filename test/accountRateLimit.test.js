import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { MemoryStore } from "express-rate-limit";
const stores = new Map();
let sessionLookups = 0;
mock.module("../src/db/pool.js", { defaultExport: {} });
const { accountIdentity } = await import("../src/middleware/accountAuth.js");
let unavailable = false,
  executed = 0;
mock.module("rate-limit-redis", {
  defaultExport: class extends MemoryStore {
    constructor(options) {
      super();
      stores.set(options.prefix, this);
    }
    async increment(key) {
      if (unavailable) throw Error("Redis unavailable");
      return super.increment(key);
    }
  },
});
mock.module("../src/services/redis.js", { namedExports: { redisClient: {} } });
const {
  accountIpLimiter,
  accountLookupLimiter,
  accountUserLimiter,
  ipQuotaKey,
} = await import("../src/middleware/rateLimiter.js");
const app = express();
app.post("/account", accountIpLimiter, (req, res) => {
  executed++;
  res.json({ success: true });
});
for (const id of ["a", "b"])
  app.post(
    "/v1/" + id,
    accountLookupLimiter,
    (req, res, next) => {
      req.accountUser = { id };
      next();
    },
    accountUserLimiter,
    (req, res) => res.json({ success: true }),
  );
app.get(
  "/invalid-session",
  accountLookupLimiter,
  accountIdentity(() => ({
    api: {
      getSession: async () => {
        sessionLookups++;
        return null;
      },
    },
  })),
  (req, res) => res.json({ success: true }),
);
app.use((error, req, res, next) =>
  res.status(error.status || 503).json({ error: "Quota unavailable" }),
);
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
after(() => new Promise((resolve) => server.close(resolve)));
const send = async (path, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: "POST",
    headers,
  });
  await r.text();
  return r.status;
};
test("Redis quota failures block account authentication instead of bypassing controls", async () => {
  unavailable = true;
  assert.equal(await send("/account"), 503);
  assert.equal(executed, 0);
  unavailable = false;
});
test("account authentication quota cannot be reset by spoofed Authorization or forwarded-IP headers", async () => {
  for (let i = 0; i < 120; i++)
    assert.equal(
      await send("/account", { authorization: "Bearer spoof-" + i }),
      200,
    );
  assert.equal(
    await send("/account", {
      "x-forwarded-for": "203.0.113.7",
      authorization: "Bearer another",
    }),
    429,
  );
});
test("verified account quotas stay separate from public authentication and from other users sharing an IP", async () => {
  for (let i = 0; i < 120; i++) assert.equal(await send("/v1/a"), 200);
  assert.equal(await send("/v1/a"), 429);
  assert.equal(await send("/v1/b"), 200);
});

test("pre-session quota rejects rotating cookies/headers before identity DB work and is independent of login", async () => {
  const store = stores.get("rl:account-lookup:");
  const key = ipQuotaKey({ ip: "127.0.0.1" });
  await store.resetKey(key);
  await stores.get('rl:account-ip:').resetKey(key);
  const invalid = async (headers = {}) => {
    const r = await fetch(
      `http://127.0.0.1:${server.address().port}/invalid-session`,
      { headers },
    );
    await r.text();
    return r.status;
  };
  for (let i = 0; i < 3; i++)
    assert.equal(
      await invalid({
        cookie: `better-auth.session_token=expired-${i}`,
        authorization: `Bearer spoof-${i}`,
      }),
      401,
    );
  assert.equal(sessionLookups, 3);
  // Fill remaining capacity in the real MemoryStore without 5997 HTTP round trips.
  for (let i = 3; i < 6000; i++) await store.increment(key);
  assert.equal(
    await invalid({
      cookie: "better-auth.session_token=rotated",
      "x-forwarded-for": "203.0.113.90",
      authorization: "Bearer other",
    }),
    429,
  );
  assert.equal(sessionLookups, 3);
  assert.equal(await send("/account"), 200); // Resource abuse did not consume login capacity.
  await store.resetKey(key);
});
test("pre-session Redis failure fails closed before identity resolution", async () => {
  unavailable = true;
  const before = sessionLookups;
  try {
    const r = await fetch(
      `http://127.0.0.1:${server.address().port}/invalid-session`,
    );
    assert.equal(r.status, 503);
    await r.text();
    assert.equal(sessionLookups, before);
  } finally {
    unavailable = false;
  }
});
