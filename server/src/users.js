// Accounts, passwords and sessions.
//
// Hashing is scrypt from node:crypto — deliberately, so there is no native dependency to fail to
// build on a host. It is a memory-hard KDF, which is what a password needs; the cost parameters
// are stored alongside each hash so they can be raised later without invalidating old ones.
//
// Session tokens are random and are stored HASHED. The cookie holds the token; the database holds
// its SHA-256. A leaked database backup therefore does not hand anyone a working session, the
// same reason passwords are not stored either.

import { randomBytes, randomUUID, scrypt, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { seedWatchlist } from './store.js';

const scryptAsync = promisify(scrypt);

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const MIN_PASSWORD_LENGTH = 10;
const ROLES = new Set(['admin', 'member']);

// --- passwords ---------------------------------------------------------------------------------

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;

  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;

  try {
    const expected = Buffer.from(hash, 'base64');
    const actual = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** What is wrong with this password, or null if nothing is. */
export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) return 'Password is too long.';
  if (password.trim().length === 0) return 'Password cannot be only spaces.';
  return null;
}

export function normaliseEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

export function emailProblem(email) {
  const clean = normaliseEmail(email);
  // Deliberately loose. The only authority on whether an address is real is whether mail to it
  // arrives, and this app does not send mail.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) || clean.length > 200) return 'Enter a valid email address.';
  return null;
}

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

const publicUser = (row) =>
  row && {
    id: row.id,
    email: row.email,
    role: row.role,
    disabled: row.disabled,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };

/**
 * @param {{query: (sql: string, params?: unknown[]) => Promise<{rows: any[]}>}} db
 */
export function createUserStore(db, { sessionTtlDays = 30 } = {}) {
  async function countAdmins(excludeId = null) {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND disabled = FALSE AND ($1::text IS NULL OR id <> $1)`,
      [excludeId],
    );
    return rows[0].n;
  }

  /** Guards the rule that there must always be someone who can administer the app. */
  async function assertNotLastAdmin(id, what) {
    const { rows } = await db.query(`SELECT role, disabled FROM users WHERE id = $1`, [id]);
    const user = rows[0];
    if (!user || user.role !== 'admin' || user.disabled) return;
    if ((await countAdmins(id)) === 0) {
      throw new UserError(`This is the only administrator — ${what} would lock everyone out.`, 409);
    }
  }

  return {
    async list() {
      const { rows } = await db.query(`SELECT * FROM users ORDER BY lower(email)`);
      return rows.map(publicUser);
    },

    async findById(id) {
      const { rows } = await db.query(`SELECT * FROM users WHERE id = $1`, [id]);
      return publicUser(rows[0]);
    },

    async count() {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM users`);
      return rows[0].n;
    },

    async create({ email, password, role = 'member' }) {
      const problem = emailProblem(email) ?? passwordProblem(password);
      if (problem) throw new UserError(problem, 400);
      if (!ROLES.has(role)) throw new UserError('Unknown role.', 400);

      const clean = normaliseEmail(email);
      const hash = await hashPassword(password);

      try {
        const { rows } = await db.query(
          `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING *`,
          [randomUUID(), clean, hash, role],
        );

        // A new account opens on the default watchlist rather than an empty screener. Done here
        // because this is the one path every account is created through — the admin route and
        // the first-boot bootstrap both come this way.
        await seedWatchlist(db, rows[0].id);

        return publicUser(rows[0]);
      } catch (error) {
        // 23505 is unique_violation: the address is already registered.
        if (error.code === '23505') throw new UserError('That email address already has an account.', 409);
        throw error;
      }
    },

    async setPassword(id, password) {
      const problem = passwordProblem(password);
      if (problem) throw new UserError(problem, 400);

      const hash = await hashPassword(password);
      const { rowCount } = await db.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [id, hash]);
      if (!rowCount) throw new UserError('No such user.', 404);

      // Changing a password ends every session that password opened — the point of changing it
      // is usually that one of them should not continue.
      await db.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
    },

    async update(id, { role, disabled }) {
      if (role !== undefined && !ROLES.has(role)) throw new UserError('Unknown role.', 400);

      if ((role !== undefined && role !== 'admin') || disabled === true) {
        await assertNotLastAdmin(id, role !== undefined && role !== 'admin' ? 'changing its role' : 'disabling it');
      }

      const { rows } = await db.query(
        `UPDATE users SET role = COALESCE($2, role), disabled = COALESCE($3, disabled) WHERE id = $1 RETURNING *`,
        [id, role ?? null, disabled ?? null],
      );
      if (!rows[0]) throw new UserError('No such user.', 404);

      // A disabled account should not stay signed in on a machine it is already signed in on.
      if (disabled === true) await db.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
      return publicUser(rows[0]);
    },

    async remove(id) {
      await assertNotLastAdmin(id, 'deleting it');
      const { rowCount } = await db.query(`DELETE FROM users WHERE id = $1`, [id]);
      if (!rowCount) throw new UserError('No such user.', 404);
    },

    // --- sessions ------------------------------------------------------------------------------

    /**
     * Checks an email and password. Returns null for every kind of failure — wrong address, wrong
     * password, disabled account — because saying which one is which tells an attacker whose
     * address is registered here.
     */
    async authenticate(email, password) {
      const { rows } = await db.query(`SELECT * FROM users WHERE lower(email) = $1`, [normaliseEmail(email)]);
      const row = rows[0];

      // Hash even when there is no such user, so a missing account does not answer faster than a
      // wrong password and turn this into an account-enumeration oracle.
      const ok = await verifyPassword(String(password ?? ''), row?.password_hash ?? (await dummyHash()));
      if (!row || !ok || row.disabled) return null;

      await db.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [row.id]);
      return publicUser(row);
    },

    /** Returns the raw token for the cookie; only its hash is stored. */
    async startSession(userId) {
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + sessionTtlDays * 86_400_000);

      await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)`, [
        hashToken(token),
        userId,
        expiresAt,
      ]);
      return { token, expiresAt };
    },

    async userForToken(token) {
      if (!token) return null;

      const { rows } = await db.query(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = $1 AND s.expires_at > now() AND u.disabled = FALSE`,
        [hashToken(token)],
      );
      return publicUser(rows[0]) ?? null;
    },

    async endSession(token) {
      if (token) await db.query(`DELETE FROM sessions WHERE id = $1`, [hashToken(token)]);
    },

    /** Housekeeping: expired rows are dead weight and are never read. */
    async purgeExpiredSessions() {
      const { rowCount } = await db.query(`DELETE FROM sessions WHERE expires_at <= now()`);
      return rowCount;
    },
  };
}

/** An error with a status code, so routes can report it without a lookup table. */
export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UserError';
    this.status = status;
  }
}

// One precomputed hash of a random string, used to spend the same time on a login for an address
// that does not exist as on one that does.
let dummy = null;
async function dummyHash() {
  dummy ??= await hashPassword(randomBytes(24).toString('hex'));
  return dummy;
}
