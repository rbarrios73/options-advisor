import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIEF_SYSTEM,
  REASONS,
  briefDigest,
  countBySeverity,
  describePosition,
  dueBriefDay,
  findings,
  isWeekday,
  marketParts,
  typicalMove,
  ungroundedInBrief,
  unusualMove,
} from '../src/domain/brief.js';

// Instants named by what they are in New York, which is the only clock this feature has.
const at = (iso) => new Date(iso);

// --- what day is it, where it matters ---------------------------------------------------------

test('the clock is the market’s, not the server’s', () => {
  // 13:30 UTC is 09:30 in New York in summer (EDT, UTC-4) and 08:30 in winter (EST, UTC-5).
  // A brief that used the server's clock would be half an hour late in one and half an hour
  // early in the other, and nobody would notice until November.
  assert.equal(marketParts(at('2026-07-15T13:30:00Z')).hour, 9, 'summer');
  assert.equal(marketParts(at('2026-01-15T13:30:00Z')).hour, 8, 'winter');

  // And the DAY can differ too: 02:00 UTC is still the previous evening in New York.
  assert.equal(marketParts(at('2026-07-16T02:00:00Z')).day, '2026-07-15');
});

test('a brief is due on a weekday once it is past nine, and not before', () => {
  // Wednesday 2026-10-14. 12:30 UTC is 08:30 ET — too early, so the current brief is still
  // Tuesday's rather than a Wednesday one that has not been written.
  assert.equal(dueBriefDay(at('2026-10-14T12:30:00Z')), '2026-10-13');
  assert.equal(dueBriefDay(at('2026-10-14T13:30:00Z')), '2026-10-14', 'nine thirty, so it is due');
  assert.equal(dueBriefDay(at('2026-10-14T23:00:00Z')), '2026-10-14', 'and stays due all evening');
});

test('a weekend shows Friday’s brief rather than nothing', () => {
  // Saturday and Sunday. Opening the app at the weekend should show the last one written, not an
  // empty panel that looks broken.
  assert.equal(dueBriefDay(at('2026-10-17T15:00:00Z')), '2026-10-16', 'Saturday');
  assert.equal(dueBriefDay(at('2026-10-18T15:00:00Z')), '2026-10-16', 'Sunday');

  // And Monday before nine still shows Friday's, not Sunday's — there is no Sunday brief.
  assert.equal(dueBriefDay(at('2026-10-19T12:00:00Z')), '2026-10-16');
  assert.equal(dueBriefDay(at('2026-10-19T14:00:00Z')), '2026-10-19', 'Monday, after the bell');
});

test('weekends are not trading days', () => {
  assert.equal(isWeekday(at('2026-10-16T15:00:00Z')), true, 'Friday');
  assert.equal(isWeekday(at('2026-10-17T15:00:00Z')), false, 'Saturday');
  assert.equal(isWeekday(at('2026-10-18T15:00:00Z')), false, 'Sunday');
});

// --- did it move more than it usually does? ---------------------------------------------------

/** Bars that move by exactly `step` each day, so the median move is knowable. */
const steadyBars = (count, step = 0.01, start = 100) => {
  const bars = [];
  let close = start;
  for (let i = 0; i < count; i++) {
    bars.push({ date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, close: round(close) });
    close *= 1 + (i % 2 ? step : -step);
  }
  return bars;
};
const round = (x) => Math.round(x * 10000) / 10000;

test('a typical day is the median move, so one gap does not redefine normal', () => {
  const bars = steadyBars(40, 0.01);
  assert.ok(Math.abs(typicalMove(bars) - 0.01) < 0.0005, `got ${typicalMove(bars)}`);

  // Drop one 20% day into the middle. A mean would roughly double; the median should barely move,
  // which is the point — the measure of a normal day must not be set by the abnormal ones.
  const withGap = [...bars];
  withGap[20] = { ...withGap[20], close: withGap[20].close * 1.2 };
  assert.ok(Math.abs(typicalMove(withGap) - 0.01) < 0.002, `got ${typicalMove(withGap)}`);
});

test('too little history is not the same as a quiet day', () => {
  // Five bars cannot say what is normal. Returning null makes the brief silent about the symbol;
  // returning 0 would make every move look infinite.
  assert.equal(typicalMove(steadyBars(5)), null);
  assert.equal(unusualMove(0.08, steadyBars(5)), null);
});

test('the threshold is the symbol’s own range, not a flat percentage', () => {
  const quiet = steadyBars(40, 0.004); // a long-bond sort of symbol
  const lively = steadyBars(40, 0.03); // a high-beta sort of symbol

  // The same 2% day: unusual for the first, an ordinary Tuesday for the second. A flat ±3% rule
  // would have said nothing about either.
  assert.ok(unusualMove(-0.02, quiet), 'flagged for the quiet symbol');
  assert.equal(unusualMove(-0.02, lively), null, 'not for the lively one');

  const move = unusualMove(-0.02, quiet);
  assert.ok(move.ratio >= 2.5);
  assert.equal(move.changePct, -0.02);
});

test('a floor stops a becalmed symbol reporting every twitch', () => {
  // Median move of a tenth of a percent: a 0.5% day is five times "normal" and still not news.
  const becalmed = steadyBars(40, 0.001);
  assert.equal(unusualMove(0.005, becalmed), null);
  assert.ok(unusualMove(0.04, becalmed), 'but a real move still lands');
});

// --- the findings -------------------------------------------------------------------------------

const ASOF = '2026-10-14';

const position = (over = {}) => ({
  id: over.id ?? 'p1',
  symbol: 'SPY',
  type: 'VPCS',
  status: 'open',
  shortStrike: 535,
  longStrike: 530,
  expiration: '2026-11-20',
  spot: 552.4,
  daysLeft: 37,
  breach: { level: 'clear' },
  exDividend: null,
  ...over,
});

test('a quiet book produces no findings at all', () => {
  const list = findings({ positions: [position()], watchlist: [{ symbol: 'SPY' }], asOf: ASOF });
  assert.deepEqual(list, []);
});

test('a breached strike is the most serious thing on the page', () => {
  const list = findings({
    positions: [position({ spot: 530.1, breach: { level: 'breached', side: 'put' } })],
    asOf: ASOF,
  });

  assert.equal(list.length, 1);
  assert.equal(list[0].severity, 'high');
  assert.equal(list[0].reasons[0].code, 'breached');
  assert.match(list[0].reasons[0].text, /530\.10.*535\.00 put/);
});

test('one position with three problems is one line, not three', () => {
  // The failure this guards against is a brief that lists the same spread under three headings
  // and stops being four sentences.
  const list = findings({
    positions: [
      position({
        spot: 534,
        breach: { level: 'breached', side: 'put' },
        daysLeft: 3,
        expiration: '2026-10-17',
        exDividend: { exDate: '2026-10-16', likely: false, text: 'Goes ex-dividend 2026-10-16, before this expires.' },
      }),
    ],
    watchlist: [{ symbol: 'SPY', earnings: '2026-10-16' }],
    asOf: ASOF,
  });

  assert.equal(list.length, 1);
  assert.equal(list[0].reasons.length, 4);
  assert.deepEqual(list[0].reasons.map((r) => r.code).sort(), ['breached', 'earnings', 'exDividend', 'expiring']);
  assert.equal(list[0].severity, 'high', 'the worst reason sets the line’s severity');
});

test('expiry inside a week is flagged, outside it is not', () => {
  const inside = findings({ positions: [position({ daysLeft: 7 })], asOf: ASOF });
  const outside = findings({ positions: [position({ daysLeft: 8 })], asOf: ASOF });
  const today = findings({ positions: [position({ daysLeft: 0 })], asOf: ASOF });

  assert.equal(inside.length, 1);
  assert.equal(outside.length, 0);
  assert.match(today[0].reasons[0].text, /Expires today/);
});

test('earnings count only when they fall inside the life of the contract', () => {
  const before = findings({
    positions: [position({ expiration: '2026-11-20' })],
    watchlist: [{ symbol: 'SPY', earnings: '2026-11-05' }],
    asOf: ASOF,
  });
  const after = findings({
    positions: [position({ expiration: '2026-11-20' })],
    watchlist: [{ symbol: 'SPY', earnings: '2026-12-05' }],
    asOf: ASOF,
  });
  const past = findings({
    positions: [position({ expiration: '2026-11-20' })],
    watchlist: [{ symbol: 'SPY', earnings: '2026-10-01' }],
    asOf: ASOF,
  });

  assert.equal(before.length, 1);
  assert.equal(after.length, 0, 'after the expiry is not this position’s problem');
  assert.equal(past.length, 0, 'and neither is one that already happened');
});

test('a likely early assignment outranks a merely upcoming ex-date', () => {
  const possible = findings({
    positions: [position({ type: 'CC', exDividend: { exDate: '2026-10-20', likely: false, text: 'x' } })],
    asOf: ASOF,
  });
  const likely = findings({
    positions: [position({ type: 'CC', exDividend: { exDate: '2026-10-20', likely: true, text: 'y' } })],
    asOf: ASOF,
  });

  assert.equal(possible[0].severity, 'watch');
  assert.equal(possible[0].reasons[0].code, 'exDividend');
  assert.equal(likely[0].severity, 'high');
  assert.equal(likely[0].reasons[0].code, 'assignment');
});

test('closed positions are not in the morning’s brief', () => {
  const list = findings({
    positions: [position({ status: 'closed', spot: 530, breach: { level: 'breached', side: 'put' } })],
    asOf: ASOF,
  });
  assert.deepEqual(list, []);
});

test('a symbol already spoken for by a position is not repeated as a mover', () => {
  const quotes = new Map([['SPY', { last: 530, changePct: -0.04 }]]);
  const histories = new Map([['SPY', steadyBars(40, 0.004)]]);

  const list = findings({
    positions: [position({ spot: 530, breach: { level: 'breached', side: 'put' } })],
    watchlist: [{ symbol: 'SPY' }],
    quotes,
    histories,
    asOf: ASOF,
  });

  assert.equal(list.length, 1, 'one line about SPY, not two');
  assert.equal(list[0].kind, 'position');
});

test('a watchlist name that moved hard gets its own line, with the comparison in it', () => {
  const quotes = new Map([['TLT', { last: 85.2, changePct: -0.025 }]]);
  const histories = new Map([['TLT', steadyBars(40, 0.004)]]);

  const list = findings({ watchlist: [{ symbol: 'TLT' }], quotes, histories, asOf: ASOF });

  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'symbol');
  assert.match(list[0].reasons[0].text, /Down 2\.5%/);
  assert.match(list[0].reasons[0].text, /× its usual day/);
});

test('worst first, and the order is stable', () => {
  const list = findings({
    positions: [
      position({ id: 'a', symbol: 'AAA', daysLeft: 2 }),
      position({ id: 'b', symbol: 'BBB', spot: 530, breach: { level: 'breached', side: 'put' } }),
      position({ id: 'c', symbol: 'CCC', daysLeft: 1 }),
    ],
    asOf: ASOF,
  });

  assert.deepEqual(list.map((f) => f.symbol), ['BBB', 'AAA', 'CCC']);
  assert.deepEqual(countBySeverity(list), { high: 1, watch: 2, note: 0 });
});

test('a position reads as a trader would name it', () => {
  assert.equal(describePosition(position()), 'SPY 535/530 vertical put credit spread');
  assert.equal(describePosition(position({ type: 'CC', longStrike: null })), 'SPY 535 covered call');
});

// --- what the model is given, and what it is told ------------------------------------------------

test('the prompt forbids exactly the things that would make this untrustworthy', () => {
  // Pinned because these are the load-bearing sentences. If one is dropped while reworking the
  // wording, the brief quietly becomes a source of invented numbers and trade suggestions.
  assert.match(BRIEF_SYSTEM, /AT MOST four sentences/);
  assert.match(BRIEF_SYSTEM, /ONLY the findings given/);
  assert.match(BRIEF_SYSTEM, /Do not add a price, a date, a percentage or a ticker that is not in them/);
  assert.match(BRIEF_SYSTEM, /no knowledge of the market/);
  assert.match(BRIEF_SYSTEM, /Do not tell the person what to do/);
});

test('the digest carries every finding and nothing else', () => {
  const list = findings({
    positions: [position({ spot: 530, breach: { level: 'breached', side: 'put' }, daysLeft: 2 })],
    asOf: ASOF,
  });

  const digest = briefDigest(list, { asOf: ASOF });

  assert.match(digest, /Date: 2026-10-14/);
  assert.match(digest, /SPY 535\/530 vertical put credit spread \[high\]/);
  assert.match(digest, /Strike is in the money/);
  assert.match(digest, /Expiring within the week/);
});

test('an empty morning is said plainly rather than left blank', () => {
  assert.match(briefDigest([], { asOf: ASOF }), /Findings: none/);
});

test('a ticker the model was never given is flagged', () => {
  const list = findings({ positions: [position({ daysLeft: 2 })], asOf: ASOF });

  assert.deepEqual(ungroundedInBrief('SPY expires in two days.', list), []);
  assert.deepEqual(ungroundedInBrief('SPY expires soon, and NVDA looks weak.', list), ['NVDA']);

  // Ordinary capitalised prose is not a ticker, and flagging it would train you to ignore the
  // warning — which is worse than not having one.
  assert.deepEqual(ungroundedInBrief('IT is ITM and 2 DTE, US time.', list), []);
});

test('every reason has a label and a severity the page can render', () => {
  for (const [code, { label, severity }] of Object.entries(REASONS)) {
    assert.ok(label && label.length > 3, code);
    assert.ok(['note', 'watch', 'high'].includes(severity), code);
  }
});
