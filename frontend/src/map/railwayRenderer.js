/**
 * Railway renderer: flat ribbon meshes from OSM railway data.
 * Shared material with railway_01 texture. Layer-based elevation. No shadows.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { worldToLatLon } from '../projection.js';
import { SEA_LEVEL } from './waterRenderer.js';
import { BCN_COLORS, BCN_DIMS } from './barcelona-constants.js';

/** Global height constants (match road system). Railway above terrain to avoid z-fighting. */
const LAYER_HEIGHT_STEP = 6;
/** Railway Y offset: above terrain (0.07) and road (0.05) to prevent flickering. */
const RAILWAY_OFFSET = 0.07;
const RAILWAY_WIDTH = 2;
/** UV repeat: u = segmentLength/2 for sleeper pattern, v = 1. */
const RAILWAY_UV_REPEAT_M = 2;

/** Tram rail: sits just above road surface to avoid z-fight with asphalt. */
const TRAM_RAIL_Y_ABOVE = 0.005;
// Road surface constants — mirror roadRenderer.js ROAD_OFFSET + ROAD_VISUAL_ABOVE_TERRAIN.
// Trams are embedded in the road, not on a ballasted bed, so they use the road formula.
const _ROAD_OFFSET = 0.05;
const _ROAD_VISUAL  = 0.05;

/**
 * Compute per-point Y heights for tram rails at road surface + TRAM_RAIL_Y_ABOVE.
 * Uses road-surface formula: (baseY + _ROAD_OFFSET) * vertExag + _ROAD_VISUAL + TRAM_RAIL_Y_ABOVE.
 * Returns a number[] when getElevationAt is provided, or a scalar fallback.
 */
function getTramSurfaceHeights(pts, getElevationAt) {
  const scale = vertExag();
  // Returns road surface Y only — buildTramRailGeometry adds TRAM_RAIL_Y_ABOVE on top.
  const fallback = _ROAD_OFFSET * scale + _ROAD_VISUAL; // ~0.10 at scale=1
  if (!getElevationAt || !pts?.length) return fallback;
  return pts.map(p => {
    const { lat, lon } = worldToLatLon(p.x, p.y);
    let baseY = getElevationAt(lat, lon);
    if (!Number.isFinite(baseY)) baseY = 0;
    return (baseY + _ROAD_OFFSET) * scale + _ROAD_VISUAL; // road surface; +0.005 added in buildTramRailGeometry
  });
}
let _tramMaterial = null;
function getTramMaterial() {
  if (_tramMaterial) return _tramMaterial;
  _tramMaterial = new THREE.MeshLambertMaterial({ color: BCN_COLORS.TRAM_RAIL_STEEL });
  return _tramMaterial;
}

/** Offset a road-point array (each pt = {x, y} where y = world Z) by dist metres perpendicular. */
function _offsetPts(pts, dist) {
  return pts.map((pt, i) => {
    const prev = pts[i - 1] ?? pt;
    const next = pts[i + 1] ?? pt;
    const dx = next.x - prev.x;
    const dz = next.y - prev.y;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    return { x: pt.x + (-dz / len) * dist, y: pt.y + (dx / len) * dist };
  });
}

/**
 * Build a flat ribbon geometry for a tram rail (one of two parallel rails).
 * pts: [{x, y}] world coords; heights: number[] per-point road surface Y, or scalar.
 */
function buildTramRailGeometry(pts, heights) {
  if (!pts || pts.length < 2) return null;
  const W = BCN_DIMS.TRAM_RAIL_WIDTH; // 0.06m
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  let cumDist = 0;

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const prev = pts[i - 1] ?? p;
    const next = pts[i + 1] ?? p;
    const dx = next.x - prev.x, dz = next.y - prev.y;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const nx = -dz / len, nz = dx / len; // perpendicular normal in XZ plane
    const y = (Array.isArray(heights) ? heights[i] : heights) + TRAM_RAIL_Y_ABOVE;

    if (i > 0) {
      const pprev = pts[i - 1];
      cumDist += Math.sqrt((p.x - pprev.x) ** 2 + (p.y - pprev.y) ** 2);
    }
    const u = cumDist / 1.0; // 1m UV repeat

    positions.push(p.x + nx * W / 2, y, p.y + nz * W / 2);
    positions.push(p.x - nx * W / 2, y, p.y - nz * W / 2);
    normals.push(0, 1, 0, 0, 1, 0);
    uvs.push(u, 0, u, 1);

    if (i > 0) {
      const base = (i - 1) * 2;
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  return geom;
}

/**
 * Create tram rail meshes for all railway=tram/light_rail segments in a tile.
 * Two parallel rails per segment at ±TRAM_GAUGE/2 from centerline.
 * Tunnel segments are skipped (underground, not visible on surface).
 * @param {object[]} railways
 * @param {{ getElevationAt?: Function }} [options]
 * @returns {THREE.Mesh|null}
 */
export function createTramMeshes(railways, options) {
  if (!CONFIG.ENABLE_TRAM_TRACKS || !railways?.length) return null;
  const HALF_GAUGE = BCN_DIMS.TRAM_GAUGE / 2; // 0.7175m each side
  const geoms = [];

  for (const rw of railways) {
    if (rw.railwayType !== 'tram' && rw.railwayType !== 'light_rail') continue;
    if (rw.tunnel || rw.layer < 0) continue; // underground — invisible on surface
    const pts = rw.points;
    if (!pts || pts.length < 2) continue;

    const heights = getTramSurfaceHeights(pts, options?.getElevationAt);

    for (const sign of [-1, 1]) {
      const offsetted = _offsetPts(pts, sign * HALF_GAUGE);
      const g = buildTramRailGeometry(offsetted, heights);
      if (g) geoms.push(g);
    }
  }

  if (!geoms.length) return null;
  const merged = mergeGeometries(geoms);
  geoms.forEach(g => g.dispose());
  if (!merged) return null;

  const mesh = new THREE.Mesh(merged, getTramMaterial());
  mesh.castShadow = false;
  mesh.receiveShadow = !!CONFIG.ENABLE_SHADOWS;
  mesh.frustumCulled = true;
  mesh.userData = { type: 'tramrail', sharedMaterial: true };
  return mesh;
}

const RAILWAY_TEXTURE_BASE = '/textures/railway/railway_01';
const RAILWAY_EXTENSIONS = ['.png', '.jpg'];
const railwayTextureLoader = new THREE.TextureLoader();
let sharedRailwayMaterial = null;

/** Single shared railway material with texture. Tries .png then .jpg. */
function getRailwayMaterial() {
  if (sharedRailwayMaterial) return sharedRailwayMaterial;
  sharedRailwayMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: null,
    roughness: 0.7,
    metalness: 0.1,
    depthWrite: true,
  });
  let tried = 0;
  function tryLoad() {
    if (tried >= RAILWAY_EXTENSIONS.length) return;
    const path = RAILWAY_TEXTURE_BASE + RAILWAY_EXTENSIONS[tried++];
    railwayTextureLoader.load(
      path,
      (t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = THREE.SRGBColorSpace;
        sharedRailwayMaterial.map = t;
        sharedRailwayMaterial.needsUpdate = true;

      },
      undefined,
      () => tryLoad()
    );
  }
  tryLoad();
  return sharedRailwayMaterial;
}

const vertExag = () =>
  CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION)
    ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION
    : 1;

/** Ramp distance (m) over which bridge railways transition from ground to elevated. */
const RAILWAY_RAMP_DIST = 60;

/** Compute per-point railway height with smooth ramp at bridge endpoints.
 *  Bridge/elevated railways ramp up from ground over RAILWAY_RAMP_DIST at
 *  the start and ramp down at the end, creating realistic approach slopes. */
function getRailwayPointHeights(railway, getElevationAt) {
  if (!getElevationAt || !railway.points?.length) return null;
  const layer = railway.layer != null && Number.isFinite(railway.layer) ? railway.layer : 0;
  const scale = vertExag();
  const pts = railway.points;
  const n = pts.length;

  // Compute cumulative arc lengths for ramp interpolation
  const arcLen = [0];
  for (let i = 1; i < n; i++) {
    arcLen.push(arcLen[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const totalLen = arcLen[n - 1];

  const heights = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const { lat, lon } = worldToLatLon(p.x, p.y);
    let baseY = getElevationAt(lat, lon);
    if (!Number.isFinite(baseY)) baseY = 0;

    if (railway.tunnel) {
      heights.push((baseY - LAYER_HEIGHT_STEP) * scale);
      continue;
    }

    const liftHeight = layer * LAYER_HEIGHT_STEP;
    if (liftHeight <= 0) {
      // Ground-level railway — no ramp needed
      heights.push((baseY + RAILWAY_OFFSET) * scale);
      continue;
    }

    // Smoothstep ramp: ramp up at start, ramp down at end
    const distFromStart = arcLen[i];
    const distFromEnd = totalLen - arcLen[i];
    let rampFactor = 1.0; // fully elevated
    if (distFromStart < RAILWAY_RAMP_DIST) {
      // Ramp up from ground at start
      const t = distFromStart / RAILWAY_RAMP_DIST;
      rampFactor = t * t * (3 - 2 * t); // smoothstep
    }
    if (distFromEnd < RAILWAY_RAMP_DIST) {
      // Ramp down to ground at end
      const t = distFromEnd / RAILWAY_RAMP_DIST;
      const endFactor = t * t * (3 - 2 * t);
      rampFactor = Math.min(rampFactor, endFactor);
    }

    const y = baseY + liftHeight * rampFactor + RAILWAY_OFFSET;
    heights.push(y * scale);
  }
  return heights;
}

/**
 * Build flat ribbon BufferGeometry for railway (2m width).
 * points: [{x, y}] with y = world Z. yOffsetOrHeights: number or number[].
 * UV: u = lengthAlong / RAILWAY_UV_REPEAT_M (2m per repeat for sleepers).
 */
function buildRailwayRibbonGeometry(points, yOffsetOrHeights) {
  if (!points || points.length < 2) return null;
  const n = points.length;
  const half = RAILWAY_WIDTH / 2;
  const isArray = Array.isArray(yOffsetOrHeights);
  const getY = (i) => (isArray ? (yOffsetOrHeights[i] != null ? yOffsetOrHeights[i] : 0) : yOffsetOrHeights);
  const positions = [];
  const uvs = [];
  const tangent = new THREE.Vector3();
  const perp = new THREE.Vector3();
  let lengthAlong = 0;

  for (let i = 0; i < n; i++) {
    const p = points[i];
    const x = p.x;
    const z = p.y;
    const y = getY(i);
    if (i > 0) lengthAlong += Math.hypot(x - points[i - 1].x, z - points[i - 1].y);
    const u = lengthAlong / RAILWAY_UV_REPEAT_M;
    if (i === 0) {
      tangent.set(points[1].x - x, 0, points[1].y - z);
    } else if (i === n - 1) {
      tangent.set(x - points[n - 2].x, 0, z - points[n - 2].y);
    } else {
      tangent.set(points[i + 1].x - points[i - 1].x, 0, points[i + 1].y - points[i - 1].y);
    }
    if (tangent.lengthSq() < 1e-12) continue;
    tangent.normalize();
    perp.set(-tangent.z, 0, tangent.x);
    const leftX = x - perp.x * half;
    const leftZ = z - perp.z * half;
    const rightX = x + perp.x * half;
    const rightZ = z + perp.z * half;
    positions.push(leftX, y, leftZ, rightX, y, rightZ);
    uvs.push(u, 0, u, 1);
  }

  const numVerts = positions.length / 3;
  if (numVerts < 4) return null;
  const indices = [];
  for (let i = 0; i < numVerts / 2 - 1; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = (i + 1) * 2;
    const d = (i + 1) * 2 + 1;
    indices.push(a, b, d, a, d, c);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

/** Create railway ribbon geometry for one railway. */
function createRailwayMesh(railway, options) {
  const pts = railway.points;
  if (!pts || pts.length < 2) return null;
  const heights = options?.getElevationAt ? getRailwayPointHeights(railway, options.getElevationAt) : null;
  const yOffsetOrHeights = heights || RAILWAY_OFFSET;
  return buildRailwayRibbonGeometry(pts, yOffsetOrHeights);
}

/**
 * Create all railway meshes for a tile. Merged per layer (no merge across layers).
 * @param {object[]} railways
 * @param {{ getElevationAt?: (lat: number, lon: number) => number }} [options]
 * @returns {THREE.Mesh[]}
 */
export function createRailwayMeshes(railways, options) {
  if (!CONFIG.ENABLE_RAILWAYS || !railways?.length) return [];

  const byLayer = new Map();
  for (const railway of railways) {
    const geom = createRailwayMesh(railway, options);
    if (!geom) continue;
    const layer = railway.layer != null && Number.isFinite(railway.layer) ? railway.layer : 0;
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer).push(geom);
  }

  const meshes = [];
  const material = getRailwayMaterial();
  for (const [layer, geoms] of byLayer) {
    if (geoms.length === 0) continue;
    const merged = mergeGeometries(geoms);
    geoms.forEach((g) => g.dispose());
    if (merged) {
      if (!merged.attributes.uv) console.warn('[UV] Railway merged geometry missing uv attribute (layer', layer, ')');
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = false;
      mesh.receiveShadow = !!CONFIG.ENABLE_SHADOWS;
      mesh.frustumCulled = true;
      mesh.userData = { type: 'railway', layer, sharedMaterial: true };
      meshes.push(mesh);
    }
  }
  return meshes;
}
