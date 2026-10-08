import { useCallback, useEffect, useState } from 'react';

import { api } from './api.js';
import { hrefFor, pagesFor, useRoute } from './router.js';
import { applyTheme, readStoredTheme, storeTheme, watchSystemTheme } from './theme.js';
import ThemeToggle from './components/ThemeToggle.jsx';
import ScreenerPage from './pages/ScreenerPage.jsx';
import SimulatorPage from './pages/SimulatorPage.jsx';
import TickerPage from './pages/TickerPage.jsx';
import WatchlistPage from './pages/WatchlistPage.jsx';
import PositionsPage from './pages/PositionsPage.jsx';
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

  // The theme the viewer chose. Seeded from this browser's storage so it matches what the inline
  // script in index.html already painted; replaced by the account's own choice once settings
  // arrive, which is what lets it follow you to another machine.
  const [theme, setThemeState] = useState(readStoredTheme);

  useEffect(() => {
    applyTheme(theme);
    storeTheme(theme);
  }, [theme]);

  // A machine that flips to dark at sunset should move anyone who chose "system". The stamp is
  // always a resolved light or dark, so nothing repaints unless the answer actually changed.
  useEffect(() => {
    if (theme !== 'system') return undefined;
    return watchSystemTheme(() => applyTheme('system'));
  }, [theme]);

  const setTheme = (next) => {
    setThemeState(next);
    // Saved to the account as well, so the choice is not stranded in one browser. It is a
    // preference, not a transaction: a failure here is not worth an error banner over the app.
    if (user) api.saveTheme(next).catch(() => {});
  };

  useEffect(() => {
    api.me().then(setSession).catch((e) => setError(e.message));
  }, []);

  // Settings belong to whoever is signed in, so they are fetched per user and dropped on sign-out.
  useEffect(() => {
    if (!user) {
      setSettings(null);
      return;
    }
    api
      .settings()
      .then((loaded) => {
        setSettings(loaded);
        // The account's choice wins over this browser's, so signing in on a new machine brings
        // your appearance with you rather than adopting whatever that machine had.
        if (loaded.theme) setThemeState(loaded.theme);
      })
      .catch((e) => setError(e.message));
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
      // The server tidies what it stores — upper-cases, trims, drops duplicates — so the answer
      // it sends back replaces the optimistic copy. Otherwise the screen keeps showing what was
      // typed while the database holds something slightly different.
      const stored = await api.saveWatchlist(watchlist);
      setSettings((s) => ({ ...s, ...stored }));
    } catch (e) {
      setError(e.message);
    }
  };

  /**
   * Creating, renaming, switching and deleting a list.
   *
   * These THROW rather than swallowing, because each one has a refusal worth reading where the
   * button is — "this is your only watchlist", "you already have one called that" — and a message
   * at the top of the page is not an answer to a button at the bottom.
   *
   * Every route answers with the whole settings state, so the app replaces what it holds: a
   * delete changes which list is active as well, and patching one field would miss that.
   */
  const watchlists = {
    create: async (name, entries) => setSettings(await api.createWatchlist(name, entries)),
    rename: async (id, name) => setSettings(await api.renameWatchlist(id, name)),
    activate: async (id) => {
      setSettings(await api.activateWatchlist(id));
      setResult(null); // another list's scan is not this list's scan
    },
    remove: async (id) => setSettings(await api.deleteWatchlist(id)),
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
    return <LoginPage onSignedIn={signedIn} theme={theme} onTheme={setTheme} />;
  }

  // A member who types #/users gets the Screener rather than a broken page. The server refuses
  // the data either way; this is just so the app does not look broken.
  const allowed = pagesFor(session);
  const page = allowed.some(([key]) => key === route.page) ? route.page : 'screener';

  return (
    <main className="app">
      <header className="topbar">
        <a className="brand" href={hrefFor('screener')}>
          {/* The wordmark already says the name on the sign-in screen; here the monogram sits
              beside the heading, so alt="" keeps a screen reader from reading it twice. */}
          <img src="/logo-mark.png" alt="" width="58" height="40" />
          <h1>Option Advisor</h1>
        </a>

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

        <div className="who">
          <ThemeToggle value={theme} onChange={setTheme} />

          {session.accounts && (
            <>
              <span className="muted small">{user.email}</span>
              <button type="button" className="link-button" onClick={signOut}>
                Sign out
              </button>
            </>
          )}
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      {!settings && page !== 'users' && page !== 'account' ? (
        <p className="muted">Loading…</p>
      ) : page === 'users' ? (
        <UsersPage me={user} />
      ) : page === 'account' ? (
        <AccountPage me={user} />
      ) : page === 'watchlist' ? (
        <WatchlistPage
          watchlist={settings.watchlist}
          watchlists={settings.watchlists ?? []}
          activeId={settings.activeWatchlistId}
          onWatchlist={saveWatchlist}
          lists={watchlists}
          accounts={session.accounts}
        />
      ) : page === 'positions' ? (
        <PositionsPage />
      ) : page === 'ticker' ? (
        <TickerPage
          key={route.params.symbol ?? ''}
          watchlist={settings.watchlist}
          listName={settings.watchlists?.find((l) => l.id === settings.activeWatchlistId)?.name}
          onWatchlist={saveWatchlist}
          params={route.params}
        />
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
          onActivate={watchlists.activate}
          onFilters={saveFilters}
          scan={{ result, scanning, run: runScan }}
        />
      )}
    </main>
  );
}
