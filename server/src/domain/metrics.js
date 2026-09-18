// Turns a set of legs into the numbers you would want before risking money on it.
//
// Every figure a candidate carries is computed here, and every input it was computed from is kept
// on the candidate. That is deliberate: a ranked list you cannot argue with is worse than no list,
// because you cannot tell a good setup from a quirk of the scoring.
//
// PRICING CONVENTION — the conservative one. A credit is taken at the price you could actually
// get hit on (sell the bid, buy the ask); a debit is what you would actually pay (buy the ask).
// Mid-price fills look better on screen and are not what a retail multi-leg order gets on a
// quiet strike. Both the conservative and the mid figure are reported so you can see the gap.

import { mid, probabilityAbove, probabilityBelow, liquidityScore, round, clamp01 } from './math.js';

const CONTRACT_MULTIPLIER = 100;

/**
 * A vertical credit spread: sell the near strike, buy the far one for protection.
 *
 * @param {object} shortLeg  option being sold
 * @param {object} longLeg   option being bought
 * @param {'put'|'call'} type
 */
export function creditSpreadMetrics({ shortLeg, longLeg, type, spot, iv, years }) {
  const width = Math.abs(shortLeg.strike - longLeg.strike);
  if (!(width > 0)) return null;

  // What you would be filled at if you crossed the spread on both legs.
  const creditConservative = (shortLeg.bid ?? 0) - (longLeg.ask ?? 0);
  const creditMid = (mid(shortLeg.bid, shortLeg.ask) ?? 0) - (mid(longLeg.bid, longLeg.ask) ?? 0);

  if (!(creditConservative > 0)) return null; // Not a credit at prices you could actually get.

  const maxLoss = width - creditConservative;
  if (!(maxLoss > 0)) return null; // Credit exceeds width: a quote artefact, not free money.

  const breakEven =
    type === 'put' ? shortLeg.strike - creditConservative : shortLeg.strike + creditConservative;

  // Probability the position expires worthless, which is the win for a credit spread.
  // Measured at the break-even, not the short strike: between the two you keep part of the
  // credit but the trade is not a full winner, and counting that as a win flatters the number.
  const probProfit =
    type === 'put'
      ? probabilityAbove(spot, breakEven, iv, years)
      : probabilityBelow(spot, breakEven, iv, years);

  // The same thing measured at the short strike — the number most platforms show, and the one
  // the short leg's delta approximates. Kept so you can see both.
  const probShortExpiresOtm =
    type === 'put'
      ? probabilityAbove(spot, shortLeg.strike, iv, years)
      : probabilityBelow(spot, shortLeg.strike, iv, years);

  const returnOnRisk = creditConservative / maxLoss;

  return {
    kind: type === 'put' ? 'put_credit_spread' : 'call_credit_spread',
    direction: type === 'put' ? 'bullish' : 'bearish',
    net: 'credit',
    width: round(width),
    credit: round(creditConservative),
    creditMid: round(creditMid),
    slippageToMid: round(creditMid - creditConservative),
    maxProfit: round(creditConservative * CONTRACT_MULTIPLIER),
    maxLoss: round(maxLoss * CONTRACT_MULTIPLIER),
    breakEven: round(breakEven),
    returnOnRisk: round(returnOnRisk, 4),
    probProfit: round(probProfit, 4),
    probShortExpiresOtm: round(probShortExpiresOtm, 4),
    expectedValue: expectedValue(probProfit, creditConservative, maxLoss),
    liquidity: round(
      Math.min(liquidityScore(shortLeg), liquidityScore(longLeg)),
      4,
    ),
    legs: [
      { action: 'sell', ...legSummary(shortLeg) },
      { action: 'buy', ...legSummary(longLeg) },
    ],
  };
}

/**
 * An iron condor: a put credit spread and a call credit spread on the same expiry. Max loss is
 * the wider side less the total credit, because only one side can finish in the money.
 */
export function ironCondorMetrics({ putSpread, callSpread }) {
  if (!putSpread || !callSpread) return null;

  const credit = putSpread.credit + callSpread.credit;
  const width = Math.max(putSpread.width, callSpread.width);
  const maxLoss = width - credit;
  if (!(maxLoss > 0)) return null;

  const lowerBreakEven = putSpread.legs[0].strike - credit;
  const upperBreakEven = callSpread.legs[0].strike + credit;

  // Finishing between the break-evens is the full win. The two tail probabilities are
  // independent enough at this level of approximation to just subtract.
  const probBelowLower = 1 - (putSpread.probProfit ?? 0);
  const probAboveUpper = 1 - (callSpread.probProfit ?? 0);
  const probProfit = clamp01(1 - probBelowLower - probAboveUpper);

  return {
    kind: 'iron_condor',
    direction: 'neutral',
    net: 'credit',
    width: round(width),
    credit: round(credit),
    creditMid: round(putSpread.creditMid + callSpread.creditMid),
    slippageToMid: round(putSpread.slippageToMid + callSpread.slippageToMid),
    maxProfit: round(credit * CONTRACT_MULTIPLIER),
    maxLoss: round(maxLoss * CONTRACT_MULTIPLIER),
    breakEven: round(lowerBreakEven),
    breakEvenUpper: round(upperBreakEven),
    profitRange: [round(lowerBreakEven), round(upperBreakEven)],
    returnOnRisk: round(credit / maxLoss, 4),
    probProfit: round(probProfit, 4),
    expectedValue: expectedValue(probProfit, credit, maxLoss),
    liquidity: round(Math.min(putSpread.liquidity, callSpread.liquidity), 4),
    legs: [...putSpread.legs, ...callSpread.legs],
  };
}

/** A long call or put: defined risk, unlimited (call) or large (put) upside. */
export function longOptionMetrics({ leg, type, spot, iv, years }) {
  const debit = leg.ask;
  if (!(debit > 0)) return null;

  const debitMid = mid(leg.bid, leg.ask);
  const breakEven = type === 'call' ? leg.strike + debit : leg.strike - debit;

  const probProfit =
    type === 'call'
      ? probabilityAbove(spot, breakEven, iv, years)
      : probabilityBelow(spot, breakEven, iv, years);

  return {
    kind: type === 'call' ? 'long_call' : 'long_put',
    direction: type === 'call' ? 'bullish' : 'bearish',
    net: 'debit',
    width: null,
    credit: round(-debit),
    creditMid: round(-(debitMid ?? debit)),
    slippageToMid: round(debit - (debitMid ?? debit)),
    // A long call's profit is unbounded; a long put's caps at the strike going to zero.
    maxProfit: type === 'call' ? null : round((leg.strike - debit) * CONTRACT_MULTIPLIER),
    maxLoss: round(debit * CONTRACT_MULTIPLIER),
    breakEven: round(breakEven),
    returnOnRisk: null, // Undefined without a profit target: the upside is not bounded by a width.
    probProfit: round(probProfit, 4),
    expectedValue: null, // Needs a payoff distribution, not two outcomes. Left null rather than faked.
    liquidity: round(liquidityScore(leg), 4),
    legs: [{ action: 'buy', ...legSummary(leg) }],
  };
}

/**
 * Expected value per contract on the two-outcome simplification: full credit or full max loss.
 *
 * This is a LOWER BOUND on a managed position and an approximation of an unmanaged one. Real
 * outcomes land between the two ends — you can close a spread early for part of the credit, and
 * a breached short strike does not always run to the long one. Treat it as a way of comparing
 * candidates with each other, not as a forecast of what you will make.
 */
export function expectedValue(probProfit, credit, maxLoss) {
  if (probProfit === null || !Number.isFinite(probProfit)) return null;
  return round((probProfit * credit - (1 - probProfit) * maxLoss) * CONTRACT_MULTIPLIER);
}

function legSummary(leg) {
  return {
    symbol: leg.symbol,
    type: leg.type,
    strike: leg.strike,
    expiration: leg.expiration,
    bid: leg.bid,
    ask: leg.ask,
    mid: round(mid(leg.bid, leg.ask)),
    delta: leg.delta ?? null,
    iv: leg.iv ?? null,
    openInterest: leg.openInterest ?? null,
    volume: leg.volume ?? null,
  };
}
