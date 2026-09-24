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

/** A strike's delta from its own IV, for feeds that omit greeks on quiet strikes. */
function optionDelta(type, option, spot, years, atmIv) {
  const vol = option.iv > 0 ? option.iv : atmIv;
  if (!(vol > 0) || !(years > 0)) return NaN;
  return bsGreeks(type, spot, option.strike, years, vol).delta;
}

const putDelta = (option, spot, years, atmIv) => optionDelta('put', option, spot, years, atmIv);

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
 * Picks a single option — the long call or long put the simulator also supports.
 *
 * @param {object} chain       { spot, options: [...] }
 * @param {object} selection   { type: 'call'|'put', by: 'delta'|'strike', delta, strike }
 */
export function pickLongOption(chain, selection, { atmIv, years } = {}) {
  const type = selection.type === 'call' ? 'call' : 'put';
  const options = (chain.options ?? [])
    .filter((o) => o.type === type && o.strike > 0)
    .sort((a, b) => a.strike - b.strike);

  if (options.length === 0) return { error: `This expiry lists no ${type}s.` };

  if (selection.by === 'strike') {
    return { legs: [buy(nearest(options, (o) => Math.abs(o.strike - selection.strike)))], note: null };
  }

  const target = Math.abs(selection.delta ?? 0.4);
  const withDelta = options
    .map((o) => ({ o, d: Math.abs(o.delta ?? optionDelta(type, o, chain.spot, years, atmIv)) }))
    .filter(({ d }) => Number.isFinite(d));

  if (withDelta.length === 0) {
    const k = strikeForDelta(type, target, chain.spot, years, atmIv);
    return { legs: [buy(nearest(options, (o) => Math.abs(o.strike - k)))], note: null };
  }

  const best = nearest(withDelta, ({ d }) => Math.abs(d - target));
  const note =
    Math.abs(best.d - target) > 0.03
      ? `No listed ${type} is near ${target.toFixed(2)} delta — the closest is ${best.d.toFixed(2)}.`
      : null;

  return { legs: [buy(best.o)], note };
}

const buy = (option) => ({ ...option, action: 'buy' });
const sell = (option) => ({ ...option, action: 'sell' });

/** +1 for a leg you sold (closing it costs money), -1 for one you bought (closing it pays). */
const legSign = (leg) => (leg.action === 'sell' ? 1 : -1);

/**
 * Freezes everything the rest of the simulation needs into one object.
 *
 * A position is a list of legs, not a special case per strategy: the P&L, the greeks and the
 * chart are then the same code for a two-legged spread and a single long option. Only the
 * headline numbers at expiry — max profit, max loss, break-even — differ by kind, because that
 * is where the shapes genuinely differ (a long call's upside has no ceiling; a spread's does).
 *
 * @param {object} p
 *   kind          'put_credit_spread' | 'long_call' | 'long_put'
 *   legs          options from the chain, each with an `action` of 'buy' or 'sell'
 *   spot          underlying price now
 *   expiration, asOf    ISO dates
 *   atmIv         the expiry's at-the-money IV — drives the probabilities, as in the screener
 *   pricing       'conservative' (sell the bid, buy the ask) | 'mid'
 *   netOverride   the net you actually filled at, per share, signed: positive is a credit
 *   quantity      contracts
 */
export function createPosition({
  kind,
  legs,
  spot,
  expiration,
  asOf,
  atmIv,
  pricing = 'conservative',
  netOverride = null,
  quantity = 1,
  rate = DEFAULT_RATE,
}) {
  // Conservative means the price you could actually be filled at on both sides: you are hit on
  // the bid when you sell and you pay the ask when you buy. Mid flatters every multi-leg order.
  const netConservative = legs.reduce(
    (sum, leg) => sum + (leg.action === 'sell' ? (leg.bid ?? 0) : -(leg.ask ?? 0)),
    0,
  );
  const netMid = legs.reduce((sum, leg) => sum + legSign(leg) * (mid(leg.bid, leg.ask) ?? 0), 0);

  const net =
    netOverride != null && Number.isFinite(netOverride)
      ? netOverride
      : pricing === 'mid'
        ? netMid
        : netConservative;

  const priced = legs.map((leg) => ({ ...leg, iv: leg.iv > 0 ? leg.iv : atmIv }));
  const dte = Math.max(daysBetween(asOf, expiration), 0);

  const position = {
    kind,
    legs: priced,
    spot,
    expiration,
    asOf,
    dte,
    atmIv,
    rate,
    quantity: Math.max(1, Math.round(quantity || 1)),
    entry: {
      net,
      netConservative,
      netMid,
      source: netOverride != null ? 'override' : pricing,
    },
  };

  // A vertical spread is read strike-by-strike often enough to be worth naming its legs.
  if (priced.length === 2) {
    position.short = priced.find((l) => l.action === 'sell');
    position.long = priced.find((l) => l.action === 'buy');
    if (position.short && position.long) {
      position.width = Math.abs(position.short.strike - position.long.strike);
    }
  }

  return position;
}

/** The put credit spread, kept as its own entry point because that is how the screener names it. */
export function createSpread({ shortLeg, longLeg, ...rest }) {
  return createPosition({ kind: 'put_credit_spread', legs: [sell(shortLeg), buy(longLeg)], ...rest });
}

export function createLongOption({ leg, type, ...rest }) {
  return createPosition({ kind: type === 'call' ? 'long_call' : 'long_put', legs: [buy(leg)], ...rest });
}

export const isCreditStrategy = (position) => position.kind === 'put_credit_spread';

/**
 * The underlying prices where the position breaks even at expiry. One for every strategy here,
 * but returned as a list because that is what the chart wants and what a condor would need.
 */
export function breakEvens(position) {
  const { kind, legs, entry } = position;

  if (kind === 'put_credit_spread') return [position.short.strike - entry.net];

  const debit = -entry.net;
  const [leg] = legs;
  return [kind === 'long_call' ? leg.strike + debit : leg.strike - debit];
}

/**
 * Headline numbers at expiry, per `quantity` contracts.
 *
 * Probabilities use the at-the-money IV and are measured at the break-even, exactly as the
 * screener does — see metrics.js for why the break-even and not the short strike.
 */
export function summarize(position) {
  const { spot, atmIv, dte, quantity, entry } = position;
  const m = CONTRACT_MULTIPLIER * quantity;
  const years = Math.max(dte, 0.5) / DAYS_PER_YEAR;
  const [breakEven] = breakEvens(position);

  const shape = isCreditStrategy(position)
    ? creditSpreadShape(position, breakEven)
    : longOptionShape(position, breakEven);

  const { maxProfit, maxLoss, probProfit, probMaxProfit, probMaxLoss, warnings } = shape;

  return {
    kind: position.kind,
    net: round(entry.net),
    // Named for what it is on this strategy, so nothing has to read a negative "credit".
    credit: entry.net > 0 ? round(entry.net) : null,
    debit: entry.net < 0 ? round(-entry.net) : null,
    netConservative: round(entry.netConservative),
    netMid: round(entry.netMid),
    // Always "what mid would have given you, versus what you took" — positive means mid is better.
    slippageToMid: round(entry.netMid - entry.netConservative),
    width: position.width == null ? null : round(position.width),

    maxProfit: maxProfit === null ? null : round(maxProfit * m),
    maxLoss: round(maxLoss * m),
    breakEven: round(breakEven),
    returnOnRisk: maxProfit !== null && maxLoss > 0 ? round(maxProfit / maxLoss, 4) : null,

    probProfit: probProfit === null ? null : round(probProfit, 4),
    probMaxProfit: probMaxProfit === null ? null : round(probMaxProfit, 4),
    probMaxLoss: probMaxLoss === null ? null : round(probMaxLoss, 4),

    // Two outcomes only, so it is meaningful for a spread and not for a long option, whose
    // upside is a distribution rather than a number. Left null rather than faked — see the note
    // on expectedValue in metrics.js.
    expectedValue:
      isCreditStrategy(position) && probProfit !== null && maxLoss > 0 && maxProfit !== null
        ? round((expectedValue(probProfit, maxProfit, maxLoss) ?? 0) * quantity)
        : null,

    expectedMove: round(expectedMove(spot, atmIv, years) ?? NaN),
    dte,
    warnings,
  };
}

function creditSpreadShape(position, breakEven) {
  const { short, long, width, spot, atmIv, dte, entry } = position;
  const years = Math.max(dte, 0.5) / DAYS_PER_YEAR;

  const credit = entry.net;
  const isCredit = credit > 0;
  const maxLoss = width - credit;

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
    maxProfit: credit,
    maxLoss,
    probProfit: isCredit ? probabilityAbove(spot, breakEven, atmIv, years) : null,
    probMaxProfit: probabilityAbove(spot, short.strike, atmIv, years),
    probMaxLoss: probabilityBelow(spot, long.strike, atmIv, years),
    warnings,
  };
}

function longOptionShape(position, breakEven) {
  const { kind, legs, spot, atmIv, dte, entry } = position;
  const years = Math.max(dte, 0.5) / DAYS_PER_YEAR;
  const [leg] = legs;

  const debit = -entry.net;
  const call = kind === 'long_call';

  const warnings = [];
  if (!(debit > 0)) {
    warnings.push('These quotes do not price this option above zero — an empty or stale book.');
  }
  // The move needed to break even, stated against what the market is pricing in, because "it
  // needs to rise 9%" means little until you know one standard deviation is 4%.
  const move = expectedMove(spot, atmIv, years);
  const needed = Math.abs(breakEven - spot);
  if (move > 0 && needed > move) {
    warnings.push(
      `Break-even is ${(needed / move).toFixed(1)}× the expected move away. The market is not pricing ` +
        'a move that big by expiry, which is why the option is this cheap.',
    );
  }

  return {
    // A long call's upside has no ceiling; a long put's is the strike going to zero.
    maxProfit: call ? null : leg.strike - debit,
    maxLoss: debit,
    probProfit: call
      ? probabilityAbove(spot, breakEven, atmIv, years)
      : probabilityBelow(spot, breakEven, atmIv, years),
    // "Max profit" is unbounded for a call, so the honest companion number is the chance of
    // finishing worthless — which is also the chance of losing the whole debit.
    probMaxProfit: null,
    probMaxLoss: call
      ? probabilityBelow(spot, leg.strike, atmIv, years)
      : probabilityAbove(spot, leg.strike, atmIv, years),
    warnings,
  };
}

/**
 * Profit or loss, in dollars for the whole position, if you closed it at `price` after
 * `daysForward` days with every leg's IV moved by `ivShift` (in vol points: +5 means 20% → 25%).
 *
 * Before expiry this is a Black-Scholes value, so it is only as good as the vol assumption. At
 * expiry it is exact: each option is worth its intrinsic value.
 */
export function pnlAt(position, price, daysForward = 0, ivShift = 0) {
  const { legs, dte, rate, quantity, entry } = position;
  const years = Math.max(dte - daysForward, 0) / DAYS_PER_YEAR;
  const shift = ivShift / 100;

  const costToClose = legs.reduce(
    (sum, leg) =>
      sum + legSign(leg) * bsPrice(leg.type, price, leg.strike, years, Math.max(leg.iv + shift, MIN_VOL), rate),
    0,
  );

  return (entry.net - costToClose) * CONTRACT_MULTIPLIER * quantity;
}

/** The expiry payoff alone — no model, just intrinsic value. */
export function pnlAtExpiry(position, price) {
  return pnlAt(position, price, position.dte, 0);
}

/**
 * Position greeks at a what-if point, in position terms:
 *   delta  — dollars of P&L per $1 move in the underlying (share-equivalents)
 *   gamma  — change in that delta per $1
 *   theta  — dollars per calendar day
 *   vega   — dollars per vol point
 */
export function positionGreeks(position, price, daysForward = 0, ivShift = 0) {
  const { legs, dte, rate, quantity } = position;
  const years = Math.max(dte - daysForward, 0) / DAYS_PER_YEAR;
  const shift = ivShift / 100;
  const m = CONTRACT_MULTIPLIER * quantity;

  const total = { delta: 0, gamma: 0, theta: 0, vega: 0 };

  for (const leg of legs) {
    const g = bsGreeks(leg.type, price, leg.strike, years, Math.max(leg.iv + shift, MIN_VOL), rate);
    // -legSign: a bought leg adds its greeks to the position, a sold leg subtracts them.
    const sign = -legSign(leg);
    for (const key of Object.keys(total)) total[key] += sign * g[key];
  }

  return {
    delta: round(total.delta * m, 2),
    gamma: round(total.gamma * m, 4),
    theta: round(total.theta * m, 2),
    vega: round(total.vega * m, 2),
  };
}

// ---------------------------------------------------------------------------------------------
// What the chart and the table draw
// ---------------------------------------------------------------------------------------------

/**
 * The price range worth drawing: comfortably past both strikes and ±2.5 standard deviations of
 * the move to expiry, so the flat parts of the payoff are visible on both sides.
 */
export function priceRange(position, sigmas = 2.5) {
  const { spot, legs } = position;
  const move = expectedMove(spot, position.atmIv, Math.max(position.dte, 1) / DAYS_PER_YEAR) ?? spot * 0.1;

  const strikes = legs.map((l) => l.strike);
  // A margin around the strikes so the flat parts of the payoff are visible rather than clipped
  // at the kink. On a one-legged position there is no width to borrow, so use the expected move.
  const pad = Math.max(Math.max(...strikes) - Math.min(...strikes), move * 0.5);

  const lo = Math.min(Math.min(...strikes) - pad, spot - sigmas * move);
  const hi = Math.max(Math.max(...strikes) + pad, spot + sigmas * move);
  return [Math.max(lo, 0.01), hi];
}

/**
 * Sample points for the chart: P&L at expiry and at the projected date, across the price range.
 * The strikes and the break-even are inserted exactly, so the kinks in the expiry line are drawn
 * where they are rather than wherever the sampling happens to land.
 */
export function pnlCurve(position, { daysForward = 0, ivShift = 0, points = 240, range } = {}) {
  const [lo, hi] = range ?? priceRange(position);
  const step = (hi - lo) / (points - 1);

  const prices = new Set();
  for (let i = 0; i < points; i++) prices.add(round(lo + i * step, 4));
  for (const p of [...position.legs.map((l) => l.strike), ...breakEvens(position), position.spot]) {
    if (p > lo && p < hi) prices.add(round(p, 4));
  }

  return [...prices]
    .sort((a, b) => a - b)
    .map((price) => ({
      price,
      expiry: pnlAtExpiry(position, price),
      projected: pnlAt(position, price, daysForward, ivShift),
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
export function pnlGrid(position, { rows = 11, columns = 6, ivShift = 0, priceStep, keyLevels = true } = {}) {
  const { spot, dte } = position;
  const move = expectedMove(spot, position.atmIv, Math.max(dte, 1) / DAYS_PER_YEAR) ?? spot * 0.05;

  // Span ±2σ at expiry, in steps that are round numbers a trader would recognise.
  const rawStep = (4 * move) / (rows - 1);
  const step = priceStep ?? niceStep(rawStep);
  const centre = Math.round(spot / step) * step;
  const half = Math.floor(rows / 2);

  const levels = new Set();
  for (let i = half; i >= -half; i--) levels.add(round(centre + i * step, 4));

  const key = { spot: round(spot, 4), breakEven: round(breakEvens(position)[0], 4) };
  for (const leg of position.legs) {
    // "short 540" / "long 535" on a spread; just "strike" when there is only one leg.
    key[position.legs.length > 1 ? leg.action === 'sell' ? 'short' : 'long' : 'strike'] = round(leg.strike, 4);
  }
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
      date: addDays(position.asOf, d),
    })),
    // `|| 0` turns -0 into 0: rounding a tiny loss at the break-even must not print "-$0".
    values: prices.map((price) => uniqueDays.map((d) => round(pnlAt(position, price, d, ivShift), 0) || 0)),
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
