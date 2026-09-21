import { useEffect, useMemo, useState } from 'react';

import {
  addDays,
  createSpread,
  pickPutSpread,
  pnlAt,
  pnlCurve,
  pnlGrid,
  positionGreeks,
  summarize,
} from '@domain/simulate.js';

import { api } from '../api.js';
import { replaceParams } from '../router.js';
import { money, pct, price, shortDate, signed, signedNumber } from '../format.js';
import PayoffChart from '../components/PayoffChart.jsx';
import PnlGrid from '../components/PnlGrid.jsx';

const TARGET_DTE = 35;

/**
 * Put credit spread simulator. Pick the legs off a real chain — by delta or by strike — then move
 * the date and implied vol to see what the position would be worth before expiry.
 *
 * Only the chain comes from the server. Everything else is computed here, in the browser, by the
 * same domain code the screener uses (imported from server/src/domain), so sliders respond
 * instantly and a spread opened from a screener row shows the screener's own numbers.
 */
export default function SimulatorPage({ watchlist, params }) {
  const initialShort = num(params.short);
  const initialLong = num(params.long);

  const [symbol, setSymbol] = useState((params.symbol || watchlist[0]?.symbol || 'SPY').toUpperCase());
  const [symbolDraft, setSymbolDraft] = useState(symbol);

  const [expiryList, setExpiryList] = useState(null);
  const [expiration, setExpiration] = useState(params.exp || null);
  const [chain, setChain] = useState(null);
  const [loading, setLoading] = useState(0);
  const [error, setError] = useState(null);

  // Leg selection.
  const [by, setBy] = useState(initialShort ? 'strike' : 'delta');
  const [shortDelta, setShortDelta] = useState(num(params.delta) ?? 0.2);
  const [shortStrike, setShortStrike] = useState(initialShort);
  const [width, setWidth] = useState(
    num(params.width) ?? (initialShort && initialLong ? initialShort - initialLong : 5),
  );

  // Position.
  const [quantity, setQuantity] = useState(num(params.qty) ?? 1);
  const [pricing, setPricing] = useState('conservative');
  const [fill, setFill] = useState('');

  // What-if.
  const [daysForward, setDaysForward] = useState(0);
  const [ivShift, setIvShift] = useState(0);

  // --- data --------------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    setLoading((n) => n + 1);
    setError(null);

    api
      .expirations(symbol)
      .then((data) => {
        if (cancelled) return;
        setExpiryList(data.expirations);
        // Keep the chosen expiry if this symbol lists it too; otherwise the one nearest ~35 days,
        // where the screener's scoring prefers credit spreads to sit.
        setExpiration((current) =>
          current && data.expirations.some((e) => e.date === current)
            ? current
            : nearestBy(data.expirations, (e) => Math.abs(e.dte - TARGET_DTE))?.date ?? null,
        );
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading((n) => n - 1));

    return () => {
      cancelled = true;
    };
  }, [symbol]);

  useEffect(() => {
    if (!expiration) return undefined;
    let cancelled = false;
    setLoading((n) => n + 1);
    setError(null);

    api
      .chain(symbol, expiration)
      .then((data) => !cancelled && setChain(data))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading((n) => n - 1));

    return () => {
      cancelled = true;
    };
  }, [symbol, expiration]);

  // --- the simulation ----------------------------------------------------------------------

  const sim = useMemo(() => {
    if (!chain) return null;

    const years = Math.max(chain.dte, 0.5) / 365;
    const picked = pickPutSpread(chain, { by, shortDelta, shortStrike, width }, { atmIv: chain.atmIv, years });
    if (picked.error) return { error: picked.error };

    const spread = createSpread({
      ...picked,
      spot: chain.spot,
      expiration: chain.expiration,
      asOf: chain.asOf,
      atmIv: chain.atmIv,
      pricing,
      creditOverride: num(fill),
      quantity,
    });

    const d = Math.min(daysForward, spread.dte);

    return {
      picked,
      spread,
      summary: summarize(spread),
      daysForward: d,
      curve: pnlCurve(spread, { daysForward: d, ivShift }),
      greeks: positionGreeks(spread, spread.spot, d, ivShift),
      atSpot: pnlAt(spread, spread.spot, d, ivShift),
      grid: pnlGrid(spread, { rows: 11, columns: 6, ivShift }),
    };
  }, [chain, by, shortDelta, shortStrike, width, pricing, fill, quantity, daysForward, ivShift]);

  // Keep the address bar describing what is on screen, so the page can be bookmarked or shared.
  useEffect(() => {
    if (!sim?.spread) return;
    const base = { symbol, exp: expiration, qty: quantity > 1 ? quantity : undefined };
    replaceParams(
      'simulator',
      by === 'strike'
        ? { ...base, short: sim.spread.short.strike, long: sim.spread.long.strike }
        : { ...base, delta: shortDelta, width },
    );
  }, [sim, symbol, expiration, by, shortDelta, width, quantity]);

  // --- controls ----------------------------------------------------------------------------

  const commitSymbol = () => {
    const clean = symbolDraft.trim().toUpperCase();
    if (/^[A-Z.]{1,6}$/.test(clean) && clean !== symbol) {
      setSymbol(clean);
      setFill('');
    } else {
      setSymbolDraft(symbol);
    }
  };

  // Switching mode starts from the strike currently on screen, so the legs do not jump.
  const switchMode = (next) => {
    if (next === by) return;
    if (next === 'strike' && sim?.spread) setShortStrike(sim.spread.short.strike);
    if (next === 'delta' && sim?.spread?.short.delta != null) {
      setShortDelta(round2(Math.abs(sim.spread.short.delta)));
    }
    setBy(next);
  };

  const putStrikes = useMemo(() => (chain?.options ?? []).map((o) => o.strike), [chain]);

  const widths = useMemo(() => {
    if (!sim?.spread) return [];
    const k = sim.spread.short.strike;
    return putStrikes
      .filter((s) => s < k)
      .map((s) => round2(k - s))
      .sort((a, b) => a - b)
      .slice(0, 16);
  }, [putStrikes, sim]);

  const resetWhatIf = () => {
    setDaysForward(0);
    setIvShift(0);
  };

  // --- render ------------------------------------------------------------------------------

  const s = sim?.summary;
  const spread = sim?.spread;
  const dte = spread?.dte ?? chain?.dte ?? 0;
  const projectedDate = spread ? addDays(spread.asOf, sim.daysForward) : null;
  const projectedLabel = spread
    ? `${sim.daysForward === 0 ? 'Today' : `${shortDate(projectedDate)} · T+${sim.daysForward}`}${
        ivShift ? ` · IV ${signedNumber(ivShift, 0)}` : ''
      }`
    : '';

  return (
    <div className="simulator">
      <p className="muted small page-intro">
        A put credit spread on a real chain: sell a put, buy a cheaper one below it for protection.
        Choose the short put by delta or by strike, then drag the date and IV to see what closing it
        early would look like. Bullish — it profits if the price stays above the break-even.
      </p>

      {/* Inputs, in one row above everything they scope. */}
      <form className="controls" onSubmit={(e) => e.preventDefault()}>
        <label className="control">
          <span>Symbol</span>
          <input
            list="sim-symbols"
            value={symbolDraft}
            onChange={(e) => setSymbolDraft(e.target.value.toUpperCase())}
            onBlur={commitSymbol}
            onKeyDown={(e) => e.key === 'Enter' && commitSymbol()}
            maxLength={6}
            className="w-symbol"
            aria-label="Symbol"
          />
          <datalist id="sim-symbols">
            {watchlist.map((w) => (
              <option key={w.symbol} value={w.symbol} />
            ))}
          </datalist>
        </label>

        <label className="control">
          <span>Expiry</span>
          <select value={expiration ?? ''} onChange={(e) => setExpiration(e.target.value)} disabled={!expiryList}>
            {(expiryList ?? []).map((e) => (
              <option key={e.date} value={e.date}>
                {shortDate(e.date)} · {e.dte}d
              </option>
            ))}
          </select>
        </label>

        <div className="control">
          <span>Short put by</span>
          <div className="segmented" role="radiogroup" aria-label="Choose the short put by">
            {['delta', 'strike'].map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={by === mode}
                className={by === mode ? 'on' : ''}
                onClick={() => switchMode(mode)}
              >
                {mode === 'delta' ? 'Delta' : 'Strike'}
              </button>
            ))}
          </div>
        </div>

        {by === 'delta' ? (
          <label className="control">
            <span>
              Target delta <strong>{shortDelta.toFixed(2)}</strong>
            </span>
            <input
              type="range"
              min="0.05"
              max="0.5"
              step="0.01"
              value={shortDelta}
              onChange={(e) => setShortDelta(Number(e.target.value))}
              className="w-range"
            />
          </label>
        ) : (
          <label className="control">
            <span>Short strike</span>
            <select value={spread?.short.strike ?? ''} onChange={(e) => setShortStrike(Number(e.target.value))}>
              {/* Not the lowest strike: a short put needs a listed put below it to buy. */}
              {putStrikes.slice(1).map((k) => (
                <option key={k} value={k}>
                  {price(k)}
                  {chain && k >= chain.spot ? ' (ITM)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="control">
          <span>Width</span>
          <select value={spread ? round2(spread.width) : width} onChange={(e) => setWidth(Number(e.target.value))}>
            {widths.map((w) => (
              <option key={w} value={w}>
                {price(w)}
              </option>
            ))}
          </select>
        </label>

        <label className="control">
          <span>Contracts</span>
          <input
            type="number"
            min="1"
            max="100"
            value={quantity}
            onChange={(e) => setQuantity(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
            className="w-qty"
          />
        </label>

        <div className="control">
          <span>Entry price</span>
          <div className="segmented" role="radiogroup" aria-label="Entry price">
            {[
              ['conservative', 'Bid/ask'],
              ['mid', 'Mid'],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={pricing === key && !fill}
                className={pricing === key && !fill ? 'on' : ''}
                onClick={() => {
                  setPricing(key);
                  setFill('');
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <label className="control">
          <span>Or your fill</span>
          <input
            type="number"
            step="0.01"
            min="0"
            placeholder={s ? price(s.creditConservative) : ''}
            value={fill}
            onChange={(e) => setFill(e.target.value)}
            className="w-qty"
            title="The credit per share you were actually filled at — overrides the entry price"
          />
        </label>
      </form>

      {error && <p className="error">{error}</p>}
      {sim?.error && <p className="error">{sim.error}</p>}
      {sim?.picked?.note && <p className="warning small">{sim.picked.note}</p>}
      {!chain && !error && <p className="muted">Loading the chain…</p>}

      {spread && (
        // Refetch keeps the frame: while a new chain loads, the old render stays, dimmed.
        <div className={loading > 0 ? 'sim-body stale' : 'sim-body'}>
          <div className="sim-main">
            <section className="panel chart-panel">
              <div className="chart-head">
                <h2>
                  {chain.symbol} {price(spread.short.strike)}/{price(spread.long.strike)} put spread ·{' '}
                  {shortDate(spread.expiration)}
                </h2>
                <span className="muted small">
                  {chain.symbol} {price(chain.spot)} · ATM IV {pct(chain.atmIv)} · {dte} days
                </span>
              </div>

              <PayoffChart
                curve={sim.curve}
                spot={spread.spot}
                shortStrike={spread.short.strike}
                longStrike={spread.long.strike}
                breakEven={s.breakEven}
                sigma={s.expectedMove}
                projectedLabel={projectedLabel}
                projectedIsExpiry={sim.daysForward >= dte}
              />

              <div className="whatif">
                <label className="control grow">
                  <span>
                    Date <strong>{sim.daysForward === 0 ? 'Today' : shortDate(projectedDate)}</strong>{' '}
                    <span className="muted">
                      T+{sim.daysForward} · {dte - sim.daysForward} days left
                    </span>
                  </span>
                  <input
                    type="range"
                    min="0"
                    max={dte}
                    step="1"
                    value={sim.daysForward}
                    onChange={(e) => setDaysForward(Number(e.target.value))}
                  />
                </label>

                <label className="control grow">
                  <span>
                    IV change <strong>{signedNumber(ivShift, 0)} pts</strong>{' '}
                    <span className="muted">
                      short leg {pct(spread.short.iv)} → {pct(Math.max(spread.short.iv + ivShift / 100, 0.01))}
                    </span>
                  </span>
                  <input
                    type="range"
                    min="-20"
                    max="20"
                    step="1"
                    value={ivShift}
                    onChange={(e) => setIvShift(Number(e.target.value))}
                  />
                </label>

                <button type="button" onClick={resetWhatIf} disabled={!sim.daysForward && !ivShift}>
                  Reset
                </button>
              </div>
            </section>

            <section className="panel">
              <h2>Legs</h2>
              {/* Nine columns do not fit a phone; scroll the table, not the page. */}
              <div className="scroll-x">
              <table className="legs">
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Strike</th>
                    <th>Bid</th>
                    <th>Ask</th>
                    <th>Mid</th>
                    <th>Delta</th>
                    <th>IV</th>
                    <th>OI</th>
                    <th>Vol</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ['sell', spread.short],
                    ['buy', spread.long],
                  ].map(([action, leg]) => (
                    <tr key={action} className={action}>
                      <td>
                        {action} {quantity} put
                      </td>
                      <td>{price(leg.strike)}</td>
                      <td>{price(leg.bid)}</td>
                      <td>{price(leg.ask)}</td>
                      <td>{price((leg.bid + leg.ask) / 2)}</td>
                      <td>{leg.delta == null ? '—' : leg.delta.toFixed(3)}</td>
                      <td>{pct(leg.iv)}</td>
                      <td>{leg.openInterest ?? '—'}</td>
                      <td>{leg.volume ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </section>

            <section className="panel">
              <h2>P&amp;L by price and date</h2>
              <PnlGrid grid={sim.grid} />
            </section>
          </div>

          <aside className="sim-side">
            <section className="panel">
              <div className="tiles">
                <Tile label="Max profit" value={money(s.maxProfit)} tone="pos" />
                <Tile label="Max loss" value={money(-s.maxLoss)} tone="neg" />
                <Tile label="Return on risk" value={pct(s.returnOnRisk)} />
              </div>

              {s.warnings.map((w) => (
                <p key={w} className="warning small">
                  {w}
                </p>
              ))}

              <dl className="facts">
                <Fact
                  label="Credit"
                  value={`${price(s.credit)} /sh`}
                  hint={
                    spread.entry.source === 'override'
                      ? 'your fill'
                      : spread.entry.source === 'mid'
                        ? `mid — bid/ask gives ${price(s.creditConservative)}`
                        : `bid/ask — mid would be ${price(s.creditMid)}`
                  }
                />
                <Fact label="Break-even at expiry" value={price(s.breakEven)} hint={`${signedPctText(s.breakEven / spread.spot - 1)} from spot`} />
                <Fact label="Win probability" value={pct(s.probProfit)} hint="finishes above break-even" />
                <Fact label="Keep the full credit" value={pct(s.probMaxProfit)} hint="finishes above short strike" />
                <Fact label="Lose the maximum" value={pct(s.probMaxLoss)} hint="finishes below long strike" />
                <Fact label="Expected value" value={signed(s.expectedValue)} hint="two-outcome, like the screener" />
                <Fact label="Expected move by expiry" value={`±${price(s.expectedMove)}`} hint="one standard deviation" />
              </dl>
            </section>

            <section className="panel">
              <h2>{sim.daysForward === 0 && !ivShift ? 'Right now' : projectedLabel}</h2>
              <dl className="facts">
                <Fact
                  label={`P&L if ${chain.symbol} is unchanged`}
                  value={<span className={sim.atSpot >= 0 ? 'pos' : 'neg'}>{signed(Math.round(sim.atSpot))}</span>}
                  hint={`closing at ${price(spread.spot)}`}
                />
                <Fact label="Delta" value={signedNumber(sim.greeks.delta, 1)} hint="$ per $1 move up" />
                <Fact label="Theta" value={signedNumber(sim.greeks.theta, 2)} hint="$ per day" />
                <Fact label="Vega" value={signedNumber(sim.greeks.vega, 2)} hint="$ per IV point" />
                <Fact label="Gamma" value={signedNumber(sim.greeks.gamma, 3)} hint="delta change per $1" />
              </dl>
              {sim.daysForward === 0 && !ivShift && sim.atSpot < 0 && (
                <p className="muted small">
                  Negative on day one is expected: you sold at the bid and bought at the ask, and the
                  position is marked at its model value in between.
                </p>
              )}
            </section>

            <p className="muted small">
              Before expiry these are Black-Scholes values from each leg&rsquo;s own IV, so they are
              only as good as that vol. Dividends are ignored, and listed options are American — a
              deep in-the-money short put can be assigned early, which this model cannot show.
            </p>
          </aside>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, tone }) {
  return (
    <div className="tile">
      <span className={`tile-value ${tone ?? ''}`}>{value}</span>
      <span className="tile-label">{label}</span>
    </div>
  );
}

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

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function nearestBy(items, distance) {
  let best = null;
  for (const item of items) if (best === null || distance(item) < distance(best)) best = item;
  return best;
}

const round2 = (x) => Math.round(x * 100) / 100;
const signedPctText = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%` : '—');
