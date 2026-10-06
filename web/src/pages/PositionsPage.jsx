import { useEffect, useState } from 'react';

import { POSITION_TYPES, STATUSES, breachOf } from '@domain/positions.js';

import { api } from '../api.js';
import { hrefFor } from '../router.js';
import { money, pct, price, shortDate, signed } from '../format.js';

const TYPES = Object.entries(POSITION_TYPES);
const TODAY = () => new Date().toISOString().slice(0, 10);

/**
 * What you actually have on — the tracker.
 *
 * The screener deals in trades you could put on; this one is the trades you did. Columns follow
 * the spreadsheet this replaces, with one difference: current price, the short leg's delta and
 * whether the strike is breached are fetched rather than typed. A hand-coloured "at risk" cell is
 * only as current as the last time somebody looked, and the day it changes is the day it matters.
 */
export default function PositionsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

  const load = async () => {
    try {
      setData(await api.positions());
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const run = async (action) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <div className="positions-page">
        {error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}
      </div>
    );
  }

  const open = data.positions.filter((p) => p.status === 'open');
  const settled = data.positions.filter((p) => p.status !== 'open');
  const rows = showClosed ? data.positions : open;

  return (
    <div className="positions-page">
      <div className="page-head">
        <p className="muted small">
          The trades you have on, and the premium they have realised. Current price, the short
          leg&rsquo;s delta and whether a strike is breached are fetched from the same chain data the
          screener uses — everything else is what you were filled at, which nothing can derive.
        </p>
      </div>

      <Goals totals={data.totals} goals={data.goals} onSave={(goals) => run(() => api.saveGoals(goals))} busy={busy} />

      <AddPosition onAdd={(position) => run(() => api.addPosition(position))} busy={busy} />

      {error && <p className="error small">{error}</p>}

      <div className="positions-head">
        <h2>
          {open.length} open{settled.length > 0 && <span className="muted"> · {settled.length} settled</span>}
        </h2>
        {settled.length > 0 && (
          <button type="button" onClick={() => setShowClosed((v) => !v)}>
            {showClosed ? 'Hide settled' : 'Show settled'}
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="muted">
          Nothing tracked yet. Add a position above — or open one from the{' '}
          <a href={hrefFor('simulator')}>simulator</a> and record it here.
        </p>
      ) : (
        <div className="scroll-x">
          <table className="positions-table">
            <caption className="muted small">
              Open positions first, soonest expiry at the top. Prices as of {data.asOf}.
            </caption>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Symbol</th>
                <th scope="col" className="num">#</th>
                <th scope="col">Account</th>
                <th scope="col">Type</th>
                <th scope="col" className="num">Short</th>
                <th scope="col" className="num">Long</th>
                <th scope="col" className="num">Delta</th>
                <th scope="col">Expiry</th>
                <th scope="col" className="num">Price</th>
                <th scope="col">Earnings</th>
                <th scope="col" className="num">Premium</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((position) => (
                <Row
                  key={position.id}
                  position={position}
                  earnings={data.earnings[position.symbol]}
                  busy={busy}
                  onPatch={(changes) => run(() => api.updatePosition(position.id, changes))}
                  onDelete={() => run(() => api.deletePosition(position.id))}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Premium realised against the targets.
 *
 * Only closed and assigned positions count, on the date they were closed — a credit on a position
 * still open is money at risk, not money kept, and a goal that can go backwards is a goal nobody
 * trusts. Open credit is shown separately and labelled.
 */
function Goals({ totals, goals, onSave, busy }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(goals);

  useEffect(() => setDraft(goals), [goals]);

  return (
    <section className="panel goals">
      <div className="goals-head">
        <h2>Premium against goals</h2>
        <button type="button" onClick={() => setEditing((v) => !v)} disabled={busy}>
          {editing ? 'Done' : 'Edit goals'}
        </button>
      </div>

      {editing ? (
        <form
          className="goals-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSave(draft);
            setEditing(false);
          }}
        >
          {['daily', 'weekly', 'monthly'].map((key) => (
            <label key={key} className="control">
              <span>{key[0].toUpperCase() + key.slice(1)}</span>
              <input
                type="number"
                min="0"
                step="50"
                value={draft[key]}
                onChange={(event) => setDraft((d) => ({ ...d, [key]: Number(event.target.value) }))}
              />
            </label>
          ))}
          <button type="submit" className="primary" disabled={busy}>
            Save
          </button>
        </form>
      ) : (
        <div className="goal-row">
          <Goal label="Today" period={totals.today} />
          <Goal label="This week" period={totals.week} hint={`since ${shortDate(totals.week.from)}`} />
          <Goal label="This month" period={totals.month} />
          <div className="goal">
            <span className="goal-label">Open premium</span>
            <strong className="goal-value">{money(totals.openPremium)}</strong>
            <span className="goal-hint">
              {totals.openCount} position{totals.openCount === 1 ? '' : 's'} — at risk, not banked
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

function Goal({ label, period, hint }) {
  const share = Math.max(0, Math.min(1, period.progress ?? 0));

  return (
    <div className="goal">
      <span className="goal-label">{label}</span>
      <strong className="goal-value">{money(period.net)}</strong>

      {/* A meter, not a chart: one value against one limit. The track is a lighter step of the
          same hue, so the state reads across the whole bar rather than from the fill alone. */}
      <span
        className="meter"
        role="img"
        aria-label={`${money(period.net)} of ${money(period.goal)}, ${pct(period.progress ?? 0, 0)}`}
      >
        <span className="meter-fill" style={{ width: `${share * 100}%` }} />
      </span>

      <span className="goal-hint">
        {pct(period.progress ?? 0, 0)} of {money(period.goal)}
        {period.assignmentLoss > 0 && ` · ${money(period.assignmentLoss)} assigned`}
        {hint && ` · ${hint}`}
      </span>
    </div>
  );
}

const BLANK = {
  symbol: '',
  type: 'VPCS',
  account: '',
  contracts: 1,
  shortStrike: '',
  longStrike: '',
  expiration: '',
  tradeDate: TODAY(),
  premium: '',
};

function AddPosition({ onAdd, busy }) {
  const [draft, setDraft] = useState(BLANK);
  const [open, setOpen] = useState(false);

  const set = (key) => (event) => setDraft((d) => ({ ...d, [key]: event.target.value }));
  const ready = /^[A-Za-z.]{1,6}$/.test(draft.symbol.trim()) && draft.expiration;

  if (!open) {
    return (
      <button type="button" className="primary add-position" onClick={() => setOpen(true)}>
        + Add a position
      </button>
    );
  }

  return (
    <form
      className="panel position-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        onAdd(draft);
        setDraft({ ...BLANK, account: draft.account, tradeDate: draft.tradeDate });
        setOpen(false);
      }}
    >
      <label className="control">
        <span>Symbol</span>
        <input className="w-symbol" value={draft.symbol} onChange={set('symbol')} maxLength={6} autoFocus />
      </label>

      <label className="control">
        <span>Type</span>
        <select value={draft.type} onChange={set('type')}>
          {TYPES.map(([key, { label }]) => (
            <option key={key} value={key}>
              {key} — {label}
            </option>
          ))}
        </select>
      </label>

      <label className="control">
        <span>Account</span>
        <input value={draft.account} onChange={set('account')} list="accounts" placeholder="Fidelity IRA" />
        <datalist id="accounts">
          {['Fidelity IRA', 'Fidelity ROTH', 'Taxable'].map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
      </label>

      <label className="control">
        <span>Contracts</span>
        <input type="number" min="1" className="w-qty" value={draft.contracts} onChange={set('contracts')} />
      </label>

      <label className="control">
        <span>Short strike</span>
        <input type="number" step="0.5" className="w-qty" value={draft.shortStrike} onChange={set('shortStrike')} />
      </label>

      <label className="control">
        <span>Long strike</span>
        <input type="number" step="0.5" className="w-qty" value={draft.longStrike} onChange={set('longStrike')} />
      </label>

      <label className="control">
        <span>Expiry</span>
        <input type="date" value={draft.expiration} onChange={set('expiration')} />
      </label>

      <label className="control">
        <span>Opened</span>
        <input type="date" value={draft.tradeDate} onChange={set('tradeDate')} />
      </label>

      <label className="control">
        <span>Premium $</span>
        <input
          type="number"
          step="1"
          className="w-qty"
          value={draft.premium}
          onChange={set('premium')}
          title="Total credit for the whole position, as the broker's fill shows it"
        />
      </label>

      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy || !ready}>
          Add
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Row({ position, earnings, busy, onPatch, onDelete }) {
  const [settling, setSettling] = useState(null); // 'closed' | 'assigned' | 'rolled'
  const breach = position.breach ?? breachOf(position, position.spot);
  const expiringSoon = position.status === 'open' && position.daysLeft <= 2;

  return (
    <>
      <tr className={`pos-${position.status}${breach?.level === 'breached' ? ' pos-breached' : ''}`}>
        <td>
          {/* Label and colour together, never colour alone — a status you can only see is a
              status a colour-blind reader cannot. */}
          <span className={`badge tone-${STATUSES[position.status].tone}`}>{STATUSES[position.status].label}</span>
          {breach?.level === 'breached' && <span className="badge tone-warn">In the money</span>}
          {breach?.level === 'near' && <span className="badge tone-watch">Near strike</span>}
        </td>

        <td>
          <a className="ticker-link" href={hrefFor('ticker', { symbol: position.symbol })}>
            {position.symbol}
          </a>
        </td>
        <td className="num">{position.contracts}</td>
        <td className="small muted">{position.account || '—'}</td>
        <td title={POSITION_TYPES[position.type]?.label}>{position.type}</td>
        <td className="num">{price(position.shortStrike)}</td>
        <td className="num">{price(position.longStrike)}</td>
        <td className="num">{position.delta == null ? '—' : Math.abs(position.delta).toFixed(3)}</td>
        <td className={expiringSoon ? 'nowrap warn-text' : 'nowrap'}>
          {shortDate(position.expiration)}
          {position.status === 'open' && <span className="muted small"> {position.daysLeft}d</span>}
        </td>
        <td className="num">{price(position.spot)}</td>
        <td className="small muted nowrap">{earnings ? shortDate(earnings) : '—'}</td>
        <td className="num">{position.premium == null ? '—' : signed(position.premium)}</td>

        <td className="row-actions">
          {position.status === 'open' ? (
            <>
              <button type="button" disabled={busy} onClick={() => setSettling(settling ? null : 'closed')}>
                Settle
              </button>
              <a className="link-button" href={hrefFor('simulator', { symbol: position.symbol })}>
                Simulate
              </a>
            </>
          ) : (
            <button type="button" disabled={busy} onClick={onDelete} aria-label={`Delete ${position.symbol}`}>
              Delete
            </button>
          )}
        </td>
      </tr>

      {settling && (
        <tr className="settle-row">
          <td colSpan={13}>
            <SettleForm
              position={position}
              busy={busy}
              onCancel={() => setSettling(null)}
              onSettle={(changes) => {
                onPatch(changes);
                setSettling(null);
              }}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Closing, assigning or rolling a position — the three ways one ends.
 *
 * All three ask for the date, because that is what decides which day's goal the premium lands in,
 * and assuming today would quietly misfile anything entered on a Monday morning.
 */
function SettleForm({ position, busy, onCancel, onSettle }) {
  const [status, setStatus] = useState('closed');
  const [closedAt, setClosedAt] = useState(TODAY());
  const [premium, setPremium] = useState(position.premium ?? '');
  const [assignmentLoss, setLoss] = useState('');
  const [rolledToExpiration, setRollExp] = useState('');
  const [rolledToShortStrike, setRollStrike] = useState('');

  return (
    <form
      className="settle-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSettle({
          status,
          closedAt,
          premium: premium === '' ? null : Number(premium),
          assignmentLoss: status === 'assigned' && assignmentLoss !== '' ? Number(assignmentLoss) : null,
          rolledToExpiration: status === 'rolled' ? rolledToExpiration : null,
          rolledToShortStrike: status === 'rolled' && rolledToShortStrike !== '' ? Number(rolledToShortStrike) : null,
        });
      }}
    >
      <div className="segmented" role="radiogroup" aria-label="How it ended">
        {['closed', 'rolled', 'assigned'].map((key) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={status === key}
            className={status === key ? 'on' : ''}
            onClick={() => setStatus(key)}
          >
            {STATUSES[key].label}
          </button>
        ))}
      </div>

      <label className="control">
        <span>Date</span>
        <input type="date" value={closedAt} onChange={(e) => setClosedAt(e.target.value)} required />
      </label>

      <label className="control">
        <span>Premium kept $</span>
        <input type="number" step="1" className="w-qty" value={premium} onChange={(e) => setPremium(e.target.value)} />
      </label>

      {status === 'assigned' && (
        <label className="control">
          <span>Assignment loss $</span>
          <input type="number" step="1" className="w-qty" value={assignmentLoss} onChange={(e) => setLoss(e.target.value)} />
        </label>
      )}

      {status === 'rolled' && (
        <>
          <label className="control">
            <span>Rolled to</span>
            <input type="date" value={rolledToExpiration} onChange={(e) => setRollExp(e.target.value)} />
          </label>
          <label className="control">
            <span>New short</span>
            <input
              type="number"
              step="0.5"
              className="w-qty"
              value={rolledToShortStrike}
              onChange={(e) => setRollStrike(e.target.value)}
            />
          </label>
        </>
      )}

      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy}>
          Record
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {status === 'rolled' && (
        <p className="muted small">
          Recording a roll settles this row and banks its premium. Add the new position separately —
          it has its own fill.
        </p>
      )}
    </form>
  );
}
