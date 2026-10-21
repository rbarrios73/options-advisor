import { useEffect, useMemo, useRef, useState } from 'react';

import { money, shortDate, signed } from '../format.js';

/**
 * What time alone does: P&L from today to expiry, with the price held where it is.
 *
 * One series, so there is no legend — the heading names it. The line is series slot 1 on both
 * planes, already validated against this app's surfaces; the area under it is washed in the
 * diverging profit/loss pair so a position that crosses zero reads correctly on each side without
 * the line changing colour, which would make one series look like two.
 *
 * The marker is the Date slider's current position, so the two controls describe the same point
 * rather than sitting beside each other saying different things.
 */
export default function DecayChart({ curve, daysForward = 0, height = 220 }) {
  const wrapRef = useRef(null);
  const width = useWidth(wrapRef, 760);
  const [hoverIdx, setHoverIdx] = useState(null);

  const m = { top: 16, right: 18, bottom: 30, left: 66 };
  const iw = Math.max(width - m.left - m.right, 50);
  const ih = Math.max(height - m.top - m.bottom, 40);

  const geo = useMemo(() => {
    const values = curve.map((p) => p.pnl);
    const lo = Math.min(0, ...values);
    const hi = Math.max(0, ...values);

    // A tenth of the range as headroom, so the end label is not pinned to the frame.
    const pad = Math.max((hi - lo) * 0.12, 1);
    const yMin = lo - pad;
    const yMax = hi + pad * 0.5;

    const lastDay = curve.at(-1).day || 1;

    return {
      xOf: (day) => m.left + (day / lastDay) * iw,
      yOf: (v) => m.top + ih - ((v - yMin) / (yMax - yMin)) * ih,
      yMin,
      yMax,
      lastDay,
    };
  }, [curve, iw, ih, m.left, m.top]);

  if (curve.length < 2) {
    return <p className="muted small">This expires today, so there is no decay left to draw.</p>;
  }

  const path = curve.map((p, i) => `${i ? 'L' : 'M'}${geo.xOf(p.day)},${geo.yOf(p.pnl)}`).join(' ');
  const zeroY = geo.yOf(0);

  // The area is split at zero so the wash under a profit and under a loss are different colours
  // while the line stays one. Drawn as two clipped copies of the same fill.
  const area = `${path} L${geo.xOf(curve.at(-1).day)},${zeroY} L${geo.xOf(curve[0].day)},${zeroY} Z`;

  const hovered = hoverIdx == null ? null : curve[hoverIdx];
  const marked = nearestTo(curve, daysForward);

  const yTicks = ticksFor(geo.yMin, geo.yMax);
  const xTicks = dayTicks(curve, width);

  const onMove = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * width;
    const day = ((x - m.left) / iw) * geo.lastDay;
    setHoverIdx(curve.indexOf(nearestTo(curve, day)));
  };

  return (
    <figure className="decay-chart" ref={wrapRef}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Profit and loss from today to expiry with the price unchanged. ${signed(curve[0].pnl)} today, ${signed(curve.at(-1).pnl)} at expiry.`}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <clipPath id="decay-above">
            <rect x={m.left} y={m.top} width={iw} height={Math.max(zeroY - m.top, 0)} />
          </clipPath>
          <clipPath id="decay-below">
            <rect x={m.left} y={zeroY} width={iw} height={Math.max(m.top + ih - zeroY, 0)} />
          </clipPath>
        </defs>

        {yTicks.map((v) => (
          <g key={v}>
            <line x1={m.left} x2={m.left + iw} y1={geo.yOf(v)} y2={geo.yOf(v)} stroke="var(--gridline)" strokeWidth="1" />
            <text x={m.left - 8} y={geo.yOf(v) + 3} textAnchor="end" className="axis-label">
              {money(v)}
            </text>
          </g>
        ))}

        <path d={area} clipPath="url(#decay-above)" fill="var(--profit)" opacity="0.14" />
        <path d={area} clipPath="url(#decay-below)" fill="var(--loss)" opacity="0.14" />

        {/* Break-even in time: the day the position stops being underwater, if it does. */}
        {geo.yMin < 0 && geo.yMax > 0 && (
          <line x1={m.left} x2={m.left + iw} y1={zeroY} y2={zeroY} stroke="var(--axis)" strokeWidth="1" />
        )}

        <path d={path} fill="none" stroke="var(--series-1)" strokeWidth="2" strokeLinejoin="round" />

        {/* Where the Date slider is standing. A 2px surface ring keeps it legible on the line. */}
        {marked && (
          <g>
            <line
              x1={geo.xOf(marked.day)}
              x2={geo.xOf(marked.day)}
              y1={m.top}
              y2={m.top + ih}
              stroke="var(--axis)"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            <circle cx={geo.xOf(marked.day)} cy={geo.yOf(marked.pnl)} r="5" fill="var(--series-1)" stroke="var(--panel)" strokeWidth="2" />
          </g>
        )}

        {xTicks.map((p) => (
          <text key={p.day} x={geo.xOf(p.day)} y={height - 10} textAnchor={p.anchor} className="axis-label">
            {p.text}
          </text>
        ))}

        {hovered && (
          <g pointerEvents="none">
            <line
              x1={geo.xOf(hovered.day)}
              x2={geo.xOf(hovered.day)}
              y1={m.top}
              y2={m.top + ih}
              stroke="var(--outline)"
              strokeWidth="1"
            />
            <circle cx={geo.xOf(hovered.day)} cy={geo.yOf(hovered.pnl)} r="4" fill="var(--series-1)" stroke="var(--panel)" strokeWidth="2" />
          </g>
        )}
      </svg>

      <figcaption className="muted small">
        {hovered ? (
          <span>
            <strong>{hovered.day === 0 ? 'Today' : shortDate(hovered.date)}</strong> · {hovered.daysLeft} days left ·{' '}
            <strong>{signed(hovered.pnl)}</strong> · theta {signed(hovered.theta)}/day
          </span>
        ) : (
          <span>
            Price held at today&rsquo;s, implied vol unchanged. Hover for a day; the dot is where the
            Date slider is.
          </span>
        )}
      </figcaption>
    </figure>
  );
}

const nearestTo = (curve, day) =>
  curve.reduce((best, p) => (Math.abs(p.day - day) < Math.abs(best.day - day) ? p : best), curve[0]);

/** Four or five round values spanning the range — enough to read a height against. */
function ticksFor(min, max) {
  const span = max - min;
  if (!(span > 0)) return [0];

  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? mag * 10;

  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) {
    const rounded = Math.round(v * 100) / 100;
    // Object.is, because -0 === 0 is true and Intl still formats the negative one as "-$0",
    // which on an axis reads as a bug rather than as zero.
    out.push(Object.is(rounded, -0) ? 0 : rounded);
  }
  return out;
}

/** Today, expiry, and one in between — anchored so neither end label is clipped. */
function dayTicks(curve, width) {
  const last = curve.at(-1);
  const mid = curve[Math.floor(curve.length / 2)];

  const ticks = [
    { day: 0, text: 'Today', anchor: 'start' },
    { day: last.day, text: `${shortDate(last.date)} · expiry`, anchor: 'end' },
  ];

  // Only when there is room for it twice over: a two-week position has nothing useful to put in
  // the middle, and at phone width the middle label runs into "expiry" — which it did.
  if (last.day >= 14 && width >= 520) {
    ticks.splice(1, 0, { day: mid.day, text: shortDate(mid.date), anchor: 'middle' });
  }
  return ticks;
}

/** The SVG is drawn at its real pixel width, so strokes are not scaled and text stays 11px. */
function useWidth(ref, fallback) {
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;

    const observer = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w > 0) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}
