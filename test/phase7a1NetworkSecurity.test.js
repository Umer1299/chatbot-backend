import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStagingRedisUrl, stagingRedisConnectionOptions } from '../src/config/stagingRedis.js';
import { infraStagingGate } from '../src/config/infraStaging.js';

const env = {
  CHATFLOW_ENVIRONMENT: 'isolated-staging', STAGING_REHEARSAL_MODE: 'infra-only',
  AGENT_WEBSITE_ENABLED: 'false', STAGING_DISABLE_LEGACY_FILE_UPLOADS: 'true',
  STAGING_DISABLE_SCRAPING: 'true', STAGING_DISABLE_PROVIDERS: 'true',
  ACCOUNT_AUTH_ENABLED: 'false', ACCOUNT_PROXY_MODE: 'direct',
  STAGING_MAX_CONNECTIONS: '8', STAGING_MAX_ACTIVE_REQUESTS: '4', STAGING_REQUEST_TIMEOUT_MS: '5000',
  STAGING_ALLOWED_HOST: 'preflight.internal:10000', STAGING_REDIS_HOST: 'red-preflight',
  REDIS_URL: 'rediss://staging-user:dummy@red-preflight:6379/',
  STAGING_REDIS_URL: 'rediss://staging-user:dummy@red-preflight:6379/',
};

test('Render infra-only Redis requires authenticated, pinned and verified TLS', () => {
  assert.equal(assertStagingRedisUrl(env), true);
  assert.deepEqual(stagingRedisConnectionOptions(env), {
    tls: { servername: 'red-preflight', rejectUnauthorized: true },
  });
  for (const patch of [
    { REDIS_URL: env.REDIS_URL.replace('rediss:', 'redis:'),
      STAGING_REDIS_URL: env.STAGING_REDIS_URL.replace('rediss:', 'redis:') },
    { REDIS_URL: 'redis://red-preflight:6379/' },
    { REDIS_URL: 'redis://staging-user@red-preflight:6379/' },
    { REDIS_URL: 'redis://staging-user:dummy@red-production:6379/', STAGING_REDIS_URL: 'redis://staging-user:dummy@red-production:6379/' },
    { STAGING_REDIS_URL: undefined }, { STAGING_REDIS_HOST: undefined },
    { REDIS_URL: 'http://staging-user:dummy@red-preflight:6379/', STAGING_REDIS_URL: 'http://staging-user:dummy@red-preflight:6379/' },
    { REDIS_URL: 'redis://staging-user:dummy@red-preflight:6379/1', STAGING_REDIS_URL: 'redis://staging-user:dummy@red-preflight:6379/1' },
  ]) assert.throws(() => assertStagingRedisUrl({ ...env, ...patch }));
  assert.throws(() => stagingRedisConnectionOptions({ ...env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }));
});

test('only a single exact Host reaches the health handler', () => {
  const original = { ...process.env };
  Object.assign(process.env, env);
  try {
    for (const rawHeaders of [[], ['Host', 'evil.internal'], ['Host', env.STAGING_ALLOWED_HOST, 'Host', env.STAGING_ALLOWED_HOST]]) {
      let code;
      infraStagingGate({ method: 'GET', path: '/healthz', headers: { host: rawHeaders[1] }, rawHeaders },
        { status(n) { code = n; return this; }, end() {} }, () => assert.fail('unexpected health access'));
      assert.equal(code, 400);
    }
    let reached = false;
    infraStagingGate({ method: 'HEAD', path: '/readyz', headers: { host: env.STAGING_ALLOWED_HOST }, rawHeaders: ['Host', env.STAGING_ALLOWED_HOST] }, {}, () => { reached = true; });
    assert.equal(reached, true);
  } finally { process.env = original; }
});
