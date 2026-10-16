import { useCallback, useEffect, useState } from 'react';

import { REASONS } from '@domain/brief.js';

import { api } from '../api.js';
import { hrefFor } from '../router.js';

/**
 * The morning brief, at the top of the home screen.
 *
 * Two layers, in this order: the findings, which are computed and are the actual content, and —
 * above them — the four sentences a model wrote about those same findings. The prose is on top
 * because it is what you read at 9am; the list is underneath because it is what you check.
 *
 * It renders perfectly well with no prose at all. Without an API key the server stores the
 * findings and leaves the summary null, and this shows the list with a line saying so. That is
 * not a degraded state to apologise for — it is the brief, minus a convenience.
 */
export default function BriefPanel() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    try {
      setState(refresh ? await api.refreshBrief() : await api.brief());
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <p className="error small">{error}</p>;
  if (!state) return null;

  const { brief, day } = state;

  // Before nine on the first weekday the app has seen, there is nothing to show and nothing is
  // wrong. Saying when the next one is due beats an empty panel that looks broken.
  if (!brief) {
    return (
      <section className="panel brief brief-empty">
        <p className="muted small">
          The morning brief is written after 09:00 New York time on weekdays. The next one is due
          then.
        </p>
      </section>
    );
  }

  const list = brief.findings ?? [];
  const counts = list.reduce((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] ?? 0) + 1 }), {});

  return (
    <section className={`panel brief${list.length === 0 ? ' brief-quiet' : ''}`}>
      <header className="brief-head">
        <h3>
          Morning brief
          <span className="muted small"> · {day}</span>
        </h3>

        <div className="brief-actions">
          <span className="muted small">
            {list.length === 0
              ? 'nothing flagged'
              : [counts.high && `${counts.high} serious`, counts.watch && `${counts.watch} to watch`]
                  .filter(Boolean)
                  .join(', ')}
          </span>
          {list.length > 0 && (
            <button type="button" className="link-button" onClick={() => setOpen((v) => !v)}>
              {open ? 'Hide detail' : 'Show detail'}
            </button>
          )}
          <button type="button" className="link-button" onClick={() => load(true)} disabled={busy}>
            {busy ? 'Running…' : 'Run again'}
          </button>
        </div>
      </header>

      {brief.summary ? (
        <p className="brief-summary">{brief.summary}</p>
      ) : (
        <p className="muted small">
          {state.advisor
            ? 'The written summary did not come back this morning — the findings below are the brief.'
            : 'No ANTHROPIC_API_KEY set, so there is no written summary. The findings below are the brief.'}
        </p>
      )}

      {brief.ungrounded?.length > 0 && (
        // The same check the advisor does. Shown rather than silently stripped: a summary that
        // names something nobody fed it is exactly what you want to know about.
        <p className="warn-text small">
          The summary mentions {brief.ungrounded.join(', ')}, which {brief.ungrounded.length === 1 ? 'is' : 'are'} not
          in the findings. Trust the list below.
        </p>
      )}

      {open && list.length > 0 && (
        <ul className="brief-findings">
          {list.map((finding) => (
            <li key={finding.id} className={`finding sev-${finding.severity}`}>
              <div className="finding-head">
                {finding.kind === 'symbol' ? (
                  <a className="ticker-link" href={hrefFor('ticker', { symbol: finding.symbol })}>
                    {finding.subject}
                  </a>
                ) : (
                  <a className="ticker-link" href={hrefFor('positions')}>
                    {finding.subject}
                  </a>
                )}
                <span className="finding-tags">
                  {/* The label, not just the colour. Every reason says what it is in words. */}
                  {finding.reasons.map((r) => (
                    <span key={r.code} className={`badge tone-${r.severity === 'high' ? 'serious' : 'warn'}`}>
                      {r.label ?? REASONS[r.code]?.label ?? r.code}
                    </span>
                  ))}
                </span>
              </div>
              <ul className="finding-why">
                {finding.reasons.map((r) => (
                  <li key={r.code} className="muted small">
                    {r.text}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <p className="muted small brief-footnote">
        Found by the app, not by a model: breached strikes, expiries inside a week, earnings and
        ex-dividend dates before an expiry, and watchlist names that moved more than they usually
        do. {brief.summary ? 'The model only turned that list into the sentences above.' : ''}
      </p>
    </section>
  );
}
