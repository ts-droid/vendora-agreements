// Optional outgoing webhook. Fully disabled when AGREEMENT_WEBHOOK_URL is unset.
// Delivery is fire-and-forget: short timeout, two retries, never throws to the caller.
const crypto = require('crypto');

const TIMEOUT_MS = 5000;
const RETRY_DELAYS_MS = [400, 1200];

function webhookUrl() {
  return (process.env.AGREEMENT_WEBHOOK_URL || '').trim();
}

function enabled() {
  return !!webhookUrl();
}

function secret() {
  return (process.env.AGREEMENT_WEBHOOK_SECRET || '').trim();
}

function secretHeaderName() {
  return (process.env.AGREEMENT_WEBHOOK_SECRET_HEADER || '').trim() || 'Authorization';
}

function isSafeHeaderName(name) {
  return /^[A-Za-z0-9-]+$/.test(name) && name.length <= 80;
}

// Headers for one already-serialized body. Signature is HMAC-SHA256 over those exact bytes.
function buildHeaders(rawBody) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'VendoraAgreements-Webhook/1.0',
  };
  const key = secret();
  if (!key) return headers;
  if (/[\r\n]/.test(process.env.AGREEMENT_WEBHOOK_SECRET || '')) {
    console.error('[webhook] AGREEMENT_WEBHOOK_SECRET contains a line break; not signing this delivery');
    return headers;
  }
  const name = secretHeaderName();
  const reserved = name.toLowerCase() === 'x-vendora-signature';
  if (!isSafeHeaderName(name) || reserved) {
    console.error('[webhook] AGREEMENT_WEBHOOK_SECRET_HEADER is not a usable header name; sending the signature only');
  } else if (name.toLowerCase() === 'authorization') {
    headers.Authorization = 'Bearer ' + key;
  } else {
    // Custom header: the raw secret, no "Bearer " prefix.
    headers[name] = key;
  }
  headers['X-Vendora-Signature'] = crypto.createHmac('sha256', key).update(rawBody, 'utf8').digest('hex');
  return headers;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function safeUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch (e) { return null; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;
  return parsed;
}

// POST payload. Returns true on 2xx. Retries network errors and 5xx (not 4xx).
// opts.delays / opts.timeoutMs exist so tests can avoid the production backoff.
async function deliver(url, payload, opts) {
  opts = opts || {};
  const parsed = safeUrl(url);
  if (!parsed) {
    console.error('[webhook] AGREEMENT_WEBHOOK_URL is missing or not an http(s) URL without credentials');
    return false;
  }
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const headers = buildHeaders(raw);
  const delays = opts.delays || RETRY_DELAYS_MS;
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const attempts = 1 + delays.length;
  const label = (payload && payload.event) || 'event';
  const id = payload && payload.agreement && payload.agreement.id;
  let last = 'unknown error';
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delays[i - 1]);
    try {
      const res = await fetch(parsed.href, {
        method: 'POST',
        headers: headers,
        body: raw,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return true;
      last = 'HTTP ' + res.status;
      // Drain so the socket can be reused; ignore failures.
      try { await res.arrayBuffer(); } catch (e) { /* ignore */ }
      if (res.status >= 400 && res.status < 500) break;
    } catch (err) {
      const name = err && err.name;
      last = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : ((err && err.message) || 'network error');
    }
  }
  console.error('[webhook] ' + label + (id ? ' agreement ' + id : '') + ' failed: ' + last);
  return false;
}

// build() may be sync or async and returns the JSON payload (or null to skip).
// Returns immediately. Failures are logged and never surface to the request handler.
function schedule(build) {
  try {
    const url = webhookUrl();
    if (!url) return;
    setImmediate(function () {
      Promise.resolve()
        .then(build)
        .then(function (payload) {
          if (!payload) return null;
          return deliver(url, payload);
        })
        .catch(function (err) {
          console.error('[webhook] ' + ((err && err.message) || err));
        });
    });
  } catch (err) {
    console.error('[webhook] ' + ((err && err.message) || err));
  }
}

module.exports = {
  TIMEOUT_MS: TIMEOUT_MS,
  RETRY_DELAYS_MS: RETRY_DELAYS_MS,
  webhookUrl: webhookUrl,
  enabled: enabled,
  buildHeaders: buildHeaders,
  deliver: deliver,
  schedule: schedule,
};
