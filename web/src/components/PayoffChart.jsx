import { useEffect, useMemo, useRef, useState } from 'react';

import { money, price as fmtPrice, signed } from '../format.js';

/**
 * Profit and loss against the underlying's price: the payoff at expiry (solid) and the modelled
 * value on the projected date (dashed), with the strikes, the break-even, today's price and a
 * one-standard-deviation band marked.
 *
 * Colour follows the dataviz rules: the two lines are categorical slots 1 and 2, validated on
 * this app's dark surface; the profit/loss shading is the diverging blue↔red pair, not green/red,
 * which is the pairing a red-green colour-blind reader cannot separate. The dashed stroke on the
 * projected line is secondary encoding, so identity never rests on colour alone.
 */
export default function PayoffChart({
  curve,
  spot,
  // Every labelled vertical: the legs' strikes, the break-even, the current price. Passed in
  // rather than inferred, so the chart does not need to know which strategy it is drawing.
  levels = [],
  sigma,
  projectedLabel,
  projectedIsExpiry,
  height = 400,
}) {
  const wrapRef = useRef(null);
  const width = useWidth(wrapRef, 760);
  const [hoverIdx, setHoverIdx] = useState(null);

  const left = 70;
  const right = 18;
  const bottom = 34;
  const iw = Math.max(width - left - right, 50);

  // The marker labels are laid out first, because how many lane rows they need decides where the
  // plot starts. On a phone four labels can need four rows; on a desktop they usually fit in two.
  const lo = curve[0].price;
  const hi = curve.at(-1).price;
  const xOf = (p) => left + ((p - lo) / (hi - lo)) * iw;

  const markers = laneLayout(
    levels
      .map((level) => ({
        key: level.key,
        x: xOf(level.value),
        text: `${level.label} ${fmtPrice(level.value)}`,
        kind: level.kind ?? 'strike',
      }))
      .filter((mk) => mk.x >= left && mk.x <= left + iw),
    left,
    left + iw,
  );
  const rowsUsed = Math.max(1, ...markers.map((mk) => mk.row + 1));

  const m = { top: laneY(rowsUsed - 1) + 12, right, bottom, left };
  const ih = height - m.top - m.bottom;

  const geo = useMemo(() => {
    const values = curve.flatMap((p) => (projectedIsExpiry ? [p.expiry] : [p.expiry, p.projected]));
    let yMin = Math.min(0, ...values);
    let yMax = Math.max(0, ...values);
    const pad = (yMax - yMin) * 0.1 || 10;
    yMin -= pad;
    yMax += pad;

    const x = xOf;
    const y = (v) => m.top + ((yMax - v) / (yMax - yMin)) * ih;

    const line = (key) =>
      curve.map((p, i) => `${i ? 'L' : 'M'}${x(p.price).toFixed(2)},${y(p[key]).toFixed(2)}`).join('');

    const zeroY = y(0);
    const area =
      `M${x(lo).toFixed(2)},${zeroY.toFixed(2)}` +
      curve.map((p) => `L${x(p.price).toFixed(2)},${y(p.expiry).toFixed(2)}`).join('') +
      `L${x(hi).toFixed(2)},${zeroY.toFixed(2)}Z`;

    return {
      lo,
      hi,
      x,
      y,
      zeroY,
      area,
      expiryPath: line('expiry'),
      projectedPath: line('projected'),
      xTicks: ticks(lo, hi, Math.max(3, Math.floor(iw / 90))),
      yTicks: ticks(yMin, yMax, 5),
    };
    // xOf is rebuilt every render but is a pure function of lo, hi, left and iw, all listed.
  }, [curve, projectedIsExpiry, iw, ih, lo, hi, left, m.top]);

  // --- hover and keyboard: the crosshair snaps to the nearest sampled price -------------------

  const onPointerMove = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    const target = geo.lo + ((px - m.left) / iw) * (geo.hi - geo.lo);
    setHoverIdx(nearestIndex(curve, target));
  };

  const onKeyDown = (event) => {
    const stepSize = event.shiftKey ? 10 : 1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const start = hoverIdx ?? nearestIndex(curve, spot);
      const next = start + (event.key === 'ArrowRight' ? stepSize : -stepSize);
      setHoverIdx(Math.min(curve.length - 1, Math.max(0, next)));
    } else if (event.key === 'Escape') {
      setHoverIdx(null);
    }
  };

  const hover = hoverIdx != null ? curve[hoverIdx] : null;
  const hx = hover ? geo.x(hover.price) : 0;
  const lastPoint = curve.at(-1);
  const expiryOnTop = projectedIsExpiry || lastPoint.expiry >= lastPoint.projected;

  const sigmaLo = sigma ? Math.max(geo.x(spot - sigma), m.left) : null;
  const sigmaHi = sigma ? Math.min(geo.x(spot + sigma), m.left + iw) : null;

  return (
    <div className="payoff" ref={wrapRef}>
      <ul className="legend" aria-label="Series">
        <li>
          <svg width="22" height="8" aria-hidden="true">
            <line x1="1" y1="4" x2="21" y2="4" className="ln-expiry" />
          </svg>
          At expiry
        </li>
        {!projectedIsExpiry && (
          <li>
            <svg width="22" height="8" aria-hidden="true">
              <line x1="1" y1="4" x2="21" y2="4" className="ln-projected" />
            </svg>
            {projectedLabel}
          </li>
        )}
        {sigma ? (
          <li>
            <span className="legend-band" aria-hidden="true" />
            ±1σ expected move by expiry
          </li>
        ) : null}
      </ul>

      <svg
        className="payoff-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Profit and loss chart. ${levels
          .map((l) => `${l.label} ${fmtPrice(l.value)}`)
          .join(', ')}. The table below the chart has the same values.`}
        tabIndex={0}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHoverIdx(null)}
        onKeyDown={onKeyDown}
        onBlur={() => setHoverIdx(null)}
      >
        <defs>
          <clipPath id="pc-profit">
            <rect x={m.left} y={m.top} width={iw} height={Math.max(geo.zeroY - m.top, 0)} />
          </clipPath>
          <clipPath id="pc-loss">
            <rect x={m.left} y={geo.zeroY} width={iw} height={Math.max(m.top + ih - geo.zeroY, 0)} />
          </clipPath>
          <clipPath id="pc-plot">
            <rect x={m.left} y={m.top} width={iw} height={ih} />
          </clipPath>
        </defs>

        {/* ±1σ band sits furthest back: context, not data. */}
        {sigma ? (
          <rect className="sigma-band" x={sigmaLo} y={m.top} width={Math.max(sigmaHi - sigmaLo, 0)} height={ih} />
        ) : null}

        {/* Recessive grid. */}
        {geo.yTicks.map((t) => (
          <g key={`y${t}`}>
            <line className="gridline" x1={m.left} x2={m.left + iw} y1={geo.y(t)} y2={geo.y(t)} />
            <text className="axis-label" x={m.left - 8} y={geo.y(t)} dy="0.32em" textAnchor="end">
              {money(t)}
            </text>
          </g>
        ))}
        {geo.xTicks.map((t) => (
          <text key={`x${t}`} className="axis-label" x={geo.x(t)} y={m.top + ih + 20} textAnchor="middle">
            {formatTick(t)}
          </text>
        ))}

        {/* Profit and loss shading under the expiry payoff. */}
        <path className="fill-profit" d={geo.area} clipPath="url(#pc-profit)" />
        <path className="fill-loss" d={geo.area} clipPath="url(#pc-loss)" />

        {/* Marker guides, drawn under the lines. */}
        {markers.map((mk) =>
          mk.kind === 'be' ? null : (
            <line
              key={`g-${mk.key}`}
              className={mk.kind === 'spot' ? 'guide-spot' : 'guide-strike'}
              x1={mk.x}
              x2={mk.x}
              y1={laneY(mk.row) + 4}
              y2={m.top + ih}
            />
          ),
        )}

        <line className="zero" x1={m.left} x2={m.left + iw} y1={geo.zeroY} y2={geo.zeroY} />

        <g clipPath="url(#pc-plot)">
          {!projectedIsExpiry && <path className="ln-projected" d={geo.projectedPath} />}
          <path className="ln-expiry" d={geo.expiryPath} />
        </g>

        {/* Break-even: a marker on the zero line, ringed so it reads against both fills. */}
        {levels
          .filter((l) => l.kind === 'be')
          .map((l) => (
            <circle key={l.key} className="be-dot" cx={geo.x(l.value)} cy={geo.zeroY} r={4.5} />
          ))}

        {/* Direct labels at the right end. Each sits on the side away from the other line — on a
            credit spread the projected line is below the payoff, on a long option it is above, so
            a fixed above/below rule would put the labels in the wrong order half the time. */}
        <text
          className="direct-label"
          x={m.left + iw - 6}
          y={geo.y(lastPoint.expiry) + (expiryOnTop ? -8 : 16)}
          textAnchor="end"
        >
          At expiry
        </text>
        {!projectedIsExpiry && (
          <text
            className="direct-label"
            x={m.left + iw - 6}
            y={geo.y(lastPoint.projected) + (expiryOnTop ? 16 : -8)}
            textAnchor="end"
          >
            {projectedLabel}
          </text>
        )}

        {/* Marker lane above the plot, rows assigned so labels never overlap. */}
        {markers.map((mk) => (
          <text
            key={`t-${mk.key}`}
            className={`marker-label marker-${mk.kind}`}
            x={mk.labelX}
            y={laneY(mk.row)}
            textAnchor="middle"
          >
            {mk.text}
          </text>
        ))}

        {sigma ? (
          <text className="axis-label" x={sigmaLo + 4} y={m.top + ih - 6}>
            −1σ
          </text>
        ) : null}
        {sigma ? (
          <text className="axis-label" x={sigmaHi - 4} y={m.top + ih - 6} textAnchor="end">
            +1σ
          </text>
        ) : null}

        {/* Crosshair. */}
        {hover && (
          <g className="crosshair" pointerEvents="none">
            <line x1={hx} x2={hx} y1={m.top} y2={m.top + ih} />
            {!projectedIsExpiry && <circle className="dot-projected" cx={hx} cy={geo.y(hover.projected)} r={4.5} />}
            <circle className="dot-expiry" cx={hx} cy={geo.y(hover.expiry)} r={4.5} />
          </g>
        )}

        {/* Transparent hit area over the whole plot: the reader aims at a price, not at a line. */}
        <rect x={m.left} y={m.top} width={iw} height={ih} fill="transparent" />
      </svg>

      {hover && (
        <div
          className="tooltip"
          style={{
            left: hx > width * 0.62 ? undefined : hx + 14,
            right: hx > width * 0.62 ? width - hx + 14 : undefined,
            top: m.top + 8,
          }}
          role="status"
        >
          <div className="tt-head">
            <strong>{fmtPrice(hover.price)}</strong>
            <span className="muted"> {signedPct(hover.price / spot - 1)} from spot</span>
          </div>
          <div className="tt-row">
            <svg width="16" height="6" aria-hidden="true">
              <line x1="0" y1="3" x2="16" y2="3" className="ln-expiry" />
            </svg>
            <strong className={hover.expiry >= 0 ? 'pos' : 'neg'}>{signed(round0(hover.expiry))}</strong>
            <span className="muted">at expiry</span>
          </div>
          {!projectedIsExpiry && (
            <div className="tt-row">
              <svg width="16" height="6" aria-hidden="true">
                <line x1="0" y1="3" x2="16" y2="3" className="ln-projected" />
              </svg>
              <strong className={hover.projected >= 0 ? 'pos' : 'neg'}>{signed(round0(hover.projected))}</strong>
              <span className="muted">{projectedLabel}</span>
            </div>
          )}
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

const LANE_TOP = 16;
const LANE_GAP = 15;
const laneY = (row) => LANE_TOP + row * LANE_GAP;

/**
 * Puts each marker label on the first lane row where it does not collide with the label before
 * it, and keeps labels inside the plot's horizontal bounds. Widths are estimated from character
 * count — close enough at 11px, and it avoids measuring text in the DOM on every render.
 */
function laneLayout(markers, left, right) {
  const sorted = [...markers].sort((a, b) => a.x - b.x);
  const rowEnds = [];

  // A new row whenever no existing one has room — never a forced overlap. With four labels the
  // worst case is four rows, which is what a phone-width chart can need.
  return sorted.map((mk) => {
    const w = mk.text.length * 6.4 + 8;
    const labelX = Math.min(Math.max(mk.x, left + w / 2), right - w / 2);
    let row = rowEnds.findIndex((end) => labelX - w / 2 > end + 4);
    if (row === -1) row = rowEnds.length;
    rowEnds[row] = labelX + w / 2;
    return { ...mk, labelX, row };
  });
}

function nearestIndex(curve, target) {
  let lo = 0;
  let hi = curve.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid].price < target) lo = mid;
    else hi = mid;
  }
  return Math.abs(curve[lo].price - target) <= Math.abs(curve[hi].price - target) ? lo : hi;
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

const formatTick = (t) => (Math.abs(t) >= 100 ? t.toFixed(0) : t.toFixed(Number.isInteger(t) ? 0 : 1));
const round0 = (v) => Math.round(v);
const signedPct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`;
