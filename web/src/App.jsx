import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from './api.js';
import { hrefFor, pagesFor, useRoute } from './router.js';
import { PAGES, needsSignIn } from './pages.js';
import { forgetLastScans, loadLastScan, saveLastScan } from './lastScan.js';
import { applyTheme, readStoredTheme, storeTheme, watchSystemTheme } from './theme.js';
import LanguageToggle from './components/LanguageToggle.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';
import ScreenerPage from './pages/ScreenerPage.jsx';
import SimulatorPage from './pages/SimulatorPage.jsx';
import TickerPage from './pages/TickerPage.jsx';
import WatchlistPage from './pages/WatchlistPage.jsx';
import PositionsPage from './pages/PositionsPage.jsx';
import DividendsPage from './pages/DividendsPage.jsx';
import LandingPage from './pages/LandingPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import UsersPage from './pages/UsersPage.jsx';
import AuditPage from './pages/AuditPage.jsx';
import AccountPage from './pages/AccountPage.jsx';

import { rememberedLang, setLang, tr, useLang } from './i18n.js';
export default function App() {
  const route = useRoute();

  // session is { accounts, user }. accounts=false is the single-user deployment, where there is
  // nothing to sign in to and `user` is a stand-in so the rest of the app needs no special case.
  // Subscribed here so a change of language re-renders every page below.
  useLang();

  const [session, setSession] = useState(null);
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);

  // Scan state is held here rather than in the Screener page, so a scan survives a trip to the
  // Simulator and back instead of costing another round of provider requests.
  const [result, setResult] = useState(null);
  const [scanning, setScanning] = useState(false);
  // { done, total, current, startedAt } while a scan runs — what the page shows instead of a
  // button that just says "Scanning…" for a minute.
  const [progress, setProgress] = useState(null);
  const pollRef = useRef(null);

  const user = session?.user ?? null;
  // Accounts on and nobody signed in: the read-only pages are open, the rest lead to sign-in.
  const guest = Boolean(session?.accounts && !user);

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
    api
      .me()
      .then((me) => {
        // The server's guess from the visitor's country — used only until they choose for themselves.
        setLang(rememberedLang() ?? me.lang ?? 'en');
        setSession(me);
      })
      .catch((e) => setError(e.message));
  }, []);

  // Settings belong to whoever is signed in, so they are fetched per user and dropped on sign-out.
  useEffect(() => {
    if (!user && !guest) {
      setSettings(null);
      return;
    }
    api
      .settings()
      .then((loaded) => {
        setSettings(loaded);
        // The account's choice wins over this browser's, so signing in on a new machine brings
        // your appearance with you rather than adopting whatever that machine had. A guest has
        // no account choice, so this browser's stands.
        if (loaded.theme && !loaded.guest) setThemeState(loaded.theme);
      })
      .catch((e) => setError(e.message));
  }, [user?.id, guest]);

  const signedIn = useCallback((nextUser) => {
    // Leaving #/signin behind, so the address bar names the page you are on, not the door you
    // came in by. Any other page in the hash is kept: that is where a shared link meant to go.
    if (AUTH_VIEW.test(window.location.hash)) window.history.replaceState(null, '', hrefFor('screener'));
    setSession((s) => ({ ...s, user: nextUser }));
    setError(null);
    setResult(null); // another person's scan is not this person's scan
    setSettings(null); // and a guest's starter list is not theirs either
  }, []);

  const signOut = async () => {
    forgetLastScans(user?.id);
    // Back to the front door, not to a sign-in form over the page you just left.
    window.history.replaceState(null, '', window.location.pathname);
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

  // Open on the last scan of this list rather than an empty page. Only when nothing is on screen:
  // a scan you just ran is never swapped for an older one.
  const activeListId = settings?.activeWatchlistId;
  useEffect(() => {
    if ((!user && !guest) || !settings || result || scanning) return;
    const kept = loadLastScan(user?.id ?? 'guest', activeListId);
    if (kept) setResult(kept);
  }, [user?.id, guest, activeListId, Boolean(settings)]);

  const stopPolling = () => {
    clearInterval(pollRef.current);
    pollRef.current = null;
  };
  useEffect(() => stopPolling, []);

  const runScan = async ({ fresh = false } = {}) => {
    setScanning(true);
    setError(null);
    setProgress({ done: 0, total: settings?.watchlist?.length ?? 0, current: null, startedAt: new Date().toISOString() });

    // Ask the server how far it has got, once a second. A failed poll is ignored — the scan
    // itself is what matters, and the next poll will usually answer.
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const p = await api.scanProgress();
        if (p.running) setProgress(p);
      } catch {
        // keep the last answer on screen
      }
    }, 1000);

    try {
      const scanned = await api.scan({ fresh, limit: 60 });
      setResult(scanned);
      saveLastScan(user?.id ?? 'guest', activeListId, scanned);
    } catch (e) {
      setError(e.message);
    } finally {
      stopPolling();
      setProgress(null);
      setScanning(false);
    }
  };

  if (!session) {
    return (
      <main className="app">
        {error ? <p className="error">{error}</p> : <p className="muted">{tr('Loading…')}</p>}
      </main>
    );
  }

  if (guest) {
    // The bare address is the landing page; #/signin and #/signup are the form. The read-only
    // pages open as they are. Positions and the Simulator ask for an account first, and keep
    // their address — so after signing in you land on the page you asked for, link and all.
    // useRoute re-renders this on every hash change.
    const hash = window.location.hash.replace(/^#\/?/, '');
    const view = AUTH_VIEW.exec(window.location.hash)?.[1];

    if (!hash) {
      return (
        <LandingPage
          signupOpen={session.signupOpen}
          onStart={(mode) => (window.location.hash = `#/${mode}`)}
          onExplore={() => (window.location.hash = hrefFor('screener'))}
          theme={theme}
          onTheme={setTheme}
        />
      );
    }

    if (view || needsSignIn(route.page, session)) {
      return (
        <LoginPage
          key={view ?? route.page}
          initialMode={view === 'signup' && session.signupOpen ? 'signup' : 'signin'}
          reason={view ? null : tr('Sign in to use {0}. It works with your own trades, so it needs an account.', [tr(PAGES[route.page]?.label) ?? tr('that page')])}
          onBack={() => {
            window.location.hash = view ? '' : hrefFor('screener');
          }}
          backLabel={view ? tr('← About Trader Mice') : tr('← Back to the Screener')}
          onSignedIn={signedIn}
          signupOpen={session.signupOpen}
          theme={theme}
          onTheme={setTheme}
        />
      );
    }
  }

  // A member who types #/users gets the Screener rather than a broken page. The server refuses
  // the data either way; this is just so the app does not look broken.
  const allowed = pagesFor(session);
  const page = allowed.some(([key]) => key === route.page) && !needsSignIn(route.page, session) ? route.page : 'screener';

  return (
    <main className="app">
      <header className="topbar">
        <a className="brand" href={hrefFor('screener')}>
          {/* The wordmark already says the name on the sign-in screen; here the monogram sits
              beside the heading, so alt="" keeps a screen reader from reading it twice. */}
          <img src="/logo-mark.png" alt="" width="58" height="40" />
          <h1>{tr('Trader Mice')}</h1>
        </a>

        <nav className="tabs" aria-label={tr('Pages')}>
          {allowed.map(([key, { label }]) => {
            // Shown to a guest, not hidden: the tab is how they learn the page exists. It leads
            // to sign-in, and says so before the click rather than after.
            const locked = needsSignIn(key, session);
            return (
              <a
                key={key}
                href={hrefFor(key)}
                className={page === key ? 'tab active' : locked ? 'tab locked' : 'tab'}
                aria-current={page === key ? 'page' : undefined}
                title={locked ? tr('Sign in to use this page') : undefined}
              >
                {tr(label)}
                {locked && (
                  <>
                    <LockIcon />
                    <span className="sr-only">{tr(' (sign in required)')}</span>
                  </>
                )}
              </a>
            );
          })}
        </nav>

        <div className="who">
          <LanguageToggle />
          <ThemeToggle value={theme} onChange={setTheme} />

          {guest ? (
            <>
              <a className="link-button" href="#/signin">
                {tr('Sign in')}
              </a>
              {session.signupOpen && (
                <a className="primary button-link" href="#/signup">
                  {tr('Create account')}
                </a>
              )}
            </>
          ) : (
            session.accounts && (
              <>
                <span className="muted small">{user.email}</span>
                <button type="button" className="link-button" onClick={signOut}>
                  {tr('Sign out')}
                </button>
              </>
            )
          )}
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      {!settings && page !== 'users' && page !== 'account' && page !== 'audit' ? (
        <p className="muted">{tr('Loading…')}</p>
      ) : page === 'users' ? (
        <UsersPage me={user} />
      ) : page === 'audit' ? (
        <AuditPage />
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
          guest={guest}
        />
      ) : page === 'positions' ? (
        <PositionsPage />
      ) : page === 'dividends' ? (
        <DividendsPage guest={guest} />
      ) : page === 'ticker' ? (
        <TickerPage
          key={route.params.symbol ?? ''}
          watchlist={settings.watchlist}
          listName={settings.watchlists?.find((l) => l.id === settings.activeWatchlistId)?.name}
          onWatchlist={guest ? undefined : saveWatchlist}
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
          scan={{ result, scanning, progress, run: runScan }}
          guest={guest}
        />
      )}
    </main>
  );
}

/** The two addresses that mean "show the sign-in form" to someone signed out. */
const AUTH_VIEW = /^#\/(signin|signup)\b/;

function LockIcon() {
  return (
    <svg className="tab-lock" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
