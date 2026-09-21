// Black-Scholes pricing and greeks for European options.
//
// Used by the simulator to answer "what is this spread worth on a date before expiry, at a price
// other than today's, with implied vol somewhere else?" The screener never needed this: it only
// ever priced at today's quotes and at expiry, where the value is just intrinsic.
//
// This module is imported by the browser as well as the server, so it must stay pure — no Node
// APIs, no I/O. That is what lets the simulator redraw on every slider tick without a round trip.
//
// Two simplifications worth knowing about, because both show up in the numbers:
//
//   • No dividends. An ETF's dividend lowers its forward price, which nudges puts up and calls
//     down. Over a 30–45 day spread on SPY it is a few cents; on a high-yield name before an
//     ex-date it is more.
//   • European exercise. Listed equity and ETF options are American, and a deep in-the-money
//     short put can be assigned early. The model will not show you that risk; it is real.

import { normalCdf } from './math.js';

export const DEFAULT_RATE = 0.04;
const DAYS_PER_YEAR = 365;

export function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Inverse of the standard normal CDF (Acklam's rational approximation, relative error < 1.2e-9).
 * Needed to go from a target delta to the strike that has it.
 */
export function inverseNormalCdf(p) {
  if (!(p > 0 && p < 1)) return NaN;

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

  const low = 0.02425;
  const high = 1 - low;

  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > high) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function d1d2(spot, strike, years, rate, vol) {
  const sqrtT = Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (rate + (vol * vol) / 2) * years) / (vol * sqrtT);
  return { d1, d2: d1 - vol * sqrtT, sqrtT };
}

/** True when there is no time or no vol left, so the option is worth exactly its intrinsic. */
function atExpiry(years, vol) {
  return !(years > 1e-9) || !(vol > 1e-9);
}

export function intrinsic(type, spot, strike) {
  return type === 'put' ? Math.max(strike - spot, 0) : Math.max(spot - strike, 0);
}

/**
 * Theoretical price of one option (per share, not per contract).
 *
 * @param {'put'|'call'} type
 * @param {number} spot     underlying price
 * @param {number} strike
 * @param {number} years    time to expiry in years
 * @param {number} vol      implied volatility, annualised (0.2 = 20%)
 * @param {number} rate     risk-free rate, annualised
 */
export function bsPrice(type, spot, strike, years, vol, rate = DEFAULT_RATE) {
  if (!(spot > 0) || !(strike > 0)) return NaN;
  if (atExpiry(years, vol)) return intrinsic(type, spot, strike);

  const { d1, d2 } = d1d2(spot, strike, years, rate, vol);
  const discount = Math.exp(-rate * years);

  return type === 'put'
    ? strike * discount * normalCdf(-d2) - spot * normalCdf(-d1)
    : spot * normalCdf(d1) - strike * discount * normalCdf(d2);
}

/**
 * Greeks for one long option, per share, in the units a trading screen shows them:
 *   delta  — change in price per $1 in the underlying
 *   gamma  — change in delta per $1 in the underlying
 *   theta  — change in price per CALENDAR day (negative for a long option)
 *   vega   — change in price per 1 vol point (0.01), not per 1.00
 */
export function bsGreeks(type, spot, strike, years, vol, rate = DEFAULT_RATE) {
  if (!(spot > 0) || !(strike > 0)) return { delta: NaN, gamma: NaN, theta: NaN, vega: NaN };

  if (atExpiry(years, vol)) {
    const itm = type === 'put' ? spot < strike : spot > strike;
    return { delta: itm ? (type === 'put' ? -1 : 1) : 0, gamma: 0, theta: 0, vega: 0 };
  }

  const { d1, d2, sqrtT } = d1d2(spot, strike, years, rate, vol);
  const pdf = normalPdf(d1);
  const discount = Math.exp(-rate * years);

  const decay = -(spot * pdf * vol) / (2 * sqrtT);
  const carry =
    type === 'put'
      ? rate * strike * discount * normalCdf(-d2)
      : -rate * strike * discount * normalCdf(d2);

  return {
    delta: type === 'put' ? normalCdf(d1) - 1 : normalCdf(d1),
    gamma: pdf / (spot * vol * sqrtT),
    theta: (decay + carry) / DAYS_PER_YEAR,
    vega: (spot * pdf * sqrtT) / 100,
  };
}

/**
 * The strike whose Black-Scholes delta equals `targetDelta`, for when there is no chain to pick
 * from. Pass the delta as a magnitude (0.20, not -0.20) — that is how traders say it.
 *
 * With a real chain the simulator picks the listed strike nearest the target instead, because a
 * strike that does not exist cannot be traded. This is the fallback, and the thing that tests
 * the inverse.
 */
export function strikeForDelta(type, targetDelta, spot, years, vol, rate = DEFAULT_RATE) {
  const magnitude = Math.abs(targetDelta);
  if (!(magnitude > 0 && magnitude < 1) || atExpiry(years, vol)) return NaN;

  // Put delta is N(d1) - 1, so a put with |delta| 0.20 has N(d1) = 0.80.
  const nd1 = type === 'put' ? 1 - magnitude : magnitude;
  const d1 = inverseNormalCdf(nd1);

  const sqrtT = Math.sqrt(years);
  return spot * Math.exp(-(d1 * vol * sqrtT - (rate + (vol * vol) / 2) * years));
}

/** One standard deviation of the underlying's move over `years`, in dollars — the "expected move". */
export function expectedMove(spot, vol, years) {
  if (!(spot > 0) || !(vol > 0) || !(years > 0)) return null;
  return spot * vol * Math.sqrt(years);
}
