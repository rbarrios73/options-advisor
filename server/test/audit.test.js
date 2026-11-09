import test from 'node:test';
import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';

import { migrate } from '../src/db.js';
import { createAuditLog, describeAgent } from '../src/audit.js';
import { createUserStore } from '../src/users.js';

async function fresh(options) {
  const db = await PGlite.create();
  await migrate(db);
  return { db, audit: createAuditLog(db, options), close: () => db.close() };
}

test('entries come back newest first, with a label and a readable browser', async (t) => {
  const { audit, close } = await fresh();
  t.after(close);

  await audit.record({ event: 'sign_in', userId: 'u1', email: 'a@x.com', ip: '1.2.3.4', userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/131.0 Safari/537.36' });
  await audit.record({ event: 'sign_out', userId: 'u1', email: 'a@x.com' });

  const { entries, more } = await audit.list();
  assert.deepEqual(entries.map((e) => e.event), ['sign_out', 'sign_in']);
  assert.equal(entries[1].label, 'Signed in');
  assert.equal(entries[1].agent, 'Chrome on Windows');
  assert.equal(entries[1].ip, '1.2.3.4');
  assert.equal(more, false);
});

test('paging by id stays put while new events arrive', async (t) => {
  const { audit, close } = await fresh();
  t.after(close);

  for (let i = 0; i < 5; i++) await audit.record({ event: 'sign_in', email: `u${i}@x.com` });
  const first = await audit.list({ limit: 2 });
  assert.equal(first.more, true);
  assert.deepEqual(first.entries.map((e) => e.email), ['u4@x.com', 'u3@x.com']);

  await audit.record({ event: 'sign_in', email: 'late@x.com' }); // arrives at the top
  const second = await audit.list({ limit: 2, before: first.next });
  assert.deepEqual(second.entries.map((e) => e.email), ['u2@x.com', 'u1@x.com']);
});

test('filters by event and by account', async (t) => {
  const { audit, close } = await fresh();
  t.after(close);

  await audit.record({ event: 'sign_in', userId: 'a', email: 'a@x.com' });
  await audit.record({ event: 'sign_in_failed', email: 'a@x.com' });
  await audit.record({ event: 'sign_in', userId: 'b', email: 'b@x.com' });

  assert.equal((await audit.list({ event: 'sign_in' })).entries.length, 2);
  assert.equal((await audit.list({ userId: 'b' })).entries[0].email, 'b@x.com');
  assert.equal((await audit.list({ event: 'not-an-event' })).entries.length, 3, 'an unknown filter is ignored, not an error');
});

test('failed sign-ins are grouped by the address typed', async (t) => {
  const { audit, close } = await fresh();
  t.after(close);

  for (let i = 0; i < 3; i++) await audit.record({ event: 'sign_in_failed', email: 'victim@x.com' });
  await audit.record({ event: 'sign_in_failed', email: 'typo@x.com' });

  assert.deepEqual(
    (await audit.recentFailures()).map((f) => [f.email, f.attempts]),
    [['victim@x.com', 3], ['typo@x.com', 1]],
  );
});

test('entries older than the retention window are pruned, newer ones kept', async (t) => {
  let clock = new Date('2026-01-01T12:00:00Z');
  const { audit, close } = await fresh({ retentionDays: 30, now: () => clock });
  t.after(close);

  await audit.record({ event: 'sign_in', email: 'old@x.com' });
  clock = new Date('2026-02-15T12:00:00Z');
  await audit.record({ event: 'sign_in', email: 'new@x.com' });

  assert.equal(await audit.prune(), 1);
  assert.deepEqual((await audit.list()).entries.map((e) => e.email), ['new@x.com']);
});

test('a failure to record never throws into the sign-in that caused it', async () => {
  const broken = { query: async () => { throw new Error('disk full'); } };
  const audit = createAuditLog(broken);
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    await audit.record({ event: 'sign_in', email: 'a@x.com' });
  } finally {
    console.error = original;
  }
  assert.match(logged[0], /could not record sign_in/);
});

test('an unknown event is a programming error, not a silent row', async () => {
  const { audit, close } = await fresh();
  await assert.rejects(() => audit.record({ event: 'teleported' }), /Unknown audit event/);
  await close();
});

test('sessions remember where they came from, and "signed in now" lists the recent ones', async (t) => {
  const db = await PGlite.create();
  await migrate(db);
  t.after(() => db.close());
  const users = createUserStore(db);

  const user = await users.create({ email: 'trader@x.com', password: 'a long enough password' });
  const { token } = await users.startSession(user.id, { ip: '9.9.9.9', userAgent: 'Mozilla/5.0 (iPhone) Safari/604.1' });

  const [online] = await users.activeSessions();
  assert.equal(online.email, 'trader@x.com');
  assert.equal(online.ip, '9.9.9.9');

  // A session idle for an hour is still valid, but not "now".
  await db.query(`UPDATE sessions SET last_seen_at = now() - interval '1 hour'`);
  assert.equal((await users.activeSessions({ minutes: 15 })).length, 0);

  // Using it brings it back.
  assert.ok(await users.userForToken(token));
  assert.equal((await users.activeSessions({ minutes: 15 })).length, 1);

  // Signing out says whose session it was, so the log can name them.
  assert.deepEqual(await users.endSession(token), { id: user.id, email: 'trader@x.com' });
  assert.equal(await users.endSession(token), null);
});

test('browser strings read as a person would say them', () => {
  assert.equal(describeAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15'), 'Safari on macOS');
  assert.equal(describeAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36 Edg/131.0'), 'Edge on Windows');
  assert.equal(describeAgent('Mozilla/5.0 (Linux; Android 14) Chrome/131.0 Mobile Safari/537.36'), 'Chrome on Android');
  assert.equal(describeAgent('curl/8.5.0'), 'Script');
  assert.equal(describeAgent(null), null);
});
