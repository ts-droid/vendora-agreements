const { test } = require('node:test');
const assert = require('node:assert/strict');
const script = require('../scripts/validateStoredAgreement');

test('validateStoredAgreement lists failing agreements and refuses a remote database', function () {
  const rows = [
    { id: 1, type: 'ra', counterparty_name: 'Good AB', status: 'draft', data: { curr: 'EUR', pay: '30', notice: '90' } },
    { id: 2, type: 'ra', counterparty_name: 'Legacy AB', status: 'generated', data: { sig_email: 'not-an-email', date: '01-10-2026', curr: 'EUR' } },
    { id: 3, type: 'rb', counterparty_name: 'Also fine', status: 'invited', data: { sig_email: 'a@b.co', date: '2026-10-01' } },
  ];
  const failing = script.failingAgreements(rows);
  assert.equal(failing.length, 1);
  assert.equal(failing[0].id, 2);
  assert.equal(failing[0].counterparty_name, 'Legacy AB');
  assert.ok(failing[0].errors.some(function (e) { return e.indexOf('sig_email') >= 0; }));
  assert.ok(failing[0].errors.some(function (e) { return e.indexOf('date') >= 0; }));

  assert.doesNotThrow(function () { script.assertSafeDatabaseUrl('postgres://vendora:secret@127.0.0.1:5432/vendora'); });
  assert.doesNotThrow(function () { script.assertSafeDatabaseUrl('postgresql://vendora@localhost/vendora'); });
  assert.throws(function () { script.assertSafeDatabaseUrl(''); }, /DATABASE_URL is not set/);
  assert.throws(
    function () { script.assertSafeDatabaseUrl('postgres://u:p@db.internal.example:5432/vendora'); },
    /must not be run against production/
  );
  assert.throws(
    function () { script.assertSafeDatabaseUrl('postgres://u:p@vendora-agreements-production.up.railway.app:5432/railway'); },
    /production database/
  );
  const production = 'postgres://u:p@vendora-agreements-production.up.railway.app:5432/railway';
  assert.equal(script.allowProduction(['node', 'scripts/validateStoredAgreement.js']), false);
  assert.equal(script.allowProduction(['node', 'scripts/validateStoredAgreement.js', '--allow-production']), true);
  assert.doesNotThrow(function () { script.assertSafeDatabaseUrl(production, true); });
  assert.throws(function () { script.assertSafeDatabaseUrl(production, false); }, /production database/);

  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'scripts', 'validateStoredAgreement.js'), 'utf8');
  const flagAt = src.indexOf('allowProduction(args)');
  const readAt = src.indexOf('db.withReadOnly');
  assert.ok(flagAt > 0 && readAt > flagAt);
});
