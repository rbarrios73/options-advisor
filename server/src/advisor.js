// The optional language-model reader: it answers questions about a scan you have already run.
//
// It is deliberately small. There is no SDK — one fetch to the Messages API — because the whole
// dependency is a POST with three headers, and the rest of this app has no runtime dependency it
// does not use properly.
//
// What it is NOT: a source of market data, a forecaster, or a thing that picks trades. It sees
// the digest built in domain/advice.js and nothing else, and the system prompt there holds it to
// those rows. Everything numeric on the screen is still computed by the screener.

import { MAX_QUESTION, SYSTEM_PROMPT, buildDigest, ungroundedSymbols } from './domain/advice.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/** Raised for anything the caller should see verbatim — a bad key, a wrong model name, a limit. */
export class AdvisorError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {object} options
 *   apiKey      ANTHROPIC_API_KEY. Without it the advisor is off and this returns null.
 *   model       a model id; see README for where the current list lives
 *   maxTokens   ceiling on the answer, which is also the ceiling on the cost of one question
 *   fetchImpl   injectable so the tests never touch the network
 */
export function createAdvisor({ apiKey, model, maxTokens = 900, fetchImpl = fetch, timeoutMs = 45_000 }) {
  if (!apiKey) return null;

  return {
    model,

    /**
     * Answers one question about one scan.
     *
     * The scan is passed in whole and digested here rather than being sent by the browser: the
     * numbers the model reads are then the ones this server computed, not numbers a client said
     * it had. The question is the only thing that comes from outside.
     */
    async ask({ question, result }) {
      const clean = String(question ?? '').trim().slice(0, MAX_QUESTION);
      if (!clean) throw new AdvisorError('Ask a question first.', 400);

      const digest = buildDigest(result);
      if (!digest) {
        throw new AdvisorError('There are no candidates to talk about — run a scan first.', 409);
      }

      const body = {
        model,
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            // The table first, the question last: the question is the only part that varies, and
            // it reads as a question about what came before rather than as a new topic.
            content: `Here is my screener's output.\n\n<scan>\n${digest}\n</scan>\n\nMy question: ${clean}`,
          },
        ],
      };

      const response = await withTimeout(
        fetchImpl(API_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': API_VERSION,
          },
          body: JSON.stringify(body),
        }),
        timeoutMs,
      );

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        // The API's own message, verbatim: a wrong model id or an exhausted credit balance says
        // exactly what is wrong, and paraphrasing it into "the advisor failed" hides the fix.
        const detail = payload?.error?.message ?? `${response.status} ${response.statusText}`;
        throw new AdvisorError(`Anthropic API: ${detail}`, response.status === 401 ? 500 : 502);
      }

      const answer = (payload.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();

      if (!answer) throw new AdvisorError('The model returned nothing.', 502);

      return {
        answer,
        model: payload.model ?? model,
        // Flagged, not hidden. The page shows the answer with a warning beside it; suppressing it
        // would leave the person with nothing and no idea why.
        ungrounded: ungroundedSymbols(answer, result),
        truncated: payload.stop_reason === 'max_tokens',
        usage: {
          input: payload.usage?.input_tokens ?? null,
          output: payload.usage?.output_tokens ?? null,
        },
      };
    },
  };
}

/** A request that never returns would hold a browser tab open forever; this one gives up. */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new AdvisorError('The model took too long to answer.', 504)), ms),
    ),
  ]);
}
