// The put credit spread simulator: pick two legs off a chain, then ask what the position is worth
// at any underlying price, on any date up to expiry, with implied vol moved up or down.
//
// Like pricing.js this runs in the browser, so it is pure and synchronous. The page recomputes
// the whole curve on every slider tick; at ~250 prices × 2 legs that is well under a millisecond.
//
// The headline numbers (credit, max loss, break-even, probability of profit, expected value)
// deliberately use the same formulas as the screener, so a spread you open from a screener row
// shows the same figures on both pages. There is a test that holds the two to each other.

import { daysBetween, mid, probabilityAbove, probabilityBelow, round } from './math.js';
import { expectedValue } from './metrics.js';
import { bsGreeks, bsPrice, DEFAULT_RATE, expectedMove, strikeForDelta } from './pricing.js';

export const CONTRACT_MULTIPLIER = 100;
const DAYS_PER_YEAR = 365;
const MIN_VOL = 0.01;

// ---------------------------------------------------------------------------------------------
// Choosing the legs
// ---------------------------------------------------------------------------------------------

/**
 * Picks the short and long put from a chain.
 *
 * @param {object} chain       { spot, options: [...] } as the providers return it
 * @param {object} selection
 *   by           'delta' | 'strike'
 *   shortDelta   magnitude, e.g. 0.20 — used when by === 'delta'
 *   shortStrike  used when by === 'strike'
 *   width        distance to the long strike, in dollars
 *   longStrike   optional: an explicit long strike, which overrides width
 * @param {number} atmIv       fallback vol for strikes with no delta of their own
 * @param {number} years       time to expiry, for that fallback
 * @returns {{ shortLeg, longLeg } | { error: string }}
 */
export function pickPutSpread(chain, selection, { atmIv, years } = {}) {
  const puts = (chain.options ?? [])
    .filter((o) => o.type === 'put' && o.strike > 0)
    .sort((a, b) => a.strike - b.strike);

  if (puts.length < 2) return { error: 'This expiry has fewer than two put strikes listed.' };

  let shortLeg;
  let note = null;

  if (selection.by === 'strike') {
    shortLeg = nearest(puts, (o) => Math.abs(o.strike - selection.shortStrike));
  } else {
    const target = Math.abs(selection.shortDelta ?? 0.2);

    // Only strikes with something listed below them can be the short leg of a spread. Without
    // this, a low target delta on a thin chain lands on the lowest strike and there is no put
    // left to buy as protection — the page would show an error where it should show a spread.
    const eligible = puts.slice(1);

    // Only a strike that is listed can be traded, so this picks the listed put nearest the target
    // delta. Where the feed has no delta for a strike (quiet strikes often lack greeks), it is
    // computed from that strike's IV, or the at-the-money IV failing that.
    const withDelta = eligible
      .map((o) => ({ o, d: Math.abs(o.delta ?? putDelta(o, chain.spot, years, atmIv)) }))
      .filter(({ d }) => Number.isFinite(d));

    if (withDelta.length === 0) {
      // No deltas and no vol to compute them: fall back to the theoretical strike for the delta.
      const k = strikeForDelta('put', target, chain.spot, years, atmIv);
      shortLeg = nearest(eligible, (o) => Math.abs(o.strike - k));
    } else {
      const best = nearest(withDelta, ({ d }) => Math.abs(d - target));
      shortLeg = best.o;

      // Say so when the chain cannot get close: a 0.10-delta request filled with a 0.16-delta
      // put is a materially different trade, and the slider alone would not tell you.
      if (Math.abs(best.d - target) > 0.03) {
        note =
          `No listed put with protection below it is near ${target.toFixed(2)} delta — ` +
          `the closest is ${best.d.toFixed(2)}.`;
      }
    }
  }

  if (!shortLeg) return { error: 'Could not find a short strike.' };

  const below = puts.filter((o) => o.strike < shortLeg.strike);
  if (below.length === 0) {
    return { error: `Nothing is listed below ${shortLeg.strike} to buy as protection.` };
  }

  const wantedLong =
    selection.longStrike != null ? selection.longStrike : shortLeg.strike - (selection.width ?? 5);
  const longLeg = nearest(below, (o) => Math.abs(o.strike - wantedLong));

  return { shortLeg, longLeg, note };
}

function putDelta(option, spot, years, atmIv) {
  const vol = option.iv > 0 ? option.iv : atmIv;
  if (!(vol > 0) || !(years > 0)) return NaN;
  return bsGreeks('put', spot, option.strike, years, vol).delta;
}

function nearest(items, distance) {
  let best = null;
  let bestD = Infinity;
  for (const item of items) {
    const d = distance(item);
    if (d < bestD) {
      best = item;
      bestD = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// The position
// ---------------------------------------------------------------------------------------------

/**
 * Freezes everything the rest of the simulation needs into one object.
 *
 * @param {object} p
 *   shortLeg, longLeg   options from the chain
 *   spot                underlying price now
 *   expiration, asOf    ISO dates
 *   atmIv               the expiry's at-the-money IV — drives the probabilities, as in the screener
 *   pricing             'conservative' (sell bid, buy ask) | 'mid'
 *   creditOverride      a credit you actually got filled at, per share; wins over pricing
 *   quantity            contracts
 */
export function createSpread({
  shortLeg,
  longLeg,
  spot,
  expiration,
  asOf,
  atmIv,
  pricing = 'conservative',
  creditOverride = null,
  quantity = 1,
  rate = DEFAULT_RATE,
}) {
  const creditConservative = (shortLeg.bid ?? 0) - (longLeg.ask ?? 0);
  const creditMid = (mid(shortLeg.bid, shortLeg.ask) ?? 0) - (mid(longLeg.bid, longLeg.ask) ?? 0);

  const entryCredit =
    creditOverride != null && Number.isFinite(creditOverride)
      ? creditOverride
      : pricing === 'mid'
        ? creditMid
        : creditConservative;

  const dte = Math.max(daysBetween(asOf, expiration), 0);

  return {
    type: 'put',
    short: { ...shortLeg, iv: shortLeg.iv > 0 ? shortLeg.iv : atmIv },
    long: { ...longLeg, iv: longLeg.iv > 0 ? longLeg.iv : atmIv },
    width: shortLeg.strike - longLeg.strike,
    spot,
    expiration,
    asOf,
    dte,
    atmIv,
    rate,
    quantity: Math.max(1, Math.round(quantity || 1)),
    entry: {
      credit: entryCredit,
      creditConservative,
      creditMid,
      source: creditOverride != null ? 'override' : pricing,
    },
  };
}

/**
 * Headline numbers at expiry, per `quantity` contracts.
 *
 * Probabilities use the at-the-money IV and are measured at the break-even, exactly as the
 * screener does — see metrics.js for why the break-even and not the short strike.
 */
export function summarize(spread) {
  const { short, long, width, spot, atmIv, dte, quantity, entry } = spread;
  const credit = entry.credit;
  const m = CONTRACT_MULTIPLIER * quantity;
  const years = Math.max(dte, 0.5) / DAYS_PER_YEAR;

  const isCredit = credit > 0;
  const maxLoss = width - credit;
  const breakEven = short.strike - credit;

  const probProfit = isCredit ? probabilityAbove(spot, breakEven, atmIv, years) : null;

  const warnings = [];
  if (!isCredit) {
    warnings.push(
      'At these prices this is not a credit: buying the protection costs as much as the short put pays. ' +
        'Usually a sign of an illiquid strike or a wide quote.',
    );
  } else if (!(maxLoss > 0)) {
    warnings.push('The credit is at least the width of the spread — a quote artefact, not free money.');
  }
  if (short.strike >= spot) {
    warnings.push('The short strike is at or above the current price: this put starts in the money.');
  }

  return {
    width: round(width),
    credit: round(credit),
    creditConservative: round(entry.creditConservative),
    creditMid: round(entry.creditMid),
    slippageToMid: round(entry.creditMid - entry.creditConservative),
    maxProfit: round(credit * m),
    maxLoss: round(maxLoss * m),
    breakEven: round(breakEven),
    returnOnRisk: maxLoss > 0 && isCredit ? round(credit / maxLoss, 4) : null,
    probProfit: probProfit === null ? null : round(probProfit, 4),
    probMaxProfit: round(probabilityAbove(spot, short.strike, atmIv, years) ?? NaN, 4),
    probMaxLoss: round(probabilityBelow(spot, long.strike, atmIv, years) ?? NaN, 4),
    // Per contract in the screener; scaled by quantity here because this page is about a position.
    expectedValue:
      probProfit === null || !(maxLoss > 0)
        ? null
        : round((expectedValue(probProfit, credit, maxLoss) ?? 0) * quantity),
    expectedMove: round(expectedMove(spot, atmIv, years) ?? NaN),
    dte,
    warnings,
  };
}

/**
 * Profit or loss, in dollars for the whole position, if you closed it at `price` after
 * `daysForward` days with every leg's IV moved by `ivShift` (in vol points: +5 means 20% → 25%).
 *
 * Before expiry this is a Black-Scholes value, so it is only as good as the vol assumption. At
 * expiry it is exact: each put is worth its intrinsic value.
 */
export function pnlAt(spread, price, daysForward = 0, ivShift = 0) {
  const { short, long, dte, rate, quantity, entry } = spread;
  const daysLeft = Math.max(dte - daysForward, 0);
  const years = daysLeft / DAYS_PER_YEAR;
  const shift = ivShift / 100;

  const shortValue = bsPrice('put', price, short.strike, years, Math.max(short.iv + shift, MIN_VOL), rate);
  const longValue = bsPrice('put', price, long.strike, years, Math.max(long.iv + shift, MIN_VOL), rate);

  const costToClose = shortValue - longValue;
  return (entry.credit - costToClose) * CONTRACT_MULTIPLIER * quantity;
}

/** The expiry payoff alone — no model, just intrinsic value. */
export function pnlAtExpiry(spread, price) {
  return pnlAt(spread, price, spread.dte, 0);
}

/**
 * Position greeks at a what-if point, in position terms:
 *   delta  — dollars of P&L per $1 move in the underlying (share-equivalents)
 *   gamma  — change in that delta per $1
 *   theta  — dollars per calendar day
 *   vega   — dollars per vol point
 */
export function positionGreeks(spread, price, daysForward = 0, ivShift = 0) {
  const { short, long, dte, rate, quantity } = spread;
  const years = Math.max(dte - daysForward, 0) / DAYS_PER_YEAR;
  const shift = ivShift / 100;

  const s = bsGreeks('put', price, short.strike, years, Math.max(short.iv + shift, MIN_VOL), rate);
  const l = bsGreeks('put', price, long.strike, years, Math.max(long.iv + shift, MIN_VOL), rate);
  const m = CONTRACT_MULTIPLIER * quantity;

  // Short the first leg, long the second.
  return {
    delta: round((l.delta - s.delta) * m, 2),
    gamma: round((l.gamma - s.gamma) * m, 4),
    theta: round((l.theta - s.theta) * m, 2),
    vega: round((l.vega - s.vega) * m, 2),
  };
}

// ---------------------------------------------------------------------------------------------
// What the chart and the table draw
// ---------------------------------------------------------------------------------------------

/**
 * The price range worth drawing: comfortably past both strikes and ±2.5 standard deviations of
 * the move to expiry, so the flat parts of the payoff are visible on both sides.
 */
export function priceRange(spread, sigmas = 2.5) {
  const { spot, short, long, width } = spread;
  const move = expectedMove(spot, spread.atmIv, Math.max(spread.dte, 1) / DAYS_PER_YEAR) ?? spot * 0.1;

  const lo = Math.min(long.strike - width, spot - sigmas * move);
  const hi = Math.max(short.strike + width, spot + sigmas * move);
  return [Math.max(lo, 0.01), hi];
}

/**
 * Sample points for the chart: P&L at expiry and at the projected date, across the price range.
 * The strikes and the break-even are inserted exactly, so the kinks in the expiry line are drawn
 * where they are rather than wherever the sampling happens to land.
 */
export function pnlCurve(spread, { daysForward = 0, ivShift = 0, points = 240, range } = {}) {
  const [lo, hi] = range ?? priceRange(spread);
  const step = (hi - lo) / (points - 1);

  const prices = new Set();
  for (let i = 0; i < points; i++) prices.add(round(lo + i * step, 4));
  for (const p of [spread.short.strike, spread.long.strike, spread.short.strike - spread.entry.credit, spread.spot]) {
    if (p > lo && p < hi) prices.add(round(p, 4));
  }

  return [...prices]
    .sort((a, b) => a - b)
    .map((price) => ({
      price,
      expiry: pnlAtExpiry(spread, price),
      projected: pnlAt(spread, price, daysForward, ivShift),
    }));
}

/**
 * A price × date P&L table. Rows are evenly spaced prices around the current one, snapped to
 * `priceStep`, plus — as rows of their own — the price now, both strikes and the break-even.
 * Columns run from today to expiry.
 *
 * The key levels are real rows rather than tags on the nearest round-number row, because a strike
 * that falls exactly between two rows has no honest nearest row, and "what happens at my short
 * strike" deserves an exact answer, not the one five dollars away.
 */
export function pnlGrid(spread, { rows = 11, columns = 6, ivShift = 0, priceStep, keyLevels = true } = {}) {
  const { spot, dte } = spread;
  const move = expectedMove(spot, spread.atmIv, Math.max(dte, 1) / DAYS_PER_YEAR) ?? spot * 0.05;

  // Span ±2σ at expiry, in steps that are round numbers a trader would recognise.
  const rawStep = (4 * move) / (rows - 1);
  const step = priceStep ?? niceStep(rawStep);
  const centre = Math.round(spot / step) * step;
  const half = Math.floor(rows / 2);

  const levels = new Set();
  for (let i = half; i >= -half; i--) levels.add(round(centre + i * step, 4));

  const key = {
    spot: round(spot, 4),
    short: round(spread.short.strike, 4),
    breakEven: round(spread.short.strike - spread.entry.credit, 4),
    long: round(spread.long.strike, 4),
  };
  if (keyLevels) for (const v of Object.values(key)) if (v > 0) levels.add(v);

  const prices = [...levels].sort((a, b) => b - a);

  const days = [];
  for (let c = 0; c < columns; c++) days.push(Math.round((c * dte) / (columns - 1)));
  const uniqueDays = [...new Set(days)];

  return {
    prices,
    // Which row is which key level, so the table can label them without guessing.
    keyLevels: keyLevels ? key : {},
    columns: uniqueDays.map((d) => ({
      daysForward: d,
      daysLeft: dte - d,
      date: addDays(spread.asOf, d),
    })),
    // `|| 0` turns -0 into 0: rounding a tiny loss at the break-even must not print "-$0".
    values: prices.map((price) => uniqueDays.map((d) => round(pnlAt(spread, price, d, ivShift), 0) || 0)),
  };
}

/** Rounds a raw step to 1, 2, 2.5 or 5 × a power of ten. */
export function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const f = raw / power;
  const nice = f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10;
  return nice * power;
}

export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
