import { useEffect, useState } from 'react';

import BriefPanel from '../components/BriefPanel.jsx';
import Watchlist from '../components/Watchlist.jsx';
import Filters from '../components/Filters.jsx';
import ResultsTable from '../components/ResultsTable.jsx';
import AskPanel from '../components/AskPanel.jsx';
import { STALE_AFTER_MS, ageOf } from '../lastScan.js';

/**
 * The daily screen. Scan state lives in App, not here, so switching to the Simulator and back
 * does not throw away a scan — and does not spend another round of provider requests.
 */
export default function ScreenerPage({ settings, onFilters, onActivate, scan }) {
  const [showFilters, setShowFilters] = useState(false);
  const { result, scanning, progress, run } = scan;

  return (
    <>
      {/* Above everything, including the scan controls: it is about positions you already hold,
          which outranks anything you might open today. */}
      <BriefPanel />

      <div className="page-head">
        <p className="muted small">
          Ranks the structures your filters allow, using one snapshot of the chain. It is a screener,
          not advice — it has never seen your account, your other positions, or anything about the
          company beyond its option prices. Check every number against your broker before acting on
          it.
        </p>

        <div className="actions">
          {/* Which list is about to be scanned, changeable without leaving the page. The scan
              follows the same choice the Watchlist tab shows, so there is one answer to "what
              will this scan?" rather than two. */}
          {settings.watchlists?.length > 1 && (
            <label className="scan-scope">
              <span className="muted small">Scanning</span>
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
          <Watchlist watchlist={settings.watchlist} name={settings.watchlists?.find((l) => l.id === settings.activeWatchlistId)?.name} />

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
          {scanning && <ScanProgress progress={progress} />}

          {!result && !scanning && (
            <p className="muted">
              Press Scan to look at today&rsquo;s chains. The first scan of the day fetches every chain
              fresh and takes about a minute; later ones reuse what it fetched.
            </p>
          )}

          {result && !scanning && <StaleNotice result={result} onScan={() => run()} />}

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
              <AskPanel advisor={settings.advisor} hasResult={result.candidates.length > 0} />

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
          {progress?.current ? `Fetching ${progress.current}` : 'Starting the scan'}
        </strong>
        <span className="muted small">
          {total > 0 && `${done} of ${total} symbols · `}
          {formatElapsed(elapsed)}
        </span>
      </div>
      <progress max={total || 1} value={total ? done : undefined} aria-label="Scan progress" />
      {elapsed >= 8 && (
        <p className="muted small">
          A first scan fetches every chain fresh, which is about a minute on a cold cache. Later scans
          reuse it and take seconds.
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
        Your last scan, from {scanTime(result.generatedAt)} ({ageOf(result.generatedAt)}).{' '}
        <button type="button" className="link-button" onClick={onScan}>
          Scan again
        </button>
      </p>
    );
  }

  return (
    <p className="warning small scan-stale">
      Showing the scan from {scanTime(result.generatedAt)} ({ageOf(result.generatedAt)}). Prices
      have moved since — scan again before acting on any of it.{' '}
      <button type="button" className="link-button" onClick={onScan}>
        Scan now
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
    ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : when.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
