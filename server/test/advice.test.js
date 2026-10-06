import test from 'node:test';
import assert from 'node:assert/strict';

import { DIGEST_LIMIT, SYSTEM_PROMPT, buildDigest, ungroundedSymbols } from '../src/domain/advice.js';
import { AdvisorError, createAdvisor } from '../src/advisor.js';

const candidate = (over = {}) => ({
  symbol: 'SPY',
  kind: 'put_credit_spread',
  expiration: '2026-11-06',
  dte: 32,
  spot: 552.4,
  credit: 0.69,
  width: 5,
  breakEven: 534.31,
  maxProfit: 69,
  maxLoss: 431,
  returnOnRisk: 0.16,
  probProfit: 0.813,
  expectedValue: -24,
  liquidity: 0.82,
  score: 0.61,
  legs: [
    { action: 'sell', strike: 535, type: 'put' },
    { action: 'buy', strike: 530, type: 'put' },
  ],
  ...over,
});

const scan = (over = {}) => ({
  asOf: '2026-10-05',
  provider: 'mock',
  totalCandidates: 2,
  filters: { minDte: 21, maxDte: 50, minProbProfit: 0.7, minReturnOnRisk: 0.15, maxWidth: 10 },
  symbols: [{ symbol: 'SPY', spot: 552.4 }, { symbol: 'GLD', spot: 246.7 }],
  failures: [],
  candidates: [candidate(), candidate({ symbol: 'GLD', spot: 246.7, score: 0.55 })],
  ...over,
});

// --- the digest ---------------------------------------------------------------------------------

test('the digest holds what the table holds, and nothing the model could not check', () => {
  const digest = buildDigest(scan());

  // The things a reader can verify against their own screen.
  assert.match(digest, /SPY Put credit spread 2026-11-06 \(32d\)/);
  assert.match(digest, /sell 535 put \/ buy 530 put/);
  assert.match(digest, /win probability 81\.3%/);
  assert.match(digest, /max loss \$431/);
  assert.match(digest, /return on risk 16\.0%/);
  assert.match(digest, /liquidity 0\.82/);

  // And the context that stops it reading two unrelated scans as one.
  assert.match(digest, /Scan of 2026-10-05, data from the mock provider/);
  assert.match(digest, /Watchlist: SPY 552\.40, GLD 246\.70/);
  assert.match(digest, /21–50 days to expiry/);

  // Deterministic: the same scan digests to the same bytes, so a cached answer is about the same
  // thing the person is looking at.
  assert.equal(buildDigest(scan()), digest);
});

test('a missing number reads as a dash, never as zero', () => {
  // A long call has no return on risk and no expected value, by design — see metrics.js. Printing
  // those as 0 would invite the model to call it the worst candidate on the list.
  const digest = buildDigest(
    scan({ candidates: [candidate({ kind: 'long_call', returnOnRisk: null, expectedValue: null, maxProfit: null, width: null })] }),
  );

  assert.match(digest, /return on risk —/);
  assert.match(digest, /expected value —/);
  assert.match(digest, /max profit —/);
  assert.match(digest, /width —/);
  assert.doesNotMatch(digest, /return on risk 0\.0%/);
});

test('an empty scan digests to nothing, so no request is spent on "there is nothing"', () => {
  assert.equal(buildDigest(scan({ candidates: [] })), null);
  assert.equal(buildDigest(null), null);
});

test('the digest is capped, and failures are named', () => {
  const many = Array.from({ length: 60 }, (_, i) => candidate({ score: 1 - i / 100 }));
  const digest = buildDigest(scan({ candidates: many, totalCandidates: 60 }));

  assert.equal(digest.match(/^\d+\. SPY/gm).length, DIGEST_LIMIT);
  assert.match(digest, new RegExp(`the top ${DIGEST_LIMIT} by score`));

  const withFailure = buildDigest(scan({ failures: [{ symbol: 'ZZZZ', error: 'No data' }] }));
  assert.match(withFailure, /Symbols that failed: ZZZZ \(No data\)/);
});

test('the system prompt forbids the three things that would make an answer unusable', () => {
  // Pinned because they are the whole basis of trusting this feature, and because a well-meaning
  // edit that softens them would not fail anything else.
  assert.match(SYSTEM_PROMPT, /ONLY the candidates in the table/);
  assert.match(SYSTEM_PROMPT, /Never state a number you were not given/);
  assert.match(SYSTEM_PROMPT, /no information about the companies, the market, the news/i);
  assert.match(SYSTEM_PROMPT, /Do not tell the person what to trade/);
});

// --- checking the answer ------------------------------------------------------------------------

test('a ticker that is not in the scan is caught', () => {
  const result = scan();

  assert.deepEqual(ungroundedSymbols('Candidate 1, SPY, pays more than 2, GLD.', result), []);
  assert.deepEqual(ungroundedSymbols('I would look at NVDA instead.', result), ['NVDA']);
  assert.deepEqual(ungroundedSymbols('Consider TSLA and AAPL.', result).sort(), ['AAPL', 'TSLA']);
});

test('a symbol that failed the scan still counts as grounded', () => {
  // It was in front of the model, in the "failed" line, so discussing it is fair.
  const result = scan({ failures: [{ symbol: 'ZZZZ', error: 'No data' }] });
  assert.deepEqual(ungroundedSymbols('ZZZZ returned nothing this time.', result), []);
});

test('ordinary capitalised words are not mistaken for tickers', () => {
  const result = scan();
  const prose =
    'A put credit spread on SPY has a 16% ROR. IV is one snapshot, and the DTE is 32. ' +
    'If the price falls, you lose. The ITM case is worse. P&L is shown above.';

  assert.deepEqual(ungroundedSymbols(prose, result), [], 'sentence-initial words and jargon are not symbols');
});

// --- the client ---------------------------------------------------------------------------------

/** A stand-in for the Messages API. No network in these tests, by construction. */
function stubFetch(handler) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return handler(calls.length);
  };
  impl.calls = calls;
  return impl;
}

const ok = (text, extra = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1200, output_tokens: 300 },
    ...extra,
  }),
});

test('no key means no advisor at all, rather than one that fails when used', () => {
  assert.equal(createAdvisor({ apiKey: '', model: 'x' }), null);
  assert.ok(createAdvisor({ apiKey: 'sk-test', model: 'x' }));
});

test('the request carries the key, the version header, the system prompt and the digest', async () => {
  const fetchImpl = stubFetch(() => ok('Candidate 1, SPY, pays the most for its risk.'));
  const advisor = createAdvisor({ apiKey: 'sk-test', model: 'claude-sonnet-5-5', fetchImpl });

  const answer = await advisor.ask({ question: 'Which pays most?', result: scan() });

  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.options.headers['x-api-key'], 'sk-test');
  assert.equal(call.options.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.body.model, 'claude-sonnet-5-5');
  assert.equal(call.body.system, SYSTEM_PROMPT);

  // The table goes in the message, and the question comes after it.
  assert.match(call.body.messages[0].content, /<scan>[\s\S]*win probability 81\.3%[\s\S]*<\/scan>/);
  assert.match(call.body.messages[0].content, /My question: Which pays most\?$/);

  assert.match(answer.answer, /Candidate 1/);
  assert.deepEqual(answer.ungrounded, []);
  assert.equal(answer.usage.input, 1200);
  assert.equal(answer.truncated, false);
});

test('an answer that invents a ticker comes back flagged, not suppressed', async () => {
  const fetchImpl = stubFetch(() => ok('Honestly I would buy NVDA calls instead.'));
  const advisor = createAdvisor({ apiKey: 'sk-test', model: 'm', fetchImpl });

  const answer = await advisor.ask({ question: 'What should I do?', result: scan() });

  // Shown with a warning rather than hidden: the person is left with something they can judge,
  // instead of a blank panel and no idea why.
  assert.match(answer.answer, /NVDA/);
  assert.deepEqual(answer.ungrounded, ['NVDA']);
});

test('a long answer is marked as cut off', async () => {
  const fetchImpl = stubFetch(() => ok('It goes on and', { stop_reason: 'max_tokens' }));
  const advisor = createAdvisor({ apiKey: 'sk-test', model: 'm', fetchImpl });

  assert.equal((await advisor.ask({ question: 'q', result: scan() })).truncated, true);
});

test('an empty question and an empty scan are refused before a request is made', async () => {
  const fetchImpl = stubFetch(() => ok('never reached'));
  const advisor = createAdvisor({ apiKey: 'sk-test', model: 'm', fetchImpl });

  await assert.rejects(() => advisor.ask({ question: '   ', result: scan() }), { status: 400 });
  await assert.rejects(() => advisor.ask({ question: 'q', result: scan({ candidates: [] }) }), { status: 409 });

  assert.equal(fetchImpl.calls.length, 0, 'neither spent a request');
});

test("the API's own error message is passed through, because it says what to fix", async () => {
  const fetchImpl = stubFetch(() => ({
    ok: false,
    status: 404,
    statusText: 'Not Found',
    json: async () => ({ error: { message: 'model: nonsense-model-1' } }),
  }));
  const advisor = createAdvisor({ apiKey: 'sk-test', model: 'nonsense-model-1', fetchImpl });

  await assert.rejects(
    () => advisor.ask({ question: 'q', result: scan() }),
    (error) => {
      assert.ok(error instanceof AdvisorError);
      // A wrong model id is one env var away from fixed, and only if the message survives.
      assert.match(error.message, /nonsense-model-1/);
      return true;
    },
  );
});

test('a question longer than the limit is cut rather than sent whole', async () => {
  const fetchImpl = stubFetch(() => ok('fine'));
  const advisor = createAdvisor({ apiKey: 'sk-test', model: 'm', fetchImpl });

  await advisor.ask({ question: 'x'.repeat(2000), result: scan() });
  const sent = fetchImpl.calls[0].body.messages[0].content;
  assert.ok(sent.length < 2000, 'the padding never reached the API');
});
