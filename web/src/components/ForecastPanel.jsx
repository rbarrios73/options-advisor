import { useEffect, useMemo, useRef, useState } from 'react';

import {
  VOL_VERDICTS,
  expectedRange,
  forecastCone,
  ivAt,
  levelOdds,
  volComparison,
} from '@domain/forecast.js';

import { api } from '../api.js';
import { pct, price, shortDate } from '../format.js';

import { tr } from '../i18n.js';
/**
 * What the option market expects from here: the range it is pricing in, whether that is more or
 * less than the stock has really been moving, and the odds for any price you type.
 *
 * A band, never a target. Implied volatility prices how wide the outcomes are, not which way they
 * go — so nothing on this panel says "up" or "down", and the one caveat that matters (real moves
 * outrun the model's tails) is said once, beside the band it applies to.
 */
export default function ForecastPanel({ symbol }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  // The level being asked about. Shared with the chart, which draws it as a line through the cone.
  const [level, setLevel] = useState('');
  const [expiry, setExpiry] = useState(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    api
      .forecast(symbol)
      .then((d) => {
        if (!live) return;
        setData(d);
        // A month out is the horizon most of the app works at; the nearest expiry to it is the
        // default question, and the default level is a 5% drop — the one a put seller asks about.
        const month = [...d.expiries].sort((a, b) => Math.abs(a.dte - 30) - Math.abs(b.dte - 30))[0];
        setExpiry(month?.date ?? null);
        setLevel(d.spot > 0 ? String(roundLevel(d.spot * 0.95)) : '');
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [symbol]);

  const cone = useMemo(() => (data ? forecastCone(data.spot, data.expiries) : []), [data]);

  if (loading && !data) {
    return (
      <section className="panel forecast">
        <h2>{tr('Expected range')}</h2>
        <p className="muted small">{tr('Reading ')}{symbol}{tr('’s option chains…')}</p>
      </section>
    );
  }
  if (error) {
    return (
      <section className="panel forecast">
        <h2>{tr('Expected range')}</h2>
        <p className="error small">{error}</p>
      </section>
    );
  }
  if (!data || data.expiries.length === 0) {
    return (
      <section className="panel forecast">
        <h2>{tr('Expected range')}</h2>
        <p className="muted small">
          {tr('No usable option prices for ')}{symbol}{tr(' in the next four months, so there is no market range to draw.')}
        </p>
      </section>
    );
  }

  const levelNum = Number(level);
  const picked = data.expiries.find((e) => e.date === expiry) ?? data.expiries[0];

  return (
    <section className={loading ? 'panel forecast stale' : 'panel forecast'} aria-labelledby="forecast-title">
      <h2 id="forecast-title">{tr('Expected range')}</h2>
      <p className="muted small forecast-lede">
        {tr('The range ')}{symbol}{tr('’s option prices imply, from ')}{price(data.spot)}{tr(' today. It says how far the market expects the price could go — not which way.')}
      </p>

      <ul className="legend" aria-hidden="true">
        <li>
          <span className="legend-swatch forecast-swatch-line" />{tr(' Last three months')}
        </li>
        <li>
          <span className="legend-band forecast-swatch-one" />{tr(' 68% of outcomes')}
        </li>
        <li>
          <span className="legend-band forecast-swatch-two" />{tr(' 95% of outcomes')}
        </li>
        {levelNum > 0 && (
          <li>
            <span className="legend-swatch forecast-swatch-level" />{tr(' Your level ')}{price(levelNum)}
          </li>
        )}
      </ul>

      <ConeChart recent={data.recent} cone={cone} asOf={data.asOf} spot={data.spot} level={levelNum > 0 ? levelNum : null} />

      <p className="muted small forecast-caveat">
        {tr('Real prices make big moves more often than this model allows, so treat the outer band as the usual range, not the worst case.')}
      </p>

      <div className="scroll-x">
        {/* Named by aria-label, not a visually hidden caption: a 1px caption still opened a gap
            above the first row in Chrome's table layout. */}
        <table className="forecast-table" aria-label={tr('Expected price range by expiry')}>
          <thead>
            <tr>
              <th scope="col">{tr('Expiry')}</th>
              <th scope="col" className="num">{tr('Days')}</th>
              <th scope="col" className="num">{tr('Implied vol')}</th>
              <th scope="col" className="num">{tr('Expected move')}</th>
              <th scope="col" className="num">{tr('68% range')}</th>
              <th scope="col" className="num">{tr('95% range')}</th>
            </tr>
          </thead>
          <tbody>
            {data.expiries.map((e) => {
              const one = expectedRange(data.spot, e.iv, e.dte, 1);
              const two = expectedRange(data.spot, e.iv, e.dte, 2);
              return (
                <tr key={e.date}>
                  <th scope="row">{shortDate(e.date)}</th>
                  <td className="num">{e.dte}</td>
                  <td className="num">{pct(e.iv)}</td>
                  <td className="num">
                    ±{price((one.high - one.low) / 2)}{' '}
                    <span className="muted">({pct((one.high - one.low) / 2 / data.spot)})</span>
                  </td>
                  <td className="num">
                    {price(one.low)}–{price(one.high)}
                  </td>
                  <td className="num">
                    {price(two.low)}–{price(two.high)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="forecast-split">
        <VolCompare data={data} symbol={symbol} />
        <LevelOdds
          data={data}
          symbol={symbol}
          level={level}
          onLevel={setLevel}
          expiry={picked}
          onExpiry={setExpiry}
        />
      </div>
    </section>
  );
}

// --- implied against realised -------------------------------------------------------------------

function VolCompare({ data, symbol }) {
  const implied = ivAt(data.expiries, 30);
  const cmp = volComparison({ implied, realized20: data.realized.d20, realized60: data.realized.d60 });

  return (
    <section className="forecast-sub" aria-labelledby="vol-title">
      <h3 id="vol-title">{tr('Priced-in vs. actual movement')}</h3>

      <dl className="greeks forecast-vol">
        <Stat label={tr('Implied, 30 days')} value={pct(implied)} hint={tr('what options are priced for')} />
        <Stat label={tr('Actual, 20 days')} value={pct(data.realized.d20)} hint={tr('how much it has moved')} />
        <Stat label={tr('Actual, 60 days')} value={pct(data.realized.d60)} hint={tr('over three months')} />
      </dl>

      {cmp ? (
        <p className="small forecast-verdict">
          <span className={`badge tone-${cmp.verdict === 'rich' ? 'done' : cmp.verdict === 'cheap' ? 'watch' : 'muted'}`}>
            {cmp.verdict === 'rich' ? tr('Priced high') : cmp.verdict === 'cheap' ? tr('Priced low') : tr('In line')}
          </span>{' '}
          {tr('Implied is ')}{cmp.ratio}{tr('× the 20-day figure (')}{cmp.gapPts >= 0 ? '+' : ''}
          {cmp.gapPts}{tr(' pts). ')}{tr(VOL_VERDICTS[cmp.verdict])}
        </p>
      ) : (
        <p className="muted small">{tr('Not enough price history for ')}{symbol}{tr(' to compare.')}</p>
      )}
    </section>
  );
}

// --- odds for a price level ---------------------------------------------------------------------

const NUDGES = [-0.1, -0.05, 0.05, 0.1];

function LevelOdds({ data, symbol, level, onLevel, expiry, onExpiry }) {
  const value = Number(level);
  const odds = levelOdds({ spot: data.spot, level: value, iv: expiry.iv, days: expiry.dte, riskFree: data.riskFree });

  return (
    <section className="forecast-sub" aria-labelledby="odds-title">
      <h3 id="odds-title">{tr('Odds for a price')}</h3>

      <form className="odds-form" onSubmit={(e) => e.preventDefault()}>
        <label className="field">
          <span>{tr('Price')}</span>
          <input
            type="number"
            min="0"
            step="0.5"
            inputMode="decimal"
            value={level}
            onChange={(e) => onLevel(e.target.value)}
            className="w-qty"
          />
        </label>
        <label className="field">
          <span>{tr('By##date')}</span>
          <select value={expiry.date} onChange={(e) => onExpiry(e.target.value)}>
            {data.expiries.map((e) => (
              <option key={e.date} value={e.date}>
                {shortDate(e.date)} · {e.dte}d
              </option>
            ))}
          </select>
        </label>
        <div className="odds-nudges" role="group" aria-label={tr('Set the price relative to today')}>
          {NUDGES.map((n) => (
            <button key={n} type="button" className="chip" onClick={() => onLevel(String(roundLevel(data.spot * (1 + n))))}>
              {n > 0 ? '+' : '−'}
              {Math.abs(n * 100)}%
            </button>
          ))}
        </div>
      </form>

      {odds ? (
        <>
          <dl className="greeks forecast-odds" aria-live="polite">
            <Stat label={tr('Ends above {0}', [price(value)])} value={pct(odds.above, 0)} hint={tr('on {0}', [shortDate(expiry.date)])} />
            <Stat label={tr('Ends below {0}', [price(value)])} value={pct(odds.below, 0)} hint={tr('on {0}', [shortDate(expiry.date)])} />
            <Stat
              label={tr('Touches {0}', [price(value)])}
              value={pct(odds.touch, 0)}
              hint={tr('at any point before {0}', [shortDate(expiry.date)])}
            />
          </dl>
          <p className="muted small">
            {price(value)}{tr(' is ')}{pct(Math.abs(odds.move))} {odds.side === 'above' ? tr('above') : tr('below')}{tr(' today’s')}{' '}
            {price(data.spot)}{tr('. Touching a level is roughly twice as likely as ending past it — which is why a short strike gets tested more often than it finishes in the money.')}
          </p>
        </>
      ) : (
        <p className="muted small">{tr('Type a price to see the odds for ')}{symbol}.</p>
      )}
    </section>
  );
}

function Stat({ label, value, hint }) {
  return (
    <div className="greek">
      <dt>{label}</dt>
      <dd>
        <span className="greek-value">{value}</span>
        {hint && <span className="greek-hint">{hint}</span>}
      </dd>
    </div>
  );
}

/** A level someone would type: whole dollars above $50, halves below. */
function roundLevel(v) {
  return v >= 50 ? Math.round(v) : Math.round(v * 2) / 2;
}

// --- the cone chart -----------------------------------------------------------------------------

/**
 * The last three months of closes, then the cone opening out from today's price to the last
 * expiry. Calendar days on the x axis throughout, so the cone's width is honest about time.
 * Arrow keys walk a readout along it; the table beneath carries the same numbers as text.
 */
function ConeChart({ recent, cone, asOf, spot, level, height = 300 }) {
  const wrapRef = useRef(null);
  const width = useWidth(wrapRef, 760);
  const [hover, setHover] = useState(null); // calendar-day offset from asOf, negative for history

  const m = { top: 12, right: 64, bottom: 28, left: 62 };
  const iw = Math.max(width - m.left - m.right, 50);
  const ih = height - m.top - m.bottom;

  const geo = useMemo(() => {
    const today = asDate(asOf);
    const past = recent.map((b) => ({ d: Math.round((asDate(b.date) - today) / 86_400_000), close: b.close }));
    const firstDay = past.length ? Math.min(past[0].d, -1) : -30;
    const lastDay = cone.length ? cone.at(-1).days : 30;

    const values = [...past.map((p) => p.close), ...cone.flatMap((c) => [c.two.low, c.two.high]), spot];
    if (level) values.push(level);
    let min = Math.min(...values);
    let max = Math.max(...values);
    const pad = (max - min) * 0.06 || spot * 0.02;
    min -= pad;
    max += pad;

    const x = (d) => m.left + ((d - firstDay) / (lastDay - firstDay)) * iw;
    const y = (v) => m.top + ((max - v) / (max - min)) * ih;

    const line = past.map((p, i) => `${i ? 'L' : 'M'}${x(p.d).toFixed(1)},${y(p.close).toFixed(1)}`).join('');
    const band = (key) =>
      `${cone.map((c, i) => `${i ? 'L' : 'M'}${x(c.days).toFixed(1)},${y(c[key].high).toFixed(1)}`).join('')}` +
      `${[...cone].reverse().map((c) => `L${x(c.days).toFixed(1)},${y(c[key].low).toFixed(1)}`).join('')}Z`;

    return {
      x,
      y,
      past,
      firstDay,
      lastDay,
      line,
      one: band('one'),
      two: band('two'),
      yTicks: ticks(min, max, 5),
      expiries: cone.filter((c) => c.expiry),
    };
  }, [recent, cone, asOf, spot, level, iw, ih, m.left, m.top]);

  const dayFromPointer = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    const d = Math.round(geo.firstDay + ((px - m.left) / iw) * (geo.lastDay - geo.firstDay));
    return Math.min(geo.lastDay, Math.max(geo.firstDay, d));
  };

  const onKeyDown = (event) => {
    const step = event.shiftKey ? 7 : 1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const from = hover ?? 0;
      const next = from + (event.key === 'ArrowRight' ? step : -step);
      setHover(Math.min(geo.lastDay, Math.max(geo.firstDay, next)));
    } else if (event.key === 'Escape') {
      setHover(null);
    }
  };

  const readout = useMemo(() => {
    if (hover == null) return null;
    if (hover <= 0) {
      const bar = geo.past.reduce((best, p) => (Math.abs(p.d - hover) < Math.abs(best.d - hover) ? p : best), geo.past[0] ?? { d: 0, close: spot });
      return { kind: 'past', d: bar.d, close: bar.close };
    }
    const c = cone.reduce((best, p) => (Math.abs(p.days - hover) < Math.abs(best.days - hover) ? p : best), cone[0]);
    return { kind: 'future', d: c.days, ...c };
  }, [hover, geo.past, cone, spot]);

  const todayX = geo.x(0);
  const rx = readout ? geo.x(readout.d) : 0;
  const last = cone.at(-1);

  return (
    <div className="pricechart forecast-chart" ref={wrapRef}>
      <svg
        className="price-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={
          last
            ? tr('Expected range: by {0}, 68% of outcomes between {1} and {2}, 95% between {3} and {4}. The table below has every expiry.', [shortDate(last.expiry ?? addDays(asOf, last.days)), price(last.one.low), price(last.one.high), price(last.two.low), price(last.two.high)])
            : tr('Expected range chart')
        }
        tabIndex={0}
        onPointerMove={(e) => setHover(dayFromPointer(e))}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
        onBlur={() => setHover(null)}
      >
        {geo.yTicks.map((t) => (
          <g key={t}>
            <line className="gridline" x1={m.left} x2={m.left + iw} y1={geo.y(t)} y2={geo.y(t)} />
            <text className="axis-label" x={m.left - 8} y={geo.y(t)} dy="0.32em" textAnchor="end">
              {price(t)}
            </text>
          </g>
        ))}

        <path className="forecast-two" d={geo.two} />
        <path className="forecast-one" d={geo.one} />
        <path className="price-line" d={geo.line} />

        <line className="forecast-today" x1={todayX} x2={todayX} y1={m.top} y2={m.top + ih} />
        <text className="axis-label" x={todayX} y={m.top + ih + 18} textAnchor="middle">
          {tr('Today')}
        </text>
        {geo.past.length > 0 && (
          <text className="axis-label" x={geo.x(geo.past[0].d)} y={m.top + ih + 18} textAnchor="start">
            {shortDate(addDays(asOf, geo.past[0].d))}
          </text>
        )}

        {geo.expiries.map((c, i) => (
          <g key={c.expiry}>
            <line className="forecast-expiry" x1={geo.x(c.days)} x2={geo.x(c.days)} y1={geo.y(c.two.high)} y2={geo.y(c.two.low)} />
            <circle className="forecast-dot" cx={geo.x(c.days)} cy={geo.y(c.one.high)} r={3} />
            <circle className="forecast-dot" cx={geo.x(c.days)} cy={geo.y(c.one.low)} r={3} />
            {/* Labelled only where there is room: a weekly expiry sits right beside "Today". */}
            {geo.x(c.days) - todayX > 44 &&
              (i === 0 || geo.x(c.days) - geo.x(geo.expiries[i - 1].days) > 52) && (
                <text className="axis-label" x={geo.x(c.days)} y={m.top + ih + 18} textAnchor="middle">
                  {shortDate(c.expiry)}
                </text>
              )}
          </g>
        ))}

        {/* Edge labels at the far end, where the reader's eye finishes. */}
        {last && (
          <g className="forecast-edge">
            {[last.two.high, last.one.high, last.one.low, last.two.low].map((v, i) => (
              <text key={i} className="axis-label" x={geo.x(last.days) + 6} y={geo.y(v)} dy="0.32em">
                {price(v)}
              </text>
            ))}
          </g>
        )}

        {level && (
          <line className="forecast-level" x1={m.left} x2={m.left + iw} y1={geo.y(level)} y2={geo.y(level)} />
        )}

        {readout && (
          <g className="crosshair" pointerEvents="none">
            <line x1={rx} x2={rx} y1={m.top} y2={m.top + ih} />
            {readout.kind === 'past' && <circle className="price-dot" cx={rx} cy={geo.y(readout.close)} r={4.5} />}
          </g>
        )}
        <rect x={m.left} y={m.top} width={iw} height={ih} fill="transparent" />
      </svg>

      {readout && (
        <div
          className="tooltip"
          role="status"
          style={{ left: rx > width * 0.6 ? undefined : rx + 14, right: rx > width * 0.6 ? width - rx + 14 : undefined, top: m.top }}
        >
          {readout.kind === 'past' ? (
            <div className="tt-head">
              <strong>{price(readout.close)}</strong>{' '}
              <span className="muted">{shortDate(addDays(asOf, readout.d))}</span>
            </div>
          ) : (
            <>
              <div className="tt-head">
                <strong>{shortDate(addDays(asOf, readout.d))}</strong>{' '}
                <span className="muted">
                  {readout.d}{tr(' days · IV ')}{pct(readout.iv)}
                </span>
              </div>
              <div className="tt-grid">
                <span className="muted">68%</span>
                <span>
                  {price(readout.one.low)}–{price(readout.one.high)}
                </span>
                <span className="muted">95%</span>
                <span>
                  {price(readout.two.low)}–{price(readout.two.high)}
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

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

const asDate = (iso) => new Date(`${iso}T00:00:00Z`);
const addDays = (iso, days) => {
  const d = asDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
