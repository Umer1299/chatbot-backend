import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import pool from '../db/pool.js';
import { redisClient } from '../services/redis.js';
import { createChatLogger, getRequestId } from '../utils/chatPerfLogger.js';

const TOKEN_CACHE_TTL_SECONDS = 600;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function loadTokenDataFromDb(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const botId = decoded?.botId;
  const businessId = decoded?.businessId;
  if (!botId || !businessId) return null;

  const result = await pool.query(
    `SELECT id, bot_id
     FROM businesses
     WHERE id = $1 AND bot_id = $2
     LIMIT 1`,
    [businessId, botId],
  );

  if (!result.rows[0]) return null;

  return {
    namespace: botId,
    businessId,
    botId,
  };
}

export async function tokenAuth(req, res, next) {
  req.requestId = req.requestId || getRequestId(req);
  const chatLog = createChatLogger({ requestId: req.requestId, namespace: req.namespace || null });
  const authStart = performance.now();
  chatLog.log('token_auth_start');

  const token = req.headers['x-chatbot-token'];
  if (!token) {
    return res.status(401).json({ error: 'Missing x-chatbot-token header' });
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
      chatLog.log('token_auth_cache_hit', { tokenCacheKey: 'chatbot:token:<sha256>', durationMs: Number((performance.now() - authStart).toFixed(2)), businessId: tokenData.businessId || null, botId: tokenData.botId || null, namespace: tokenData.namespace || null });
    } else {
      chatLog.log('token_auth_cache_miss', { tokenCacheKey: 'chatbot:token:<sha256>', durationMs: Number((performance.now() - authStart).toFixed(2)) });
    }
  } catch (error) {
    req.redisTokenCacheHit = 'error_fallback';
    chatLog.error('redis_error', error, { operation: 'token_auth_cache_read', fallback: 'db_lookup' });
  }

  if (!tokenData) {
    chatLog.log('token_auth_db_fallback_start', { durationMs: Number((performance.now() - authStart).toFixed(2)) });
    try {
      tokenData = await loadTokenDataFromDb(token);
    } catch (error) {
      chatLog.error('token_auth_db_fallback_failed', error);
      tokenData = null;
    }
    chatLog.log('token_auth_db_fallback_done', { durationMs: Number((performance.now() - authStart).toFixed(2)), dbTokenValid: Boolean(tokenData) });

    if (tokenData) {
      try {
        await redisClient.setex(tokenCacheKey, TOKEN_CACHE_TTL_SECONDS, JSON.stringify(tokenData));
        chatLog.log('token_auth_cache_set', { tokenCacheKey: 'chatbot:token:<sha256>', ttlSeconds: TOKEN_CACHE_TTL_SECONDS, durationMs: Number((performance.now() - authStart).toFixed(2)), businessId: tokenData.businessId, botId: tokenData.botId, namespace: tokenData.namespace });
      } catch (error) {
        chatLog.error('redis_error', error, { operation: 'token_auth_cache_write', fallback: 'continue_without_cache' });
      }
    }
  }

  if (!tokenData?.namespace) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }

  req.chatbotToken = token;
  req.namespace = tokenData.namespace;
  req.businessId = tokenData.businessId || null;
  req.botId = tokenData.botId || tokenData.namespace;
  chatLog.with({ namespace: tokenData.namespace, businessId: tokenData.businessId || null, botId: tokenData.botId || null });
  const totalMs = Number((performance.now() - authStart).toFixed(2));
  chatLog.log('token_auth_done', { durationMs: totalMs, redisTokenCacheHit: req.redisTokenCacheHit });
  if (totalMs > 200) chatLog.warn('slow_token_auth', { durationMs: totalMs });
  next();
}
