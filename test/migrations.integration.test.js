import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// This suite NEVER reads DATABASE_URL or .env. CI provides a disposable database.
const testUrl = process.env.TEST_DATABASE_URL;
let client;
const cache = new Map();
const embedding = [1, ...Array(1535).fill(0)];
mock.module('../src/db/pool.js', { defaultExport: { query: (...args) => client.query(...args) } });
mock.module('../src/services/aiService.js', { namedExports: { getEmbedding: async () => embedding } });
mock.module('../src/services/redis.js', { namedExports: { redisClient: {
  get: async key => cache.get(key) || null,
  setex: async (key, ttl, value) => cache.set(key, value),
} } });
const migration = async name => readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), 'utf8');

test('isolated PostgreSQL migration, historical data and RAG revision integration', { skip: !testUrl && 'TEST_DATABASE_URL not configured; run in PostgreSQL CI or isolated staging' }, async t => {
  const url = new URL(testUrl);
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname), 'Integration tests require a loopback database');
  assert.equal(url.pathname, '/chatflow_security_test', 'Integration database must be explicitly named chatflow_security_test');
  const { default: pg } = await import('pg');
  client = new pg.Client({ connectionString: testUrl });
  await client.connect();
  const schema = `security_test_${randomUUID().replaceAll('-','')}`;
  try {
    // Extensions are public; all customer-style fixtures live in a fresh private schema.
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    for (const name of ['001_initial_schema.sql','002_plan_limits.sql','003_models_and_disable.sql','003_quick_answers.sql','004_inquiries.sql']) await client.query(await migration(name));
    const A = randomUUID(), B = randomUUID();
    await client.query(`INSERT INTO businesses (id,bubble_user_id,business_name,industry,owner_email,bot_id)
      VALUES ($1,'legacy-a','A','other','a@example.test','bot-a'),($2,'legacy-b','B','other','b@example.test','bot-b')`, [A,B]);
    await client.query(`INSERT INTO sessions (id,business_id) VALUES ('session-a',$1),('historical-null',NULL)`, [A]);
    await client.query(`INSERT INTO messages (session_id,business_id,role,content)
      VALUES ('session-a',$1,'user','historical mismatch'),(NULL,NULL,'user','historical unowned')`, [B]);
    await client.query(await migration('005_security_boundaries.sql'));
    await client.query(await migration('006_durable_chatbot_settings.sql'));
    await client.query(await migration('007_knowledge_cache_revision.sql'));

    await t.test('005 retains historical inconsistencies and rejects new cross-business/unowned messages', async () => {
      assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM messages')).rows[0].n,2);
      await assert.rejects(client.query(`INSERT INTO messages(session_id,business_id,role,content) VALUES ('session-a',$1,'user','bad')`,[B]), {code:'23503'});
      await assert.rejects(client.query(`INSERT INTO messages(role,content) VALUES ('user','unowned')`), {code:'23514'});
      await assert.rejects(client.query(`INSERT INTO sessions(id) VALUES ('new-unowned')`), {code:'23514'});
      await client.query(`INSERT INTO messages(session_id,business_id,role,content) VALUES ('session-a',$1,'user','valid')`,[A]);
      const constraints = await client.query(`SELECT convalidated FROM pg_constraint WHERE conrelid='messages'::regclass AND conname='messages_session_business_fk'`);
      assert.equal(constraints.rows[0].convalidated,false);
      const assigned = await client.query(`SELECT assigned_to FROM leads LIMIT 0`); assert.equal(assigned.rows.length,0);
    });
    await t.test('006 persists restrictions and tombstones; invalid/missing allowlists are rejected by SQL', async () => {
      await client.query(`INSERT INTO chatbot_settings(namespace,settings,revision) VALUES ('bot-a',$1,$2)`,[JSON.stringify({allowedDomains:['trusted.example']}),randomUUID()]);
      await assert.rejects(client.query(`INSERT INTO chatbot_settings(namespace,settings,revision) VALUES ('bad','{}',$1)`,[randomUUID()]), {code:'23514'});
      await client.query(`INSERT INTO chatbot_settings(namespace,settings,revision,deleted) VALUES ('deleted','{"allowedDomains":[]}',$1,true)`,[randomUUID()]);
    });
    const revision = async id => (await client.query('SELECT knowledge_revision FROM businesses WHERE id=$1',[id])).rows[0].knowledge_revision;
    await t.test('007 updates one generation per affected business per statement, including tenant moves and rollback', async () => {
      assert.equal(await revision(A),'0');
      await client.query(`INSERT INTO knowledge_chunks(business_id,content) VALUES ($1,'first'),($1,'second')`,[A]);
      assert.equal(await revision(A),'1'); assert.equal(await revision(B),'0');
      await client.query('UPDATE knowledge_chunks SET business_id=$1 WHERE business_id=$2',[B,A]);
      assert.equal(await revision(A),'2'); assert.equal(await revision(B),'1');
      await client.query('BEGIN');
      await client.query(`INSERT INTO knowledge_chunks(business_id,content) VALUES ($1,'rolled back')`,[A]);
      await client.query('ROLLBACK'); assert.equal(await revision(A),'2');
      await client.query('DELETE FROM knowledge_chunks WHERE business_id=$1',[B]);
      assert.equal(await revision(B),'2');
    });
    await t.test('real pgvector reads after successful deletion/upload/replacement cannot reuse stale Redis generations', async () => {
      const {getRelevantChunks,deleteBusinessChunks,upsertSupplementalChunks,upsertChunks} = await import('../src/db/vectorStore.js');
      await client.query(`INSERT INTO knowledge_chunks(business_id,content,embedding) VALUES ($1,'deleted customer knowledge',$2::vector)`,[A,JSON.stringify(embedding)]);
      const before = await getRelevantChunks(A,'current policy','bot-a');
      assert.equal(before[0].content,'deleted customer knowledge');
      assert.equal(await deleteBusinessChunks(A),1);
      assert.deepEqual(await getRelevantChunks(A,'current policy','bot-a'),[]);
      await upsertSupplementalChunks(A,['new owner upload']);
      assert.equal((await getRelevantChunks(A,'current policy','bot-a'))[0].content,'new owner upload');
      await upsertChunks(A,['new website info']);
      const result = await getRelevantChunks(A,'current policy','bot-a');
      assert.ok(result.some(row => row.content==='new website info'));
      assert.ok(!result.some(row => row.content==='deleted customer knowledge'));
    });
    await t.test('reapplying 005/006/007 preserves policies, revisions, historical messages and customer rows', async () => {
      const original = await revision(A);
      for (const name of ['005_security_boundaries.sql','006_durable_chatbot_settings.sql','007_knowledge_cache_revision.sql']) await client.query(await migration(name));
      assert.equal(await revision(A),original);
      assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM businesses')).rows[0].n,2);
      assert.deepEqual((await client.query(`SELECT settings FROM chatbot_settings WHERE namespace='bot-a'`)).rows[0].settings.allowedDomains,['trusted.example']);
      assert.equal((await client.query(`SELECT deleted FROM chatbot_settings WHERE namespace='deleted'`)).rows[0].deleted,true);
      assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM messages')).rows[0].n,3);
    });
  } finally {
    // Never touches pre-existing schemas/tables; this name was generated above.
    await client.query('ROLLBACK');
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
