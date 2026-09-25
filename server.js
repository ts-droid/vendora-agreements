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
// Sign-in is Google-only (tokens can't be guessed), so this only guards against request floods —
// sized so a whole office behind one shared IP can sign in at once.
const authLimiter   = rateLimit('auth',   60, 15 * 60 * 1000); // 60 sign-ins / 15 min / IP
const publicLimiter = rateLimit('public', 30, 10 * 60 * 1000); // 30 requests / 10 min / IP

// Escape untrusted strings before putting them in email HTML.
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
const DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || 'vendora.se').toLowerCase();

// Valid archive lifecycle statuses:
// draft → invited → submitted → generated → pending_signature (awaiting the CEO) → vendora_signed
// (approved + signed by the CEO) → sent (to the counterparty) → signed (fully executed);
// plus 'imported' for records brought in from a link.
const STATUSES = ['draft', 'invited', 'submitted', 'generated', 'pending_signature', 'vendora_signed', 'sent', 'signed', 'imported'];
// While awaiting or carrying the CEO's signature, an agreement's content is frozen.
const LOCKED = ['pending_signature', 'vendora_signed'];
// …including after it moves on to the counterparty: anything still carrying Vendora's signature.
function isLocked(row) { return LOCKED.includes(row.status) || !!row.vendora_signed_at; }
// Statuses that may only be reached through the signature workflow, never set by hand.
const WORKFLOW_ONLY = ['pending_signature', 'vendora_signed'];
// A signature can be requested once negotiation is done (never while still awaiting the counterparty).
const SIGNABLE_FROM = ['draft', 'submitted', 'generated', 'imported'];

// Roles. Admins see every agreement; everyone else sees only the agreements they created.
// The signer (the CEO) approves agreements for Vendora and is always an admin.
const SIGNER_EMAIL = (process.env.SIGNER_EMAIL || '').trim().toLowerCase();
const SIGNER_NAME = process.env.SIGNER_NAME || 'Andreas Höynälä';
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || 'ts@vendora.se').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean)
);
if (SIGNER_EMAIL) ADMIN_EMAILS.add(SIGNER_EMAIL);
function isAdmin(u) { return !!u && ADMIN_EMAILS.has(String(u.email || '').toLowerCase()); }
function isSigner(u) { return !!u && !!SIGNER_EMAIL && String(u.email || '').toLowerCase() === SIGNER_EMAIL; }
// Fields only the server may write into agreement data (the CEO's signature stamp comes solely from
// POST /sign). Stripped from every client-supplied payload so a stamp can't be forged.
function stripServerFields(data) {
  if (data && typeof data === 'object') delete data._vendoraSignature;
  return data;
}
function userPayload(u) {
  return { id: u.id != null ? u.id : u.uid, email: u.email, name: u.name, isAdmin: isAdmin(u), isSigner: isSigner(u),
    onboarded: !!u.onboarded_at };
}

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
    signer: !!SIGNER_EMAIL,
    signerName: SIGNER_NAME,
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

app.put('/api/playbook/guidance', requireDb, auth.requireAuth, requireAdmin, async (req, res) => {
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

app.delete('/api/playbook/notes/:id', requireDb, auth.requireAuth, requireAdmin, async (req, res) => {
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

// Load an agreement the current user may act on: admins may open any row, everyone else only the
// rows they created. Unknown and not-yours both answer 404, so ids can't be probed.
async function loadOwned(req, res) {
  const r = await db.query('SELECT * FROM agreements WHERE id=$1', [req.params.id]);
  const row = r.rows[0];
  if (!row || (!isAdmin(req.user) && row.created_by !== req.user.uid)) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return row;
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only admins can do this' });
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
       RETURNING id, email, name, onboarded_at`,
      [g.email, g.sub, g.name || null]
    );
    const u = r.rows[0];
    auth.setAuthCookie(res, auth.signToken(u));
    res.json({ user: userPayload(u) });
  } catch (err) {
    console.error('Google auth error:', err.message);
    res.status(500).json({ error: 'Google sign-in failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  auth.clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  const u = auth.readUser(req);
  if (!u) return res.status(401).json({ error: 'Not authenticated' });
  // The session token doesn't carry onboarding state; look it up (best-effort).
  let onboarded_at = null;
  if (db.enabled) {
    try { const r = await db.query('SELECT onboarded_at FROM users WHERE id=$1', [u.uid]); onboarded_at = r.rows[0] && r.rows[0].onboarded_at; }
    catch (e) { console.error('Onboarding lookup error:', e.message); }
  }
  res.json({ user: userPayload(Object.assign({}, u, { onboarded_at })) });
});

// The user finished or skipped the first-login walkthrough — don't show it again (on any device).
app.post('/api/me/onboarded', requireDb, auth.requireAuth, async (req, res) => {
  try {
    await db.query('UPDATE users SET onboarded_at = COALESCE(onboarded_at, now()) WHERE id=$1', [req.user.uid]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Onboarded error:', err.message);
    res.status(500).json({ error: 'Could not save' });
  }
});

// ── Agreements archive (auth required) ─────────────────────────────────────────
app.post('/api/agreements', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const { type, counterpartyName, counterpartyEmail, data, status } = req.body || {};
    if (!type || !data) return res.status(400).json({ error: 'type and data are required' });
    stripServerFields(data);
    const initial = status && STATUSES.includes(status) && !WORKFLOW_ONLY.includes(status) ? status : 'draft';
    const r = await db.query(
      `INSERT INTO agreements (type, counterparty_name, counterparty_email, data, status, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
      [type, counterpartyName || null, counterpartyEmail || null, data, initial, req.user.uid, req.user.name || req.user.email]
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
    stripServerFields(data);
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
    stripServerFields(data);
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
    // Admins see everything; everyone else only the agreements they created.
    const r = await db.query(
      `SELECT a.id, a.type, a.counterparty_name, a.counterparty_email, a.status,
              a.status_updated_at, a.last_reminder_at, a.created_by, a.created_by_name, a.created_at, a.updated_at,
              a.signature_requested_by_name, a.signature_requested_at, a.signature_note,
              a.vendora_signed_by, a.vendora_signed_at,
              (SELECT COUNT(*) FROM agreement_files f WHERE f.agreement_id = a.id)::int AS file_count
       FROM agreements a
       WHERE $1::boolean OR a.created_by = $2
       ORDER BY a.updated_at DESC LIMIT 500`,
      [isAdmin(req.user), req.user.uid]
    );
    res.json({ agreements: r.rows });
  } catch (err) {
    console.error('List agreements error:', err.message);
    res.status(500).json({ error: 'Could not list agreements' });
  }
});

app.get('/api/agreements/:id', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const row = await loadOwned(req, res); if (!row) return;
    delete row.update_token; // capability token never leaves the server once issued
    res.json({ agreement: row });
  } catch (err) {
    console.error('Get agreement error:', err.message);
    res.status(500).json({ error: 'Could not load agreement' });
  }
});

app.put('/api/agreements/:id', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const { counterpartyName, counterpartyEmail, data, status } = req.body || {};
    if (!data) return res.status(400).json({ error: 'data is required' });
    const row = await loadOwned(req, res); if (!row) return;
    // Content is frozen while awaiting / carrying the CEO's signature: an unchanged save is a
    // harmless no-op (e.g. re-downloading the .docx), but any real change must withdraw first.
    if (isLocked(row)) {
      const same = await db.query('SELECT data = $1::jsonb AS same FROM agreements WHERE id=$2', [data, req.params.id]);
      if (same.rows[0] && same.rows[0].same) return res.json({ id: row.id, updated_at: row.updated_at, locked: true });
      return res.status(409).json({ error: 'This agreement is locked for the CEO\'s signature. Withdraw the signature request before editing.', locked: true });
    }
    stripServerFields(data);
    // Workflow-only statuses can't be set through a plain save.
    const nextStatus = status && STATUSES.includes(status) && !WORKFLOW_ONLY.includes(status) ? status : null;
    const r = await db.query(
      `UPDATE agreements SET counterparty_name=$1, counterparty_email=$2, data=$3,
         status=COALESCE($4,status), updated_at=now() WHERE id=$5 RETURNING id, updated_at`,
      [counterpartyName || null, counterpartyEmail || null, data, nextStatus, req.params.id]
    );
    res.json({ id: r.rows[0].id, updated_at: r.rows[0].updated_at });
  } catch (err) {
    console.error('Update agreement error:', err.message);
    res.status(500).json({ error: 'Could not update agreement' });
  }
});

app.delete('/api/agreements/:id', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const row = await loadOwned(req, res); if (!row) return;
    await db.query('DELETE FROM agreements WHERE id=$1', [req.params.id]);
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
    if (WORKFLOW_ONLY.includes(status)) return res.status(400).json({ error: 'Use "Send to CEO for signature" — this status is set by the signature workflow.' });
    const row = await loadOwned(req, res); if (!row) return;
    if (row.status === 'pending_signature') {
      return res.status(409).json({ error: 'Awaiting the CEO\'s signature — withdraw the request first.' });
    }
    // Once the CEO has signed, the record can only move forward (to the counterparty / fully signed).
    if (row.vendora_signed_at && !['sent', 'signed'].includes(status)) {
      return res.status(409).json({ error: 'Already signed by Vendora — withdraw (voids the signature) to move it back.' });
    }
    const r = await db.query('UPDATE agreements SET status=$1, status_updated_at=now(), updated_at=now() WHERE id=$2 RETURNING status_updated_at', [status, req.params.id]);
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
    if (!(await loadOwned(req, res))) return;
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
      if (!(await loadOwned(req, res))) return;
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
    if (!(await loadOwned(req, res))) return;
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
    if (!(await loadOwned(req, res))) return;
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
    const row = await loadOwned(req, res); if (!row) return;
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

// ── CEO signature workflow ─────────────────────────────────────────────────────
// seller: request-signature → CEO: sign | return (with comment) → seller/admin: withdraw.
const TYPE_LABEL = { da: 'Distributor Agreement', ra: 'Reseller Agreement', rb: 'Reseller Agreement — Simplified' };
function oneLine(s) { return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').slice(0, 200); }

// The browser computes the cover sheet (key terms + deviations from standard); sanitise it before
// it goes into the signer's email.
function cleanSummary(s) {
  s = s && typeof s === 'object' ? s : {};
  const str = function (v, n) { return String(v == null ? '' : v).slice(0, n); };
  return {
    terms: Array.isArray(s.terms) ? s.terms.slice(0, 40).map(function (r) { return [str(r && r[0], 80), str(r && r[1], 400)]; }) : [],
    deviations: Array.isArray(s.deviations) ? s.deviations.slice(0, 60).map(function (d) { return str(d, 700); }) : [],
  };
}
function coverHtml(summary) {
  const rows = summary.terms.map(function (t) {
    return `<tr><td style="padding:5px 12px 5px 0;color:#666;font-size:13px;vertical-align:top;white-space:nowrap">${escHtml(t[0])}</td>`
      + `<td style="padding:5px 0;font-size:13px;color:#1a1a2e">${escHtml(t[1])}</td></tr>`;
  }).join('');
  const n = summary.deviations.length;
  const dev = n
    ? `<div style="background:#FFF3CD;border:1px solid #ffe69c;border-radius:4px;padding:10px 14px;margin:14px 0;color:#856404;font-size:13px">`
      + `<strong>&#x26A0; ${n} deviation${n > 1 ? 's' : ''} from Vendora's standard agreement</strong>`
      + `<ul style="margin:8px 0 0 18px;padding:0">${summary.deviations.map(function (d) { return '<li style="margin:3px 0">' + escHtml(d) + '</li>'; }).join('')}</ul></div>`
    : `<div style="background:#e6f2ea;border:1px solid #b7dfc3;border-radius:4px;padding:10px 14px;margin:14px 0;color:#1e7e34;font-size:13px">`
      + `<strong>&#x2714; No deviations from Vendora's standard agreement.</strong></div>`;
  return `<table style="border-collapse:collapse;width:100%">${rows}</table>${dev}`;
}
// title is trusted markup; callers escape any user data they put in it.
function mailShell(title, inner) {
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">`
    + `<div style="background:#0F2240;padding:20px 28px"><h1 style="color:#fff;font-size:18px;margin:0">Vendora Agreements</h1></div>`
    + `<div style="padding:24px 28px;border:1px solid #e0e0e0;border-top:none">`
    + `<h2 style="color:#0F2240;font-size:16px;margin-top:0">${title}</h2>${inner}`
    + `<hr style="border:none;border-top:1px solid #eee;margin:20px 0">`
    + `<p style="color:#999;font-size:12px">Vendora Nordic AB · Ladugårdsvägen 1, 234 35 Lomma, Sweden</p></div></div>`;
}
function btnHtml(href, label) {
  return `<div style="text-align:center;margin:24px 0"><a href="${escHtml(href)}" style="display:inline-block;background:#0F2240;color:#fff;`
    + `padding:12px 28px;text-decoration:none;font-size:14px;font-weight:bold">${escHtml(label)}</a></div>`;
}
async function sendMailSafe(msg) {
  const t = getTransporter();
  if (!t) return false;
  try { await t.sendMail(Object.assign({ from: `"Vendora Agreements" <${process.env.SMTP_USER}>` }, msg)); return true; }
  catch (e) { console.error('Mail error:', e.message); return false; }
}
function cpName(row) { return row.counterparty_name || (row.data && row.data.name) || 'the counterparty'; }

// Seller → CEO: freeze the negotiated agreement and ask the signer to approve it.
app.post('/api/agreements/:id/request-signature', requireDb, auth.requireAuth, async (req, res) => {
  try {
    if (!SIGNER_EMAIL) return res.status(503).json({ error: 'No signer is configured on this server (set SIGNER_EMAIL).' });
    const row = await loadOwned(req, res); if (!row) return;
    if (!SIGNABLE_FROM.includes(row.status)) {
      return res.status(409).json({ error: row.status === 'invited'
        ? 'Still waiting for the counterparty\'s details.'
        : 'This agreement can\'t be sent for signature from its current status.' });
    }
    const summary = cleanSummary((req.body || {}).summary);
    const who = req.user.name || req.user.email;
    const up = await db.query(
      `UPDATE agreements SET status='pending_signature', status_updated_at=now(), updated_at=now(),
         signature_requested_by=$1, signature_requested_by_name=$2, signature_requested_at=now(), signature_note=NULL,
         vendora_signed_by=NULL, vendora_signed_email=NULL, vendora_signed_at=NULL,
         data = data - '_vendoraSignature'
       WHERE id=$3 RETURNING status_updated_at, signature_requested_at`,
      [req.user.email, who, req.params.id]);
    const type = TYPE_LABEL[row.type] || 'Agreement';
    const notified = await sendMailSafe({
      to: SIGNER_EMAIL, replyTo: req.user.email,
      subject: oneLine(`Signature requested: ${type} — ${cpName(row)}`),
      html: mailShell(`&#x270D;&#xFE0F; Signature requested: ${escHtml(type)} with ${escHtml(cpName(row))}`,
        `<p style="color:#555;font-size:14px"><strong>${escHtml(who)}</strong> has finished negotiating this agreement and asks you to review and sign it for Vendora.</p>`
        + coverHtml(summary) + btnHtml('https://' + req.get('host') + '/#sign=' + row.id, 'Review & sign →')),
    });
    res.json({ ok: true, status: 'pending_signature', status_updated_at: up.rows[0].status_updated_at,
      signature_requested_at: up.rows[0].signature_requested_at, notified });
  } catch (err) {
    console.error('Request signature error:', err.message);
    res.status(500).json({ error: 'Could not request the signature' });
  }
});

// CEO approves and signs for Vendora. The stamp is written into the agreement data, so every later
// export of the .docx carries it; the content stays locked from here on.
app.post('/api/agreements/:id/sign', requireDb, auth.requireAuth, async (req, res) => {
  try {
    if (!isSigner(req.user)) return res.status(403).json({ error: 'Only the designated signer can sign for Vendora.' });
    const row = await loadOwned(req, res); if (!row) return;
    const stamp = { name: SIGNER_NAME, title: 'CEO', email: req.user.email, at: new Date().toISOString() };
    const up = await db.query(
      `UPDATE agreements SET status='vendora_signed', status_updated_at=now(), updated_at=now(),
         vendora_signed_by=$1, vendora_signed_email=$2, vendora_signed_at=now(),
         data = jsonb_set(data, '{_vendoraSignature}', $3::jsonb)
       WHERE id=$4 AND status='pending_signature' RETURNING vendora_signed_at, data`,
      [SIGNER_NAME, req.user.email, JSON.stringify(stamp), req.params.id]);
    if (!up.rows[0]) return res.status(409).json({ error: 'This agreement is not awaiting a signature.' });
    if (row.signature_requested_by) {
      const type = TYPE_LABEL[row.type] || 'agreement';
      await sendMailSafe({
        to: row.signature_requested_by,
        subject: oneLine(`Signed by Vendora: ${type} — ${cpName(row)}`),
        html: mailShell(`&#x2714; Signed by ${escHtml(SIGNER_NAME)}`,
          `<p style="color:#555;font-size:14px">${escHtml(SIGNER_NAME)} approved and signed the ${escHtml(type)} with <strong>${escHtml(cpName(row))}</strong>.`
          + ` Download the signed agreement from the archive and send it to the counterparty for countersignature.</p>`
          + btnHtml('https://' + req.get('host') + '/', 'Open the archive →')),
      });
    }
    res.json({ ok: true, status: 'vendora_signed', vendora_signed_at: up.rows[0].vendora_signed_at, data: up.rows[0].data });
  } catch (err) {
    console.error('Sign error:', err.message);
    res.status(500).json({ error: 'Could not sign the agreement' });
  }
});

// CEO sends it back to the seller with a comment instead of signing.
app.post('/api/agreements/:id/return', requireDb, auth.requireAuth, async (req, res) => {
  try {
    if (!isSigner(req.user)) return res.status(403).json({ error: 'Only the designated signer can return an agreement.' });
    const row = await loadOwned(req, res); if (!row) return;
    const note = String((req.body || {}).note || '').trim().slice(0, 2000);
    if (!note) return res.status(400).json({ error: 'Add a comment so the seller knows what to change.' });
    const up = await db.query(
      `UPDATE agreements SET status='generated', status_updated_at=now(), updated_at=now(), signature_note=$1
       WHERE id=$2 AND status='pending_signature' RETURNING status_updated_at`,
      [note, req.params.id]);
    if (!up.rows[0]) return res.status(409).json({ error: 'This agreement is not awaiting a signature.' });
    if (row.signature_requested_by) {
      const type = TYPE_LABEL[row.type] || 'agreement';
      await sendMailSafe({
        to: row.signature_requested_by, replyTo: req.user.email,
        subject: oneLine(`Returned for changes: ${type} — ${cpName(row)}`),
        html: mailShell(`&#x21A9;&#xFE0F; Returned for changes`,
          `<p style="color:#555;font-size:14px">${escHtml(SIGNER_NAME)} returned the ${escHtml(type)} with <strong>${escHtml(cpName(row))}</strong> instead of signing:</p>`
          + `<blockquote style="border-left:3px solid #ffe69c;margin:12px 0;padding:6px 12px;color:#555;font-size:14px;white-space:pre-wrap">${escHtml(note)}</blockquote>`
          + `<p style="color:#555;font-size:14px">Make the changes, then send it for signature again.</p>`
          + btnHtml('https://' + req.get('host') + '/', 'Open the archive →')),
      });
    }
    res.json({ ok: true, status: 'generated', status_updated_at: up.rows[0].status_updated_at });
  } catch (err) {
    console.error('Return error:', err.message);
    res.status(500).json({ error: 'Could not return the agreement' });
  }
});

// Seller/admin pulls it back out of the signature workflow (voids Vendora's signature if present).
app.post('/api/agreements/:id/withdraw', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const row = await loadOwned(req, res); if (!row) return;
    if (!isLocked(row)) return res.status(409).json({ error: 'Nothing to withdraw.' });
    const up = await db.query(
      `UPDATE agreements SET status='generated', status_updated_at=now(), updated_at=now(),
         vendora_signed_by=NULL, vendora_signed_email=NULL, vendora_signed_at=NULL, signature_note=NULL,
         data = data - '_vendoraSignature'
       WHERE id=$1 RETURNING status_updated_at`, [req.params.id]);
    // Voiding an actual signature is worth telling the signer about.
    if (row.vendora_signed_at && SIGNER_EMAIL) {
      await sendMailSafe({
        to: SIGNER_EMAIL,
        subject: oneLine(`Signature voided: ${TYPE_LABEL[row.type] || 'Agreement'} — ${cpName(row)}`),
        html: mailShell('Signature voided',
          `<p style="color:#555;font-size:14px">${escHtml(req.user.name || req.user.email)} withdrew the ${escHtml(TYPE_LABEL[row.type] || 'agreement')} with`
          + ` <strong>${escHtml(cpName(row))}</strong>, voiding your signature. It will come back to you if it is sent for signature again.</p>`),
      });
    }
    res.json({ ok: true, status: 'generated', status_updated_at: up.rows[0].status_updated_at });
  } catch (err) {
    console.error('Withdraw error:', err.message);
    res.status(500).json({ error: 'Could not withdraw' });
  }
});

// ── Static routes ─────────────────────────────────────────────────────────────
app.get('/i/:code', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('*',        (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`Vendora Agreement Generator on port ${PORT}`));
