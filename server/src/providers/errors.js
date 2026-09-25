/**
 * "This provider does not know that symbol" — a 404, not a 500.
 *
 * It matters because it is a normal answer, not a fault: the watchlist page checks a ticker
 * before adding it, and a delisted name on an existing list shows as "no quote" rather than as
 * the app being broken. A 500 in the browser console for a typo is noise that hides real faults.
 */
export function unknownSymbol(symbol, provider) {
  const error = new Error(`${provider} has no data for ${String(symbol).toUpperCase()}`);
  error.status = 404;
  return error;
}
