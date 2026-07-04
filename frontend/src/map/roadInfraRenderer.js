/**
 * Procedural road infrastructure: speed limit signs, direction boards, lane arrows,
 * traffic lights, road name boards, highway gantries, drain covers.
 *
 * All generated from the road graph per tile — no OSM data needed.
 * Uses InstancedMesh for repeated objects. Shared geometry/material across tiles.
 *
 * Coordinate convention (same as roadRenderer / streetlightRenderer):
 *   road.points[i] = { x: worldX, y: worldZ, elevation?: number }
 *   tangent (tx, tz) = unit vector along road in (worldX, worldZ)
 *   perpendicular right = (-tz, tx)
 *
 * Three.js rotateY(θ):  local +X → (cosθ, 0, −sinθ),  local +Z → (sinθ, 0, cosθ)
 * To face sign against tangent (toward oncoming traffic):
 *   want local +Z = (−tx, 0, −tz) → θ = atan2(−tx, −tz)
 * To span beam perpendicular to road:
 *   want local +X = (−tz, 0, tx) → same θ = atan2(−tx, −tz)
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { getWorldElevationOffset } from '../elevationOffset.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const LAYER_HEIGHT_STEP = 6;
const ROAD_Y_OFFSET = 0.06; // above road surface for decals

/**
 * Normalize a raw road-point elevation to render-Y, matching the road deck.
 * Road points carry ABSOLUTE DEM (post road-drape fix); the rendered frame is
 * spawn-anchored: renderY = (rawDEM − worldElevationOffset) × vertExag. Infra is
 * anchored to road points, so it MUST apply the same transform or it floats ~80 m
 * up (the absolute Montjuïc DEM) instead of sitting beside the draped road. See
 * gotchas G-43. Returns null when there is no elevation data (caller falls back).
 */
function normRoadElev(rawElev) {
  if (rawElev == null || !Number.isFinite(rawElev)) return null;
  const off = getWorldElevationOffset() ?? 0;
  const vEx = (CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null
    && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION)) ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;
  return (rawElev - off) * vEx;
}

const ROAD_WIDTHS_BY_TYPE = {
  motorway: 15, trunk: 12, primary: 10, secondary: 8,
  tertiary: 7, residential: 6, service: 5, unclassified: 6,
};

const SPEED_LIMITS = {
  motorway: 100, trunk: 80, primary: 60, secondary: 50,
  tertiary: 40, residential: 30, service: 20, unclassified: 40,
  motorway_link: 60, trunk_link: 50, primary_link: 40,
  secondary_link: 40, tertiary_link: 30,
};

const ENDPOINT_TOLERANCE = 2;
const JUNCTION_MIN_ROADS = 2;

// ─── Shared geometry/material singletons ─────────────────────────────────────

let sharedSpeedSignPoleMat = null;
let sharedSignBackMat = null;
let sharedTLPoleGeom = null, sharedTLPoleMat = null;
let sharedTLBulbGeom = null;
let sharedGantryPoleGeom = null, sharedGantryPoleMat = null;
let sharedGantryBoardGeom = null;
let sharedDrainGeom = null, sharedDrainMat = null;
let sharedArrowGeom = null, sharedArrowMat = null;
let sharedBoardPoleMat = null;
let sharedTLRedBulbMat = null;
let sharedTLYellowBulbMat = null;
let sharedTLGreenBulbMat = null;
let sharedPoleShadowMat = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getRoadWidth(road) {
  const osm = Number(road.width);
  if (osm > 0) return Math.min(30, osm);
  return ROAD_WIDTHS_BY_TYPE[road.highwayType] || 6;
}

function hashPoint(x, z, tol) {
  const g = 1 / (tol || 1);
  return `${Math.floor(x * g)}_${Math.floor(z * g)}`;
}

function seededRandom(seed) {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function tileKeyToSeed(tileKey) {
  let h = 0;
  for (let i = 0; i < tileKey.length; i++) h = ((h << 5) - h + tileKey.charCodeAt(i)) | 0;
  return h;
}

/**
 * Compute the correct Y-axis rotation so that:
 *   - the object's local +Z faces AGAINST the tangent (toward oncoming traffic)
 *   - the object's local +X is perpendicular to the road (beam direction)
 */
function facingAngle(tx, tz) {
  return Math.atan2(-tx, -tz);
}

function walkPolyline(points, step) {
  const result = [];
  if (!points || points.length < 2) return result;
  let dist = 0, nextEmit = step * 0.5;
  for (let i = 0; i < points.length - 1; i++) {
    const ax = points[i].x, az = points[i].y;
    const bx = points[i + 1].x, bz = points[i + 1].y;
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 0.001) continue;
    const ux = dx / len, uz = dz / len;
    const eA = normRoadElev(points[i].elevation) ?? 0;
    const eB = normRoadElev(points[i + 1].elevation) ?? 0;
    while (nextEmit <= dist + len) {
      const t = (nextEmit - dist) / len;
      result.push({ x: ax + t * dx, z: az + t * dz, tx: ux, tz: uz, elevation: eA + t * (eB - eA) });
      nextEmit += step;
    }
    dist += len;
  }
  return result;
}

function polylineLength(points) {
  let len = 0;
  for (let i = 0; i < points.length - 1; i++) {
    len += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  }
  return len;
}

function isNearJunction(x, z, junctions, dist) {
  const d2 = dist * dist;
  for (const j of junctions) {
    if ((x - j.x) ** 2 + (z - j.z) ** 2 < d2) return true;
  }
  return false;
}

function interpolateAlongPolyline(points, targetDist) {
  let dist = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const ax = points[i].x, az = points[i].y;
    const bx = points[i + 1].x, bz = points[i + 1].y;
    const dx = bx - ax, dz = bz - az;
    const segLen = Math.hypot(dx, dz);
    if (segLen < 0.001) continue;
    if (dist + segLen >= targetDist) {
      const t = (targetDist - dist) / segLen;
      const eA = normRoadElev(points[i].elevation) ?? 0;
      const eB = normRoadElev(points[i + 1].elevation) ?? 0;
      return { x: ax + t * dx, z: az + t * dz, tx: dx / segLen, tz: dz / segLen, elevation: eA + t * (eB - eA) };
    }
    dist += segLen;
  }
  return null;
}

function interpolateFromEnd(points, targetDist) {
  let dist = 0;
  for (let i = points.length - 1; i > 0; i--) {
    const ax = points[i].x, az = points[i].y;
    const bx = points[i - 1].x, bz = points[i - 1].y;
    const dx = bx - ax, dz = bz - az;
    const segLen = Math.hypot(dx, dz);
    if (segLen < 0.001) continue;
    if (dist + segLen >= targetDist) {
      const t = (targetDist - dist) / segLen;
      const tx = -dx / segLen, tz = -dz / segLen;
      const eA = normRoadElev(points[i].elevation) ?? 0;
      const eB = normRoadElev(points[i - 1].elevation) ?? 0;
      return { x: ax + t * dx, z: az + t * dz, tx, tz, elevation: eA + t * (eB - eA) };
    }
    dist += segLen;
  }
  return null;
}

// ─── Intersection detection ─────────────────────────────────────────────────

function findIntersections(roads) {
  const byHash = new Map();
  for (const road of roads || []) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;

    const startH = hashPoint(pts[0].x, pts[0].y, ENDPOINT_TOLERANCE);
    if (!byHash.has(startH)) byHash.set(startH, { x: pts[0].x, z: pts[0].y, count: 0, roads: [] });
    const startEntry = byHash.get(startH);
    startEntry.count++;
    const sDx = pts[1].x - pts[0].x, sDz = pts[1].y - pts[0].y;
    const sLen = Math.hypot(sDx, sDz) || 1;
    startEntry.roads.push({
      name: road.name || '', highwayType: road.highwayType || '',
      tx: sDx / sLen, tz: sDz / sLen, road,
      elevation: normRoadElev(pts[0].elevation),
    });

    const last = pts.length - 1;
    const endH = hashPoint(pts[last].x, pts[last].y, ENDPOINT_TOLERANCE);
    if (!byHash.has(endH)) byHash.set(endH, { x: pts[last].x, z: pts[last].y, count: 0, roads: [] });
    const endEntry = byHash.get(endH);
    endEntry.count++;
    const eDx = pts[last].x - pts[last - 1].x, eDz = pts[last].y - pts[last - 1].y;
    const eLen = Math.hypot(eDx, eDz) || 1;
    endEntry.roads.push({
      name: road.name || '', highwayType: road.highwayType || '',
      tx: eDx / eLen, tz: eDz / eLen, road,
      elevation: normRoadElev(pts[last].elevation),
    });
  }

  const intersections = [];
  for (const v of byHash.values()) {
    if (v.count >= JUNCTION_MIN_ROADS) {
      intersections.push({ x: v.x, z: v.z, roadCount: v.count, connectedRoads: v.roads });
    }
  }
  return intersections;
}

// ─── Shared geometry builders ────────────────────────────────────────────────

/** Shared gray material for the back face of all sign boards. */
function getSignBackMaterial() {
  if (!sharedSignBackMat) {
    sharedSignBackMat = new THREE.MeshLambertMaterial({ color: 0x888888, side: THREE.DoubleSide });
    sharedSignBackMat.userData.sharedMaterial = true;
  }
  return sharedSignBackMat;
}

// ─── Speed sign resources (Indian-style yellow board) ────────────────────────

const SPEED_SIGN_W = 0.7;   // board width (metres)
const SPEED_SIGN_H = 0.9;   // board height
const SPEED_SIGN_POLE_H = 3.0;
const SPEED_SIGN_BOARD_Y = 2.4; // Y of bottom edge of board

function getSpeedSignPoleMat() {
  if (!sharedSpeedSignPoleMat) {
    sharedSpeedSignPoleMat = new THREE.MeshLambertMaterial({ color: 0x999999 });
    sharedSpeedSignPoleMat.userData.sharedMaterial = true;
  }
  return sharedSpeedSignPoleMat;
}

/** Cache: speed number → CanvasTexture (only ~6 unique values). */
const _speedTexCache = new Map();

/**
 * European / Spanish speed limit sign: white disc, thick red ring, black number, no text.
 */
function getSpeedSignTexture(speed) {
  if (_speedTexCache.has(speed)) return _speedTexCache.get(speed);

  const W = 256, H = 320;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Pale grey backing board (rounded) — European signs mount the disc on a light plate
  ctx.fillStyle = '#e9e9e9';
  ctx.beginPath();
  ctx.roundRect(0, 0, W, H, 16);
  ctx.fill();
  ctx.strokeStyle = '#3a3a3a';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(2, 2, W - 4, H - 4, 14);
  ctx.stroke();

  // Big centered white disc with a thick red ring (the actual EU speed sign)
  const cx = W / 2, cy = H / 2, r = 96;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#d10000';
  ctx.lineWidth = 26;
  ctx.stroke();

  // Speed number — big, black, centered in the disc
  ctx.fillStyle = '#111111';
  ctx.font = 'bold 100px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(speed), cx, cy + 4);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Compensate for scene worldGroup scale.x = -1
  tex.repeat.x = -1;
  tex.offset.x = 1;
  _speedTexCache.set(speed, tex);
  return tex;
}

// Traffic light: pole+arm+box (dark), 3 bulb InstancedMeshes (R/Y/G) with per-instance color.
// Cycle: Green 25s → Yellow 5s → Red 30s, staggered per light.

const TL_GREEN_DUR = 25;
const TL_YELLOW_DUR = 5;
const TL_RED_DUR = 30;
const TL_CYCLE = TL_GREEN_DUR + TL_YELLOW_DUR + TL_RED_DUR; // 60s

// Colors: active vs inactive (dim)
const TL_RED_ON     = new THREE.Color(0xff1111);
const TL_YELLOW_ON  = new THREE.Color(0xffcc00);
const TL_GREEN_ON   = new THREE.Color(0x11dd11);
const TL_OFF_DAY    = new THREE.Color(0x222222);
const _tlOffNight   = new THREE.Color(0x111111);

function getTLPoleResources() {
  if (!sharedTLPoleGeom) {
    const pole = new THREE.CylinderGeometry(0.06, 0.07, 5.5, 6);
    pole.translate(0, 2.75, 0);
    const arm = new THREE.CylinderGeometry(0.04, 0.04, 3, 5);
    arm.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
    arm.translate(1.5, 5.5, 0);
    const box = new THREE.BoxGeometry(0.4, 1.1, 0.3);
    box.translate(3, 5.2, 0);
    sharedTLPoleGeom = mergeGeometries([pole, arm, box]);
    [pole, arm, box].forEach(g => g.dispose());
    sharedTLPoleGeom.userData.sharedGeometry = true;
  }
  if (!sharedTLPoleMat) {
    sharedTLPoleMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2a });
    sharedTLPoleMat.userData.sharedMaterial = true;
  }
  if (!sharedTLBulbGeom) {
    sharedTLBulbGeom = new THREE.SphereGeometry(0.1, 8, 6);
    sharedTLBulbGeom.userData.sharedGeometry = true;
  }
  return { poleGeom: sharedTLPoleGeom, poleMat: sharedTLPoleMat, bulbGeom: sharedTLBulbGeom };
}

function getTLBulbMaterials() {
  if (!sharedTLRedBulbMat) {
    sharedTLRedBulbMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    sharedTLRedBulbMat.userData.sharedMaterial = true;
  }
  if (!sharedTLYellowBulbMat) {
    sharedTLYellowBulbMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    sharedTLYellowBulbMat.userData.sharedMaterial = true;
  }
  if (!sharedTLGreenBulbMat) {
    sharedTLGreenBulbMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    sharedTLGreenBulbMat.userData.sharedMaterial = true;
  }
  return { redMat: sharedTLRedBulbMat, yellowMat: sharedTLYellowBulbMat, greenMat: sharedTLGreenBulbMat };
}

function getPoleShadowMaterial() {
  if (!sharedPoleShadowMat) {
    sharedPoleShadowMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.30,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    sharedPoleShadowMat.userData.sharedMaterial = true;
  }
  return sharedPoleShadowMat;
}

// Bulb local offsets (relative to traffic light origin): x=3 (arm tip), z=0.16 (front)
const TL_BULB_OFFSETS = [
  { dy: 5.55, color: 'red' },    // top
  { dy: 5.20, color: 'yellow' }, // middle
  { dy: 4.85, color: 'green' },  // bottom
];

/** Registry of all active traffic light bulb meshes for animation. */
const _tlRegistry = [];

/**
 * Update all traffic light colors. Call from game loop.
 * @param {number} timeSeconds - elapsed game time in seconds
 * @param {boolean} isNight - night mode flag
 */
export function updateTrafficLights(timeSeconds, isNight) {
  // At night, "off" bulbs are darker
  const offColor = isNight ? _tlOffNight : TL_OFF_DAY;

  for (const entry of _tlRegistry) {
    const { redMesh, yellowMesh, greenMesh, staggerOffsets } = entry;
    if (!redMesh || !redMesh.parent) continue; // disposed

    for (let i = 0; i < staggerOffsets.length; i++) {
      const phase = (timeSeconds + staggerOffsets[i]) % TL_CYCLE;
      let rOn = false, yOn = false, gOn = false;
      if (phase < TL_GREEN_DUR) {
        gOn = true;
      } else if (phase < TL_GREEN_DUR + TL_YELLOW_DUR) {
        yOn = true;
      } else {
        rOn = true;
      }

      redMesh.setColorAt(i, rOn ? TL_RED_ON : offColor);
      yellowMesh.setColorAt(i, yOn ? TL_YELLOW_ON : offColor);
      greenMesh.setColorAt(i, gOn ? TL_GREEN_ON : offColor);
    }
    redMesh.instanceColor.needsUpdate = true;
    yellowMesh.instanceColor.needsUpdate = true;
    greenMesh.instanceColor.needsUpdate = true;
  }
}

/**
 * Remove disposed entries from the traffic light registry.
 * Called automatically by updateTrafficLights, but can also be called on tile unload.
 */
export function cleanupTrafficLightRegistry() {
  for (let i = _tlRegistry.length - 1; i >= 0; i--) {
    if (!_tlRegistry[i].redMesh.parent) _tlRegistry.splice(i, 1);
  }
}

// ─── Gantry resources ────────────────────────────────────────────────────────
// Gantry: two gray poles + horizontal beam (shared InstancedMesh)
//         + green sign board with white border and road name text (individual mesh per gantry)

const GANTRY_POLE_HEIGHT = 7.5;
const GANTRY_BEAM_HEIGHT = 0.35;
const GANTRY_BOARD_W = 5;
const GANTRY_BOARD_H = 1.8;

function getGantryPoleResources(halfSpan) {
  // Poles + beam are created per-tile since halfSpan varies by road width.
  // But we share material across all tiles.
  if (!sharedGantryPoleMat) {
    sharedGantryPoleMat = new THREE.MeshLambertMaterial({ color: 0xaaaaaa });
    sharedGantryPoleMat.userData.sharedMaterial = true;
  }
  return { mat: sharedGantryPoleMat };
}

/** Cache: gantry sign textures keyed by roadName + connected names. */
const _gantryTexCache = new Map();

/**
 * Get (or create) a canvas texture for a gantry sign board.
 * Green background, white rounded border, road name + arrow.
 * Cached by roadName + connectedNames so identical signs share one texture.
 */
function getGantrySignTexture(roadName, connectedNames) {
  const cacheKey = (roadName || '') + '|' + (connectedNames?.join(',') || '');
  if (_gantryTexCache.has(cacheKey)) return _gantryTexCache.get(cacheKey);

  const W = 512, H = 192;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Green background
  ctx.fillStyle = '#1a6b3c';
  ctx.fillRect(0, 0, W, H);

  // White rounded border (inset 6px)
  const inset = 6, r = 14;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(inset, inset, W - inset * 2, H - inset * 2, r);
  ctx.stroke();

  // Text
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Main road name (top line)
  const displayName = roadName || 'Delhi';
  ctx.font = 'bold 38px Arial, sans-serif';
  const nameY = connectedNames?.length ? H * 0.32 : H * 0.38;
  ctx.fillText(displayName, W / 2, nameY, W - 40);

  // Connected road name or direction hint (second line)
  if (connectedNames && connectedNames.length > 0) {
    ctx.font = '28px Arial, sans-serif';
    ctx.fillText(connectedNames[0], W / 2, H * 0.58, W - 40);
  }

  // Arrow pointing up
  const arrowX = W / 2, arrowY = connectedNames?.length ? H * 0.82 : H * 0.72;
  ctx.font = 'bold 36px Arial, sans-serif';
  ctx.fillText('\u2191', arrowX, arrowY); // ↑

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Scene worldGroup has scale.x = -1 which mirrors textures; flip U to compensate
  tex.repeat.x = -1;
  tex.offset.x = 1;
  _gantryTexCache.set(cacheKey, tex);
  return tex;
}

function getDrainResources() {
  if (!sharedDrainGeom) {
    sharedDrainGeom = new THREE.CircleGeometry(0.25, 8);
    sharedDrainGeom.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    sharedDrainGeom.userData.sharedGeometry = true;
  }
  if (!sharedDrainMat) {
    sharedDrainMat = new THREE.MeshLambertMaterial({
      color: 0x333333,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    sharedDrainMat.userData.sharedMaterial = true;
  }
  return { geom: sharedDrainGeom, mat: sharedDrainMat };
}

function getArrowResources() {
  if (!sharedArrowGeom) {
    const shape = new THREE.Shape();
    shape.moveTo(0, 1.5);
    shape.lineTo(-0.4, 0.7);
    shape.lineTo(-0.15, 0.7);
    shape.lineTo(-0.15, -1.5);
    shape.lineTo(0.15, -1.5);
    shape.lineTo(0.15, 0.7);
    shape.lineTo(0.4, 0.7);
    shape.closePath();
    sharedArrowGeom = new THREE.ShapeGeometry(shape);
    sharedArrowGeom.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    sharedArrowGeom.userData.sharedGeometry = true;
  }
  if (!sharedArrowMat) {
    sharedArrowMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
      side: THREE.DoubleSide,
    });
    sharedArrowMat.userData.sharedMaterial = true;
  }
  return { geom: sharedArrowGeom, mat: sharedArrowMat };
}

// ─── Direction board resources (Barcelona/Spanish white urban directional) ───────────────

const BOARD_W = 2.2;      // sign width (metres)
const BOARD_H = 1.6;      // sign height
const BOARD_ARROW_W = 0.5; // arrow point extension
const BOARD_POLE_H = 2.8;  // pole height (bottom of sign at ~2.0m)
const BOARD_SIGN_Y = 2.0;  // Y of bottom edge of sign

function getBoardPoleMat() {
  if (!sharedBoardPoleMat) {
    sharedBoardPoleMat = new THREE.MeshLambertMaterial({ color: 0xbbbbbb });
    sharedBoardPoleMat.userData.sharedMaterial = true;
  }
  return sharedBoardPoleMat;
}

/** Cache: direction board textures keyed by roadName. */
const _dirBoardTexCache = new Map();

/** Catalan/Spanish particles that stay lowercase in a title-cased street name. */
const CAT_LOWER = new Set(['de', 'del', 'dels', 'la', 'les', 'el', 'els', 'i', 'a', 'en', 'amb', 'per', 'da', 'do', 'y']);
/** "AVINGUDA DE LA DIAGONAL" / "avinguda de la diagonal" → "Avinguda de la Diagonal". */
function toCatalanTitleCase(name) {
  const words = name.trim().split(/\s+/);
  return words.map((w, i) => {
    // handle elided articles like d'Aragó / l'Eixample
    if (/^[dl]'/i.test(w)) return w[0].toLowerCase() + "'" + (w[2] ? w[2].toUpperCase() + w.slice(3).toLowerCase() : '');
    const lower = w.toLowerCase();
    if (i > 0 && CAT_LOWER.has(lower)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(' ');
}

/** Split a street name into two roughly balanced lines (by character length) for wrapping. */
function splitTwoLines(name) {
  const words = name.split(/\s+/);
  if (words.length < 2) return [name];
  const total = name.length;
  let acc = 0, cut = 0;
  for (let i = 0; i < words.length - 1; i++) {
    acc += words[i].length + 1;
    if (acc >= total / 2) { cut = i + 1; break; }
  }
  if (cut === 0) cut = 1;
  return [words.slice(0, cut).join(' '), words.slice(cut).join(' ')];
}

/**
 * Get (or create) canvas texture for a Barcelona/Spanish urban direction sign.
 * White retroreflective panel, dark charcoal border + solid arrow, a single street name in Catalan
 * Title Case (Spanish urban señalización — not the old green Indian board with duplicated text).
 * Cached by roadName so identical signs share one texture.
 */
function getDirectionBoardTexture(roadName) {
  const cacheKey = roadName || '';
  if (_dirBoardTexCache.has(cacheKey)) return _dirBoardTexCache.get(cacheKey);

  const W = 512, H = 384;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const INK = '#1c1c1e'; // near-black charcoal (Spanish signs use black on white)

  // White retroreflective panel
  ctx.fillStyle = '#f2f2ee';
  ctx.fillRect(0, 0, W, H);
  // Subtle vignette so it doesn't read as a flat sticker
  const vg = ctx.createLinearGradient(0, 0, 0, H);
  vg.addColorStop(0, 'rgba(255,255,255,0.5)');
  vg.addColorStop(1, 'rgba(200,200,195,0.35)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);

  // Charcoal border with rounded corners + a thin inner keyline (detail)
  ctx.strokeStyle = INK;
  ctx.lineWidth = 10;
  ctx.beginPath(); ctx.roundRect(12, 12, W - 24, H - 24, 14); ctx.stroke();
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(26, 26, W - 52, H - 52, 8); ctx.stroke();

  // Solid charcoal arrow on the left (points toward the destination)
  const cy = H / 2, ax = 58, head = 62, shaftW = 30;
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.moveTo(ax, cy);                       // tip
  ctx.lineTo(ax + head, cy - 58);           // head top
  ctx.lineTo(ax + head, cy - shaftW / 2);   // neck top
  ctx.lineTo(ax + head + 92, cy - shaftW / 2); // shaft top
  ctx.lineTo(ax + head + 92, cy + shaftW / 2); // shaft bottom
  ctx.lineTo(ax + head, cy + shaftW / 2);   // neck bottom
  ctx.lineTo(ax + head, cy + 58);           // head bottom
  ctx.closePath();
  ctx.fill();

  // Street name — Catalan Title Case, charcoal. Prefer one line (shrink to 40px); if it still won't fit,
  // wrap to two balanced lines and size those to fit.
  const name = toCatalanTitleCase(roadName || 'Carrer');
  const textX = ax + head + 92 + 22;        // just right of the arrow shaft
  const maxW = W - textX - 30;
  const fontOf = (px) => `700 ${px}px "Helvetica Neue", Arial, sans-serif`;
  ctx.fillStyle = INK;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  let lines, fontPx = 54;
  ctx.font = fontOf(fontPx);
  if (ctx.measureText(name).width <= maxW) {
    lines = [name];
  } else {
    // shrink a single line down to 40px
    while (fontPx > 40) { fontPx -= 2; ctx.font = fontOf(fontPx); if (ctx.measureText(name).width <= maxW) break; }
    if (ctx.measureText(name).width <= maxW) {
      lines = [name];
    } else {
      // wrap to two lines and fit the wider line
      lines = splitTwoLines(name);
      fontPx = 46;
      while (fontPx > 24) {
        ctx.font = fontOf(fontPx);
        const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
        if (widest <= maxW) break;
        fontPx -= 2;
      }
    }
  }

  ctx.font = fontOf(fontPx);
  if (lines.length === 1) {
    ctx.fillText(lines[0], textX, cy, maxW);
  } else {
    const lh = fontPx * 1.08;
    ctx.fillText(lines[0], textX, cy - lh / 2, maxW);
    ctx.fillText(lines[1], textX, cy + lh / 2, maxW);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  // Compensate for scene worldGroup scale.x = -1
  tex.repeat.x = -1;
  tex.offset.x = 1;
  _dirBoardTexCache.set(cacheKey, tex);
  return tex;
}

// ─── Infrastructure generators ───────────────────────────────────────────────

const SIGN_ROAD_TYPES = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'residential', 'unclassified',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]);

const TRAFFIC_LIGHT_ROAD_TYPES = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'residential', 'unclassified',
]);

const MAJOR_ROAD_TYPES = new Set(['motorway', 'trunk']);
const GANTRY_ROAD_TYPES = new Set(['motorway', 'trunk', 'primary']);

function generateSpeedSigns(roads, junctions, rng) {
  const instances = [];
  for (const road of roads) {
    if (!SIGN_ROAD_TYPES.has(road.highwayType)) continue;
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const len = polylineLength(pts);
    if (len < 40) continue;

    const spacing = 400 + rng() * 200; // 400-600m between signs
    const roadW = getRoadWidth(road);
    const layer = (road.layer != null && Number.isFinite(road.layer)) ? road.layer : 0;
    const speed = SPEED_LIMITS[road.highwayType] || 40;

    const samples = walkPolyline(pts, spacing);
    for (const s of samples) {
      // Larger skip distance near junctions to avoid overlapping direction boards
      if (isNearJunction(s.x, s.z, junctions, 50)) continue;
      // Right side of road: perpendicular = (-tz, tx)
      const nx = -s.tz, nz = s.tx;
      const SIGN_OFFSET = { motorway: 2.5, trunk: 2.0, primary: 1.5, secondary: 1.2,
        tertiary: 1.0, residential: 0.6, service: 0.5 };
      const edgeDist = roadW * 0.5 + (SIGN_OFFSET[road.highwayType] || 0.8);
      instances.push({
        x: s.x + nx * edgeDist,
        z: s.z + nz * edgeDist,
        angle: facingAngle(s.tx, s.tz),
        baseY: s.elevation != null ? s.elevation : layer * LAYER_HEIGHT_STEP,
        bridge: !!road.bridge,
        speed,
      });
    }
  }
  return instances;
}

/**
 * Build speed sign meshes: gray pole + yellow board with speed number.
 * Uses cached textures per speed value (only ~6 unique values).
 */
function buildSpeedSignMeshes(signInstances) {
  if (signInstances.length === 0) return [];

  const poleMat = getSpeedSignPoleMat();
  const meshes = [];
  const poleGeometries = [];
  const _q = new THREE.Quaternion();
  const _axisY = new THREE.Vector3(0, 1, 0);

  // Group by speed to batch sign boards sharing the same texture
  const bySpeed = new Map();
  for (const s of signInstances) {
    if (!bySpeed.has(s.speed)) bySpeed.set(s.speed, []);
    bySpeed.get(s.speed).push(s);
  }

  for (const s of signInstances) {
    _q.setFromAxisAngle(_axisY, s.angle);

    // Pole
    const pole = new THREE.BoxGeometry(0.06, SPEED_SIGN_POLE_H, 0.06);
    const polePos = new THREE.Vector3(0, SPEED_SIGN_POLE_H / 2 + s.baseY, 0);
    polePos.applyQuaternion(_q).add(new THREE.Vector3(s.x, 0, s.z));
    pole.translate(polePos.x, polePos.y, polePos.z);
    poleGeometries.push(pole);
  }

  // Merge all poles
  if (poleGeometries.length > 0) {
    const merged = mergeGeometries(poleGeometries);
    poleGeometries.forEach(g => g.dispose());
    if (merged) {
      const poleMesh = new THREE.Mesh(merged, poleMat);
      poleMesh.userData.sharedMaterial = true;
      poleMesh.castShadow = false;  // projected shadows used instead
      poleMesh.receiveShadow = false;
      meshes.push(poleMesh);
    }
  }

  // Create InstancedMesh per speed value (shared texture within each group)
  for (const [speed, group] of bySpeed) {
    const tex = getSpeedSignTexture(speed);
    const boardGeom = new THREE.PlaneGeometry(SPEED_SIGN_W, SPEED_SIGN_H);
    const boardMat = new THREE.MeshBasicMaterial({ map: tex, transparent: false, side: THREE.DoubleSide });
    const backMat = getSignBackMaterial();

    const instMesh = new THREE.InstancedMesh(boardGeom, boardMat, group.length);
    instMesh.castShadow = false;
    instMesh.receiveShadow = false;

    const backGeom = new THREE.PlaneGeometry(SPEED_SIGN_W, SPEED_SIGN_H);
    const backMesh = new THREE.InstancedMesh(backGeom, backMat, group.length);
    backMesh.userData.sharedMaterial = true;
    backMesh.castShadow = false;
    backMesh.receiveShadow = false;

    const _m = new THREE.Matrix4();
    const _pos = new THREE.Vector3();
    const _qI = new THREE.Quaternion();
    const _qBack = new THREE.Quaternion();
    const _scale = new THREE.Vector3(1, 1, 1);
    const _axisYLocal = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i < group.length; i++) {
      const s = group[i];
      _qI.setFromAxisAngle(_axisYLocal, s.angle);
      const boardPos = new THREE.Vector3(0, SPEED_SIGN_BOARD_Y + SPEED_SIGN_H / 2 + s.baseY, 0.04);
      boardPos.applyQuaternion(_qI).add(new THREE.Vector3(s.x, 0, s.z));
      _pos.copy(boardPos);
      _m.compose(_pos, _qI, _scale);
      instMesh.setMatrixAt(i, _m);
      // Back face: same orientation, offset slightly behind front
      const _backPos = _pos.clone();
      const _backOff = new THREE.Vector3(0, 0, -0.05);
      _backOff.applyQuaternion(_qI);
      _backPos.add(_backOff);
      _m.compose(_backPos, _qI, _scale);
      backMesh.setMatrixAt(i, _m);
    }
    instMesh.instanceMatrix.needsUpdate = true;
    backMesh.instanceMatrix.needsUpdate = true;
    meshes.push(instMesh, backMesh);
  }

  return meshes;
}

function generateTrafficLights(intersections, roads) {
  const instances = [];
  const MAX_PER_TILE = 20;
  const MAX_PER_INTERSECTION = 4; // at most 4 lights per junction
  const MIN_SPACING = 6; // metres between any two traffic lights

  for (const inter of intersections) {
    if (inter.roadCount < 3) continue;
    if (instances.length >= MAX_PER_TILE) break;

    const hasSignificantRoad = inter.connectedRoads.some(
      r => TRAFFIC_LIGHT_ROAD_TYPES.has(r.highwayType)
    );
    if (!hasSignificantRoad) continue;

    let placedThisIntersection = 0;
    for (const cr of inter.connectedRoads) {
      if (placedThisIntersection >= MAX_PER_INTERSECTION) break;
      if (instances.length >= MAX_PER_TILE) break;

      const roadW = getRoadWidth(cr.road);
      // Left side of road (India drives on the left, lights on the left facing oncoming)
      const nx = cr.tz, nz = -cr.tx;

      // Try progressively further offsets until clear of all roads
      let px, pz;
      let cornerDist = roadW * 0.5 + 1.5;
      const maxDist = roadW * 0.5 + 6;
      let found = false;
      while (cornerDist <= maxDist) {
        px = inter.x + nx * cornerDist;
        pz = inter.z + nz * cornerDist;
        if (!isOnAnyRoad(px, pz, roads, 0.5)) { found = true; break; }
        cornerDist += 1.5;
      }
      if (!found) continue;

      // Check minimum spacing against already-placed lights
      let tooClose = false;
      for (const prev of instances) {
        if ((px - prev.x) ** 2 + (pz - prev.z) ** 2 < MIN_SPACING * MIN_SPACING) {
          tooClose = true; break;
        }
      }
      if (tooClose) continue;

      const layer = (cr.road.layer != null && Number.isFinite(cr.road.layer)) ? cr.road.layer : 0;
      // Arm extends in local +X; flip angle so arm reaches over the road from the left side
      instances.push({
        x: px, z: pz,
        angle: Math.atan2(-cr.tx, -cr.tz),
        baseY: cr.elevation != null ? cr.elevation : layer * LAYER_HEIGHT_STEP,
        bridge: !!cr.road?.bridge,
      });
      placedThisIntersection++;
    }
  }
  return instances;
}

function generateLaneArrows(intersections) {
  const instances = [];
  const MAX_PER_TILE = 60;

  for (const inter of intersections) {
    if (inter.roadCount < 2) continue;

    for (const cr of inter.connectedRoads) {
      if (instances.length >= MAX_PER_TILE) break;
      const pts = cr.road.points;
      if (!pts || pts.length < 2) continue;
      const roadLen = polylineLength(pts);
      if (roadLen < 25) continue;

      const startDist = Math.hypot(pts[0].x - inter.x, pts[0].y - inter.z);
      const endDist = Math.hypot(pts[pts.length - 1].x - inter.x, pts[pts.length - 1].y - inter.z);
      const isAtEnd = endDist < startDist;

      let sample;
      if (isAtEnd) {
        sample = interpolateFromEnd(pts, 15);
      } else {
        sample = interpolateAlongPolyline(pts, 15);
      }
      if (!sample) continue;

      const layer = (cr.road.layer != null && Number.isFinite(cr.road.layer)) ? cr.road.layer : 0;
      // Arrow points in the direction of travel (toward intersection)
      const dirTx = isAtEnd ? sample.tx : -sample.tx;
      const dirTz = isAtEnd ? sample.tz : -sample.tz;
      instances.push({
        x: sample.x, z: sample.z,
        angle: facingAngle(dirTx, dirTz),
        baseY: (sample.elevation != null ? sample.elevation : layer * LAYER_HEIGHT_STEP) + ROAD_Y_OFFSET,
      });
    }
  }
  return instances;
}

/**
 * Check if a point (px, pz) is on or very close to any road segment.
 * Returns true if the point is within (roadHalfWidth + margin) of any road centerline.
 */
function isOnAnyRoad(px, pz, roads, margin) {
  for (const road of roads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const halfW = getRoadWidth(road) * 0.5 + margin;
    const halfWSq = halfW * halfW;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i].x, az = pts[i].y;
      const bx = pts[i + 1].x, bz = pts[i + 1].y;
      const dx = bx - ax, dz = bz - az;
      const lenSq = dx * dx + dz * dz;
      if (lenSq < 0.01) continue;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
      const closestX = ax + t * dx, closestZ = az + t * dz;
      const distSq = (px - closestX) ** 2 + (pz - closestZ) ** 2;
      if (distSq < halfWSq) return true;
    }
  }
  return false;
}

function generateDirectionBoards(intersections, roads, rng) {
  const instances = [];
  const MAX_PER_TILE = 20;
  const placedHashes = new Set();

  for (const inter of intersections) {
    if (inter.roadCount < 2) continue;
    if (instances.length >= MAX_PER_TILE) break;

    // Find the widest ground-level (main) road at this junction
    let mainRoad = inter.connectedRoads[0];
    for (const cr of inter.connectedRoads) {
      if (getRoadWidth(cr.road) > getRoadWidth(mainRoad.road)) mainRoad = cr;
    }

    // Skip if main road is a bridge, ramp, or elevated (_link types on bridges)
    const mainLayer = (mainRoad.road.layer != null && Number.isFinite(mainRoad.road.layer)) ? mainRoad.road.layer : 0;
    const isBridgeOrRamp = mainRoad.road.bridge === true || mainLayer > 0
      || (mainRoad.highwayType && mainRoad.highwayType.endsWith('_link') && mainLayer !== 0);
    if (isBridgeOrRamp) continue;

    // Collect unique names of OTHER roads branching off at this junction
    // These are the destinations the direction board should point toward
    const otherNames = [];
    const seenNames = new Set();
    for (const cr of inter.connectedRoads) {
      if (cr.road === mainRoad.road) continue;
      const n = cr.name || '';
      if (n && n !== mainRoad.name && !seenNames.has(n)) {
        seenNames.add(n);
        otherNames.push(n);
      }
    }
    // If no named side roads, use the main road name or a type fallback
    let boardText;
    if (otherNames.length > 0) {
      // Show up to 2 destination names
      boardText = otherNames.slice(0, 2).join(' / ');
    } else {
      // Fallback: show main road name or formatted type
      boardText = mainRoad.name || formatRoadType(mainRoad.highwayType);
    }

    const pts = mainRoad.road.points;
    if (!pts || pts.length < 2) continue;
    const roadLen = polylineLength(pts);
    if (roadLen < 50) continue;

    const startDist = Math.hypot(pts[0].x - inter.x, pts[0].y - inter.z);
    const endDist = Math.hypot(pts[pts.length - 1].x - inter.x, pts[pts.length - 1].y - inter.z);
    const isAtEnd = endDist < startDist;

    let sample;
    if (isAtEnd) {
      sample = interpolateFromEnd(pts, 40);
    } else {
      sample = interpolateAlongPolyline(pts, 40);
    }
    if (!sample) continue;

    const roadW = getRoadWidth(mainRoad.road);
    const nx = -sample.tz, nz = sample.tx;

    // Try progressively larger offsets until the sign clears all roads
    let px, pz, edgeDist = roadW * 0.5 + 1.5;
    const MAX_OFFSET = roadW * 0.5 + 8;
    while (edgeDist <= MAX_OFFSET) {
      px = sample.x + nx * edgeDist;
      pz = sample.z + nz * edgeDist;
      if (!isOnAnyRoad(px, pz, roads, 1.0)) break;
      edgeDist += 0.75;
    }
    // Skip this board entirely if we couldn't find a clear spot
    if (edgeDist > MAX_OFFSET) continue;

    const key = hashPoint(px, pz, 8);
    if (placedHashes.has(key)) continue;
    placedHashes.add(key);

    const layer = (mainRoad.road.layer != null && Number.isFinite(mainRoad.road.layer)) ? mainRoad.road.layer : 0;
    const dirTx = isAtEnd ? sample.tx : -sample.tx;
    const dirTz = isAtEnd ? sample.tz : -sample.tz;
    // Face the approaching driver (opposite of toward-intersection)
    instances.push({
      x: px, z: pz,
      angle: facingAngle(dirTx, dirTz) + Math.PI,
      baseY: sample.elevation != null ? sample.elevation : layer * LAYER_HEIGHT_STEP,
      roadName: boardText,
    });
  }
  return instances;
}

/**
 * Build direction board meshes: two silver poles + white Spanish urban directional sign.
 */
function buildDirectionBoardMeshes(boardInstances) {
  if (boardInstances.length === 0) return [];

  const poleMat = getBoardPoleMat();
  const meshes = [];
  const poleGeometries = [];
  const _q = new THREE.Quaternion();
  const _axisY = new THREE.Vector3(0, 1, 0);

  for (const b of boardInstances) {
    _q.setFromAxisAngle(_axisY, b.angle);

    // Two poles: left and right of the sign
    const poleSpacing = BOARD_W * 0.4;
    for (const side of [-1, 1]) {
      const pole = new THREE.BoxGeometry(0.06, BOARD_POLE_H, 0.06);
      const localPos = new THREE.Vector3(side * poleSpacing, BOARD_POLE_H / 2 + b.baseY, 0);
      localPos.applyQuaternion(_q).add(new THREE.Vector3(b.x, 0, b.z));
      pole.translate(localPos.x, localPos.y, localPos.z);
      poleGeometries.push(pole);
    }

    // Sign board — front face with texture
    const signGeom = new THREE.PlaneGeometry(BOARD_W, BOARD_H);
    const tex = getDirectionBoardTexture(b.roadName);
    // DoubleSide so the sign is visible from BOTH directions (was FrontSide → invisible from behind).
    const signMat = new THREE.MeshBasicMaterial({ map: tex, transparent: false, side: THREE.DoubleSide });

    const signMesh = new THREE.Mesh(signGeom, signMat);
    const signPos = new THREE.Vector3(0, BOARD_SIGN_Y + BOARD_H / 2 + b.baseY, 0.04);
    signPos.applyQuaternion(_q).add(new THREE.Vector3(b.x, 0, b.z));
    signMesh.position.copy(signPos);
    signMesh.quaternion.copy(_q);
    signMesh.castShadow = false;
    signMesh.receiveShadow = false;
    meshes.push(signMesh);
  }

  // Merge all poles into one mesh
  if (poleGeometries.length > 0) {
    const merged = mergeGeometries(poleGeometries);
    poleGeometries.forEach(g => g.dispose());
    if (merged) {
      const poleMesh = new THREE.Mesh(merged, poleMat);
      poleMesh.userData.sharedMaterial = true;
      poleMesh.castShadow = false;  // projected shadows used instead
      poleMesh.receiveShadow = false;
      meshes.unshift(poleMesh);
    }
  }

  return meshes;
}

/**
 * Generate gantry data for motorway/trunk/primary roads.
 * Returns array of { x, z, tx, tz, angle, baseY, roadWidth, roadName, connectedNames }.
 */
function generateGantries(roads, intersections) {
  const instances = [];
  const MAX_PER_TILE = 6;

  // Build a lookup: intersection position → connected road names (for sign text)
  const interNames = new Map();
  for (const inter of intersections) {
    const names = inter.connectedRoads
      .map(r => r.name)
      .filter(n => n && n.length > 0);
    const uniqueNames = [...new Set(names)];
    interNames.set(hashPoint(inter.x, inter.z, 5), uniqueNames);
  }

  for (const road of roads) {
    if (!GANTRY_ROAD_TYPES.has(road.highwayType)) continue;
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const len = polylineLength(pts);
    if (len < 150) continue;

    const roadW = getRoadWidth(road);
    if (roadW < 8) continue; // only wide enough roads
    const layer = (road.layer != null && Number.isFinite(road.layer)) ? road.layer : 0;
    const roadName = road.name || '';

    const spacing = 400;
    const samples = walkPolyline(pts, spacing);
    for (const s of samples) {
      if (instances.length >= MAX_PER_TILE) break;

      // Find nearby intersection names for the sign text
      const nearHash = hashPoint(s.x, s.z, 50);
      let connectedNames = [];
      for (const inter of intersections) {
        if (Math.hypot(inter.x - s.x, inter.z - s.z) < 200) {
          for (const cr of inter.connectedRoads) {
            if (cr.name && cr.name !== roadName && !connectedNames.includes(cr.name)) {
              connectedNames.push(cr.name);
            }
          }
        }
      }

      instances.push({
        x: s.x, z: s.z,
        tx: s.tx, tz: s.tz,
        angle: facingAngle(s.tx, s.tz),
        baseY: s.elevation != null ? s.elevation : layer * LAYER_HEIGHT_STEP,
        roadWidth: roadW,
        roadName: roadName || formatRoadType(road.highwayType),
        connectedNames: connectedNames.slice(0, 2),
      });
    }
  }
  return instances;
}

/** Format highway type as readable label for signs when no name available. */
function formatRoadType(highwayType) {
  const map = {
    motorway: 'National Highway',
    motorway_link: 'NH Slip Road',
    trunk: 'State Highway',
    trunk_link: 'SH Slip Road',
    primary: 'Main Road',
    primary_link: 'Main Road Link',
    secondary: 'City Road',
    secondary_link: 'City Road Link',
    tertiary: 'Local Road',
    tertiary_link: 'Local Road Link',
    residential: 'Residential Road',
    service: 'Service Road',
  };
  return map[highwayType] || 'Road';
}

function generateDrains(roads, junctions, rng) {
  const instances = [];
  const MAX_PER_TILE = 300;
  const DRAIN_ROAD_TYPES = new Set([
    'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'service',
  ]);

  for (const road of roads) {
    if (!DRAIN_ROAD_TYPES.has(road.highwayType)) continue;
    const pts = road.points;
    if (!pts || pts.length < 2) continue;

    const roadW = getRoadWidth(road);
    const layer = (road.layer != null && Number.isFinite(road.layer)) ? road.layer : 0;
    if (layer !== 0) continue;
    const baseY = ROAD_Y_OFFSET;

    const spacing = 15 + rng() * 10;
    const samples = walkPolyline(pts, spacing);
    for (const s of samples) {
      if (instances.length >= MAX_PER_TILE) break;
      if (isNearJunction(s.x, s.z, junctions, 5)) continue;

      const nx = -s.tz, nz = s.tx;
      const offset = roadW * 0.5 - 0.3 + (rng() - 0.5) * 0.4;
      instances.push({
        x: s.x + nx * offset,
        z: s.z + nz * offset,
        baseY,
      });
    }
  }
  return instances;
}

// ─── Gantry mesh builder ─────────────────────────────────────────────────────

/**
 * Build gantry meshes: poles+beam (merged geometry) + sign boards (individual textured planes).
 * Returns array of meshes. Each gantry gets its own sign texture with road name.
 */
function buildGantryMeshes(gantryInstances) {
  if (gantryInstances.length === 0) return [];

  const { mat: poleMat } = getGantryPoleResources();
  const meshes = [];
  const _m = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _scale = new THREE.Vector3(1, 1, 1);
  const _axisY = new THREE.Vector3(0, 1, 0);

  // Collect pole geometries to merge into one mesh per tile
  const poleGeometries = [];

  for (const g of gantryInstances) {
    const halfSpan = Math.max(g.roadWidth * 0.5 + 1.5, 5);
    const angle = g.angle;

    // Compute rotation
    _q.setFromAxisAngle(_axisY, angle);

    // Left pole (local X = -halfSpan)
    const poleL = new THREE.BoxGeometry(0.25, GANTRY_POLE_HEIGHT, 0.25);
    const poleLocalL = new THREE.Vector3(-halfSpan, GANTRY_POLE_HEIGHT / 2 + g.baseY, 0);
    poleLocalL.applyQuaternion(_q).add(new THREE.Vector3(g.x, 0, g.z));
    poleL.translate(poleLocalL.x, poleLocalL.y, poleLocalL.z);
    poleGeometries.push(poleL);

    // Right pole (local X = +halfSpan)
    const poleR = new THREE.BoxGeometry(0.25, GANTRY_POLE_HEIGHT, 0.25);
    const poleLocalR = new THREE.Vector3(halfSpan, GANTRY_POLE_HEIGHT / 2 + g.baseY, 0);
    poleLocalR.applyQuaternion(_q).add(new THREE.Vector3(g.x, 0, g.z));
    poleR.translate(poleLocalR.x, poleLocalR.y, poleLocalR.z);
    poleGeometries.push(poleR);

    // Horizontal beam
    const beamLen = halfSpan * 2;
    const beam = new THREE.BoxGeometry(beamLen, GANTRY_BEAM_HEIGHT, 0.3);
    _pos.set(g.x, GANTRY_POLE_HEIGHT + g.baseY, g.z);
    _m.compose(_pos, _q, _scale);
    beam.applyMatrix4(_m);
    poleGeometries.push(beam);

    // Sign board: individual textured plane
    const boardW = Math.min(GANTRY_BOARD_W, beamLen * 0.6);
    const boardH = GANTRY_BOARD_H;
    const boardGeom = new THREE.PlaneGeometry(boardW, boardH);
    const tex = getGantrySignTexture(g.roadName, g.connectedNames);
    const boardMat = new THREE.MeshBasicMaterial({ map: tex, transparent: false, side: THREE.DoubleSide });

    const boardMesh = new THREE.Mesh(boardGeom, boardMat);
    const boardPos = new THREE.Vector3(0, GANTRY_POLE_HEIGHT - boardH * 0.5 - 0.1 + g.baseY, 0.2);
    boardPos.applyQuaternion(_q).add(new THREE.Vector3(g.x, 0, g.z));
    boardMesh.position.copy(boardPos);
    boardMesh.quaternion.copy(_q);
    boardMesh.castShadow = false;
    boardMesh.receiveShadow = false;
    meshes.push(boardMesh);

    // Back face — plain gray, offset slightly behind the front face
    const backGeom = new THREE.PlaneGeometry(boardW, boardH);
    const backMesh = new THREE.Mesh(backGeom, getSignBackMaterial());
    backMesh.userData.sharedMaterial = true;
    const backOffset = new THREE.Vector3(0, 0, -0.05);
    backOffset.applyQuaternion(_q);
    backMesh.position.copy(boardPos).add(backOffset);
    backMesh.quaternion.copy(_q);
    backMesh.castShadow = false;
    backMesh.receiveShadow = false;
    meshes.push(backMesh);
  }

  // Merge all pole/beam geometry into one mesh
  if (poleGeometries.length > 0) {
    const merged = mergeGeometries(poleGeometries);
    poleGeometries.forEach(g => g.dispose());
    if (merged) {
      const poleMesh = new THREE.Mesh(merged, poleMat);
      poleMesh.userData.sharedMaterial = true;
      poleMesh.castShadow = false;  // projected shadows used instead
      poleMesh.receiveShadow = false;
      meshes.unshift(poleMesh); // poles first
    }
  }

  return meshes;
}

// ─── Main build function ─────────────────────────────────────────────────────

/**
 * Build all road infrastructure meshes for a tile.
 * @param {object[]} roads - tile road data (points as {x, y} where y = world Z)
 * @param {string} tileKey - for deterministic seeding
 * @returns {{ meshes: THREE.Mesh[] }}
 */
export function buildRoadInfrastructure(roads, tileKey, getGroundY = null) {
  if (!roads || roads.length === 0) return { meshes: [] };

  const rng = seededRandom(tileKeyToSeed(tileKey));
  const intersections = findIntersections(roads);
  const junctionPts = intersections.map(i => ({ x: i.x, z: i.z }));

  // Roadside poles (signs, traffic lights) are baked at the ROAD elevation, which can be wrong/spiky and
  // leaves the pole hanging in the sky. Plant EVERY non-bridge pole on the terrain it stands in; if the
  // terrain sample fails, drop the instance entirely rather than leave a pole floating in the air.
  const groundInstances = (list) => {
    if (!list) return list;
    if (!getGroundY) return list;
    const out = [];
    for (const inst of list) {
      if (inst.bridge) { out.push(inst); continue; }
      const g = getGroundY(inst.x, inst.z);
      if (Number.isFinite(g)) { inst.baseY = g; out.push(inst); }   // always snap to terrain
      // else: unknown terrain here → skip (no floaters)
    }
    return out;
  };

  const meshes = [];
  const _m = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _scale = new THREE.Vector3(1, 1, 1);
  const _axisY = new THREE.Vector3(0, 1, 0);

  // 1. Speed limit signs (Indian-style yellow board with red circle)
  const signInstances = groundInstances(generateSpeedSigns(roads, junctionPts, rng));
  const speedSignMeshes = buildSpeedSignMeshes(signInstances);
  meshes.push(...speedSignMeshes);

  // 2. Traffic lights (pole + 3 animated bulb InstancedMeshes)
  const tlInstances = groundInstances(generateTrafficLights(intersections, roads));
  if (tlInstances.length > 0) {
    const { poleGeom, poleMat, bulbGeom } = getTLPoleResources();
    const count = tlInstances.length;

    // Pole InstancedMesh (dark structure: pole + arm + box)
    const poleMesh = new THREE.InstancedMesh(poleGeom, poleMat, count);
    poleMesh.userData.sharedGeometry = true;
    poleMesh.userData.sharedMaterial = true;
    poleMesh.castShadow = false;  // projected shadows used instead
    poleMesh.receiveShadow = false;

    // Bulb materials: MeshBasicMaterial — bulbs are self-lit, per-instance color controls on/off
    const { redMat, yellowMat, greenMat } = getTLBulbMaterials();

    // 3 bulb InstancedMeshes (one per color slot)
    const redMesh = new THREE.InstancedMesh(bulbGeom, redMat, count);
    const yellowMesh = new THREE.InstancedMesh(bulbGeom, yellowMat, count);
    const greenMesh = new THREE.InstancedMesh(bulbGeom, greenMat, count);
    redMesh.userData.sharedGeometry = true;
    redMesh.userData.sharedMaterial = true;
    yellowMesh.userData.sharedGeometry = true;
    yellowMesh.userData.sharedMaterial = true;
    greenMesh.userData.sharedGeometry = true;
    greenMesh.userData.sharedMaterial = true;
    [poleMesh, redMesh, yellowMesh, greenMesh].forEach(m => { m.castShadow = false; m.receiveShadow = false; });

    // Position each instance (pole + 3 bulbs)
    const _bulbPos = new THREE.Vector3();
    const staggerOffsets = [];
    for (let i = 0; i < count; i++) {
      const t = tlInstances[i];
      _pos.set(t.x, t.baseY, t.z);
      _q.setFromAxisAngle(_axisY, t.angle);
      _m.compose(_pos, _q, _scale);
      poleMesh.setMatrixAt(i, _m);

      // Bulb positions: local x=3 (arm tip), z=0.16 (front of box), dy per bulb
      for (let b = 0; b < 3; b++) {
        const bulbDef = TL_BULB_OFFSETS[b];
        _bulbPos.set(3, bulbDef.dy, 0.16);
        _bulbPos.applyQuaternion(_q);
        _bulbPos.x += t.x;
        _bulbPos.y += t.baseY;
        _bulbPos.z += t.z;
        _m.compose(_bulbPos, _q, _scale);
        if (b === 0) redMesh.setMatrixAt(i, _m);
        else if (b === 1) yellowMesh.setMatrixAt(i, _m);
        else greenMesh.setMatrixAt(i, _m);
      }

      // Initialize colors (all off except red)
      redMesh.setColorAt(i, TL_RED_ON);
      yellowMesh.setColorAt(i, TL_OFF_DAY);
      greenMesh.setColorAt(i, TL_OFF_DAY);

      // Stagger: hash-based offset so nearby lights don't all sync
      staggerOffsets.push(((t.x * 7 + t.z * 13) % TL_CYCLE + TL_CYCLE) % TL_CYCLE);
    }
    poleMesh.instanceMatrix.needsUpdate = true;
    redMesh.instanceMatrix.needsUpdate = true;
    yellowMesh.instanceMatrix.needsUpdate = true;
    greenMesh.instanceMatrix.needsUpdate = true;
    if (redMesh.instanceColor) redMesh.instanceColor.needsUpdate = true;
    if (yellowMesh.instanceColor) yellowMesh.instanceColor.needsUpdate = true;
    if (greenMesh.instanceColor) greenMesh.instanceColor.needsUpdate = true;

    meshes.push(poleMesh, redMesh, yellowMesh, greenMesh);

    // Register for animation
    _tlRegistry.push({ redMesh, yellowMesh, greenMesh, staggerOffsets });
  }

  // 3. Lane arrows (road decals)
  const arrowInstances = generateLaneArrows(intersections);
  if (arrowInstances.length > 0) {
    const { geom, mat } = getArrowResources();
    const arrowMesh = new THREE.InstancedMesh(geom, mat, arrowInstances.length);
    arrowMesh.userData.sharedGeometry = true;
    arrowMesh.userData.sharedMaterial = true;
    arrowMesh.castShadow = false;
    arrowMesh.receiveShadow = false;
    arrowMesh.renderOrder = 1;
    for (let i = 0; i < arrowInstances.length; i++) {
      const a = arrowInstances[i];
      _pos.set(a.x, a.baseY, a.z);
      _q.setFromAxisAngle(_axisY, a.angle);
      _m.compose(_pos, _q, _scale);
      arrowMesh.setMatrixAt(i, _m);
    }
    arrowMesh.instanceMatrix.needsUpdate = true;
    meshes.push(arrowMesh);
  }

  // 4. Direction boards (Barcelona/Spanish white urban directional signs)
  const boardInstances = generateDirectionBoards(intersections, roads, rng);
  const boardMeshes = buildDirectionBoardMeshes(boardInstances);
  meshes.push(...boardMeshes);

  // 5. Highway gantries (green boards with text + gray poles)
  const gantryInstances = generateGantries(roads, intersections);
  const gantryMeshes = buildGantryMeshes(gantryInstances);
  meshes.push(...gantryMeshes);

  // 6. Projected pole shadows for all infrastructure poles
  {
    const allPoles = [];
    // Speed sign poles
    for (const s of signInstances) allPoles.push({ x: s.x, z: s.z, y: s.baseY, height: 3.0 });
    // Traffic light poles
    for (const t of tlInstances) allPoles.push({ x: t.x, z: t.z, y: t.baseY, height: 5.0 });
    // Direction board poles
    for (const b of boardInstances) allPoles.push({ x: b.x, z: b.z, y: b.baseY, height: 4.0 });
    // Gantry poles — two poles per gantry (left + right of road) + horizontal beam shadow
    for (const g of gantryInstances) {
      const halfSpan = Math.max(g.roadWidth * 0.5 + 1.5, 5);
      const angle = g.angle;
      const _gq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
      // Left pole
      const pL = new THREE.Vector3(-halfSpan, 0, 0).applyQuaternion(_gq);
      allPoles.push({ x: g.x + pL.x, z: g.z + pL.z, y: g.baseY, height: 7.0 });
      // Right pole
      const pR = new THREE.Vector3(halfSpan, 0, 0).applyQuaternion(_gq);
      allPoles.push({ x: g.x + pR.x, z: g.z + pR.z, y: g.baseY, height: 7.0 });
    }

    if (allPoles.length > 0) {
      // Sun shadow direction (same as streetlightRenderer)
      const sunElevDeg = 35, sunAzDeg = 200;
      const sunPhi = (90 - sunElevDeg) * Math.PI / 180;
      const sunTheta = sunAzDeg * Math.PI / 180;
      const sunXZ_x = Math.sin(sunPhi) * Math.sin(sunTheta);
      const sunXZ_z = Math.sin(sunPhi) * Math.cos(sunTheta);
      const shadowAngle = Math.atan2(sunXZ_x, sunXZ_z) + Math.PI;

      const shadowGeom = new THREE.PlaneGeometry(0.3, 1);
      shadowGeom.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
      // Offset so shadow extends from pole base in one direction only
      shadowGeom.translate(0, 0, 0.5);
      const shadowMat = getPoleShadowMaterial();

      const shadowMesh = new THREE.InstancedMesh(shadowGeom, shadowMat, allPoles.length);
      shadowMesh.castShadow = false;
      shadowMesh.receiveShadow = false;
      shadowMesh.renderOrder = 1;
      shadowMesh.userData.sharedGeometry = true;
      shadowMesh.userData.sharedMaterial = true;

      const _sPos = new THREE.Vector3();
      const _sQ = new THREE.Quaternion();
      const _sScl = new THREE.Vector3();
      const _sAxisY = new THREE.Vector3(0, 1, 0);

      for (let i = 0; i < allPoles.length; i++) {
        const pole = allPoles[i];
        // Shadow length proportional to pole height / tan(elevation)
        const shadowLen = pole.height / Math.tan(sunElevDeg * Math.PI / 180);
        _sPos.set(pole.x, pole.y + 0.15, pole.z);
        _sQ.setFromAxisAngle(_sAxisY, shadowAngle);
        _sScl.set(1, 1, shadowLen);
        _m.compose(_sPos, _sQ, _sScl);
        shadowMesh.setMatrixAt(i, _m);
      }
      shadowMesh.instanceMatrix.needsUpdate = true;
      meshes.push(shadowMesh);
    }
  }

  // 7. Drain covers — disabled (looked like manholes/holes on road)

  return { meshes };
}
