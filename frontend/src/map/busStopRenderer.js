import * as THREE from 'three';
import { applyGroundLayer } from './groundLayers.js';   // v3 P1
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';

// ─── Night illumination ──────────────────────────────────────────────────────
const GLOW_PANEL_W    = 5.0;   // emissive panel width (under roof)
const GLOW_PANEL_D    = 1.2;   // emissive panel depth
const GLOW_PANEL_Y    = -0.08; // offset below roof underside
const POOL_SIZE       = 5.0;   // ground light pool diameter
const POOL_Y_OFFSET   = 0.10;  // above ground

let sharedGlowMat = null;
let sharedPoolMat = null;
let _busStopPoolTex = null;
let _sharedShelterMat = null;
let _sharedMarkingMat = null;

const GLOW_INTENSITY_DAY   = 0.0;
const GLOW_INTENSITY_NIGHT = 0.65; // was 3.0 → an effectively-solid bright panel that bloomed to a white blob; now a soft translucent glow
const POOL_OPACITY_DAY     = 0.0;
const POOL_OPACITY_NIGHT   = 0.6;

function createBusStopPoolTexture() {
  if (_busStopPoolTex) return _busStopPoolTex;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255, 220, 160, 0.7)');
  grad.addColorStop(0.5, 'rgba(255, 200, 120, 0.3)');
  grad.addColorStop(1, 'rgba(255, 180, 100, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  _busStopPoolTex = new THREE.CanvasTexture(canvas);
  _busStopPoolTex.needsUpdate = true;
  return _busStopPoolTex;
}

function getSharedGlowMat() {
  if (!sharedGlowMat) {
    sharedGlowMat = new THREE.MeshBasicMaterial({
      color: 0xffd898,
      transparent: true,
      opacity: GLOW_INTENSITY_DAY,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }
  return sharedGlowMat;
}

function getSharedPoolMat() {
  if (!sharedPoolMat) {
    sharedPoolMat = new THREE.MeshBasicMaterial({
      map: createBusStopPoolTexture(),
      transparent: true,
      opacity: POOL_OPACITY_DAY,
      depthWrite: false,
      side: THREE.DoubleSide,
      // v3 P1: EXEMPT from groundLayers by its own RULES — a transparent, depthWrite:false decal is
      // ordered by renderOrder, not by depth bias. The small offset here just keeps it off the
      // asphalt it sits on. assertGroundLayers() skips transparent+depthWrite:false for this reason.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
  }
  return sharedPoolMat;
}

/** Toggle bus stop shelter illumination for day/night. */
export function setBusStopNightMode(isNight) {
  if (sharedGlowMat) {
    sharedGlowMat.opacity = isNight ? GLOW_INTENSITY_NIGHT : GLOW_INTENSITY_DAY;
  }
  if (sharedPoolMat) {
    sharedPoolMat.opacity = isNight ? POOL_OPACITY_NIGHT : POOL_OPACITY_DAY;
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────
// Only motorways are access-controlled. Trunk roads in Delhi (Ring Road, Aurobindo Marg) are
// ground-level arterials that have bus stops — keep them. Skip elevated bridge segments instead.
const SKIP_HIGHWAY_TYPES = new Set(['motorway', 'motorway_link']);
const ALLOWED_HIGHWAY_TYPES = new Set([
  'primary', 'secondary', 'tertiary', 'residential', 'service', 'unclassified',
]);
const MAX_SNAP_DISTANCE = 50;
const MIN_INTERSECTION_DISTANCE = 20;
const SIDEWALK_OFFSET = 1.5;
const SHELTER_WIDTH = 7;
const SHELTER_DEPTH = 2;
const SHELTER_HEIGHT = 3.2;
// Texture is 128×256 (portrait, 1:2 ratio). With tex.rotation=π/2, the 256px dimension maps to U
// (along road). Natural proportions: U/V = 256/128 = 2 → 7m along road × 3.5m across = 36.6 px/m.
const MARKING_LENGTH = 7;
const MARKING_WIDTH = 3.5;
const MARKING_Y_OFFSET = 0.15;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findNearestRoad(sx, sz, roads) {
  let best = null;
  let bestDist = Infinity;

  for (const road of roads) {
    if (!road.points || road.points.length < 2) continue;
    const pts = road.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i].x, az = pts[i].y;        // road points are {x, y} after roadToWorld()
      const bx = pts[i + 1].x, bz = pts[i + 1].y;
      const dx = bx - ax, dz = bz - az;
      const lenSq = dx * dx + dz * dz;
      if (lenSq === 0) continue;
      const t = Math.max(0, Math.min(1, ((sx - ax) * dx + (sz - az) * dz) / lenSq));
      const nx = ax + t * dx;
      const nz = az + t * dz;
      const dist = Math.hypot(sx - nx, sz - nz);
      if (dist < bestDist) {
        bestDist = dist;
        const len = Math.sqrt(lenSq);
        const dirX = dx / len, dirZ = dz / len;
        best = {
          road,
          segIdx: i,
          nearestX: nx,
          nearestZ: nz,
          dist,
          dirX,
          dirZ,
          perpX: -dirZ,
          perpZ: dirX,
        };
      }
    }
  }
  return best;
}

/** Shortest distance from a point to a road's polyline (segments). */
function distToRoad(px, pz, road) {
  const pts = road.points;
  if (!pts || pts.length < 2) return Infinity;
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].x, az = pts[i].y;
    const bx = pts[i + 1].x, bz = pts[i + 1].y;
    const dx = bx - ax, dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    if (lenSq === 0) continue;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
    const d = Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
    if (d < best) best = d;
  }
  return best;
}

/**
 * True if (px,pz) sits inside (or too close to) ANY road's carriageway — i.e. the shelter would
 * intrude into a driving lane. `clearance` accounts for the shelter's own footprint. Checking every
 * road (not just the snapped one) is what stops a stop on a narrow service lane from landing in the
 * middle of the wide avenue running alongside it.
 */
function intrudesOnRoad(px, pz, roads, clearance) {
  for (const r of roads) {
    if (!r.points || r.points.length < 2) continue;
    if (r.bridge) continue;  // elevated — different level, ignore
    const halfW = (Number.isFinite(r.width) && r.width > 0 ? r.width : 6) / 2;
    if (distToRoad(px, pz, r) < halfW + clearance) return true;
  }
  return false;
}

function isNearEndpoint(road, segIdx, nearestX, nearestZ, threshold) {
  const pts = road.points;
  const p1 = pts[segIdx];
  const p2 = pts[segIdx + 1];
  return (
    Math.hypot(nearestX - p1.x, nearestZ - p1.y) < threshold ||
    Math.hypot(nearestX - p2.x, nearestZ - p2.y) < threshold
  );
}

// ─── Geometry builders ───────────────────────────────────────────────────────

function colorGeometry(geom, color) {
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;
  const count = geom.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geom;
}

const _dummy = new THREE.Object3D();

function placePart(geom, px, py, pz, ry = 0) {
  _dummy.position.set(px, py, pz);
  _dummy.rotation.set(0, ry, 0);
  _dummy.scale.set(1, 1, 1);
  _dummy.updateMatrix();
  const clone = geom.clone();
  clone.applyMatrix4(_dummy.matrix);
  return clone;
}

function buildShelterGeometry(ox, oz, oy, dirX, dirZ, side) {
  const angle = Math.atan2(-dirZ, dirX) + (side > 0 ? Math.PI : 0);
  const parts = [];
  const W = SHELTER_WIDTH;
  const D = SHELTER_DEPTH;
  const H = SHELTER_HEIGHT;
  const POLE_R = 0.06;
  const POLE_COLOR = 0x9A9A9A;    // steel grey
  const ROOF_COLOR = 0x3B6FA0;    // DTC blue roof
  const ROOF_EDGE  = 0x2C5580;    // darker blue trim
  const PANEL_COLOR = 0xC8D8E4;   // translucent glass blue-grey
  const BACK_COLOR  = 0xB0BEC5;   // back panel grey
  const BENCH_COLOR = 0x7A6B58;   // weathered wood
  const BENCH_LEG   = 0x6A6A6A;   // metal grey
  const PLATFORM_COLOR = 0xB8B2A6; // concrete base
  const SIGN_COLOR  = 0x2B5DA8;   // sign board blue
  const SIGN_WHITE  = 0xE8E8E0;   // sign face

  // ── Platform / base slab ──
  const platform = colorGeometry(new THREE.BoxGeometry(W + 0.6, 0.12, D + 0.4), PLATFORM_COLOR);
  parts.push(placePart(platform, 0, 0.06, 0));

  // ── 4 poles (front and back corners) ──
  const poleH = H - 0.12;
  const polePositions = [
    [-W / 2, D / 2 - 0.1],   // front-left
    [W / 2,  D / 2 - 0.1],   // front-right
    [-W / 2, -D / 2 + 0.1],  // back-left
    [W / 2,  -D / 2 + 0.1],  // back-right
  ];
  for (const [px, pz] of polePositions) {
    const pole = colorGeometry(new THREE.CylinderGeometry(POLE_R, POLE_R, poleH, 5), POLE_COLOR);
    parts.push(placePart(pole, px, 0.12 + poleH / 2, pz));
  }

  // ── Roof — main slab + front trim strip ──
  const roof = colorGeometry(new THREE.BoxGeometry(W + 0.4, 0.12, D + 0.3), ROOF_COLOR);
  parts.push(placePart(roof, 0, H, 0));
  // Front trim (colored band along road-facing edge)
  const trim = colorGeometry(new THREE.BoxGeometry(W + 0.4, 0.20, 0.08), ROOF_EDGE);
  parts.push(placePart(trim, 0, H - 0.10, D / 2 + 0.11));

  // ── Back panel (full height, opaque) ──
  const backPanel = colorGeometry(new THREE.BoxGeometry(W, H * 0.85, 0.06), BACK_COLOR);
  parts.push(placePart(backPanel, 0, 0.12 + H * 0.85 / 2, -D / 2 + 0.13));

  // ── Side panels (partial height, glass-like) ──
  const sidePanelH = H * 0.6;
  const leftSide = colorGeometry(new THREE.BoxGeometry(0.05, sidePanelH, D * 0.6), PANEL_COLOR);
  parts.push(placePart(leftSide, -W / 2 + 0.03, 0.12 + sidePanelH / 2, -D * 0.1));
  const rightSide = colorGeometry(new THREE.BoxGeometry(0.05, sidePanelH, D * 0.6), PANEL_COLOR);
  parts.push(placePart(rightSide, W / 2 - 0.03, 0.12 + sidePanelH / 2, -D * 0.1));

  // ── Bench — seat + 3 legs ──
  const seat = colorGeometry(new THREE.BoxGeometry(W * 0.75, 0.10, 0.45), BENCH_COLOR);
  parts.push(placePart(seat, 0, 0.50, -D / 2 + 0.45));
  for (let li = -1; li <= 1; li++) {
    const leg = colorGeometry(new THREE.BoxGeometry(0.06, 0.38, 0.06), BENCH_LEG);
    parts.push(placePart(leg, li * (W * 0.3), 0.31, -D / 2 + 0.45));
  }

  // ── Route sign board (on a short pole, above roof on one side) ──
  const signPoleH = 1.2;
  const signPole = colorGeometry(new THREE.CylinderGeometry(0.04, 0.04, signPoleH, 4), POLE_COLOR);
  parts.push(placePart(signPole, -W / 2 + 0.5, H + signPoleH / 2, 0));
  // Sign board
  const signBoard = colorGeometry(new THREE.BoxGeometry(1.4, 0.7, 0.06), SIGN_COLOR);
  parts.push(placePart(signBoard, -W / 2 + 0.5, H + signPoleH - 0.15, 0));
  // White face on front
  const signFace = colorGeometry(new THREE.BoxGeometry(1.2, 0.5, 0.02), SIGN_WHITE);
  parts.push(placePart(signFace, -W / 2 + 0.5, H + signPoleH - 0.15, 0.04));

  // ── Dustbin (small cylinder beside shelter) ──
  const bin = colorGeometry(new THREE.CylinderGeometry(0.2, 0.18, 0.6, 6), 0x5A6A5A);
  parts.push(placePart(bin, W / 2 + 0.5, 0.42, D / 2 - 0.3));
  const binLid = colorGeometry(new THREE.CylinderGeometry(0.22, 0.22, 0.05, 6), 0x4A5A4A);
  parts.push(placePart(binLid, W / 2 + 0.5, 0.73, D / 2 - 0.3));

  const merged = mergeGeometries(parts);
  parts.forEach(g => g.dispose());

  _dummy.position.set(ox, oy, oz);
  _dummy.rotation.set(0, angle, 0);
  _dummy.scale.set(1, 1, 1);
  _dummy.updateMatrix();
  merged.applyMatrix4(_dummy.matrix);

  // Compute world-space light position (center of roof underside)
  const lightLocal = new THREE.Vector3(0, H + GLOW_PANEL_Y, 0);
  lightLocal.applyMatrix4(_dummy.matrix);

  return { geometry: merged, lightPos: lightLocal, angle };
}

// Dashed-line rectangle: border of the bus stop bay drawn as individual dash quads
const DASH_LEN    = 0.6;  // length of each dash
const DASH_GAP    = 0.4;  // gap between dashes
const LINE_WIDTH  = 0.15; // stripe width

function buildMarkingGeometry(ox, oz, oy, dirX, dirZ) {
  const pos = [], idx = [];
  const y = oy + MARKING_Y_OFFSET;
  const halfL = MARKING_LENGTH / 2;
  const halfW = MARKING_WIDTH / 2;
  // perpendicular to road direction
  const perpX = -dirZ, perpZ = dirX;

  // Transform local (along, across) to world position
  // along = distance along road dir, across = distance along perp
  function toWorld(along, across) {
    return [ox + dirX * along + perpX * across, oz + dirZ * along + perpZ * across];
  }

  // Emit a quad from 4 world XZ points
  function dashQuad(a, b, c, d) {
    const bi = pos.length / 3;
    pos.push(a[0], y, a[1], b[0], y, b[1], c[0], y, c[1], d[0], y, d[1]);
    idx.push(bi, bi+1, bi+2, bi, bi+2, bi+3);
  }

  const hw = LINE_WIDTH / 2;

  // Two long sides (along road direction) — dashed
  for (const side of [-1, 1]) {
    const across = side * halfW;
    let s = -halfL;
    while (s < halfL) {
      const end = Math.min(s + DASH_LEN, halfL);
      dashQuad(
        toWorld(s,   across - hw),
        toWorld(end, across - hw),
        toWorld(end, across + hw),
        toWorld(s,   across + hw),
      );
      s = end + DASH_GAP;
    }
  }

  // Two short sides (across road) — dashed
  for (const side of [-1, 1]) {
    const along = side * halfL;
    let s = -halfW;
    while (s < halfW) {
      const end = Math.min(s + DASH_LEN, halfW);
      dashQuad(
        toWorld(along - hw, s),
        toWorld(along + hw, s),
        toWorld(along + hw, end),
        toWorld(along - hw, end),
      );
      s = end + DASH_GAP;
    }
  }

  if (pos.length === 0) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setIndex(idx);
  return geom;
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function buildBusStopMeshes(busStops, roads, getElevationAt) {
  if (!busStops?.length || !roads?.length) {
    return { shelterMesh: null, markingMesh: null, glowMesh: null, poolMesh: null };
  }

  const shelterGeoms = [];
  const markingGeoms = [];
  const lightPositions = []; // { x, y, z, angle } for glow panels + pools

  for (const stop of busStops) {
    const [sx, sz] = stop.point;

    const hit = findNearestRoad(sx, sz, roads);
    if (!hit) continue;
    if (hit.dist > MAX_SNAP_DISTANCE) continue;
    if (SKIP_HIGHWAY_TYPES.has(hit.road.highwayType)) continue;
    if (hit.road.bridge) continue;  // don't place shelters on elevated flyover segments
    if (isNearEndpoint(hit.road, hit.segIdx, hit.nearestX, hit.nearestZ, MIN_INTERSECTION_DISTANCE)) continue;

    // Determine which side of the road the stop is on (prefer it, but we'll switch if it's blocked)
    const dotPerp = (sx - hit.nearestX) * hit.perpX + (sz - hit.nearestZ) * hit.perpZ;
    const preferredSide = dotPerp >= 0 ? 1 : -1;

    const roadHalfWidth = (Number.isFinite(hit.road.width) && hit.road.width > 0 ? hit.road.width : 6) / 2;
    // Keep the whole shelter footprint off the carriageway: its road-facing edge is ~SHELTER_DEPTH/2
    // in front of its centre, so require that much clearance beyond every road's half-width.
    const CLEARANCE = SHELTER_DEPTH / 2 + 0.4;
    const baseOffset = roadHalfWidth + SIDEWALK_OFFSET;

    // Search outward on the preferred side, then the other side, for a spot that clears EVERY road.
    let px, pz, side = preferredSide, found = false;
    for (const trySide of [preferredSide, -preferredSide]) {
      for (let extra = 0; extra <= 7; extra += 0.7) {
        const off = baseOffset + extra;
        const cx = hit.nearestX + hit.perpX * off * trySide;
        const cz = hit.nearestZ + hit.perpZ * off * trySide;
        if (!intrudesOnRoad(cx, cz, roads, CLEARANCE)) {
          px = cx; pz = cz; side = trySide; found = true; break;
        }
      }
      if (found) break;
    }
    // Couldn't find a clear sidewalk spot (e.g. a stop stranded between dual carriageways) → skip it
    // rather than plant a shelter in a driving lane.
    if (!found) continue;
    const py = getElevationAt ? (getElevationAt(px, pz) || 0) : 0;

    // Marking: placed ON the road surface, centred in the nearside lane (road edge − half marking width)
    const markOffset = Math.max(0, roadHalfWidth - MARKING_WIDTH / 2) * side;
    const mx = hit.nearestX + hit.perpX * markOffset;
    const mz = hit.nearestZ + hit.perpZ * markOffset;
    const my = getElevationAt ? (getElevationAt(mx, mz) || 0) : 0;

    const result = buildShelterGeometry(px, pz, py, hit.dirX, hit.dirZ, side);
    shelterGeoms.push(result.geometry);
    markingGeoms.push(buildMarkingGeometry(mx, mz, my, hit.dirX, hit.dirZ));
    lightPositions.push({ x: result.lightPos.x, y: result.lightPos.y, z: result.lightPos.z, angle: result.angle, groundY: py });
  }

  if (shelterGeoms.length === 0) {
    return { shelterMesh: null, markingMesh: null, glowMesh: null, poolMesh: null };
  }

  // Merge all shelter geometries into one mesh
  if (!_sharedShelterMat) {
    _sharedShelterMat = new THREE.MeshLambertMaterial({
      vertexColors: true,
    });
  }
  const shelterMat = _sharedShelterMat;
  const mergedShelter = mergeGeometries(shelterGeoms);
  shelterGeoms.forEach(g => g.dispose());
  const shelterMesh = new THREE.Mesh(mergedShelter, shelterMat);
  shelterMesh.castShadow = false;  // projected shadows used for small props
  shelterMesh.receiveShadow = true;
  shelterMesh.userData.sharedMaterial = true;  // _sharedShelterMat is a singleton — don't dispose on unload

  // Merge all marking geometries into one mesh
  const validMarkings = markingGeoms.filter(g => g != null);
  let markingMesh = null;
  if (validMarkings.length > 0) {
    if (!_sharedMarkingMat) {
      _sharedMarkingMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      // v3 P1: was a hand-rolled -2, which is LESS negative than road's -4 — so the bus-bay
      // marking lost the depth test to the asphalt it is painted on. Exactly the bug P0-14 found in
      // lane arrows and drain covers, surfaced here by the assertGroundLayers dev guard.
      applyGroundLayer(_sharedMarkingMat, 'marking');
    }
    const markingMat = _sharedMarkingMat;
    const mergedMarking = mergeGeometries(validMarkings);
    validMarkings.forEach(g => g.dispose());
    markingMesh = new THREE.Mesh(mergedMarking, markingMat);
    markingMesh.receiveShadow = false;
    markingMesh.userData.sharedMaterial = true;  // _sharedMarkingMat is a singleton — don't dispose on unload
  }

  // ── Night illumination meshes ──
  // Glow panel (emissive rectangle under each roof) — merged into one mesh
  const glowGeoms = [];
  const poolGeoms = [];
  const _obj = new THREE.Object3D();

  const glowPlane = new THREE.PlaneGeometry(GLOW_PANEL_W, GLOW_PANEL_D);
  glowPlane.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2)); // lie flat facing down

  const poolPlane = new THREE.PlaneGeometry(POOL_SIZE, POOL_SIZE);
  poolPlane.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2)); // lie flat facing up

  for (const lp of lightPositions) {
    // Glow panel under roof — rotated to match shelter orientation
    const gClone = glowPlane.clone();
    _obj.position.set(lp.x, lp.y, lp.z);
    _obj.rotation.set(0, lp.angle, 0);
    _obj.scale.set(1, 1, 1);
    _obj.updateMatrix();
    gClone.applyMatrix4(_obj.matrix);
    glowGeoms.push(gClone);

    // Ground pool (circular, no rotation needed)
    const pClone = poolPlane.clone();
    _obj.position.set(lp.x, lp.groundY + POOL_Y_OFFSET, lp.z);
    _obj.rotation.set(0, 0, 0);
    _obj.scale.set(1, 1, 1);
    _obj.updateMatrix();
    pClone.applyMatrix4(_obj.matrix);
    poolGeoms.push(pClone);
  }
  glowPlane.dispose();
  poolPlane.dispose();

  let glowMesh = null;
  if (glowGeoms.length > 0) {
    const merged = mergeGeometries(glowGeoms);
    glowGeoms.forEach(g => g.dispose());
    glowMesh = new THREE.Mesh(merged, getSharedGlowMat());
    glowMesh.castShadow = false;
    glowMesh.receiveShadow = false;
    glowMesh.userData.sharedMaterial = true;
  }

  let poolMesh = null;
  if (poolGeoms.length > 0) {
    const merged = mergeGeometries(poolGeoms);
    poolGeoms.forEach(g => g.dispose());
    poolMesh = new THREE.Mesh(merged, getSharedPoolMat());
    poolMesh.castShadow = false;
    poolMesh.receiveShadow = false;
    poolMesh.userData.sharedMaterial = true;
  }

  return { shelterMesh, markingMesh, glowMesh, poolMesh };
}
