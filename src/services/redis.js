import Redis from 'ioredis';
import { isInfraStaging } from '../config/infraStaging.js';
import { stagingRedisConnectionOptions } from '../config/stagingRedis.js';
export const redisClient = new Redis(process.env.REDIS_URL, {
  ...stagingRedisConnectionOptions(),
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});
redisClient.on('connect', () => console.log('✅ Redis connected'));
redisClient.on('error', (err) => console.error('Redis error:', isInfraStaging() ? { code: err.code || 'CONNECTION_FAILED' } : err));
