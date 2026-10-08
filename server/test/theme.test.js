import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_THEME,
  THEMES,
  THEME_LABELS,
  cleanTheme,
  resolveTheme,
} from '../src/domain/theme.js';

test('there are three choices, and the default defers to the machine', () => {
  assert.deepEqual(THEMES, ['light', 'dark', 'system']);
  assert.equal(DEFAULT_THEME, 'system');
  for (const theme of THEMES) assert.ok(THEME_LABELS[theme], theme);
});

test('anything that is not a choice becomes the default rather than undefined', () => {
  for (const theme of THEMES) assert.equal(cleanTheme(theme), theme);

  // A stored value from an older build, a typo in a request body, a null from empty storage —
  // all of them have to land somewhere paintable, because nothing downstream guards.
  for (const junk of ['Dark', 'blue', '', null, undefined, 0, {}, ['dark']]) {
    assert.equal(cleanTheme(junk), 'system', JSON.stringify(junk));
  }
});

test('resolving always answers light or dark — never "system"', () => {
  // The stylesheet paints; it does not interpret. Handing it "system" would mean a second
  // implementation of this decision in CSS, and two places to keep in step.
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
});

test('an explicit choice beats the machine, in both directions', () => {
  // The whole point of the two explicit options: a dark laptop in a bright room, a bright one
  // at night. If the OS could override them they would not be choices.
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});

test('a junk preference still resolves, following the machine', () => {
  assert.equal(resolveTheme(undefined, true), 'dark');
  assert.equal(resolveTheme('nonsense', false), 'light');
});
