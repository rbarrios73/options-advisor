import { COMPONENT_LABELS, money, price, pct, signed } from '../format.js';
import { hrefFor } from '../router.js';

import { tr } from '../i18n.js';
/**
 * The expanded row: every input the score was computed from, and the legs at the quotes they were
 * priced at. If the ranking looks wrong, this is where you find out why — and the numbers here
 * are the ones to sanity-check against your broker before doing anything.
 */
export default function CandidateDetail({ candidate }) {
  const c = candidate;

  return (
    <div className="detail">
      <div className="detail-grid">
        <section>
          <h4>{tr('Legs at scan time')}</h4>
          <table className="legs">
            <thead>
              <tr>
                <th>{tr('Action')}</th>
                <th>{tr('Type')}</th>
                <th>{tr('Strike')}</th>
                <th>{tr('Bid')}</th>
                <th>{tr('Ask')}</th>
                <th>{tr('Mid')}</th>
                <th>{tr('Delta')}</th>
                <th>{tr('IV')}</th>
                <th>{tr('OI')}</th>
                <th>{tr('Vol')}</th>
              </tr>
            </thead>
            <tbody>
              {c.legs.map((leg, i) => (
                <tr key={`${leg.symbol}-${i}`} className={leg.action === 'sell' ? 'sell' : 'buy'}>
                  <td>{tr(leg.action === 'sell' ? 'sell' : 'buy')}</td>
                  <td>{leg.type}</td>
                  <td>{price(leg.strike)}</td>
                  <td>{price(leg.bid)}</td>
                  <td>{price(leg.ask)}</td>
                  <td>{price(leg.mid)}</td>
                  <td>{leg.delta == null ? '—' : leg.delta.toFixed(3)}</td>
                  <td>{pct(leg.iv)}</td>
                  <td>{leg.openInterest ?? '—'}</td>
                  <td>{leg.volume ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="muted small">
            {tr('Priced conservatively: sell the bid, buy the ask. Filling both legs at mid would have been worth ')}{price(c.slippageToMid)}{tr(' more per contract — that gap is what you give up by taking a marketable order, and it is real money on a 4-leg condor.')}
          </p>

          {simulatorLink(c) && (
            <a className="button" href={simulatorLink(c)}>
              {tr('Open in simulator →')}
            </a>
          )}
        </section>

        <section>
          <h4>{tr('How it scored')}</h4>
          <table className="components">
            <tbody>
              {Object.entries(c.scoreComponents).map(([key, value]) => (
                <tr key={key} className={key === c.strongest ? 'best' : key === c.weakest ? 'worst' : ''}>
                  <td>{tr(COMPONENT_LABELS[key]) ?? key}</td>
                  <td className="num">{(value ?? 0).toFixed(2)}</td>
                  <td className="num muted">× {c.weightsUsed[key]}</td>
                  <td className="bar">
                    <span style={{ width: `${(value ?? 0) * 100}%` }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <dl className="facts">
            <div>
              <dt>{tr('Underlying')}</dt>
              <dd>{price(c.spot)}</dd>
            </div>
            <div>
              <dt>{tr('IV used')}</dt>
              <dd>{pct(c.ivUsed)}{tr(' (at the money, this expiry)')}</dd>
            </div>
            <div>
              <dt>{tr('Break-even')}</dt>
              <dd>
                {c.profitRange
                  ? `${price(c.profitRange[0])} – ${price(c.profitRange[1])}`
                  : price(c.breakEven)}
              </dd>
            </div>
            <div>
              <dt>{tr('Max profit / loss')}</dt>
              <dd>
                {c.maxProfit == null ? tr('uncapped') : money(c.maxProfit)} / {money(c.maxLoss)}
              </dd>
            </div>
            <div>
              <dt>{tr('Expected value')}</dt>
              <dd>{c.expectedValue == null ? '—' : signed(c.expectedValue)}</dd>
            </div>
          </dl>

          <p className="muted small">
            {tr('Expected value here is the crude two-outcome version: full credit or full max loss, weighted by the model\'s probability. On efficiently priced options it lands near zero or slightly negative once the bid/ask is paid — which is the honest answer. It says nothing about the edge premium sellers actually pursue, the gap between implied and realised volatility, because nothing here measures realised volatility.')}
          </p>
        </section>
      </div>
    </div>
  );
}

/**
 * The simulator covers both credit spreads, long calls and long puts. Anything else — an iron
 * condor — has no link rather than a link to something that would silently show a different
 * position.
 */
function simulatorLink(c) {
  const base = { symbol: c.symbol, exp: c.expiration, kind: c.kind };

  if (c.kind === 'put_credit_spread' || c.kind === 'call_credit_spread') {
    return hrefFor('simulator', {
      ...base,
      short: c.legs.find((l) => l.action === 'sell')?.strike,
      long: c.legs.find((l) => l.action === 'buy')?.strike,
    });
  }
  if (c.kind === 'long_call' || c.kind === 'long_put') {
    return hrefFor('simulator', { ...base, strike: c.legs[0]?.strike });
  }
  return null;
}
