/**
 * Procedural streetlights along road edges: instanced poles + lamp heads + road pool decals.
 *
 * Per tile ONE InstancedMesh is created for poles, one for lamp heads, one for ground pools.
 * Returns { poleMesh, lampMesh, poolMesh, positions } where positions are lamp-head world
 * coords (used by the dynamic PointLight pool in main.js).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { toNormalizedRoadY } from '../roadElevation.js';
import { getWorldElevationOffset } from '../elevationOffset.js';

const POLE_HEIGHT    = 8;
const POLE_RADIUS    = 0.08;
const ARM_LENGTH     = 1.8;   // arm overhangs road by ARM_LENGTH - EDGE_OFFSET
const ARM_RADIUS     = 0.055;
const LAMP_SIZE      = 0.3;
const LIGHT_SPACING  = 22;   // denser lamps — nights felt too dark/sparse (was 30)
const EDGE_OFFSET    = 0.6;   // pole close to curb
const JUNCTION_SKIP  = 10;
const LAYER_HEIGHT_STEP = 6;

const POOL_SIZE      = 16;    // m diameter — falloff room without an 18 m plane that fights slopes
const POOL_Y_OFFSET  = 0.38;  // just above the road+curb+sidewalk stack (0.52 floated at tyre height on
                              // flat streets; 0.34 got sliced by lifted sidewalk decks) — the pool plane is
                              // flat, so slopes will always clip ONE edge slightly; smaller pool helps
                              // lamp stands on the higher sidewalk, so the curb was clipping half the glow.

// Base shadow length for pole contact shadow
const BASE_SHADOW_LEN = 10.0;
// Sun shadow direction angle on XZ plane (opposite of sun azimuth projection)
// Sun azimuth 200° → shadow falls NE → angle = atan2(-sunX, -sunZ) on XZ plane
const SUN_ELEV_DEG = 35;
const SUN_AZ_DEG   = 200;
const _sunPhi   = (90 - SUN_ELEV_DEG) * Math.PI / 180;
const _sunTheta = SUN_AZ_DEG * Math.PI / 180;
// sunDir in Three.js spherical: (sinPhi*sinTheta, cosPhi, sinPhi*cosTheta)
const _sunX = Math.sin(_sunPhi) * Math.sin(_sunTheta);
const _sunZ = Math.sin(_sunPhi) * Math.cos(_sunTheta);
// Shadow direction = opposite of sun XZ projection
const SHADOW_ANGLE = Math.atan2(_sunX, _sunZ) + Math.PI;

const LIGHT_ROAD_TYPES = new Set([
  'motorway','trunk','primary','secondary','tertiary',
  'residential','unclassified','living_street',
]);

const ROAD_WIDTHS_BY_TYPE = {
  motorway: 15, trunk: 12, primary: 10, secondary: 8,
  tertiary: 7, residential: 6, service: 5, unclassified: 6,
};

// Convex mirror constants
const MIRROR_ROAD_TYPES = new Set(['residential', 'living_street', 'service']);
const MIRROR_RADIUS = 0.75;       // mirror disc radius in metres
const MIRROR_HEIGHT = 3.5;        // height on pole where mirror is mounted
const MIRROR_OFFSET = 0.4;       // offset outward from pole to avoid collision
const MIRROR_JUNCTION_DIST = 18;  // max distance from junction to place mirror

function getRoadWidth(road) {
  const osm = Number(road.width);
  if (osm > 0) return Math.min(30, osm);
  return ROAD_WIDTHS_BY_TYPE[road.highwayType] || 6;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Shared resources — created once across all tiles
// ---------------------------------------------------------------------------
let sharedPoleGeom = null;
let sharedPoleMat  = null;
let sharedArmGeom  = null;
let sharedArmMat   = null;
let sharedLampGeom = null;
let sharedLampMat  = null;
let sharedMirrorGeom = null;
let sharedMirrorMat  = null;
let sharedMirrorRimGeom = null;
let sharedMirrorRimMat  = null;
let sharedMirrorBackMat = null;
let sharedPoolGeom = null;
let sharedPoolMat  = null;
let sharedPoleShadowGeom = null;
let sharedPoleShadowMat  = null;

// Stored defaults so setters work even before first tile builds the material.
let _lampEmissiveIntensity = 0.25; // day default — night toggle boosts (setStreetlightNightMode)
let _poolOpacity = 0.0;             // day default — no ground light pools in daylight
let _bridgeNightMode = false;
const _bridgeNightCallbacks = new Set();

/** Update lamp emissive on all current and future tiles (shared material). */
export function setLampEmissiveIntensity(v) {
  _lampEmissiveIntensity = v;
  if (sharedLampMat) sharedLampMat.emissiveIntensity = v;
}

/** Update ground-pool opacity on all current and future tiles (shared material). */
export function setPoolOpacity(v) {
  _poolOpacity = Math.max(0, Math.min(1, v));
  if (sharedPoolMat) sharedPoolMat.opacity = _poolOpacity;
}

/** Day/night for street lamps: bright glowing heads + warm ground pools at night, near-off by day. */
export function setStreetlightNightMode(isNight) {
  setLampEmissiveIntensity(isNight ? 2.8 : 0.25);
  setPoolOpacity(isNight ? 0.95 : 0.0);
}

/** Toggle Indian tricolor on bridge poles (saffron/white/green) for night mode. */
export function setBridgePoleNightMode(isNight) {
  _bridgeNightMode = isNight;
  for (const cb of _bridgeNightCallbacks) cb(isNight);
}

/** Radial gradient texture — warm yellow pool fading to transparent edges. */
let _streetlightPoolTex = null;
function createPoolTexture() {
  if (_streetlightPoolTex) return _streetlightPoolTex;
  const size = 256;   // 128 upscaled to a 14 m decal showed soft-banding; 256 stays smooth
  const canvas = document.createElement('canvas');
  canvas.width  = size;
  canvas.height = size;
  const ctx  = canvas.getContext('2d');
  const cx = size / 2, cy = size / 2, r = size / 2;
  // Warm sodium pool — computed per-pixel inverse-square-ish falloff instead of a stepped canvas
  // gradient: bright tight core, long smooth tail, zero banding (the old 3-stop radial read as a
  // flat "sticker"). Colour shifts from warm white-amber at the core to deep sodium orange at the
  // fringe, like a real lamp's spectrum spreading.
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let yy = 0; yy < size; yy++) {
    for (let xx = 0; xx < size; xx++) {
      const dx = (xx - cx) / r, dy = (yy - cy) / r;
      const rr = Math.min(1, Math.hypot(dx, dy));
      // gentle core shaping × inverse-square tail, stretched so the glow breathes all the way to
      // the rim; ±1-step alpha dither kills the banding rings 8-bit alpha produces in the tail
      const I = Math.pow(1 - rr, 1.6) / (1 + 3.5 * rr * rr);
      const a = 0.36 * I + (Math.random() - 0.5) / 255;
      const i4 = (yy * size + xx) * 4;
      d[i4]     = 255;
      d[i4 + 1] = Math.round(210 - 55 * rr);   // 210 core → 155 fringe (amber → sodium orange)
      d[i4 + 2] = Math.round(140 - 100 * rr);  // 140 core → 40 fringe
      d[i4 + 3] = Math.max(0, Math.round(a * 255));
    }
  }
  ctx.putImageData(img, 0, 0);
  _streetlightPoolTex = new THREE.CanvasTexture(canvas);
  _streetlightPoolTex.userData.sharedTexture = true;
  return _streetlightPoolTex;
}

function getSharedResources() {
  // --- Pole shaft (vertical only — separate from arm for per-instance tricolor) ---
  if (!sharedPoleGeom) {
    const poleW = POLE_RADIUS * 2.4;
    sharedPoleGeom = new THREE.BoxGeometry(poleW, POLE_HEIGHT, poleW);
    sharedPoleGeom.translate(0, POLE_HEIGHT * 0.5, 0);
    sharedPoleGeom.userData.sharedGeometry = true;
  }
  if (!sharedPoleMat) {
    // White base so per-instance colors (day gray / night tricolor) show accurately.
    sharedPoleMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.7, metalness: 0.3,
    });
    sharedPoleMat.userData.sharedMaterial = true;
  }
  // --- Arm (horizontal part — always gray, no tricolor) -----------------------
  if (!sharedArmGeom) {
    const armW = ARM_RADIUS * 2;
    sharedArmGeom = new THREE.BoxGeometry(ARM_LENGTH, armW, armW);
    sharedArmGeom.translate(ARM_LENGTH * 0.5, POLE_HEIGHT, 0);
    sharedArmGeom.userData.sharedGeometry = true;
  }
  if (!sharedArmMat) {
    sharedArmMat = new THREE.MeshStandardMaterial({
      color: 0x6a6a6a, roughness: 0.7, metalness: 0.3,
    });
    sharedArmMat.userData.sharedMaterial = true;
  }

  // --- Lamp head ------------------------------------------------------------
  if (!sharedLampGeom) {
    sharedLampGeom = new THREE.BoxGeometry(LAMP_SIZE, LAMP_SIZE * 0.35, LAMP_SIZE);
    sharedLampGeom.userData.sharedGeometry = true;
  }
  if (!sharedLampMat) {
    sharedLampMat = new THREE.MeshStandardMaterial({
      color: 0xfff0a0,
      emissive: new THREE.Color(0xff8800),
      emissiveIntensity: _lampEmissiveIntensity,
      roughness: 0.4,
    });
    sharedLampMat.userData.sharedMaterial = true;
  }

  // --- Ground pool decal ----------------------------------------------------
  if (!sharedPoolGeom) {
    // Pre-rotate plane to lie flat (XZ) so instance matrices only need translation.
    sharedPoolGeom = new THREE.PlaneGeometry(POOL_SIZE, POOL_SIZE);
    sharedPoolGeom.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    sharedPoolGeom.userData.sharedGeometry = true;
  }
  if (!sharedPoolMat) {
    sharedPoolMat = new THREE.MeshBasicMaterial({
      map: createPoolTexture(),
      transparent: true,
      opacity: _poolOpacity,
      depthWrite: false,
      side: THREE.DoubleSide,
      // Light ADDS onto the surface it hits (real photometric behaviour) — normal alpha blending
      // mixed the glow toward grey at the edges and read as a translucent sticker.
      blending: THREE.AdditiveBlending,
    });
    sharedPoolMat.userData.sharedMaterial = true;
  }

  // --- Pole shadow decal (fake ground shadow) --------------------------------
  if (!sharedPoleShadowGeom) {
    // Thin rectangle lying flat on XZ plane, offset so it starts at origin
    // and extends in +Z (local) when rotated to sun direction
    sharedPoleShadowGeom = new THREE.PlaneGeometry(0.25, 1);  // narrow width, length scaled per instance
    sharedPoleShadowGeom.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    // Shift so the geometry spans [0, 1] in local Z instead of [-0.5, 0.5]
    sharedPoleShadowGeom.translate(0, 0, 0.5);
    sharedPoleShadowGeom.userData.sharedGeometry = true;
  }
  if (!sharedPoleShadowMat) {
    sharedPoleShadowMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    sharedPoleShadowMat.userData.sharedMaterial = true;
  }

  // --- Convex mirror disc + red rim + grey back --------------------------------
  if (!sharedMirrorGeom) {
    // Front reflective face + grey back merged together
    const frontDisc = new THREE.CircleGeometry(MIRROR_RADIUS - 0.05, 16);
    const backDisc = new THREE.CircleGeometry(MIRROR_RADIUS, 16);
    backDisc.rotateY(Math.PI); // face opposite direction
    backDisc.translate(0, 0, -0.03); // slight offset behind front
    // We'll use front disc as mirror, back disc separately
    sharedMirrorGeom = frontDisc;
    sharedMirrorGeom.userData.sharedGeometry = true;
    // Store back geom separately
    sharedMirrorGeom._backGeom = backDisc;
  }
  if (!sharedMirrorMat) {
    sharedMirrorMat = new THREE.MeshStandardMaterial({
      color: 0xd0d8e0, roughness: 0.05, metalness: 0.9,
    });
    sharedMirrorMat.userData.sharedMaterial = true;
  }
  if (!sharedMirrorRimGeom) {
    sharedMirrorRimGeom = new THREE.RingGeometry(MIRROR_RADIUS - 0.06, MIRROR_RADIUS + 0.02, 16);
    sharedMirrorRimGeom.userData.sharedGeometry = true;
  }
  if (!sharedMirrorRimMat) {
    sharedMirrorRimMat = new THREE.MeshBasicMaterial({ color: 0xcc2222, side: THREE.DoubleSide });
    sharedMirrorRimMat.userData.sharedMaterial = true;
  }
  if (!sharedMirrorBackMat) {
    sharedMirrorBackMat = new THREE.MeshBasicMaterial({ color: 0x555555 });
    sharedMirrorBackMat.userData.sharedMaterial = true;
  }

  return {
    poleGeom: sharedPoleGeom, poleMat: sharedPoleMat,
    armGeom: sharedArmGeom, armMat: sharedArmMat,
    lampGeom: sharedLampGeom, lampMat: sharedLampMat,
    poolGeom: sharedPoolGeom, poolMat: sharedPoolMat,
    poleShadowGeom: sharedPoleShadowGeom, poleShadowMat: sharedPoleShadowMat,
    mirrorGeom: sharedMirrorGeom, mirrorMat: sharedMirrorMat,
    mirrorRimGeom: sharedMirrorRimGeom, mirrorRimMat: sharedMirrorRimMat,
    mirrorBackMat: sharedMirrorBackMat,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk a polyline emitting a sample every `step` metres (first at step/2).
 * p.x = world X, p.y = world Z (tile-data convention).
 */
function walkPolyline(points, step) {
  const result = [];
  if (!points || points.length < 2) return result;
  let distAlongLine = 0;
  let nextEmit = step * 0.5;
  for (let i = 0; i < points.length - 1; i++) {
    const ax = points[i].x,   az = points[i].y;
    const bx = points[i+1].x, bz = points[i+1].y;
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 0.001) continue;
    const ux = dx / len, uz = dz / len;
    const eA = points[i].elevation ?? 0;
    const eB = points[i+1].elevation ?? 0;
    while (nextEmit <= distAlongLine + len) {
      const t = (nextEmit - distAlongLine) / len;
      result.push({ x: ax + t * dx, z: az + t * dz, tx: ux, tz: uz, elevation: eA + t * (eB - eA) });
      nextEmit += step;
    }
    distAlongLine += len;
  }
  return result;
}

function isNearJunction(x, z, junctionPoints, skipDist) {
  const skipSq = skipDist * skipDist;
  for (const jp of junctionPoints) {
    if ((x - jp.x) ** 2 + (z - jp.z) ** 2 < skipSq) return true;
  }
  return false;
}

/**
 * Check if position (x, z) on a ground-level road (layer 0) is underneath a bridge.
 * Returns true if any bridge/elevated road segment passes within half-road-width overhead.
 */
function isUnderBridge(x, z, bridgeSegments) {
  for (let k = 0; k < bridgeSegments.length; k += 5) {
    const ax = bridgeSegments[k], az = bridgeSegments[k + 1];
    const bx = bridgeSegments[k + 2], bz = bridgeSegments[k + 3];
    const halfW = bridgeSegments[k + 4];
    // Distance from point to segment
    const dx = bx - ax, dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    if (lenSq < 1e-12) continue;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lenSq));
    const nx = ax + t * dx - x, nz = az + t * dz - z;
    if (nx * nx + nz * nz < halfW * halfW) return true;
  }
  return false;
}

/**
 * Build a flat array of bridge road segments: [ax, az, bx, bz, halfWidth, ...] for fast lookup.
 */
function buildBridgeSegments(roads) {
  const segs = [];
  for (const road of roads || []) {
    const isBridge = road.bridge === true ||
      (road.layer != null && Number.isFinite(road.layer) && road.layer > 0);
    if (!isBridge) continue;
    const pts = road.points || [];
    const hw = (getRoadWidth(road) / 2) + 3; // extra margin for streetlight poles
    for (let i = 0; i < pts.length - 1; i++) {
      segs.push(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, hw);
    }
  }
  return segs;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Build one InstancedMesh each for poles, lamp heads, and ground pool decals.
 * All three share the same instance count so indices align.
 *
 * @param {object[]} roads
 * @param {{ x: number, z: number }[]} junctionPoints
 * @returns {{ poleMesh, lampMesh, poolMesh, positions: {x,y,z}[] } | null}
 */
export function buildStreetlights(roads, junctionPoints, options) {
  const { poleGeom, poleMat, armGeom, armMat, lampGeom, lampMat, poolGeom, poolMat,
          poleShadowGeom, poleShadowMat,
          mirrorGeom, mirrorMat, mirrorRimGeom, mirrorRimMat,
          mirrorBackMat } = getSharedResources();

  // Pre-compute bridge segments for under-bridge check
  const bridgeSegs = buildBridgeSegments(roads);

  // --- Collect placement data -----------------------------------------------
  const instances = []; // { px, py, pz, armAngle, lampX, lampZ }
  // Wire pairs: consecutive pole tops on the same ground-level road
  const wirePairs = []; // [{ x1,y1,z1, x2,y2,z2 }, ...]
  // Convex mirror placements: pole position + direction to face nearest junction
  const mirrorInstances = []; // { x, y, z, faceDirX, faceDirZ }

  for (const road of roads || []) {
    if (!LIGHT_ROAD_TYPES.has(road.highwayType)) continue;
    if (road.tunnel) continue; // no streetlights inside tunnels
    const roadWidth = getRoadWidth(road);
    const layer  = (road.layer != null && Number.isFinite(road.layer)) ? road.layer : 0;
    const isBridge = road.bridge === true || layer > 0;

    const samples = walkPolyline(road.points, LIGHT_SPACING);
    // Track previous pole top per side so wires stay on same side (no zig-zag)
    let prevPoleTopLeft = null, prevPoleTopRight = null;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (isNearJunction(s.x, s.z, junctionPoints, JUNCTION_SKIP)) {
        prevPoleTopLeft = null; prevPoleTopRight = null;
        continue;
      }
      // Skip streetlights on ground-level roads that pass under a bridge
      if (layer === 0 && bridgeSegs.length > 0 && isUnderBridge(s.x, s.z, bridgeSegs)) {
        prevPoleTopLeft = null; prevPoleTopRight = null;
        continue;
      }

      // Alternate left / right of road.
      const side = (i % 2 === 0) ? 1 : -1;
      const nx = -s.tz * side;
      const nz =  s.tx * side;

      const edgeDist = roadWidth * 0.5 + EDGE_OFFSET;
      const px = s.x + nx * edgeDist;
      const pz = s.z + nz * edgeDist;

      // rotateY(θ) maps +X → (cos θ, 0, −sin θ).
      // Arm must point in direction (-nx, 0, -nz) → θ = atan2(nz, -nx).
      const armAngle = Math.atan2(nz, -nx);

      // Arm tip (lamp head) in world space
      const lampX = px + Math.cos(armAngle) * ARM_LENGTH;
      const lampZ = pz - Math.sin(armAngle) * ARM_LENGTH;

      const rawElev = s.elevation;
      let baseY;
      if (rawElev != null) {
        const offset = options?.elevationOffset !== undefined ? options.elevationOffset : (getWorldElevationOffset() ?? 0);
        const scale = CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION) ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;
        baseY = toNormalizedRoadY(rawElev, offset, scale);
      } else {
        baseY = layer * LAYER_HEIGHT_STEP;
      }
      // Drop poles whose base sits well above the terrain — the baked road elevation can be wrong/spiky
      // and leaves a streetlight hanging in the sky. Remove it rather than plant a floater.
      if (!isBridge && options?.getGroundY) {
        const gy = options.getGroundY(px, pz);
        if (Number.isFinite(gy) && baseY - gy > 6) continue; // floating in the air → skip entirely
      }
      instances.push({ px, py: baseY, pz, armAngle, lampX, lampZ, roadTx: s.tx, roadTz: s.tz, isBridge });

      // Convex mirror: on residential road poles near junctions
      if (!isBridge && MIRROR_ROAD_TYPES.has(road.highwayType)) {
        let nearestJDist = Infinity, nearestJx = 0, nearestJz = 0;
        for (const jp of junctionPoints) {
          const d = Math.hypot(px - jp.x, pz - jp.z);
          if (d < nearestJDist) { nearestJDist = d; nearestJx = jp.x; nearestJz = jp.z; }
        }
        // Place mirror if pole is within range of a junction (but not right on top)
        if (nearestJDist > 5 && nearestJDist < MIRROR_JUNCTION_DIST) {
          const fdx = nearestJx - px, fdz = nearestJz - pz;
          const fdLen = Math.hypot(fdx, fdz);
          if (fdLen > 0.1) {
            mirrorInstances.push({
              x: px, y: baseY + MIRROR_HEIGHT, z: pz,
              faceDirX: fdx / fdLen, faceDirZ: fdz / fdLen,
            });
          }
        }
      }

      // Wire between same-side poles (ground-level only, not bridges/ramps)
      if (!isBridge) {
        const poleTopY = baseY + POLE_HEIGHT;
        const curPoleTop = { x: px, y: poleTopY, z: pz };
        const prevSame = side === 1 ? prevPoleTopRight : prevPoleTopLeft;
        if (prevSame) {
          const dist = Math.hypot(curPoleTop.x - prevSame.x, curPoleTop.z - prevSame.z);
          if (dist < LIGHT_SPACING * 3.5) { // allow wider gap since same-side poles are further apart
            wirePairs.push({ x1: prevSame.x, y1: prevSame.y, z1: prevSame.z,
                             x2: curPoleTop.x, y2: curPoleTop.y, z2: curPoleTop.z });
          }
        }
        if (side === 1) prevPoleTopRight = curPoleTop;
        else prevPoleTopLeft = curPoleTop;
      }
    }
  }

  if (instances.length === 0) return null;

  // --- Build InstancedMeshes ------------------------------------------------
  const poleMesh = new THREE.InstancedMesh(poleGeom, poleMat, instances.length);
  poleMesh.userData.sharedGeometry = true;
  poleMesh.userData.sharedMaterial = true;
  poleMesh.castShadow  = false;
  poleMesh.receiveShadow = false;

  const armMesh = new THREE.InstancedMesh(armGeom, armMat, instances.length);
  armMesh.userData.sharedGeometry = true;
  armMesh.userData.sharedMaterial = true;
  armMesh.castShadow  = false;
  armMesh.receiveShadow = false;

  const lampMesh = new THREE.InstancedMesh(lampGeom, lampMat, instances.length);
  lampMesh.userData.sharedGeometry = true;
  lampMesh.userData.sharedMaterial = true;
  lampMesh.castShadow  = false;
  lampMesh.receiveShadow = false;

  // Pool decals: flat quad, no shadow, additive-style transparency
  const poolMesh = new THREE.InstancedMesh(poolGeom, poolMat, instances.length);
  poolMesh.userData.sharedGeometry = true;
  poolMesh.userData.sharedMaterial = true;
  poolMesh.castShadow   = false;
  poolMesh.receiveShadow = false;

  // Fake pole shadow decals on ground
  const poleShadowMesh = new THREE.InstancedMesh(poleShadowGeom, poleShadowMat, instances.length);
  poleShadowMesh.userData.sharedGeometry = true;
  poleShadowMesh.userData.sharedMaterial = true;
  poleShadowMesh.castShadow   = false;
  poleShadowMesh.receiveShadow = false;
  poleShadowMesh.renderOrder   = 1;  // render after road to avoid z-fighting

  // --- Fill matrices --------------------------------------------------------
  const _m         = new THREE.Matrix4();
  const _pos       = new THREE.Vector3();
  const _q         = new THREE.Quaternion();
  const _one       = new THREE.Vector3(1, 1, 1);
  const _poolScale   = new THREE.Vector3(1.5, 1, 0.65); // wider oval along road
  const _shadowScale = new THREE.Vector3();
  const _axisY     = new THREE.Vector3(0, 1, 0);
  const _lampColor = new THREE.Color();

  // Base HSL for warm-yellow lamp glow
  const BASE_H = 0.09, BASE_S = 0.85, BASE_L = 0.75;

  const lampHeadPositions = [];
  const bridgeIndices = [];   // indices of instances on bridges (for tricolor night mode)
  const _poleColor = new THREE.Color();
  const DAY_POLE_COLOR = new THREE.Color(0x6a6a6a);

  // Indian tricolor for bridge poles at night — very overbright so they visibly glow
  const BRIDGE_NIGHT_COLORS = [
    new THREE.Color(6.0, 1.2, 0.05),  // saffron / deep orange (minimal green to stay orange)
    new THREE.Color(5.0, 5.0, 5.0),   // white
    new THREE.Color(0.3, 3.0, 0.1),   // green
  ];

  let bridgeCounter = 0; // running counter across all bridge poles for color cycling

  for (let i = 0; i < instances.length; i++) {
    const { px, py, pz, armAngle, lampX, lampZ, roadTx, roadTz, isBridge } = instances[i];

    // Pole shaft — rotated so arm faces road center
    _pos.set(px, py, pz);
    _q.setFromAxisAngle(_axisY, armAngle);
    _m.compose(_pos, _q, _one);
    poleMesh.setMatrixAt(i, _m);
    // Arm — same transform as pole (arm geometry is offset to POLE_HEIGHT)
    armMesh.setMatrixAt(i, _m);

    // Default pole color (gray) — all poles start the same
    poleMesh.setColorAt(i, DAY_POLE_COLOR);

    if (isBridge) {
      bridgeIndices.push(i);
      bridgeCounter++;
    }

    // Lamp head — at arm tip, no rotation needed
    _pos.set(lampX, py + POLE_HEIGHT, lampZ);
    _q.identity();
    _m.compose(_pos, _q, _one);
    lampMesh.setMatrixAt(i, _m);

    // Per-instance color: subtle ±hue and ±lightness variation for realism
    _lampColor.setHSL(
      BASE_H + (Math.random() - 0.5) * 0.04,   // hue  ±0.02
      BASE_S,
      BASE_L + (Math.random() - 0.5) * 0.08,   // lightness ±0.04
    );
    lampMesh.setColorAt(i, _lampColor);

    // Ground pool — elliptical, oriented along road direction
    // rotateY so local X (wide axis 1.5×) aligns with road tangent.
    // For local +X → (tx, 0, tz): cos(θ)=tx, -sin(θ)=tz → θ = atan2(-tz, tx)
    const poolAngle = Math.atan2(-roadTz, roadTx);
    _pos.set(lampX, py + POOL_Y_OFFSET, lampZ);
    _q.setFromAxisAngle(_axisY, poolAngle);
    _m.compose(_pos, _q, _poolScale);
    poolMesh.setMatrixAt(i, _m);

    // Pole shadow — thin dark plane on ground, aligned with sun direction
    const shadowLen = BASE_SHADOW_LEN * (0.85 + Math.random() * 0.3);  // ±15% variation
    _shadowScale.set(1, 1, shadowLen);
    // Offset shadow origin along sun direction so it starts at pole base
    _pos.set(px, py + 0.15, pz);
    _q.setFromAxisAngle(_axisY, SHADOW_ANGLE);
    _m.compose(_pos, _q, _shadowScale);
    poleShadowMesh.setMatrixAt(i, _m);

    lampHeadPositions.push({ x: lampX, y: py + POLE_HEIGHT, z: lampZ });
  }

  poleMesh.instanceMatrix.needsUpdate       = true;
  poleMesh.instanceColor.needsUpdate        = true;
  armMesh.instanceMatrix.needsUpdate        = true;
  lampMesh.instanceMatrix.needsUpdate       = true;
  lampMesh.instanceColor.needsUpdate        = true;
  poolMesh.instanceMatrix.needsUpdate       = true;
  poleShadowMesh.instanceMatrix.needsUpdate = true;

  // Night mode toggle for bridge poles — cycles saffron / white / green (2 each)
  function setBridgeNightMode(isNight) {
    for (let bi = 0; bi < bridgeIndices.length; bi++) {
      const idx = bridgeIndices[bi];
      if (isNight) {
        // Every 2 poles get the same color, then cycle to next
        const colorIdx = Math.floor(bi / 2) % 3;
        poleMesh.setColorAt(idx, BRIDGE_NIGHT_COLORS[colorIdx]);
      } else {
        poleMesh.setColorAt(idx, DAY_POLE_COLOR);
      }
    }
    if (bridgeIndices.length > 0) {
      poleMesh.instanceColor.needsUpdate = true;
    }
  }

  // Register with global toggle so envToggle can control all tiles at once
  _bridgeNightCallbacks.add(setBridgeNightMode);
  // Apply current state immediately (tile may load after night was already toggled)
  if (_bridgeNightMode) setBridgeNightMode(true);

  // --- Build catenary wires between consecutive ground-level poles -----------
  let wireMesh = null;
  if (wirePairs.length > 0) {
    const WIRE_SAG = 0.8;     // metres of sag at midpoint
    const WIRE_SEGS = 8;      // segments per wire for smooth curve
    const WIRE_GAP = 0.35;    // vertical gap between the two wires
    const wirePositions = [];
    // Two wires per span — upper and lower
    for (const w of wirePairs) {
      for (let line = 0; line < 2; line++) {
        const yOff = -line * WIRE_GAP; // second wire hangs slightly lower
        const sagMult = line === 0 ? 1.0 : 1.15; // lower wire sags a bit more
        for (let si = 0; si <= WIRE_SEGS; si++) {
          const t = si / WIRE_SEGS;
          const x = w.x1 + (w.x2 - w.x1) * t;
          const z = w.z1 + (w.z2 - w.z1) * t;
          const sag = -4 * WIRE_SAG * sagMult * t * (1 - t);
          const y = w.y1 + (w.y2 - w.y1) * t + sag + yOff;
          wirePositions.push(x, y, z);
        }
      }
    }
    const wireGeom = new THREE.BufferGeometry();
    wireGeom.setAttribute('position', new THREE.Float32BufferAttribute(wirePositions, 3));
    const wireIndices = [];
    const ptsPerWire = WIRE_SEGS + 1;
    for (let wi = 0; wi < wirePairs.length * 2; wi++) {
      const base = wi * ptsPerWire;
      for (let si = 0; si < WIRE_SEGS; si++) {
        wireIndices.push(base + si, base + si + 1);
      }
    }
    wireGeom.setIndex(wireIndices);
    const wireMat = new THREE.LineBasicMaterial({ color: 0x222222 });
    wireMesh = new THREE.LineSegments(wireGeom, wireMat);
    wireMesh.frustumCulled = true;
    wireMesh.userData.type = 'streetlightWire';
  }

  // --- Build convex mirrors at residential junctions -------------------------
  let mirrorDiscMesh = null, mirrorRimMeshOut = null, mirrorBackMesh = null;
  if (mirrorInstances.length > 0) {
    const mCount = mirrorInstances.length;
    mirrorDiscMesh = new THREE.InstancedMesh(mirrorGeom, mirrorMat, mCount);
    mirrorDiscMesh.userData.sharedGeometry = true;
    mirrorDiscMesh.userData.sharedMaterial = true;
    mirrorDiscMesh.castShadow = false;
    mirrorDiscMesh.receiveShadow = false;

    mirrorRimMeshOut = new THREE.InstancedMesh(mirrorRimGeom, mirrorRimMat, mCount);
    mirrorRimMeshOut.userData.sharedGeometry = true;
    mirrorRimMeshOut.userData.sharedMaterial = true;
    mirrorRimMeshOut.castShadow = false;
    mirrorRimMeshOut.receiveShadow = false;

    // Grey back of mirror
    const backGeom = mirrorGeom._backGeom;
    mirrorBackMesh = new THREE.InstancedMesh(backGeom, mirrorBackMat, mCount);
    mirrorBackMesh.userData.sharedMaterial = true;
    mirrorBackMesh.castShadow = false;
    mirrorBackMesh.receiveShadow = false;

    const _mPos = new THREE.Vector3();
    const _mQuat = new THREE.Quaternion();
    const _mScale = new THREE.Vector3(1, 1, 1);
    const _mMat = new THREE.Matrix4();
    const _lookTarget = new THREE.Vector3();
    const _up = new THREE.Vector3(0, 1, 0);

    for (let mi = 0; mi < mCount; mi++) {
      const m = mirrorInstances[mi];
      // Offset mirror position away from pole toward the junction
      const mx = m.x + m.faceDirX * MIRROR_OFFSET;
      const mz = m.z + m.faceDirZ * MIRROR_OFFSET;
      _mPos.set(mx, m.y, mz);
      _lookTarget.set(mx + m.faceDirX, m.y, mz + m.faceDirZ);
      _mMat.lookAt(_mPos, _lookTarget, _up);
      _mQuat.setFromRotationMatrix(_mMat);
      _mMat.compose(_mPos, _mQuat, _mScale);
      mirrorDiscMesh.setMatrixAt(mi, _mMat);
      mirrorRimMeshOut.setMatrixAt(mi, _mMat);
      mirrorBackMesh.setMatrixAt(mi, _mMat);
    }
    mirrorDiscMesh.instanceMatrix.needsUpdate = true;
    mirrorRimMeshOut.instanceMatrix.needsUpdate = true;
    mirrorBackMesh.instanceMatrix.needsUpdate = true;
  }

  return { poleMesh, armMesh, lampMesh, poolMesh, poleShadowMesh, wireMesh,
           mirrorDiscMesh, mirrorRimMesh: mirrorRimMeshOut, mirrorBackMesh,
           positions: lampHeadPositions, setBridgeNightMode };
}
