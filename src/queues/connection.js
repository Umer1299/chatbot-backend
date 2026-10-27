import { Redis } from 'ioredis';
import { stagingRedisConnectionOptions } from '../config/stagingRedis.js';
const redisUrl = process.env.REDIS_URL;
export const connection = new Redis(redisUrl, {
  ...stagingRedisConnectionOptions(),
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});
