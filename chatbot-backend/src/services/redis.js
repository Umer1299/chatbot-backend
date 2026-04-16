import Redis from 'ioredis';
export const redisClient = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});
redisClient.on('connect', () => console.log('✅ Redis connected'));
redisClient.on('error', (err) => console.error('Redis error:', err));