// Dividends: what a holding pays, when it pays it, and how likely that is to continue.
//
// WHAT THIS DOES AND DOES NOT DO, because the difference matters more here than anywhere else in
// the app. Projecting a DECLARED dividend forward is arithmetic: a rate, a frequency and a date
// give you a schedule, and the schedule is exact. Predicting whether a company will RAISE or CUT
// is not arithmetic, and nothing in this file claims to. What it does instead is compute the
// projection and, separately, report the two or three measurable things that tend to precede a
// cut — a payout above earnings, a yield far above the company's own history — each labelled as
// the observation it is rather than dressed up as a forecast.
//
// The consequence worth knowing: sorting by yield alone puts the about-to-be-cut names on top. A
// 14% yield is usually the market saying it does not believe the payment, not a bargain nobody
// noticed. That is why every row carries a risk label and why the screen refuses to rank on yield
// without showing it.
//
// Pure, so the browser imports it through the @domain alias and shows the same figures the server
// computes rather than its own rounding of them.

import { SYMBOL_PATTERN } from './watchlist.js';

/** How often it pays, and what that means in payments per year. */
export const FREQUENCIES = {
  monthly: { label: 'Monthly', perYear: 12, months: 1 },
  quarterly: { label: 'Quarterly', perYear: 4, months: 3 },
  semiannual: { label: 'Twice a year', perYear: 2, months: 6 },
  annual: { label: 'Once a year', perYear: 1, months: 12 },
};

export const DEFAULT_FREQUENCY = 'quarterly';

/** How many holdings one account may track. A screen, not a portfolio accounting system. */
export const MAX_HOLDINGS = 60;

export const MAX_NOTE = 200;

/** Projection window offered on the page, in months. */
export const HORIZONS = [12, 24, 36];
export const DEFAULT_HORIZON = 12;

/**
 * Where a row's dividend figures came from. Shown on every row, because "the broker told me" and
 * "I typed it in nine months ago" deserve different amounts of trust and the page should not
 * quietly blend them.
 */
export const SOURCES = {
  provider: { label: 'From your data provider' },
  typed: { label: 'You entered this' },
  none: { label: 'Not set' },
};

const n = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/**
 * A real calendar day, written as YYYY-MM-DD.
 *
 * The round-trip is the whole test: Date.parse happily accepts "2026-02-31" and rolls it forward
 * to 3 March, so a shape check plus a parse check still lets an impossible date through — and then
 * Postgres rejects it on the way into a DATE column, turning a typo into a 500.
 */
const isIsoDate = (v) =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

const clampNote = (v) => String(v ?? '').trim().slice(0, MAX_NOTE);

/** A date-only UTC day, so nothing shifts by one west of Greenwich. */
const day = (iso) => new Date(`${iso}T00:00:00Z`);

export const isoDay = (date) => new Date(date).toISOString().slice(0, 10);

/** Whole calendar months added to an ISO date, clamped to the end of a short month. */
export function addMonths(iso, months) {
  const d = day(iso);
  const target = d.getUTCMonth() + months;
  const end = new Date(Date.UTC(d.getUTCFullYear(), target + 1, 0)).getUTCDate();

  return isoDay(new Date(Date.UTC(d.getUTCFullYear(), target, Math.min(d.getUTCDate(), end))));
}

export const daysBetweenDates = (from, to) => Math.round((day(to) - day(from)) / 86_400_000);

/**
 * Tidies one holding into the shape that gets stored.
 *
 * Null, not zero, for anything blank — an unset rate is not a rate of nothing, and a holding with
 * no share count is still worth watching for its yield. Number('') is 0, which is how an empty box
 * becomes a figure that looks like data.
 *
 * Returns null when there is no usable symbol, which is the only thing a row cannot do without.
 */
export function cleanHolding(raw = {}) {
  const symbol = String(raw.symbol ?? '').trim().toUpperCase();
  if (!SYMBOL_PATTERN.test(symbol)) return null;

  const shares = n(raw.shares);
  const costBasis = n(raw.costBasis);
  const annualRate = n(raw.annualRate);

  return {
    symbol,
    // Fractional shares are real, and negative ones are not.
    shares: shares === null ? null : Math.max(0, round(shares, 4)),
    // Per share, as a broker reports an average price.
    costBasis: costBasis === null ? null : Math.max(0, round(costBasis, 4)),
    // Dollars per share per YEAR, not per payment. One unit everywhere, converted at the edges —
    // the alternative is a field whose meaning depends on the frequency beside it.
    annualRate: annualRate === null ? null : Math.max(0, round(annualRate, 4)),
    frequency: FREQUENCIES[raw.frequency] ? raw.frequency : DEFAULT_FREQUENCY,
    nextExDate: isIsoDate(raw.nextExDate) ? raw.nextExDate : null,
    note: clampNote(raw.note),
  };
}

const round = (x, dp) => Math.round(x * 10 ** dp) / 10 ** dp;

/** What one payment is worth per share. */
export function perPayment(annualRate, frequency) {
  const rate = n(annualRate);
  const per = FREQUENCIES[frequency]?.perYear;
  if (rate === null || !per) return null;
  return round(rate / per, 4);
}

/** Annual rate over price, as a fraction. Null rather than 0 when either side is missing. */
export function yieldOf(annualRate, price) {
  const rate = n(annualRate);
  const p = n(price);
  if (rate === null || p === null || p <= 0) return null;
  return round(rate / p, 6);
}

/** Dollars a year at the current rate. Not a promise — the rate is what is declared today. */
export function annualIncome(shares, annualRate) {
  const s = n(shares);
  const rate = n(annualRate);
  if (s === null || rate === null) return null;
  return round(s * rate, 2);
}

/**
 * The next payments, projected forward from the known ex-date.
 *
 * Every date after the first is this one plus whole months, because that is genuinely all that can
 * be said: companies keep an approximate cadence, not an exact one, and inventing a day of the
 * week for a payment fourteen months out would be false precision. The AMOUNTS assume the rate
 * does not change, which is the assumption, not a prediction — `risk` below is where the chance of
 * it changing is reported.
 *
 * Returns [] rather than throwing when the rate or the date is missing: a holding you have not
 * filled in yet is a normal state, not an error.
 */
export function schedule({ annualRate, frequency, nextExDate, shares }, { months = DEFAULT_HORIZON, asOf } = {}) {
  const amount = perPayment(annualRate, frequency);
  const step = FREQUENCIES[frequency]?.months;
  if (amount === null || !step || !isIsoDate(nextExDate)) return [];

  const from = isIsoDate(asOf) ? asOf : isoDay(new Date());
  const until = addMonths(from, months);

  const out = [];
  let exDate = nextExDate;

  // A date already past means the stored one is stale — step it forward to the next one that has
  // not happened rather than reporting payments that are behind us as income to come.
  let guard = 0;
  while (exDate < from && guard++ < 480) exDate = addMonths(exDate, step);

  while (exDate <= until && out.length < 60) {
    out.push({
      exDate,
      perShare: amount,
      amount: shares == null ? null : round(shares * amount, 2),
      daysAway: daysBetweenDates(from, exDate),
      // True once the stored date has been carried forward, so the page can say the first one is
      // an estimate rather than a date the company announced.
      estimated: exDate !== nextExDate,
    });
    exDate = addMonths(exDate, step);
  }

  return out;
}

/** What the schedule adds up to over the window. Null share count means per-share totals only. */
export function projectIncome(holding, options = {}) {
  const payments = schedule(holding, options);

  return {
    payments,
    perShare: round(payments.reduce((sum, p) => sum + p.perShare, 0), 4),
    total: holding.shares == null ? null : round(payments.reduce((sum, p) => sum + (p.amount ?? 0), 0), 2),
  };
}

/**
 * Turns a provider's list of past payments into the few figures the screen needs.
 *
 * Everything here is derived from payments that actually happened, which is why it is worth doing
 * rather than asking someone to type it: the cadence comes from the gaps between them, the forward
 * rate from the most recent one, and the streak from the yearly totals. The one judgement is the
 * next ex-date, which is the last one plus the cadence — companies keep an approximate schedule,
 * so it is close, and the page says it is an estimate.
 *
 * `annualRate` is the INDICATED rate — the latest payment annualised — not the trailing twelve
 * months. They differ exactly when a company has just changed its dividend, which is the moment
 * the difference matters: trailing would keep quoting the old, higher number for a year after a
 * cut. Both are returned, so the page can show the gap rather than pick a side silently.
 *
 * Returns null when there is nothing usable, which is the normal answer for a symbol that has
 * never paid a dividend.
 */
export function summariseHistory(history, { asOf } = {}) {
  const paid = (Array.isArray(history) ? history : [])
    .map((e) => ({ exDate: e?.exDate, payDate: e?.payDate ?? null, amount: n(e?.amount) }))
    .filter((e) => isIsoDate(e.exDate) && e.amount !== null && e.amount > 0)
    .sort((a, b) => a.exDate.localeCompare(b.exDate));

  if (paid.length === 0) return null;

  const latest = paid.at(-1);
  const frequency = inferFrequency(paid);
  const per = FREQUENCIES[frequency].perYear;
  const from = isIsoDate(asOf) ? asOf : isoDay(new Date());

  const trailing = paid
    .filter((e) => daysBetweenDates(e.exDate, from) <= 365 && e.exDate <= from)
    .reduce((sum, e) => sum + e.amount, 0);

  return {
    annualRate: round(latest.amount * per, 4),
    trailing12m: trailing > 0 ? round(trailing, 4) : null,
    frequency,
    lastExDate: latest.exDate,
    lastPayDate: latest.payDate,
    // Rolled forward until it is actually in the future. One step past the last payment is only
    // "next" if that payment was within the last cycle; a company that is late, or a history that
    // stops short, would otherwise put a date that has already been and gone in a column headed
    // "next ex-date" — and the schedule below would disagree with it.
    nextExDate: nextAfter(latest.exDate, FREQUENCIES[frequency].months, from),
    ...yearOverYear(paid, from),
    payments: paid.length,
  };
}

/** The first date after `from`, stepping `months` at a time from `last`. */
function nextAfter(last, months, from) {
  let date = addMonths(last, months);
  let guard = 0;
  while (date <= from && guard++ < 480) date = addMonths(date, months);
  return date;
}

/**
 * The cadence, from the gaps between the last few payments rather than from a field.
 *
 * Providers disagree about how to spell "quarterly", and some leave it out; the dates are always
 * there. Four gaps rather than all of them, because a company that moved from annual to quarterly
 * years ago pays quarterly now, and the median over its whole history would say otherwise.
 */
function inferFrequency(paid) {
  if (paid.length < 2) return DEFAULT_FREQUENCY;

  const recent = paid.slice(-5);
  const gaps = recent.slice(1).map((e, i) => daysBetweenDates(recent[i].exDate, e.exDate)).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];

  let best = DEFAULT_FREQUENCY;
  for (const [name, { perYear }] of Object.entries(FREQUENCIES)) {
    if (Math.abs(median - 365 / perYear) < Math.abs(median - 365 / FREQUENCIES[best].perYear)) best = name;
  }
  return best;
}

/**
 * The streak, and the most recent cut — both from the yearly totals.
 *
 * A cut that actually happened is the strongest honest signal in this file. It is a fact about the
 * past rather than a guess about the future, it is right there in the payment history, and a
 * company that has cut once is telling you something a payout ratio only hints at.
 *
 * The current year is excluded from both: it is incomplete, so its total is always lower and would
 * read as a cut every January. A year with no payment at all ends the streak, which is the point —
 * that is what a suspension looks like in this data.
 */
function yearOverYear(paid, asOf) {
  const thisYear = Number(asOf.slice(0, 4));

  const byYear = new Map();
  for (const e of paid) {
    const year = Number(e.exDate.slice(0, 4));
    if (year >= thisYear) continue;
    byYear.set(year, round((byYear.get(year) ?? 0) + e.amount, 4));
  }
  if (byYear.size === 0) return { streakYears: null, lastCut: null };

  const years = [...byYear.keys()].sort((a, b) => a - b);

  let lastCut = null;
  for (let i = 1; i < years.length; i++) {
    const [before, after] = [byYear.get(years[i - 1]), byYear.get(years[i])];
    // A hair below counts as flat: a quarter that lands either side of New Year moves an annual
    // total by a fraction of a percent, and that is a calendar artefact, not a decision.
    if (after < before * 0.98) lastCut = { year: years[i], from: before, to: after };
  }

  let streak = 0;
  for (let year = thisYear - 1; byYear.has(year); year--) {
    const previous = byYear.get(year - 1);
    if (previous !== undefined && byYear.get(year) < previous * 0.98) break;
    streak += 1;
  }

  return { streakYears: streak, lastCut };
}

/**
 * How stretched the payment looks, in four words and a reason.
 *
 * NOT a prediction, and the labels are chosen to keep it from reading as one: "covered" says the
 * earnings are there today, not that the dividend is safe. Every level carries its reasons in
 * plain language, and the level is always paired with that text — a colour alone on a risk reading
 * is unreadable to anyone who cannot distinguish the colours, and ambiguous to everyone else.
 *
 *   lastCut     — a year whose total came in under the one before. The strongest signal here, and
 *                 the only one that is a fact rather than an inference: it already happened.
 *   yield       — a yield far above what the market pays generally is usually the market pricing
 *                 in a cut rather than an opportunity nobody else noticed.
 *   payoutRatio — annual dividend over annual earnings per share, when anything supplies it. Above
 *                 1 means it is paying out more than it earns, which it can do for a while out of
 *                 cash and not forever.
 */
export function cutRisk({ annualRate, price, payoutRatio, streakYears, lastCut } = {}) {
  const ratio = n(payoutRatio);
  const y = yieldOf(annualRate, price);
  const streak = n(streakYears);

  const reasons = [];
  let level = 'unknown';

  const raise = (next) => {
    const order = ['unknown', 'covered', 'watch', 'stretched'];
    if (order.indexOf(next) > order.indexOf(level)) level = next;
  };

  if (ratio !== null) {
    if (ratio > 1) {
      raise('stretched');
      reasons.push(`Pays out ${pct(ratio)} of earnings — more than it earns.`);
    } else if (ratio > 0.8) {
      raise('watch');
      reasons.push(`Pays out ${pct(ratio)} of earnings, leaving little room.`);
    } else {
      raise('covered');
      reasons.push(`Pays out ${pct(ratio)} of earnings.`);
    }
  }

  if (y !== null) {
    if (y > 0.1) {
      raise('stretched');
      reasons.push(`A ${pct(y)} yield usually means the market expects a cut.`);
    } else if (y > 0.07) {
      raise('watch');
      reasons.push(`${pct(y)} is high enough to be worth asking why.`);
    }
  }

  // A cut that already happened outranks everything else here, because it is the only item on this
  // list that is a fact rather than an inference from a ratio.
  if (lastCut?.year) {
    raise('watch');
    reasons.push(`Cut in ${lastCut.year}, from $${Number(lastCut.from).toFixed(2)} to $${Number(lastCut.to).toFixed(2)} for the year.`);
  }

  // A long record never LOWERS a level — plenty of long streaks ended the quarter after someone
  // pointed out how long they were — but it does lift one off "no read at all". Ten years of
  // uninterrupted payments is evidence; calling that "not enough data" would be the page refusing
  // to read what is in front of it.
  if (streak !== null && streak >= 10 && !lastCut) {
    raise('covered');
    reasons.push(`Held or raised for ${Math.floor(streak)} years running.`);
  } else if (streak !== null && streak >= 10) {
    reasons.push(`Held or raised for ${Math.floor(streak)} years running.`);
  } else if (streak !== null && streak > 0 && !lastCut) {
    reasons.push(`Held or raised for ${Math.floor(streak)} ${streak === 1 ? 'year' : 'years'} running.`);
  }

  if (level === 'unknown') {
    reasons.push('Too little history here to say anything either way.');
  }

  return { level, label: RISK_LABELS[level], reasons };
}

/**
 * Deliberately not "safe" and not "at risk".
 *
 * "Nothing flagged" says exactly what the app knows — that none of the three things it can measure
 * is adverse — and does not promise the dividend will be paid, which it has no way to know. A
 * label that sounded like a verdict would be read as one.
 */
export const RISK_LABELS = {
  unknown: 'No read on this',
  covered: 'Nothing flagged',
  watch: 'Worth watching',
  stretched: 'Stretched',
};

const pct = (fraction) => `${Math.round(fraction * 1000) / 10}%`;

/**
 * Whether a short call is sitting in front of an ex-dividend date.
 *
 * This is the one place dividends and the options side of the app meet, and it is a real way to
 * lose money by surprise: an in-the-money short call is assigned the day BEFORE an ex-date when
 * the dividend is worth more than the time value left in the option, because exercising to collect
 * the dividend then beats selling the contract. You wake up short the stock and owing the payment.
 *
 * `extrinsic` is what the option has left above its intrinsic value. Given it, this can say the
 * assignment is likely rather than merely possible; without it, it still flags the date, which is
 * the part worth seeing.
 */
export function exDividendWarning({ side, expiration, nextExDate, perShare: amount, extrinsic }, asOf) {
  if (side !== 'call' || !isIsoDate(nextExDate) || !isIsoDate(expiration)) return null;

  const from = isIsoDate(asOf) ? asOf : isoDay(new Date());
  if (nextExDate < from || nextExDate > expiration) return null;

  const per = n(amount);
  const left = n(extrinsic);
  const likely = per !== null && left !== null && per > left;

  return {
    exDate: nextExDate,
    daysAway: daysBetweenDates(from, nextExDate),
    perShare: per,
    extrinsic: left,
    likely,
    text: likely
      ? `Goes ex-dividend ${nextExDate}, and the $${per.toFixed(2)} payment is worth more than the $${left.toFixed(2)} of time value left — an in-the-money short call is likely to be assigned the day before.`
      : `Goes ex-dividend ${nextExDate}, before this expires. A short call that is in the money can be assigned the day before, to collect the dividend.`,
  };
}

/**
 * Orders the screen.
 *
 * Yield descending by default, which is what was asked for — but rows with nothing filled in sort
 * last whatever the key, because an empty row at the top of a ranked table reads as a zero rather
 * than as a gap.
 */
export function sortHoldings(rows, by = 'yield') {
  const key = {
    yield: (r) => r.yield,
    income: (r) => r.annualIncome,
    soonest: (r) => (r.nextExDate ? -daysBetweenDates('1970-01-01', r.nextExDate) : null),
    symbol: null,
  };

  // `in`, not `??`: sorting by symbol uses a null picker on purpose, and `??` would read that as
  // "no such key" and quietly rank by yield instead — the control would move and nothing would.
  const pick = by in key ? key[by] : key.yield;

  return [...rows].sort((a, b) => {
    if (!pick) return a.symbol.localeCompare(b.symbol);

    const x = pick(a);
    const y = pick(b);
    if (x === null && y === null) return a.symbol.localeCompare(b.symbol);
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x || a.symbol.localeCompare(b.symbol);
  });
}

/** The figures across the whole screen, for the row of tiles at the top. */
export function totals(rows, options = {}) {
  const held = rows.filter((r) => r.shares > 0 && r.annualRate !== null);

  const income = held.reduce((sum, r) => sum + (r.annualIncome ?? 0), 0);
  const value = held.reduce((sum, r) => sum + (r.price === null ? 0 : r.shares * r.price), 0);
  const cost = held.reduce((sum, r) => sum + (r.costBasis === null ? 0 : r.shares * r.costBasis), 0);

  const projected = rows.reduce((sum, r) => sum + (projectIncome(r, options).total ?? 0), 0);

  return {
    holdings: rows.length,
    paying: held.length,
    annualIncome: round(income, 2),
    monthlyAverage: round(income / 12, 2),
    marketValue: value > 0 ? round(value, 2) : null,
    // On what the shares are worth now, and on what they cost — the second is the one that climbs
    // when a company raises its dividend, which is the whole argument for holding these.
    portfolioYield: value > 0 ? round(income / value, 6) : null,
    yieldOnCost: cost > 0 ? round(income / cost, 6) : null,
    projected: round(projected, 2),
  };
}
