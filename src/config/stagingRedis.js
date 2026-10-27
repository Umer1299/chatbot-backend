import { isInfraStaging, assertInfraStaging } from './infraStaging.js';

export function assertStagingRedisUrl(env = process.env) {
  if (!isInfraStaging(env)) return false;
  assertInfraStaging(env);
  let url;
  try { url = new URL(env.REDIS_URL || ''); } catch { throw new Error('Invalid staging Redis URL'); }
  if (env.STAGING_DEPLOYMENT_PLATFORM === 'digitalocean' &&
      (url.protocol !== 'rediss:' || !url.password ||
       !/^[a-z0-9-]+\.db\.ondigitalocean\.com$/.test(url.hostname) ||
       !/^[1-9]\d*$/.test(url.port) || url.username !== (env.STAGING_REDIS_USERNAME || '')))
    throw new Error('DigitalOcean Valkey requires TLS, password and a pinned staging endpoint');
  if (!['redis:', 'rediss:'].includes(url.protocol) ||
      (env.STAGING_DEPLOYMENT_PLATFORM !== 'digitalocean' && !url.username) || !url.password ||
      !url.hostname || url.hostname !== env.STAGING_REDIS_HOST ||
      url.pathname !== '/' || url.search || url.hash ||
      env.STAGING_REDIS_URL !== env.REDIS_URL)
    throw new Error('Staging Redis requires a dedicated authenticated internal URL and pinned host');
  return true;
}
