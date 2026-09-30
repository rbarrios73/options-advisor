import { useEffect, useRef, useState } from 'react';

import { MAX_LISTS, MAX_NAME, MAX_SYMBOLS, SYMBOL_PATTERN, cleanEntry } from '@domain/watchlist.js';

import { api } from '../api.js';
import { hrefFor } from '../router.js';
import { price as fmtPrice } from '../format.js';

/**
 * The watchlists: several named lists, one of them live.
 *
 * The list you are editing IS the list that gets scanned. That is deliberately one idea rather
 * than two — a page where you edit "ETFs" while the screener quietly scans "earnings plays" is a
 * page that will eventually scan the wrong thing without saying so.
 *
 * Structural edits — add, remove, reorder — save as they happen, because a list that needs a Save
 * button is a list someone will leave unsaved. Text edits save when the field is left, so typing a
 * note is not a request per keystroke.
 */
export default function WatchlistPage({ watchlist, watchlists, activeId, onWatchlist, lists, accounts }) {
  const [typed, setTyped] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState(null);
  const [pending, setPending] = useState(null); // a symbol with no quote, awaiting "add anyway"
  const [checking, setChecking] = useState(false);
  const [saved, setSaved] = useState(null);
  const [quotes, setQuotes] = useState({});
  const [listProblem, setListProblem] = useState(null);
  const [busy, setBusy] = useState(false);

  const active = watchlists.find((l) => l.id === activeId) ?? watchlists[0] ?? null;

  const symbols = watchlist.map((w) => w.symbol).join(',');

  // One quote per row, so a ticker that has quietly stopped trading shows up here rather than as
  // a failure in the middle of a scan. They come from the same cache the scan uses, and in small
  // batches — forty at once is a way to meet a provider's rate limit head on.
  useEffect(() => {
    let live = true;
    const list = symbols ? symbols.split(',') : [];

    (async () => {
      for (let i = 0; i < list.length && live; i += 4) {
        const batch = await Promise.all(
          list.slice(i, i + 4).map((symbol) =>
            api
              .quote(symbol)
              .then((r) => [symbol, r.quote])
              .catch((e) => [symbol, { error: e.message }]),
          ),
        );
        if (live) setQuotes((q) => ({ ...q, ...Object.fromEntries(batch) }));
      }
    })();

    return () => {
      live = false;
    };
  }, [symbols]);

  const save = async (next) => {
    setSaved('saving');
    await onWatchlist(next);
    setSaved('saved');
  };

  /** Runs one list operation, showing its refusal where the button is rather than at the top. */
  const run = async (action) => {
    setBusy(true);
    setListProblem(null);
    try {
      await action();
    } catch (error) {
      setListProblem(error.message);
    } finally {
      setBusy(false);
    }
  };

  const add = async (event, force = false) => {
    event?.preventDefault();

    const entry = cleanEntry({ symbol: typed, note });
    if (!entry) {
      setProblem(`“${typed.trim()}” is not a ticker — letters and dots, up to six of them.`);
      return;
    }
    if (watchlist.some((w) => w.symbol === entry.symbol)) {
      setProblem(`${entry.symbol} is already on the list.`);
      return;
    }
    if (watchlist.length >= MAX_SYMBOLS) {
      setProblem(`That is the limit of ${MAX_SYMBOLS} — a scan costs provider requests per symbol.`);
      return;
    }

    // Checked against the provider before it goes in, so a typo is caught here rather than as a
    // failed symbol in the middle of tomorrow's scan. It can be overridden: a name the provider
    // does not know today may still be one you want on the list.
    if (!force) {
      setChecking(true);
      try {
        await api.quote(entry.symbol);
      } catch (error) {
        setProblem(`${entry.symbol}: ${error.message}`);
        setPending(entry);
        return;
      } finally {
        setChecking(false);
      }
    }

    setProblem(null);
    setPending(null);
    setTyped('');
    setNote('');
    await save([...watchlist, entry]);
  };

  const patch = (symbol, changes) =>
    save(watchlist.map((w) => (w.symbol === symbol ? { ...w, ...changes } : w)));

  const remove = (symbol) => save(watchlist.filter((w) => w.symbol !== symbol));

  const move = (index, by) => {
    const next = [...watchlist];
    const target = index + by;
    if (target < 0 || target >= next.length) return;

    [next[index], next[target]] = [next[target], next[index]];
    save(next);
  };

  return (
    <div className="watchlist-page">
      <div className="page-head">
        <p className="muted small">
          Keep as many lists as you like — the one you pick here is the one the screener scans.
          Notes are for you; the earnings date is not — set it and the screener flags any expiry
          that lands after it, which is the most common way a short premium position goes wrong.
          {accounts
            ? ' These lists are yours: they are stored per account, and nobody else’s changes touch them.'
            : ' This copy runs without accounts, so the lists are saved to a file beside the app.'}
        </p>

        <p className="muted small" aria-live="polite">
          {saved === 'saving'
            ? 'Saving…'
            : saved === 'saved'
              ? 'Saved'
              : `${watchlist.length} ${watchlist.length === 1 ? 'symbol' : 'symbols'}`}
        </p>
      </div>

      <nav className="lists" aria-label="Watchlists">
        {watchlists.map((list) => (
          <button
            key={list.id}
            type="button"
            className={list.id === active?.id ? 'chip on' : 'chip'}
            aria-current={list.id === active?.id ? 'true' : undefined}
            disabled={busy}
            onClick={() => list.id !== active?.id && run(() => lists.activate(list.id))}
          >
            {list.name} <span className="count">{list.entries.length}</span>
          </button>
        ))}

        {watchlists.length < MAX_LISTS && (
          <button
            type="button"
            className="chip new"
            disabled={busy}
            onClick={() => run(() => lists.create('New list'))}
          >
            + New list
          </button>
        )}
      </nav>

      {active && (
        <div className="list-bar">
          <ListName key={active.id} list={active} busy={busy} onRename={(name) => run(() => lists.rename(active.id, name))} />

          <button
            type="button"
            disabled={busy || watchlists.length >= MAX_LISTS}
            onClick={() => run(() => lists.create(`${active.name} copy`, active.entries))}
            title={watchlists.length >= MAX_LISTS ? `That is the limit of ${MAX_LISTS} watchlists.` : undefined}
          >
            Duplicate
          </button>

          {/* No confirmation dialog: a list is a handful of tickers and a name, the symbols are
              on screen while you delete it, and the app refuses to delete the last one. */}
          <button
            type="button"
            disabled={busy || watchlists.length === 1}
            onClick={() => run(() => lists.remove(active.id))}
            title={watchlists.length === 1 ? 'Your only watchlist — empty it instead.' : undefined}
          >
            Delete list
          </button>
        </div>
      )}

      {listProblem && <p className="error small">{listProblem}</p>}

      <form className="add-row" onSubmit={add}>
        <label>
          <span className="muted small">Ticker</span>
          <input
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              setProblem(null);
              setPending(null);
            }}
            placeholder="SPY"
            className="w-symbol"
            maxLength={6}
            autoComplete="off"
            spellCheck="false"
            aria-invalid={problem ? 'true' : undefined}
          />
        </label>

        <label className="grow">
          <span className="muted small">Note (optional)</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why it is on the list"
            maxLength={200}
          />
        </label>

        <button type="submit" className="primary" disabled={checking || !SYMBOL_PATTERN.test(typed.trim().toUpperCase())}>
          {checking ? 'Checking…' : 'Add'}
        </button>
      </form>

      {problem && (
        <p className="error small">
          {problem}
          {pending && (
            <button type="button" className="link-button" onClick={() => add(null, true)}>
              Add {pending.symbol} anyway
            </button>
          )}
        </p>
      )}

      {watchlist.length === 0 ? (
        <p className="muted">
          Nothing on {active ? `“${active.name}”` : 'this list'}. Add a ticker above — until then a
          scan has nothing to look at.
        </p>
      ) : (
        <div className="scroll-x">
          <table className="watchlist-table">
            <caption className="muted small">
              Scanned in this order. Prices come from the same cache as a scan, so showing them
              here costs nothing extra.
            </caption>
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Symbol</th>
                <th scope="col" className="num">Last</th>
                <th scope="col">Note</th>
                <th scope="col">Earnings</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {watchlist.map((entry, index) => (
                <Row
                  key={entry.symbol}
                  entry={entry}
                  index={index}
                  last={index === watchlist.length - 1}
                  quote={quotes[entry.symbol]}
                  onMove={move}
                  onPatch={patch}
                  onRemove={remove}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * The active list's name, edited in place and saved when the field is left — the same way notes
 * are edited a few rows below, rather than a dialog for one text field.
 *
 * Keyed on the list id by its parent, so switching lists starts the field again rather than
 * carrying a half-typed name across.
 */
function ListName({ list, busy, onRename }) {
  const [name, setName] = useState(list.name);

  const commit = () => {
    const wanted = name.trim();
    if (!wanted || wanted === list.name) {
      setName(list.name); // an empty name is not a name; put back what it was called
      return;
    }
    onRename(wanted);
  };

  return (
    <label className="list-name">
      <span className="sr-only">Watchlist name</span>
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') setName(list.name);
        }}
        maxLength={MAX_NAME}
        disabled={busy}
        aria-label="Watchlist name"
      />
    </label>
  );
}

function Row({ entry, index, last, quote, onMove, onPatch, onRemove }) {
  // The note is held locally while it is being typed and committed on blur, so each keystroke is
  // not a save — and so the caret does not jump when the saved list comes back.
  const [note, setNote] = useState(entry.note ?? '');
  const committed = useRef(entry.note ?? '');

  useEffect(() => {
    if (entry.note !== committed.current) {
      committed.current = entry.note ?? '';
      setNote(entry.note ?? '');
    }
  }, [entry.note]);

  const commit = () => {
    if (note === committed.current) return;
    committed.current = note;
    onPatch(entry.symbol, { note });
  };

  return (
    <tr>
      <td className="order-cell">
        <span className="muted small">{index + 1}</span>
        <button type="button" className="link" disabled={index === 0} onClick={() => onMove(index, -1)} aria-label={`Move ${entry.symbol} up`}>
          ↑
        </button>
        <button type="button" className="link" disabled={last} onClick={() => onMove(index, 1)} aria-label={`Move ${entry.symbol} down`}>
          ↓
        </button>
      </td>

      <td>
        <a className="ticker-link" href={hrefFor('ticker', { symbol: entry.symbol })}>
          {entry.symbol}
        </a>
      </td>

      <td className="num">
        {quote === undefined ? (
          <span className="muted">…</span>
        ) : quote.error ? (
          <span className="tag warn" title={quote.error}>
            no quote
          </span>
        ) : (
          fmtPrice(quote.last)
        )}
      </td>

      <td className="note-cell">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          maxLength={200}
          aria-label={`Note for ${entry.symbol}`}
          placeholder="—"
        />
      </td>

      <td>
        <input
          type="date"
          className="earnings"
          value={entry.earnings ?? ''}
          onChange={(e) => onPatch(entry.symbol, { earnings: e.target.value || null })}
          aria-label={`Earnings date for ${entry.symbol}`}
          title="Expiries after this date get flagged on every candidate"
        />
      </td>

      <td className="row-actions">
        {/* Every row's buttons read "Remove"; the label is what tells a screen reader which
            row it is on, and it is what a test can address the row by. */}
        <a
          className="link-button"
          href={hrefFor('simulator', { symbol: entry.symbol })}
          aria-label={`Simulate a position on ${entry.symbol}`}
        >
          Simulate
        </a>
        <button type="button" onClick={() => onRemove(entry.symbol)} aria-label={`Remove ${entry.symbol}`}>
          Remove
        </button>
      </td>
    </tr>
  );
}
