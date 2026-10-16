import { test, mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

let policies, cache, clock, dbFailure, cacheFailure, beforeLegacyInsert;
const TOKEN_LIFETIME = 365 * 86400;
function put(key, value, seconds) { cache.set(key, { value, until: clock + seconds }); }
function cached(key) {
  const entry = cache.get(key);
  if (!entry || entry.until <= clock) { cache.delete(key); return null; }
  return entry.value;
}
mock.module('../src/db/pool.js', { defaultExport: { query: async (sql, args = []) => {
  if (dbFailure) throw new Error('PostgreSQL unavailable');
  const q = sql.replace(/\s+/g, ' ').trim();
  if (q.startsWith('INSERT INTO chatbot_settings')) {
    if (q.includes('DO NOTHING') && beforeLegacyInsert) beforeLegacyInsert();
    let row = policies.get(args[0]);
    if (q.includes('true)')) {
      row = { namespace: args[0], settings: { allowedDomains: [] }, revision: args[1], deleted: true };
    } else if (!row || !q.includes('DO NOTHING')) {
      row = { namespace: args[0], settings: JSON.parse(args[1]), revision: args[2], deleted: false };
    }
    policies.set(args[0], row); return { rows: [structuredClone(row)] };
  }
  if (q.startsWith('SELECT') && q.includes('FROM chatbot_settings')) {
    const rows = q.includes('WHERE namespace=$1') ? [policies.get(args[0])].filter(Boolean) : [...policies.values()];
    return { rows: structuredClone(q.includes('AND deleted=false') ? rows.filter(row => !row.deleted) : rows) };
  }
  if (q.startsWith('SELECT id FROM businesses')) return { rows: [] };
  throw new Error(`Unexpected SQL: ${q}`);
} } });
mock.module('../src/services/redis.js', { namedExports: { redisClient: {
  get: async key => { if (cacheFailure && !key.startsWith('chatbot_token:') && !key.startsWith('chatbot_namespace_token:')) throw new Error('Redis unavailable'); return cached(key); },
  setex: async (key, seconds, value) => { if (cacheFailure) throw new Error('Redis unavailable'); put(key, value, seconds); },
  del: async key => { if (cacheFailure) throw new Error('Redis unavailable'); cache.delete(key); },
  keys: async pattern => { if (cacheFailure) throw new Error('Redis unavailable'); return [...cache.keys()].filter(key => key.startsWith(pattern.slice(0,-1)) && cached(key)); },
} } });
mock.module('../src/db/vectorStore.js', { namedExports: { deleteBusinessChunks: async () => 0 } });
const { saveChatbotSettings, getChatbotSettings, deleteChatbotSettings } = await import('../src/services/chatbotSettings.js');
const { tokenAuth } = await import('../src/middleware/tokenAuth.js');
const { domainRestriction } = await import('../src/middleware/domainRestriction.js');
const adminRouter = (await import('../src/routes/chatbots.js')).default;
process.env.ADMIN_API_KEY = 'test-only-admin';
const app = express(); app.use(express.json());
app.get('/widget', tokenAuth, domainRestriction, (req, res) => res.json({ success: true }));
app.use('/api/chatbots', adminRouter);
app.use((error, req, res, next) => res.status(error.status || 500).json({ error: 'Unavailable' }));
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
after(() => new Promise(resolve => server.close(resolve)));
const base = `http://127.0.0.1:${server.address().port}`;
async function widget(origin = 'https://trusted.example') {
  const response = await fetch(base + '/widget', { headers: { origin, 'x-chatbot-token': 'public' } });
  await response.text(); return response.status;
}
async function admin(path = '/bot-a', method = 'GET', body) {
  const response = await fetch(base + '/api/chatbots' + path, { method, headers: { 'x-admin-key': process.env.ADMIN_API_KEY, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
beforeEach(() => {
  policies = new Map(); cache = new Map(); clock = 0; dbFailure = false; cacheFailure = false; beforeLegacyInsert = undefined;
  put('chatbot_token:public', 'bot-a', TOKEN_LIFETIME);
  put('chatbot_namespace_token:bot-a', 'public', TOKEN_LIFETIME);
});
const restricted = () => ({ model: 'existing-model', systemPrompt: 'existing prompt', allowedDomains: ['trusted.example'] });

test('restrictions survive cache/legacy expiry while the public token remains valid', async () => {
  put('chatbot:bot-a', JSON.stringify(restricted()), 30 * 86400);
  assert.equal(await widget(), 200); // Lazily promote a surviving legacy policy.
  clock += 31 * 86400;
  assert.equal(cached('chatbot:bot-a'), null);
  assert.equal(cached('chatbot_token:public'), 'bot-a');
  assert.equal(await widget('https://attacker.example'), 403);
  assert.equal(await widget(), 200);
  assert.deepEqual((await admin()).body.allowedDomains, ['trusted.example']);
});
test('expired legacy settings with no durable policy fail closed instead of allowing all', async () => {
  put('chatbot:bot-a', JSON.stringify(restricted()), 30 * 86400);
  clock += 31 * 86400;
  assert.equal(await widget('https://attacker.example'), 503);
  assert.equal(await widget(), 503); assert.equal(policies.size, 0);
  assert.equal((await admin()).status, 404);
});
test('durable admin saves preserve response contract and survive cache eviction', async () => {
  const response = await admin('/bot-a', 'POST', restricted());
  assert.equal(response.status, 200); assert.equal(response.body.success, true);
  assert.equal(response.body.namespace, 'bot-a'); assert.equal(response.body.token, 'public');
  assert.deepEqual(response.body.settings.allowedDomains, ['trusted.example']);
  for (const key of cache.keys()) if (key.startsWith('chatbot_settings:')) cache.delete(key);
  assert.equal(await widget('https://attacker.example'), 403); assert.equal(await widget(), 200);
});
test('a stale cache write cannot undo a later allowlist update', async () => {
  await saveChatbotSettings('bot-a', { allowedDomains: [] });
  const oldRevision = policies.get('bot-a').revision;
  await saveChatbotSettings('bot-a', restricted());
  put(`chatbot_settings:bot-a:${oldRevision}`, JSON.stringify({ allowedDomains: [] }), 300);
  assert.notEqual(policies.get('bot-a').revision, oldRevision);
  assert.equal(await widget('https://attacker.example'), 403);
});
test('Redis cache read/write failures fall back to the durable restriction', async () => {
  cacheFailure = true;
  await saveChatbotSettings('bot-a', restricted());
  assert.equal(await widget('https://attacker.example'), 403); assert.equal(await widget(), 200);
});
test('database failure cannot authorize from a cached policy', async () => {
  await saveChatbotSettings('bot-a', { allowedDomains: [] });
  dbFailure = true;
  assert.equal(await widget('https://attacker.example'), 500);
});
test('malformed cached settings fall back to PostgreSQL instead of an empty allowlist', async () => {
  await saveChatbotSettings('bot-a', restricted());
  const key = `chatbot_settings:bot-a:${policies.get('bot-a').revision}`;
  for (const bad of ['{', '{}', '{"allowedDomains":"*"}']) {
    put(key, bad, 300); assert.equal(await widget('https://attacker.example'), 403);
  }
});
test('missing/invalid legacy policy is never inferred as unrestricted', async () => {
  for (const bad of ['{', '{}', '{"allowedDomains":null}', '{"allowedDomains":[null]}']) {
    put('chatbot:bot-a', bad, 86400);
    assert.equal(await widget(), 503); assert.equal(policies.size, 0);
  }
});
test('explicit empty allowlist remains supported, including legacy promotion', async () => {
  put('chatbot:bot-a', JSON.stringify({ allowedDomains: [] }), 30 * 86400);
  assert.equal(await widget('https://any.example'), 200);
  assert.deepEqual(policies.get('bot-a').settings.allowedDomains, []);
});
test('legacy promotion cannot overwrite a concurrent durable admin update', async () => {
  put('chatbot:bot-a', JSON.stringify({ allowedDomains: [] }), 30 * 86400);
  beforeLegacyInsert = () => policies.set('bot-a', { namespace: 'bot-a', revision: 'concurrent', settings: restricted(), deleted: false });
  assert.equal(await widget('https://attacker.example'), 403);
});
test('policy deletion cannot be resurrected from stale legacy/cache entries', async () => {
  await saveChatbotSettings('bot-a', restricted());
  put('chatbot:bot-a', JSON.stringify({ allowedDomains: [] }), 30 * 86400);
  cacheFailure = true; await assert.rejects(deleteChatbotSettings('bot-a'));
  cacheFailure = false;
  assert.equal(await widget('https://attacker.example'), 503);
  assert.equal(policies.get('bot-a').deleted, true);
  await saveChatbotSettings('bot-a', restricted());
  assert.equal(await widget('https://attacker.example'), 403);
});
test('omitting allowedDomains on admin update preserves restrictions; new bots require explicit policy', async () => {
  assert.equal((await admin('/new-bot', 'POST', { model: 'changed' })).status, 400);
  await saveChatbotSettings('bot-a', restricted());
  assert.equal((await admin('/bot-a', 'POST', { model: 'changed' })).status, 200);
  assert.deepEqual((await getChatbotSettings('bot-a')).allowedDomains, ['trusted.example']);
  assert.equal((await admin('/bot-a', 'POST', { allowedDomains: null })).status, 400);
});
test('admin listing includes durable and surviving legacy settings without Redis being authoritative', async () => {
  put('chatbot:legacy', JSON.stringify(restricted()), 30 * 86400);
  await saveChatbotSettings('bot-a', restricted());
  const listed = await admin(''); assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.map(row => row.namespace).sort(), ['bot-a', 'legacy']);
  clock += 31 * 86400;
  assert.equal((await admin('')).body.length, 2);
});
