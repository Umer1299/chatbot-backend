import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import Redis from 'ioredis';
import { assertInfraStaging } from '../src/config/infraStaging.js';
import { assertStagingRedisUrl, stagingRedisConnectionOptions } from '../src/config/stagingRedis.js';
import { assertDigitalOceanSpec, assertDigitalOceanEffectiveSpec, createSourceAttestation } from '../scripts/attest-digitalocean-source.js';
import { assertApprovedStagingSource } from '../src/config/approvedStagingSource.js';

const sha = 'a'.repeat(40);
const vpcId = 'b54dfc23-a332-4fc2-8d2f-01c038c70c2e';
const host = 'preflight-valkey-123.db.ondigitalocean.com';
const redisUrl = `rediss://:dummy@${host}:25061/`;
const env = {
  CHATFLOW_ENVIRONMENT: 'isolated-staging', STAGING_REHEARSAL_MODE: 'infra-only',
  STAGING_DEPLOYMENT_PLATFORM: 'digitalocean',
  STAGING_SOURCE_BRANCH: 'security/phase-7b1-valkey-vpc-security-repair',
  AGENT_WEBSITE_ENABLED: 'false', STAGING_DISABLE_LEGACY_FILE_UPLOADS: 'true',
  STAGING_DISABLE_SCRAPING: 'true', STAGING_DISABLE_PROVIDERS: 'true',
  ACCOUNT_AUTH_ENABLED: 'false', ACCOUNT_PROXY_MODE: 'direct',
  STAGING_MAX_CONNECTIONS: '8', STAGING_MAX_ACTIVE_REQUESTS: '4', STAGING_REQUEST_TIMEOUT_MS: '5000',
  STAGING_ALLOWED_HOST: 'preflight.internal:8080', STAGING_REDIS_HOST: host,
  STAGING_APPROVED_COMMIT_SHA: sha, DO_DEPLOYED_COMMIT_SHA: sha,
  STAGING_APPROVED_VPC_ID: vpcId, REDIS_URL: redisUrl, STAGING_REDIS_URL: redisUrl,
};
const template = await fs.readFile(new URL('../digitalocean.staging.yaml', import.meta.url), 'utf8');

function effectiveSpec() {
  const parsed = yaml.load(template);
  parsed.vpc.id = vpcId;
  parsed.services[0].envs.find(entry => entry.key === 'STAGING_APPROVED_VPC_ID').value = vpcId;
  parsed.services[0].envs.find(entry => entry.key === 'STAGING_APPROVED_COMMIT_SHA').value = sha;
  const extra = ['STAGING_ALLOWED_HOST', 'STAGING_REDIS_HOST', 'STAGING_DATABASE_HOST',
    'DATABASE_URL', 'STAGING_DATABASE_URL', 'STAGING_DATABASE_CA_PEM', 'REDIS_URL', 'STAGING_REDIS_URL'];
  for (const key of extra) parsed.services[0].envs.push({ key, value: 'provided-by-owner',
    type: key.endsWith('_URL') || key.endsWith('_PEM') ? 'SECRET' : 'GENERAL', scope: 'RUN_TIME' });
  return parsed;
}

test('unsafe process-wide TLS settings fail before any Valkey client construction', () => {
  assert.deepEqual(stagingRedisConnectionOptions(env),
    { tls: { servername: host, rejectUnauthorized: true } });
  for (const setting of ['0', '', 'false', '2']) {
    const unsafe = { ...env, NODE_TLS_REJECT_UNAUTHORIZED: setting };
    assert.throws(() => assertInfraStaging(unsafe), /TLS certificate verification/);
    assert.throws(() => assertStagingRedisUrl(unsafe), /TLS certificate verification/);
    let constructed = false;
    assert.throws(() => {
      const options = stagingRedisConnectionOptions(unsafe);
      constructed = true;
      return new Redis(unsafe.REDIS_URL, { lazyConnect: true, ...options });
    }, /TLS certificate verification/);
    assert.equal(constructed, false);
  }
  assert.deepEqual(stagingRedisConnectionOptions({ ...env, NODE_TLS_REJECT_UNAUTHORIZED: '1' }),
    { tls: { servername: host, rejectUnauthorized: true } });
  for (const bad of [redisUrl.replace('rediss:', 'redis:'), redisUrl.replace(':dummy@', '@'),
    redisUrl.replace(host, 'production-valkey.db.ondigitalocean.com'), redisUrl + '?tls=false']) {
    assert.throws(() => stagingRedisConnectionOptions({ ...env, REDIS_URL: bad, STAGING_REDIS_URL: bad }));
  }
  assert.throws(() => stagingRedisConnectionOptions(env, 'rediss://:dummy@other.invalid:25061/'));
});

test('actual ioredis TLS handshake verifies trust and exact hostname even if process TLS default is unsafe', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatflow-valkey-tls-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  async function certificate(name, prefix) {
    const key = path.join(directory, `${prefix}-key.pem`);
    const cert = path.join(directory, `${prefix}-cert.pem`);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', key, '-out', cert, '-subj', `/CN=${name}`,
      '-addext', `subjectAltName=DNS:${name}`], { stdio: 'ignore' });
    return { key: await fs.readFile(key), cert: await fs.readFile(cert) };
  }
  const issued = await certificate(host, 'server');
  const other = await certificate('untrusted.invalid', 'other');
  const server = tls.createServer(issued, socket => {
    // The test only exercises TLS negotiation; no provider AUTH is claimed.
    socket.on('data', () => socket.write('+OK\r\n'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const baseOptions = stagingRedisConnectionOptions(env).tls;
  async function probe(tlsOptions) {
    const client = new Redis(`rediss://:dummy@localhost:${port}/`, {
      lazyConnect: true, connectTimeout: 1000, maxRetriesPerRequest: 0,
      retryStrategy: () => null, tls: tlsOptions,
    });
    client.on('error', () => {});
    try {
      const connected = new Promise(resolve => {
        client.once('connect', () => resolve(true));
        client.once('error', () => resolve(false));
      });
      client.connect().catch(() => {});
      return await Promise.race([connected, new Promise(resolve => setTimeout(() => resolve(false), 1500))]);
    } finally { client.disconnect(); }
  }
  assert.equal(await probe({ ...baseOptions, ca: issued.cert }), true, 'trusted matching certificate');
  assert.equal(await probe(baseOptions), false, 'self-signed without trusted CA');
  assert.equal(await probe({ ...baseOptions, ca: other.cert }), false, 'untrusted CA');
  assert.equal(await probe({ ...baseOptions, ca: issued.cert, servername: 'wrong.invalid' }), false, 'hostname mismatch');
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    assert.throws(() => stagingRedisConnectionOptions({ ...env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }));
    assert.equal(await probe(baseOptions), false, 'explicit verification survives unsafe process default');
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
});

test('VPC template is nondeployable; exported effective spec must match owner-approved VPC and commit', async t => {
  assert.equal(assertDigitalOceanSpec(template), true);
  assert.throws(() => assertDigitalOceanEffectiveSpec(template, { approvedVpcId: vpcId, approvedCommit: sha }));
  const effective = effectiveSpec();
  assert.equal(assertDigitalOceanEffectiveSpec(yaml.dump(effective), { approvedVpcId: vpcId, approvedCommit: sha }), true);
  for (const change of [
    spec => { delete spec.vpc; },
    spec => { spec.vpc.id = 'OWNER_VPC_ID_REQUIRED'; },
    spec => { spec.vpc.id = '1df40000-0000-4000-8000-000000000001'; },
    spec => { spec.region = 'nyc'; },
    spec => { spec.ingress = { rules: [] }; },
    spec => { spec.static_sites = [{ name: 'public-site' }]; },
    spec => { spec.services[0].http_port = 8080; },
    spec => { spec.services[0].github.deploy_on_push = true; },
    spec => { spec.services[0].envs.find(e => e.key === 'STAGING_APPROVED_VPC_ID').value = 'wrong'; },
    spec => { spec.services[0].envs.find(e => e.key === 'STAGING_APPROVED_COMMIT_SHA').value = 'b'.repeat(40); },
    spec => { spec.services[0].envs.push({ key: 'NODE_TLS_REJECT_UNAUTHORIZED', value: '0' }); },
  ]) {
    const variant = structuredClone(effective);
    change(variant);
    assert.throws(() => assertDigitalOceanEffectiveSpec(yaml.dump(variant), { approvedVpcId: vpcId, approvedCommit: sha }));
  }
  assert.throws(() => assertDigitalOceanEffectiveSpec(yaml.dump(effective),
    { approvedVpcId: 'OWNER_VPC_ID_REQUIRED', approvedCommit: sha }));
  assert.throws(() => assertDigitalOceanEffectiveSpec(yaml.dump(effective),
    { approvedVpcId: undefined, approvedCommit: sha }));
  assert.throws(() => assertDigitalOceanEffectiveSpec(`${yaml.dump(effective)}\nvpc:\n  id: ${vpcId}\n`,
    { approvedVpcId: vpcId, approvedCommit: sha }), /duplicate/);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatflow-vpc-attest-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'attestation.json');
  await fs.writeFile(file, JSON.stringify(createSourceAttestation({ env, sourceCommit: sha, spec: template })));
  assert.equal(assertApprovedStagingSource(env, file), sha);
  assert.throws(() => assertApprovedStagingSource({ ...env, STAGING_APPROVED_VPC_ID: undefined }, file));
  assert.throws(() => assertApprovedStagingSource({ ...env,
    STAGING_APPROVED_VPC_ID: '1df40000-0000-4000-8000-000000000001' }, file));
});
