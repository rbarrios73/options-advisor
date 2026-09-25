// Two ways in, depending on how the app is deployed.
//
//   • Single user (no DATABASE_URL): HTTP basic auth with one shared password. A low bar — a
//     password in a header over TLS, no lockout, no sessions — but the alternative on a public
//     host is no bar at all. What it protects is a screener and a broker READ token, not an
//     order router. If this app is ever given a token that can trade, replace it.
//   • Accounts (DATABASE_URL set): email and password, a session cookie, roles.
//
// Neither is a password reset flow, because that needs email this app cannot send. An admin sets
// a new password instead, and doing so ends that account's sessions.

import { timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'oa_session';

// --- single-user mode --------------------------------------------------------------------------

export function basicAuth({ user, password }) {
  if (!password) return null; // not configured: no gate

  const expected = Buffer.from(`${user || 'admin'}:${password}`);

  return function guard(req, res, next) {
    // Left open so a host's health check does not need credentials.
    if (req.path === '/api/health') return next();

    const header = req.get('authorization') ?? '';
    const [scheme, encoded] = header.split(' ');

    if (scheme === 'Basic' && encoded) {
      const supplied = Buffer.from(encoded, 'base64');

      // Compare against a fixed-length digest-free buffer only when the lengths match;
      // timingSafeEqual throws on a length mismatch, which would itself leak the length.
      if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return next();
    }

    res.set('WWW-Authenticate', 'Basic realm="Option Advisor", charset="UTF-8"');
    res.status(401).json({ error: 'Authentication required.' });
  };
}

// --- accounts mode -------------------------------------------------------------------------------

/** Minimal cookie header parser — one cookie is not worth a dependency. */
export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function sessionCookie(token, { expiresAt, secure }) {
  const attributes = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly', // JavaScript cannot read it, so an XSS bug cannot walk off with the session
    'SameSite=Lax', // another site's page cannot make the browser send it on a POST
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function clearedCookie({ secure }) {
  return sessionCookie('', { expiresAt: new Date(0), secure });
}

/**
 * Attaches req.user when the session cookie names a live session. It never rejects on its own —
 * requireUser and requireAdmin do that — so that public routes stay public and the front end can
 * ask "who am I" and be told "nobody" rather than being bounced.
 */
export function sessionUser(users) {
  return async function attach(req, _res, next) {
    try {
      req.user = await users.userForToken(readCookie(req, SESSION_COOKIE));
    } catch (error) {
      // A database blip must not look like a forged session; log it and continue unauthenticated.
      console.error('session lookup failed:', error.message);
      req.user = null;
    }
    next();
  };
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrators only.' });
  next();
}

/**
 * A crude per-address rate limit on sign-in attempts, held in memory.
 *
 * In memory is honest about what it is: one process, and the counters reset when it restarts.
 * It exists to make online guessing slow, not to be a security control — scrypt is what makes a
 * stolen hash expensive, and the limit is what makes a login form tedious.
 */
export function loginRateLimit({ attempts = 10, windowMs = 15 * 60_000 } = {}) {
  const seen = new Map();

  return function limit(req, res, next) {
    const now = Date.now();
    const key = req.ip ?? 'unknown';

    // Opportunistic sweep: this map must not grow without bound on a long-lived process.
    if (seen.size > 5000) {
      for (const [k, v] of seen) if (now - v.start > windowMs) seen.delete(k);
    }

    const entry = seen.get(key);
    if (!entry || now - entry.start > windowMs) {
      seen.set(key, { start: now, count: 1 });
      return next();
    }

    entry.count += 1;
    if (entry.count > attempts) {
      const retryAfter = Math.ceil((entry.start + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: `Too many sign-in attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.` });
    }
    next();
  };
}
