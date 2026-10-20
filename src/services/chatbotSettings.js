import { randomUUID } from 'node:crypto';
import pool from '../db/pool.js';
import { redisClient } from './redis.js';

const CACHE_TTL_SECONDS = 300;
const cacheKey = (namespace, revision) => `chatbot_settings:${namespace}:${revision}`;

function policyUnavailable(code = 'BOT_DOMAIN_POLICY_UNAVAILABLE') {
  return Object.assign(new Error('Bot domain policy unavailable'), { status: 503, code });
}

export function validateChatbotSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
      !Array.isArray(settings.allowedDomains) ||
      settings.allowedDomains.some(domain => typeof domain !== 'string' || !domain.trim())) {
    throw policyUnavailable('INVALID_BOT_SETTINGS');
  }
  return settings;
}

async function cacheSettings(namespace, row) {
  try {
    await redisClient.setex(cacheKey(namespace, row.revision), CACHE_TTL_SECONDS, JSON.stringify(row.settings));
  } catch {
    // Cache availability must not change a durable policy's authorization result.
  }
}

export async function saveChatbotSettings(namespace, settings) {
  validateChatbotSettings(settings);
  const { rows } = await pool.query(
    `INSERT INTO chatbot_settings (namespace, settings, revision)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (namespace) DO UPDATE
     SET settings=EXCLUDED.settings, revision=EXCLUDED.revision, deleted=false, updated_at=NOW()
     RETURNING settings, revision`,
    [namespace, JSON.stringify(settings), randomUUID()],
  );
  await cacheSettings(namespace, rows[0]);
  return rows[0].settings;
}

async function loadDurableSettings(namespace) {
  const { rows } = await pool.query('SELECT settings, revision FROM chatbot_settings WHERE namespace=$1 AND deleted=false', [namespace]);
  if (!rows[0]) throw policyUnavailable();
  validateChatbotSettings(rows[0].settings);
  await cacheSettings(namespace, rows[0]);
  return rows[0].settings;
}

// One-time bridge for settings created before the durable table existed.
// Missing/expired/malformed legacy settings never imply unrestricted access.
async function importLegacySettings(namespace) {
  let raw;
  try { raw = await redisClient.get(`chatbot:${namespace}`); }
  catch { throw policyUnavailable(); }
  if (!raw) throw policyUnavailable('BOT_SETTINGS_MISSING');
  let settings;
  try { settings = validateChatbotSettings(JSON.parse(raw)); }
  catch { throw policyUnavailable('INVALID_BOT_SETTINGS'); }
  await pool.query(
    `INSERT INTO chatbot_settings (namespace, settings, revision)
     VALUES ($1, $2::jsonb, $3) ON CONFLICT (namespace) DO NOTHING`,
    [namespace, JSON.stringify(settings), randomUUID()],
  );
  // A concurrent admin update wins. Never overwrite it with legacy cache data.
  return loadDurableSettings(namespace);
}

export async function getChatbotSettings(namespace) {
  // Always consult the durable revision first: cache expiry, failed invalidation,
  // and late writes of old cache entries cannot restore an outdated allowlist.
  const { rows } = await pool.query('SELECT revision, deleted FROM chatbot_settings WHERE namespace=$1', [namespace]);
  if (!rows[0]) return importLegacySettings(namespace);
  if (rows[0].deleted) throw policyUnavailable('BOT_SETTINGS_MISSING');
  try {
    const raw = await redisClient.get(cacheKey(namespace, rows[0].revision));
    if (raw) return validateChatbotSettings(JSON.parse(raw));
  } catch {
    // Cache errors/corruption fall back to PostgreSQL, never to allow-all.
  }
  return loadDurableSettings(namespace);
}

export async function listChatbotSettings() {
  const { rows } = await pool.query('SELECT namespace, settings, deleted FROM chatbot_settings ORDER BY namespace');
  const known = new Set(rows.map(row => row.namespace));
  const result = rows.filter(row => !row.deleted)
    .map(row => ({ namespace: row.namespace, settings: validateChatbotSettings(row.settings) }));
  // Preserve listing for surviving legacy configurations during rollout.
  let legacyKeys = [];
  try { legacyKeys = await redisClient.keys('chatbot:*'); } catch { /* Durable rows remain available. */ }
  for (const key of legacyKeys) {
    const namespace = key.slice('chatbot:'.length);
    if (!known.has(namespace)) result.push({ namespace, settings: await getChatbotSettings(namespace) });
  }
  return result;
}

export async function deleteChatbotSettings(namespace) {
  // Revisions are random and never reused, even when a namespace is recreated.
  // Old revision cache entries expire naturally and cannot authorize requests.
  // Keep a tombstone so stale legacy Redis settings cannot resurrect a deleted bot.
  await pool.query(`INSERT INTO chatbot_settings (namespace, settings, revision, deleted)
    VALUES ($1, '{"allowedDomains":[]}'::jsonb, $2, true)
    ON CONFLICT (namespace) DO UPDATE SET deleted=true, revision=EXCLUDED.revision, updated_at=NOW()`,
  [namespace, randomUUID()]);
  await redisClient.del(`chatbot:${namespace}`);
}
