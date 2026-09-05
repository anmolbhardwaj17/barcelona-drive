/**
 * Window resize — the canvas must follow the window.
 *
 * User, 2026-09-05: going fullscreen kept the game at its windowed size with dead space below it.
 * Two independent links were broken and either alone would have kept it broken:
 *
 *   1. `adaptiveResolution.apply()` called `renderer.setSize(w, h, false)` — updateStyle FALSE —
 *      for every resize. That is correct for an adaptive-resolution change (same box on screen,
 *      fewer pixels in it) and wrong for a window resize, where the box itself changed.
 *
 *   2. `#app` had no CSS size. Once the canvas is inside it, a plain block div's height IS its
 *      content — the canvas's inline height, which the renderer wrote. So the resize handler read
 *      the canvas's stale size back out of its own parent and set it to itself.
 *
 * Neither is visible in a unit test, so these are source-level guards. They are cheap and this is a
 * regression that hides until someone maximises a window.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const adaptive = readFileSync(new URL('../src/ui/adaptiveResolution.js', import.meta.url), 'utf8');

test('#app has a size of its own, so clientWidth/Height are not circular', () => {
  assert.match(html, /#app\s*\{[^}]*position:\s*fixed/,
    '#app must not take its height from the canvas it contains');
  assert.match(html, /#app\s*\{[^}]*inset:\s*0/);
});

test('a WINDOW resize updates the canvas style; an adaptive change does not', () => {
  assert.match(adaptive, /setSize\(nw, nh\)\s*\{[^}]*apply\(true\)/,
    'the resize handler must restyle the canvas');
  assert.match(adaptive, /function apply\(updateStyle = false\)/,
    'adaptive probes must default to backing-buffer only');
  assert.match(adaptive, /renderer\.setSize\(w, h, updateStyle\)/,
    'setSize must honour the flag rather than hardcoding it');
});

test('the renderer size still falls back when the container has no layout yet', () => {
  // At startup #app is empty and clientHeight is 0; the fallback is what makes the FIRST size right.
  const scene = readFileSync(new URL('../src/scene.js', import.meta.url), 'utf8');
  assert.match(scene, /container\.clientWidth \|\| window\.innerWidth/);
});
