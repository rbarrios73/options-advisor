import { useEffect, useState } from 'react';

import BriefPanel from '../components/BriefPanel.jsx';
import Watchlist from '../components/Watchlist.jsx';
import Filters from '../components/Filters.jsx';
import ResultsTable from '../components/ResultsTable.jsx';
import AskPanel from '../components/AskPanel.jsx';
import { STALE_AFTER_MS, ageOf } from '../lastScan.js';

import { dateLocale, tr } from '../i18n.js';
/**
 * The daily screen. Scan state lives in App, not here, so switching to the Simulator and back
 * does not throw away a scan — and does not spend another round of provider requests.
 */
export default function ScreenerPage({ settings, onFilters, onActivate, scan, guest = false }) {
  const [showFilters, setShowFilters] = useState(false);
  const { result, scanning, progress, run } = scan;

  return (
    <>
      {/* Above everything, including the scan controls: it is about positions you already hold,
          which outranks anything you might open today. */}
      {/* The brief is about your positions, which a guest does not have. */}
      {!guest && <BriefPanel />}

      {guest && (
        <p className="notice small guest-note">
          {tr('You are scanning the starter watchlist with the default filters.')}{' '}
          <a href="#/signup">{tr('Create a free account')}</a>{tr(' or ')}<a href="#/signin">{tr('sign in')}</a>{tr(' to scan your own lists, tune the filters, and open trades in the Simulator.')}
        </p>
      )}

      <div className="page-head">
        <p className="muted small">
          {tr('Ranks the structures your filters allow, using one snapshot of the chain. It is a screener, not advice — it has never seen your account, your other positions, or anything about the company beyond its option prices. Check every number against your broker before acting on it.')}
        </p>

        <div className="actions">
          {/* Which list is about to be scanned, changeable without leaving the page. The scan
              follows the same choice the Watchlist tab shows, so there is one answer to "what
              will this scan?" rather than two. */}
          {settings.watchlists?.length > 1 && (
            <label className="scan-scope">
              <span className="muted small">{tr('Scanning')}</span>
              <select
                value={settings.activeWatchlistId ?? ''}
                disabled={scanning}
                onChange={(event) => onActivate(event.target.value)}
              >
                {settings.watchlists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name} ({list.entries.length})
                  </option>
                ))}
              </select>
            </label>
          )}

          <button className="primary" onClick={() => run()} disabled={scanning}>
            {scanning ? tr('Scanning…') : tr('Scan')}
          </button>
          {/* Bypassing the cache spends the shared rate limit, so it is an account feature. */}
          {!guest && (
            <button onClick={() => run({ fresh: true })} disabled={scanning} title={tr('Ignore cached chains')}>
              {tr('Refresh data')}
            </button>
          )}
          <button onClick={() => setShowFilters((v) => !v)}>{showFilters ? tr('Hide filters') : tr('Filters')}</button>
        </div>
      </div>

      <div className="layout">
        <aside>
          <Watchlist watchlist={settings.watchlist} name={settings.watchlists?.find((l) => l.id === settings.activeWatchlistId)?.name} />

          {showFilters && (
            // A guest sees the filters the scan uses, but cannot change them: there is no account
            // to save them to, and the server scans a guest on the defaults whatever is sent.
            <fieldset className="plain-fieldset" disabled={guest}>
              {guest && <p className="muted small">{tr('The default filters. Sign in to tune your own.')}</p>}
              <Filters
                filters={settings.filters}
                weights={settings.weights}
                onFilters={(filters) => onFilters(filters, settings.weights)}
                onWeights={(weights) => onFilters(settings.filters, weights)}
              />
            </fieldset>
          )}

          <p className="muted small provider">
            {tr('Data: ')}{settings.provider}
            {settings.provider === 'mock' && tr(' — synthetic chains, for checking the app works')}
          </p>
        </aside>

        <section className="results-pane">
          {scanning && <ScanProgress progress={progress} />}

          {!result && !scanning && (
            <p className="muted">
              {tr('Press Scan to look at today’s chains. The first scan of the day fetches every chain fresh and takes about a minute; later ones reuse what it fetched.')}
            </p>
          )}

          {result && !scanning && <StaleNotice result={result} onScan={() => run()} />}

          {result && (
            <>
              <div className="summary">
                <span>
                  <strong>{result.candidates.length}</strong>{tr(' shown of ')}{result.totalCandidates}{tr(' that passed the filters')}
                </span>
                <span className="muted">
                  {result.symbols.map((s) => `${s.symbol} ${s.spot?.toFixed(2)}`).join('  ·  ')}
                </span>
                <span className="muted">{scanTime(result.generatedAt)}</span>
              </div>

              {result.failures.length > 0 && (
                <p className="error small">
                  {result.failures.map((f) => `${f.symbol}: ${f.error}`).join(' · ')}
                </p>
              )}

              {/* Above the table rather than below it. A scan can return sixty rows, and a box at
                  the bottom is a box nobody scrolls to — this sits where your eye lands when the
                  scan finishes, and the answer appears there too. */}
              {/* An account feature (it costs money per question), and its "off" message is
                  written for whoever runs the app — neither is for a visitor. */}
              {!guest && <AskPanel advisor={settings.advisor} hasResult={result.candidates.length > 0} />}

              {result.candidates.length === 0 ? (
                <p className="muted">
                  {tr('Nothing passed. The filters are the usual culprit — try a lower win probability or a lower return on risk; on a quiet day nothing pays enough to clear both.')}
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

/**
 * What the scan is doing, while it does it: which symbol, how many of how many, how long so far.
 * A cold cache is ~60 provider requests, and a minute behind a button that only says "Scanning…"
 * reads as a hang. Polite live region, so a screen reader hears it without being interrupted.
 */
function ScanProgress({ progress }) {
  const elapsed = useElapsed(progress?.startedAt);
  const total = progress?.total ?? 0;
  const done = Math.min(progress?.done ?? 0, total);

  return (
    <div className="scan-progress panel" role="status" aria-live="polite">
      <div className="scan-progress-line">
        <strong>
          {progress?.current ? tr('Fetching {0}', [progress.current]) : tr('Starting the scan')}
        </strong>
        <span className="muted small">
          {total > 0 && tr('{0} of {1} symbols · ', [done, total])}
          {formatElapsed(elapsed)}
        </span>
      </div>
      <progress max={total || 1} value={total ? done : undefined} aria-label={tr('Scan progress')} />
      {elapsed >= 8 && (
        <p className="muted small">
          {tr('A first scan fetches every chain fresh, which is about a minute on a cold cache. Later scans reuse it and take seconds.')}
        </p>
      )}
    </div>
  );
}

/**
 * Said above a scan that is not fresh — one restored from this browser, or simply one that has
 * sat on screen a while. Prices move; a credit from yesterday is not on offer today.
 */
function StaleNotice({ result, onScan }) {
  // Re-render each minute so "4 min ago" does not freeze while the page is open.
  useElapsed(result.generatedAt, 60_000);
  const age = Date.now() - new Date(result.generatedAt).getTime();
  const stale = age >= STALE_AFTER_MS;
  if (!result.restored && !stale) return null;

  // Restored but recent — a reload, or a trip to another tab — is worth naming, not warning about.
  if (!stale) {
    return (
      <p className="muted small scan-stale">
        {tr('Your last scan, from ')}{scanTime(result.generatedAt)} ({ageOf(result.generatedAt)}).{' '}
        <button type="button" className="link-button" onClick={onScan}>
          {tr('Scan again')}
        </button>
      </p>
    );
  }

  return (
    <p className="warning small scan-stale">
      {tr('Showing the scan from ')}{scanTime(result.generatedAt)} ({ageOf(result.generatedAt)}{tr('). Prices have moved since — scan again before acting on any of it.')}{' '}
      <button type="button" className="link-button" onClick={onScan}>
        {tr('Scan now')}
      </button>
    </p>
  );
}

/** Seconds since `iso`, ticking every `everyMs` until it is cleared. */
function useElapsed(iso, everyMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return undefined;
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [iso, everyMs]);
  return iso ? Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000)) : 0;
}

const formatElapsed = (seconds) =>
  seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** The time alone for a scan from today; the day as well for anything older. */
function scanTime(iso) {
  const when = new Date(iso);
  const today = new Date().toDateString() === when.toDateString();
  return today
    ? when.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })
    : when.toLocaleString(dateLocale(), { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
