import test from 'node:test';
import assert from 'node:assert/strict';

import { createMockProvider } from '../src/providers/mock.js';
import { atmImpliedVol } from '../src/domain/strategies.js';
import { creditSpreadMetrics } from '../src/domain/metrics.js';
import { daysBetween } from '../src/domain/math.js';
import { longOptionMetrics } from '../src/domain/metrics.js';
import {
  breakEvens,
  createLongOption,
  createSpread,
  pickLongOption,
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
  const { spread: filled } = await spreadFor({ netOverride: 1.23 });

  assert.ok(midPriced.entry.net > conservative.entry.net);
  assert.equal(filled.entry.net, 1.23);
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

// ===============================================================================================
// Long calls and long puts
// ===============================================================================================

async function longFor({ symbol = 'SPY', type = 'call', delta = 0.4, ...rest } = {}) {
  const quote = await provider.getQuote(symbol);
  const expirations = await provider.getExpirations(symbol);
  const expiration = expirations.find((e) => daysBetween(asOf, e) >= 30);
  const chain = await provider.getChain(symbol, expiration, quote.last);

  const dte = daysBetween(asOf, expiration);
  const atmIv = atmImpliedVol(chain.options, quote.last);
  const picked = pickLongOption(chain, { type, by: 'delta', delta }, { atmIv, years: dte / 365 });
  assert.ok(!picked.error, picked.error);

  return {
    chain,
    atmIv,
    dte,
    leg: picked.legs[0],
    position: createLongOption({ leg: picked.legs[0], type, spot: quote.last, expiration, asOf, atmIv, ...rest }),
  };
}

test('picks the listed contract nearest the target delta, on either side of the chain', async () => {
  for (const type of ['call', 'put']) {
    const { chain, leg } = await longFor({ type, delta: 0.4 });
    const same = chain.options.filter((o) => o.type === type);
    const best = Math.min(...same.map((o) => Math.abs(Math.abs(o.delta) - 0.4)));

    assert.equal(leg.type, type);
    assert.equal(leg.action, 'buy');
    close(Math.abs(Math.abs(leg.delta) - 0.4), best, 1e-12, `${type} nearest delta`);
  }
});

test('a long option is a debit: you pay the ask, and mid would cost less', async () => {
  const { position: atAsk } = await longFor();
  const { position: atMid } = await longFor({ pricing: 'mid' });

  assert.ok(atAsk.entry.net < 0, 'a debit is a negative net');
  assert.equal(atAsk.entry.net, -atAsk.legs[0].ask, 'conservative means the ask');
  assert.ok(atMid.entry.net > atAsk.entry.net, 'mid is a smaller debit');

  const s = summarize(atAsk);
  assert.equal(s.credit, null, 'nothing here is a credit');
  assert.equal(s.debit, round2(atAsk.legs[0].ask));
  assert.equal(s.maxLoss, round2(atAsk.legs[0].ask * 100), 'the most you can lose is what you paid');
});

test('long call: break-even is strike plus debit, and the upside has no ceiling', async () => {
  const { position } = await longFor({ type: 'call' });
  const s = summarize(position);
  const { strike } = position.legs[0];
  const debit = s.debit;

  close(s.breakEven, strike + debit, 1e-9, 'break-even');
  assert.equal(s.maxProfit, null, 'unbounded, and reported as unknown rather than a big number');
  assert.equal(s.returnOnRisk, null, 'undefined without a profit target');
  assert.equal(s.expectedValue, null, 'two outcomes cannot describe an open-ended payoff');

  close(pnlAtExpiry(position, strike - 10), -s.maxLoss, 1e-9, 'worthless below the strike');
  close(pnlAtExpiry(position, strike), -s.maxLoss, 1e-9, 'at the strike');
  close(pnlAtExpiry(position, s.breakEven), 0, 1e-6, 'at break-even');
  close(pnlAtExpiry(position, s.breakEven + 10), 1000, 1e-6, '$10 beyond break-even is $1,000');
});

test('long put: break-even is strike minus debit, and max profit is the strike going to zero', async () => {
  const { position } = await longFor({ type: 'put' });
  const s = summarize(position);
  const { strike } = position.legs[0];

  close(s.breakEven, strike - s.debit, 1e-9, 'break-even');
  close(s.maxProfit, (strike - s.debit) * 100, 1e-6, 'the strike less what you paid');

  close(pnlAtExpiry(position, strike + 10), -s.maxLoss, 1e-9, 'worthless above the strike');
  close(pnlAtExpiry(position, s.breakEven), 0, 1e-6, 'at break-even');
  close(pnlAtExpiry(position, 0.01), s.maxProfit, 1, 'underlying to zero');
});

test('long options agree with the screener for the same contract', async () => {
  for (const type of ['call', 'put']) {
    const { position, leg, atmIv, dte } = await longFor({ type });
    const s = summarize(position);

    const screener = longOptionMetrics({ leg, type, spot: position.spot, iv: atmIv, years: Math.max(dte, 0.5) / 365 });
    assert.ok(screener, `${type}: the screener should accept this`);

    for (const key of ['maxProfit', 'maxLoss', 'breakEven', 'probProfit']) {
      assert.equal(s[key], screener[key], `${type} ${key}`);
    }
  }
});

test('long options are the mirror of short premium: time hurts, rising vol helps', async () => {
  for (const type of ['call', 'put']) {
    const { position } = await longFor({ type });
    const at = position.spot;

    const early = pnlAt(position, at, 0);
    const late = pnlAt(position, at, position.dte - 1);
    assert.ok(late < early, `${type}: time decay works against you (${early} → ${late})`);

    assert.ok(pnlAt(position, at, 5, +10) > pnlAt(position, at, 5, 0), `${type}: vol up helps`);
    assert.ok(pnlAt(position, at, 5, -5) < pnlAt(position, at, 5, 0), `${type}: vol down hurts`);
  }
});

test('long option greeks have the signs a buyer expects, and delta matches the P&L slope', async () => {
  const cases = [['call', 1], ['put', -1]];

  for (const [type, direction] of cases) {
    const { position } = await longFor({ type });
    const g = positionGreeks(position, position.spot, 3, 0);

    assert.ok(Math.sign(g.delta) === direction, `${type} delta points ${direction > 0 ? 'up' : 'down'}`);
    assert.ok(g.gamma > 0, `${type}: long gamma`);
    assert.ok(g.theta < 0, `${type}: paying theta`);
    assert.ok(g.vega > 0, `${type}: long vega`);

    const h = 0.05;
    const slope = (pnlAt(position, position.spot + h, 3) - pnlAt(position, position.spot - h, 3)) / (2 * h);
    close(g.delta, slope, 0.05, `${type} delta vs slope`);
  }
});

test('the chart and table cover a long option the same way they cover a spread', async () => {
  const { position } = await longFor({ type: 'call' });
  const s = summarize(position);
  const { strike } = position.legs[0];

  const curve = pnlCurve(position, { daysForward: 5 });
  const prices = curve.map((p) => p.price);
  assert.ok(prices.includes(strike), 'the kink at the strike is sampled exactly');
  assert.ok(prices[0] < strike && prices.at(-1) > position.spot, 'and the range spans it');
  for (let i = 1; i < curve.length; i++) assert.ok(curve[i].price > curve[i - 1].price);

  const grid = pnlGrid(position, { rows: 9, columns: 5 });
  assert.equal(grid.prices.filter((p) => Math.abs(p - strike) < 1e-6).length, 1, 'one row at the strike');
  assert.equal(grid.keyLevels.strike, round2(strike), 'labelled "strike", not "short"/"long"');
  for (let r = 0; r < grid.prices.length; r++) {
    assert.equal(grid.values[r].at(-1), Math.round(pnlAtExpiry(position, grid.prices[r])) || 0);
  }

  assert.deepEqual(breakEvens(position), [s.breakEven]);
});

test('a far out-of-the-money option is flagged as needing more than the expected move', async () => {
  const { position } = await longFor({ type: 'call', delta: 0.05 });
  const { warnings } = summarize(position);

  assert.ok(
    warnings.some((w) => /expected move/.test(w)),
    `expected a warning, got ${JSON.stringify(warnings)}`,
  );
});
