import { isIP } from 'node:net';
import { isInfraStaging, assertInfraStaging } from '../config/infraStaging.js';

// The pg URL's sslmode/sslrootcert options can override an explicit ssl object.
export function stagingDatabaseSsl(connectionString, env = process.env) {
  if (!isInfraStaging(env))
    return env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
  assertInfraStaging(env);
  let url;
  try { url = new URL(connectionString); } catch { throw new Error('Invalid staging PostgreSQL URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || isIP(url.hostname.replace(/^\[|\]$/g, '')))
    throw new Error('Staging PostgreSQL requires a DNS hostname');
  if (env.STAGING_DEPLOYMENT_PLATFORM === 'digitalocean' &&
      (!/^[a-z0-9-]+\.db\.ondigitalocean\.com$/.test(url.hostname) ||
       url.hostname !== env.STAGING_DATABASE_HOST || !url.username || !url.password ||
       !url.pathname || url.pathname === '/' || /prod(?:uction)?/i.test(url.pathname) ||
       url.search || url.hash))
    throw new Error('DigitalOcean PostgreSQL requires a pinned staging host and dedicated database credentials');
  for (const key of url.searchParams.keys()) {
    if (/^ssl/i.test(key)) throw new Error('PostgreSQL URL TLS overrides are forbidden');
  }
  const ca = env.STAGING_DATABASE_CA_PEM;
  if (!ca || !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(ca))
    throw new Error('Staging PostgreSQL requires a trusted CA certificate');
  // The servername is derived from the validated URL, never an independent untrusted override.
  if (env.STAGING_DATABASE_TLS_SERVERNAME && env.STAGING_DATABASE_TLS_SERVERNAME !== url.hostname)
    throw new Error('Staging PostgreSQL TLS servername must match the database URL hostname');
  return { ca, servername: url.hostname, rejectUnauthorized: true };
}
