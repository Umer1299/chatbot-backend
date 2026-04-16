import { Redis } from 'ioredis';
const redisUrl = process.env.REDIS_URL;
export const connection = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});