/**
 * F — fullscreen, and the controls strip that tells you about it.
 *
 * A binding nobody is told about may as well not exist, which is why the strip is asserted here
 * alongside the handler. C had that problem already: V-14 added a third camera view and the strip
 * never mentioned it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

test('F is bound, and bound only once', () => {
  const hits = main.match(/e\.code === 'KeyF'/g) || [];
  assert.equal(hits.length, 1, 'KeyF should have exactly one handler');
  assert.match(main, /e\.code === 'KeyF'[^\n]*toggleFullscreen/);
});

test('fullscreen targets the DOCUMENT, not the canvas', () => {
  // The HUD — speedo, minimap, controls strip — is position:fixed on the BODY. Fullscreening the
  // canvas alone takes the game full and leaves every readout behind on a black page.
  assert.match(main, /documentElement\.requestFullscreen/);
  assert.doesNotMatch(main, /domElement\.requestFullscreen|canvas\.requestFullscreen/);
});

test('the optional call is resolved before .catch is chained', () => {
  // `requestFullscreen?.()` yields undefined when the method is missing, and `.catch` on undefined
  // THROWS — swapping a missing-API case for a real exception inside a keydown handler.
  assert.doesNotMatch(main, /requestFullscreen\?\.\(\)\.catch/,
    'chaining straight off the optional call throws when the API is absent');
  assert.match(main, /const req = document\.documentElement\.requestFullscreen\?\.\(\)/);
});

test('the controls strip lists the keys that exist', () => {
  const strip = main.match(/controlsStrip\.innerHTML = '([^']*)'/);
  assert.ok(strip, 'controls strip not found');
  for (const key of ['WASD', 'Space', 'H Horn', 'L Lights', 'C Camera', 'N Day/Night',
                     'F Fullscreen', 'R Recover', 'M Map', 'Esc Menu']) {
    assert.ok(strip[1].includes(key), `controls strip does not mention ${key}`);
  }
});
