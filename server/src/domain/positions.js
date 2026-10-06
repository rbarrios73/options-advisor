// A position you have actually opened — the tracker, as opposed to the screener's candidates.
//
// The screener deals in things you COULD do; this deals in things you DID. The difference matters
// for where the numbers come from: a candidate's figures are all computed, whereas a position's
// premium is what your broker filled you at and nothing can derive it. So the rule here is that
// anything the market can tell us is fetched (price, delta, whether the short strike is breached)
// and anything only you know is typed (the fill, the account, the date).
//
// Pure, like everything else in domain/ — the browser imports it too, so the page can decide a
// row is at risk without waiting for the server to say so.

/** The strategies worth tracking, keyed by the shorthand a trading journal already uses. */
export const POSITION_TYPES = {
  VPCS: { label: 'Vertical put credit spread', side: 'put', legs: 2, short: true },
  VCCS: { label: 'Vertical call credit spread', side: 'call', legs: 2, short: true },
  CSP: { label: 'Cash secured put', side: 'put', legs: 1, short: true },
  CC: { label: 'Covered call', side: 'call', legs: 1, short: true },
  W: { label: 'Wheel', side: 'put', legs: 1, short: true },
  PMCC: { label: "Poor man's covered call", side: 'call', legs: 2, short: true },
  IC: { label: 'Iron condor', side: 'both', legs: 4, short: true },
};

/**
 * Where a position is in its life. Deliberately NOT the same axis as risk: a position can be open
 * and fine, or open and breached, and conflating the two is what makes a spreadsheet's colours
 * ambiguous — yellow meant "in the money", which is not a status but a fact about today's price.
 */
export const STATUSES = {
  open: { label: 'Open', tone: 'new' },
  rolled: { label: 'Rolled', tone: 'muted' },
  closed: { label: 'Closed', tone: 'done' },
  assigned: { label: 'Assigned', tone: 'warn' },
};

export const ACCOUNTS_HINT = ['Fidelity IRA', 'Fidelity ROTH', 'Taxable'];

export const DEFAULT_GOALS = { daily: 450, weekly: 2250, monthly: 9000 };

const SYMBOL = /^[A-Z.]{1,6}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A number, or null for anything that is not one.
 *
 * The explicit null/undefined/'' test is load-bearing: Number(null) and Number('') are both 0, so
 * without it an empty premium box stores a $0 fill and an unset goal becomes a goal of zero —
 * both of which look like data rather than like a blank.
 */
const n = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/**
 * One row, tidied. Returns null only when the symbol, type or expiration is unusable — those
 * three are what make the row mean anything; everything else can be filled in later.
 */
export function cleanPosition(raw) {
  const symbol = String(raw?.symbol ?? '').trim().toUpperCase();
  const type = String(raw?.type ?? '').trim().toUpperCase();
  const expiration = String(raw?.expiration ?? '').trim();

  if (!SYMBOL.test(symbol)) return null;
  if (!POSITION_TYPES[type]) return null;
  if (!ISO_DATE.test(expiration)) return null;

  const status = STATUSES[raw?.status] ? raw.status : 'open';

  return {
    symbol,
    type,
    expiration,
    status,
    account: String(raw?.account ?? '').trim().slice(0, 40),
    contracts: Math.max(1, Math.round(n(raw?.contracts) ?? 1)),
    shortStrike: n(raw?.shortStrike),
    longStrike: n(raw?.longStrike),
    tradeDate: ISO_DATE.test(String(raw?.tradeDate ?? '')) ? raw.tradeDate : null,

    // Dollars for the whole position, not per share: it is what the broker shows on the fill, and
    // converting in your head every time is how a goal total ends up 100x out.
    premium: n(raw?.premium),
    assignmentLoss: n(raw?.assignmentLoss),

    // When the money was realised. A premium with no date cannot count towards a daily goal, so
    // closing a position asks for this rather than assuming today.
    closedAt: ISO_DATE.test(String(raw?.closedAt ?? '')) ? raw.closedAt : null,

    // Where it went, when it was rolled. Keeps the chain readable without a second table.
    rolledToExpiration: ISO_DATE.test(String(raw?.rolledToExpiration ?? '')) ? raw.rolledToExpiration : null,
    rolledToShortStrike: n(raw?.rolledToShortStrike),

    note: String(raw?.note ?? '').trim().slice(0, 200),
  };
}

/**
 * How close today's price is to the short strike — the column the spreadsheet painted yellow by
 * hand.
 *
 * Computed rather than typed, because a hand-coloured cell is only as current as the last time
 * someone looked, and the whole point of the colour is to catch the day it changes.
 *
 * `band` is how near counts as near: 2% of the strike by default. A put is in trouble when the
 * price falls to it, a call when the price rises to it, and an iron condor on either side.
 */
export function breachOf(position, spot, band = 0.02) {
  const { shortStrike, type } = position;
  if (!(spot > 0) || !(shortStrike > 0) || position.status !== 'open') return null;

  const side = POSITION_TYPES[type]?.side;
  if (!side) return null;

  const put = () => {
    if (spot <= shortStrike) return { level: 'breached', side: 'put' };
    if (spot <= shortStrike * (1 + band)) return { level: 'near', side: 'put' };
    return null;
  };

  const call = () => {
    if (spot >= shortStrike) return { level: 'breached', side: 'call' };
    if (spot >= shortStrike * (1 - band)) return { level: 'near', side: 'call' };
    return null;
  };

  // An iron condor's tracked short strike is one side; the other is not stored, so only the side
  // that is known can be judged. Said plainly rather than guessed at.
  const found = side === 'call' ? call() : side === 'both' ? (put() ?? call()) : put();
  if (!found) return { level: 'clear', distance: distanceTo(spot, shortStrike) };

  return { ...found, distance: distanceTo(spot, shortStrike) };
}

/** Signed: positive means the price is above the strike. */
const distanceTo = (spot, strike) => (strike > 0 ? spot / strike - 1 : null);

/** Days until expiry, negative once it has passed. */
export function daysLeft(expiration, today) {
  const a = new Date(`${today}T00:00:00Z`);
  const b = new Date(`${expiration}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Premium realised in each goal period, and what is still open.
 *
 * Only CLOSED and ASSIGNED positions count towards a goal, and only on the date they were closed.
 * Counting a credit the day you open it books money you have not kept yet — the position can
 * still go against you, and a goal that moves backwards is a goal nobody trusts.
 *
 * Rolled positions count too: a roll realises the original credit and opens a new position.
 */
export function premiumTotals(positions, { today, goals = DEFAULT_GOALS } = {}) {
  const realised = positions.filter((p) => p.closedAt && p.status !== 'open');

  const inRange = (from) => realised.filter((p) => p.closedAt >= from && p.closedAt <= today);
  const sum = (rows, key) => rows.reduce((total, p) => total + (p[key] ?? 0), 0);

  const period = (from) => {
    const rows = inRange(from);
    const premium = sum(rows, 'premium');
    const loss = sum(rows, 'assignmentLoss');
    return { premium: round2(premium), assignmentLoss: round2(loss), net: round2(premium - loss), count: rows.length };
  };

  const day = period(today);
  const week = period(startOfWeek(today));
  const month = period(`${today.slice(0, 7)}-01`);

  const open = positions.filter((p) => p.status === 'open');

  return {
    today: { ...day, goal: goals.daily, progress: progress(day.net, goals.daily) },
    week: { ...week, goal: goals.weekly, progress: progress(week.net, goals.weekly), from: startOfWeek(today) },
    month: { ...month, goal: goals.monthly, progress: progress(month.net, goals.monthly) },

    // Credit on positions still live. Not counted towards a goal, and labelled as such, because
    // it is money at risk rather than money kept.
    openPremium: round2(sum(open, 'premium')),
    openCount: open.length,
  };
}

/** Monday, because a trading week does. */
export function startOfWeek(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7; // Sunday is 0, and belongs to the week that just ended
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

const progress = (value, goal) => (goal > 0 ? round2(value / goal) : null);
const round2 = (x) => Math.round(x * 100) / 100;

/** Goals, tidied — they are typed into a settings form and a negative target is not a target. */
export function cleanGoals(raw) {
  const pick = (key) => {
    const value = n(raw?.[key]);
    return value != null && value >= 0 ? round2(value) : DEFAULT_GOALS[key];
  };
  return { daily: pick('daily'), weekly: pick('weekly'), monthly: pick('monthly') };
}

/**
 * The order the table reads in: open positions first, soonest expiry at the top, because that is
 * what needs attention. Everything settled sinks, newest first.
 */
export function sortPositions(positions) {
  return [...positions].sort((a, b) => {
    const aOpen = a.status === 'open';
    const bOpen = b.status === 'open';
    if (aOpen !== bOpen) return aOpen ? -1 : 1;

    if (aOpen) return a.expiration.localeCompare(b.expiration) || a.symbol.localeCompare(b.symbol);
    return (b.closedAt ?? '').localeCompare(a.closedAt ?? '') || a.symbol.localeCompare(b.symbol);
  });
}
