import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
let calls, ingestFailure, result, analysis;
mock.module('../src/db/pool.js', {
  defaultExport: {
    query: async (sql, args) => {
      calls.push({ sql, args });
      return { rows: [{ id: 'queued' }] };
    },
  },
});
mock.module('../src/services/firecrawlService.js', {
  namedExports: {
    scrapeWebsite: async () => ({ pages: [{ content: 'valid website' }] }),
    cleanAndChunkContent: () => ['valid chunk'],
    shouldEmbedChunk: () => true,
  },
});
mock.module('../src/db/vectorStore.js', {
  namedExports: {
    upsertChunks: async () => {
      if (ingestFailure) throw Error('Database/embedding failed');
      return result;
    },
  },
});
mock.module('../src/agents/industryDetector.js', {
  namedExports: {
    detectIndustry: async () => {
      analysis++;
      throw Error('Must not analyse failed ingestion');
    },
  },
});
mock.module('../src/agents/contentValidator.js', {
  namedExports: { validateWebsiteContent: async () => ({}) },
});
mock.module('../src/agents/contentGenerator.js', {
  namedExports: { generateChatbotContent: async () => ({}) },
});
mock.module('../src/agents/agentSelector.js', {
  namedExports: { suggestAgents: () => [] },
});
const { refreshScrapeJob, processScrapeJob } =
  await import('../src/jobs/scrapeWorker.js');
beforeEach(() => {
  calls = [];
  ingestFailure = false;
  result = { inserted: 1 };
  analysis = 0;
});
test('refresh queues a replacement without deleting website/owner knowledge in advance', async () => {
  assert.equal(
    await refreshScrapeJob('business-a', 'https://example.test'),
    'queued',
  );
  assert.ok(calls.every((c) => !c.sql.includes('DELETE')));
  assert.deepEqual(calls[0].args, ['business-a', 'https://example.test']);
});
test('scrape worker records ingestion failures, including bad zero-result contracts, instead of complete', async () => {
  for (const mode of ['throw', 'zero']) {
    ingestFailure = mode === 'throw';
    result = { inserted: 0 };
    calls = [];
    await processScrapeJob({
      id: 'job-a',
      business_id: 'business-a',
      url: 'https://example.test',
    });
    assert.ok(calls.some((c) => c.sql.includes("status = 'failed'")));
    assert.ok(!calls.some((c) => c.sql.includes("status = 'complete'")));
    assert.equal(analysis, 0);
  }
});
