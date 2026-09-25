import { hrefFor } from '../router.js';

/**
 * What this scan will look at — read only.
 *
 * Editing lives on the Watchlist tab, and only there. Two editors for one list is how a note
 * typed in one place disappears when the other saves over it; and the thing this panel is for
 * during a scan is answering "did it include X?", which does not need an input box.
 */
export default function Watchlist({ watchlist }) {
  return (
    <section className="panel">
      <h2>Watchlist</h2>

      {watchlist.length === 0 ? (
        <p className="muted">
          Nothing on the list — a scan has nothing to look at. <a href={hrefFor('watchlist')}>Add a ticker</a>.
        </p>
      ) : (
        <>
          <ul className="watchlist">
            {watchlist.map((entry) => (
              <li key={entry.symbol}>
                <a className="ticker" href={hrefFor('ticker', { symbol: entry.symbol })}>
                  {entry.symbol}
                </a>

                {/* Only the dates that are set, and only as text. An earnings date is the one
                    field here that changes what the scan reports, so it is worth seeing. */}
                {entry.earnings && (
                  <span className="muted small" title="Expiries after this are flagged">
                    {entry.earnings}
                  </span>
                )}
              </li>
            ))}
          </ul>

          <p className="muted small">
            <a href={hrefFor('watchlist')}>Edit the watchlist</a>
          </p>
        </>
      )}
    </section>
  );
}
