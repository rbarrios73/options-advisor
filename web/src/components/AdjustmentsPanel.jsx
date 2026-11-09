import { useEffect, useMemo, useState } from 'react';

import { adjustmentScenarios, rollExpiries } from '@domain/manage.js';

import { api } from '../api.js';
import { money, pct, price, shortDate } from '../format.js';
import { hrefFor } from '../router.js';

/**
 * Close, roll and reshape: what you could do with this position instead of holding it, each
 * priced at today's quotes on the same terms — the net of closing the old legs and opening the
 * new ones, conservatively, and what it leaves you holding.
 *
 * "Close now" and reshaping within this expiry need nothing more than the chain already loaded.
 * Rolling needs later expiries' chains, which cost requests against a shared rate limit — so they
 * are fetched only when asked for, two at most, and from the same cache the scan uses.
 */
export default function AdjustmentsPanel({ position, chain, expiryList, symbol }) {
  const [later, setLater] = useState([]);
  const [state, setState] = useState('idle'); // idle | loading | done | error
  const [error, setError] = useState(null);

  const targets = useMemo(() => rollExpiries(expiryList, position), [expiryList, position]);
  const key = `${symbol}:${position.expiration}`;

  // A different symbol or expiry makes yesterday's rolls someone else's.
  useEffect(() => {
    setLater([]);
    setState('idle');
    setError(null);
  }, [key]);

  const loadRolls = async () => {
    setState('loading');
    setError(null);
    try {
      const chains = [];
      for (const t of targets) chains.push(await api.chain(symbol, t.date)); // one at a time, like the scan
      setLater(chains);
      setState('done');
    } catch (e) {
      setError(e.message);
      setState('error');
    }
  };

  const scenarios = useMemo(() => adjustmentScenarios(position, { chain, later }), [position, chain, later]);
  const held = position.entry.source === 'override';

  return (
    <section className="panel adjustments" aria-labelledby="adjust-title">
      <div className="chart-head">
        <h2 id="adjust-title">Adjustments and rolls</h2>
        <span className="muted small">priced at today’s quotes · bid/ask, not mid</span>
      </div>

      {!held && (
        <p className="muted small">
          Enter the price you were filled at above to see what each of these would bank against it.
        </p>
      )}

      <div className="scroll-x">
        <table className="adjust-table">
          <thead>
            <tr>
              <th scope="col">Scenario</th>
              <th scope="col" className="num">Net / share</th>
              <th scope="col" className="num">Cash</th>
              <th scope="col">Leaves you with</th>
              <th scope="col" className="num">Max profit</th>
              <th scope="col" className="num">Max loss</th>
              <th scope="col" className="num">Break-even</th>
              <th scope="col" className="num">Win prob.</th>
              <th scope="col"><span className="sr-only">Open</span></th>
            </tr>
          </thead>
          <tbody>
            {scenarios.map((sc) => (
              <tr key={sc.id}>
                <th scope="row">
                  <span className="adjust-title">{sc.title}</span>
                  <span className="muted small adjust-action">{sc.action}</span>
                </th>
                <td className="num">{netLabel(sc.net)}</td>
                <td className="num">{cashLabel(sc.cash)}</td>
                {sc.result ? (
                  <>
                    <td className="nowrap">
                      {shortDate(sc.result.expiration)} · {sc.result.dte}d
                    </td>
                    <td className="num">{sc.result.maxProfit == null ? 'No cap' : money(sc.result.maxProfit)}</td>
                    <td className="num">{money(sc.result.maxLoss)}</td>
                    <td className="num">{price(sc.result.breakEven)}</td>
                    <td className="num">{sc.result.probProfit == null ? '—' : pct(sc.result.probProfit, 0)}</td>
                  </>
                ) : (
                  <td colSpan={5} className="muted small">
                    {sc.realized == null
                      ? 'Nothing left open.'
                      : `Nothing left open — banks ${sc.realized >= 0 ? '' : '−'}${money(Math.abs(sc.realized))} against your fill.`}
                  </td>
                )}
                <td>
                  {sc.params && (
                    <a className="link-button nowrap" href={hrefFor('simulator', { symbol, ...sc.params })}>
                      Open
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {state !== 'done' && targets.length > 0 && (
        <p className="adjust-load">
          <button type="button" onClick={loadRolls} disabled={state === 'loading'}>
            {state === 'loading' ? 'Pricing rolls…' : `Price rolls to ${targets.map((t) => shortDate(t.date)).join(' and ')}`}
          </button>{' '}
          <span className="muted small">Fetches {targets.length} more chain{targets.length === 1 ? '' : 's'}.</span>
        </p>
      )}
      {state === 'done' && !scenarios.some((sc) => sc.id.includes(':')) && (
        <p className="muted small">The strikes these rolls need are not listed in the later expiries, so there is nothing to show.</p>
      )}
      {targets.length === 0 && <p className="muted small">No later expiry is listed to roll to.</p>}
      {error && <p className="error small">{error}</p>}

      <p className="muted small adjust-note">
        A roll is two trades: closing this one and opening the next. The net is both together, so a
        small credit can still mean more risk — compare the max loss and break-even before rolling,
        not just the cash.
      </p>
    </section>
  );
}

const netLabel = (v) => (v > 0 ? `+${price(v)} credit` : v < 0 ? `${price(-v)} debit` : 'even');
const cashLabel = (v) => (v > 0 ? `+${money(v)}` : v < 0 ? `−${money(-v)}` : money(0));
