import { useState } from 'react';

import { api } from '../api.js';

/**
 * Ask about the scan on screen.
 *
 * The model is given the ranked candidates and nothing else — no prices it did not get from the
 * screener, no news, no opinion about the companies. So this box answers "which of these, and
 * what am I trading off" well, and "what will go up next month" not at all, which is the honest
 * division and is said on the page rather than only in the code.
 */
const SUGGESTIONS = [
  'Which of these has the best balance of win probability and return on risk?',
  'What would you be wary of in the top five?',
  'Which ones suit holding for about a month, and why?',
  'Where are two candidates close enough that the ranking is not meaningful?',
];

export default function AskPanel({ advisor, hasResult }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [error, setError] = useState(null);
  const [asking, setAsking] = useState(false);

  // Off rather than broken: the same shape as accounts, which are absent without a database.
  if (!advisor) {
    return (
      <section className="panel ask-panel">
        <h2>Ask about these results</h2>
        <p className="muted small">
          Off. Set <code>ANTHROPIC_API_KEY</code> in the environment to turn it on — it is the one
          part of this app that costs money per use, so it is opt-in.
        </p>
      </section>
    );
  }

  const ask = async (text) => {
    const clean = (text ?? question).trim();
    if (!clean || asking) return;

    setQuestion(clean);
    setAsking(true);
    setError(null);
    setAnswer(null);

    try {
      setAnswer(await api.explain(clean));
    } catch (e) {
      setError(e.message);
    } finally {
      setAsking(false);
    }
  };

  return (
    <section className="panel ask-panel">
      <h2>Ask about these results</h2>

      <p className="muted small">
        Reads the ranked candidates below — their credit, max loss, probabilities and liquidity —
        and nothing else. It has not seen a chart, the news, or anything about the companies, so it
        cannot tell you what a price will do. Everything numeric still comes from the screener.
      </p>

      <form
        className="ask-form"
        onSubmit={(event) => {
          event.preventDefault();
          ask();
        }}
      >
        <label className="sr-only" htmlFor="ask-question">
          Your question
        </label>
        <textarea
          id="ask-question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter writes a line — what a chat box does, and this is one.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              ask();
            }
          }}
          placeholder={hasResult ? 'Which of these looks best, and what is the catch?' : 'Run a scan first.'}
          rows={2}
          maxLength={500}
          disabled={!hasResult || asking}
        />
        <button type="submit" className="primary" disabled={!hasResult || asking || !question.trim()}>
          {asking ? 'Reading…' : 'Ask'}
        </button>
      </form>

      {hasResult && !answer && !asking && (
        <ul className="suggestions">
          {SUGGESTIONS.map((text) => (
            <li key={text}>
              <button type="button" className="link-button" onClick={() => ask(text)}>
                {text}
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="error small">{error}</p>}

      {answer && (
        <div className="answer">
          {/* Plain paragraphs. Markdown rendering would mean trusting model output as markup; the
              answer is prose and reads as prose. */}
          {answer.answer.split(/\n{2,}/).map((para, i) => (
            <p key={i}>{para}</p>
          ))}

          {answer.ungrounded?.length > 0 && (
            <p className="warning small">
              This answer mentions {answer.ungrounded.join(', ')}, which {answer.ungrounded.length > 1 ? 'are' : 'is'}{' '}
              not in your scan. Treat {answer.ungrounded.length > 1 ? 'those parts' : 'that part'} as unfounded — every
              other claim can be checked against the table below.
            </p>
          )}

          {answer.truncated && <p className="muted small">The answer was cut off at the length limit.</p>}

          <p className="muted small answer-foot">
            {answer.model} · read the top {answer.candidatesConsidered} candidates from the {answer.asOf} scan
            {answer.usage?.output ? ` · ${answer.usage.input + answer.usage.output} tokens` : ''}. Not advice, and
            not a forecast — check every number against your broker before acting on it.
          </p>
        </div>
      )}
    </section>
  );
}
