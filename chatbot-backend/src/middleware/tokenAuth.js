import { redisClient } from '../services/redis.js';

export async function tokenAuth(req, res, next) {
  const token = req.headers['x-chatbot-token'];
  if (!token) {
    return res.status(401).json({ error: 'Missing x-chatbot-token header' });
  }
  const namespace = await redisClient.get(`chatbot_token:${token}`);
  if (!namespace) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
  req.chatbotToken = token;
  req.namespace = namespace;
  next();
}