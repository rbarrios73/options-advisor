import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { PGlite } from '@electric-sql/pglite';

import { createApp, prepare } from '../src/app.js';
import { migrate } from '../src/db.js';
import { DEFAULT_RANGE } from '../src/domain/history.js';

// The real routes over real HTTP, against a real (in-process) Postgres. Cookies, status codes and
// cross-account isolation are the sort of thing that only a round trip actually proves.

const ADMIN = { email: 'admin@example.com', password: 'admin password one' };
const MEMBER = { email: 'member@example.com', password: 'member password one' };

const baseConfig = {
  production: false,
  provider: 'mock',
  cacheTtlMs: 60_000,
  sessionTtlDays: 30,
  webDist: '/nonexistent',
  riskFreeRate: 0.04,
  authUser: '',
  authPassword: '',
  adminEmail: ADMIN.email,
  adminPassword: ADMIN.password,
  adminReset: false,
  advisorPerHour: 20,
};

/** A stand-in for the Messages API, so these tests never touch the network. */
function stubAnthropic(reply = 'Candidate 1, SPY, pays the most for its risk.') {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: 'stub-model',
        content: [{ type: 'text', text: reply }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1000, output_tokens: 200 },
      }),
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

async function startServer(overrides = {}) {
  const db = await PGlite.create();
  await migrate(db);

  const config = { ...baseConfig, ...overrides };
  const built = createApp({ config, db });
  await prepare({ config, db, users: built.users, accounts: built.accounts });

  const server = built.app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  /**
   * One browser: its own cookie jar. Two accounts in a test means two of these, rather than one
   * jar and a sign-out in between — signing out ends the session, so a cookie kept from before
   * it would be dead for reasons that have nothing to do with what is being tested.
   */
  const client = () => {
    const jar = { cookie: null };

    const call = async (path, { method = 'GET', body, cookie = jar.cookie } = {}) => {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      const setCookie = response.headers.get('set-cookie');
      if (setCookie) jar.cookie = setCookie.split(';')[0];

      const text = await response.text();
      return { status: response.status, setCookie, body: text ? JSON.parse(text) : null };
    };

    call.jar = jar;
    call.signIn = (who) => call('/api/login', { method: 'POST', body: who });
    return call;
  };

  // The database is closed as well as the server. Each test spins up its own in-process Postgres,
  // and leaving them open leaked one per test until the whole file was killed for memory —
  // which reads as a mysterious SIGKILL rather than as a failing assertion.
  const close = async () => {
    server.close();
    await db.close();
  };

  return { client, base, db, users: built.users, close };
}

// --- the gate --------------------------------------------------------------------------------

test('every data route needs a session; health and identity do not', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const anon = s.client();

  assert.equal((await anon('/api/health')).status, 200, 'health stays open for the host checker');

  const me = await anon('/api/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.body, { accounts: true, user: null }, 'not signed in is an answer, not an error');

  for (const [path, method] of [
    ['/api/settings', 'GET'],
    ['/api/scan', 'POST'],
    ['/api/watchlist', 'PUT'],
    ['/api/filters', 'PUT'],
    ['/api/expirations?symbol=SPY', 'GET'],
    ['/api/chain?symbol=SPY&expiration=2026-10-23', 'GET'],
    ['/api/users', 'GET'],
  ]) {
    const r = await anon(path, { method, body: method === 'GET' ? undefined : {} });
    assert.equal(r.status, 401, `${method} ${path}`);
  }
});

test('signing in sets an HttpOnly session cookie and signing out clears it', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const call = s.client();

  const bad = await call('/api/login', { method: 'POST', body: { ...ADMIN, password: 'wrong wrong wrong' } });
  assert.equal(bad.status, 401);
  assert.match(bad.body.error, /Wrong email or password/);
  assert.equal(bad.setCookie, null, 'a failed sign-in sets nothing');

  const ok = await call.signIn(ADMIN);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.email, ADMIN.email);
  assert.equal(ok.body.user.role, 'admin');
  assert.ok(!('passwordHash' in ok.body.user) && !('password_hash' in ok.body.user));

  assert.match(ok.setCookie, /^oa_session=/);
  assert.match(ok.setCookie, /HttpOnly/, 'script cannot read it');
  assert.match(ok.setCookie, /SameSite=Lax/, 'another site cannot make the browser send it');
  assert.ok(!/Secure/.test(ok.setCookie), 'not Secure in development, or localhost could not sign in');

  assert.equal((await call('/api/settings')).status, 200);

  const out = await call('/api/logout', { method: 'POST' });
  assert.match(out.setCookie, /oa_session=;/);
  assert.equal((await call('/api/settings')).status, 401, 'the cookie no longer works');
});

test('the cookie is marked Secure in production', async (t) => {
  const s = await startServer({ production: true });
  t.after(s.close);

  assert.match((await s.client().signIn(ADMIN)).setCookie, /Secure/);
});

test('a forged or stale cookie is simply not signed in', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const call = s.client();

  for (const cookie of ['oa_session=made-up', 'oa_session=', 'other=1']) {
    assert.equal((await call('/api/me', { cookie })).body.user, null, cookie);
  }
});

// --- bootstrap -------------------------------------------------------------------------------

test('the first admin comes from the environment, and a redeploy does not reset the password', async () => {
  const db = await PGlite.create();
  await migrate(db);

  const config = { ...baseConfig };
  const built = createApp({ config, db });

  await prepare({ config, db, users: built.users, accounts: true });
  assert.equal((await built.users.list()).length, 1);

  // The password is changed in the app, then the app restarts with the old one still in the env.
  const me = (await built.users.list())[0];
  await built.users.setPassword(me.id, 'changed it afterwards');
  await prepare({ config, db, users: built.users, accounts: true });

  assert.ok(await built.users.authenticate(ADMIN.email, 'changed it afterwards'), 'kept the new password');
  assert.equal(await built.users.authenticate(ADMIN.email, ADMIN.password), null);

  // ADMIN_RESET is the deliberate way back in after a forgotten password.
  await prepare({ config: { ...config, adminReset: true }, db, users: built.users, accounts: true });
  assert.ok(await built.users.authenticate(ADMIN.email, ADMIN.password), 'reset on request');
});

// --- administration --------------------------------------------------------------------------

test('only an admin can manage users', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = s.client();
  await admin.signIn(ADMIN);
  const created = await admin('/api/users', { method: 'POST', body: { ...MEMBER, role: 'member' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.user.role, 'member');

  const member = s.client();
  await member.signIn(MEMBER);

  assert.equal((await member('/api/users')).status, 403, 'members cannot list accounts');
  assert.equal(
    (await member('/api/users', { method: 'POST', body: { email: 'x@y.com', password: 'another password' } })).status,
    403,
    'nor create them',
  );
  assert.equal((await member(`/api/users/${created.body.user.id}`, { method: 'DELETE' })).status, 403);

  // But a member can use the app.
  assert.equal((await member('/api/settings')).status, 200);
});

test('account creation rejects duplicates and weak passwords with a readable message', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const admin = s.client();
  await admin.signIn(ADMIN);

  const weak = await admin('/api/users', { method: 'POST', body: { email: 'a@b.com', password: 'short' } });
  assert.equal(weak.status, 400);
  assert.match(weak.body.error, /at least 10/);

  const bad = await admin('/api/users', { method: 'POST', body: { email: 'nope', password: 'long enough here' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /valid email/);

  await admin('/api/users', { method: 'POST', body: MEMBER });
  const dupe = await admin('/api/users', { method: 'POST', body: { ...MEMBER, email: MEMBER.email.toUpperCase() } });
  assert.equal(dupe.status, 409);
  assert.match(dupe.body.error, /already has an account/);
});

test('an admin cannot lock the app out via their own account', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const admin = s.client();
  await admin.signIn(ADMIN);

  const me = (await admin('/api/me')).body.user;

  const demote = await admin(`/api/users/${me.id}`, { method: 'PATCH', body: { role: 'member' } });
  assert.equal(demote.status, 409);
  assert.match(demote.body.error, /your own account/);

  assert.equal((await admin(`/api/users/${me.id}`, { method: 'PATCH', body: { disabled: true } })).status, 409);
  assert.equal((await admin(`/api/users/${me.id}`, { method: 'DELETE' })).status, 409);
  assert.equal((await admin('/api/me')).body.user.role, 'admin', 'still an admin');
});

test('an admin resetting a password signs that person out everywhere', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = s.client();
  await admin.signIn(ADMIN);
  const created = await admin('/api/users', { method: 'POST', body: MEMBER });

  const member = s.client();
  await member.signIn(MEMBER);
  assert.equal((await member('/api/settings')).status, 200);

  const reset = await admin(`/api/users/${created.body.user.id}`, {
    method: 'PATCH',
    body: { password: 'a brand new password' },
  });
  assert.equal(reset.status, 200);

  assert.equal((await member('/api/settings')).status, 401, 'the open session is gone');
  assert.equal((await member('/api/login', { method: 'POST', body: MEMBER })).status, 401, 'old password is gone');
  assert.equal(
    (await member('/api/login', { method: 'POST', body: { email: MEMBER.email, password: 'a brand new password' } }))
      .status,
    200,
  );
});

test('disabling an account ends its session immediately', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = s.client();
  await admin.signIn(ADMIN);
  const created = await admin('/api/users', { method: 'POST', body: MEMBER });

  const member = s.client();
  await member.signIn(MEMBER);
  assert.equal((await member('/api/settings')).status, 200);

  await admin(`/api/users/${created.body.user.id}`, { method: 'PATCH', body: { disabled: true } });

  assert.equal((await member('/api/settings')).status, 401);
  assert.equal((await member('/api/login', { method: 'POST', body: MEMBER })).status, 401, 'and cannot sign back in');
});

test('changing your own password requires the current one, and keeps you signed in', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const call = s.client();
  await call.signIn(ADMIN);

  const wrong = await call('/api/password', {
    method: 'POST',
    body: { currentPassword: 'not it at all', newPassword: 'a fine new password' },
  });
  assert.equal(wrong.status, 403);

  const short = await call('/api/password', {
    method: 'POST',
    body: { currentPassword: ADMIN.password, newPassword: 'tiny' },
  });
  assert.equal(short.status, 400);

  const ok = await call('/api/password', {
    method: 'POST',
    body: { currentPassword: ADMIN.password, newPassword: 'a fine new password' },
  });
  assert.equal(ok.status, 200);
  assert.ok(ok.setCookie, 'a fresh cookie, because changing a password ends the old sessions');
  assert.equal((await call('/api/settings')).status, 200, 'still signed in on this device');
});

// --- one account cannot see another's --------------------------------------------------------

test('watchlists are per account', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = s.client();
  await admin.signIn(ADMIN);
  await admin('/api/users', { method: 'POST', body: MEMBER });

  await admin('/api/watchlist', { method: 'PUT', body: { watchlist: [{ symbol: 'AAPL' }] } });
  assert.deepEqual((await admin('/api/settings')).body.watchlist.map((w) => w.symbol), ['AAPL']);

  const member = s.client();
  await member.signIn(MEMBER);

  const memberList = (await member('/api/settings')).body.watchlist.map((w) => w.symbol);
  assert.ok(memberList.length > 1 && !memberList.includes('AAPL'), 'a new account gets the defaults');

  await member('/api/watchlist', { method: 'PUT', body: { watchlist: [{ symbol: 'TLT' }] } });
  assert.deepEqual((await member('/api/settings')).body.watchlist.map((w) => w.symbol), ['TLT']);

  assert.deepEqual(
    (await admin('/api/settings')).body.watchlist.map((w) => w.symbol),
    ['AAPL'],
    "the admin's list is untouched",
  );
});

test('saving a watchlist tidies it, keeps its order, and answers with what was stored', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const call = s.client();
  await call.signIn(ADMIN);

  const { status, body } = await call('/api/watchlist', {
    method: 'PUT',
    body: {
      watchlist: [
        { symbol: ' nvda ', note: '  semis  ', earnings: '2026-11-19' },
        { symbol: 'gld', note: 'gold', earnings: '' },
        { symbol: 'GLD', note: 'said twice' },
        { symbol: 'not a ticker', note: 'dropped' },
      ],
    },
  });

  assert.equal(status, 200);
  assert.deepEqual(body.watchlist, [
    { symbol: 'NVDA', note: 'semis', earnings: '2026-11-19' },
    { symbol: 'GLD', note: 'gold', earnings: null },
  ]);

  // The response is what is stored, not an echo of what was sent — the page replaces its own
  // optimistic copy with it, so the two cannot drift.
  assert.deepEqual((await call('/api/settings')).body.watchlist, body.watchlist);

  // And an empty list is a list, not a reason to put the defaults back.
  await call('/api/watchlist', { method: 'PUT', body: { watchlist: [] } });
  assert.deepEqual((await call('/api/settings')).body.watchlist, []);
});

test('the watchlist routes create, rename, switch and delete — and refuse another account\'s list', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = s.client();
  await admin.signIn(ADMIN);
  await admin('/api/users', { method: 'POST', body: MEMBER });

  const member = s.client();
  await member.signIn(MEMBER);
  const hers = (await member('/api/settings')).body.watchlists[0];

  // Create. The answer is the whole state, so the page replaces what it has rather than patching.
  const made = await admin('/api/watchlists', { method: 'POST', body: { name: 'ETFs', watchlist: [{ symbol: 'gld' }] } });
  assert.equal(made.status, 200);
  assert.equal(made.body.watchlists.length, 2);

  const etfs = made.body.watchlists[1];
  assert.equal(etfs.name, 'ETFs');
  assert.equal(made.body.activeWatchlistId, etfs.id, 'a new list is the one you are now working in');
  assert.deepEqual(made.body.watchlist.map((w) => w.symbol), ['GLD']);

  // A scan follows the active list, which is the whole point of having one.
  const scan = await admin('/api/scan', { method: 'POST', body: {} });
  assert.deepEqual(scan.body.symbols.map((row) => row.symbol), ['GLD']);

  // Rename, then switch back to the first list.
  const renamed = await admin(`/api/watchlists/${etfs.id}`, { method: 'PATCH', body: { name: '  index   funds ' } });
  assert.equal(renamed.body.watchlists[1].name, 'index funds');

  const first = renamed.body.watchlists[0];
  const switched = await admin(`/api/watchlists/${first.id}`, { method: 'PATCH', body: { active: true } });
  assert.equal(switched.body.activeWatchlistId, first.id);
  assert.equal(switched.body.watchlist.length, 10);

  // One account's id is not a handle on another's list — and the answer does not say otherwise.
  for (const [method, body] of [['PATCH', { name: 'mine' }], ['PUT', { watchlist: [] }], ['DELETE', undefined]]) {
    const refused = await admin(`/api/watchlists/${hers.id}`, { method, body });
    assert.equal(refused.status, 404, `${method} another account's list`);
    assert.equal(refused.body.error, 'No such watchlist.');
  }
  assert.equal((await member('/api/settings')).body.watchlist.length, 10, "and hers is untouched");

  // Delete, then find the last one cannot go.
  const deleted = await admin(`/api/watchlists/${etfs.id}`, { method: 'DELETE' });
  assert.equal(deleted.body.watchlists.length, 1);

  const lastOne = await admin(`/api/watchlists/${first.id}`, { method: 'DELETE' });
  assert.equal(lastOne.status, 409);
  assert.match(lastOne.body.error, /only watchlist/);
});

test('an empty or missing watchlist body empties the list rather than erroring', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const call = s.client();
  await call.signIn(ADMIN);

  assert.equal((await call('/api/watchlist', { method: 'PUT', body: {} })).status, 200);
  assert.deepEqual((await call('/api/settings')).body.watchlist, []);
});

test('a scan uses the signed-in account’s own watchlist', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const call = s.client();
  await call.signIn(ADMIN);
  await call('/api/watchlist', { method: 'PUT', body: { watchlist: [{ symbol: 'SPY' }] } });

  const scan = await call('/api/scan', { method: 'POST', body: { limit: 5 } });
  assert.equal(scan.status, 200);
  assert.deepEqual(scan.body.symbols.map((x) => x.symbol), ['SPY']);
});

// --- single-user mode still works ---------------------------------------------------------------

test('with no database the app runs single-user behind one shared password', async (t) => {
  const config = { ...baseConfig, authUser: 'admin', authPassword: 'shared', dataFile: '/tmp/oa-test-state.json' };
  const built = createApp({ config, db: null });
  assert.equal(built.accounts, false);

  const server = built.app.listen(0);
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${base}/api/health`)).status, 200, 'health is open');
  assert.equal((await fetch(`${base}/api/settings`)).status, 401, 'everything else needs the password');

  const auth = 'Basic ' + Buffer.from('admin:shared').toString('base64');
  assert.equal((await fetch(`${base}/api/settings`, { headers: { authorization: auth } })).status, 200);

  const me = await (await fetch(`${base}/api/me`, { headers: { authorization: auth } })).json();
  assert.equal(me.accounts, false);
  assert.equal(me.user.role, 'admin', 'the single user administers their own copy');

  // The account routes do not exist in this mode.
  assert.equal((await fetch(`${base}/api/users`, { headers: { authorization: auth } })).status, 404);
});

// --- ticker lookup -----------------------------------------------------------------------------

test('the appearance preference is kept on the account, and junk falls back', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const call = s.client();
  await call.signIn(ADMIN);

  assert.equal((await call('/api/settings')).body.theme, 'system', 'a new account defers to the machine');

  assert.equal((await call('/api/theme', { method: 'PUT', body: { theme: 'light' } })).body.theme, 'light');
  assert.equal((await call('/api/settings')).body.theme, 'light', 'and it survives a reload');

  // Nothing downstream guards, so an unknown value has to land somewhere paintable.
  await call('/api/theme', { method: 'PUT', body: { theme: 'neon' } });
  assert.equal((await call('/api/settings')).body.theme, 'system');

  assert.equal((await s.client()('/api/theme', { method: 'PUT', body: { theme: 'dark' } })).status, 401);
});

test('one account’s appearance is not another’s', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = s.client();
  await admin.signIn(ADMIN);
  await admin('/api/users', { method: 'POST', body: MEMBER });
  await admin('/api/theme', { method: 'PUT', body: { theme: 'light' } });

  const member = s.client();
  await member.signIn(MEMBER);
  assert.equal((await member('/api/settings')).body.theme, 'system');

  await member('/api/theme', { method: 'PUT', body: { theme: 'dark' } });
  assert.equal((await admin('/api/settings')).body.theme, 'light', "the admin's choice is untouched");
});

// --- the position tracker -----------------------------------------------------------------------

const POSITION = {
  symbol: 'SPY',
  type: 'VPCS',
  account: 'Fidelity IRA',
  contracts: 2,
  shortStrike: 535,
  longStrike: 530,
  expiration: '2026-11-06',
  tradeDate: '2026-10-01',
  premium: 138,
};

test('a position is stored, listed back, and carries today’s price and the short leg’s delta', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const call = s.client();
  await call.signIn(ADMIN);

  const made = await call('/api/positions', { method: 'POST', body: POSITION });
  assert.equal(made.status, 200);
  assert.ok(made.body.id);
  assert.equal(made.body.symbol, 'SPY');

  const { body } = await call('/api/positions');
  assert.equal(body.positions.length, 1);

  const [row] = body.positions;
  assert.equal(row.premium, 138);
  assert.equal(row.contracts, 2);

  // The live half — fetched per request, never stored, so it cannot go stale in the database.
  assert.ok(row.spot > 0, 'a price came back');
  assert.equal(typeof row.daysLeft, 'number');
  assert.ok(row.breach, 'and a verdict on the short strike');
  assert.ok(['clear', 'near', 'breached'].includes(row.breach.level));
});

test('the tracker survives a symbol the provider has never heard of', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const call = s.client();
  await call.signIn(ADMIN);

  await call('/api/positions', { method: 'POST', body: POSITION });
  await call('/api/positions', { method: 'POST', body: { ...POSITION, symbol: 'ZZZZ' } });

  // One dead ticker must leave one row showing dashes, not empty the whole table.
  const { status, body } = await call('/api/positions');
  assert.equal(status, 200);
  assert.equal(body.positions.length, 2);

  const dead = body.positions.find((p) => p.symbol === 'ZZZZ');
  assert.equal(dead.spot, null);
  assert.equal(dead.breach, null);
  assert.ok(body.positions.find((p) => p.symbol === 'SPY').spot > 0, 'the good row is unaffected');
});

test('a position that is not a position is refused', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const call = s.client();
  await call.signIn(ADMIN);

  for (const bad of [{}, { symbol: 'SPY' }, { ...POSITION, type: 'NONSENSE' }, { ...POSITION, expiration: 'soon' }]) {
    assert.equal((await call('/api/positions', { method: 'POST', body: bad })).status, 400, JSON.stringify(bad));
  }
});

test('settling a position banks its premium against the goals', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const call = s.client();
  await call.signIn(ADMIN);

  const { body: made } = await call('/api/positions', { method: 'POST', body: POSITION });

  const before = (await call('/api/positions')).body.totals;
  assert.equal(before.month.net, 0, 'an open credit is at risk, not banked');
  assert.equal(before.openPremium, 138);

  const today = new Date().toISOString().slice(0, 10);
  await call(`/api/positions/${made.id}`, {
    method: 'PATCH',
    body: { status: 'closed', closedAt: today, premium: 138 },
  });

  const after = (await call('/api/positions')).body.totals;
  assert.equal(after.today.net, 138);
  assert.equal(after.month.net, 138);
  assert.equal(after.openPremium, 0);
  assert.equal(after.today.goal, 450, 'the default daily target');
});

test('goals are saved per account and drive the progress figures', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const call = s.client();
  await call.signIn(ADMIN);

  const saved = await call('/api/goals', { method: 'PUT', body: { goals: { daily: 900, weekly: 4500, monthly: 18000 } } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.goals.daily, 900);

  assert.equal((await call('/api/positions')).body.goals.daily, 900, 'and it survives a reload');
  assert.equal((await call('/api/settings')).body.goals.weekly, 4500);
});

test('one account cannot see, change or delete another’s positions', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = s.client();
  await admin.signIn(ADMIN);
  await admin('/api/users', { method: 'POST', body: MEMBER });
  const { body: mine } = await admin('/api/positions', { method: 'POST', body: POSITION });

  const member = s.client();
  await member.signIn(MEMBER);

  assert.deepEqual((await member('/api/positions')).body.positions, [], 'a new account starts empty');

  // "No such position", not "not yours" — an id is not a way to find out which ids exist.
  for (const [method, body] of [['PATCH', { status: 'closed' }], ['DELETE', undefined]]) {
    const refused = await member(`/api/positions/${mine.id}`, { method, body });
    assert.equal(refused.status, 404, method);
    assert.equal(refused.body.error, 'No such position.');
  }

  assert.equal((await admin('/api/positions')).body.positions.length, 1, 'and it is untouched');
});

test('deleting a user takes their positions with them', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const admin = s.client();
  await admin.signIn(ADMIN);
  await admin('/api/users', { method: 'POST', body: MEMBER });

  const member = s.client();
  await member.signIn(MEMBER);
  await member('/api/positions', { method: 'POST', body: POSITION });

  const { body: users } = await admin('/api/users');
  const id = users.users.find((u) => u.email === MEMBER.email).id;
  await admin(`/api/users/${id}`, { method: 'DELETE' });

  // Nothing to assert against the member's own view — the account is gone. The cascade is what
  // stops their rows outliving them, and users.test.js holds the schema side of that.
  assert.equal((await admin('/api/positions')).body.positions.length, 0);
});

test('the tracker needs a session like everything else', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const anon = s.client();

  for (const [path, method] of [
    ['/api/positions', 'GET'],
    ['/api/positions', 'POST'],
    ['/api/positions/anything', 'PATCH'],
    ['/api/positions/anything', 'DELETE'],
    ['/api/goals', 'PUT'],
  ]) {
    assert.equal((await anon(path, { method, body: method === 'GET' ? undefined : {} })).status, 401, `${method} ${path}`);
  }
});

// --- the advisor ------------------------------------------------------------------------------

test('without a key the advisor is off, and says so rather than failing obscurely', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const call = s.client();
  await call.signIn(ADMIN);

  assert.equal((await call('/api/settings')).body.advisor, null, 'the page can tell it is off');

  const refused = await call('/api/explain', { method: 'POST', body: { question: 'anything' } });
  assert.equal(refused.status, 503);
  assert.match(refused.body.error, /ANTHROPIC_API_KEY/);
});

test('with a key, a question is answered from a scan the SERVER ran', async (t) => {
  const fetchImpl = stubAnthropic();
  const s = await startServer({ anthropicApiKey: 'sk-test', anthropicModel: 'stub-model', fetchImpl });
  t.after(s.close);
  const call = s.client();
  await call.signIn(ADMIN);

  assert.deepEqual((await call('/api/settings')).body.advisor, { model: 'stub-model', perHour: 20 });

  const { status, body } = await call('/api/explain', {
    method: 'POST',
    body: { question: 'Which of these has the best return on risk?' },
  });

  assert.equal(status, 200);
  assert.match(body.answer, /Candidate 1/);
  assert.ok(body.candidatesConsidered > 0);
  assert.deepEqual(body.ungrounded, []);

  // The decisive one: the digest was built from this server's own scan of this account's
  // watchlist. Nothing numeric came from the browser, so nothing numeric can be forged there.
  const [sent] = fetchImpl.calls;
  assert.match(sent.body.messages[0].content, /<scan>/);
  assert.match(sent.body.messages[0].content, /Watchlist: /);
  assert.match(sent.body.messages[0].content, /My question: Which of these has the best return on risk\?/);
});

test('the advisor answers about the signed-in account’s own watchlist, not somebody else’s', async (t) => {
  const fetchImpl = stubAnthropic();
  const s = await startServer({ anthropicApiKey: 'sk-test', anthropicModel: 'stub-model', fetchImpl });
  t.after(s.close);

  const admin = s.client();
  await admin.signIn(ADMIN);
  await admin('/api/users', { method: 'POST', body: MEMBER });
  await admin('/api/watchlist', { method: 'PUT', body: { watchlist: [{ symbol: 'GLD' }] } });

  const member = s.client();
  await member.signIn(MEMBER);
  await member('/api/watchlist', { method: 'PUT', body: { watchlist: [{ symbol: 'TLT' }] } });

  await admin('/api/explain', { method: 'POST', body: { question: 'q' } });
  await member('/api/explain', { method: 'POST', body: { question: 'q' } });

  const [forAdmin, forMember] = fetchImpl.calls.map((c) => c.body.messages[0].content);
  assert.match(forAdmin, /Watchlist: GLD/);
  assert.match(forMember, /Watchlist: TLT/);
  assert.doesNotMatch(forMember, /GLD/);
});

test('the hourly ceiling holds, because every question costs money', async (t) => {
  const fetchImpl = stubAnthropic();
  const s = await startServer({
    anthropicApiKey: 'sk-test',
    anthropicModel: 'stub-model',
    advisorPerHour: 2,
    fetchImpl,
  });
  t.after(s.close);
  const call = s.client();
  await call.signIn(ADMIN);

  for (let i = 0; i < 2; i++) {
    assert.equal((await call('/api/explain', { method: 'POST', body: { question: 'q' } })).status, 200, `#${i + 1}`);
  }

  const stopped = await call('/api/explain', { method: 'POST', body: { question: 'q' } });
  assert.equal(stopped.status, 429);
  assert.match(stopped.body.error, /limit/);
  assert.equal(fetchImpl.calls.length, 2, 'the refused one never reached the API, so it cost nothing');
});

test('an answer naming a ticker that is not in the scan comes back flagged', async (t) => {
  const fetchImpl = stubAnthropic('Forget these — buy NVDA calls.');
  const s = await startServer({ anthropicApiKey: 'sk-test', anthropicModel: 'stub-model', fetchImpl });
  t.after(s.close);
  const call = s.client();
  await call.signIn(ADMIN);
  await call('/api/watchlist', { method: 'PUT', body: { watchlist: [{ symbol: 'SPY' }] } });

  const { body } = await call('/api/explain', { method: 'POST', body: { question: 'q' } });
  assert.deepEqual(body.ungrounded, ['NVDA']);
  assert.match(body.answer, /NVDA/, 'still shown, so the person can judge it');
});

test('the advisor needs a session like everything else', async (t) => {
  const s = await startServer({ anthropicApiKey: 'sk-test', anthropicModel: 'stub-model', fetchImpl: stubAnthropic() });
  t.after(s.close);

  assert.equal((await s.client()('/api/explain', { method: 'POST', body: { question: 'q' } })).status, 401);
});

test('quote and history need a session, and reject a nonsense symbol', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const anon = s.client();
  assert.equal((await anon('/api/quote?symbol=SPY')).status, 401);
  assert.equal((await anon('/api/history?symbol=SPY')).status, 401);

  const call = s.client();
  await call.signIn(ADMIN);
  assert.equal((await call('/api/quote?symbol=not-a-symbol')).status, 400);
  assert.equal((await call('/api/history?symbol=')).status, 400);

  // A ticker the provider does not know is an answer, not a fault. The watchlist page checks a
  // symbol before adding it, so this is a normal path — a 500 here would fill the console with
  // red for a typo and hide the faults that matter.
  const missing = await call('/api/quote?symbol=ZZZZ');
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /ZZZZ/);
});

test('a quote carries what a ticker page needs to show', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const call = s.client();
  await call.signIn(ADMIN);

  const { status, body } = await call('/api/quote?symbol=spy');
  assert.equal(status, 200);
  assert.equal(body.symbol, 'SPY', 'normalised to upper case');
  assert.ok(body.quote.last > 0);
  assert.ok(body.asOf.match(/^\d{4}-\d{2}-\d{2}$/));

  // The stats panel reads these by name. A provider that stops filling one shows a column of
  // dashes rather than an error, which is the kind of quiet rot a test is for.
  for (const field of ['open', 'high', 'low', 'prevClose', 'volume', 'averageVolume', 'week52High', 'week52Low']) {
    assert.ok(Number.isFinite(body.quote[field]), `${field} is a number`);
  }

  assert.ok(body.quote.week52Low <= body.quote.last && body.quote.last <= body.quote.week52High);
  assert.ok(body.quote.low <= body.quote.high);
});

test('history returns bars for the range asked for, and defaults when it is not', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const call = s.client();
  await call.signIn(ADMIN);

  const month = (await call('/api/history?symbol=SPY&range=1M')).body;
  assert.equal(month.range, '1M');
  assert.equal(month.interval, 'daily');
  assert.ok(month.bars.length > 10 && month.bars.length < 31, `${month.bars.length} bars`);
  assert.ok(month.bars.every((b) => b.close > 0 && b.date >= month.start && b.date <= month.end));

  const year = (await call('/api/history?symbol=SPY&range=1Y')).body;
  assert.ok(year.bars.length > month.bars.length * 5, 'a year holds far more bars than a month');

  const fiveYear = (await call('/api/history?symbol=SPY&range=5Y')).body;
  assert.equal(fiveYear.interval, 'weekly', 'five years is weekly, or the payload is absurd');

  // An unknown range falls back rather than erroring, so a stale bookmark still works.
  assert.equal((await call('/api/history?symbol=SPY&range=nonsense')).body.range, DEFAULT_RANGE);
});

test('the last bar agrees with the quote, so the chart and the header cannot disagree', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const call = s.client();
  await call.signIn(ADMIN);

  const { quote } = (await call('/api/quote?symbol=SPY')).body;
  const { bars } = (await call('/api/history?symbol=SPY&range=3M')).body;

  assert.equal(bars.at(-1).close, quote.last);

  // And the whole of today's bar, not just its close — the header prints the day's open, range
  // and volume right above the chart's last point, so a difference would be visible on screen.
  const today = bars.at(-1);
  assert.equal(today.open, quote.open);
  assert.equal(today.high, quote.high);
  assert.equal(today.low, quote.low);
  assert.equal(today.volume, quote.volume);

  // Asking for a different range must not redraw today. It did not, first time round, because
  // the generator walked forwards from the start of the window.
  const year = (await call('/api/history?symbol=SPY&range=1Y')).body;
  assert.deepEqual(year.bars.at(-1), today);
});
