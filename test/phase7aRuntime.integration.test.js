import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { assertInfraStaging } from '../src/config/infraStaging.js';

// A controlled no-secret process fixture; never read or print inherited values.
for (const key of Object.keys(process.env)) {
  if (/(^|_)(API_KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)$/.test(key)) delete process.env[key];
}
Object.assign(process.env, {
  CHATFLOW_ENVIRONMENT: 'isolated-staging', STAGING_REHEARSAL_MODE: 'infra-only',
  AGENT_WEBSITE_ENABLED: 'false', STAGING_DISABLE_LEGACY_FILE_UPLOADS: 'true',
  STAGING_DISABLE_SCRAPING: 'true', STAGING_DISABLE_PROVIDERS: 'true',
  ACCOUNT_AUTH_ENABLED: 'false', ACCOUNT_PROXY_MODE: 'direct',
  STAGING_MAX_CONNECTIONS: '8', STAGING_MAX_ACTIVE_REQUESTS: '4', STAGING_REQUEST_TIMEOUT_MS: '5000',
});
assertInfraStaging();

let databaseQueries = 0, scraped = 0;
mock.module('../src/db/pool.js', { defaultExport: { query: async () => { databaseQueries++; return { rows: [] }; } } });
mock.module('../src/services/redis.js', { namedExports: { redisClient: { ping: async () => 'PONG' } } });
mock.module('../src/services/firecrawlService.js', { namedExports: {
  scrapeWebsite: async () => { scraped++; }, cleanAndChunkContent: () => [], shouldEmbedChunk: () => false,
} });
mock.module('../src/db/vectorStore.js', { namedExports: { upsertChunks: async () => { throw Error('not reached'); } } });
mock.module('../src/agents/industryDetector.js', { namedExports: { detectIndustry: async () => { throw Error('not reached'); } } });
mock.module('../src/agents/contentValidator.js', { namedExports: { validateWebsiteContent: async () => { throw Error('not reached'); } } });
mock.module('../src/agents/contentGenerator.js', { namedExports: { generateChatbotContent: async () => { throw Error('not reached'); } } });
mock.module('../src/agents/agentSelector.js', { namedExports: { suggestAgents: () => [] } });

const [{ default: app }, { markApplicationReady }, { addScrapeJob, processScrapeJob, startScrapeWorker }] = await Promise.all([
  import('../src/infraStagingApp.js'), import('../src/services/readiness.js'), import('../src/jobs/scrapeWorker.js'),
]);

test('actual private Express listener exposes only health/readiness and refuses spoofed forwarding', async t => {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  markApplicationReady(true);
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/api/upsert', '/api/upsert/', '/api/scrape/supplement/file', '/api/scrape/start',
    '/api/v1/agents', '/api/agent-chat', '/api/chat', '/api/account/sign-in', '/health']) {
    const response = await fetch(base + path, { method: 'POST', headers: { Authorization: 'Bearer forged' } });
    assert.equal(response.status, 404, path);
  }
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await fetch(base + '/readyz')).status, 200);
  for (const header of ['X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Real-IP', 'Forwarded']) {
    assert.equal((await fetch(base + '/healthz', { headers: { [header]: 'spoofed' } })).status, 400, header);
  }
  assert.equal((await fetch(base + '/healthz', { method: 'POST', body: 'x' })).status, 413);
  assert.equal(databaseQueries, 1);
});

test('forged queued scrape payload and admission fail before database or provider access', async () => {
  const before = databaseQueries;
  await assert.rejects(addScrapeJob('victim', 'http://169.254.169.254/latest/meta-data'));
  await assert.rejects(processScrapeJob({ id: 'forged', business_id: 'victim', url: 'https://example.test' }));
  assert.throws(startScrapeWorker);
  assert.equal(databaseQueries, before);
  assert.equal(scraped, 0);
});

test('direct worker and migration invocations fail before creating a worker or writing schema', async () => {
  const before = databaseQueries;
  await assert.rejects(import('../src/workers/fileWorker.js'), /disabled in infrastructure-only staging/);
  const { validateMigrationTarget } = await import('../scripts/apply-staging-migrations.js');
  assert.throws(() => validateMigrationTarget({
    CHATFLOW_ENVIRONMENT: 'isolated-staging', STAGING_REHEARSAL_MODE: 'infra-only',
    STAGING_MIGRATION_CONFIRM: 'I_CONFIRM_EMPTY_STAGING_DATABASE',
    STAGING_DATABASE_URL: 'postgres://test@staging-db.example/chatflow_staging',
    DATABASE_URL: 'postgres://test@staging-db.example/chatflow_staging',
  }), /forbidden/);
  assert.equal(databaseQueries, before);
});
