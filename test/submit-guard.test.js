const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const db = require('../db');
const auth = require('../auth');
const app = require('../server');

function post(port, path, body, headers) {
  return new Promise(function (resolve, reject) {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: port,
      path: path,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      }, headers || {}),
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        let json = {};
        const raw = Buffer.concat(chunks).toString();
        if (raw) { try { json = JSON.parse(raw); } catch (e) { json = { raw: raw }; } }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

function put(port, path, body, headers) {
  return new Promise(function (resolve, reject) {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: port,
      path: path,
      method: 'PUT',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      }, headers || {}),
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        let json = {};
        const raw = Buffer.concat(chunks).toString();
        if (raw) { try { json = JSON.parse(raw); } catch (e) { json = { raw: raw }; } }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('submit checks the token before validation and does not write a locked or signed agreement', async function () {
  const originalQuery = db.query;
  const originalEnabled = db.enabled;
  const writes = [];
  const legacy = { sig_email: 'not-an-email', date: '01-10-2026', curr: 'EUR', name: 'Acme' };
  const rows = {
    1: { update_token: 'good-token', status: 'invited', vendora_signed_at: null, data: legacy },
    2: { update_token: 'good-token', status: 'signed', vendora_signed_at: new Date().toISOString(), data: { name: 'Signed Co', curr: 'EUR' } },
    3: { update_token: 'good-token', status: 'pending_signature', vendora_signed_at: null, data: { name: 'Locked Co', curr: 'EUR' } },
    4: { update_token: 'good-token', status: 'vendora_signed', vendora_signed_at: new Date().toISOString(), data: { name: 'CEO Co', curr: 'EUR' } },
    5: { update_token: 'good-token', status: 'invited', vendora_signed_at: new Date().toISOString(), data: { name: 'Stamp Co', curr: 'EUR' } },
    6: { update_token: 'good-token', status: 'submitted', vendora_signed_at: null, data: legacy, id: 6 },
  };
  db.enabled = true;
  db.query = async function (sql, params) {
    const text = String(sql);
    if (text.indexOf('UPDATE') >= 0) {
      writes.push({ sql: text, params: params });
      return { rowCount: 1, rows: [{ id: 6, updated_at: new Date().toISOString() }] };
    }
    const id = String(params && params[0]);
    return { rows: rows[id] ? [rows[id]] : [], rowCount: rows[id] ? 1 : 0 };
  };
  const server = await new Promise(function (resolve) {
    const s = app.listen(0, '127.0.0.1', function () { resolve(s); });
  });
  const port = server.address().port;
  const badData = { curr: 'BTC', sig_email: 'not-an-email', date: '01-10-2026', name: 'Acme' };
  try {
    const wrongToken = await post(port, '/api/agreements/1/submit', { token: 'wrong-token', data: badData });
    assert.equal(wrongToken.status, 403);
    assert.equal(wrongToken.body.details, undefined);
    assert.equal(writes.length, 0);

    const missing = await post(port, '/api/agreements/99/submit', { token: 'good-token', data: badData });
    assert.equal(missing.status, 404);
    assert.equal(writes.length, 0);

    for (const id of [2, 3, 4, 5]) {
      const closed = await post(port, '/api/agreements/' + id + '/submit', { token: 'good-token', data: badData });
      assert.equal(closed.status, 409, 'id ' + id);
      assert.equal(closed.body.details, undefined, 'id ' + id);
    }
    assert.equal(writes.length, 0);

    const kept = await post(port, '/api/agreements/6/submit', {
      token: 'good-token',
      data: Object.assign({}, legacy, { name: 'Acme AB' }),
      counterpartyName: 'Acme AB',
    });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.equal(writes.length, 1);
    assert.match(writes[0].sql, /vendora_signed_at IS NULL/);
    assert.match(writes[0].sql, /pending_signature/);

    const changed = await post(port, '/api/agreements/6/submit', {
      token: 'good-token',
      data: Object.assign({}, legacy, { sig_email: 'still-wrong' }),
    });
    assert.equal(changed.status, 400);
    assert.ok(Array.isArray(changed.body.details) && changed.body.details.length > 0);
    assert.ok(changed.body.details.some(function (d) { return String(d).indexOf('sig_email') >= 0; }));
    assert.equal(writes.length, 1);

    const cookie = auth.COOKIE + '=' + auth.signToken({ id: 7, email: 'ts@vendora.se', name: 'Thomas' });
    const saved = await put(port, '/api/agreements/6', {
      counterpartyName: 'Acme AB',
      data: Object.assign({}, legacy, { name: 'Acme AB' }),
      status: 'submitted',
    }, { Cookie: cookie });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(writes.length, 2);

    const putBad = await put(port, '/api/agreements/6', {
      counterpartyName: 'Acme AB',
      data: Object.assign({}, legacy, { date: 'yesterday' }),
      status: 'submitted',
    }, { Cookie: cookie });
    assert.equal(putBad.status, 400);
    assert.ok(putBad.body.details.some(function (d) { return String(d).indexOf('date') >= 0; }));
    assert.equal(writes.length, 2);
  } finally {
    db.query = originalQuery;
    db.enabled = originalEnabled;
    await new Promise(function (resolve) { server.close(resolve); });
  }
});
