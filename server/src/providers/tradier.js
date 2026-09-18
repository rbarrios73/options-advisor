// Tradier adapter.
//
// The sandbox (https://sandbox.tradier.com) gives you full chains with greeks and implied vol on
// delayed quotes, which is enough to build and judge everything here. Moving to live data is a
// base URL and a token — no code below changes.
//
// Rate limits are real and the sandbox's are tight, so chains are fetched one expiry at a time
// and cached by the caller. A watchlist of 20 names across 3 expiries is 60 chain calls; that is
// why the scan is a button and not a poll.

const SANDBOX_BASE = 'https://sandbox.tradier.com/v1';
const LIVE_BASE = 'https://api.tradier.com/v1';

export function createTradierProvider({ token, mode = 'sandbox', fetchImpl = fetch }) {
  if (!token) {
    throw new Error(
      'Tradier token missing. Put TRADIER_TOKEN in server/.env — see README for where to get one.',
    );
  }

  const base = mode === 'live' ? LIVE_BASE : SANDBOX_BASE;

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
      if (!quote) throw new Error(`No quote for ${symbol}`);

      const q = Array.isArray(quote) ? quote[0] : quote;
      return {
        symbol: q.symbol,
        last: num(q.last) ?? num(q.close) ?? num(q.prevclose),
        change: num(q.change),
        changePct: num(q.change_percentage),
        description: q.description,
      };
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
