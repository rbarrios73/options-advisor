// Where a user's watchlist and saved filters live.
//
// Two stores with one interface. The file store is the single-user mode: everything in one JSON
// file. The database store is the accounts mode: filters and weights in a `settings` row, and the
// watchlist in its own table — see the note on that table in db.js for why it is not in the blob.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { DEFAULT_FILTERS } from './domain/strategies.js';
import { DEFAULT_WEIGHTS } from './domain/score.js';
import { DEFAULT_WATCHLIST, cleanWatchlist } from './domain/watchlist.js';

// The starting point for a fresh install. On Render's free tier there is no persistent disk, so
// in single-user mode the saved file is wiped on every cold start and the app falls back to this.
const DEFAULT_STATE = {
  watchlist: DEFAULT_WATCHLIST,
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
      return write({ ...current, watchlist: cleanWatchlist(watchlist) });
    },
  };
}

/**
 * Settings in Postgres — the accounts mode. Filters and weights are one JSONB row per user; the
 * watchlist is its own table, read in the order it was arranged in.
 *
 * A user with no settings row reads the default filters rather than an empty screen, and the row
 * is written the first time they change anything. A user with no watchlist rows has an EMPTY
 * watchlist, and that is not the same thing: the default list is put there once, when the account
 * is created (see seedWatchlist), so clearing it is a choice the app respects.
 */
export function createDbStore(db) {
  async function readWatchlist(userId) {
    const { rows } = await db.query(
      `SELECT symbol, note, to_char(earnings, 'YYYY-MM-DD') AS earnings
       FROM watchlist WHERE user_id = $1
       ORDER BY sort_order, symbol`,
      [userId],
    );
    return rows;
  }

  async function readSettings(userId) {
    const { rows } = await db.query(`SELECT data FROM settings WHERE user_id = $1`, [userId]);

    // A row written before the watchlist had a table may still carry the key; db.js clears it on
    // the first boot after the change, and this makes the read safe in either order.
    const { watchlist: _buried, ...data } = rows[0]?.data ?? {};
    return withDefaults(data);
  }

  async function writeSettings(userId, next) {
    // The watchlist is not part of this row any more. Stripped on the way in as well as on the
    // way out, so a client that still sends the old shape cannot resurrect the buried copy.
    const { watchlist: _ignored, ...data } = next;

    await db.query(
      `INSERT INTO settings (user_id, data) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET data = $2, updated_at = now()`,
      [userId, JSON.stringify(data)],
    );
    return data;
  }

  return {
    async read(userId) {
      const [settings, watchlist] = await Promise.all([readSettings(userId), readWatchlist(userId)]);
      return { ...settings, watchlist };
    },

    async update(userId, patch) {
      const settings = await writeSettings(userId, { ...(await readSettings(userId)), ...patch });
      return { ...settings, watchlist: await readWatchlist(userId) };
    },

    /**
     * Replaces the list in one statement, so a save is all-or-nothing.
     *
     * One statement rather than a transaction on purpose: `db` here may be a pool, and a pool
     * hands each query whatever connection is free — a BEGIN and its COMMIT can land on different
     * connections, which is a transaction that silently is not one.
     */
    async setWatchlist(userId, watchlist) {
      const clean = cleanWatchlist(watchlist);

      await db.query(
        `WITH incoming AS (
           SELECT * FROM jsonb_to_recordset($2::jsonb)
             AS x(symbol text, note text, earnings text, sort_order int)
         ),
         upserted AS (
           INSERT INTO watchlist (user_id, symbol, note, earnings, sort_order)
           SELECT $1, symbol, note, earnings::date, sort_order FROM incoming
           ON CONFLICT (user_id, symbol) DO UPDATE
             SET note = EXCLUDED.note, earnings = EXCLUDED.earnings, sort_order = EXCLUDED.sort_order
           RETURNING 1
         )
         DELETE FROM watchlist w
         WHERE w.user_id = $1
           AND NOT EXISTS (SELECT 1 FROM incoming i WHERE i.symbol = w.symbol)`,
        [userId, JSON.stringify(clean.map((entry, sort_order) => ({ ...entry, sort_order })))],
      );

      return { ...(await readSettings(userId)), watchlist: await readWatchlist(userId) };
    },
  };
}

/**
 * Puts the default list in front of a brand-new account, once.
 *
 * Called when a user is created, not on every read — so an account that clears its watchlist
 * keeps it cleared. `watchlist_seeded` is what says it has been done; db.js sets it for accounts
 * that existed before the watchlist had a table of its own.
 */
export async function seedWatchlist(db, userId) {
  await db.query(
    `INSERT INTO watchlist (user_id, symbol, note, sort_order)
     SELECT $1, d.symbol, d.note, d.ord
     FROM jsonb_to_recordset($2::jsonb) AS d(symbol text, note text, ord int)
     ON CONFLICT (user_id, symbol) DO NOTHING`,
    [userId, JSON.stringify(DEFAULT_WATCHLIST.map((entry, ord) => ({ ...entry, ord })))],
  );
  await db.query(`UPDATE users SET watchlist_seeded = TRUE WHERE id = $1`, [userId]);
}
