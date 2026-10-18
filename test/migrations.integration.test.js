import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// This suite NEVER reads DATABASE_URL or .env. CI provides a disposable database.
const testUrl = process.env.TEST_DATABASE_URL;
let client, sessionPool;
let embeddingBarrier;
const cache = new Map();
const embedding = [1, ...Array(1535).fill(0)];
mock.module('../src/db/pool.js', { defaultExport: { query: (...args) => (sessionPool || client).query(...args), connect: async () => sessionPool ? sessionPool.connect() : ({query: (...args) => client.query(...args), release() {}}) } });
mock.module('../src/services/aiService.js', { namedExports: { getEmbedding: async () => { if (embeddingBarrier) { const barrier=embeddingBarrier; barrier.started(); await barrier.release; } return embedding; } } });
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
    for (const name of ['008_account_auth.sql','009_agency_business_access.sql','010_agent_foundation.sql','011_agent_runtime.sql','012_agent_chat_turn_claims.sql','013_legacy_knowledge_mutation_claims.sql'])
      await client.query(await migration(name));

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
    await t.test('atomic replacement rollback and partial supplemental failure preserve confirmed data/revisions', async () => {
      const {upsertChunks,upsertSupplementalChunks}=await import('../src/db/vectorStore.js');
      const before=(await client.query('SELECT content FROM knowledge_chunks WHERE business_id=$1 ORDER BY content',[A])).rows;
      const version=await revision(A);
      await client.query("ALTER TABLE knowledge_chunks ADD CONSTRAINT test_ingestion_failure CHECK (content <> 'invalid test chunk') NOT VALID");
      await assert.rejects(upsertChunks(A,['valid replacement','invalid test chunk']),e=>e.result.inserted===0);
      assert.deepEqual((await client.query('SELECT content FROM knowledge_chunks WHERE business_id=$1 ORDER BY content',[A])).rows,before);
      assert.equal(await revision(A),version);
      await assert.rejects(upsertSupplementalChunks(A,['confirmed partial','invalid test chunk']),e=>e.result.inserted===1 && e.result.status==='partial');
      assert.equal(BigInt(await revision(A)),BigInt(version)+1n);
      const retry=await upsertSupplementalChunks(A,['confirmed partial','retry succeeds']);
      assert.equal(retry.inserted,1);assert.equal(retry.skipped,1);
      assert.equal((await client.query("SELECT COUNT(*)::int AS n FROM knowledge_chunks WHERE business_id=$1 AND content='confirmed partial'",[A])).rows[0].n,1);
    });
    await t.test('supplemental ingestion conflicts safely with deletion without holding pooled clients', async () => {
      const {deleteBusinessChunks,upsertSupplementalChunks}=await import('../src/db/vectorStore.js');
      sessionPool = new pg.Pool({ connectionString: testUrl, max: 3, options: `-c search_path=${schema},public` });
      let startedResolve,releaseResolve;
      const started=new Promise(resolve=>{startedResolve=resolve;});
      const release=new Promise(resolve=>{releaseResolve=resolve;});
      embeddingBarrier={started:startedResolve,release};
      try {
        const upload=upsertSupplementalChunks(A,['concurrent upload one','concurrent upload two']);
        await started;
        await assert.rejects(upsertSupplementalChunks(A,['overlapping upload']), error =>
          error.status===409 && error.code==='KNOWLEDGE_MUTATION_CONFLICT');
        await assert.rejects(deleteBusinessChunks(A), error => error.status===409);
        assert.equal(sessionPool.waitingCount,0);
        releaseResolve();
        await upload;
        await deleteBusinessChunks(A);
        assert.equal((await sessionPool.query('SELECT count(*)::int n FROM knowledge_chunks WHERE business_id=$1',[A])).rows[0].n,0);
      } finally {
        embeddingBarrier=null;
        await sessionPool.end();sessionPool=null;
      }
    });
    await t.test('durable chat gate and concurrent session ownership use real PostgreSQL constraints', async () => {
      const { requireChatSession } = await import('../src/middleware/chatSession.js');
      sessionPool = new pg.Pool({ connectionString: testUrl, max: 6, options: `-c search_path=${schema},public` });
      const gate = async (botId, sessionId) => {
        const req = { namespace: botId, body: {botId, sessionId, message:'hello'} };
        let status=200, payload, continued=false;
        const res={status(code){status=code;return this;},json(value){payload=value;return this;}};
        await requireChatSession(req,res,error=>{if(error)throw error;continued=true;});
        return {req,status,payload,continued};
      };
      try {
        await client.query('INSERT INTO bot_configs(business_id,active) VALUES ($1,true),($2,true)',[A,B]);
        await client.query("UPDATE businesses SET is_disabled=true WHERE id=$1",[A]);
        const disabled=await gate('bot-a','disabled-pg');
        assert.equal(disabled.req.chatConfig.is_disabled,true);assert.equal(disabled.req.chatSession,undefined);
        assert.equal((await client.query("SELECT count(*)::int n FROM sessions WHERE id='disabled-pg'")).rows[0].n,0);
        await client.query('UPDATE businesses SET is_disabled=false,active=false WHERE id=$1',[A]);
        assert.equal((await gate('bot-a','inactive-pg')).status,404);
        await client.query('UPDATE businesses SET active=true WHERE id=$1',[A]);
        await client.query('UPDATE bot_configs SET active=false WHERE business_id=$1',[A]);
        assert.equal((await gate('bot-a','unconfigured-pg')).status,404);
        await client.query('UPDATE bot_configs SET active=true WHERE business_id=$1',[A]);
        const firsts=await Promise.all(Array.from({length:6},()=>gate('bot-a','concurrent-pg')));
        assert.ok(firsts.every(r=>r.continued && r.req.chatSession.business_id===A));
        assert.equal((await client.query("SELECT count(*)::int n FROM sessions WHERE id='concurrent-pg'")).rows[0].n,1);
        assert.equal((await gate('bot-a','concurrent-pg')).req.chatSession.business_id,A);
        const collision=await gate('bot-b','concurrent-pg');
        assert.equal(collision.status,403);assert.deepEqual(collision.payload,{error:'Invalid session scope'});
        assert.equal((await client.query("SELECT business_id FROM sessions WHERE id='concurrent-pg'")).rows[0].business_id,A);
        assert.equal((await client.query("SELECT count(*)::int n FROM sessions WHERE id IN ('inactive-pg','unconfigured-pg')")).rows[0].n,0);
      } finally { await sessionPool.end(); sessionPool=undefined; }
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
