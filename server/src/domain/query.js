// A screen described in words, read into the filters the scanner already has.
//
// "Put credit spreads 30 to 45 days out with win probability above 75%, highest return first"
// becomes a list of conditions — one per thing that was understood — and each condition maps onto
// a filter, a sort order or a subset of the watchlist. Nothing here guesses: a phrase that matches
// no rule is handed back in `unread`, so the page can say what it ignored instead of pretending.
//
// It is rules, not a model, on purpose. Reading a query costs nothing, works without an API key,
// gives the same answer twice, and every rule can be tested. English and Spanish are both read,
// because the app speaks both.
//
// Pure: no I/O, no clock. Shared with the browser, which reads the query as you type.

import { STRATEGIES } from './strategies.js';

const NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:[.,]\\d+)?)';
const INT = '(\\d{1,3})';
const PCT = '(?:%|percent|por ciento)';
const DAYS = '(?:days?|dte|dias?)';

// "at least" and friends. STRICT leaves out the weak joiners (of, is, de) for places where they
// would turn "an expiry of 30 days" into "at least 30 days".
const GE_STRICT =
  '(?:above|over|at least|greater than|more than|higher than|min(?:imum)?(?: of)?|>=|>|mayor (?:a|que|de)|superior a|sobre|por encima de|al menos|de al menos|minim[oa](?: de)?|mas de)';
const GE = `(?:${GE_STRICT.slice(3, -1)}|=|of|is|de)`;
const LE =
  '(?:under|below|less than|at most|no more than|max(?:imum)?(?: of)?|up to|<=|<|menor (?:a|que|de)|inferior a|bajo|por debajo de|hasta|maxim[oa](?: de)?|menos de|no mas de)';

const WIN = '(?:win(?:ning)? prob(?:ability)?|prob(?:ability)?(?: of (?:profit|winning|success))?|pop|odds(?: of winning)?|chance(?: of (?:profit|winning))?|prob(?:abilidad)?(?: de (?:ganar|ganancia|exito))?)';
const RETURN = '(?:return on risk|returns?|ror|retorno sobre (?:el )?riesgo|retorno|rendimiento|yield)';
const LOSS = '(?:max(?:imum)? loss|perdida maxima|perdida|riesgo|risk|loss)';

/** What a results list can be ordered by, and which way is "best first". */
export const SORTS = {
  score: 'desc',
  probProfit: 'desc',
  returnOnRisk: 'desc',
  expectedValue: 'desc',
  liquidity: 'desc',
  credit: 'desc',
  maxLoss: 'asc',
  dte: 'asc',
};

// hasOwn, not a plain lookup: "constructor" is a key of every object and is not a sort.
const isSort = (key) => typeof key === 'string' && Object.hasOwn(SORTS, key);

const SORT_TERMS = [
  ['probProfit', WIN],
  ['returnOnRisk', RETURN],
  ['expectedValue', '(?:expected value|ev|valor esperado)'],
  ['liquidity', '(?:liquidity|liquid|liquidez|liquid[oa]s?)'],
  ['credit', '(?:credit|premium|credito|prima)'],
  ['maxLoss', LOSS],
  ['dte', '(?:expir\\w+|dte|vencimiento|days? to expir\\w+)'],
  ['score', '(?:score|calificacion|puntuacion)'],
];
const SORT_ANY = SORT_TERMS.map(([, re]) => re).join('|');

const CREDIT = ['put_credit_spread', 'call_credit_spread', 'iron_condor'];
const LONG = ['long_call', 'long_put'];
const DIRECTIONS = {
  up: ['put_credit_spread', 'long_call'],
  down: ['call_credit_spread', 'long_put'],
  flat: ['iron_condor'],
};

// Words that carry no condition. A leftover made only of these is not reported as unread.
const FILLER = new Set(
  `a an the of in on at to for from by with and or but that which where is are be it its me my i we
   show find give get want need looking look search screen scan list watchlist trade trades option options
   setup setups idea ideas candidate candidates stock stocks name names ticker tickers symbol symbols please
   some any all only just have has having out expiring expire expires expiry expiration expirations first
   then also them these those this each per contract contracts would like can you good new today now
   el la los las un una unos unas de del en mi mis y o pero que donde es son con para por al lo se
   muestrame muestra busca buscar encuentra dame quiero necesito lista operaciones operacion opciones opcion
   ideas candidatos acciones simbolos solo solamente tengan tenga vencen venzan vence vencimiento vencimientos
   primero luego tambien cada contrato contratos hoy ahora favor`
    .split(/\s+/)
    .filter(Boolean),
);

// Tickers that are also ordinary words. Read as a symbol only when written in capitals.
const WORDLIKE = new Set(['A', 'ALL', 'AN', 'ARE', 'AT', 'BE', 'BY', 'CAN', 'CASH', 'COST', 'DAY', 'BEST', 'BIG', 'FAST', 'GOOD', 'LIVE', 'OPEN', 'PLAY', 'REAL', 'RUN', 'SAFE', 'TOP', 'TRUE', 'FOR', 'GO', 'HAS', 'IT', 'KEY', 'LOW', 'NEW', 'NOW', 'ON', 'ONE', 'OR', 'OUT', 'SEE', 'SO', 'TWO', 'UP', 'WELL', 'DE', 'EL', 'LA', 'Y', 'O', 'EN', 'UN', 'ES', 'MAS', 'SOL']);

const number = (text) => Number(/^\d{1,3}(,\d{3})+/.test(text) ? text.replace(/,/g, '') : text.replace(',', '.'));
const fraction = (text) => {
  const value = number(text);
  return value > 1 ? value / 100 : value;
};
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const plain = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Reads a query. `symbols` is the watchlist being scanned: a ticker is only a condition when it
 * is on it, because the scan cannot reach anything else.
 *
 * Returns { conditions, unread }. Conditions are in the order they were found and there is at
 * most one of each kind.
 */
export function interpretQuery(text, { symbols = [] } = {}) {
  const original = String(text ?? '').slice(0, 500);
  // Accents are dropped and case folded so one rule covers "días", "dias" and "DIAS". A character
  // is replaced by exactly one character, so a position in `work` is a position in `original`.
  let work = [...original].map((ch) => plain(ch)[0] ?? ' ').join('');

  const found = new Map();
  // Where in the sentence the rule now running matched. Kept with the condition, so that taking
  // the condition away can take its words out of the box as well.
  let at = null;
  const set = (id, value) => {
    if (!found.has(id)) found.set(id, { id, ...value, spans: at ? [at] : [] });
    else if (at && id === 'strategies') found.get(id).spans.push(at);
  };

  // Runs a rule over what has not been claimed yet, and blanks what it claims so that a later,
  // looser rule cannot read the same words a second time.
  const take = (pattern, use) => {
    const re = new RegExp(`(?<![a-z0-9])(?<!\\d[.,])(?:${pattern})(?![a-z0-9])`, 'g');
    work = work.replace(re, (...args) => {
      const groups = args.slice(0, -2);
      at = [args.at(-2), args.at(-2) + groups[0].length];
      const claimed = use(groups) !== false;
      at = null;
      return claimed ? ' '.repeat(groups[0].length) : groups[0];
    });
  };

  // --- symbols: only ones on the list ---------------------------------------------------------
  const listed = new Set(symbols.map((s) => String(s).toUpperCase()));
  const named = [];
  const namedAt = [];
  const notListed = [];
  work = work.replace(/(?<![a-z0-9.])\$?([a-z]{1,5}(?:\.[a-z])?)(?![a-z0-9])/g, (whole, word, at) => {
    const upper = word.toUpperCase();
    const asWritten = original.slice(at, at + whole.length).replace('$', '');
    const shouted = asWritten === upper && upper.length >= 2;
    const flagged = whole.startsWith('$');

    if (listed.has(upper) && (flagged || shouted || (!WORDLIKE.has(upper) && upper.length >= 3))) {
      if (!named.includes(upper)) named.push(upper);
      namedAt.push([at, at + whole.length]);
      return ' '.repeat(whole.length);
    }
    // A capitalised or $-marked ticker that is not on the list is worth saying so about.
    if ((flagged || (shouted && upper.length >= 3 && !KNOWN_CAPS.has(upper))) && !listed.has(upper)) {
      if (!notListed.includes(upper)) notListed.push(upper);
      return ' '.repeat(whole.length);
    }
    return whole;
  });
  if (named.length) found.set('symbols', { id: 'symbols', symbols: named, spans: namedAt });

  // --- how many, and in what order -------------------------------------------------------------
  take(`(?:top|best|first|primer[oa]s|(?:l[oa]s )?mejores)\\s+(\\d{1,2})(?!\\s*(?:%|percent|por ciento|${DAYS}|delta))`, ([, n]) =>
    set('limit', { value: clamp(Number(n), 1, 60) }),
  );

  const sortKey = (phrase) => SORT_TERMS.find(([, re]) => new RegExp(`^(?:${re})$`).test(phrase.trim()))?.[0];
  const setSort = (phrase, lowest) => {
    const key = sortKey(phrase);
    if (!key) return false;
    // "Lowest" flips the natural order — except where lowest already is the natural order.
    const natural = SORTS[key];
    set('sort', { key, dir: lowest || natural === 'asc' ? 'asc' : 'desc' });
    return true;
  };
  take(
    `(?:sort(?:ed)?|rank(?:ed)?|order(?:ed)?|ordenad[oa]s?|ordenar|ordena|clasificad[oa]s?) (?:by|por) (?:the |el |la )?(highest |best |most |lowest |smallest |mayor |mejor |menor )?(${SORT_ANY})(?: first| primero)?`,
    ([, how, phrase]) => setSort(phrase, /lowest|smallest|menor/.test(how ?? '')),
  );
  take(`(lowest|smallest|least|cheapest|menor|mas baj[oa]) (${SORT_ANY})(?: first| primero)?`, ([, , phrase]) => setSort(phrase, true));
  take(`(?:highest|best|biggest|most|largest|richest|mayor|mejor|mas alt[oa]) (${SORT_ANY})(?: first| primero)?`, ([, phrase]) => setSort(phrase, false));
  // "top 10 by score": the count was taken above, and this is the order it is counted in.
  take(`(?:by|por) (${SORT_ANY})`, ([, phrase]) => setSort(phrase, false));
  take('safest first|mas segur[oa]s primero', () => set('sort', { key: 'probProfit', dir: 'desc' }));
  take('cheapest(?: first)?|mas barat[oa]s(?: primero)?', () => set('sort', { key: 'maxLoss', dir: 'asc' }));
  take('(?:soonest|nearest|closest)(?: expir\\w+)?(?: first)?|mas cercan[oa]s(?: primero)?', () => set('sort', { key: 'dte', dir: 'asc' }));

  // --- earnings ----------------------------------------------------------------------------------
  take(
    '(?:no|avoid(?:ing)?|without|skip(?:ping)?|exclud(?:e|ing)|sin|evita(?:r|ndo)?|excluir|excluyendo) (?:any |the )?(?:earnings|resultados|reportes?)(?: (?:before|inside|within|through|until|antes de(?:l)?|dentro de(?:l)?|hasta el?) (?:the |its |el |su )?(?:expir\\w+|vencimiento|trade|operacion))?',
    () => set('avoidEarnings', {}),
  );

  // --- days to expiry ----------------------------------------------------------------------------
  const window = (min, max, target) => set('dte', { min: Math.max(0, Math.round(min)), max: Math.round(max), target: Math.round(target ?? (min + max) / 2) });
  const about = (n) => {
    const slack = clamp(Math.round(n * 0.25), 5, 10);
    window(n - slack, n + slack, n);
  };
  const OUT = '(?: to expir\\w+| out| al vencimiento| de plazo)?';
  const range = ([, a, b]) => window(Math.min(Number(a), Number(b)), Math.max(Number(a), Number(b)));
  // "and" only counts as a range after "between": "above 75 and 30 days" is two conditions.
  take(`(?:between|entre)\\s*${INT}\\s*(?:and|y)\\s*${INT}\\s*${DAYS}${OUT}`, range);
  take(`(?:from |de )?${INT}\\s*(?:-|–|to|a)\\s*${INT}\\s*${DAYS}${OUT}`, range);
  take(`(?:${LE}|within|inside|dentro de|en menos de)\\s*${NUM}\\s*${DAYS}${OUT}`, ([, n]) => window(0, number(n)));
  take(`(?:${GE_STRICT}|beyond)\\s*${NUM}\\s*${DAYS}${OUT}`, ([, n]) => window(number(n), number(n) + 60, number(n) + 15));
  take(`(?:about |around |roughly |near |approximately |~\\s*|cerca de |alrededor de |unos |aprox\\.? |aproximadamente |a )?${NUM}\\s*${DAYS}${OUT}`, ([, n]) => about(number(n)));
  take(`(?:about |around |roughly |unas |cerca de |a )?${NUM}\\s*(?:weeks?|semanas?)${OUT}`, ([, n]) => about(number(n) * 7));
  take(`(?:about |around |roughly |unos |cerca de |a )?${NUM}\\s*(?:months?|mes(?:es)?)${OUT}`, ([, n]) => about(number(n) * 30));
  take(`(?:about |around |roughly |cerca de |a )?(?:a|one|un) (?:month|mes)${OUT}`, () => about(30));
  take('0\\s*dte|weekl(?:y|ies)|(?:expiring |expire |vencen |que vencen )?(?:this week|esta semana)|semanal(?:es)?', () => window(0, 7, 4));
  take('next week|(?:la )?proxima semana|(?:la )?semana que viene', () => window(5, 14, 9));
  take('monthl(?:y|ies)|mensual(?:es)?', () => window(21, 49, 35));
  take('short[- ]term|(?:de |a )?corto plazo', () => window(0, 14, 7));
  take('leaps?|long[- ]term|(?:de |a )?largo plazo', () => window(180, 730, 365));

  // --- win probability ---------------------------------------------------------------------------
  const prob = (n) => set('minProbProfit', { value: clamp(fraction(n), 0.01, 0.99) });
  take(`${NUM}\\s*${PCT}\\+?\\s*(?:or (?:more|better) |o mas )?(?:de )?${WIN}`, ([, n]) => prob(n));
  take(`${WIN}\\s*(?:${GE})?\\s*(?:a |an |un |una |el )?${NUM}\\s*${PCT}?\\+?`, ([, n]) => prob(n));

  // --- return on risk ----------------------------------------------------------------------------
  const ror = (n) => set('minReturnOnRisk', { value: clamp(fraction(n), 0.01, 5) });
  take(`${NUM}\\s*${PCT}\\+?\\s*(?:or more |o mas )?(?:de )?${RETURN}`, ([, n]) => ror(n));
  take(`(?:${RETURN}|pay(?:s|ing)?|paga(?:n)?)\\s*(?:${GE})?\\s*(?:a |an |un |una |el )?${NUM}\\s*${PCT}\\+?`, ([, n]) => ror(n));

  // --- the most it can lose ----------------------------------------------------------------------
  const loss = (n) => set('maxLoss', { value: clamp(number(n), 1, 1_000_000) });
  take(`${LOSS}\\s*(?:per contract |por contrato )?(?:${LE}|of|de|=)?\\s*\\$?\\s*${NUM}(?!\\s*${PCT})`, ([, n]) => loss(n));
  take(`(?:${LE}\\s*)?\\$\\s*${NUM}\\s*(?:or less |o menos )?(?:of |de |at |en )?${LOSS}`, ([, n]) => loss(n));
  take(`(?:risk(?:ing)?|arriesga(?:r|ndo)?)\\s*(?:${LE})?\\s*\\$?\\s*${NUM}(?!\\s*${PCT})`, ([, n]) => loss(n));
  // "under $300" on its own: a dollar ceiling with nothing else to attach to is the loss.
  take(`${LE}\\s*\\$\\s*${NUM}(?![\\d%])`, ([, n]) => loss(n));

  // --- delta, width, liquidity -------------------------------------------------------------------
  const delta = (n) => set('maxShortDelta', { value: clamp(fraction(n), 0.01, 0.6) });
  take(`${NUM}\\s*-?\\s*deltas?`, ([, n]) => delta(n));
  take(`deltas?\\s*(?:${LE}|${GE}|around|about|near|~|cerca de)?\\s*${NUM}`, ([, n]) => delta(n));
  take('far (?:otm|out of the money)|(?:muy |lejos )(?:otm|fuera del dinero)|lejos del dinero', () => delta('0.15'));

  const wide = (n) => set('width', { min: number(n), max: number(n) });
  take(`\\$?\\s*${NUM}\\s*-?\\s*(?:(?:dollars?|points?|pts?|puntos?|dolares?)\\s*-?\\s*)?wide`, ([, n]) => wide(n));
  take(`\\$?\\s*${NUM}\\s*(?:dolares? |puntos? )?de ancho`, ([, n]) => wide(n));
  take(`(?:width|ancho)\\s*(?:of|de|=)?\\s*\\$?\\s*${NUM}`, ([, n]) => wide(n));

  take(`(?:liquidity|liquidez)(?: score)?\\s*(?:${GE})\\s*${NUM}`, ([, n]) => set('minLiquidity', { value: clamp(fraction(n), 0, 1) }));
  take('(?:very|highly|muy) liquid[oa]?s?(?: options| opciones)?', () => set('minLiquidity', { value: 0.8 }));
  take('(?:options (?:are )?|opciones )?liquid[oa]?s?(?: options| opciones)?|tight (?:spreads|quotes|markets)|good liquidity|buena liquidez', () => set('minLiquidity', { value: 0.6 }));

  // --- which structures --------------------------------------------------------------------------
  const kinds = [];
  const kindsAt = [];
  const add = (...list) => {
    list.forEach((k) => kinds.includes(k) || kinds.push(k));
    kindsAt.push(at);
  };
  take('iron condors?|condor(?:es)? de hierro|condor(?:es|s)?', () => add('iron_condor'));
  take('put credit spreads?|credit put spreads?|bull put(?: spreads?)?|short put spreads?|spreads? de credito (?:con|de) puts?|put spreads?|pcs|sell(?:ing)? puts?|short puts?|cash[- ]secured puts?|csps?|vend(?:er|iendo) puts?|venta de puts?', () => add('put_credit_spread'));
  take('call credit spreads?|credit call spreads?|bear call(?: spreads?)?|short call spreads?|spreads? de credito (?:con|de) calls?|call spreads?|ccs|sell(?:ing)? calls?|short calls?|vend(?:er|iendo) calls?|venta de calls?', () => add('call_credit_spread'));
  take('long calls?|buy(?:ing)? (?:a )?calls?|calls? larg[ao]s?|compra(?:r|ndo)? (?:de )?calls?', () => add('long_call'));
  take('long puts?|buy(?:ing)? (?:a )?puts?|puts? larg[oa]s?|compra(?:r|ndo)? (?:de )?puts?', () => add('long_put'));
  take('credit spreads?|spreads? de credito|vertical(?:es|s)?(?: spreads?)?|spreads?', () => add('put_credit_spread', 'call_credit_spread'));
  take('long options?|debit(?: trades?)?|premium buy(?:ers?|ing)|buy(?:ing)? (?:options|premium)|opciones largas|compra(?:r|ndo)? (?:opciones|prima)|compra(?:dores)? de prima', () => add(...LONG));
  take('premium sell(?:ers?|ing)(?: trades?)?|sell(?:ing)? premium|income(?: trades?)?|vend(?:er|iendo) prima|venta de prima|vendedores de prima|(?:de )?ingresos?', () => add(...CREDIT));
  take('calls?', () => add('long_call'));
  take('puts?', () => add('long_put'));

  let lean = null;
  const leaning = (way) => () => {
    lean = lean ?? way;
    kindsAt.push(at);
  };
  take('bullish|alcistas?|upside', leaning('up'));
  take('bearish|bajistas?|downside', leaning('down'));
  take('neutral(?:es)?|range[- ]bound|sideways|lateral(?:es)?', leaning('flat'));
  if (lean) {
    const towards = DIRECTIONS[lean];
    const both = kinds.filter((k) => towards.includes(k));
    kinds.splice(0, kinds.length, ...(kinds.length === 0 ? towards : both.length ? both : kinds));
  }
  if (kinds.length) found.set('strategies', { id: 'strategies', strategies: STRATEGIES.filter((k) => kinds.includes(k)), lean, spans: kindsAt });

  // --- words that stand for a number -------------------------------------------------------------
  take('high[- ]prob(?:ability)?|alta prob(?:abilidad)?|safe(?:r|st)?|conservative|conservador(?:es|as?)?|segur[oa]s?', () => set('minProbProfit', { value: 0.75, implied: true }));
  take('aggressive|agresiv[oa]s?|high[- ]return|alto retorno|rich premium|prima alta', () => set('minReturnOnRisk', { value: 0.3, implied: true }));
  take('cheap|small account|low[- ]risk|cuenta pequena|barat[oa]s?|bajo riesgo', () => set('maxLoss', { value: 250, implied: true }));

  // A long option wins less than half the time by construction, so a screen that asks for them
  // and says nothing about probability would otherwise return nothing under the usual 60% floor.
  const wanted = found.get('strategies')?.strategies ?? [];
  if (wanted.length && wanted.every((k) => LONG.includes(k))) set('minProbProfit', { value: 0.2, implied: true, forLongs: true });

  // --- what was left over ------------------------------------------------------------------------
  const unread = work
    .split(/[,;.!?()]|\s(?:and|with|but|that|where|which|y|con|pero|que|donde)\s/)
    .map((chunk) => chunk.replace(/[^a-z0-9$%<>=.\s-]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((chunk) => chunk.split(' ').some((word) => word.length > 1 && !FILLER.has(word) && !/^[-–.]+$/.test(word)))
    .map((chunk) =>
      chunk
        .split(' ')
        .filter((word, i, all) => !(FILLER.has(word) && (i === 0 || i === all.length - 1)))
        .join(' '),
    )
    .filter(Boolean);

  return { conditions: [...found.values()], unread, notListed };
}

// Capitalised words that are not tickers: the vocabulary of the screen itself.
const KNOWN_CAPS = new Set(['DTE', 'OTM', 'ITM', 'ATM', 'POP', 'ROR', 'PCS', 'CCS', 'CSP', 'CSPS', 'LEAP', 'LEAPS', 'USD', 'ROI', 'ETF', 'ETFS', 'IV', 'EV', 'AND', 'THE', 'WITH', 'NOT', 'TOP', 'BEST', 'PUT', 'PUTS', 'CALL', 'CALLS']);

/**
 * The sentence with one condition's words taken out, tidied so it still reads: "put spreads with
 * win probability above 75%, highest return first" less the probability is "put spreads, highest
 * return first". Used when a chip is removed, so the box and the chips keep saying the same thing.
 */
export function withoutCondition(text, condition) {
  let out = String(text ?? '');
  for (const [from, to] of [...(condition?.spans ?? [])].sort((a, b) => b[0] - a[0])) out = `${out.slice(0, from)}\u0000${out.slice(to)}`;

  const JOIN = '(?:with|and|that|where|on|in|for|of|con|y|que|en|para|de)';
  return out
    .replace(new RegExp(`(?:[\\s,]*\\b${JOIN})*[\\s,]*\u0000(?:[\\s,]*\u0000)*`, 'gi'), '\u0000')
    .replace(new RegExp(`\u0000\\s*(?:\\b${JOIN}\\b\\s*)?`, 'gi'), ', ')
    .replace(/\s+/g, ' ')
    .replace(/(?:\s*,)+/g, ',')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .replace(/,(?=\S)/g, ', ');
}

/**
 * Conditions → what the scan is asked for: { symbols, filters, screen }.
 *
 * `filters` is a patch over the saved filters, not a full set — anything the query did not
 * mention keeps its saved value, and the page says so.
 */
export function screenRequest(conditions = []) {
  const request = { symbols: null, filters: {}, screen: {} };

  for (const c of conditions) {
    if (c.id === 'symbols' && c.symbols?.length) request.symbols = c.symbols;
    else if (c.id === 'strategies' && c.strategies?.length) request.filters.strategies = c.strategies;
    else if (c.id === 'dte') Object.assign(request.filters, { minDte: c.min, maxDte: c.max, targetDte: c.target ?? Math.round((c.min + c.max) / 2) });
    else if (c.id === 'width') Object.assign(request.filters, { minWidth: c.min, maxWidth: c.max });
    else if (['minProbProfit', 'minReturnOnRisk', 'maxLoss', 'maxShortDelta', 'minLiquidity'].includes(c.id)) request.filters[c.id] = c.value;
    else if (c.id === 'avoidEarnings') request.screen.avoidEarnings = true;
    else if (c.id === 'sort' && isSort(c.key)) request.screen.sort = { key: c.key, dir: c.dir === 'asc' ? 'asc' : 'desc' };
    else if (c.id === 'limit') request.screen.limit = c.value;
  }
  return request;
}

/**
 * A visitor's filters: the defaults, changed by their query only in ways that cannot make the
 * scan cost more.
 *
 * What a scan costs is provider requests, and those are decided by the symbols and by which
 * expiries are fetched. So the expiry window may only shrink inside the default one and the
 * number of expiries stays fixed; everything else is arithmetic on chains already fetched, and
 * the query may set it freely.
 */
export function guestFilters(base, patch = {}) {
  const out = { ...base };
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

  if (Array.isArray(patch.strategies)) {
    const allowed = patch.strategies.filter((k) => STRATEGIES.includes(k));
    if (allowed.length) out.strategies = allowed;
  }
  if (num(patch.minDte) != null) out.minDte = clamp(num(patch.minDte), base.minDte, base.maxDte);
  if (num(patch.maxDte) != null) out.maxDte = clamp(num(patch.maxDte), base.minDte, base.maxDte);
  if (out.minDte > out.maxDte) out.minDte = out.maxDte;
  if (num(patch.targetDte) != null) out.targetDte = clamp(num(patch.targetDte), out.minDte, out.maxDte);

  for (const [key, low, high] of [
    ['minWidth', 0.5, 100],
    ['maxWidth', 0.5, 100],
    ['maxShortDelta', 0.01, 0.6],
    ['minProbProfit', 0.01, 0.99],
    ['minReturnOnRisk', 0.01, 5],
    ['minLiquidity', 0, 1],
    ['maxLoss', 1, 1_000_000],
  ]) {
    if (num(patch[key]) != null) out[key] = clamp(num(patch[key]), low, high);
  }
  return out;
}

/** The `screen` part of a scan request, with anything unexpected dropped. */
export function cleanScreen(screen) {
  const out = {};
  if (screen?.avoidEarnings === true) out.avoidEarnings = true;
  if (screen?.sort && isSort(screen.sort.key)) out.sort = { key: screen.sort.key, dir: screen.sort.dir === 'asc' ? 'asc' : 'desc' };
  const limit = Number(screen?.limit);
  if (Number.isInteger(limit) && limit >= 1) out.limit = Math.min(limit, 60);
  return out;
}

/** Candidates in the order a screen asked for; ties and missing values fall back to the score. */
export function orderCandidates(candidates, sort, limit = 50) {
  const key = sort && isSort(sort.key) ? sort.key : 'score';
  const dir = key === 'score' ? -1 : sort.dir === 'asc' ? 1 : -1;

  return [...candidates]
    .sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av == null && bv != null) return 1; // a value that is missing sorts last either way
      if (bv == null && av != null) return -1;
      if (av !== bv && av != null) return av > bv ? dir : -dir;
      return b.score - a.score;
    })
    .slice(0, limit);
}

// Where a template asks for high odds or a far strike it also names a return it can live with:
// those trades pay little by construction, and the usual saved floor of 15% would empty the list.
/**
 * Screens to start from. Each is only a query — running one types it into the box, so what it
 * asked for can be read, edited and run again.
 */
export const TEMPLATE_GROUPS = [
  {
    id: 'sellers',
    name: 'Premium sellers',
    templates: [
      {
        title: 'High-probability put spreads',
        tag: 'Put credit spread',
        query: 'Put credit spreads 30 to 45 days out with win probability above 75% and liquid options, highest return first',
        blurb: 'Bullish, defined-risk income where the odds are clearly on your side.',
      },
      {
        title: 'Call spreads far above the price',
        tag: 'Call credit spread',
        query: 'Call credit spreads around 30 days with delta under 0.25 and return above 10%',
        blurb: 'Bearish credit with the short strike well out of the money.',
      },
      {
        title: 'Iron condors for a quiet month',
        tag: 'Iron condor',
        query: 'Iron condors 30 to 45 days out, sorted by expected value',
        blurb: 'Paid on both sides if the price stays in its range.',
      },
      {
        title: 'No earnings surprises',
        tag: 'Earnings',
        query: 'Premium selling trades 20 to 45 days out with no earnings before expiry, sorted by win probability',
        blurb: 'Leaves out anything that expires after an earnings date on your watchlist.',
      },
    ],
  },
  {
    id: 'short',
    name: 'Short-term',
    templates: [
      {
        title: 'This week’s income',
        tag: 'Weeklies',
        query: 'Credit spreads expiring this week with win probability above 75% and return above 5%, sorted by return',
        blurb: 'Fast decay, little time to be wrong — and little time to recover.',
      },
      {
        title: 'Two weeks out, far from the price',
        tag: 'Short-term',
        query: 'Credit spreads 7 to 14 days out with delta under 0.20 and return above 5%, most liquid first',
        blurb: 'Short strikes the market gives little chance of reaching.',
      },
    ],
  },
  {
    id: 'buyers',
    name: 'Premium buyers',
    templates: [
      {
        title: 'Calls with time on their side',
        tag: 'Long call',
        query: 'Long calls 45 to 60 days out with liquid options, sorted by win probability',
        blurb: 'Bullish, with enough time that decay is not yet the whole story.',
      },
      {
        title: 'Puts for a pullback',
        tag: 'Long put',
        query: 'Long puts around 45 days with liquid options, lowest max loss first',
        blurb: 'Bearish, and the most you can lose is what you pay.',
      },
      {
        title: 'Small directional bets',
        tag: 'Long options',
        query: 'Long options with max loss under $300, sorted by win probability',
        blurb: 'Calls and puts that risk no more than $300 a contract.',
      },
    ],
  },
  {
    id: 'small',
    name: 'Small accounts',
    templates: [
      {
        title: 'Spreads that risk under $200',
        tag: 'Low risk',
        query: 'Credit spreads with max loss under $200 and win probability above 70%',
        blurb: 'Narrow spreads sized for a small account.',
      },
      {
        title: '$5-wide put spreads under 30 delta',
        tag: 'Put credit spread',
        query: 'Put credit spreads $5 wide with delta under 0.30 around 45 days',
        blurb: 'The textbook 45-day put spread, on your own watchlist.',
      },
      {
        title: 'Ten best bullish trades',
        tag: 'Bullish',
        query: 'Bullish trades 30 to 45 days out, top 10 by score',
        blurb: 'Put credit spreads and long calls, ranked together.',
      },
    ],
  },
];

/** One-tap screens, in the spirit of a "market movers" row — for the watchlist. */
export const QUICK_SCREENS = [
  ['Highest win probability', 'Highest win probability first'],
  ['Best return on risk', 'Sorted by return on risk'],
  ['Expiring this week', 'Expiring this week'],
  ['About a month out', 'Around 30 days'],
  ['Lowest risk', 'Lowest max loss first'],
  ['Most liquid', 'Very liquid options, most liquid first'],
  ['Bullish', 'Bullish trades'],
  ['Bearish', 'Bearish trades'],
  ['Neutral', 'Iron condors'],
  ['No earnings', 'No earnings before expiry'],
];
