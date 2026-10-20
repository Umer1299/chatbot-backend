import { createHash } from 'crypto';
import { redisClient } from './redis.js';

const keyFor = (content, namespace) => `dedup:v2:${namespace}:${createHash('sha256').update(content).digest('hex')}`;

export async function isDuplicateContent(content, namespace) {
  return Boolean(await redisClient.get(keyFor(content, namespace)));
}

// Only successful callers may mark content. Redis is an optimization, not proof
// that a failed upload was ingested; database content is rechecked on retries.
export async function markContentProcessed(content, namespace) {
  try { await redisClient.setex(keyFor(content, namespace), 30 * 24 * 3600, '1'); }
  catch { /* A cache failure must not turn committed knowledge into a failed upload. */ }
}
