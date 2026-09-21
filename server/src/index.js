import { existsSync } from 'node:fs';
import { join } from 'node:path';

import express from 'express';
import cors from 'cors';

import { config } from './config.js';
import { basicAuth } from './auth.js';
import { createProvider } from './providers/index.js';
import { createStore } from './store.js';
import { createScanner } from './scan.js';
import { DEFAULT_FILTERS, STRATEGIES, atmImpliedVol } from './domain/strategies.js';
import { DEFAULT_WEIGHTS } from './domain/score.js';
import { daysBetween } from './domain/math.js';

const app = express();

// Behind Render's load balancer, so req.protocol and req.ip mean something.
if (config.production) app.set('trust proxy', 1);

// In development the UI is served by Vite on another port, so it needs CORS. In production it
// is served by this same process, so any cross-origin request is somebody else's page calling
// this API — there is no reason to permit that.
if (!config.production) app.use(cors());

app.use(express.json());

const guard = basicAuth({ user: config.authUser, password: config.authPassword });
if (guard) app.use(guard);

const store = createStore(config.dataFile);
const provider = createProvider(config);
const scanner = createScanner({ provider, cacheTtlMs: config.cacheTtlMs });

const wrap = (handler) => (req, res) => {
  handler(req, res).catch((error) => {
    console.error(`${req.method} ${req.path} failed:`, error.message);
    res.status(500).json({ error: error.message });
  });
};

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, provider: provider.name, strategies: STRATEGIES });
});

app.get(
  '/api/settings',
  wrap(async (_req, res) => {
    const state = await store.read();
    res.json({
      ...state,
      defaults: { filters: DEFAULT_FILTERS, weights: DEFAULT_WEIGHTS },
      provider: provider.name,
    });
  }),
);

app.put(
  '/api/watchlist',
  wrap(async (req, res) => {
    const incoming = Array.isArray(req.body?.watchlist) ? req.body.watchlist : [];

    const watchlist = incoming
      .map((entry) => ({
        symbol: String(entry.symbol ?? '').trim().toUpperCase(),
        note: String(entry.note ?? '').slice(0, 200),
        // Optional, and set by hand: no free feed gives a reliable earnings date, and guessing
        // one is worse than leaving it blank. If it is set, the scan flags expiries beyond it.
        earnings: entry.earnings ? String(entry.earnings).slice(0, 10) : null,
      }))
      .filter((entry) => /^[A-Z.]{1,6}$/.test(entry.symbol));

    res.json(await store.setWatchlist(dedupe(watchlist)));
  }),
);

app.put(
  '/api/filters',
  wrap(async (req, res) => {
    const filters = { ...DEFAULT_FILTERS, ...(req.body?.filters ?? {}) };
    const weights = { ...DEFAULT_WEIGHTS, ...(req.body?.weights ?? {}) };
    res.json(await store.update({ filters, weights }));
  }),
);

app.post(
  '/api/scan',
  wrap(async (req, res) => {
    const state = await store.read();

    const symbols = req.body?.symbols?.length
      ? req.body.symbols.map((s) => String(s).toUpperCase())
      : state.watchlist.map((w) => w.symbol);

    const filters = { ...state.filters, ...(req.body?.filters ?? {}) };
    const weights = { ...state.weights, ...(req.body?.weights ?? {}) };

    if (req.body?.fresh) scanner.clearCache();

    const result = await scanner.scan({
      symbols,
      filters,
      weights,
      limit: Number(req.body?.limit ?? 50),
    });

    res.json(annotateEarnings(result, state.watchlist));
  }),
);

// --- simulator --------------------------------------------------------------------------------
//
// The simulator does all its arithmetic in the browser (see domain/simulate.js), so the server's
// only job is to hand it a quote, the expiries, and one expiry's chain.

const SYMBOL = /^[A-Z.]{1,6}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);

function symbolParam(req, res) {
  const symbol = String(req.query.symbol ?? '').trim().toUpperCase();
  if (!SYMBOL.test(symbol)) {
    res.status(400).json({ error: 'symbol must be 1–6 letters, like SPY or BRK.B' });
    return null;
  }
  return symbol;
}

app.get(
  '/api/expirations',
  wrap(async (req, res) => {
    const symbol = symbolParam(req, res);
    if (!symbol) return;

    const asOf = today();
    const [quote, expirations] = await Promise.all([
      scanner.quote(symbol),
      scanner.expirations(symbol),
    ]);

    res.json({
      symbol,
      spot: quote.last,
      description: quote.description,
      asOf,
      expirations: expirations
        .map((date) => ({ date, dte: daysBetween(asOf, date) }))
        .filter((e) => e.dte >= 0),
    });
  }),
);

app.get(
  '/api/chain',
  wrap(async (req, res) => {
    const symbol = symbolParam(req, res);
    if (!symbol) return;

    const expiration = String(req.query.expiration ?? '');
    if (!ISO_DATE.test(expiration)) {
      res.status(400).json({ error: 'expiration must be a date, YYYY-MM-DD' });
      return;
    }

    const { quote, chain } = await scanner.chain(symbol, expiration);
    const spot = quote.last;
    const asOf = today();

    // Puts only: the simulator builds put credit spreads, and a full chain on SPY is several
    // hundred strikes per side — no reason to ship the half that is never read.
    const puts = chain.options.filter((o) => o.type === 'put').sort((a, b) => a.strike - b.strike);

    res.json({
      symbol,
      spot,
      description: quote.description,
      expiration,
      asOf,
      dte: daysBetween(asOf, expiration),
      // Taken from both sides, as the screener does, so the probabilities agree between pages.
      atmIv: atmImpliedVol(chain.options, spot),
      options: puts,
    });
  }),
);

// The built front end, when there is one. Two services on a host is two things to configure and
// two things to pay for; one process serving both is neither.
const indexHtml = join(config.webDist, 'index.html');
const hasBuiltUi = existsSync(indexHtml);

if (hasBuiltUi) {
  // Vite fingerprints everything under /assets, so those are safe to cache hard. index.html is
  // not fingerprinted — it is what points at the current bundle — so it must never be cached,
  // or a deploy leaves browsers asking for a bundle that no longer exists.
  app.use('/assets', express.static(join(config.webDist, 'assets'), { maxAge: '1y', immutable: true }));
  app.use(express.static(config.webDist, { index: false }));

  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(indexHtml));
}

app.use('/api', (_req, res) => res.status(404).json({ error: 'No such endpoint.' }));

app.listen(config.port, () => {
  const where = config.production ? `port ${config.port}` : `http://localhost:${config.port}`;
  console.log(`options-advisor on ${where}  (provider: ${provider.name})`);

  if (provider.name === 'mock') {
    console.log('Provider is "mock": chains are synthetic. Set PROVIDER=tradier for real data.');
  }
  if (hasBuiltUi) {
    console.log('Serving the built UI from this process — open the same address in a browser.');
  }
  if (config.production && !guard) {
    console.warn('WARNING: no APP_PASSWORD set. Anyone with this URL can scan, and spend your data quota.');
  }
});

/** Flags any candidate whose expiry sits beyond a hand-entered earnings date. */
function annotateEarnings(result, watchlist) {
  const bySymbol = new Map(watchlist.map((w) => [w.symbol, w.earnings]).filter(([, e]) => e));
  if (bySymbol.size === 0) return result;

  return {
    ...result,
    candidates: result.candidates.map((c) => {
      const earnings = bySymbol.get(c.symbol);
      if (!earnings) return c;
      return { ...c, earningsBeforeExpiry: earnings <= c.expiration ? earnings : null };
    }),
  };
}

function dedupe(watchlist) {
  const seen = new Set();
  return watchlist.filter((w) => (seen.has(w.symbol) ? false : seen.add(w.symbol)));
}
