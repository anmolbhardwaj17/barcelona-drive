/**
 * The report crashed the first time it was asked for: groupVariants() read `v.tokens`, a field
 * noteVariant() never stored, so F9 threw "Cannot read properties of undefined (reading '0')" and
 * a 140-second drive produced nothing.
 *
 * That is D-35's lesson repeating — an instrument must be tested on the path that PRODUCES its
 * output, not just the path that collects data. Collecting worked fine for two builds. These tests
 * therefore always call buildReport()/digest(), which is where it broke.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { armReport, noteVariant, noteLongFrame, buildReport, digest } from '../src/ui/driveReport.js';

// A real minified key: a patched material whose customProgramCacheKey tail contains commas.
const PATCHED = 'lambert,highp,srgb-linear,false,,false,0,true,1,0,2,2,1,0,1,0,0,1024,132099,srgb,(l,u)=>{a&&a(l,u),e(l,u)}|roadAO+lightGrid';
const PLAIN   = 'basic,highp,srgb,false,,uv,false,0,true,1,0,2,2,1,0,1,0,0,262144,5123,srgb,onBeforeCompile(){}';

armReport([{ cacheKey: PLAIN }], { timeToDriveMs: 22032 });
noteLongFrame({ wall: 66.5, sections: { rend: 40, hud: 12 }, gpu: 7.1, heap: 240, alloc: { rend: 3.5 } });
// The case a token-SET diff structurally cannot see: one field moved, to a value that already
// appears elsewhere in the very same key. Nothing is novel; the combination is.
const SHIFTED = PLAIN.replace(',false,', ',true,');

noteVariant(2, PATCHED);
noteVariant(3, PLAIN);          // identical to the warm baseline — nothing novel to say about it
noteVariant(4, undefined);      // three can hand us a program with no cacheKey
noteVariant(5, SHIFTED);

test('building the report does not throw — this is the path that broke', () => {
  const r = buildReport({ trigger: 'test' });
  assert.equal(typeof digest(r), 'string');
});

test('a comma-bearing patch tag is not torn into fragments', () => {
  const r = buildReport();
  const causes = r.shaders.byCause.map((g) => g.cause).join(' | ');
  assert.ok(causes.includes('roadAO+lightGrid'), `tag should survive intact, got: ${causes}`);
  assert.ok(!causes.includes('u)}'), `function body should be collapsed, got: ${causes}`);
});

test('a key identical to a warm one is called a recompile, not a new variant', () => {
  // This is the distinction that matters: 124 late programs all reporting "no novel token" were
  // not new variants at all. Saying so plainly is the difference between a lead and a dead end.
  const r = buildReport();
  const dull = r.shaders.byCause.find((g) => g.cause.includes('recompiled, not new'));
  assert.ok(dull, 'a byte-identical late program should be named as a recompile');
  assert.match(dull.cause, /^basic/, 'it should lead with the material type');
});

test('a one-field difference is named by position, not written off as unexplained', () => {
  const g = buildReport().shaders.byCause.find((x) => /#\d+ /.test(x.cause));
  assert.ok(g, 'the group should be named by the position that moved');
  assert.match(g.cause, /#3 false→true/, `expected the field that moved, got: ${g && g.cause}`);
});

test('a missing cacheKey is recorded rather than crashing the report', () => {
  const r = buildReport();
  assert.equal(r.shaders.compiledWhileDriving, 4);
});

test('the digest carries time-to-drive, the number the load work is measured by', () => {
  const d = digest(buildReport());
  assert.match(d, /time-to-drive 22\.0s/);
});

test('the digest survives having nothing to report', () => {
  // buildReport on a fresh module would be empty; here just prove the frame half formats.
  const d = digest(buildReport());
  assert.match(d, /FRAMES\s+1 long/);
});

test('arming discards anything recorded before it — the count means "while driving"', () => {
  // The bug this holds shut: the watcher runs from the first frame, so without a reset the warm-up's
  // own programs were reported as compiles that happened while driving. A drive said "+124" when the
  // honest number was 32.
  noteVariant(100, 'basic,highp,srgb,recorded-before-arming');
  noteLongFrame({ wall: 999, sections: { rend: 999 } });

  armReport([{ cacheKey: PLAIN }], { timeToDriveMs: 1000 });

  const r = buildReport();
  assert.equal(r.shaders.compiledWhileDriving, 0, 'pre-arm variants must not survive arming');
  assert.equal(r.frames.longFrames, 0, 'pre-arm long frames must not survive arming either');
});


// ── Both ways of shipping a report must carry the same thing ────────────────────────────────────

test('F9 and window._ddReport go through ONE wrapper, so neither can carry less', () => {
  // The tile builder's per-phase totals were wired into `window._ddReport` first, and F9 kept
  // calling `shipReport` directly — so pressing the key would have produced a report missing the
  // largest cost in the game. Same shape as the two disposal branches (D-56) and the seven
  // road-field copies (D-46): a fix applied to one of two entry points.
  const src = fs.readFileSync('src/main.js', 'utf8');
  const direct = (src.match(/(?<!_reportWith)\bshipReport\s*\(/g) || []).length;
  assert.equal(direct, 1,
    `main.js calls shipReport() directly ${direct} times — it must be exactly once, inside the ` +
    `_reportWithBuild wrapper, with F9 and window._ddReport both routed through that.`);
  assert.match(src, /F9'\s*\)\s*\{[^}]*_reportWithBuild\(/,
    'the F9 handler must call _reportWithBuild, not shipReport');
});

test('the report carries a top-level build section, not a meta field', () => {
  // Buried in `meta` it reads as a note about the run. It is the biggest cost in the game and it is
  // ASYNC, so no `sections` entry can ever show it — it needs to be somewhere a reader looks.
  const src = fs.readFileSync('src/ui/driveReport.js', 'utf8');
  assert.match(src, /build:\s*\{\s*phases:/, 'buildReport must emit a top-level `build.phases`');
  assert.match(src, /const \{ buildPhases, \.\.\.restExtra \} = extra/,
    'buildPhases must be hoisted OUT of extra, or it lands in meta as well');
});
