import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL;

if (!redisUrl) {
  throw new Error('BullMQ Redis connection requires REDIS_URL or REDIS_PRIVATE_URL to be set.');
}

export const connection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});
