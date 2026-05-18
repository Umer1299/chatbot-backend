import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL;
let redisClient = null;

if (!redisUrl) {
  console.warn(JSON.stringify({ event: 'redis_disabled', reason: 'missing_REDIS_URL' }));
  redisClient = {
    get: async () => null,
    setex: async () => null,
    call: async () => null,
    del: async () => 0,
    keys: async () => [],
    ping: async () => 'PONG',
  };
} else {
  redisClient = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 50, 2000),
  });
  redisClient.on('connect', () => console.log(JSON.stringify({ event: 'redis_connected' })));
  redisClient.on('error', (err) => console.error(JSON.stringify({ event: 'redis_error', error: err?.message || 'unknown_error' })));
}

export { redisClient };
