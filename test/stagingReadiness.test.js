import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runStagingReadiness,
  summarizeReadiness,
} from '../scripts/staging-readiness.js';
import { createReadinessHandler, markApplicationReady } from '../src/services/readiness.js';

const secret = 'super-secret-staging-password-0123456789';
const env = () => ({
  NODE_ENV: 'production',
  CHATFLOW_ENVIRONMENT: 'isolated-staging',
  STAGING_READINESS_CONFIRM: 'I_CONFIRM_NON_PRODUCTION_STAGING',
  STAGING_DATABASE_URL: `postgres://staging:${secret}@db.internal:5432/chatflow_staging`,
  DATABASE_URL: `postgres://staging:${secret}@db.internal:5432/chatflow_staging`,
  STAGING_REDIS_URL: 'redis://redis.internal:6379',
  REDIS_URL: 'redis://redis.internal:6379',
  ACCOUNT_AUTH_ENABLED: 'true',
  ACCOUNT_AUTH_URL: 'https://api.staging.example.test',
  ACCOUNT_TRUSTED_ORIGINS: 'https://api.staging.example.test',
  ACCOUNT_AUTH_SECRET: 'auth-secret-with-more-than-32-characters-long',
  ACCOUNT_PROXY_MODE: 'trusted',
  TRUSTED_PROXY_CIDRS: '10.1.0.0/16',
  DASHBOARD_ALLOWED_ORIGINS: 'https://dashboard.staging.example.test',
  WIDGET_ALLOWED_ORIGINS: 'https://widget.staging.example.test',
  RESEND_API_KEY: 'test-resend-key',
  RESEND_FROM_EMAIL: 'Chatflow <test@example.test>',
  OPENAI_API_KEY: 'test-openai-key',
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  JWT_SECRET: 'legacy-jwt-staging-secret-with-32-chars',
  AGENT_WEBSITE_ENABLED: 'false',
  STAGING_BASE_URL: 'https://api.staging.example.test',
});

function fakePostgres() {
  const versions = ['008', '009', '010', '011', '012', '013'];
  const triggers = [
    'knowledge_revision_insert', 'knowledge_revision_update',
    'knowledge_revision_delete', 'agent_knowledge_revision_insert',
    'agent_knowledge_revision_update', 'agent_knowledge_revision_delete',
  ];
  return {
    async query(sql) {
      if (sql.includes('current_database')) return { rowCount: 1, rows: [{ name: 'chatflow_staging', server_version: '16.0' }] };
      if (sql.includes('pg_extension')) return { rowCount: 1, rows: [{ extversion: '0.7.4' }] };
      if (sql.includes('to_regclass')) return { rowCount: 0, rows: [] };
      if (sql.includes('chatflow_schema_migrations')) return { rowCount: versions.length, rows: versions.map(version => ({ version })) };
      if (sql.includes('pg_trigger')) return { rowCount: triggers.length, rows: triggers.map(tgname => ({ tgname })) };
      throw new Error('Unexpected query in mock');
    },
    async end() {},
  };
}

function fakeRedis(policy = 'noeviction') {
  return {
    async ping() { return 'PONG'; },
    async info(section) { return section === 'server' ? '# Server\nredis_version:7.2.4\n' : `# Memory\nmaxmemory_policy:${policy}\n`; },
    async quit() {},
  };
}

const httpOk = async () => ({ status: 200 });

test('staging readiness blocks unsafe or unconfirmed targets before opening services', async () => {
  let postgresCalls = 0;
  let redisCalls = 0;
  const target = env();
  target.STAGING_READINESS_CONFIRM = '';
  const results = await runStagingReadiness({
    env: target,
    nodeVersion: 'v24.21.0',
    postgresConnector: async () => { postgresCalls++; throw new Error('must not connect'); },
    redisConnector: async () => { redisCalls++; throw new Error('must not connect'); },
    httpRequest: httpOk,
  });
  assert.equal(postgresCalls, 0);
  assert.equal(redisCalls, 0);
  assert.ok(results.some(r => r.name === 'Non-production target guard' && r.status === 'BLOCKED'));
  assert.ok(results.some(r => r.name === 'PostgreSQL connectivity/schema' && r.status === 'NOT RUN'));
  assert.equal(JSON.stringify(results).includes(secret), false);
});

test('staging readiness checks Node, PostgreSQL migrations/vector/triggers, Redis policy and HTTP health read-only', async () => {
  let requested = 0;
  const results = await runStagingReadiness({
    env: env(),
    nodeVersion: 'v24.21.0',
    postgresConnector: async () => fakePostgres(),
    redisConnector: async () => fakeRedis(),
    httpRequest: async (url) => { requested++; assert.equal(url.protocol, 'https:'); return { status: 200 }; },
  });
  assert.equal(requested, 2);
  assert.equal(summarizeReadiness(results).ready, true);
  assert.ok(results.every(r => r.status === 'PASS'));
  assert.equal(JSON.stringify(results).includes(secret), false);
});

test('staging readiness reports incompatible Node, open feature flag and Redis eviction policy', async () => {
  const target = env();
  target.AGENT_WEBSITE_ENABLED = 'true';
  const results = await runStagingReadiness({
    env: target,
    nodeVersion: 'v20.0.0',
    postgresConnector: async () => fakePostgres(),
    redisConnector: async () => fakeRedis('allkeys-lru'),
    httpRequest: httpOk,
  });
  assert.ok(results.some(r => r.name === 'Node.js runtime' && r.status === 'FAIL'));
  assert.ok(results.some(r => r.name === 'Website-agent feature gate' && r.status === 'BLOCKED'));
  assert.ok(results.some(r => r.name === 'Redis eviction policy' && r.status === 'FAIL'));
  assert.equal(summarizeReadiness(results).ready, false);
});

test('staging readiness accepts Redis-protocol version 7 and rejects incompatible versions', async () => {
  const results = await runStagingReadiness({
    env: env(),
    nodeVersion: 'v24.21.0',
    postgresConnector: async () => fakePostgres(),
    redisConnector: async () => ({
      ...fakeRedis(),
      async info(section) { return section === 'server' ? '# Server\nvalkey_version:8.0.1\n' : '# Memory\nmaxmemory_policy:noeviction\n'; },
    }),
    httpRequest: httpOk,
  });
  assert.ok(results.some(r => r.name === 'Redis protocol service version' && r.status === 'FAIL'));
  assert.equal(summarizeReadiness(results).ready, false);
});

test('staging readiness requires separate legacy JWT and explicit widget origins', async () => {
  const target = env();
  target.JWT_SECRET = 'short';
  target.WIDGET_ALLOWED_ORIGINS = 'https://*.staging.example.test';
  const results = await runStagingReadiness({
    env: target,
    nodeVersion: 'v24.21.0',
    postgresConnector: async () => fakePostgres(),
    redisConnector: async () => fakeRedis(),
    httpRequest: httpOk,
  });
  assert.ok(results.some(r => r.name === 'Legacy JWT secret' && r.status === 'BLOCKED'));
  assert.ok(results.some(r => r.name === 'Legacy widget HTTPS origins' && r.status === 'BLOCKED'));
});

test('readiness endpoint stays unavailable until startup completes and live dependencies answer', async () => {
  const response = () => ({
    code: 200,
    body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  });
  markApplicationReady(false);
  const starting = response();
  let dbChecks = 0;
  let redisChecks = 0;
  const handler = createReadinessHandler({
    async checkDatabase() { dbChecks++; },
    async checkRedis() { redisChecks++; },
  });
  await handler({}, starting);
  assert.equal(starting.code, 503);
  assert.deepEqual(starting.body, { status: 'starting' });
  assert.equal(dbChecks, 0);
  assert.equal(redisChecks, 0);
  markApplicationReady(true);
  const ready = response();
  await handler({}, ready);
  assert.equal(ready.code, 200);
  assert.deepEqual(ready.body, { status: 'ready' });
  const unavailable = response();
  await createReadinessHandler({
    async checkDatabase() { throw new Error('secret-like database detail'); },
    async checkRedis() {},
  })({}, unavailable);
  assert.equal(unavailable.code, 503);
  assert.deepEqual(unavailable.body, { status: 'dependencies_unavailable' });
  assert.equal(JSON.stringify(unavailable.body).includes('secret-like'), false);
  markApplicationReady(false);
});
