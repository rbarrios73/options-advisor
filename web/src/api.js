const json = async (response) => {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  return body;
};

export const api = {
  settings: () => fetch('/api/settings').then(json),

  saveWatchlist: (watchlist) =>
    fetch('/api/watchlist', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ watchlist }),
    }).then(json),

  saveFilters: (filters, weights) =>
    fetch('/api/filters', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filters, weights }),
    }).then(json),

  expirations: (symbol) =>
    fetch(`/api/expirations?symbol=${encodeURIComponent(symbol)}`).then(json),

  chain: (symbol, expiration) =>
    fetch(
      `/api/chain?symbol=${encodeURIComponent(symbol)}&expiration=${encodeURIComponent(expiration)}`,
    ).then(json),

  scan: (body) =>
    fetch('/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json),
};
