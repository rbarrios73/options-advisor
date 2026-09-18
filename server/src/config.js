import 'dotenv/config';

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// fileURLToPath, not new URL().pathname: on Windows the latter yields "/C:/Users/..." with a
// leading slash, which fs then fails to write. The bug only shows on Windows, which is why it
// survived a Linux-only test run.
const here = dirname(fileURLToPath(import.meta.url));

export const config = {
  // Render (and most hosts) hand the port in as PORT and expect the app to use it verbatim.
  port: Number(process.env.PORT ?? 4000),

  production: process.env.NODE_ENV === 'production',

  // 'tradier' for real chains, 'mock' for the synthetic provider (no token, no network).
  provider: process.env.PROVIDER ?? 'mock',

  tradierToken: process.env.TRADIER_TOKEN ?? '',
  tradierMode: process.env.TRADIER_MODE ?? 'sandbox',

  // Chains are cached for this long so repeated scans in a session do not burn the rate limit.
  cacheTtlMs: Number(process.env.CACHE_TTL_MS ?? 5 * 60 * 1000),

  // Where the watchlist and saved filters live. A file, deliberately: this is a single-user tool
  // and a database would be ceremony. On a host with an ephemeral disk, point DATA_FILE at a
  // mounted volume or expect the watchlist to reset to its defaults on every deploy.
  dataFile: process.env.DATA_FILE ?? join(here, '..', 'data', 'state.json'),

  // The built front end, served by this same process in production so the whole thing is one
  // service rather than two. Empty in development, where Vite serves it and proxies /api here.
  webDist: process.env.WEB_DIST ?? join(here, '..', '..', 'web', 'dist'),

  // Optional HTTP basic auth. Unset means the app is open to anyone with the URL — fine on
  // localhost, not fine on a public host, where strangers would be spending your Tradier quota.
  authUser: process.env.APP_USER ?? '',
  authPassword: process.env.APP_PASSWORD ?? '',

  riskFreeRate: Number(process.env.RISK_FREE_RATE ?? 0.04),
};
