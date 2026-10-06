// What the language model is allowed to see, and how its answer is checked afterwards.
//
// The model never prices anything. Every number it reads was computed by the screener from a real
// chain — the same `metrics.js` the results table shows — and this file's whole job is to hand it
// those rows compactly and then verify that what came back refers to them.
//
// Pure and synchronous, like everything else in domain/, so the digest is testable without a
// network and identical for the same scan every time.

import { STRATEGY_LABELS } from './strategies.js';

/** How many ranked candidates the model sees. Enough to compare; not so many that it skims. */
export const DIGEST_LIMIT = 25;

/** The longest question worth sending. Past this it is a document, not a question. */
export const MAX_QUESTION = 500;

const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');
const money = (v) => (typeof v === 'number' && Number.isFinite(v) ? `$${Math.round(v)}` : '—');
const num = (v, dp = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(dp) : '—');

/**
 * One candidate as a line of the table the model reads.
 *
 * Deliberately the same fields the results table shows a person. If a number is not on this line
 * the model cannot cite it, and if it is on this line the reader can check it against the screen.
 */
function line(c, index) {
  const legs = c.legs
    .map((l) => `${l.action} ${l.strike} ${l.type}`)
    .join(' / ');

  return [
    `${index + 1}. ${c.symbol} ${STRATEGY_LABELS[c.kind] ?? c.kind} ${c.expiration} (${c.dte}d)`,
    `   legs: ${legs}`,
    `   credit/debit ${num(c.credit)} · width ${c.width == null ? '—' : num(c.width)} · break-even ${num(c.breakEven)} · spot ${num(c.spot)}`,
    `   max profit ${money(c.maxProfit)} · max loss ${money(c.maxLoss)} · return on risk ${pct(c.returnOnRisk)}`,
    `   win probability ${pct(c.probProfit)} · expected value ${money(c.expectedValue)} · liquidity ${num(c.liquidity, 2)}`,
    `   score ${num(c.score, 3)}${c.warnings?.length ? ` · flags: ${c.warnings.join('; ')}` : ''}`,
  ].join('\n');
}

/**
 * The whole prompt payload for one scan: what was scanned, what passed, and the ranked rows.
 *
 * Returns null when there is nothing to talk about, so the caller can refuse before spending a
 * request on "there are no candidates".
 */
export function buildDigest(result, limit = DIGEST_LIMIT) {
  const candidates = (result?.candidates ?? []).slice(0, limit);
  if (candidates.length === 0) return null;

  const symbols = (result.symbols ?? [])
    .map((s) => `${s.symbol} ${num(s.spot)}${s.earnings ? ` (earnings ${s.earnings})` : ''}`)
    .join(', ');

  const filters = result.filters ?? {};

  return [
    `Scan of ${result.asOf}, data from the ${result.provider} provider.`,
    `Watchlist: ${symbols || '—'}`,
    `Filters: ${filters.minDte}–${filters.maxDte} days to expiry, minimum win probability ${pct(filters.minProbProfit)}, minimum return on risk ${pct(filters.minReturnOnRisk)}, maximum width ${filters.maxWidth}.`,
    `${result.totalCandidates} structures passed those filters; the top ${candidates.length} by score follow.`,
    result.failures?.length ? `Symbols that failed: ${result.failures.map((f) => `${f.symbol} (${f.error})`).join(', ')}` : '',
    '',
    ...candidates.map(line),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The instructions that keep the answer tied to the rows.
 *
 * The important ones are the prohibitions. A model asked "what are the best options today" will,
 * left alone, happily discuss companies, earnings and the market — none of which is in front of
 * it, and none of which the reader could check. It may only talk about these rows.
 */
export const SYSTEM_PROMPT = [
  'You are helping someone read the output of their own options screener. They see the same ranked table you do, beside your answer.',
  '',
  'Rules, in order of importance:',
  '1. Discuss ONLY the candidates in the table. Never mention a ticker, strike, expiry or price that is not in it.',
  '2. Never state a number you were not given. Do not estimate, extrapolate or compute new figures beyond simple comparisons of the numbers present.',
  '3. You have no information about the companies, the market, the news, or what any price will do. You have not seen a chart. If asked to predict direction, say plainly that you cannot, and compare what the table shows instead.',
  '4. Do not tell the person what to trade. Lay out the trade-offs between candidates and let them choose. No "I recommend", no "you should buy".',
  '5. Say what the numbers do not capture: an earnings date inside the position, a thin quote, early assignment on an American option, and that probabilities come from one implied-vol snapshot.',
  '',
  'Style: plain prose, short. Name candidates by their number and symbol (e.g. "3, XLF"). Compare on the dimensions the screener computes — win probability, return on risk, expected value, liquidity, days to expiry. Where two candidates are close, say so rather than inventing a winner. If the question cannot be answered from the table, say which part cannot and answer the part that can.',
].join('\n');

/**
 * Checks an answer against the scan it was supposed to be about.
 *
 * Only tickers, because they are the one thing that can be checked exactly: an invented symbol is
 * the failure that matters, since a reader cannot tell it apart from a real row. Returns the
 * ones that look like tickers and are not in the scan, for the page to show as a warning rather
 * than for the server to silently suppress the answer — a flagged answer is more useful than no
 * answer, and more honest than a quiet one.
 */
export function ungroundedSymbols(answer, result) {
  const known = new Set([
    ...(result?.candidates ?? []).map((c) => c.symbol),
    ...(result?.symbols ?? []).map((s) => s.symbol),
    ...(result?.failures ?? []).map((f) => f.symbol),
  ]);

  // Words that are all capitals and ticker-shaped. Common English words that fit (A, I, IT, US)
  // and the vocabulary of this domain (IV, DTE, ROR, P&L) are not symbols and are excluded, or
  // every other sentence would be flagged.
  const ignore = new Set([
    'A', 'I', 'IT', 'US', 'IV', 'DTE', 'ROR', 'EV', 'PL', 'P', 'L', 'OI', 'ATM', 'OTM', 'ITM',
    'AND', 'OR', 'THE', 'IF', 'NO', 'NOT', 'BUT', 'ALL', 'ONE', 'TWO', 'API', 'AI',
  ]);

  const found = new Set();
  for (const [word] of String(answer ?? '').matchAll(/\b[A-Z][A-Z.]{0,5}\b/g)) {
    if (!ignore.has(word) && !known.has(word)) found.add(word);
  }

  return [...found];
}
