/**
 * Semi-transparent dirt/shoulder overlay strips blending asphalt edges into terrain.
 * One merged Mesh per tile: two ribbons per road (left + right), fading from
 * semi-opaque brown at the road boundary to fully transparent SHOULDER_WIDTH metres out.
 * MeshBasicMaterial with depthWrite:false and polygonOffset — zero geometry cost.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Shoulder width = 10% of road width, clamped to 0.3 – 1.0 m
const SHOULDER_RATIO    = 0.10;
const SHOULDER_MIN      = 0.3;
const SHOULDER_MAX      = 1.4;
const EDGE_OVERLAP      = 0.06; // extend past road edge to cover the dark edge-strip mesh
const SHOULDER_Y_INNER  = 0.11; // above road surface and green area meshes
const LAYER_HEIGHT_STEP = 6;

const SHOULDER_BY_TYPE = { motorway: 1.4, trunk: 1.2, primary: 1.0, secondary: 0.8,
  tertiary: 0.5, residential: 0.3, service: 0.2 };

function getShoulderWidth(roadWidth, highwayType) {
  if (highwayType && SHOULDER_BY_TYPE[highwayType] != null) return SHOULDER_BY_TYPE[highwayType];
  return Math.min(SHOULDER_MAX, Math.max(SHOULDER_MIN, roadWidth * SHOULDER_RATIO));
}

const ROAD_WIDTHS_BY_TYPE = {
  motorway: 15, trunk: 12, primary: 10, secondary: 8,
  tertiary: 7,  residential: 6, service: 5, unclassified: 6,
};

function getRoadWidth(road) {
  const osm = Number(road.width);
  if (osm > 0) return Math.min(30, osm);
  return ROAD_WIDTHS_BY_TYPE[road.highwayType] || 6;
}

// ---------------------------------------------------------------------------
// Shared material — created once across all tiles
// ---------------------------------------------------------------------------
let sharedShoulderMat = null;

// Base opacity multipliers per mode (applied to the material's opacity)
const SHOULDER_OPACITY_DAY   = 0.18;   // reduced — vertex shading + blend strip handle most of the transition
const SHOULDER_OPACITY_NIGHT = 0.08;   // dim — road edges should not glow at night

let _shoulderNight = false;   // persisted so a material created AFTER a night toggle comes up night-side

/** Dim/restore shoulder overlay when toggling day ↔ night. */
export function setShoulderNightMode(isNight) {
  _shoulderNight = isNight;
  if (sharedShoulderMat) {
    sharedShoulderMat.opacity = isNight ? SHOULDER_OPACITY_NIGHT : SHOULDER_OPACITY_DAY;
  }
}

function createShoulderTexture() {
  // 4-wide × 64-tall: V=0 outer edge (transparent), V=1 inner edge (dirt, semi-opaque)
  const canvas = document.createElement('canvas');
  canvas.width  = 4;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  // Draw gradient bottom→top: transparent at bottom (V=0), dirt at top (V=1)
  const grad = ctx.createLinearGradient(0, canvas.height, 0, 0);
  grad.addColorStop(0,    'rgba(0, 0, 0, 0)');
  grad.addColorStop(0.30, 'rgba(146, 130, 92, 0.12)');
  grad.addColorStop(0.70, 'rgba(146, 130, 92, 0.30)');
  grad.addColorStop(0.92, 'rgba(160, 158, 150, 0.35)');
  grad.addColorStop(1,    'rgba(165, 162, 155, 0.40)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(6, 1);  // slight U-repeat for fine texture feel
  return tex;
}

function getSharedShoulderMat() {
  if (!sharedShoulderMat) {
    sharedShoulderMat = new THREE.MeshBasicMaterial({
      map:                 createShoulderTexture(),
      transparent:         true,
      opacity:             _shoulderNight ? SHOULDER_OPACITY_NIGHT : SHOULDER_OPACITY_DAY,  // was missing → defaulted to 1.0 in day
      depthWrite:          false,
      side:                THREE.DoubleSide,
      polygonOffset:       true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits:  -1,
    });
    sharedShoulderMat.userData.sharedMaterial = true;
  }
  return sharedShoulderMat;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Build a ribbon BufferGeometry for ONE side of a road polyline.
 * side = +1 → right of travel direction, -1 → left.
 * V=1 at road edge (opaque dirt, overlapping edge strip), V=0 inward (transparent).
 */
function buildSideRibbon(points, halfRoadWidth, shoulderWidth, side, baseY) {
  if (!points || points.length < 2) return null;

  const positions = [];
  const uvs       = [];
  const indices   = [];
  let   lenSoFar  = 0;

  for (let i = 0; i < points.length; i++) {
    const cur = points[i];

    // Miter-corrected perpendicular — tracks road edge properly at bends
    let nx, nz, miterScale = 1;
    if (i === 0) {
      const dx = points[1].x - cur.x, dz = points[1].y - cur.y;
      const dl = Math.hypot(dx, dz) || 1;
      nx = -dz / dl; nz = dx / dl;
    } else if (i === points.length - 1) {
      const dx = cur.x - points[i - 1].x, dz = cur.y - points[i - 1].y;
      const dl = Math.hypot(dx, dz) || 1;
      nx = -dz / dl; nz = dx / dl;
    } else {
      const adx = cur.x - points[i - 1].x, adz = cur.y - points[i - 1].y;
      const bdx = points[i + 1].x - cur.x, bdz = points[i + 1].y - cur.y;
      const aLen = Math.hypot(adx, adz) || 1, bLen = Math.hypot(bdx, bdz) || 1;
      const perpAx = -adz / aLen, perpAz = adx / aLen;
      const perpBx = -bdz / bLen, perpBz = bdx / bLen;
      let mx = perpAx + perpBx, mz = perpAz + perpBz;
      const mLen = Math.hypot(mx, mz);
      if (mLen < 1e-10) {
        nx = perpBx; nz = perpBz;
      } else {
        mx /= mLen; mz /= mLen;
        const denom = mx * perpBx + mz * perpBz;
        if (Math.abs(denom) < 0.2) {
          nx = perpBx; nz = perpBz;
        } else {
          miterScale = Math.min(1 / denom, 3);
          nx = mx; nz = mz;
        }
      }
    }

    if (i > 0) {
      lenSoFar += Math.hypot(cur.x - points[i - 1].x, cur.y - points[i - 1].y);
    }
    const u = lenSoFar / 4; // match road UV repeat frequency

    // Ribbon sits ON the road surface: road edge (opaque, covers edge-strip) → inward (transparent)
    // Extend slightly past halfRoadWidth to overlap the dark edge-strip mesh
    const edgeDist  = (halfRoadWidth + EDGE_OVERLAP) * miterScale;
    const innerDist = Math.max(0, halfRoadWidth - shoulderWidth) * miterScale;

    const edgeX  = cur.x + nx * side * edgeDist;
    const edgeZ  = cur.y + nz * side * edgeDist;
    const innerX = cur.x + nx * side * innerDist;
    const innerZ = cur.y + nz * side * innerDist;

    const yRoad = baseY + SHOULDER_Y_INNER;

    // road-edge vertex (V=1 — opaque dirt, overlaps edge strip)
    positions.push(edgeX, yRoad, edgeZ);
    uvs.push(u, 1);

    // inward vertex (V=0 — fades to transparent toward road center)
    positions.push(innerX, yRoad, innerZ);
    uvs.push(u, 0);
  }

  // Quad strip
  for (let i = 0; i < points.length - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.push(a, b, d, a, d, c);
  }

  if (positions.length < 6) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs,       2));
  geom.setIndex(indices);
  return geom;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build merged shoulder-overlay mesh for all roads in one tile.
 * @param {object[]} roads
 * @returns {THREE.Mesh | null}
 */
export function buildShoulderMesh(roads) {
  const mat = getSharedShoulderMat();
  const geometries = [];

  for (const road of roads || []) {
    // Skip bridges, ramps, tunnels, and elevated approach roads
    if (road.bridge || road.tunnel) continue;
    if (road.isRamp || (road.highwayType && road.highwayType.endsWith('_link'))) continue;
    const layer = (road.layer != null && Number.isFinite(road.layer)) ? road.layer : 0;
    if (layer !== 0) continue;
    // Skip roads with significantly elevated points (approach slopes to bridges)
    const elev = road.elevation;
    if (Array.isArray(elev) && elev.some(e => e != null && e > 2.0)) continue;

    const pts = road.points;
    if (!pts || pts.length < 2) continue;

    const roadWidth    = getRoadWidth(road);
    const halfW        = roadWidth * 0.5;
    const shoulderW    = getShoulderWidth(roadWidth, road.highwayType);
    const baseY = 0;

    const left  = buildSideRibbon(pts, halfW, shoulderW, -1, baseY);
    const right = buildSideRibbon(pts, halfW, shoulderW, +1, baseY);
    if (left)  geometries.push(left);
    if (right) geometries.push(right);
  }

  if (geometries.length === 0) return null;

  const merged = mergeGeometries(geometries, false);
  for (const g of geometries) g.dispose();

  const mesh = new THREE.Mesh(merged, mat);
  mesh.userData.sharedMaterial = true;
  mesh.castShadow   = false;
  mesh.receiveShadow = false;
  return mesh;
}
