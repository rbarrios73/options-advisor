import { useEffect, useState } from 'react';

import { POSITION_TYPES, STATUSES, breachOf } from '@domain/positions.js';
import { simulatorParamsFromPosition } from '@domain/simulate.js';
import PeriodReport from '../components/PeriodReport.jsx';

import { api } from '../api.js';
import { hrefFor } from '../router.js';
import { money, pct, price, shortDate, signed } from '../format.js';

import { tr } from '../i18n.js';
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
        {error ? <p className="error">{error}</p> : <p className="muted">{tr('Loading…')}</p>}
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
          {tr('The trades you have on, and the premium they have realised. Current price, the short leg’s delta and whether a strike is breached are fetched from the same chain data the screener uses — everything else is what you were filled at, which nothing can derive.')}
        </p>
      </div>

      <Goals totals={data.totals} goals={data.goals} onSave={(goals) => run(() => api.saveGoals(goals))} busy={busy} />

      <PeriodReport positions={data.positions} today={data.asOf} />

      <AddPosition onAdd={(position) => run(() => api.addPosition(position))} busy={busy} />

      {error && <p className="error small">{error}</p>}

      <div className="positions-head">
        <h2>
          {open.length}{tr(' open')}{settled.length > 0 && <span className="muted"> · {settled.length}{tr(' settled')}</span>}
        </h2>
        {settled.length > 0 && (
          <button type="button" onClick={() => setShowClosed((v) => !v)}>
            {showClosed ? tr('Hide settled') : tr('Show settled')}
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="muted">
          {tr('Nothing tracked yet. Add a position above — or open one from the')}{' '}
          <a href={hrefFor('simulator')}>{tr('simulator')}</a>{tr(' and record it here.')}
        </p>
      ) : (
        <div className="scroll-x">
          <table className="positions-table">
            <caption className="muted small">
              {tr('Open positions first, soonest expiry at the top. Prices as of ')}{data.asOf}.
            </caption>
            <thead>
              <tr>
                <th scope="col">{tr('Status')}</th>
                <th scope="col">{tr('Symbol')}</th>
                <th scope="col" className="num">#</th>
                <th scope="col">{tr('Account')}</th>
                <th scope="col">{tr('Type')}</th>
                <th scope="col" className="num">{tr('Short')}</th>
                <th scope="col" className="num">{tr('Long')}</th>
                <th scope="col" className="num">{tr('Delta')}</th>
                <th scope="col">{tr('Expiry')}</th>
                <th scope="col" className="num">{tr('Price')}</th>
                <th scope="col">{tr('Earnings')}</th>
                <th scope="col" className="num">{tr('Premium')}</th>
                <th scope="col"><span className="sr-only">{tr('Actions')}</span></th>
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
        <h2>{tr('Premium against goals')}</h2>
        <button type="button" onClick={() => setEditing((v) => !v)} disabled={busy}>
          {editing ? tr('Done') : tr('Edit goals')}
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
            {tr('Save')}
          </button>
        </form>
      ) : (
        <div className="goal-row">
          <Goal label={tr('Today')} period={totals.today} />
          <Goal label={tr('This week')} period={totals.week} hint={tr('since {0}', [shortDate(totals.week.from)])} />
          <Goal label={tr('This month')} period={totals.month} />
          <div className="goal">
            <span className="goal-label">{tr('Open premium')}</span>
            <strong className="goal-value">{money(totals.openPremium)}</strong>
            <span className="goal-hint">
              {totals.openCount === 1 ? tr('1 position — at risk, not banked') : tr('{0} positions — at risk, not banked', [totals.openCount])}
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
        aria-label={tr('{0} of {1}, {2}', [money(period.net), money(period.goal), pct(period.progress ?? 0, 0)])}
      >
        <span className="meter-fill" style={{ width: `${share * 100}%` }} />
      </span>

      <span className="goal-hint">
        {pct(period.progress ?? 0, 0)}{tr(' of ')}{money(period.goal)}
        {period.assignmentLoss > 0 && tr(' · {0} assigned', [money(period.assignmentLoss)])}
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
        {tr('+ Add a position')}
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
        <span>{tr('Symbol')}</span>
        <input className="w-symbol" value={draft.symbol} onChange={set('symbol')} maxLength={6} autoFocus />
      </label>

      <label className="control">
        <span>{tr('Type')}</span>
        <select value={draft.type} onChange={set('type')}>
          {TYPES.map(([key, { label }]) => (
            <option key={key} value={key}>
              {key} — {tr(label)}
            </option>
          ))}
        </select>
      </label>

      <label className="control">
        <span>{tr('Account')}</span>
        <input value={draft.account} onChange={set('account')} list="accounts" placeholder={tr('Fidelity IRA')} />
        <datalist id="accounts">
          {['Fidelity IRA', 'Fidelity ROTH', 'Taxable'].map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
      </label>

      <label className="control">
        <span>{tr('Contracts')}</span>
        <input type="number" min="1" className="w-qty" value={draft.contracts} onChange={set('contracts')} />
      </label>

      <label className="control">
        {/* A long option has one strike and nothing short about it, so the label follows the type
            rather than asking someone to enter a bought call's strike under "short strike". */}
        <span>{POSITION_TYPES[draft.type]?.short === false ? tr('Strike') : tr('Short strike')}</span>
        <input type="number" step="0.5" className="w-qty" value={draft.shortStrike} onChange={set('shortStrike')} />
      </label>

      {POSITION_TYPES[draft.type]?.legs !== 1 && (
        <label className="control">
          <span>{tr('Long strike')}</span>
          <input type="number" step="0.5" className="w-qty" value={draft.longStrike} onChange={set('longStrike')} />
        </label>
      )}

      <label className="control">
        <span>{tr('Expiry')}</span>
        <input type="date" value={draft.expiration} onChange={set('expiration')} />
      </label>

      <label className="control">
        <span>{tr('Opened')}</span>
        <input type="date" value={draft.tradeDate} onChange={set('tradeDate')} />
      </label>

      <label className="control">
        <span>{tr('Premium $')}</span>
        <input
          type="number"
          step="1"
          className="w-qty"
          value={draft.premium}
          onChange={set('premium')}
          title={tr('Total credit for the whole position, as the broker\'s fill shows it')}
        />
      </label>

      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy || !ready}>
          {tr('Add')}
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          {tr('Cancel')}
        </button>
      </div>
    </form>
  );
}

function Row({ position, earnings, busy, onPatch, onDelete }) {
  const [settling, setSettling] = useState(null); // 'closed' | 'assigned' | 'rolled'
  const [editing, setEditing] = useState(false);
  const breach = position.breach ?? breachOf(position, position.spot);
  const expiringSoon = position.status === 'open' && position.daysLeft <= 2;

  return (
    <>
      <tr className={`pos-${position.status}${breach?.level === 'breached' ? ' pos-breached' : ''}`}>
        <td>
          {/* Label and colour together, never colour alone — a status you can only see is a
              status a colour-blind reader cannot. */}
          <span className={`badge tone-${STATUSES[position.status].tone}`}>{tr(STATUSES[position.status].label)}</span>
          {breach?.level === 'breached' && <span className="badge tone-warn">{tr('In the money')}</span>}
          {breach?.level === 'near' && <span className="badge tone-watch">{tr('Near strike')}</span>}
        </td>

        <td>
          <a className="ticker-link" href={hrefFor('ticker', { symbol: position.symbol })}>
            {position.symbol}
          </a>
        </td>
        <td className="num">{position.contracts}</td>
        <td className="small muted">{position.account || '—'}</td>
        <td title={tr(POSITION_TYPES[position.type]?.label)}>{position.type}</td>
        <td className="num">{price(position.shortStrike)}</td>
        <td className="num">{price(position.longStrike)}</td>
        <td className="num">{position.delta == null ? '—' : Math.abs(position.delta).toFixed(3)}</td>
        <td className={expiringSoon ? 'nowrap warn-text' : 'nowrap'}>
          {shortDate(position.expiration)}
          {position.status === 'open' && <span className="muted small"> {position.daysLeft}d</span>}
          {/* A short call can be taken off you the day before an ex-dividend date, a month before
              this expiry, if the dividend beats the time value left. Worth seeing on the row
              rather than discovering from a broker email. */}
          {position.exDividend && (
            <span
              className={position.exDividend.likely ? 'ex-div likely' : 'ex-div'}
              title={tr(position.exDividend.text)}
            >
              {tr('Ex-div ')}{shortDate(position.exDividend.exDate)}
              {position.exDividend.likely ? tr(' · assignment likely') : ''}
            </span>
          )}
        </td>
        <td className="num">{price(position.spot)}</td>
        <td className="small muted nowrap">{earnings ? shortDate(earnings) : '—'}</td>
        <td className="num">
          {position.premium == null ? '—' : signed(position.premium)}
          {position.closeCost > 0 && (
            <span className="muted small" title={tr('Paid to buy it back')}>
              {' '}
              −{money(position.closeCost)}{tr(' to close')}
            </span>
          )}
        </td>

        <td className="row-actions">
          {/* Every row can be edited, open or settled: a mistyped strike or a fill entered a
              dollar out is fixed in place rather than by deleting and re-adding the trade. */}
          <button
            type="button"
            disabled={busy}
            aria-expanded={editing}
            aria-label={tr('Edit {0} {1} {2}', [position.symbol, position.type, shortDate(position.expiration)])}
            onClick={() => {
              setEditing((v) => !v);
              setSettling(null);
            }}
          >
            {/* Not "Close" while open: beside Settle, that reads as closing the trade. */}
            {tr('Edit')}
          </button>
          {position.status === 'open' ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setSettling(settling ? null : 'closed');
                  setEditing(false);
                }}
              >
                {tr('Settle')}
              </button>
              <SimulateLink position={position} />
            </>
          ) : (
            <button type="button" disabled={busy} onClick={onDelete} aria-label={tr('Delete {0}', [position.symbol])}>
              {tr('Delete')}
            </button>
          )}
        </td>
      </tr>

      {editing && (
        <tr className="settle-row edit-row">
          <td colSpan={13}>
            <EditForm
              position={position}
              busy={busy}
              onCancel={() => setEditing(false)}
              onSave={(changes) => {
                onPatch(changes);
                setEditing(false);
              }}
            />
          </td>
        </tr>
      )}

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
 * Every field of a recorded trade, editable in place.
 *
 * The same fields as adding one, plus how it ended once it has: the date it was settled, what it
 * cost to close, where it was rolled, what an assignment lost. Setting it back to Open clears
 * those, so a trade settled by mistake does not keep counting towards the goals and the results
 * report as if it had closed.
 */
function EditForm({ position, busy, onCancel, onSave }) {
  const field = (v) => (v == null ? '' : String(v));
  const [draft, setDraft] = useState(() => ({
    symbol: position.symbol,
    type: position.type,
    account: position.account ?? '',
    contracts: field(position.contracts),
    shortStrike: field(position.shortStrike),
    longStrike: field(position.longStrike),
    expiration: position.expiration,
    tradeDate: position.tradeDate ?? '',
    premium: field(position.premium),
    note: position.note ?? '',
    status: position.status,
    closedAt: position.closedAt ?? '',
    closeCost: field(position.closeCost),
    assignmentLoss: field(position.assignmentLoss),
    rolledToExpiration: position.rolledToExpiration ?? '',
    rolledToShortStrike: field(position.rolledToShortStrike),
  }));
  const set = (key) => (event) => setDraft((d) => ({ ...d, [key]: event.target.value }));

  const spec = POSITION_TYPES[draft.type];
  const settled = draft.status !== 'open';
  const numOrNull = (v) => (String(v).trim() === '' ? null : Number(v));

  // What would stop the server accepting it, said before the click rather than after.
  const problem = !/^[A-Za-z.]{1,6}$/.test(draft.symbol.trim())
    ? tr('A symbol is one to six letters.')
    : !draft.expiration
      ? tr('An expiry date is needed.')
      : settled && !draft.closedAt
        ? tr('A settled trade needs the date it was settled.')
        : draft.closedAt && draft.tradeDate && draft.closedAt < draft.tradeDate
          ? tr('It cannot be settled before it was opened.')
          : null;

  const submit = (event) => {
    event.preventDefault();
    if (problem) return;
    onSave({
      symbol: draft.symbol.trim().toUpperCase(),
      type: draft.type,
      account: draft.account,
      contracts: numOrNull(draft.contracts) ?? 1,
      shortStrike: numOrNull(draft.shortStrike),
      longStrike: spec?.legs === 1 ? null : numOrNull(draft.longStrike),
      expiration: draft.expiration,
      tradeDate: draft.tradeDate || null,
      premium: numOrNull(draft.premium),
      note: draft.note,
      status: draft.status,
      // Reopened: none of the ending is true any more.
      closedAt: settled ? draft.closedAt : null,
      closeCost: settled && draft.status !== 'assigned' ? numOrNull(draft.closeCost) : null,
      assignmentLoss: draft.status === 'assigned' ? numOrNull(draft.assignmentLoss) : null,
      rolledToExpiration: draft.status === 'rolled' ? draft.rolledToExpiration || null : null,
      rolledToShortStrike: draft.status === 'rolled' ? numOrNull(draft.rolledToShortStrike) : null,
    });
  };

  return (
    <form className="settle-form edit-form" onSubmit={submit} aria-label={tr('Edit {0}', [position.symbol])}>
      <div className="edit-grid">
        <label className="control">
          <span>{tr('Symbol')}</span>
          <input className="w-symbol" value={draft.symbol} onChange={set('symbol')} maxLength={6} autoFocus />
        </label>
        <label className="control">
          <span>{tr('Type')}</span>
          <select value={draft.type} onChange={set('type')}>
            {TYPES.map(([key, { label }]) => (
              <option key={key} value={key}>
                {key} — {tr(label)}
              </option>
            ))}
          </select>
        </label>
        <label className="control">
          <span>{tr('Account')}</span>
          <input value={draft.account} onChange={set('account')} list="accounts" />
        </label>
        <label className="control">
          <span>{tr('Contracts')}</span>
          <input type="number" min="1" className="w-qty" value={draft.contracts} onChange={set('contracts')} />
        </label>
        <label className="control">
          <span>{spec?.short === false ? tr('Strike') : tr('Short strike')}</span>
          <input type="number" step="0.5" className="w-qty" value={draft.shortStrike} onChange={set('shortStrike')} />
        </label>
        {spec?.legs !== 1 && (
          <label className="control">
            <span>{tr('Long strike')}</span>
            <input type="number" step="0.5" className="w-qty" value={draft.longStrike} onChange={set('longStrike')} />
          </label>
        )}
        <label className="control">
          <span>{tr('Expiry')}</span>
          <input type="date" value={draft.expiration} onChange={set('expiration')} />
        </label>
        <label className="control">
          <span>{tr('Opened')}</span>
          <input type="date" value={draft.tradeDate} onChange={set('tradeDate')} />
        </label>
        <label className="control">
          <span>{settled && draft.status !== 'assigned' ? tr('Opening credit $') : tr('Premium $')}</span>
          <input
            type="number"
            step="0.01"
            className="w-qty"
            value={draft.premium}
            onChange={set('premium')}
            title={tr('Total for the whole position, as the broker\'s fill shows it — a debit is negative')}
          />
        </label>
        <label className="control grow">
          <span>{tr('Note')}</span>
          <input value={draft.note} onChange={set('note')} maxLength={200} />
        </label>
      </div>

      <div className="edit-grid edit-settlement">
        <label className="control">
          <span>{tr('Status')}</span>
          <select value={draft.status} onChange={set('status')}>
            {Object.entries(STATUSES).map(([key, { label }]) => (
              <option key={key} value={key}>
                {tr(label)}
              </option>
            ))}
          </select>
        </label>

        {settled && (
          <label className="control">
            <span>{tr('Settled on')}</span>
            <input type="date" value={draft.closedAt} onChange={set('closedAt')} />
          </label>
        )}
        {(draft.status === 'closed' || draft.status === 'rolled') && (
          <label className="control">
            <span>{tr('Cost to close $')}</span>
            <input type="number" step="0.01" min="0" className="w-qty" value={draft.closeCost} onChange={set('closeCost')} placeholder="0" />
          </label>
        )}
        {draft.status === 'assigned' && (
          <label className="control">
            <span>{tr('Assignment loss $')}</span>
            <input type="number" step="1" min="0" className="w-qty" value={draft.assignmentLoss} onChange={set('assignmentLoss')} />
          </label>
        )}
        {draft.status === 'rolled' && (
          <>
            <label className="control">
              <span>{tr('Rolled to expiry')}</span>
              <input type="date" value={draft.rolledToExpiration} onChange={set('rolledToExpiration')} />
            </label>
            <label className="control">
              <span>{tr('Rolled to strike')}</span>
              <input type="number" step="0.5" className="w-qty" value={draft.rolledToShortStrike} onChange={set('rolledToShortStrike')} />
            </label>
          </>
        )}
        {position.status !== 'open' && draft.status === 'open' && (
          <p className="muted small edit-reopen">
            {tr('Reopening clears the settlement date and costs, so it stops counting towards the goals and the results report.')}
          </p>
        )}
      </div>

      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy || Boolean(problem)}>
          {tr('Save changes')}
        </button>
        <button type="button" onClick={onCancel}>
          {tr('Cancel')}
        </button>
        {problem && <span className="warning small">{problem}</span>}
      </div>
    </form>
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
  const [closeCost, setCloseCost] = useState('');
  const [assignmentLoss, setLoss] = useState('');

  // Closing and rolling both buy the old leg back; that cost is kept beside the credit rather than
  // netted into it, so the period report can say what was paid to close. Assignment has no buyback.
  const buysBack = status === 'closed' || status === 'rolled';
  const kept = Number(premium || 0) - (buysBack ? Number(closeCost || 0) : 0);
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
          closeCost: buysBack && closeCost !== '' ? Math.abs(Number(closeCost)) : null,
          assignmentLoss: status === 'assigned' && assignmentLoss !== '' ? Number(assignmentLoss) : null,
          rolledToExpiration: status === 'rolled' ? rolledToExpiration : null,
          rolledToShortStrike: status === 'rolled' && rolledToShortStrike !== '' ? Number(rolledToShortStrike) : null,
        });
      }}
    >
      <div className="segmented" role="radiogroup" aria-label={tr('How it ended')}>
        {['closed', 'rolled', 'assigned'].map((key) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={status === key}
            className={status === key ? 'on' : ''}
            onClick={() => setStatus(key)}
          >
            {tr(STATUSES[key].label)}
          </button>
        ))}
      </div>

      <label className="control">
        <span>{tr('Date')}</span>
        <input type="date" value={closedAt} onChange={(e) => setClosedAt(e.target.value)} required />
      </label>

      <label className="control">
        <span>{buysBack ? tr('Opening credit $') : tr('Premium kept $')}</span>
        <input type="number" step="1" className="w-qty" value={premium} onChange={(e) => setPremium(e.target.value)} />
      </label>

      {buysBack && (
        <label className="control">
          <span>{tr('Cost to close $')}</span>
          <input
            type="number"
            step="0.01"
            min="0"
            className="w-qty"
            value={closeCost}
            placeholder="0"
            onChange={(e) => setCloseCost(e.target.value)}
            title={tr('What you paid to buy it back. Leave blank if it expired worthless.')}
          />
        </label>
      )}

      {buysBack && closeCost !== '' && (
        <span className="muted small settle-kept">{tr('Kept ')}{signed(kept)}</span>
      )}

      {status === 'assigned' && (
        <label className="control">
          <span>{tr('Assignment loss $')}</span>
          <input type="number" step="1" className="w-qty" value={assignmentLoss} onChange={(e) => setLoss(e.target.value)} />
        </label>
      )}

      {status === 'rolled' && (
        <>
          <label className="control">
            <span>{tr('Rolled to')}</span>
            <input type="date" value={rolledToExpiration} onChange={(e) => setRollExp(e.target.value)} />
          </label>
          <label className="control">
            <span>{tr('New short')}</span>
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
          {tr('Record')}
        </button>
        <button type="button" onClick={onCancel}>
          {tr('Cancel')}
        </button>
      </div>

      {status === 'rolled' && (
        <p className="muted small">
          {tr('Recording a roll settles this row. Add the new leg separately, with this date as its Opened date — the results report pairs the two into one roll, net of the cost to close.')}
        </p>
      )}
    </form>
  );
}

/**
 * Opens this trade in the simulator — the same strikes, expiry, size and fill — so what you see
 * there is the position you hold, not a default spread that happens to share its symbol. A type
 * the simulator cannot draw still links to the symbol, but says so rather than implying it is
 * your trade.
 */
function SimulateLink({ position }) {
  const params = simulatorParamsFromPosition(position);
  if (!params) return null;

  const { exact, ...query } = params;
  const label = tr(POSITION_TYPES[position.type]?.label) ?? position.type;

  return (
    <a
      className="link-button"
      href={hrefFor('simulator', query)}
      title={exact ? undefined : tr('The simulator cannot draw a {0} yet — this opens {1} only', [label.toLowerCase(), position.symbol])}
      aria-label={exact ? tr('Simulate this {0} position', [position.symbol]) : tr('Simulate {0} (symbol only)', [position.symbol])}
    >
      {exact ? tr('Simulate') : tr('Simulate symbol')}
    </a>
  );
}
