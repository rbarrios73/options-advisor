// English and Spanish, with English as the source: tr('Sign in') returns the Spanish when the
// language is Spanish and a translation exists, and the English otherwise. So a string nobody has
// translated yet shows in English rather than as a key or a blank.
//
// Placeholders are positional — tr('Fetching {0}', [symbol]) — and a translation may be a function
// of the same arguments, for the places Spanish needs more than substitution (plurals, word
// order): es['{0} trade{1}'] = ([n]) => `${n} operaci${n === 1 ? 'ón' : 'ones'}`.
//
// The language is module state, not React state: formatters and domain labels need it too, and
// they are not components. App subscribes with useLang() and remounts the page on a change.

import { useSyncExternalStore } from 'react';

import { es } from './i18n.es.js';
import { esExtra, esPatterns } from './i18n.es.extra.js';

export const LANGS = { en: 'English', es: 'Español' };
const DICTS = { es: { ...es, ...esExtra } };
const PATTERNS = { es: esPatterns };
const STORAGE_KEY = 'tm:lang';

const listeners = new Set();

/** Strings asked for in Spanish that had no translation — read by the coverage check. */
export const missing = new Set();

export const getLang = () => lang;

/** 'es-MX' or 'en-US' — for dates. Numbers stay in US form: these are US-market prices. */
export const dateLocale = () => (lang === 'es' ? 'es-MX' : 'en-US');

export function setLang(next, { remember = false } = {}) {
  const clean = LANGS[next] ? next : 'en';
  if (remember) {
    try {
      window.localStorage.setItem(STORAGE_KEY, clean);
    } catch {
      // blocked storage: the choice lasts for this visit
    }
  }
  if (clean === lang) return;
  lang = clean;
  if (typeof document !== 'undefined') document.documentElement.lang = clean;
  listeners.forEach((fn) => fn());
}

/** The language this browser chose before, if it did. An explicit choice outranks the IP guess. */
export function rememberedLang() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return LANGS[saved] ? saved : null;
  } catch {
    return null;
  }
}

// Starts on the remembered choice so a returning visitor never sees a flash of the other language;
// a first-time visitor starts in English until the server's guess arrives with the session.
let lang = rememberedLang() ?? 'en';
if (typeof document !== 'undefined') document.documentElement.lang = lang;

export function useLang() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getLang,
    getLang,
  );
}

const fill = (text, args) => (args ? text.replace(/\{(\d+)\}/g, (m, i) => (args[i] ?? '')) : text);

// 'By##date' and 'By' are the same English word and two Spanish ones. The part after ## is only
// there to tell them apart; it is never shown.
const bare = (text) => (text.includes('##') ? text.slice(0, text.indexOf('##')) : text);

export function tr(text, args) {
  if (typeof text !== 'string') return text;
  if (lang === 'en') return fill(bare(text), args);

  const hit = DICTS[lang]?.[text];
  if (hit !== undefined) return typeof hit === 'function' ? hit(args ?? []) : fill(hit, args);

  // Sentences the domain code builds with numbers in them ("The 505 strike is 1.2% away…") cannot
  // be dictionary keys, so they are matched by shape instead.
  if (!args) {
    for (const [pattern, render] of PATTERNS[lang] ?? []) {
      const match = pattern.exec(text);
      if (match) return render(match);
    }
  }

  if (/[A-Za-z]{2}/.test(text)) missing.add(text);
  return fill(bare(text), args);
}

if (typeof window !== 'undefined') window.__i18nMissing = missing;
