// Authentication: bcrypt password hashing + stateless JWT stored in an httpOnly cookie.
// Registration is gated by SIGNUP_CODE so the public URL can't be freely signed up against.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

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
function hashPassword(pw) { return bcrypt.hash(pw, 10); }
function verifyPassword(pw, hash) { return bcrypt.compare(pw, hash); }

module.exports = {
  signToken, setAuthCookie, clearAuthCookie, readUser, requireAuth,
  hashPassword, verifyPassword, COOKIE,
};
