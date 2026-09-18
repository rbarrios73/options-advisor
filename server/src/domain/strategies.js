// Enumerates the candidate positions available in one expiry of one chain, and scores them.
//
// The generators are deliberately dumb: they produce every structure that fits the filters and
// let the scoring sort it out. Cleverness here (skipping strikes that "look wrong") is how a
// screener quietly develops opinions you cannot see.

import { yearsToExpiry, daysBetween, round } from './math.js';
import { creditSpreadMetrics, ironCondorMetrics, longOptionMetrics } from './metrics.js';

export const STRATEGIES = [
  'put_credit_spread',
  'call_credit_spread',
  'iron_condor',
  'long_call',
  'long_put',
];

/**
 * @param {object} chain    { symbol, spot, expiration, options: [...] }
 * @param {object} filters  see DEFAULT_FILTERS
 * @param {string} asOf     ISO date the scan is run for
 */
export function generateCandidates(chain, filters, asOf) {
  const dte = daysBetween(asOf, chain.expiration);
  if (dte < filters.minDte || dte > filters.maxDte) return [];

  const years = yearsToExpiry(dte);
  const spot = chain.spot;

  const puts = sortByStrike(chain.options.filter((o) => o.type === 'put'));
  const calls = sortByStrike(chain.options.filter((o) => o.type === 'call'));

  // One volatility for the whole expiry, taken at the money. Using each leg's own IV would let
  // skew quietly change the probability between two candidates that differ only by strike, which
  // makes the ranking impossible to reason about.
  const iv = atmImpliedVol([...puts, ...calls], spot);
  if (!(iv > 0)) return [];

  const context = { spot, iv, years, dte, symbol: chain.symbol, expiration: chain.expiration };

  const putSpreads = verticalCreditSpreads(puts, 'put', context, filters);
  const callSpreads = verticalCreditSpreads(calls, 'call', context, filters);

  const wanted = new Set(filters.strategies ?? STRATEGIES);
  const out = [];

  if (wanted.has('put_credit_spread')) out.push(...putSpreads);
  if (wanted.has('call_credit_spread')) out.push(...callSpreads);
  if (wanted.has('iron_condor')) out.push(...ironCondors(putSpreads, callSpreads, context, filters));
  if (wanted.has('long_call')) out.push(...longOptions(calls, 'call', context, filters));
  if (wanted.has('long_put')) out.push(...longOptions(puts, 'put', context, filters));

  return out;
}

/** Every short/long strike pair whose width is allowed and whose short leg is out of the money. */
function verticalCreditSpreads(options, type, context, filters) {
  const { spot, iv, years } = context;
  const out = [];

  for (const shortLeg of options) {
    // A credit spread is sold out of the money; selling ITM is a different trade with different
    // assignment behaviour and does not belong in the same ranked list.
    const isOtm = type === 'put' ? shortLeg.strike < spot : shortLeg.strike > spot;
    if (!isOtm) continue;

    if (filters.maxShortDelta != null && shortLeg.delta != null) {
      if (Math.abs(shortLeg.delta) > filters.maxShortDelta) continue;
    }

    for (const longLeg of options) {
      // The long leg is further out of the money than the short one: that is what caps the loss.
      const isProtection =
        type === 'put' ? longLeg.strike < shortLeg.strike : longLeg.strike > shortLeg.strike;
      if (!isProtection) continue;

      const width = Math.abs(shortLeg.strike - longLeg.strike);
      if (width < filters.minWidth || width > filters.maxWidth) continue;

      const metrics = creditSpreadMetrics({ shortLeg, longLeg, type, spot, iv, years });
      if (metrics && passes(metrics, filters)) out.push(decorate(metrics, context));
    }
  }

  return out;
}

/**
 * Pairs each put spread with each call spread on the same expiry. Capped, because the pairing is
 * a cross product and a wide chain would otherwise produce tens of thousands of near-identical
 * condors that all say the same thing.
 */
function ironCondors(putSpreads, callSpreads, context, filters) {
  const best = (xs) =>
    [...xs].sort((a, b) => (b.returnOnRisk ?? 0) - (a.returnOnRisk ?? 0)).slice(0, filters.condorLegCap);

  const out = [];
  for (const put of best(putSpreads)) {
    for (const call of best(callSpreads)) {
      const metrics = ironCondorMetrics({ putSpread: put, callSpread: call });
      if (metrics && passes(metrics, filters)) out.push(decorate(metrics, context));
    }
  }
  return out;
}

function longOptions(options, type, context, filters) {
  const { spot, iv, years } = context;
  const out = [];

  for (const leg of options) {
    // Keep it to strikes near the money; a 10-delta lottery ticket and a deep ITM stock
    // substitute are both long calls, and neither belongs next to a 30-delta directional bet.
    const moneyness = Math.abs(leg.strike / spot - 1);
    if (moneyness > filters.maxLongMoneyness) continue;

    const metrics = longOptionMetrics({ leg, type, spot, iv, years });
    if (metrics && passes(metrics, filters)) out.push(decorate(metrics, context));
  }

  return out;
}

function passes(metrics, filters) {
  if (metrics.liquidity < filters.minLiquidity) return false;
  if (metrics.probProfit != null && metrics.probProfit < filters.minProbProfit) return false;

  // Return on risk only constrains credit structures; a long option has no width to measure against.
  if (metrics.net === 'credit' && metrics.returnOnRisk < filters.minReturnOnRisk) return false;
  if (filters.maxLoss != null && metrics.maxLoss > filters.maxLoss) return false;

  return true;
}

function decorate(metrics, context) {
  return {
    ...metrics,
    symbol: context.symbol,
    expiration: context.expiration,
    dte: context.dte,
    spot: round(context.spot),
    ivUsed: round(context.iv, 4),
    id: candidateId(metrics, context),
  };
}

function candidateId(metrics, context) {
  const strikes = metrics.legs.map((l) => `${l.action[0]}${l.type[0]}${l.strike}`).join('-');
  return `${context.symbol}:${context.expiration}:${metrics.kind}:${strikes}`;
}

/**
 * Implied volatility at the money: the average of the nearest put and call IV either side of
 * spot. Falls back to whatever the closest strike reports.
 */
export function atmImpliedVol(options, spot) {
  const withIv = options.filter((o) => Number.isFinite(o.iv) && o.iv > 0);
  if (withIv.length === 0) return null;

  let closest = withIv[0];
  let closestGap = Math.abs(closest.strike - spot);

  const nearby = [];
  for (const o of withIv) {
    const gap = Math.abs(o.strike - spot);
    if (gap < closestGap) {
      closest = o;
      closestGap = gap;
    }
    if (gap <= Math.max(spot * 0.02, 1)) nearby.push(o);
  }

  if (nearby.length === 0) return closest.iv;
  return nearby.reduce((sum, o) => sum + o.iv, 0) / nearby.length;
}

function sortByStrike(options) {
  return [...options].sort((a, b) => a.strike - b.strike);
}

export const DEFAULT_FILTERS = {
  strategies: STRATEGIES,
  minDte: 7,
  maxDte: 60,
  minWidth: 1,
  maxWidth: 10,
  maxShortDelta: 0.35,
  minProbProfit: 0.6,
  minReturnOnRisk: 0.15,
  minLiquidity: 0.3,
  maxLoss: null,
  maxLongMoneyness: 0.1,
  condorLegCap: 6,
};
