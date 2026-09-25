// One scan: for each symbol on the watchlist, pull the expiries in range, build every candidate
// the filters allow, score them, and return the best.
//
// Chains are cached and symbols are fetched one at a time on purpose. A provider rate limit is
// the usual reason a scan half-works, and a half-finished scan that reports which symbols failed
// is far more useful than one that throws.

import { generateCandidates } from './domain/strategies.js';
import { scoreCandidate, rank } from './domain/score.js';
import { daysBetween } from './domain/math.js';

/**
 * The expiries worth spending a chain request on: inside the DTE window, and — when the window
 * holds more than maxExpirations — the ones nearest targetDte, returned in date order.
 *
 * Exported so it can be tested on its own. The alternative, taking the first N in the window,
 * would pin every scan to the shortest expiries, which is where a credit spread's gamma risk
 * lives and where the scoring least wants to be.
 */
export function selectExpirations(expirations, filters, asOf) {
  const inWindow = expirations.filter((e) => {
    const dte = daysBetween(asOf, e);
    return dte >= filters.minDte && dte <= filters.maxDte;
  });

  const cap = filters.maxExpirations;
  if (!(cap > 0) || inWindow.length <= cap) return inWindow;

  const target = filters.targetDte ?? (filters.minDte + filters.maxDte) / 2;

  return [...inWindow]
    .sort(
      (a, b) =>
        Math.abs(daysBetween(asOf, a) - target) - Math.abs(daysBetween(asOf, b) - target),
    )
    .slice(0, cap)
    .sort();
}

export function createScanner({ provider, cacheTtlMs = 300_000 }) {
  const cache = new Map();

  async function cached(key, produce) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < cacheTtlMs) return hit.value;

    const value = await produce();
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  async function scanSymbol(symbol, filters, asOf) {
    const quote = await cached(`quote:${symbol}`, () => provider.getQuote(symbol));
    const spot = quote.last;
    if (!(spot > 0)) throw new Error(`No usable price for ${symbol}`);

    const expirations = await cached(`exp:${symbol}`, () => provider.getExpirations(symbol));

    const inRange = selectExpirations(expirations, filters, asOf);

    const candidates = [];
    for (const expiration of inRange) {
      const chain = await cached(`chain:${symbol}:${expiration}`, () =>
        provider.getChain(symbol, expiration, spot),
      );
      candidates.push(...generateCandidates({ ...chain, spot }, filters, asOf));
    }

    return { quote, expirationsScanned: inRange, candidates };
  }

  return {
    clearCache: () => cache.clear(),

    // Single lookups for the simulator. They go through the same cache as a scan, so opening a
    // spread straight from a screener row costs no extra requests against the provider's limit.
    quote: (symbol) => cached(`quote:${symbol}`, () => provider.getQuote(symbol)),

    /** Daily bars, cached like everything else so flicking between ranges is not a new request. */
    history: (symbol, { start, end, interval }) =>
      cached(`hist:${symbol}:${interval}:${start}:${end}`, () =>
        provider.getHistory(symbol, { start, end, interval }),
      ),
    expirations: (symbol) => cached(`exp:${symbol}`, () => provider.getExpirations(symbol)),
    async chain(symbol, expiration) {
      const quote = await cached(`quote:${symbol}`, () => provider.getQuote(symbol));
      const chain = await cached(`chain:${symbol}:${expiration}`, () =>
        provider.getChain(symbol, expiration, quote.last),
      );
      return { quote, chain };
    },

    async scan({ symbols, filters, weights, limit = 50, asOf = new Date().toISOString().slice(0, 10) }) {
      const all = [];
      const perSymbol = [];
      const failures = [];

      for (const symbol of symbols) {
        try {
          const { quote, expirationsScanned, candidates } = await scanSymbol(symbol, filters, asOf);
          const scored = candidates.map((c) => scoreCandidate(c, weights));

          all.push(...scored);
          perSymbol.push({
            symbol,
            spot: quote.last,
            description: quote.description,
            expirations: expirationsScanned.length,
            candidates: scored.length,
            best: scored.length ? rank(scored, 1)[0].score : null,
          });
        } catch (error) {
          // One bad symbol must not cost the whole scan — a delisted ticker, a name with no
          // options, or a rate limit part-way through should still leave you the rest.
          failures.push({ symbol, error: error.message });
        }
      }

      return {
        asOf,
        provider: provider.name,
        generatedAt: new Date().toISOString(),
        filters,
        weights,
        symbols: perSymbol,
        failures,
        totalCandidates: all.length,
        candidates: rank(all, limit),
      };
    },
  };
}
