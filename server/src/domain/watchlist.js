// What a watchlist entry is, and what the default list holds.
//
// Pure, like everything else in domain/ — the browser imports the validation too, so the Watchlist
// page can refuse a bad ticker before the round trip and refuse it for the same reason the server
// would. One definition, two places that enforce it.

/** Letters and dots: BRK.B is a ticker, "AAPL " and "aapl;drop" are not. */
export const SYMBOL_PATTERN = /^[A-Z.]{1,6}$/;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const MAX_SYMBOLS = 40;
export const MAX_NOTE = 200;

/**
 * Ten names chosen for two things at once: exposure to different drivers, and option chains deep
 * enough that a four-legged position is fillable. Diversification is the point, but an illiquid
 * chain quietly costs more than a correlated one — on a condor you pay the bid/ask four times.
 *
 * Eight are ETFs, which have no earnings date to gap over; the earnings field is entered by hand,
 * so every single name is a thing you have to remember.
 *
 * This is what a NEW account starts with. It is not a floor: empty is a list you chose, and the
 * app leaves it empty rather than quietly putting these back.
 */
export const DEFAULT_WATCHLIST = [
  { symbol: 'SPY', note: 'US large cap — the deepest options market there is' },
  { symbol: 'IWM', note: 'US small cap — higher IV than SPY, different economic sensitivity' },
  { symbol: 'XLF', note: 'Financials — rates and credit' },
  { symbol: 'XLE', note: 'Energy — crude, largely its own cycle' },
  { symbol: 'XLV', note: 'Healthcare — defensive, low beta to the index' },
  { symbol: 'GLD', note: 'Gold — the one that usually rises when equities fall' },
  { symbol: 'TLT', note: 'Long Treasuries — duration and rate expectations' },
  { symbol: 'EEM', note: 'Emerging markets — non-US, dollar-sensitive' },
  { symbol: 'XLY', note: 'Consumer discretionary — the household-spending side of the economy' },
  // The one single name. High IV means it is usually the only thing here paying enough for a
  // short spread to clear the 15% return-on-risk floor — and the only one that can gap on an
  // earnings date, which you have to enter by hand.
  { symbol: 'NVDA', note: 'Semis — high IV, deepest single-name chain. Set its earnings date' },
];

/** One entry, tidied — or null if the symbol is not a symbol, which is the only fatal problem. */
export function cleanEntry(entry) {
  const symbol = String(entry?.symbol ?? '').trim().toUpperCase();
  if (!SYMBOL_PATTERN.test(symbol)) return null;

  return {
    symbol,
    note: String(entry?.note ?? '').trim().slice(0, MAX_NOTE),
    // Optional, and set by hand: no free feed gives a reliable earnings date, and guessing one is
    // worse than leaving it blank. Anything that is not a plain YYYY-MM-DD is dropped rather than
    // stored — a half-parsed date would reach the database as a cast error on someone else's row.
    earnings: ISO_DATE.test(String(entry?.earnings ?? '')) ? String(entry.earnings) : null,
  };
}

/**
 * A whole list, tidied: bad entries dropped, duplicates collapsed onto the first mention, and
 * capped. The cap is not a licence issue — it is the scan, which spends provider requests per
 * symbol, and a list of 300 tickers would exhaust a rate limit before it finished.
 */
export function cleanWatchlist(list) {
  const seen = new Set();
  const out = [];

  for (const raw of Array.isArray(list) ? list : []) {
    const entry = cleanEntry(raw);
    if (!entry || seen.has(entry.symbol)) continue;

    seen.add(entry.symbol);
    out.push(entry);
    if (out.length === MAX_SYMBOLS) break;
  }

  return out;
}
