/**
 * Road studs / cat's eyes — flat trapezoidal blocks on the road surface
 * with orange/amber reflective faces. Placed along road edges with a
 * small margin inward from the edge line.
 *
 * Shape: low trapezoid (wider base, narrower top) ~10cm tall, ~10cm wide, ~8cm deep.
 * Two glowing amber faces on front and back.
 *
 * Road point convention: p.x = world X, p.y = world Z.
 * Vertical Y from p.elevation via toNormalizedRoadY, or layer * 6m.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { toNormalizedRoadY } from '../roadElevation.js';
import { getWorldElevationOffset } from '../elevationOffset.js';
import { CONFIG } from '../config.js';

// Stud dimensions (metres) — exaggerated for game visibility
const STUD_WIDTH = 0.25;       // across road
const STUD_DEPTH = 0.20;       // along road
const STUD_HEIGHT = 0.10;      // above road surface
const TOP_INSET = 0.04;        // trapezoid narrowing at top
const REFLECTOR_HEIGHT = 0.07;  // reflective face height
const REFLECTOR_INSET = 0.01;   // inset from stud edge

const SPACING = 6;              // metres between studs
const EDGE_MARGIN = 0.4;        // inward from road edge
const LAYER_HEIGHT_STEP = 6;
const ROAD_Y_ABOVE = 0.08;      // above road surface + edge strips

const ROAD_WIDTHS_BY_TYPE = {
  motorway: 15, trunk: 12, primary: 10, secondary: 8,
  tertiary: 7, residential: 6, service: 5, unclassified: 6,
};

const ELIGIBLE_TYPES = new Set([
  'motorway', 'motorway_link',
  'trunk', 'trunk_link',
  'primary', 'primary_link',
  'secondary', 'secondary_link',
  'tertiary', 'tertiary_link',
]);

// Shared materials
let _bodyMat = null;
let _reflectorMat = null;

function getBodyMaterial() {
  if (_bodyMat) return _bodyMat;
  _bodyMat = new THREE.MeshLambertMaterial({ color: 0xCCB844 }); // yellow plastic
  _bodyMat.userData = { sharedMaterial: true };
  return _bodyMat;
}

function getReflectorMaterial() {
  if (_reflectorMat) return _reflectorMat;
  _reflectorMat = new THREE.MeshLambertMaterial({
    color: 0xFF8800,
    emissive: 0xFF6600,
    emissiveIntensity: 0.8,
  });
  _reflectorMat.userData = { sharedMaterial: true };
  return _reflectorMat;
}

function getRoadWidth(road) {
  const osm = Number(road.width);
  if (osm > 0) return Math.min(30, osm);
  return ROAD_WIDTHS_BY_TYPE[road.highwayType] || 6;
}

function computeY(elev, layer, elevationOffset, vertExag) {
  if (Number.isFinite(elev)) {
    return toNormalizedRoadY(elev, elevationOffset, vertExag) + ROAD_Y_ABOVE;
  }
  const l = (layer != null && Number.isFinite(layer)) ? layer : 0;
  return l * LAYER_HEIGHT_STEP + ROAD_Y_ABOVE;
}

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

/**
 * Build a single road stud trapezoid geometry at origin, oriented along +Z.
 * Base wider, top narrower. Returns positions + indices for manual geometry.
 *
 *   Top face (narrower):
 *     TFL ---- TFR       (front = -Z, back = +Z)
 *      |        |
 *     TBL ---- TBR
 *
 *   Bottom face (wider):
 *     BFL ---- BFR
 *      |        |
 *     BBL ---- BBR
 */
function createStudGeometry(cx, cy, cz, tx, tz) {
  // tx, tz = tangent along road (unit)
  // perpendicular: px, pz = right
  const px = -tz, pz = tx;

  const hw = STUD_WIDTH / 2;
  const hd = STUD_DEPTH / 2;
  const h = STUD_HEIGHT;
  const inset = TOP_INSET;

  // World-space vertex helper
  const wp = (along, across, y) => [
    cx + along * tx + across * px,
    cy + y,
    cz + along * tz + across * pz,
  ];

  // Bottom (wider)
  const BFL = wp(-hd, -hw, 0);
  const BFR = wp(-hd,  hw, 0);
  const BBR = wp( hd,  hw, 0);
  const BBL = wp( hd, -hw, 0);
  // Top (narrower — inset on all sides)
  const TFL = wp(-hd + inset, -hw + inset, h);
  const TFR = wp(-hd + inset,  hw - inset, h);
  const TBR = wp( hd - inset,  hw - inset, h);
  const TBL = wp( hd - inset, -hw + inset, h);

  // 6 faces: top, bottom, front, back, left, right = 24 verts
  const verts = [
    // Top (0-3)
    ...TFL, ...TFR, ...TBR, ...TBL,
    // Bottom (4-7)
    ...BBL, ...BBR, ...BFR, ...BFL,
    // Front -tangent (8-11)
    ...BFL, ...BFR, ...TFR, ...TFL,
    // Back +tangent (12-15)
    ...BBR, ...BBL, ...TBL, ...TBR,
    // Left -perp (16-19)
    ...BBL, ...BFL, ...TFL, ...TBL,
    // Right +perp (20-23)
    ...BFR, ...BBR, ...TBR, ...TFR,
  ];

  const indices = [];
  for (let f = 0; f < 6; f++) {
    const o = f * 4;
    indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

/**
 * Build reflective face quads (front and back of stud).
 * Small orange rectangles on the front/back sloped faces.
 */
function createReflectorFaces(cx, cy, cz, tx, tz) {
  const px = -tz, pz = tx;

  const hw = STUD_WIDTH / 2 - REFLECTOR_INSET;
  const hd = STUD_DEPTH / 2;
  const h = STUD_HEIGHT;
  const inset = TOP_INSET;
  const rh = REFLECTOR_HEIGHT;

  const wp = (along, across, y) => [
    cx + along * tx + across * px,
    cy + y,
    cz + along * tz + across * pz,
  ];

  // Front face reflector (faces -tangent direction, toward oncoming traffic)
  // Bottom edge at road level, top edge partway up the slope
  const rBot = 0.005; // just above road
  const rTop = rBot + rh;

  // Front face: lerp between bottom edge and top edge positions
  const frontBot = hd;
  const frontTop = hd - inset * (rTop / h);
  const FB_L = wp(-frontBot, -hw, rBot);
  const FB_R = wp(-frontBot,  hw, rBot);
  const FT_R = wp(-frontTop,  hw, rTop);
  const FT_L = wp(-frontTop, -hw, rTop);

  // Back face reflector
  const BB_L = wp(frontBot,  hw, rBot);
  const BB_R = wp(frontBot, -hw, rBot);
  const BT_R = wp(frontTop, -hw, rTop);
  const BT_L = wp(frontTop,  hw, rTop);

  const verts = [
    // Front (0-3)
    ...FB_L, ...FB_R, ...FT_R, ...FT_L,
    // Back (4-7)
    ...BB_L, ...BB_R, ...BT_R, ...BT_L,
  ];

  const indices = [
    0, 1, 2, 0, 2, 3,
    4, 5, 6, 4, 6, 7,
  ];

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

/**
 * Build merged road stud meshes for a set of roads.
 * Returns a THREE.Group or null.
 */
export function buildReflectors(roads) {
  if (!roads || roads.length === 0) return null;

  const elevationOffset = getWorldElevationOffset() ?? 0;
  const vertExag = (CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION))
    ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;

  const bodyGeoms = [];
  const reflGeoms = [];

  for (const road of roads) {
    if (!ELIGIBLE_TYPES.has(road.highwayType)) continue;
    const pts = road.points;
    if (!pts || pts.length < 2) continue;

    const arcLengths = computeArcLengths(pts);
    const totalLen = arcLengths[arcLengths.length - 1];
    if (totalLen < SPACING * 2) continue;

    const halfW = getRoadWidth(road) / 2;
    const layer = road.layer;

    // Place studs along both edges
    for (let dist = SPACING; dist < totalLen - SPACING * 0.5; dist += SPACING) {
      const sample = samplePolyline(pts, arcLengths, dist);
      const tangent = sampleTangent(pts, arcLengths, dist);
      const y = computeY(sample.elev, layer, elevationOffset, vertExag);

      const px = -tangent.z;
      const pz = tangent.x;

      for (const side of [-1, 1]) {
        const offset = halfW - EDGE_MARGIN;
        const wx = sample.x + px * offset * side;
        const wz = sample.z + pz * offset * side;

        bodyGeoms.push(createStudGeometry(wx, y, wz, tangent.x, tangent.z));
        reflGeoms.push(createReflectorFaces(wx, y, wz, tangent.x, tangent.z));
      }
    }
  }

  if (bodyGeoms.length === 0) return null;

  const group = new THREE.Group();

  const mergedBody = mergeGeometries(bodyGeoms, false);
  if (mergedBody) {
    const mesh = new THREE.Mesh(mergedBody, getBodyMaterial());
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  }
  for (const g of bodyGeoms) g.dispose();

  const mergedRefl = mergeGeometries(reflGeoms, false);
  if (mergedRefl) {
    const mesh = new THREE.Mesh(mergedRefl, getReflectorMaterial());
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  }
  for (const g of reflGeoms) g.dispose();

  return group;
}
