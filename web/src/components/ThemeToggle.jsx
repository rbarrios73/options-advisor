import { useEffect, useState } from 'react';

import { PICKABLE_THEMES, THEME_LABELS, prefersDark, resolveTheme, watchSystemTheme } from '../theme.js';

import { tr } from '../i18n.js';
/**
 * Light or Dark.
 *
 * Someone who has never chosen follows their computer (the stored 'system' default), and the menu
 * shows which of the two that came out as rather than a third "System" entry. Picking either one
 * makes it an explicit choice from then on.
 *
 * It lives in the top bar rather than on the Account page because the Account page does not exist
 * when the app runs without a database, and a preference you can only reach while signed in is a
 * preference the sign-in screen cannot honour.
 */
export default function ThemeToggle({ value, onChange }) {
  // Tracked so the menu moves with the computer while the choice is still the default — a
  // machine that turns dark at sunset should not leave the menu saying "Light".
  const [dark, setDark] = useState(prefersDark);
  useEffect(() => watchSystemTheme(setDark), []);

  const shown = resolveTheme(value, dark);

  return (
    <label className="theme-toggle">
      <span className="sr-only">{tr('Appearance')}</span>
      <select value={shown} onChange={(event) => onChange(event.target.value)} aria-label={tr('Appearance')}>
        {PICKABLE_THEMES.map((theme) => (
          <option key={theme} value={theme}>
            {tr(THEME_LABELS[theme])}
          </option>
        ))}
      </select>
    </label>
  );
}
