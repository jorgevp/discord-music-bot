import crypto from 'node:crypto';
import { config } from '../config.js';

const COOKIE_NAME = 'mb_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

const loginAttempts = new Map();

function sign(payload) {
  return crypto.createHmac('sha256', config.get().web.sessionSecret).update(payload).digest('base64url');
}

/** Changes whenever the password changes, which invalidates every existing session. */
function passwordVersion() {
  return crypto.createHash('sha256').update(config.get().web.passwordHash || '').digest('base64url').slice(0, 12);
}

export function createSessionToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS, pv: passwordVersion() })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !config.get().web.passwordHash) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > Date.now() && data.pv === passwordVersion();
  } catch {
    return false;
  }
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

export function isAuthenticatedCookieHeader(cookieHeader) {
  return verifySessionToken(parseCookies(cookieHeader)[COOKIE_NAME]);
}

export function setSessionCookie(req, res) {
  const attributes = [`${COOKIE_NAME}=${createSessionToken()}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_TTL_MS / 1000}`];
  if (req.secure) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** WebSocket handshakes must come from the dashboard's own origin (or the configured public URL). */
export function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).host;
    const { publicUrl } = config.get().web;
    return host === req.headers.host || Boolean(publicUrl && host === new URL(publicUrl).host);
  } catch {
    return false;
  }
}

export function requireAuth(req, res, next) {
  if (isAuthenticatedCookieHeader(req.headers.cookie)) return next();
  res.status(401).json({ error: 'Not signed in.' });
}

/** Simple per-IP brute-force protection for the login form. */
export function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return { allowed: true };
  }
  entry.count++;
  if (entry.count > LOGIN_MAX_ATTEMPTS) return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  return { allowed: true };
}

export function resetLoginRateLimit(ip) {
  loginAttempts.delete(ip);
}
