import { useCallback, useEffect, useState } from 'react';

import { FREQUENCIES, RISK_LABELS } from '@domain/dividends.js';

import { api } from '../api.js';
import { cash, money, pct, price, shortDate } from '../format.js';
import IncomeChart from '../components/IncomeChart.jsx';

/**
 * What the names you follow pay, and what the shares you hold will pay you.
 *
 * The ranking is by yield, because that is the question — but every row carries its risk label
 * beside it, and the label is text, not a colour. Sorting purely on yield puts the dividends the
 * market has already stopped believing at the top of the page; showing why, in the same glance, is
 * the difference between a screen and a trap.
 *
 * Nothing here is a recommendation. Rates are what has been declared, projections assume the rate
 * does not change, and the page says so in the one place somebody might forget it.
 */
export default function DividendsPage() {
  const [data, setData] = useState(null);
  const [months, setMonths] = useState(12);
  const [sort, setSort] = useState('yield');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setData(await api.dividends({ months, sort }));
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, [months, sort]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (symbol, holding) => {
    try {
      await api.saveHolding(symbol, holding);
      setEditing(null);
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  const remove = async (symbol) => {
    try {
      await api.deleteHolding(symbol);
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  if (!data) {
    return <p className="muted">{error ? <span className="error">{error}</span> : 'Loading…'}</p>;
  }

  const { rows, totals, asOf } = data;
  const held = rows.filter((r) => r.shares > 0 && r.annualRate !== null);
  const allPayments = held.flatMap((r) => r.projected.payments.map((p) => ({ ...p, symbol: r.symbol })));

  return (
    <section className="dividends">
      <p className="muted small page-intro">
        What each name pays, ranked, and what your shares will pay you. Rates are the latest
        declared payment annualised — a projection assumes it does not change, which is an
        assumption and not a forecast. The risk column is where the reasons it might change live.
      </p>

      {error && <p className="error">{error}</p>}

      <div className="tiles">
        <div className="tile">
          <span className="tile-label">Income a year, at today’s rates</span>
          <span className="tile-value">{money(totals.annualIncome)}</span>
          <span className="tile-hint">{money(totals.monthlyAverage)} a month averaged</span>
        </div>
        <div className="tile">
          <span className="tile-label">Yield on what they’re worth</span>
          <span className="tile-value">{pct(totals.portfolioYield, 2)}</span>
          <span className="tile-hint">
            {totals.marketValue ? `on ${money(totals.marketValue)} of stock` : 'add share counts to see this'}
          </span>
        </div>
        <div className="tile">
          <span className="tile-label">Yield on what you paid</span>
          <span className="tile-value">{pct(totals.yieldOnCost, 2)}</span>
          <span className="tile-hint">the one that rises when a dividend is raised</span>
        </div>
      </div>

      <div className="panel">
        <div className="dividend-controls">
          <div className="control">
            <span className="muted small">Project ahead</span>
            <div className="segmented">
              {data.horizons.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={m === months ? 'on' : ''}
                  onClick={() => setMonths(m)}
                >
                  {m === 12 ? '1 year' : `${m / 12} years`}
                </button>
              ))}
            </div>
          </div>

          <div className="control">
            <span className="muted small">Rank by</span>
            <div className="segmented">
              {[
                ['yield', 'Yield'],
                ['income', 'Income'],
                ['soonest', 'Next payment'],
                ['symbol', 'Symbol'],
              ].map(([key, label]) => (
                <button key={key} type="button" className={key === sort ? 'on' : ''} onClick={() => setSort(key)}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <button type="button" onClick={load} disabled={busy}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <h3 className="chart-heading">
          Projected income, {months === 12 ? 'next 12 months' : `next ${months / 12} years`}
          <span className="muted small"> — {money(totals.projected)} in total</span>
        </h3>

        {held.length === 0 ? (
          <p className="muted small">
            Add a share count to a row below and the months you get paid in will appear here.
          </p>
        ) : (
          <IncomeChart payments={allPayments} months={months} asOf={asOf} />
        )}
      </div>

      <div className="table-wrap">
        <table className="dividend-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th className="num">Price</th>
              <th className="num">Rate a year</th>
              <th className="num">Yield</th>
              <th>Pays</th>
              <th>Next ex-date</th>
              <th className="num">Your shares</th>
              <th className="num">Your income</th>
              <th>Dividend risk</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Row
                key={row.symbol}
                row={row}
                editing={editing === row.symbol}
                onEdit={() => setEditing(editing === row.symbol ? null : row.symbol)}
                onSave={save}
                onRemove={remove}
              />
            ))}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && (
        <p className="muted small">
          Nothing to show yet — this page reads the active watchlist, so add a symbol there and it
          will appear here.
        </p>
      )}

      <p className="muted small footnote">
        As of {asOf}. A payment is projected from the last one plus the usual gap, so dates beyond
        the next one are approximate; the amounts assume the rate holds. Prices and payment
        histories come from your data provider — where it has no dividend data, you can type the
        rate yourself and the row says which of the two it is.
      </p>
    </section>
  );
}

function Row({ row, editing, onEdit, onSave, onRemove }) {
  const frequency = FREQUENCIES[row.frequency]?.label ?? '—';

  return (
    <>
      <tr className={row.annualRate === null ? 'quiet' : undefined}>
        <td>
          <strong>{row.symbol}</strong>
          {row.source !== 'provider' && row.annualRate !== null && (
            <span className="tag" title="You entered this rate — your provider had none.">
              typed
            </span>
          )}
        </td>
        <td className="num">{price(row.price)}</td>
        <td className="num">{row.annualRate === null ? '—' : cash(row.annualRate)}</td>
        <td className="num">{pct(row.yield, 2)}</td>
        <td>{row.annualRate === null ? '—' : frequency}</td>
        <td className="nowrap">
          {row.nextExDate ? shortDate(row.nextExDate) : '—'}
          {row.perPayment !== null && <span className="muted small"> · {cash(row.perPayment)}</span>}
        </td>
        <td className="num">{row.shares ? row.shares.toLocaleString('en-US') : '—'}</td>
        <td className="num">{money(row.annualIncome)}</td>
        <td>
          <RiskCell risk={row.risk} availability={row.availability} />
        </td>
        <td className="order-cell">
          <div className="row-actions">
            <button type="button" onClick={onEdit}>
              {editing ? 'Close' : row.tracked ? 'Edit' : 'Add shares'}
            </button>
            {row.tracked && (
              <button type="button" onClick={() => onRemove(row.symbol)}>
                Remove
              </button>
            )}
          </div>
        </td>
      </tr>

      {editing && (
        <tr className="detail-row">
          <td colSpan={10}>
            <HoldingForm row={row} onSave={onSave} />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The risk reading: a word and the reasons behind it.
 *
 * The level drives a left border as well as the word, never the word's colour alone — a reader who
 * cannot separate the hues still reads "Stretched", and a reader who can gets there faster.
 */
function RiskCell({ risk, availability }) {
  if (availability === 'never') return <span className="muted small">Pays no dividend</span>;

  return (
    // Every reason goes in the title as well as the first one on screen: the reasons line is
    // hidden at phone width, where it turned every row into three, and the label alone would
    // otherwise leave no way to find out why.
    <div className={`risk risk-${risk.level}`} title={risk.reasons.join(' ')}>
      <span className="risk-label">{risk.label ?? RISK_LABELS[risk.level]}</span>
      {risk.reasons.length > 0 && <span className="muted small risk-why">{risk.reasons[0]}</span>}
    </div>
  );
}

function HoldingForm({ row, onSave }) {
  const [shares, setShares] = useState(row.shares ?? '');
  const [costBasis, setCostBasis] = useState(row.costBasis ?? '');
  const [annualRate, setAnnualRate] = useState(row.annualRate ?? '');
  const [frequency, setFrequency] = useState(row.frequency ?? 'quarterly');
  const [nextExDate, setNextExDate] = useState(row.nextExDate ?? '');
  const [note, setNote] = useState(row.note ?? '');

  // The rate is only yours to set when the provider has none. Offering the box anyway would invite
  // someone to type a figure that is silently ignored on the next refresh.
  const ownRate = row.source !== 'provider';

  const submit = (event) => {
    event.preventDefault();
    onSave(row.symbol, {
      shares,
      costBasis,
      note,
      ...(ownRate ? { annualRate, frequency, nextExDate } : {}),
    });
  };

  return (
    <form className="holding-form" onSubmit={submit}>
      <label className="field">
        <span>Shares</span>
        <input type="number" min="0" step="any" value={shares} onChange={(e) => setShares(e.target.value)} />
      </label>

      <label className="field">
        <span>Average cost a share</span>
        <input type="number" min="0" step="any" value={costBasis} onChange={(e) => setCostBasis(e.target.value)} />
        <span className="muted small">For yield on cost. Leave blank if you would rather not.</span>
      </label>

      {ownRate ? (
        <>
          <label className="field">
            <span>Dividend a year, per share</span>
            <input type="number" min="0" step="any" value={annualRate} onChange={(e) => setAnnualRate(e.target.value)} />
            <span className="muted small">
              The whole year, not one payment — $0.25 a quarter is 1.00 here.
            </span>
          </label>

          <label className="field">
            <span>Pays</span>
            <select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
              {Object.entries(FREQUENCIES).map(([key, { label }]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Next ex-dividend date</span>
            <input type="date" value={nextExDate} onChange={(e) => setNextExDate(e.target.value)} />
            <span className="muted small">The schedule is projected from this.</span>
          </label>
        </>
      ) : (
        <p className="muted small provider-note">
          The rate, cadence and dates for {row.symbol} come from your data provider, so there is
          nothing to type — {row.payments} past payments on record
          {row.lastExDate ? `, the last on ${shortDate(row.lastExDate)}` : ''}.
        </p>
      )}

      <label className="field wide">
        <span>Note</span>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why you hold it" />
      </label>

      <div className="row-actions">
        <button className="primary" type="submit">
          Save
        </button>
      </div>
    </form>
  );
}
