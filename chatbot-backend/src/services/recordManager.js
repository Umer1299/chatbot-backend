import { createHash } from 'crypto';
import { redisClient } from './redis.js';

export async function isDuplicateContent(content, namespace) {
  const hash = createHash('sha256').update(content).digest('hex');
  const key = `dedup:${namespace}:${hash}`;
  const exists = await redisClient.get(key);
  if (exists) return true;
  await redisClient.setex(key, 30 * 24 * 3600, '1');
  return false;
}