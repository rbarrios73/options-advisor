import { useEffect, useMemo, useState } from 'react';

import { RANGES, DEFAULT_RANGE, isRange, summarizeSeries } from '@domain/history.js';

import { api } from '../api.js';
import { hrefFor, replaceParams } from '../router.js';
import { compact, price as fmtPrice } from '../format.js';
import PriceChart from '../components/PriceChart.jsx';

/**
 * Look up one symbol: what it costs now, and what it has done over a period.
 *
 * The quote and the history are fetched separately and shown separately, because they answer
 * different questions and fail independently — a symbol with no option chain still has a price,
 * and a fresh listing has a price but almost no history.
 */
export default function TickerPage({ watchlist = [], onWatchlist, params }) {
  const [symbol, setSymbol] = useState((params.symbol || watchlist[0]?.symbol || 'SPY').toUpperCase());
  const [typed, setTyped] = useState(symbol);
  const [range, setRange] = useState(isRange(params.range) ? params.range : DEFAULT_RANGE);

  const [quote, setQuote] = useState(null);
  const [bars, setBars] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    replaceParams('ticker', { symbol, range });
  }, [symbol, range]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);

    Promise.all([api.quote(symbol), api.history(symbol, range)])
      .then(([q, h]) => {
        if (!live) return;
        setQuote(q.quote);
        setBars(h.bars);
      })
      .catch((e) => {
        if (!live) return;
        setError(e.message);
        setQuote(null);
        setBars(null);
      })
      .finally(() => live && setLoading(false));

    return () => {
      live = false;
    };
  }, [symbol, range]);

  const series = useMemo(() => summarizeSeries(bars), [bars]);

  const submit = (event) => {
    event.preventDefault();
    const next = typed.trim().toUpperCase();
    if (next) setSymbol(next);
  };

  // The watchlist holds { symbol, note, earnings }, not bare strings — reading it as strings is
  // how the page rendered an object as a React child and blanked itself.
  const listed = watchlist.find((w) => w.symbol === symbol);

  return (
    <div className="ticker-page">
      <div className="page-head">
        <form className="lookup" onSubmit={submit}>
          <label className="sr-only" htmlFor="ticker-symbol">
            Symbol
          </label>
          <input
            id="ticker-symbol"
            className="w-symbol"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="SPY"
            autoComplete="off"
            spellCheck="false"
          />
          <button type="submit" className="primary">
            Look up
          </button>
        </form>

        {watchlist.length > 0 && (
          <nav className="chips" aria-label="Watchlist">
            {watchlist.map((w) => (
              <button
                key={w.symbol}
                type="button"
                className={w.symbol === symbol ? 'chip on' : 'chip'}
                aria-current={w.symbol === symbol ? 'true' : undefined}
                title={w.note || undefined}
                onClick={() => {
                  setTyped(w.symbol);
                  setSymbol(w.symbol);
                }}
              >
                {w.symbol}
              </button>
            ))}
          </nav>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {quote && (
        <header className="quote-head">
          <div>
            <h2 className="quote-symbol">
              {quote.symbol}
              {quote.exchange && <span className="tag">{quote.exchange}</span>}
            </h2>
            {quote.description && <p className="muted small quote-name">{quote.description}</p>}
          </div>

          <div className="quote-price">
            <strong>{fmtPrice(quote.last)}</strong>
            {/* The day's move, labelled as the day's move. The period change sits under the
                chart, where the period is visible — the two differ, and reading one as the
                other is how a flat day looks like a rally. */}
            <span className="quote-change">
              {signedPrice(quote.change)} ({signedPct(quote.changePct)}) today
            </span>
          </div>

          <div className="actions">
            {onWatchlist && (
              <button
                type="button"
                onClick={() =>
                  onWatchlist(
                    listed
                      ? watchlist.filter((w) => w.symbol !== symbol)
                      : [...watchlist, { symbol, note: '', earnings: null }],
                  )
                }
              >
                {listed ? 'Remove from watchlist' : 'Add to watchlist'}
              </button>
            )}
            <a className="button" href={hrefFor('simulator', { symbol })}>
              Open in simulator
            </a>
          </div>
        </header>
      )}

      <div className={loading ? 'ticker-body stale' : 'ticker-body'}>
        <section className="chart-pane">
          <div className="chart-head">
            <div className="segmented" role="group" aria-label="Range">
              {Object.entries(RANGES).map(([key, { label }]) => (
                <button
                  key={key}
                  type="button"
                  className={key === range ? 'on' : undefined}
                  aria-pressed={key === range}
                  onClick={() => setRange(key)}
                >
                  {label}
                </button>
              ))}
            </div>

            {series && (
              <span className="muted small">
                {signedPrice(series.change)} ({signedPct(series.changePct)}) over {RANGES[range].label}
                {' · '}
                {series.points} {intervalNoun(range)}
              </span>
            )}
          </div>

          {series ? (
            <>
              <PriceChart bars={series.bars} rangeLabel={RANGES[range].label} />

              {/* The chart is a picture; this is the same data as text, for anyone the picture
                  does not reach and for anyone who wants the numbers rather than the shape. */}
              <details className="series-table">
                <summary className="muted small">{series.points} closes as a table</summary>
                <div className="scroll-y">
                  <table>
                    <caption className="muted small">
                      {quote?.symbol ?? symbol} closes, {series.first.date} to {series.last.date}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Date</th>
                        <th scope="col" className="num">Close</th>
                        <th scope="col" className="num">Volume</th>
                      </tr>
                    </thead>
                    <tbody>
                      {series.bars.map((b) => (
                        <tr key={b.date}>
                          <th scope="row">{b.date}</th>
                          <td className="num">{fmtPrice(b.close)}</td>
                          <td className="num">{compact(b.volume)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          ) : (
            !loading && !error && <p className="muted">No price history for {symbol}.</p>
          )}
        </section>

        <aside className="stats-pane">
          <h4>Today</h4>
          <dl className="facts">
            <Fact label="Open" value={fmtPrice(quote?.open)} />
            <Fact label="Day range" value={rangeText(quote?.low, quote?.high)} />
            <Fact label="Previous close" value={fmtPrice(quote?.prevClose)} />
            <Fact label="Bid / Ask" value={`${fmtPrice(quote?.bid)} / ${fmtPrice(quote?.ask)}`} />
            <Fact label="Volume" value={compact(quote?.volume)} />
            <Fact label="Average volume" value={compact(quote?.averageVolume)} />
            <Fact label="52-week range" value={rangeText(quote?.week52Low, quote?.week52High)} />
          </dl>

          {series && (
            <>
              <h4>Over {RANGES[range].label}</h4>
              <dl className="facts">
                <Fact label="Period high" value={fmtPrice(series.high.price)} hint={onDate(series.high.date)} />
                <Fact label="Period low" value={fmtPrice(series.low.price)} hint={onDate(series.low.date)} />
                <Fact label="Change" value={`${signedPrice(series.change)} (${signedPct(series.changePct)})`} />
                <Fact label="Average volume" value={compact(series.averageVolume)} />
                <Fact
                  label="Off the high"
                  value={signedPct((series.last.close - series.high.price) / series.high.price)}
                />
              </dl>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

// Same shape as the simulator's fact list, so the two side panels read alike: .facts styles a
// div-wrapped dt/dd pair, and a bare fragment here would quietly lose the row rule.
function Fact({ label, value, hint }) {
  return (
    <div>
      <dt>
        {label}
        {hint && <span className="hint">{hint}</span>}
      </dt>
      <dd>{value}</dd>
    </div>
  );
}

const rangeText = (low, high) =>
  Number.isFinite(low) && Number.isFinite(high) ? `${fmtPrice(low)} – ${fmtPrice(high)}` : '—';

// A dash for a missing value, the same as every other formatter — "+NaN%" reads as a bug. The
// minus is a true minus, as it is on both charts, so "+1.30%" and "−1.30%" are the same width.
const has = (v) => typeof v === 'number' && Number.isFinite(v);

const signedPrice = (v) => (has(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}` : '—');

const signedPct = (v) => (has(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(2)}%` : '—');

/** "22 May 2026" reads as a date at a glance; "2026-05-22" reads as a serial number. */
const onDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

const intervalNoun = (range) => (RANGES[range]?.interval === 'weekly' ? 'weeks' : 'trading days');
