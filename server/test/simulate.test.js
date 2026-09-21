import test from 'node:test';
import assert from 'node:assert/strict';

import { createMockProvider } from '../src/providers/mock.js';
import { atmImpliedVol } from '../src/domain/strategies.js';
import { creditSpreadMetrics } from '../src/domain/metrics.js';
import { daysBetween } from '../src/domain/math.js';
import {
  createSpread,
  niceStep,
  pickPutSpread,
  pnlAt,
  pnlAtExpiry,
  pnlCurve,
  pnlGrid,
  positionGreeks,
  summarize,
} from '../src/domain/simulate.js';

const asOf = '2026-09-21';
const provider = createMockProvider({ today: new Date(`${asOf}T00:00:00Z`) });

async function spreadFor({ symbol = 'SPY', shortDelta = 0.2, width = 5, pricing = 'conservative', ...rest } = {}) {
  const quote = await provider.getQuote(symbol);
  const expirations = await provider.getExpirations(symbol);
  const expiration = expirations.find((e) => daysBetween(asOf, e) >= 30);
  const chain = await provider.getChain(symbol, expiration, quote.last);

  const dte = daysBetween(asOf, expiration);
  const atmIv = atmImpliedVol(chain.options, quote.last);
  const picked = pickPutSpread(chain, { by: 'delta', shortDelta, width }, { atmIv, years: dte / 365 });
  assert.ok(!picked.error, picked.error);

  return {
    chain,
    atmIv,
    dte,
    picked,
    spread: createSpread({ ...picked, spot: quote.last, expiration, asOf, atmIv, pricing, ...rest }),
  };
}

const close = (actual, expected, tol, label) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: expected ${expected} ± ${tol}, got ${actual}`);

// --- choosing the legs ------------------------------------------------------------------------

test('picks the listed put nearest the target delta, and the long leg by width', async () => {
  const { chain, picked } = await spreadFor({ shortDelta: 0.2, width: 10 });

  const puts = chain.options.filter((o) => o.type === 'put');
  const bestGap = Math.min(...puts.map((o) => Math.abs(Math.abs(o.delta) - 0.2)));
  close(Math.abs(Math.abs(picked.shortLeg.delta) - 0.2), bestGap, 1e-12, 'nearest listed delta');

  assert.ok(picked.longLeg.strike < picked.shortLeg.strike, 'long put sits below the short put');
  assert.equal(picked.shortLeg.strike - picked.longLeg.strike, 10, 'width honoured when the strike is listed');
});

test('picks by strike when asked, and an explicit long strike beats the width', async () => {
  const { chain } = await spreadFor();
  const strikes = chain.options.filter((o) => o.type === 'put').map((o) => o.strike).sort((a, b) => a - b);
  const shortStrike = strikes[10];
  const longStrike = strikes[6];

  const picked = pickPutSpread(chain, { by: 'strike', shortStrike, width: 1, longStrike });
  assert.equal(picked.shortLeg.strike, shortStrike);
  assert.equal(picked.longLeg.strike, longStrike);
});

test('by delta, never picks a short strike with nothing below it — and says when it missed', async () => {
  // A thin chain where the target delta sits on the lowest listed strike. Found in the browser:
  // NVDA at 0.10 delta on the mock chain showed an error instead of a spread.
  const chain = {
    spot: 100,
    options: [
      { type: 'put', strike: 80, delta: -0.1, bid: 0.3, ask: 0.35 },
      { type: 'put', strike: 85, delta: -0.16, bid: 0.6, ask: 0.66 },
      { type: 'put', strike: 90, delta: -0.24, bid: 1.1, ask: 1.18 },
    ],
  };

  const picked = pickPutSpread(chain, { by: 'delta', shortDelta: 0.1, width: 5 });
  assert.ok(!picked.error, picked.error);
  assert.equal(picked.shortLeg.strike, 85);
  assert.equal(picked.longLeg.strike, 80);
  assert.match(picked.note, /closest is 0\.16/);

  const onTarget = pickPutSpread(chain, { by: 'delta', shortDelta: 0.24, width: 5 });
  assert.equal(onTarget.note, null, 'no note when the delta is hit');
});

test('reports, rather than throws, when there is nothing below the short strike', async () => {
  const { chain } = await spreadFor();
  const lowest = Math.min(...chain.options.filter((o) => o.type === 'put').map((o) => o.strike));
  const picked = pickPutSpread(chain, { by: 'strike', shortStrike: lowest, width: 5 });
  assert.match(picked.error, /Nothing is listed below/);
});

// --- agreement with the screener ------------------------------------------------------------

test('conservative headline numbers are identical to the screener’s for the same legs', async () => {
  const { spread, picked, atmIv, dte } = await spreadFor();
  const s = summarize(spread);

  const screener = creditSpreadMetrics({
    ...picked,
    type: 'put',
    spot: spread.spot,
    iv: atmIv,
    years: Math.max(dte, 0.5) / 365,
  });

  assert.ok(screener, 'the screener should accept this spread');
  for (const key of ['credit', 'maxProfit', 'maxLoss', 'breakEven', 'returnOnRisk', 'probProfit', 'expectedValue']) {
    assert.equal(s[key], screener[key], key);
  }
});

test('mid pricing takes the larger credit, and an override wins over both', async () => {
  const { spread: conservative } = await spreadFor();
  const { spread: midPriced } = await spreadFor({ pricing: 'mid' });
  const { spread: filled } = await spreadFor({ creditOverride: 1.23 });

  assert.ok(midPriced.entry.credit > conservative.entry.credit);
  assert.equal(filled.entry.credit, 1.23);
  assert.equal(filled.entry.source, 'override');
});

// --- the payoff -----------------------------------------------------------------------------

test('at expiry: full credit above the short strike, full loss below the long, zero at break-even', async () => {
  const { spread } = await spreadFor();
  const s = summarize(spread);

  close(pnlAtExpiry(spread, spread.short.strike + 50), s.maxProfit, 1e-9, 'far above');
  close(pnlAtExpiry(spread, spread.short.strike), s.maxProfit, 1e-9, 'at the short strike');
  close(pnlAtExpiry(spread, spread.long.strike - 50), -s.maxLoss, 1e-6, 'far below');
  close(pnlAtExpiry(spread, spread.long.strike), -s.maxLoss, 1e-6, 'at the long strike');
  close(pnlAtExpiry(spread, s.breakEven), 0, 1e-6, 'at break-even');
});

test('quantity scales every dollar figure linearly', async () => {
  const { spread: one } = await spreadFor();
  const { spread: five } = await spreadFor({ quantity: 5 });

  assert.equal(summarize(five).maxLoss, round2(summarize(one).maxLoss * 5));
  close(pnlAt(five, one.spot, 10, 3), pnlAt(one, one.spot, 10, 3) * 5, 1e-6, 'pnl');
});

test('projecting to the expiry date gives the expiry payoff exactly', async () => {
  const { spread } = await spreadFor();
  for (const price of [spread.long.strike - 10, spread.long.strike + 1, spread.short.strike + 3]) {
    assert.equal(pnlAt(spread, price, spread.dte, 0), pnlAtExpiry(spread, price));
  }
});

test('out of the money, time helps and rising vol hurts — the short-premium signature', async () => {
  const { spread } = await spreadFor();
  const price = spread.spot; // short strike is below spot at 0.20 delta

  const early = pnlAt(spread, price, 0);
  const middle = pnlAt(spread, price, Math.floor(spread.dte / 2));
  const late = pnlAt(spread, price, spread.dte - 1);
  assert.ok(early < middle && middle < late, `${early} < ${middle} < ${late}`);

  assert.ok(pnlAt(spread, price, 5, +10) < pnlAt(spread, price, 5, 0), 'vol up hurts');
  assert.ok(pnlAt(spread, price, 5, -5) > pnlAt(spread, price, 5, 0), 'vol down helps');
});

test('opening at the conservative price starts you down by roughly the slippage', async () => {
  const { spread } = await spreadFor();
  const s = summarize(spread);
  const today = pnlAt(spread, spread.spot, 0, 0);

  assert.ok(today < 0, 'crossing the bid/ask is an immediate loss on paper');
  // The theoretical value uses each leg's IV, not the quote mid, so they will not match exactly.
  close(today, -s.slippageToMid * 100, 15, 'about the gap to mid');
});

test('position greeks: bullish, collecting theta, short vega — and delta matches the P&L slope', async () => {
  const { spread } = await spreadFor();
  const g = positionGreeks(spread, spread.spot, 3, 0);

  assert.ok(g.delta > 0, 'a put credit spread is long delta');
  assert.ok(g.theta > 0, 'and earns time decay');
  assert.ok(g.vega < 0, 'and loses when vol rises');

  const h = 0.05;
  const slope = (pnlAt(spread, spread.spot + h, 3) - pnlAt(spread, spread.spot - h, 3)) / (2 * h);
  close(g.delta, slope, 0.05, 'delta vs slope');
});

// --- what gets drawn ------------------------------------------------------------------------

test('the curve is sorted, spans the strikes, and hits the kinks exactly', async () => {
  const { spread } = await spreadFor();
  const curve = pnlCurve(spread, { daysForward: 10, ivShift: 2 });

  for (let i = 1; i < curve.length; i++) assert.ok(curve[i].price > curve[i - 1].price);
  const prices = curve.map((p) => p.price);
  assert.ok(prices.includes(spread.short.strike) && prices.includes(spread.long.strike));
  assert.ok(prices[0] < spread.long.strike && prices.at(-1) > spread.spot);
});

test('the grid runs from today to expiry, and its last column is the expiry payoff', async () => {
  const { spread } = await spreadFor();
  const grid = pnlGrid(spread, { rows: 9, columns: 5 });

  // Nine round-number rows plus the key levels, each exactly once, highest price first.
  const s = summarize(spread);
  for (const level of [spread.spot, spread.short.strike, spread.long.strike, s.breakEven]) {
    assert.equal(grid.prices.filter((p) => Math.abs(p - level) < 1e-6).length, 1, `row for ${level}`);
  }
  assert.ok(grid.prices.length >= 9 && grid.prices.length <= 13);
  for (let i = 1; i < grid.prices.length; i++) assert.ok(grid.prices[i] < grid.prices[i - 1], 'descending, no duplicates');
  assert.equal(pnlGrid(spread, { rows: 9, keyLevels: false }).prices.length, 9);

  assert.equal(grid.columns[0].daysForward, 0);
  assert.equal(grid.columns.at(-1).daysLeft, 0);
  for (let r = 0; r < grid.prices.length; r++) {
    // `|| 0`: the grid never shows negative zero (a break-even row would print "-$0").
    assert.equal(grid.values[r].at(-1), Math.round(pnlAtExpiry(spread, grid.prices[r])) || 0);
  }
});

test('niceStep rounds to 1, 2, 2.5 or 5 of a power of ten', () => {
  assert.equal(niceStep(0.9), 1);
  assert.equal(niceStep(2.1), 2);
  assert.equal(niceStep(2.8), 2.5);
  assert.equal(niceStep(6), 5);
  assert.equal(niceStep(13), 10);
  assert.equal(niceStep(0.03), 0.025);
});

function round2(x) {
  return Math.round(x * 100) / 100;
}
