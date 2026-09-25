import test from 'node:test';
import assert from 'node:assert/strict';

// The front end's page table, imported straight from web/src — it is plain JavaScript with no
// dependencies for exactly this reason. It decides which tabs the nav offers, and the failure it
// guards against is not a crash but a tab that leads to a route the server never registered.
import { pagesFor } from '../../web/src/pages.js';

const names = (session) => pagesFor(session).map(([key]) => key);

test('single user: no Users or Account tab, because those routes do not exist without a database', () => {
  // With no DATABASE_URL the app calls its lone user an admin, so "admin sees Users" is not
  // enough on its own. This is the bug that shipped: the tab appeared and the first click
  // answered "No such endpoint."
  const single = { accounts: false, user: { id: 'local', email: null, role: 'admin' } };

  assert.deepEqual(names(single), ['screener', 'watchlist', 'ticker', 'simulator']);
});

test('accounts: admins get Users, members do not, everyone gets Account', () => {
  const admin = { accounts: true, user: { id: '1', role: 'admin' } };
  const member = { accounts: true, user: { id: '2', role: 'member' } };

  assert.deepEqual(names(admin), ['screener', 'watchlist', 'ticker', 'simulator', 'users', 'account']);
  assert.deepEqual(names(member), ['screener', 'watchlist', 'ticker', 'simulator', 'account']);
});

test('nobody signed in gets no privileged tabs', () => {
  assert.deepEqual(names({ accounts: true, user: null }), ['screener', 'watchlist', 'ticker', 'simulator']);
});
