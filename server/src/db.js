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
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      username TEXT NOT NULL UNIQUE CHECK (username = lower(username)),
      name TEXT NOT NULL,
      gender TEXT NOT NULL CHECK (gender IN ('woman', 'man', 'prefer_not_to_say')),
      niche TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      failed_pins INT NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    );
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
    ALTER TABLE takes ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE shoot_plans ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE takes ADD COLUMN IF NOT EXISTS transcript TEXT;
    ALTER TABLE takes ADD COLUMN IF NOT EXISTS score INT;
    ALTER TABLE takes ADD COLUMN IF NOT EXISTS notes JSONB;
    ALTER TABLE takes ADD COLUMN IF NOT EXISTS features JSONB;
    ALTER TABLE takes ADD COLUMN IF NOT EXISTS notes_source TEXT;
    ALTER TABLE takes ADD COLUMN IF NOT EXISTS words JSONB;
    ALTER TABLE takes ADD COLUMN IF NOT EXISTS has_audio BOOLEAN;
    ALTER TABLE takes ADD COLUMN IF NOT EXISTS file_path TEXT;
    ALTER TABLE takes ADD COLUMN IF NOT EXISTS kept BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE takes ADD COLUMN IF NOT EXISTS trim_start REAL;
    ALTER TABLE takes ADD COLUMN IF NOT EXISTS trim_end REAL;
    ALTER TABLE takes ADD COLUMN IF NOT EXISTS caption_edits JSONB;
    ALTER TABLE takes ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
    ALTER TABLE takes ADD COLUMN IF NOT EXISTS aspect REAL;
    ALTER TABLE takes ADD COLUMN IF NOT EXISTS caption_words JSONB;
    ALTER TABLE takes ADD COLUMN IF NOT EXISTS language TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_until TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_dev BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_complimentary BOOLEAN NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS payments (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      merchant_order_reference TEXT NOT NULL UNIQUE,
      pine_order_id TEXT,
      amount_paise INT NOT NULL,
      status TEXT NOT NULL,
      pine_status TEXT,
      raw JSONB,
      paid_at TIMESTAMPTZ
    );
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'pinelabs';
    CREATE TABLE IF NOT EXISTS reels (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_id BIGINT REFERENCES shoot_plans(id),
      take_ids BIGINT[] NOT NULL,
      captions BOOLEAN NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      error TEXT,
      file_path TEXT,
      width INT,
      height INT,
      duration_seconds REAL
    );
    CREATE TABLE IF NOT EXISTS trend_cache (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    DELETE FROM trend_cache WHERE updated_at < now() - interval '7 days';
    DELETE FROM sessions WHERE expires_at < now();
  `);
}
