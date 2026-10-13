// Tradier adapter.
//
// The sandbox (https://sandbox.tradier.com) gives you full chains with greeks and implied vol on
// delayed quotes, which is enough to build and judge everything here. Moving to live data is a
// base URL and a token — no code below changes.
//
// Rate limits are real and the sandbox's are tight, so chains are fetched one expiry at a time
// and cached by the caller. A watchlist of 20 names across 3 expiries is 60 chain calls; that is
// why the scan is a button and not a poll.

import { unknownSymbol } from './errors.js';

const SANDBOX_BASE = 'https://sandbox.tradier.com/v1';
const LIVE_BASE = 'https://api.tradier.com/v1';

export function createTradierProvider({ token, mode = 'sandbox', fetchImpl = fetch }) {
  if (!token) {
    throw new Error(
      'Tradier token missing. Put TRADIER_TOKEN in server/.env — see README for where to get one.',
    );
  }

  const base = mode === 'live' ? LIVE_BASE : SANDBOX_BASE;

  // The fundamentals endpoints hang off /beta rather than /v1, and they are gated: they answer for
  // brokerage account holders and 403 or 404 for everyone else, the sandbox included. That is why
  // getDividends below returns null rather than throwing — "your plan does not have this" is an
  // answer the app is built to carry on from, not a fault.
  const betaBase = base.replace(/\/v1$/, '/beta');

  async function call(path, params) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v != null) url.searchParams.set(k, String(v));
    }

    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });

    if (response.status === 401) {
      throw new Error('Tradier rejected the token (401). Check TRADIER_TOKEN and TRADIER_MODE.');
    }
    if (response.status === 429) {
      throw new Error('Tradier rate limit hit (429). Wait a minute, or scan fewer symbols.');
    }
    if (!response.ok) {
      throw new Error(`Tradier ${path} failed: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  return {
    name: `tradier:${mode}`,

    async getQuote(symbol) {
      const data = await call('/markets/quotes', { symbols: symbol, greeks: 'false' });
      const quote = data?.quotes?.quote;
      if (!quote) throw unknownSymbol(symbol, 'Tradier');

      const q = Array.isArray(quote) ? quote[0] : quote;
      return {
        symbol: q.symbol,
        last: num(q.last) ?? num(q.close) ?? num(q.prevclose),
        change: num(q.change),
        // Tradier reports this as a percentage (1.23 meaning 1.23%); the app works in fractions
        // everywhere else, so it is converted here rather than in four places downstream.
        changePct: num(q.change_percentage) === null ? null : num(q.change_percentage) / 100,
        description: q.description,
        exchange: q.exch,
        open: num(q.open),
        high: num(q.high),
        low: num(q.low),
        prevClose: num(q.prevclose),
        bid: num(q.bid),
        ask: num(q.ask),
        volume: num(q.volume),
        averageVolume: num(q.average_volume),
        week52High: num(q.week_52_high),
        week52Low: num(q.week_52_low),
        tradeDate: q.trade_date ? new Date(num(q.trade_date)).toISOString() : null,
      };
    },

    /**
     * Daily (or weekly) bars. Tradier returns a bare object rather than an array when the range
     * holds exactly one day, which is the shape that breaks a naive .map on a quiet symbol.
     */
    async getHistory(symbol, { start, end, interval = 'daily' } = {}) {
      const data = await call('/markets/history', { symbol, interval, start, end });

      const days = data?.history?.day;
      if (!days) return [];

      return (Array.isArray(days) ? days : [days])
        .map((d) => ({
          date: d.date,
          open: num(d.open),
          high: num(d.high),
          low: num(d.low),
          close: num(d.close),
          volume: num(d.volume) ?? 0,
        }))
        .filter((d) => d.date && d.close > 0);
    },

    /**
     * Past cash dividends, newest last, or null when this account cannot read them.
     *
     * Null is load-bearing: it is the difference between "this symbol pays nothing" (an empty
     * array) and "I am not allowed to ask" (null), and the screen says something different for
     * each — the second offers you the box to type the rate in yourself.
     *
     * The response is nested three deep and the shape varies by symbol, so every level is reached
     * for defensively. An ETF and a share come back differently, and a symbol with one payment
     * comes back as an object where one with twelve comes back as an array.
     */
    async getDividends(symbol) {
      const url = new URL(`${betaBase}/markets/fundamentals/dividends`);
      url.searchParams.set('symbols', symbol);

      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });

      // 403 is "not on your plan", 404 is "not on this environment" — the sandbox answers one of
      // them. Neither is worth an error on a page that works without this.
      if (response.status === 403 || response.status === 404) return null;
      if (response.status === 401) {
        throw new Error('Tradier rejected the token (401). Check TRADIER_TOKEN and TRADIER_MODE.');
      }
      if (!response.ok) return null;

      const data = await response.json().catch(() => null);
      const entries = [];

      for (const item of asArray(data)) {
        for (const result of asArray(item?.results)) {
          for (const row of asArray(result?.tables?.cash_dividends)) {
            const amount = num(row?.cash_amount);
            if (!row?.ex_date || amount === null) continue;

            entries.push({
              exDate: String(row.ex_date).slice(0, 10),
              payDate: row.pay_date ? String(row.pay_date).slice(0, 10) : null,
              amount,
            });
          }
        }
      }

      // De-duplicated: the same payment can appear under both the share and the ADR entry.
      const seen = new Map();
      for (const e of entries) seen.set(`${e.exDate}|${e.amount}`, e);

      return [...seen.values()].sort((a, b) => a.exDate.localeCompare(b.exDate));
    },

    async getExpirations(symbol) {
      const data = await call('/markets/options/expirations', {
        symbol,
        includeAllRoots: 'true',
        strikes: 'false',
      });

      const dates = data?.expirations?.date;
      if (!dates) return [];
      return Array.isArray(dates) ? dates : [dates];
    },

    async getChain(symbol, expiration, spot) {
      const data = await call('/markets/options/chains', {
        symbol,
        expiration,
        greeks: 'true',
      });

      const raw = data?.options?.option;
      if (!raw) return { symbol, expiration, spot, options: [] };

      const list = Array.isArray(raw) ? raw : [raw];

      return {
        symbol,
        expiration,
        spot,
        options: list.map(normaliseOption).filter((o) => o.strike > 0),
      };
    },
  };
}

/**
 * Tradier's shape into ours. Greeks live in a nested object and are absent on illiquid strikes,
 * so every numeric field is coerced and allowed to be null — a missing delta must not become 0,
 * which would read as "far out of the money" and let a bad strike through the filters.
 */
function normaliseOption(o) {
  const greeks = o.greeks ?? {};

  return {
    symbol: o.symbol,
    type: o.option_type, // 'put' | 'call'
    strike: num(o.strike),
    expiration: o.expiration_date,
    bid: num(o.bid) ?? 0,
    ask: num(o.ask) ?? 0,
    last: num(o.last),
    volume: num(o.volume) ?? 0,
    openInterest: num(o.open_interest) ?? 0,
    delta: num(greeks.delta),
    gamma: num(greeks.gamma),
    theta: num(greeks.theta),
    vega: num(greeks.vega),
    // mid_iv is Tradier's blended implied vol; smv_vol is their surface value. Prefer the
    // blend and fall back, because one or the other is missing on quiet strikes.
    iv: num(greeks.mid_iv) ?? num(greeks.smv_vol) ?? num(greeks.ask_iv) ?? num(greeks.bid_iv),
  };
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Tradier returns a bare object where a list has one element. This flattens that away. */
const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
