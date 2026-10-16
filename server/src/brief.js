// The pre-market brief: gathering the data, running the rules, and deciding when to do it.
//
// The rules themselves are in domain/brief.js and are pure. This file is the plumbing around
// them — which accounts to run for, what to fetch, what to store, and how to behave on a host
// that does not stay awake.
//
// ON SCHEDULING, HONESTLY. There are two ways a brief can appear at 9am and this does both,
// because neither is sufficient alone:
//
//   • A timer, checked every few minutes while the process is up. Precise enough for a brief and
//     indifferent to being started at an odd moment.
//   • Generation on demand, the first time the page is opened and today's brief is missing.
//
// The second exists because Render's free instances sleep after fifteen minutes of no traffic,
// and a sleeping process runs no timers. Without the on-demand path the brief would simply not
// exist on most mornings — the timer would fire reliably only on a paid instance. With it, the
// worst case is that the brief is computed when you open the page rather than before you did,
// which you would not be able to tell apart anyway.

import { dueBriefDay, findings as detectFindings, marketParts } from './domain/brief.js';

/** How many daily bars to judge "a normal day for this symbol" against. */
const HISTORY_DAYS = 90;

/** A ceiling on the provider work one brief can do, whatever the watchlist's length. */
const MAX_SYMBOLS = 25;

/** Regenerations per account per day, so a refresh button is not an open tap on the bill. */
export const MAX_RUNS_PER_DAY = 5;

/**
 * @param options
 *   store     the settings/positions/briefs store
 *   scanner   for quotes and history, so the brief shares the scan's cache
 *   enrich    the tracker's live-data pass — reused rather than reimplemented, so the brief
 *             cannot drift from what the Positions page shows
 *   advisor   null without a key, in which case briefs are findings with no prose
 *   now       injectable clock, so the tests can stand at 8:59 on a Friday
 */
export function createBriefer({ store, scanner, enrich, advisor, now = () => new Date() }) {
  /**
   * Fetches what the rules need and runs them. No model call, no storage — separated so the
   * tests can assert on findings without a stub of the Messages API in the way.
   */
  async function collect(userId, tradingDay) {
    const [positions, state] = await Promise.all([store.listPositions(userId), store.read(userId)]);
    const watchlist = state.watchlist ?? [];

    const enriched = await enrich(positions, tradingDay);

    // Quotes and histories only for the names that could produce a "moved" finding: the ones on
    // the watchlist that are not already spoken for by a position.
    const held = new Set(enriched.filter((p) => p.status === 'open').map((p) => p.symbol));
    const wanted = watchlist.map((e) => e.symbol).filter((s) => !held.has(s)).slice(0, MAX_SYMBOLS);

    const quotes = new Map();
    const histories = new Map();

    const start = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);

    for (const symbol of wanted) {
      // Per symbol, failing soft: one delisted ticker should cost its own line, not the brief.
      try {
        quotes.set(symbol, await scanner.quote(symbol));
        histories.set(symbol, await scanner.history(symbol, { start, end: tradingDay, interval: 'daily' }));
      } catch {
        quotes.delete(symbol);
        histories.delete(symbol);
      }
    }

    return detectFindings({ positions: enriched, watchlist, quotes, histories, asOf: tradingDay });
  }

  /**
   * Builds and stores the brief for one account and one trading day.
   *
   * The findings are stored whether or not the prose succeeds. A model that is down, rate-limited
   * or unconfigured must not cost you the list — which is the whole reason the detection does not
   * live inside the prompt.
   */
  async function generate(userId, tradingDay) {
    const list = await collect(userId, tradingDay);

    let summary = null;
    let model = null;
    let ungrounded = [];

    if (advisor) {
      try {
        const written = await advisor.summarise({ findings: list, asOf: tradingDay });
        summary = written.summary;
        model = written.model;
        ungrounded = written.ungrounded;
      } catch (error) {
        // Logged, not raised, and not shown as an error on the page: the brief still has
        // everything that matters in it.
        console.error(`brief summary failed for ${tradingDay}:`, error.message);
      }
    }

    return store.saveBrief(userId, tradingDay, { findings: list, summary, model, ungrounded });
  }

  return {
    /** The day a brief should exist for right now, in market time. */
    dueDay: () => dueBriefDay(now()),

    /**
     * Today's brief, generating it if this is the first ask since nine o'clock.
     *
     * `force` is the refresh button, capped per day. Null before 9am on the first weekday of a
     * session's life, which the page renders as "the next one is due at 9".
     */
    async forUser(userId, { force = false } = {}) {
      const day = dueBriefDay(now());
      if (!day) return null;

      const existing = await store.readBrief(userId, day);

      // A brief is a snapshot of nine o'clock on ITS OWN day. If the day it belongs to is not
      // today — a weekend, or before nine on a weekday, when the current brief is still
      // yesterday's — then it is shown if it was written and otherwise not at all. Building it
      // now would stamp yesterday's date on this morning's prices, which is worse than an empty
      // panel: it would look like a record of a morning that was never examined.
      if (day !== marketParts(now()).day) return existing ?? null;

      if (existing && !force) return existing;
      if (existing && force && existing.runs >= MAX_RUNS_PER_DAY) {
        const error = new Error(`That is ${MAX_RUNS_PER_DAY} refreshes today — tomorrow's brief is a new one.`);
        error.status = 429;
        throw error;
      }

      return generate(userId, day);
    },

    /**
     * The timer. Every account that has something to say about gets its brief written once the
     * clock passes nine, without waiting for anyone to open the page.
     *
     * Accounts with neither a position nor a watchlist are skipped: a brief about nothing is a
     * model call about nothing.
     */
    async run({ userIds }) {
      const day = dueBriefDay(now());

      // Same rule as forUser: only ever write the current day's. A tick at the weekend finds
      // Friday's day due, and must not overwrite Friday's brief with Saturday's prices.
      if (!day || day !== marketParts(now()).day) return { day: null, written: 0 };

      let written = 0;
      for (const userId of userIds) {
        try {
          if (await store.readBrief(userId, day)) continue;

          const [positions, state] = await Promise.all([store.listPositions(userId), store.read(userId)]);
          if (positions.filter((p) => p.status === 'open').length === 0 && (state.watchlist ?? []).length === 0) {
            continue;
          }

          await generate(userId, day);
          written += 1;
        } catch (error) {
          // One account's failure is not the others'.
          console.error(`brief failed for ${userId}:`, error.message);
        }
      }

      return { day, written };
    },

    collect,
    generate,
  };
}

/**
 * Starts the timer, and returns the function that stops it.
 *
 * Every fifteen minutes rather than at nine exactly, because a process that was asleep at nine
 * should write the brief when it wakes rather than wait until tomorrow — and because `run` is
 * idempotent, a tick that finds the brief already written costs one indexed lookup per account.
 * `unref` so this never holds the process open on its own.
 */
export function startBriefTimer(briefer, { usersOf, everyMs = 15 * 60_000 } = {}) {
  const tick = async () => {
    try {
      await briefer.run({ userIds: await usersOf() });
    } catch (error) {
      console.error('brief timer failed:', error.message);
    }
  };

  const timer = setInterval(tick, everyMs);
  timer.unref?.();

  // One run at startup, after a short delay: a deploy at 9:05 should produce the morning's brief
  // rather than the first visitor's. The delay keeps it off the critical path of booting.
  const first = setTimeout(tick, 20_000);
  first.unref?.();

  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
