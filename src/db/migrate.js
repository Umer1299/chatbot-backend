import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE_URL is not configured. Migration file was created but not executed.');
    return;
  }

  const migrationPath = path.join(
    __dirname,
    'migrations',
    '001_initial_schema.sql'
  );

  console.log('Running ChatflowAI initial schema migration...');
  console.log(`Reading migration file: ${migrationPath}`);

  const sql = await fs.readFile(migrationPath, 'utf8');

  if (!sql.trim()) {
    throw new Error('Migration SQL file is empty');
  }

  console.log('Executing schema...');

  await pool.query(sql);

  console.log('Migration completed successfully');
}

runMigration()
  .catch((error) => {
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch (error) {
      console.error('Failed to close database pool:', error.message);
    }
  });
