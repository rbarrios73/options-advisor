// Watchlist and saved filters, persisted as one JSON file.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { DEFAULT_FILTERS } from './domain/strategies.js';
import { DEFAULT_WEIGHTS } from './domain/score.js';

const DEFAULT_STATE = {
  watchlist: [
    { symbol: 'SPY', note: 'Index proxy — tight chains, weekly expiries' },
    { symbol: 'QQQ', note: '' },
    { symbol: 'AAPL', note: '' },
  ],
  filters: DEFAULT_FILTERS,
  weights: DEFAULT_WEIGHTS,
};

export function createStore(file) {
  let cache = null;

  async function read() {
    if (cache) return cache;
    try {
      cache = JSON.parse(await readFile(file, 'utf8'));
      // Merge in any keys added since the file was written, so an old file never breaks a scan.
      cache = {
        ...DEFAULT_STATE,
        ...cache,
        filters: { ...DEFAULT_FILTERS, ...(cache.filters ?? {}) },
        weights: { ...DEFAULT_WEIGHTS, ...(cache.weights ?? {}) },
      };
    } catch {
      cache = structuredClone(DEFAULT_STATE);
    }
    return cache;
  }

  async function write(next) {
    cache = next;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  return {
    read,
    async update(patch) {
      const current = await read();
      return write({ ...current, ...patch });
    },
    async setWatchlist(watchlist) {
      const current = await read();
      return write({ ...current, watchlist });
    },
  };
}
