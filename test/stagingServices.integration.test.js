import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import Redis from "ioredis";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.STAGING_REDIS_URL;
const confirmation = "I_CONFIRM_DISPOSABLE_TEST_DATABASE";

test(
  "isolated PostgreSQL 16/pgvector and Redis services are reachable with safe Redis eviction policy",
  { skip: !databaseUrl || !redisUrl ? "TEST_DATABASE_URL and STAGING_REDIS_URL are required" : false },
  async () => {
    assert.equal(process.env.TEST_DATABASE_CONFIRM, confirmation);
    const database = new URL(databaseUrl);
    const redisAddress = new URL(redisUrl);
    const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
    assert.ok(loopback.has(database.hostname), "PostgreSQL target must be loopback");
    assert.equal(database.pathname, "/chatflow_security_test");
    assert.equal(redisAddress.protocol, "redis:");
    assert.ok(loopback.has(redisAddress.hostname), "Redis target must be loopback");

    const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
    const redis = new Redis(redisUrl, { connectTimeout: 3000, maxRetriesPerRequest: 1, lazyConnect: true });
    try {
      await client.connect();
      const version = Number((await client.query("SHOW server_version_num")).rows[0].server_version_num);
      assert.equal(Math.floor(version / 10000), 16, "staging stack must use PostgreSQL 16");
      assert.equal((await client.query("SELECT extversion FROM pg_extension WHERE extname='vector'")).rowCount, 1);

      await redis.connect();
      assert.equal(await redis.ping(), "PONG");
      const policy = await redis.config("GET", "maxmemory-policy");
      assert.equal(policy[1], "noeviction", "BullMQ Redis must not evict queue state under memory pressure");
    } finally {
      await Promise.allSettled([client.end(), redis.quit()]);
    }
  },
);
