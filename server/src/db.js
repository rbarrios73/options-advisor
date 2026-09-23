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
}
