import { useEffect, useMemo, useState } from 'react';

import {
  addDays,
  breakEvens,
  createLongOption,
  createSpread,
  isCreditStrategy,
  pickLongOption,
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
 * What each strategy needs from the controls, and how to describe it. Keeping the differences in
 * one table rather than scattered through the JSX is what stops a fourth strategy turning the
 * page into a thicket of conditionals.
 */
const STRATEGIES = {
  put_credit_spread: {
    label: 'Put credit spread',
    side: 'put',
    legs: 2,
    defaultDelta: 0.2,
    deltaRange: [0.05, 0.5],
    strikeLabel: 'Short strike',
    deltaLabel: 'Short put delta',
    entryLabels: [['conservative', 'Bid/ask'], ['mid', 'Mid']],
    blurb:
      'Sell a put, buy a cheaper one below it for protection. Bullish and defined-risk: you keep ' +
      'the credit if the price stays above the break-even, and the width caps what you can lose.',
  },
  long_call: {
    label: 'Long call',
    side: 'call',
    legs: 1,
    defaultDelta: 0.4,
    deltaRange: [0.05, 0.85],
    strikeLabel: 'Strike',
    deltaLabel: 'Delta',
    entryLabels: [['conservative', 'Ask'], ['mid', 'Mid']],
    blurb:
      'Buy a call. Bullish, and the most you can lose is what you paid — but time decay works ' +
      'against you every day, and the price has to clear the break-even before any of it is profit.',
  },
  long_put: {
    label: 'Long put',
    side: 'put',
    legs: 1,
    defaultDelta: 0.4,
    deltaRange: [0.05, 0.85],
    strikeLabel: 'Strike',
    deltaLabel: 'Delta',
    entryLabels: [['conservative', 'Ask'], ['mid', 'Mid']],
    blurb:
      'Buy a put. Bearish, and the most you can lose is what you paid. The same time decay ' +
      'applies: the price has to fall past the break-even before any of it is profit.',
  },
};

/**
 * The simulator. Pick a position off a real chain — by delta or by strike — then move the date and
 * implied vol to see what it would be worth before expiry.
 *
 * Only the chain comes from the server. Everything else is computed here, in the browser, by the
 * same domain code the screener uses (imported from server/src/domain), so sliders respond
 * instantly and a position opened from a screener row shows the screener's own numbers.
 */
export default function SimulatorPage({ watchlist, params }) {
  const initialKind = STRATEGIES[params.kind] ? params.kind : 'put_credit_spread';
  const initialStrike = num(params.short) ?? num(params.strike);
  const initialLong = num(params.long);

  const [kind, setKind] = useState(initialKind);
  const strategy = STRATEGIES[kind];

  const [symbol, setSymbol] = useState((params.symbol || watchlist[0]?.symbol || 'SPY').toUpperCase());
  const [symbolDraft, setSymbolDraft] = useState(symbol);

  const [expiryList, setExpiryList] = useState(null);
  const [expiration, setExpiration] = useState(params.exp || null);
  const [chain, setChain] = useState(null);
  const [loading, setLoading] = useState(0);
  const [error, setError] = useState(null);

  // Leg selection. One delta and one strike, whichever the strategy uses them for.
  const [by, setBy] = useState(initialStrike ? 'strike' : 'delta');
  const [targetDelta, setTargetDelta] = useState(num(params.delta) ?? STRATEGIES[initialKind].defaultDelta);
  const [strike, setStrike] = useState(initialStrike);
  const [width, setWidth] = useState(
    num(params.width) ?? (initialStrike && initialLong ? initialStrike - initialLong : 5),
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

    // Both sides of the chain come back in one request, so switching strategy is instant and
    // costs nothing against the provider's rate limit.
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
    const picking = { atmIv: chain.atmIv, years };
    const common = {
      spot: chain.spot,
      expiration: chain.expiration,
      asOf: chain.asOf,
      atmIv: chain.atmIv,
      pricing,
      quantity,
      // The box takes a positive number; on a debit strategy that number is what you paid, which
      // is a negative net. Getting this sign wrong would flip the whole P&L.
      netOverride: num(fill) == null ? null : isCreditStrategy({ kind }) ? num(fill) : -num(fill),
    };

    let picked;
    let position;

    if (kind === 'put_credit_spread') {
      picked = pickPutSpread(chain, { by, shortDelta: targetDelta, shortStrike: strike, width }, picking);
      if (picked.error) return { error: picked.error };
      position = createSpread({ shortLeg: picked.shortLeg, longLeg: picked.longLeg, ...common });
    } else {
      const type = strategy.side;
      picked = pickLongOption(chain, { type, by, delta: targetDelta, strike }, picking);
      if (picked.error) return { error: picked.error };
      position = createLongOption({ leg: picked.legs[0], type, ...common });
    }

    const d = Math.min(daysForward, position.dte);

    return {
      picked,
      position,
      summary: summarize(position),
      daysForward: d,
      curve: pnlCurve(position, { daysForward: d, ivShift }),
      greeks: positionGreeks(position, position.spot, d, ivShift),
      atSpot: pnlAt(position, position.spot, d, ivShift),
      grid: pnlGrid(position, { rows: 11, columns: 6, ivShift }),
    };
  }, [chain, kind, strategy, by, targetDelta, strike, width, pricing, fill, quantity, daysForward, ivShift]);

  // Keep the address bar describing what is on screen, so the page can be bookmarked or shared.
  useEffect(() => {
    if (!sim?.position) return;
    const p = sim.position;
    const base = { kind, symbol, exp: expiration, qty: quantity > 1 ? quantity : undefined };

    if (by === 'delta') {
      replaceParams('simulator', { ...base, delta: targetDelta, width: p.width ?? undefined });
    } else if (kind === 'put_credit_spread') {
      replaceParams('simulator', { ...base, short: p.short.strike, long: p.long.strike });
    } else {
      replaceParams('simulator', { ...base, strike: p.legs[0].strike });
    }
  }, [sim, kind, symbol, expiration, by, targetDelta, width, quantity]);

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

  /**
   * Switching strategy resets the leg choice rather than carrying it across: a 0.20-delta short
   * put and a 0.20-delta long call are not the same trade, and a strike from the put side may not
   * even be listed on the call side.
   */
  const switchStrategy = (next) => {
    if (next === kind) return;
    setKind(next);
    setTargetDelta(STRATEGIES[next].defaultDelta);
    setStrike(null);
    setBy('delta');
    setFill('');
  };

  // Switching mode starts from the strike currently on screen, so the legs do not jump.
  const switchMode = (next) => {
    if (next === by || !sim?.position) return;
    const leading = kind === 'put_credit_spread' ? sim.position.short : sim.position.legs[0];

    if (next === 'strike') setStrike(leading.strike);
    if (next === 'delta' && leading.delta != null) setTargetDelta(round2(Math.abs(leading.delta)));
    setBy(next);
  };

  const strikes = useMemo(
    () => (chain?.options ?? []).filter((o) => o.type === strategy.side).map((o) => o.strike),
    [chain, strategy.side],
  );

  const widths = useMemo(() => {
    if (kind !== 'put_credit_spread' || !sim?.position?.short) return [];
    const k = sim.position.short.strike;
    return strikes
      .filter((s) => s < k)
      .map((s) => round2(k - s))
      .sort((a, b) => a - b)
      .slice(0, 16);
  }, [strikes, sim, kind]);

  const resetWhatIf = () => {
    setDaysForward(0);
    setIvShift(0);
  };

  // --- render ------------------------------------------------------------------------------

  const s = sim?.summary;
  const position = sim?.position;
  const dte = position?.dte ?? chain?.dte ?? 0;
  const credit = Boolean(position) && isCreditStrategy(position);
  const projectedDate = position ? addDays(position.asOf, sim.daysForward) : null;
  const projectedLabel = position
    ? `${sim.daysForward === 0 ? 'Today' : `${shortDate(projectedDate)} · T+${sim.daysForward}`}${
        ivShift ? ` · IV ${signedNumber(ivShift, 0)}` : ''
      }`
    : '';

  const levels = position
    ? [
        ...position.legs.map((leg, i) => ({
          key: `leg${i}`,
          label:
            position.legs.length > 1 ? (leg.action === 'sell' ? 'Short' : 'Long') : leg.type === 'call' ? 'Call' : 'Put',
          value: leg.strike,
          kind: 'strike',
        })),
        ...breakEvens(position).map((value, i) => ({ key: `be${i}`, label: 'BE', value, kind: 'be' })),
        { key: 'spot', label: 'Spot', value: position.spot, kind: 'spot' },
      ]
    : [];

  return (
    <div className="simulator">
      <p className="muted small page-intro">
        {strategy.blurb} Choose it by delta or by strike, then drag the date and IV to see what
        closing it early would look like.
      </p>

      {/* Inputs, in one row above everything they scope. */}
      <form className="controls" onSubmit={(e) => e.preventDefault()}>
        <div className="control">
          <span>Strategy</span>
          <div className="segmented" role="radiogroup" aria-label="Strategy">
            {Object.entries(STRATEGIES).map(([key, { label }]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={kind === key}
                className={kind === key ? 'on' : ''}
                onClick={() => switchStrategy(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

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
          <span>Choose by</span>
          <div className="segmented" role="radiogroup" aria-label="Choose the contract by">
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
              {strategy.deltaLabel} <strong>{targetDelta.toFixed(2)}</strong>
            </span>
            <input
              type="range"
              min={strategy.deltaRange[0]}
              max={strategy.deltaRange[1]}
              step="0.01"
              value={targetDelta}
              onChange={(e) => setTargetDelta(Number(e.target.value))}
              className="w-range"
            />
          </label>
        ) : (
          <label className="control">
            <span>{strategy.strikeLabel}</span>
            <select
              value={(kind === 'put_credit_spread' ? position?.short.strike : position?.legs[0].strike) ?? ''}
              onChange={(e) => setStrike(Number(e.target.value))}
            >
              {/* On a spread, not the lowest strike: the short put needs a listed put below it. */}
              {(kind === 'put_credit_spread' ? strikes.slice(1) : strikes).map((k) => (
                <option key={k} value={k}>
                  {price(k)}
                  {chain && inTheMoney(strategy.side, k, chain.spot) ? ' (ITM)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}

        {kind === 'put_credit_spread' && (
          <label className="control">
            <span>Width</span>
            <select
              value={position ? round2(position.width) : width}
              onChange={(e) => setWidth(Number(e.target.value))}
            >
              {widths.map((w) => (
                <option key={w} value={w}>
                  {price(w)}
                </option>
              ))}
            </select>
          </label>
        )}

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
            {strategy.entryLabels.map(([key, label]) => (
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
            placeholder={s ? price(Math.abs(s.netConservative)) : ''}
            value={fill}
            onChange={(e) => setFill(e.target.value)}
            className="w-qty"
            title={`The ${credit ? 'credit' : 'debit'} per share you were actually filled at`}
          />
        </label>
      </form>

      {error && <p className="error">{error}</p>}
      {sim?.error && <p className="error">{sim.error}</p>}
      {sim?.picked?.note && <p className="warning small">{sim.picked.note}</p>}
      {!chain && !error && <p className="muted">Loading the chain…</p>}

      {position && (
        // Refetch keeps the frame: while a new chain loads, the old render stays, dimmed.
        <div className={loading > 0 ? 'sim-body stale' : 'sim-body'}>
          <div className="sim-main">
            <section className="panel chart-panel">
              <div className="chart-head">
                <h2>{describe(position, chain)}</h2>
                <span className="muted small">
                  {chain.symbol} {price(chain.spot)} · ATM IV {pct(chain.atmIv)} · {dte} days
                </span>
              </div>

              <PayoffChart
                curve={sim.curve}
                spot={position.spot}
                levels={levels}
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
                      {position.legs.length > 1 ? 'short leg' : 'this contract'} {pct(position.legs[0].iv)} →{' '}
                      {pct(Math.max(position.legs[0].iv + ivShift / 100, 0.01))}
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
              <h2>{position.legs.length > 1 ? 'Legs' : 'Contract'}</h2>
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
                    {position.legs.map((leg) => (
                      <tr key={`${leg.action}-${leg.type}-${leg.strike}`} className={leg.action}>
                        <td>
                          {leg.action} {quantity} {leg.type}
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
                <Tile
                  label="Max profit"
                  value={s.maxProfit === null ? 'No cap' : money(s.maxProfit)}
                  tone="pos"
                  // A long put's maximum is the strike going to zero. True, and misleading as a
                  // headline unless it says so — nobody is pricing SPY at $0.
                  hint={position.kind === 'long_put' ? 'if it goes to zero' : undefined}
                />
                <Tile label="Max loss" value={money(-s.maxLoss)} tone="neg" />
                {credit ? (
                  <Tile label="Return on risk" value={pct(s.returnOnRisk)} />
                ) : (
                  <Tile label="Move to break even" value={movePct(s.breakEven, position.spot)} />
                )}
              </div>

              {s.warnings.map((w) => (
                <p key={w} className="warning small">
                  {w}
                </p>
              ))}

              <dl className="facts">
                <Fact
                  label={credit ? 'Credit' : 'Debit'}
                  value={`${price(credit ? s.credit : s.debit)} /sh`}
                  hint={
                    position.entry.source === 'override'
                      ? 'your fill'
                      : position.entry.source === 'mid'
                        ? `mid — ${credit ? 'bid/ask' : 'the ask'} gives ${price(Math.abs(s.netConservative))}`
                        : `${credit ? 'bid/ask' : 'the ask'} — mid would be ${price(Math.abs(s.netMid))}`
                  }
                />
                <Fact
                  label="Break-even at expiry"
                  value={price(s.breakEven)}
                  hint={`${movePct(s.breakEven, position.spot)} from spot`}
                />
                <Fact
                  label="Win probability"
                  value={pct(s.probProfit)}
                  hint={`finishes ${credit || position.kind === 'long_call' ? 'above' : 'below'} break-even`}
                />
                {credit && (
                  <Fact label="Keep the full credit" value={pct(s.probMaxProfit)} hint="finishes above short strike" />
                )}
                <Fact
                  label={credit ? 'Lose the maximum' : 'Expires worthless'}
                  value={pct(s.probMaxLoss)}
                  hint={
                    credit
                      ? 'finishes below long strike'
                      : `finishes ${position.kind === 'long_call' ? 'below' : 'above'} the strike`
                  }
                />
                {credit && (
                  <Fact label="Expected value" value={signed(s.expectedValue)} hint="two-outcome, like the screener" />
                )}
                <Fact
                  label="Expected move by expiry"
                  value={`±${price(s.expectedMove)}`}
                  hint="one standard deviation"
                />
              </dl>

              {!credit && (
                <p className="muted small">
                  No expected value here: a long option&rsquo;s upside is a distribution, not one of
                  two outcomes, so the screener&rsquo;s crude version would be worse than nothing.
                </p>
              )}
            </section>

            <section className="panel">
              <h2>{sim.daysForward === 0 && !ivShift ? 'Right now' : projectedLabel}</h2>
              <dl className="facts">
                <Fact
                  label={`P&L if ${chain.symbol} is unchanged`}
                  value={<span className={sim.atSpot >= 0 ? 'pos' : 'neg'}>{signed(Math.round(sim.atSpot))}</span>}
                  hint={`closing at ${price(position.spot)}`}
                />
                <Fact label="Delta" value={signedNumber(sim.greeks.delta, 1)} hint="$ per $1 move up" />
                <Fact label="Theta" value={signedNumber(sim.greeks.theta, 2)} hint="$ per day" />
                <Fact label="Vega" value={signedNumber(sim.greeks.vega, 2)} hint="$ per IV point" />
                <Fact label="Gamma" value={signedNumber(sim.greeks.gamma, 3)} hint="delta change per $1" />
              </dl>

              {sim.daysForward === 0 && !ivShift && sim.atSpot < 0 && (
                <p className="muted small">
                  Negative on day one is expected: you {credit ? 'sold at the bid and bought at the ask' : 'paid the ask'},
                  and the position is marked at its model value in between.
                </p>
              )}
            </section>

            <p className="muted small">
              Before expiry these are Black-Scholes values from each leg&rsquo;s own IV, so they are
              only as good as that vol. Dividends are ignored, and listed options are American — an
              option deep in the money can be assigned early, which this model cannot show.
            </p>
          </aside>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, tone, hint }) {
  return (
    <div className="tile">
      <span className={`tile-value ${tone ?? ''}`}>{value}</span>
      <span className="tile-label">
        {label}
        {hint && <span className="tile-hint">{hint}</span>}
      </span>
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

/** "SPY 540/535 put spread · Oct 23" or "SPY 555 call · Oct 23". */
function describe(position, chain) {
  const when = shortDate(position.expiration);

  if (position.legs.length > 1) {
    return `${chain.symbol} ${price(position.short.strike)}/${price(position.long.strike)} put spread · ${when}`;
  }
  const [leg] = position.legs;
  return `${chain.symbol} ${price(leg.strike)} ${leg.type} · ${when}`;
}

const inTheMoney = (side, strike, spot) => (side === 'put' ? strike >= spot : strike <= spot);

function movePct(target, spot) {
  if (!Number.isFinite(target) || !(spot > 0)) return '—';
  const move = target / spot - 1;
  return `${move >= 0 ? '+' : '−'}${Math.abs(move * 100).toFixed(1)}%`;
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
