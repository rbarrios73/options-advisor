import { useState } from 'react';

import Watchlist from '../components/Watchlist.jsx';
import Filters from '../components/Filters.jsx';
import ResultsTable from '../components/ResultsTable.jsx';

/**
 * The daily screen. Scan state lives in App, not here, so switching to the Simulator and back
 * does not throw away a scan — and does not spend another round of provider requests.
 */
export default function ScreenerPage({ settings, onFilters, scan }) {
  const [showFilters, setShowFilters] = useState(false);
  const { result, scanning, run } = scan;

  return (
    <>
      <div className="page-head">
        <p className="muted small">
          Ranks the structures your filters allow, using one snapshot of the chain. It is a screener,
          not advice — it has never seen your account, your other positions, or anything about the
          company beyond its option prices. Check every number against your broker before acting on
          it.
        </p>

        <div className="actions">
          <button className="primary" onClick={() => run()} disabled={scanning}>
            {scanning ? 'Scanning…' : 'Scan'}
          </button>
          <button onClick={() => run({ fresh: true })} disabled={scanning} title="Ignore cached chains">
            Refresh data
          </button>
          <button onClick={() => setShowFilters((v) => !v)}>{showFilters ? 'Hide filters' : 'Filters'}</button>
        </div>
      </div>

      <div className="layout">
        <aside>
          <Watchlist watchlist={settings.watchlist} />

          {showFilters && (
            <Filters
              filters={settings.filters}
              weights={settings.weights}
              onFilters={(filters) => onFilters(filters, settings.weights)}
              onWeights={(weights) => onFilters(settings.filters, weights)}
            />
          )}

          <p className="muted small provider">
            Data: {settings.provider}
            {settings.provider === 'mock' && ' — synthetic chains, for checking the app works'}
          </p>
        </aside>

        <section className="results-pane">
          {!result && <p className="muted">Press Scan to look at today&rsquo;s chains.</p>}

          {result && (
            <>
              <div className="summary">
                <span>
                  <strong>{result.candidates.length}</strong> shown of {result.totalCandidates} that
                  passed the filters
                </span>
                <span className="muted">
                  {result.symbols.map((s) => `${s.symbol} ${s.spot?.toFixed(2)}`).join('  ·  ')}
                </span>
                <span className="muted">{new Date(result.generatedAt).toLocaleTimeString()}</span>
              </div>

              {result.failures.length > 0 && (
                <p className="error small">
                  {result.failures.map((f) => `${f.symbol}: ${f.error}`).join(' · ')}
                </p>
              )}

              {result.candidates.length === 0 ? (
                <p className="muted">
                  Nothing passed. The filters are the usual culprit — try a lower win probability or
                  a lower return on risk; on a quiet day nothing pays enough to clear both.
                </p>
              ) : (
                <div className="table-wrap">
                  <ResultsTable candidates={result.candidates} />
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}
