// Turns the metrics into one comparable number — and shows its working.
//
// The score exists to order the table, nothing more. It is a weighted sum of five normalised
// components, and every candidate carries the component values that produced it, so a candidate
// that ranks oddly can be inspected rather than trusted. The weights are yours to change; they
// encode a preference, not a fact.
//
// What it deliberately does NOT do: recommend a position, size one, or claim an edge. It cannot.
// It sees one snapshot of one chain, knows nothing about what you already hold, your account, or
// whether the name reports earnings on Thursday.

import { clamp01, round } from './math.js';

export const DEFAULT_WEIGHTS = {
  // How likely you are to keep the credit. The dominant term for a premium seller.
  probProfit: 0.35,
  // Credit relative to what you are risking to earn it.
  returnOnRisk: 0.25,
  // Whether you can get in and out without paying the spread twice.
  liquidity: 0.2,
  // The two-outcome expected value, normalised against max loss.
  expectedValue: 0.1,
  // Preference for the middle of the time curve: enough decay to work with, not so long that the
  // position outlives your view of the name.
  timeFit: 0.1,
};

export const SWEET_SPOT_DTE = 35;

export function scoreCandidate(candidate, weights = DEFAULT_WEIGHTS) {
  const components = {
    // A 90%-likely trade scores 1, a coin flip scores 0. Below 50% a premium seller is simply
    // in the wrong structure, so there is nothing to award.
    probProfit: clamp01(((candidate.probProfit ?? 0) - 0.5) / 0.4),

    // 50% return on risk is an excellent credit spread; 0 is none.
    returnOnRisk: clamp01((candidate.returnOnRisk ?? 0) / 0.5),

    liquidity: clamp01(candidate.liquidity ?? 0),

    // EV as a fraction of max loss, mapped so break-even scores 0.5 and +20% of max loss scores 1.
    expectedValue:
      candidate.expectedValue == null || !(candidate.maxLoss > 0)
        ? 0
        : clamp01(0.5 + candidate.expectedValue / candidate.maxLoss / 0.4),

    // Triangular around the sweet spot, reaching 0 at 7 and 70 days.
    timeFit: timeFit(candidate.dte),
  };

  let total = 0;
  let used = 0;
  for (const [key, weight] of Object.entries(weights)) {
    if (components[key] == null) continue;
    total += weight * components[key];
    used += weight;
  }

  const score = used > 0 ? total / used : 0;

  return {
    ...candidate,
    score: round(score, 4),
    scoreComponents: Object.fromEntries(
      Object.entries(components).map(([k, v]) => [k, round(v, 4)]),
    ),
    weightsUsed: weights,
    // Named so the UI can show the one thing most responsible for the ranking.
    strongest: strongest(components, weights),
    weakest: weakest(components, weights),
  };
}

function timeFit(dte) {
  if (!Number.isFinite(dte)) return 0;
  if (dte <= 7 || dte >= 70) return 0;

  return dte <= SWEET_SPOT_DTE
    ? (dte - 7) / (SWEET_SPOT_DTE - 7)
    : (70 - dte) / (70 - SWEET_SPOT_DTE);
}

function strongest(components, weights) {
  return rankBy(components, weights, (a, b) => b[1] - a[1]);
}

function weakest(components, weights) {
  return rankBy(components, weights, (a, b) => a[1] - b[1]);
}

function rankBy(components, weights, comparator) {
  const contributions = Object.entries(components)
    .filter(([k]) => weights[k] != null)
    .map(([k, v]) => [k, v * weights[k]]);

  if (contributions.length === 0) return null;
  return contributions.sort(comparator)[0][0];
}

/** Sorts scored candidates, best first, and keeps the top `limit`. */
export function rank(candidates, limit = 50) {
  return [...candidates].sort((a, b) => b.score - a.score).slice(0, limit);
}
