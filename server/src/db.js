// Postgres connection and schema.
//
// The app runs in one of two modes, decided by whether DATABASE_URL is set:
//
//   • no DATABASE_URL — single user. Settings live in a JSON file and the whole app sits behind
//     one shared password (APP_PASSWORD). This is what a local copy wants, and it is what the
//     app did before accounts existed.
//   • DATABASE_URL — accounts. Users, sessions and per-user settings live in Postgres.
//
// Accounts need a database because a file does not survive: on Render's free tier the filesystem
// is wiped on every deploy and every cold start, so file-backed logins would vanish within hours.

import pg from 'pg';

import { DEFAULT_LIST_NAME, DEFAULT_WATCHLIST } from './domain/watchlist.js';

/**
 * A pool, or null when the app is running without a database.
 *
 * Managed Postgres (Neon, Supabase, Render) requires TLS; a local Postgres usually has none, so
 * SSL is on unless the host is local or PGSSL=disable says otherwise.
 */
export function createDb({ databaseUrl, pgSsl }) {
  if (!databaseUrl) return null;

  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(databaseUrl);
  const ssl = pgSsl === 'disable' || (pgSsl !== 'require' && local) ? false : { rejectUnauthorized: true };

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl,
    // Free Postgres plans cap connections hard, and this app is one small Node process.
    max: Number(process.env.PG_POOL_MAX ?? 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on('error', (error) => console.error('postgres pool error:', error.message));
  return pool;
}

/**
 * Creates the schema if it is not there. Safe to run on every boot, which is how it runs — there
 * is no migration tool here because there is one version of one small schema.
 *
 * Takes anything with `query(sql, params)`, so the tests can hand it an in-process Postgres.
 */
export async function migrate(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'member',
      disabled      BOOLEAN NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at TIMESTAMPTZ
    )
  `);

  // Emails are stored lowercase, and the index enforces it so two rows cannot differ by case.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email))`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions (user_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions (expires_at)`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (
      user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data       JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Watchlists are rows, not a field inside `settings.data`, and an account may have several of
  // them — "ETFs", "earnings plays", whatever you keep apart. A list is a row here and its symbols
  // are rows in `watchlist` below, so the whole thing can be read in order and looked at in a SQL
  // console when something is wrong.
  await db.query(`
    CREATE TABLE IF NOT EXISTS watchlists (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Two lists of one account cannot share a name, case aside: picking between "ETFs" and "etfs"
  // in a switcher is a coin toss, and renaming one to the other should say so rather than succeed.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS watchlists_user_name ON watchlists (user_id, lower(name))`);
  await db.query(`CREATE INDEX IF NOT EXISTS watchlists_user_order ON watchlists (user_id, sort_order)`);

  // The symbols on a list. A new database gets this shape; a database that predates several lists
  // is brought to it by upgradeToSeveralLists below.
  await db.query(`
    CREATE TABLE IF NOT EXISTS watchlist (
      watchlist_id TEXT NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
      symbol       TEXT NOT NULL,
      note         TEXT NOT NULL DEFAULT '',
      -- A real DATE, so the database rejects the 31st of February. It is always read back with
      -- to_char: a DATE arrives in Node as a Date at local midnight, which is the previous day
      -- west of UTC, and an earnings date that moves by a day is worse than none.
      earnings     DATE,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      added_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Marks a user whose lists have been set up, so an empty watchlist stays empty. Without it,
  // "this user has no rows" cannot tell a new account from someone who cleared their list on
  // purpose, and the defaults would come back on the next restart.
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS watchlist_seeded BOOLEAN NOT NULL DEFAULT FALSE`);

  await upgradeToSeveralLists(db);

  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS watchlist_key ON watchlist (watchlist_id, symbol)`);
  await db.query(`CREATE INDEX IF NOT EXISTS watchlist_order ON watchlist (watchlist_id, sort_order)`);

  // Repairs an account that somehow has no list at all — including one whose list rows were
  // removed by hand. Every signed-in account needs somewhere to put a symbol.
  await db.query(
    `INSERT INTO watchlists (id, user_id, name, sort_order)
     SELECT gen_random_uuid()::text, u.id, $1, 0
     FROM users u
     WHERE u.watchlist_seeded = TRUE
       AND NOT EXISTS (SELECT 1 FROM watchlists l WHERE l.user_id = u.id)`,
    [DEFAULT_LIST_NAME],
  );

  // Positions you have actually opened — the tracker. Separate from watchlists on purpose: a
  // watchlist is a list of names to look at, a position is a trade with money in it, a lifecycle
  // and a date it was realised. One table would have meant half the columns null on every row.
  await db.query(`
    CREATE TABLE IF NOT EXISTS positions (
      id             TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol         TEXT NOT NULL,
      type           TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'open',
      account        TEXT NOT NULL DEFAULT '',
      contracts      INTEGER NOT NULL DEFAULT 1,
      short_strike   NUMERIC,
      long_strike    NUMERIC,
      expiration     DATE NOT NULL,
      trade_date     DATE,
      -- Dollars for the whole position, as the broker's fill shows it. NUMERIC, not float:
      -- money summed into a goal total should not drift by a cent per row.
      premium        NUMERIC,
      assignment_loss NUMERIC,
      closed_at      DATE,
      rolled_to_expiration  DATE,
      rolled_to_short_strike NUMERIC,
      note           TEXT NOT NULL DEFAULT '',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS positions_user ON positions (user_id, status, expiration)`);
  // The goal totals read by date, and a month of rows is a small scan, but this is the one query
  // that runs on every page load.
  await db.query(`CREATE INDEX IF NOT EXISTS positions_closed ON positions (user_id, closed_at)`);

  await moveWatchlistsOutOfSettings(db);
}

/**
 * Brings a database written before watchlists could be plural up to the current shape, in place.
 *
 * The entries used to hang off the user; now they hang off a named list. Each account's existing
 * symbols become one list, keeping their order, and the old column goes. Keyed off whether that
 * column is still there, so it runs once and is a no-op on every boot after.
 */
async function upgradeToSeveralLists(db) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'watchlist' AND column_name = 'user_id'`,
  );
  if (rows.length === 0) return;

  await db.query(
    `ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS watchlist_id TEXT REFERENCES watchlists(id) ON DELETE CASCADE`,
  );

  // One list per account that has symbols, named the same as a new account's first list — so
  // nobody logs in to find their watchlist under a name the app invented for the occasion.
  await db.query(
    `INSERT INTO watchlists (id, user_id, name, sort_order)
     SELECT gen_random_uuid()::text, u.id, $1, 0
     FROM users u
     WHERE EXISTS (SELECT 1 FROM watchlist w WHERE w.user_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM watchlists l WHERE l.user_id = u.id)`,
    [DEFAULT_LIST_NAME],
  );

  await db.query(`
    UPDATE watchlist w
    SET watchlist_id = (
      SELECT l.id FROM watchlists l WHERE l.user_id = w.user_id ORDER BY l.sort_order, l.created_at LIMIT 1
    )
    WHERE w.watchlist_id IS NULL
  `);

  // Anything still unassigned belongs to no user at all, which the foreign key should have made
  // impossible. Dropped rather than carried forward as a row nothing can reach.
  await db.query(`DELETE FROM watchlist WHERE watchlist_id IS NULL`);

  // Dropping the column takes the old primary key and the old index with it.
  await db.query(`ALTER TABLE watchlist DROP CONSTRAINT IF EXISTS watchlist_pkey`);
  await db.query(`ALTER TABLE watchlist DROP COLUMN IF EXISTS user_id`);
  await db.query(`ALTER TABLE watchlist ALTER COLUMN watchlist_id SET NOT NULL`);
}

/**
 * The one-time move from `settings.data.watchlist` to rows.
 *
 * Runs on every boot and does nothing after the first, because it clears the flag it keys off:
 * the JSON key is deleted once copied, and every user is marked seeded at the end. A list
 * emptied on purpose afterwards is left alone.
 */
async function moveWatchlistsOutOfSettings(db) {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM users WHERE watchlist_seeded = FALSE`);
  if (rows[0].n === 0) return;

  await db.query(
    `INSERT INTO watchlists (id, user_id, name, sort_order)
     SELECT gen_random_uuid()::text, u.id, $1, 0
     FROM users u
     WHERE u.watchlist_seeded = FALSE
       AND NOT EXISTS (SELECT 1 FROM watchlists l WHERE l.user_id = u.id)`,
    [DEFAULT_LIST_NAME],
  );

  // WITH ORDINALITY keeps the order the list was saved in. Entries are filtered rather than
  // trusted — this is the app's own data, but a cast error here would fail every boot.
  await db.query(`
    INSERT INTO watchlist (watchlist_id, symbol, note, earnings, sort_order)
    SELECT l.id,
           upper(e.value->>'symbol'),
           coalesce(e.value->>'note', ''),
           CASE WHEN e.value->>'earnings' ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (e.value->>'earnings')::date END,
           (e.ord - 1)::int
    FROM settings s
    JOIN users u ON u.id = s.user_id AND u.watchlist_seeded = FALSE
    JOIN LATERAL (
      SELECT id FROM watchlists WHERE user_id = u.id ORDER BY sort_order, created_at LIMIT 1
    ) l ON TRUE
    CROSS JOIN LATERAL jsonb_array_elements(s.data->'watchlist') WITH ORDINALITY AS e(value, ord)
    WHERE jsonb_typeof(s.data->'watchlist') = 'array'
      AND upper(e.value->>'symbol') ~ '^[A-Z.]{1,6}$'
    ON CONFLICT (watchlist_id, symbol) DO NOTHING
  `);

  await db.query(`UPDATE settings SET data = data - 'watchlist' WHERE data ? 'watchlist'`);

  // Anyone who had no saved list was looking at the defaults, so that is what they keep.
  await db.query(
    `INSERT INTO watchlist (watchlist_id, symbol, note, sort_order)
     SELECT l.id, d.symbol, d.note, d.ord
     FROM users u
     JOIN LATERAL (
       SELECT id FROM watchlists WHERE user_id = u.id ORDER BY sort_order, created_at LIMIT 1
     ) l ON TRUE
     CROSS JOIN jsonb_to_recordset($1::jsonb) AS d(symbol text, note text, ord int)
     WHERE u.watchlist_seeded = FALSE
       AND NOT EXISTS (SELECT 1 FROM watchlist w WHERE w.watchlist_id = l.id)
     ON CONFLICT (watchlist_id, symbol) DO NOTHING`,
    [JSON.stringify(DEFAULT_WATCHLIST.map((e, ord) => ({ ...e, ord })))],
  );

  await db.query(`UPDATE users SET watchlist_seeded = TRUE WHERE watchlist_seeded = FALSE`);
}
