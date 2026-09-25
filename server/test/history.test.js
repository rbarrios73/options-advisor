import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_RANGE, RANGES, intervalFor, isRange, movingAverage, startDateFor, summarizeSeries } from '../src/domain/history.js';

const bar = (date, close, extra = {}) => ({ date, open: close, high: close, low: close, close, volume: 1000, ...extra });

test('each range asks for a sensible window, and YTD is the year, not 365 days', () => {
  const asOf = '2026-09-25';

  assert.equal(startDateFor('1M', asOf), '2026-08-25');
  assert.equal(startDateFor('1Y', asOf), '2025-09-24'); // 366 days back, so a leap year still covers a year
  assert.equal(startDateFor('YTD', asOf), '2026-01-01');
  // 1,827 days back from 2026-09-25 — five years plus the 2024 leap day, plus one.
  assert.equal(startDateFor('5Y', asOf), '2021-09-24');

  // In early January, YTD is days — not a year, which is what a day count would give.
  assert.equal(startDateFor('YTD', '2026-01-05'), '2026-01-01');

  assert.equal(startDateFor('nonsense', asOf), startDateFor(DEFAULT_RANGE, asOf), 'unknown falls back');
});

test('five years is asked for weekly, so the chart is not 1,200 points', () => {
  assert.equal(intervalFor('5Y'), 'weekly');
  for (const r of ['1M', '3M', '6M', 'YTD', '1Y']) assert.equal(intervalFor(r), 'daily', r);
  assert.equal(intervalFor('made up'), 'daily');
});

test('isRange only accepts the ranges the UI offers', () => {
  for (const key of Object.keys(RANGES)) assert.ok(isRange(key), key);
  for (const key of ['', '2M', 'toString', 'constructor', '__proto__']) assert.equal(isRange(key), false, key);
});

test('a summary reports the period change, the extremes, and where they happened', () => {
  const s = summarizeSeries([
    bar('2026-01-02', 100),
    bar('2026-01-03', 110, { high: 112 }),
    bar('2026-01-06', 90, { low: 88 }),
    bar('2026-01-07', 105),
  ]);

  assert.equal(s.points, 4);
  assert.equal(s.first.close, 100);
  assert.equal(s.last.close, 105);
  assert.equal(s.change, 5);
  assert.equal(s.changePct, 0.05);
  assert.deepEqual(s.high, { date: '2026-01-03', price: 112 }, 'the intraday high, not the close');
  assert.deepEqual(s.low, { date: '2026-01-06', price: 88 });
  assert.equal(s.averageVolume, 1000);
});

test('a summary drops unusable bars and reports nothing at all for an empty series', () => {
  assert.equal(summarizeSeries([]), null);
  assert.equal(summarizeSeries(null), null);
  assert.equal(summarizeSeries([{ date: 'x', close: null }, { date: 'y', close: 0 }]), null);

  const s = summarizeSeries([bar('2026-01-02', 100), { date: '2026-01-03', close: null }, bar('2026-01-04', 120)]);
  assert.equal(s.points, 2, 'the hole is skipped, not charted as zero');
  assert.equal(s.change, 20);
});

test('the moving average lines up with its bars, with nulls before it has enough history', () => {
  const bars = [10, 12, 14, 16, 18].map((c, i) => bar(`2026-01-0${i + 1}`, c));
  const ma = movingAverage(bars, 3);

  assert.equal(ma.length, bars.length, 'same indices as the bars, so the chart cannot shift it');
  assert.deepEqual(ma.slice(0, 2), [null, null]);
  assert.equal(ma[2], 12); // (10+12+14)/3
  assert.equal(ma[3], 14);
  assert.equal(ma[4], 16);

  assert.deepEqual(movingAverage(bars, 50), new Array(5).fill(null), 'not enough history is all nulls');
  assert.deepEqual(movingAverage(bars, 1), new Array(5).fill(null), 'a 1-period average is just the price');
});
