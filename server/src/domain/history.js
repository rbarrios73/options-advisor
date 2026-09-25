// Price history: what to ask the provider for, and what to say about what comes back.
//
// Pure, like everything else in domain/ — the browser imports this too, so the chart and the
// server agree on what "6M" means and on how a change is computed.

/**
 * The ranges the UI offers. `days` is how far back to ask for; `interval` keeps the number of
 * points sane — five years of daily bars is ~1,260 points to draw and ship, and weekly says the
 * same thing in a fifth of the payload.
 */
export const RANGES = {
  '1M': { label: '1M', days: 31, interval: 'daily' },
  '3M': { label: '3M', days: 92, interval: 'daily' },
  '6M': { label: '6M', days: 183, interval: 'daily' },
  YTD: { label: 'YTD', days: null, interval: 'daily' },
  '1Y': { label: '1Y', days: 366, interval: 'daily' },
  '5Y': { label: '5Y', days: 1827, interval: 'weekly' },
};

export const DEFAULT_RANGE = '6M';

export function isRange(key) {
  return Object.prototype.hasOwnProperty.call(RANGES, key);
}

/**
 * The start date to request for a range, as YYYY-MM-DD.
 *
 * YTD is the first of January of the same year — not "365 days back", which is what it quietly
 * becomes if you treat every range as a day count.
 */
export function startDateFor(range, asOf) {
  const end = new Date(`${asOf}T00:00:00Z`);

  if (range === 'YTD') {
    return `${end.getUTCFullYear()}-01-01`;
  }

  const { days } = RANGES[range] ?? RANGES[DEFAULT_RANGE];
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return start.toISOString().slice(0, 10);
}

export function intervalFor(range) {
  return (RANGES[range] ?? RANGES[DEFAULT_RANGE]).interval;
}

/**
 * What the chart and the header need from a series: where it started and ended, its extremes,
 * and the change across the period.
 *
 * Returns null for an empty series rather than zeroes — a symbol with no history should read as
 * "no data", not as a flat line at zero.
 */
export function summarizeSeries(bars) {
  const clean = (bars ?? []).filter((b) => Number.isFinite(b?.close) && b.close > 0);
  if (clean.length === 0) return null;

  const first = clean[0];
  const last = clean.at(-1);

  let high = clean[0];
  let low = clean[0];
  let volume = 0;

  for (const bar of clean) {
    if ((bar.high ?? bar.close) > (high.high ?? high.close)) high = bar;
    if ((bar.low ?? bar.close) < (low.low ?? low.close)) low = bar;
    volume += bar.volume ?? 0;
  }

  const change = last.close - first.close;

  return {
    bars: clean,
    points: clean.length,
    first,
    last,
    high: { date: high.date, price: high.high ?? high.close },
    low: { date: low.date, price: low.low ?? low.close },
    change,
    // Over a period, not since yesterday — the header says which, because the two differ and
    // reading one as the other is how a flat day looks like a rally.
    changePct: first.close > 0 ? change / first.close : null,
    averageVolume: Math.round(volume / clean.length),
  };
}

/**
 * A simple moving average, aligned to the same indices as `bars` with nulls where there is not
 * yet enough history. Nulls rather than a shortened array: the chart draws it against the same
 * x positions, and a silently shifted line is a lie that looks like analysis.
 */
export function movingAverage(bars, period) {
  const out = new Array(bars.length).fill(null);
  if (!(period > 1) || bars.length < period) return out;

  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= period) sum -= bars[i - period].close;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
