/* Understory — passwords and sessions.
   scrypt via node:crypto; opaque session tokens stored as SHA-256.
   No dependencies, no JWT, no signing keys to leak. */

import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { q, nowIso } from './db.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const SESSION_COOKIE = 'us_session';
const SESSION_DAYS = 7;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  q.run(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    sha256(token), userId, nowIso(), expires,
  );
  return { token, expires };
}

export function destroySession(token) {
  if (!token) return;
  q.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

export function userForToken(token) {
  if (!token) return null;
  const row = q.get(
    `SELECT s.expires_at, u.id, u.email, u.plan, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`, sha256(token),
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    q.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
    return null;
  }
  return { id: row.id, email: row.email, plan: row.plan, created_at: row.created_at };
}

/* ── cookies ─────────────────────────────────────────────── */

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, expires, secure) {
  const maxAge = Math.floor((new Date(expires).getTime() - Date.now()) / 1000);
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearCookie(secure) {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export const readSessionCookie = (req) =>
  parseCookies(req.headers.cookie ?? '')[SESSION_COOKIE] ?? null;

export const isSecureRequest = (req) =>
  req.socket?.encrypted === true ||
  String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';

/* ── login throttling ────────────────────────────────────── */

const attempts = new Map(); // key -> { count, resetAt }
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

export function throttleKey(req, email) {
  const ip = req.socket?.remoteAddress ?? 'local';
  return `${ip}|${String(email).toLowerCase()}`;
}

export function tooManyAttempts(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (rec.resetAt < Date.now()) { attempts.delete(key); return false; }
  return rec.count >= MAX_ATTEMPTS;
}

export function noteAttempt(key) {
  const rec = attempts.get(key);
  if (!rec || rec.resetAt < Date.now()) {
    attempts.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
    return;
  }
  rec.count += 1;
}

export function clearAttempts(key) {
  attempts.delete(key);
}
