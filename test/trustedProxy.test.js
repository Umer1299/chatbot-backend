import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import {
  trustedProxySettings,
  configureTrustedProxy,
} from "../src/middleware/trustedProxy.js";

test("proxy trust accepts explicit IPv4/IPv6 CIDRs and rejects blanket/hop/header-based trust", () => {
  assert.deepEqual(trustedProxySettings({}).trust, false);
  assert.deepEqual(
    trustedProxySettings({
      ACCOUNT_PROXY_MODE: "trusted",
      TRUSTED_PROXY_CIDRS: "10.20.0.0/24,2001:db8::/48",
    }).trust,
    ["10.20.0.0/24", "2001:db8::/48"],
  );
  for (const value of [
    "true",
    "1",
    "0.0.0.0/0",
    "::/0",
    "127.0.0.1/33",
    "::1/129",
    "loopback",
    "not-an-ip",
    "127.0.0.1/no",
  ])
    assert.throws(() => trustedProxySettings({ TRUSTED_PROXY_CIDRS: value }));
  assert.throws(() => trustedProxySettings({ ACCOUNT_PROXY_MODE: "trusted" }));
  assert.throws(() =>
    trustedProxySettings({
      ACCOUNT_PROXY_MODE: "direct",
      TRUSTED_PROXY_CIDRS: "127.0.0.1",
    }),
  );
});
const app = express();
configureTrustedProxy(app, {
  ACCOUNT_PROXY_MODE: "trusted",
  TRUSTED_PROXY_CIDRS: "127.0.0.1/32,10.20.0.0/24",
});
app.get("/", (req, res) => res.json({ ip: req.ip }));
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
after(() => new Promise((resolve) => server.close(resolve)));
function getIp(forwarded, localAddress = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port: server.address().port,
        path: "/",
        localAddress,
        headers: { "x-forwarded-for": forwarded },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(JSON.parse(body).ip));
      },
    );
    req.on("error", reject);
  });
}
test("trusted ingress preserves distinct clients and stops at the nearest untrusted hop", async () => {
  assert.equal(await getIp("198.51.100.10, 10.20.0.8"), "198.51.100.10");
  assert.equal(await getIp("198.51.100.11, 10.20.0.8"), "198.51.100.11");
  assert.equal(
    await getIp("203.0.113.99, 198.51.100.10, 10.20.0.8"),
    "198.51.100.10",
  );
  assert.equal(await getIp("203.0.113.99, 10.99.0.8"), "10.99.0.8");
});
test("a direct untrusted peer cannot spoof client identity with forwarded headers", async () => {
  assert.equal(await getIp("198.51.100.10", "127.0.0.2"), "127.0.0.2");
});
