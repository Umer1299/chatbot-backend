import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runStagingMigrations, validateMigrationTarget } from '../scripts/apply-staging-migrations.js';
import { REQUIRED_TABLES } from '../scripts/staging-schema.js';

const expectedFiles = [
  '001_initial_schema.sql', '002_plan_limits.sql', '003_models_and_disable.sql',
  '003_quick_answers.sql', '004_inquiries.sql', '005_security_boundaries.sql',
  '006_durable_chatbot_settings.sql', '007_knowledge_cache_revision.sql',
  '008_account_auth.sql', '009_agency_business_access.sql',
  '010_agent_foundation.sql', '011_agent_runtime.sql',
  '012_agent_chat_turn_claims.sql', '013_legacy_knowledge_mutation_claims.sql',
];
const testEnv = () => ({
  CHATFLOW_ENVIRONMENT: 'isolated-staging',
  STAGING_MIGRATION_CONFIRM: 'I_CONFIRM_EMPTY_STAGING_DATABASE',
  STAGING_DATABASE_URL: 'postgres://test:password@127.0.0.1:5432/chatflow_staging',
  DATABASE_URL: 'postgres://test:password@127.0.0.1:5432/chatflow_staging',
});

test('staging migration target requires the isolated marker, confirmation and dedicated database name', () => {
  assert.throws(() => validateMigrationTarget({ ...testEnv(), CHATFLOW_ENVIRONMENT: 'production' }), /isolated-staging/);
  assert.throws(() => validateMigrationTarget({ ...testEnv(), STAGING_MIGRATION_CONFIRM: '' }), /STAGING_MIGRATION_CONFIRM/);
  assert.throws(() => validateMigrationTarget({ ...testEnv(), STAGING_DATABASE_URL: 'postgres://x:y@host/prod' }), /chatflow_staging/);
});

test('unsafe migration preconditions refuse before a database connection', async () => {
  let connections = 0;
  await assert.rejects(runStagingMigrations({
    env: { ...testEnv(), STAGING_MIGRATION_CONFIRM: '' },
    clientFactory: async () => { connections++; throw new Error('must not connect'); },
  }), /STAGING_MIGRATION_CONFIRM/);
  assert.equal(connections, 0);
});

test('migration runner refuses a non-empty public schema without executing SQL', async () => {
  const calls = [];
  const client = {
    async connect() {},
    async query(sql) {
      calls.push(sql);
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
      if (sql.includes('current_database')) return { rows: [{ name: 'chatflow_staging', server_version: '16.3' }], rowCount: 1 };
      if (sql.includes('FROM pg_class')) return { rows: [{ relname: 'businesses' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  };
  await assert.rejects(runStagingMigrations({ env: testEnv(), clientFactory: async () => client }), /existing public schema objects/);
  assert.equal(calls.some(sql => sql.includes('SELECT 1;')), false);
  assert.ok(calls.some(sql => sql.includes('pg_advisory_unlock')));
});

test('fresh staging migration runner applies only the exact ordered 001–013 set and checks vector/ledger', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatflow-staging-migrations-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const file of expectedFiles) await fs.writeFile(path.join(directory, file), `SELECT '${file}';`);

  const applied = [];
  const client = {
    async connect() {},
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
      if (sql.includes('current_database')) return { rows: [{ name: 'chatflow_staging', server_version: '16.3' }], rowCount: 1 };
      if (sql.includes('FROM pg_class')) return { rows: [], rowCount: 0 };
      if (sql.includes('to_regclass')) return { rows: [], rowCount: 0 };
      if (sql.includes('pg_trigger')) {
        const rows = applied.length ? [
          'knowledge_revision_insert', 'knowledge_revision_update', 'knowledge_revision_delete',
          'agent_knowledge_revision_insert', 'agent_knowledge_revision_update', 'agent_knowledge_revision_delete',
        ].map(tgname => ({ tgname })) : [];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("extname='vector'")) return { rows: applied.length ? [{ ok: 1 }] : [], rowCount: applied.length ? 1 : 0 };
      if (sql.includes('chatflow_schema_migrations')) {
        const rows = applied.length ? ['008', '009', '010', '011', '012', '013'].map(version => ({ version })) : [];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
      applied.push(sql.match(/SELECT '([^']+)'/)?.[1]);
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  };
  const result = await runStagingMigrations({
    env: testEnv(),
    clientFactory: async () => client,
    migrationsDirectory: directory,
  });
  assert.deepEqual(applied, expectedFiles);
  assert.deepEqual(result.migrations, expectedFiles);
  assert.equal(result.ledger.length, 6);
});

test('migration runner is a no-op when the complete staging schema is already present', async () => {
  const client = {
    async connect() {},
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
      if (sql.includes('current_database')) return { rows: [{ name: 'chatflow_staging', server_version: '16.3' }], rowCount: 1 };
      if (sql.includes('chatflow_schema_migrations'))
        return { rows: ['008', '009', '010', '011', '012', '013'].map(version => ({ version })), rowCount: 6 };
      if (sql.includes('to_regclass')) return { rows: [], rowCount: 0 };
      if (sql.includes('pg_trigger'))
        return { rows: [
          'knowledge_revision_insert', 'knowledge_revision_update', 'knowledge_revision_delete',
          'agent_knowledge_revision_insert', 'agent_knowledge_revision_update', 'agent_knowledge_revision_delete',
        ].map(tgname => ({ tgname })), rowCount: 6 };
      if (sql.includes("extname='vector'")) return { rows: [{ ok: 1 }], rowCount: 1 };
      if (sql.includes('FROM pg_class')) throw new Error('Complete schema must not be treated as an empty schema.');
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  };
  const result = await runStagingMigrations({ env: testEnv(), clientFactory: async () => client });
  assert.equal(result.alreadyApplied, true);
  assert.deepEqual(result.migrations, []);
});

test('migration runner rejects every missing legacy table despite a completed migration ledger and performs no writes', async () => {
  const legacyTables = [
    'model_configs', 'quick_answers', 'scrape_jobs', 'notifications',
    'pipeline_stages', 'analytics_daily',
  ];
  for (const missingTable of legacyTables) {
    assert.ok(REQUIRED_TABLES.includes(missingTable), `${missingTable} is part of the shared required schema`);
    const calls = [];
    const client = {
      async connect() {},
      async query(sql) {
        calls.push(sql);
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
        if (sql.includes('current_database')) return { rows: [{ name: 'chatflow_staging', server_version: '16.3' }], rowCount: 1 };
        if (sql.includes('chatflow_schema_migrations'))
          return { rows: ['008', '009', '010', '011', '012', '013'].map(version => ({ version })), rowCount: 6 };
        if (sql.includes('to_regclass')) return { rows: [{ name: missingTable }], rowCount: 1 };
        if (sql.includes('pg_trigger'))
          return { rows: [
            'knowledge_revision_insert', 'knowledge_revision_update', 'knowledge_revision_delete',
            'agent_knowledge_revision_insert', 'agent_knowledge_revision_update', 'agent_knowledge_revision_delete',
          ].map(tgname => ({ tgname })), rowCount: 6 };
        if (sql.includes("extname='vector'")) return { rows: [{ ok: 1 }], rowCount: 1 };
        if (sql.includes('FROM pg_class')) return { rows: [{ relname: 'chatflow_schema_migrations' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      async end() {},
    };
    await assert.rejects(
      runStagingMigrations({ env: testEnv(), clientFactory: async () => client }),
      new RegExp(`missing required tables: ${missingTable}`),
    );
    assert.ok(calls.every(sql => /^\s*SELECT\b/i.test(sql)), 'only read-only checks and advisory locks may run');
    assert.equal(calls.some(sql => sql.includes("SELECT '001_")), false, 'no migration SQL was applied');
  }
});

test('migration runner rejects missing new agent tables even when the ledger is complete', async () => {
  const missingTables = ['agents', 'agent_configs', 'website_deployments', 'agent_knowledge_chunks', 'agent_chat_sessions'];
  for (const missingTable of missingTables) {
    assert.ok(REQUIRED_TABLES.includes(missingTable));
    const client = {
      async connect() {},
      async query(sql) {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
        if (sql.includes('current_database')) return { rows: [{ name: 'chatflow_staging', server_version: '16.3' }], rowCount: 1 };
        if (sql.includes('chatflow_schema_migrations'))
          return { rows: ['008', '009', '010', '011', '012', '013'].map(version => ({ version })), rowCount: 6 };
        if (sql.includes('to_regclass')) return { rows: [{ name: missingTable }], rowCount: 1 };
        if (sql.includes('pg_trigger'))
          return { rows: [
            'knowledge_revision_insert', 'knowledge_revision_update', 'knowledge_revision_delete',
            'agent_knowledge_revision_insert', 'agent_knowledge_revision_update', 'agent_knowledge_revision_delete',
          ].map(tgname => ({ tgname })), rowCount: 6 };
        if (sql.includes("extname='vector'")) return { rows: [{ ok: 1 }], rowCount: 1 };
        if (sql.includes('FROM pg_class')) return { rows: [{ relname: 'agents' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      async end() {},
    };
    await assert.rejects(
      runStagingMigrations({ env: testEnv(), clientFactory: async () => client }),
      new RegExp(`missing required tables: ${missingTable}`),
    );
  }
});

test('migration runner refuses PostgreSQL versions other than 16 before schema inspection', async () => {
  const calls = [];
  const client = {
    async connect() {},
    async query(sql) {
      calls.push(sql);
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
      if (sql.includes('current_database')) return { rows: [{ name: 'chatflow_staging', server_version: '15.8' }], rowCount: 1 };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
      throw new Error('Schema query must not run on unsupported PostgreSQL.');
    },
    async end() {},
  };
  await assert.rejects(runStagingMigrations({ env: testEnv(), clientFactory: async () => client }), /PostgreSQL 16/);
  assert.equal(calls.some(sql => sql.includes('chatflow_schema_migrations')), false);
});
