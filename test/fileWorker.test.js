import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
let processor, statuses, writes, duplicate, fail, ingestError, rawResult, marked, unlinked, parsedChunks;
mock.module('bullmq', { namedExports: { Worker: class {
  constructor(queue, fn) { processor = fn; } on() {}
} } });
mock.module('../src/queues/connection.js', { namedExports: { connection: {} } });
mock.module('fs/promises', { defaultExport: { readFile: async () => Buffer.from('example'), unlink: async () => { unlinked++; } } });
mock.module('../src/services/fileLoader.js', { namedExports: { loadFile: async () => { if (fail) throw Error('parse error'); return [{ pageContent: 'example' }]; } } });
mock.module('../src/services/recordManager.js', { namedExports: { markContentProcessed: async () => { marked++; }, isDuplicateContent: async () => duplicate } });
mock.module('../src/db/vectorStore.js', { namedExports: { upsertSupplementalChunks: async () => { writes++; if (ingestError) throw ingestError; return duplicate ? {inserted:0,skipped:1,status:'skipped'} : rawResult; } } });
mock.module('../src/services/firecrawlService.js', { namedExports: { cleanAndChunkContent: () => parsedChunks, shouldEmbedChunk: () => true } });
mock.module('../src/db/pool.js', { defaultExport: { query: async () => ({ rows: [{ id: 'business-a' }] }) } });
mock.module('../src/services/redis.js', { namedExports: { redisClient: { setex: async (key, ttl, value) => statuses.push(JSON.parse(value)) } } });
await import('../src/workers/fileWorker.js');
const job = () => ({ data: { jobId: 'job', namespace: 'bot-a', businessId: 'business-a', filePath: '/unused', originalName: 'test.txt' }, updateProgress: async () => {} });
beforeEach(() => { statuses = []; writes = 0; duplicate = false; fail = false; ingestError=undefined; rawResult={inserted:1}; marked=0; unlinked=0; parsedChunks=['chunk']; });
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

test('database/embedding/partial ingestion failures reject BullMQ processing and preserve retry source bytes', async () => {
  for (const result of [{inserted:0,skipped:0,failed:1,status:'failed'}, {inserted:1,skipped:0,failed:1,status:'partial'}]) {
    ingestError=Object.assign(new Error('Ingestion failed'),{result});
    await assert.rejects(processor(job()));
    assert.equal(statuses.at(-1).status,'failed');assert.deepEqual(statuses.at(-1).ingestion,result);
  }
  assert.equal(marked,0);assert.equal(unlinked,0);
});
test('a swallowed zero or partial helper result cannot become a completed job', async () => {
  for (const result of [{inserted:0},{inserted:1,failed:1,status:'partial'}]) {
    rawResult=result;await assert.rejects(processor(job()));assert.equal(statuses.at(-1).status,'failed');
  }
  assert.equal(marked,0);
});
test('legitimate empty extraction completes as skipped; forged ownership is checked before duplicate completion', async () => {
  parsedChunks=[];rawResult={inserted:0,skipped:0,status:'empty'};
  await processor(job());assert.equal(statuses.at(-1).status,'completed');assert.equal(statuses.at(-1).skipped,true);
  duplicate=true;const forged=job();forged.data.businessId='business-b';
  await assert.rejects(processor(forged),/Invalid job business scope/);assert.equal(statuses.at(-1).status,'failed');
});
test('source files are removed on the final failed attempt instead of leaking indefinitely', async () => {
  fail=true;const final=job();final.opts={attempts:3};final.attemptsMade=2;
  await assert.rejects(processor(final));assert.equal(unlinked,1);
});
