import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adjustmentScenarios,
  exposure,
  probabilityReliability,
  riskAlerts,
  rollExpiries,
  unrealizedPnl,
} from '../src/domain/manage.js';
import { createLongOption, createSpread, positionGreeks, summarize } from '../src/domain/simulate.js';

const near = (a, b, tol = 1e-6, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}, got ${a}`);

const opt = (type, strike, bid, ask, extra = {}) => ({ type, strike, bid, ask, iv: 0.22, delta: null, openInterest: 2000, volume: 300, ...extra });

const ASOF = '2026-11-09';
const base = { spot: 500, expiration: '2026-12-11', asOf: ASOF, atmIv: 0.2, quantity: 1 };

// A 480/475 put spread on a $500 stock: sold for 1.20 if a fill is given.
const spread = (over = {}, legs = {}) =>
  createSpread({
    shortLeg: opt('put', 480, 1.6, 1.7, legs.short),
    longLeg: opt('put', 475, 1.0, 1.1, legs.long),
    type: 'put',
    ...base,
    ...over,
  });

const chainFor = (expiration, options, spot = 500) => ({ symbol: 'XYZ', spot, expiration, asOf: ASOF, atmIv: 0.21, options });

test('probabilities are reliable on a normal book, and say why when they are not', () => {
  assert.deepEqual(probabilityReliability(spread()), { reliable: true, reasons: [] });

  const wide = probabilityReliability(spread({}, { short: { bid: 0.5, ask: 1.5 } }));
  assert.equal(wide.reliable, false);
  assert.match(wide.reasons.join(), /480 put's quote is 100% wide/);

  const noBid = probabilityReliability(spread({}, { short: { bid: 0 } }));
  assert.match(noBid.reasons.join(), /480 put has no bid/);

  assert.equal(probabilityReliability(spread({ atmIv: 0 })).reliable, false);
});

test('unrealized P&L needs a fill, and is measured at what closing costs now', () => {
  assert.equal(unrealizedPnl(spread()), null, 'a quote is not a fill');

  const held = spread({ netOverride: 1.2 });
  const u = unrealizedPnl(held);
  // Close: buy the 480 at 1.70, sell the 475 at 1.00 → 0.70 debit. Kept 1.20 − 0.70 = 0.50.
  near(u.closeCost, 0.7, 1e-9);
  near(u.conservative, 50, 1e-9);
  // At mid: 1.65 − 1.05 = 0.60 to close, so 0.60 kept.
  near(u.mid, 60, 1e-9);
  near(u.shareOfMaxProfit, 50 / 120, 1e-9);
});

test('a long option’s unrealized P&L is what it sells for at the bid, less what was paid', () => {
  const held = createLongOption({ leg: opt('call', 510, 6.0, 6.4), type: 'call', ...base, netOverride: -5 });
  near(unrealizedPnl(held).conservative, 100, 1e-9);
});

test('exposure restates delta as shares and dollars, and a 1% move as P&L', () => {
  const p = spread();
  const g = positionGreeks(p, p.spot);
  const e = exposure(p, g);
  assert.equal(e.shareEquivalent, Math.round(g.delta * 10) / 10);
  near(e.dollarDelta, g.delta * 500, 0.01);
  near(e.upOnePct, g.delta * 5 + 0.5 * g.gamma * 25, 0.01);
  assert.ok(e.upOnePct > 0 && e.downOnePct < 0, 'a put credit spread is long the market');
  assert.equal(e.capitalAtRisk, summarize(p).maxLoss);
  assert.ok(e.thetaShare > 0);
});

test('alerts: a breached short strike is critical, and comes first', () => {
  const breached = spread({ spot: 478 });
  const alerts = riskAlerts(breached, { greeks: positionGreeks(breached, 478) });
  assert.equal(alerts[0].severity, 'critical');
  assert.equal(alerts[0].title, 'Short strike is in the money');
});

test('alerts: past the long strike says the loss is the maximum', () => {
  const p = spread({ spot: 470 });
  assert.ok(riskAlerts(p).some((a) => a.title === 'Past the long strike'));
});

test('alerts: half the credit in is a take-profit note; twice the credit lost is a stop', () => {
  const winning = spread({ netOverride: 2.0 }); // close for 0.70, keep 1.30 of 2.00
  assert.ok(riskAlerts(winning).some((a) => a.title === 'Half the credit is in' && a.severity === 'info'));

  const losing = createSpread({ shortLeg: opt('put', 480, 4.0, 4.1), longLeg: opt('put', 475, 1.0, 1.1), type: 'put', ...base, netOverride: 1.0 });
  assert.ok(riskAlerts(losing).some((a) => a.title === 'Loss is twice the credit' && a.severity === 'critical'));
});

test('alerts: earnings inside the trade, expiry week, thin and wide quotes', () => {
  const p = spread({ expiration: '2026-11-13' }, { long: { openInterest: 20, bid: 1.0, ask: 1.3 } });
  const titles = riskAlerts(p, { greeks: positionGreeks(p, p.spot), earnings: '2026-11-12' }).map((a) => a.title);
  for (const t of ['Earnings before expiry', 'Expiry week', 'Thin open interest', 'Wide quote']) assert.ok(titles.includes(t), t);

  // Earnings after expiry are not this trade's problem.
  assert.ok(!riskAlerts(p, { earnings: '2026-12-20' }).some((a) => a.title === 'Earnings before expiry'));
});

test('alerts: an in-the-money short with no time value left warns of assignment', () => {
  const p = spread({ spot: 470 }, { short: { bid: 10.0, ask: 10.06 } }); // intrinsic 10, ~0.03 left
  assert.ok(riskAlerts(p).some((a) => a.title === 'Early assignment risk'));
});

test('a calm, well-quoted spread a month out raises nothing', () => {
  const p = spread();
  assert.deepEqual(riskAlerts(p, { greeks: positionGreeks(p, p.spot) }), []);
});

test('roll expiries: about a week and about a month further out', () => {
  const p = spread(); // 32 dte
  const list = [25, 32, 39, 46, 60, 67].map((dte) => ({ date: `2026-12-${String(dte - 20).padStart(2, '0')}`, dte }));
  assert.deepEqual(rollExpiries(list, p).map((e) => e.dte), [39, 60]);
});

test('scenarios: close, roll out, roll down, and the furthest roll that is still a credit', () => {
  const p = spread({ netOverride: 1.2 });
  const later = chainFor('2027-01-15', [
    opt('put', 480, 3.2, 3.3), opt('put', 475, 2.4, 2.5),
    opt('put', 470, 1.8, 1.9), opt('put', 465, 1.2, 1.3), opt('put', 460, 0.8, 0.9),
  ]);
  const s = adjustmentScenarios(p, { later: [later] });
  const by = Object.fromEntries(s.map((x) => [x.id, x]));

  near(by.close.net, -0.7, 1e-9);
  near(by.close.realized, 50, 1e-9);

  // Same strikes in January: open for 3.20 − 2.50 = 0.70, after paying 0.70 to close → 0.00.
  const out = by['out:2027-01-15'];
  near(out.net, 0, 1e-9);
  assert.equal(out.result.expiration, '2027-01-15');
  assert.deepEqual([out.params.short, out.params.long], [480, 475]);

  // One width down: 475/470 opens for 2.40 − 1.90 = 0.50 → net −0.20, a debit.
  near(by['out-away:2027-01-15'].net, -0.2, 1e-9);

  // No strike below 480 rolls for a credit here, so no "roll for a credit" row is invented.
  assert.equal(by['credit:2027-01-15'], undefined);
});

test('scenarios: a strike missing from the later chain is left out, not faked', () => {
  const p = spread();
  const later = chainFor('2027-01-15', [opt('put', 480, 3.2, 3.3)]); // no 475
  assert.deepEqual(adjustmentScenarios(p, { later: [later] }).map((x) => x.id), ['close']);
});

test('scenarios for a long call: sell one further out against it, or roll it out', () => {
  const p = createLongOption({ leg: opt('call', 510, 6.0, 6.4), type: 'call', ...base, netOverride: -5 });
  const now = chainFor(base.expiration, [opt('call', 510, 6.0, 6.4), opt('call', 525, 2.0, 2.2), opt('call', 540, 0.6, 0.7)]);
  const later = chainFor('2027-01-15', [opt('call', 510, 9.0, 9.4)]);
  const s = adjustmentScenarios(p, { chain: now, later: [later] });
  const by = Object.fromEntries(s.map((x) => [x.id, x]));

  // The 525 is nearest +5% (525): sell it at 2.00 → basis 3.00 on a $15 wide spread.
  const v = by.vertical;
  assert.match(v.title, /525 call/);
  near(v.result.maxLoss, 300, 1e-9);
  near(v.result.maxProfit, 1200, 1e-9);
  near(v.result.breakEven, 513, 1e-9);

  // Roll out: sell at 6.00, buy January at 9.40 → 3.40 debit.
  near(by['out:2027-01-15'].net, -3.4, 1e-9);
});
