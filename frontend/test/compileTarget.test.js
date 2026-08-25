/**
 * Every shader program's cache key carries the OUTPUT COLOUR SPACE, which three reads from the
 * bound render target: null (the canvas) gives `srgb`, a WebGLRenderTarget gives `srgb-linear`.
 * The game draws exclusively through composer.render(), into the composer's linear target — so any
 * compile with nothing bound builds a parallel set of programs the session never draws.
 *
 * That bug was fixed once, at the boot warm-up, and MISSED at the second call site (the debounced
 * lightGrid recompile). The result was measured on a drive: the warm-up compiled 150 programs
 * correctly, and 1.9 s later the other site recompiled the whole scene in the wrong colour space —
 * 224 programs in one 50 ms burst, 70 of them inside a long frame.
 *
 * The fix is one helper. This test holds the rule that keeps it one helper, because two call sites
 * drifting apart is exactly what happened.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // strip comments

test('renderer.compileAsync has exactly one call site', () => {
  const calls = code.match(/renderer\.compileAsync/g) || [];
  assert.equal(calls.length, 1,
    `compileAsync must only be called from compileForComposer(); found ${calls.length} call sites`);
});

test('that call site binds the composer target and restores it in a finally', () => {
  const fn = code.match(/function compileForComposer\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fn, 'compileForComposer() should exist');
  const body = fn[0];
  assert.match(body, /setRenderTarget\(\s*composer\.renderTarget1/, 'must bind the composer target');
  assert.match(body, /finally\s*\{[\s\S]*setRenderTarget\(\s*prev\s*\)/,
    'must restore the previous target in a finally — a frame rendered with it bound draws to the wrong place');
  assert.match(body, /renderer\.compileAsync/, 'and it should be the thing doing the compiling');
});

test('both compile paths go through the helper', () => {
  const uses = code.match(/compileForComposer\(\)/g) || [];
  assert.ok(uses.length >= 2,
    `expected the warm-up and the lightGrid recompile to both use it; found ${uses.length}`);
});
