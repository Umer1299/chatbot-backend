import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { MemoryStore } from 'express-rate-limit';

// Exercise the actual app-level limiter mount, using an isolated in-memory store
// instead of Redis. Route work is stubbed so this test measures quota boundaries.
mock.module('rate-limit-redis', { defaultExport: class extends MemoryStore { constructor() { super(); } } });
mock.module('dotenv', { defaultExport: { config() {} } });
mock.module('../src/services/redis.js', { namedExports: { redisClient: {} } });
for (const file of ['registerSaasSoftware', 'registerUniversalContactRouter']) {
  mock.module(`../src/agents/${file}.js`, { namedExports: {} });
}
for (const file of ['routes/chat', 'routes/upsert', 'routes/chatbots', 'routes/moderate', 'routes/lead', 'api/auth', 'api/billing', 'api/scrape', 'api/leads', 'api/inquiries', 'api/businessPublic', 'api/quickAnswers']) {
  const router = express.Router(); router.use((req, res) => res.json({ success: true }));
  mock.module(`../src/${file}.js`, { defaultExport: router });
}
const app = (await import('../src/app.js')).default;
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
after(() => new Promise(resolve => server.close(resolve)));
const base = `http://127.0.0.1:${server.address().port}`;
async function status(path, authorization, widget = 'public-token') {
  const response = await fetch(base + path, { headers: { authorization, 'x-chatbot-token': widget } });
  await response.text(); return response.status;
}
test('upsert uses dashboard quota and keeps owners sharing one IP independent', async () => {
  for (let n = 0; n < 120; n++) assert.equal(await status('/api/upsert/job/own', 'Bearer owner-a'), 200);
  assert.equal(await status('/api/upsert/job/own', 'Bearer owner-a'), 429);
  assert.equal(await status('/api/upsert/job/own', 'Bearer owner-a', 'different-widget'), 429);
  assert.equal(await status('/api/upsert/job/own', 'Bearer owner-b'), 200);
});
test('public chat retains its separate 60-request widget quota', async () => {
  for (let n = 0; n < 60; n++) assert.equal(await status('/api/chat', 'Bearer owner-c'), 200);
  assert.equal(await status('/api/chat', 'Bearer owner-c'), 429);
});
