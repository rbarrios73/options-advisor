// Applying the theme in the browser: reading the stored choice, stamping it on <html>, and
// keeping the stamp in step when the OS flips underneath you.
//
// The rules themselves live in @domain/theme.js, shared with the server. This file is only the
// browser's half: storage, the DOM, and the media query.

import { DEFAULT_THEME, THEME_STORAGE_KEY, cleanTheme, resolveTheme } from '@domain/theme.js';

export { THEMES, THEME_LABELS, DEFAULT_THEME, cleanTheme, resolveTheme } from '@domain/theme.js';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * The choice this browser last saw.
 *
 * Wrapped because localStorage throws rather than returning null in a private window and
 * wherever site data is blocked — and a theme is not worth a blank page.
 */
export function readStoredTheme() {
  try {
    return cleanTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

export function storeTheme(preference) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, cleanTheme(preference));
  } catch {
    // A viewer who blocks storage still gets the theme for this visit; it just will not survive
    // a reload. Nothing else in the app depends on it, so there is nothing to recover from.
  }
}

export const prefersDark = () => window.matchMedia?.(DARK_QUERY).matches ?? false;

/**
 * Stamps the resolved theme on <html>.
 *
 * `data-theme` is always one of 'light' or 'dark' — never 'system' — because the stylesheet's
 * job is to paint, not to work out what the OS wanted. The preference is kept separately for the
 * control to show, and so that a machine flipping to dark at sunset still moves a viewer who
 * chose "system".
 */
export function applyTheme(preference) {
  const resolved = resolveTheme(preference, prefersDark());
  document.documentElement.dataset.theme = resolved;

  // The browser's own chrome — the address bar on a phone, the frame around the tab. index.html
  // sets this for the first paint; switching theme afterwards has to move it too, or a dark app
  // sits under a light address bar for the rest of the visit.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', resolved === 'dark' ? DARK_PLANE : LIGHT_PLANE);

  return resolved;
}

// The page plane in each theme, kept beside the stylesheet's --bg. Two values rather than reading
// the computed style: this runs before a repaint, when the old theme's value is still current.
const DARK_PLANE = '#0f1216';
const LIGHT_PLANE = '#f4f6f8';

/**
 * Calls back when the OS preference changes. Only matters while the choice is "system", which is
 * the caller's business — this just reports the change.
 */
export function watchSystemTheme(onChange) {
  const query = window.matchMedia?.(DARK_QUERY);
  if (!query) return () => {};

  const handler = (event) => onChange(event.matches);
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}
