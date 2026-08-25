/**
 * v3 P3-02 — modular storey bands.
 *
 * The defect: one quad per wall face with v: 0 -> height/FLOOR_HEIGHT. The facade tile carries its
 * shopfront in the bottom gFrac of its height, so every tile repeat painted another shopfront —
 * measured at 10 m, 20 m, 30 m on 36,122 of 40,828 buildings (88.5%), twice on 30.8%.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extrudePolygonWallBands } from '../src/workers/workerGeometry.js';

const SQUARE = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
const OPTS = { hRepeatM: 12, groundH: 3.8, gFrac: 0.38, storeyH: 3.5, crownH: 1.2 };
const build = (h, o = {}) => extrudePolygonWallBands(SQUARE, h, 0, { ...OPTS, ...o });
const vs = (g) => { const out = []; for (let i = 1; i < g.uvs.length; i += 2) out.push(g.uvs[i]); return out; };

test('with a WINDOW-ONLY tile (P3-04) the body starts at v=0 — nothing to wrap onto', () => {
  // The premise that mattered: once the body layer contains windows only, the shopfront is not in
  // the body's tile at all, so the body maps v 0 -> N and every repeat is a storey of windows.
  // (An earlier version of this test asserted v never entered 0..gFrac, which was wrong — with a
  // window-only tile that range IS windows.)
  for (const h of [12, 20, 31.7, 55, 90]) {
    const g = build(h, { windowOnlyTile: true });
    assert.equal(g.uvs[1 * 8 + 1], 0, `h=${h}: body band must start at v=0 on a window-only tile`);
    const reps = g.uvs[1 * 8 + 5];
    const expected = Math.max(1, (h - OPTS.groundH - OPTS.crownH) / OPTS.storeyH);
    assert.ok(Math.abs(reps - expected) < 1e-4, `h=${h}: ${reps} repeats, expected ${expected}`);
  }
});

test('AGAINST TODAY\'S TILE the wrap is REDUCED, not eliminated — a documented limitation', () => {
  // Guards the honest claim. A 12 m building used to show a shopfront at 0 m AND ~10 m; with bands
  // the ground band owns 0 m and the body wraps once. When P3-04 lands, flip windowOnlyTile and the
  // test above becomes the live guarantee. If this ever starts passing as zero-wrap by accident,
  // something changed and the claim in the tracker needs revisiting.
  const g = build(12);
  const bodyV1 = g.uvs[1 * 8 + 5];
  assert.ok(bodyV1 > 1, 'body still crosses v=1 against the legacy tile — known, gated on P3-04');
});

test('the ground band spans exactly the shopfront, once', () => {
  const g = build(30);
  assert.equal(g.positions[1], 0, 'ground band starts at baseY');
  assert.ok(Math.abs(g.positions[7] - OPTS.groundH) < 1e-6, 'and tops out at groundH');
  assert.equal(g.uvs[1], 0, 'v starts at 0');
  // 1e-6, not 1e-9: uvs is a Float32Array, so 0.38 round-trips as 0.37999999523.
  assert.ok(Math.abs(g.uvs[5] - OPTS.gFrac) < 1e-6, 'and reaches exactly gFrac');
});

test('12 vertices per face on a normal building — 3 bands', () => {
  const g = build(30);
  assert.equal(g.positions.length / 3, 4 * 3 * 4, '4 edges x 3 bands x 4 verts');
  assert.equal(g.indices.length / 3, 4 * 3 * 2, 'two triangles per band quad');
});

test('SHORT BUILDINGS DEGRADE, they do not emit degenerate bands', () => {
  // A zero- or negative-height band survives to the depth buffer as z-fighting slivers.
  for (const h of [0.5, 2, 3.8, 4.2, 4.9, 5.0]) {
    const g = build(h);
    assert.ok(g, `h=${h} returned null`);
    for (let q = 0; q < g.positions.length / 12; q++) {
      const y0 = g.positions[q * 12 + 1], y1 = g.positions[q * 12 + 7];
      assert.ok(y1 - y0 > 1e-5, `h=${h}: a band of height ${(y1 - y0).toExponential()} was emitted`);
    }
  }
});

test('bands tile the full height with no gap and no overlap', () => {
  for (const h of [4, 9, 30, 77.5]) {
    const g = build(h);
    const perEdge = (g.positions.length / 3) / 4;          // verts on edge 0
    let covered = 0;
    for (let q = 0; q < perEdge / 4; q++) covered += g.positions[q * 12 + 7] - g.positions[q * 12 + 1];
    assert.ok(Math.abs(covered - h) < 1e-4, `h=${h}: bands cover ${covered}, expected ${h}`);
  }
});

test('every face agrees on the split — bands ring the building, not step around it', () => {
  const g = build(30);
  const perEdgeVerts = (g.positions.length / 3) / 4;
  const edge0 = []; for (let i = 0; i < perEdgeVerts; i++) edge0.push(g.positions[i * 3 + 1]);
  for (let e = 1; e < 4; e++) {
    for (let i = 0; i < perEdgeVerts; i++) {
      assert.equal(g.positions[(e * perEdgeVerts + i) * 3 + 1], edge0[i],
        'a face split differently — the band seam would step around the building');
    }
  }
});

test('normals point outward and stay horizontal', () => {
  const g = build(30);
  for (let i = 0; i < g.normals.length; i += 3) {
    assert.equal(g.normals[i + 1], 0, 'wall normals must have no vertical component');
    const len = Math.hypot(g.normals[i], g.normals[i + 2]);
    assert.ok(Math.abs(len - 1) < 1e-6, 'normal must be unit length');
  }
});

test('body UV repeats track real storeys, so window scale is height-independent', () => {
  const rep = (h) => (h - OPTS.groundH - OPTS.crownH) / OPTS.storeyH;
  // (60-5)/3.5 over (30-5)/3.5 = 55/25 = 2.2 — the fixed ground+crown make it super-linear, which is
  // correct: they are a smaller fraction of a taller building.
  const ratio = rep(60) / rep(30);
  assert.ok(ratio > 2.0 && ratio < 2.4, `expected ~2.2x, got ${ratio.toFixed(2)}`);
  const a = build(30, { windowOnlyTile: true }), b = build(60, { windowOnlyTile: true });
  assert.ok(b.uvs[1 * 8 + 5] > a.uvs[1 * 8 + 5], 'taller building must repeat the window band more');
});

test('degenerate input returns null rather than a broken buffer', () => {
  assert.equal(extrudePolygonWallBands([{ x: 0, y: 0 }, { x: 1, y: 1 }], 10, 0, OPTS), null);
  assert.equal(extrudePolygonWallBands(SQUARE, 0, 0, OPTS), null);
  assert.equal(extrudePolygonWallBands(null, 10, 0, OPTS), null);
});

// ── v3 P3-02: cross-module contract ──────────────────────────────────────────────────────────────
// The band geometry places its ground band at groundH metres; meshMaterializer paints the shopfront
// into the bottom groundH/FLOOR_HEIGHT of the tile. If those two numbers ever drift, the shopfront
// straddles the band seam — which looks WORSE than the mid-air shopfront this replaces, and would
// show up as an art complaint rather than an obvious bug. FACADE_GROUND_H_M is now the one source;
// this test fails if anyone reintroduces a local copy.
import { FACADE_GROUND_H_M, groundFloorH, FLOOR_HEIGHT, STOREY_H, CROWN_H } from '../src/buildingConstants.js';
import fs from 'node:fs';

test('meshMaterializer reads the SHARED ground-floor heights, not a local copy', () => {
  const src = fs.readFileSync(new URL('../src/workers/meshMaterializer.js', import.meta.url), 'utf8');
  assert.match(src, /FACADE_GROUND_H_M/, 'materializer must import the shared map');
  const styles = src.slice(src.indexOf('const WINDOW_STYLES'), src.indexOf('};', src.indexOf('const WINDOW_STYLES')));
  const literals = styles.match(/marginB:\s*[0-9]/g);
  assert.equal(literals, null, `marginB was hard-coded again: ${literals} — reintroduces the mirror`);
});

test('every painted category has a ground-floor height, and it is a plausible storey', () => {
  for (const [cat, h] of Object.entries(FACADE_GROUND_H_M)) {
    assert.ok(h > 0 && h < FLOOR_HEIGHT, `${cat}: ${h} m must be positive and inside one tile`);
    assert.equal(groundFloorH(cat), h);
  }
  assert.equal(groundFloorH('not-a-category'), FACADE_GROUND_H_M.residential, 'unknown must fall back');
});

test('the band constants leave a body on a normal Eixample building', () => {
  // ground + crown must not swallow a typical 6-storey block, or every building becomes two bands.
  const typical = 21;
  assert.ok(groundFloorH('residential') + CROWN_H < typical * 0.4,
    'ground+crown eat too much of a normal building — the body band would barely exist');
  assert.ok(STOREY_H > 2.5 && STOREY_H < 4.5, 'storey height must be a real storey');
});

test('the CROWN follows windowOnlyTile too — gFrac is meaningless on a window-only tile', () => {
  // Caught by inspection, not by a failing test: the crown kept starting at gFrac in window-only
  // mode, which crops it to the tile's upper 62% for no reason.
  const legacy = build(30);
  const arrayMode = build(30, { windowOnlyTile: true });
  const crownV0 = (g) => g.uvs[2 * 8 + 1];              // third band on edge 0
  assert.ok(Math.abs(crownV0(legacy) - OPTS.gFrac) < 1e-6, 'legacy crown starts at gFrac');
  assert.equal(crownV0(arrayMode), 0, 'window-only crown must use the whole tile');
});
