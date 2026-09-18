import { useState } from 'react';

export default function Watchlist({ watchlist, onChange }) {
  const [symbol, setSymbol] = useState('');

  const add = (event) => {
    event.preventDefault();
    const clean = symbol.trim().toUpperCase();
    if (!/^[A-Z.]{1,6}$/.test(clean)) return;
    if (watchlist.some((w) => w.symbol === clean)) return;

    onChange([...watchlist, { symbol: clean, note: '', earnings: null }]);
    setSymbol('');
  };

  const remove = (target) => onChange(watchlist.filter((w) => w.symbol !== target));

  const setEarnings = (target, value) =>
    onChange(
      watchlist.map((w) => (w.symbol === target ? { ...w, earnings: value || null } : w)),
    );

  return (
    <section className="panel">
      <h2>Watchlist</h2>

      <form className="inline-row" onSubmit={add}>
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          placeholder="Add ticker"
          aria-label="Add ticker"
          maxLength={6}
        />
        <button type="submit">Add</button>
      </form>

      <ul className="watchlist">
        {watchlist.map((entry) => (
          <li key={entry.symbol}>
            <span className="ticker">{entry.symbol}</span>

            {/* No free feed gives a dependable earnings date, so this is entered by hand. Any
                expiry after it is flagged on the candidate — an earnings print inside the life
                of a short premium position is the single most common way one goes wrong. */}
            <input
              type="date"
              className="earnings"
              value={entry.earnings ?? ''}
              onChange={(e) => setEarnings(entry.symbol, e.target.value)}
              title="Earnings date (optional) — expiries after this get flagged"
            />

            <button className="link" onClick={() => remove(entry.symbol)} aria-label={`Remove ${entry.symbol}`}>
              ×
            </button>
          </li>
        ))}
      </ul>

      {watchlist.length === 0 && <p className="muted">Add a ticker to scan.</p>}
    </section>
  );
}
