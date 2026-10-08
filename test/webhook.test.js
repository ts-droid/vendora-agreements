const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const webhook = require('../webhook');

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] == null) delete process.env[k];
    else process.env[k] = vars[k];
  }
  return Promise.resolve()
    .then(fn)
    .finally(function () {
      for (const k of Object.keys(prev)) {
        if (prev[k] == null) delete process.env[k];
        else process.env[k] = prev[k];
      }
    });
}

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      resolve({
        server: server,
        url: 'http://127.0.0.1:' + server.address().port + '/hook',
        close: function () { return new Promise(function (r) { server.close(r); }); },
      });
    });
  });
}

describe('webhook headers', { concurrency: 1 }, function () {
  test('default header is Authorization: Bearer and the body is signed', function () {
    return withEnv({
      AGREEMENT_WEBHOOK_SECRET: 'topsecret',
      AGREEMENT_WEBHOOK_SECRET_HEADER: null,
    }, function () {
      const raw = '{"event":"agreement.created"}';
      const headers = webhook.buildHeaders(raw);
      assert.equal(headers.Authorization, 'Bearer topsecret');
      const expect = crypto.createHmac('sha256', 'topsecret').update(raw, 'utf8').digest('hex');
      assert.equal(headers['X-Vendora-Signature'], expect);
    });
  });

  test('a custom header carries the raw secret, not a Bearer prefix', function () {
    return withEnv({
      AGREEMENT_WEBHOOK_SECRET: 'topsecret',
      AGREEMENT_WEBHOOK_SECRET_HEADER: 'X-Api-Key',
    }, function () {
      const headers = webhook.buildHeaders('{}');
      assert.equal(headers['X-Api-Key'], 'topsecret');
      assert.equal(headers.Authorization, undefined);
      assert.ok(headers['X-Vendora-Signature']);
    });
  });

  test('no secret means no auth header and no signature', function () {
    return withEnv({
      AGREEMENT_WEBHOOK_SECRET: null,
      AGREEMENT_WEBHOOK_SECRET_HEADER: null,
    }, function () {
      const headers = webhook.buildHeaders('{}');
      assert.equal(headers.Authorization, undefined);
      assert.equal(headers['X-Vendora-Signature'], undefined);
    });
  });

  test('an unsafe header name is not sent; the signature still is', function () {
    return withEnv({
      AGREEMENT_WEBHOOK_SECRET: 'topsecret',
      AGREEMENT_WEBHOOK_SECRET_HEADER: 'Bad Name',
    }, function () {
      const headers = webhook.buildHeaders('abc');
      assert.equal(headers['Bad Name'], undefined);
      assert.equal(headers.Authorization, undefined);
      assert.ok(/^[0-9a-f]{64}$/.test(headers['X-Vendora-Signature']));
    });
  });
});

describe('webhook delivery', { concurrency: 1 }, function () {
  test('retries a 500 then posts the same signed body', async function () {
    const seen = [];
    const srv = await listen(function (req, res) {
      const chunks = [];
      req.on('data', function (c) { chunks.push(c); });
      req.on('end', function () {
        seen.push({
          raw: Buffer.concat(chunks).toString('utf8'),
          auth: req.headers.authorization,
          sig: req.headers['x-vendora-signature'],
        });
        if (seen.length < 3) res.writeHead(500).end('no');
        else res.writeHead(204).end();
      });
    });
    try {
      await withEnv({
        AGREEMENT_WEBHOOK_SECRET: 'topsecret',
        AGREEMENT_WEBHOOK_SECRET_HEADER: null,
      }, async function () {
        const payload = {
          event: 'agreement.status_changed',
          occurred_at: '2026-04-02T00:00:00.000Z',
          agreement: { id: 9, status: 'submitted', previous_status: 'invited' },
        };
        const ok = await webhook.deliver(srv.url, payload, { delays: [10, 20], timeoutMs: 1000 });
        assert.equal(ok, true);
        assert.equal(seen.length, 3);
        const raw = JSON.stringify(payload);
        const expect = crypto.createHmac('sha256', 'topsecret').update(raw, 'utf8').digest('hex');
        for (const hit of seen) {
          assert.equal(hit.raw, raw);
          assert.equal(hit.auth, 'Bearer topsecret');
          assert.equal(hit.sig, expect);
        }
      });
    } finally {
      await srv.close();
    }
  });

  test('does not retry a 4xx', async function () {
    let n = 0;
    const srv = await listen(function (req, res) {
      n++;
      res.writeHead(400).end('bad');
    });
    try {
      await withEnv({ AGREEMENT_WEBHOOK_SECRET: null }, async function () {
        const ok = await webhook.deliver(srv.url, { event: 'agreement.created', agreement: { id: 1 } }, { delays: [10, 10], timeoutMs: 1000 });
        assert.equal(ok, false);
        assert.equal(n, 1);
      });
    } finally {
      await srv.close();
    }
  });

  test('schedule posts without the caller waiting, and is a no-op when unset', async function () {
    let hit = null;
    const srv = await listen(function (req, res) {
      const chunks = [];
      req.on('data', function (c) { chunks.push(c); });
      req.on('end', function () {
        hit = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200).end('ok');
      });
    });
    try {
      await withEnv({ AGREEMENT_WEBHOOK_URL: null, AGREEMENT_WEBHOOK_SECRET: null }, async function () {
        let built = false;
        const started = Date.now();
        webhook.schedule(function () { built = true; return { event: 'agreement.created' }; });
        assert.ok(Date.now() - started < 50);
        await new Promise(function (r) { setTimeout(r, 30); });
        assert.equal(built, false);
      });
      const done = new Promise(function (resolve) {
        const timer = setInterval(function () { if (hit) { clearInterval(timer); resolve(); } }, 15);
      });
      await withEnv({ AGREEMENT_WEBHOOK_URL: srv.url, AGREEMENT_WEBHOOK_SECRET: 's' }, function () {
        webhook.schedule(function () {
          return { event: 'agreement.reminder_sent', agreement: { id: 4, previous_status: null } };
        });
      });
      await done;
      assert.equal(hit.event, 'agreement.reminder_sent');
      assert.equal(hit.agreement.id, 4);
    } finally {
      await srv.close();
    }
  });

  test('rejects urls that are not http(s) or that embed credentials', async function () {
    assert.equal(await webhook.deliver('javascript:alert(1)', { event: 'x' }, { delays: [] }), false);
    assert.equal(await webhook.deliver('http://user:pass@127.0.0.1/hook', { event: 'x' }, { delays: [] }), false);
  });
});
