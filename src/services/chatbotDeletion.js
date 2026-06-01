import crypto from 'crypto';
import pool from '../db/pool.js';
import { redisClient } from './redis.js';
import { deleteBusinessChunks } from '../db/vectorStore.js';

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function getRedisKeys(pattern) {
  if (!redisClient) return [];

  if (typeof redisClient.scan === 'function') {
    const keys = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }

  if (typeof redisClient.keys === 'function') {
    return redisClient.keys(pattern);
  }

  return [];
}

async function deleteRedisKeys(keys) {
  const uniqueKeys = [...new Set(keys.filter(Boolean))];
  if (uniqueKeys.length === 0) return 0;
  return redisClient.del(...uniqueKeys);
}

async function getRedisJobKeysForNamespace(namespace) {
  const jobKeys = await getRedisKeys('job:*');
  const matchingKeys = [];

  for (const key of jobKeys) {
    try {
      const raw = await redisClient.get(key);
      if (!raw) continue;
      const job = JSON.parse(raw);
      if (job?.namespace === namespace) matchingKeys.push(key);
    } catch (error) {
      console.warn('Failed to inspect Redis job while deleting chatbot data:', {
        namespace,
        key,
        error: error.message,
      });
    }
  }

  return matchingKeys;
}

async function deleteChatbotRedisData({ namespace, businessId, token }) {
  const directKeys = [
    `chatbot:${namespace}`,
    `chatbot_config:${namespace}`,
    `chatbot_namespace_token:${namespace}`,
    `chatbot:token:${hashToken(namespace)}`,
  ];

  if (token) {
    directKeys.push(`chatbot_token:${token}`);
    directKeys.push(`chatbot:token:${hashToken(token)}`);
  }

  const patternKeys = [
    ...(await getRedisKeys(`rag:${namespace}:*`)),
    ...(businessId ? await getRedisKeys(`rag:${businessId}:*`) : []),
    ...(businessId ? await getRedisKeys(`lead-extract:${businessId}:*`) : []),
    ...(await getRedisJobKeysForNamespace(namespace)),
  ];

  return deleteRedisKeys([...directKeys, ...patternKeys]);
}

export async function deleteChatbotData(namespace) {
  const businessResult = await pool.query(
    'SELECT id FROM businesses WHERE bot_id = $1 LIMIT 1',
    [namespace],
  );
  const businessId = businessResult.rows[0]?.id || null;
  const token = await redisClient.get(`chatbot_namespace_token:${namespace}`);

  let deletedChunks = 0;
  let deletedQuickAnswers = 0;

  if (businessId) {
    deletedChunks = await deleteBusinessChunks(businessId);

    const quickAnswerResult = await pool.query(
      'DELETE FROM quick_answers WHERE business_id = $1',
      [businessId],
    );
    deletedQuickAnswers = quickAnswerResult.rowCount;
  }

  const deletedRedisKeys = await deleteChatbotRedisData({ namespace, businessId, token });

  return {
    namespace,
    businessId,
    deletedChunks,
    deletedQuickAnswers,
    deletedRedisKeys,
  };
}

export async function deleteChatbotDataForBusiness(businessId) {
  const businessResult = await pool.query(
    'SELECT bot_id FROM businesses WHERE id = $1 LIMIT 1',
    [businessId],
  );
  const namespace = businessResult.rows[0]?.bot_id || null;

  if (!namespace) {
    return null;
  }

  return deleteChatbotData(namespace);
}
