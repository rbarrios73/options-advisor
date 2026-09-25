// A synthetic provider, so the whole app runs — and is testable — with no token and no network.
//
// The chain is generated from Black-Scholes with a volatility smile and a widening bid/ask as you
// move away from the money, which is enough to exercise every filter and make the ranking behave
// like it does on real data. It is NOT a market simulator: do not read anything into the
// candidates it produces beyond "the pipeline works".

import { normalCdf } from '../domain/math.js';

const UNIVERSE = {
  SPY: { spot: 552.4, baseIv: 0.14 },
  QQQ: { spot: 486.1, baseIv: 0.19 },
  IWM: { spot: 221.7, baseIv: 0.22 },
  AAPL: { spot: 238.6, baseIv: 0.27 },
  NVDA: { spot: 174.3, baseIv: 0.46 },
  TSLA: { spot: 412.8, baseIv: 0.55 },
  AMD: { spot: 168.2, baseIv: 0.44 },
  MSFT: { spot: 512.9, baseIv: 0.21 },

  // The sector and asset-class ETFs on the default watchlist, so a mock run exercises the same
  // list the app ships with rather than reporting half of it as missing. The vols are plausible
  // relative orderings — gold and bonds quieter than equities, energy noisier — not forecasts.
  XLF: { spot: 52.8, baseIv: 0.19 },
  XLE: { spot: 91.4, baseIv: 0.25 },
  XLV: { spot: 148.3, baseIv: 0.16 },
  GLD: { spot: 246.7, baseIv: 0.15 },
  TLT: { spot: 88.9, baseIv: 0.14 },
  EEM: { spot: 47.2, baseIv: 0.2 },
  XLY: { spot: 224.6, baseIv: 0.21 },
};

export function createMockProvider({ today = new Date() } = {}) {
  return {
    name: 'mock',

    async getQuote(symbol) {
      const key = symbol.toUpperCase();
      const base = UNIVERSE[key];
      if (!base) throw new Error(`Mock provider has no data for ${symbol}`);

      // The day's numbers and the 52-week range come out of the same generator the chart uses, so
      // the header agrees with the line under it. Walking backwards means the last bar is drawn
      // first from the same seed, whatever range was asked for — today's bar is always the same.
      const year = buildHistory(key, base, { start: isoDaysBefore(today, 366), end: iso(today) }, today);
      const day = year.at(-1);
      const prev = year.at(-2) ?? day;

      const change = day ? round2(day.close - prev.close) : 0;

      return {
        symbol: key,
        last: base.spot,
        change,
        changePct: prev?.close > 0 ? change / prev.close : 0,
        description: `${key} (synthetic)`,
        exchange: 'MOCK',
        open: day?.open ?? base.spot,
        high: day?.high ?? base.spot,
        low: day?.low ?? base.spot,
        prevClose: prev?.close ?? base.spot,
        bid: round2(base.spot * 0.9995),
        ask: round2(base.spot * 1.0005),
        volume: day?.volume ?? 0,
        averageVolume: Math.round(year.reduce((sum, b) => sum + b.volume, 0) / Math.max(year.length, 1)),
        week52High: Math.max(...year.map((b) => b.high)),
        week52Low: Math.min(...year.map((b) => b.low)),
        tradeDate: day ? `${day.date}T20:00:00.000Z` : null,
      };
    },

    async getExpirations(symbol) {
      if (!UNIVERSE[symbol.toUpperCase()]) throw new Error(`Mock provider has no data for ${symbol}`);
      // Weeklies out to ~3 months, on Fridays.
      return fridaysAhead(today, 13);
    },

    /**
     * Synthetic daily bars, deterministic per symbol so the chart does not reshuffle itself on
     * every request, and walked BACKWARDS from today's price so the last bar agrees with the
     * quote. A series that ends somewhere other than the quoted price is the kind of detail that
     * makes a mock useless for checking the UI.
     */
    async getHistory(symbol, { start, end, interval = 'daily' } = {}) {
      const key = symbol.toUpperCase();
      const base = UNIVERSE[key];
      if (!base) throw new Error(`Mock provider has no data for ${symbol}`);

      return buildHistory(key, base, { start, end, interval }, today);
    },

    async getChain(symbol, expiration, spot) {
      const base = UNIVERSE[symbol.toUpperCase()];
      if (!base) throw new Error(`Mock provider has no data for ${symbol}`);

      const price = spot ?? base.spot;
      const dte = Math.max(
        1,
        Math.ceil((new Date(expiration).getTime() - today.getTime()) / 86_400_000),
      );
      const years = dte / 365;

      const step = strikeStep(price);
      const options = [];

      for (let i = -14; i <= 14; i++) {
        const strike = round(price / step) * step + i * step;
        if (strike <= 0) continue;

        for (const type of ['put', 'call']) {
          options.push(buildOption({ symbol, type, strike, price, base, years, dte, expiration }));
        }
      }

      return { symbol: symbol.toUpperCase(), expiration, spot: price, options };
    },
  };
}

function buildHistory(key, base, { start, end, interval = 'daily' }, today) {
  const last = end ? new Date(`${end}T00:00:00Z`) : new Date(today);
  const from = new Date(`${start ?? '1970-01-01'}T00:00:00Z`);
  const step = interval === 'weekly' ? 7 : interval === 'monthly' ? 30 : 1;

  const rand = seeded(key);
  const daily = base.baseIv / Math.sqrt(252);      // a day's worth of the symbol's own vol
  const drift = 0.00025 * step;                    // a gentle upward tilt, as indices have had

  const bars = [];
  let close = base.spot;

  for (let d = new Date(last); d >= from; d.setUTCDate(d.getUTCDate() - step)) {
    const day = d.getUTCDay();
    if (step === 1 && (day === 0 || day === 6)) continue;   // no weekend bars

    const date = d.toISOString().slice(0, 10);
    const wobble = daily * Math.sqrt(step) * (rand() * 2 - 1) * 1.6;
    const open = close * (1 - wobble * 0.6);
    const spread = Math.abs(wobble) * close * 0.8 + close * 0.001;

    bars.push({
      date,
      open: round2(open),
      high: round2(Math.max(open, close) + spread * rand()),
      low: round2(Math.min(open, close) - spread * rand()),
      close: round2(close),
      volume: Math.round((2_000_000 + rand() * 6_000_000) * (step === 1 ? 1 : step)),
    });

    // Step the price back one period: undo the drift, then the wobble.
    close = close / (1 + drift) * (1 - wobble);
  }

  return bars.reverse();
}

const iso = (date) => new Date(date).toISOString().slice(0, 10);

function isoDaysBefore(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - days);
  return iso(d);
}

function buildOption({ symbol, type, strike, price, base, years, dte, expiration }) {
  // A smile: further from the money is dearer in vol terms, puts more so than calls.
  const moneyness = Math.log(strike / price);
  const skew = moneyness < 0 ? 0.55 : 0.25;
  const iv = base.baseIv * (1 + skew * Math.abs(moneyness) * 6) * (1 + 0.15 / Math.sqrt(dte));

  const { price: theo, delta } = blackScholes({ type, spot: price, strike, iv, years });

  // Quotes widen away from the money and on cheap contracts, the way they really do.
  const relWidth = 0.02 + 0.5 * Math.abs(moneyness) + (theo < 0.5 ? 0.08 : 0);
  const halfSpread = Math.max(0.01, theo * relWidth) / 2;

  const bid = Math.max(0, roundTo(theo - halfSpread, 0.01));
  const ask = Math.max(0.01, roundTo(theo + halfSpread, 0.01));

  // Open interest and volume peak at the money and decay outwards.
  const nearness = Math.exp(-((moneyness * 8) ** 2));
  const openInterest = Math.round(50 + 8000 * nearness);
  const volume = Math.round(5 + 1500 * nearness);

  return {
    symbol: `${symbol.toUpperCase()}${expiration.replaceAll('-', '').slice(2)}${type[0].toUpperCase()}${String(Math.round(strike * 1000)).padStart(8, '0')}`,
    type,
    strike: roundTo(strike, 0.5),
    expiration,
    bid,
    ask,
    last: roundTo(theo, 0.01),
    volume,
    openInterest,
    delta: roundDp(delta, 4),
    gamma: null,
    theta: null,
    vega: null,
    iv: roundDp(iv, 4),
  };
}

/** Black-Scholes price and delta, no dividends. */
function blackScholes({ type, spot, strike, iv, years, riskFree = 0.04 }) {
  const sqrtT = Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (riskFree + (iv * iv) / 2) * years) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;
  const discount = Math.exp(-riskFree * years);

  if (type === 'call') {
    return {
      price: Math.max(0.01, spot * normalCdf(d1) - strike * discount * normalCdf(d2)),
      delta: normalCdf(d1),
    };
  }

  return {
    price: Math.max(0.01, strike * discount * normalCdf(-d2) - spot * normalCdf(-d1)),
    delta: normalCdf(d1) - 1,
  };
}

function strikeStep(price) {
  if (price < 25) return 0.5;
  if (price < 100) return 1;
  if (price < 250) return 2.5;
  return 5;
}

function fridaysAhead(from, count) {
  const out = [];
  const d = new Date(from);
  d.setUTCHours(0, 0, 0, 0);

  while (out.length < count) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() === 5) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const round = (x) => Math.round(x);

// roundTo snaps to a multiple (strikes, penny quotes); roundDp trims decimals (deltas, vols).
// Confusing the two silently zeroes everything, which is exactly what it did the first time.
const roundTo = (x, step) => Math.round(x / step) * step;
const roundDp = (x, dp) => Math.round(x * 10 ** dp) / 10 ** dp;

/**
 * A small deterministic generator (mulberry32), seeded from the symbol — so SPY's chart is the
 * same every time it is drawn, and different from QQQ's.
 */
function seeded(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round2 = (x) => Math.round(x * 100) / 100;
