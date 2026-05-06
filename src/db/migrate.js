import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigrations() {
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE_URL is not configured. Migrations not executed.');
    return;
  }

  const migrationsDir = path.join(__dirname, 'migrations');

  // Get all .sql files sorted by name (001, 002, …)
  const files = await fs.readdir(migrationsDir);
  const sqlFiles = files
    .filter(f => f.endsWith('.sql'))
    .sort();

  if (sqlFiles.length === 0) {
    console.log('No migration files found.');
    return;
  }

  for (const file of sqlFiles) {
    const filePath = path.join(migrationsDir, file);
    console.log(`Running migration: ${file}`);

    const sql = await fs.readFile(filePath, 'utf8');
    if (!sql.trim()) {
      throw new Error(`Migration file is empty: ${file}`);
    }

    await pool.query(sql);
    console.log(`✅ Migration complete: ${file}`);
  }

  console.log('All migrations completed successfully');
}

runMigrations()
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
