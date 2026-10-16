// The pre-market brief: what is worth knowing about your own book before the bell.
//
// THE DIVISION OF LABOUR HERE IS THE WHOLE POINT. Everything that decides what matters is in this
// file, in code, and is tested: a breached strike, a week to expiry, earnings inside the life of a
// contract, an ex-dividend date in front of a short call, a watchlist name that moved more than it
// usually does. The model's only job is to turn that list into four sentences someone will read at
// 9am. It is given the findings and nothing else, it is told not to add a number that is not in
// them, and the brief is still produced — as a plain list — when there is no model at all.
//
// That ordering is deliberate. A model asked to "look at my positions and tell me what matters"
// would be fluent about whatever it happened to notice, and would be just as fluent on the morning
// it noticed nothing. Detection in code fails loudly; detection in prose fails silently.
//
// Pure, so the browser renders the same findings the server stored.

import { POSITION_TYPES } from './positions.js';

/**
 * Nine in the morning, New York.
 *
 * The zone is the market's, not the server's and not the reader's: "before the open" is a fact
 * about the exchange, and a brief that arrives at 9am Oregon time is a brief that arrives three
 * hours after the bell. Intl carries the daylight-saving rules, so this needs no library and no
 * twice-yearly correction.
 */
export const MARKET_ZONE = 'America/New_York';
export const BRIEF_HOUR = 9;

/** A position inside this many days of expiry is worth a line. */
export const SOON_DAYS = 7;

/**
 * How much bigger than its own normal day a move has to be before it is a finding.
 *
 * Measured against the symbol's own recent range rather than a flat percentage, so a 2% day in
 * a long-bond ETF is flagged and a 2% day in a high-beta name is not. The floor stops a symbol
 * that has barely moved in months from reporting every twitch as a three-sigma event.
 */
export const MOVE_MULTIPLE = 2.5;
export const MOVE_FLOOR = 0.015;

export const SEVERITIES = ['note', 'watch', 'high'];

/** Why a line is in the brief. The label is what the page prints; the tone drives the border. */
export const REASONS = {
  breached: { label: 'Strike is in the money', severity: 'high' },
  assignment: { label: 'Early assignment likely', severity: 'high' },
  expiring: { label: 'Expiring within the week', severity: 'watch' },
  earnings: { label: 'Earnings before expiry', severity: 'watch' },
  exDividend: { label: 'Goes ex-dividend before expiry', severity: 'watch' },
  moved: { label: 'Moved more than it usually does', severity: 'watch' },
};

// --- what day is it, where it matters ------------------------------------------------------------

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: MARKET_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  weekday: 'short',
});

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Year, month, day, hour and weekday as they read in New York at this instant. */
export function marketParts(date = new Date()) {
  const got = {};
  for (const part of PARTS.formatToParts(date)) got[part.type] = part.value;

  return {
    day: `${got.year}-${got.month}-${got.day}`,
    // "24" rather than "00" is what hour12:false yields at midnight in some runtimes; both mean
    // the same day has just started, and a brief is never due at either.
    hour: Number(got.hour) % 24,
    minute: Number(got.minute),
    weekday: WEEKDAYS[got.weekday],
  };
}

export const isWeekday = (date = new Date()) => {
  const { weekday } = marketParts(date);
  return weekday >= 1 && weekday <= 5;
};

/**
 * The trading day whose brief should exist right now, or null if none does yet.
 *
 * Steps back to the most recent weekday that is already past 9am in New York — so a Saturday
 * shows Friday's brief rather than nothing, and 7am on a Tuesday shows Monday's rather than
 * inventing one for a day that has not started. Null only in the first week of the epoch, which
 * is to say never, but the guard is cheap.
 */
export function dueBriefDay(date = new Date()) {
  for (let back = 0; back < 8; back++) {
    const at = new Date(date.getTime() - back * 86_400_000);
    const { day, hour, weekday } = marketParts(at);

    if (weekday < 1 || weekday > 5) continue;
    if (back === 0 && hour < BRIEF_HOUR) continue;
    return day;
  }
  return null;
}

/** Whether a brief for `day` is the one that should be on screen now. */
export const isCurrentBrief = (day, date = new Date()) => Boolean(day) && day === dueBriefDay(date);

// --- did it move more than it usually does? ------------------------------------------------------

const median = (xs) => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * A typical day for this symbol: the median close-to-close move over the bars given.
 *
 * Median rather than mean, and absolute rather than signed. One earnings gap would drag a mean
 * far enough that the next gap looked ordinary, which is precisely backwards — the measure of a
 * normal day should not be moved by the abnormal ones.
 */
export function typicalMove(bars, { minBars = 20 } = {}) {
  const closes = (bars ?? []).map((b) => Number(b?.close)).filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length < minBars) return null;

  const moves = [];
  for (let i = 1; i < closes.length; i++) moves.push(Math.abs(closes[i] - closes[i - 1]) / closes[i - 1]);

  const typical = median(moves);
  return typical > 0 ? typical : null;
}

/**
 * Today's move, if it is unusual for this symbol. Null when it is not, or when there is not enough
 * history to have an opinion — which is a different thing from "it was a quiet day", and the
 * brief should not claim the second when it means the first.
 */
export function unusualMove(changePct, bars, { multiple = MOVE_MULTIPLE, floor = MOVE_FLOOR } = {}) {
  const move = Number(changePct);
  if (!Number.isFinite(move)) return null;

  const typical = typicalMove(bars);
  if (typical === null) return null;

  const size = Math.abs(move);
  if (size < floor || size < typical * multiple) return null;

  return {
    changePct: round(move, 6),
    typical: round(typical, 6),
    ratio: round(size / typical, 2),
  };
}

const round = (x, dp) => Math.round(x * 10 ** dp) / 10 ** dp;

// --- the findings ---------------------------------------------------------------------------------

/** "SPY 535/530 vertical put credit spread" — what the line is about, in a trader's words. */
export function describePosition(position) {
  const type = POSITION_TYPES[position.type];
  const strikes = [position.shortStrike, position.longStrike].filter((s) => s > 0).join('/');

  return [position.symbol, strikes, type ? type.label.toLowerCase() : position.type]
    .filter(Boolean)
    .join(' ');
}

const worst = (reasons) =>
  reasons.reduce((top, r) => (SEVERITIES.indexOf(r.severity) > SEVERITIES.indexOf(top) ? r.severity : top), 'note');

/**
 * Everything worth a line this morning, one entry per position or symbol.
 *
 * Grouped by subject rather than by rule on purpose: a spread that is both in the money and
 * expiring on Friday is one problem, and reporting it twice under two headings is how a brief
 * stops being four sentences.
 *
 * @param positions  the tracker's rows, already enriched with spot, breach, daysLeft, exDividend
 * @param watchlist  the active list's entries, for earnings dates
 * @param quotes     Map of symbol → quote (for the move)
 * @param histories  Map of symbol → daily bars (for what a normal day looks like)
 */
export function findings({ positions = [], watchlist = [], quotes = new Map(), histories = new Map(), asOf }) {
  const out = [];
  const earningsBySymbol = new Map(watchlist.filter((e) => e?.earnings).map((e) => [e.symbol, e.earnings]));

  for (const position of positions) {
    if (position.status !== 'open') continue;

    const reasons = [];
    const side = POSITION_TYPES[position.type]?.side;

    if (position.breach?.level === 'breached') {
      reasons.push(reason('breached', `${position.symbol} is at ${fmt(position.spot)}, through the ${fmt(position.shortStrike)} ${side === 'call' ? 'call' : 'put'}.`));
    }

    if (Number.isFinite(position.daysLeft) && position.daysLeft >= 0 && position.daysLeft <= SOON_DAYS) {
      reasons.push(
        reason('expiring', position.daysLeft === 0
          ? 'Expires today.'
          : `Expires in ${position.daysLeft} ${position.daysLeft === 1 ? 'day' : 'days'}, on ${position.expiration}.`),
      );
    }

    const earnings = earningsBySymbol.get(position.symbol);
    if (earnings && earnings >= asOf && earnings <= position.expiration) {
      reasons.push(reason('earnings', `Reports on ${earnings}, before this expires on ${position.expiration}.`));
    }

    if (position.exDividend) {
      // Two different findings, not one with a flag: "it goes ex-dividend first" is a date to
      // know, and "the dividend beats the time value" is a position you are probably losing.
      reasons.push(
        position.exDividend.likely
          ? reason('assignment', position.exDividend.text)
          : reason('exDividend', position.exDividend.text),
      );
    }

    if (reasons.length > 0) {
      out.push({
        kind: 'position',
        id: position.id,
        symbol: position.symbol,
        subject: describePosition(position),
        severity: worst(reasons),
        reasons,
      });
    }
  }

  // Watchlist names that moved. Only names you are not already being told about through a
  // position — the same symbol under two headings is the repetition this is meant to avoid.
  const spokenFor = new Set(out.map((f) => f.symbol));

  for (const entry of watchlist) {
    const symbol = entry?.symbol;
    if (!symbol || spokenFor.has(symbol)) continue;

    const quote = quotes.get(symbol);
    const move = unusualMove(quote?.changePct, histories.get(symbol));
    if (!move) continue;

    out.push({
      kind: 'symbol',
      id: symbol,
      symbol,
      subject: symbol,
      severity: 'watch',
      reasons: [
        reason(
          'moved',
          `${move.changePct > 0 ? 'Up' : 'Down'} ${pct(Math.abs(move.changePct))} to ${fmt(quote?.last)}, about ${move.ratio}× its usual day of ${pct(move.typical)}.`,
        ),
      ],
      move,
    });
  }

  return sortFindings(out);
}

const reason = (code, text) => ({ code, label: REASONS[code].label, severity: REASONS[code].severity, text });

/** Worst first, then by how many things are wrong, then alphabetically so the order is stable. */
export function sortFindings(list) {
  return [...list].sort(
    (a, b) =>
      SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) ||
      b.reasons.length - a.reasons.length ||
      a.subject.localeCompare(b.subject),
  );
}

export function countBySeverity(list) {
  const counts = { high: 0, watch: 0, note: 0 };
  for (const f of list) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  return counts;
}

const fmt = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '—');
const pct = (fraction) => `${(fraction * 100).toFixed(1)}%`;

// --- what the model is given, and what it is told ------------------------------------------------

export const BRIEF_SYSTEM = `You write a short pre-market note for one person about their own options positions.

You will be given a list of findings that their software has already computed. Follow these rules exactly:

1. Write AT MOST four sentences. Fewer is better. No preamble, no sign-off, no headings, no bullet points.
2. Use ONLY the findings given. Do not add a price, a date, a percentage or a ticker that is not in them.
3. You have no knowledge of the market, the news, or these companies. You did not look anything up. Do not imply you did.
4. Do not tell the person what to do. Do not suggest rolling, closing, buying or selling. Describe what the findings say and stop.
5. Lead with the most serious finding. If there are several of the same kind, say so in one clause rather than listing each.

If the list is empty, say that nothing was flagged this morning, in one sentence.`;

/**
 * The findings as the model sees them. Compact and flat — one line per finding, its reasons
 * indented — because the model's job is to compress this, not to parse it.
 */
export function briefDigest(list, { asOf } = {}) {
  if (list.length === 0) return `Date: ${asOf}\nFindings: none.`;

  const lines = [`Date: ${asOf}`, `Findings: ${list.length}`, ''];

  for (const f of list) {
    lines.push(`- ${f.subject} [${f.severity}]`);
    for (const r of f.reasons) lines.push(`    ${r.label}: ${r.text}`);
  }

  return lines.join('\n');
}

/**
 * Tickers the summary mentions that are not in the findings.
 *
 * The same check the advisor does, for the same reason: the one failure worth catching is a
 * confident sentence about a symbol nobody fed it. Flagged on screen, never silently removed.
 */
export function ungroundedInBrief(text, list) {
  const known = new Set(list.map((f) => f.symbol));
  const mentioned = String(text ?? '').match(/\b[A-Z]{2,5}\b/g) ?? [];

  // Words that are capitalised in ordinary prose and are not tickers.
  const ignore = new Set(['A', 'I', 'IT', 'IV', 'AM', 'PM', 'ET', 'US', 'THE', 'AND', 'ITM', 'OTM', 'DTE', 'EPS']);

  return [...new Set(mentioned.filter((word) => !known.has(word) && !ignore.has(word)))];
}
