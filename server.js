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

app.use(express.static(path.join(__dirname), { etag: false, lastModified: false }));

// ── In-memory invite store ────────────────────────────────────────────────────
const store = new Map();

app.post('/api/invite', (req, res) => {
  const data = req.body;
  if (!data || !data._type) return res.status(400).json({ error: 'Invalid data' });
  const code = crypto.randomBytes(5).toString('base64url');
  store.set(code, { data, created: Date.now() });
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [k, v] of store) { if (v.created < cutoff) store.delete(k); }
  res.json({ code, url: `/i/${code}` });
});

app.get('/api/invite/:code', (req, res) => {
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
app.post('/api/send-invite', async (req, res) => {
  const { toEmail, toName, fromName, agreementType, inviteUrl, salespersonEmail } = req.body;
  if (!toEmail || !inviteUrl) return res.status(400).json({ error: 'Missing fields' });

  const transporter = getTransporter();
  if (!transporter) {
    return res.json({ ok: true, sent: false, reason: 'SMTP not configured' });
  }

  const greeting = toName ? `Hi ${toName},` : 'Hi,';
  const typeLabel = agreementType === 'da' ? 'Distributor Agreement' : 'Reseller Agreement';

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
              ${fromName || 'Vendora Nordic AB'} has prepared a <strong>${typeLabel}</strong>
              and would like you to fill in your company details before the agreement is finalised.
            </p>
            <p style="color:#333;font-size:14px">
              It only takes a few minutes. The commercial terms have already been set —
              you just need to provide your legal company details and contact persons.
            </p>
            <div style="text-align:center;margin:28px 0">
              <a href="${inviteUrl}"
                 style="display:inline-block;background:#0F2240;color:#fff;padding:14px 32px;
                        text-decoration:none;font-size:15px;font-weight:bold">
                Fill in your details →
              </a>
            </div>
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
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Notification to Vendora when supplier submits ─────────────────────────────
app.post('/api/notify', async (req, res) => {
  const { supplierName, agreementType, reviewUrl, vendoraContact, proposalCount } = req.body;
  const transporter = getTransporter();
  if (!transporter) {
    console.log('SMTP not configured — skipping notification');
    return res.json({ ok: true, sent: false });
  }

  const recipients = ['ts@vendora.se'];
  if (vendoraContact && vendoraContact !== 'ts@vendora.se') recipients.push(vendoraContact);

  try {
    await transporter.sendMail({
      from:    `"Vendora Agreements" <${process.env.SMTP_USER}>`,
      to:      recipients.join(', '),
      subject: `${proposalCount > 0 ? '[' + proposalCount + ' proposed changes] ' : ''}${agreementType} details submitted — ${supplierName}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
          <div style="background:#0F2240;padding:20px 28px">
            <h1 style="color:#fff;font-size:18px;margin:0">Vendora Agreement Generator</h1>
          </div>
          <div style="padding:24px 28px;border:1px solid #e0e0e0;border-top:none">
            <h2 style="color:#0F2240;font-size:16px;margin-top:0">
              &#x2705; ${supplierName} has submitted their details
            </h2>
            <p style="color:#555;font-size:14px">
              <strong>${supplierName}</strong> has filled in their company details and contacts
              for the <strong>${agreementType}</strong>.
            </p>
            ${proposalCount > 0 ? `<div style="background:#FFF3CD;border:1px solid #ffe69c;border-radius:4px;padding:10px 14px;margin:12px 0;color:#856404;font-size:13px"><strong>&#x26A0; ${proposalCount} proposed change${proposalCount>1?'s':''} to your commercial terms.</strong> Review them on the page before generating the final agreement.</div>` : ''}
            <div style="text-align:center;margin:24px 0">
              <a href="${reviewUrl}"
                 style="display:inline-block;background:#0F2240;color:#fff;padding:12px 28px;
                        text-decoration:none;font-size:14px;font-weight:bold">
                Review &amp; Generate Agreement →
              </a>
            </div>
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
    res.json({ ok: true, sent: false, reason: err.message });
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
    const { agreement, messages } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages are required' });
    const playbook = await loadPlaybook();
    const out = await ai.chat(agreement || null, messages, playbook);
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
  try { await db.query('DELETE FROM ai_notes WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (err) { console.error('Delete note error:', err.message); res.status(500).json({ error: 'Could not delete' }); }
});

function requireDb(req, res, next) {
  if (!db.enabled) return res.status(503).json({ error: 'Archive is not enabled on this server' });
  next();
}

app.post('/api/auth/register', requireDb, async (req, res) => {
  try {
    const { email, password, name, signupCode } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const expected = process.env.SIGNUP_CODE || '';
    if (!expected || signupCode !== expected) return res.status(403).json({ error: 'Invalid or missing signup code' });
    const hash = await auth.hashPassword(password);
    let row;
    try {
      const r = await db.query(
        'INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING id, email, name',
        [String(email).trim().toLowerCase(), hash, (name || '').trim() || null]
      );
      row = r.rows[0];
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'An account with that email already exists' });
      throw e;
    }
    auth.setAuthCookie(res, auth.signToken(row));
    res.json({ user: { id: row.id, email: row.email, name: row.name } });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Sign in with Google (domain-restricted). The frontend sends the Google ID-token credential.
app.post('/api/auth/google', requireDb, async (req, res) => {
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

app.post('/api/auth/login', requireDb, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const r = await db.query('SELECT id, email, name, password_hash FROM users WHERE email=$1', [String(email).trim().toLowerCase()]);
    const u = r.rows[0];
    if (!u || !(await auth.verifyPassword(password, u.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    auth.setAuthCookie(res, auth.signToken(u));
    res.json({ user: { id: u.id, email: u.email, name: u.name } });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
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
app.post('/api/agreements/:id/submit', requireDb, async (req, res) => {
  try {
    const { token, data, counterpartyName, counterpartyEmail } = req.body || {};
    if (!token || !data) return res.status(400).json({ error: 'token and data are required' });
    const cur = await db.query('SELECT update_token FROM agreements WHERE id=$1', [req.params.id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Not found' });
    if (!cur.rows[0].update_token || cur.rows[0].update_token !== token) return res.status(403).json({ error: 'Invalid token' });
    await db.query(
      `UPDATE agreements SET data=$1, status='submitted', counterparty_name=COALESCE($2,counterparty_name),
         counterparty_email=COALESCE($3,counterparty_email), updated_at=now() WHERE id=$4`,
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
      `SELECT id, type, counterparty_name, counterparty_email, status, created_by_name, created_at, updated_at
       FROM agreements ORDER BY updated_at DESC LIMIT 500`
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
    await db.query('DELETE FROM agreements WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete agreement error:', err.message);
    res.status(500).json({ error: 'Could not delete agreement' });
  }
});

// ── Static routes ─────────────────────────────────────────────────────────────
app.get('/i/:code', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('*',        (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`Vendora Agreement Generator on port ${PORT}`));
