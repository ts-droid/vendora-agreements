const express    = require('express');
const path       = require('path');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));

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

// ── Static routes ─────────────────────────────────────────────────────────────
app.get('/i/:code', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('*',        (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`Vendora Agreement Generator on port ${PORT}`));
