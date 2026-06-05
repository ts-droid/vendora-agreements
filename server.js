const express    = require('express');
const path       = require('path');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname)));

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

// ── Notification endpoint ─────────────────────────────────────────────────────
app.post('/api/notify', async (req, res) => {
  const { supplierName, agreementType, reviewUrl, vendoraContact } = req.body;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log('SMTP not configured — skipping email notification');
    return res.json({ ok: true, sent: false, reason: 'SMTP not configured' });
  }

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const recipients = ['ts@vendora.se'];
  if (vendoraContact && vendoraContact !== 'ts@vendora.se') recipients.push(vendoraContact);

  try {
    await transporter.sendMail({
      from:    `"Vendora Agreements" <${process.env.SMTP_USER}>`,
      to:      recipients.join(', '),
      subject: `${agreementType} details submitted — ${supplierName}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
          <div style="background:#0F2240;padding:20px 28px">
            <h1 style="color:#fff;font-size:18px;margin:0">Vendora Agreement Generator</h1>
          </div>
          <div style="padding:24px 28px;border:1px solid #e0e0e0;border-top:none">
            <h2 style="color:#0F2240;font-size:16px;margin-top:0">
              ✅ ${supplierName} has submitted their details
            </h2>
            <p style="color:#555;font-size:14px">
              <strong>${supplierName}</strong> has filled in their company details and contacts
              for the <strong>${agreementType}</strong>.
            </p>
            <p style="color:#555;font-size:14px">
              Click the button below to open the review page and generate the final agreement.
            </p>
            <a href="${reviewUrl}"
               style="display:inline-block;background:#0F2240;color:#fff;padding:12px 24px;
                      text-decoration:none;font-size:14px;font-weight:bold;margin:8px 0">
              Review &amp; Generate Agreement →
            </a>
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
    console.error('Email error:', err.message);
    res.json({ ok: true, sent: false, reason: err.message });
  }
});

// ── Static routes ─────────────────────────────────────────────────────────────
app.get('/i/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Vendora Agreement Generator running on port ${PORT}`);
});
