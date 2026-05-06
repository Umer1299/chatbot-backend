import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool
  .connect()
  .then((client) => {
    console.log('PostgreSQL pool connected successfully');
    client.release();
  })
  .catch((error) => {
    console.error('PostgreSQL pool connection error:', error.message);
  });

pool.on('error', (error) => {
  console.error('PostgreSQL pool error:', error.message);
});

export async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (error) {
    console.error('PostgreSQL query error:', { text, error: error.message });
    throw error;
  }
}

export default pool;
