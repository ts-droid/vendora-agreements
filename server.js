const express      = require('express');
const path         = require('path');
const crypto       = require('crypto');
const nodemailer   = require('nodemailer');
const cookieParser = require('cookie-parser');
const db           = require('./db');
const auth         = require('./auth');
const ai           = require('./ai');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.set('trust proxy', 1); // behind Railway's proxy: correct req.ip / secure-cookie handling

// Baseline security headers (no external dependency; deliberately no strict CSP because the
// single-file frontend relies on inline scripts/styles that a strict policy would break).
app.use(function (req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-XSS-Protection', '0');
  next();
});

// Tiny in-memory rate limiter (single Railway instance). Keyed by client IP + bucket name.
// Not a distributed guarantee — just enough to blunt credential stuffing and email/API abuse.
const rlBuckets = new Map();
function rateLimit(name, max, windowMs) {
  return function (req, res, next) {
    const now = Date.now();
    const key = name + ':' + (req.ip || 'unknown');
    let b = rlBuckets.get(key);
    if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; rlBuckets.set(key, b); }
    b.count++;
    if (b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests — please slow down and try again shortly.' });
    }
    next();
  };
}
// Opportunistic sweep so the map can't grow unbounded.
setInterval(function () {
  const now = Date.now();
  for (const [k, v] of rlBuckets) { if (now > v.reset) rlBuckets.delete(k); }
}, 10 * 60 * 1000).unref();
const authLimiter   = rateLimit('auth',   15, 15 * 60 * 1000); // 15 attempts / 15 min / IP
const publicLimiter = rateLimit('public', 30, 10 * 60 * 1000); // 30 requests / 10 min / IP

// Escape untrusted strings before putting them in email HTML.
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
const DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || 'vendora.se').toLowerCase();

// Valid archive lifecycle statuses (draft → invited → submitted → generated → sent → signed;
// plus 'imported' for records brought in from a link).
const STATUSES = ['draft', 'invited', 'submitted', 'generated', 'sent', 'signed', 'imported'];

// Strip characters that could break a Content-Disposition header or path.
function safeFilename(s) {
  return String(s == null ? 'file' : s).replace(/[\r\n"\\/]/g, '_').replace(/[^\x20-\x7E]/g, '_').slice(0, 200) || 'file';
}

// Constant-time secret comparison (avoids timing side-channels on capability tokens).
function tokenEq(a, b) {
  try { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
  catch (e) { return false; }
}

// Provision the database schema on boot (no-op if DATABASE_URL is unset).
if (db.enabled) {
  db.init()
    .then(() => console.log('Database ready (archive + auth enabled)'))
    .catch((e) => console.error('Database init failed:', e.message));
} else {
  console.log('DATABASE_URL not set — archive + auth disabled (stateless mode)');
}

// Never cache index.html — always serve the latest deployed version
app.use(function(req, res, next) {
  if (req.path === '/' || req.path.endsWith('.html') || req.path.startsWith('/i/')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

// NOTE: we do NOT use express.static on the project root — that would serve server.js, ai.js
// (the Vendora playbook), package.json etc. as source. index.html is self-contained (libraries
// are embedded inline), so the catch-all GET '*' below serves it for every page route.

// ── In-memory invite store ────────────────────────────────────────────────────
const store = new Map();

app.post('/api/invite', auth.requireAuth, (req, res) => {
  const data = req.body;
  if (!data || !data._type) return res.status(400).json({ error: 'Invalid data' });
  const code = crypto.randomBytes(5).toString('base64url');
  store.set(code, { data, created: Date.now() });
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [k, v] of store) { if (v.created < cutoff) store.delete(k); }
  res.json({ code, url: `/i/${code}` });
});

app.get('/api/invite/:code', publicLimiter, (req, res) => {
  const entry = store.get(req.params.code);
  if (!entry) return res.status(404).json({ error: 'Link not found or expired' });
  res.json(entry.data);
});

// ── Shared mailer ─────────────────────────────────────────────────────────────
function getTransporter() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// ── Send invite email to supplier/reseller ────────────────────────────────────
app.post('/api/send-invite', auth.requireAuth, async (req, res) => {
  const { toEmail, toName, fromName, agreementType, inviteUrl, salespersonEmail } = req.body;
  if (!toEmail || !inviteUrl) return res.status(400).json({ error: 'Missing fields' });

  const transporter = getTransporter();
  if (!transporter) {
    return res.json({ ok: true, sent: false, reason: 'SMTP not configured' });
  }

  const greeting = toName ? `Hi ${escHtml(toName)},` : 'Hi,';
  const typeLabel = agreementType === 'da' ? 'Distributor Agreement' : 'Reseller Agreement';
  const fromLabel = escHtml(fromName || 'Vendora Nordic AB');
  const okInvite = typeof inviteUrl === 'string' && inviteUrl.indexOf('https://' + req.get('host') + '/') === 0;

  // CC the responsible salesperson (visible to the recipient as their contact); BCC
  // ts@vendora.se (hidden from the recipient). Never CC/BCC the recipient themselves.
  const toLc = (toEmail || '').trim().toLowerCase();
  const TS = 'ts@vendora.se';
  const sp = (salespersonEmail || '').trim();
  const ccList = [];
  if (sp && sp.toLowerCase() !== toLc && sp.toLowerCase() !== TS) ccList.push(sp);
  const bccList = [];
  if (toLc !== TS) bccList.push(TS);

  try {
    await transporter.sendMail({
      from:    `"Vendora Nordic AB" <${process.env.SMTP_USER}>`,
      to:      `${toName ? toName + ' <' + toEmail + '>' : toEmail}`,
      ...(ccList.length ? { cc: ccList.join(', ') } : {}),
      ...(bccList.length ? { bcc: bccList.join(', ') } : {}),
      replyTo: 'ts@vendora.se',
      subject: `Action required: Please fill in your details — ${typeLabel} with Vendora Nordic AB`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
          <div style="background:#0F2240;padding:20px 28px">
            <h1 style="color:#fff;font-size:18px;margin:0">Vendora Nordic AB</h1>
            <p style="color:#C8D9ED;font-size:13px;margin:4px 0 0">${typeLabel}</p>
          </div>
          <div style="padding:24px 28px;border:1px solid #e0e0e0;border-top:none">
            <p style="color:#333;font-size:14px">${greeting}</p>
            <p style="color:#333;font-size:14px">
              ${fromLabel} has prepared a <strong>${typeLabel}</strong>
              and would like you to fill in your company details before the agreement is finalised.
            </p>
            <p style="color:#333;font-size:14px">
              It only takes a few minutes. The commercial terms have already been set —
              you just need to provide your legal company details and contact persons.
            </p>
            ${okInvite ? `<div style="text-align:center;margin:28px 0">
              <a href="${escHtml(inviteUrl)}"
                 style="display:inline-block;background:#0F2240;color:#fff;padding:14px 32px;
                        text-decoration:none;font-size:15px;font-weight:bold">
                Fill in your details →
              </a>
            </div>` : ''}
            <p style="color:#999;font-size:12px">
              If the button above doesn't work, please contact us at ts@vendora.se.
            </p>
            <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
            <p style="color:#999;font-size:12px">
              Vendora Nordic AB · Ladugårdsvägen 1, 234 35 Lomma, Sweden ·
              <a href="mailto:ts@vendora.se" style="color:#999">ts@vendora.se</a>
            </p>
          </div>
        </div>
      `,
    });
    console.log(`Invite sent to ${toEmail}${ccList.length ? ' (cc: ' + ccList.join(', ') + ')' : ''}${bccList.length ? ' (bcc: ' + bccList.join(', ') + ')' : ''}`);
    res.json({ ok: true, sent: true });
  } catch (err) {
    console.error('Send invite error:', err.message);
    res.status(500).json({ ok: false, error: 'Could not send the invitation email' });
  }
});

// ── Notification to Vendora when supplier submits ─────────────────────────────
app.post('/api/notify', publicLimiter, async (req, res) => {
  const { supplierName, agreementType, reviewUrl, vendoraContact, proposalCount } = req.body;
  const transporter = getTransporter();
  if (!transporter) {
    console.log('SMTP not configured — skipping notification');
    return res.json({ ok: true, sent: false });
  }

  // This endpoint is public (the counterparty's browser calls it after submitting), so treat
  // every field as untrusted: only ever email Vendora addresses, escape all interpolated
  // values, coerce the count, and only render the review button if the URL is our own origin.
  const recipients = ['ts@vendora.se'];
  if (vendoraContact && /^[^\s@]+@vendora\.se$/i.test(String(vendoraContact)) && vendoraContact.toLowerCase() !== 'ts@vendora.se') {
    recipients.push(String(vendoraContact));
  }
  const sName = escHtml(supplierName || 'Supplier');
  const aType = escHtml(agreementType || 'Agreement');
  const pCount = Math.max(0, parseInt(proposalCount, 10) || 0);
  const okUrl = typeof reviewUrl === 'string' && reviewUrl.indexOf('https://' + req.get('host') + '/') === 0;

  try {
    await transporter.sendMail({
      from:    `"Vendora Agreements" <${process.env.SMTP_USER}>`,
      to:      recipients.join(', '),
      subject: `${pCount > 0 ? '[' + pCount + ' proposed changes] ' : ''}${aType} details submitted — ${sName}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
          <div style="background:#0F2240;padding:20px 28px">
            <h1 style="color:#fff;font-size:18px;margin:0">Vendora Agreement Generator</h1>
          </div>
          <div style="padding:24px 28px;border:1px solid #e0e0e0;border-top:none">
            <h2 style="color:#0F2240;font-size:16px;margin-top:0">
              &#x2705; ${sName} has submitted their details
            </h2>
            <p style="color:#555;font-size:14px">
              <strong>${sName}</strong> has filled in their company details and contacts
              for the <strong>${aType}</strong>.
            </p>
            ${pCount > 0 ? `<div style="background:#FFF3CD;border:1px solid #ffe69c;border-radius:4px;padding:10px 14px;margin:12px 0;color:#856404;font-size:13px"><strong>&#x26A0; ${pCount} proposed change${pCount>1?'s':''} to your commercial terms.</strong> Review them on the page before generating the final agreement.</div>` : ''}
            ${okUrl ? `<div style="text-align:center;margin:24px 0">
              <a href="${escHtml(reviewUrl)}"
                 style="display:inline-block;background:#0F2240;color:#fff;padding:12px 28px;
                        text-decoration:none;font-size:14px;font-weight:bold">
                Review &amp; Generate Agreement →
              </a>
            </div>` : '<p style="color:#555;font-size:13px">Open the Vendora Agreement Generator to review this submission.</p>'}
            <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
            <p style="color:#999;font-size:12px">
              Vendora Nordic AB · Ladugårdsvägen 1, 234 35 Lomma, Sweden
            </p>
          </div>
        </div>
      `,
    });
    console.log(`Notification sent for ${supplierName}`);
    res.json({ ok: true, sent: true });
  } catch (err) {
    console.error('Notify error:', err.message);
    res.json({ ok: true, sent: false });
  }
});

// ── Auth ──────────────────────────────────────────────────────────────────────
// Reports whether server-side features (login + archive) are available at all.
app.get('/api/config', (req, res) => {
  res.json({
    archive: db.enabled,
    google: auth.googleEnabled,
    googleClientId: auth.GOOGLE_CLIENT_ID || null,
    allowedDomain: auth.ALLOWED_DOMAIN,
    ai: ai.enabled,
  });
});

// Load the evolving playbook (house view + learned notes) from the database.
async function loadPlaybook() {
  if (!db.enabled) return { guidance: '', notes: [] };
  const g = await db.query("SELECT value FROM settings WHERE key='ai_guidance'");
  const n = await db.query('SELECT id, topic, content, created_by_name, created_at FROM ai_notes ORDER BY created_at DESC LIMIT 200');
  return { guidance: (g.rows[0] && g.rows[0].value) || '', notes: n.rows };
}

// AI contract-lawyer chat (auth required). Takes the agreement context + the conversation so far.
app.post('/api/ai/chat', auth.requireAuth, async (req, res) => {
  if (!ai.enabled) return res.status(503).json({ error: 'AI is not configured on this server' });
  try {
    const { agreement, messages, clauses } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages are required' });
    const playbook = await loadPlaybook();
    const out = await ai.chat(agreement || null, messages, { playbook: playbook, clauses: Array.isArray(clauses) ? clauses : null });
    res.json(out);
  } catch (err) {
    console.error('AI chat error:', err.message);
    res.status(500).json({ error: 'The AI lawyer could not respond right now.' });
  }
});

// Distill a reusable lesson from a conversation (the "teach the lawyer" loop).
app.post('/api/ai/suggest-note', auth.requireAuth, async (req, res) => {
  if (!ai.enabled) return res.status(503).json({ error: 'AI is not configured on this server' });
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages are required' });
    const note = await ai.suggestNote(messages);
    res.json(note);
  } catch (err) {
    console.error('Suggest-note error:', err.message);
    res.status(500).json({ error: 'Could not distill a note' });
  }
});

// ── AI playbook (house view + learned notes), auth required ────────────────────
app.get('/api/playbook', requireDb, auth.requireAuth, async (req, res) => {
  try { res.json(await loadPlaybook()); }
  catch (err) { console.error('Get playbook error:', err.message); res.status(500).json({ error: 'Could not load the playbook' }); }
});

app.put('/api/playbook/guidance', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const { guidance } = req.body || {};
    await db.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('ai_guidance',$1,now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [String(guidance || '')]
    );
    res.json({ ok: true });
  } catch (err) { console.error('Save guidance error:', err.message); res.status(500).json({ error: 'Could not save' }); }
});

app.post('/api/playbook/notes', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const { topic, content } = req.body || {};
    if (!content || !String(content).trim()) return res.status(400).json({ error: 'content is required' });
    const r = await db.query(
      'INSERT INTO ai_notes (topic, content, created_by_name) VALUES ($1,$2,$3) RETURNING id, topic, content, created_by_name, created_at',
      [(topic || '').trim() || null, String(content).trim(), req.user.name || req.user.email]
    );
    res.json({ note: r.rows[0] });
  } catch (err) { console.error('Add note error:', err.message); res.status(500).json({ error: 'Could not add note' }); }
});

app.delete('/api/playbook/notes/:id', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const r = await db.query('DELETE FROM ai_notes WHERE id=$1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  }
  catch (err) { console.error('Delete note error:', err.message); res.status(500).json({ error: 'Could not delete' }); }
});

function requireDb(req, res, next) {
  if (!db.enabled) return res.status(503).json({ error: 'Archive is not enabled on this server' });
  next();
}

// Sign-in is Google-only (domain-restricted). Password registration/login were removed so the
// only way into the archive is a verified @vendora.se Google account.

// Sign in with Google (domain-restricted). The frontend sends the Google ID-token credential.
app.post('/api/auth/google', authLimiter, requireDb, async (req, res) => {
  try {
    const { credential } = req.body || {};
    if (!credential) return res.status(400).json({ error: 'Missing Google credential' });
    let g;
    try {
      g = await auth.verifyGoogleToken(credential);
    } catch (e) {
      return res.status(e.forbidden ? 403 : 401).json({ error: e.message || 'Google sign-in failed' });
    }
    // Upsert by email; record the Google subject and name.
    const r = await db.query(
      `INSERT INTO users (email, google_sub, name)
         VALUES ($1,$2,$3)
       ON CONFLICT (email) DO UPDATE SET google_sub = EXCLUDED.google_sub,
         name = COALESCE(NULLIF(EXCLUDED.name,''), users.name)
       RETURNING id, email, name`,
      [g.email, g.sub, g.name || null]
    );
    const u = r.rows[0];
    auth.setAuthCookie(res, auth.signToken(u));
    res.json({ user: { id: u.id, email: u.email, name: u.name } });
  } catch (err) {
    console.error('Google auth error:', err.message);
    res.status(500).json({ error: 'Google sign-in failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  auth.clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const u = auth.readUser(req);
  if (!u) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: { id: u.uid, email: u.email, name: u.name } });
});

// ── Agreements archive (auth required) ─────────────────────────────────────────
app.post('/api/agreements', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const { type, counterpartyName, counterpartyEmail, data, status } = req.body || {};
    if (!type || !data) return res.status(400).json({ error: 'type and data are required' });
    const r = await db.query(
      `INSERT INTO agreements (type, counterparty_name, counterparty_email, data, status, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
      [type, counterpartyName || null, counterpartyEmail || null, data, status || 'draft', req.user.uid, req.user.name || req.user.email]
    );
    res.json({ id: r.rows[0].id, created_at: r.rows[0].created_at });
  } catch (err) {
    console.error('Save agreement error:', err.message);
    res.status(500).json({ error: 'Could not save agreement' });
  }
});

// Create an 'invited' agreement record + capability token when Vendora sends an invite, so the
// counterparty's submission can later update THIS row (auto-linking invite → returned data).
app.post('/api/invites', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const { type, counterpartyName, counterpartyEmail, data } = req.body || {};
    if (!type || !data) return res.status(400).json({ error: 'type and data are required' });
    const token = crypto.randomBytes(24).toString('base64url');
    const r = await db.query(
      `INSERT INTO agreements (type, counterparty_name, counterparty_email, data, status, update_token, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,'invited',$5,$6,$7) RETURNING id`,
      [type, counterpartyName || null, counterpartyEmail || null, data, token, req.user.uid, req.user.name || req.user.email]
    );
    res.json({ id: r.rows[0].id, token });
  } catch (err) {
    console.error('Create invite error:', err.message);
    res.status(500).json({ error: 'Could not create invite record' });
  }
});

// Public: the counterparty's fill submission updates its linked record, authorised by the token.
app.post('/api/agreements/:id/submit', publicLimiter, requireDb, async (req, res) => {
  try {
    const { token, data, counterpartyName, counterpartyEmail } = req.body || {};
    if (!token || !data) return res.status(400).json({ error: 'token and data are required' });
    const cur = await db.query('SELECT update_token, status FROM agreements WHERE id=$1', [req.params.id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Not found' });
    if (!cur.rows[0].update_token || !tokenEq(cur.rows[0].update_token, token)) return res.status(403).json({ error: 'Invalid token' });
    // Only accept a submission while the row is still awaiting one. Once Vendora has generated the
    // final agreement (status='generated'), a stray/replayed submit must not overwrite it.
    if (!['invited', 'submitted'].includes(cur.rows[0].status)) {
      return res.status(409).json({ error: 'This agreement is no longer open for submission.' });
    }
    await db.query(
      `UPDATE agreements SET data=$1, status='submitted', counterparty_name=COALESCE($2,counterparty_name),
         counterparty_email=COALESCE($3,counterparty_email), status_updated_at=now(), updated_at=now()
         WHERE id=$4 AND status IN ('invited','submitted')`,
      [data, counterpartyName || null, counterpartyEmail || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Submit error:', err.message);
    res.status(500).json({ error: 'Could not record submission' });
  }
});

app.get('/api/agreements', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT a.id, a.type, a.counterparty_name, a.counterparty_email, a.status,
              a.status_updated_at, a.last_reminder_at, a.created_by_name, a.created_at, a.updated_at,
              (SELECT COUNT(*) FROM agreement_files f WHERE f.agreement_id = a.id)::int AS file_count
       FROM agreements a ORDER BY a.updated_at DESC LIMIT 500`
    );
    res.json({ agreements: r.rows });
  } catch (err) {
    console.error('List agreements error:', err.message);
    res.status(500).json({ error: 'Could not list agreements' });
  }
});

app.get('/api/agreements/:id', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM agreements WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ agreement: r.rows[0] });
  } catch (err) {
    console.error('Get agreement error:', err.message);
    res.status(500).json({ error: 'Could not load agreement' });
  }
});

app.put('/api/agreements/:id', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const { counterpartyName, counterpartyEmail, data, status } = req.body || {};
    if (!data) return res.status(400).json({ error: 'data is required' });
    const r = await db.query(
      `UPDATE agreements SET counterparty_name=$1, counterparty_email=$2, data=$3,
         status=COALESCE($4,status), updated_at=now() WHERE id=$5 RETURNING id, updated_at`,
      [counterpartyName || null, counterpartyEmail || null, data, status || null, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ id: r.rows[0].id, updated_at: r.rows[0].updated_at });
  } catch (err) {
    console.error('Update agreement error:', err.message);
    res.status(500).json({ error: 'Could not update agreement' });
  }
});

app.delete('/api/agreements/:id', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const r = await db.query('DELETE FROM agreements WHERE id=$1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete agreement error:', err.message);
    res.status(500).json({ error: 'Could not delete agreement' });
  }
});

// Set the lifecycle status of an archive record (manual override from the edit view).
app.put('/api/agreements/:id/status', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const r = await db.query('UPDATE agreements SET status=$1, status_updated_at=now(), updated_at=now() WHERE id=$2 RETURNING status_updated_at', [status, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, status, status_updated_at: r.rows[0].status_updated_at });
  } catch (err) {
    console.error('Set status error:', err.message);
    res.status(500).json({ error: 'Could not update status' });
  }
});

// ── Signed-agreement files (stored as bytea in Postgres) ───────────────────────
// List file metadata for a record (never returns the bytea content).
app.get('/api/agreements/:id/files', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT id, filename, mime, size_bytes, uploaded_by, uploaded_at FROM agreement_files WHERE agreement_id=$1 ORDER BY uploaded_at DESC',
      [req.params.id]
    );
    res.json({ files: r.rows });
  } catch (err) {
    console.error('List files error:', err.message);
    res.status(500).json({ error: 'Could not list files' });
  }
});

// Upload a signed agreement. The file is sent as the raw request body (the global JSON parser
// ignores non-JSON content types, so it never hits the 2 MB JSON cap); filename comes via header.
// Uploading a signed document also advances the record to 'signed'.
app.post('/api/agreements/:id/files',
  requireDb, auth.requireAuth,
  express.raw({ type: () => true, limit: '15mb' }),
  async (req, res) => {
    try {
      const buf = req.body;
      if (!buf || !buf.length) return res.status(400).json({ error: 'Empty file' });
      const exists = await db.query('SELECT id FROM agreements WHERE id=$1', [req.params.id]);
      if (!exists.rows[0]) return res.status(404).json({ error: 'Not found' });
      const filename = safeFilename(decodeURIComponent(req.get('X-Filename') || 'signed-agreement'));
      const mime = (req.get('Content-Type') || 'application/octet-stream').split(';')[0].slice(0, 120);
      const who = req.user.name || req.user.email;
      const r = await db.query(
        `INSERT INTO agreement_files (agreement_id, filename, mime, size_bytes, content, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, filename, mime, size_bytes, uploaded_by, uploaded_at`,
        [req.params.id, filename, mime, buf.length, buf, who]
      );
      // A countersigned upload means the deal is done.
      const up = await db.query("UPDATE agreements SET status='signed', status_updated_at=now(), updated_at=now() WHERE id=$1 RETURNING status_updated_at", [req.params.id]);
      res.json({ file: r.rows[0], status: 'signed', status_updated_at: up.rows[0] && up.rows[0].status_updated_at });
    } catch (err) {
      console.error('Upload file error:', err.message);
      res.status(500).json({ error: 'Could not store file' });
    }
  });

// Download a stored file.
app.get('/api/agreements/:id/files/:fileId', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT filename, mime, content FROM agreement_files WHERE id=$1 AND agreement_id=$2',
      [req.params.fileId, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    const f = r.rows[0];
    res.set('Content-Type', f.mime || 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="' + safeFilename(f.filename) + '"');
    res.send(f.content);
  } catch (err) {
    console.error('Download file error:', err.message);
    res.status(500).json({ error: 'Could not download file' });
  }
});

// Delete a stored file.
app.delete('/api/agreements/:id/files/:fileId', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const r = await db.query('DELETE FROM agreement_files WHERE id=$1 AND agreement_id=$2', [req.params.fileId, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete file error:', err.message);
    res.status(500).json({ error: 'Could not delete file' });
  }
});

// Send a reminder to the counterparty on file. Status-aware: an 'invited' record still awaiting
// the counterparty's details gets a "please fill in" nudge with a fresh link to the same record;
// anything past that gets a "please sign and return" nudge. Recipient is always the stored
// counterparty email — never an arbitrary address — so this can't be used as an open relay.
app.post('/api/agreements/:id/remind', publicLimiter, requireDb, auth.requireAuth, async (req, res) => {
  try {
    const cur = await db.query(
      'SELECT counterparty_name, counterparty_email, type, status, update_token, data FROM agreements WHERE id=$1',
      [req.params.id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Not found' });
    const row = cur.rows[0];
    if (!row.counterparty_email) return res.status(400).json({ error: 'No counterparty email on file for this agreement.' });
    const transporter = getTransporter();
    if (!transporter) return res.json({ ok: true, sent: false, reason: 'SMTP not configured' });

    const TYPE = { da: 'Distributor Agreement', ra: 'Reseller Agreement', rb: 'Reseller Agreement — Simplified' };
    const typeLabel = TYPE[row.type] || 'agreement';
    const name = escHtml(row.counterparty_name || 'there');
    const kind = row.status === 'invited' ? 'fill' : 'sign';

    let link = '';
    if (kind === 'fill') {
      // Ensure the record has a capability token, then rebuild the same fill link so the
      // counterparty's submission still auto-links back to THIS record.
      let token = row.update_token;
      if (!token) {
        token = crypto.randomBytes(24).toString('base64url');
        await db.query('UPDATE agreements SET update_token=$1 WHERE id=$2', [token, req.params.id]);
      }
      const linkData = Object.assign({}, row.data || {}, { _aid: Number(req.params.id), _atok: token });
      link = 'https://' + req.get('host') + '/#fill=' + Buffer.from(JSON.stringify(linkData), 'utf8').toString('base64');
    }

    const btn = link
      ? `<div style="text-align:center;margin:26px 0"><a href="${escHtml(link)}" style="display:inline-block;background:#0F2240;color:#fff;padding:13px 30px;text-decoration:none;font-size:14px;font-weight:bold">${kind === 'fill' ? 'Fill in your details →' : 'Open the agreement →'}</a></div>`
      : '';
    const body = kind === 'fill'
      ? `<p style="color:#333;font-size:14px">This is a friendly reminder to fill in your company details for the <strong>${escHtml(typeLabel)}</strong> with Vendora Nordic AB. It only takes a few minutes.</p>`
      : `<p style="color:#333;font-size:14px">This is a friendly reminder regarding the <strong>${escHtml(typeLabel)}</strong> with Vendora Nordic AB. When you have a moment, please sign the agreement you received and return the countersigned copy to us.</p>`;

    await transporter.sendMail({
      from:    `"Vendora Nordic AB" <${process.env.SMTP_USER}>`,
      to:      row.counterparty_email,
      replyTo: 'ts@vendora.se',
      subject: `Reminder: ${typeLabel} with Vendora Nordic AB`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
          <div style="background:#0F2240;padding:20px 28px"><h1 style="color:#fff;font-size:18px;margin:0">Vendora Nordic AB</h1></div>
          <div style="padding:24px 28px;border:1px solid #e0e0e0;border-top:none">
            <p style="color:#333;font-size:14px">Hi ${name},</p>
            ${body}
            ${btn}
            <p style="color:#999;font-size:12px">If you have any questions, just reply to this email or contact us at ts@vendora.se.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
            <p style="color:#999;font-size:12px">Vendora Nordic AB · Ladugårdsvägen 1, 234 35 Lomma, Sweden</p>
          </div>
        </div>`,
    });
    const rem = await db.query('UPDATE agreements SET last_reminder_at=now() WHERE id=$1 RETURNING last_reminder_at', [req.params.id]);
    console.log(`Reminder (${kind}) sent for agreement ${req.params.id} to ${row.counterparty_email}`);
    res.json({ ok: true, sent: true, kind, last_reminder_at: rem.rows[0] && rem.rows[0].last_reminder_at });
  } catch (err) {
    console.error('Reminder error:', err.message);
    res.status(500).json({ error: 'Could not send the reminder' });
  }
});

// ── Static routes ─────────────────────────────────────────────────────────────
app.get('/i/:code', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('*',        (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`Vendora Agreement Generator on port ${PORT}`));
