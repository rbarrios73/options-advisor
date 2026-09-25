const json = async (response) => {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  return body;
};

const send = (path, method, body) =>
  fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then(json);

export const api = {
  // Who is signed in. Always answers — "nobody" is a valid answer and is how the app knows to
  // show the sign-in screen rather than an error.
  me: () => fetch('/api/me').then(json),
  login: (email, password) => send('/api/login', 'POST', { email, password }),
  logout: () => send('/api/logout', 'POST'),
  changePassword: (currentPassword, newPassword) => send('/api/password', 'POST', { currentPassword, newPassword }),

  listUsers: () => fetch('/api/users').then(json),
  createUser: (user) => send('/api/users', 'POST', user),
  updateUser: (id, changes) => send(`/api/users/${encodeURIComponent(id)}`, 'PATCH', changes),
  deleteUser: (id) => fetch(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(json),

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

  quote: (symbol) => fetch(`/api/quote?symbol=${encodeURIComponent(symbol)}`).then(json),

  history: (symbol, range) =>
    fetch(`/api/history?symbol=${encodeURIComponent(symbol)}&range=${encodeURIComponent(range)}`).then(json),

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
