// Light or dark, and who decides.
//
// Three choices rather than two: "system" is the honest default, because a machine already knows
// whether its owner wants light or dark and the app should not be the one thing that ignores it.
// The two explicit choices exist for the cases the OS setting gets wrong — a dark-themed laptop
// in a bright room, a bright one at night.
//
// In domain/ because both sides need it: the server validates what it stores, the browser decides
// what to paint, and one spelling of 'system' is what keeps those two agreeing.

export const THEMES = ['light', 'dark', 'system'];

/**
 * What the Appearance menu offers. 'system' is still a valid stored value — it is the default,
 * what every visitor has until they choose — but it is not offered as a choice: the menu shows
 * the light or dark it resolved to, and picking either one makes it explicit.
 */
export const PICKABLE_THEMES = ['light', 'dark'];

/** What an account that has never chosen gets. */
export const DEFAULT_THEME = 'system';

/** The key the browser stores the choice under, so the first paint can read it synchronously. */
export const THEME_STORAGE_KEY = 'oa-theme';

export const THEME_LABELS = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

/** A stored or posted value, or the default — never undefined, so nothing downstream guards. */
export function cleanTheme(value) {
  return THEMES.includes(value) ? value : DEFAULT_THEME;
}

/**
 * The theme to actually paint: 'light' or 'dark', never 'system'.
 *
 * `prefersDark` is what the OS says. Resolving here rather than in the stylesheet means the same
 * answer drives the `data-theme` stamp, the `color-scheme` and anything that has to know which
 * way round it is — a second implementation in CSS is a second thing to keep in step.
 */
export function resolveTheme(preference, prefersDark) {
  const choice = cleanTheme(preference);
  if (choice !== 'system') return choice;
  return prefersDark ? 'dark' : 'light';
}
