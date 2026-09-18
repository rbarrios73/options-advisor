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
};

export function createMockProvider({ today = new Date() } = {}) {
  return {
    name: 'mock',

    async getQuote(symbol) {
      const base = UNIVERSE[symbol.toUpperCase()];
      if (!base) throw new Error(`Mock provider has no data for ${symbol}`);
      return {
        symbol: symbol.toUpperCase(),
        last: base.spot,
        change: 0,
        changePct: 0,
        description: `${symbol.toUpperCase()} (synthetic)`,
      };
    },

    async getExpirations(symbol) {
      if (!UNIVERSE[symbol.toUpperCase()]) throw new Error(`Mock provider has no data for ${symbol}`);
      // Weeklies out to ~3 months, on Fridays.
      return fridaysAhead(today, 13);
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
