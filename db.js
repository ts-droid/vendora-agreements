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

// Run SELECT work in a transaction that Postgres itself will reject writes from.
// Used by the read-only export API and by webhook metadata loads.
async function withReadOnly(fn) {
  if (!pool) throw new Error('Database not configured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* connection already doomed */ }
    throw err;
  } finally {
    client.release();
  }
}

// All workflow transitions hold the row lock until the snapshot and decision are committed.
async function withTransaction(fn) {
  if (!pool) throw new Error('Database not configured');
  const client=await pool.connect();
  try { await client.query('BEGIN'); const result=await fn(client); await client.query('COMMIT'); return result; }
  catch(e){try{await client.query('ROLLBACK');}catch(_){} throw e;}
  finally{client.release();}
}
async function init() {
  if (!pool) return false;
  // Several processes can run this at once: the test runner runs files in parallel, and a deploy
  // can overlap the instance it replaces. Concurrent CREATE TABLE IF NOT EXISTS on the same table
  // fails in Postgres ("duplicate key value violates unique constraint pg_type_typname_nsp_index"),
  // so initialisers take turns behind a session-level advisory lock: each one finds the others'
  // work already done. Every statement still commits on its own — holding every table's lock in
  // one long transaction deadlocked against the requests another instance was serving meanwhile.
  const client = await pool.connect();
  const query = (text, params) => client.query(text, params);   // the statements below run on this client
  try {
    await client.query('SELECT pg_advisory_lock(734280117)');
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
    await query(`ALTER TABLE agreements ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ;`);
    await query(`ALTER TABLE agreements ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ;`);
    // CEO signature workflow.
    await query(`ALTER TABLE agreements ADD COLUMN IF NOT EXISTS signature_requested_by TEXT;`);
    await query(`ALTER TABLE agreements ADD COLUMN IF NOT EXISTS signature_requested_by_name TEXT;`);
    await query(`ALTER TABLE agreements ADD COLUMN IF NOT EXISTS signature_requested_at TIMESTAMPTZ;`);
    await query(`ALTER TABLE agreements ADD COLUMN IF NOT EXISTS signature_note TEXT;`);
    await query(`ALTER TABLE agreements ADD COLUMN IF NOT EXISTS vendora_signed_by TEXT;`);
    await query(`ALTER TABLE agreements ADD COLUMN IF NOT EXISTS vendora_signed_email TEXT;`);
    await query(`ALTER TABLE agreements ADD COLUMN IF NOT EXISTS vendora_signed_at TIMESTAMPTZ;`);
    // Counterparty-first signing: the seller approves and sends a signing link, the counterparty uploads
    // their signed copy, the CEO countersigns last.
    await query(`ALTER TABLE agreements ADD COLUMN IF NOT EXISTS signature_token TEXT;`);
    await query(`ALTER TABLE agreements ADD COLUMN IF NOT EXISTS signature_sent_at TIMESTAMPTZ;`);
    await query(`ALTER TABLE agreements ADD COLUMN IF NOT EXISTS signature_summary JSONB;`);
    await query(`ALTER TABLE agreements ADD COLUMN IF NOT EXISTS counterparty_signed_at TIMESTAMPTZ;`);
    await query(`ALTER TABLE agreements ADD COLUMN IF NOT EXISTS counterparty_signed_by TEXT;`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;`);
    // Set once the user has seen (or skipped) the first-login walkthrough.
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ;`);
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
    // The counterparty's signed copy, once it has arrived (references the files table, so it is created here).
    await query(`ALTER TABLE agreements ADD COLUMN IF NOT EXISTS counterparty_signed_file INTEGER REFERENCES agreement_files(id) ON DELETE SET NULL;`);
    // Contract reviews: a counterparty's own contract compared with Vendora's agreement. Kept with
    // the document and benchmark so a review can be reopened, continued in the lawyer chat and
    // exported later.
    await query(`
      CREATE TABLE IF NOT EXISTS contract_reviews (
        id                SERIAL PRIMARY KEY,
        name              TEXT NOT NULL,
        type              TEXT NOT NULL,
        filename          TEXT NOT NULL,
        doc_kind          TEXT NOT NULL,
        doc               BYTEA NOT NULL,
        our_text          TEXT NOT NULL,
        review            JSONB NOT NULL,
        verdict           TEXT,
        findings_count    INTEGER NOT NULL DEFAULT 0,
        deal_breakers     INTEGER NOT NULL DEFAULT 0,
        counterparty_name TEXT,
        agreement_id      INTEGER REFERENCES agreements(id) ON DELETE SET NULL,
        created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_by_name   TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS contract_reviews_created_idx ON contract_reviews (created_at DESC);`);
    await query(`ALTER TABLE agreements ADD COLUMN IF NOT EXISTS workflow_state JSONB;`);
    await query(`ALTER TABLE agreements ADD COLUMN IF NOT EXISTS workflow_revision INTEGER NOT NULL DEFAULT 0;`);
    await query(`CREATE TABLE IF NOT EXISTS agreement_versions (
      agreement_id INTEGER NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,data JSONB NOT NULL,workflow_state JSONB NOT NULL,
      actor TEXT NOT NULL,action TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(agreement_id,revision)
    );`);
    // Version history for every agreement (agreement-history.js): records outside the review
    // workflow have no workflow_state, and each version notes the lifecycle status it left behind.
    await query(`ALTER TABLE agreement_versions ALTER COLUMN workflow_state DROP NOT NULL;`);
    await query(`ALTER TABLE agreement_versions ADD COLUMN IF NOT EXISTS status TEXT;`);
    await query(`ALTER TABLE agreement_versions ADD COLUMN IF NOT EXISTS note TEXT;`);
    await query(`CREATE TABLE IF NOT EXISTS agreement_submission_conflicts (
      id SERIAL PRIMARY KEY,agreement_id INTEGER NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
      sent_version INTEGER,submission JSONB NOT NULL,reason TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(734280117)'); } catch (e) { /* connection already doomed */ }
    client.release();
  }
  return true;
}

module.exports = { enabled, pool, query, withReadOnly, withTransaction, init };
