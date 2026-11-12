import { useEffect, useState } from 'react';

import { interpretQuery, withoutCondition } from '@domain/query.js';

import BriefPanel from '../components/BriefPanel.jsx';
import Watchlist from '../components/Watchlist.jsx';
import Filters from '../components/Filters.jsx';
import ResultsTable from '../components/ResultsTable.jsx';
import AskPanel from '../components/AskPanel.jsx';
import { QueryBox, Reading, Templates } from '../components/ScreenQuery.jsx';
import { STRATEGY_LABELS } from '../format.js';
import { STALE_AFTER_MS, ageOf } from '../lastScan.js';

import { dateLocale, tr } from '../i18n.js';
/**
 * The daily screen. Scan state lives in App, not here, so switching to the Simulator and back
 * does not throw away a scan — and does not spend another round of provider requests.
 *
 * You describe the screen in words. The words are read into conditions here, in the browser, by
 * rules (domain/query.js) — so reading costs nothing and the same words always mean the same
 * thing — and the conditions go to the scan as filters. The watchlist stays beside the results:
 * it is what the screen runs over, and nothing outside it is scanned.
 */
export default function ScreenerPage({ settings, onFilters, onActivate, scan, guest = false }) {
  const [showFilters, setShowFilters] = useState(false);
  const { result, scanning, progress, run } = scan;

  // The box starts on the query the scan on screen was run for, including one restored from an
  // earlier visit, so what you see and what the box says never disagree.
  const [text, setText] = useState(result?.query?.text ?? '');
  const [showTemplates, setShowTemplates] = useState(false);
  const [rowFilter, setRowFilter] = useState('');
  useEffect(() => {
    if (result?.query?.text != null && !text) setText(result.query.text);
  }, [result?.generatedAt]);

  const symbols = settings.watchlist.map((w) => w.symbol);
  const query = result?.query ?? null;

  const runQuery = (words, { fresh = false } = {}) => {
    const typed = String(words ?? '').trim();
    setText(typed);
    setRowFilter('');
    setShowTemplates(false);
    run({ fresh, query: typed ? { text: typed, ...interpretQuery(typed, { symbols }) } : null });
  };
  // Taking a chip off takes its words out of the sentence too and runs what is left, so the box
  // and the chips never say different things.
  const removeCondition = (id) => runQuery(withoutCondition(query.text, query.conditions.find((c) => c.id === id)));
  const addPhrase = (phrase) => runQuery(text.trim() ? `${text.trim()}, ${phrase}` : phrase);

  const shown = result ? filterRows(result.candidates, rowFilter) : [];

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

      <QueryBox text={text} onText={setText} onRun={runQuery} scanning={scanning}>
        {/* Bypassing the cache spends the shared rate limit, so it is an account feature. */}
        {!guest && (
          <button type="button" onClick={() => runQuery(text, { fresh: true })} disabled={scanning} title={tr('Ignore cached chains')}>
            {tr('Refresh data')}
          </button>
        )}
        <button type="button" aria-expanded={showTemplates} onClick={() => setShowTemplates((v) => !v)}>
          {tr('Templates')}
        </button>
        <button type="button" aria-expanded={showFilters} onClick={() => setShowFilters((v) => !v)}>
          {showFilters ? tr('Hide filters') : tr('Filters')}
        </button>

        {/* Which list is about to be scanned, changeable without leaving the page. The scan
            follows the same choice the Watchlist tab shows, so there is one answer to "what
            will this scan?" rather than two. */}
        {settings.watchlists?.length > 1 && (
          <label className="scan-scope">
            <span className="muted small">{tr('Scanning')}</span>
            <select value={settings.activeWatchlistId ?? ''} disabled={scanning} onChange={(event) => onActivate(event.target.value)}>
              {settings.watchlists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name} ({list.entries.length})
                </option>
              ))}
            </select>
          </label>
        )}
      </QueryBox>

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

          {/* Templates are the empty state, and one click away afterwards. */}
          {(showTemplates || (!result && !scanning)) && <Templates onRun={runQuery} scanning={scanning} />}

          {!result && !scanning && (
            <p className="muted small">
              {tr('The first scan of the day fetches every chain fresh and takes about a minute; later ones reuse what it fetched. It is a screener, not advice — check every number against your broker before acting on it.')}
            </p>
          )}

          {result && !scanning && <StaleNotice result={result} onScan={() => runQuery(text)} />}

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

              <Reading
                query={query}
                result={result}
                filters={settings.filters}
                guest={guest}
                scanning={scanning}
                onRemove={removeCondition}
                onAdd={addPhrase}
                onEditFilters={() => setShowFilters(true)}
              />

              {result.failures.length > 0 && (
                <p className="error small">
                  {result.failures.map((f) => `${f.symbol}: ${tr(f.error)}`).join(' · ')}
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
                  {query?.conditions?.length
                    ? tr('Nothing on this watchlist matches. Take a condition off above, or loosen your saved filters — on a quiet day little pays enough to clear a high bar.')
                    : tr('Nothing passed. The filters are the usual culprit — try a lower win probability or a lower return on risk; on a quiet day nothing pays enough to clear both.')}
                </p>
              ) : (
                <>
                  <label className="row-filter">
                    <span className="sr-only">{tr('Filter rows')}</span>
                    <input
                      type="search"
                      value={rowFilter}
                      placeholder={tr('Filter rows — a symbol, a strategy, an expiry')}
                      onChange={(event) => setRowFilter(event.target.value)}
                    />
                    {rowFilter && (
                      <span className="muted small" role="status">
                        {tr('{0} of {1} rows', [shown.length, result.candidates.length])}
                      </span>
                    )}
                  </label>
                  <div className="table-wrap">
                    {/* Keyed by the scan, so a new screen opens in the order it asked for. */}
                    <ResultsTable key={result.generatedAt} candidates={shown} initialSort={result.sort} />
                  </div>
                </>
              )}

            </>
          )}
        </section>
      </div>
    </>
  );
}

// The box above the table: narrows the rows already on screen, without another scan.
function filterRows(candidates, typed) {
  const words = typed.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return candidates;
  return candidates.filter((c) => {
    const hay = `${c.symbol} ${tr(STRATEGY_LABELS[c.kind] ?? c.kind)} ${STRATEGY_LABELS[c.kind] ?? ''} ${c.expiration}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
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
