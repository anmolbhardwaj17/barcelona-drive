/**
 * bushCards.js — photographic crossed-quad bushes. The undergrowth half of the card work.
 *
 * WHY NOW. The tree cards made the canopy photographic and left the undergrowth as three
 * overlapping dodecahedrons tinted flat green. On a street that was tolerable — bushes are small and
 * mostly behind parked cars. Once the generated woodland filled the hillsides it stopped being
 * tolerable: a wooded slope is mostly NOT tree canopy at eye level, so the blobs became the first
 * thing you look at.
 *
 * Everything structural is shared with the trees — the crossed-quad geometry and dome normals
 * (cardMesh.js), the sway (treeWind.js), the double-sided flip cancel and the night constants
 * (treeCards.js). Only the atlas and the sizes are different, which is the whole point: six bushes
 * and six trees that were built by two separate code paths would not sit in the same scene.
 */
import * as THREE from 'three';
import { patchMaterial } from './materialRegistry.js';
import { injectTreeWind } from './treeWind.js';
import { buildCardGeometry, loadCardAtlas } from './cardMesh.js';
import { patchCardFaceDirection, onCardNightTint, CARD_NIGHT_TINT, NIGHT_LIGHT_FRACTION } from './treeCards.js';
import MANIFEST from './bushAtlas.js';

const ATLAS_ALBEDO = '/textures/vegetation/bush_atlas_albedo.png';
const ATLAS_NORMAL = '/textures/vegetation/bush_atlas_normal.png';

export const BUSH_CARD_SPECIES = MANIFEST.species;
export const BUSH_CARD_COUNT = MANIFEST.species.length;

// Slightly above the trees' 0.4. A bush is small on screen and its silhouette is mostly edge, so a
// lower threshold leaves a halo of half-transparent texels around the whole shape rather than in a
// canopy's interior gaps where it reads as depth.
const BUSH_ALPHA_TEST = 0.45;

let _geometries = null;
let _material = null;
let _tex = null;

function atlas() {
  if (!_tex) _tex = loadCardAtlas(ATLAS_ALBEDO, ATLAS_NORMAL);
  return _tex;
}

/** Card geometry per species, indexed by variant index. Built once. */
export function buildBushCardGeometries() {
  if (_geometries) return _geometries;
  _geometries = BUSH_CARD_SPECIES.map(buildCardGeometry);
  return _geometries;
}

export function getBushCardMaterial() {
  if (_material) return _material;
  const { albedo, normal } = atlas();

  _material = new THREE.MeshLambertMaterial({
    map: albedo,
    normalMap: normal,
    emissiveMap: albedo,   // night lift must be modulated — see treeCards CARD_NIGHT_EMISSIVE
    alphaTest: BUSH_ALPHA_TEST,
    transparent: false,    // never blend: tens of thousands of quads, no early-z, full depth sort
    side: THREE.DoubleSide,
    vertexColors: false,   // per-instance tint arrives via BatchedMesh.setColorAt
  });
  // AD-5: the normal map is calibrated at bake into the §3.7 foliage band, which is what makes 1.0
  // correct here. The knob is reserved for LOD fade, never taste.
  _material.normalScale = new THREE.Vector2(1.0, 1.0);
  _applyNight(_material);

  patchMaterial(_material, (shader) => {
    injectTreeWind(shader);
    patchCardFaceDirection(shader);
  }, 'vegBushCard');

  // Bushes follow the trees' day/night state exactly. They are the same surface class under the
  // same sky; letting them drift apart is how the ground and the canopy stop looking lit by one sun.
  onCardNightTint((tint) => {
    if (_material && _night) _material.color.setRGB(tint[0], tint[1], tint[2]);
  });

  return _material;
}

let _night = false;
function _applyNight(m) {
  if (!m) return;
  if (_night) {
    m.color.setRGB(...CARD_NIGHT_TINT);
    m.emissive.setRGB(0.042, 0.050, 0.044);
  } else {
    m.color.setRGB(1, 1, 1);
    m.emissive.setRGB(0, 0, 0);
  }
}

export function setBushCardNightMode(isNight) {
  _night = isNight;
  _applyNight(_material);
}

export function _bushInternals() {
  return { BUSH_ALPHA_TEST, NIGHT_LIGHT_FRACTION };
}
