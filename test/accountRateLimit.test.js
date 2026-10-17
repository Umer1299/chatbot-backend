import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { MemoryStore } from "express-rate-limit";
let unavailable = false,
  executed = 0;
mock.module("rate-limit-redis", {
  defaultExport: class extends MemoryStore {
    constructor() {
      super();
    }
    async increment(key) {
      if (unavailable) throw Error("Redis unavailable");
      return super.increment(key);
    }
  },
});
mock.module("../src/services/redis.js", { namedExports: { redisClient: {} } });
const { accountIpLimiter, accountUserLimiter } =
  await import("../src/middleware/rateLimiter.js");
const app = express();
app.post("/account", accountIpLimiter, (req, res) => {
  executed++;
  res.json({ success: true });
});
for (const id of ["a", "b"])
  app.post(
    "/v1/" + id,
    (req, res, next) => {
      req.accountUser = { id };
      next();
    },
    accountUserLimiter,
    (req, res) => res.json({ success: true }),
  );
app.use((error, req, res, next) =>
  res.status(503).json({ error: "Quota unavailable" }),
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
