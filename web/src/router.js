// A hash router, which is all two pages need.
//
// The route lives after the # so that a link like  #/simulator?symbol=SPY&exp=2026-10-23&short=540
// can be bookmarked or sent to someone, and the server never sees it — so there is nothing to
// configure on Render and the password gate is not asked to understand client-side paths.

import { useEffect, useState } from 'react';

export const PAGES = {
  screener: { label: 'Screener' },
  simulator: { label: 'Simulator' },
};

export function parseHash(hash = window.location.hash) {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  const page = PAGES[path] ? path : 'screener';
  return { page, params: Object.fromEntries(new URLSearchParams(query)) };
}

export function hrefFor(page, params = {}) {
  const clean = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  const query = new URLSearchParams(clean).toString();
  return `#/${page}${query ? `?${query}` : ''}`;
}

export function navigate(page, params) {
  window.location.hash = hrefFor(page, params);
}

/**
 * Keeps the address bar in step with page state without adding a history entry for every slider
 * tick — back should leave the page, not undo a drag.
 */
export function replaceParams(page, params) {
  const next = hrefFor(page, params);
  if (window.location.hash !== next) window.history.replaceState(null, '', next);
}

export function useRoute() {
  const [route, setRoute] = useState(() => parseHash());

  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}
