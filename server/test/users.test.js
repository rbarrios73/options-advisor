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
  await db.query(`INSERT INTO settings (user_id, data) VALUES ($1, $2)`, [
    user.id,
    JSON.stringify({ watchlist: [{ symbol: 'QQQ' }] }),
  ]);

  const state = await settings.read(user.id);
  assert.deepEqual(state.watchlist, [{ symbol: 'QQQ' }]);
  assert.ok(state.filters.minDte > 0, 'filters filled in');
  assert.ok(state.weights.probProfit > 0, 'weights filled in');
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
  assert.equal(await users.findById(member.id), undefined);
});

test('migrate is safe to run again on a database that already has data', async () => {
  const { db, users } = await fresh();
  await users.create({ email: 'a@b.com', password: GOOD, role: 'admin' });

  await migrate(db);
  await migrate(db);

  assert.equal((await users.list()).length, 1);
});
