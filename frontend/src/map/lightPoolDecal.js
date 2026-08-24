/**
 * lightPoolDecal.js — the additive ground-glow decal, extracted (v3 P1-24).
 *
 * WHY THIS EXISTS AS ITS OWN MODULE. P2 deletes the streetlamp ground pools: `lightGrid.js` replaces
 * them with real clustered punctual lights, and 16 m glow quads at 22 m lamp spacing (>100% road
 * coverage, additive, depth-write off) are exactly the fake they exist to retire.
 *
 * But the MECHANISM is not the fake. A cheap additive ground decal is still the right tool for
 * things that will never justify a real light — vehicle headlight spill, hero-building glow, mode
 * markers. If the geometry and material live inside streetlightRenderer, P2 has to either delete
 * something two other systems still want, or leave the whole streetlight module alive to host two
 * constants.
 *
 * So: P2 deletes the streetlamp INSTANCES and their placement. It does not delete this.
 *
 * The pool TEXTURE stays in streetlightRenderer for now — it is a canvas texture on the P1-06
 * retirement register and will be replaced by an authored KTX2 map, at which point this module
 * takes ownership of the whole decal.
 */
import * as THREE from 'three';

const POOL_SIZE = 16;   // m across. Sized for falloff room; an 18 m plane fought sloped streets.

let _geom = null;

/**
 * Shared unit ground-quad, pre-rotated flat into XZ so instance matrices carry translation only.
 * One geometry for every consumer — never dispose it on tile unload.
 */
export function getLightPoolGeometry() {
  if (_geom) return _geom;
  _geom = new THREE.PlaneGeometry(POOL_SIZE, POOL_SIZE);
  _geom.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  _geom.userData.sharedGeometry = true;
  return _geom;
}

/**
 * Build an additive ground-glow material around a caller-supplied texture.
 *
 * ADDITIVE, not normal alpha: light ADDS to the surface it lands on. Alpha blending mixed the glow
 * toward grey at the edges and read as a translucent sticker rather than illumination — a recorded
 * finding, do not "simplify" it back.
 */
export function makeLightPoolMaterial(map, opacity = 0) {
  const mat = new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  mat.userData.sharedMaterial = true;
  return mat;
}

export { POOL_SIZE };
