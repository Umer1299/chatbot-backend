import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
let processor, statuses, writes, duplicate, fail;
mock.module('bullmq', { namedExports: { Worker: class {
  constructor(queue, fn) { processor = fn; } on() {}
} } });
mock.module('../src/queues/connection.js', { namedExports: { connection: {} } });
mock.module('fs/promises', { defaultExport: { readFile: async () => Buffer.from('example'), unlink: async () => {} } });
mock.module('../src/services/fileLoader.js', { namedExports: { loadFile: async () => { if (fail) throw Error('parse error'); return [{ pageContent: 'example' }]; } } });
mock.module('../src/services/recordManager.js', { namedExports: { isDuplicateContent: async () => duplicate } });
mock.module('../src/db/vectorStore.js', { namedExports: { upsertSupplementalChunks: async () => { writes++; return { inserted: 1 }; } } });
mock.module('../src/services/firecrawlService.js', { namedExports: { cleanAndChunkContent: () => ['chunk'], shouldEmbedChunk: () => true } });
mock.module('../src/db/pool.js', { defaultExport: { query: async () => ({ rows: [{ id: 'business-a' }] }) } });
mock.module('../src/services/redis.js', { namedExports: { redisClient: { setex: async (key, ttl, value) => statuses.push(JSON.parse(value)) } } });
await import('../src/workers/fileWorker.js');
const job = () => ({ data: { jobId: 'job', namespace: 'bot-a', businessId: 'business-a', filePath: '/unused', originalName: 'test.txt' }, updateProgress: async () => {} });
beforeEach(() => { statuses = []; writes = 0; duplicate = false; fail = false; });
test('completed file jobs keep owner metadata and JSON status format used by polling', async () => {
  await processor(job()); assert.equal(writes, 1);
  assert.deepEqual(statuses.at(-1), { status: 'completed', chunksAdded: 1, namespace: 'bot-a', businessId: 'business-a' });
});
test('duplicate and failed jobs retain owner metadata for authorized polling', async () => {
  duplicate = true; await processor(job()); assert.equal(statuses.at(-1).namespace, 'bot-a');
  duplicate = false; fail = true; await assert.rejects(processor(job()));
  assert.equal(statuses.at(-1).namespace, 'bot-a'); assert.equal(statuses.at(-1).status, 'failed');
});
test('queued ownership cannot be rebound to a different business', async () => {
  const forged = job(); forged.data.businessId = 'business-b';
  await assert.rejects(processor(forged), /Invalid job business scope/); assert.equal(writes, 0);
});
