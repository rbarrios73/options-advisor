import test from 'node:test';
import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';

import { migrate } from '../src/db.js';
import { createDbStore } from '../src/store.js';
import {
  UserError,
  createUserStore,
  emailProblem,
  hashPassword,
  passwordProblem,
  verifyPassword,
} from '../src/users.js';

// A real Postgres, in process — so these exercise the actual SQL, constraints and cascades
// rather than a stand-in that would agree with whatever the code does.
async function fresh({ sessionTtlDays = 30 } = {}) {
  const db = await PGlite.create();
  await migrate(db);
  return { db, users: createUserStore(db, { sessionTtlDays }), settings: createDbStore(db) };
}

const GOOD = 'correct horse battery';

// --- passwords ---------------------------------------------------------------------------------

test('password hashes verify, differ every time, and never contain the password', async () => {
  const a = await hashPassword(GOOD);
  const b = await hashPassword(GOOD);

  assert.notEqual(a, b, 'a fresh salt each time');
  assert.ok(!a.includes(GOOD));
  assert.ok(a.startsWith('scrypt$16384$8$1$'), a.slice(0, 20));

  assert.equal(await verifyPassword(GOOD, a), true);
  assert.equal(await verifyPassword(GOOD, b), true);
  assert.equal(await verifyPassword('correct horse batter', a), false);
  assert.equal(await verifyPassword('', a), false);
});

test('a malformed or foreign hash is rejected, not thrown on', async () => {
  for (const stored of ['', 'nonsense', 'bcrypt$2$x$y', 'scrypt$notanumber$8$1$AA$BB', null, undefined]) {
    assert.equal(await verifyPassword(GOOD, stored), false, String(stored));
  }
});

test('weak passwords and bad addresses are named before anything is stored', () => {
  assert.match(passwordProblem('short'), /at least 10/);
  assert.match(passwordProblem('          '), /only spaces/);
  assert.equal(passwordProblem(GOOD), null);

  assert.match(emailProblem('not-an-email'), /valid email/);
  assert.match(emailProblem(''), /valid email/);
  assert.equal(emailProblem('  Raul@Example.COM '), null);
});

// --- accounts ------------------------------------------------------------------------------------

test('creating a user normalises the address and refuses a duplicate in any case', async () => {
  const { users } = await fresh();

  const user = await users.create({ email: '  Raul@Example.COM ', password: GOOD, role: 'admin' });
  assert.equal(user.email, 'raul@example.com');
  assert.equal(user.role, 'admin');
  assert.equal(user.disabled, false);
  assert.ok(!('password_hash' in user) && !('passwordHash' in user), 'never hands back the hash');

  await assert.rejects(() => users.create({ email: 'RAUL@example.com', password: GOOD }), (e) => {
    assert.ok(e instanceof UserError);
    assert.equal(e.status, 409);
    return true;
  });
});

test('sign-in accepts the right password and refuses everything else, alike', async () => {
  const { users } = await fresh();
  await users.create({ email: 'a@b.com', password: GOOD });

  assert.ok(await users.authenticate('A@B.COM', GOOD), 'address is case-insensitive');
  assert.equal(await users.authenticate('a@b.com', 'wrong password!'), null);
  assert.equal(await users.authenticate('nobody@b.com', GOOD), null, 'no such user answers the same way');
  assert.equal(await users.authenticate('a@b.com', ''), null);
  assert.equal(await users.authenticate('a@b.com', undefined), null);
});

test('a disabled account cannot sign in, and its live sessions are ended', async () => {
  const { users } = await fresh();
  const admin = await users.create({ email: 'admin@b.com', password: GOOD, role: 'admin' });
  const member = await users.create({ email: 'm@b.com', password: GOOD });

  const { token } = await users.startSession(member.id);
  assert.equal((await users.userForToken(token)).id, member.id);

  await users.update(member.id, { disabled: true });

  assert.equal(await users.userForToken(token), null, 'the open session stops working');
  assert.equal(await users.authenticate('m@b.com', GOOD), null);
  assert.ok(await users.authenticate('admin@b.com', GOOD), 'other accounts are untouched');
});

// --- sessions ------------------------------------------------------------------------------------

test('the session token is not what is stored', async () => {
  const { db, users } = await fresh();
  const user = await users.create({ email: 'a@b.com', password: GOOD });

  const { token } = await users.startSession(user.id);
  const { rows } = await db.query('SELECT id FROM sessions');

  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].id, token, 'the database holds a hash, not the cookie value');
  assert.equal(await users.userForToken(rows[0].id), null, 'the stored value is not a usable token');
});

test('sessions expire, and expired ones are purged', async () => {
  const { db, users } = await fresh({ sessionTtlDays: -1 }); // already in the past
  const user = await users.create({ email: 'a@b.com', password: GOOD });
  const { token } = await users.startSession(user.id);

  assert.equal(await users.userForToken(token), null, 'an expired session does not authenticate');
  assert.equal(await users.purgeExpiredSessions(), 1);
  assert.equal((await db.query('SELECT count(*)::int n FROM sessions')).rows[0].n, 0);
});

test('signing out ends that session only', async () => {
  const { users } = await fresh();
  const user = await users.create({ email: 'a@b.com', password: GOOD });

  const laptop = await users.startSession(user.id);
  const phone = await users.startSession(user.id);

  await users.endSession(laptop.token);
  assert.equal(await users.userForToken(laptop.token), null);
  assert.ok(await users.userForToken(phone.token), 'the other device stays signed in');

  await users.endSession(null); // must not throw or delete anything
  assert.ok(await users.userForToken(phone.token));
});

test('changing a password ends every session for that account', async () => {
  const { users } = await fresh();
  const user = await users.create({ email: 'a@b.com', password: GOOD });
  const a = await users.startSession(user.id);
  const b = await users.startSession(user.id);

  await users.setPassword(user.id, 'a different long password');

  assert.equal(await users.userForToken(a.token), null);
  assert.equal(await users.userForToken(b.token), null);
  assert.ok(await users.authenticate('a@b.com', 'a different long password'));
  assert.equal(await users.authenticate('a@b.com', GOOD), null, 'the old password stops working');
});

test('a short new password is refused before the old one is replaced', async () => {
  const { users } = await fresh();
  const user = await users.create({ email: 'a@b.com', password: GOOD });

  await assert.rejects(() => users.setPassword(user.id, 'short'), /at least 10/);
  assert.ok(await users.authenticate('a@b.com', GOOD), 'the old password still works');
});

// --- the last administrator ----------------------------------------------------------------------

test('the last administrator cannot be deleted, demoted or disabled', async () => {
  const { users } = await fresh();
  const admin = await users.create({ email: 'admin@b.com', password: GOOD, role: 'admin' });
  await users.create({ email: 'member@b.com', password: GOOD });

  const lastAdmin = /only administrator/;
  await assert.rejects(() => users.remove(admin.id), lastAdmin);
  await assert.rejects(() => users.update(admin.id, { role: 'member' }), lastAdmin);
  await assert.rejects(() => users.update(admin.id, { disabled: true }), lastAdmin);

  // With a second admin in place the first one can be demoted...
  const second = await users.create({ email: 'admin2@b.com', password: GOOD, role: 'admin' });
  await users.update(admin.id, { role: 'member' });
  assert.equal((await users.findById(admin.id)).role, 'member');

  // ...and the guard moves with the set: the second admin is now the only one left.
  await assert.rejects(() => users.remove(second.id), lastAdmin);

  await users.update(admin.id, { role: 'admin' });
  await users.remove(second.id);
  assert.deepEqual(
    (await users.list()).map((u) => [u.email, u.role]),
    [['admin@b.com', 'admin'], ['member@b.com', 'member']],
  );
});

test('a disabled admin does not count as cover for the last one', async () => {
  const { users } = await fresh();
  const active = await users.create({ email: 'a@b.com', password: GOOD, role: 'admin' });
  const sleeping = await users.create({ email: 'b@b.com', password: GOOD, role: 'admin' });
  await users.update(sleeping.id, { disabled: true });

  await assert.rejects(() => users.remove(active.id), /only administrator/);
});

// --- per-user settings -----------------------------------------------------------------------------

test('each account has its own watchlist, and a new one starts from the defaults', async () => {
  const { users, settings } = await fresh();
  const raul = await users.create({ email: 'raul@b.com', password: GOOD, role: 'admin' });
  const sam = await users.create({ email: 'sam@b.com', password: GOOD });

  const defaults = await settings.read(raul.id);
  assert.ok(defaults.watchlist.length >= 10, 'the default watchlist');
  assert.ok(defaults.filters.minDte > 0, 'and the default filters');

  await settings.setWatchlist(raul.id, [{ symbol: 'SPY', note: '', earnings: null }]);

  assert.deepEqual((await settings.read(raul.id)).watchlist, [{ symbol: 'SPY', note: '', earnings: null }]);
  assert.equal((await settings.read(sam.id)).watchlist.length, defaults.watchlist.length, 'sam is unaffected');
});

test('saved settings survive, and missing keys are filled in from the defaults', async () => {
  const { db, users, settings } = await fresh();
  const user = await users.create({ email: 'a@b.com', password: GOOD });

  // A row written by an older version of the app, with no filters or weights at all.
  await db.query(`INSERT INTO settings (user_id, data) VALUES ($1, $2)`, [user.id, JSON.stringify({})]);

  const state = await settings.read(user.id);
  assert.ok(state.filters.minDte > 0, 'filters filled in');
  assert.ok(state.weights.probProfit > 0, 'weights filled in');
});

test('a new account opens on the default watchlist, and clearing it makes it stay clear', async () => {
  const { users, settings } = await fresh();
  const user = await users.create({ email: 'a@b.com', password: GOOD });

  const seeded = (await settings.read(user.id)).watchlist;
  assert.ok(seeded.length >= 5, `${seeded.length} symbols seeded`);
  assert.equal(seeded[0].symbol, 'SPY', 'and in the order the defaults are written in');

  await settings.setWatchlist(user.id, []);
  assert.deepEqual((await settings.read(user.id)).watchlist, [], 'empty is a list you chose');
});

test('the watchlist is rows: order is kept, entries are tidied, and duplicates collapse', async () => {
  const { db, users, settings } = await fresh();
  const user = await users.create({ email: 'a@b.com', password: GOOD });

  await settings.setWatchlist(user.id, [
    { symbol: 'tlt', note: '  duration  ', earnings: '' },
    { symbol: 'NVDA', note: 'semis', earnings: '2026-11-19' },
    { symbol: 'NVDA', note: 'said twice' },
    { symbol: 'not a ticker!', note: 'dropped' },
  ]);

  const list = (await settings.read(user.id)).watchlist;
  assert.deepEqual(list, [
    { symbol: 'TLT', note: 'duration', earnings: null },
    { symbol: 'NVDA', note: 'semis', earnings: '2026-11-19' },
  ]);

  // The date comes back as the day it was saved. A DATE column read as a JS Date is local
  // midnight, which is the day before west of UTC — so it is read back with to_char.
  assert.equal(typeof list[1].earnings, 'string');

  // Reordering is a save like any other, and removes nothing.
  await settings.setWatchlist(user.id, [list[1], list[0]]);
  assert.deepEqual(
    (await settings.read(user.id)).watchlist.map((w) => w.symbol),
    ['NVDA', 'TLT'],
  );

  const { rows } = await db.query(`SELECT symbol FROM watchlist WHERE user_id = $1 ORDER BY sort_order`, [user.id]);
  assert.deepEqual(rows.map((r) => r.symbol), ['NVDA', 'TLT'], 'rows, not a blob');
});

test('one account cannot see or overwrite another account\'s watchlist', async () => {
  const { users, settings } = await fresh();
  const a = await users.create({ email: 'a@b.com', password: GOOD });
  const b = await users.create({ email: 'b@b.com', password: GOOD });

  await settings.setWatchlist(a.id, [{ symbol: 'GLD', note: 'gold' }]);

  const forB = (await settings.read(b.id)).watchlist;
  assert.ok(forB.length > 1, "B still has B's own list");
  assert.ok(forB.some((w) => w.symbol === 'SPY'));
});

test('a watchlist stored the old way, inside the settings blob, is moved into the table once', async () => {
  const { db, users, settings } = await fresh();
  const user = await users.create({ email: 'a@b.com', password: GOOD });

  // Put the database back the way an older version of the app left it: the list buried in the
  // JSON, the table empty, and the user not yet marked as set up.
  await db.query(`DELETE FROM watchlist WHERE user_id = $1`, [user.id]);
  await db.query(`UPDATE users SET watchlist_seeded = FALSE WHERE id = $1`, [user.id]);
  await db.query(`INSERT INTO settings (user_id, data) VALUES ($1, $2)`, [
    user.id,
    JSON.stringify({
      watchlist: [
        { symbol: 'QQQ', note: 'tech', earnings: null },
        { symbol: 'aapl', note: '', earnings: '2026-10-29' },
        { symbol: 'junk!!', note: 'not a ticker' },
      ],
      filters: { minDte: 21 },
    }),
  ]);

  await migrate(db);

  assert.deepEqual((await settings.read(user.id)).watchlist, [
    { symbol: 'QQQ', note: 'tech', earnings: null },
    { symbol: 'AAPL', note: '', earnings: '2026-10-29' },
  ]);
  assert.equal((await settings.read(user.id)).filters.minDte, 21, 'the rest of the settings are untouched');

  const { rows } = await db.query(`SELECT data ? 'watchlist' AS buried FROM settings WHERE user_id = $1`, [user.id]);
  assert.equal(rows[0].buried, false, 'and the blob copy is gone, so it cannot come back');

  // The move is what runs on every boot. Running it again must not resurrect anything.
  await settings.setWatchlist(user.id, []);
  await migrate(db);
  assert.deepEqual((await settings.read(user.id)).watchlist, []);
});

test('an account that predates the watchlist table, and never saved settings, keeps the defaults', async () => {
  const { db, users, settings } = await fresh();
  const user = await users.create({ email: 'a@b.com', password: GOOD });

  await db.query(`DELETE FROM watchlist WHERE user_id = $1`, [user.id]);
  await db.query(`UPDATE users SET watchlist_seeded = FALSE WHERE id = $1`, [user.id]);

  await migrate(db);

  const list = (await settings.read(user.id)).watchlist;
  assert.ok(list.length >= 5, 'they were looking at the defaults, so that is what they keep');
  assert.equal(list[0].symbol, 'SPY');
});

test('deleting a user takes their sessions and settings with them', async () => {
  const { db, users, settings } = await fresh();
  await users.create({ email: 'admin@b.com', password: GOOD, role: 'admin' });
  const member = await users.create({ email: 'm@b.com', password: GOOD });

  await users.startSession(member.id);
  await settings.setWatchlist(member.id, [{ symbol: 'SPY' }]);

  await users.remove(member.id);

  assert.equal((await db.query('SELECT count(*)::int n FROM sessions')).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int n FROM settings')).rows[0].n, 0);
  assert.equal(
    (await db.query('SELECT count(*)::int n FROM watchlist WHERE user_id = $1', [member.id])).rows[0].n,
    0,
    'the watchlist cascades too — and the admin still has theirs',
  );
  assert.ok((await db.query('SELECT count(*)::int n FROM watchlist')).rows[0].n > 0);
  assert.equal(await users.findById(member.id), undefined);
});

test('migrate is safe to run again on a database that already has data', async () => {
  const { db, users } = await fresh();
  await users.create({ email: 'a@b.com', password: GOOD, role: 'admin' });

  await migrate(db);
  await migrate(db);

  assert.equal((await users.list()).length, 1);
});
