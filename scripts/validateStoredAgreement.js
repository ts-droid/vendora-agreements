#!/usr/bin/env node
// List stored agreements that fail the strict agreement check.
// The query always runs inside BEGIN READ ONLY. A non-local or production
// database is refused unless --allow-production is passed on the command line.
const lawyerChanges = require('../lawyer-changes');

function allowProduction(argv) {
  return (argv || []).indexOf('--allow-production') >= 0;
}

function assertSafeDatabaseUrl(url, allowProductionFlag) {
  const raw = String(url || '').trim();
  if (!raw) throw new Error('DATABASE_URL is not set');
  let host = '';
  try { host = new URL(raw).hostname; }
  catch (e) { throw new Error('DATABASE_URL is not a valid URL'); }
  if (allowProductionFlag) return;
  if (/production|railway\.app|rlwy\.net/i.test(raw)) {
    throw new Error('Refusing to run validateStoredAgreement against a production database.');
  }
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!local) throw new Error('Refusing to read a non-local database. This script must not be run against production.');
}

function failingAgreements(rows) {
  return (rows || []).map(function (row) {
    const checked = lawyerChanges.validateStoredAgreement(row && row.data);
    if (checked.ok) return null;
    return {
      id: row.id,
      type: row.type || '',
      counterparty_name: row.counterparty_name || '',
      status: row.status || '',
      errors: checked.errors || [],
    };
  }).filter(Boolean);
}

async function main(argv) {
  const args = argv || process.argv;
  assertSafeDatabaseUrl(process.env.DATABASE_URL || '', allowProduction(args));
  const db = require('../db');
  if (!db.enabled) throw new Error('Database not configured');
  const result = await db.withReadOnly(function (client) {
    return client.query(
      'SELECT id, type, counterparty_name, status, data FROM agreements ORDER BY id'
    );
  });
  const rows = result.rows || [];
  const failing = failingAgreements(rows);
  if (!failing.length) {
    console.log('No stored agreements fail validation (' + rows.length + ' checked).');
  } else {
    console.log(failing.length + ' of ' + rows.length + ' agreements fail validation:');
    failing.forEach(function (row) {
      console.log('#' + row.id + ' ' + row.type + ' ' + (row.counterparty_name || '(no name)') + ' [' + row.status + ']');
      row.errors.forEach(function (err) { console.log('  - ' + err); });
    });
  }
  if (db.pool) await db.pool.end();
  return failing;
}

module.exports = {
  allowProduction: allowProduction,
  assertSafeDatabaseUrl: assertSafeDatabaseUrl,
  failingAgreements: failingAgreements,
  main: main,
};

if (require.main === module) {
  main().catch(function (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}
