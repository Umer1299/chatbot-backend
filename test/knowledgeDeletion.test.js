import { test, mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

let failDelete, deletedCount, invalidations, queries;
const databaseError = new Error('PostgreSQL unavailable');
mock.module('../src/db/pool.js', { defaultExport: { query: async (sql, args) => {
  queries.push({ sql, args });
  assert.match(sql, /^DELETE FROM knowledge_chunks WHERE business_id = \$1$/);
  if (failDelete) throw databaseError;
  return { rowCount: deletedCount };
} } });
mock.module('../src/services/aiService.js', { namedExports: { getEmbedding: async () => [] } });
mock.module('../src/services/redis.js', { namedExports: { redisClient: {
  keys: async () => { invalidations++; return ['rag:business-a:cached']; }, del: async () => {},
} } });
mock.module('../src/middleware/knowledgeAuth.js', { namedExports: { requireKnowledgeOwner: (req, res, next) => {
  req.business = { businessId: 'business-a', botId: 'bot-a' }; req.namespace = 'bot-a'; next();
} } });
mock.module('../src/queues/fileQueue.js', { namedExports: { fileQueue: {} } });
mock.module('../src/services/recordManager.js', { namedExports: { markContentProcessed: async () => {}, isDuplicateContent: async () => false } });
mock.module('../src/services/firecrawlService.js', { namedExports: { cleanAndChunkContent: () => [], shouldEmbedChunk: () => true } });
const { deleteBusinessChunks } = await import('../src/db/vectorStore.js');
const app = express();
app.use('/api/upsert', (await import('../src/routes/upsert.js')).default);
app.use((error, req, res, next) => res.status(500).json({ error: 'Deletion failed' }));
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
after(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => { failDelete = false; deletedCount = 2; invalidations = 0; queries = []; });
test('knowledge helper rejects the original database error instead of reporting zero deletions', async () => {
  failDelete = true;
  await assert.rejects(deleteBusinessChunks('business-a'), error => error === databaseError);
  assert.equal(invalidations, 0);
});
test('knowledge deletion endpoint returns an error when PostgreSQL rejects deletion', async () => {
  failDelete = true;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/upsert/namespace/bot-a`, { method: 'DELETE' });
  assert.equal(response.status, 500); assert.equal((await response.json()).success, undefined);
  assert.deepEqual(queries[0].args, ['business-a']);
});
test('successful and empty knowledge deletion preserve success response without Redis scans', async () => {
  for (const count of [2, 0]) {
    deletedCount = count;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/upsert/namespace/bot-a`, { method: 'DELETE' });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { success: true });
  }
  assert.equal(invalidations, 0);
});
