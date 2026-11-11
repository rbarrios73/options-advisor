import { useMemo, useState } from 'react';

import { POSITION_TYPES } from '@domain/positions.js';
import { KIND_LABELS, PRESETS, periodReport, presetRange } from '@domain/report.js';

import { pct, price, shortDate } from '../format.js';

import { dateLocale, tr } from '../i18n.js';
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
          <h2 id="results-title">{tr('Trading results')}</h2>
          <p className="muted small report-range">
            {longDate(report.from)} – {longDate(report.to)} · {totals.tradingDays === 1 ? tr('1 trading day') : tr('{0} trading days', [totals.tradingDays])}
          </p>
        </div>

        <form className="report-filter" onSubmit={(e) => e.preventDefault()} aria-label={tr('Date range')}>
          <div className="segmented" role="radiogroup" aria-label={tr('Period')}>
            {Object.entries(PRESETS).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={preset === key}
                className={preset === key ? 'on' : ''}
                onClick={() => choose(key)}
              >
                {tr(label)}
              </button>
            ))}
          </div>
          <label className="field">
            <span>{tr('From')}</span>
            <input type="date" value={range.from} max={today} onChange={setDate('from')} />
          </label>
          <label className="field">
            <span>{tr('To')}</span>
            <input type="date" value={range.to} max={today} onChange={setDate('to')} />
          </label>
        </form>
      </div>

      {totals.count === 0 ? (
        <p className="muted">
          {tr('Nothing opened, rolled or closed between ')}{shortDate(report.from)}{tr(' and ')}{shortDate(report.to)}.
          {report.assigned > 0 && (report.assigned === 1 ? tr(' 1 assignment — not counted here.') : tr(' {0} assignments — not counted here.', [report.assigned]))}
        </p>
      ) : (
        <>
          <dl className="report-tiles">
            <Tile label={tr('Premium collected')} value={money2(totals.collected)} hint={tr('before closes')} />
            <Tile
              label={tr('Cost to close')}
              value={totals.costToClose > 0 ? `−${money2(totals.costToClose)}` : money2(0)}
              hint={(groups.close.count === 1 ? tr('1 trade') : tr('{0} trades', [groups.close.count]))}
            />
            <Tile label={tr('Net premium')} value={money2(totals.net)} hint={tr('after closes')} strong />
            <Tile label={tr('Transactions')} value={String(totals.count)} hint={report.assigned ? tr('assignments not counted') : tr('excludes assignments')} />
            <Tile label={tr('Average per transaction')} value={money2(totals.averagePerTransaction)} hint={tr('net')} />
          </dl>

          <dl className="report-tiles report-tiles-secondary">
            <Tile label={tr('Capital required')} value={money2(totals.capital)} hint={tr('for these trades')} />
            <Tile label={tr('Return on capital')} value={pct(totals.returnOnCapital, 2)} hint={tr('net ÷ capital required')} />
            <Tile label={tr('Per trading day')} value={money2(totals.perDay)} hint={(totals.tradingDays === 1 ? tr('over 1 day') : tr('over {0} days', [totals.tradingDays]))} />
          </dl>

          <div className="report-groups">
            <Group
              title={tr('New positions')}
              kind="new"
              group={groups.new}
              rows={[
                [tr('Total premium'), money2(groups.new.premium)],
                [tr('Average premium'), money2(groups.new.average)],
                [tr('Average yearly ROI'), pct(groups.new.averageYearlyRoi, 0)],
              ]}
            />
            <Group
              title={tr('Rolls')}
              kind="roll"
              group={groups.roll}
              rows={[
                [tr('Total premium'), money2(groups.roll.premium)],
                [tr('Average premium'), money2(groups.roll.average)],
                [tr('Average yearly ROI'), pct(groups.roll.averageYearlyRoi, 0)],
              ]}
            />
            <Group
              title={tr('Closed positions')}
              kind="close"
              group={groups.close}
              rows={[
                [tr('Total cost to close'), groups.close.count ? `−${money2(-groups.close.premium)}` : '—'],
                [tr('Average cost'), groups.close.count ? `−${money2(-groups.close.average)}` : '—'],
              ]}
            />
            <TradeMix groups={groups} total={totals.count} />
          </div>

          <div className="scroll-x">
            <table className="report-table">
              <caption className="muted small">
                {tr('Every transaction from ')}{shortDate(report.from)}{tr(' to ')}{shortDate(report.to)}{tr(', in date order.')}
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="num">#</th>
                  <th scope="col">{tr('Ticker')}</th>
                  <th scope="col">{tr('Date')}</th>
                  <th scope="col">{tr('Type')}</th>
                  <th scope="col">{tr('Event')}</th>
                  <th scope="col" className="num">{tr('Short')}</th>
                  <th scope="col" className="num">{tr('Long')}</th>
                  <th scope="col" className="num">{tr('Delta')}</th>
                  <th scope="col">{tr('Expiry')}</th>
                  <th scope="col">{tr('Roll')}</th>
                  <th scope="col" className="num">{tr('Premium')}</th>
                  <th scope="col" className="num">{tr('Capital')}</th>
                  <th scope="col" className="num">{tr('Yearly ROI')}</th>
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
              {tr('Return on capital compares net premium with the capital these trades required. It is not your portfolio’s return, and the yearly ROI on a short trade is an annualised rate, not a forecast.')}
            </li>
            {report.assigned > 0 && (
              <li>
                {report.assigned === 1
                  ? tr('1 assignment in this period is not counted — the goals panel above includes its loss.')
                  : tr('{0} assignments in this period are not counted — the goals panel above includes their loss.', [report.assigned])}
              </li>
            )}
            {totals.capitalMissing > 0 && (
              <li>
                {totals.capitalMissing === 1
                  ? tr('1 trade has no capital figure (covered calls, poor man’s covered calls, or a spread missing its long strike) and is left out of capital required.')
                  : tr('{0} trades have no capital figure (covered calls, poor man’s covered calls, or a spread missing its long strike) and are left out of capital required.', [totals.capitalMissing])}
              </li>
            )}
            {report.closesWithoutCost > 0 && (
              <li>
                {report.closesWithoutCost === 1
                  ? tr('1 close in this period has no cost to close recorded, so it is not listed.')
                  : tr('{0} closes in this period have no cost to close recorded, so they are not listed.', [report.closesWithoutCost])}
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
    ['new', tr('New'), groups.new.count],
    ['roll', tr('Rolls'), groups.roll.count],
    ['close', tr('Closed##mix'), groups.close.count],
  ].filter(([, , n]) => n > 0);

  const summary = parts.map(([, label, n]) => `${label} ${n} (${pct(n / total, 0)})`).join(', ');

  return (
    <section className="report-group report-mix" aria-label={tr('Trade mix')}>
      <h3>
        <span className="report-count">{total}</span>{tr(' Trade mix')}
      </h3>
      <div className="mix-bar" role="img" aria-label={tr('Trade mix: {0}', [summary])}>
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
  if (t.rolledFrom) roll = tr('from {0}', [shortDate(t.rolledFrom.expiration)]);
  else if (t.newLegMissing) roll = t.rolledTo ? tr('to {0} · new leg not recorded', [shortDate(t.rolledTo.expiration)]) : tr('new leg not recorded');

  return (
    <tr className={`kind-row kind-${t.kind}`}>
      <td className="num muted">{index}</td>
      <th scope="row">{p.symbol}</th>
      <td className="nowrap">{shortDate(t.date)}</td>
      <td title={tr(spec?.label)}>{p.type}</td>
      <td>
        <span className={`event-tag kind-${t.kind}`}>{tr(`${KIND_LABELS[t.kind]}##event`)}</span>
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
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(dateLocale(), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
