import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { stagingDatabaseSsl } from '../src/db/stagingTls.js';
import { REQUIRED_LEDGER_VERSIONS, REQUIRED_TABLES, REQUIRED_TRIGGERS } from './staging-schema.js';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED_CONFIRMATION = 'I_CONFIRM_EMPTY_STAGING_DATABASE';
const EXPECTED_DATABASE = 'chatflow_staging';
const EXPECTED_LEDGER = REQUIRED_LEDGER_VERSIONS;
const EXPECTED_MIGRATIONS = [
  '001_initial_schema.sql', '002_plan_limits.sql', '003_models_and_disable.sql',
  '003_quick_answers.sql', '004_inquiries.sql', '005_security_boundaries.sql',
  '006_durable_chatbot_settings.sql', '007_knowledge_cache_revision.sql',
  '008_account_auth.sql', '009_agency_business_access.sql',
  '010_agent_foundation.sql', '011_agent_runtime.sql',
  '012_agent_chat_turn_claims.sql', '013_legacy_knowledge_mutation_claims.sql',
];
export function validateMigrationTarget(env) {
  if (env.STAGING_REHEARSAL_MODE === 'infra-only')
    throw new Error('Migrations are forbidden in infrastructure-only staging');
  if (env.CHATFLOW_ENVIRONMENT !== 'isolated-staging')
    throw new Error('CHATFLOW_ENVIRONMENT must be isolated-staging.');
  if (env.STAGING_MIGRATION_CONFIRM !== REQUIRED_CONFIRMATION)
    throw new Error(`Set STAGING_MIGRATION_CONFIRM=${REQUIRED_CONFIRMATION} only for a newly created empty staging database.`);
  let url;
  try { url = new URL(env.STAGING_DATABASE_URL || ''); } catch {
    throw new Error('STAGING_DATABASE_URL must be a valid PostgreSQL URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || decodeURIComponent(url.pathname.slice(1)) !== EXPECTED_DATABASE)
    throw new Error(`Migration target must be the dedicated ${EXPECTED_DATABASE} database.`);
  let appUrl;
  try { appUrl = new URL(env.DATABASE_URL || ''); } catch {
    throw new Error('DATABASE_URL must point to the same staging database as STAGING_DATABASE_URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(appUrl.protocol) || appUrl.href !== url.href)
    throw new Error('DATABASE_URL must point to the same staging database as STAGING_DATABASE_URL.');
  return url;
}

async function makeClient(url, env) {
  return new Client({
    connectionString: url.href,
    ssl: stagingDatabaseSsl(url.href, env),
    connectionTimeoutMillis: 5000,
  });
}

export async function runStagingMigrations({
  env = process.env,
  clientFactory = makeClient,
  migrationsDirectory = path.resolve(__dirname, '../src/db/migrations'),
} = {}) {
  const target = validateMigrationTarget(env);
  const client = await clientFactory(target, env);
  let locked = false;
  try {
    await client.connect();
    // Separate key from per-migration transaction locks (145008).
    const lock = await client.query('SELECT pg_try_advisory_lock(145013) AS locked');
    locked = lock.rows[0]?.locked === true;
    if (!locked) throw new Error('Another migration process holds the migration lock.');

    const targetInfo = await client.query('SELECT current_database() AS name, current_setting($1) AS server_version', ['server_version']);
    const pgMajor = Number.parseInt(targetInfo.rows[0]?.server_version?.split('.')[0], 10);
    if (targetInfo.rows[0]?.name !== EXPECTED_DATABASE || pgMajor !== 16)
      throw new Error('Connected target must be PostgreSQL 16 database chatflow_staging.');

    const versionsPresent = await client.query(`
      SELECT version FROM chatflow_schema_migrations WHERE version=ANY($1::text[])
    `, [EXPECTED_LEDGER]).catch(() => null);
    const relationsPresent = await client.query(
      'SELECT name FROM unnest($1::text[]) AS expected(name) WHERE to_regclass(format(\'public.%I\', name)) IS NULL',
      [REQUIRED_TABLES],
    ).catch(() => null);
    const triggersPresent = await client.query(
      'SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname=ANY($1::text[])',
      [REQUIRED_TRIGGERS],
    ).catch(() => null);
    const vectorPresent = await client.query("SELECT 1 FROM pg_extension WHERE extname='vector'").catch(() => null);
    if (!relationsPresent)
      throw new Error('Unable to verify required staging tables; refusing to apply migrations. Check the database permissions and retry only after review.');
    const missingTables = relationsPresent.rows.map((row) => row.name);
    const recorded = new Set((versionsPresent?.rows || []).map((row) => row.version));
    const migrationComplete = versionsPresent && missingTables.length === 0 &&
      triggersPresent?.rowCount === REQUIRED_TRIGGERS.length && vectorPresent?.rowCount === 1 &&
      EXPECTED_LEDGER.every((version) => recorded.has(version));
    if (migrationComplete)
      return { migrations: [], ledger: [...recorded].sort(), alreadyApplied: true };

    const existing = await client.query(`
      SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')
      LIMIT 1
    `);
    if (existing.rowCount) {
      if (missingTables.length)
        throw new Error(`Refusing to migrate an initialized staging schema with missing required tables: ${missingTables.join(', ')}. No migrations were applied. Restore or repair the schema through an approved recovery plan; this command only initializes an empty staging database.`);
      throw new Error('Refusing to migrate a database with existing public schema objects; this command only initializes a fresh staging database.');
    }

    const files = (await fs.readdir(migrationsDirectory))
      .filter((file) => /^\d{3}_.+\.sql$/.test(file))
      .sort();
    if (JSON.stringify(files) !== JSON.stringify(EXPECTED_MIGRATIONS))
      throw new Error('Expected migration sequence 001–013 was not found exactly.');

    for (const file of files) {
      const sql = await fs.readFile(path.join(migrationsDirectory, file), 'utf8');
      if (!sql.trim()) throw new Error(`Migration ${file} is empty.`);
      await client.query(sql);
    }

    const versions = await client.query('SELECT version FROM chatflow_schema_migrations WHERE version=ANY($1::text[])', [EXPECTED_LEDGER]);
    const applied = new Set(versions.rows.map((row) => row.version));
    if (EXPECTED_LEDGER.some((version) => !applied.has(version)))
      throw new Error('Migration ledger verification failed.');
    const vector = await client.query("SELECT 1 FROM pg_extension WHERE extname='vector'");
    if (vector.rowCount !== 1) throw new Error('pgvector extension verification failed.');
    return { migrations: files, ledger: [...applied].sort() };
  } catch (error) {
    error.stagingMigrationFailure = true;
    throw error;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(145013)').catch(() => {});
    await client.end().catch(() => {});
  }
}

async function main() {
  try {
    const result = await runStagingMigrations();
    if (result.alreadyApplied)
      console.log(`PASS migrations 001–013 are already complete; no SQL was applied. Ledger versions ${result.ledger.join(', ')} verified.`);
    else
      console.log(`PASS applied ${result.migrations.length} migrations to the empty staging database; ledger versions ${result.ledger.join(', ')} verified.`);
  } catch (error) {
    console.error(`${error.stagingMigrationFailure ? 'FAIL' : 'BLOCKED'} staging migration: ${error.message}`);
    console.error('No database URL, password, or query text was printed. A failed run may have partially applied SQL; do not rerun it. Inspect the disposable database and recreate it only after confirming it contains no needed data.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('FAIL staging migration command; secret values were not printed.');
    process.exitCode = 1;
  });
