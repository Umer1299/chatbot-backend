import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';

// Every external service is replaced before application modules are imported.
// No .env file, production database, Redis, queue, email or model API is used.
process.env.JWT_SECRET = 'test-only-signing-secret';
process.env.ADMIN_API_KEY = 'test-only-admin-key';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const businesses = [A, B].map((id, i) => ({ id, active: true, bubble_user_id: `user-${i}`, bot_id: `bot-${i}`, industry: 'other', plan: 'free' }));
let calls, sessions, records, jobs, effects, redisFailure;
const db = { async query(sql, args = []) {
  const q = sql.replace(/\s+/g, ' ').trim(); calls.push({ q, args });
  if (q.startsWith('SELECT') && q.includes('FROM businesses')) {
    const b = businesses.find(b => q.includes('bubble_user_id = $1') ? b.bubble_user_id === args[0] : (/bot_id\s*=\s*\$1/.test(q)) ? b.bot_id === args[0] : b.id === args[0]);
    return { rows: b ? [{ ...b }] : [] };
  }
  if (q.startsWith('INSERT INTO sessions')) {
    if (!sessions.has(args[0])) sessions.set(args[0], { id: args[0], business_id: args[1], current_phase: 1, collected_data: {} });
    return { rows: [] };
  }
  if (q.includes('FROM sessions')) {
    const s = sessions.get(args[0]);
    assert.match(q, /business_id\s*=\s*\$2/);
    return { rows: s?.business_id === args[1] ? [s] : [] };
  }
  if (q.includes('FROM bot_configs')) {
    const b = businesses.find(b => b.bot_id === args[0]);
    return { rows: b ? [{ ...b, business_id: b.id, selected_agents: [], business_name: 'Example', active: true }] : [] };
  }
  if (q.includes('FROM scrape_jobs')) {
    assert.match(q, /business_id = \$2/);
    return { rows: jobs.filter(j => j.id === args[0] && j.business_id === args[1]) };
  }
  if (q.includes('FROM messages')) {
    assert.match(q, /business_id\s*=\s*\$2/);
    return { rows: records.filter(r => r.session_id === args[0] && r.business_id === args[1]) };
  }
  if (q.startsWith('INSERT INTO messages')) { effects.messages++; assert.equal(sessions.get(args[0]).business_id, args[1]); return { rows: [] }; }
  if (q.startsWith('UPDATE sessions')) { effects.sessions++; return { rows: [] }; }
  if (q.startsWith('SELECT l.*')) return { rows: records.filter(r => r.id === args[0] && r.business_id === args[1]) };
  if (q.startsWith('SELECT * FROM inquiries')) return { rows: records.filter(r => r.id === args[0] && r.business_id === args[1]) };
  if (q.startsWith('UPDATE leads') || q.startsWith('UPDATE inquiries')) return { rows: records.filter(r => r.id === args[0] && r.business_id === args[1]) };
  if (q.includes('FROM notifications')) { assert.match(q, /business_id=\$2/); return { rows: [] }; }
  if (q.startsWith('CREATE ') || q.startsWith('ALTER ')) return { rows: [] };
  throw new Error(`Unexpected database call: ${q}`);
} };
const cache = new Map();
mock.module('../src/db/pool.js', { defaultExport: db });
mock.module('../src/services/redis.js', { namedExports: { redisClient: {
  async get(key) { if (redisFailure === true || (redisFailure === 'domain' && key.startsWith('chatbot:'))) throw new Error('Redis unavailable'); return cache.get(key) || null; },
  async setex(key, ttl, value) { cache.set(key, value); }, async del() {},
} } });
mock.module('../src/db/vectorStore.js', { namedExports: {
  getRelevantChunks: async () => [], getKnowledgeAge: async () => ({}),
  upsertChunks: async () => ({}), upsertSupplementalChunks: async () => { effects.knowledge++; return { inserted: 1 }; },
  deleteBusinessChunks: async id => { effects.deletions.push(id); return 1; },
} });
mock.module('../src/queues/fileQueue.js', { namedExports: { fileQueue: { add: async () => { effects.jobs++; } } } });
mock.module('../src/services/recordManager.js', { namedExports: { isDuplicateContent: async () => false } });
mock.module('../src/services/firecrawlService.js', { namedExports: { scrapeWebsite: async () => [], cleanAndChunkContent: () => ['example chunk'], shouldEmbedChunk: () => true } });
mock.module('../src/agents/industryDetector.js', { namedExports: { detectIndustry: async () => ({}) } });
mock.module('../src/agents/contentValidator.js', { namedExports: { validateWebsiteContent: async () => ({}), processSupplementalInfo: async () => ({}) } });
mock.module('../src/agents/contentGenerator.js', { namedExports: { generateChatbotContent: async () => ({}) } });
mock.module('../src/agents/agentSelector.js', { namedExports: { suggestAgents: () => [] } });
mock.module('../src/services/modelService.js', { namedExports: { getSafeModel: async () => { throw new Error('Model must not be called in boundary tests'); } } });
mock.module('../src/services/aiService.js', { namedExports: { getEmbedding: async () => [] } });
mock.module('../src/services/emailService.js', { namedExports: { sendLeadAlert: async () => {}, sendUrgentEscalation: async () => {} } });
mock.module('../src/services/inquiryService.js', { namedExports: {
  removeVisibleInquiryJson: text => text,
  saveInquiryFromConversation: async ({ session, config }) => { assert.equal(session.business_id, config.business_id); effects.inquiries++; return null; },
} });
mock.module('../src/tools/leadCaptureTool.js', { namedExports: { leadCaptureTool: { func: async () => { effects.webhook++; return 'ok'; } } } });
const { JWT_OPTIONS, requireAuth } = await import('../src/middleware/jwtAuth.js');
const app = express(); app.use(express.json());
app.get('/identity', requireAuth, (req, res) => res.json(req.business));
for (const [path, module] of [['auth','../src/api/auth.js'], ['leads','../src/api/leads.js'], ['inquiries','../src/api/inquiries.js'], ['upsert','../src/routes/upsert.js'], ['lead','../src/routes/lead.js'], ['quick-answers','../src/api/quickAnswers.js'], ['scrape','../src/api/scrape.js'], ['billing','../src/api/billing.js'], ['chat','../src/routes/chat.js']]) {
  app.use(`/api/${path}`, (await import(module)).default);
}
app.use((error, req, res, next) => res.status(503).json({ error: 'Service unavailable' }));
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
after(() => new Promise(resolve => server.close(resolve)));
const base = `http://127.0.0.1:${server.address().port}`;
function sign(b = businesses[0], claims = {}, options = {}) {
  return jwt.sign({ businessId: b.id, bubbleUserId: b.bubble_user_id, ...claims }, process.env.JWT_SECRET, { ...JWT_OPTIONS, subject: b.id, ...options });
}
const owner = () => ({ authorization: `Bearer ${sign()}` });
const widget = { 'x-chatbot-token': 'public-a' };
async function request(path, method = 'GET', headers = {}, body) {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
beforeEach(() => {
  calls = []; sessions = new Map(); records = []; jobs = []; effects = { messages: 0, sessions: 0, inquiries: 0, knowledge: 0, jobs: 0, webhook: 0, deletions: [] }; redisFailure = false;
  cache.clear(); cache.set('chatbot_token:public-a', 'bot-0'); cache.set('chatbot_token:public-b', 'bot-1');
  businesses.forEach(b => { b.active = true; b.plan = 'free'; });
});

test('token issuance rejects caller-supplied identity without trusted backend authentication', async () => {
  for (const headers of [{}, widget, { 'x-admin-key': 'wrong' }]) {
    assert.equal((await request('/api/auth/token', 'POST', headers, { bubbleUserId: 'user-1', email: 'victim@example.com' })).status, 401);
  }
  assert.equal(calls.length, 0);
});
test('trusted bridge issues bounded, audience/issuer/subject-scoped JWT and preserves response', async () => {
  const r = await request('/api/auth/token', 'POST', { 'x-admin-key': process.env.ADMIN_API_KEY }, { bubbleUserId: 'user-0', email: 'owner@example.com' });
  assert.equal(r.status, 200); assert.equal(r.body.businessId, A);
  const c = jwt.verify(r.body.token, process.env.JWT_SECRET, { algorithms: ['HS256'], audience: JWT_OPTIONS.audience, issuer: JWT_OPTIONS.issuer });
  assert.equal(c.exp - c.iat, 3600); assert.equal(c.sub, A);
});
test('rejects malformed, legacy nonexpiring, wrong audience/issuer/algorithm and expired JWTs', async () => {
  const tokens = ['garbage', jwt.sign({ businessId: A }, process.env.JWT_SECRET), sign(undefined, {}, { audience: 'wrong' }), sign(undefined, {}, { issuer: 'wrong' }), sign(undefined, {}, { algorithm: 'HS384' }), sign(undefined, {}, { expiresIn: -1 }), sign(undefined, { businessId: 'invalid' }), sign(undefined, { sub: undefined }, { subject: B })];
  for (const token of tokens) assert.equal((await request('/api/leads/x', 'GET', { authorization: `Bearer ${token}` })).status, 401);
  assert.equal(calls.length, 0);
});
test('rejects missing Bearer scheme, missing exp, missing/future iat, wrong subject, and identity mismatch', async () => {
  const good = jwt.decode(sign());
  const variants = [{ ...good, exp: undefined }, { ...good, iat: undefined }, { ...good, iat: Math.floor(Date.now()/1000)+120 }, { ...good, sub: B }, { ...good, bubbleUserId: 'user-1' }];
  assert.equal((await request('/api/leads/x', 'GET', { authorization: sign() })).status, 401);
  for (const c of variants) {
    const payload = Object.fromEntries(Object.entries(c).filter(([, value]) => value !== undefined));
    const token = jwt.sign(payload, process.env.JWT_SECRET, { noTimestamp: c.iat === undefined });
    assert.equal((await request('/api/leads/x', 'GET', { authorization: `Bearer ${token}` })).status, 401);
  }
});
test('inactive and deleted business accounts cannot use an otherwise valid JWT', async () => {
  const headers = owner(); businesses[0].active = false;
  assert.equal((await request('/api/leads/x', 'GET', headers)).status, 401);
  const unknown = { ...businesses[0], id: '33333333-3333-4333-8333-333333333333' };
  assert.equal((await request('/api/leads/x', 'GET', { authorization: `Bearer ${sign(unknown)}` })).status, 401);
});
test('widget token cannot read inquiries/analytics, leads or quick answers', async () => {
  for (const path of ['/api/inquiries', '/api/inquiries/analytics/summary', '/api/inquiries/x', '/api/leads/x', '/api/quick-answers']) {
    assert.equal((await request(path, 'GET', widget)).status, 401);
  }
  assert.equal(calls.length, 0);
});
test('tenant A cannot read/update tenant B leads or inquiries', async () => {
  records.push({ id: 'foreign', business_id: B, session_id: 'private-b' });
  for (const path of ['/api/leads/foreign', '/api/inquiries/foreign']) {
    assert.equal((await request(path, 'GET', owner())).status, 404);
    assert.equal((await request(path, 'PATCH', owner(), { status: 'open', business_id: B })).status, 404);
  }
});
test('own lead and inquiry remain readable with tenant-filtered messages and notifications', async () => {
  records.push({ id: 'own', business_id: A, session_id: 'own-session' });
  for (const path of ['/api/leads/own', '/api/inquiries/own']) assert.equal((await request(path, 'GET', owner())).status, 200);
});
test('public tokens cannot upload knowledge, poll jobs or delete namespaces', async () => {
  for (const [path, method] of [['/api/upsert','POST'], ['/api/upsert/job/j','GET'], ['/api/upsert/namespace/bot-1','DELETE']]) {
    assert.equal((await request(path, method, widget, method === 'POST' ? { text: 'poisoned knowledge' } : undefined)).status, 401);
  }
  assert.equal(effects.knowledge, 0); assert.equal(effects.jobs, 0); assert.deepEqual(effects.deletions, []);
});
test('owner knowledge upload works; namespace from URL/body cannot override identity', async () => {
  assert.equal((await request('/api/upsert', 'POST', owner(), { text: 'valid owner knowledge', namespace: 'bot-1' })).status, 200);
  assert.equal(effects.knowledge, 1);
  assert.equal((await request('/api/upsert/namespace/bot-1', 'DELETE', owner())).status, 403);
  assert.equal((await request('/api/upsert/namespace/bot-0', 'DELETE', owner())).status, 200);
  assert.deepEqual(effects.deletions, [A]);
});
test('file job polling is owner-scoped, including legacy jobs without ownership', async () => {
  for (const job of [{ namespace: 'bot-1' }, {}]) {
    cache.set('job:j', JSON.stringify(job));
    assert.ok([403,404].includes((await request('/api/upsert/job/j', 'GET', owner())).status));
  }
  cache.set('job:j', JSON.stringify({ namespace: 'bot-0', status: 'queued' }));
  assert.equal((await request('/api/upsert/job/j', 'GET', owner())).status, 200);
});
test('scrape job status only returns jobs belonging to authenticated business', async () => {
  jobs.push({ id: 'j', business_id: B, status: 'queued' });
  assert.equal((await request('/api/scrape/status/j', 'GET', owner())).status, 404);
  jobs[0].business_id = A;
  assert.equal((await request('/api/scrape/status/j', 'GET', owner())).status, 200);
});
test('legacy lead webhook and entitlement writes require server key', async () => {
  assert.equal((await request('/api/lead/capture', 'POST', widget, { message: 'spam' })).status, 401);
  assert.equal((await request('/api/billing/select-plan', 'POST', owner(), { plan: 'agency' })).status, 401);
  assert.equal(effects.webhook, 0);
});
test('chat rejects unauthenticated/wrong-bot requests before inquiry or database side effects', async () => {
  const body = { botId: 'bot-1', sessionId: 'new', message: 'Please call me' };
  assert.equal((await request('/api/chat', 'POST', {}, body)).status, 401);
  assert.equal((await request('/api/chat', 'POST', widget, body)).status, 403);
  assert.equal(calls.length, 0); assert.equal(effects.inquiries, 0);
});
test('foreign session collision is rejected before history, emergency, messages or inquiry side effects', async () => {
  sessions.set('private-b', { id: 'private-b', business_id: B, collected_data: { email: 'private@example.com' } });
  for (const message of ['hello', 'chest pain', 'Please call me']) {
    assert.equal((await request('/api/chat?stream=true', 'POST', widget, { botId: 'bot-0', sessionId: 'private-b', message })).status, 403);
  }
  assert.equal(effects.messages, 0); assert.equal(effects.inquiries, 0); assert.equal(effects.sessions, 0);
  assert.ok(!calls.some(c => c.q.includes('FROM messages') || c.q.includes('FROM bot_configs')));
  assert.equal(sessions.get('private-b').business_id, B);
});
test('session ownership remains stable across concurrent first requests from two tenants', async () => {
  const results = await Promise.all([request('/api/chat', 'POST', widget, { botId: 'bot-0', sessionId: 'race', message: 'hello' }), request('/api/chat', 'POST', { 'x-chatbot-token': 'public-b' }, { botId: 'bot-1', sessionId: 'race', message: 'hello' })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200,403]); assert.equal(effects.messages, 1);
});
test('new and existing own sessions continue to support normal chat', async () => {
  const first = await request('/api/chat', 'POST', widget, { botId: 'bot-0', sessionId: 'own', message: 'hello' });
  assert.equal(first.status, 200); assert.match(first.body.reply, /Hi/); assert.equal(effects.messages, 1);
  assert.equal(sessions.get('own').business_id, A);
  const resumed = await request('/api/chat', 'POST', widget, { botId: 'bot-0', sessionId: 'own', message: 'hello' });
  assert.equal(resumed.status, 200); assert.equal(effects.messages, 2);
});
test('malformed chat inputs cannot create sessions', async () => {
  for (const body of [{}, { botId: 'bot-0', sessionId: {}, message: 'hello' }, { botId: 'bot-0', sessionId: 's', message: [] }]) assert.equal((await request('/api/chat', 'POST', widget, body)).status, 400);
  assert.equal(calls.length, 0);
});
test('Redis and origin validation failures fail closed', async () => {
  redisFailure = true;
  assert.equal((await request('/api/chat', 'POST', widget, { botId: 'bot-0', sessionId: 's', message: 'hello' })).status, 503);
  assert.equal(calls.length, 0);
});

test('dashboard identity and entitlements come from current database, not forged/stale claims', async () => {
  const token = sign(undefined, { plan: 'agency', botId: 'bot-1', industry: 'healthcare' });
  const result = await request('/identity', 'GET', { authorization: `Bearer ${token}` });
  assert.equal(result.status, 200); assert.equal(result.body.plan, 'free');
  assert.equal(result.body.botId, 'bot-0'); assert.equal(result.body.industry, 'other');
});
test('foreign widget header cannot override valid dashboard identity on inquiry reads', async () => {
  records.push({ id: 'foreign', business_id: B, session_id: 'private-b' });
  const result = await request('/api/inquiries/foreign', 'GET', { ...owner(), 'x-chatbot-token': 'public-b' });
  assert.equal(result.status, 404);
});
test('origin denial and domain settings failure stop requests before session/inquiry effects', async () => {
  const body = { botId: 'bot-0', sessionId: 's', message: 'hello' };
  cache.set('chatbot:bot-0', JSON.stringify({ allowedDomains: ['trusted.example'] }));
  assert.equal((await request('/api/chat', 'POST', { ...widget, origin: 'https://attacker.example' }, body)).status, 403);
  redisFailure = 'domain';
  assert.equal((await request('/api/chat', 'POST', widget, body)).status, 503);
  assert.equal(calls.length, 0); assert.equal(effects.inquiries, 0);
});
test('public streaming chat keeps SSE response contract after authorization', async () => {
  const response = await fetch(base + '/api/chat?stream=true', { method: 'POST', headers: { ...widget, 'content-type': 'application/json' }, body: JSON.stringify({ botId: 'bot-0', sessionId: 'stream', message: 'hello' }) });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const stream = await response.text(); assert.match(stream, /data: \[DONE\]/); assert.match(stream, /Hi/);
});
