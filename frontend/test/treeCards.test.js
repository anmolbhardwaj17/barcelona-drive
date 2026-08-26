/**
 * v3 P3-10 — photographic tree cards.
 *
 * The failures these guard against are all SILENT ones: a variant-count mismatch deletes trees
 * without a warning, a UV that spans the whole cell shrinks a tree without an error, and a three
 * upgrade that renames one shader chunk turns every card black on its far side while still
 * compiling cleanly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONFIG } from '../src/config.js';
import MANIFEST from '../src/map/treeAtlas.js';
import { buildTreeCardGeometries, TREE_CARD_SPECIES, TREE_CARD_COUNT, _cardInternals,
  patchCardFaceDirection, NIGHT_LIGHT_FRACTION } from '../src/map/treeCards.js';
import { buildProceduralTreeGeometries } from '../src/map/vegetationRenderer.js';
import * as rendererMod from '../src/map/vegetationRenderer.js';

test('variant count matches the geometry the renderer actually has — both switch positions', () => {
  // Cards on (the default under node: no location, so the URL switch falls through to true).
  assert.equal(CONFIG.TREE_CARDS, true);
  assert.equal(CONFIG.NUM_TREE_VARIANTS, buildTreeCardGeometries().length);
  // And the hardcoded legacy count in config.js still matches the real blob table. If someone adds
  // a fifth blob variant, this fails rather than ?treecards=0 quietly dropping it.
  assert.equal(buildProceduralTreeGeometries().length, 4);
});

test('every species card is 2 crossed quads standing on y=0 at its real height', () => {
  const geos = buildTreeCardGeometries();
  assert.equal(geos.length, TREE_CARD_COUNT);

  for (let i = 0; i < geos.length; i++) {
    const sp = TREE_CARD_SPECIES[i];
    const pos = geos[i].getAttribute('position');
    assert.equal(pos.count, 8, `${sp.name}: 8 verts (2 quads)`);
    assert.equal(geos[i].getIndex().count, 12, `${sp.name}: 4 triangles`);

    let minY = Infinity, maxY = -Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let v = 0; v < pos.count; v++) {
      minY = Math.min(minY, pos.getY(v)); maxY = Math.max(maxY, pos.getY(v));
      maxX = Math.max(maxX, pos.getX(v)); maxZ = Math.max(maxZ, pos.getZ(v));
    }
    // Stands on the ground: the pools place instances at terrain height, so a card that
    // straddles y=0 would sink half the trunk into the road.
    assert.equal(minY, 0, `${sp.name}: base at y=0`);
    assert.equal(maxY, sp.heightM, `${sp.name}: full height`);
    // Image proportions preserved — a stretched canopy is the most obvious card artefact there is.
    const w = sp.heightM * sp.aspect;
    assert.ok(Math.abs(maxX * 2 - w) < 1e-4, `${sp.name}: quad width from image aspect`);
    assert.ok(Math.abs(maxZ * 2 - w) < 1e-4, `${sp.name}: crossed quad matches`);
  }
});

test('card UVs stay inside their own atlas cell (no bleed into a neighbouring species)', () => {
  const geos = buildTreeCardGeometries();
  const [cellW, cellH] = [MANIFEST.cell * MANIFEST.cols, MANIFEST.cell * MANIFEST.rows];
  for (let i = 0; i < geos.length; i++) {
    const sp = TREE_CARD_SPECIES[i];
    const [u0, v0, du, dv] = sp.contentUV;
    // The content rect must sit within the full cell rect...
    const [cu, cv, cdu, cdv] = sp.uv;
    assert.ok(u0 >= cu - 1e-6 && u0 + du <= cu + cdu + 1e-6, `${sp.name}: content inside cell (u)`);
    assert.ok(v0 >= cv - 1e-6 && v0 + dv <= cv + cdv + 1e-6, `${sp.name}: content inside cell (v)`);
    // ...and the rect's pixel proportions must be the aspect the geometry was sized with, or the
    // card is stretched even though every individual number looks right.
    assert.ok(Math.abs((du * cellW) / (dv * cellH) - sp.aspect) < 2e-3, `${sp.name}: contentUV aspect`);

    const uv = geos[i].getAttribute('uv');
    for (let v = 0; v < uv.count; v++) {
      assert.ok(uv.getX(v) >= u0 - 1e-6 && uv.getX(v) <= u0 + du + 1e-6, `${sp.name}: u in cell`);
      assert.ok(uv.getY(v) >= v0 - 1e-6 && uv.getY(v) <= v0 + dv + 1e-6, `${sp.name}: v in cell`);
    }
  }
});

test('normals form an outward dome, never pointing back into the canopy', () => {
  const geos = buildTreeCardGeometries();
  for (let i = 0; i < geos.length; i++) {
    const sp = TREE_CARD_SPECIES[i];
    const pos = geos[i].getAttribute('position'), nrm = geos[i].getAttribute('normal');
    const cy = sp.heightM * _cardInternals().CANOPY_CENTRE_Y;
    for (let v = 0; v < pos.count; v++) {
      const n = [nrm.getX(v), nrm.getY(v), nrm.getZ(v)];
      assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-5, `${sp.name}: normal is unit length`);
      // Outward: the normal must have a positive component along (vertex - canopy centre).
      const r = [pos.getX(v), pos.getY(v) - cy, pos.getZ(v)];
      const dot = n[0] * r[0] + n[1] * r[1] + n[2] * r[2];
      assert.ok(dot > 0, `${sp.name}: normal points away from the canopy centre`);
    }
  }
});

test('the double-sided flip is actually cancelled in the shader three will compile', () => {
  // THIS TEST SHIPPED BROKEN ONCE AND MUST NOT AGAIN.
  //
  // The original version read node_modules/three/src/.../normal_fragment_begin.glsl.js and asserted
  // the string existed. It passed, the build passed, the shader compiled — and every card in the
  // city still darkened from behind, because `onBeforeCompile` hands you the shader with its
  // `#include <...>` directives UNRESOLVED. The chunk's text is simply not there yet, so the
  // replace no-opped. The test was asserting against a file the bundle does not even load.
  //
  // So drive the real function against a realistic pre-include shader and check the OUTPUT.
  const shader = { fragmentShader: 'void main() {\n#include <normal_fragment_begin>\n}' };
  assert.equal(patchCardFaceDirection(shader), true, 'patch reports success');
  assert.ok(shader.fragmentShader.includes('float faceDirection = 1.0;'), 'flip is cancelled');
  assert.ok(!shader.fragmentShader.includes('gl_FrontFacing'), 'no flip survives');
  assert.ok(!shader.fragmentShader.includes('#include <normal_fragment_begin>'), 'chunk expanded');
  // The rest of the chunk must survive — replacing the include with ONLY our line would delete the
  // normal calculation itself and every card would render with a garbage normal.
  assert.ok(shader.fragmentShader.includes('vec3 normal'), 'the rest of the chunk is intact');

  // And a material that does NOT contain the include must be reported as unpatchable, not silently
  // pass — that is the three-upgrade alarm.
  const bad = { fragmentShader: 'void main() {}' };
  assert.equal(patchCardFaceDirection(bad), false, 'missing include is reported, not swallowed');
});

test('night lift is modulated by the albedo, not flat', () => {
  // A constant emissive lifts every texel equally, so the canopy's own light and shade cancel and
  // the trees go flat pale mint — brighter than the facades behind them. Measured in-game.
  const src = fs.readFileSync('src/map/treeCards.js', 'utf8');
  assert.ok(/emissiveMap:\s*albedo/.test(src), 'night lift modulates by the canopy texture');
  // It must be declared at construction: adding emissiveMap later flips USE_EMISSIVEMAP and
  // recompiles every tree shader mid-drive, which G-53 forbids.
  const ctor = src.slice(src.indexOf('new THREE.MeshLambertMaterial'));
  assert.ok(ctor.slice(0, ctor.indexOf('});')).includes('emissiveMap'),
    'emissiveMap is set in the constructor, not assigned afterwards');
});

test('cards are alpha-tested cutouts, never blended', () => {
  // Blending tens of thousands of quads means a full per-frame depth sort and no early-z. This is
  // the single most expensive mistake available on this path, so it is asserted rather than trusted.
  const { CARD_ALPHA_TEST } = _cardInternals();
  assert.ok(CARD_ALPHA_TEST > 0 && CARD_ALPHA_TEST < 1);
  const src = fs.readFileSync('src/map/treeCards.js', 'utf8');
  assert.ok(/transparent:\s*false/.test(src), 'card material must not set transparent:true');
});

test('P3-10(c): impostor quads carry their own atlas cell and their species size', () => {
  // The collapse removed the per-variant bbUvOff uniform by baking the cell into geometry UVs. If
  // that bake is wrong every distant tree draws a slice of the wrong species — and it would look
  // like an art bug, not a wiring bug.
  const { getTreeBillboardGeometry } = require_renderer();
  for (let i = 0; i < TREE_CARD_COUNT; i++) {
    const sp = TREE_CARD_SPECIES[i];
    const geo = getTreeBillboardGeometry(i);
    const [u0, v0, du, dv] = sp.contentUV;
    const uv = geo.getAttribute('uv');
    for (let v = 0; v < uv.count; v++) {
      assert.ok(uv.getX(v) >= u0 - 1e-6 && uv.getX(v) <= u0 + du + 1e-6, `${sp.name}: impostor u in cell`);
      assert.ok(uv.getY(v) >= v0 - 1e-6 && uv.getY(v) <= v0 + dv + 1e-6, `${sp.name}: impostor v in cell`);
    }
    const pos = geo.getAttribute('position');
    let minY = Infinity, maxY = -Infinity;
    for (let v = 0; v < pos.count; v++) {
      minY = Math.min(minY, pos.getY(v)); maxY = Math.max(maxY, pos.getY(v));
    }
    assert.ok(Math.abs(minY) < 1e-4, `${sp.name}: impostor stands on y=0`);
    assert.ok(Math.abs(maxY - sp.heightM) < 1e-4, `${sp.name}: impostor matches card height`);
  }
  // Distinct cells: two species must not share a UV origin, which is what a stale cache would give.
  const origins = new Set();
  for (let i = 0; i < TREE_CARD_COUNT; i++) {
    const uv = getTreeBillboardGeometry(i).getAttribute('uv');
    origins.add(`${uv.getX(0).toFixed(5)},${uv.getY(0).toFixed(5)}`);
  }
  assert.equal(origins.size, TREE_CARD_COUNT, 'every impostor variant has its own cell');
});

test('P3-10(c): impostors are not blended', () => {
  // transparent:true pushed every distant tree through the sorted pass with no Z-rejection.
  const src = fs.readFileSync('src/map/vegetationRenderer.js', 'utf8');
  const block = src.slice(src.indexOf('export function getTreeBillboardMaterial()'));
  const mat = block.slice(0, block.indexOf('});'));
  assert.ok(/transparent:\s*false/.test(mat), 'impostor material must not blend');
  assert.ok(/alphaTest:/.test(mat), 'impostor material still cuts out');
});

function require_renderer() {
  return rendererMod;
}

test('night lift uses emissive, and stays below the lit facades behind it', () => {
  // Cards are lit MeshLambert: `color` multiplies incoming light, and at canopy height at night
  // that is ~0 (street lamps sit below the crowns pointing down). Multiplying zero stays zero, so
  // the lever must be emissive. It must also stay faint — a glowing tree is worse than a dark one.
  const e = _cardInternals().CARD_NIGHT_EMISSIVE;
  assert.equal(e.length, 3);
  for (const c of e) {
    assert.ok(c > 0, 'night emissive actually lifts');
    assert.ok(c < 0.15, 'night emissive stays a silhouette, not a light source');
  }
  // The albedo tint is the second lever: cancelling the double-sided flip lit the back half of
  // every canopy, so the cards got brighter at the same moment the lift landed. Tint pulls the lit
  // response down, emissive sets the floor. Both must be < 1 or night is brighter than day.
  const t = _cardInternals().CARD_NIGHT_TINT;
  assert.equal(t.length, 3);
  for (const c of t) assert.ok(c > 0 && c < 1, 'night tint darkens without crushing');

  const src = fs.readFileSync('src/map/treeCards.js', 'utf8');
  assert.ok(/setTreeCardNightMode/.test(src), 'night switch is exported');
  // G-53: the day/night SWITCH itself must only move a uniform. emissiveMap is allowed because it
  // is declared in the constructor (asserted separately) — the define is baked before the warm-up,
  // so toggling night never recompiles.
  const fn = src.slice(src.indexOf('function _applyCardNight'));
  assert.ok(!/emissiveMap|needsUpdate|defines/.test(fn.slice(0, fn.indexOf('\n}'))),
    'the night switch only sets a uniform');
});

test('LOD impostor night tint is DERIVED from the card tint, never picked separately', () => {
  // Impostors are unlit (albedo x tint); near cards are lit (albedo x tint x night light + floor).
  // Two equations, so two hand-picked tints cannot agree — and a tree that changes brightness as it
  // crosses the LOD band is what that disagreement looks like on screen.
  const src = fs.readFileSync('src/map/vegetationRenderer.js', 'utf8');
  assert.ok(/CARD_NIGHT_TINT\.map\(\(c\) => c \* NIGHT_LIGHT_FRACTION\)/.test(src),
    'impostor tint is derived from the card tint');
  assert.ok(!/BB_NIGHT_CARDS\s*=\s*\[/.test(src), 'no independently hand-picked card impostor tint');
  const f = _cardInternals().NIGHT_LIGHT_FRACTION ?? null;
  assert.ok(NIGHT_LIGHT_FRACTION > 0 && NIGHT_LIGHT_FRACTION < 1,
    'night light fraction darkens the unlit impostor toward the lit card');
});
