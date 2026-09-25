import { useEffect, useMemo, useRef, useState } from 'react';

import { compact, price as fmtPrice } from '../format.js';

/**
 * A price line over time, with a crosshair that reads out the bar under the pointer.
 *
 * One series, so there is no legend — the heading above the chart names it, and a legend box for
 * a single line is ink doing a label's job. The line is the app's first categorical colour, the
 * same blue as the payoff chart's expiry line; direction is carried by the dashed baseline at the
 * period's opening price and by the signed change in the header, not by recolouring the line.
 *
 * Bars are spaced evenly by trading day rather than by calendar date. Every price chart does
 * this: spacing by date leaves a gap for every weekend and holiday, which reads as the market
 * standing still rather than being shut.
 */
export default function PriceChart({ bars, height = 320, rangeLabel }) {
  const wrapRef = useRef(null);
  const width = useWidth(wrapRef, 760);
  const [hoverIdx, setHoverIdx] = useState(null);

  const m = { top: 12, right: 16, bottom: 28, left: 62 };
  const iw = Math.max(width - m.left - m.right, 50);
  const ih = height - m.top - m.bottom;

  const geo = useMemo(() => {
    const closes = bars.map((b) => b.close);
    const lows = bars.map((b) => Math.min(b.low ?? b.close, b.close));
    const highs = bars.map((b) => Math.max(b.high ?? b.close, b.close));

    let min = Math.min(...lows);
    let max = Math.max(...highs);
    const pad = (max - min) * 0.08 || Math.max(max * 0.01, 0.5);
    min -= pad;
    max += pad;

    const x = (i) => m.left + (bars.length === 1 ? iw / 2 : (i / (bars.length - 1)) * iw);
    const y = (v) => m.top + ((max - v) / (max - min)) * ih;

    const line = bars.map((b, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(b.close).toFixed(2)}`).join('');
    const area = `${line}L${x(bars.length - 1).toFixed(2)},${(m.top + ih).toFixed(2)}L${x(0).toFixed(2)},${(m.top + ih).toFixed(2)}Z`;

    return { x, y, min, max, line, area, yTicks: ticks(min, max, 5), xTicks: dateTicks(bars, Math.max(2, Math.floor(iw / 110))) };
  }, [bars, iw, ih, m.left, m.top]);

  const onPointerMove = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    const i = Math.round(((px - m.left) / iw) * (bars.length - 1));
    setHoverIdx(Math.min(bars.length - 1, Math.max(0, i)));
  };

  const onKeyDown = (event) => {
    const step = event.shiftKey ? 10 : 1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const from = hoverIdx ?? bars.length - 1;
      setHoverIdx(Math.min(bars.length - 1, Math.max(0, from + (event.key === 'ArrowRight' ? step : -step))));
    } else if (event.key === 'Escape') {
      setHoverIdx(null);
    }
  };

  const hover = hoverIdx == null ? null : bars[hoverIdx];
  const hx = hover ? geo.x(hoverIdx) : 0;
  const openPrice = bars[0].close;
  const baselineY = geo.y(openPrice);

  return (
    <div className="pricechart" ref={wrapRef}>
      <svg
        className="price-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Price over ${rangeLabel}: ${fmtPrice(openPrice)} on ${bars[0].date} to ${fmtPrice(bars.at(-1).close)} on ${bars.at(-1).date}. The table of values is below.`}
        tabIndex={0}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHoverIdx(null)}
        onKeyDown={onKeyDown}
        onBlur={() => setHoverIdx(null)}
      >
        {geo.yTicks.map((t) => (
          <g key={t}>
            <line className="gridline" x1={m.left} x2={m.left + iw} y1={geo.y(t)} y2={geo.y(t)} />
            <text className="axis-label" x={m.left - 8} y={geo.y(t)} dy="0.32em" textAnchor="end">
              {fmtPrice(t)}
            </text>
          </g>
        ))}

        {geo.xTicks.map(({ i, text }) => (
          <text key={i} className="axis-label" x={geo.x(i)} y={m.top + ih + 18} textAnchor="middle">
            {text}
          </text>
        ))}

        <path className="price-area" d={geo.area} />

        {/* Where the period started: the reference the header's change is measured from. */}
        <line className="baseline" x1={m.left} x2={m.left + iw} y1={baselineY} y2={baselineY} />

        <path className="price-line" d={geo.line} />

        {hover && (
          <g className="crosshair" pointerEvents="none">
            <line x1={hx} x2={hx} y1={m.top} y2={m.top + ih} />
            <circle className="price-dot" cx={hx} cy={geo.y(hover.close)} r={4.5} />
          </g>
        )}

        <rect x={m.left} y={m.top} width={iw} height={ih} fill="transparent" />
      </svg>

      {hover && (
        <div
          className="tooltip"
          style={{ left: hx > width * 0.6 ? undefined : hx + 14, right: hx > width * 0.6 ? width - hx + 14 : undefined, top: m.top }}
          role="status"
        >
          <div className="tt-head">
            <strong>{fmtPrice(hover.close)}</strong> <span className="muted">{longDate(hover.date)}</span>
          </div>
          <div className="tt-grid">
            <span className="muted">Open</span>
            <span>{fmtPrice(hover.open)}</span>
            <span className="muted">High</span>
            <span>{fmtPrice(hover.high)}</span>
            <span className="muted">Low</span>
            <span>{fmtPrice(hover.low)}</span>
            <span className="muted">Volume</span>
            <span>{compact(hover.volume)}</span>
          </div>
          <div className="tt-since muted">
            {signedPct(hover.close / openPrice - 1)} since {shortLabel(bars[0].date)}
          </div>
        </div>
      )}
    </div>
  );
}

// --- helpers --------------------------------------------------------------------------------

function useWidth(ref, fallback) {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!ref.current) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.floor(entry.contentRect.width);
      if (w > 0) setWidth(w);
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function ticks(min, max, count) {
  const raw = (max - min) / Math.max(count, 1);
  const power = 10 ** Math.floor(Math.log10(raw));
  const f = raw / power;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * power;

  const out = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) out.push(Number(t.toFixed(6)));
  return out;
}

/**
 * Evenly spaced date labels. The format follows the span: days inside a couple of months, months
 * inside a couple of years, years beyond that — so the axis never repeats "Sep" five times or
 * prints a full date nobody is reading.
 */
function dateTicks(bars, count) {
  const span = daysBetween(bars[0].date, bars.at(-1).date);
  const format = span <= 70 ? shortLabel : span <= 800 ? monthLabel : yearLabel;

  const out = [];
  const step = Math.max(1, Math.floor((bars.length - 1) / count));

  for (let i = 0; i < bars.length; i += step) {
    const text = format(bars[i].date);
    // Evenly spaced ticks in a coarse format repeat themselves — five years at year resolution
    // labelled "2023 2023 2025 2025". A repeat carries no information and reads as a mistake, so
    // the tick is placed but left unlabelled.
    if (out.length && out.at(-1).text === text) continue;
    out.push({ i, text });
  }
  return out;
}

const asDate = (iso) => new Date(`${iso}T00:00:00Z`);
const daysBetween = (a, b) => Math.round((asDate(b) - asDate(a)) / 86_400_000);

const shortLabel = (iso) => asDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const monthLabel = (iso) => asDate(iso).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const yearLabel = (iso) => asDate(iso).toLocaleDateString('en-US', { year: 'numeric', timeZone: 'UTC' });
const longDate = (iso) =>
  asDate(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

const signedPct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(2)}%`;
