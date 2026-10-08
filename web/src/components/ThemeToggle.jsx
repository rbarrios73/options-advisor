import { THEMES, THEME_LABELS } from '../theme.js';

/**
 * Light, Dark or System.
 *
 * A select rather than a cycling button: a button that rotates through three states makes you
 * click twice to find out what the third one is, and with "system" in the set there is no visual
 * cue for which of the three is current. Three named options say it outright.
 *
 * It lives in the top bar rather than on the Account page because the Account page does not exist
 * when the app runs without a database, and a preference you can only reach while signed in is a
 * preference the sign-in screen cannot honour.
 */
export default function ThemeToggle({ value, onChange }) {
  return (
    <label className="theme-toggle">
      <span className="sr-only">Appearance</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} aria-label="Appearance">
        {THEMES.map((theme) => (
          <option key={theme} value={theme}>
            {THEME_LABELS[theme]}
          </option>
        ))}
      </select>
    </label>
  );
}
