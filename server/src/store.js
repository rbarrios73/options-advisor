// Watchlist and saved filters, persisted as one JSON file.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { DEFAULT_FILTERS } from './domain/strategies.js';
import { DEFAULT_WEIGHTS } from './domain/score.js';

// Ten names chosen for two things at once: exposure to different drivers, and option chains deep
// enough that a four-legged position is fillable. Diversification is the point, but an illiquid
// chain quietly costs more than a correlated one — on a condor you pay the bid/ask four times.
//
// Eight are ETFs, which have no earnings date to gap over; the earnings field is entered by hand,
// so every single name is a thing you have to remember. The two that are here earn their place by
// paying enough premium to clear the 15% return-on-risk floor, which the quiet ETFs often cannot.
//
// This is the DEFAULT list, not just the current one: Render's free tier has no persistent disk,
// so the saved file is wiped on every cold start and the app falls back to exactly this.
const DEFAULT_STATE = {
  watchlist: [
    { symbol: 'SPY', note: 'US large cap — the deepest options market there is' },
    { symbol: 'IWM', note: 'US small cap — higher IV than SPY, different economic sensitivity' },
    { symbol: 'XLF', note: 'Financials — rates and credit' },
    { symbol: 'XLE', note: 'Energy — crude, largely its own cycle' },
    { symbol: 'XLV', note: 'Healthcare — defensive, low beta to the index' },
    { symbol: 'GLD', note: 'Gold — the one that usually rises when equities fall' },
    { symbol: 'TLT', note: 'Long Treasuries — duration and rate expectations' },
    { symbol: 'EEM', note: 'Emerging markets — non-US, dollar-sensitive' },
    { symbol: 'XLY', note: 'Consumer discretionary — the household-spending side of the economy' },
    // The one single name. High IV means it is usually the only thing here paying enough for a
    // short spread to clear the 15% return-on-risk floor — and the only one that can gap on an
    // earnings date, which you have to enter by hand.
    { symbol: 'NVDA', note: 'Semis — high IV, deepest single-name chain. Set its earnings date' },
  ],
  filters: DEFAULT_FILTERS,
  weights: DEFAULT_WEIGHTS,
};

/** Fills in anything a stored blob is missing, so an old row or file never breaks a scan. */
export function withDefaults(stored) {
  return {
    ...DEFAULT_STATE,
    ...(stored ?? {}),
    filters: { ...DEFAULT_FILTERS, ...(stored?.filters ?? {}) },
    weights: { ...DEFAULT_WEIGHTS, ...(stored?.weights ?? {}) },
  };
}

/**
 * Settings in a JSON file — the single-user mode, used when there is no DATABASE_URL.
 *
 * Every method takes a userId for interface compatibility with the database store and ignores
 * it: there is exactly one user here, and that is the whole point of this mode.
 */
export function createFileStore(file) {
  let cache = null;

  async function read() {
    if (cache) return cache;
    try {
      cache = withDefaults(JSON.parse(await readFile(file, 'utf8')));
    } catch {
      cache = structuredClone(DEFAULT_STATE);
    }
    return cache;
  }

  async function write(next) {
    cache = next;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  return {
    read,
    async update(_userId, patch) {
      const current = await read();
      return write({ ...current, ...patch });
    },
    async setWatchlist(_userId, watchlist) {
      const current = await read();
      return write({ ...current, watchlist });
    },
  };
}

/**
 * Settings in Postgres, one row per user — the accounts mode.
 *
 * A user with no row yet reads the defaults rather than an empty screen, and the row is written
 * the first time they change anything. New accounts therefore start with the default watchlist.
 */
export function createDbStore(db) {
  async function read(userId) {
    const { rows } = await db.query(`SELECT data FROM settings WHERE user_id = $1`, [userId]);
    return withDefaults(rows[0]?.data);
  }

  async function write(userId, next) {
    await db.query(
      `INSERT INTO settings (user_id, data) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET data = $2, updated_at = now()`,
      [userId, JSON.stringify(next)],
    );
    return next;
  }

  return {
    read,
    async update(userId, patch) {
      return write(userId, { ...(await read(userId)), ...patch });
    },
    async setWatchlist(userId, watchlist) {
      return write(userId, { ...(await read(userId)), watchlist });
    },
  };
}
