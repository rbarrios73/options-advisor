import { existsSync } from 'node:fs';
import { join } from 'node:path';

import express from 'express';
import cors from 'cors';

import {
  SESSION_COOKIE,
  basicAuth,
  clearedCookie,
  loginRateLimit,
  readCookie,
  requireAdmin,
  requireUser,
  sessionCookie,
  sessionUser,
} from './auth.js';
import { migrate } from './db.js';
import { UserError, createUserStore, passwordProblem } from './users.js';
import { createProvider } from './providers/index.js';
import { createDbStore, createFileStore } from './store.js';
import { createScanner } from './scan.js';
import { DEFAULT_FILTERS, STRATEGIES, atmImpliedVol } from './domain/strategies.js';
import { DEFAULT_WEIGHTS } from './domain/score.js';
import { daysBetween } from './domain/math.js';
import { DEFAULT_RANGE, intervalFor, isRange, startDateFor } from './domain/history.js';
import { cleanWatchlist } from './domain/watchlist.js';
import { DIGEST_LIMIT } from './domain/advice.js';
import { cleanTheme } from './domain/theme.js';
import {
  POSITION_TYPES,
  breachOf,
  cleanGoals,
  daysLeft,
  premiumTotals,
} from './domain/positions.js';
import { createAdvisor } from './advisor.js';

/**
 * Builds the Express app.
 *
 * A factory rather than a module that starts itself, so the tests can hand it an in-process
 * Postgres and a mock provider and drive the real routes over real HTTP.
 *
 * @param {object} options
 *   config    as config.js exports it, or a partial override in tests
 *   db        a Postgres pool (or anything with query()). null means single-user mode.
 */
export function createApp({ config, db = null }) {
    const app = express();

    // Behind Render's load balancer, so req.protocol and req.ip mean something.
    if (config.production) app.set('trust proxy', 1);

  // In development the UI is served by Vite on another port, so it needs CORS. In production it
  // is served by this same process, so any cross-origin request is somebody else's page calling
  // this API — there is no reason to permit that.
  if (!config.production) app.use(cors());

  app.use(express.json());

  // Two modes, decided by whether there is a database. See db.js for why accounts need one.
  const accounts = Boolean(db);

  const users = accounts ? createUserStore(db, { sessionTtlDays: config.sessionTtlDays }) : null;
  const store = accounts ? createDbStore(db) : createFileStore(config.dataFile);

  // Without accounts, the whole app sits behind one shared password.
  const guard = accounts ? null : basicAuth({ user: config.authUser, password: config.authPassword });
  if (guard) app.use(guard);
  if (accounts) app.use(sessionUser(users));

  // In single-user mode every request is "the one user"; the stores ignore the id.
  const currentUserId = (req) => req.user?.id ?? 'local';
  const gate = accounts ? requireUser : (_req, _res, next) => next();

  const provider = createProvider(config);
  const scanner = createScanner({ provider, cacheTtlMs: config.cacheTtlMs });

  // null without a key, which is how every "is the advisor on?" question is answered.
  const advisor = createAdvisor({
    apiKey: config.anthropicApiKey,
    model: config.anthropicModel,
    fetchImpl: config.fetchImpl ?? fetch,
  });

  const wrap = (handler) => (req, res) => {
    handler(req, res).catch((error) => {
      // A status on the error means it is an answer, not a fault: an unknown ticker is a 404 and
      // does not belong in the log next to the things that are actually broken.
      if (error instanceof UserError || Number.isInteger(error.status)) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error(`${req.method} ${req.path} failed:`, error.message);
      res.status(500).json({ error: error.message });
    });
  };

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, provider: provider.name, strategies: STRATEGIES, accounts });
  });

  // --- who you are, signing in and out -----------------------------------------------------------

  app.get('/api/me', (req, res) => {
    // Always 200: "nobody is signed in" is an answer, not an error, and the front end needs it to
    // decide between the app and the sign-in screen.
    res.json({ accounts, user: accounts ? req.user ?? null : { id: 'local', email: null, role: 'admin' } });
  });

  if (accounts) {
    app.post(
      '/api/login',
      loginRateLimit(),
      wrap(async (req, res) => {
        const user = await users.authenticate(req.body?.email, req.body?.password);
        // One message for every kind of failure: saying which part was wrong tells an attacker
        // whose address has an account here.
        if (!user) return res.status(401).json({ error: 'Wrong email or password.' });

        const { token, expiresAt } = await users.startSession(user.id);
        res.set('Set-Cookie', sessionCookie(token, { expiresAt, secure: config.production }));
        res.json({ user });
      }),
    );

    app.post(
      '/api/logout',
      wrap(async (req, res) => {
        await users.endSession(readCookie(req, SESSION_COOKIE));
        res.set('Set-Cookie', clearedCookie({ secure: config.production }));
        res.json({ ok: true });
      }),
    );

    app.post(
      '/api/password',
      requireUser,
      wrap(async (req, res) => {
        // Proving the current password matters: it is what stops someone at an unlocked laptop
        // from taking the account over.
        const ok = await users.authenticate(req.user.email, req.body?.currentPassword);
        if (!ok) return res.status(403).json({ error: 'Current password is wrong.' });

        const problem = passwordProblem(req.body?.newPassword);
        if (problem) return res.status(400).json({ error: problem });

        await users.setPassword(req.user.id, req.body.newPassword);

        // setPassword ends every session, including this one — sign the browser back in rather
        // than bouncing someone to the login screen for doing the right thing.
        const { token, expiresAt } = await users.startSession(req.user.id);
        res.set('Set-Cookie', sessionCookie(token, { expiresAt, secure: config.production }));
        res.json({ ok: true });
      }),
    );

    // --- users, administrators only ----------------------------------------------------------

    app.get('/api/users', requireAdmin, wrap(async (_req, res) => res.json({ users: await users.list() })));

    app.post(
      '/api/users',
      requireAdmin,
      wrap(async (req, res) => {
        const user = await users.create({
          email: req.body?.email,
          password: req.body?.password,
          role: req.body?.role === 'admin' ? 'admin' : 'member',
        });
        res.status(201).json({ user });
      }),
    );

    app.patch(
      '/api/users/:id',
      requireAdmin,
      wrap(async (req, res) => {
        const { id } = req.params;

        if (req.body?.password !== undefined) {
          await users.setPassword(id, req.body.password);
        }

        // An admin demoting or disabling themselves is how an app ends up with nobody who can
        // administer it. The store also refuses to strand the last admin.
        if (id === req.user.id && (req.body?.role === 'member' || req.body?.disabled === true)) {
          return res.status(409).json({ error: 'You cannot demote or disable your own account.' });
        }

        const changed =
          req.body?.role !== undefined || req.body?.disabled !== undefined
            ? await users.update(id, { role: req.body.role, disabled: req.body.disabled })
            : await users.findById(id);

        res.json({ user: changed });
      }),
    );

    app.delete(
      '/api/users/:id',
      requireAdmin,
      wrap(async (req, res) => {
        if (req.params.id === req.user.id) {
          return res.status(409).json({ error: 'You cannot delete your own account.' });
        }
        await users.remove(req.params.id);
        res.json({ ok: true });
      }),
    );
  }

  app.get(
    '/api/settings',
    gate,
    wrap(async (req, res) => {
      const state = await store.read(currentUserId(req));
      res.json({
        ...state,
        defaults: { filters: DEFAULT_FILTERS, weights: DEFAULT_WEIGHTS },
        provider: provider.name,
        advisor: advisor ? { model: advisor.model, perHour: config.advisorPerHour } : null,
        user: req.user ?? null,
      });
    }),
  );

  app.put(
    '/api/watchlist',
    gate,
    wrap(async (req, res) => {
      // The ACTIVE list — this is what the Ticker page's "add to watchlist" and anything that
      // does not care which list is which writes to. Validation lives in domain/watchlist.js,
      // which the browser imports too, so the page refuses a bad ticker for the same reason, in
      // the same words, before the round trip.
      res.json(await store.setWatchlist(currentUserId(req), cleanWatchlist(req.body?.watchlist)));
    }),
  );

  // --- watchlists ------------------------------------------------------------------------------
  //
  // Every route answers with the whole settings state, the same shape /api/settings returns. The
  // page then replaces what it has rather than patching it, so a rename, a delete and a change of
  // active list cannot leave the screen holding a version of the truth the server does not share.
  //
  // Ownership is checked in the store, which answers "no such watchlist" for another account's id
  // rather than "not yours" — otherwise an id becomes a way to find out which ids exist.

  app.post(
    '/api/watchlists',
    gate,
    wrap(async (req, res) => {
      const entries = cleanWatchlist(req.body?.watchlist);
      res.json(await store.createWatchlist(currentUserId(req), req.body?.name, entries));
    }),
  );

  app.patch(
    '/api/watchlists/:id',
    gate,
    wrap(async (req, res) => {
      const userId = currentUserId(req);
      const { id } = req.params;

      // Rename and "make this the active one" are both small changes to the same thing, so they
      // share a route; either may be sent on its own.
      if (req.body?.name !== undefined) await store.renameWatchlist(userId, id, req.body.name);
      if (req.body?.active) await store.setActiveWatchlist(userId, id);

      res.json(await store.read(userId));
    }),
  );

  app.put(
    '/api/watchlists/:id',
    gate,
    wrap(async (req, res) => {
      const entries = cleanWatchlist(req.body?.watchlist);
      res.json(await store.setWatchlistEntries(currentUserId(req), req.params.id, entries));
    }),
  );

  app.delete(
    '/api/watchlists/:id',
    gate,
    wrap(async (req, res) => {
      res.json(await store.deleteWatchlist(currentUserId(req), req.params.id));
    }),
  );

  app.put(
    '/api/filters',
    gate,
    wrap(async (req, res) => {
      const filters = { ...DEFAULT_FILTERS, ...(req.body?.filters ?? {}) };
      const weights = { ...DEFAULT_WEIGHTS, ...(req.body?.weights ?? {}) };
      res.json(await store.update(currentUserId(req), { filters, weights }));
    }),
  );

  app.post(
    '/api/scan',
    gate,
    wrap(async (req, res) => {
      const state = await store.read(currentUserId(req));

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

  // --- the position tracker ---------------------------------------------------------------------
  //
  // What you have actually opened. The stored row is what you typed; the live part — today's
  // price, the short leg's delta, whether the strike is breached — is fetched here and never
  // saved, because a saved price is a price that is wrong by tomorrow.

  app.get(
    '/api/positions',
    gate,
    wrap(async (req, res) => {
      const userId = currentUserId(req);
      const [positions, state] = await Promise.all([store.listPositions(userId), store.read(userId)]);
      const asOf = today();

      res.json({
        asOf,
        positions: await enrich(positions, asOf),
        totals: premiumTotals(positions, { today: asOf, goals: state.goals }),
        goals: state.goals,
        // Earnings dates are already kept on the watchlist, so the tracker reads them from there
        // rather than asking for the same date twice.
        earnings: Object.fromEntries(
          (state.watchlists ?? []).flatMap((l) => l.entries).filter((e) => e.earnings).map((e) => [e.symbol, e.earnings]),
        ),
      });
    }),
  );

  app.post(
    '/api/positions',
    gate,
    wrap(async (req, res) => {
      res.json(await store.addPosition(currentUserId(req), req.body));
    }),
  );

  app.patch(
    '/api/positions/:id',
    gate,
    wrap(async (req, res) => {
      res.json(await store.updatePosition(currentUserId(req), req.params.id, req.body ?? {}));
    }),
  );

  app.delete(
    '/api/positions/:id',
    gate,
    wrap(async (req, res) => {
      await store.deletePosition(currentUserId(req), req.params.id);
      res.json({ ok: true });
    }),
  );

  app.put(
    '/api/theme',
    gate,
    wrap(async (req, res) => {
      const theme = cleanTheme(req.body?.theme);
      await store.update(currentUserId(req), { theme });
      res.json({ theme });
    }),
  );

  app.put(
    '/api/goals',
    gate,
    wrap(async (req, res) => {
      const goals = cleanGoals(req.body?.goals);
      await store.update(currentUserId(req), { goals });
      res.json({ goals });
    }),
  );

  /**
   * Attaches today's price and the short leg's live delta to each open position.
   *
   * Everything here fails soft, per position: a delisted symbol or an expiry the provider has
   * dropped should leave one row showing dashes, not empty the whole table. Quotes and chains
   * come from the scan's cache, so an open tracker costs nothing on top of a scan.
   */
  async function enrich(positions, asOf) {
    const open = positions.filter((p) => p.status === 'open');
    const symbols = [...new Set(open.map((p) => p.symbol))];

    const quotes = new Map();
    for (const symbol of symbols) {
      try {
        quotes.set(symbol, await scanner.quote(symbol));
      } catch {
        quotes.set(symbol, null);
      }
    }

    // One chain per distinct symbol-and-expiry, not per row: several spreads on the same expiry
    // are common, and asking again for each is how a tracker burns a rate limit on page load.
    const chains = new Map();
    const wanted = [...new Set(open.map((p) => `${p.symbol}|${p.expiration}`))].slice(0, 25);

    for (const key of wanted) {
      const [symbol, expiration] = key.split('|');
      try {
        chains.set(key, (await scanner.chain(symbol, expiration)).chain);
      } catch {
        chains.set(key, null);
      }
    }

    return positions.map((position) => {
      const quote = quotes.get(position.symbol) ?? null;
      const spot = quote?.last ?? null;
      const chain = chains.get(`${position.symbol}|${position.expiration}`) ?? null;

      const side = POSITION_TYPES[position.type]?.side;
      const leg =
        chain && position.shortStrike > 0 && side && side !== 'both'
          ? (chain.options ?? []).find((o) => o.type === side && Math.abs(o.strike - position.shortStrike) < 0.001)
          : null;

      return {
        ...position,
        spot,
        change: quote?.change ?? null,
        changePct: quote?.changePct ?? null,
        delta: leg?.delta ?? null,
        daysLeft: daysLeft(position.expiration, asOf),
        breach: spot == null ? null : breachOf(position, spot),
      };
    });
  }

  // --- the advisor ------------------------------------------------------------------------------
  //
  // Optional, off without ANTHROPIC_API_KEY, and the only part of the app that costs money per
  // use. It reads a scan THIS SERVER has just run — not numbers posted by the browser — so every
  // figure it is shown is one the screener computed. See domain/advice.js for what it is told.

  const askedRecently = new Map();

  /** A per-account hourly ceiling. On the bill as much as on the traffic. */
  function withinRate(userId) {
    const now = Date.now();
    const hourAgo = now - 3_600_000;

    const times = (askedRecently.get(userId) ?? []).filter((t) => t > hourAgo);
    if (times.length >= config.advisorPerHour) return false;

    times.push(now);
    askedRecently.set(userId, times);
    return true;
  }

  app.post(
    '/api/explain',
    gate,
    wrap(async (req, res) => {
      if (!advisor) {
        return res.status(503).json({
          error: 'The advisor is not configured — set ANTHROPIC_API_KEY to turn it on.',
        });
      }

      const userId = currentUserId(req);
      if (!withinRate(userId)) {
        return res.status(429).json({
          error: `That is ${config.advisorPerHour} questions this hour, which is the limit. Each one costs money, so the ceiling is deliberate.`,
        });
      }

      // The scan is re-run rather than taken from the request. Chains are cached, so this spends
      // no provider requests; what it buys is that the model reads this server's arithmetic.
      const state = await store.read(userId);
      const result = annotateEarnings(
        await scanner.scan({
          symbols: state.watchlist.map((w) => w.symbol),
          filters: state.filters,
          weights: state.weights,
          limit: 50,
        }),
        state.watchlist,
      );

      const answer = await advisor.ask({ question: req.body?.question, result });

      res.json({
        ...answer,
        asOf: result.asOf,
        candidatesConsidered: Math.min(result.candidates.length, DIGEST_LIMIT),
      });
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
    gate,
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
    gate,
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

      // Both sides: the simulator builds put credit spreads AND long calls, and switching
      // strategy should not cost another request against the rate limit. A `side` parameter
      // trims it for a caller that only wants one.
      const side = req.query.side === 'put' || req.query.side === 'call' ? req.query.side : null;
      const options = chain.options
        .filter((o) => !side || o.type === side)
        .sort((a, b) => a.strike - b.strike || a.type.localeCompare(b.type));

      res.json({
        symbol,
        spot,
        description: quote.description,
        expiration,
        asOf,
        dte: daysBetween(asOf, expiration),
        // Taken from both sides, as the screener does, so the probabilities agree between pages.
        atmIv: atmImpliedVol(chain.options, spot),
        options,
      });
    }),
  );

  // --- ticker lookup ------------------------------------------------------------------------------

app.get(
  '/api/quote',
  gate,
  wrap(async (req, res) => {
    const symbol = symbolParam(req, res);
    if (!symbol) return;

    res.json({ symbol, asOf: today(), quote: await scanner.quote(symbol) });
  }),
);

app.get(
  '/api/history',
  gate,
  wrap(async (req, res) => {
    const symbol = symbolParam(req, res);
    if (!symbol) return;

    // Only the ranges the UI offers: the range name decides a date window and an interval, and
    // letting a caller pass arbitrary start dates is how one request asks for twenty years of
    // daily bars and spends the whole rate limit.
    const range = isRange(req.query.range) ? req.query.range : DEFAULT_RANGE;
    const asOf = today();
    const start = startDateFor(range, asOf);
    const interval = intervalFor(range);

    const bars = await scanner.history(symbol, { start, end: asOf, interval });

    res.json({ symbol, range, interval, start, end: asOf, bars });
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

  return { app, accounts, db, users, store, provider, scanner, hasBuiltUi };
}

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

/**
 * Prepares the database and makes sure somebody can administer the app.
 *
 * The first admin has to come from the environment: you cannot add a user without signing in,
 * and you cannot sign in without a user. An existing account is left alone unless ADMIN_RESET is
 * set, so a redeploy never silently resets a password that has since been changed.
 */
export async function prepare({ config, db, users, accounts }) {
  if (!accounts) return;

  await migrate(db);
  const removed = await users.purgeExpiredSessions();
  if (removed) console.log(`Cleared ${removed} expired session(s).`);

  if (!config.adminEmail || !config.adminPassword) {
    if ((await users.count()) === 0) {
      console.warn(
        'WARNING: the database has no accounts and ADMIN_EMAIL / ADMIN_PASSWORD are not set, ' +
          'so nobody can sign in. Set both and restart.',
      );
    }
    return;
  }

  const { rows } = await db.query(`SELECT id FROM users WHERE lower(email) = lower($1)`, [config.adminEmail]);

  if (!rows[0]) {
    await users.create({ email: config.adminEmail, password: config.adminPassword, role: 'admin' });
    console.log(`Created the administrator account ${config.adminEmail}.`);
  } else if (config.adminReset) {
    await users.setPassword(rows[0].id, config.adminPassword);
    await users.update(rows[0].id, { role: 'admin', disabled: false });
    console.log(`Reset the password for ${config.adminEmail} (ADMIN_RESET=true).`);
  }
}
