import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { redisClient } from '../services/redis.js';

export const sessionRateLimiter = rateLimit({
  store: new RedisStore({ sendCommand: (...args) => redisClient.call(...args) }),
  keyGenerator: (req) => {
    const token = req.chatbotToken || req.headers['x-chatbot-token'] || 'anonymous';
    const ip = req.ip;
    return `${token}:${ip}`;
  },
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please wait.' },
  standardHeaders: true,
});