/**
 * aoSampler.js — runtime access to the baked sky-visibility AO grid (tile format v9).
 *
 * The bake stores PURE sky-view factors (uint8, 255 = fully open sky) on the same 128×128
 * lat/lon grid as the tile's elevation — see backend/worldBuilder/aoBaker.js. This module
 * turns that into (a) a bilinear world-XZ sampler and (b) the art-tuned AO multipliers the
 * renderers actually apply. Keeping the strength curves HERE (not in the bake) means look
 * tuning never needs a re-bake.
 *
 * Coordinate note: runtime geometry XZ ≡ bake-side world XZ (both are
 * (mercator − origin) × MERCATOR_UNSTRETCH), so sampling is a straight affine map from the
 * tile's lat/lon bounds — no origin/mirror handling needed here.
 */

import { latLonToWorld } from '../projection.js';
import { patchMaterial } from '../map/materialRegistry.js';   // v3 P1-03

// Perf A/B escape hatch: ?ao=off disables ALL AO consumption for the session (samplers return
// null → no attribute fills, no worker sampling). Baked grids still download; purely a runtime gate.
export const AO_DISABLED = typeof location !== 'undefined'
  && new URLSearchParams(location.search).get('ao') === 'off';

// ── Strength dials (tune from screenshots; higher = darker canyons) ─────────
// Round 2 (2026-07-11 screenshots): round-1 dials read almost invisible under the rally grade's
// brightening — raised strengths + lowered gamma so typical Eixample canyons (svf ≈ 0.5) darken
// ~20-25% while plazas (svf ≈ 0.9) stay within ~3% of untouched.
export const AO_TERRAIN_STRENGTH = 0.55;  // ground between buildings
export const AO_ROAD_STRENGTH = 0.52;     // asphalt/sidewalk/curbs (slightly lighter than raw ground —
                                          //  streets receive more bounce than dirt in reality)
export { AO_FACADE_STRENGTH } from '../buildingConstants.js';   // v3 P1-13: no longer mirrored
export const AO_GREEN_STRENGTH = 0.40;    // park/verge polygons. LOWER than terrain on purpose: green
                                          // ShapeGeometry only has vertices on the polygon OUTLINE
                                          // (which hugs the buildings), so sampled svf skews dark vs
                                          // the area average — _aoDebug measured mean 0.407 darkening
                                          // at 0.55 vs the adjacent roads' 0.199 (shadow-stripe look)
import { AO_GAMMA } from '../buildingConstants.js';   // v3 P1-13: no longer mirrored

/**
 * @param {{resolution:number, data:Uint8Array}|null} aoGrid  parsed tile aoGrid (null on pre-v9 tiles)
 * @param {{south:number, west:number, north:number, east:number}} bounds  the tile's elevation bounds
 * @returns {(wx:number, wz:number) => number} svfAt — sky-view factor 0..1 (1 = open sky).
 *   Returns null when the tile has no AO data, so callers can skip their whole pass.
 */
export function createAoSampler(aoGrid, bounds) {
  if (AO_DISABLED) return null;
  if (!aoGrid || !aoGrid.data || !aoGrid.resolution || !bounds) return null;
  const res = aoGrid.resolution;
  const data = aoGrid.data;
  if (data.length !== res * res) return null;

  const { south, west, north, east } = bounds;
  // Same affine lat/lon↔world linearization the baker uses (exact to <0.1% over a 500m tile).
  const sw = latLonToWorld(south, west);
  const se = latLonToWorld(south, east);
  const nw = latLonToWorld(north, west);
  const colPerX = (res - 1) / (se.x - sw.x);
  const rowPerZ = (res - 1) / (nw.z - sw.z);

  return function svfAt(wx, wz) {
    let c = (wx - sw.x) * colPerX;
    let r = (wz - sw.z) * rowPerZ;
    if (c < 0) c = 0; else if (c > res - 1) c = res - 1;
    if (r < 0) r = 0; else if (r > res - 1) r = res - 1;
    const c0 = c | 0, r0 = r | 0;
    const c1 = c0 < res - 1 ? c0 + 1 : c0, r1 = r0 < res - 1 ? r0 + 1 : r0;
    const fc = c - c0, fr = r - r0;
    const v00 = data[r0 * res + c0], v10 = data[r0 * res + c1];
    const v01 = data[r1 * res + c0], v11 = data[r1 * res + c1];
    return ((v00 * (1 - fc) + v10 * fc) * (1 - fr) + (v01 * (1 - fc) + v11 * fc) * fr) / 255;
  };
}

/** svf (0..1) → final colour multiplier for a given strength dial. */
export function aoMultiplier(svf, strength) {
  const occ = Math.pow(1 - svf, AO_GAMMA);
  return 1 - strength * occ;
}

/**
 * svf → darkening amount (1 − multiplier). Road/facade shaders use `rgb *= (1.0 − vAoDark)` so a
 * missing attribute (default 0 on meshes that never ran the AO pass) means "no darkening", never
 * "black" — the multiplier form would default to 0 and nuke unbaked meshes sharing the material.
 */
export function aoDarkening(svf, strength) {
  return strength * Math.pow(1 - svf, AO_GAMMA);
}

/**
 * ONE shared uniform scales every AO consumer at runtime (attributes stay baked): the night rig is
 * already dark, so full-strength AO on top can crush canyon floors to black. envToggle sets this
 * via setAoNightScale; tune AO_NIGHT_SCALE from night screenshots — instant, no tile rebuild.
 */
export const AO_NIGHT_SCALE = 0.55;
const _aoScaleUniform = { value: 1 };
export function setAoNightScale(isNight) { _aoScaleUniform.value = isNight ? AO_NIGHT_SCALE : 1; }

/** GLSL for the shared AO fragment multiply — used by every patch site so they stay identical. */
export const AO_FRAG_APPLY = 'diffuseColor.rgb *= (1.0 - vAoDark * uAoScale);';
export function bindAoScaleUniform(shader) { shader.uniforms.uAoScale = _aoScaleUniform; }

/**
 * Patch any built-in material to consume the per-vertex `aAO` DARKENING attribute (default 0 →
 * untouched). Same shader fragment as roadRenderer's patchRoadAO, for materials that
 * don't need the night-wash machinery (e.g. greens). Identical patch source on every call → three
 * shares one compiled program across all patched materials of a type.
 */
export function patchAoDarkening(mat) {
  patchMaterial(mat, (shader) => {
    bindAoScaleUniform(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAO;\nvarying float vAoDark;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAoDark = aAO;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uAoScale;\nvarying float vAoDark;')
      .replace('#include <color_fragment>', `#include <color_fragment>\n${AO_FRAG_APPLY}`);
  }, 'aoDarken');
  return mat;
}
