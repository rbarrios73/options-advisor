import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BAND_COVERAGE,
  expectedRange,
  forecastCone,
  ivAt,
  levelOdds,
  pickForecastExpiries,
  realizedVol,
  volComparison,
} from '../src/domain/forecast.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);

// A series whose daily log return alternates +r / −r has a known standard deviation of r (sample
// stdev of n alternating values is r·√(n/(n−1))), which makes the annualising checkable.
const alternating = (n, r, start = 100) => {
  const bars = [{ close: start }];
  for (let i = 1; i <= n; i++) bars.push({ close: bars.at(-1).close * Math.exp(i % 2 ? r : -r) });
  return bars;
};

test('realised vol annualises the daily stdev of log returns by √252', () => {
  const vol = realizedVol(alternating(20, 0.01), 20);
  near(vol, 0.01 * Math.sqrt(20 / 19) * Math.sqrt(252), 1e-9);
});

test('realised vol says nothing rather than something from too little history', () => {
  assert.equal(realizedVol(alternating(10, 0.01), 20), null);
  assert.equal(realizedVol([], 20), null);
  assert.equal(realizedVol(null), null);
});

test('a flat price has no realised volatility', () => {
  assert.equal(realizedVol(Array.from({ length: 30 }, () => ({ close: 50 })), 20), 0);
});

test('expiries are the nearest to each target, without repeats, in date order', () => {
  const list = [2, 5, 9, 16, 23, 30, 37, 58, 65, 93, 150].map((dte) => ({ date: `d${dte}`, dte }));
  assert.deepEqual(
    pickForecastExpiries(list).map((e) => e.dte),
    [5, 30, 58, 93],
  );

  // A short list cannot pick the same expiry twice to fill four slots.
  const short = [{ date: 'a', dte: 30 }];
  assert.deepEqual(pickForecastExpiries(short).map((e) => e.dte), [30]);

  // Past expiries and ones beyond the horizon are never picked.
  assert.deepEqual(pickForecastExpiries([{ date: 'x', dte: 0 }, { date: 'y', dte: 400 }]), []);
});

test('implied vol between expiries interpolates total variance, flat beyond the ends', () => {
  const pts = [
    { dte: 30, iv: 0.2 },
    { dte: 90, iv: 0.3 },
  ];
  assert.equal(ivAt(pts, 10), 0.2);
  assert.equal(ivAt(pts, 200), 0.3);
  assert.equal(ivAt(pts, 30), 0.2);

  // At 60 days: variance 0.04·30 → 0.09·90 linearly, so 0.6 + (8.1−1.2)/2 = 4.65 → √(4.65/60).
  near(ivAt(pts, 60), Math.sqrt((1.2 + (8.1 - 1.2) / 2) / 60), 1e-12);
  assert.equal(ivAt([], 30), null);
});

test('a one-sigma range is symmetric in log terms, so it leans upward in dollars', () => {
  const r = expectedRange(100, 0.2, 365, 1);
  near(r.high, 100 * Math.exp(0.2), 0.01);
  near(r.low, 100 * Math.exp(-0.2), 0.01);
  assert.ok(r.high - 100 > 100 - r.low);
  assert.equal(expectedRange(100, 0, 30), null);
});

test('the cone starts at today’s price, widens with time, and lands on every expiry', () => {
  const pts = [
    { date: '2026-12-04', dte: 30, iv: 0.18 },
    { date: '2027-01-15', dte: 72, iv: 0.2 },
  ];
  const cone = forecastCone(500, pts, { step: 7 });

  assert.deepEqual(cone[0].one, { low: 500, high: 500 });
  assert.equal(cone.at(-1).days, 72);
  assert.deepEqual(cone.filter((c) => c.expiry).map((c) => c.expiry), ['2026-12-04', '2027-01-15']);

  for (let i = 1; i < cone.length; i++) {
    assert.ok(cone[i].one.high >= cone[i - 1].one.high, 'never narrows');
    assert.ok(cone[i].two.high > cone[i].one.high && cone[i].two.low < cone[i].one.low, '2σ outside 1σ');
  }
});

test('the bands hold about 68% and 95% of outcomes', () => {
  near(BAND_COVERAGE[1], 0.6827, 0.001);
  near(BAND_COVERAGE[2], 0.9545, 0.001);
});

test('level odds: above and below add to one, and touching is about twice finishing beyond', () => {
  const odds = levelOdds({ spot: 100, level: 110, iv: 0.25, days: 30, riskFree: 0 });
  near(odds.above + odds.below, 1, 1e-12);
  assert.equal(odds.side, 'above');
  near(odds.touch, 2 * odds.above, 1e-12);
  assert.ok(odds.above < 0.15 && odds.above > 0.05, `a 10% rise in a month at 25% vol is unlikely, got ${odds.above}`);
  near(odds.move, 0.1, 1e-12);
});

test('a level below the price is touched by falling to it', () => {
  const odds = levelOdds({ spot: 100, level: 95, iv: 0.25, days: 30, riskFree: 0 });
  assert.equal(odds.side, 'below');
  near(odds.touch, 2 * odds.below, 1e-12);
});

test('touch is capped at certainty, and today’s price is already touched', () => {
  assert.equal(levelOdds({ spot: 100, level: 100.01, iv: 0.9, days: 300 }).touch <= 1, true);
  assert.equal(levelOdds({ spot: 100, level: 100, iv: 0.2, days: 30 }).touch, 1);
  assert.equal(levelOdds({ spot: 100, level: 0, iv: 0.2, days: 30 }), null);
});

test('implied against realised: rich, fair and cheap, with the gap in vol points', () => {
  assert.equal(volComparison({ implied: 0.3, realized20: 0.2 }).verdict, 'rich');
  assert.equal(volComparison({ implied: 0.21, realized20: 0.2 }).verdict, 'fair');
  assert.equal(volComparison({ implied: 0.15, realized20: 0.2 }).verdict, 'cheap');
  assert.equal(volComparison({ implied: 0.3, realized20: 0.2 }).gapPts, 10);
  assert.equal(volComparison({ implied: 0.2, realized20: null }), null);
});
