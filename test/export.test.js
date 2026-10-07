const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const agreementExport = require('../agreement-export');
const db = require('../db');

const STATUSES = ['draft', 'invited', 'submitted', 'generated', 'pending_signature', 'vendora_signed', 'sent', 'signed', 'imported'];

function row(overrides) {
  return Object.assign({
    id: 1,
    type: 'ra',
    counterparty_name: null,
    counterparty_email: null,
    status: 'draft',
    created_at: new Date('2026-03-01T12:00:00Z'),
    updated_at: new Date('2026-03-02T08:30:00Z'),
    status_updated_at: null,
    last_reminder_at: null,
    vendora_signed_at: null,
    signature_requested_at: null,
    created_by: 4,
    created_by_name: 'Sara',
    created_by_email: 'sara@vendora.se',
    company_name: null,
    invite_contact_name: null,
    signatory_name: null,
    invite_email: null,
    signatory_email: null,
    mgmt_contact_name: null,
    mgmt_contact_email: null,
    notices_name: null,
    notices_email: null,
    main_contact_name: null,
    file_count: 0,
  }, overrides);
}

test('metadata is names, status, timestamps, creator email, and file count only', function () {
  const meta = agreementExport.toMeta(row({
    id: 3,
    counterparty_name: 'Nordic Retail AB',
    counterparty_email: 'anna@reseller.com',
    status: 'vendora_signed',
    company_name: 'Nordic Retail AB',
    signatory_name: 'Anna Andersson',
    invite_contact_name: 'Anna Andersson',
    vendora_signed_at: new Date('2026-04-01T09:00:00Z'),
    signature_requested_at: '2026-03-31T15:00:00.000Z',
    file_count: 2,
    update_token: 'capability-token',
    content: Buffer.from('pdf-bytes'),
    data: { _vendoraSignature: { image: 'secret' }, _atok: 'tok' },
  }));
  assert.equal(meta.id, 3);
  assert.equal(meta.type, 'ra');
  assert.equal(meta.counterparty_company, 'Nordic Retail AB');
  assert.equal(meta.counterparty_name, 'Nordic Retail AB');
  assert.equal(meta.contact_name, 'Anna Andersson');
  assert.equal(meta.contact_email, 'anna@reseller.com');
  assert.equal(meta.status, 'vendora_signed');
  assert.equal(meta.created_at, '2026-03-01T12:00:00.000Z');
  assert.equal(meta.updated_at, '2026-03-02T08:30:00.000Z');
  assert.equal(meta.vendora_signed_at, '2026-04-01T09:00:00.000Z');
  assert.equal(meta.signature_requested_at, '2026-03-31T15:00:00.000Z');
  assert.equal(meta.created_by_email, 'sara@vendora.se');
  assert.equal(meta.created_by_name, 'Sara');
  assert.equal(meta.file_count, 2);
  assert.equal(meta.previous_status, undefined);
  const json = JSON.stringify(meta);
  assert.equal(json.includes('capability-token'), false);
  assert.equal(json.includes('_vendoraSignature'), false);
  assert.equal(json.includes('pdf-bytes'), false);
  assert.deepEqual(Object.keys(meta), agreementExport.FIELDS);
});

test('invite rows keep the company and the contact person apart', function () {
  const meta = agreementExport.toMeta(row({
    type: 'da',
    status: 'invited',
    counterparty_name: 'Sarah Chen',
    counterparty_email: 'sarah@supplier.com',
    company_name: 'Acme Technology Co., Ltd.',
    invite_contact_name: 'Sarah Chen',
    invite_email: 'sarah@supplier.com',
  }));
  assert.equal(meta.counterparty_company, 'Acme Technology Co., Ltd.');
  assert.equal(meta.counterparty_name, 'Sarah Chen');
  assert.equal(meta.contact_name, 'Sarah Chen');
  assert.equal(meta.contact_email, 'sarah@supplier.com');
});

test('a contact stored only on the column is not reported as the company', function () {
  const meta = agreementExport.toMeta(row({
    counterparty_name: 'Sarah Chen',
    counterparty_email: 'sarah@supplier.com',
  }));
  assert.equal(meta.counterparty_company, null);
  assert.equal(meta.contact_name, 'Sarah Chen');
});

test('distributor management contact is used when there is no signatory', function () {
  const meta = agreementExport.toMeta(row({
    type: 'da',
    company_name: 'Acme AB',
    counterparty_name: 'Acme AB',
    mgmt_contact_name: 'Bo Ek',
    mgmt_contact_email: 'bo@acme.se',
  }));
  assert.equal(meta.counterparty_company, 'Acme AB');
  assert.equal(meta.contact_name, 'Bo Ek');
  assert.equal(meta.contact_email, 'bo@acme.se');
});

test('csv escapes commas, quotes, newlines, and formula prefixes', function () {
  const csv = agreementExport.toCsv([
    agreementExport.toMeta(row({
      counterparty_company: 'A, "B"',
      company_name: 'A, "B"',
      contact_name: '=HYPERLINK("http://evil")',
      signatory_name: '=HYPERLINK("http://evil")',
    })),
  ]);
  assert.ok(csv.startsWith(agreementExport.FIELDS.join(',') + '\r\n'));
  assert.match(csv, /"A, ""B"""/);
  assert.match(csv, /"'=HYPERLINK/);
  assert.equal(csv.includes('\n='), false);
});

test('bearer comparison is equal only for the same secret', function () {
  assert.equal(agreementExport.secretEq('abc', 'abc'), true);
  assert.equal(agreementExport.secretEq('abc', 'abd'), false);
  assert.equal(agreementExport.secretEq('', 'abc'), false);
  assert.equal(agreementExport.secretEq('abc', 'abc '), false);
});

test('filters: status, since, format; include_test is ignored', function () {
  const ok = agreementExport.parseFilters({ status: 'signed', since: '2026-01-15', format: 'CSV', include_test: '0' }, STATUSES);
  assert.equal(ok.status, 'signed');
  assert.equal(ok.since, '2026-01-15T00:00:00.000Z');
  assert.equal(ok.format, 'csv');
  assert.equal(agreementExport.parseFilters({ status: 'nope' }, STATUSES).error, 'Invalid status');
  assert.equal(agreementExport.parseFilters({ since: 'not-a-date' }, STATUSES).error, 'Invalid since date');
  assert.equal(agreementExport.parseFilters({ format: 'xml' }, STATUSES).error, 'Invalid format');
  assert.equal(agreementExport.parseFilters({}, STATUSES).format, 'json');
});

test('list query is a bounded SELECT inside a read-only transaction', async function () {
  const src = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  assert.match(src, /BEGIN READ ONLY/);
  let sql = '';
  let params = null;
  const fake = {
    withReadOnly: async function (fn) {
      return fn({
        query: function (text, p) { sql = text; params = p; return { rows: [row({ id: 7, file_count: 1 })] }; },
      });
    },
    query: function () { throw new Error('export must not use the writable query helper'); },
  };
  const out = await agreementExport.list(fake, { status: 'signed', since: '2026-01-01T00:00:00.000Z' });
  assert.match(sql, /^\s*SELECT/i);
  assert.doesNotMatch(sql, /\b(insert|update|delete|drop|alter|truncate|grant)\b/i);
  assert.doesNotMatch(sql, /update_token|_vendoraSignature|\bcontent\b/);
  assert.deepEqual(params, ['signed', '2026-01-01T00:00:00.000Z', agreementExport.MAX_ROWS + 1]);
  assert.equal(out.truncated, false);
  assert.equal(out.agreements.length, 1);
  assert.equal(out.agreements[0].id, 7);
});

test('more than MAX_ROWS is truncated', async function () {
  const rows = [];
  for (let i = 0; i < agreementExport.MAX_ROWS + 1; i++) rows.push(row({ id: i + 1 }));
  const fake = {
    withReadOnly: async function (fn) {
      return fn({ query: function () { return { rows: rows }; } });
    },
  };
  const out = await agreementExport.list(fake, {});
  assert.equal(out.truncated, true);
  assert.equal(out.agreements.length, agreementExport.MAX_ROWS);
});

describe('GET /api/export/agreements', { concurrency: 1 }, function () {
  let app;
  let server;
  let base;
  const saved = {};

  before(async function () {
    for (const k of ['EXPORT_API_KEY', 'DATABASE_URL']) saved[k] = process.env[k];
    delete process.env.EXPORT_API_KEY;
    app = require('../server');
    server = await new Promise(function (resolve) {
      const s = app.listen(0, '127.0.0.1', function () { resolve(s); });
    });
    base = 'http://127.0.0.1:' + server.address().port;
  });

  after(async function () {
    for (const k of Object.keys(saved)) {
      if (saved[k] == null) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (server) await new Promise(function (resolve) { server.close(resolve); });
  });

  function hit(path, headers) {
    return fetch(base + path, { headers: headers || {} });
  }

  test('disabled (404 JSON) when EXPORT_API_KEY is unset', async function () {
    delete process.env.EXPORT_API_KEY;
    const res = await hit('/api/export/agreements');
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.equal(body.error, 'Not found');
    assert.match(res.headers.get('content-type'), /json/);
  });

  test('401 when the bearer token is missing or wrong', async function () {
    process.env.EXPORT_API_KEY = 'test-export-key';
    const missing = await hit('/api/export/agreements');
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error, 'Unauthorized');
    const wrong = await hit('/api/export/agreements', { Authorization: 'Bearer not-the-key' });
    assert.equal(wrong.status, 401);
    const text = await wrong.text();
    assert.equal(text.includes('test-export-key'), false);
  });

  test('400 for a bad filter before touching the database', async function () {
    process.env.EXPORT_API_KEY = 'test-export-key';
    const res = await hit('/api/export/agreements?status=nope', { Authorization: 'Bearer test-export-key' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'Invalid status');
  });

  test('503 when the key is set but the archive database is not', async function () {
    if (db.enabled) return; // this environment has DATABASE_URL; the query path needs Postgres
    process.env.EXPORT_API_KEY = 'test-export-key';
    const res = await hit('/api/export/agreements?include_test=1', { Authorization: 'Bearer test-export-key' });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'Archive is not enabled on this server');
  });
});

test('export route is registered as its own GET, not the HTML catch-all', function () {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = src.indexOf("app.get('/api/export/agreements'");
  const catchAll = src.indexOf("app.get('*");
  assert.ok(route > 0);
  assert.ok(catchAll > route);
});
