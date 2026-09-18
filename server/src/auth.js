// Optional HTTP basic auth, for when this runs somewhere with a public URL.
//
// Basic auth is a low bar — it is a password in a header over TLS, with no lockout and no
// sessions. It is here because the alternative on a public host is no bar at all, and because
// the thing being protected is a screener and a broker *read* token, not an order router. If
// you ever give this app a token that can trade, replace this with something real.

import { timingSafeEqual } from 'node:crypto';

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

    res.set('WWW-Authenticate', 'Basic realm="Options Advisor", charset="UTF-8"');
    res.status(401).json({ error: 'Authentication required.' });
  };
}
