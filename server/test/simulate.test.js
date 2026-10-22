import test from 'node:test';
import assert from 'node:assert/strict';

import { createMockProvider } from '../src/providers/mock.js';
import { atmImpliedVol } from '../src/domain/strategies.js';
import { creditSpreadMetrics } from '../src/domain/metrics.js';
import { daysBetween } from '../src/domain/math.js';
import { longOptionMetrics } from '../src/domain/metrics.js';
import {
  TRACKER_TYPES,
  addDays,
  breakEvens,
  createLongOption,
  createSpread,
  decayCurve,
  decayProfile,
  decayShape,
  niceStep,
  pickCallSpread,
  pickLongOption,
  pickPutSpread,
  pnlAt,
  pnlAtExpiry,
  pnlCurve,
  pnlGrid,
  positionGreeks,
  summarize,
  trackerRowFrom,
} from '../src/domain/simulate.js';
import { POSITION_TYPES, cleanPosition } from '../src/domain/positions.js';

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

/** The same, on the call side: sell above the price, buy further above. */
async function callSpreadFor({ symbol = 'SPY', shortDelta = 0.2, width = 5, pricing = 'conservative', ...rest } = {}) {
  const quote = await provider.getQuote(symbol);
  const expirations = await provider.getExpirations(symbol);
  const expiration = expirations.find((e) => daysBetween(asOf, e) >= 30);
  const chain = await provider.getChain(symbol, expiration, quote.last);

  const dte = daysBetween(asOf, expiration);
  const atmIv = atmImpliedVol(chain.options, quote.last);
  const picked = pickCallSpread(chain, { by: 'delta', shortDelta, width }, { atmIv, years: dte / 365 });
  assert.ok(!picked.error, picked.error);

  return {
    chain,
    atmIv,
    dte,
    picked,
    spread: createSpread({ ...picked, type: 'call', spot: quote.last, expiration, asOf, atmIv, pricing, ...rest }),
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

// --- the call credit spread -------------------------------------------------------------------
//
// The mirror of the put spread in every respect, which is the point of these: each one asserts
// the thing that would be wrong if the side had been copied rather than mirrored.

test('a call spread sells above the price and buys further above', async () => {
  const { chain, picked, spread } = await callSpreadFor({ shortDelta: 0.2, width: 10 });

  assert.equal(spread.kind, 'call_credit_spread');
  assert.ok(picked.shortLeg.strike > chain.spot, 'the short call is out of the money, above spot');
  assert.ok(picked.longLeg.strike > picked.shortLeg.strike, 'protection is bought ABOVE the short call');
  assert.equal(picked.longLeg.strike - picked.shortLeg.strike, 10, 'width honoured');

  const calls = chain.options.filter((o) => o.type === 'call');
  const bestGap = Math.min(...calls.map((o) => Math.abs(Math.abs(o.delta) - 0.2)));
  close(Math.abs(Math.abs(picked.shortLeg.delta) - 0.2), bestGap, 1e-12, 'nearest listed delta');
});

test('by delta, never picks a short call with nothing above it — and says when it missed', async () => {
  const chain = {
    spot: 100,
    options: [
      { type: 'call', strike: 110, delta: 0.24, bid: 1.1, ask: 1.18 },
      { type: 'call', strike: 115, delta: 0.16, bid: 0.6, ask: 0.66 },
      { type: 'call', strike: 120, delta: 0.1, bid: 0.3, ask: 0.35 },
    ],
  };

  // 0.10 sits on the highest strike, which has nothing above it to buy as protection.
  const picked = pickCallSpread(chain, { by: 'delta', shortDelta: 0.1, width: 5 });
  assert.ok(!picked.error, picked.error);
  assert.equal(picked.shortLeg.strike, 115);
  assert.equal(picked.longLeg.strike, 120);
  assert.match(picked.note, /closest is 0\.16/);

  const top = Math.max(...chain.options.map((o) => o.strike));
  assert.match(pickCallSpread(chain, { by: 'strike', shortStrike: top, width: 5 }).error, /Nothing is listed above/);
});

test('the call spread break-even is ABOVE the short strike — the mirror of the put spread', async () => {
  const { spread } = await callSpreadFor();
  const s = summarize(spread);

  close(s.breakEven, spread.short.strike + s.credit, 1e-9, 'short strike plus the credit');
  assert.ok(s.breakEven > spread.short.strike, 'a credit moves it further out, which is upwards here');
  assert.ok(s.breakEven > spread.spot, 'and it starts above the current price');
});

test('at expiry: full credit below the short strike, full loss above the long', async () => {
  const { spread } = await callSpreadFor();
  const s = summarize(spread);

  close(pnlAtExpiry(spread, spread.short.strike - 50), s.maxProfit, 1e-9, 'far below');
  close(pnlAtExpiry(spread, spread.short.strike), s.maxProfit, 1e-9, 'at the short strike');
  close(pnlAtExpiry(spread, spread.long.strike + 50), -s.maxLoss, 1e-6, 'far above');
  close(pnlAtExpiry(spread, spread.long.strike), -s.maxLoss, 1e-6, 'at the long strike');
  close(pnlAtExpiry(spread, s.breakEven), 0, 1e-6, 'at break-even');
});

test('a call spread is bearish, collects theta and is short vega', async () => {
  const { spread } = await callSpreadFor();
  const g = positionGreeks(spread, spread.spot, 0, 0);

  // Bearish: the one sign that flips against the put spread. Everything short-premium does not.
  assert.ok(g.delta < 0, `delta should be negative, got ${g.delta}`);
  assert.ok(g.theta > 0, 'time decay is earned, as on any credit spread');
  assert.ok(g.vega < 0, 'and a jump in vol hurts');

  // Delta is the slope of the P&L, so a dollar up should cost about `delta` dollars.
  const up = pnlAt(spread, spread.spot + 1, 0, 0) - pnlAt(spread, spread.spot, 0, 0);
  close(up, g.delta, Math.abs(g.delta) * 0.05 + 0.5, 'delta matches the slope');

  assert.ok(pnlAt(spread, spread.spot, 5, +10) < pnlAt(spread, spread.spot, 5, 0), 'vol up hurts');
  const half = Math.floor(spread.dte / 2);
  assert.ok(pnlAt(spread, spread.spot, half) > pnlAt(spread, spread.spot, 0), 'time passing helps');
});

test('call spread headline numbers are identical to the screener’s for the same legs', async () => {
  const { spread, picked, atmIv, dte } = await callSpreadFor();
  const s = summarize(spread);

  const screener = creditSpreadMetrics({
    ...picked,
    type: 'call',
    spot: spread.spot,
    iv: atmIv,
    years: Math.max(dte, 0.5) / 365,
  });

  assert.ok(screener, 'the screener should accept this spread');
  assert.equal(screener.kind, 'call_credit_spread');
  for (const key of ['credit', 'maxProfit', 'maxLoss', 'breakEven', 'returnOnRisk', 'probProfit', 'expectedValue']) {
    assert.equal(s[key], screener[key], key);
  }
});

test('a short call below the price is flagged as starting in the money', async () => {
  const { chain } = await callSpreadFor();
  const strikes = chain.options.filter((o) => o.type === 'call').map((o) => o.strike).sort((a, b) => a - b);
  const deepItm = strikes.find((k) => k < chain.spot * 0.95);

  const picked = pickCallSpread(chain, { by: 'strike', shortStrike: deepItm, width: 5 });
  const spread = createSpread({ ...picked, type: 'call', spot: chain.spot, expiration: chain.expiration, asOf, atmIv: 0.2 });

  assert.match(summarize(spread).warnings.join(' '), /starts in the money/);
});

// --- time decay -----------------------------------------------------------------------------

/** A put credit spread with a month to run, from the same fixtures the rest of this file uses. */
const decaySpread = ({ dte = 30, iv = 0.25, quantity = 1 } = {}) =>
  createSpread({
    shortLeg: { type: 'put', strike: 95, bid: 2.0, ask: 2.1, iv },
    longLeg: { type: 'put', strike: 90, bid: 0.9, ask: 1.0, iv },
    spot: 100,
    expiration: addDays('2026-10-21', dte),
    asOf: '2026-10-21',
    atmIv: iv,
    quantity,
  });

const decayLongCall = ({ dte = 30, iv = 0.25 } = {}) =>
  createLongOption({
    leg: { type: 'call', strike: 100, bid: 2.8, ask: 2.9, iv },
    type: 'call',
    spot: 100,
    expiration: addDays('2026-10-21', dte),
    asOf: '2026-10-21',
    atmIv: iv,
  });

test('the decay curve runs from today to expiry and ends at the expiry payoff', () => {
  const position = decaySpread({ dte: 30 });
  const curve = decayCurve(position);

  assert.equal(curve[0].day, 0);
  assert.equal(curve[0].daysLeft, 30);
  assert.equal(curve.at(-1).day, 30, 'expiry is always sampled exactly — it is where the kink is');
  assert.equal(curve.at(-1).daysLeft, 0);

  // The last point is the real payoff, not a Black-Scholes value with a hair of time left.
  assert.ok(Math.abs(curve.at(-1).pnl - pnlAtExpiry(position, position.spot)) < 0.005);
  assert.equal(curve[0].pnl, pnlAt(position, position.spot, 0, 0));
});

test('a credit spread gains as time passes, and a long option bleeds', () => {
  // The sign of the whole exercise. Out of the money and nothing moving, the spread walks up to
  // its credit; the call walks down to nothing.
  const spread = decayProfile(decaySpread());
  const call = decayProfile(decayLongCall());

  assert.ok(spread.total > 0, `credit spread should gain, got ${spread.total}`);
  assert.ok(call.total < 0, `long call should bleed, got ${call.total}`);

  // And monotonically, with the price held still: no day is worse than the one before it.
  for (let i = 1; i < spread.curve.length; i++) {
    assert.ok(spread.curve[i].pnl >= spread.curve[i - 1].pnl - 0.01, `day ${spread.curve[i].day}`);
  }
});

test('the shape of the decay depends on moneyness, and the app measures it rather than assuming', () => {
  // THE FOLK WISDOM IS WRONG FOR THIS APP'S OWN HOUSE TRADE. "Theta accelerates into expiry" is
  // true at the money and false away from it, and a credit spread is deliberately placed away
  // from it. These two assertions are opposite on purpose.
  const otm = decayProfile(decaySpread({ dte: 30 })); // 95/90 with the stock at 100
  const atm = decayProfile(
    createSpread({
      shortLeg: { type: 'put', strike: 100, bid: 2.0, ask: 2.1, iv: 0.25 },
      longLeg: { type: 'put', strike: 95, bid: 0.9, ask: 1.0, iv: 0.25 },
      spot: 100,
      expiration: addDays('2026-10-21', 30),
      asOf: '2026-10-21',
      atmIv: 0.25,
    }),
  );

  // A straight line would put 7/30 — about 23% — in the final week.
  assert.ok(otm.lastWeekShare < 0.2, `out of the money should be front-loaded, got ${otm.lastWeekShare}`);
  assert.equal(otm.shape, 'early');

  assert.ok(atm.lastWeekShare > 0.5, `at the money should be back-loaded, got ${atm.lastWeekShare}`);
  assert.equal(atm.shape, 'late');

  // And the halfway marker agrees with each.
  assert.ok(otm.halfwayDay <= 15, `got T+${otm.halfwayDay}`);
  assert.ok(atm.halfwayDay > 20, `got T+${atm.halfwayDay}`);
});

test('the shape classifier is judged against a straight line, so it holds at any length', () => {
  // 7/dte is what a flat rate would put in the final week; the classifier compares against that
  // rather than a fixed percentage, or every long-dated position would read as front-loaded.
  assert.equal(decayShape(0.9, 30), 'late');
  assert.equal(decayShape(0.23, 30), 'even', 'exactly linear');
  assert.equal(decayShape(0.05, 30), 'early');

  // A 90-day position: a straight line gives the final week 7/90, under 8%. So 9% is steady and
  // 12% — which looks tiny next to the 30-day numbers — is already half again over the line.
  assert.equal(decayShape(0.09, 90), 'even');
  assert.equal(decayShape(0.12, 90), 'late');
  assert.equal(decayShape(0.04, 90), 'early');

  // Under a week there is no "final week" to compare, so it declines to classify.
  assert.equal(decayShape(1, 5), 'even');
  assert.equal(decayShape(null, 30), 'even');
});

test('the shares are of the signed total, so they read the same way for a long option', () => {
  // A long call's total is negative. Dividing one negative by another keeps the share positive,
  // which is what makes "38% of it in the last week" true of both sides.
  const { total, lastWeek, lastWeekShare } = decayProfile(decayLongCall({ dte: 30 }));

  assert.ok(total < 0);
  assert.ok(lastWeek < 0, 'the last week bleeds too');
  assert.ok(lastWeekShare > 0 && lastWeekShare <= 1.0001, `got ${lastWeekShare}`);
});

test('quantity scales the decay exactly, because it is the same position twice', () => {
  const one = decayProfile(decaySpread({ quantity: 1 }));
  const three = decayProfile(decaySpread({ quantity: 3 }));

  assert.ok(Math.abs(three.total - one.total * 3) < 0.02);
  assert.ok(Math.abs(three.lastWeek - one.lastWeek * 3) < 0.02);
  assert.equal(three.halfwayDay, one.halfwayDay, 'the shape is the same, only the scale differs');
});

test('a position expiring today has no decay left, and says so rather than dividing by zero', () => {
  const position = decaySpread({ dte: 0 });
  const profile = decayProfile(position);

  assert.equal(profile.curve.length, 1);
  assert.equal(profile.total, 0);
  assert.equal(profile.lastWeekShare, null, 'not NaN, not Infinity');
  assert.equal(profile.halfwayDay, null);
});

test('a long-dated position is thinned, not drawn at 365 points', () => {
  // A LEAP does not need a point per day to show its shape, and 365 SVG segments on a phone is
  // a cost with no reader.
  const curve = decayCurve(decaySpread({ dte: 365 }));

  assert.ok(curve.length <= 125, `expected it thinned, got ${curve.length} points`);
  assert.equal(curve.at(-1).day, 365, 'and expiry is still exact');

  // A short one is sampled every day.
  assert.equal(decayCurve(decaySpread({ dte: 30 })).length, 31);
});

test('theta on the curve is the theta at that day, not today’s repeated', () => {
  // Whichever way it goes, it must MOVE: quoting today's theta across the whole curve would be
  // the exact error this chart exists to correct. On an out-of-the-money spread it fades, which
  // is the direction most people would guess wrong.
  const curve = decayCurve(decaySpread({ dte: 30 }));

  const now = curve[0].theta;
  const late = curve.find((p) => p.day === 28).theta;

  assert.ok(now > 0 && late > 0, 'a credit spread collects theta throughout');
  assert.ok(late < now * 0.5, `out of the money, theta should fade: ${now} → ${late}`);

  // At the money it goes the other way, which is why the page reads the shape off the numbers.
  const atmCurve = decayCurve(
    createSpread({
      shortLeg: { type: 'put', strike: 100, bid: 2.0, ask: 2.1, iv: 0.25 },
      longLeg: { type: 'put', strike: 95, bid: 0.9, ask: 1.0, iv: 0.25 },
      spot: 100,
      expiration: addDays('2026-10-21', 30),
      asOf: '2026-10-21',
      atmIv: 0.25,
    }),
  );
  assert.ok(
    atmCurve.find((p) => p.day === 28).theta > atmCurve[0].theta,
    'at the money it accelerates',
  );
});

test('the decay curve agrees with the payoff chart where the two meet', () => {
  // Both are drawn from pnlAt, and a reader will compare them: the decay curve at T+N must be
  // the payoff curve's projected value at today's price on that same day.
  const position = decaySpread({ dte: 30 });
  const curve = decayCurve(position);

  for (const day of [0, 7, 21, 30]) {
    const fromDecay = curve.find((p) => p.day === day).pnl;
    const fromPayoff = pnlAt(position, position.spot, day, 0);
    assert.ok(Math.abs(fromDecay - fromPayoff) < 0.005, `day ${day}: ${fromDecay} vs ${fromPayoff}`);
  }
});

test('an IV shift moves the whole curve, and the chart says the price is what is held still', () => {
  // The caveat the page prints is only honest if the curve really does respond to vol.
  const position = decaySpread({ dte: 30 });
  const flat = decayProfile(position, { ivShift: 0 });
  const higher = decayProfile(position, { ivShift: 10 });

  assert.ok(higher.now < flat.now, 'a vol spike hurts a short-vega position today');
  assert.ok(Math.abs(higher.end - flat.end) < 0.01, 'but expiry is intrinsic, so vol cannot touch it');
});

// --- saving a simulation to the tracker -------------------------------------------------------

const savedSpread = () =>
  createSpread({
    shortLeg: { type: 'put', strike: 95, bid: 2.0, ask: 2.1, iv: 0.25 },
    longLeg: { type: 'put', strike: 90, bid: 0.9, ask: 1.0, iv: 0.25 },
    spot: 100,
    expiration: '2026-11-20',
    asOf: '2026-10-22',
    atmIv: 0.25,
    quantity: 2,
  });

const savedCall = () =>
  createLongOption({
    leg: { type: 'call', strike: 105, bid: 2.8, ask: 2.9, iv: 0.25 },
    type: 'call',
    spot: 100,
    expiration: '2026-11-20',
    asOf: '2026-10-22',
    atmIv: 0.25,
  });

test('a simulated spread becomes a tracker row the Positions page would have written', () => {
  const row = trackerRowFrom(savedSpread(), { symbol: 'spy', account: 'Fidelity IRA' });

  assert.equal(row.symbol, 'SPY', 'upper-cased, like everything else stored');
  assert.equal(row.type, 'VPCS');
  assert.equal(row.status, 'open');
  assert.equal(row.shortStrike, 95);
  assert.equal(row.longStrike, 90);
  assert.equal(row.expiration, '2026-11-20');
  assert.equal(row.contracts, 2);
  assert.equal(row.tradeDate, '2026-10-22', 'the simulation’s own date, not today');
  assert.equal(row.account, 'Fidelity IRA');

  // Whatever cleanPosition does to it, it must survive — this is the row that gets POSTed.
  assert.ok(cleanPosition(row), 'the tracker accepts it');
  assert.equal(cleanPosition(row).type, 'VPCS');
});

test('the premium is dollars for the whole position, not net per share', () => {
  // The error this guards against is a goal total that is 100× or 200× out. Two contracts of a
  // spread filled at 1.00 is $200, not 1.00 and not $100.
  const position = savedSpread(); // 2 contracts
  const row = trackerRowFrom(position, { symbol: 'SPY', fill: 1.05 });

  assert.equal(row.premium, 210);
  assert.equal(trackerRowFrom(position, { symbol: 'SPY', fill: 1.05 }).contracts, 2);

  // And without a fill it uses the simulation's own net, scaled the same way.
  const modelled = trackerRowFrom(position, { symbol: 'SPY' });
  assert.ok(Math.abs(modelled.premium - position.entry.net * 100 * 2) < 0.01);
});

test('a long option is stored as a debit, and a credit as a credit', () => {
  // Signed on purpose: what you paid should come off the month's total, because it did.
  const debit = trackerRowFrom(savedCall(), { symbol: 'SPY' });
  const credit = trackerRowFrom(savedSpread(), { symbol: 'SPY' });

  assert.ok(debit.premium < 0, `a bought call costs money, got ${debit.premium}`);
  assert.ok(credit.premium > 0, `a credit spread collects it, got ${credit.premium}`);

  // A typed fill is a positive number on a ticket; its sign comes from the structure, not from
  // whether the person remembered to type a minus.
  assert.ok(trackerRowFrom(savedCall(), { symbol: 'SPY', fill: 2.9 }).premium < 0);
  assert.ok(trackerRowFrom(savedSpread(), { symbol: 'SPY', fill: 1.0 }).premium > 0);
});

test('a long option maps to its own type and carries its single strike', () => {
  const row = trackerRowFrom(savedCall(), { symbol: 'SPY' });

  assert.equal(row.type, 'LC');
  assert.equal(row.shortStrike, 105, 'the one strike it has');
  assert.equal(row.longStrike, null, 'and no second leg to invent');
  assert.ok(cleanPosition(row), 'and the tracker accepts it');
});

test('every strategy the simulator offers maps to a type the tracker has', () => {
  // The failure this prevents is a Save button that produces a 400 on one of the four strategies.
  for (const [kind, type] of Object.entries(TRACKER_TYPES)) {
    assert.ok(POSITION_TYPES[type], `${kind} → ${type} must exist in the tracker`);
  }
  assert.deepEqual(Object.keys(TRACKER_TYPES).sort(), [
    'call_credit_spread',
    'long_call',
    'long_put',
    'put_credit_spread',
  ]);
});

test('a row with no symbol is refused rather than stored half-formed', () => {
  assert.equal(trackerRowFrom(savedSpread(), {}), null);
  assert.equal(trackerRowFrom({ ...savedSpread(), kind: 'iron_condor' }, { symbol: 'SPY' }), null);
});
