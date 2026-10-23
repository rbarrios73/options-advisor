import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createDb } from '../src/db.js';

// The TLS decision is the one piece of configuration that cannot fail locally and absolutely will
// fail in production if it is wrong: a managed Postgres (Neon, Supabase, Render) refuses a plain
// connection, and a local one has no certificate to verify. So it is pinned here rather than
// discovered on a deploy.

const sslFor = async (databaseUrl, pgSsl = '') => {
  const pool = await createDb({ databaseUrl, pgSsl });
  const { ssl } = pool.options;
  pool.end();
  return ssl;
};

test('a hosted database gets TLS, with the certificate actually verified', async () => {
  for (const url of [
    'postgres://u:p@ep-cool-name-123.us-east-2.aws.neon.tech/neondb?sslmode=require',
    'postgresql://postgres:p@db.abcdefgh.supabase.co:5432/postgres',
    'postgres://u:p@dpg-abc123-a.oregon-postgres.render.com/optionadvisor',
  ]) {
    assert.deepEqual(await sslFor(url), { rejectUnauthorized: true }, url);
  }
});

test('a local database gets no TLS, because there is no certificate to verify', async () => {
  for (const url of [
    'postgres://oa:pass@localhost:5432/optionadvisor',
    'postgres://oa:pass@127.0.0.1:5432/optionadvisor',
    'postgres://oa:pass@[::1]:5432/optionadvisor',
    'postgres://oa:pass@localhost/optionadvisor',
  ]) {
    assert.equal(await sslFor(url), false, url);
  }
});

test('PGSSL overrides the guess in both directions', async () => {
  assert.equal((await sslFor('postgres://u:p@localhost/db', 'require')).rejectUnauthorized, true, 'forced on');
  assert.equal(await sslFor('postgres://u:p@ep-x.neon.tech/db', 'disable'), false, 'forced off');
});

test('no DATABASE_URL means no pool at all — the app runs single-user', async () => {
  assert.equal(await createDb({ databaseUrl: '' }), null);
  assert.equal(await createDb({ databaseUrl: undefined }), null);
});

test('single-user mode never reaches for the Postgres driver', async () => {
  // The bug this pins: `import pg` at the TOP of db.js ran whether or not a database was
  // configured, so a machine without the driver installed could not start the app at all — in a
  // mode the README says needs no database.
  //
  // Asserted against the source rather than by mocking the module system, because the property
  // that broke is a property of the file: a static import is hoisted and executed on load, and no
  // amount of branching inside the function can undo that. If someone moves it back to the top,
  // this fails; a test that only called createDb('') could not tell the difference.
  const source = await readFile(new URL('../src/db.js', import.meta.url), 'utf8');

  assert.ok(!/^\s*import\s+[^;]*\bfrom\s+['"]pg['"]/m.test(source), 'pg must not be imported at the top of db.js');
  assert.match(source, /await import\('pg'\)/, 'it is loaded inside the branch that uses it');

  // And the branch that skips it really does skip it.
  assert.equal(await createDb({ databaseUrl: '' }), null);
});

test('the pool is small, because free database plans cap connections hard', async () => {
  const pool = await createDb({ databaseUrl: 'postgres://u:p@ep-x.neon.tech/db' });
  assert.ok(pool.options.max <= 5, `max is ${pool.options.max}`);
  assert.ok(pool.options.connectionTimeoutMillis > 0, 'a hung connect must not hang the request');
  pool.end();
});
