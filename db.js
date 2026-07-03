// Postgres data layer. Everything here is optional: if DATABASE_URL is not set the whole
// archive/auth feature is disabled and the app behaves exactly as before (stateless generator
// + counterparty fill flow). This keeps deploys safe until a database is provisioned.
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || '';
const enabled = !!DATABASE_URL;

// Railway (and most hosted PG) require SSL; local sockets/localhost do not.
const isLocal = /localhost|127\.0\.0\.1|@\/|host=\/tmp/.test(DATABASE_URL);
const pool = enabled
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      max: 5,
    })
  : null;

async function query(text, params) {
  if (!pool) throw new Error('Database not configured');
  return pool.query(text, params);
}

async function init() {
  if (!pool) return false;
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      google_sub    TEXT,
      name          TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Idempotent migrations for databases created before Google login was added.
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;`);
  await query(`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_key ON users (google_sub) WHERE google_sub IS NOT NULL;`);
  await query(`
    CREATE TABLE IF NOT EXISTS agreements (
      id                 SERIAL PRIMARY KEY,
      type               TEXT NOT NULL,
      counterparty_name  TEXT,
      counterparty_email TEXT,
      data               JSONB NOT NULL,
      status             TEXT NOT NULL DEFAULT 'draft',
      created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by_name    TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS agreements_created_at_idx ON agreements (created_at DESC);`);
  return true;
}

module.exports = { enabled, pool, query, init };
