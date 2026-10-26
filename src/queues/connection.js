import { Redis } from 'ioredis';
import { assertStagingRedisUrl } from '../config/stagingRedis.js';
assertStagingRedisUrl();
const redisUrl = process.env.REDIS_URL;
export const connection = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});
