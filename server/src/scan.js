// One scan: for each symbol on the watchlist, pull the expiries in range, build every candidate
// the filters allow, score them, and return the best.
//
// Chains are cached and symbols are fetched one at a time on purpose. A provider rate limit is
// the usual reason a scan half-works, and a half-finished scan that reports which symbols failed
// is far more useful than one that throws.

import { generateCandidates } from './domain/strategies.js';
import { scoreCandidate, rank } from './domain/score.js';
import { daysBetween } from './domain/math.js';

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

    const inRange = expirations.filter((e) => {
      const dte = daysBetween(asOf, e);
      return dte >= filters.minDte && dte <= filters.maxDte;
    });

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
