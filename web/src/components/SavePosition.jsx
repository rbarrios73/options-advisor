import { useState } from 'react';

import { ACCOUNTS_HINT, POSITION_TYPES } from '@domain/positions.js';
import { trackerRowFrom } from '@domain/simulate.js';

import { api } from '../api.js';
import { hrefFor } from '../router.js';
import { price, signed } from '../format.js';

import { tr } from '../i18n.js';
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
        {tr('Saved to your tracker as ')}<strong>{saved.type}</strong> {saved.symbol}{' '}
        {price(saved.shortStrike)}
        {saved.longStrike ? `/${price(saved.longStrike)}` : ''}{tr(' at ')}{signed(saved.premium)}.{' '}
        <a href={hrefFor('positions')}>{tr('Open Positions')}</a> ·{' '}
        <button type="button" className="link-button" onClick={() => setSaved(null)}>
          {tr('Save another')}
        </button>
      </p>
    );
  }

  if (!open) {
    return (
      // No hint beside it: this sits on the chart panel's title line, which already names the
      // position, and the form says the rest the moment it opens.
      <div className="save-position">
        <button type="button" onClick={() => setOpen(true)} title={tr('Record this {0} as a trade you have opened', [tr(type?.label)?.toLowerCase()])}>
          {tr('Save to Positions')}
        </button>
      </div>
    );
  }

  return (
    <form className="panel save-form" onSubmit={save}>
      <h3>{tr('Save to Positions')}</h3>

      <p className="muted small">
        {symbol} {tr(type?.label)?.toLowerCase()}, {position.quantity}{' '}
        {position.quantity === 1 ? tr('contract') : tr('contracts')}{tr(', expiring ')}{position.expiration}{tr('. The strikes and the expiry come from the simulation; the rest is yours to set.')}
      </p>

      <div className="save-fields">
        <label className="field">
          <span>{tr('Your fill, per share')}</span>
          <input
            type="number"
            step="0.01"
            min="0"
            value={fill}
            onChange={(e) => setFill(e.target.value)}
            placeholder={Math.abs(position.entry.net).toFixed(2)}
          />
          <span className="muted small">
            {credit ? tr('Credit received') : tr('Debit paid')}{tr(', as on the ticket. Blank uses the')}{' '}
            {pricedAt}{tr(' price, ')}{Math.abs(position.entry.net).toFixed(2)}.
          </span>
        </label>

        <label className="field">
          <span>{tr('Account')}</span>
          <input
            type="text"
            list="save-accounts"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            placeholder={tr('Optional')}
          />
          <datalist id="save-accounts">
            {ACCOUNTS_HINT.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </label>

        <label className="field">
          <span>{tr('Trade date')}</span>
          <input type="date" value={tradeDate} onChange={(e) => setTradeDate(e.target.value)} />
        </label>

        <label className="field wide">
          <span>{tr('Note')}</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={tr('Why you opened it')}
          />
        </label>
      </div>

      {error && <p className="error small">{error}</p>}

      <div className="row-actions">
        <button className="primary" type="submit" disabled={busy}>
          {busy ? tr('Saving…') : tr('Save at {0}', [signed(row.premium)])}
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={busy}>
          {tr('Cancel')}
        </button>
        <span className="muted small">
          {/* The sign is the thing most likely to look wrong, so it is explained before it is
              stored rather than queried afterwards. */}
          {credit
            ? tr('A credit is stored positive — it counts towards your goals when you close it.')
            : tr('A debit is stored negative: what you paid comes off the total, which is what happened.')}
        </span>
      </div>
    </form>
  );
}
