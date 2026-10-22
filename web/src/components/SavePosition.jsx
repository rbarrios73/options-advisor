import { useState } from 'react';

import { ACCOUNTS_HINT, POSITION_TYPES } from '@domain/positions.js';
import { trackerRowFrom } from '@domain/simulate.js';

import { api } from '../api.js';
import { hrefFor } from '../router.js';
import { price, signed } from '../format.js';

/**
 * Saves the position on screen to the tracker.
 *
 * A form rather than one press, because of what the tracker is for. Everything the market can
 * tell us is fetched; everything only you know is typed — the fill, the account, the date. The
 * simulator's price is derived from a quote and is not what your broker gave you, so it arrives
 * here as a default to correct rather than as a figure to record.
 *
 * What it writes is what the Positions page would have written: the same route, the same
 * validation. Nothing here is a second way to create a position.
 */
export default function SavePosition({ position, symbol, pricedAt }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const [account, setAccount] = useState('');
  const [fill, setFill] = useState('');
  const [tradeDate, setTradeDate] = useState(position.asOf);
  const [note, setNote] = useState('');

  const type = POSITION_TYPES[trackerRowFrom(position, { symbol })?.type];
  const credit = position.entry.net > 0;

  // The row exactly as it will be stored, recomputed as you type — so the premium shown on the
  // button is the premium that lands in the tracker, not an approximation of it.
  const row = trackerRowFrom(position, {
    symbol,
    account,
    fill: fill === '' ? null : Number(fill),
    tradeDate,
    note,
  });

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const stored = await api.addPosition(row);
      setSaved(stored);
      setOpen(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (saved) {
    return (
      <p className="saved-note small">
        Saved to your tracker as <strong>{saved.type}</strong> {saved.symbol}{' '}
        {price(saved.shortStrike)}
        {saved.longStrike ? `/${price(saved.longStrike)}` : ''} at {signed(saved.premium)}.{' '}
        <a href={hrefFor('positions')}>Open Positions</a> ·{' '}
        <button type="button" className="link-button" onClick={() => setSaved(null)}>
          Save another
        </button>
      </p>
    );
  }

  if (!open) {
    return (
      <div className="save-position">
        <button type="button" onClick={() => setOpen(true)}>
          Save to Positions
        </button>
        <span className="muted small">
          records this as a trade you have opened — {type?.label.toLowerCase()}
        </span>
      </div>
    );
  }

  return (
    <form className="panel save-form" onSubmit={save}>
      <h3>Save to Positions</h3>

      <p className="muted small">
        {symbol} {type?.label.toLowerCase()}, {position.quantity}{' '}
        {position.quantity === 1 ? 'contract' : 'contracts'}, expiring {position.expiration}. The
        strikes and the expiry come from the simulation; the rest is yours to set.
      </p>

      <div className="save-fields">
        <label className="field">
          <span>Your fill, per share</span>
          <input
            type="number"
            step="0.01"
            min="0"
            value={fill}
            onChange={(e) => setFill(e.target.value)}
            placeholder={Math.abs(position.entry.net).toFixed(2)}
          />
          <span className="muted small">
            {credit ? 'Credit received' : 'Debit paid'}, as on the ticket. Blank uses the{' '}
            {pricedAt} price, {Math.abs(position.entry.net).toFixed(2)}.
          </span>
        </label>

        <label className="field">
          <span>Account</span>
          <input
            type="text"
            list="save-accounts"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            placeholder="Optional"
          />
          <datalist id="save-accounts">
            {ACCOUNTS_HINT.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </label>

        <label className="field">
          <span>Trade date</span>
          <input type="date" value={tradeDate} onChange={(e) => setTradeDate(e.target.value)} />
        </label>

        <label className="field wide">
          <span>Note</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why you opened it"
          />
        </label>
      </div>

      {error && <p className="error small">{error}</p>}

      <div className="row-actions">
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : `Save at ${signed(row.premium)}`}
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
        <span className="muted small">
          {/* The sign is the thing most likely to look wrong, so it is explained before it is
              stored rather than queried afterwards. */}
          {credit
            ? 'A credit is stored positive — it counts towards your goals when you close it.'
            : 'A debit is stored negative: what you paid comes off the total, which is what happened.'}
        </span>
      </div>
    </form>
  );
}
