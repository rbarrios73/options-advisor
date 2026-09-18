// Provider interface and factory.
//
// Everything above this line in the stack knows only these four calls, so swapping Tradier for a
// broker feed or a paid vendor is one new file plus one line here:
//
//   name                                  a label for the UI
//   getQuote(symbol)                   -> { symbol, last, change, changePct, description }
//   getExpirations(symbol)             -> ['2026-10-16', ...]
//   getChain(symbol, expiration, spot) -> { symbol, expiration, spot, options: [...] }
//
// An option is:
//   { symbol, type: 'put'|'call', strike, expiration, bid, ask, last, volume, openInterest,
//     delta, gamma, theta, vega, iv }
// with null — never 0 — for anything the feed did not report.

import { createTradierProvider } from './tradier.js';
import { createMockProvider } from './mock.js';

export function createProvider(config) {
  switch (config.provider) {
    case 'tradier':
      return createTradierProvider({ token: config.tradierToken, mode: config.tradierMode });
    case 'mock':
      return createMockProvider();
    default:
      throw new Error(`Unknown provider "${config.provider}". Use "tradier" or "mock".`);
  }
}
