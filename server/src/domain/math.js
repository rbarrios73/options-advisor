// Probability and pricing helpers.
//
// Everything here is a closed-form approximation under the usual lognormal assumption. That is
// worth stating plainly: these numbers describe what the market is currently pricing in, not what
// will happen. Two consequences you should keep in mind when reading a score:
//
//   • The probabilities come from implied volatility. IV is the market's price of uncertainty,
//     not a forecast, and it is systematically higher than realised volatility for index options
//     — which is exactly why selling premium has an edge, and also why these probabilities look
//     a little pessimistic for sellers.
//   • A lognormal model has thin tails compared with real markets. Anything that depends on the
//     tail (max loss on a short spread) is more likely than the model says.

/** Standard normal CDF (Abramowitz & Stegun 26.2.17, |error| < 7.5e-8). */
export function normalCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;

  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);

  return 0.5 * (1 + sign * y);
}

/**
 * Probability that the underlying finishes at or above `strike` at expiry — N(d2) under a
 * lognormal diffusion. Returns null when the inputs cannot support an answer (no vol, no time),
 * because a fabricated 0 or 1 here would quietly poison every score downstream.
 *
 * @param {number} spot        current underlying price
 * @param {number} strike      level to finish above
 * @param {number} iv          implied volatility, annualised (0.32 = 32%)
 * @param {number} years       time to expiry in years
 * @param {number} riskFree    annualised risk-free rate
 */
export function probabilityAbove(spot, strike, iv, years, riskFree = 0.04) {
  if (!(spot > 0) || !(strike > 0) || !(iv > 0) || !(years > 0)) return null;

  const d2 =
    (Math.log(spot / strike) + (riskFree - (iv * iv) / 2) * years) / (iv * Math.sqrt(years));
  return normalCdf(d2);
}

/** Probability of finishing at or below `strike`. */
export function probabilityBelow(spot, strike, iv, years, riskFree = 0.04) {
  const above = probabilityAbove(spot, strike, iv, years, riskFree);
  return above === null ? null : 1 - above;
}

/** Calendar days between two dates, rounded up — the way an expiry is normally counted. */
export function daysBetween(from, to) {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Math.ceil(ms / 86_400_000);
}

/** Years to expiry, floored at a bit under a day so same-day expiries do not divide by zero. */
export function yearsToExpiry(days) {
  return Math.max(days, 0.5) / 365;
}

/** Mid price, or whichever side exists when the book is one-sided. */
export function mid(bid, ask) {
  const b = Number(bid);
  const a = Number(ask);
  const hasBid = Number.isFinite(b) && b > 0;
  const hasAsk = Number.isFinite(a) && a > 0;

  if (hasBid && hasAsk) return (b + a) / 2;
  if (hasBid) return b;
  if (hasAsk) return a;
  return null;
}

/**
 * Bid/ask spread as a fraction of mid. This is the single most useful liquidity number for a
 * spread trader: it is what you actually pay to get in and out, and on a multi-leg position you
 * pay it on every leg.
 */
export function spreadPct(bid, ask) {
  const m = mid(bid, ask);
  if (m === null || !(m > 0)) return null;

  const b = Number(bid);
  const a = Number(ask);
  if (!Number.isFinite(b) || !Number.isFinite(a) || a < b) return null;

  return (a - b) / m;
}

/**
 * Liquidity score in [0, 1] from the three things that decide whether a fill is painful:
 * how wide the quote is, and how much open interest and volume sit behind it.
 * Missing inputs score 0 for their component rather than being skipped, so a chain that
 * reports nothing cannot look as good as one that reports real depth.
 */
export function liquidityScore({ bid, ask, openInterest, volume }) {
  const sp = spreadPct(bid, ask);

  // 2% wide or better is fine; 20% or worse is unusable.
  const tightness = sp === null ? 0 : clamp01((0.2 - sp) / 0.18);
  // 1000 contracts of OI is plenty; the curve is logarithmic because 10 -> 100 matters more
  // than 5000 -> 5090.
  const depth = clamp01(Math.log10(Math.max(Number(openInterest) || 0, 1)) / 3);
  const activity = clamp01(Math.log10(Math.max(Number(volume) || 0, 1)) / 3);

  return round(0.5 * tightness + 0.3 * depth + 0.2 * activity, 4);
}

export function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

export function round(x, dp = 2) {
  if (!Number.isFinite(x)) return null;
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
