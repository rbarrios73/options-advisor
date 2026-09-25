export const STRATEGY_LABELS = {
  put_credit_spread: 'Put credit spread',
  call_credit_spread: 'Call credit spread',
  iron_condor: 'Iron condor',
  long_call: 'Long call',
  long_put: 'Long put',
};

// Every formatter treats null, undefined and NaN alike as "no value". A NaN reaching the screen
// as the literal text "NaN" reads as a bug; a dash reads as "not available", which is the truth.
const has = (v) => typeof v === 'number' && Number.isFinite(v);

export const money = (v) =>
  has(v) ? v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : '—';

export const price = (v) => (has(v) ? v.toFixed(2) : '—');

export const pct = (v, dp = 1) => (has(v) ? `${(v * 100).toFixed(dp)}%` : '—');

export const signed = (v) => (has(v) ? `${v > 0 ? '+' : ''}${money(v)}` : '—');

export const signedNumber = (v, dp = 2) => (has(v) ? `${v > 0 ? '+' : ''}${v.toFixed(dp)}` : '—');

/**
 * "4.41M" — share volumes, which run to nine figures and are unreadable written out. Three
 * significant figures, because the difference between 4.41M and 4.42M shares is noise.
 */
export const compact = (v) =>
  has(v) ? v.toLocaleString('en-US', { notation: 'compact', maximumSignificantDigits: 3 }) : '—';

/** "Oct 23" — how a trader names an expiry. */
export const shortDate = (iso) =>
  iso
    ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    : '—';

/** Component names as they read in the UI. */
export const COMPONENT_LABELS = {
  probProfit: 'Win probability',
  returnOnRisk: 'Return on risk',
  liquidity: 'Liquidity',
  expectedValue: 'Expected value',
  timeFit: 'Time to expiry',
};
