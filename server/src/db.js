import pg from 'pg';
import { config } from './config.js';

// Render's internal Postgres URLs don't use SSL; external ones (*.render.com) require it.
const ssl = config.databaseUrl?.includes('.render.com') ? { rejectUnauthorized: false } : false;

export const pool = config.databaseUrl
  ? new pg.Pool({ connectionString: config.databaseUrl, ssl, max: 5 })
  : null;

export async function migrate() {
  if (!pool) {
    console.warn('DATABASE_URL not set; running without a database');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS takes (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      original_name TEXT,
      size_bytes BIGINT NOT NULL,
      duration_seconds REAL,
      width INT,
      height INT
    )
  `);
}
