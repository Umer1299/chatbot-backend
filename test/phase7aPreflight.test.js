import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { assertInfraStaging, assertScrapingDisabled, infraStagingGate, infraStagingConcurrency } from '../src/config/infraStaging.js';
import { assertApprovedStagingSource } from '../src/config/approvedStagingSource.js';
import { stagingDatabaseSsl } from '../src/db/stagingTls.js';

const sha = 'a'.repeat(40);
const ca = '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----';
const env = {
  CHATFLOW_ENVIRONMENT: 'isolated-staging', STAGING_REHEARSAL_MODE: 'infra-only',
  AGENT_WEBSITE_ENABLED: 'false', STAGING_DISABLE_LEGACY_FILE_UPLOADS: 'true',
  STAGING_DISABLE_SCRAPING: 'true', STAGING_DISABLE_PROVIDERS: 'true',
  ACCOUNT_AUTH_ENABLED: 'false', ACCOUNT_PROXY_MODE: 'direct',
  STAGING_MAX_CONNECTIONS: '8', STAGING_MAX_ACTIVE_REQUESTS: '4', STAGING_REQUEST_TIMEOUT_MS: '5000',
  STAGING_APPROVED_COMMIT_SHA: sha, RENDER_GIT_COMMIT: sha,
  RENDER_GIT_BRANCH: 'security/phase-7a-isolated-staging-security-preflight',
  STAGING_DATABASE_CA_PEM: ca,
};

test('infra-only config rejects missing, contradictory and credential-bearing flags', () => {
  assert.equal(assertInfraStaging(env), true);
  for (const key of Object.keys(env).filter(k => k.includes('DISABLE') || k === 'ACCOUNT_PROXY_MODE' || k === 'STAGING_MAX_CONNECTIONS')) {
    assert.throws(() => assertInfraStaging({ ...env, [key]: undefined }), key);
  }
  for (const key of ['OPENAI_API_KEY', 'FIRECRAWL_API_KEY', 'FIRECRAWL_OFFICIAL_API_KEY',
    'FIRECRAWL_SELF_HOSTED_API_KEY', 'FIRECRAWL_SELF_HOSTED_AUTHORIZATION', 'FIRECRAWL_BASIC_AUTH',
    'JWT_SECRET', 'ACCOUNT_AUTH_SECRET', 'LANGCHAIN_API_KEY', 'UNKNOWN_PROVIDER_TOKEN'])
    assert.throws(() => assertInfraStaging({ ...env, [key]: 'dummy' }), key);
  assert.throws(() => assertInfraStaging({ ...env, TRUSTED_PROXY_CIDRS: '10.0.0.0/8' }));
  assert.throws(() => assertInfraStaging({ ...env, ACCOUNT_PROXY_MODE: 'trusted', TRUSTED_PROXY_CIDRS: '10.0.0.0/8' }));
  assert.throws(() => assertScrapingDisabled(env));
  assert.throws(() => stagingDatabaseSsl('postgres://staging-db.example/chatflow_staging',
    { ...env, CHATFLOW_ENVIRONMENT: 'misspelled', NODE_ENV: 'production' }));
});

test('source lock rejects missing, moving or wrong deployment commit and branch', () => {
  assert.equal(assertApprovedStagingSource(env), sha);
  for (const patch of [{ RENDER_GIT_COMMIT: undefined }, { RENDER_GIT_COMMIT: 'b'.repeat(40) },
    { STAGING_APPROVED_COMMIT_SHA: undefined }, { RENDER_GIT_BRANCH: 'main' }])
    assert.throws(() => assertApprovedStagingSource({ ...env, ...patch }));
});

test('staging TLS rejects missing CA, IP/plaintext URL, overrides and mismatched host', () => {
  const url = 'postgres://user:password@staging-db.example/chatflow_staging';
  assert.deepEqual(stagingDatabaseSsl(url, env), { ca, servername: 'staging-db.example', rejectUnauthorized: true });
  for (const [badUrl, patch] of [
    [url, { STAGING_DATABASE_CA_PEM: undefined }],
    [url, { STAGING_DATABASE_CA_PEM: 'invalid' }],
    [url, { STAGING_DATABASE_TLS_SERVERNAME: 'wrong.example' }],
    ['postgres://user@127.0.0.1/chatflow_staging', {}],
    ['postgres://user@staging-db.example/chatflow_staging?sslmode=disable', {}],
    ['http://staging-db.example/chatflow_staging', {}],
  ]) assert.throws(() => stagingDatabaseSsl(badUrl, { ...env, ...patch }));
});

test('TLS transport verifies trusted certificate and hostname against controlled fixture', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatflow-preflight-tls-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const keyPath = path.join(directory, 'key.pem');
  const certPath = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', keyPath, '-out', certPath, '-subj', '/CN=staging-db.example',
    '-addext', 'subjectAltName=DNS:staging-db.example'], { stdio: 'ignore' });
  const [key, cert] = await Promise.all([fs.readFile(keyPath), fs.readFile(certPath)]);
  const server = tls.createServer({ key, cert }, socket => socket.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const probe = ssl => new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port: server.address().port, ...ssl }, () => {
      const authorized = socket.authorized;
      socket.end();
      resolve(authorized);
    });
    socket.on('error', reject);
  });
  assert.equal(await probe(stagingDatabaseSsl('postgres://staging-db.example/chatflow_staging',
    { ...env, STAGING_DATABASE_CA_PEM: cert.toString() })), true);
  await assert.rejects(probe(stagingDatabaseSsl('postgres://staging-db.example/chatflow_staging',
    { ...env, STAGING_DATABASE_CA_PEM: ca })));
  await assert.rejects(probe(stagingDatabaseSsl('postgres://other-db.example/chatflow_staging',
    { ...env, STAGING_DATABASE_CA_PEM: cert.toString() })));
});

test('infra gate blocks canonical routes, aliases, methods, uploads and payload-bearing health checks', () => {
  const original = { ...process.env };
  Object.assign(process.env, env);
  try {
    for (const path of ['/api/upsert', '/api/upsert/', '/api/scrape/supplement/file', '/api/v1/agents',
      '/api/agent-chat', '/api/chat', '/api/account/sign-in', '/health', '/ready', '/api//upsert']) {
      let code;
      infraStagingGate({ method: 'POST', path, headers: {} }, { status(v) { code = v; return this; }, json() {} }, () => assert.fail(path));
      assert.equal(code, 404, path);
    }
    for (const path of ['/healthz', '/readyz']) {
      let reached = false;
      infraStagingGate({ method: 'GET', path, headers: {} }, {}, () => { reached = true; });
      assert.equal(reached, true);
    }
    let code;
    infraStagingGate({ method: 'GET', path: '/healthz', headers: { 'transfer-encoding': 'chunked' } },
      { status(v) { code = v; return this; }, end() {} }, () => assert.fail());
    assert.equal(code, 413);
  } finally { process.env = original; }
});

test('concurrent requests beyond explicit cap fail before routing', () => {
  const original = { ...process.env };
  Object.assign(process.env, { ...env, STAGING_MAX_ACTIVE_REQUESTS: '1' });
  try {
    let release, status;
    infraStagingConcurrency({}, { once(_event, fn) { release = fn; } }, () => {});
    infraStagingConcurrency({}, { status(v) { status = v; return this; }, end() {} }, () => assert.fail());
    assert.equal(status, 503);
    release();
    infraStagingConcurrency({}, { once() {} }, () => {});
  } finally { process.env = original; }
});

test('review-only blueprint has private API, no worker, no automatic migrations or provider keys', async () => {
  const blueprint = await fs.readFile(new URL('../render.staging.yaml', import.meta.url), 'utf8');
  const liveLines = blueprint.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  assert.match(liveLines, /type: pserv/);
  assert.match(liveLines, /autoDeployTrigger: off/);
  assert.match(liveLines, /branch: security\/phase-7a-isolated-staging-security-preflight/);
  assert.match(liveLines, /verify-infra-staging-source/);
  assert.doesNotMatch(liveLines, /type: web|type: worker|preDeployCommand|staging:migrate|OPENAI_API_KEY|FIRECRAWL_API_KEY/);
  const server = await fs.readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(server, /if \(isInfraStaging\(\)\) \{\s*await pool.query\('SELECT 1'\)/);
});
