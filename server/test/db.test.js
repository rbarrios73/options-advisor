import test from 'node:test';
import assert from 'node:assert/strict';

import { createDb } from '../src/db.js';

// The TLS decision is the one piece of configuration that cannot fail locally and absolutely will
// fail in production if it is wrong: a managed Postgres (Neon, Supabase, Render) refuses a plain
// connection, and a local one has no certificate to verify. So it is pinned here rather than
// discovered on a deploy.

const sslFor = (databaseUrl, pgSsl = '') => {
  const pool = createDb({ databaseUrl, pgSsl });
  const { ssl } = pool.options;
  pool.end();
  return ssl;
};

test('a hosted database gets TLS, with the certificate actually verified', () => {
  for (const url of [
    'postgres://u:p@ep-cool-name-123.us-east-2.aws.neon.tech/neondb?sslmode=require',
    'postgresql://postgres:p@db.abcdefgh.supabase.co:5432/postgres',
    'postgres://u:p@dpg-abc123-a.oregon-postgres.render.com/optionadvisor',
  ]) {
    assert.deepEqual(sslFor(url), { rejectUnauthorized: true }, url);
  }
});

test('a local database gets no TLS, because there is no certificate to verify', () => {
  for (const url of [
    'postgres://oa:pass@localhost:5432/optionadvisor',
    'postgres://oa:pass@127.0.0.1:5432/optionadvisor',
    'postgres://oa:pass@[::1]:5432/optionadvisor',
    'postgres://oa:pass@localhost/optionadvisor',
  ]) {
    assert.equal(sslFor(url), false, url);
  }
});

test('PGSSL overrides the guess in both directions', () => {
  assert.equal(sslFor('postgres://u:p@localhost/db', 'require').rejectUnauthorized, true, 'forced on');
  assert.equal(sslFor('postgres://u:p@ep-x.neon.tech/db', 'disable'), false, 'forced off');
});

test('no DATABASE_URL means no pool at all — the app runs single-user', () => {
  assert.equal(createDb({ databaseUrl: '' }), null);
  assert.equal(createDb({ databaseUrl: undefined }), null);
});

test('the pool is small, because free database plans cap connections hard', () => {
  const pool = createDb({ databaseUrl: 'postgres://u:p@ep-x.neon.tech/db' });
  assert.ok(pool.options.max <= 5, `max is ${pool.options.max}`);
  assert.ok(pool.options.connectionTimeoutMillis > 0, 'a hung connect must not hang the request');
  pool.end();
});
