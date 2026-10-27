import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertApprovedStagingSource } from '../src/config/approvedStagingSource.js';
import { createSourceAttestation, assertDigitalOceanSpec } from '../scripts/attest-digitalocean-source.js';
import { stagingDatabaseSsl } from '../src/db/stagingTls.js';
import { assertStagingRedisUrl } from '../src/config/stagingRedis.js';
import { infraStagingGate, isInfraStaging, assertInfraStaging } from '../src/config/infraStaging.js';

const sha = 'a'.repeat(40);
const branch = 'security/phase-7b1-digitalocean-private-preflight';
const dbHost = 'preflight-db-123.db.ondigitalocean.com';
const redisHost = 'preflight-valkey-123.db.ondigitalocean.com';
const database = `postgres://staging_api:dummy@${dbHost}:25060/chatflow_staging`;
const redis = `rediss://:dummy@${redisHost}:25061/`;
const env = {
  CHATFLOW_ENVIRONMENT: 'isolated-staging', STAGING_REHEARSAL_MODE: 'infra-only',
  AGENT_WEBSITE_ENABLED: 'false', STAGING_DISABLE_LEGACY_FILE_UPLOADS: 'true',
  STAGING_DISABLE_SCRAPING: 'true', STAGING_DISABLE_PROVIDERS: 'true',
  ACCOUNT_AUTH_ENABLED: 'false', ACCOUNT_PROXY_MODE: 'direct',
  STAGING_MAX_CONNECTIONS: '8', STAGING_MAX_ACTIVE_REQUESTS: '4', STAGING_REQUEST_TIMEOUT_MS: '5000',
  STAGING_ALLOWED_HOST: 'preflight.internal:8080', STAGING_REDIS_HOST: redisHost,
  STAGING_DEPLOYMENT_PLATFORM: 'digitalocean', STAGING_SOURCE_BRANCH: branch,
  STAGING_APPROVED_COMMIT_SHA: sha, DO_DEPLOYED_COMMIT_SHA: sha,
  STAGING_DATABASE_HOST: dbHost, STAGING_DATABASE_CA_PEM: '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----',
  REDIS_URL: redis, STAGING_REDIS_URL: redis,
};
const spec = await fs.readFile(new URL('../digitalocean.staging.yaml', import.meta.url), 'utf8');

test('review-only DO spec has no public ingress, jobs, worker or automatic migrations', () => {
  assert.equal(assertDigitalOceanSpec(spec), true);
  assert.match(spec, /value: \$\{_self\.COMMIT_HASH\}/);
  assert.doesNotMatch(spec.split('\n').filter(line => !/^\s*#/.test(line)).join('\n'),
    /predeploy|migrat|OPENAI_API_KEY|FIRECRAWL_API_KEY/i);
  for (const changed of [spec.replace('internal_ports: [8080]', 'http_port: 8080'),
    `${spec}\ningress:\n  rules: []\n`, spec.replace('deploy_on_push: false', 'deploy_on_push: true'),
    spec.replace(`branch: ${branch}`, 'branch: main'), spec.replace('region: lon', 'region: nyc'),
    spec.replace('run_command: node scripts/start-infra-staging.js',
      'run_command: node scripts/start-infra-staging.js\n    run_command: node src/server.js'),
    spec.replace(`branch: ${branch}`, `branch: ${branch}\n      branch: main`),
    `${spec}\nstatic_sites:\n  - name: public-site\n`,
    `${spec}\nservices:\n  - name: other\n`,
    spec.replace('value: ${_self.COMMIT_HASH}', 'value: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    spec.replace('value: "false"', 'value: "true"')])
    assert.throws(() => assertDigitalOceanSpec(changed));
});

test('build attestation binds git revision, provider identity, approval and spec branch', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatflow-do-attest-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'attestation.json');
  const attest = createSourceAttestation({ env, sourceCommit: sha, spec });
  await fs.writeFile(file, JSON.stringify(attest));
  assert.equal(assertApprovedStagingSource(env, file), sha);
  for (const patch of [
    { STAGING_APPROVED_COMMIT_SHA: undefined }, { STAGING_APPROVED_COMMIT_SHA: 'b'.repeat(40) },
    { DO_DEPLOYED_COMMIT_SHA: undefined }, { DO_DEPLOYED_COMMIT_SHA: 'b'.repeat(40) },
    { DO_DEPLOYED_COMMIT_SHA: '${_self.COMMIT_HASH}' },
    { STAGING_SOURCE_BRANCH: 'main' }, { STAGING_DEPLOYMENT_PLATFORM: 'unknown' },
  ]) assert.throws(() => assertApprovedStagingSource({ ...env, ...patch }, file));
  for (const patch of [{ DO_DEPLOYED_COMMIT_SHA: undefined }, { DO_DEPLOYED_COMMIT_SHA: 'b'.repeat(40) },
    { STAGING_SOURCE_BRANCH: 'main' }, { STAGING_APPROVED_COMMIT_SHA: undefined },
    { AGENT_WEBSITE_ENABLED: 'true' }])
    assert.throws(() => createSourceAttestation({ env: { ...env, ...patch }, sourceCommit: sha, spec }));
  assert.throws(() => createSourceAttestation({ env, sourceCommit: 'b'.repeat(40), spec }));
  assert.throws(() => assertApprovedStagingSource(env, path.join(directory, 'missing.json')));
  await fs.writeFile(file, JSON.stringify({ ...attest, sourceCommit: 'b'.repeat(40) }));
  assert.throws(() => assertApprovedStagingSource(env, file));
  await fs.writeFile(file, '{');
  assert.throws(() => assertApprovedStagingSource(env, file));
});

test('DO PostgreSQL requires exact staging hostname, credentials, CA and immutable TLS policy', () => {
  assert.deepEqual(stagingDatabaseSsl(database, env), {
    ca: env.STAGING_DATABASE_CA_PEM, servername: dbHost, rejectUnauthorized: true,
  });
  for (const [url, patch] of [
    [database, { STAGING_DATABASE_CA_PEM: undefined }],
    [database, { STAGING_DATABASE_HOST: 'production-db.db.ondigitalocean.com' }],
    [database.replace('preflight-db-123', 'production-db'), {}],
    [database.replace('chatflow_staging', 'production'), {}],
    [`postgres://staging_api@${dbHost}/chatflow_staging`, {}],
    [`postgres://staging_api:dummy@${dbHost}/chatflow_staging?sslmode=disable`, {}],
    [`postgres://staging_api:dummy@${dbHost}/chatflow_staging?sslrootcert=system`, {}],
    [`postgres://staging_api:dummy@${dbHost}/chatflow_staging?host=localhost`, {}],
    [`postgres://staging_api:dummy@${dbHost}/chatflow_staging?port=5432`, {}],
    [`postgres://staging_api:dummy@${dbHost}/chatflow_staging?user=doadmin`, {}],
    ['postgres://staging_api:dummy@127.0.0.1/chatflow_staging', {}],
    ['postgres://%not-a-url', {}],
  ]) assert.throws(() => stagingDatabaseSsl(url, { ...env, ...patch }));
});

test('DO Valkey requires TLS, password and exact staging hostname', () => {
  assert.equal(assertStagingRedisUrl(env), true);
  assert.equal(assertStagingRedisUrl({ ...env,
    REDIS_URL: `rediss://staging-user:dummy@${redisHost}:25061/`,
    STAGING_REDIS_URL: `rediss://staging-user:dummy@${redisHost}:25061/`,
    STAGING_REDIS_USERNAME: 'staging-user' }), true);
  for (const bad of [redis.replace('rediss:', 'redis:'), redis.replace(':dummy@', '@'),
    redis.replace(redisHost, 'prod-valkey.db.ondigitalocean.com'),
    redis.replace(':25061', ':6379/1'), redis + '?tls=false'])
    assert.throws(() => assertStagingRedisUrl({ ...env, REDIS_URL: bad, STAGING_REDIS_URL: bad }));
  assert.throws(() => assertStagingRedisUrl({ ...env, STAGING_REDIS_HOST: 'prod-valkey.db.ondigitalocean.com' }));
  assert.throws(() => assertStagingRedisUrl({ ...env, REDIS_URL: redis, STAGING_REDIS_URL: undefined }));
});

test('DO health probe host is exact; unknown host and forwarded headers fail closed', () => {
  const before = { ...process.env };
  Object.assign(process.env, env);
  try {
    const invoke = (host, headers = {}) => {
      let status, passed = false;
      infraStagingGate({ method: 'GET', path: '/healthz', headers: { host, ...headers }, rawHeaders: ['Host', host] },
        { status(code) { status = code; return this; }, end() {} }, () => { passed = true; });
      return { status, passed };
    };
    assert.deepEqual(invoke(env.STAGING_ALLOWED_HOST), { status: undefined, passed: true });
    assert.deepEqual(invoke('unverified-probe.internal'), { status: 400, passed: false });
    assert.deepEqual(invoke(env.STAGING_ALLOWED_HOST, { 'x-forwarded-host': 'evil.example' }), { status: 400, passed: false });
  } finally { process.env = before; }
});

test('a partial or contradictory DO platform marker cannot activate public app or worker mode', () => {
  for (const patch of [{ CHATFLOW_ENVIRONMENT: undefined, STAGING_REHEARSAL_MODE: undefined },
    { CHATFLOW_ENVIRONMENT: 'production', STAGING_REHEARSAL_MODE: undefined },
    { STAGING_DISABLE_SCRAPING: undefined }, { AGENT_WEBSITE_ENABLED: 'true' }]) {
    const candidate = { ...env, ...patch };
    assert.equal(isInfraStaging(candidate), true);
    assert.throws(() => assertInfraStaging(candidate));
  }
});
