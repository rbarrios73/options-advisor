import { useCallback, useEffect, useState } from 'react';

import { api } from './api.js';
import { hrefFor, pagesFor, useRoute } from './router.js';
import ScreenerPage from './pages/ScreenerPage.jsx';
import SimulatorPage from './pages/SimulatorPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import UsersPage from './pages/UsersPage.jsx';
import AccountPage from './pages/AccountPage.jsx';

export default function App() {
  const route = useRoute();

  // session is { accounts, user }. accounts=false is the single-user deployment, where there is
  // nothing to sign in to and `user` is a stand-in so the rest of the app needs no special case.
  const [session, setSession] = useState(null);
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);

  // Scan state is held here rather than in the Screener page, so a scan survives a trip to the
  // Simulator and back instead of costing another round of provider requests.
  const [result, setResult] = useState(null);
  const [scanning, setScanning] = useState(false);

  const user = session?.user ?? null;

  useEffect(() => {
    api.me().then(setSession).catch((e) => setError(e.message));
  }, []);

  // Settings belong to whoever is signed in, so they are fetched per user and dropped on sign-out.
  useEffect(() => {
    if (!user) {
      setSettings(null);
      return;
    }
    api.settings().then(setSettings).catch((e) => setError(e.message));
  }, [user?.id]);

  const signedIn = useCallback((nextUser) => {
    setSession((s) => ({ ...s, user: nextUser }));
    setError(null);
    setResult(null); // another person's scan is not this person's scan
  }, []);

  const signOut = async () => {
    try {
      await api.logout();
    } catch (e) {
      setError(e.message);
    }
    setSession((s) => ({ ...s, user: null }));
    setSettings(null);
    setResult(null);
  };

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

  if (!session) {
    return (
      <main className="app">
        {error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}
      </main>
    );
  }

  if (session.accounts && !user) {
    return <LoginPage onSignedIn={signedIn} />;
  }

  // A member who types #/users gets the Screener rather than a broken page. The server refuses
  // the data either way; this is just so the app does not look broken.
  const allowed = pagesFor(session);
  const page = allowed.some(([key]) => key === route.page) ? route.page : 'screener';

  return (
    <main className="app">
      <header className="topbar">
        <h1>Options Advisor</h1>

        <nav className="tabs" aria-label="Pages">
          {allowed.map(([key, { label }]) => (
            <a
              key={key}
              href={hrefFor(key)}
              className={page === key ? 'tab active' : 'tab'}
              aria-current={page === key ? 'page' : undefined}
            >
              {label}
            </a>
          ))}
        </nav>

        {session.accounts && (
          <div className="who">
            <span className="muted small">{user.email}</span>
            <button type="button" className="link-button" onClick={signOut}>
              Sign out
            </button>
          </div>
        )}
      </header>

      {error && <p className="error">{error}</p>}

      {!settings && page !== 'users' && page !== 'account' ? (
        <p className="muted">Loading…</p>
      ) : page === 'users' ? (
        <UsersPage me={user} />
      ) : page === 'account' ? (
        <AccountPage me={user} />
      ) : page === 'simulator' ? (
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
