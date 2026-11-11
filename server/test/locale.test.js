import assert from 'node:assert/strict';
import { test } from 'node:test';

import { countryOfIp, langFromHeader, suggestLanguage } from '../src/locale.js';

const req = (ip, headers = {}) => ({ ip, headers });

test('an address resolves to its country, and a private one to nothing', () => {
  assert.equal(countryOfIp('8.8.8.8'), 'US');
  assert.equal(countryOfIp('::ffff:8.8.8.8'), 'US');
  assert.equal(countryOfIp('127.0.0.1'), null);
  assert.equal(countryOfIp('10.1.2.3'), null);
  assert.equal(countryOfIp('2001:db8::1'), null);
  assert.equal(countryOfIp(undefined), null);
  assert.equal(countryOfIp('not an address'), null);
});

test('a visitor from a Spanish-speaking country is offered Spanish', () => {
  // 200.33.0.0/16 is allocated in Mexico; 193.146.0.0/16 to Spain's research network.
  assert.deepEqual(suggestLanguage(req('200.33.1.1')), { lang: 'es', country: 'MX', from: 'country' });
  assert.equal(suggestLanguage(req('193.146.1.1')).lang, 'es');
  assert.deepEqual(suggestLanguage(req('8.8.8.8')), { lang: 'en', country: 'US', from: 'country' });
});

test('the country outranks the browser language', () => {
  assert.equal(suggestLanguage(req('8.8.8.8', { 'accept-language': 'es-MX,es;q=0.9' })).lang, 'en');
  assert.equal(suggestLanguage(req('200.33.1.1', { 'accept-language': 'en-US' })).lang, 'es');
});

test("a CDN's country header is used when there is one", () => {
  assert.deepEqual(suggestLanguage(req('8.8.8.8', { 'cf-ipcountry': 'ar' })), { lang: 'es', country: 'AR', from: 'country' });
  // XX is Cloudflare for "unknown": fall through to the address.
  assert.equal(suggestLanguage(req('8.8.8.8', { 'cf-ipcountry': 'XX' })).country, 'US');
});

test('with no country, the browser language decides; with neither, English', () => {
  assert.deepEqual(suggestLanguage(req('127.0.0.1', { 'accept-language': 'fr-FR,es;q=0.8,en;q=0.5' })), {
    lang: 'es',
    country: null,
    from: 'browser',
  });
  assert.deepEqual(suggestLanguage(req('127.0.0.1')), { lang: 'en', country: null, from: 'default' });
  assert.equal(langFromHeader('de, pt;q=0.9'), null);
  assert.equal(langFromHeader('en;q=0, es;q=0.3'), 'es');
});
