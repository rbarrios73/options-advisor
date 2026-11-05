// The period report on the Positions page: what was traded between two dates, and what it earned.
//
// Built from the tracker's rows, which record lifecycles rather than transactions — one row is
// opened, then later closed, rolled or assigned. This turns them into the events a trading
// journal lists for a week:
//
//   new     a position opened in the period
//   roll    a position opened in the period to continue one rolled the same day, or a roll whose
//           new leg was not recorded; its premium is the new credit less the cost to close the old
//   close   a position bought back in the period, at the cost recorded when it was closed
//
// Assignments are counted but not listed, the same way the journal this mirrors leaves them out:
// an assignment is stock changing hands, and its loss is reported where it happened.
//
// Pure, like everything else in domain/ — the page computes the report as the dates change,
// without a request.

import { POSITION_TYPES } from './positions.js';

const MULTIPLIER = 100;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const asDate = (iso) => new Date(`${iso}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (date, days) => {
  const d = asDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
};
const daysBetween = (a, b) => Math.round((asDate(b) - asDate(a)) / 86_400_000);
const round2 = (x) => Math.round(x * 100) / 100;
const inRange = (date, from, to) => Boolean(date) && date >= from && date <= to;

/**
 * The money a position ties up while it is open, or null when the tracker cannot know it.
 *
 * A spread risks its width less the credit; a cash-secured put the strike less the credit; a long
 * option what it cost. A covered call is secured by shares, and a poor man's covered call by a
 * long option whose price is not stored, so neither has a figure rather than a guessed one.
 */
export function requiredCapital(position) {
  const { type, shortStrike, longStrike } = position;
  const contracts = Math.max(1, position.contracts ?? 1);
  const credit = Math.max(position.premium ?? 0, 0);

  let capital = null;
  if (type === 'VPCS' || type === 'VCCS' || type === 'IC') {
    if (shortStrike > 0 && longStrike > 0) capital = Math.abs(shortStrike - longStrike) * MULTIPLIER * contracts - credit;
  } else if (type === 'CSP' || type === 'W') {
    if (shortStrike > 0) capital = shortStrike * MULTIPLIER * contracts - credit;
  } else if (type === 'LC' || type === 'LP') {
    capital = Math.abs(position.premium ?? 0) || null;
  }

  return capital > 0 ? round2(capital) : null;
}

/**
 * Premium over capital, scaled to a year by the days the position was open for. The same yearly
 * figure a journal works out, and as fragile: a two-day trade annualises to a huge number, which
 * is why the page labels it "yearly" and never calls it a return you will get.
 */
export function yearlyRoi(premium, capital, tradeDate, expiration) {
  if (!(capital > 0) || !Number.isFinite(premium) || !ISO_DATE.test(tradeDate ?? '') || !ISO_DATE.test(expiration ?? '')) {
    return null;
  }
  const days = Math.max(1, daysBetween(tradeDate, expiration));
  return (premium / capital) * (365 / days);
}

/** Weekdays from `from` to `to`, both included. Market holidays are not known here. */
export function tradingDays(from, to) {
  if (!ISO_DATE.test(from ?? '') || !ISO_DATE.test(to ?? '') || to < from) return 0;
  let count = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const day = asDate(d).getUTCDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

/** The ranges the date filter offers, each a { from, to } pair ending no later than today. */
export const PRESETS = {
  'this-week': 'This week',
  'last-week': 'Last week',
  'this-month': 'This month',
  'last-month': 'Last month',
  ytd: 'Year to date',
};

export function presetRange(key, today) {
  const d = asDate(today);
  const monday = addDays(today, -((d.getUTCDay() + 6) % 7));

  switch (key) {
    case 'last-week':
      return { from: addDays(monday, -7), to: addDays(monday, -1) };
    case 'this-month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'last-month': {
      const first = asDate(`${today.slice(0, 7)}-01`);
      first.setUTCMonth(first.getUTCMonth() - 1);
      const from = iso(first);
      return { from, to: addDays(`${today.slice(0, 7)}-01`, -1) };
    }
    case 'ytd':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case 'this-week':
    default:
      return { from: monday, to: today };
  }
}

/**
 * The report for [from, to], both included.
 *
 * Returns the transactions in date order and the totals the page's tiles show. Nothing here is
 * estimated: a figure the rows cannot support (capital for a covered call, a cost to close that
 * was never typed) is left out of its total, and the page says how many were left out.
 */
export function periodReport(positions, { from, to, today = to }) {
  const rows = positions ?? [];
  const end = to > today ? today : to;

  // A rolled row and the row that continues it share a symbol and a date: the day it was rolled
  // is the day the new leg was opened.
  const rolled = rows.filter((p) => p.status === 'rolled' && p.closedAt);
  const continues = new Map(); // new leg id → the rolled row it continues
  const continued = new Set(); // rolled row ids whose new leg was found
  for (const p of rows) {
    if (!p.tradeDate) continue;
    const from_ = rolled.find(
      (r) => r.id !== p.id && !continued.has(r.id) && r.symbol === p.symbol && r.closedAt === p.tradeDate,
    );
    if (from_) {
      continues.set(p.id, from_);
      continued.add(from_.id);
    }
  }

  const transactions = [];

  for (const p of rows) {
    // Opened in the period: a new position, or the new leg of a roll.
    if (inRange(p.tradeDate, from, end)) {
      const prior = continues.get(p.id);
      const kind = prior ? 'roll' : 'new';
      const premium = round2((p.premium ?? 0) - (prior?.closeCost ?? 0));
      const capital = requiredCapital(p);
      transactions.push({
        id: `${p.id}:${kind}`,
        kind,
        date: p.tradeDate,
        position: p,
        premium,
        capital,
        yearlyRoi: yearlyRoi(premium, capital, p.tradeDate, p.expiration),
        rolledFrom: prior ? { expiration: prior.expiration, shortStrike: prior.shortStrike } : null,
      });
    }

    // Rolled in the period with no new leg recorded: still a roll, carrying only what it cost to
    // close. Said as such on the page, so the missing credit reads as missing, not as zero.
    if (p.status === 'rolled' && inRange(p.closedAt, from, end) && !continued.has(p.id)) {
      transactions.push({
        id: `${p.id}:roll`,
        kind: 'roll',
        date: p.closedAt,
        position: p,
        premium: round2(-(p.closeCost ?? 0)),
        capital: null,
        yearlyRoi: null,
        newLegMissing: true,
        rolledTo: p.rolledToExpiration ? { expiration: p.rolledToExpiration, shortStrike: p.rolledToShortStrike } : null,
      });
    }

    // Bought back in the period. Only with a cost recorded — a close without one is either an
    // expiry (nothing paid) or a row settled before costs were kept.
    if (p.status === 'closed' && inRange(p.closedAt, from, end) && p.closeCost > 0) {
      transactions.push({
        id: `${p.id}:close`,
        kind: 'close',
        date: p.closedAt,
        position: p,
        premium: round2(-p.closeCost),
        capital: null,
        yearlyRoi: null,
      });
    }
  }

  transactions.sort(
    (a, b) => a.date.localeCompare(b.date) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.position.symbol.localeCompare(b.position.symbol),
  );

  const of = (kind) => transactions.filter((t) => t.kind === kind);
  const sum = (list, f) => round2(list.reduce((s, t) => s + (f(t) ?? 0), 0));
  const mean = (list) => (list.length ? list.reduce((s, v) => s + v, 0) / list.length : null);
  const symbols = (list) => [...new Set(list.map((t) => t.position.symbol))];

  const group = (kind) => {
    const list = of(kind);
    const premium = sum(list, (t) => t.premium);
    const rois = list.map((t) => t.yearlyRoi).filter((r) => Number.isFinite(r));
    return {
      count: list.length,
      premium,
      average: list.length ? round2(premium / list.length) : null,
      averageYearlyRoi: mean(rois),
      symbols: symbols(list),
    };
  };

  const opened = transactions.filter((t) => t.kind !== 'close');
  // Before closes: every opening and roll credit (a roll's already net of buying the old leg back).
  const collected = sum(opened, (t) => t.premium);
  const costToClose = sum(of('close'), (t) => -t.premium);
  const net = sum(transactions, (t) => t.premium);
  const withCapital = opened.filter((t) => t.capital > 0);
  const capital = sum(withCapital, (t) => t.capital);
  const days = tradingDays(from, end);

  return {
    from,
    to: end,
    transactions,
    groups: { new: group('new'), roll: group('roll'), close: group('close') },
    totals: {
      collected,
      costToClose,
      net,
      count: transactions.length,
      averagePerTransaction: transactions.length ? round2(net / transactions.length) : null,
      capital,
      capitalMissing: opened.length - withCapital.length,
      returnOnCapital: capital > 0 ? net / capital : null,
      tradingDays: days,
      perDay: days > 0 ? round2(net / days) : null,
    },
    assigned: rows.filter((p) => p.status === 'assigned' && inRange(p.closedAt, from, end)).length,
    closesWithoutCost: rows.filter((p) => p.status === 'closed' && inRange(p.closedAt, from, end) && p.closeCost == null).length,
  };
}

const KIND_ORDER = { new: 0, roll: 1, close: 2 };

/** The labels the page uses for each kind, from one place. */
export const KIND_LABELS = { new: 'Opened', roll: 'Rolled', close: 'Closed' };

/** Strategy labels for the table, short form first. */
export const typeLabel = (type) => POSITION_TYPES[type]?.label ?? type;
