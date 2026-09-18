import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalCdf,
  probabilityAbove,
  probabilityBelow,
  spreadPct,
  liquidityScore,
  mid,
  daysBetween,
} from '../src/domain/math.js';

const close = (actual, expected, tolerance = 1e-3) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected} ± ${tolerance}, got ${actual}`,
  );

test('normalCdf matches known values', () => {
  close(normalCdf(0), 0.5, 1e-6);
  close(normalCdf(1), 0.841345, 1e-5);
  close(normalCdf(-1), 0.158655, 1e-5);
  close(normalCdf(1.96), 0.975, 1e-4);
  close(normalCdf(-1.96), 0.025, 1e-4);
  close(normalCdf(6), 1, 1e-6);
});

test('at-the-money probability is near half, and drifts with rate against vol', () => {
  // d2 = (r - σ²/2)·T / (σ√T). At 30% vol over 30 days the σ²/2 drag (4.5%) just outweighs a
  // 4% rate, leaving it a hair under a coin flip.
  close(probabilityAbove(100, 100, 0.3, 30 / 365), 0.4981, 0.001);

  // Drop the vol and the rate wins: the drift turns positive.
  assert.ok(probabilityAbove(100, 100, 0.1, 30 / 365) > 0.5);

  // Raise it and the drag takes over, monotonically — which is the property that matters, and
  // the reason a high-IV name needs a further strike for the same comfort.
  const byVol = [0.1, 0.2, 0.3, 0.5, 0.8, 1.2].map((iv) =>
    probabilityAbove(100, 100, iv, 30 / 365),
  );
  for (let i = 1; i < byVol.length; i++) {
    assert.ok(byVol[i] < byVol[i - 1], `p should fall as vol rises: ${byVol}`);
  }
});

test('probability falls as the strike moves away, and rises with time and vol', () => {
  const near = probabilityAbove(100, 105, 0.3, 30 / 365);
  const far = probabilityAbove(100, 120, 0.3, 30 / 365);
  assert.ok(far < near, 'a further strike must be less likely');

  const short = probabilityAbove(100, 120, 0.3, 7 / 365);
  const long = probabilityAbove(100, 120, 0.3, 90 / 365);
  assert.ok(long > short, 'more time must make a distant strike more reachable');

  const calm = probabilityAbove(100, 120, 0.15, 30 / 365);
  const wild = probabilityAbove(100, 120, 0.6, 30 / 365);
  assert.ok(wild > calm, 'more vol must make a distant strike more reachable');
});

test('above and below are complements', () => {
  const above = probabilityAbove(100, 95, 0.25, 45 / 365);
  const below = probabilityBelow(100, 95, 0.25, 45 / 365);
  close(above + below, 1, 1e-9);
});

test('probability refuses to guess without vol or time', () => {
  assert.equal(probabilityAbove(100, 95, 0, 30 / 365), null);
  assert.equal(probabilityAbove(100, 95, 0.3, 0), null);
  assert.equal(probabilityAbove(0, 95, 0.3, 30 / 365), null);
});

test('mid handles a one-sided book', () => {
  assert.equal(mid(1.0, 1.2), 1.1);
  assert.equal(mid(0, 1.2), 1.2);
  assert.equal(mid(1.0, 0), 1.0);
  assert.equal(mid(0, 0), null);
});

test('spreadPct is the cost of crossing, as a fraction of mid', () => {
  close(spreadPct(1.0, 1.2), 0.2 / 1.1);
  assert.equal(spreadPct(0, 0), null);
  assert.equal(spreadPct(1.5, 1.0), null, 'a crossed book is not a quote');
});

test('liquidity rewards tight quotes with real depth behind them', () => {
  const good = liquidityScore({ bid: 1.0, ask: 1.02, openInterest: 5000, volume: 1200 });
  const thin = liquidityScore({ bid: 0.4, ask: 0.9, openInterest: 3, volume: 0 });

  assert.ok(good > 0.85, `a tight, deep strike should score high, got ${good}`);
  assert.ok(thin < 0.25, `a wide, empty strike should score low, got ${thin}`);
  assert.ok(good > thin);
});

test('liquidity gives nothing away for missing data', () => {
  const unknown = liquidityScore({ bid: 1.0, ask: 1.02 });
  const known = liquidityScore({ bid: 1.0, ask: 1.02, openInterest: 5000, volume: 1200 });
  assert.ok(unknown < known, 'absent depth must not score the same as reported depth');
});

test('daysBetween counts calendar days to expiry', () => {
  assert.equal(daysBetween('2026-09-18', '2026-10-16'), 28);
  assert.equal(daysBetween('2026-09-18', '2026-09-18'), 0);
});
