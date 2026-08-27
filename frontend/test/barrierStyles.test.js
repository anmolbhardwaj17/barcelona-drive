/**
 * R-B2 · BARRIER STYLES — a sandbox, because these cannot be checked by driving.
 *
 * Four styles that must be distinguishable at speed: a solid parapet on a bridge deck, a concrete
 * New Jersey barrier on a ronda, a steel W-beam guardrail on a ramp, and slim dark ironwork on a
 * city median. Every failure mode here is visual and none of them throws — a style that silently
 * builds the same geometry as another, a post floating above its wall, a barrier taller than a car
 * window, a city street getting a motorway barrier.
 *
 * So each style is BUILT and its actual dimensions measured, rather than its config inspected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { emitGuardRailRun } from '../src/map/roadRenderer.js';

const STYLES = ['parapet', 'jersey', 'guardrail', 'pedestrian'];

/** Build one straight 40 m run in a given style and measure what actually came out. */
function build(style) {
  const inner = [], outer = [];
  for (let i = 0; i <= 10; i++) {
    inner.push({ x: i * 4, y: 0, z: 2.0 });
    outer.push({ x: i * 4, y: 0, z: 2.25 });
  }
  const wall = [], posts = [], beams = [];
  emitGuardRailRun(inner, outer, inner.map(() => 5), 5, wall, posts, beams, style);
  const bbox = (geos) => {
    if (!geos.length) return null;
    const box = new THREE.Box3();
    for (const g of geos) { g.computeBoundingBox(); box.union(g.boundingBox); }
    return box;
  };
  const tris = (geos) => geos.reduce((a, g) => a + (g.getIndex() ? g.getIndex().count / 3 : 0), 0);
  return {
    wallTris: tris(wall), postTris: tris(posts), beamTris: tris(beams),
    wallBox: bbox(wall), postBox: bbox(posts), beamBox: bbox(beams),
    totalTris: tris(wall) + tris(posts) + tris(beams),
  };
}

test('SANDBOX — every style builds, and the profile is printed for review', () => {
  const rows = [];
  for (const st of STYLES) {
    const b = build(st);
    const top = Math.max(b.wallBox?.max.y ?? 0, b.postBox?.max.y ?? 0, b.beamBox?.max.y ?? 0);
    rows.push(`${st.padEnd(11)} top ${top.toFixed(2)} m · wall ${(b.wallBox?.max.y ?? 0).toFixed(2)} m ` +
              `· tris wall ${String(b.wallTris).padStart(3)} post ${String(b.postTris).padStart(4)} ` +
              `beam ${String(b.beamTris).padStart(4)} = ${b.totalTris} per 40 m`);
    assert.ok(b.totalTris > 0, `${st} produced no geometry at all`);
  }
  console.log('\n  barrier profiles (40 m run):\n    ' + rows.join('\n    ') + '\n');
});

test('each style is geometrically DISTINCT — none silently duplicates another', () => {
  const sig = new Map();
  for (const st of STYLES) {
    const b = build(st);
    const top = Math.max(b.wallBox?.max.y ?? 0, b.postBox?.max.y ?? 0, b.beamBox?.max.y ?? 0);
    const k = `${(b.wallBox?.max.y ?? 0).toFixed(2)}|${b.postTris}|${b.beamTris}|${top.toFixed(2)}`;
    assert.ok(!sig.has(k), `${st} is identical to ${sig.get(k)} — the styles would be indistinguishable`);
    sig.set(k, st);
  }
});

test('solid styles carry NO posts — that is most of the triangle budget', () => {
  for (const st of ['parapet', 'jersey']) {
    const b = build(st);
    assert.equal(b.postTris, 0, `${st} should be solid to the top, not posted`);
    assert.equal(b.beamTris, 0, `${st} should have no beam`);
    assert.ok(b.wallTris > 0, `${st} needs its wall`);
  }
});

test('a pedestrian railing has NO concrete — posts and rails only', () => {
  const b = build('pedestrian');
  assert.equal(b.wallTris, 0, 'a city median railing must not ship a concrete wall');
  assert.ok(b.postTris > 0 && b.beamTris > 0, 'it is posts + rails');
});

test('posts sit ON their wall, never floating above or sunk into it', () => {
  // guardrail is the only style with BOTH. If the post base used a constant instead of the style
  // wall height, the posts would hover — silently, and only visible from the pavement.
  const b = build('guardrail');
  const wallTop = b.wallBox.max.y;
  const postBottom = b.postBox.min.y;
  assert.ok(Math.abs(postBottom - wallTop) < 0.02,
    `posts start at ${postBottom.toFixed(2)} m but the wall ends at ${wallTop.toFixed(2)} m — they float`);
});

test('no barrier is taller than a driver can see over', () => {
  // A barrier above ~1.2 m blocks the view from a car and makes a street feel like a trench.
  for (const st of STYLES) {
    const b = build(st);
    const top = Math.max(b.wallBox?.max.y ?? 0, b.postBox?.max.y ?? 0, b.beamBox?.max.y ?? 0);
    // 0.7 m floor: below that it is a kerb or a trip hazard, not a barrier. The pedestrian style
    // first shipped at 0.42 m and a laxer threshold here let it through.
    assert.ok(top >= 0.7, `${st} at ${top.toFixed(2)} m is too low to be a barrier — kerb height`);
    assert.ok(top <= 1.25, `${st} at ${top.toFixed(2)} m would wall the driver in`);
  }
});

test('style selection is deterministic and matches Barcelona practice', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync('src/map/roadRenderer.js', 'utf8'));
  const fn = src.slice(src.indexOf('function pickBarrierStyle'), src.indexOf('export function emitGuardRailRun'));
  assert.match(fn, /road\.bridge.*parapet/s, 'a bridge deck gets a parapet');
  assert.match(fn, /motorway.*jersey/s, 'a ronda gets New Jersey concrete');
  assert.match(fn, /isRamp.*guardrail/s, 'a ramp gets a steel guardrail');
  assert.match(fn, /return 'pedestrian'/, 'an urban street falls through to slim ironwork');
  // nothing random, nothing time-dependent — R-0
  assert.doesNotMatch(fn, /Math\.random|Date\.now/, 'selection must be deterministic');
});

test('every barrier colour sits inside its SURFACE CLASS band, not merely near an anchor', async () => {
  // The mistake this pins, made three times now (toldos, shop signs, and these): a colour can pass
  // ΔE against an anchor and still be plainly wrong, because ΔE does not catch a value that is too
  // dark or too bright. The pedestrian ironwork shipped at ΔE 6.51 against `carriageway_grey` while
  // sitting at L* 26.4 — eighteen points below the `metal` floor of 44 — and read as near-black.
  const src = await import('node:fs').then((fs) => fs.readFileSync('src/map/roadRenderer.js', 'utf8'));
  const block = src.slice(src.indexOf('const BARRIER_STYLES = {'), src.indexOf('function pickBarrierStyle'));

  // sRGB -> L*, enough to check the band without pulling in a colour library.
  const toL = ([r, g, b]) => {
    const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const Y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
  };
  const triples = [...block.matchAll(/(wallC|postC):\s*\[([\d.]+),\s*([\d.]+),\s*([\d.]+)\]/g)]
    .map((m) => ({ kind: m[1], rgb: [+m[2], +m[3], +m[4]] }));
  assert.ok(triples.length >= 5, `expected every style's colour, found ${triples.length}`);

  for (const t of triples) {
    const L = toL(t.rgb);
    // wallC is concrete (sidewalk class 62±9); postC is steel/iron (metal class 58±14). Widened by
    // a few points because these are PRE-GRADED values, which sit slightly below their target.
    const [lo, hi] = t.kind === 'wallC' ? [49, 75] : [40, 76];
    assert.ok(L >= lo && L <= hi,
      `${t.kind} at L* ${L.toFixed(1)} is outside ${lo}..${hi} — too ${L < lo ? 'DARK' : 'BRIGHT'} for its class`);
  }
});
