import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
const calls = [];
const original = async (...args) => {
  calls.push(args);
  return { rows: [{ id: 'unrelated-write' }] };
};
const pool = { query: original };
mock.module('../src/db/pool.js', { defaultExport: pool });
mock.module('../src/api/chat.js', { defaultExport: express.Router() });
mock.module('../src/services/redis.js', { namedExports: { redisClient: {} } });
mock.module('../src/services/inquiryService.js', {
  namedExports: {
    removeVisibleInquiryJson: (x) => x,
    saveInquiryFromConversation: async () => null,
  },
});
await import('../src/api/chatInquiries.js');
const { rememberInquiryOnlySession, isInquiryOnlySession } =
  await import('../src/services/inquirySessions.js');
const { applyChatEmailPolicy } =
  await import('../src/services/chatConfigPolicy.js');
const { getRecentConversationHistory } =
  await import('../src/db/sessionHistory.js');
test('importing all chat wrappers never replaces or intercepts shared pool.query', async () => {
  assert.equal(pool.query, original);
  rememberInquiryOnlySession('business-a', 'session');
  const result = await pool.query(
    'INSERT INTO leads (business_id, session_id) VALUES ($1,$2) RETURNING id',
    ['business-a', 'session'],
  );
  assert.equal(result.rows[0].id, 'unrelated-write');
});
test('inquiry classification stays business/session scoped without changing other queries', () => {
  assert.equal(isInquiryOnlySession('business-a', 'session'), true);
  assert.equal(isInquiryOnlySession('business-b', 'session'), false);
  assert.equal(isInquiryOnlySession('business-a', 'other'), false);
});
test('chat email policy is explicit, plan-aware and does not mutate shared query results', () => {
  const source = {
    plan: 'free',
    owner_email: 'owner@example.test',
    escalation_email: 'notify@example.test',
  };
  const filtered = applyChatEmailPolicy(source);
  assert.equal(filtered.owner_email, null);
  assert.equal(source.owner_email, 'owner@example.test');
  assert.equal(
    applyChatEmailPolicy({ ...source, plan: 'professional' }).owner_email,
    'owner@example.test',
  );
});
test('explicit recent history queries require and bind business scope and bounded limit', async () => {
  await getRecentConversationHistory('session', 'business-a', 20);
  const [sql, params] = calls.at(-1);
  assert.match(sql, /business_id = \$2/);
  assert.deepEqual(params, ['session', 'business-a', 20]);
  await assert.rejects(
    getRecentConversationHistory('session'),
    /businessId required/,
  );
});
