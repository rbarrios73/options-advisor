import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_WATCHLIST,
  MAX_SYMBOLS,
  SYMBOL_PATTERN,
  cleanEntry,
  cleanWatchlist,
} from '../src/domain/watchlist.js';

test('a ticker is letters and dots, up to six', () => {
  for (const good of ['SPY', 'A', 'BRK.B', 'GOOGL']) assert.ok(SYMBOL_PATTERN.test(good), good);
  for (const bad of ['', 'TOOLONGX', 'spy', 'SP Y', 'SPY;', 'SPY-', '123']) {
    assert.equal(SYMBOL_PATTERN.test(bad), false, bad);
  }
});

test('an entry is tidied, and only a bad symbol is fatal', () => {
  assert.deepEqual(cleanEntry({ symbol: '  spy ', note: '  the index  ', earnings: '2026-10-29' }), {
    symbol: 'SPY',
    note: 'the index',
    earnings: '2026-10-29',
  });

  // No note and no date is a perfectly good entry: both are optional.
  assert.deepEqual(cleanEntry({ symbol: 'gld' }), { symbol: 'GLD', note: '', earnings: null });

  assert.equal(cleanEntry({ symbol: 'not a ticker' }), null);
  assert.equal(cleanEntry({}), null);
  assert.equal(cleanEntry(null), null);
});

test('half a date is dropped rather than stored', () => {
  // The column is a real DATE. Anything that is not a plain YYYY-MM-DD would arrive as a cast
  // error that fails the whole save — including the browser date input's empty string.
  for (const junk of ['', '2026', '29/10/2026', 'tomorrow', '2026-10-29T00:00:00Z']) {
    assert.equal(cleanEntry({ symbol: 'SPY', earnings: junk }).earnings, null, junk);
  }
  assert.equal(cleanEntry({ symbol: 'SPY', earnings: '2026-10-29' }).earnings, '2026-10-29');
});

test('a list drops what it cannot use, keeps the first of any duplicate, and holds its order', () => {
  const list = cleanWatchlist([
    { symbol: 'tlt', note: 'duration' },
    { symbol: 'junk!' },
    { symbol: 'TLT', note: 'said twice' },
    { symbol: 'GLD' },
  ]);

  assert.deepEqual(list.map((e) => e.symbol), ['TLT', 'GLD']);
  assert.equal(list[0].note, 'duration', 'the first mention wins, not the last');

  assert.deepEqual(cleanWatchlist(null), []);
  assert.deepEqual(cleanWatchlist('SPY'), [], 'a string is not a list');
});

test('the list is capped, because a scan costs provider requests per symbol', () => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const many = Array.from({ length: MAX_SYMBOLS + 20 }, (_, i) => ({
    symbol: `${letters[Math.floor(i / 26)]}${letters[i % 26]}`,
  }));
  assert.equal(new Set(many.map((e) => e.symbol)).size, many.length, 'all distinct, so the cap is what trims');
  assert.equal(cleanWatchlist(many).length, MAX_SYMBOLS);
});

test('the default list is itself valid, and is ten diversified names', () => {
  assert.deepEqual(cleanWatchlist(DEFAULT_WATCHLIST).length, DEFAULT_WATCHLIST.length);
  assert.equal(DEFAULT_WATCHLIST.length, 10);
  assert.equal(new Set(DEFAULT_WATCHLIST.map((e) => e.symbol)).size, 10, 'no duplicates');
  assert.ok(DEFAULT_WATCHLIST.every((e) => e.note), 'every name says why it is there');
});
