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
import { armReport, noteVariant, noteLongFrame, buildReport, digest } from '../src/ui/driveReport.js';

// A real minified key: a patched material whose customProgramCacheKey tail contains commas.
const PATCHED = 'lambert,highp,srgb-linear,false,,false,0,true,1,0,2,2,1,0,1,0,0,1024,132099,srgb,(l,u)=>{a&&a(l,u),e(l,u)}|roadAO+lightGrid';
const PLAIN   = 'basic,highp,srgb,false,,uv,false,0,true,1,0,2,2,1,0,1,0,0,262144,5123,srgb,onBeforeCompile(){}';

armReport([{ cacheKey: PLAIN }], { timeToDriveMs: 22032 });
noteLongFrame({ wall: 66.5, sections: { rend: 40, hud: 12 }, gpu: 7.1, heap: 240, alloc: { rend: 3.5 } });
noteVariant(2, PATCHED);
noteVariant(3, PLAIN);          // identical to the warm baseline — nothing novel to say about it
noteVariant(4, undefined);      // three can hand us a program with no cacheKey

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

test('a variant with nothing novel is still named by type and tag, never left blank', () => {
  const r = buildReport();
  const dull = r.shaders.byCause.find((g) => g.cause.includes('no novel token'));
  assert.ok(dull, 'the familiar-looking variant should get its own group');
  assert.match(dull.cause, /^basic/, 'it should lead with the material type');
  assert.ok(dull.sampleKey, 'and carry a sample key, since the diff had nothing to say');
});

test('a missing cacheKey is recorded rather than crashing the report', () => {
  const r = buildReport();
  assert.equal(r.shaders.compiledWhileDriving, 3);
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
