import { useId, useState } from 'react';

import { cash } from '../format.js';

/**
 * Projected income, one column per month.
 *
 * A column chart because the question is "how much, in which month" — magnitude over time, a
 * dozen or so of them. One series, so there is no legend: the heading above it names the thing,
 * and a legend box for a single colour is furniture.
 *
 * Months with no payment are drawn as empty slots rather than skipped. A quarterly payer puts
 * money in your account four times a year, and a chart that hid the gaps would make it look
 * monthly — the shape of the gaps IS the information here.
 */
export default function IncomeChart({ payments, months, asOf, perShare = false }) {
  const [hover, setHover] = useState(null);
  const clipId = useId();

  const buckets = monthsFrom(asOf, months);
  const byMonth = new Map(buckets.map((b) => [b.key, 0]));

  for (const p of payments) {
    const key = p.exDate.slice(0, 7);
    if (byMonth.has(key)) byMonth.set(key, byMonth.get(key) + (perShare ? p.perShare : p.amount ?? 0));
  }

  const values = buckets.map((b) => ({ ...b, value: round2(byMonth.get(b.key) ?? 0) }));
  const peak = Math.max(...values.map((v) => v.value), 0);

  // Cents on small figures, whole dollars on large ones: $0.26 a share rounded to the dollar is
  // the entire number thrown away, and $1,284.00 is two digits of noise.
  const dp = peak < 20 ? 2 : 0;

  const peakIsUnique = values.filter((v) => v.value === peak).length === 1;

  if (peak <= 0) {
    return <p className="muted small">Nothing is projected to pay in this window.</p>;
  }

  // Geometry in user units; the SVG scales to its box. Taller than it is per-column wide, so a
  // quiet month reads as a gap rather than as a rounding error.
  const W = 760;
  const H = 180;
  const padLeft = 44;
  const padBottom = 26;
  const padTop = 14;

  const plotW = W - padLeft - 10;
  const plotH = H - padBottom - padTop;

  const slot = plotW / values.length;
  // A 2px surface gap between neighbouring bars, so two full months do not read as one block.
  const barW = Math.max(4, slot - 2);

  const y = (v) => padTop + plotH - (v / peak) * plotH;

  // Three gridlines, recessive: enough to read a height against, not a grid to look at.
  const ticks = [peak, peak / 2].map((v) => ({ v, y: y(v) }));

  return (
    <figure className="income-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Projected income by month, ${values.length} months from ${asOf}. Highest month ${cash(peak, dp)}.`}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          {/* Rounds the top of every bar and leaves the baseline square, by clipping a plain rect
              — a rounded rect would round the bottom too and float the bar off its own axis. */}
          <clipPath id={`${clipId}-top`}>
            <rect x="0" y={padTop - 8} width={W} height={plotH + 8} />
          </clipPath>
        </defs>

        {ticks.map((t) => (
          <g key={t.v}>
            <line x1={padLeft} x2={W - 10} y1={t.y} y2={t.y} stroke="var(--gridline)" strokeWidth="1" />
            <text x={padLeft - 6} y={t.y + 3} textAnchor="end" className="axis-label">
              {cash(t.v, dp)}
            </text>
          </g>
        ))}

        <line x1={padLeft} x2={W - 10} y1={y(0)} y2={y(0)} stroke="var(--axis)" strokeWidth="1" />

        {values.map((v, i) => {
          const x = padLeft + i * slot + (slot - barW) / 2;
          const on = hover?.key === v.key;

          return (
            <g key={v.key}>
              {/* A full-height hit target: a 3px bar is not something anyone can point at. */}
              <rect
                x={padLeft + i * slot}
                y={padTop}
                width={slot}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHover(v)}
              />
              {v.value > 0 && (
                <rect
                  x={x}
                  y={y(v.value)}
                  width={barW}
                  height={Math.max(2, y(0) - y(v.value)) + 8}
                  rx="4"
                  clipPath={`url(#${clipId}-top)`}
                  fill="var(--series-1)"
                  opacity={hover && !on ? 0.55 : 1}
                  pointerEvents="none"
                />
              )}
              {/* Every third month, so the axis stays readable at a phone width. */}
              {i % 3 === 0 && (
                <text x={padLeft + i * slot + slot / 2} y={H - 8} textAnchor="middle" className="axis-label">
                  {v.label}
                </text>
              )}
            </g>
          );
        })}

        {/* The one direct label: the biggest month, and ONLY when there is a single biggest month.
            A monthly payer makes every column equal, and labelling "the tallest" then writes the
            same figure over all thirty-six of them — which is what it did the first time. */}
        {values.map((v, i) =>
          v.value === peak && peakIsUnique ? (
            <text
              key={`peak-${v.key}`}
              x={padLeft + i * slot + slot / 2}
              y={y(v.value) - 5}
              textAnchor="middle"
              className="chart-value"
            >
              {cash(v.value, dp)}
            </text>
          ) : null,
        )}
      </svg>

      <figcaption className="muted small">
        {hover ? (
          <span>
            <strong>{hover.long}</strong> — {hover.value > 0 ? cash(hover.value, dp) : 'nothing due'}
            {perShare ? ' per share' : ''}
          </span>
        ) : (
          <span>Each column is one month’s payments. Hover for the figure.</span>
        )}
      </figcaption>
    </figure>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthsFrom(asOf, count) {
  const start = new Date(`${asOf}T00:00:00Z`);
  const out = [];

  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    const month = d.getUTCMonth();

    out.push({
      key: d.toISOString().slice(0, 7),
      // The year on January, so a 36-month chart does not show "Jan" three times unlabelled.
      label: month === 0 ? `${MONTHS[month]} ’${String(d.getUTCFullYear()).slice(2)}` : MONTHS[month],
      long: `${MONTHS[month]} ${d.getUTCFullYear()}`,
    });
  }
  return out;
}

const round2 = (x) => Math.round(x * 100) / 100;
