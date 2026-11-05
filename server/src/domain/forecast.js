// What the option market expects a price to do — the Ticker page's forecast panel.
//
// Not a prediction, and nothing here pretends to be one. Every number is read off option prices
// (implied volatility) or off the price's own past (realised volatility). Implied volatility is
// the market's price of uncertainty: it says how WIDE the range of outcomes is priced to be, and
// nothing at all about which way. So the panel draws a band, never a target.
//
// The model is the same lognormal one the screener uses, with the same weakness: real markets
// have fatter tails, so a move outside the two-sigma band happens more often than the 4.6% the
// band implies. The page says so where the band is drawn.
//
// Pure, like everything else in domain/ — the browser imports it too, so typing a price level
// answers instantly instead of costing a request.

import { normalCdf, probabilityAbove, round } from './math.js';

/** Trading days in a year: realised vol is measured on trading days, implied on calendar days. */
export const TRADING_DAYS = 252;

/** How much of the outcome each band holds under the lognormal model. */
export const BAND_COVERAGE = { 1: normalCdf(1) - normalCdf(-1), 2: normalCdf(2) - normalCdf(-2) };

/**
 * Realised (historical) volatility: the annualised standard deviation of daily log returns over
 * the last `window` returns. The yardstick implied volatility is compared against.
 *
 * Null when there are not enough closes to say — a fresh listing should read "not enough
 * history", not a confident number made from four days.
 */
export function realizedVol(bars, window = 20) {
  const closes = (bars ?? []).map((b) => b?.close).filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length < window + 1 || window < 2) return null;

  const recent = closes.slice(-(window + 1));
  const returns = [];
  for (let i = 1; i < recent.length; i++) returns.push(Math.log(recent[i] / recent[i - 1]));

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * TRADING_DAYS);
}

/**
 * The expiries worth a chain request for the forecast: the listed one nearest each target, out to
 * `maxDte`, without repeats. Four at most, so opening a ticker costs four chains — the same cap
 * the screener keeps per symbol, and from the same cache.
 */
export function pickForecastExpiries(expirations, { targets = [7, 30, 60, 90], maxDte = 120 } = {}) {
  const usable = (expirations ?? []).filter((e) => e.dte >= 1 && e.dte <= maxDte);
  const picked = new Map();

  for (const target of targets) {
    let best = null;
    for (const e of usable) {
      if (picked.has(e.date)) continue;
      if (!best || Math.abs(e.dte - target) < Math.abs(best.dte - target)) best = e;
    }
    if (best) picked.set(best.date, best);
  }

  return [...picked.values()].sort((a, b) => a.dte - b.dte);
}

/**
 * Implied volatility for any horizon, from the few expiries we have.
 *
 * Interpolates total variance (iv² × time), not the vol itself — that is the standard way, and
 * the one that cannot produce a band that narrows as time goes on. Flat beyond either end: past
 * the last expiry there is no market to read, so the panel stops drawing there anyway.
 */
export function ivAt(points, days) {
  const pts = (points ?? []).filter((p) => p.iv > 0 && p.dte > 0).sort((a, b) => a.dte - b.dte);
  if (pts.length === 0 || !(days > 0)) return null;
  if (days <= pts[0].dte) return pts[0].iv;
  if (days >= pts.at(-1).dte) return pts.at(-1).iv;

  const upper = pts.findIndex((p) => p.dte >= days);
  const a = pts[upper - 1];
  const b = pts[upper];
  const va = a.iv * a.iv * a.dte;
  const vb = b.iv * b.iv * b.dte;
  const v = va + ((vb - va) * (days - a.dte)) / (b.dte - a.dte);
  return Math.sqrt(Math.max(v, 0) / days);
}

/**
 * The price band `sigmas` wide, `days` from now, at volatility `iv`.
 *
 * Symmetric in log terms around today's price — so the upper edge is further away in dollars
 * than the lower one, which is what a lognormal price does and why the band leans upward.
 */
export function expectedRange(spot, iv, days, sigmas = 1) {
  if (!(spot > 0) || !(iv > 0) || !(days > 0)) return null;
  const move = sigmas * iv * Math.sqrt(days / 365);
  return { low: round(spot * Math.exp(-move), 2), high: round(spot * Math.exp(move), 2) };
}

/**
 * The cone: one and two-sigma bands at every `step` days out to the last expiry, plus a row at
 * each expiry itself so the table and the chart's markers land on real listed dates.
 */
export function forecastCone(spot, points, { step = 1 } = {}) {
  const pts = (points ?? []).filter((p) => p.iv > 0 && p.dte > 0);
  if (!(spot > 0) || pts.length === 0) return [];

  const last = Math.max(...pts.map((p) => p.dte));
  const days = new Set([0, ...pts.map((p) => p.dte)]);
  for (let d = step; d < last; d += step) days.add(d);

  return [...days]
    .sort((a, b) => a - b)
    .map((d) => {
      if (d === 0) return { days: 0, iv: null, one: { low: spot, high: spot }, two: { low: spot, high: spot } };
      const iv = ivAt(pts, d);
      return {
        days: d,
        iv,
        one: expectedRange(spot, iv, d, 1),
        two: expectedRange(spot, iv, d, 2),
        expiry: pts.find((p) => p.dte === d)?.date ?? null,
      };
    });
}

/**
 * The odds for one price level by one date: finishing above it, finishing below it, and touching
 * it at any point before then.
 *
 * Touch uses the reflection principle — for a driftless random walk, the chance of reaching a
 * level is twice the chance of ending beyond it. It is an approximation (it ignores drift and the
 * fat tails), but a good one over weeks, and it answers the question a stop or a roll is really
 * about: not "where will it close" but "will it get there at all".
 */
export function levelOdds({ spot, level, iv, days, riskFree = 0.04 }) {
  if (!(spot > 0) || !(level > 0) || !(iv > 0) || !(days > 0)) return null;

  const years = days / 365;
  const above = probabilityAbove(spot, level, iv, years, riskFree);
  const below = 1 - above;
  const beyond = level >= spot ? above : below;

  return {
    above,
    below,
    touch: level === spot ? 1 : Math.min(1, 2 * beyond),
    side: level >= spot ? 'above' : 'below',
    move: level / spot - 1,
  };
}

/**
 * Implied against realised: are the options priced for bigger moves than the price has actually
 * been making? The gap premium sellers are paid for, and the one thing the screener cannot see.
 *
 * Compared with the 20-day figure, the closest in horizon to a month of implied vol. The bands
 * are deliberately wide — a ratio of 1.1 is noise, not a signal.
 */
export function volComparison({ implied, realized20, realized60 }) {
  if (!(implied > 0) || !(realized20 > 0)) return null;

  const ratio = implied / realized20;
  const verdict = ratio >= 1.25 ? 'rich' : ratio <= 0.85 ? 'cheap' : 'fair';

  return {
    ratio: round(ratio, 2),
    verdict,
    gapPts: round((implied - realized20) * 100, 1),
    against60: realized60 > 0 ? round(implied / realized60, 2) : null,
  };
}

/** Plain words for each verdict — said on the page, so a ratio is never left to interpret. */
export const VOL_VERDICTS = {
  rich: 'Options are priced for bigger moves than the stock has been making. That gap is the cushion a premium seller is paid for — and it is often there because the market expects news.',
  fair: 'Options are priced about in line with how much the stock has actually been moving.',
  cheap: 'Options are priced for smaller moves than the stock has been making. Selling premium pays less for the risk here; buying it costs less than usual.',
};
