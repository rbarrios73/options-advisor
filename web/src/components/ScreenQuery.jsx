import { useState } from 'react';

import { QUICK_SCREENS, TEMPLATE_GROUPS } from '@domain/query.js';

import { STRATEGY_LABELS, money, pct } from '../format.js';
import { tr } from '../i18n.js';

/**
 * The box you describe a screen in, and the one-tap screens under it.
 *
 * Typing is the whole interface: a template or a quick screen only fills the box and runs it, so
 * whatever was asked for is always there to read, change and run again. An empty box is a plain
 * scan on the saved filters, exactly as the Scan button used to be.
 */
export function QueryBox({ text, onText, onRun, scanning, children }) {
  const submit = (event) => {
    event.preventDefault();
    onRun(text);
  };

  return (
    <form className="query-box panel" onSubmit={submit}>
      <label htmlFor="screen-query" className="query-title">
        {tr('Describe the trade you are looking for')}
      </label>
      <p className="muted small query-sub">
        {tr('You get a sortable list from your watchlist’s option chains, and the exact way your words were read.')}
      </p>
      <textarea
        id="screen-query"
        rows={2}
        value={text}
        maxLength={500}
        placeholder={tr('e.g. Put credit spreads 30 to 45 days out with win probability above 75%, highest return first')}
        onChange={(event) => onText(event.target.value)}
        onKeyDown={(event) => {
          // Enter runs it, as in a search box; Shift+Enter is still a new line.
          if (event.key === 'Enter' && !event.shiftKey) submit(event);
        }}
      />
      <div className="query-actions">
        <button type="submit" className="primary" disabled={scanning}>
          {scanning ? tr('Scanning…') : text.trim() ? tr('Run') : tr('Scan')}
        </button>
        {children}
      </div>

      <div className="quick-screens" role="group" aria-label={tr('Quick screens')}>
        <span className="quick-label">{tr('Quick screens')}</span>
        {QUICK_SCREENS.map(([label, query]) => (
          <button key={label} type="button" className="chip-button" disabled={scanning} onClick={() => onRun(tr(query))}>
            {tr(label)}
          </button>
        ))}
      </div>
    </form>
  );
}

/**
 * "How I read it": one chip per condition the query was understood to ask for, each removable,
 * then what was not understood, then the saved filters that still apply to everything the query
 * did not mention. The point is that nothing is applied without being shown.
 */
export function Reading({ query, result, filters, guest, onRemove, onAdd, onEditFilters, scanning }) {
  const conditions = query?.conditions ?? [];
  const mentioned = new Set(conditions.map((c) => c.id));

  return (
    <section className="reading" aria-label={tr('How your words were read')}>
      {conditions.length > 0 && (
        <div className="reading-row">
          <span className="reading-label">{tr('How I read it')}</span>
          <ul className="chips">
            {conditions.map((c) => (
              <li key={c.id} className={c.implied ? 'chip implied' : 'chip'} title={impliedNote(c)}>
                <span>{conditionLabel(c)}</span>
                {/* A condition with no words of its own in the sentence — the floor lowered for long
                    options — has nothing to take out, so it has no ×. */}
                {c.spans?.length > 0 && (
                  <button type="button" disabled={scanning} aria-label={tr('Remove “{0}”', [conditionLabel(c)])} onClick={() => onRemove(c.id)}>
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {query?.unread?.length > 0 && (
        <p className="warning small reading-unread">
          {tr('Not understood, so not applied: ')}
          {query.unread.map((u) => `“${u}”`).join(', ')}
          {tr('. This screen reads strategy, days to expiry, win probability, return on risk, max loss, delta, width, liquidity, earnings and symbols on your watchlist.')}
        </p>
      )}
      {query?.notListed?.length > 0 && (
        <p className="warning small reading-unread">
          {query.notListed.length === 1
            ? tr('{0} is not on this watchlist, so it was not scanned.', [query.notListed[0]])
            : tr('{0} are not on this watchlist, so they were not scanned.', [query.notListed.join(', ')])}{' '}
          {!guest && <a href="#/watchlist">{tr('Edit the list')}</a>}
        </p>
      )}

      <p className="base-filters small">
        <strong>{guest ? tr('Default filters:') : tr('Your saved filters:')}</strong>{' '}
        {baseFilterText(result?.filters ?? filters, mentioned)}{' '}
        <button type="button" className="link-button" onClick={onEditFilters}>
          {guest ? tr('See them') : tr('Edit')}
        </button>
      </p>

      {result && followUps(conditions).length > 0 && (
        <div className="follow-ups" role="group" aria-label={tr('Narrow it down')}>
          {followUps(conditions).map(([label, phrase]) => (
            <button key={label} type="button" className="chip-button" disabled={scanning} onClick={() => onAdd(tr(phrase))}>
              ↳ {tr(label)}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** Screens to start from, by the kind of trader they suit. */
export function Templates({ onRun, scanning }) {
  const [group, setGroup] = useState(TEMPLATE_GROUPS[0].id);
  const shown = TEMPLATE_GROUPS.find((g) => g.id === group) ?? TEMPLATE_GROUPS[0];

  return (
    <section className="templates" aria-labelledby="templates-title">
      <div className="templates-head">
        <h2 id="templates-title">{tr('Templates')}</h2>
        <div className="segmented" role="radiogroup" aria-label={tr('Template category')}>
          {TEMPLATE_GROUPS.map((g) => (
            <button key={g.id} type="button" role="radio" aria-checked={g.id === group} className={g.id === group ? 'on' : ''} onClick={() => setGroup(g.id)}>
              {tr(g.name)}
            </button>
          ))}
        </div>
      </div>

      <ul className="template-cards">
        {shown.templates.map((t) => (
          <li key={t.title} className="template-card">
            <span className="template-tag">{tr(t.tag)}</span>
            <h3>{tr(t.title)}</h3>
            <p className="template-query">“{tr(t.query)}”</p>
            <p className="muted small">{tr(t.blurb)}</p>
            <button type="button" className="link-button" disabled={scanning} onClick={() => onRun(tr(t.query))}>
              {tr('Run it')} →
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const SORT_NAMES = {
  score: 'score',
  probProfit: 'win probability',
  returnOnRisk: 'return on risk',
  expectedValue: 'expected value',
  liquidity: 'liquidity',
  credit: 'credit',
  maxLoss: 'max loss',
  dte: 'days to expiry',
};

/** A condition, in the words the rest of the app uses. */
export function conditionLabel(c) {
  switch (c.id) {
    case 'symbols':
      return tr('Only {0}', [c.symbols.join(', ')]);
    case 'strategies':
      return c.strategies.map((k) => tr(STRATEGY_LABELS[k] ?? k)).join(' · ');
    case 'dte':
      return c.min === 0 ? tr('Expires within {0} days', [c.max]) : tr('{0}–{1} days to expiry', [c.min, c.max]);
    case 'minProbProfit':
      return tr('Win probability ≥ {0}', [pct(c.value, 0)]);
    case 'minReturnOnRisk':
      return tr('Return on risk ≥ {0}', [pct(c.value, 0)]);
    case 'maxLoss':
      return tr('Max loss ≤ {0}', [money(c.value)]);
    case 'maxShortDelta':
      return tr('Short delta ≤ {0}', [c.value.toFixed(2)]);
    case 'width':
      return c.min === c.max ? tr('${0} wide', [c.min]) : tr('${0}–${1} wide', [c.min, c.max]);
    case 'minLiquidity':
      return tr('Liquidity ≥ {0}', [c.value.toFixed(2)]);
    case 'avoidEarnings':
      return tr('No earnings before expiry');
    case 'sort':
      return c.dir === 'asc' ? tr('Lowest {0} first', [tr(SORT_NAMES[c.key])]) : tr('Highest {0} first', [tr(SORT_NAMES[c.key])]);
    case 'limit':
      return tr('Top {0}', [c.value]);
    default:
      return c.id;
  }
}

// Why a condition is there when its number was never typed.
function impliedNote(c) {
  if (c.id === 'avoidEarnings') return tr('Uses the earnings dates written on your watchlist. A symbol with no date there is not left out.');
  if (!c.implied) return undefined;
  if (c.forLongs) return tr('A long option wins less than half the time by design, so the usual floor is lowered for this screen. Type a win probability to set your own.');
  return tr('You did not give a number, so this is what the word was taken to mean. Remove it, or type the number you want.');
}

/** The saved filters the query left alone, in one line. */
function baseFilterText(filters, mentioned) {
  if (!filters) return '';
  const parts = [];
  if (!mentioned.has('dte')) parts.push(tr('{0}–{1} days', [filters.minDte, filters.maxDte]));
  if (!mentioned.has('maxShortDelta')) parts.push(tr('short delta ≤ {0}', [Number(filters.maxShortDelta).toFixed(2)]));
  if (!mentioned.has('minProbProfit')) parts.push(tr('win probability ≥ {0}', [pct(filters.minProbProfit, 0)]));
  if (!mentioned.has('minReturnOnRisk')) parts.push(tr('return ≥ {0}', [pct(filters.minReturnOnRisk, 0)]));
  if (!mentioned.has('minLiquidity')) parts.push(tr('liquidity ≥ {0}', [Number(filters.minLiquidity).toFixed(2)]));
  if (!mentioned.has('width')) parts.push(tr('${0}–${1} wide', [filters.minWidth, filters.maxWidth]));
  if (!mentioned.has('maxLoss') && filters.maxLoss != null) parts.push(tr('max loss ≤ {0}', [money(filters.maxLoss)]));
  return parts.length ? `${parts.join(' · ')}.` : tr('all overridden by this query.');
}

// Up to three ways to tighten the screen that it has not already used.
function followUps(conditions) {
  const has = (id) => conditions.some((c) => c.id === id);
  const longsOnly = conditions.some((c) => c.forLongs);
  return [
    !has('minProbProfit') && !longsOnly && ['Win probability above 75%', 'win probability above 75%'],
    !has('avoidEarnings') && ['No earnings before expiry', 'no earnings before expiry'],
    !has('maxLoss') && ['Max loss under $300', 'max loss under $300'],
    !has('minLiquidity') && ['Very liquid only', 'very liquid options'],
    !has('dte') && ['About a month out', 'around 30 days'],
  ]
    .filter(Boolean)
    .slice(0, 3);
}
