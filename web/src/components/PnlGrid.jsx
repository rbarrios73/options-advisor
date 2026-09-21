import { money, price, shortDate } from '../format.js';

/**
 * Profit and loss by price and date — the chart's table view. It carries the same numbers as the
 * curves, so nothing on the chart is reachable only by hovering.
 *
 * Cell shading is diverging: blue for profit, red for loss, with intensity scaled to the largest
 * absolute value in the grid and a neutral cell at zero. The number is always printed in text
 * ink, so the colour is a reading aid, never the only carrier of the value.
 */
export default function PnlGrid({ grid }) {
  const maxAbs = Math.max(1, ...grid.values.flat().map(Math.abs));
  const tags = rowTags(grid.prices, grid.keyLevels);

  return (
    <div className="grid-wrap">
      <table className="pnl-grid">
        <caption className="muted small">
          P&amp;L of the whole position if closed at that price on that date, at the IV shown on the
          sliders. The last column is expiry, where it is exact; the others are modelled.
        </caption>
        <thead>
          <tr>
            <th scope="col">Price</th>
            {grid.columns.map((c) => (
              <th key={c.date} scope="col" className="num">
                {c.daysForward === 0 ? 'Today' : shortDate(c.date)}
                <span className="sub">{c.daysLeft === 0 ? 'expiry' : `${c.daysLeft}d left`}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.prices.map((p, r) => (
            <tr key={p} className={tags[r].length ? `key-row${tags[r].includes('spot') ? ' spot-row' : ''}` : undefined}>
              <th scope="row">
                {price(p)}
                <span className="row-tags">{tags[r].length ? ` ${tags[r].join(' · ')}` : ''}</span>
              </th>
              {grid.values[r].map((v, c) => (
                <td key={grid.columns[c].date} className="num" style={{ background: shade(v, maxAbs) }}>
                  {money(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Diverging poles from the validated pair; alpha capped so primary text stays legible on top.
function shade(v, maxAbs) {
  const t = Math.min(Math.abs(v) / maxAbs, 1);
  if (t < 0.02) return 'transparent';
  const alpha = (0.1 + 0.4 * t).toFixed(3);
  return v > 0 ? `rgba(57, 135, 229, ${alpha})` : `rgba(230, 103, 103, ${alpha})`;
}

/**
 * Labels the rows that are key levels. The grid inserts those levels as rows of their own, so
 * this is an exact match, not a nearest-row guess — see pnlGrid in domain/simulate.js.
 */
const LABELS = { spot: 'now', short: 'short', breakEven: 'break-even', long: 'long' };

function rowTags(prices, keyLevels = {}) {
  return prices.map((p) =>
    Object.entries(keyLevels)
      .filter(([, level]) => Math.abs(level - p) < 1e-6)
      .map(([name]) => LABELS[name] ?? name),
  );
}
