import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import proxyaddr from "proxy-addr";
import { ipKeyGenerator } from "express-rate-limit";
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

test("IPv4-mapped trust subnets cannot turn an untrusted IPv4 peer into a trusted proxy", async () => {
  // A short mapped prefix previously matched every IPv4 address. Check Express
  // req.ip and the quota key, not only proxy-addr's subnet predicate.
  const mappedTrust = proxyaddr.compile("::ffff:10.0.0.0/8");
  assert.equal(mappedTrust("198.51.100.10"), false);
  assert.equal(mappedTrust("10.20.0.8"), false);
  const mappedApp = express();
  configureTrustedProxy(mappedApp, {
    ACCOUNT_PROXY_MODE: "trusted",
    TRUSTED_PROXY_CIDRS: "::ffff:10.0.0.0/8",
  });
  mappedApp.get("/", (req, res) =>
    res.json({ ip: req.ip, quotaKey: ipKeyGenerator(req.ip) }),
  );
  const mappedServer = await new Promise(resolve => {
    const s = mappedApp.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const request = forwarded => new Promise((resolve, reject) => {
      http.get({
        hostname: "127.0.0.1", port: mappedServer.address().port,
        localAddress: "127.0.0.2", headers: { "x-forwarded-for": forwarded },
      }, res => {
        let body = "";
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve(JSON.parse(body)));
      }).on("error", reject);
    });
    const first = await request("198.51.100.10");
    const second = await request("203.0.113.99");
    assert.deepEqual(first, { ip: "127.0.0.2", quotaKey: ipKeyGenerator("127.0.0.2") });
    assert.deepEqual(second, first);
  } finally {
    await new Promise(resolve => mappedServer.close(resolve));
  }
});

test("bounded IPv4, IPv6, and correctly mapped proxy CIDRs remain distinct", () => {
  const ipv4 = proxyaddr.compile("10.20.0.0/24");
  assert.equal(ipv4("10.20.0.8"), true);
  assert.equal(ipv4("10.21.0.8"), false);
  const ipv6 = proxyaddr.compile("2001:db8::/48");
  assert.equal(ipv6("2001:db8::1"), true);
  assert.equal(ipv6("2001:db9::1"), false);
  assert.equal(ipv6("198.51.100.10"), false);
  const mapped = proxyaddr.compile("::ffff:127.0.0.0/104");
  assert.equal(mapped("127.0.0.2"), true);
  assert.equal(mapped("198.51.100.10"), false);
});
