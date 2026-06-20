import pool from './pool.js';

const DEFAULT_CHAT_HISTORY_LIMIT = 20;
const MAX_CHAT_HISTORY_LIMIT = 50;

export function getChatHistoryLimit() {
  const configured = Number.parseInt(process.env.CHAT_HISTORY_LIMIT || '', 10);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_CHAT_HISTORY_LIMIT;
  return Math.min(configured, MAX_CHAT_HISTORY_LIMIT);
}

export async function setupSessionHistoryIndexes() {
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_session_created_at_desc
    ON messages (session_id, created_at DESC)
  `);
}

export async function getRecentConversationHistory(sessionId, limit = getChatHistoryLimit()) {
  const historyRows = await pool.query(
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
  );

  return historyRows.rows.map((row) => ({
    role: row.role,
    content: row.content,
  }));
}

export function buildSessionMemoryBlock(session = {}) {
  const collectedData = session?.collected_data || {};
  const hasMemory = collectedData && typeof collectedData === 'object' && Object.keys(collectedData).length > 0;
  if (!hasMemory) return '';

  return `SESSION MEMORY:\n${JSON.stringify(collectedData, null, 2)}\n\nUse this as factual memory for this visitor. Do not ask again for details already present here.\n\n`;
}
