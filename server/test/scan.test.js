import test from 'node:test';
import assert from 'node:assert/strict';

import { createMockProvider } from '../src/providers/mock.js';
import { createScanner, selectExpirations } from '../src/scan.js';
import { DEFAULT_FILTERS } from '../src/domain/strategies.js';
import { DEFAULT_WEIGHTS } from '../src/domain/score.js';
import { daysBetween } from '../src/domain/math.js';

const TODAY = new Date('2026-09-18T00:00:00Z');
const asOf = '2026-09-18';

const scannerFor = (overrides = {}) =>
  createScanner({ provider: createMockProvider({ today: TODAY }), cacheTtlMs: 60_000, ...overrides });

test('a scan returns scored, ranked candidates', async () => {
  const result = await scannerFor().scan({
    symbols: ['SPY', 'NVDA'],
    filters: DEFAULT_FILTERS,
    weights: DEFAULT_WEIGHTS,
    asOf,
    limit: 25,
  });

  assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
  assert.ok(result.totalCandidates > 0, 'the mock chain should yield candidates');
  assert.ok(result.candidates.length > 0 && result.candidates.length <= 25);

  for (let i = 1; i < result.candidates.length; i++) {
    assert.ok(
      result.candidates[i - 1].score >= result.candidates[i].score,
      'candidates must come back best-first',
    );
  }
});

test('every candidate carries the inputs its score was built from', async () => {
  const { candidates } = await scannerFor().scan({
    symbols: ['SPY'],
    filters: DEFAULT_FILTERS,
    weights: DEFAULT_WEIGHTS,
    asOf,
  });

  for (const c of candidates) {
    for (const field of ['symbol', 'expiration', 'dte', 'spot', 'ivUsed', 'kind', 'legs', 'score']) {
      assert.ok(c[field] != null, `${field} missing from ${c.id}`);
    }
    assert.ok(c.legs.length >= 1);
    assert.ok(c.scoreComponents.probProfit != null);
    assert.ok(c.strongest && c.weakest, 'the score must say what drove it');

    // Every leg keeps the quote it was priced from, so the arithmetic can be checked by hand.
    for (const leg of c.legs) {
      assert.ok(leg.strike > 0);
      assert.ok(['buy', 'sell'].includes(leg.action));
      assert.ok(leg.bid != null && leg.ask != null);
    }
  }
});

test('filters actually bind', async () => {
  const scanner = scannerFor();

  const loose = await scanner.scan({
    symbols: ['NVDA'],
    filters: { ...DEFAULT_FILTERS, minProbProfit: 0.5, minReturnOnRisk: 0.05 },
    weights: DEFAULT_WEIGHTS,
    asOf,
    limit: 500,
  });

  const strict = await scanner.scan({
    symbols: ['NVDA'],
    filters: { ...DEFAULT_FILTERS, minProbProfit: 0.85, minReturnOnRisk: 0.05 },
    weights: DEFAULT_WEIGHTS,
    asOf,
    limit: 500,
  });

  assert.ok(strict.totalCandidates < loose.totalCandidates, 'a stricter filter must cut the list');
  for (const c of strict.candidates) {
    if (c.probProfit != null) assert.ok(c.probProfit >= 0.85);
  }
});

test('asking for one strategy returns only that strategy', async () => {
  const { candidates } = await scannerFor().scan({
    symbols: ['SPY'],
    filters: { ...DEFAULT_FILTERS, strategies: ['iron_condor'] },
    weights: DEFAULT_WEIGHTS,
    asOf,
    limit: 100,
  });

  assert.ok(candidates.length > 0, 'the mock chain should support condors');
  for (const c of candidates) {
    assert.equal(c.kind, 'iron_condor');
    assert.equal(c.legs.length, 4);
  }
});

test('every expiry scanned is inside the DTE window', async () => {
  const filters = { ...DEFAULT_FILTERS, minDte: 20, maxDte: 45 };
  const { candidates } = await scannerFor().scan({
    symbols: ['QQQ'],
    filters,
    weights: DEFAULT_WEIGHTS,
    asOf,
    limit: 200,
  });

  for (const c of candidates) {
    assert.ok(c.dte >= 20 && c.dte <= 45, `${c.id} has ${c.dte} dte`);
  }
});

test('a bad symbol is reported, not thrown', async () => {
  const result = await scannerFor().scan({
    symbols: ['SPY', 'NOTREAL'],
    filters: DEFAULT_FILTERS,
    weights: DEFAULT_WEIGHTS,
    asOf,
  });

  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].symbol, 'NOTREAL');
  assert.ok(result.candidates.length > 0, 'the good symbol still produces results');
});

test('credit structures never report a max loss smaller than the credit is worth', async () => {
  const { candidates } = await scannerFor().scan({
    symbols: ['SPY', 'AAPL', 'TSLA'],
    filters: DEFAULT_FILTERS,
    weights: DEFAULT_WEIGHTS,
    asOf,
    limit: 200,
  });

  for (const c of candidates.filter((x) => x.net === 'credit')) {
    assert.ok(c.maxLoss > 0, `${c.id} has no downside, which cannot be right`);
    assert.ok(c.maxProfit > 0);
    // width x 100 = maxProfit + maxLoss, for every vertical and condor.
    assert.ok(
      Math.abs(c.width * 100 - (c.maxProfit + c.maxLoss)) < 0.01,
      `${c.id}: width ${c.width} vs ${c.maxProfit} + ${c.maxLoss}`,
    );
  }
});

// --- expiry selection -------------------------------------------------------------------
//
// This is the knob that decides how many provider requests a scan costs, so it is worth pinning
// precisely. SPY-like symbols list an expiry nearly every weekday; without a cap, a ten-symbol
// watchlist is hundreds of chain calls and a guaranteed 429.

const dailyExpiries = (from, days) => {
  const out = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date(from);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

test('expiry selection caps the request count and prefers the target DTE', () => {
  const every = dailyExpiries(TODAY, 90); // 90 candidate expiries, as SPY roughly has
  const filters = { ...DEFAULT_FILTERS, minDte: 7, maxDte: 60, maxExpirations: 4, targetDte: 35 };

  const picked = selectExpirations(every, filters, asOf);

  assert.equal(picked.length, 4, 'must not exceed maxExpirations');

  const dtes = picked.map((e) => daysBetween(asOf, e));
  assert.deepEqual(dtes, [33, 34, 35, 36], 'should cluster on targetDte, not on the near expiries');
  assert.deepEqual([...picked].sort(), picked, 'returned in date order');
});

test('expiry selection never returns anything outside the DTE window', () => {
  const every = dailyExpiries(TODAY, 120);
  const filters = { ...DEFAULT_FILTERS, minDte: 20, maxDte: 30, maxExpirations: 50, targetDte: 25 };

  for (const e of selectExpirations(every, filters, asOf)) {
    const dte = daysBetween(asOf, e);
    assert.ok(dte >= 20 && dte <= 30, `${e} is ${dte} days out, outside 20-30`);
  }
});

test('an uncapped or small window is passed through untouched', () => {
  const few = dailyExpiries(TODAY, 40).filter((_, i) => i % 7 === 0);
  const window = { ...DEFAULT_FILTERS, minDte: 0, maxDte: 365 };

  assert.equal(selectExpirations(few, { ...window, maxExpirations: 0 }, asOf).length, few.length);
  assert.equal(selectExpirations(few, { ...window, maxExpirations: 99 }, asOf).length, few.length);
});
