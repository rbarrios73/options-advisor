import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_GOALS,
  POSITION_TYPES,
  breachOf,
  cleanGoals,
  cleanPosition,
  daysLeft,
  premiumTotals,
  shortSideOf,
  sortPositions,
  startOfWeek,
} from '../src/domain/positions.js';

const position = (over = {}) => ({
  symbol: 'SPY',
  type: 'VPCS',
  status: 'open',
  expiration: '2026-11-06',
  shortStrike: 535,
  longStrike: 530,
  contracts: 2,
  premium: 138,
  ...over,
});

// --- what a position is -------------------------------------------------------------------------

test('a row needs a symbol, a type and an expiry; everything else can come later', () => {
  const clean = cleanPosition({ symbol: ' spy ', type: 'vpcs', expiration: '2026-11-06' });

  assert.equal(clean.symbol, 'SPY');
  assert.equal(clean.type, 'VPCS');
  assert.equal(clean.status, 'open', 'a new row is open until told otherwise');
  assert.equal(clean.contracts, 1);
  assert.equal(clean.premium, null, 'no premium yet is not an error — you may not have the fill');

  for (const bad of [
    { symbol: 'not a ticker', type: 'VPCS', expiration: '2026-11-06' },
    { symbol: 'SPY', type: 'NONSENSE', expiration: '2026-11-06' },
    { symbol: 'SPY', type: 'VPCS', expiration: 'next friday' },
    {},
    null,
  ]) {
    assert.equal(cleanPosition(bad), null, JSON.stringify(bad));
  }
});

test('half a date is dropped rather than stored, on every date field', () => {
  // All four are real DATE columns. Anything that is not a plain YYYY-MM-DD would arrive as a
  // cast error that fails the whole save — including the browser date input's empty string.
  const clean = cleanPosition(
    position({ tradeDate: '', closedAt: 'yesterday', rolledToExpiration: '2026/12/18' }),
  );

  assert.equal(clean.tradeDate, null);
  assert.equal(clean.closedAt, null);
  assert.equal(clean.rolledToExpiration, null);
});

// --- is the short strike in trouble ---------------------------------------------------------------

test('a put structure is breached when the price falls TO the short strike', () => {
  const p = position({ type: 'VPCS', shortStrike: 535 });

  assert.equal(breachOf(p, 560).level, 'clear');
  assert.equal(breachOf(p, 545).level, 'near', 'within 2% above counts as near');
  assert.equal(breachOf(p, 535).level, 'breached', 'at the strike is in the money');
  assert.equal(breachOf(p, 500).level, 'breached');
  assert.equal(breachOf(p, 535).side, 'put');
});

test('a call structure is the mirror — breached when the price RISES to the strike', () => {
  const p = position({ type: 'CC', shortStrike: 27, longStrike: null });

  assert.equal(breachOf(p, 23).level, 'clear');
  assert.equal(breachOf(p, 26.6).level, 'near', 'within 2% below counts as near');
  assert.equal(breachOf(p, 27).level, 'breached');
  assert.equal(breachOf(p, 31).level, 'breached');
  assert.equal(breachOf(p, 31).side, 'call');
});

test('a settled position is never flagged, and a missing price flags nothing', () => {
  // The colour is about what to do today. A closed row has nothing to do.
  assert.equal(breachOf(position({ status: 'closed' }), 400), null);
  assert.equal(breachOf(position(), null), null);
  assert.equal(breachOf(position({ shortStrike: null }), 500), null);
});

test('the distance to the strike comes back signed, so a page can show how far', () => {
  const p = position({ shortStrike: 100 });
  assert.equal(breachOf(p, 110).distance.toFixed(2), '0.10');
  assert.equal(breachOf(p, 90).distance.toFixed(2), '-0.10');
});

// --- the goals ------------------------------------------------------------------------------------

test('only settled premium counts, on the day it was settled', () => {
  const rows = [
    position({ status: 'closed', closedAt: '2026-10-06', premium: 200 }),
    position({ status: 'closed', closedAt: '2026-10-05', premium: 150 }),
    position({ status: 'closed', closedAt: '2026-09-30', premium: 999 }),
    // Still open: its credit is at risk, not banked, and must not move a goal.
    position({ status: 'open', premium: 500 }),
  ];

  const totals = premiumTotals(rows, { today: '2026-10-06' });

  assert.equal(totals.today.net, 200, 'today is today, not the week');
  assert.equal(totals.week.net, 350, 'Monday the 5th and Tuesday the 6th');
  assert.equal(totals.month.net, 350, 'the 30th of September is last month');
  assert.equal(totals.openPremium, 500, 'shown, but separately');
  assert.equal(totals.openCount, 1);
});

test('an assignment loss comes off the net, and is reported on its own', () => {
  const totals = premiumTotals(
    [position({ status: 'assigned', closedAt: '2026-10-06', premium: 120, assignmentLoss: 450 })],
    { today: '2026-10-06' },
  );

  assert.equal(totals.today.premium, 120);
  assert.equal(totals.today.assignmentLoss, 450);
  assert.equal(totals.today.net, -330, 'a losing day is a losing day');
  assert.ok(totals.today.progress < 0);
});

test('progress is measured against the goal that was set', () => {
  const rows = [position({ status: 'closed', closedAt: '2026-10-06', premium: 225 })];

  assert.equal(premiumTotals(rows, { today: '2026-10-06' }).today.progress, 0.5, '225 of the default 450');
  assert.equal(
    premiumTotals(rows, { today: '2026-10-06', goals: { ...DEFAULT_GOALS, daily: 900 } }).today.progress,
    0.25,
  );
});

test('the week starts on Monday, and Sunday belongs to the week that just ended', () => {
  assert.equal(startOfWeek('2026-10-06'), '2026-10-05', 'Tuesday → Monday');
  assert.equal(startOfWeek('2026-10-05'), '2026-10-05', 'Monday → itself');
  assert.equal(startOfWeek('2026-10-11'), '2026-10-05', 'Sunday → the Monday before, not the one after');
});

test('a goal is a number and not a negative one', () => {
  assert.deepEqual(cleanGoals({ daily: 500, weekly: 2500, monthly: 10000 }), {
    daily: 500,
    weekly: 2500,
    monthly: 10000,
  });

  // Anything unusable falls back rather than blanking the panel.
  assert.deepEqual(cleanGoals({ daily: -5, weekly: 'lots', monthly: null }), DEFAULT_GOALS);
  assert.deepEqual(cleanGoals(undefined), DEFAULT_GOALS);
  assert.equal(cleanGoals({ daily: 0 }).daily, 0, 'zero is a choice, not a mistake');
});

// --- reading order --------------------------------------------------------------------------------

test('open positions come first, soonest expiry at the top', () => {
  const rows = sortPositions([
    position({ symbol: 'C', status: 'closed', closedAt: '2026-10-01' }),
    position({ symbol: 'B', expiration: '2026-12-18' }),
    position({ symbol: 'A', expiration: '2026-11-06' }),
    position({ symbol: 'D', status: 'closed', closedAt: '2026-10-05' }),
  ]);

  assert.deepEqual(rows.map((p) => p.symbol), ['A', 'B', 'D', 'C'], 'open by expiry, then settled newest first');
});

test('days left counts down and goes negative once it has passed', () => {
  assert.equal(daysLeft('2026-11-06', '2026-10-06'), 31);
  assert.equal(daysLeft('2026-10-06', '2026-10-06'), 0);
  assert.equal(daysLeft('2026-10-02', '2026-10-06'), -4);
});

// --- positions you bought rather than sold ----------------------------------------------------

test('a long option has no breach, because through the strike is where it wants to be', () => {
  // The reading would not just be unhelpful, it would be backwards: "in the money" is the alarm
  // on a position you sold and the good news on one you bought.
  const longCall = { symbol: 'SPY', type: 'LC', status: 'open', shortStrike: 100, expiration: '2026-11-20' };
  const shortCall = { ...longCall, type: 'CC' };

  assert.equal(breachOf(longCall, 120), null, 'deep in the money and still silent');
  assert.equal(breachOf(longCall, 80), null);

  // The same price on the same strike, sold instead of bought, is breached.
  assert.equal(breachOf(shortCall, 120).level, 'breached');
});

test('shortSideOf answers "did you sell this", not "which option is it"', () => {
  assert.equal(shortSideOf('CC'), 'call');
  assert.equal(shortSideOf('VCCS'), 'call');
  assert.equal(shortSideOf('CSP'), 'put');
  assert.equal(shortSideOf('IC'), 'both');

  // The two that matter: a long call IS a call, and you cannot be assigned on it.
  assert.equal(POSITION_TYPES.LC.side, 'call', 'it is still a call');
  assert.equal(shortSideOf('LC'), null, 'but not one you sold');
  assert.equal(shortSideOf('LP'), null);

  assert.equal(shortSideOf('nonsense'), null);
});

test('the long types are storable, and keep a negative premium', () => {
  const row = cleanPosition({
    symbol: 'SPY',
    type: 'LC',
    shortStrike: 105,
    expiration: '2026-11-20',
    contracts: 1,
    premium: -290,
  });

  assert.ok(row);
  assert.equal(row.type, 'LC');
  assert.equal(row.premium, -290, 'a debit survives as a debit');
});

test('a long option that expires worthless takes its cost off the total', () => {
  // The accounting consequence of storing a debit. A month with one $290 call that expired is a
  // month down $290, and a tracker that reported zero would be flattering you.
  const totals = premiumTotals(
    [
      { symbol: 'SPY', type: 'LC', status: 'closed', premium: -290, closedAt: '2026-10-22', expiration: '2026-11-20' },
      { symbol: 'SPY', type: 'VPCS', status: 'closed', premium: 140, closedAt: '2026-10-22', expiration: '2026-11-20' },
    ],
    { today: '2026-10-22', goals: DEFAULT_GOALS },
  );

  assert.equal(totals.today.net, -150, '140 collected less 290 paid');
  assert.equal(totals.today.premium, -150);
  assert.ok(totals.today.progress <= 0, 'and a day in the red is not progress towards a goal');
});
