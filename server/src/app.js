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

  const wrap = (handler) => (req, res) => {
    handler(req, res).catch((error) => {
      if (error instanceof UserError) return res.status(error.status).json({ error: error.message });
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
        user: req.user ?? null,
      });
    }),
  );

  app.put(
    '/api/watchlist',
    gate,
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

      res.json(await store.setWatchlist(currentUserId(req), dedupe(watchlist)));
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

function dedupe(watchlist) {
  const seen = new Set();
  return watchlist.filter((w) => (seen.has(w.symbol) ? false : seen.add(w.symbol)));
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
