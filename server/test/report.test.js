import test from 'node:test';
import assert from 'node:assert/strict';

import { periodReport, presetRange, requiredCapital, tradingDays, yearlyRoi } from '../src/domain/report.js';
import { cleanPosition, keptOf, premiumTotals } from '../src/domain/positions.js';

const near = (a, b, tol = 1e-6, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}, got ${a}`);
const row = (id, fields) => ({ id, account: '', contracts: 1, note: '', status: 'open', ...fields });

// A week shaped like the journal it mirrors: Mon 2026-10-19 to Fri 2026-10-23.
const WEEK = { from: '2026-10-19', to: '2026-10-23', today: '2026-10-23' };
const positions = [
  // Opened this week.
  row('cls', { symbol: 'CLS', type: 'VPCS', contracts: 2, shortStrike: 240, longStrike: 230, expiration: '2026-11-20', tradeDate: '2026-10-20', premium: 347.31 }),
  row('crm', { symbol: 'CRM', type: 'VPCS', shortStrike: 215, longStrike: 205, expiration: '2026-11-20', tradeDate: '2026-10-20', premium: 285.32 }),
  // Rolled this week: the old leg, bought back for 40, and the new leg opened the same day.
  row('qcom-old', { symbol: 'QCOM', type: 'CSP', shortStrike: 165, expiration: '2026-10-23', tradeDate: '2026-09-20', premium: 300, status: 'rolled', closedAt: '2026-10-19', closeCost: 40, rolledToExpiration: '2026-12-18' }),
  row('qcom-new', { symbol: 'QCOM', type: 'CSP', shortStrike: 165, expiration: '2026-12-18', tradeDate: '2026-10-19', premium: 553.3 }),
  // Closed this week, at a cost.
  row('wmt', { symbol: 'WMT', type: 'VPCS', shortStrike: 100, longStrike: 95, expiration: '2026-11-20', tradeDate: '2026-10-01', premium: 120, status: 'closed', closedAt: '2026-10-19', closeCost: 23.06 }),
  // Assigned this week: counted, not listed.
  row('xyz', { symbol: 'XYZ', type: 'CSP', shortStrike: 50, expiration: '2026-10-23', tradeDate: '2026-10-01', premium: 60, status: 'assigned', closedAt: '2026-10-23', assignmentLoss: 200 }),
  // Outside the week entirely.
  row('old', { symbol: 'OLD', type: 'VPCS', shortStrike: 50, longStrike: 45, expiration: '2026-10-16', tradeDate: '2026-09-01', premium: 90, status: 'closed', closedAt: '2026-10-16', closeCost: 10 }),
];

test('the week lists opens, the roll and the close — not the assignment or anything outside it', () => {
  const r = periodReport(positions, WEEK);
  assert.deepEqual(
    r.transactions.map((t) => `${t.kind}:${t.position.symbol}`),
    ['roll:QCOM', 'close:WMT', 'new:CLS', 'new:CRM'],
  );
  assert.equal(r.assigned, 1);
});

test('a roll’s premium is the new credit less the cost of buying the old leg back', () => {
  const roll = periodReport(positions, WEEK).transactions.find((t) => t.kind === 'roll');
  near(roll.premium, 553.3 - 40);
  assert.deepEqual(roll.rolledFrom, { expiration: '2026-10-23', shortStrike: 165 });
});

test('totals: collected, cost to close, net, return on capital, per day', () => {
  const { totals, groups } = periodReport(positions, WEEK);

  near(totals.collected, 347.31 + 285.32 + 513.3, 0.005);
  near(totals.costToClose, 23.06, 0.005);
  near(totals.net, totals.collected - totals.costToClose, 0.005);
  assert.equal(totals.count, 4);

  // CLS: 2 × $10 wide − credit; CRM: $10 wide − credit; QCOM CSP: strike × 100 − credit.
  near(totals.capital, 2000 - 347.31 + (1000 - 285.32) + (16500 - 553.3), 0.005);
  near(totals.returnOnCapital, totals.net / totals.capital);
  assert.equal(totals.tradingDays, 5);
  near(totals.perDay, totals.net / 5, 0.005);

  assert.equal(groups.new.count, 2);
  assert.deepEqual(groups.new.symbols, ['CLS', 'CRM']);
  assert.equal(groups.close.count, 1);
});

test('a roll with no new leg recorded is still a roll, carrying only its cost to close', () => {
  const lone = positions.filter((p) => p.id !== 'qcom-new');
  const roll = periodReport(lone, WEEK).transactions.find((t) => t.kind === 'roll');
  assert.equal(roll.newLegMissing, true);
  near(roll.premium, -40);
});

test('a close with no cost recorded is not invented, and is counted so the page can say so', () => {
  const legacy = [row('a', { symbol: 'A', type: 'VPCS', shortStrike: 10, longStrike: 9, expiration: '2026-11-20', tradeDate: '2026-10-01', premium: 30, status: 'closed', closedAt: '2026-10-20' })];
  const r = periodReport(legacy, WEEK);
  assert.equal(r.transactions.length, 0);
  assert.equal(r.closesWithoutCost, 1);
});

test('a period ending after today stops at today', () => {
  const r = periodReport(positions, { from: '2026-10-19', to: '2026-10-31', today: '2026-10-21' });
  assert.equal(r.to, '2026-10-21');
  assert.equal(r.totals.tradingDays, 3);
});

test('required capital per strategy, and nothing made up where it cannot be known', () => {
  assert.equal(requiredCapital({ type: 'VPCS', contracts: 2, shortStrike: 240, longStrike: 230, premium: 347.31 }), 1652.69);
  assert.equal(requiredCapital({ type: 'CSP', contracts: 1, shortStrike: 50, premium: 100 }), 4900);
  assert.equal(requiredCapital({ type: 'LC', contracts: 1, shortStrike: 150, premium: -425 }), 425);
  assert.equal(requiredCapital({ type: 'CC', contracts: 1, shortStrike: 85, premium: 997.9 }), null);
  assert.equal(requiredCapital({ type: 'VPCS', contracts: 1, shortStrike: 240, premium: 100 }), null, 'no long strike, no width');
});

test('yearly ROI scales premium over capital by the days held', () => {
  // CLS in the journal: $347.31 on $1,652.69 for 31 days ≈ 247%.
  near(yearlyRoi(347.31, 1652.69, '2026-10-20', '2026-11-20'), 2.474, 0.001);
  assert.equal(yearlyRoi(100, null, '2026-10-20', '2026-11-20'), null);
});

test('trading days skip weekends', () => {
  assert.equal(tradingDays('2026-10-19', '2026-10-25'), 5);
  assert.equal(tradingDays('2026-10-24', '2026-10-25'), 0);
  assert.equal(tradingDays('2026-10-25', '2026-10-19'), 0);
});

test('presets: weeks start on Monday, months on the 1st, nothing runs past today', () => {
  const today = '2026-11-05'; // a Thursday
  assert.deepEqual(presetRange('this-week', today), { from: '2026-11-02', to: today });
  assert.deepEqual(presetRange('last-week', today), { from: '2026-10-26', to: '2026-11-01' });
  assert.deepEqual(presetRange('this-month', today), { from: '2026-11-01', to: today });
  assert.deepEqual(presetRange('last-month', today), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(presetRange('ytd', today), { from: '2026-01-01', to: today });
  assert.deepEqual(presetRange('last-month', '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' });
});

test('cost to close is stored positive, and the goal totals count premium kept', () => {
  const clean = cleanPosition({ symbol: 'wmt', type: 'VPCS', expiration: '2026-11-20', premium: 120, closeCost: -23.06 });
  assert.equal(clean.closeCost, 23.06);
  near(keptOf({ premium: 120, closeCost: 23.06 }), 96.94);
  near(keptOf({ premium: 96.94, closeCost: null }), 96.94, 1e-9, 'an older row is already net');

  const totals = premiumTotals([positions.find((p) => p.id === 'wmt')], { today: '2026-10-19' });
  near(totals.today.net, 120 - 23.06, 0.005);
});
