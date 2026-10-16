import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { MemoryStore } from 'express-rate-limit';

const prefixes = [];
mock.module('rate-limit-redis', { defaultExport: class extends MemoryStore {
  constructor(options) { super(); prefixes.push(options.prefix); }
} });
mock.module('dotenv', { defaultExport: { config() {} } });
mock.module('../src/services/redis.js', { namedExports: { redisClient: {
  get: async key => key.startsWith('chatbot_token:valid-widget') ? 'public-bot' : null,
} } });
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
mock.module('../src/db/pool.js', { defaultExport: { query: async (sql, [id]) => ({ rows: [A,B].includes(id)
  ? [{ id, bubble_user_id: id, bot_id: id, industry: 'other', plan: 'free', active: true }] : [] }) } });
for (const file of ['registerSaasSoftware', 'registerUniversalContactRouter']) mock.module(`../src/agents/${file}.js`, { namedExports: {} });
for (const file of ['routes/chat', 'routes/upsert', 'routes/chatbots', 'routes/moderate', 'routes/lead', 'api/auth', 'api/billing', 'api/leads', 'api/inquiries', 'api/businessPublic', 'api/quickAnswers']) {
  const router = express.Router(); router.use((req, res) => res.json({ success: true }));
  mock.module(`../src/${file}.js`, { defaultExport: router });
}
// api/scrape imports workers; stub it too, keeping real authentication and limiters.
mock.module('../src/api/scrape.js', { defaultExport: (req, res) => res.json({ success: true }) });
process.env.JWT_SECRET = 'test-only-quota-secret';
const { JWT_OPTIONS } = await import('../src/middleware/jwtAuth.js');
const { ipQuotaKey } = await import('../src/middleware/rateLimiter.js');
const sign = (id, age = 0) => `Bearer ${jwt.sign({ businessId: id, bubbleUserId: id, iat: Math.floor(Date.now()/1000)-age }, process.env.JWT_SECRET, { ...JWT_OPTIONS, subject: id })}`;
const app = (await import('../src/app.js')).default;
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
after(() => new Promise(resolve => server.close(resolve)));
const base = `http://127.0.0.1:${server.address().port}`;
async function status(path, authorization = 'spoofed', widget = 'valid-widget', extra = {}) {
  const response = await fetch(base + path, { headers: { authorization, 'x-chatbot-token': widget, ...extra } });
  await response.text(); return response.status;
}
test('management quota uses verified business identity, survives token rotation and isolates shared-IP owners', async () => {
  const token = sign(A);
  for (let n = 0; n < 120; n++) assert.equal(await status('/api/upsert/job/own', token), 200);
  assert.equal(await status('/api/upsert/job/own', token), 429);
  assert.equal(await status('/api/upsert/job/own', sign(A, 5), 'different-widget'), 429);
  assert.equal(await status('/api/leads', sign(A, 10)), 429); // Same management quota across paths.
  assert.equal(await status('/api/upsert/job/own', sign(B)), 200);
});
test('arbitrary/unsigned Authorization headers never obtain an authenticated management quota', async () => {
  for (const header of ['Bearer made-up-a', 'Bearer made-up-b', 'Basic random', '']) {
    assert.equal(await status('/api/upsert/job/own', header), 401);
  }
});
test('public authentication quota is IP-based and cannot be reset with Authorization or forwarded-IP headers', async () => {
  for (let n = 0; n < 120; n++) assert.equal(await status('/api/auth/token', `Bearer spoof-${n}`), 200);
  assert.equal(await status('/api/auth/token', 'Bearer another-spoof', 'other-widget', { 'x-forwarded-for': '203.0.113.5' }), 429);
  assert.equal(await status('/api/upsert/job/own', sign(B)), 200); // Separate family/quota.
});
test('public chat retains its separate verified-widget quota; arbitrary headers cannot reset it', async () => {
  for (let n = 0; n < 60; n++) assert.equal(await status('/api/chat', `arbitrary-${n}`), 200);
  assert.equal(await status('/api/chat', 'different-authorization'), 429);
  assert.equal(await status('/api/chat', 'different-authorization', 'forged-widget'), 403);
  assert.equal(await status('/api/upsert/job/own', sign(B)), 200);
});
test('public preview stays public while settings and management endpoints require verified authentication', async () => {
  assert.equal(await status('/api/business/bot-config/bot/preview'), 200);
  assert.equal(await status('/api/business/settings'), 401);
});
test('IP keys normalize IPv6 subnets and stores have separate prefixes', () => {
  assert.equal(ipQuotaKey({ ip: '2001:db8:1234:5600::1' }), ipQuotaKey({ ip: '2001:db8:1234:56ff::2' }));
  assert.notEqual(ipQuotaKey({ ip: '2001:db8:1234:5600::1' }), ipQuotaKey({ ip: '2001:db8:1234:5700::1' }));
  assert.equal(new Set(prefixes).size, prefixes.length);
});
