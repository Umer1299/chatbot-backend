import { test } from "node:test";
import assert from "node:assert/strict";
import {
  issueCredential,
  hashCredential,
  validateOrigins,
} from "../src/services/websiteDeployment.js";
test("website token is 256-bit random and verifier never contains plaintext", () => {
  const a = issueCredential(),
    b = issueCredential();
  assert.notEqual(a.token, b.token);
  assert.equal(a.verifier.length, 32);
  assert.deepEqual(hashCredential(a.token), a.verifier);
  assert.notDeepEqual(hashCredential(b.token), a.verifier);
  assert.equal(hashCredential("public-deployment-uuid"), null);
  assert.ok(!a.verifier.toString("hex").includes(a.token));
});
test("deployment origins are exact HTTPS or loopback development origins", () => {
  assert.deepEqual(
    validateOrigins(["https://client.example", "http://localhost:3000"]),
    ["https://client.example", "http://localhost:3000"],
  );
  for (const origins of [
    [],
    ["*"],
    ["https://*.example.com"],
    ["http://client.example"],
    ["https://client.example", "https://client.example"],
    ["https://client.example.evil/path"],
    ["null"],
  ])
    assert.throws(() => validateOrigins(origins), { status: 400 });
});
