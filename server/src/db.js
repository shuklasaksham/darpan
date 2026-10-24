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
    );
    CREATE TABLE IF NOT EXISTS shoot_plans (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      brief JSONB NOT NULL,
      plan JSONB NOT NULL,
      agent_run_id TEXT
    );
    ALTER TABLE takes ADD COLUMN IF NOT EXISTS plan_id BIGINT REFERENCES shoot_plans(id);
    ALTER TABLE takes ADD COLUMN IF NOT EXISTS shot_index INT;
    ALTER TABLE takes ADD COLUMN IF NOT EXISTS review JSONB;
  `);
}
