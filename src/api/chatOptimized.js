import pool from '../db/pool.js';
import { buildSessionMemoryBlock, getChatHistoryLimit } from '../db/sessionHistory.js';

const originalQuery = pool.query.bind(pool);
const ORIGINAL_HISTORY_QUERY = 'SELECT role, content FROM messages WHERE session_id=$1 ORDER BY created_at ASC LIMIT 30';

function normalizeQuery(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

async function getOptimizedHistory(sessionId) {
  const limit = getChatHistoryLimit();

  const [historyResult, sessionResult] = await Promise.all([
    originalQuery(
      `SELECT role, content
       FROM (
         SELECT role, content, created_at
         FROM messages
         WHERE session_id = $1
         ORDER BY created_at DESC
         LIMIT $2
       ) recent
       ORDER BY created_at ASC`,
      [sessionId, limit],
    ),
    originalQuery('SELECT collected_data FROM sessions WHERE id = $1', [sessionId]).catch(() => ({ rows: [] })),
  ]);

  const memoryBlock = buildSessionMemoryBlock(sessionResult.rows?.[0] || {});
  if (!memoryBlock) return historyResult;

  return {
    ...historyResult,
    rows: [
      { role: 'user', content: memoryBlock },
      ...historyResult.rows,
    ],
  };
}

pool.query = async function optimizedSessionHistoryQuery(text, params = [], ...rest) {
  if (normalizeQuery(text) === ORIGINAL_HISTORY_QUERY && params?.[0]) {
    return getOptimizedHistory(params[0]);
  }

  return originalQuery(text, params, ...rest);
};

const { default: router } = await import('./chat.js');

export default router;
