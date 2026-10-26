const REQUIRED = {
  CHATFLOW_ENVIRONMENT: 'isolated-staging',
  STAGING_REHEARSAL_MODE: 'infra-only',
  AGENT_WEBSITE_ENABLED: 'false',
  STAGING_DISABLE_LEGACY_FILE_UPLOADS: 'true',
  STAGING_DISABLE_SCRAPING: 'true',
  STAGING_DISABLE_PROVIDERS: 'true',
  ACCOUNT_AUTH_ENABLED: 'false',
  ACCOUNT_PROXY_MODE: 'direct',
};

const FORBIDDEN_CREDENTIALS = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'FIRECRAWL_API_KEY',
  'FIRECRAWL_OFFICIAL_API_KEY', 'FIRECRAWL_SELF_HOSTED_API_KEY',
  'FIRECRAWL_SELF_HOSTED_AUTHORIZATION', 'FIRECRAWL_BASIC_AUTH',
  'RESEND_API_KEY', 'PINECONE_API_KEY', 'BUBBLE_API_KEY',
  'ADMIN_API_KEY', 'JWT_SECRET', 'ACCOUNT_AUTH_SECRET',
];

export function isInfraStaging(env = process.env) {
  return env.CHATFLOW_ENVIRONMENT === 'isolated-staging' || env.STAGING_REHEARSAL_MODE !== undefined;
}

export function assertInfraStaging(env = process.env) {
  if (!isInfraStaging(env)) return false;
  for (const [key, expected] of Object.entries(REQUIRED)) {
    if (env[key] !== expected) throw new Error(`Infra-only staging requires ${key}=${expected}`);
  }
  if (env.TRUSTED_PROXY_CIDRS?.trim()) throw new Error('Infra-only direct mode forbids trusted proxy CIDRs');
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])(?::[1-9]\d{0,4})?$/.test(env.STAGING_ALLOWED_HOST || '') ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(env.STAGING_REDIS_HOST || ''))
    throw new Error('Infra-only staging requires explicit DNS Host and Redis host');
  for (const key of FORBIDDEN_CREDENTIALS) {
    if (env[key]?.trim()) throw new Error(`Infra-only staging forbids ${key}`);
  }
  // Catch credentials introduced by a later SDK without waiting for this list
  // to be updated. Database/Redis URLs are the only authorized service secrets.
  for (const [key, value] of Object.entries(env)) {
    if (/(^|_)(API_KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)$/.test(key) && String(value || '').trim())
      throw new Error(`Infra-only staging forbids credential environment key ${key}`);
  }
  for (const key of ['STAGING_MAX_CONNECTIONS', 'STAGING_MAX_ACTIVE_REQUESTS', 'STAGING_REQUEST_TIMEOUT_MS']) {
    if (!/^[1-9]\d*$/.test(env[key] || '') || !Number.isSafeInteger(Number(env[key])))
      throw new Error(`Infra-only staging requires a positive integer ${key}`);
  }
  return true;
}

export function assertScrapingDisabled(env = process.env) {
  if (isInfraStaging(env)) {
    assertInfraStaging(env);
    throw new Error('Scraping is disabled in infrastructure-only staging');
  }
}

export function infraStagingGate(req, res, next) {
  if (!isInfraStaging()) return next();
  const hosts = [];
  for (let i = 0; i < (req.rawHeaders || []).length; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() === 'host') hosts.push(req.rawHeaders[i + 1]);
  }
  if (hosts.length !== 1 || hosts[0] !== process.env.STAGING_ALLOWED_HOST ||
      req.headers.host !== process.env.STAGING_ALLOWED_HOST)
    return res.status(400).end();
  if (req.headers['x-forwarded-for'] !== undefined || req.headers['forwarded'] !== undefined ||
      req.headers['x-real-ip'] !== undefined || req.headers['x-forwarded-host'] !== undefined ||
      req.headers['x-forwarded-proto'] !== undefined)
    return res.status(400).end();
  if (req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined)
    return res.status(413).end();
  if ((req.method === 'GET' || req.method === 'HEAD') &&
      (req.path === '/healthz' || req.path === '/readyz')) return next();
  return res.status(404).json({ error: 'Not available in infrastructure-only staging' });
}

let active = 0;
export function infraStagingConcurrency(req, res, next) {
  if (!isInfraStaging()) return next();
  if (active >= Number(process.env.STAGING_MAX_ACTIVE_REQUESTS)) return res.status(503).end();
  active++;
  res.once('close', () => { active--; });
  return next();
}
