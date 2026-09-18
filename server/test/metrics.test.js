import test from 'node:test';
import assert from 'node:assert/strict';

import { creditSpreadMetrics, ironCondorMetrics, longOptionMetrics } from '../src/domain/metrics.js';

const leg = (over) => ({
  symbol: 'TEST',
  type: 'put',
  strike: 100,
  expiration: '2026-10-16',
  bid: 1.0,
  ask: 1.1,
  delta: -0.3,
  iv: 0.3,
  openInterest: 2000,
  volume: 500,
  ...over,
});

const ctx = { spot: 110, iv: 0.3, years: 30 / 365 };

test('put credit spread: credit, max loss and break-even are the textbook arithmetic', () => {
  const m = creditSpreadMetrics({
    shortLeg: leg({ strike: 105, bid: 2.0, ask: 2.2 }),
    longLeg: leg({ strike: 100, bid: 0.9, ask: 1.0 }),
    type: 'put',
    ...ctx,
  });

  // Sell the bid (2.00), buy the ask (1.00): a credit of 1.00 on a 5-wide spread.
  assert.equal(m.credit, 1);
  assert.equal(m.width, 5);
  assert.equal(m.maxProfit, 100); // one contract
  assert.equal(m.maxLoss, 400); // (5 - 1) x 100
  assert.equal(m.breakEven, 104); // short strike less the credit
  assert.equal(m.returnOnRisk, 0.25);
  assert.equal(m.kind, 'put_credit_spread');
  assert.equal(m.direction, 'bullish');
});

test('the quoted credit is the conservative one, with the gap to mid shown', () => {
  const m = creditSpreadMetrics({
    shortLeg: leg({ strike: 105, bid: 2.0, ask: 2.4 }),
    longLeg: leg({ strike: 100, bid: 0.8, ask: 1.0 }),
    type: 'put',
    ...ctx,
  });

  assert.equal(m.credit, 1.0); // 2.00 - 1.00, crossing both spreads
  assert.equal(m.creditMid, 1.3); // 2.20 - 0.90, if both legs filled at mid
  assert.equal(m.slippageToMid, 0.3); // what chasing mid would be worth
  assert.ok(m.credit < m.creditMid, 'the conservative fill must never flatter the mid');
});

test('call credit spread breaks even above the short strike', () => {
  const m = creditSpreadMetrics({
    shortLeg: leg({ type: 'call', strike: 115, bid: 1.5, ask: 1.7, delta: 0.28 }),
    longLeg: leg({ type: 'call', strike: 120, bid: 0.4, ask: 0.5 }),
    type: 'call',
    ...ctx,
  });

  assert.equal(m.credit, 1);
  assert.equal(m.breakEven, 116);
  assert.equal(m.direction, 'bearish');
});

test('probability of profit is measured at the break-even, not the short strike', () => {
  const m = creditSpreadMetrics({
    shortLeg: leg({ strike: 105, bid: 2.0, ask: 2.2 }),
    longLeg: leg({ strike: 100, bid: 0.9, ask: 1.0 }),
    type: 'put',
    ...ctx,
  });

  // Break-even (104) is further away than the short strike (105), so finishing above it is
  // likelier — the honest number is the smaller of the two.
  assert.ok(m.probProfit > m.probShortExpiresOtm, 'break-even sits below the short strike');
  assert.ok(m.probProfit > 0.5 && m.probProfit < 1);
});

test('a spread that is not a credit at crossable prices is rejected', () => {
  const m = creditSpreadMetrics({
    shortLeg: leg({ strike: 105, bid: 1.0, ask: 1.2 }),
    longLeg: leg({ strike: 100, bid: 1.1, ask: 1.3 }), // protection costs more than the credit
    type: 'put',
    ...ctx,
  });
  assert.equal(m, null);
});

test('a credit wider than the spread is rejected as a quote artefact', () => {
  const m = creditSpreadMetrics({
    shortLeg: leg({ strike: 105, bid: 6.0, ask: 6.2 }),
    longLeg: leg({ strike: 100, bid: 0.1, ask: 0.2 }), // 5.80 credit on a 5-wide spread
    type: 'put',
    ...ctx,
  });
  assert.equal(m, null, 'free money is a bad quote, not an opportunity');
});

test('expected value is credit-weighted against max loss', () => {
  const m = creditSpreadMetrics({
    shortLeg: leg({ strike: 105, bid: 2.0, ask: 2.2 }),
    longLeg: leg({ strike: 100, bid: 0.9, ask: 1.0 }),
    type: 'put',
    ...ctx,
  });

  const expected = Math.round((m.probProfit * 1 - (1 - m.probProfit) * 4) * 100 * 100) / 100;
  assert.equal(m.expectedValue, expected);
});

test('iron condor: credits add, max loss is the wider side less the total credit', () => {
  const put = creditSpreadMetrics({
    shortLeg: leg({ strike: 105, bid: 1.2, ask: 1.4 }),
    longLeg: leg({ strike: 100, bid: 0.4, ask: 0.5 }),
    type: 'put',
    ...ctx,
  });
  const call = creditSpreadMetrics({
    shortLeg: leg({ type: 'call', strike: 118, bid: 1.1, ask: 1.3, delta: 0.25 }),
    longLeg: leg({ type: 'call', strike: 123, bid: 0.3, ask: 0.4 }),
    type: 'call',
    ...ctx,
  });

  const condor = ironCondorMetrics({ putSpread: put, callSpread: call });

  assert.equal(condor.credit, 1.4); // 0.70 + 0.70
  assert.equal(condor.width, 5);
  assert.equal(condor.maxLoss, 360); // (5 - 1.40) x 100
  // Only one side can finish in the money, so the full 1.40 credit cushions whichever side is
  // breached: 105 - 1.40 below, 118 + 1.40 above — not each side's own credit.
  assert.deepEqual(condor.profitRange, [103.6, 119.4]);
  assert.equal(condor.legs.length, 4);
  assert.equal(condor.direction, 'neutral');

  // Both tails must be given up, so a condor cannot be likelier to win than either side alone.
  assert.ok(condor.probProfit < put.probProfit);
  assert.ok(condor.probProfit < call.probProfit);
});

test('long call: risk is the debit, break-even is strike plus debit', () => {
  const m = longOptionMetrics({
    leg: leg({ type: 'call', strike: 110, bid: 3.4, ask: 3.6, delta: 0.5 }),
    type: 'call',
    ...ctx,
  });

  assert.equal(m.maxLoss, 360); // pay the ask
  assert.equal(m.breakEven, 113.6);
  assert.equal(m.maxProfit, null, 'a long call has no cap to report');
  assert.equal(m.returnOnRisk, null);
  assert.equal(m.expectedValue, null, 'two outcomes cannot describe an unbounded payoff');
  assert.ok(m.probProfit > 0 && m.probProfit < 0.5);
});

test('long put caps its profit at the strike going to zero', () => {
  const m = longOptionMetrics({
    leg: leg({ type: 'put', strike: 100, bid: 2.0, ask: 2.2, delta: -0.3 }),
    type: 'put',
    ...ctx,
  });

  assert.equal(m.maxLoss, 220);
  assert.equal(m.breakEven, 97.8);
  assert.equal(m.maxProfit, 9780); // (100 - 2.20) x 100
});
