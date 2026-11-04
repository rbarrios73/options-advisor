// The last scan, kept in this browser so the Screener opens on something instead of an empty page.
//
// Per person and per watchlist: one account's scan is not another's, and a scan of "Income" is
// not a scan of "Momentum". Kept in localStorage rather than on the server because the server
// sleeps after 15 minutes on the free tier and would forget it by the next morning.
//
// It is a convenience and nothing more. Storage can be full, blocked or wiped, so every access is
// wrapped and a failure means "nothing kept" — never an error over the page. And a restored scan
// is always shown with its age, because yesterday's credit is not today's.

const PREFIX = 'oa:lastScan:';

const keyFor = (userId, listId) => `${PREFIX}${userId ?? 'local'}:${listId ?? 'default'}`;

export function saveLastScan(userId, listId, result) {
  try {
    window.localStorage.setItem(keyFor(userId, listId), JSON.stringify(result));
  } catch {
    // full or blocked: the scan still shows, it just is not kept
  }
}

export function loadLastScan(userId, listId) {
  try {
    const raw = window.localStorage.getItem(keyFor(userId, listId));
    if (!raw) return null;
    const result = JSON.parse(raw);
    // Anything without the fields the page reads is from an older version, or not ours.
    if (!result?.generatedAt || !Array.isArray(result.candidates)) return null;
    return { ...result, restored: true };
  } catch {
    return null;
  }
}

/** On sign-out, so the next person at this browser does not open on your trades. */
export function forgetLastScans(userId) {
  try {
    const mine = `${PREFIX}${userId ?? 'local'}:`;
    const doomed = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(mine)) doomed.push(key);
    }
    doomed.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // nothing kept, nothing to forget
  }
}

/** How old a scan is, in words a person reads at a glance: "4 min", "2 h", "3 days". */
export function ageOf(iso, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Older than this, a scan's prices have moved enough to say so. */
export const STALE_AFTER_MS = 15 * 60_000;
