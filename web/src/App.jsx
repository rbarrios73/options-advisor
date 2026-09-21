import { useEffect, useState } from 'react';

import { api } from './api.js';
import { PAGES, hrefFor, useRoute } from './router.js';
import ScreenerPage from './pages/ScreenerPage.jsx';
import SimulatorPage from './pages/SimulatorPage.jsx';

export default function App() {
  const route = useRoute();

  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);

  // Scan state is held here rather than in the Screener page, so a scan survives a trip to the
  // Simulator and back instead of costing another round of provider requests.
  const [result, setResult] = useState(null);
  const [scanning, setScanning] = useState(false);

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

  const runScan = async ({ fresh = false } = {}) => {
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
      <header className="topbar">
        <h1>Options Advisor</h1>
        <nav className="tabs" aria-label="Pages">
          {Object.entries(PAGES).map(([key, { label }]) => (
            <a
              key={key}
              href={hrefFor(key)}
              className={route.page === key ? 'tab active' : 'tab'}
              aria-current={route.page === key ? 'page' : undefined}
            >
              {label}
            </a>
          ))}
        </nav>
      </header>

      {error && <p className="error">{error}</p>}

      {route.page === 'simulator' ? (
        // Keyed on the incoming parameters: a new link (from a screener row, or an edited URL)
        // starts a fresh simulation, while the page's own URL updates do not remount it.
        <SimulatorPage
          key={JSON.stringify(route.params)}
          watchlist={settings.watchlist}
          params={route.params}
        />
      ) : (
        <ScreenerPage
          settings={settings}
          onWatchlist={saveWatchlist}
          onFilters={saveFilters}
          scan={{ result, scanning, run: runScan }}
        />
      )}
    </main>
  );
}
