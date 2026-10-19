import { spawnSync } from "node:child_process";

const confirmation = "I_CONFIRM_DISPOSABLE_TEST_DATABASE";
if (process.env.TEST_DATABASE_CONFIRM !== confirmation) {
  console.error(`Refusing migration rehearsal. Set TEST_DATABASE_CONFIRM=${confirmation} only for a disposable database.`);
  process.exit(2);
}

if (process.env.CHATFLOW_ENVIRONMENT !== "isolated-staging") {
  console.error("Refusing staging test run unless CHATFLOW_ENVIRONMENT=isolated-staging.");
  process.exit(2);
}

let database, redis;
try {
  database = new URL(process.env.TEST_DATABASE_URL || "");
  redis = new URL(process.env.STAGING_REDIS_URL || "");
} catch {
  console.error("TEST_DATABASE_URL and STAGING_REDIS_URL must be valid URLs.");
  process.exit(2);
}

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
if (
  database.protocol !== "postgres:" && database.protocol !== "postgresql:" ||
  !loopback.has(database.hostname) ||
  database.pathname !== "/chatflow_security_test" ||
  redis.protocol !== "redis:" ||
  !loopback.has(redis.hostname)
) {
  console.error("Refusing unsafe target: tests require loopback PostgreSQL database chatflow_security_test and loopback Redis.");
  process.exit(2);
}

const result = spawnSync(
  process.execPath,
  [
    "--experimental-test-module-mocks",
    "--test",
    "test/account.integration.test.js",
    "test/migrations.integration.test.js",
    "test/stagingServices.integration.test.js",
  ],
  { stdio: "inherit", env: process.env },
);
process.exit(result.status ?? 1);
