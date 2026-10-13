import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FREQUENCIES,
  addMonths,
  annualIncome,
  cleanHolding,
  cutRisk,
  exDividendWarning,
  perPayment,
  projectIncome,
  schedule,
  sortHoldings,
  summariseHistory,
  totals,
  yieldOf,
} from '../src/domain/dividends.js';

const ASOF = '2026-10-13';

/** Quarterly payments ending shortly before ASOF, growing by `growth` a year as they come forward. */
function history({ start = '2016-11-15', quarters = 40, amount = 0.2, growth = 0 } = {}) {
  const out = [];
  let date = start;
  let value = amount;

  for (let i = 0; i < quarters; i++) {
    out.push({ exDate: date, payDate: addMonths(date, 0), amount: Math.round(value * 10000) / 10000 });
    date = addMonths(date, 3);
    value *= (1 + growth) ** 0.25;
  }
  return out;
}

// --- the arithmetic -------------------------------------------------------------------------

test('a blank box is not a figure of zero', () => {
  // Number('') is 0, and a holding with "0 shares" and "a $0 dividend" looks like data rather
  // than like the empty form it came from. This is the same trap the position tracker fell into.
  const blank = cleanHolding({ symbol: 'ko', shares: '', costBasis: null, annualRate: undefined });

  assert.equal(blank.symbol, 'KO', 'and the symbol is upper-cased');
  assert.equal(blank.shares, null);
  assert.equal(blank.costBasis, null);
  assert.equal(blank.annualRate, null);
  assert.equal(blank.frequency, 'quarterly', 'the one field that gets a default');

  assert.equal(cleanHolding({ symbol: 'not a ticker' }), null);
  assert.equal(cleanHolding({}), null);
});

test('a bad date is dropped rather than carried as a date that does not exist', () => {
  assert.equal(cleanHolding({ symbol: 'KO', nextExDate: '2026-02-31' }).nextExDate, null);
  assert.equal(cleanHolding({ symbol: 'KO', nextExDate: 'next tuesday' }).nextExDate, null);
  assert.equal(cleanHolding({ symbol: 'KO', nextExDate: '2026-11-14' }).nextExDate, '2026-11-14');
});

test('the rate is per year everywhere, and per payment only where it says so', () => {
  assert.equal(perPayment(2.0, 'quarterly'), 0.5);
  assert.equal(perPayment(2.4, 'monthly'), 0.2);
  assert.equal(perPayment(2.0, 'annual'), 2);
  assert.equal(perPayment(null, 'quarterly'), null, 'not zero');
});

test('yield and income are null when either side is missing, never zero', () => {
  assert.equal(yieldOf(2, 50), 0.04);
  assert.equal(yieldOf(2, 0), null, 'a price of zero is missing data, not an infinite yield');
  assert.equal(yieldOf(null, 50), null);
  assert.equal(annualIncome(100, 2), 200);
  assert.equal(annualIncome(null, 2), null);
});

test('adding months clamps to the end of a short month', () => {
  // 31 January plus one month is not 31 February, and a schedule that produced one would hand
  // every downstream date to Date's rollover, landing on 3 March.
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29', 'leap year');
  assert.equal(addMonths('2026-11-15', 3), '2027-02-15');
});

// --- the schedule ---------------------------------------------------------------------------

test('a quarterly payer projects four payments a year, on the quarter', () => {
  const { payments, total } = projectIncome(
    { annualRate: 4, frequency: 'quarterly', nextExDate: '2026-11-15', shares: 100 },
    { months: 12, asOf: ASOF },
  );

  assert.equal(payments.length, 4);
  assert.deepEqual(
    payments.map((p) => p.exDate),
    ['2026-11-15', '2027-02-15', '2027-05-15', '2027-08-15'],
  );
  assert.equal(payments[0].perShare, 1);
  assert.equal(payments[0].amount, 100);
  assert.equal(total, 400);
});

test('a stored ex-date in the past is carried forward, not reported as income to come', () => {
  // A date typed a year ago is the common case, and a schedule that started from it would list
  // payments that have already happened as money still owed.
  const { payments } = projectIncome(
    { annualRate: 4, frequency: 'quarterly', nextExDate: '2025-02-15', shares: 10 },
    { months: 12, asOf: ASOF },
  );

  assert.ok(payments.every((p) => p.exDate >= ASOF));
  assert.equal(payments[0].exDate, '2026-11-15');
  assert.equal(payments[0].estimated, true, 'and it is flagged as worked out rather than announced');
});

test('no rate and no date means no schedule — not a schedule of nothing', () => {
  assert.deepEqual(schedule({ annualRate: null, frequency: 'quarterly', nextExDate: '2026-11-15' }), []);
  assert.deepEqual(schedule({ annualRate: 4, frequency: 'quarterly', nextExDate: null }), []);
});

test('a monthly payer fills every month and an annual one fills one', () => {
  const monthly = schedule({ annualRate: 12, frequency: 'monthly', nextExDate: '2026-10-20', shares: 1 }, { months: 12, asOf: ASOF });
  const yearly = schedule({ annualRate: 12, frequency: 'annual', nextExDate: '2026-10-20', shares: 1 }, { months: 12, asOf: ASOF });

  // Twelve, not thirteen: the window ends on the same day next year, and the thirteenth payment
  // falls a week after it.
  assert.equal(monthly.length, 12);
  assert.equal(monthly[0].perShare, 1);
  assert.equal(yearly.length, 1);
  assert.equal(yearly[0].perShare, 12);
});

test('a holding with no share count still projects per share', () => {
  const { total, perShare, payments } = projectIncome(
    { annualRate: 4, frequency: 'quarterly', nextExDate: '2026-11-15', shares: null },
    { months: 12, asOf: ASOF },
  );

  assert.equal(total, null, 'there is no dollar figure without a share count');
  assert.equal(perShare, 4);
  assert.equal(payments[0].amount, null);
});

// --- reading a provider's history -------------------------------------------------------------

test('the cadence is read off the gaps, not off a field nobody fills in consistently', () => {
  assert.equal(summariseHistory(history({ quarters: 8 }), { asOf: ASOF }).frequency, 'quarterly');

  const monthly = Array.from({ length: 12 }, (_, i) => ({ exDate: addMonths('2026-01-10', i), amount: 0.1 }));
  assert.equal(summariseHistory(monthly, { asOf: ASOF }).frequency, 'monthly');

  const twice = Array.from({ length: 6 }, (_, i) => ({ exDate: addMonths('2023-03-10', i * 6), amount: 0.5 }));
  assert.equal(summariseHistory(twice, { asOf: ASOF }).frequency, 'semiannual');
});

test('the rate quoted is the latest payment annualised, not the trailing year', () => {
  // The two differ exactly when a company has just changed its dividend — which is the moment it
  // matters. Trailing would go on quoting the old, higher number for a year after a cut.
  const cutRecently = [
    { exDate: '2025-11-15', amount: 1 },
    { exDate: '2026-02-15', amount: 1 },
    { exDate: '2026-05-15', amount: 1 },
    { exDate: '2026-08-15', amount: 0.25 },
  ];

  const summary = summariseHistory(cutRecently, { asOf: ASOF });
  assert.equal(summary.annualRate, 1, 'four times the newest payment');
  assert.equal(summary.trailing12m, 3.25, 'and the trailing figure is kept, so the page can show both');
});

test('the next ex-date is the last one plus the cadence', () => {
  const summary = summariseHistory(history({ start: '2017-02-15', quarters: 39 }), { asOf: ASOF });
  assert.equal(summary.lastExDate, '2026-08-15');
  assert.equal(summary.nextExDate, '2026-11-15');
});

test('“next” always means next, even when the history stops a year short', () => {
  // One step past the last payment is only "next" if that payment was recent. A stale history —
  // a late payer, a provider that has not caught up — would otherwise print a date that has
  // already been and gone in a column headed "next ex-date", and disagree with the schedule
  // underneath it, which carries forward on its own.
  const stale = summariseHistory(history({ start: '2020-02-15', quarters: 16 }), { asOf: ASOF });

  assert.equal(stale.lastExDate, '2023-11-15');
  assert.ok(stale.nextExDate > ASOF, `got ${stale.nextExDate}`);
  assert.equal(stale.nextExDate, '2026-11-15');

  // And it agrees with the first payment the schedule projects, which is the thing that would
  // look broken on screen.
  const [first] = schedule({ ...stale, shares: 1 }, { months: 12, asOf: ASOF });
  assert.equal(first.exDate, stale.nextExDate);
});

test('a streak counts completed years that did not fall, and a cut ends it', () => {
  const steady = summariseHistory(history({ start: '2012-02-15', quarters: 59, growth: 0.06 }), { asOf: ASOF });
  assert.ok(steady.streakYears >= 10, `expected a long streak, got ${steady.streakYears}`);
  assert.equal(steady.lastCut, null);

  // Same series, but one year's payments halved.
  const raw = history({ start: '2012-02-15', quarters: 59, growth: 0.06 });
  const cut = raw.map((e) => (e.exDate.startsWith('2022') ? { ...e, amount: e.amount * 0.4 } : e));

  const summary = summariseHistory(cut, { asOf: ASOF });
  assert.equal(summary.lastCut.year, 2022);
  assert.ok(summary.streakYears < 10, 'and the streak restarts after it');
});

test('the current year never counts as a cut just for being unfinished', () => {
  // Three quarters of a year is always less than four, and a naive comparison would report a cut
  // every January until the fourth payment landed.
  const summary = summariseHistory(history({ start: '2019-02-15', quarters: 31 }), { asOf: ASOF });
  assert.equal(summary.lastCut, null);
});

test('a symbol that has never paid is a different answer from one that cannot be asked about', () => {
  assert.equal(summariseHistory([], { asOf: ASOF }), null);
  assert.equal(summariseHistory(null, { asOf: ASOF }), null);
  assert.equal(summariseHistory([{ exDate: 'rubbish', amount: 1 }], { asOf: ASOF }), null);
});

// --- the risk reading -------------------------------------------------------------------------

test('a very high yield is reported as the warning it usually is', () => {
  const risk = cutRisk({ annualRate: 6, price: 40 }); // 15%
  assert.equal(risk.level, 'stretched');
  assert.match(risk.reasons.join(' '), /expects a cut/);

  assert.equal(cutRisk({ annualRate: 3.5, price: 45 }).level, 'watch', '7.8% is worth a question');
  assert.equal(cutRisk({ annualRate: 2, price: 100 }).level, 'unknown', '2% says nothing either way');
});

test('paying out more than it earns is the clearest signal there is', () => {
  const risk = cutRisk({ annualRate: 2, price: 100, payoutRatio: 1.3 });
  assert.equal(risk.level, 'stretched');
  assert.match(risk.reasons[0], /more than it earns/);

  assert.equal(cutRisk({ annualRate: 2, price: 100, payoutRatio: 0.9 }).level, 'watch');
  assert.equal(cutRisk({ annualRate: 2, price: 100, payoutRatio: 0.4 }).level, 'covered');
});

test('a cut that already happened outranks a long record, and the record never cancels it', () => {
  // The failure mode this guards against is a 40-year streak quietly downgrading a company that
  // cut last year. A streak is context; a cut is a fact.
  const risk = cutRisk({ annualRate: 2, price: 100, streakYears: 40, lastCut: { year: 2024, from: 2, to: 1 } });

  assert.equal(risk.level, 'watch');
  assert.match(risk.reasons.join(' '), /Cut in 2024/);
  assert.match(risk.reasons.join(' '), /40 years/, 'both are reported');
});

test('every risk level carries words, never a colour on its own', () => {
  for (const input of [
    {},
    { annualRate: 2, price: 100, payoutRatio: 0.3 },
    { annualRate: 3.5, price: 45 },
    { annualRate: 6, price: 40 },
  ]) {
    const risk = cutRisk(input);
    assert.ok(risk.label && risk.label.length > 3, JSON.stringify(input));
    assert.ok(risk.reasons.length > 0, `${risk.level} must say why`);
  }
});

// --- where dividends meet the options side ------------------------------------------------------

test('a short call in front of an ex-date is flagged, and only a short call', () => {
  const base = { expiration: '2026-12-18', nextExDate: '2026-11-20', perShare: 0.9, extrinsic: 0.4 };

  const call = exDividendWarning({ ...base, side: 'call' }, ASOF);
  assert.ok(call);
  assert.equal(call.likely, true, 'the dividend beats the time value left');
  assert.match(call.text, /likely to be assigned the day before/);

  assert.equal(exDividendWarning({ ...base, side: 'put' }, ASOF), null, 'a put is never called away for a dividend');
});

test('an ex-date after the expiry, or already past, is not a warning', () => {
  const base = { side: 'call', expiration: '2026-11-06', perShare: 0.9, extrinsic: 0.4 };

  assert.equal(exDividendWarning({ ...base, nextExDate: '2026-12-20' }, ASOF), null, 'after it expires');
  assert.equal(exDividendWarning({ ...base, nextExDate: '2026-09-20' }, ASOF), null, 'already happened');
});

test('without the time value the date is still flagged, just not called likely', () => {
  // The chain can be missing a leg — an illiquid strike, a provider blip. Losing the "likely" is
  // fine; losing the date entirely would hide the thing worth seeing.
  const warning = exDividendWarning(
    { side: 'call', expiration: '2026-12-18', nextExDate: '2026-11-20', perShare: 0.9, extrinsic: null },
    ASOF,
  );

  assert.ok(warning);
  assert.equal(warning.likely, false);
  assert.match(warning.text, /can be assigned the day before/);
});

// --- ranking and totals -------------------------------------------------------------------------

test('rows with nothing filled in sort last, whatever the ranking', () => {
  const rows = [
    { symbol: 'AAA', yield: 0.02, annualIncome: 10, nextExDate: '2026-11-01' },
    { symbol: 'BBB', yield: null, annualIncome: null, nextExDate: null },
    { symbol: 'CCC', yield: 0.08, annualIncome: 5, nextExDate: '2026-12-01' },
  ];

  // An empty row at the top of a ranked table reads as a zero rather than as a gap.
  assert.deepEqual(sortHoldings(rows, 'yield').map((r) => r.symbol), ['CCC', 'AAA', 'BBB']);
  assert.deepEqual(sortHoldings(rows, 'income').map((r) => r.symbol), ['AAA', 'CCC', 'BBB']);
  assert.deepEqual(sortHoldings(rows, 'soonest').map((r) => r.symbol), ['AAA', 'CCC', 'BBB']);
  assert.deepEqual(sortHoldings(rows, 'symbol').map((r) => r.symbol), ['AAA', 'BBB', 'CCC']);
});

test('totals count only what is actually held, and both yields are reported', () => {
  const rows = [
    { symbol: 'AAA', shares: 100, price: 50, costBasis: 25, annualRate: 2, annualIncome: 200, frequency: 'quarterly', nextExDate: '2026-11-15' },
    { symbol: 'BBB', shares: null, price: 30, costBasis: null, annualRate: 1, annualIncome: null, frequency: 'quarterly', nextExDate: '2026-11-15' },
  ];

  const sums = totals(rows, { months: 12, asOf: ASOF });

  assert.equal(sums.holdings, 2);
  assert.equal(sums.paying, 1, 'the one with shares');
  assert.equal(sums.annualIncome, 200);
  assert.equal(sums.portfolioYield, 0.04, 'on $5,000 of stock');
  assert.equal(sums.yieldOnCost, 0.08, 'on the $2,500 it cost — the figure that rises with a raise');
});

test('every frequency is a real divisor of a year', () => {
  for (const [name, { perYear, months }] of Object.entries(FREQUENCIES)) {
    assert.equal(perYear * months, 12, name);
  }
});
