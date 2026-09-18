export const STRATEGY_LABELS = {
  put_credit_spread: 'Put credit spread',
  call_credit_spread: 'Call credit spread',
  iron_condor: 'Iron condor',
  long_call: 'Long call',
  long_put: 'Long put',
};

export const money = (v) =>
  v == null ? '—' : v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export const price = (v) => (v == null ? '—' : v.toFixed(2));

export const pct = (v, dp = 1) => (v == null ? '—' : `${(v * 100).toFixed(dp)}%`);

export const signed = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${money(v)}`);

/** Component names as they read in the UI. */
export const COMPONENT_LABELS = {
  probProfit: 'Win probability',
  returnOnRisk: 'Return on risk',
  liquidity: 'Liquidity',
  expectedValue: 'Expected value',
  timeFit: 'Time to expiry',
};
