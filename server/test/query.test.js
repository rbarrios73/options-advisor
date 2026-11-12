import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_FILTERS } from '../src/domain/strategies.js';
import {
  QUICK_SCREENS,
  TEMPLATE_GROUPS,
  cleanScreen,
  guestFilters,
  interpretQuery,
  orderCandidates,
  screenRequest,
  withoutCondition,
} from '../src/domain/query.js';

const symbols = ['SPY', 'IWM', 'GLD', 'TLT', 'NVDA', 'ALL'];
const read = (text) => interpretQuery(text, { symbols });
// Each condition also carries where in the sentence it was found; that is tested on its own.
const by = (result) => Object.fromEntries(result.conditions.map(({ id, spans, ...rest }) => [id, rest]));

test('a full sentence becomes one condition per thing it asked for', () => {
  const r = read('Put credit spreads 30 to 45 days out with win probability above 75% and liquid options, highest return first');
  assert.deepEqual(by(r), {
    sort: { key: 'returnOnRisk', dir: 'desc' },
    dte: { min: 30, max: 45, target: 38 },
    minProbProfit: { value: 0.75 },
    minLiquidity: { value: 0.6 },
    strategies: { strategies: ['put_credit_spread'], lean: null },
  });
  assert.deepEqual(r.unread, []);
});

test('the same screen in Spanish reads the same', () => {
  const es = read('Spreads de crédito con puts de 30 a 45 días con probabilidad de ganar mayor a 75% y opciones líquidas, mayor retorno primero');
  const en = read('Put credit spreads 30 to 45 days out with win probability above 75% and liquid options, highest return first');
  assert.deepEqual(by(es), by(en));
  assert.deepEqual(es.unread, []);

  const condor = by(read('cóndores de hierro que vencen esta semana con pérdida máxima menor a $300'));
  assert.deepEqual(condor.strategies.strategies, ['iron_condor']);
  assert.deepEqual(condor.dte, { min: 0, max: 7, target: 4 });
  assert.equal(condor.maxLoss.value, 300);
});

test('a ticker is a condition only when it is on the watchlist', () => {
  const r = read('show me spy and NVDA put spreads under $500 risk, 2 weeks out');
  assert.deepEqual(by(r).symbols, { symbols: ['SPY', 'NVDA'] });
  assert.equal(by(r).maxLoss.value, 500);
  assert.deepEqual(by(r).dte, { min: 9, max: 19, target: 14 });
  assert.deepEqual(r.unread, []);

  const off = read('safe weekly trades on AAPL');
  assert.equal(by(off).symbols, undefined);
  assert.deepEqual(off.notListed, ['AAPL']);

  // ALL is on the list, and is also a word: only capitals make it a ticker.
  assert.equal(by(read('show me all the bullish trades')).symbols, undefined);
  assert.deepEqual(by(read('bullish trades on ALL')).symbols, { symbols: ['ALL'] });
});

test('what it could not read is handed back, not swallowed', () => {
  const r = read('credit spreads with IV rank above 60 and no earnings');
  assert.deepEqual(r.unread, ['iv rank above 60']);
  assert.ok(by(r).avoidEarnings);
});

test('numbers are read with their units, not the neighbouring ones', () => {
  // "75 and 30 days" is a probability and an expiry, not a 30–75 day window.
  const r = by(read('win probability above 75 and 30 days'));
  assert.equal(r.minProbProfit.value, 0.75);
  assert.deepEqual(r.dte, { min: 22, max: 38, target: 30 });

  assert.equal(by(read('20 delta put spreads')).maxShortDelta.value, 0.2);
  assert.equal(by(read('delta under 0.15')).maxShortDelta.value, 0.15);
  assert.deepEqual(by(read('$5 wide spreads')).width, { min: 5, max: 5 });
  assert.equal(by(read('max loss under $1,500')).maxLoss.value, 1500);
  assert.equal(by(read('return on risk above 20%')).minReturnOnRisk.value, 0.2);
  assert.equal(by(read('return on risk above 20%')).maxLoss, undefined, '"risk" in "return on risk" is not a loss limit');
});

test('direction picks the structures, and narrows the ones that were named', () => {
  assert.deepEqual(by(read('bullish trades')).strategies.strategies, ['put_credit_spread', 'long_call']);
  assert.deepEqual(by(read('bearish credit spreads')).strategies.strategies, ['call_credit_spread']);
  assert.deepEqual(by(read('neutral')).strategies.strategies, ['iron_condor']);
});

test('long options get a probability floor they can pass, and it is marked as implied', () => {
  const r = by(read('long calls around 45 days'));
  assert.deepEqual(r.minProbProfit, { value: 0.2, implied: true, forLongs: true });
  // Asked for alongside spreads, or with a probability of its own, nothing is implied.
  assert.equal(by(read('long calls and put credit spreads')).minProbProfit, undefined);
  assert.equal(by(read('long calls with win probability above 40%')).minProbProfit.value, 0.4);
});

test('order and length', () => {
  assert.deepEqual(by(read('lowest max loss first')).sort, { key: 'maxLoss', dir: 'asc' });
  assert.deepEqual(by(read('sorted by expected value')).sort, { key: 'expectedValue', dir: 'desc' });
  const top = by(read('top 10 by win probability'));
  assert.equal(top.limit.value, 10);
  assert.deepEqual(top.sort, { key: 'probProfit', dir: 'desc' });
});

test('every template and quick screen is read in full', () => {
  const all = [...TEMPLATE_GROUPS.flatMap((g) => g.templates.map((t) => t.query)), ...QUICK_SCREENS.map(([, q]) => q)];
  for (const query of all) {
    const r = read(query);
    assert.ok(r.conditions.length > 0, query);
    assert.deepEqual(r.unread, [], query);
  }
});

test('conditions become a filter patch, a symbol list and the screen extras', () => {
  const { conditions } = read('SPY put credit spreads 30 to 45 days out, no earnings, top 5 by return');
  assert.deepEqual(screenRequest(conditions), {
    symbols: ['SPY'],
    filters: { minDte: 30, maxDte: 45, targetDte: 38, strategies: ['put_credit_spread'] },
    screen: { limit: 5, sort: { key: 'returnOnRisk', dir: 'desc' }, avoidEarnings: true },
  });
  assert.deepEqual(screenRequest([]), { symbols: null, filters: {}, screen: {} });
});

test("a visitor's query cannot widen what the scan fetches", () => {
  const base = DEFAULT_FILTERS; // 7–60 days, 4 expiries
  const wide = guestFilters(base, { minDte: 0, maxDte: 400, targetDte: 300, maxExpirations: 40, minProbProfit: 0.2 });
  assert.equal(wide.minDte, 7);
  assert.equal(wide.maxDte, 60);
  assert.equal(wide.targetDte, 60);
  assert.equal(wide.maxExpirations, base.maxExpirations);
  assert.equal(wide.minProbProfit, 0.2, 'thresholds are free: they cost no requests');

  const narrow = guestFilters(base, { minDte: 30, maxDte: 45, strategies: ['iron_condor', 'nonsense'] });
  assert.deepEqual([narrow.minDte, narrow.maxDte, narrow.strategies], [30, 45, ['iron_condor']]);
  assert.deepEqual(guestFilters(base, {}), base);
});

test('the screen extras are cleaned before they are trusted', () => {
  assert.deepEqual(cleanScreen({ avoidEarnings: 'yes', sort: { key: 'constructor', dir: 'asc' }, limit: 5000 }), { limit: 60 });
  assert.deepEqual(cleanScreen({ avoidEarnings: true, sort: { key: 'maxLoss', dir: 'asc' }, limit: 5 }), {
    avoidEarnings: true,
    sort: { key: 'maxLoss', dir: 'asc' },
    limit: 5,
  });
  assert.deepEqual(cleanScreen(undefined), {});
});

test('ordering puts missing values last and breaks ties on the score', () => {
  const rows = [
    { id: 'a', score: 0.5, expectedValue: 10 },
    { id: 'b', score: 0.9, expectedValue: null },
    { id: 'c', score: 0.7, expectedValue: 10 },
    { id: 'd', score: 0.1, expectedValue: 30 },
  ];
  assert.deepEqual(orderCandidates(rows, { key: 'expectedValue', dir: 'desc' }).map((r) => r.id), ['d', 'c', 'a', 'b']);
  assert.deepEqual(orderCandidates(rows, { key: 'expectedValue', dir: 'asc' }, 2).map((r) => r.id), ['c', 'a']);
  assert.deepEqual(orderCandidates(rows, null).map((r) => r.id), ['b', 'c', 'a', 'd']);
});

test('the Spanish wording of every template and quick screen means what the English does', async () => {
  // The translations live with the web app; this is the one place they are checked against the
  // reader, because a translated query that reads differently would run a different screen.
  const { esExtra } = await import('../../web/src/i18n.es.extra.js');
  const all = [...TEMPLATE_GROUPS.flatMap((g) => g.templates.map((t) => t.query)), ...QUICK_SCREENS.map(([, q]) => q)];
  const followUps = ['win probability above 75%', 'no earnings before expiry', 'max loss under $300', 'very liquid options', 'around 30 days'];

  for (const query of [...all, ...followUps]) {
    const spanish = esExtra[query];
    assert.equal(typeof spanish, 'string', `no Spanish for: ${query}`);
    const es = read(spanish);
    assert.deepEqual(es.unread, [], spanish);
    assert.deepEqual(by(es), by(read(query)), spanish);
  }
});

test('taking a condition away takes its words out of the sentence', () => {
  const text = 'Put credit spreads 30 to 45 days out with win probability above 75% and liquid options, highest return first';
  const cut = (id) => withoutCondition(text, read(text).conditions.find((c) => c.id === id));

  assert.equal(cut('minProbProfit'), 'Put credit spreads 30 to 45 days out, liquid options, highest return first');
  assert.equal(cut('sort'), 'Put credit spreads 30 to 45 days out with win probability above 75% and liquid options');
  assert.equal(cut('dte'), 'Put credit spreads, win probability above 75% and liquid options, highest return first');

  // What is left reads as the same screen less that one condition — which is the whole point.
  for (const { id } of read(text).conditions) {
    const left = by(read(cut(id)));
    const expected = by(read(text));
    delete expected[id];
    assert.deepEqual(left, expected, id);
  }

  assert.equal(withoutCondition('No earnings before expiry', read('No earnings before expiry').conditions[0]), '');
  assert.equal(withoutCondition('anything', { id: 'limit', value: 5, spans: [] }), 'anything');
});
