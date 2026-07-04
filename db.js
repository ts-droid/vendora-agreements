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
  await query(`
    CREATE TABLE IF NOT EXISTS agreements (
      id                 SERIAL PRIMARY KEY,
      type               TEXT NOT NULL,
      counterparty_name  TEXT,
      counterparty_email TEXT,
      data               JSONB NOT NULL,
      status             TEXT NOT NULL DEFAULT 'draft',
      update_token       TEXT,
      created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by_name    TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS agreements_created_at_idx ON agreements (created_at DESC);`);
  // Idempotent migrations for databases created before later columns were added — run AFTER
  // the CREATE TABLEs so they don't fail (and abort init) on a brand-new database.
  await query(`ALTER TABLE agreements ADD COLUMN IF NOT EXISTS update_token TEXT;`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;`);
  await query(`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_key ON users (google_sub) WHERE google_sub IS NOT NULL;`);
  // AI playbook: an evolving "house view" (settings) + discrete learned notes.
  await query(`
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS ai_notes (
      id              SERIAL PRIMARY KEY,
      topic           TEXT,
      content         TEXT NOT NULL,
      created_by_name TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Uploaded countersigned agreements (and any supporting files) attached to an archive record.
  await query(`
    CREATE TABLE IF NOT EXISTS agreement_files (
      id             SERIAL PRIMARY KEY,
      agreement_id   INTEGER NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
      filename       TEXT NOT NULL,
      mime           TEXT,
      size_bytes     INTEGER,
      content        BYTEA NOT NULL,
      uploaded_by    TEXT,
      uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS agreement_files_agreement_idx ON agreement_files (agreement_id);`);
  return true;
}

module.exports = { enabled, pool, query, init };
