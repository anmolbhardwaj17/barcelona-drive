#!/usr/bin/env node
/**
 * lint-canvas.mjs — the canvas-texture retirement ratchet (v3 P1-06).
 *
 * The v3 art library replaces procedurally-drawn CanvasTextures with authored KTX2 maps. That
 * migration takes until P4, so the count has to fall monotonically rather than all at once — and
 * without a ratchet it will not fall at all, because every domain assumes "the foundation" owns
 * these and the foundation budgeted zero days for them.
 *
 * This asserts a per-file BUDGET. Adding a CanvasTexture to a file at its budget fails the build.
 * Retiring one means LOWERING the number here in the same commit — the ratchet only turns one way.
 *
 *   node scripts/lint-canvas.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// file -> max allowed. Lower these as textures are retired; never raise one without an ADR.
const BUDGET = {
  'workers/meshMaterializer.js':  6,   // facade windows + night emissive atlases → P3 facade array
  'map/roadRenderer.js':          5,   // markings/paint atlases              → P3 road material
  'map/buildingRenderer.js':      5,   // LOD + night window atlas            → P3/P4
  'scene.js':                     4,   // cloud, moon, moon glow, stars       → P4 sky (2 KTX2 keys)
  'map/urbanFeatureRenderer.js':  3,   // fountain/hydrant/misc props         → P4 prop atlas
  'map/roadInfraRenderer.js':     3,   // signs, boards, arrows               → P4 sign atlas
  'map/vegetationRenderer.js':    2,   // billboard atlas                     → P4 foliage atlas
  'map/generate-road-atlas.js':   2,   // build-time tool, not shipped        → exempt in practice
  'ui/carShowcase.js':            1,
  'tunnelDebugOverlay.js':        1,   // debug-only
  'map/tunnelRenderer.js':        1,
  'map/streetlightRenderer.js':   1,   // ground-pool glow                    → P2/P4 (see lightPoolDecal)
  'map/shopSignRenderer.js':      1,   // shop fascia text                    → P4 sign text page
  'map/busStopRenderer.js':       1,
  'map/barrierRenderer.js':       1,
  'car/contactShadows.js':        1,   // blob shadow — cheap, may stay
  'car/carModel.js':              1,
  'car/carEffects.js':            1,
};

const ROOT = new URL('../src/', import.meta.url).pathname;
const NEEDLE = 'new THREE.CanvasTexture';

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.js')) out.push(p);
  }
  return out;
}

let total = 0, fail = false;
const seen = new Set();
for (const abs of walk(ROOT)) {
  const rel = abs.slice(ROOT.length);
  const n = readFileSync(abs, 'utf8').split(NEEDLE).length - 1;
  if (!n) continue;
  total += n;
  seen.add(rel);
  const cap = BUDGET[rel];
  if (cap === undefined) {
    console.error(`✗ ${rel}: ${n} CanvasTexture(s) in a file with NO budget entry.\n` +
      `  Adding new canvas textures works against the v3 art library. If this is genuinely needed,\n` +
      `  add it to BUDGET in scripts/lint-canvas.mjs with a note saying which phase retires it.`);
    fail = true;
  } else if (n > cap) {
    console.error(`✗ ${rel}: ${n} CanvasTexture(s), budget ${cap}. The ratchet only turns one way.`);
    fail = true;
  }
}
for (const rel of Object.keys(BUDGET)) {
  if (!seen.has(rel)) console.warn(`· ${rel}: budgeted but no longer present — drop its BUDGET entry.`);
}

console.log(`${fail ? '✗' : '✓'} canvas textures: ${total} across ${seen.size} files ` +
            `(budget total ${Object.values(BUDGET).reduce((a, b) => a + b, 0)})`);
process.exit(fail ? 1 : 0);
