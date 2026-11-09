// Managing a position the simulator has built: is the probability worth showing, what is it worth
// right now against your fill, how exposed is it, what should you be warned about, and what could
// you do instead — close it, roll it, or reshape it.
//
// Pure, like the rest of domain/: the simulator imports it, and every number here comes from the
// position and the chains it was handed. Nothing is fetched and nothing is guessed — where an
// input is missing (no fill, no later expiry, a strike that is not listed) the answer says so
// instead of inventing a figure.

import { mid, probabilityAbove, probabilityBelow, round, spreadPct } from './math.js';
import { expectedMove } from './pricing.js';
import { CONTRACT_MULTIPLIER, createLongOption, createSpread, isCreditStrategy, spreadType, summarize } from './simulate.js';

const DAYS_PER_YEAR = 365;

// --- is the probability worth showing? ----------------------------------------------------------

/** A quote wider than this share of its mid is not a price anyone should model from. */
export const MAX_RELIABLE_SPREAD = 0.35;

/**
 * Whether the win probabilities rest on data good enough to print.
 *
 * They come from implied volatility, which comes from quotes. An empty book, a quote wider than a
 * third of its own price, or an IV the feed could not compute makes the probability a number with
 * nothing under it — so the page shows the reason instead of the number.
 */
export function probabilityReliability(position) {
  const reasons = [];

  if (!(position.atmIv > 0.01 && position.atmIv < 3)) {
    reasons.push('the at-the-money implied volatility is missing or implausible');
  }
  for (const leg of position.legs) {
    const name = `the ${leg.strike} ${leg.type}`;
    if (!(leg.bid > 0) && leg.action === 'sell') reasons.push(`${name} has no bid`);
    if (!(leg.ask > 0)) reasons.push(`${name} has no ask`);
    const width = spreadPct(leg.bid, leg.ask);
    if (leg.bid > 0 && leg.ask > 0 && width > MAX_RELIABLE_SPREAD) {
      reasons.push(`${name}'s quote is ${Math.round(width * 100)}% wide`);
    }
  }
  if (position.dte < 1) reasons.push('it expires today, when the model has nothing left to say');

  return { reliable: reasons.length === 0, reasons };
}

// --- what it is worth now -----------------------------------------------------------------------

/**
 * Profit or loss right now against the fill you entered, at today's quotes.
 *
 * Two prices, as everywhere in this app: what you could actually close at (buy back at the ask,
 * sell at the bid) and the flattering mid. Null when there is no fill to measure from — a quote
 * is not a fill, and P&L against the price you might have got is not your P&L.
 */
export function unrealizedPnl(position) {
  if (position.entry.source !== 'override') return null;

  const m = CONTRACT_MULTIPLIER * position.quantity;
  // Closing reverses each leg: a sold leg is bought back, a bought leg is sold.
  const closeConservative = position.legs.reduce(
    (sum, leg) => sum + (leg.action === 'sell' ? -(leg.ask ?? 0) : leg.bid ?? 0),
    0,
  );
  const closeMid = position.legs.reduce(
    (sum, leg) => sum + (leg.action === 'sell' ? -1 : 1) * (mid(leg.bid, leg.ask) ?? 0),
    0,
  );

  const entry = position.entry.net; // signed: a credit is positive
  const conservative = (entry + closeConservative) * m;
  const atMid = (entry + closeMid) * m;

  const s = summarize(position);
  return {
    conservative: round(conservative),
    mid: round(atMid),
    // Per share, as the closing order would be written: positive is a debit to pay.
    closeCost: round(-closeConservative),
    closeCostMid: round(-closeMid),
    shareOfMaxProfit: s.maxProfit > 0 ? conservative / s.maxProfit : null,
    shareOfMaxLoss: s.maxLoss > 0 ? -conservative / s.maxLoss : null,
  };
}

// --- exposure -----------------------------------------------------------------------------------

/**
 * The greeks restated as exposure — what the position behaves like, in shares and dollars.
 *
 * `greeks` is positionGreeks' answer, already for the whole position: delta in $ per $1, so it is
 * also the share-equivalent; gamma in delta per $1; theta in $ per day; vega in $ per vol point.
 */
export function exposure(position, greeks, summary = summarize(position)) {
  const { spot } = position;
  const onePct = spot * 0.01;
  const move = (dS) => greeks.delta * dS + 0.5 * greeks.gamma * dS * dS;

  // A day's one-sigma move, from the same implied vol the probabilities use.
  const daySigma = expectedMove(spot, position.atmIv, 1 / DAYS_PER_YEAR) ?? 0;

  // Theta measured against what there is to earn or lose: for a credit spread, the credit still
  // to be collected; for a long option, the premium being paid down.
  const thetaBase = isCreditStrategy(position) ? summary.maxProfit : summary.maxLoss;

  return {
    shareEquivalent: round(greeks.delta, 1),
    dollarDelta: round(greeks.delta * spot),
    upOnePct: round(move(onePct)),
    downOnePct: round(move(-onePct)),
    daySigma: round(daySigma),
    oneDayMove: round(Math.max(Math.abs(move(daySigma)), Math.abs(move(-daySigma)))),
    capitalAtRisk: summary.maxLoss,
    thetaShare: thetaBase > 0 ? Math.abs(greeks.theta) / thetaBase : null,
  };
}

// --- risk alerts --------------------------------------------------------------------------------

export const SEVERITY_LABELS = { critical: 'Act now', warning: 'Watch', info: 'Note' };
const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

/**
 * What a trader holding this position should be told, at today's prices.
 *
 * Rules a person would apply by hand, each one stated with the numbers that tripped it. They are
 * prompts, not instructions: "half the credit is in" is a common place to take profits, not an
 * order to.
 */
export function riskAlerts(position, { summary = summarize(position), greeks, unrealized = unrealizedPnl(position), earnings = null, reliability = probabilityReliability(position) } = {}) {
  const alerts = [];
  const add = (severity, title, detail) => alerts.push({ severity, title, detail });
  const { spot, dte } = position;
  const credit = isCreditStrategy(position);
  const pctFrom = (level) => `${Math.abs((level / spot - 1) * 100).toFixed(1)}%`;

  if (credit) {
    const call = spreadType(position) === 'call';
    const { short, long } = position;
    const pastShort = call ? spot >= short.strike : spot <= short.strike;
    const pastLong = call ? spot >= long.strike : spot <= long.strike;
    const pastBreakEven = call ? spot >= summary.breakEven : spot <= summary.breakEven;
    const distance = Math.abs(short.strike - spot);
    const sigma = summary.expectedMove;

    if (pastLong) {
      add('critical', 'Past the long strike', `The price is beyond both strikes. At expiry this is the full ${money(summary.maxLoss)} loss unless it comes back.`);
    } else if (pastShort) {
      add('critical', 'Short strike is in the money', `The price is ${pctFrom(short.strike)} ${call ? 'above' : 'below'} the ${short.strike} short ${short.type}${pastBreakEven ? ', and past the break-even' : ''}.`);
    } else if (sigma > 0 && distance < sigma * 0.5) {
      add('warning', 'Short strike is close', `The ${short.strike} strike is ${pctFrom(short.strike)} away — under half the expected move to expiry (±${sigma.toFixed(2)}).`);
    }

    // Assignment: American options can be exercised early, and an in-the-money short with almost
    // no time value left is the one most likely to be.
    const shortMid = mid(short.bid, short.ask);
    const intrinsic = Math.max(call ? spot - short.strike : short.strike - spot, 0);
    if (intrinsic > 0 && shortMid != null && shortMid - intrinsic < 0.1) {
      add('critical', 'Early assignment risk', `The short ${short.type} is in the money with ${money((shortMid - intrinsic) * 100)} of time value left per contract. Short options like this can be assigned before expiry.`);
    }

    // Pin risk: about to expire with the price sitting on, or between, the strikes — where a few
    // cents at the close decide whether the short leg is assigned and the long leg is not.
    const nearShort = Math.abs(spot - short.strike) / spot < 0.01;
    if (dte <= 2 && !pastLong && (pastShort || nearShort)) {
      add('critical', 'Pin risk', `Expiring with the price ${pastShort ? 'between the strikes' : 'right at the short strike'}: a small move at the close decides whether the short ${short.type} is assigned.`);
    }

    if (unrealized) {
      const credit_ = summary.maxProfit;
      if (unrealized.conservative <= -2 * credit_) {
        add('critical', 'Loss is twice the credit', `Down ${money(-unrealized.conservative)} against a ${money(credit_)} credit — a common point to cut the trade.`);
      } else if (unrealized.shareOfMaxProfit >= 0.5) {
        add('info', 'Half the credit is in', `Closing now keeps ${money(unrealized.conservative)} (${Math.round(unrealized.shareOfMaxProfit * 100)}% of the maximum) with ${dte} days of risk left — a common point to take profits.`);
      }
    }

    if (dte > 7 && dte <= 21) {
      add('info', 'Inside 21 days', 'Gamma rises from here: each move in the price swings the P&L more. Many credit sellers close or roll at this point.');
    }
  } else {
    const [leg] = position.legs;
    const call = leg.type === 'call';
    const otm = call ? spot < leg.strike : spot > leg.strike;

    if (unrealized && unrealized.shareOfMaxLoss >= 0.5) {
      add('warning', 'Half the premium is gone', `Down ${money(-unrealized.conservative)} of the ${money(summary.maxLoss)} paid.`);
    }
    if (otm && dte <= 14) {
      add('warning', 'Out of the money near expiry', `${dte} days left and the ${leg.strike} ${leg.type} is ${pctFrom(leg.strike)} out of the money: time value is running out fastest now.`);
    }
    if (greeks && summary.maxLoss > 0 && Math.abs(greeks.theta) / summary.maxLoss > 0.03) {
      add('warning', 'Fast time decay', `Theta is costing ${money(Math.abs(greeks.theta))} a day — ${(Math.abs(greeks.theta) / summary.maxLoss * 100).toFixed(1)}% of what was paid.`);
    }
  }

  if (dte <= 7 && dte >= 1) {
    add('warning', 'Expiry week', `${dte} day${dte === 1 ? '' : 's'} left${greeks ? `: gamma is ${greeks.gamma.toFixed(3)}, so delta moves fast with the price` : ''}.`);
  }

  if (earnings && earnings >= position.asOf && earnings <= position.expiration) {
    add('warning', 'Earnings before expiry', `${earnings} falls inside this trade. Prices can gap past both strikes overnight, and implied vol usually drops right after.`);
  }

  for (const leg of position.legs) {
    const width = spreadPct(leg.bid, leg.ask);
    if (leg.bid > 0 && leg.ask > 0 && width > 0.15) {
      add('warning', 'Wide quote', `The ${leg.strike} ${leg.type} is ${Math.round(width * 100)}% wide (${leg.bid.toFixed(2)} × ${leg.ask.toFixed(2)}): fills will be poor, and closing costs more than the mid suggests.`);
    }
    if (Number.isFinite(leg.openInterest) && leg.openInterest < 100) {
      add('warning', 'Thin open interest', `Only ${leg.openInterest} contracts open at the ${leg.strike} ${leg.type}. It may be hard to exit at a fair price.`);
    }
  }

  if (!reliability.reliable) {
    add('info', 'Probabilities hidden', `Not shown because ${reliability.reasons.join('; ')}.`);
  }

  for (const w of summary.warnings) add('warning', 'Pricing', w);

  return alerts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

// --- what you could do instead ------------------------------------------------------------------

/**
 * Close, roll and reshape scenarios for the position, priced at today's quotes.
 *
 * `chain` is the position's own expiry (for reshaping it in place); `later` is a list of chains for expiries after this one (the simulator fetches them only when
 * asked). Every scenario carries the per-share net of the whole move — closing the old legs and
 * opening the new ones, conservatively — and the position it leaves you in, so they can be
 * compared on the same terms. A scenario whose strikes are not listed is left out, not faked.
 */
export function adjustmentScenarios(position, { chain = null, later = [] } = {}) {
  const unrealized = unrealizedPnl(position);
  const close = closeNet(position);
  const scenarios = [];

  scenarios.push({
    id: 'close',
    title: 'Close now',
    action: describeClose(position),
    net: round(close),
    cash: round(close * CONTRACT_MULTIPLIER * position.quantity),
    realized: unrealized?.conservative ?? null,
    result: null,
  });

  if (isCreditStrategy(position)) creditScenarios(position, close, later, scenarios);
  else longScenarios(position, close, chain, later, scenarios);

  return scenarios;
}

/** What closing every leg nets per share, conservatively: buy back at the ask, sell at the bid. */
function closeNet(position) {
  return position.legs.reduce((sum, leg) => sum + (leg.action === 'sell' ? -(leg.ask ?? 0) : leg.bid ?? 0), 0);
}

function describeClose(position) {
  return position.legs
    .map((leg, i) => `${leg.action === 'sell' ? (i ? 'buy back' : 'Buy back') : i ? 'sell' : 'Sell'} the ${leg.strike} ${leg.type}`)
    .join(', ');
}

const find = (chain, type, strike) => chain.options.find((o) => o.type === type && o.strike === strike && o.ask > 0);

function baseFor(position, chain) {
  return {
    spot: chain.spot,
    expiration: chain.expiration,
    asOf: chain.asOf,
    atmIv: chain.atmIv,
    pricing: 'conservative',
    quantity: position.quantity,
  };
}

function outcome(next) {
  const s = summarize(next);
  const reliable = probabilityReliability(next).reliable;
  return {
    expiration: next.expiration,
    dte: next.dte,
    maxProfit: s.maxProfit,
    maxLoss: s.maxLoss,
    breakEven: s.breakEven,
    probProfit: reliable ? s.probProfit : null,
    openNet: round(next.entry.net),
  };
}

function creditScenarios(position, close, later, out) {
  const type = spreadType(position);
  const away = type === 'call' ? 1 : -1; // further from the money
  const { short, long, width } = position;

  for (const chain of later) {
    const strikes = [...new Set(chain.options.filter((o) => o.type === type).map((o) => o.strike))].sort((a, b) => a - b);
    const spread = (shortStrike) => {
      const s = find(chain, type, shortStrike);
      const l = find(chain, type, round(shortStrike + away * width, 4));
      if (!s || !l || !(s.bid > 0)) return null;
      return createSpread({ shortLeg: s, longLeg: l, type, ...baseFor(position, chain) });
    };
    const push = (id, title, next, action) => {
      if (!next) return;
      const net = close + next.entry.net;
      out.push({
        id: `${id}:${chain.expiration}`,
        title,
        action,
        net: round(net),
        cash: round(net * CONTRACT_MULTIPLIER * position.quantity),
        result: outcome(next),
        params: { kind: position.kind, exp: chain.expiration, short: next.short.strike, long: next.long.strike, qty: position.quantity > 1 ? position.quantity : undefined, fill: next.entry.net > 0 ? round(next.entry.net) : undefined },
      });
    };
    const when = shortWhen(chain);

    // Same strikes, more time: the plain roll.
    push('out', `Roll out to ${when}`, spread(short.strike), `Close this spread, sell the same ${short.strike}/${long.strike} for ${when}`);

    // One width further from the money: more room, usually for less credit.
    const further = round(short.strike + away * width, 4);
    if (strikes.includes(further)) {
      push('out-away', `Roll out and ${type === 'put' ? 'down' : 'up'} to ${when}`, spread(further), `Close this spread, sell the ${further}/${round(further + away * width, 4)} for ${when}`);
    }

    // The furthest strike that can still be rolled to for a net credit — the usual rule.
    const candidates = strikes
      .filter((k) => (type === 'put' ? k <= short.strike : k >= short.strike))
      .sort((a, b) => (type === 'put' ? a - b : b - a));
    for (const k of candidates) {
      const next = spread(k);
      if (next && close + next.entry.net >= 0) {
        if (k !== short.strike && k !== further) {
          push('credit', `Roll for a credit to ${when}`, next, `The furthest ${short.type} you can roll to for ${when} without paying: ${k}/${round(k + away * width, 4)}`);
        }
        break;
      }
    }
  }
}

function longScenarios(position, close, chain, later, out) {
  const [leg] = position.legs;
  const call = leg.type === 'call';
  const chainNow = { options: chain?.options ?? [] };

  // Into a debit spread: sell an option further out, same expiry, to take money off the table and
  // cap the upside. The simulator does not draw debit spreads, so this one is summarised here.
  if (chainNow.options.length) {
    const target = position.spot * (call ? 1.05 : 0.95);
    const pool = chainNow.options.filter((o) => o.type === leg.type && (call ? o.strike > leg.strike : o.strike < leg.strike) && o.bid > 0);
    const sold = pool.sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target))[0];
    if (sold) {
      const basis = -position.entry.net - sold.bid; // what the spread now costs per share
      const width = Math.abs(sold.strike - leg.strike);
      const breakEven = call ? leg.strike + basis : leg.strike - basis;
      const years = Math.max(position.dte, 0.5) / DAYS_PER_YEAR;
      const m = CONTRACT_MULTIPLIER * position.quantity;
      out.push({
        id: 'vertical',
        title: `Sell the ${sold.strike} ${leg.type} against it`,
        action: `Turns it into a ${leg.strike}/${sold.strike} ${call ? 'bull call' : 'bear put'} spread for ${shortDate(position.expiration)}`,
        net: round(sold.bid),
        cash: round(sold.bid * m),
        result: {
          expiration: position.expiration,
          dte: position.dte,
          maxProfit: round(Math.max(width - basis, 0) * m),
          maxLoss: round(Math.max(basis, 0) * m),
          breakEven: round(breakEven),
          probProfit: probabilityReliability(position).reliable
            ? round(call ? probabilityAbove(position.spot, breakEven, position.atmIv, years) : probabilityBelow(position.spot, breakEven, position.atmIv, years), 4)
            : null,
        },
        params: null,
      });
    }
  }

  for (const chain of later) {
    const when = shortWhen(chain);
    const same = find(chain, leg.type, leg.strike);
    if (same) {
      const next = createLongOption({ leg: same, type: leg.type, ...baseFor(position, chain) });
      const net = close + next.entry.net;
      out.push({
        id: `out:${chain.expiration}`,
        title: `Roll out to ${when}`,
        action: `Sell this ${leg.strike} ${leg.type}, buy the same strike for ${when}`,
        net: round(net),
        cash: round(net * CONTRACT_MULTIPLIER * position.quantity),
        result: outcome(next),
        params: { kind: position.kind, exp: chain.expiration, strike: leg.strike, qty: position.quantity > 1 ? position.quantity : undefined, fill: round(-next.entry.net) },
      });
    }
  }
}

/** Which later expiries to price rolls against: about a week and about a month further out. */
export function rollExpiries(expirations, position) {
  const later = (expirations ?? []).filter((e) => e.date > position.expiration);
  const pick = (target) => later.reduce((best, e) => (!best || Math.abs(e.dte - target) < Math.abs(best.dte - target) ? e : best), null);
  const week = pick(position.dte + 7);
  const month = pick(position.dte + 28);
  return [...new Map([week, month].filter(Boolean).map((e) => [e.date, e])).values()];
}

const money = (v) => `$${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
const shortDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortWhen = (chain) => shortDate(chain.expiration);
