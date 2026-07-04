// Authentication: Google Sign-In (domain-restricted) issuing a stateless JWT in an httpOnly
// cookie. Password login/registration were removed — the only way in is a verified @vendora.se
// Google account.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
// Only accounts on this domain may sign in (empty = fall back to '@' any, but we require it set).
const ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || 'vendora.se').toLowerCase();
const googleEnabled = !!GOOGLE_CLIENT_ID;
const googleClient = googleEnabled ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// Verify a Google ID token (credential from Sign in with Google), enforce the allowed
// domain, and return { sub, email, name } — or throw with a user-safe message.
async function verifyGoogleToken(idToken) {
  if (!googleClient) throw new Error('Google login is not configured');
  const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
  const p = ticket.getPayload();
  if (!p || !p.email || !p.email_verified) throw new Error('Google account email is not verified');
  const email = String(p.email).toLowerCase();
  const domain = email.split('@')[1] || '';
  const hdOk = !p.hd || String(p.hd).toLowerCase() === ALLOWED_DOMAIN;
  if (domain !== ALLOWED_DOMAIN || !hdOk) {
    const err = new Error('Only @' + ALLOWED_DOMAIN + ' accounts may sign in');
    err.forbidden = true;
    throw err;
  }
  return { sub: p.sub, email, name: p.name || (p.given_name || '') };
}

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('[auth] JWT_SECRET not set — using an ephemeral secret; logins will not survive a restart. Set JWT_SECRET in production.');
}

const COOKIE = 'vendora_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function signToken(user) {
  return jwt.sign({ uid: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
}
function setAuthCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE_MS,
  });
}
function clearAuthCookie(res) {
  res.clearCookie(COOKIE);
}
function readUser(req) {
  try {
    const t = req.cookies && req.cookies[COOKIE];
    if (!t) return null;
    return jwt.verify(t, JWT_SECRET);
  } catch (e) {
    return null;
  }
}
function requireAuth(req, res, next) {
  const u = readUser(req);
  if (!u) return res.status(401).json({ error: 'Not authenticated' });
  req.user = u;
  next();
}
module.exports = {
  signToken, setAuthCookie, clearAuthCookie, readUser, requireAuth, COOKIE,
  verifyGoogleToken, googleEnabled, GOOGLE_CLIENT_ID, ALLOWED_DOMAIN,
};
