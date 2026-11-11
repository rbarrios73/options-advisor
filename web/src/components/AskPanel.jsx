import { useState } from 'react';

import { api } from '../api.js';

import { tr } from '../i18n.js';
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
        <h2>{tr('Ask about these results')}</h2>
        <p className="muted small">
          {tr('Off. Set ')}<code>{tr('ANTHROPIC_API_KEY')}</code>{tr(' in the environment to turn it on — it is the one part of this app that costs money per use, so it is opt-in.')}
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
      <h2>{tr('Ask about these results')}</h2>

      <p className="muted small">
        {tr('Reads the ranked candidates below — their credit, max loss, probabilities and liquidity — and nothing else. It has not seen a chart, the news, or anything about the companies, so it cannot tell you what a price will do. Everything numeric still comes from the screener.')}
      </p>

      <form
        className="ask-form"
        onSubmit={(event) => {
          event.preventDefault();
          ask();
        }}
      >
        <label className="sr-only" htmlFor="ask-question">
          {tr('Your question')}
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
          placeholder={hasResult ? tr('Which of these looks best, and what is the catch?') : tr('Run a scan first.')}
          rows={2}
          maxLength={500}
          disabled={!hasResult || asking}
        />
        <button type="submit" className="primary" disabled={!hasResult || asking || !question.trim()}>
          {asking ? tr('Reading…') : tr('Ask')}
        </button>
      </form>

      {hasResult && !answer && !asking && (
        <ul className="suggestions">
          {SUGGESTIONS.map((s) => tr(s)).map((text) => (
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
              {tr('This answer mentions ')}{answer.ungrounded.join(', ')}{tr(', which ')}{answer.ungrounded.length > 1 ? tr('are') : tr('is')}{' '}
              {tr('not in your scan. Treat ')}{answer.ungrounded.length > 1 ? tr('those parts') : tr('that part')}{tr(' as unfounded — every other claim can be checked against the table below.')}
            </p>
          )}

          {answer.truncated && <p className="muted small">{tr('The answer was cut off at the length limit.')}</p>}

          <p className="muted small answer-foot">
            {answer.model}{tr(' · read the top ')}{answer.candidatesConsidered}{tr(' candidates from the ')}{answer.asOf}{tr(' scan')}
            {answer.usage?.output ? tr(' · {0} tokens', [answer.usage.input + answer.usage.output]) : ''}{tr('. Not advice, and not a forecast — check every number against your broker before acting on it.')}
          </p>
        </div>
      )}
    </section>
  );
}
