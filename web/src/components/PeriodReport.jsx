import { useMemo, useState } from 'react';

import { POSITION_TYPES } from '@domain/positions.js';
import { KIND_LABELS, PRESETS, periodReport, presetRange } from '@domain/report.js';

import { pct, price, shortDate } from '../format.js';

/**
 * Trading results between two dates — the weekly journal, kept by the app.
 *
 * Every figure is computed from the tracker's rows as the dates change; nothing is fetched. Where
 * the rows cannot support a number (capital for a covered call, a close settled before costs were
 * kept), the number is left out of its total and the footnote says how many were.
 */
export default function PeriodReport({ positions, today }) {
  const [preset, setPreset] = useState('this-week');
  const [range, setRange] = useState(() => presetRange('this-week', today));

  const choose = (key) => {
    setPreset(key);
    setRange(presetRange(key, today));
  };
  const setDate = (key) => (event) => {
    const value = event.target.value;
    if (!value) return;
    setPreset('custom');
    setRange((r) => {
      const next = { ...r, [key]: value };
      // A from after the to is a range nobody meant; move the other end rather than show nothing.
      if (next.from > next.to) key === 'from' ? (next.to = value) : (next.from = value);
      return next;
    });
  };

  const report = useMemo(() => periodReport(positions, { ...range, today }), [positions, range, today]);
  const { totals, groups } = report;

  return (
    <section className="panel results-report" aria-labelledby="results-title">
      <div className="report-head">
        <div>
          <h2 id="results-title">Trading results</h2>
          <p className="muted small report-range">
            {longDate(report.from)} – {longDate(report.to)} · {totals.tradingDays} trading day
            {totals.tradingDays === 1 ? '' : 's'}
          </p>
        </div>

        <form className="report-filter" onSubmit={(e) => e.preventDefault()} aria-label="Date range">
          <div className="segmented" role="radiogroup" aria-label="Period">
            {Object.entries(PRESETS).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={preset === key}
                className={preset === key ? 'on' : ''}
                onClick={() => choose(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="field">
            <span>From</span>
            <input type="date" value={range.from} max={today} onChange={setDate('from')} />
          </label>
          <label className="field">
            <span>To</span>
            <input type="date" value={range.to} max={today} onChange={setDate('to')} />
          </label>
        </form>
      </div>

      {totals.count === 0 ? (
        <p className="muted">
          Nothing opened, rolled or closed between {shortDate(report.from)} and {shortDate(report.to)}.
          {report.assigned > 0 && ` ${report.assigned} assignment${report.assigned === 1 ? '' : 's'} — not counted here.`}
        </p>
      ) : (
        <>
          <dl className="report-tiles">
            <Tile label="Premium collected" value={money2(totals.collected)} hint="before closes" />
            <Tile
              label="Cost to close"
              value={totals.costToClose > 0 ? `−${money2(totals.costToClose)}` : money2(0)}
              hint={`${groups.close.count} trade${groups.close.count === 1 ? '' : 's'}`}
            />
            <Tile label="Net premium" value={money2(totals.net)} hint="after closes" strong />
            <Tile label="Transactions" value={String(totals.count)} hint={report.assigned ? 'assignments not counted' : 'excludes assignments'} />
            <Tile label="Average per transaction" value={money2(totals.averagePerTransaction)} hint="net" />
          </dl>

          <dl className="report-tiles report-tiles-secondary">
            <Tile label="Capital required" value={money2(totals.capital)} hint="for these trades" />
            <Tile label="Return on capital" value={pct(totals.returnOnCapital, 2)} hint="net ÷ capital required" />
            <Tile label="Per trading day" value={money2(totals.perDay)} hint={`over ${totals.tradingDays} day${totals.tradingDays === 1 ? '' : 's'}`} />
          </dl>

          <div className="report-groups">
            <Group
              title="New positions"
              kind="new"
              group={groups.new}
              rows={[
                ['Total premium', money2(groups.new.premium)],
                ['Average premium', money2(groups.new.average)],
                ['Average yearly ROI', pct(groups.new.averageYearlyRoi, 0)],
              ]}
            />
            <Group
              title="Rolls"
              kind="roll"
              group={groups.roll}
              rows={[
                ['Total premium', money2(groups.roll.premium)],
                ['Average premium', money2(groups.roll.average)],
                ['Average yearly ROI', pct(groups.roll.averageYearlyRoi, 0)],
              ]}
            />
            <Group
              title="Closed positions"
              kind="close"
              group={groups.close}
              rows={[
                ['Total cost to close', groups.close.count ? `−${money2(-groups.close.premium)}` : '—'],
                ['Average cost', groups.close.count ? `−${money2(-groups.close.average)}` : '—'],
              ]}
            />
            <TradeMix groups={groups} total={totals.count} />
          </div>

          <div className="scroll-x">
            <table className="report-table">
              <caption className="muted small">
                Every transaction from {shortDate(report.from)} to {shortDate(report.to)}, in date order.
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="num">#</th>
                  <th scope="col">Ticker</th>
                  <th scope="col">Date</th>
                  <th scope="col">Type</th>
                  <th scope="col">Event</th>
                  <th scope="col" className="num">Short</th>
                  <th scope="col" className="num">Long</th>
                  <th scope="col" className="num">Delta</th>
                  <th scope="col">Expiry</th>
                  <th scope="col">Roll</th>
                  <th scope="col" className="num">Premium</th>
                  <th scope="col" className="num">Capital</th>
                  <th scope="col" className="num">Yearly ROI</th>
                </tr>
              </thead>
              <tbody>
                {report.transactions.map((t, i) => (
                  <TransactionRow key={t.id} index={i + 1} t={t} />
                ))}
              </tbody>
            </table>
          </div>

          <ul className="muted small report-notes">
            <li>
              Return on capital compares net premium with the capital these trades required. It is not
              your portfolio&rsquo;s return, and the yearly ROI on a short trade is an annualised rate,
              not a forecast.
            </li>
            {report.assigned > 0 && (
              <li>
                {report.assigned} assignment{report.assigned === 1 ? '' : 's'} in this period {report.assigned === 1 ? 'is' : 'are'} not
                counted — the goals panel above includes {report.assigned === 1 ? 'its' : 'their'} loss.
              </li>
            )}
            {totals.capitalMissing > 0 && (
              <li>
                {totals.capitalMissing} trade{totals.capitalMissing === 1 ? ' has' : 's have'} no capital figure (covered calls,
                poor man&rsquo;s covered calls, or a spread missing its long strike) and {totals.capitalMissing === 1 ? 'is' : 'are'}{' '}
                left out of capital required.
              </li>
            )}
            {report.closesWithoutCost > 0 && (
              <li>
                {report.closesWithoutCost} close{report.closesWithoutCost === 1 ? '' : 's'} in this period {report.closesWithoutCost === 1 ? 'has' : 'have'} no
                cost to close recorded, so {report.closesWithoutCost === 1 ? 'it is' : 'they are'} not listed.
              </li>
            )}
          </ul>
        </>
      )}
    </section>
  );
}

function Tile({ label, value, hint, strong }) {
  return (
    <div className={strong ? 'report-tile strong' : 'report-tile'}>
      <dt>{label}</dt>
      <dd>
        <span className="report-value">{value}</span>
        {hint && <span className="report-hint">{hint}</span>}
      </dd>
    </div>
  );
}

function Group({ title, kind, group, rows }) {
  return (
    <section className={`report-group kind-${kind}`} aria-label={title}>
      <h3>
        <span className="report-count">{group.count}</span> {title}
      </h3>
      <dl className="facts">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {group.symbols.length > 0 && <p className="report-symbols small">{group.symbols.join(' · ')}</p>}
    </section>
  );
}

/**
 * The trade mix as one segmented bar — the share of new, rolled and closed. A bar rather than a
 * pie: three parts of one whole read faster as lengths, and each part carries its count in words.
 */
function TradeMix({ groups, total }) {
  const parts = [
    ['new', 'New', groups.new.count],
    ['roll', 'Rolls', groups.roll.count],
    ['close', 'Closed', groups.close.count],
  ].filter(([, , n]) => n > 0);

  const summary = parts.map(([, label, n]) => `${label} ${n} (${pct(n / total, 0)})`).join(', ');

  return (
    <section className="report-group report-mix" aria-label="Trade mix">
      <h3>
        <span className="report-count">{total}</span> Trade mix
      </h3>
      <div className="mix-bar" role="img" aria-label={`Trade mix: ${summary}`}>
        {parts.map(([kind, label, n]) => (
          <span key={kind} className={`mix-part kind-${kind}`} style={{ flexGrow: n }} title={`${label}: ${n} (${pct(n / total, 0)})`}>
            {n / total >= 0.12 ? pct(n / total, 0) : ''}
          </span>
        ))}
      </div>
      <ul className="legend mix-legend">
        {parts.map(([kind, label, n]) => (
          <li key={kind}>
            <span className={`legend-band kind-${kind}`} /> {label} · {n}
          </li>
        ))}
      </ul>
    </section>
  );
}

function TransactionRow({ index, t }) {
  const p = t.position;
  const spec = POSITION_TYPES[p.type];

  let roll = '—';
  if (t.rolledFrom) roll = `from ${shortDate(t.rolledFrom.expiration)}`;
  else if (t.newLegMissing) roll = t.rolledTo ? `to ${shortDate(t.rolledTo.expiration)} · new leg not recorded` : 'new leg not recorded';

  return (
    <tr className={`kind-row kind-${t.kind}`}>
      <td className="num muted">{index}</td>
      <th scope="row">{p.symbol}</th>
      <td className="nowrap">{shortDate(t.date)}</td>
      <td title={spec?.label}>{p.type}</td>
      <td>
        <span className={`event-tag kind-${t.kind}`}>{KIND_LABELS[t.kind]}</span>
      </td>
      <td className="num">{price(p.shortStrike)}</td>
      <td className="num">{price(p.longStrike)}</td>
      <td className="num">{p.status === 'open' && p.delta != null ? Math.abs(p.delta).toFixed(2) : '—'}</td>
      <td className="nowrap">{shortDate(p.expiration)}</td>
      <td className="small muted nowrap">{roll}</td>
      <td className="num">{signed2(t.premium)}</td>
      <td className="num">{t.capital == null ? '—' : money2(t.capital)}</td>
      <td className="num">{t.yearlyRoi == null ? '—' : pct(t.yearlyRoi, 0)}</td>
    </tr>
  );
}

// Cents matter on a weekly report — $23.06 to close is the figure, not $23.
const money2 = (v) =>
  Number.isFinite(v) ? v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
const signed2 = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${money2(Math.abs(v))}` : '—');

const longDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
