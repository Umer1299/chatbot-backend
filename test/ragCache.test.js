import { test, mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const question = 'What is the warranty on this service?';
let cache, chunks, revisions, sessions, reads, redisFailure, dbFailure, race, failInsert, modelReply, leadWrites, knowledgeClaim;
const prompts = [];
const key = (id, revision, text = question, limit = 5) => `rag:v2:${id}:${revision}:${createHash('sha256').update(JSON.stringify([text, limit])).digest('hex')}`;
const db = { query: async (sql, args = []) => {
  if (dbFailure) throw Error('PostgreSQL unavailable');
  const q = sql.replace(/\s+/g, ' ').trim();
  if (q.startsWith('INSERT INTO legacy_knowledge_mutation_claims')) {
    if (knowledgeClaim) return { rows: [] };
    knowledgeClaim=args[1]; return { rows: [{claim_token:knowledgeClaim}] };
  }
  if (q.startsWith('SELECT claim_token FROM legacy_knowledge_mutation_claims')) return { rows: knowledgeClaim ? [{claim_token:knowledgeClaim}] : [] };
  if (q.startsWith('DELETE FROM legacy_knowledge_mutation_claims')) { if (knowledgeClaim===args[1]) knowledgeClaim=null; return {rows:[],rowCount:1}; }
  if (q.startsWith('SELECT knowledge_revision')) return { rows: [{ knowledge_revision: String(revisions.get(args[0])) }] };
  if (q.startsWith('SELECT content FROM knowledge_chunks')) return { rows: chunks.filter(c => c.businessId===args[0] && c.type===args[1] && args[2].includes(c.content)).map(c=>({content:c.content})) };
  if (q.startsWith('SELECT content,')) {
    reads++;
    const rows = chunks.filter(c => c.businessId === args[0]).slice(0, args[2]).map(c => ({ content: c.content, similarity: 0.9 }));
    if (race) { const fn = race; race = undefined; fn(); }
    return { rows };
  }
  if (q.startsWith('DELETE FROM knowledge_chunks')) {
    const before = chunks.length;
    chunks = chunks.filter(c => c.businessId !== args[0] || (args[1] && c.type !== args[1]));
    if (chunks.length !== before) revisions.set(args[0], revisions.get(args[0])+1);
    return { rows: [], rowCount: before-chunks.length };
  }
  if (q.startsWith('SELECT COUNT(*)')) return { rows: [{ total: chunks.filter(c => c.businessId === args[0]).length }] };
  if (q.startsWith('INSERT INTO knowledge_chunks')) {
    if (failInsert && chunks.some(c => c.content === 'partial upload')) throw Error('Insert failed');
    chunks.push({ businessId: args[0], content: args[1], type: args[3] }); revisions.set(args[0], revisions.get(args[0])+1);
    return { rows: [], rowCount: 1 };
  }
  if (q.startsWith('INSERT INTO leads')) { leadWrites.push(args); return {rows:[{id:'saved-lead'}]}; }
  if (q.startsWith('SELECT id FROM businesses')) return { rows: [{ id: A }] };
  if (q.includes('FROM bot_configs')) return { rows: [{ business_id: A, business_name: 'Example', selected_agents: [], selected_model: 'test', plan: 'free', industry: 'other', active: true }] };
  if (q.startsWith('INSERT INTO sessions')) { if (!sessions.has(args[0])) sessions.set(args[0], { id: args[0], business_id: args[1], collected_data: {} }); return { rows: [] }; }
  if (q.includes('FROM sessions')) return { rows: sessions.has(args[0]) ? [sessions.get(args[0])] : [] };
  if (q.includes('FROM messages') || q.startsWith('UPDATE sessions') || q.startsWith('INSERT INTO messages')) return { rows: [] };
  throw Error(`Unexpected query ${q}`);
} };
db.connect = async () => { let snapshot; return { release() {}, query: async (sql,args) => {
  if (sql==='BEGIN') { snapshot={ chunks:structuredClone(chunks), revisions:new Map(revisions) }; return {rows:[]}; }
  if (sql==='ROLLBACK') { chunks=snapshot.chunks; revisions=snapshot.revisions; return {rows:[]}; }
  if (sql==='COMMIT') return {rows:[]};
  return db.query(sql,args);
} }; };
mock.module('../src/db/pool.js', { defaultExport: db });
mock.module('../src/services/aiService.js', { namedExports: { getEmbedding: async () => [1,0,0] } });
mock.module('../src/services/redis.js', { namedExports: { redisClient: {
  get: async k => { if (redisFailure) throw Error('Redis unavailable'); return cache.get(k) || null; },
  setex: async (k, ttl, value) => { if (redisFailure) throw Error('Redis unavailable'); assert.ok(ttl > 0); cache.set(k, value); },
  keys: async () => { throw Error('RAG must never use KEYS'); },
} } });
mock.module('../src/middleware/tokenAuth.js', { namedExports: { tokenAuth: (req, res, next) => { req.namespace='bot-public-namespace'; req.chatbotToken='test'; next(); } } });
mock.module('../src/middleware/domainRestriction.js', { namedExports: { domainRestriction: (req, res, next) => next() } });
mock.module('../src/services/emailService.js', { namedExports: { sendLeadAlert: async () => {}, sendUrgentEscalation: async () => {} } });
mock.module('../src/services/modelService.js', { namedExports: { getSafeModel: async () => ({ provider: 'openai', modelId: 'test', apiModelId: 'test' }) } });
mock.module('../src/agents/promptBuilder.js', { namedExports: { buildMasterPrompt: () => 'Help the visitor', generateProjectDetails: () => '' } });
mock.module('openai', { defaultExport: class {
  chat = { completions: { create: async ({ messages, stream }) => {
    prompts.push(messages[0].content);
    const content = modelReply || 'Here is the current information.';
    if (stream) return (async function* () { yield { choices: [{ delta: { content } }] }; })();
    return { choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 6 } };
  } } };
} });
mock.module('@anthropic-ai/sdk', {defaultExport:class { messages={create:async()=>({content:[{text:'Test summary'}]})}; }});
process.env.BUBBLE_API_URL=''; process.env.BUBBLE_API_KEY='';
process.env.OPENAI_API_KEY = 'test-only-dummy';
const { getRelevantChunks, deleteBusinessChunks, upsertChunks, upsertSupplementalChunks } = await import('../src/db/vectorStore.js');
const app = express(); app.use(express.json()); app.use('/chat', (await import('../src/api/chat.js')).default);
app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
after(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => {
  cache = new Map(); chunks = [{ businessId: A, content: 'Deleted warranty detail', type: 'website' }, { businessId: B, content: 'Private tenant B detail', type: 'website' }];
  revisions = new Map([[A,0], [B,0]]); sessions = new Map(); reads=0; redisFailure=false; dbFailure=false; race=undefined; failInsert=false; prompts.length=0; modelReply=undefined; leadWrites=[]; knowledgeClaim=null;
});
test('retrieval ignores old namespace keys and uses business-scoped versioned keys', async () => {
  cache.set('rag:bot-public-namespace:what-is-the-warranty-on-this-service?', JSON.stringify([{ content: 'stale namespace cache', similarity: 1 }]));
  assert.equal((await getRelevantChunks(A, question, 'bot-public-namespace'))[0].content, 'Deleted warranty detail');
  assert.ok(cache.has(key(A, 0))); assert.equal(reads, 1);
  await getRelevantChunks(A, question, 'another-namespace'); assert.equal(reads, 1);
});
test('successful deletion makes old generation unreachable for subsequent retrieval', async () => {
  await getRelevantChunks(A, question, 'bot-public-namespace');
  await deleteBusinessChunks(A);
  assert.deepEqual(await getRelevantChunks(A, question, 'bot-public-namespace'), []);
  assert.ok(cache.has(key(A,0))); // No scan required; unreachable keys expire by TTL.
  assert.ok(cache.has(key(A,1)));
});
test('same namespace and question cannot leak another business retrieval result', async () => {
  await getRelevantChunks(B, question, 'shared-or-forged-namespace');
  assert.equal((await getRelevantChunks(A, question, 'shared-or-forged-namespace'))[0].content, 'Deleted warranty detail');
  await deleteBusinessChunks(A);
  assert.equal((await getRelevantChunks(B, question, 'shared-or-forged-namespace'))[0].content, 'Private tenant B detail');
});
test('full query and limit participate in the cache key, avoiding truncated-query collisions', async () => {
  const first = 'same question prefix '.repeat(3) + 'option one';
  const second = 'same question prefix '.repeat(3) + 'option two';
  await getRelevantChunks(A, first, 'bot'); await getRelevantChunks(A, second, 'bot'); await getRelevantChunks(A, first, 'bot', 1);
  assert.equal(reads, 3); assert.ok(cache.has(key(A,0,first,1)));
});
test('owner uploads and website re-scraping invalidate prior retrieval generations', async () => {
  await getRelevantChunks(A, question, 'bot');
  await upsertSupplementalChunks(A, ['uploaded current detail']);
  assert.ok((await getRelevantChunks(A, question, 'bot')).some(c => c.content === 'uploaded current detail'));
  await upsertChunks(A, ['new website detail']);
  const result = await getRelevantChunks(A, question, 'bot');
  assert.ok(result.some(c => c.content === 'new website detail'));
  assert.ok(!result.some(c => c.content === 'Deleted warranty detail'));
});
test('partial upload failures cannot keep an old retrieval generation valid', async () => {
  await getRelevantChunks(A, question, 'bot'); failInsert = true;
  await assert.rejects(upsertSupplementalChunks(A, ['partial upload', 'failed next chunk']), error => error.result.inserted===1 && error.result.status==='partial');
  assert.ok((await getRelevantChunks(A, question, 'bot')).some(c => c.content === 'partial upload'));
});
test('deletion during retrieval retries instead of caching stale results into the current generation', async () => {
  race = () => { chunks = chunks.filter(c => c.businessId !== A); revisions.set(A,1); };
  assert.deepEqual(await getRelevantChunks(A, question, 'bot'), []); assert.equal(reads, 2); assert.ok(!cache.has(key(A,0)));
});
test('Redis outage during deletion cannot revive stale results when Redis returns', async () => {
  await getRelevantChunks(A, question, 'bot'); redisFailure=true;
  await deleteBusinessChunks(A);
  redisFailure=false;
  assert.deepEqual(await getRelevantChunks(A, question, 'bot'), []);
});
test('unavailable durable revision cannot return old cached knowledge', async () => {
  await getRelevantChunks(A, question, 'bot'); dbFailure=true;
  assert.deepEqual(await getRelevantChunks(A, question, 'bot'), []);
});
test('JSON and streaming conversations after deletion do not receive deleted knowledge in the model prompt', async () => {
  const chat = async (sessionId, streaming=false) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat${streaming ? '?stream=true' : ''}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({botId:'bot-public-namespace', sessionId, message:question}) });
    assert.equal(response.status,200); return streaming ? response.text() : response.json();
  };
  await chat('before'); assert.match(prompts.at(-1), /Deleted warranty detail/);
  await deleteBusinessChunks(A);
  const response = await chat('after'); assert.equal(typeof response.reply,'string');
  assert.doesNotMatch(prompts.at(-1), /Deleted warranty detail|Private tenant B detail/);
  const stream = await chat('stream-after',true); assert.match(stream, /data: \[DONE\]/);
  assert.doesNotMatch(prompts.at(-1), /Deleted warranty detail|Private tenant B detail/);
});

test('normal lead capture stays business-scoped after removing global query interception',async()=>{
  modelReply='Thanks. LEAD_DATA: '+JSON.stringify({name:'Test Customer',email:'customer@example.test',needs:'new website',project_type:'website'});
  const r=await fetch(`http://127.0.0.1:${server.address().port}/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({botId:'bot-public-namespace',sessionId:'lead-normal',message:'Please help me with a website project'})});
  assert.equal(r.status,200);await r.json();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(leadWrites.length,1);assert.equal(leadWrites[0][0],A);assert.equal(leadWrites[0][1],'lead-normal');
});
test('inquiry-only classification suppresses only its own business/session lead',async()=>{
  const {rememberInquiryOnlySession}=await import('../src/services/inquirySessions.js');
  rememberInquiryOnlySession(A,'inquiry-only');
  modelReply='Thanks. LEAD_DATA: '+JSON.stringify({name:'Test Customer',email:'customer@example.test',needs:'new website',project_type:'website'});
  const r=await fetch(`http://127.0.0.1:${server.address().port}/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({botId:'bot-public-namespace',sessionId:'inquiry-only',message:'Please help me with a website project'})});
  assert.equal(r.status,200);await r.json();await new Promise(resolve=>setImmediate(resolve));assert.equal(leadWrites.length,0);
});
