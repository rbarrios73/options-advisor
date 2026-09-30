// Where a user's watchlists and saved filters live.
//
// Two stores with one interface. The file store is the single-user mode: everything in one JSON
// file. The database store is the accounts mode: filters and weights in a `settings` row, the
// lists and their symbols in their own tables — see the note in db.js for why they are not in the
// blob.
//
// An account may keep several named lists. Exactly one of them is ACTIVE: it is the one the
// screener scans, the one the sidebar shows, and the one "add to watchlist" adds to. That is one
// idea rather than two — choosing a list to edit is choosing the list you scan.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { DEFAULT_FILTERS } from './domain/strategies.js';
import { DEFAULT_WEIGHTS } from './domain/score.js';
import {
  DEFAULT_LIST_NAME,
  DEFAULT_WATCHLIST,
  MAX_LISTS,
  cleanName,
  cleanWatchlist,
  uniqueName,
} from './domain/watchlist.js';

/** Raised by either store when a request is refused for a reason worth telling the user. */
export class StoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const newList = (name, entries = [], sortOrder = 0) => ({
  id: randomUUID(),
  name,
  sortOrder,
  entries: cleanWatchlist(entries),
});

const publicList = (list) => ({ id: list.id, name: list.name, entries: list.entries });

/** Fills in anything a stored blob is missing, so an old row or file never breaks a scan. */
export function withDefaults(stored) {
  return {
    filters: { ...DEFAULT_FILTERS, ...(stored?.filters ?? {}) },
    weights: { ...DEFAULT_WEIGHTS, ...(stored?.weights ?? {}) },
  };
}

/**
 * The shape both stores answer with.
 *
 * `watchlist` is the active list's entries, under the name it has always had — the scan, the
 * sidebar and the Ticker page all read it, and none of them need to know that lists are now
 * plural.
 */
function stateFrom({ settings, lists, activeId }) {
  const active = lists.find((l) => l.id === activeId) ?? lists[0] ?? null;

  return {
    ...withDefaults(settings),
    watchlists: lists.map(publicList),
    activeWatchlistId: active?.id ?? null,
    watchlist: active?.entries ?? [],
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

  async function load() {
    if (cache) return cache;
    try {
      cache = upgradeFile(JSON.parse(await readFile(file, 'utf8')));
    } catch {
      cache = { lists: [newList(DEFAULT_LIST_NAME, DEFAULT_WATCHLIST)], activeId: null, settings: {} };
    }
    return cache;
  }

  async function save(next) {
    cache = next;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(next, null, 2), 'utf8');
    return state(next);
  }

  const state = (raw) => stateFrom({ settings: raw.settings, lists: raw.lists, activeId: raw.activeId });

  /** The list an operation names, or a 404 — the same answer the database store gives. */
  function find(raw, id) {
    const list = raw.lists.find((l) => l.id === id);
    if (!list) throw new StoreError('No such watchlist.', 404);
    return list;
  }

  return {
    async read() {
      return state(await load());
    },

    async update(_userId, patch) {
      const raw = await load();
      const { watchlist: _ignored, watchlists: _also, activeWatchlistId: _and, ...settings } = patch;
      return save({ ...raw, settings: { ...raw.settings, ...settings } });
    },

    async setWatchlist(_userId, entries) {
      const raw = await load();
      const active = raw.lists.find((l) => l.id === raw.activeId) ?? raw.lists[0];
      if (!active) throw new StoreError('No such watchlist.', 404);
      return this.setWatchlistEntries(_userId, active.id, entries);
    },

    async setWatchlistEntries(_userId, id, entries) {
      const raw = await load();
      const list = find(raw, id);
      return save({
        ...raw,
        lists: raw.lists.map((l) => (l.id === list.id ? { ...l, entries: cleanWatchlist(entries) } : l)),
      });
    },

    async createWatchlist(_userId, name, entries = []) {
      const raw = await load();
      if (raw.lists.length >= MAX_LISTS) {
        throw new StoreError(`That is the limit of ${MAX_LISTS} watchlists.`, 409);
      }

      const wanted = cleanName(name) ?? DEFAULT_LIST_NAME;
      const list = newList(
        uniqueName(wanted, raw.lists.map((l) => l.name)),
        entries,
        raw.lists.length,
      );

      // A new list becomes the active one: you made it to put something in it.
      return save({ ...raw, lists: [...raw.lists, list], activeId: list.id });
    },

    async renameWatchlist(_userId, id, name) {
      const raw = await load();
      const list = find(raw, id);

      const wanted = cleanName(name);
      if (!wanted) throw new StoreError('A watchlist needs a name.', 400);
      if (raw.lists.some((l) => l.id !== id && l.name.toLowerCase() === wanted.toLowerCase())) {
        throw new StoreError(`You already have a watchlist called “${wanted}”.`, 409);
      }

      return save({ ...raw, lists: raw.lists.map((l) => (l.id === list.id ? { ...l, name: wanted } : l)) });
    },

    async deleteWatchlist(_userId, id) {
      const raw = await load();
      find(raw, id);
      if (raw.lists.length === 1) {
        throw new StoreError('This is your only watchlist — empty it instead of deleting it.', 409);
      }

      const lists = raw.lists.filter((l) => l.id !== id);
      return save({ ...raw, lists, activeId: raw.activeId === id ? lists[0].id : raw.activeId });
    },

    async setActiveWatchlist(_userId, id) {
      const raw = await load();
      find(raw, id);
      return save({ ...raw, activeId: id });
    },
  };
}

/**
 * A file written before lists were plural held one `watchlist` array. It becomes the account's
 * first list, under the name a new account's first list gets, so nothing appears to have moved.
 */
function upgradeFile(stored) {
  if (Array.isArray(stored?.lists)) {
    return {
      lists: stored.lists.map((l, i) => ({
        id: l.id ?? randomUUID(),
        name: cleanName(l.name) ?? DEFAULT_LIST_NAME,
        sortOrder: i,
        entries: cleanWatchlist(l.entries),
      })),
      activeId: stored.activeId ?? null,
      settings: stored.settings ?? {},
    };
  }

  const { watchlist, filters, weights, ...rest } = stored ?? {};
  return {
    lists: [newList(DEFAULT_LIST_NAME, watchlist ?? DEFAULT_WATCHLIST)],
    activeId: null,
    settings: { ...rest, filters, weights },
  };
}

/**
 * Settings in Postgres — the accounts mode. Filters and weights are one JSONB row per user; the
 * lists and their symbols are rows, read in the order they were arranged in.
 *
 * A user with no settings row reads the default filters rather than an empty screen, and the row
 * is written the first time they change anything. A list with no symbols is EMPTY, and that is
 * not the same as "not set up yet": the default symbols are put there once, when the account is
 * created (see seedWatchlist), so clearing a list is a choice the app respects.
 */
export function createDbStore(db) {
  /** Every list the account has, with its symbols, in one round trip. */
  async function readLists(userId) {
    const { rows } = await db.query(
      `SELECT l.id, l.name,
              coalesce(
                (SELECT json_agg(e ORDER BY e.sort_order, e.symbol)
                 FROM (
                   SELECT w.symbol, w.note, to_char(w.earnings, 'YYYY-MM-DD') AS earnings, w.sort_order
                   FROM watchlist w WHERE w.watchlist_id = l.id
                 ) e),
                '[]'::json
              ) AS entries
       FROM watchlists l
       WHERE l.user_id = $1
       ORDER BY l.sort_order, l.created_at`,
      [userId],
    );

    // sort_order comes back for the ordering and is not part of what an entry is.
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      entries: row.entries.map(({ sort_order: _o, ...entry }) => entry),
    }));
  }

  async function readSettings(userId) {
    const { rows } = await db.query(`SELECT data FROM settings WHERE user_id = $1`, [userId]);

    // Rows written before the watchlist had tables may still carry the key; db.js clears it on
    // the first boot after the change, and this makes the read safe in either order.
    const { watchlist: _buried, ...data } = rows[0]?.data ?? {};
    return data;
  }

  async function writeSettings(userId, next) {
    const { watchlist: _a, watchlists: _b, ...data } = next;

    await db.query(
      `INSERT INTO settings (user_id, data) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET data = $2, updated_at = now()`,
      [userId, JSON.stringify(data)],
    );
    return data;
  }

  async function state(userId) {
    const [settings, lists] = await Promise.all([readSettings(userId), readLists(userId)]);
    return stateFrom({ settings, lists, activeId: settings.activeWatchlistId });
  }

  /**
   * Checks the list exists AND belongs to this account, in one query.
   *
   * Both in one: answering "no such watchlist" for someone else's id rather than "not yours" is
   * what stops an id being a way to find out which ids exist.
   */
  async function assertOwned(userId, id) {
    const { rows } = await db.query(`SELECT 1 FROM watchlists WHERE id = $1 AND user_id = $2`, [id, userId]);
    if (rows.length === 0) throw new StoreError('No such watchlist.', 404);
  }

  async function nextSortOrder(userId) {
    const { rows } = await db.query(
      `SELECT coalesce(max(sort_order) + 1, 0) AS next FROM watchlists WHERE user_id = $1`,
      [userId],
    );
    return Number(rows[0].next);
  }

  /** The active list's id, falling back to the first — the same rule the read uses. */
  async function activeId(userId) {
    const settings = await readSettings(userId);
    const lists = await readLists(userId);
    const active = lists.find((l) => l.id === settings.activeWatchlistId) ?? lists[0];
    if (!active) throw new StoreError('No such watchlist.', 404);
    return active.id;
  }

  return {
    read: state,

    async update(userId, patch) {
      const { watchlist: _a, watchlists: _b, activeWatchlistId: _c, ...settings } = patch;
      await writeSettings(userId, { ...(await readSettings(userId)), ...settings });
      return state(userId);
    },

    /** The active list's symbols — what the Ticker page's "add to watchlist" writes to. */
    async setWatchlist(userId, entries) {
      return this.setWatchlistEntries(userId, await activeId(userId), entries);
    },

    /**
     * Replaces one list's symbols in a single statement, so a save is all-or-nothing.
     *
     * One statement rather than a transaction on purpose: `db` here may be a pool, and a pool
     * hands each query whatever connection is free — a BEGIN and its COMMIT can land on different
     * connections, which is a transaction that silently is not one.
     */
    async setWatchlistEntries(userId, id, entries) {
      await assertOwned(userId, id);
      const clean = cleanWatchlist(entries);

      await db.query(
        `WITH incoming AS (
           SELECT * FROM jsonb_to_recordset($2::jsonb)
             AS x(symbol text, note text, earnings text, sort_order int)
         ),
         upserted AS (
           INSERT INTO watchlist (watchlist_id, symbol, note, earnings, sort_order)
           SELECT $1, symbol, note, earnings::date, sort_order FROM incoming
           ON CONFLICT (watchlist_id, symbol) DO UPDATE
             SET note = EXCLUDED.note, earnings = EXCLUDED.earnings, sort_order = EXCLUDED.sort_order
           RETURNING 1
         )
         DELETE FROM watchlist w
         WHERE w.watchlist_id = $1
           AND NOT EXISTS (SELECT 1 FROM incoming i WHERE i.symbol = w.symbol)`,
        [id, JSON.stringify(clean.map((entry, sort_order) => ({ ...entry, sort_order })))],
      );

      return state(userId);
    },

    async createWatchlist(userId, name, entries = []) {
      const lists = await readLists(userId);
      if (lists.length >= MAX_LISTS) {
        throw new StoreError(`That is the limit of ${MAX_LISTS} watchlists.`, 409);
      }

      const wanted = uniqueName(cleanName(name) ?? DEFAULT_LIST_NAME, lists.map((l) => l.name));
      const id = randomUUID();

      await db.query(`INSERT INTO watchlists (id, user_id, name, sort_order) VALUES ($1, $2, $3, $4)`, [
        id,
        userId,
        wanted,
        await nextSortOrder(userId),
      ]);

      if (entries.length > 0) await this.setWatchlistEntries(userId, id, entries);

      // A new list becomes the active one: you made it to put something in it.
      return this.setActiveWatchlist(userId, id);
    },

    async renameWatchlist(userId, id, name) {
      await assertOwned(userId, id);

      const wanted = cleanName(name);
      if (!wanted) throw new StoreError('A watchlist needs a name.', 400);

      try {
        await db.query(`UPDATE watchlists SET name = $3 WHERE id = $1 AND user_id = $2`, [id, userId, wanted]);
      } catch (error) {
        // 23505 is unique_violation: the index on (user_id, lower(name)) caught a clash.
        if (error.code === '23505') {
          throw new StoreError(`You already have a watchlist called “${wanted}”.`, 409);
        }
        throw error;
      }

      return state(userId);
    },

    async deleteWatchlist(userId, id) {
      await assertOwned(userId, id);

      const lists = await readLists(userId);
      if (lists.length === 1) {
        throw new StoreError('This is your only watchlist — empty it instead of deleting it.', 409);
      }

      // The symbols go with it, by foreign key.
      await db.query(`DELETE FROM watchlists WHERE id = $1 AND user_id = $2`, [id, userId]);

      const settings = await readSettings(userId);
      if (settings.activeWatchlistId === id) {
        const remaining = lists.find((l) => l.id !== id);
        await writeSettings(userId, { ...settings, activeWatchlistId: remaining.id });
      }

      return state(userId);
    },

    async setActiveWatchlist(userId, id) {
      await assertOwned(userId, id);
      await writeSettings(userId, { ...(await readSettings(userId)), activeWatchlistId: id });
      return state(userId);
    },
  };
}

/**
 * Puts a first list, holding the default symbols, in front of a brand-new account — once.
 *
 * Called when a user is created, not on every read, so an account that clears or deletes lists
 * keeps them that way. `watchlist_seeded` is what says it has been done; db.js sets it for
 * accounts that existed before any of this had tables.
 */
export async function seedWatchlist(db, userId) {
  const id = randomUUID();

  await db.query(`INSERT INTO watchlists (id, user_id, name, sort_order) VALUES ($1, $2, $3, 0)`, [
    id,
    userId,
    DEFAULT_LIST_NAME,
  ]);

  await db.query(
    `INSERT INTO watchlist (watchlist_id, symbol, note, sort_order)
     SELECT $1, d.symbol, d.note, d.ord
     FROM jsonb_to_recordset($2::jsonb) AS d(symbol text, note text, ord int)
     ON CONFLICT (watchlist_id, symbol) DO NOTHING`,
    [id, JSON.stringify(DEFAULT_WATCHLIST.map((entry, ord) => ({ ...entry, ord })))],
  );

  await db.query(`UPDATE users SET watchlist_seeded = TRUE WHERE id = $1`, [userId]);
}
