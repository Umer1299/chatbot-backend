import crypto from 'crypto';
import pool from '../db/pool.js';
import { redisClient } from '../services/redis.js';
import { createChatLogger, getRequestId } from '../utils/chatPerfLogger.js';

const TOKEN_CACHE_TTL_SECONDS = 600;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function getHeaderSource(req) {
  const chatbotToken = req.headers['x-chatbot-token'];
  const authHeader = req.headers.authorization;

  if (chatbotToken) return 'x-chatbot-token';
  if (authHeader) return 'authorization';
  return 'missing';
}

async function loadTokenDataFromDb(token) {
  const result = await pool.query(
    `SELECT id, bot_id
     FROM businesses
     WHERE bot_id = $1
     LIMIT 1`,
    [token],
  );

  if (!result.rows[0]) return null;

  return {
    namespace: result.rows[0].bot_id,
    businessId: result.rows[0].id,
    botId: result.rows[0].bot_id,
  };
}

async function loadTokenDataFromRedis(token) {
  const namespace = await redisClient.get(`chatbot_token:${token}`);
  if (!namespace) return null;

  const business = await pool.query(
    `SELECT id, bot_id
     FROM businesses
     WHERE bot_id = $1
     LIMIT 1`,
    [namespace],
  );

  if (!business.rows[0]) return null;

  return {
    namespace: business.rows[0].bot_id,
    businessId: business.rows[0].id,
    botId: business.rows[0].bot_id,
  };
}

export async function tokenAuth(req, res, next) {
  req.requestId = req.requestId || getRequestId(req);
  const chatLog = createChatLogger({ requestId: req.requestId, namespace: req.namespace || null });
  const authStart = performance.now();

  chatLog.log('token_auth_started');
  const headerSource = getHeaderSource(req);
  chatLog.log('token_auth_header_source', { source: headerSource });

  const token = req.headers['x-chatbot-token'];
  if (!token) {
    chatLog.log('token_auth_failed', { reason: 'missing_chatbot_token' });
    return res.status(401).json({ error: 'Missing chatbot token' });
  }

  const tokenHash = hashToken(token);
  const tokenCacheKey = `chatbot:token:${tokenHash}`;

  req.redisTokenCacheHit = false;
  let tokenData = null;

  try {
    const cached = await redisClient.get(tokenCacheKey);
    if (cached) {
      tokenData = JSON.parse(cached);
      req.redisTokenCacheHit = true;
      chatLog.log('token_auth_cache_hit', { token_auth_cache_hit: true });
    } else {
      chatLog.log('token_auth_cache_hit', { token_auth_cache_hit: false });
    }
  } catch (error) {
    req.redisTokenCacheHit = 'error_fallback';
    chatLog.error('redis_error', error, { operation: 'token_auth_cache_read', fallback: 'lookup_chatbot_token_mapping' });
    chatLog.log('token_auth_cache_hit', { token_auth_cache_hit: false });
  }

  let usedDbFallback = false;

  if (!tokenData) {
    try {
      tokenData = await loadTokenDataFromRedis(token);
    } catch (error) {
      chatLog.error('redis_error', error, { operation: 'chatbot_token_lookup', fallback: 'db_lookup' });
    }
  }

  if (!tokenData) {
    usedDbFallback = true;
    chatLog.log('token_auth_db_fallback', { token_auth_db_fallback: true });
    try {
      tokenData = await loadTokenDataFromDb(token);
    } catch (error) {
      chatLog.error('token_auth_db_fallback_failed', error);
      tokenData = null;
    }
  } else {
    chatLog.log('token_auth_db_fallback', { token_auth_db_fallback: false });
  }

  if (tokenData) {
    try {
      await redisClient.setex(tokenCacheKey, TOKEN_CACHE_TTL_SECONDS, JSON.stringify(tokenData));
    } catch (error) {
      chatLog.error('redis_error', error, { operation: 'token_auth_cache_write', fallback: 'continue_without_cache' });
    }
  }

  if (!tokenData?.namespace) {
    if (usedDbFallback) {
      chatLog.log('token_auth_db_fallback', { token_auth_db_fallback: true });
    }
    chatLog.log('token_auth_failed', { reason: 'invalid_chatbot_token' });
    return res.status(401).json({ error: 'Invalid chatbot token' });
  }

  req.chatbotToken = token;
  req.namespace = tokenData.namespace;
  req.businessId = tokenData.businessId || null;
  req.botId = tokenData.botId || tokenData.namespace;

  chatLog.with({ namespace: tokenData.namespace, businessId: tokenData.businessId || null, botId: tokenData.botId || null });
  const totalMs = Number((performance.now() - authStart).toFixed(2));
  chatLog.log('token_auth_done', { durationMs: totalMs, redisTokenCacheHit: req.redisTokenCacheHit });
  if (totalMs > 200) chatLog.warn('slow_token_auth', { durationMs: totalMs });

  return next();
}
