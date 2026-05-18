import { redisClient } from '../services/redis.js';
import { createChatLogger, getRequestId } from '../utils/chatPerfLogger.js';

export async function tokenAuth(req, res, next) {
  req.requestId = req.requestId || getRequestId(req);
  const chatLog = createChatLogger({ requestId: req.requestId, namespace: req.namespace || null });
  const token = req.headers['x-chatbot-token'];
  if (!token) {
    return res.status(401).json({ error: 'Missing x-chatbot-token header' });
  }
  chatLog.startTimer('redis_token_lookup');
  let namespace = null;
  try {
    namespace = await redisClient.get(`chatbot_token:${token}`);
  } catch (error) {
    chatLog.error('redis_error', error, { operation: 'token_lookup', fallback: 'deny_request' });
  }
  const redisDuration = chatLog.endTimer('redis_token_lookup', { redisTokenCacheHit: Boolean(namespace) });
  if (redisDuration && redisDuration > 200) chatLog.warn('slow_redis_operation', { operation: 'token_lookup', durationMs: redisDuration });
  if (!namespace) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
  req.chatbotToken = token;
  req.namespace = namespace;
  chatLog.with({ namespace });
  chatLog.log('token_auth_result', { tokenSource: 'redis', dbFallbackUsed: false });
  next();
}