// Which language a visitor is offered before they have chosen one.
//
// By country, from the address the request came from: a visitor from Mexico or Spain gets Spanish,
// everyone else English. This is a first guess and nothing more — the switch in the header
// overrides it, and the browser remembers that choice, so someone in Madrid who prefers English
// is asked once.
//
// The country comes from the CDN's header when there is one (Cloudflare sets cf-ipcountry), and
// otherwise from a small table bundled with the app, so no visitor's address is ever sent to a
// third-party lookup service. The table is IP2Location LITE's, by way of the ip3country package:
// this product includes IP2Location LITE data available from https://lite.ip2location.com.
// It covers IPv4; an IPv6 visitor falls back to the languages their browser asks for.

import ip3country from 'ip3country';

export const LANGS = ['en', 'es'];

/** Where Spanish is the language most people read. Puerto Rico and Equatorial Guinea included. */
export const SPANISH_COUNTRIES = new Set([
  'ES', 'MX', 'AR', 'CO', 'CL', 'PE', 'VE', 'EC', 'GT', 'CU', 'BO', 'DO', 'HN', 'PY', 'SV', 'NI', 'CR', 'PA', 'UY', 'PR', 'GQ',
]);

let ready = false;

/** The two-letter country for an address, or null when it is private, IPv6 or unknown. */
export function countryOfIp(ip) {
  // Express writes an IPv4 client on a dual-stack socket as ::ffff:203.0.113.9.
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(String(ip ?? ''))?.[1];
  if (!v4) return null;
  try {
    if (!ready) {
      ip3country.init();
      ready = true;
    }
    const code = ip3country.lookupStr(v4);
    return /^[A-Z]{2}$/.test(code ?? '') ? code : null;
  } catch {
    return null; // a lookup that fails must never fail the request
  }
}

/** The first language in an Accept-Language header that the app speaks, or null. */
export function langFromHeader(header) {
  const wanted = String(header ?? '')
    .split(',')
    .map((part) => {
      const [tag, q] = part.trim().split(';q=');
      return { lang: tag.slice(0, 2).toLowerCase(), q: q === undefined ? 1 : Number(q) };
    })
    .filter((w) => w.q > 0)
    .sort((a, b) => b.q - a.q);
  return wanted.find((w) => LANGS.includes(w.lang))?.lang ?? null;
}

/**
 * { lang, country, from } for a request. `from` says which evidence decided it — 'country' or
 * 'browser' — or 'default' when there was none.
 */
export function suggestLanguage(req) {
  const header = String(req.headers?.['cf-ipcountry'] ?? '').toUpperCase();
  // Cloudflare writes XX for unknown and T1 for Tor; neither is a country.
  const country = /^[A-Z]{2}$/.test(header) && header !== 'XX' ? header : countryOfIp(req.ip);

  if (country) return { lang: SPANISH_COUNTRIES.has(country) ? 'es' : 'en', country, from: 'country' };

  const browser = langFromHeader(req.headers?.['accept-language']);
  return browser ? { lang: browser, country: null, from: 'browser' } : { lang: 'en', country: null, from: 'default' };
}
