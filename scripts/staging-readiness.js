import { pathToFileURL } from 'node:url';
import pg from 'pg';
import Redis from 'ioredis';
import { trustedProxySettings } from '../src/middleware/trustedProxy.js';

const { Pool } = pg;
const CONFIRM = 'I_CONFIRM_NON_PRODUCTION_STAGING';
const DB_NAME = 'chatflow_staging';
const REQUIRED_LEDGER_VERSIONS = ['008', '009', '010', '011', '012', '013'];
const REQUIRED_TABLES = [
  'businesses', 'bot_configs', 'knowledge_chunks', 'scrape_jobs', 'leads',
  'sessions', 'messages', 'notifications', 'pipeline_stages', 'analytics_daily',
  'model_configs', 'quick_answers', 'inquiries', 'chatbot_settings',
  'chatflow_schema_migrations', 'chatflow_user', 'chatflow_session',
  'chatflow_account', 'chatflow_verification', 'chatflow_organization',
  'chatflow_member', 'chatflow_invitation', 'chatflow_rate_limit',
  'agency_businesses', 'business_memberships', 'agents', 'agent_configs',
  'legacy_agent_mappings', 'website_deployments', 'agent_knowledge_sources',
  'agent_knowledge_chunks', 'agent_chat_sessions', 'agent_chat_messages',
  'agent_leads', 'agent_inquiries', 'agent_chat_turn_claims',
  'legacy_knowledge_mutation_claims',
];
const REQUIRED_TRIGGERS = [
  'knowledge_revision_insert', 'knowledge_revision_update',
  'knowledge_revision_delete', 'agent_knowledge_revision_insert',
  'agent_knowledge_revision_update', 'agent_knowledge_revision_delete',
];

const parseUrl = (value, protocols) => {
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
};

function add(results, name, status, detail) {
  results.push({ name, status, detail });
}

function checkEnvironment(env, nodeVersion) {
  const results = [];
  const [major, minor] = nodeVersion.replace(/^v/, '').split('.').map(Number);
  add(results, 'Node.js runtime', major > 22 || (major === 22 && minor >= 18) ? 'PASS' : 'FAIL',
    'Requires Node.js >=22.18.0; secret values are not displayed.');

  const db = parseUrl(env.STAGING_DATABASE_URL, ['postgres:', 'postgresql:']);
  const appDb = parseUrl(env.DATABASE_URL, ['postgres:', 'postgresql:']);
  const redis = parseUrl(env.STAGING_REDIS_URL, ['redis:', 'rediss:']);
  const appRedis = parseUrl(env.REDIS_URL, ['redis:', 'rediss:']);
  const dbName = db?.pathname ? decodeURIComponent(db.pathname.slice(1)) : '';
  const identitySafe = env.CHATFLOW_ENVIRONMENT === 'isolated-staging' &&
    env.STAGING_READINESS_CONFIRM === CONFIRM && dbName === DB_NAME &&
    db?.href === appDb?.href && redis?.href === appRedis?.href;
  add(results, 'Non-production target guard', identitySafe ? 'PASS' : 'BLOCKED',
    'Requires isolated-staging mode, explicit confirmation, database name chatflow_staging, and a Redis URL.');

  if (env.NODE_ENV !== 'production')
    add(results, 'Secure-cookie runtime mode', 'FAIL', 'Set NODE_ENV=production for HTTPS Secure cookies.');
  else add(results, 'Secure-cookie runtime mode', 'PASS', 'NODE_ENV enables Better Auth Secure cookies.');

  const origins = (env.ACCOUNT_TRUSTED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  const authUrl = parseUrl(env.ACCOUNT_AUTH_URL, ['https:']);
  const dashboardOrigins = (env.DASHBOARD_ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  const widgetOrigins = (env.WIDGET_ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  const trustedOriginsValid = origins.length > 0 && origins.every((origin) => {
    const parsed = parseUrl(origin, ['https:']);
    return parsed && !parsed.username && !parsed.password && parsed.origin === origin && !origin.includes('*');
  });
  const dashboardOriginsValid = dashboardOrigins.length > 0 && dashboardOrigins.every((origin) => {
    const parsed = parseUrl(origin, ['https:']);
    return parsed && parsed.origin === origin && !origin.includes('*');
  });
  const widgetOriginsValid = widgetOrigins.length > 0 && widgetOrigins.every((origin) => {
    const parsed = parseUrl(origin, ['https:']);
    return parsed && parsed.origin === origin && !origin.includes('*');
  });
  add(results, 'Legacy widget HTTPS origins', widgetOriginsValid ? 'PASS' : 'BLOCKED',
    'Set WIDGET_ALLOWED_ORIGINS to explicit HTTPS origins for legacy widget compatibility.');
  add(results, 'Legacy JWT secret', (env.JWT_SECRET || '').length >= 32 ? 'PASS' : 'BLOCKED',
    'Set a unique staging JWT_SECRET of at least 32 characters; never reuse production credentials.');
  let proxyValid = false;
  try {
    const proxy = trustedProxySettings(env);
    proxyValid = proxy.mode === 'trusted' && proxy.trust !== false;
  } catch { /* Report only status, never environment values. */ }
  const authReady = env.ACCOUNT_AUTH_ENABLED === 'true' && authUrl &&
    origins.includes(authUrl.origin) && trustedOriginsValid && dashboardOriginsValid &&
    (env.ACCOUNT_AUTH_SECRET || '').length >= 32 && proxyValid &&
    Boolean(env.RESEND_API_KEY?.trim()) && Boolean(env.RESEND_FROM_EMAIL?.trim());
  add(results, 'Better Auth, HTTPS origins, proxy and email', authReady ? 'PASS' : 'BLOCKED',
    'Requires enabled Better Auth, a 32+ character secret, exact HTTPS origins, trusted proxy CIDRs, and email delivery settings.');

  const featureOff = env.AGENT_WEBSITE_ENABLED !== 'true';
  add(results, 'Website-agent feature gate', featureOff ? 'PASS' : 'BLOCKED',
    featureOff ? 'Agent runtime remains disabled during preflight.' : 'Disable AGENT_WEBSITE_ENABLED before running preflight.');

  const providerReady = Boolean(env.OPENAI_API_KEY?.trim()) &&
    Boolean(env.OPENAI_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim());
  add(results, 'Provider credentials present', providerReady ? 'PASS' : 'BLOCKED',
    'OpenAI credentials are required for embeddings; at least one completion-provider credential is required. No provider call is made.');

  const appBase = parseUrl(env.STAGING_BASE_URL, ['https:']);
  const baseSafe = appBase && !appBase.username && !appBase.password && appBase.pathname === '/' &&
    appBase.hostname.includes('staging');
  add(results, 'Staging HTTPS URL', baseSafe ? 'PASS' : 'BLOCKED',
    'Set STAGING_BASE_URL to the staging service HTTPS origin after Render assigns its URL.');
  return { results, safeToConnect: identitySafe && db !== null && dbName === DB_NAME && redis !== null, dbName, baseUrl: baseSafe ? appBase.origin : null };
}

async function connectPostgres(connectionString, env) {
  const pool = new Pool({
    connectionString,
    ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 1,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 1000,
  });
  return pool;
}

async function connectRedis(connectionString) {
  const client = new Redis(connectionString, {
    lazyConnect: true,
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  client.on('error', () => {});
  await client.connect();
  return client;
}

async function checkDatabase(results, env, connect = connectPostgres) {
  let client;
  try {
    client = await connect(env.STAGING_DATABASE_URL, env);
    const identity = await client.query('SELECT current_database() AS name, current_setting($1) AS server_version', ['server_version']);
    if (identity.rows[0]?.name !== DB_NAME) {
      add(results, 'PostgreSQL connectivity and database identity', 'FAIL', 'Connected database name does not match chatflow_staging.');
      return;
    }
    add(results, 'PostgreSQL connectivity and database identity', 'PASS', 'Read-only connection reached chatflow_staging.');

    const ext = await client.query("SELECT extversion FROM pg_extension WHERE extname='vector'");
    add(results, 'pgvector extension', ext.rowCount === 1 ? 'PASS' : 'FAIL',
      ext.rowCount === 1 ? `pgvector ${ext.rows[0].extversion} is available.` : 'pgvector extension is not installed.');

    const missing = await client.query(
      'SELECT name FROM unnest($1::text[]) AS expected(name) WHERE to_regclass(format(\'public.%I\', name)) IS NULL',
      [REQUIRED_TABLES],
    );
    const versions = await client.query('SELECT version FROM chatflow_schema_migrations WHERE version=ANY($1::text[])', [REQUIRED_LEDGER_VERSIONS]);
    const applied = new Set(versions.rows.map((row) => row.version));
    const missingVersions = REQUIRED_LEDGER_VERSIONS.filter((version) => !applied.has(version));
    const migrationReady = missing.rowCount === 0 && missingVersions.length === 0;
    add(results, 'Migrations 001–013', migrationReady ? 'PASS' : 'FAIL',
      migrationReady ? 'Required legacy/agent tables exist and ledger versions 008–013 are recorded.' : 'Required schema objects or migration ledger versions are missing.');

    const triggers = await client.query(
      'SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname=ANY($1::text[])',
      [REQUIRED_TRIGGERS],
    );
    add(results, 'Knowledge revision triggers', triggers.rowCount === REQUIRED_TRIGGERS.length ? 'PASS' : 'FAIL',
      triggers.rowCount === REQUIRED_TRIGGERS.length ? 'Legacy and per-agent revision triggers are installed.' : 'One or more knowledge revision triggers are missing.');
  } catch {
    add(results, 'PostgreSQL connectivity and schema checks', 'FAIL', 'Connection or read-only schema check failed; inspect protected service logs.');
  } finally {
    await client?.end().catch(() => {});
  }
}

async function checkRedis(results, env, connect = connectRedis) {
  let redis;
  try {
    redis = await connect(env.STAGING_REDIS_URL);
    const pong = await redis.ping();
    const info = await redis.info('memory');
    const serverInfo = await redis.info('server');
    const redisVersion = /^redis_version:(.+)$/m.exec(serverInfo)?.[1]?.trim();
    const valkeyVersion = /^valkey_version:(.+)$/m.exec(serverInfo)?.[1]?.trim();
    const product = valkeyVersion ? 'Valkey' : 'Redis';
    const version = valkeyVersion || redisVersion;
    const major = version ? Number.parseInt(version.split('.')[0], 10) : NaN;
    const policy = /^maxmemory_policy:(.+)$/m.exec(info)?.[1]?.trim();
    if (pong !== 'PONG') {
      add(results, 'Redis connectivity', 'FAIL', 'Redis did not return PONG.');
    } else {
      add(results, 'Redis connectivity', 'PASS', 'Redis returned PONG.');
      add(results, 'Redis protocol service version', major === 7 ? 'PASS' : (version ? 'FAIL' : 'BLOCKED'),
        version ? `Observed ${product} ${version}; staging requires Redis 7-compatible protocol service.` : 'Redis INFO did not expose a server version; verify the managed service version manually.');
      add(results, 'Redis eviction policy', policy === 'noeviction' ? 'PASS' : (policy ? 'FAIL' : 'BLOCKED'),
        policy ? `Observed policy: ${policy}. BullMQ requires noeviction.` : 'Redis INFO did not expose maxmemory_policy; verify the managed service setting manually.');
    }
  } catch {
    add(results, 'Redis connectivity and eviction policy', 'FAIL', 'Redis connection or read-only policy check failed; inspect protected service logs.');
  } finally {
    await redis?.quit().catch(() => {});
  }
}

async function checkHttp(results, baseUrl, request = fetch) {
  if (!baseUrl) {
    add(results, 'HTTP liveness/readiness', 'BLOCKED', 'No valid staging HTTPS URL is configured.');
    return;
  }
  for (const [path, name] of [['/healthz', 'HTTP liveness'], ['/readyz', 'HTTP readiness']]) {
    try {
      const response = await request(new URL(path, baseUrl), { signal: AbortSignal.timeout(5000), redirect: 'error' });
      add(results, name, response.status === 200 ? 'PASS' : 'FAIL',
        response.status === 200 ? `Received HTTP ${response.status}.` : `Expected HTTP 200; received ${response.status}.`);
    } catch {
      add(results, name, 'FAIL', 'Staging health endpoint was unreachable or timed out.');
    }
  }
}

export async function runStagingReadiness({
  env = process.env,
  nodeVersion = process.version,
  httpRequest,
  postgresConnector = connectPostgres,
  redisConnector = connectRedis,
} = {}) {
  const checked = checkEnvironment(env, nodeVersion);
  if (checked.safeToConnect) {
    await checkDatabase(checked.results, env, postgresConnector);
    await checkRedis(checked.results, env, redisConnector);
  } else {
    add(checked.results, 'PostgreSQL connectivity/schema', 'NOT RUN', 'Target safety guard is not satisfied; no database connection was attempted.');
    add(checked.results, 'Redis connectivity/policy', 'NOT RUN', 'Target safety guard is not satisfied; no Redis connection was attempted.');
  }
  await checkHttp(checked.results, checked.baseUrl, httpRequest);
  return checked.results;
}

export function summarizeReadiness(results) {
  const counts = Object.fromEntries(['PASS', 'FAIL', 'BLOCKED', 'NOT RUN'].map((status) => [
    status, results.filter((result) => result.status === status).length,
  ]));
  return { counts, ready: counts.FAIL === 0 && counts.BLOCKED === 0 && counts['NOT RUN'] === 0 };
}

async function main() {
  const results = await runStagingReadiness();
  const summary = summarizeReadiness(results);
  for (const result of results)
    console.log(`${result.status.padEnd(7)} ${result.name}: ${result.detail}`);
  console.log(`SUMMARY ${JSON.stringify(summary.counts)}; ready=${summary.ready}`);
  if (!summary.ready) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('FAIL staging readiness command; inspect protected logs. Secret values were not printed.');
    process.exitCode = 1;
  });
