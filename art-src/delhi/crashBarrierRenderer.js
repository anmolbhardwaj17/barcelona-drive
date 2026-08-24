/**
 * Indian highway crash barriers on sharp road curves.
 * Yellow-black striped concrete barriers placed on the outer side of sharp curves
 * on major roads (motorway, trunk, primary, secondary + _link variants).
 *
 * Road point convention: p.x = world X, p.y = world Z.
 * Vertical Y comes from p.elevation (raw DEM) via toNormalizedRoadY, or layer * 6m.
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { toNormalizedRoadY } from '../roadElevation.js';
import { getWorldElevationOffset } from '../elevationOffset.js';
import { getOriginOffset } from '../originOffset.js';

// ── Constants ────────────────────────────────────────────────────────────────
const BARRIER_HEIGHT = 0.9;
const BASE_WIDTH = 0.8;
const TOP_WIDTH = 0.5;
const BARRIER_LENGTH = 3.5;
const GAP = 0.05;
const STEP = BARRIER_LENGTH + GAP;
const LAYER_HEIGHT_STEP = 6;
const ROAD_VISUAL_ABOVE_TERRAIN = 0.05;

const OFFSET_FROM_EDGE = 1.5;
const DEFLECTION_THRESHOLD = 15 * (Math.PI / 180);
const ZONE_EXTEND = 8;

const ELIGIBLE_TYPES = new Set([
  'motorway', 'motorway_link',
  'trunk', 'trunk_link',
  'primary', 'primary_link',
  'secondary', 'secondary_link',
]);

// ── Shared materials (created once) ──────────────────────────────────────────
let _stripeMat = null;
let _greyMat = null;

function getStripeMaterial() {
  if (_stripeMat) return _stripeMat;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  // Vertical bold yellow-black stripes
  const sw = 8;
  for (let x = 0; x < size; x += sw) {
    ctx.fillStyle = (Math.floor(x / sw) % 2 === 0) ? '#FFD700' : '#1A1A1A';
    ctx.fillRect(x, 0, sw, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  _stripeMat = new THREE.MeshLambertMaterial({ map: tex });
  _stripeMat.userData = { sharedMaterial: true };
  return _stripeMat;
}

function getGreyMaterial() {
  if (_greyMat) return _greyMat;
  _greyMat = new THREE.MeshLambertMaterial({ color: 0x8A8578 });
  _greyMat.userData = { sharedMaterial: true };
  return _greyMat;
}

// ── Barrier geometry builders ────────────────────────────────────────────────
// Returns { stripeGeom, greyGeom } — separate geometries for the two materials.

function createBarrierGeometries(length, tangent, perp, cx, cy, cz) {
  const halfLen = length / 2;
  const halfBase = BASE_WIDTH / 2;
  const halfTop = TOP_WIDTH / 2;
  const h = BARRIER_HEIGHT;
  const tx = tangent.x, tz = tangent.z;
  const px = perp.x, pz = perp.z;

  const wp = (along, across, y) => [
    cx + along * tx + across * px,
    cy + y,
    cz + along * tz + across * pz,
  ];

  const BFL = wp(-halfLen, -halfBase, 0);
  const BFR = wp(-halfLen,  halfBase, 0);
  const BBR = wp( halfLen,  halfBase, 0);
  const BBL = wp( halfLen, -halfBase, 0);
  const TFL = wp(-halfLen, -halfTop,  h);
  const TFR = wp(-halfLen,  halfTop,  h);
  const TBR = wp( halfLen,  halfTop,  h);
  const TBL = wp( halfLen, -halfTop,  h);

  const uLen = length / 2.0;

  // ── Stripe geometry: two long sides running along the road (2 quads = 8 verts) ──
  const sPos = new Float32Array(8 * 3);
  const sUv  = new Float32Array(8 * 2);
  const sIdx = [];

  // Left long side (faces outward, -perp): BBL(0), BFL(1), TFL(2), TBL(3)
  const sLeft = [BBL, BFL, TFL, TBL];
  const sLeftUV = [[0,0],[uLen,0],[uLen,1],[0,1]];
  for (let i = 0; i < 4; i++) {
    sPos[i*3] = sLeft[i][0]; sPos[i*3+1] = sLeft[i][1]; sPos[i*3+2] = sLeft[i][2];
    sUv[i*2] = sLeftUV[i][0]; sUv[i*2+1] = sLeftUV[i][1];
  }
  sIdx.push(0,1,2, 0,2,3);

  // Right long side (faces outward, +perp): BFR(4), BBR(5), TBR(6), TFR(7)
  const sRight = [BFR, BBR, TBR, TFR];
  const sRightUV = [[0,0],[uLen,0],[uLen,1],[0,1]];
  for (let i = 0; i < 4; i++) {
    const j = 4 + i;
    sPos[j*3] = sRight[i][0]; sPos[j*3+1] = sRight[i][1]; sPos[j*3+2] = sRight[i][2];
    sUv[j*2] = sRightUV[i][0]; sUv[j*2+1] = sRightUV[i][1];
  }
  sIdx.push(4,5,6, 4,6,7);

  const stripeGeom = new THREE.BufferGeometry();
  stripeGeom.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
  stripeGeom.setAttribute('uv', new THREE.BufferAttribute(sUv, 2));
  stripeGeom.setIndex(sIdx);
  stripeGeom.computeVertexNormals();

  // ── Grey geometry: two short end caps + top (3 quads = 12 verts) ──
  const gPos = new Float32Array(12 * 3);
  const gIdx = [];

  // Front end cap: BFL(0), BFR(1), TFR(2), TFL(3)
  const gFront = [BFL, BFR, TFR, TFL];
  for (let i = 0; i < 4; i++) {
    gPos[i*3] = gFront[i][0]; gPos[i*3+1] = gFront[i][1]; gPos[i*3+2] = gFront[i][2];
  }
  gIdx.push(0,1,2, 0,2,3);

  // Back end cap: BBR(4), BBL(5), TBL(6), TBR(7)
  const gBack = [BBR, BBL, TBL, TBR];
  for (let i = 0; i < 4; i++) {
    const j = 4 + i;
    gPos[j*3] = gBack[i][0]; gPos[j*3+1] = gBack[i][1]; gPos[j*3+2] = gBack[i][2];
  }
  gIdx.push(4,5,6, 4,6,7);

  // Top: TFL(8), TFR(9), TBR(10), TBL(11)
  const gTop = [TFL, TFR, TBR, TBL];
  for (let i = 0; i < 4; i++) {
    const j = 8 + i;
    gPos[j*3] = gTop[i][0]; gPos[j*3+1] = gTop[i][1]; gPos[j*3+2] = gTop[i][2];
  }
  gIdx.push(8,9,10, 8,10,11);

  const greyGeom = new THREE.BufferGeometry();
  greyGeom.setAttribute('position', new THREE.BufferAttribute(gPos, 3));
  greyGeom.setIndex(gIdx);
  greyGeom.computeVertexNormals();

  return { stripeGeom, greyGeom };
}

// ── Polyline utilities (points as { x, y } where y=worldZ) ──────────────────
function computeArcLengths(pts) {
  const lengths = [0];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dz = pts[i].y - pts[i - 1].y;
    lengths.push(lengths[i - 1] + Math.sqrt(dx * dx + dz * dz));
  }
  return lengths;
}

function samplePolyline(pts, arcLengths, dist) {
  if (dist <= 0) return { x: pts[0].x, z: pts[0].y, elev: pts[0].elevation };
  const total = arcLengths[arcLengths.length - 1];
  if (dist >= total) {
    const last = pts[pts.length - 1];
    return { x: last.x, z: last.y, elev: last.elevation };
  }
  for (let i = 1; i < arcLengths.length; i++) {
    if (arcLengths[i] >= dist) {
      const segLen = arcLengths[i] - arcLengths[i - 1];
      const t = segLen > 0 ? (dist - arcLengths[i - 1]) / segLen : 0;
      const elevA = pts[i - 1].elevation;
      const elevB = pts[i].elevation;
      let elev;
      if (Number.isFinite(elevA) && Number.isFinite(elevB)) {
        elev = elevA + t * (elevB - elevA);
      } else if (Number.isFinite(elevA)) {
        elev = elevA;
      } else if (Number.isFinite(elevB)) {
        elev = elevB;
      }
      return {
        x: pts[i - 1].x + t * (pts[i].x - pts[i - 1].x),
        z: pts[i - 1].y + t * (pts[i].y - pts[i - 1].y),
        elev,
      };
    }
  }
  const last = pts[pts.length - 1];
  return { x: last.x, z: last.y, elev: last.elevation };
}

function sampleTangent(pts, arcLengths, dist) {
  const eps = 0.5;
  const a = samplePolyline(pts, arcLengths, dist - eps);
  const b = samplePolyline(pts, arcLengths, dist + eps);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.sqrt(dx * dx + dz * dz) || 1;
  return { x: dx / len, z: dz / len };
}

// ── Curve detection ──────────────────────────────────────────────────────────
function detectCurveZones(pts, arcLengths) {
  const zones = [];
  const totalLen = arcLengths[arcLengths.length - 1];

  for (let i = 1; i < pts.length - 1; i++) {
    const ax = pts[i].x - pts[i - 1].x;
    const az = pts[i].y - pts[i - 1].y;
    const aLen = Math.sqrt(ax * ax + az * az) || 1;
    const bx = pts[i + 1].x - pts[i].x;
    const bz = pts[i + 1].y - pts[i].y;
    const bLen = Math.sqrt(bx * bx + bz * bz) || 1;

    const nax = ax / aLen, naz = az / aLen;
    const nbx = bx / bLen, nbz = bz / bLen;

    const dot = nax * nbx + naz * nbz;
    const angle = Math.acos(Math.min(1, Math.max(-1, dot)));
    if (angle < DEFLECTION_THRESHOLD) continue;

    const cross = nax * nbz - naz * nbx;
    const side = cross > 0 ? 'right' : 'left';

    const d = arcLengths[i];
    const start = Math.max(0, d - ZONE_EXTEND);
    const end = Math.min(totalLen, d + ZONE_EXTEND);
    zones.push({ start, end, side });
  }

  if (zones.length === 0) return zones;
  zones.sort((a, b) => a.start - b.start);
  const merged = [zones[0]];
  for (let i = 1; i < zones.length; i++) {
    const last = merged[merged.length - 1];
    if (zones[i].side === last.side && zones[i].start <= last.end) {
      last.end = Math.max(last.end, zones[i].end);
    } else {
      merged.push(zones[i]);
    }
  }
  return merged;
}

// ── Compute vertical Y for a road point ──────────────────────────────────────
function computeY(elev, layer, elevationOffset, vertExag) {
  if (Number.isFinite(elev)) {
    return toNormalizedRoadY(elev, elevationOffset, vertExag) + ROAD_VISUAL_ABOVE_TERRAIN;
  }
  const l = (layer != null && Number.isFinite(layer)) ? layer : 0;
  return l * LAYER_HEIGHT_STEP;
}

// ── Roundabout detection ─────────────────────────────────────────────────────
const ROUNDABOUT_PROXIMITY = 30; // metres — suppress barriers this far from any roundabout center

/**
 * Detect roundabout roads and return exclusion zones [{cx, cz, rSq}].
 * A roundabout is any road whose first and last points are within 5m (closed loop),
 * OR explicitly flagged closedLoop.
 */
function detectRoundaboutZones(roads) {
  const zones = [];
  for (const road of roads) {
    const pts = road.points;
    if (!pts || pts.length < 3) continue;
    const first = pts[0], last = pts[pts.length - 1];
    const dx = last.x - first.x, dz = last.y - first.y;
    const isClosed = road.closedLoop || (dx * dx + dz * dz < 25); // 5m threshold
    if (!isClosed) continue;
    // Compute centroid and radius of the loop
    let cx = 0, cz = 0;
    for (const p of pts) { cx += p.x; cz += p.y; }
    cx /= pts.length; cz /= pts.length;
    let maxDistSq = 0;
    for (const p of pts) {
      const d = (p.x - cx) ** 2 + (p.y - cz) ** 2;
      if (d > maxDistSq) maxDistSq = d;
    }
    const radius = Math.sqrt(maxDistSq) + ROUNDABOUT_PROXIMITY;
    zones.push({ cx, cz, rSq: radius * radius });
  }
  return zones;
}

function isNearRoundabout(x, z, roundaboutZones) {
  for (const r of roundaboutZones) {
    if ((x - r.cx) ** 2 + (z - r.cz) ** 2 < r.rSq) return true;
  }
  return false;
}

// ── Collect barrier placement data (shared by visual + physics) ──────────────
function collectBarrierPlacements(roads, elevationOffset, vertExag) {
  const placements = [];
  const roundaboutZones = detectRoundaboutZones(roads);

  for (const road of roads) {
    if (!ELIGIBLE_TYPES.has(road.highwayType)) continue;
    if (road.tunnel) continue;
    if (road.closedLoop) continue; // skip roundabout circle itself
    if (road.bridge) continue; // bridges have guard rails instead
    if (road.layer != null && road.layer > 0) continue; // only ground-level roads
    const pts = road.points;
    if (!pts || pts.length < 3) continue;

    const arcLengths = computeArcLengths(pts);
    const totalRoadLen = arcLengths[arcLengths.length - 1] || 0;
    const zones = detectCurveZones(pts, arcLengths);
    if (zones.length === 0) continue;

    const roadHalfWidth = (road.width || 7) / 2;
    const layer = road.layer;
    const ENDPOINT_MARGIN = 10; // metres — no barriers within this of road start/end

    for (const zone of zones) {
      let dist = zone.start;
      while (dist + BARRIER_LENGTH <= zone.end) {
        const mid = dist + BARRIER_LENGTH / 2;

        // Skip barriers near road endpoints (junction/merge zones)
        if (mid < ENDPOINT_MARGIN || mid > totalRoadLen - ENDPOINT_MARGIN) {
          dist += STEP;
          continue;
        }
        const pos = samplePolyline(pts, arcLengths, mid);
        const tan = sampleTangent(pts, arcLengths, mid);

        const perp = zone.side === 'right'
          ? { x: tan.z, z: -tan.x }
          : { x: -tan.z, z: tan.x };

        const offset = roadHalfWidth + OFFSET_FROM_EDGE;
        const cx = pos.x + perp.x * offset;
        const cz = pos.z + perp.z * offset;

        // Skip barriers near roundabouts (on approach roads too)
        if (roundaboutZones.length > 0 && isNearRoundabout(pos.x, pos.z, roundaboutZones)) {
          dist += STEP;
          continue;
        }

        const cy = computeY(pos.elev, layer, elevationOffset, vertExag);

        placements.push({ cx, cy, cz, tan, perp });
        dist += STEP;
      }
    }
  }
  return placements;
}

// ── Visual mesh export ───────────────────────────────────────────────────────
/**
 * Returns a THREE.Group containing two meshes (stripes + grey concrete),
 * or null if no barriers needed.
 */
export function buildCrashBarriers(roads) {
  if (!roads || roads.length === 0) return null;

  const elevationOffset = getWorldElevationOffset() ?? 0;
  const vertExag = (CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION))
    ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;

  const placements = collectBarrierPlacements(roads, elevationOffset, vertExag);
  if (placements.length === 0) return null;

  const stripeGeoms = [];
  const greyGeoms = [];
  for (const p of placements) {
    const { stripeGeom, greyGeom } = createBarrierGeometries(BARRIER_LENGTH, p.tan, p.perp, p.cx, p.cy, p.cz);
    stripeGeoms.push(stripeGeom);
    greyGeoms.push(greyGeom);
  }

  const mergedStripe = mergeGeometries(stripeGeoms, false);
  const mergedGrey   = mergeGeometries(greyGeoms, false);
  stripeGeoms.forEach(g => g.dispose());
  greyGeoms.forEach(g => g.dispose());

  if (!mergedStripe && !mergedGrey) return null;

  const group = new THREE.Group();
  group.name = 'crashBarriers';

  if (mergedStripe) {
    const m = new THREE.Mesh(mergedStripe, getStripeMaterial());
    m.frustumCulled = false;
    group.add(m);
  }
  if (mergedGrey) {
    const m = new THREE.Mesh(mergedGrey, getGreyMaterial());
    m.frustumCulled = false;
    group.add(m);
  }

  return group;
}

// ── Physics collider export ──────────────────────────────────────────────────
export function buildCrashBarrierColliders(roads) {
  if (!roads || roads.length === 0) return null;

  const elevationOffset = getWorldElevationOffset() ?? 0;
  const vertExag = (CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION))
    ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;

  const placements = collectBarrierPlacements(roads, elevationOffset, vertExag);
  if (placements.length === 0) return null;

  const physicsOrigin = getOriginOffset();
  const body = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC });

  const halfH = BARRIER_HEIGHT / 2;
  const halfW = BASE_WIDTH / 2;
  const halfLen = BARRIER_LENGTH / 2;
  // Box: X=thickness(across road), Y=height, Z=length(along road) — matches barrierRenderer convention
  const shape = new CANNON.Box(new CANNON.Vec3(halfW, halfH, halfLen));

  for (const p of placements) {
    const px = -(p.cx - physicsOrigin.x);
    const pz = p.cz - physicsOrigin.z;
    const py = p.cy + halfH;

    // Physics tangent: (-tan.x, tan.z) — dx,dz in physics space
    // atan2(dx, dz) aligns local +Z with the tangent (same as barrierRenderer)
    const dx = -p.tan.x;
    const dz = p.tan.z;
    const yaw = Math.atan2(dx, dz);
    const q = new CANNON.Quaternion();
    q.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);

    body.addShape(shape, new CANNON.Vec3(px, py, pz), q);
  }

  return body;
}
