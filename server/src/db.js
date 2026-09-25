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

import { DEFAULT_WATCHLIST } from './domain/watchlist.js';

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

  // The watchlist is rows, not a field inside `settings.data`. It is the one part of a user's
  // settings that is a list of things rather than a setting — it has an order, each entry has its
  // own fields, and it is what the scan iterates. As rows it can be read in order, updated one
  // symbol at a time, and looked at in a SQL console when something is wrong.
  await db.query(`
    CREATE TABLE IF NOT EXISTS watchlist (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol     TEXT NOT NULL,
      note       TEXT NOT NULL DEFAULT '',
      -- A real DATE, so the database rejects the 31st of February. It is always read back with
      -- to_char: a DATE arrives in Node as a Date at local midnight, which is the previous day
      -- west of UTC, and an earnings date that moves by a day is worse than none.
      earnings   DATE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, symbol)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS watchlist_order ON watchlist (user_id, sort_order)`);

  // Marks a user whose list has been set up, so an empty watchlist stays empty. Without it,
  // "this user has no rows" cannot tell a new account from someone who cleared their list on
  // purpose, and the defaults would come back on the next restart.
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS watchlist_seeded BOOLEAN NOT NULL DEFAULT FALSE`);

  await moveWatchlistsOutOfSettings(db);
}

/**
 * The one-time move from `settings.data.watchlist` to the watchlist table.
 *
 * Runs on every boot and does nothing after the first, because it clears the flag it keys off:
 * the JSON key is deleted once copied, and every user is marked seeded at the end. A list
 * emptied on purpose afterwards is left alone.
 */
async function moveWatchlistsOutOfSettings(db) {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM users WHERE watchlist_seeded = FALSE`);
  if (rows[0].n === 0) return;

  // WITH ORDINALITY keeps the order the list was saved in. Entries are filtered rather than
  // trusted — this is the app's own data, but a cast error here would fail every boot.
  await db.query(`
    INSERT INTO watchlist (user_id, symbol, note, earnings, sort_order)
    SELECT s.user_id,
           upper(e.value->>'symbol'),
           coalesce(e.value->>'note', ''),
           CASE WHEN e.value->>'earnings' ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (e.value->>'earnings')::date END,
           (e.ord - 1)::int
    FROM settings s
    JOIN users u ON u.id = s.user_id AND u.watchlist_seeded = FALSE
    CROSS JOIN LATERAL jsonb_array_elements(s.data->'watchlist') WITH ORDINALITY AS e(value, ord)
    WHERE jsonb_typeof(s.data->'watchlist') = 'array'
      AND upper(e.value->>'symbol') ~ '^[A-Z.]{1,6}$'
    ON CONFLICT (user_id, symbol) DO NOTHING
  `);

  await db.query(`UPDATE settings SET data = data - 'watchlist' WHERE data ? 'watchlist'`);

  // Anyone who had no saved list was looking at the defaults, so that is what they keep.
  await db.query(
    `INSERT INTO watchlist (user_id, symbol, note, sort_order)
     SELECT u.id, d.symbol, d.note, d.ord
     FROM users u
     CROSS JOIN jsonb_to_recordset($1::jsonb) AS d(symbol text, note text, ord int)
     WHERE u.watchlist_seeded = FALSE
       AND NOT EXISTS (SELECT 1 FROM watchlist w WHERE w.user_id = u.id)
     ON CONFLICT (user_id, symbol) DO NOTHING`,
    [JSON.stringify(DEFAULT_WATCHLIST.map((e, ord) => ({ ...e, ord })))],
  );

  await db.query(`UPDATE users SET watchlist_seeded = TRUE WHERE watchlist_seeded = FALSE`);
}
