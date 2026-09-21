import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bsGreeks,
  bsPrice,
  expectedMove,
  inverseNormalCdf,
  normalPdf,
  strikeForDelta,
} from '../src/domain/pricing.js';
import { normalCdf } from '../src/domain/math.js';

const close = (actual, expected, tol, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label}: expected ${expected} ± ${tol}, got ${actual}`,
  );

// The textbook case: S=100, K=100, one year, r=5%, vol=20%. Hull quotes these to four places.
test('matches the textbook Black-Scholes values', () => {
  close(bsPrice('call', 100, 100, 1, 0.2, 0.05), 10.4506, 1e-3, 'call');
  close(bsPrice('put', 100, 100, 1, 0.2, 0.05), 5.5735, 1e-3, 'put');

  const c = bsGreeks('call', 100, 100, 1, 0.2, 0.05);
  const p = bsGreeks('put', 100, 100, 1, 0.2, 0.05);

  close(c.delta, 0.6368, 1e-3, 'call delta');
  close(p.delta, -0.3632, 1e-3, 'put delta');
  close(c.gamma, 0.018762, 1e-5, 'gamma');
  close(c.vega, 0.37524, 1e-4, 'vega per vol point');
  close(c.theta, -6.414 / 365, 1e-4, 'call theta per day');
  close(p.theta, -1.658 / 365, 1e-4, 'put theta per day');
});

test('put-call parity holds across strikes and maturities', () => {
  for (const K of [80, 95, 100, 110, 130]) {
    for (const T of [7 / 365, 30 / 365, 0.5, 2]) {
      const c = bsPrice('call', 100, K, T, 0.3, 0.04);
      const p = bsPrice('put', 100, K, T, 0.3, 0.04);
      close(c - p, 100 - K * Math.exp(-0.04 * T), 1e-6, `parity K=${K} T=${T}`);
    }
  }
});

test('greeks agree with finite differences of the price', () => {
  const cases = [
    ['put', 552, 530, 35 / 365, 0.16],
    ['put', 174, 160, 21 / 365, 0.48],
    ['call', 88, 92, 60 / 365, 0.14],
  ];

  for (const [type, S, K, T, v] of cases) {
    const g = bsGreeks(type, S, K, T, v);
    const h = 0.01;

    const dPrice = (bsPrice(type, S + h, K, T, v) - bsPrice(type, S - h, K, T, v)) / (2 * h);
    const dDelta =
      (bsGreeks(type, S + h, K, T, v).delta - bsGreeks(type, S - h, K, T, v).delta) / (2 * h);
    const dVol = (bsPrice(type, S, K, T, v + 0.0005) - bsPrice(type, S, K, T, v - 0.0005)) / 0.001 / 100;
    const day = 1 / 365;
    const dTime = bsPrice(type, S, K, T - day, v) - bsPrice(type, S, K, T, v);

    const label = `${type} S=${S} K=${K}`;
    close(g.delta, dPrice, 1e-4, `${label} delta`);
    close(g.gamma, dDelta, 1e-4, `${label} gamma`);
    close(g.vega, dVol, 1e-4, `${label} vega`);
    close(g.theta, dTime, Math.abs(dTime) * 0.05 + 1e-4, `${label} theta`);
  }
});

test('at expiry an option is worth exactly its intrinsic value', () => {
  assert.equal(bsPrice('put', 90, 100, 0, 0.3), 10);
  assert.equal(bsPrice('put', 110, 100, 0, 0.3), 0);
  assert.equal(bsPrice('call', 110, 100, 0, 0.3), 10);
  assert.equal(bsGreeks('put', 90, 100, 0, 0.3).delta, -1);
  assert.equal(bsGreeks('put', 110, 100, 0, 0.3).delta, 0);
});

test('the inverse normal CDF matches published quantiles, including in the tails', () => {
  // Checked against reference quantiles directly rather than by round-tripping through
  // normalCdf: that CDF's absolute error (7.5e-8) is magnified ~1000× by the inverse's slope in
  // the far tail, so a round trip at x=-3.5 tests the CDF, not this function.
  const quantiles = [
    [0.001, -3.090232306],
    [0.025, -1.959963985],
    [0.2, -0.841621234],
    [0.5, 0],
    [0.8, 0.841621234],
    [0.95, 1.644853627],
    [0.99, 2.326347874],
    [0.9999, 3.719016485],
  ];
  for (const [p, z] of quantiles) close(inverseNormalCdf(p), z, 1e-8, `p=${p}`);

  // And it inverts the CDF over the range deltas actually live in, to within the CDF's own error
  // bound pushed through the slope of the inverse: 7.5e-8 / φ(x).
  for (const x of [-2, -0.7, 0, 0.3, 1.64]) {
    const tol = 7.5e-8 / normalPdf(x) + 1e-9;
    close(inverseNormalCdf(normalCdf(x)), x, tol, `x=${x}`);
  }

  assert.ok(Number.isNaN(inverseNormalCdf(0)));
  assert.ok(Number.isNaN(inverseNormalCdf(1)));
});

test('strikeForDelta finds the strike that has the delta asked for', () => {
  for (const [type, target] of [['put', 0.1], ['put', 0.2], ['put', 0.3], ['call', 0.25]]) {
    const K = strikeForDelta(type, target, 552, 35 / 365, 0.16);
    const delta = bsGreeks(type, 552, K, 35 / 365, 0.16).delta;
    close(Math.abs(delta), target, 1e-6, `${type} ${target}`);
  }

  // A lower-delta put is further out of the money.
  assert.ok(strikeForDelta('put', 0.1, 552, 0.1, 0.16) < strikeForDelta('put', 0.3, 552, 0.1, 0.16));
});

test('expected move is spot × vol × √t', () => {
  close(expectedMove(100, 0.2, 1), 20, 1e-9, 'one year');
  close(expectedMove(400, 0.25, 36.5 / 365), 400 * 0.25 * Math.sqrt(0.1), 1e-9, 'a tenth of a year');
  assert.equal(expectedMove(100, 0, 1), null);
});
