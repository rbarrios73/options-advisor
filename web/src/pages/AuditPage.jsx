import { useEffect, useState } from 'react';

import { api } from '../api.js';

import { dateLocale, tr } from '../i18n.js';
/**
 * Who is using the app, and what has happened to its accounts. Administrators only.
 *
 * Opens on the two questions an administrator comes with — who is in right now, and is anyone
 * guessing passwords — then the full log, newest first, filterable by what happened.
 */
export default function AuditPage() {
  const [data, setData] = useState(null);
  const [entries, setEntries] = useState([]);
  const [event, setEvent] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = async ({ before = null } = {}) => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.audit({ before, event });
      if (before) {
        setEntries((e) => [...e, ...page.entries]);
        setData((d) => ({ ...d, more: page.more, next: page.next }));
      } else {
        setEntries(page.entries);
        setData(page);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [event]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !data) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">{tr('Loading the audit log…')}</p>;

  return (
    <div className="audit-page">
      <section className="panel" aria-labelledby="online-title">
        <div className="chart-head">
          <h2 id="online-title">{tr('Signed in now')}</h2>
          <span className="muted small">{tr('active in the last 15 minutes · one row per browser')}</span>
          <button type="button" className="audit-refresh" onClick={() => load()} disabled={loading}>
            {loading ? tr('Refreshing…') : tr('Refresh')}
          </button>
        </div>
        {data.online.length === 0 ? (
          <p className="muted small">{tr('Nobody else is using the app right now.')}</p>
        ) : (
          <div className="scroll-x">
            <table className="audit-table">
              <thead>
                <tr>
                  <th scope="col">{tr('Account')}</th>
                  <th scope="col">{tr('Role')}</th>
                  <th scope="col">{tr('Signed in')}</th>
                  <th scope="col">{tr('Last active')}</th>
                  <th scope="col">{tr('Browser')}</th>
                  <th scope="col">{tr('IP address')}</th>
                </tr>
              </thead>
              <tbody>
                {data.online.map((o, i) => (
                  <tr key={`${o.userId}-${o.since}-${i}`}>
                    <th scope="row">{o.email}</th>
                    <td>{o.role === 'admin' ? tr('Admin') : tr('Member')}</td>
                    <td className="nowrap">{when(o.since)}</td>
                    <td className="nowrap">{ago(o.lastSeen)}</td>
                    <td>{o.agent ?? '—'}</td>
                    <td className="mono">{o.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data.failures?.length > 0 && (
        <section className="panel audit-failures" aria-labelledby="failures-title">
          <div className="chart-head">
            <h2 id="failures-title">{tr('Failed sign-ins, last 24 hours')}</h2>
            <span className="muted small">{tr('by the address that was typed')}</span>
          </div>
          <ul className="audit-failure-list">
            {data.failures.map((f) => (
              <li key={f.email || '(blank)'}>
                <strong>{f.email || tr('(blank)')}</strong> — {f.attempts === 1 ? tr('1 attempt, last {0}', [ago(f.last)]) : tr('{0} attempts, last {1}', [f.attempts, ago(f.last)])}
              </li>
            ))}
          </ul>
          <p className="muted small">
            {tr('Sign-in is already rate-limited per address. A run of failures on one account is someone guessing; on many accounts at once, someone trying a password list.')}
          </p>
        </section>
      )}

      <section className="panel" aria-labelledby="log-title">
        <div className="chart-head">
          <h2 id="log-title">{tr('Audit log')}</h2>
          <span className="muted small">{tr('newest first · kept ')}{data.retentionDays}{tr(' days')}</span>
          <label className="control audit-filter">
            <span className="sr-only">{tr('Show')}</span>
            <select value={event} onChange={(e) => setEvent(e.target.value)} aria-label={tr('Filter by event')}>
              <option value="">{tr('Every event')}</option>
              {Object.entries(data.events).map(([key, label]) => (
                <option key={key} value={key}>
                  {tr(label)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {entries.length === 0 ? (
          <p className="muted small">{tr('Nothing recorded')}{event ? tr(' of that kind') : ''}{tr(' yet.')}</p>
        ) : (
          <div className="scroll-x">
            <table className="audit-table">
              <thead>
                <tr>
                  <th scope="col">{tr('When')}</th>
                  <th scope="col">{tr('Event')}</th>
                  <th scope="col">{tr('Account')}</th>
                  <th scope="col">{tr('By')}</th>
                  <th scope="col">{tr('Detail')}</th>
                  <th scope="col">{tr('Browser')}</th>
                  <th scope="col">{tr('IP address')}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className={`audit-${e.event}`}>
                    <td className="nowrap" title={new Date(e.at).toString()}>
                      {when(e.at)}
                    </td>
                    <td className="nowrap">
                      <span className={`audit-tag tag-${tagOf(e.event)}`}>{tr(e.label)}</span>
                    </td>
                    <td>{e.email || <span className="muted">{tr('(blank)')}</span>}</td>
                    <td className="small">
                      {/* A failed sign-in was typed by someone unknown — not by the account named. */}
                      {e.actorEmail ?? <span className="muted">{e.event === 'sign_in_failed' ? tr('unknown') : tr('themselves')}</span>}
                    </td>
                    <td className="small">{e.detail ?? ''}</td>
                    <td className="small">{e.agent ?? '—'}</td>
                    <td className="mono small">{e.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data.more && (
          <p>
            <button type="button" onClick={() => load({ before: data.next })} disabled={loading}>
              {loading ? tr('Loading…') : tr('Show older')}
            </button>
          </p>
        )}
        {error && <p className="error small">{error}</p>}
      </section>
    </div>
  );
}

// Which tag an event wears: a failure is the one worth catching the eye; admin changes are
// distinct from people coming and going. Always with its words, never colour alone.
const tagOf = (event) =>
  event === 'sign_in_failed' ? 'fail' : event.startsWith('user_') || event === 'password_reset' ? 'admin' : 'plain';

const when = (iso) =>
  new Date(iso).toLocaleString(dateLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function ago(iso) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return tr('just now');
  if (minutes < 60) return tr('{0} min ago', [minutes]);
  const hours = Math.round(minutes / 60);
  return hours < 24 ? tr('{0} h ago', [hours]) : tr('{0} d ago', [Math.round(hours / 24)]);
}
