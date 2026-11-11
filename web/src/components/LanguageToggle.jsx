import { LANGS, setLang, tr, useLang } from '../i18n.js';

/**
 * English or Spanish.
 *
 * The app picks one on a first visit from the country the visitor connects from; this is how they
 * overrule it. The choice is remembered in the browser, and from then on it wins over the guess —
 * someone in Mexico City who reads English is asked once, not on every visit.
 *
 * Two short buttons rather than a menu: there are two languages, the header is crowded, and "EN"
 * and "ES" read the same whichever of them you currently understand.
 */
export default function LanguageToggle() {
  const lang = useLang();

  return (
    <div className="lang-toggle" role="group" aria-label={tr('Language')}>
      {Object.entries(LANGS).map(([code, name]) => (
        <button
          key={code}
          type="button"
          lang={code}
          title={name}
          aria-label={name}
          aria-pressed={lang === code}
          className={lang === code ? 'on' : ''}
          onClick={() => setLang(code, { remember: true })}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
