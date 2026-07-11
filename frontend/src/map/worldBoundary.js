/**
 * worldBoundary.js — the edge of the baked world (user call 2026-07-11: "typical game thing").
 *
 * Beyond the region bbox there is simply no data: no tiles, no terrain, a fall into void. Two
 * treatments make that read as an intentional boundary instead of a bug:
 *   1. HAZE CURTAINS: four tall gradient planes just inside the bbox — soft, noise-wobbled fog
 *      walls that fade with height (NOT a hard wall). Colour tracks scene fog → day/night correct.
 *   2. RETURN-TO-ROAD: main.js checks the car's lat/lon each frame; past the bbox (+ grace band)
 *      it fires carDriver.recoverToCrumb() — the breadcrumb is gated to in-bounds positions
 *      (carDriver opts.isCrumbSafe), so the car lands back on the last road it was on.
 *
 * REGION_BBOX MUST MATCH backend/worldBuilder config for the barcelona region
 * (bbox: minLon 2.1198, minLat 41.3580, maxLon 2.2230, maxLat 41.4130), INSET slightly because
 * edge tiles are partial — the boundary should arrive before the data visibly runs out.
 */
import * as THREE from 'three';
import { latLonToWorld, worldToLatLon } from '../projection.js';

const REGION_BBOX = { minLat: 41.3580, minLon: 2.1198, maxLat: 41.4130, maxLon: 2.2230 };
const INSET_DEG_LAT = 0.0012;   // ~130 m inside the bake edge
const INSET_DEG_LON = 0.0016;   // ~130 m at this latitude
const OUT_GRACE_M = 45;         // how far past the curtain the car may push before the teleport

const B = {
  minLat: REGION_BBOX.minLat + INSET_DEG_LAT,
  maxLat: REGION_BBOX.maxLat - INSET_DEG_LAT,
  minLon: REGION_BBOX.minLon + INSET_DEG_LON,
  maxLon: REGION_BBOX.maxLon - INSET_DEG_LON,
};

/** Is this physics-frame position (lx, lz) inside the playable area? (px = −worldX convention.) */
export function isInsidePlayArea(lx, lz) {
  const { lat, lon } = worldToLatLon(-lx, lz);
  return lat >= B.minLat && lat <= B.maxLat && lon >= B.minLon && lon <= B.maxLon;
}

/** How far (deg→~metres) past the boundary this physics-frame position is; 0 = inside. */
export function outOfBoundsM(lx, lz) {
  const { lat, lon } = worldToLatLon(-lx, lz);
  const dLat = Math.max(0, B.minLat - lat, lat - B.maxLat) * 111000;
  const dLon = Math.max(0, B.minLon - lon, lon - B.maxLon) * 111000 * Math.cos((lat * Math.PI) / 180);
  return Math.max(dLat, dLon);
}

export const BOUNDARY_GRACE_M = OUT_GRACE_M;

/**
 * Four haze curtains just inside the bbox. Vertical fade (opaque-ish at ground → gone by the top),
 * slow horizontal noise wobble so it reads as weather, not geometry. Call update(dt, fogColor)
 * each frame (cheap: one uniform write per curtain).
 */
export function createBoundaryHaze(worldGroup) {   // MUST be the mirrored worldGroup — the curtains
                                                   // use absolute world coords like tile meshes
  const sw = latLonToWorld(B.minLat, B.minLon);
  const ne = latLonToWorld(B.maxLat, B.maxLon);
  const minX = Math.min(sw.x, ne.x), maxX = Math.max(sw.x, ne.x);
  const minZ = Math.min(sw.z, ne.z), maxZ = Math.max(sw.z, ne.z);
  const HAZE_H = 110, Y0 = -10;

  const uniforms = {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(0xdfe8ef) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: `
      varying vec2 vUv;
      varying float vWorldX;
      varying float vWorldZ;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldX = wp.x; vWorldZ = wp.z;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uColor;
      varying vec2 vUv;
      varying float vWorldX;
      varying float vWorldZ;
      // cheap value noise — organic drift so the curtain doesn't read as a flat wall
      float n2(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      void main() {
        float along = (vWorldX + vWorldZ) * 0.004;
        float wob = n2(vec2(along * 3.0, uTime * 0.03)) * 0.5
                  + n2(vec2(along * 9.0 + 7.0, uTime * 0.05)) * 0.5;
        // vertical fade: dense at the base, gone by the top; wobble modulates the fade height
        float top = 0.55 + wob * 0.35;
        float a = smoothstep(top, 0.0, vUv.y) * 0.82;
        // soft flicker in density along the curtain
        a *= 0.75 + 0.25 * n2(vec2(along * 5.0 + 3.0, uTime * 0.04));
        gl_FragColor = vec4(uColor, a);
      }`,
  });

  const group = new THREE.Group();
  group.renderOrder = 5;   // over opaque world, under UI
  const mkCurtain = (w, x, z, rotY) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, HAZE_H), mat);
    m.position.set(x, Y0 + HAZE_H / 2, z);
    m.rotation.y = rotY;
    m.frustumCulled = true;
    group.add(m);
  };
  mkCurtain(maxX - minX, (minX + maxX) / 2, minZ, 0);              // south edge
  mkCurtain(maxX - minX, (minX + maxX) / 2, maxZ, 0);              // north edge
  mkCurtain(maxZ - minZ, minX, (minZ + maxZ) / 2, Math.PI / 2);    // west edge
  mkCurtain(maxZ - minZ, maxX, (minZ + maxZ) / 2, Math.PI / 2);    // east edge
  worldGroup.add(group);

  return {
    group,
    update(dt, fogColor) {
      uniforms.uTime.value += dt;
      if (fogColor) uniforms.uColor.value.lerp(fogColor, 0.05);
    },
  };
}
