import { useEffect, useState } from 'react';

import { api } from './api.js';
import Watchlist from './components/Watchlist.jsx';
import Filters from './components/Filters.jsx';
import ResultsTable from './components/ResultsTable.jsx';

export default function App() {
  const [settings, setSettings] = useState(null);
  const [result, setResult] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    api.settings().then(setSettings).catch((e) => setError(e.message));
  }, []);

  const saveWatchlist = async (watchlist) => {
    setSettings((s) => ({ ...s, watchlist })); // optimistic: typing should not wait on a round trip
    try {
      await api.saveWatchlist(watchlist);
    } catch (e) {
      setError(e.message);
    }
  };

  const saveFilters = async (filters, weights) => {
    setSettings((s) => ({ ...s, filters, weights }));
    try {
      await api.saveFilters(filters, weights);
    } catch (e) {
      setError(e.message);
    }
  };

  const scan = async ({ fresh = false } = {}) => {
    setScanning(true);
    setError(null);
    try {
      setResult(await api.scan({ fresh, limit: 60 }));
    } catch (e) {
      setError(e.message);
    } finally {
      setScanning(false);
    }
  };

  if (error && !settings) return <main className="app"><p className="error">{error}</p></main>;
  if (!settings) return <main className="app"><p className="muted">Loading…</p></main>;

  return (
    <main className="app">
      <header>
        <div>
          <h1>Options Advisor</h1>
          <p className="muted small">
            Ranks the structures your filters allow, using one snapshot of the chain. It is a
            screener, not advice — it has never seen your account, your other positions, or
            anything about the company beyond its option prices. Check every number against your
            broker before acting on it.
          </p>
        </div>

        <div className="actions">
          <button className="primary" onClick={() => scan()} disabled={scanning}>
            {scanning ? 'Scanning…' : 'Scan'}
          </button>
          <button onClick={() => scan({ fresh: true })} disabled={scanning} title="Ignore cached chains">
            Refresh data
          </button>
          <button onClick={() => setShowFilters((v) => !v)}>
            {showFilters ? 'Hide filters' : 'Filters'}
          </button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="layout">
        <aside>
          <Watchlist watchlist={settings.watchlist} onChange={saveWatchlist} />

          {showFilters && (
            <Filters
              filters={settings.filters}
              weights={settings.weights}
              onFilters={(filters) => saveFilters(filters, settings.weights)}
              onWeights={(weights) => saveFilters(settings.filters, weights)}
            />
          )}

          <p className="muted small provider">
            Data: {settings.provider}
            {settings.provider === 'mock' && ' — synthetic chains, for checking the app works'}
          </p>
        </aside>

        <section className="results-pane">
          {!result && <p className="muted">Press Scan to look at today's chains.</p>}

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
                <span className="muted">
                  {new Date(result.generatedAt).toLocaleTimeString()}
                </span>
              </div>

              {result.failures.length > 0 && (
                <p className="error small">
                  {result.failures.map((f) => `${f.symbol}: ${f.error}`).join(' · ')}
                </p>
              )}

              {result.candidates.length === 0 ? (
                <p className="muted">
                  Nothing passed. The filters are the usual culprit — try a lower win probability
                  or a lower return on risk; on a quiet day nothing pays enough to clear both.
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
    </main>
  );
}
