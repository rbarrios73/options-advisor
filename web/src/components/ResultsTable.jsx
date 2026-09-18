import { Fragment, useState } from 'react';

import CandidateDetail from './CandidateDetail.jsx';
import { STRATEGY_LABELS, money, price, pct, signed } from '../format.js';

const COLUMNS = [
  { key: 'score', label: 'Score', render: (c) => c.score.toFixed(3), numeric: true },
  { key: 'symbol', label: 'Symbol', render: (c) => c.symbol },
  { key: 'kind', label: 'Strategy', render: (c) => STRATEGY_LABELS[c.kind] ?? c.kind },
  { key: 'expiration', label: 'Expiry', render: (c) => c.expiration },
  { key: 'dte', label: 'DTE', render: (c) => c.dte, numeric: true },
  { key: 'strikes', label: 'Strikes', render: (c) => strikeLabel(c), sortable: false },
  { key: 'credit', label: 'Credit', render: (c) => price(c.credit), numeric: true },
  { key: 'maxLoss', label: 'Max loss', render: (c) => money(c.maxLoss), numeric: true },
  { key: 'returnOnRisk', label: 'Return', render: (c) => pct(c.returnOnRisk), numeric: true },
  { key: 'probProfit', label: 'Win prob', render: (c) => pct(c.probProfit), numeric: true },
  { key: 'breakEven', label: 'Break-even', render: (c) => breakEvenLabel(c), numeric: true },
  { key: 'expectedValue', label: 'EV', render: (c) => signed(c.expectedValue), numeric: true },
  { key: 'liquidity', label: 'Liq', render: (c) => (c.liquidity ?? 0).toFixed(2), numeric: true },
];

export default function ResultsTable({ candidates }) {
  const [sort, setSort] = useState({ key: 'score', dir: 'desc' });
  const [openId, setOpenId] = useState(null);

  const sorted = [...candidates].sort((a, b) => {
    const dir = sort.dir === 'desc' ? -1 : 1;
    const av = a[sort.key];
    const bv = b[sort.key];

    if (av == null && bv == null) return 0;
    if (av == null) return 1; // nulls last, whichever way you sort
    if (bv == null) return -1;

    return av > bv ? dir : av < bv ? -dir : 0;
  });

  const toggleSort = (key) =>
    setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }));

  return (
    <table className="results">
      <thead>
        <tr>
          {COLUMNS.map((col) => (
            <th
              key={col.key}
              className={col.numeric ? 'num' : ''}
              onClick={col.sortable === false ? undefined : () => toggleSort(col.key)}
              role={col.sortable === false ? undefined : 'button'}
            >
              {col.label}
              {sort.key === col.key ? (sort.dir === 'desc' ? ' ▾' : ' ▴') : ''}
            </th>
          ))}
        </tr>
      </thead>

      <tbody>
        {sorted.map((c) => {
          const open = openId === c.id;
          return (
            <Fragment key={c.id}>
              <tr
                className={`row ${open ? 'open' : ''} ${c.earningsBeforeExpiry ? 'earnings' : ''}`}
                onClick={() => setOpenId(open ? null : c.id)}
              >
                {COLUMNS.map((col) => (
                  <td key={col.key} className={col.numeric ? 'num' : ''}>
                    {/* The caret lives in the first real column rather than a column of its own:
                        an empty header cell has no intrinsic width and table layout hands it all
                        the slack, which pushes every header out of line with its data. */}
                    {col.key === 'score' && <span className="toggle">{open ? '▾' : '▸'}</span>}
                    {col.render(c)}
                    {col.key === 'expiration' && c.earningsBeforeExpiry && (
                      <span className="flag" title={`Earnings ${c.earningsBeforeExpiry} falls before this expiry`}>
                        E
                      </span>
                    )}
                  </td>
                ))}
              </tr>

              {open && (
                <tr className="detail-row">
                  <td colSpan={COLUMNS.length}>
                    <CandidateDetail candidate={c} />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function strikeLabel(c) {
  const shorts = c.legs.filter((l) => l.action === 'sell').map((l) => l.strike);
  const longs = c.legs.filter((l) => l.action === 'buy').map((l) => l.strike);

  if (c.kind === 'iron_condor') {
    const all = [...c.legs].sort((a, b) => a.strike - b.strike).map((l) => l.strike);
    return all.join(' / ');
  }
  if (shorts.length === 0) return longs.join(' / ');
  return `${shorts.join('/')} → ${longs.join('/')}`;
}

function breakEvenLabel(c) {
  if (c.profitRange) return `${price(c.profitRange[0])}–${price(c.profitRange[1])}`;
  return price(c.breakEven);
}
