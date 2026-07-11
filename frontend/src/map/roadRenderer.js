/**
 * Production road renderer: flat ribbon meshes, shared materials by highway type,
 * merged geometry per tile, Norma 8.2-IC road markings, bridge pillars.
 * Supports terrain via getElevationAt and tunnel/bridge/layer.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { worldToLatLon } from '../projection.js';
import { getWorldElevationOffset } from '../elevationOffset.js';
import { toNormalizedRoadY } from '../roadElevation.js';
import { aoDarkening, AO_ROAD_STRENGTH, bindAoScaleUniform, AO_FRAG_APPLY } from './aoSampler.js';
import { SEA_LEVEL } from './waterRenderer.js';
import { BCN_COLORS, BCN_DIMS } from './barcelona-constants.js';
import { applyGroundLayer } from './groundLayers.js';
import { createRoadTextures } from './generate-road-atlas.js';

/**
 * Global height constants for stable layering (no z-fighting).
 * Layering order above terrain:
 *   terrain (0) → greens (0.01) → road (0.05+0.02) → sidewalk (0.08)
 *   → edge strips/shoulders (0.02 above road) → markings/reflectors (0.03 above road)
 */
const LAYER_HEIGHT_STEP = 6;
const ROAD_OFFSET = 0.05;
const ROAD_VISUAL_ABOVE_TERRAIN = 0.05; // lift roads above the terrain mesh (decal offset) — clears z-fight + the bilinear-road vs triangle-mesh conformance gap on curved 128-grid cells. Was 0.22 (pre-smoothing DEM), 0.06 (Phase 2); wheels ride the terrain heightfield (D-16) so the slab floats ABOVE the wheel contact by exactly this amount → the car looks sunk by it. Shaved 0.06→0.05 to reduce that. Raise if roads start dipping under terrain on curved/hill cells.
const ROAD_ZFIGHT_OFFSET = 0.02;
const SIDEWALK_OFFSET = 0.08;

/**
 * Tiny Y micro-offset per road priority to resolve z-fighting at intersections.
 * Higher-priority (wider) roads get a higher offset so they render on top.
 * Values are in metres — kept well under 1cm to be invisible to the eye.
 */
const ROAD_PRIORITY_Y_BUMP = {
  motorway:       0.009,
  trunk:          0.008,
  primary:        0.007,
  secondary:      0.006,
  tertiary:       0.005,
  motorway_link:  0.0085,
  trunk_link:     0.0075,
  primary_link:   0.0065,
  secondary_link: 0.0055,
  tertiary_link:  0.0045,
  residential:    0.004,
  unclassified:   0.003,
  service:        0.002,
  living_street:  0.002,
  track:          0.001,
  path:           0.001,
  footway:        0.001,
  cycleway:       0.001,
};

/** Height step per OSM layer; tunnel = -1 step. */
const BRIDGE_TUNNEL_OFFSET = LAYER_HEIGHT_STEP;
const LAYER_HEIGHT_PER_LEVEL = LAYER_HEIGHT_STEP;
/** Sidewalk height above terrain: terrain + (layer * LAYER_HEIGHT_STEP) + SIDEWALK_OFFSET. */
const SIDEWALK_Y_OFFSET = SIDEWALK_OFFSET;
/** Sidewalk width (m) by road type, total per side. 0 = no sidewalk. Do not exceed these values. */
const SIDEWALK_WIDTH_BY_TYPE = {
  motorway: 0,
  trunk: 0,
  primary: 2.5,
  secondary: 2.0,
  tertiary: 1.5,
  residential: 1.2,
  service: 0.8,
  unclassified: 1.2,
};
const DEFAULT_SIDEWALK_WIDTH = 1.2;
const EDGE_STRIP_WIDTH = 0.1;
const EDGE_STRIP_Y_OFFSET = 0.02;
/** Norma 8.2-IC road marking constants. All longitudinal lines are 0.10 m wide. */
const CENTER_LINE_WIDTH       = BCN_DIMS.LINE_WIDTH_LONGITUDINAL; // 0.10 m
const MARKING_EDGE_LINE_WIDTH = BCN_DIMS.LINE_WIDTH_LONGITUDINAL; // 0.10 m
const LANE_DIVIDER_WIDTH      = BCN_DIMS.LINE_WIDTH_LONGITUDINAL; // 0.10 m
const DOUBLE_LINE_GAP = 0.20;
const DASH_LENGTH = 2.0;
const DASH_GAP = 2.0;
const MARKING_Y_ABOVE_ROAD = 0.06; // was 0.03 (sank into ±3.5cm road noise) → 0.08 → 0.06: still clears noise, floats less above the wheels so the car looks less sunk
                                   // under bumps and vanished up close. 0.08 clears the noise + grazing z-fight.

const LANES_BY_TYPE = {
  motorway: 4, trunk: 3, primary: 2, secondary: 2, tertiary: 2,
  motorway_link: 2, trunk_link: 2, primary_link: 1, secondary_link: 1, tertiary_link: 1,
  residential: 1, service: 1, unclassified: 1,
};

const MARKING_RULES = {
  motorway:       { center: 'double_solid', lanes: true,  edge: true },
  motorway_link:  { center: 'solid',        lanes: false, edge: true },
  trunk:          { center: 'solid',        lanes: true,  edge: true },
  trunk_link:     { center: 'dashed',       lanes: false, edge: true },
  primary:        { center: 'dashed',       lanes: false, edge: true },
  primary_link:   { center: 'dashed',       lanes: false, edge: true },
  secondary:      { center: 'dashed',       lanes: false, edge: true },
  secondary_link: { center: 'dashed',       lanes: false, edge: true },
  tertiary:       { center: 'dashed',       lanes: false, edge: true },
  tertiary_link:  { center: 'dashed',       lanes: false, edge: true },
  residential:    { center: null,           lanes: false, edge: true },
  unclassified:   { center: null,           lanes: false, edge: true },
  // Small drivable streets that were absent from the table → got NO markings at all (plain grey).
  // Give them solid edge lines too (no centre line — they're single-carriageway side streets).
  living_street:  { center: null,           lanes: false, edge: true },
  service:        { center: null,           lanes: false, edge: true },
  road:           { center: null,           lanes: false, edge: true },
};

/** Bridge pillar spacing (m). */
const PILLAR_SPACING = 30;
/** Bridge pillar radius (m). */
const PILLAR_RADIUS = 0.5;
/** Concrete slab depth below bridge deck (m). */
const SLAB_THICKNESS = 1.2;
/** Bridge structures (slab, guard rails, pillars) hidden below this height above ground (m). */
const MIN_BRIDGE_STRUCTURE_HEIGHT = 2.0;
/** Guard-rail height above bridge deck (m). */
const GUARD_RAIL_HEIGHT = 0.8;
/** Guard-rail wall thickness (m). */
const GUARD_RAIL_THICKNESS = 0.25;
/** Metal railing: post spacing (m). */
const RAILING_POST_SPACING = 3.0;
/** Metal railing: post width/depth (m). */
const RAILING_POST_SIZE = 0.12;
/** Metal railing: post height above concrete wall (m). */
const RAILING_POST_HEIGHT = 0.5;
/** Metal railing: horizontal beam radius approximation (half-height of box beam) (m). */
const RAILING_BEAM_HALF = 0.07;
/** Metal railing: beam depth (across-road thickness) (m). */
const RAILING_BEAM_DEPTH = 0.10;

function getSidewalkWidthForRoad(highwayType) {
  const w = SIDEWALK_WIDTH_BY_TYPE[highwayType];
  return w !== undefined ? w : DEFAULT_SIDEWALK_WIDTH;
}

/** Asphalt colors by highway type (hex) — unified dark asphalt. */
const COLOR_BY_TYPE = {
  motorway: 0x3A414B,
  trunk: 0x3A414B,
  primary: 0x3A414B,
  secondary: 0x3A414B,
  tertiary: 0x3A414B,
  residential: 0x3A414B,
  service: 0x3A414B,
  unclassified: 0x3A414B,
};

/** Road width (m) by highway type. Used when road.width is not set.
 *  Values scaled so one lane ≈ 4 m (fits car ~2 m wide with margin).
 *  Dual-carriageway types get ×2 lanes. Link ramps get one lane less. */
const WIDTH_BY_TYPE = {
  motorway:        30,  // 4 lanes each direction
  trunk:           26,  // 3 lanes each direction
  primary:         20,  // 2-3 lanes each direction
  secondary:       16,  // 2 lanes each direction
  tertiary:        13,  // 2 lanes
  motorway_link:   15,  // 3-lane ramp
  trunk_link:      13,  // 2-lane ramp
  primary_link:    11,  // 2-lane ramp
  secondary_link:  10,  // 2-lane connector
  tertiary_link:    9,  // 1-2 lane connector
  residential:     10,  // 2 lanes
  service:          7,
  unclassified:    10,
  living_street:    8,
  track:            5,
  path:             2,
  footway:          2,
  cycleway:         2,
};

// Stored max anisotropy value — applied to panot texture at creation and on update
let _maxAnisotropy = 4;
export function setRendererAnisotropy(v) {
  _maxAnisotropy = v || 4;
  // If panot material already exists, update its texture anisotropy
  const textures = createRoadTextures();
  if (textures?.panotTexture) textures.panotTexture.anisotropy = _maxAnisotropy;
}

// ── Phase 3 Barcelona material cache ─────────────────────────────────────────
let _panotMaterial = null;
let _curbMaterial = null;
let _bikeLaneMaterial = null;
let _bikePictogramMaterial = null;

/** MeshStandardMaterial with panot texture + world-space UVs (Phase 3 sidewalks). */
function getPanotMaterial() {
  if (_panotMaterial) return _panotMaterial;
  const { panotTexture } = createRoadTextures();
  panotTexture.anisotropy = _maxAnisotropy;
  _panotMaterial = patchRoadWash(new THREE.MeshLambertMaterial({
    map: panotTexture,
    color: 0xffffff,
  }));
  applyGroundLayer(_panotMaterial, 'sidewalk');
  return _panotMaterial;
}

/** MeshStandardMaterial for granite curbs (Phase 3). */
function getCurbMaterial() {
  if (_curbMaterial) return _curbMaterial;
  _curbMaterial = new THREE.MeshStandardMaterial({
    color: BCN_COLORS.CURB_GRANITE,
    roughness: 0.6,
    metalness: 0.1,
  });
  return _curbMaterial;
}

/** MeshLambertMaterial for green bike lane surface (Phase 3). */
function getBikeLaneMaterial() {
  if (_bikeLaneMaterial) return _bikeLaneMaterial;
  _bikeLaneMaterial = new THREE.MeshLambertMaterial({
    color: _decalNight ? 0x55906b : BCN_COLORS.PAINT_BIKE_GREEN,   // night lift — see setRoadDecalNightMode
  });
  applyGroundLayer(_bikeLaneMaterial, 'bikeLane');
  return _bikeLaneMaterial;
}

/** MeshBasicMaterial for bike pictogram InstancedMesh (Phase 3). */
function getBikePictogramMaterial() {
  if (_bikePictogramMaterial) return _bikePictogramMaterial;
  const { bikePictogramTexture } = createRoadTextures();
  _bikePictogramMaterial = applyGroundLayer(new THREE.MeshBasicMaterial({
    map: bikePictogramTexture,
    transparent: true,
    alphaTest: 0.1,
    depthWrite: false,
  }), 'stencil');
  return _bikePictogramMaterial;
}

// Shared quad geometry for bike pictograms (1 draw call per tile via InstancedMesh)
let _bikePictogramGeometry = null;
function getBikePictogramGeometry() {
  if (_bikePictogramGeometry) return _bikePictogramGeometry;
  // 1.5m along road × 0.8m across road, lying flat
  _bikePictogramGeometry = new THREE.PlaneGeometry(0.8, 1.5);
  _bikePictogramGeometry.rotateX(-Math.PI / 2); // lie flat
  return _bikePictogramGeometry;
}

let sharedRoadMaterial = null;
let sharedMaterials = null;
let sidewalkMaterial = null;
let edgeStripMaterial = null;

// ── Night building-glow wash on road surfaces ────────────────────────────────
// Roads near buildings pick up the same warm ground-glow the facades' lower floors have, so lit
// blocks and their streets merge at night; away from buildings the wash factor (per-vertex aWash,
// baked by tileManager from building proximity) falls to 0 and the road fades to plain dark.
// ONE shared uniform drives every patched road material; geometry without aWash reads 0 (no wash).
const _roadWashUniform = { value: 0 };
export function setRoadNightWash(isNight) { _roadWashUniform.value = isNight ? 0.045 : 0; }

// Deep-albedo road decals crush to BLACK under the blue night rig (PAINT_BLUE's red channel is 0;
// the bike-lane green is dark) — the "black patches" on night streets. Lift to moonlit variants.
let _decalNight = false;
export function setRoadDecalNightMode(isNight) {
  _decalNight = isNight;
  if (_blueZoneMaterial) _blueZoneMaterial.color.setHex(isNight ? 0x3a6ea8 : BCN_COLORS.PAINT_BLUE);
  if (_bikeLaneMaterial) _bikeLaneMaterial.color.setHex(isNight ? 0x55906b : BCN_COLORS.PAINT_BIKE_GREEN);
}
function patchRoadWash(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNightWash = _roadWashUniform;
    bindAoScaleUniform(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aWash;\nattribute float aAO;\nvarying float vWash;\nvarying float vAoDark;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWash = aWash;\nvAoDark = aAO;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNightWash;\nuniform float uAoScale;\nvarying float vWash;\nvarying float vAoDark;')
      // Baked sky-visibility AO (v9): aAO stores a DARKENING amount, so meshes without the
      // attribute (default 0) render unchanged. uAoScale softens AO under the night rig.
      .replace('#include <color_fragment>', `#include <color_fragment>\n${AO_FRAG_APPLY}`)
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.62, 0.34) * (vWash * uNightWash);');
  };
  return mat;
}

/** Asphalt road material with vertex color variation (stylized mode). */
function getSharedRoadMaterial() {
  if (sharedRoadMaterial) return sharedRoadMaterial;
  sharedRoadMaterial = patchRoadWash(new THREE.MeshStandardMaterial({
    color: 0xffffff,       // white base — actual color comes from vertex colors
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
    depthWrite: true,
    side: THREE.DoubleSide,  // visible from below bridges
  }));
  applyGroundLayer(sharedRoadMaterial, 'road');   // above terrain/greens, below all paint
  return sharedRoadMaterial;
}

/** Deterministic noise for road surface variation. */
function roadNoise(x, z, seed) {
  const n = Math.sin(x * 0.08 + seed) * Math.cos(z * 0.11 + seed * 0.6)
          + Math.sin((x + z) * 0.05 + seed * 1.4) * 0.5;
  return n * 0.5; // roughly -0.5..+0.5
}

/** Add per-vertex color noise to road geometry. Dark pastel bluish-grey with imperfections. */
function applyRoadVertexColors(geometry) {
  const posAttr = geometry.getAttribute('position');
  if (!posAttr) return;
  const count = posAttr.count;
  const colors = new Float32Array(count * 3);
  // Dark pastel bluish-grey — low saturation, blue-leaning
  // Target on-screen: ~#4A5566 after tonemapping
  const br = 0.22, bg = 0.25, bb = 0.30;
  for (let i = 0; i < count; i++) {
    const x = posAttr.getX(i);
    const z = posAttr.getZ(i);
    // Broad patches (oil stains, wear)
    const n1 = roadNoise(x, z, 3.0) * 0.035;
    // Fine grain (texture detail)
    const n2 = roadNoise(x * 5, z * 5, 7.0) * 0.018;
    // Occasional dark splotches
    const n3 = roadNoise(x * 0.3, z * 0.3, 11.0);
    const splotch = n3 > 0.15 ? -0.015 : 0;
    const variation = n1 + n2 + splotch;
    colors[i * 3]     = Math.max(0, Math.min(1, br + variation * 0.7));
    colors[i * 3 + 1] = Math.max(0, Math.min(1, bg + variation * 0.85));
    colors[i * 3 + 2] = Math.max(0, Math.min(1, bb + variation));
  }
  // Edge darkening: constant world-space fade width with smoothstep falloff.
  // Uses halfWidth attribute to convert UV edge distance to metres.
  const uvAttr = geometry.getAttribute('uv');
  const hwAttr = geometry.getAttribute('halfWidth');
  if (uvAttr) {
    const EDGE_FADE_WIDTH = 0.8;  // metres — constant dust shoulder width
    const EDGE_DARKEN_MIN = 0.88; // darkening at very edge (12% darker)
    for (let i = 0; i < count; i++) {
      const v = uvAttr.getY(i);
      const edgeDistUV = Math.min(v, 1 - v); // 0 at edge, 0.5 at center
      // Convert UV distance to world-space metres
      const hw = hwAttr ? hwAttr.getX(i) : 5; // fallback 5m half-width
      const edgeDistM = edgeDistUV * 2 * hw;  // UV 0..0.5 → 0..halfWidth metres
      const raw = Math.min(edgeDistM / EDGE_FADE_WIDTH, 1.0);
      // Smoothstep: 3t² - 2t³
      const t = raw * raw * (3 - 2 * raw);
      const darken = EDGE_DARKEN_MIN + t * (1.0 - EDGE_DARKEN_MIN);
      colors[i * 3] *= darken;
      colors[i * 3 + 1] *= darken;
      colors[i * 3 + 2] *= darken;
    }
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
}

function getSharedMaterials() {
  if (sharedMaterials) return sharedMaterials;
  sharedMaterials = {};
  for (const [type, hex] of Object.entries(COLOR_BY_TYPE)) {
    sharedMaterials[type] = patchRoadWash(new THREE.MeshStandardMaterial({
      color: hex,
      roughness: 0.9,
      metalness: 0,
      flatShading: false,
    }));
  }
  return sharedMaterials;
}

/** Flat beige sidewalk material (stylized mode — no textures). */
function getSidewalkMaterial() {
  if (sidewalkMaterial) return sidewalkMaterial;
  sidewalkMaterial = patchRoadWash(new THREE.MeshLambertMaterial({
    color: 0xb8bab5,
    depthWrite: true,
  }));
  return sidewalkMaterial;
}

/**
 * Bake the per-vertex building-proximity wash factor (aWash) into ground meshes. Sources are the
 * buildings' footprint OUTLINE points (not just centroids — big blocks would starve their kerb),
 * hashed into a coarse grid; each vertex takes 1 − d/RANGE to its nearest source. Streets flanked
 * by buildings glow with the facades at night; empty stretches read 0 → plain dark. ~1 grid lookup
 * per vertex; call it through the tile builder's yield budget.
 */
const WASH_RANGE = 18, WASH_R2 = WASH_RANGE * WASH_RANGE, WASH_CELL = 24;  // CELL ≥ RANGE → ±1-cell query

/** Hash grid of building footprint outline points — shared by road, sidewalk AND vegetation washes.
 *  Points are thinned to ≥5 m spacing: a dense Eixample tile put 100+ points per cell, turning each
 *  washAt into ~900 distance checks (measured: 55 ms wash chunks). The wash is a soft 18 m gradient —
 *  5 m source spacing is visually identical. */
export function buildWashGrid(buildings) {
  const grid = new Map();
  const MIN_SPACING_SQ = 5 * 5;
  for (const b of buildings) {
    const fp = b.footprint;
    if (!fp || fp.length < 3) continue;
    let lx = Infinity, lz = Infinity;
    for (let i = 0; i < fp.length; i++) {
      const px = fp[i].x, pz = fp[i].y;
      const dx = px - lx, dz = pz - lz;
      if (dx * dx + dz * dz < MIN_SPACING_SQ) continue;   // too close to the previous kept point
      lx = px; lz = pz;
      const k = Math.floor(px / WASH_CELL) * 100003 + Math.floor(pz / WASH_CELL);
      let a = grid.get(k);
      if (!a) grid.set(k, a = []);
      a.push(px, pz);
    }
  }
  return grid.size ? grid : null;
}

/** 1 at a building wall → 0 beyond WASH_RANGE. */
export function washAt(grid, x, z) {
  const gx = Math.floor(x / WASH_CELL), gz = Math.floor(z / WASH_CELL);
  let best = WASH_R2;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const a = grid.get((gx + dx) * 100003 + (gz + dz));
      if (!a) continue;
      for (let j = 0; j < a.length; j += 2) {
        const ddx = a[j] - x, ddz = a[j + 1] - z;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 < best) best = d2;
      }
    }
  }
  return best < WASH_R2 ? 1 - Math.sqrt(best) / WASH_RANGE : 0;
}

export async function bakeRoadWash(meshes, buildings, yieldFn, svfAt, aoStrength = AO_ROAD_STRENGTH) {
  const grid = buildings?.length ? buildWashGrid(buildings) : null;
  if (!grid && !svfAt) return;

  for (const mesh of meshes) {
    const pos = mesh?.geometry?.getAttribute?.('position');
    if (!pos) continue;
    const n = pos.count;
    const wash = grid ? new Float32Array(n) : null;
    const ao = svfAt ? new Float32Array(n) : null;
    let any = false, anyAo = false;
    for (let i = 0; i < n; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      if (grid) {
        const w = washAt(grid, x, z);
        if (w > 0) { wash[i] = w; any = true; }
      }
      if (svfAt) {
        // Baked sky-visibility AO (v9) — darkening amount, 0 = open sky (see aoSampler).
        // Finite guard: NaN vertex positions (G-06 grid holes) must not reach the shader.
        const d = aoDarkening(svfAt(x, z), aoStrength);
        if (Number.isFinite(d) && d > 0.004) { ao[i] = d; anyAo = true; }
      }
      // yield INSIDE big meshes too — one merged road mesh can carry 40k+ verts. 4095 (was 8191):
      // wash+AO per vertex pushed chunks to 17-22ms — fine at a 30fps budget, an overrun at 60.
      if (yieldFn && (i & 4095) === 4095) await yieldFn();
    }
    if (any) mesh.geometry.setAttribute('aWash', new THREE.BufferAttribute(wash, 1));
    if (anyAo) mesh.geometry.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
    if (yieldFn) await yieldFn();
  }
}

function getEdgeStripMaterial() {
  if (!edgeStripMaterial) {
    edgeStripMaterial = new THREE.MeshLambertMaterial({
      color: 0x6e7580,
      flatShading: false,
    });
  }
  return edgeStripMaterial;
}

/**
 * Build flat ribbon BufferGeometry along polyline (no curve).
 * points: [{x, y}] with y = world Z. width in meters.
 * yOffsetOrHeights: number (constant Y for all points) or number[] (per-point height).
 */
const ROAD_UV_REPEAT_M = 4;

function buildFlatRibbonGeometry(points, widthOrWidths, yOffsetOrHeights) {
  if (!points || points.length < 2) return null;
  const n = points.length;
  const isWidthArray = Array.isArray(widthOrWidths);
  const getHalf = isWidthArray
    ? (i) => (widthOrWidths[i] != null ? widthOrWidths[i] / 2 : 3)
    : () => widthOrWidths / 2;
  const isArray = Array.isArray(yOffsetOrHeights);
  const getY = (i) => (isArray ? (yOffsetOrHeights[i] != null ? yOffsetOrHeights[i] : 0) : yOffsetOrHeights);
  const positions = [];
  const uvs = [];
  const halfWidths = [];  // per-vertex half-width for world-space edge fade
  const dir = new THREE.Vector3();
  const miter = new THREE.Vector3();
  let lengthAlong = 0;
  if (!window._roadVertexYLogged && n > 0) {
    const y0 = getY(0) + ROAD_ZFIGHT_OFFSET;
    window._roadVertexYLogged = true;
  }

  for (let i = 0; i < n; i++) {
    const p = points[i];
    const x = p.x;
    const z = p.y;
    const y = getY(i) + ROAD_ZFIGHT_OFFSET;
    const half = getHalf(i);
    if (i > 0) lengthAlong += Math.hypot(x - points[i - 1].x, z - points[i - 1].y);
    const u = lengthAlong / ROAD_UV_REPEAT_M;

    let normX, normZ, miterLength;
    if (i === 0) {
      dir.set(points[1].x - x, 0, points[1].y - z);
      if (dir.lengthSq() < 1e-12) continue;
      dir.normalize();
      normX = -dir.z;
      normZ = dir.x;
      miterLength = half;
    } else if (i === n - 1) {
      dir.set(x - points[n - 2].x, 0, z - points[n - 2].y);
      if (dir.lengthSq() < 1e-12) continue;
      dir.normalize();
      normX = -dir.z;
      normZ = dir.x;
      miterLength = half;
    } else {
      dir.set(x - points[i - 1].x, 0, z - points[i - 1].y);
      if (dir.lengthSq() < 1e-12) {
        dir.set(points[i + 1].x - x, 0, points[i + 1].y - z);
        if (dir.lengthSq() < 1e-12) continue;
        dir.normalize();
        normX = -dir.z;
        normZ = dir.x;
        miterLength = half;
      } else {
        const dirBX = points[i + 1].x - x;
        const dirBZ = points[i + 1].y - z;
        const lenBSq = dirBX * dirBX + dirBZ * dirBZ;
        if (lenBSq < 1e-12) {
          dir.normalize();
          normX = -dir.z;
          normZ = dir.x;
          miterLength = half;
        } else {
          dir.normalize();
          const perpAX = -dir.z;
          const perpAZ = dir.x;
          const lenB = Math.sqrt(lenBSq);
          const perpBX = -dirBZ / lenB;
          const perpBZ = dirBX / lenB;
          miter.set(perpAX + perpBX, 0, perpAZ + perpBZ);
          const lenSq = miter.x * miter.x + miter.z * miter.z;
          if (lenSq < 1e-12) continue;
          miter.normalize();
          const denom = miter.x * perpBX + miter.z * perpBZ;
          if (Math.abs(denom) < 0.2) {
            normX = perpBX;
            normZ = perpBZ;
            miterLength = half;
          } else {
            miterLength = half / denom;
            miterLength = Math.min(miterLength, half * 4);
            normX = miter.x;
            normZ = miter.z;
          }
        }
      }
    }

    const leftX = x - normX * miterLength;
    const leftZ = z - normZ * miterLength;
    const rightX = x + normX * miterLength;
    const rightZ = z + normZ * miterLength;
    positions.push(leftX, y, leftZ, rightX, y, rightZ);
    uvs.push(u, 0, u, 1);
    halfWidths.push(half, half);  // same half-width for left and right vertex
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
  geom.setAttribute('halfWidth', new THREE.Float32BufferAttribute(halfWidths, 1));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

const vertExag = () => (CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION) ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1);

/** Compute per-point road height. When p.elevation exists, backend has already applied bridge/tunnel/layer; only apply offset and vertExag here. Otherwise use getElevationAt + layer/tunnel. */
function getRoadPointHeights(road, optionsOrGetElevationAt) {
  if (!road.points?.length) return null;
  const opts = optionsOrGetElevationAt && typeof optionsOrGetElevationAt === 'object'
    ? optionsOrGetElevationAt
    : { getElevationAt: typeof optionsOrGetElevationAt === 'function' ? optionsOrGetElevationAt : null };
  const getElevationAt = opts.getElevationAt ?? null;
  const layer = road.layer != null && Number.isFinite(road.layer) ? road.layer : 0;
  const scale = vertExag();
  const offset = opts.elevationOffset !== undefined ? opts.elevationOffset : (getWorldElevationOffset() ?? 0);
  const heights = [];
  for (const p of road.points) {
    if (p && Number.isFinite(p.elevation)) {
      const y = toNormalizedRoadY(p.elevation, offset, scale);
      heights.push(y + ROAD_VISUAL_ABOVE_TERRAIN);
      continue;
    }
    if (!getElevationAt) {
      heights.push(ROAD_OFFSET * scale + ROAD_VISUAL_ABOVE_TERRAIN);
      continue;
    }
    const { lat, lon } = worldToLatLon(p.x, p.y);
    let baseY = getElevationAt(lat, lon);
    if (!Number.isFinite(baseY)) baseY = 0;
    const y = baseY + (layer * LAYER_HEIGHT_STEP) + ROAD_OFFSET;
    heights.push(y * scale + ROAD_VISUAL_ABOVE_TERRAIN);
  }
  return heights;
}

/**
 * Per-point road height ABOVE LOCAL TERRAIN (= the layer/ramp/bridge structural component,
 * with terrain elevation removed). Bridge-structure detection MUST use this, never the raw
 * `getRoadPointHeights` value: since the road-drape fix, that value is terrain-inclusive
 * (DEM − offset), so its magnitude and slope reflect terrain — not whether a road is elevated.
 * Subtracting terrain (getElevationAt, same normalized frame) cancels DEM and leaves the
 * structural rise. Falls back to the raw height when no terrain function is present (flat world).
 * @returns {number[]|null} per-point above-terrain height, same length as road.points
 */
function getAboveTerrainHeights(road, options, heights) {
  const hVals = heights || getRoadPointHeights(road, options);
  if (!hVals) return null;
  const getElevationAt = options?.getElevationAt;
  const scale = vertExag();
  const pts = road.points || [];
  return hVals.map((hy, i) => {
    const p = pts[i];
    if (!getElevationAt || !p) return hy;
    const { lat, lon } = worldToLatLon(p.x, p.y);
    const ty = getElevationAt(lat, lon);
    return Number.isFinite(ty) ? hy - ty * scale : hy;
  });
}

/** Ground level for pillar bottom in mesh space (terrain × vertExag or SEA_LEVEL). Must match road deck Y space. */
function getPillarBottomY(lat, lon, getElevationAt) {
  if (!getElevationAt) return SEA_LEVEL;
  const norm = getElevationAt(lat, lon);
  const t = Number.isFinite(norm) ? norm : 0;
  return Math.max(t * vertExag(), SEA_LEVEL);
}

const JUNCTION_TOLERANCE = 2;
/** Default intersection radius (m). Used when junction has no radius. */
export const INTERSECTION_RADIUS = 3;

function hashPoint(x, z, tol) {
  const g = 1 / (tol || 1);
  return `${Math.floor(x * g)}_${Math.floor(z * g)}`;
}

function getRoadWidth(road) {
  const osmW = Number(road.width);
  let w = (osmW > 0) ? Math.max(4, Math.min(30, osmW)) : (WIDTH_BY_TYPE[road.highwayType] ?? 6);
  if (road.highwayType === 'service' && road.serviceSubtype) {
    if (road.serviceSubtype === 'alley')         w = 3;
    else if (road.serviceSubtype === 'driveway') w = 3.5;
  }
  return w;
}

/** Endpoints shared by at least two road segments. Returns [{ x, z, radius }] where radius = max(roadWidth) at junction. */
export function getJunctionPoints(roads, tolerance) {
  const byHash = new Map();
  for (const road of roads || []) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const w = getRoadWidth(road);
    for (const p of [pts[0], pts[pts.length - 1]]) {
      const h = hashPoint(p.x, p.y, tolerance);
      if (!byHash.has(h)) byHash.set(h, { x: p.x, z: p.y, count: 0, maxWidth: 0 });
      const v = byHash.get(h);
      v.count += 1;
      v.maxWidth = Math.max(v.maxWidth, w);
    }
  }
  const out = [];
  for (const v of byHash.values()) {
    if (v.count >= 2) out.push({ x: v.x, z: v.z, radius: v.maxWidth });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Width tapering at junctions: smooth transitions between different road widths
// ---------------------------------------------------------------------------

const WIDTH_TAPER_DISTANCE = 20; // metres over which width blends

/**
 * Build a map from hashed endpoint position to the max width of all roads
 * meeting at that endpoint. Only entries where at least two different widths
 * meet are kept (i.e. a taper is actually needed).
 */
function buildJunctionWidthMap(roads, tol) {
  const byHash = new Map();
  for (const road of roads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const w = Number.isFinite(Number(road.width))
      ? Math.max(3, Math.min(30, Number(road.width)))
      : (WIDTH_BY_TYPE[road.highwayType] ?? 6);
    for (const p of [pts[0], pts[pts.length - 1]]) {
      const h = hashPoint(p.x, p.y, tol);
      if (!byHash.has(h)) byHash.set(h, { maxW: w, minW: w });
      const v = byHash.get(h);
      v.maxW = Math.max(v.maxW, w);
      v.minW = Math.min(v.minW, w);
    }
  }
  // Only keep entries where widths actually differ
  for (const [k, v] of byHash) {
    if (v.maxW - v.minW < 0.5) byHash.delete(k);
  }
  return byHash;
}

/**
 * Compute per-point widths for a road, tapering at endpoints that connect to
 * roads of a different width. Returns null when no tapering is needed (the
 * caller can pass the constant width instead).
 */
function computeTaperedWidths(road, junctionWidthMap, tol) {
  const pts = road.points;
  if (!pts || pts.length < 2) return null;
  const ownW = Number.isFinite(Number(road.width))
    ? Math.max(3, Math.min(30, Number(road.width)))
    : (WIDTH_BY_TYPE[road.highwayType] ?? 6);

  const startHash = hashPoint(pts[0].x, pts[0].y, tol);
  const endHash = hashPoint(pts[pts.length - 1].x, pts[pts.length - 1].y, tol);
  const startJ = junctionWidthMap.get(startHash);
  const endJ = junctionWidthMap.get(endHash);

  const startTarget = startJ ? startJ.maxW : ownW;
  const endTarget = endJ ? endJ.maxW : ownW;
  const needsStart = Math.abs(startTarget - ownW) >= 0.5;
  const needsEnd = Math.abs(endTarget - ownW) >= 0.5;
  if (!needsStart && !needsEnd) return null;

  // Precompute cumulative distance
  const cumDist = [0];
  for (let i = 1; i < pts.length; i++) {
    cumDist[i] = cumDist[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  const totalLen = cumDist[pts.length - 1];
  const taper = Math.min(WIDTH_TAPER_DISTANCE, totalLen / 2);

  const widths = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const dStart = cumDist[i];
    const dEnd = totalLen - dStart;
    let w = ownW;
    if (needsStart && dStart < taper) {
      const t = dStart / taper;
      const blend = t * t * (3 - 2 * t); // smoothstep
      w = startTarget + blend * (ownW - startTarget);
    }
    if (needsEnd && dEnd < taper) {
      const t = dEnd / taper;
      const blend = t * t * (3 - 2 * t);
      const wEnd = endTarget + blend * (ownW - endTarget);
      // If both ends taper (short road), blend to the wider value
      w = Math.max(w, wEnd);
    }
    widths[i] = w;
  }
  return widths;
}

/** Line segment (ax,az)->(bx,bz) vs circle center (jx,jz) radius R. Returns t values in [0,1] for intersections. */
function segmentCircleIntersections(ax, az, bx, bz, jx, jz, R) {
  const dx = bx - ax;
  const dz = bz - az;
  const ox = ax - jx;
  const oz = az - jz;
  const a = dx * dx + dz * dz;
  if (a < 1e-14) return [];
  const b = 2 * (dx * ox + dz * oz);
  const c = ox * ox + oz * oz - R * R;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const sqrtD = Math.sqrt(disc);
  const t1 = (-b - sqrtD) / (2 * a);
  const t2 = (-b + sqrtD) / (2 * a);
  const out = [];
  if (t1 >= 0 && t1 <= 1) out.push(t1);
  if (t2 >= 0 && t2 <= 1 && Math.abs(t2 - t1) > 1e-8) out.push(t2);
  return out;
}

function distToPoint(x, z, jx, jz) {
  return Math.hypot(x - jx, z - jz);
}

/** Returns true if (x,z) is outside all junction circles. radiusOrGetter: number or (j) => number. */
function isOutsideJunctions(x, z, junctions, radiusOrGetter) {
  const getR = (j) => (typeof radiusOrGetter === 'function' ? radiusOrGetter(j) : radiusOrGetter);
  for (const j of junctions) {
    const r = getR(j);
    if (distToPoint(x, z, j.x, j.z) < r - 1e-6) return false;
  }
  return true;
}

/**
 * Clip polyline so no part lies inside junction circles. Returns array of polylines (runs).
 * points: [{ x, y }] with y = Z. radiusOrGetter: number (all junctions) or (j) => number (per-junction).
 */
function clipPolylineNearJunctions(points, junctionPoints, radiusOrGetter) {
  if (!points || points.length < 2 || junctionPoints.length === 0) return [points];
  const junctions = junctionPoints;
  const getR = (j) => (typeof radiusOrGetter === 'function' ? radiusOrGetter(j) : radiusOrGetter);
  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const A = points[i];
    const B = points[i + 1];
    const ax = A.x; const az = A.y;
    const bx = B.x; const bz = B.y;
    let tValues = [0, 1];
    for (const j of junctions) {
      const r = getR(j);
      const ts = segmentCircleIntersections(ax, az, bx, bz, j.x, j.z, r);
      for (const t of ts) tValues.push(t);
    }
    tValues = [...new Set(tValues)].sort((a, b) => a - b);
    for (let k = 0; k < tValues.length - 1; k++) {
      const ta = tValues[k];
      const tb = tValues[k + 1];
      const tMid = (ta + tb) / 2;
      const mx = ax + tMid * (bx - ax);
      const mz = az + tMid * (bz - az);
      if (isOutsideJunctions(mx, mz, junctions, radiusOrGetter)) {
        const px = ax + ta * (bx - ax);
        const pz = az + ta * (bz - az);
        const qx = ax + tb * (bx - ax);
        const qz = az + tb * (bz - az);
        segments.push([{ x: px, y: pz }, { x: qx, y: qz }]);
      }
    }
  }
  if (segments.length === 0) return [];
  const eps = 1e-4;
  function eq(a, b) {
    return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;
  }
  const runs = [];
  for (const seg of segments) {
    let added = false;
    for (const run of runs) {
      if (eq(run[run.length - 1], seg[0])) {
        if (!eq(run[run.length - 1], seg[1])) run.push(seg[1]);
        added = true;
        break;
      }
      if (eq(run[0], seg[1])) {
        if (!eq(run[0], seg[0])) run.unshift(seg[0]);
        added = true;
        break;
      }
    }
    if (!added) runs.push([seg[0], seg[1]]);
  }
  return runs.filter((r) => r.length >= 2);
}

const SIDEWALK_CLAMP_EPSILON = 0.01;

/**
 * Clamp sidewalk mesh vertices so none lie inside any road (thick segment).
 * Modifies position attribute in place (XZ only). Use after mergeGeometries.
 */
function clampSidewalkVerticesOutsideRoads(roads, positionAttr) {
  if (!positionAttr || positionAttr.itemSize !== 3 || !roads?.length) return;
  const pos = positionAttr.array;
  const n = pos.length / 3;
  for (let iter = 0; iter < 2; iter++) {
    for (let i = 0; i < n; i++) {
      let x = pos[i * 3];
      let z = pos[i * 3 + 2];
      for (const road of roads) {
        const pts = road.points;
        if (!pts || pts.length < 2) continue;
        const half = getRoadWidth(road) / 2 + SIDEWALK_CLAMP_EPSILON;
        for (let j = 0; j < pts.length - 1; j++) {
          const ax = pts[j].x;
          const az = pts[j].y;
          const bx = pts[j + 1].x;
          const bz = pts[j + 1].y;
          const dx = bx - ax;
          const dz = bz - az;
          const lenSq = dx * dx + dz * dz || 1e-12;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lenSq));
          const qx = ax + t * dx;
          const qz = az + t * dz;
          const d = Math.hypot(x - qx, z - qz);
          if (d < half) {
            if (d < 1e-6) {
              const perpX = -dz / Math.sqrt(lenSq);
              const perpZ = dx / Math.sqrt(lenSq);
              x = qx + half * perpX;
              z = qz + half * perpZ;
            } else {
              const scale = half / d;
              x = qx + (x - qx) * scale;
              z = qz + (z - qz) * scale;
            }
          }
        }
      }
      pos[i * 3] = x;
      pos[i * 3 + 2] = z;
    }
  }
}

/** Get polyline points offset by distance (positive = right, negative = left). points: [{x,y}], y = Z. */
function getOffsetPolyline(points, offset) {
  if (!points || points.length < 2) return [];
  const out = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    let dx, dz;
    if (i === 0) {
      dx = points[1].x - p.x;
      dz = points[1].y - p.y;
    } else if (i === n - 1) {
      dx = p.x - points[n - 2].x;
      dz = p.y - points[n - 2].y;
    } else {
      dx = points[i + 1].x - points[i - 1].x;
      dz = points[i + 1].y - points[i - 1].y;
    }
    const len = Math.hypot(dx, dz) || 1;
    const perpX = (-dz / len) * offset;
    const perpZ = (dx / len) * offset;
    out.push({ x: p.x + perpX, y: p.y + perpZ });
  }
  return out;
}

/**
 * Create road ribbon geometry for one road (for merging).
 * @param {object} road - { points, width, highwayType, tunnel?, bridge?, layer? }
 * @param {{ getElevationAt?: (lat, lon) => number }} [options]
 * @returns {THREE.BufferGeometry|null}
 */
export function createRoadMesh(road, options, taperedWidths) {
  const pts = road.points;
  if (!pts || pts.length < 2) return null;
  // Marked crossings (footway=crossing etc., flagged at bake — bake-surface-clipping.md Phase 1):
  // no ribbon. They live INSIDE the carriageway; the zebra decals come from buildCrosswalks and
  // the polyline stays available to gameplay systems.
  if (road.crossing) return null;
  const widthOrWidths = taperedWidths || (
    Number.isFinite(Number(road.width))
      ? Math.max(3, Math.min(30, Number(road.width)))
      : (WIDTH_BY_TYPE[road.highwayType] ?? 6)
  );
  const heights = getRoadPointHeights(road, options);
  const yOffsetOrHeights = heights || ROAD_OFFSET;
  // Apply priority-based Y micro-offset: wider roads sit fractionally higher
  // to win depth test at intersections and eliminate z-fighting
  const priorityBump = ROAD_PRIORITY_Y_BUMP[road.highwayType] ?? 0;
  let finalY = yOffsetOrHeights;
  if (priorityBump > 0) {
    if (Array.isArray(finalY)) {
      for (let i = 0; i < finalY.length; i++) finalY[i] += priorityBump;
    } else {
      finalY = finalY + priorityBump;
    }
  }
  return buildFlatRibbonGeometry(pts, widthOrWidths, finalY);
}

/** White material for center lines, lane dividers, and edge lines (Norma 8.2-IC). */
let whiteLineMaterial = null;
let _mergedMarkingMaterial = null;
let _markingNight = false;                 // persisted so materials built AFTER a night toggle inherit it
// Unlit paint → hand-tuned per time of day. Day: muted worn grey (0xB0B0B0 read too bright).
// Night: soft moonlit grey (visible, not glaring). Both one-line tunable.
const MARK_DAY = 0x8a8a8a, MARK_NIGHT = 0x565b62;
/** Shared unlit material for all lane lines + zebra crosswalks (created once, night-state-aware). */
function getMarkingMaterial() {
  if (!_mergedMarkingMaterial) {
    _mergedMarkingMaterial = applyGroundLayer(new THREE.MeshBasicMaterial({
      color: _markingNight ? MARK_NIGHT : MARK_DAY,
      vertexColors: true,
    }), 'marking');
  }
  return _mergedMarkingMaterial;
}
let _mergedPedestrianMaterial = null;
function getWhiteLineMaterial() {
  if (!whiteLineMaterial) {
    whiteLineMaterial = applyGroundLayer(new THREE.MeshLambertMaterial({ color: BCN_COLORS.PAINT_WHITE, flatShading: false }), 'marking');
  }
  return whiteLineMaterial;
}

/** Yellow/blue paint material reserved for Phase 4 (no-parking, regulated parking). Currently unused. */
let yellowLineMaterial = null;
function getYellowLineMaterial() {
  if (!yellowLineMaterial) {
    yellowLineMaterial = applyGroundLayer(new THREE.MeshLambertMaterial({ color: BCN_COLORS.PAINT_WHITE, flatShading: false }), 'marking');
  }
  return yellowLineMaterial;
}


/**
 * Walk along a polyline and extract sub-polylines for each dash segment.
 * Returns an array of { points: [{x,y}], heights: number[]|null } for each dash.
 * Heights are interpolated from the source heights array when provided.
 */
function extractDashSubPolylines(polyline, dashLen, gapLen, sourceHeights) {
  if (!polyline || polyline.length < 2) return [];

  const cumDist = [0];
  for (let i = 1; i < polyline.length; i++) {
    cumDist.push(cumDist[i - 1] + Math.hypot(polyline[i].x - polyline[i - 1].x, polyline[i].y - polyline[i - 1].y));
  }
  const totalLen = cumDist[cumDist.length - 1];
  if (totalLen < 0.5) return [];

  const cycle = dashLen + gapLen;
  const dashes = [];

  function pointAtDist(d) {
    d = Math.max(0, Math.min(totalLen, d));
    for (let i = 0; i < cumDist.length - 1; i++) {
      if (d >= cumDist[i] && d <= cumDist[i + 1] + 1e-9) {
        const segLen = cumDist[i + 1] - cumDist[i];
        const t = segLen > 1e-9 ? (d - cumDist[i]) / segLen : 0;
        const a = polyline[i];
        const b = polyline[i + 1];
        const pt = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
        let h = null;
        if (sourceHeights) {
          const hA = sourceHeights[i] != null ? sourceHeights[i] : 0;
          const hB = sourceHeights[i + 1] != null ? sourceHeights[i + 1] : 0;
          h = hA + t * (hB - hA);
        }
        return { pt, h };
      }
    }
    const last = polyline[polyline.length - 1];
    return { pt: { x: last.x, y: last.y }, h: sourceHeights ? sourceHeights[sourceHeights.length - 1] : null };
  }

  let dist = 0;
  while (dist + dashLen <= totalLen + 0.01) {
    const dStart = dist;
    const dEnd = Math.min(dist + dashLen, totalLen);
    const pts = [];
    const hts = sourceHeights ? [] : null;

    const startRes = pointAtDist(dStart);
    pts.push(startRes.pt);
    if (hts) hts.push(startRes.h);

    for (let i = 0; i < cumDist.length; i++) {
      if (cumDist[i] > dStart + 1e-9 && cumDist[i] < dEnd - 1e-9) {
        pts.push({ x: polyline[i].x, y: polyline[i].y });
        if (hts) hts.push(sourceHeights[i]);
      }
    }

    const endRes = pointAtDist(dEnd);
    const lastPt = pts[pts.length - 1];
    if (Math.hypot(endRes.pt.x - lastPt.x, endRes.pt.y - lastPt.y) > 1e-6) {
      pts.push(endRes.pt);
      if (hts) hts.push(endRes.h);
    }

    if (pts.length >= 2) {
      dashes.push({ points: pts, heights: hts });
    }
    dist += cycle;
  }
  return dashes;
}

/**
 * Build dashed ribbon geometries along a polyline.
 * Returns an array of BufferGeometry, one per dash segment.
 */
function buildDashedRibbons(polyline, width, dashLen, gapLen, heights) {
  const subs = extractDashSubPolylines(polyline, dashLen, gapLen, heights);
  const geoms = [];
  for (const sub of subs) {
    const h = sub.heights ? sub.heights.map((v) => v + MARKING_Y_ABOVE_ROAD) : (ROAD_OFFSET + ROAD_VISUAL_ABOVE_TERRAIN + MARKING_Y_ABOVE_ROAD);
    const g = buildFlatRibbonGeometry(sub.points, width, h);
    if (g) geoms.push(g);
  }
  return geoms;
}

/**
 * Build a solid (continuous) ribbon along a polyline for road markings.
 * @returns {THREE.BufferGeometry|null}
 */
function buildSolidRibbon(polyline, width, heights) {
  const h = heights ? heights.map((v) => v + MARKING_Y_ABOVE_ROAD) : (ROAD_OFFSET + ROAD_VISUAL_ABOVE_TERRAIN + MARKING_Y_ABOVE_ROAD);
  return buildFlatRibbonGeometry(polyline, width, h);
}

/**
 * For each point in targetPts, find the closest projection onto the srcPts
 * polyline and linearly interpolate from srcHeights.  Works for offset,
 * clipped, or any derived polyline regardless of point count.
 */
function interpolateHeightsFromSource(srcPts, srcHeights, targetPts) {
  if (!srcHeights || !srcPts || srcPts.length < 2 || !targetPts || targetPts.length === 0) return null;
  if (targetPts.length === srcHeights.length && targetPts === srcPts) return srcHeights;

  const out = new Array(targetPts.length);
  for (let ti = 0; ti < targetPts.length; ti++) {
    const px = targetPts[ti].x, pz = targetPts[ti].y;
    let bestT = 0, bestSeg = 0, bestDistSq = Infinity;
    for (let i = 0; i < srcPts.length - 1; i++) {
      const ax = srcPts[i].x, az = srcPts[i].y;
      const bx = srcPts[i + 1].x, bz = srcPts[i + 1].y;
      const dx = bx - ax, dz = bz - az;
      const lenSq = dx * dx + dz * dz;
      const t = lenSq > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq)) : 0;
      const cx = ax + t * dx, cz = az + t * dz;
      const dSq = (px - cx) * (px - cx) + (pz - cz) * (pz - cz);
      if (dSq < bestDistSq) { bestDistSq = dSq; bestSeg = i; bestT = t; }
    }
    const hA = srcHeights[bestSeg] ?? 0;
    const hB = srcHeights[bestSeg + 1] ?? 0;
    out[ti] = hA + bestT * (hB - hA);
  }
  return out;
}

/**
 * Build all Norma 8.2-IC road markings for a tile: center lines, lane dividers, edge lines.
 * Merges all white geometries (center + lane) and yellow geometries (edge) separately.
 * @returns {{ whiteMarkingsMesh: THREE.Mesh|null, yellowMarkingsMesh: THREE.Mesh|null }}
 */
function buildRoadMarkings(roads, options) {
  const whiteGeoms = [];
  const yellowGeoms = [];
  const junctionPoints = getJunctionPoints(roads, JUNCTION_TOLERANCE);
  const getJunctionRadius = (j) => (j.radius != null ? j.radius : INTERSECTION_RADIUS);

  for (const road of roads) {
    const type = road.highwayType || '';
    const rules = MARKING_RULES[type];
    if (!rules) continue;

    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    // Was `if (road.tunnel) continue;` — a Delhi-era guard from when tunnels were a separate dark
    // enclosure. With Option-L DAYLIGHTED trenches the corridor IS a normal baked asphalt deck, so
    // its lane lines were being suppressed (Ronda de Dalt etc. = plain grey). Only skip markings for
    // fully-covered tunnels (tunnel && layer >= 0); daylighted layer<0 corridors get proper paint.
    if (road.tunnel && !(road.layer != null && road.layer < 0)) continue;

    const roadWidth = Math.max(4, Math.min(30, Number(road.width) || (WIDTH_BY_TYPE[type] ?? 6)));
    const half = roadWidth / 2;
    const roadHeights = getRoadPointHeights(road, options);

    // For ramp/link roads, use a smaller clipping radius (own width) so short
    // ramps aren't entirely swallowed by large junction radii from trunk/motorway.
    const isLinkRoad = road.isRamp || (type && type.endsWith('_link'));
    const getClipRadius = isLinkRoad
      ? () => Math.max(roadWidth * 0.5, INTERSECTION_RADIUS)
      : getJunctionRadius;

    // --- Center line ---
    if (rules.center) {
      const centerPts = pts;
      const runs = junctionPoints.length > 0
        ? clipPolylineNearJunctions(centerPts, junctionPoints, getClipRadius)
        : [centerPts];

      for (const run of runs) {
        const runHeights = interpolateHeightsFromSource(pts, roadHeights, run);

        if (rules.center === 'double_solid') {
          for (const sign of [-1, 1]) {
            const offset = sign * DOUBLE_LINE_GAP;
            const linePts = getOffsetPolyline(run, offset);
            const h = interpolateHeightsFromSource(pts, roadHeights, linePts);
            const g = buildSolidRibbon(linePts, CENTER_LINE_WIDTH, h);
            if (g) whiteGeoms.push(g);
          }
        } else if (rules.center === 'solid') {
          const g = buildSolidRibbon(run, CENTER_LINE_WIDTH, runHeights);
          if (g) whiteGeoms.push(g);
        } else {
          const dashGeoms = buildDashedRibbons(run, CENTER_LINE_WIDTH, DASH_LENGTH, DASH_GAP, runHeights);
          for (const g of dashGeoms) whiteGeoms.push(g);
        }
      }
    }

    // --- Lane dividers (white dashed) ---
    if (rules.lanes) {
      const totalLanes = road.lanes ?? LANES_BY_TYPE[type] ?? 2; // Phase 2: prefer OSM lane count over hardcoded default
      if (totalLanes > 2) {
        const laneWidth = roadWidth / totalLanes;
        for (let k = 1; k < totalLanes; k++) {
          const offset = -half + k * laneWidth;
          if (Math.abs(offset) < 0.1) continue;
          const lanePts = getOffsetPolyline(pts, offset);

          const runs = junctionPoints.length > 0
            ? clipPolylineNearJunctions(lanePts, junctionPoints, getClipRadius)
            : [lanePts];

          for (const run of runs) {
            const runH = interpolateHeightsFromSource(pts, roadHeights, run);
            const dashGeoms = buildDashedRibbons(run, LANE_DIVIDER_WIDTH, DASH_LENGTH, DASH_GAP, runH);
            for (const g of dashGeoms) whiteGeoms.push(g);
          }
        }
      }
    }

    // --- Edge lines (white solid) — sits at road edge, below reflectors and dust ---
    if (rules.edge) {
      for (const sign of [-1, 1]) {
        const edgePts = getOffsetPolyline(pts, sign * (half - 0.4));

        const runs = junctionPoints.length > 0
          ? clipPolylineNearJunctions(edgePts, junctionPoints, getClipRadius)
          : [edgePts];

        for (const run of runs) {
          const runH = interpolateHeightsFromSource(pts, roadHeights, run);
          const g = buildSolidRibbon(run, MARKING_EDGE_LINE_WIDTH, runH);
          if (g) whiteGeoms.push(g);
        }
      }
    }
  }

  // Merge white + yellow markings into a single mesh using vertex colors
  const out = { whiteMarkingsMesh: null, yellowMarkingsMesh: null };

  const whiteColor = new THREE.Color(BCN_COLORS.PAINT_WHITE);   // Norma 8.2-IC: all longitudinal lines white
  const yellowColor = new THREE.Color(BCN_COLORS.PAINT_WHITE);  // Phase 4 will use BCN_COLORS.PAINT_YELLOW for no-parking
  const allMarkingGeoms = [];

  for (const g of whiteGeoms) {
    const count = g.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) { colors[i*3] = whiteColor.r; colors[i*3+1] = whiteColor.g; colors[i*3+2] = whiteColor.b; }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    allMarkingGeoms.push(g);
  }
  for (const g of yellowGeoms) {
    const count = g.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) { colors[i*3] = yellowColor.r; colors[i*3+1] = yellowColor.g; colors[i*3+2] = yellowColor.b; }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    allMarkingGeoms.push(g);
  }

  if (allMarkingGeoms.length > 0) {
    const merged = mergeGeometries(allMarkingGeoms);
    allMarkingGeoms.forEach((g) => g.dispose());
    if (merged) {
      const mesh = new THREE.Mesh(merged, getMarkingMaterial());
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false; // tile-level LOD handles visibility; avoids marking pop-in at distance
      mesh.userData.sharedMaterial = true;
      out.whiteMarkingsMesh = mesh; // reuse existing slot — tileManager expects this key
    }
  }

  return out;
}

/**
 * Build Norma 8.2-IC zebra crosswalks (paso de cebra) at every eligible junction.
 * Stripes 0.50 m wide / 0.50 m gap, full road width, placed just outside the junction
 * clipping zone on each approach. Returns a single merged mesh or null.
 *
 * Vertex cost: ~40 verts per crosswalk approach, ~160 per junction.
 * Mesh is tagged userData.type='crosswalk' for 80m LOD culling in tileManager.
 */
function buildCrosswalks(roads, options) {
  if (!CONFIG.ENABLE_CROSSWALKS) return null;

  const CROSSWALK_SETBACK = 1.5; // metres past the clipping zone edge before first stripe
  const CROSSWALK_Y_ABOVE = 0.055; // above ±3.5cm road noise, but lowered from 0.08 so stripes don't float ~0.14m over the wheels (made the car look extra-sunk at crossings)

  const junctionPoints = getJunctionPoints(roads, JUNCTION_TOLERANCE);
  if (junctionPoints.length === 0) return null;

  // Build fast lookup: road-point hash → junction object
  const junctionMap = new Map();
  for (const j of junctionPoints) {
    junctionMap.set(hashPoint(j.x, j.z, JUNCTION_TOLERANCE), j);
  }

  // Only road types that would have pedestrian crossings
  const ELIGIBLE = new Set([
    'primary', 'secondary', 'tertiary',
    'primary_link', 'secondary_link', 'tertiary_link',
    'residential', 'unclassified', 'living_street',
  ]);

  const geoms = [];

  for (const road of roads) {
    const type = road.highwayType || '';
    if (!ELIGIBLE.has(type)) continue;
    if (road.tunnel || road.bridge) continue;

    const pts = road.points;
    if (!pts || pts.length < 2) continue;

    const roadWidth = Math.max(4, Math.min(30, Number(road.width) || (WIDTH_BY_TYPE[type] ?? 6)));
    const heights = getRoadPointHeights(road, options);

    // Compute total polyline length for the short-road guard
    let roadLength = 0;
    for (let i = 1; i < pts.length; i++) {
      roadLength += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
    }

    for (const endIdx of [0, pts.length - 1]) {
      const ep = pts[endIdx];
      const junction = junctionMap.get(hashPoint(ep.x, ep.y, JUNCTION_TOLERANCE));
      if (!junction) continue;

      // Clipping zone radius: max road width at junction, fallback to INTERSECTION_RADIUS
      const clipR = Math.max(junction.radius > 0 ? junction.radius : 0, INTERSECTION_RADIUS);

      // Crosswalk setback from junction center
      const setback = clipR + CROSSWALK_SETBACK;

      // Short-road guard: skip if both-end setbacks overlap (road shorter than 2× setback)
      if (setback * 2 > roadLength) continue;

      // Direction vector pointing INTO the road from the junction endpoint
      const nextIdx = endIdx === 0 ? 1 : pts.length - 2;
      const next = pts[nextIdx];
      const dx = next.x - ep.x, dz = next.y - ep.y;
      const len = Math.hypot(dx, dz);
      if (len < 0.1) continue;
      const dirX = dx / len, dirZ = dz / len;

      // Perpendicular (stripes span across road in this direction)
      const perpX = -dirZ, perpZ = dirX;
      const half = roadWidth / 2;

      // Stripe generation: offset = gap/2 before first stripe, then every pitch metres
      const pitch = BCN_DIMS.CROSSWALK_STRIPE_WIDTH + BCN_DIMS.CROSSWALK_STRIPE_GAP; // 1.0 m
      const numStripes = Math.max(1, Math.floor((roadWidth - BCN_DIMS.CROSSWALK_STRIPE_GAP) / pitch));

      for (let s = 0; s < numStripes; s++) {
        // Centre of this stripe in the along-road direction
        const alongOffset = setback + BCN_DIMS.CROSSWALK_STRIPE_GAP * 0.5 + s * pitch;

        const sCx = ep.x + dirX * alongOffset;
        const sCz = ep.y + dirZ * alongOffset;

        // Stripe centerline: runs ACROSS road (perpendicular direction), two endpoints
        const leftPt  = { x: sCx + perpX * half, y: sCz + perpZ * half };
        const rightPt = { x: sCx - perpX * half, y: sCz - perpZ * half };

        // Height EXACTLY like the (working) lane lines: project each stripe endpoint onto the road
        // centerline and read its draped height there. The old endpoint-height version floated.
        const hh = interpolateHeightsFromSource(pts, heights, [leftPt, rightPt]);
        const stripeH = hh
          ? hh.map((v) => v + CROSSWALK_Y_ABOVE)
          : (ROAD_OFFSET + ROAD_VISUAL_ABOVE_TERRAIN + CROSSWALK_Y_ABOVE);

        const g = buildFlatRibbonGeometry([leftPt, rightPt], BCN_DIMS.CROSSWALK_STRIPE_WIDTH, stripeH);
        if (g) geoms.push(g);
      }
    }
  }

  if (geoms.length === 0) return null;

  try {
    const merged = mergeGeometries(geoms);
    geoms.forEach(g => g.dispose());
    if (!merged) return null;

    // Apply BCN_COLORS.PAINT_WHITE as vertex color (matches _mergedMarkingMaterial)
    const count = merged.attributes.position.count;
    const colors = new Float32Array(count * 3);
    const c = new THREE.Color(BCN_COLORS.PAINT_WHITE);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const mesh = new THREE.Mesh(merged, getMarkingMaterial());
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false; // tile-level LOD (crosswalkMesh hidden at >80m in tileManager)
    mesh.userData = { sharedMaterial: true, type: 'crosswalk', noMerge: true };
    return mesh;
  } catch {
    geoms.forEach(g => g.dispose());
    return null;
  }
}

/**
 * Build one-way direction arrows (→) painted on road surface — Norma 8.2-IC.
 * Requires road.oneway from Phase 2 OSM data ('forward' | 'backward' | 'no' | null).
 * Triangle arrow, 1.5m long × 0.6m wide, placed every 30m along eligible roads.
 * Tagged userData.noMerge=true, type='onewayArrows' for 80m LOD culling in tileManager.
 */
function buildOnewayArrows(roads, options) {
  if (!CONFIG.ENABLE_ONEWAY_ARROWS) return null;

  const ARROW_SPACING = 30;    // metres between arrows
  const ARROW_LENGTH  = 0.75;  // half-length of triangle (tip to center)
  const ARROW_HALF_W  = 0.30;  // half-width of triangle base
  const ARROW_Y_ABOVE = 0.035;  // above road surface (lowered with crosswalks/markings)

  // Skip road types where arrows would be redundant clutter (direction implied by divider)
  const SKIP_TYPES = new Set(['motorway', 'trunk', 'motorway_link', 'trunk_link']);
  // Minimum road length to bother with an arrow
  const MIN_ROAD_LEN = ARROW_SPACING * 0.5;

  const geoms = [];

  for (const road of roads) {
    if (!road.oneway || road.oneway === 'no') continue;
    if (road.tunnel || road.bridge) continue;
    if (SKIP_TYPES.has(road.highwayType)) continue;

    const pts = road.points;
    if (!pts || pts.length < 2) continue;

    // Compute cumulative distances along polyline
    const cumDist = [0];
    for (let i = 1; i < pts.length; i++) {
      cumDist.push(cumDist[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    }
    const totalLen = cumDist[cumDist.length - 1];
    if (totalLen < MIN_ROAD_LEN) continue;

    const heights = getRoadPointHeights(road, options);
    const isBackward = road.oneway === 'backward';

    // Helper: interpolate position and direction at distance d along polyline
    function samplePolyline(d) {
      const clampD = Math.max(0, Math.min(totalLen, d));
      for (let i = 1; i < pts.length; i++) {
        if (cumDist[i] >= clampD) {
          const segLen = cumDist[i] - cumDist[i - 1];
          const t = segLen > 0 ? (clampD - cumDist[i - 1]) / segLen : 0;
          const ax = pts[i - 1].x, az = pts[i - 1].y;
          const bx = pts[i].x,   bz = pts[i].y;
          const px = ax + t * (bx - ax), pz = az + t * (bz - az);
          const len = Math.hypot(bx - ax, bz - az) || 1;
          const dxn = (bx - ax) / len, dzn = (bz - az) / len;
          const hA = heights ? heights[i - 1] : (ROAD_OFFSET + ROAD_VISUAL_ABOVE_TERRAIN);
          const hB = heights ? heights[i]     : (ROAD_OFFSET + ROAD_VISUAL_ABOVE_TERRAIN);
          const py = (hA + t * (hB - hA)) + ARROW_Y_ABOVE;
          return { px, py, pz, dxn, dzn };
        }
      }
      return null;
    }

    // Place arrows every ARROW_SPACING metres, offset by half-spacing from each end
    const firstOffset = ARROW_SPACING / 2;
    const arrowCount = Math.max(1, Math.floor((totalLen - firstOffset) / ARROW_SPACING) + 1);

    for (let a = 0; a < arrowCount; a++) {
      const d = firstOffset + a * ARROW_SPACING;
      if (d > totalLen - firstOffset * 0.5) break;

      const sample = samplePolyline(d);
      if (!sample) continue;

      let { px, py, pz, dxn, dzn } = sample;

      // Backward arrows: flip direction
      if (isBackward) { dxn = -dxn; dzn = -dzn; }

      // Perpendicular
      const perpX = -dzn, perpZ = dxn;

      // Triangle: tip at +ARROW_LENGTH ahead, base at -ARROW_LENGTH behind ± ARROW_HALF_W
      const tipX   = px + dxn * ARROW_LENGTH,        tipZ   = pz + dzn * ARROW_LENGTH;
      const baseL_X = px - dxn * ARROW_LENGTH + perpX * ARROW_HALF_W;
      const baseL_Z = pz - dzn * ARROW_LENGTH + perpZ * ARROW_HALF_W;
      const baseR_X = px - dxn * ARROW_LENGTH - perpX * ARROW_HALF_W;
      const baseR_Z = pz - dzn * ARROW_LENGTH - perpZ * ARROW_HALF_W;

      const posArr = new Float32Array([
        tipX,    py, tipZ,
        baseL_X, py, baseL_Z,
        baseR_X, py, baseR_Z,
      ]);
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
      geom.computeVertexNormals();
      geoms.push(geom);
    }
  }

  if (geoms.length === 0) return null;

  try {
    const merged = mergeGeometries(geoms);
    geoms.forEach(g => g.dispose());
    if (!merged) return null;

    // Apply BCN_COLORS.PAINT_WHITE as vertex color
    const count = merged.attributes.position.count;
    const colors = new Float32Array(count * 3);
    const c = new THREE.Color(BCN_COLORS.PAINT_WHITE);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const mesh = new THREE.Mesh(merged, getMarkingMaterial());
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false; // tile-level LOD (onewayArrowMesh hidden at >80m in tileManager)
    mesh.userData = { sharedMaterial: true, type: 'onewayArrows', noMerge: true };
    return mesh;
  } catch {
    geoms.forEach(g => g.dispose());
    return null;
  }
}

// ── PHASE 3: Sidewalks (panot), Curbs (granite), Bike lanes, Bike pictograms ─

/**
 * Infer which side(s) of a road have sidewalks.
 * OSM explicit tags take priority; road type is used as fallback when untagged.
 * Returns 'both'|'left'|'right'|null (null = no sidewalk).
 */
const _NO_SIDEWALK_TYPES = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link',
  'service', 'track', 'path', 'cycleway', 'footway', 'steps',
  'pedestrian', 'living_street',  // these ARE the walkable surface — no ribbon needed
]);
function inferSidewalkSide(road) {
  const osm = road.sidewalk;
  if (osm === 'both' || osm === 'left' || osm === 'right') return osm;
  if (osm === 'no' || osm === 'none') return null;
  // No explicit OSM tag — infer from highway type
  if (_NO_SIDEWALK_TYPES.has(road.highwayType || '')) return null;
  return 'both';
}

/**
 * Build OSM-driven panot sidewalk ribbons.
 * Uses OSM sidewalk= tag when present; falls back to road-type inference for untagged roads.
 * Uses world-space UV mapping so the 0.2m panot tile is constant physical size.
 * Y = road surface + CURB_HEIGHT (sidewalk sits atop the curb).
 */
function buildSidewalks(roads, options) {
  if (!CONFIG.ENABLE_SIDEWALKS) return null;

  const SIDEWALK_Y_ABOVE = BCN_DIMS.CURB_HEIGHT; // 0.12m — atop the curb
  const junctionPoints = getJunctionPoints(roads, JUNCTION_TOLERANCE);

  // Building proximity gate: skip sidewalk on roads with no building centroid within 30m.
  // Prevents sidewalks in parks, open fields, and rural roads inferred by road-type fallback.
  const _bldgCentroids = (options.buildings || []).map(b => {
    if (b.center) return { x: b.center.x, z: b.center.y };
    const fp = b.footprint || [];
    if (!fp.length) return null;
    return { x: fp.reduce((s, p) => s + p.x, 0) / fp.length, z: fp.reduce((s, p) => s + p.y, 0) / fp.length };
  }).filter(Boolean);
  const BLDG_PROX_SQ = 30 * 30;
  function _hasBuildingNearby(pts) {
    if (!_bldgCentroids.length) return false;
    for (const pt of pts) {
      for (const bc of _bldgCentroids) {
        const dx = pt.x - bc.x, dz = pt.y - bc.z;
        if (dx * dx + dz * dz < BLDG_PROX_SQ) return true;
      }
    }
    return false;
  }

  const geoms = [];

  for (const road of roads) {
    const sidewalkSide = inferSidewalkSide(road);
    if (!sidewalkSide) continue;
    if (road.tunnel) continue; // skip — would float underground

    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    if (!_hasBuildingNearby(pts)) continue; // no adjacent urban context

    const roadWidth = Math.max(4, Math.min(30, Number(road.width) || 6));
    const half = roadWidth / 2;

    // Sidewalk width from road width (no heuristics — just geometry-driven)
    let swWidth;
    if (roadWidth >= 25) swWidth = BCN_DIMS.SIDEWALK_WIDTH_BOULEVARD;
    else if (roadWidth < 12) swWidth = BCN_DIMS.SIDEWALK_WIDTH_NARROW;
    else swWidth = BCN_DIMS.SIDEWALK_WIDTH_EIXAMPLE;

    const heights = getRoadPointHeights(road, options);
    const baseY = heights ? heights.map(h => h + SIDEWALK_Y_ABOVE) : (ROAD_OFFSET + ROAD_VISUAL_ABOVE_TERRAIN + SIDEWALK_Y_ABOVE);

    // Offset from centerline: road edge + curb + half sidewalk width
    const offsetFromCenter = half + BCN_DIMS.CURB_WIDTH + swWidth / 2;

    // Junction clip radius must exceed offsetFromCenter so the clip actually reaches
    // the offset polyline and trims the sidewalk before it enters the intersection.
    const swJunctionRadius = (j) => (j.radius != null ? j.radius : INTERSECTION_RADIUS) + offsetFromCenter;

    const sides = sidewalkSide === 'left'  ? [-1] :
                  sidewalkSide === 'right' ? [+1] : [-1, +1];

    for (const sign of sides) {
      const offsetPts = getOffsetPolyline(pts, sign * offsetFromCenter);
      const runs = junctionPoints.length > 0
        ? clipPolylineNearJunctions(offsetPts, junctionPoints, swJunctionRadius)
        : [offsetPts];

      for (const run of runs) {
        const runY = Array.isArray(baseY) ? interpolateHeightsFromSource(pts, baseY, run) : baseY;
        const g = buildFlatRibbonGeometry(run, swWidth, runY);
        if (!g) continue;

        // World-space UV mapping: 1 UV unit = PANOT_TILE_SIZE (0.2m)
        // Overwrite UVs using world positions from geometry
        const posAttr = g.getAttribute('position');
        const uvArr = new Float32Array(posAttr.count * 2);
        const TILE_SCALE = 1 / BCN_DIMS.PANOT_TILE_SIZE; // 5 tiles per metre
        for (let vi = 0; vi < posAttr.count; vi++) {
          uvArr[vi * 2]     = posAttr.getX(vi) * TILE_SCALE;
          uvArr[vi * 2 + 1] = posAttr.getZ(vi) * TILE_SCALE;
        }
        g.setAttribute('uv', new THREE.Float32BufferAttribute(uvArr, 2));
        geoms.push(g);
      }
    }
  }

  if (geoms.length === 0) return null;
  try {
    const merged = mergeGeometries(geoms);
    geoms.forEach(g => g.dispose());
    if (!merged) return null;
    merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, getPanotMaterial());
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.userData = { sharedMaterial: true, type: 'sidewalk', noMerge: true };
    return mesh;
  } catch { geoms.forEach(g => g.dispose()); return null; }
}

/**
 * Materialize PRE-BAKED sidewalk + curb geometry (v8 tiles, sidewalkBaker.js blobs).
 * Blob Y is RAW DEM elevation (+CURB_HEIGHT baked in) — normalized here exactly like the
 * bakedRoads fast path: y' = (y − elevationOffset) × vertExag + ROAD_VISUAL_ABOVE_TERRAIN.
 */
function buildBakedSidewalkMeshes(bs, bakedOffset, bakedVertExag) {
  const toGeom = (blob, withUv) => {
    if (!blob?.positions || !blob?.indices) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(
      blob.positions instanceof Float32Array ? blob.positions : new Float32Array(blob.positions), 3));
    if (blob.normals) {
      g.setAttribute('normal', new THREE.BufferAttribute(
        blob.normals instanceof Float32Array ? blob.normals : new Float32Array(blob.normals), 3));
    }
    if (withUv && blob.uvs) {
      g.setAttribute('uv', new THREE.BufferAttribute(
        blob.uvs instanceof Float32Array ? blob.uvs : new Float32Array(blob.uvs), 2));
    }
    g.setIndex(new THREE.BufferAttribute(
      blob.indices instanceof Uint32Array ? blob.indices : new Uint32Array(blob.indices), 1));
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (bakedVertExag !== 1) g.scale(1, bakedVertExag, 1);
    g.translate(0, -bakedOffset * bakedVertExag + ROAD_VISUAL_ABOVE_TERRAIN, 0);
    return g;
  };

  let sidewalkMesh = null;
  const swGeom = toGeom(bs.sidewalk, true);
  if (swGeom) {
    sidewalkMesh = new THREE.Mesh(swGeom, getPanotMaterial());
    sidewalkMesh.castShadow = false;
    sidewalkMesh.receiveShadow = true;
    sidewalkMesh.frustumCulled = false;
    sidewalkMesh.userData = { sharedMaterial: true, type: 'sidewalk', noMerge: true };
  }

  let curbMesh = null;
  const curbGeoms = [toGeom(bs.curbTop, false), toGeom(bs.curbFace, false)].filter(Boolean);
  if (curbGeoms.length) {
    let merged = curbGeoms[0];
    if (curbGeoms.length > 1) {
      try { merged = mergeGeometries(curbGeoms); curbGeoms.forEach((g) => { if (g !== merged) g.dispose(); }); }
      catch { merged = curbGeoms[0]; }
    }
    if (merged) {
      curbMesh = new THREE.Mesh(merged, getCurbMaterial());
      curbMesh.castShadow = false;
      curbMesh.receiveShadow = false;
      curbMesh.frustumCulled = false;
      curbMesh.userData = { sharedMaterial: true, type: 'curb', noMerge: true };
    }
  }

  return { sidewalkMesh, curbMesh };
}

/**
 * Build granite curb L-profile between road edge and sidewalk.
 * Two quads per segment: top face (horizontal) + outer vertical face (facing road).
 * Only generated for roads that have sidewalks (same eligibility as buildSidewalks).
 */
function buildCurbs(roads, options) {
  if (!CONFIG.ENABLE_CURBS) return null;

  const CURB_H = BCN_DIMS.CURB_HEIGHT;  // 0.12m
  const CURB_W = BCN_DIMS.CURB_WIDTH;   // 0.30m
  const junctionPoints = getJunctionPoints(roads, JUNCTION_TOLERANCE);

  // Same building proximity gate as buildSidewalks — curbs only where sidewalks are.
  const _bldgCentroids = (options.buildings || []).map(b => {
    if (b.center) return { x: b.center.x, z: b.center.y };
    const fp = b.footprint || [];
    if (!fp.length) return null;
    return { x: fp.reduce((s, p) => s + p.x, 0) / fp.length, z: fp.reduce((s, p) => s + p.y, 0) / fp.length };
  }).filter(Boolean);
  const BLDG_PROX_SQ = 30 * 30;
  function _hasBuildingNearby(pts) {
    if (!_bldgCentroids.length) return false;
    for (const pt of pts) {
      for (const bc of _bldgCentroids) {
        const dx = pt.x - bc.x, dz = pt.y - bc.z;
        if (dx * dx + dz * dz < BLDG_PROX_SQ) return true;
      }
    }
    return false;
  }

  const geoms = [];

  for (const road of roads) {
    const sidewalkSide = inferSidewalkSide(road);
    if (!sidewalkSide) continue;
    if (road.tunnel) continue;

    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    if (!_hasBuildingNearby(pts)) continue;

    const roadWidth = Math.max(4, Math.min(30, Number(road.width) || 6));
    const half = roadWidth / 2;
    const curbOffset = half + CURB_W;
    // Junction clip radius: must reach the curb offset polyline to actually trim corners.
    const curbJunctionRadius = (j) => (j.radius != null ? j.radius : INTERSECTION_RADIUS) + curbOffset;

    const heights = getRoadPointHeights(road, options);
    const sides = sidewalkSide === 'left'  ? [-1] :
                  sidewalkSide === 'right' ? [+1] : [-1, +1];

    for (const sign of sides) {
      // Curb outer edge sits at road edge (half from centerline)
      // Curb inner edge is CURB_W further outward
      const outerOffset = half;
      const innerOffset = half + CURB_W;

      // Outer edge polyline (at road boundary)
      const outerPts = getOffsetPolyline(pts, sign * outerOffset);
      // Inner edge polyline (at sidewalk boundary)
      const innerPts = getOffsetPolyline(pts, sign * innerOffset);

      const runs = junctionPoints.length > 0
        ? clipPolylineNearJunctions(outerPts, junctionPoints, curbJunctionRadius)
        : [outerPts];

      for (const run of runs) {
        if (run.length < 2) continue;
        const runInner = clipPolylineNearJunctions(innerPts, junctionPoints, curbJunctionRadius);

        // Per-run: build TOP face and OUTER VERTICAL face
        // TOP face: ribbon at Y = roadH + CURB_H, between outer and inner edges
        // Use buildFlatRibbonGeometry with centerline at midpoint, width = CURB_W
        const midPts = run.map((p, i) => ({
          x: (p.x + (runInner[0]?.[i]?.x ?? p.x)) / 2 || p.x,
          y: (p.y + (runInner[0]?.[i]?.y ?? p.y)) / 2 || p.y,
        }));
        // Simpler approach: center the ribbon between outer and inner
        const midOffset = sign * (outerOffset + CURB_W / 2);
        const midPtsSimple = getOffsetPolyline(pts, midOffset);
        const midRunsSimple = junctionPoints.length > 0
          ? clipPolylineNearJunctions(midPtsSimple, junctionPoints, curbJunctionRadius)
          : [midPtsSimple];

        for (const midRun of midRunsSimple) {
          const roadH = heights ? interpolateHeightsFromSource(pts, heights, midRun) : (ROAD_OFFSET + ROAD_VISUAL_ABOVE_TERRAIN);
          const topY = Array.isArray(roadH) ? roadH.map(h => h + CURB_H) : (roadH + CURB_H);

          // Quad A: TOP FACE — flat horizontal ribbon at curb top height
          const gTop = buildFlatRibbonGeometry(midRun, CURB_W, topY);
          if (gTop) geoms.push(gTop);

          // Quad B: OUTER VERTICAL FACE — thin vertical ribbon at road edge
          // Points run along the road edge; ribbon extends vertically 0→CURB_H
          const outerRunSimple = junctionPoints.length > 0
            ? clipPolylineNearJunctions(getOffsetPolyline(pts, sign * outerOffset), junctionPoints, curbJunctionRadius)
            : [getOffsetPolyline(pts, sign * outerOffset)];
          for (const outerRun of outerRunSimple) {
            if (outerRun.length < 2) continue;
            const bottomY = Array.isArray(roadH) ? interpolateHeightsFromSource(pts, heights, outerRun) : roadH;
            const gVert = buildFlatRibbonGeometry(outerRun, CURB_H, bottomY); // ribbon of height CURB_H
            // Rotate the vertical ribbon: it should stand upright
            // Since buildFlatRibbonGeometry creates a flat horizontal ribbon, we need to rotate
            // The ribbon sits in the XZ plane; we want it in the XY plane (vertical).
            // Apply a manual transform to the positions: swap Y and Z offsets
            if (gVert) {
              // buildFlatRibbonGeometry extrudes in ±X/Z with Y = height.
              // For the outer face we want a ribbon that extrudes in ±Y.
              // Instead of using buildFlatRibbonGeometry, build custom geometry.
              gVert.dispose();
              // Custom vertical face geometry
              const n = outerRun.length;
              const posArr = new Float32Array(n * 2 * 3);
              const uvArr  = new Float32Array(n * 2 * 2);
              const normals = new Float32Array(n * 2 * 3);
              const dir = new THREE.Vector3();
              let cumLen = 0;
              for (let i = 0; i < n; i++) {
                const p = outerRun[i];
                const yBottom = Array.isArray(bottomY) ? (bottomY[i] ?? bottomY[0]) : bottomY;
                const yTop = yBottom + CURB_H;
                // Inward normal (toward road center): sign flipped
                if (i < n - 1) {
                  dir.set(outerRun[i+1].x - p.x, 0, outerRun[i+1].y - p.y).normalize();
                }
                const nx = -sign * dir.z, nz = sign * dir.x; // perpendicular inward
                const base = i * 2 * 3;
                posArr[base]   = p.x; posArr[base+1] = yBottom; posArr[base+2] = p.y;
                posArr[base+3] = p.x; posArr[base+4] = yTop;    posArr[base+5] = p.y;
                const uvBase = i * 2 * 2;
                if (i > 0) cumLen += Math.hypot(outerRun[i].x - outerRun[i-1].x, outerRun[i].y - outerRun[i-1].y);
                uvArr[uvBase]   = cumLen; uvArr[uvBase+1] = 0;
                uvArr[uvBase+2] = cumLen; uvArr[uvBase+3] = 1;
                // Normal facing inward (toward road)
                for (let k = 0; k < 2; k++) {
                  normals[(i*2+k)*3]   = nx;
                  normals[(i*2+k)*3+1] = 0;
                  normals[(i*2+k)*3+2] = nz;
                }
              }
              const idxArr = new Uint32Array((n - 1) * 6);
              for (let i = 0; i < n - 1; i++) {
                const a = i*2, b = i*2+1, c = (i+1)*2, d = (i+1)*2+1;
                idxArr[i*6]   = a; idxArr[i*6+1] = c; idxArr[i*6+2] = b;
                idxArr[i*6+3] = b; idxArr[i*6+4] = c; idxArr[i*6+5] = d;
              }
              const gFace = new THREE.BufferGeometry();
              gFace.setAttribute('position',  new THREE.BufferAttribute(posArr, 3));
              gFace.setAttribute('normal',    new THREE.BufferAttribute(normals, 3));
              gFace.setAttribute('uv',        new THREE.BufferAttribute(uvArr, 2));
              // halfWidth required for mergeGeometries consistency with gTop (from buildFlatRibbonGeometry)
              gFace.setAttribute('halfWidth', new THREE.BufferAttribute(new Float32Array(n * 2).fill(CURB_W / 2), 1));
              gFace.setIndex(new THREE.BufferAttribute(idxArr, 1));
              geoms.push(gFace);
            }
          }
        }
      }
    }
  }

  if (geoms.length === 0) return null;
  try {
    const merged = mergeGeometries(geoms);
    geoms.forEach(g => g.dispose());
    if (!merged) return null;
    merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, getCurbMaterial());
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.userData = { sharedMaterial: true, type: 'curb', noMerge: true };
    return mesh;
  } catch { geoms.forEach(g => g.dispose()); return null; }
}

/**
 * Build solid green bike lane ribbons from road.cycleway OSM data.
 * Strict: only renders for 'lane','opposite_lane','track','opposite_track'. No fallbacks.
 * Position: between the rightmost car lane and the curb (offset inward from road edge).
 */
function buildBikeLanes(roads, options) {
  if (!CONFIG.ENABLE_BIKE_LANES) return null;

  const VALID_CYCLEWAY = new Set(['lane', 'opposite_lane', 'track', 'opposite_track']);
  const BIKE_W = BCN_DIMS.BIKE_LANE_WIDTH_ONEWAY; // 2.0m
  const BIKE_Y_ABOVE = 0.02; // slight raise above asphalt
  const junctionPoints = getJunctionPoints(roads, JUNCTION_TOLERANCE);
  const getJunctionRadius = (j) => (j.radius != null ? j.radius : INTERSECTION_RADIUS);

  const geoms = [];

  for (const road of roads) {
    if (!road.cycleway || !VALID_CYCLEWAY.has(road.cycleway)) continue;
    if (road.tunnel) continue;
    // Allow on bridges if cycleway is tagged

    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const roadWidth = Math.max(4, Math.min(30, Number(road.width) || 6));
    const half = roadWidth / 2;

    const heights = getRoadPointHeights(road, options);
    const baseY = heights ? heights.map(h => h + BIKE_Y_ABOVE) : (ROAD_OFFSET + ROAD_VISUAL_ABOVE_TERRAIN + BIKE_Y_ABOVE);

    // Side: 'opposite_*' → left side (sign=−1), others → right side (sign=+1)
    const sign = (road.cycleway === 'opposite_lane' || road.cycleway === 'opposite_track') ? -1 : +1;

    // Center the bike lane between road edge and curb: road_edge − BIKE_W/2 inward
    const offsetFromCenter = sign * (half - BIKE_W / 2);
    const lanePts = getOffsetPolyline(pts, offsetFromCenter);

    const runs = junctionPoints.length > 0
      ? clipPolylineNearJunctions(lanePts, junctionPoints, getJunctionRadius)
      : [lanePts];

    for (const run of runs) {
      const runY = Array.isArray(baseY) ? interpolateHeightsFromSource(pts, baseY, run) : baseY;
      const g = buildFlatRibbonGeometry(run, BIKE_W, runY);
      if (g) geoms.push(g);
    }
  }

  if (geoms.length === 0) return null;
  try {
    const merged = mergeGeometries(geoms);
    geoms.forEach(g => g.dispose());
    if (!merged) return null;
    const mesh = new THREE.Mesh(merged, getBikeLaneMaterial());
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.userData = { sharedMaterial: true, type: 'bikelane', noMerge: true };
    return mesh;
  } catch { geoms.forEach(g => g.dispose()); return null; }
}

/**
 * Build bike pictogram InstancedMesh — one draw call for all pictograms in a tile.
 * Pictograms every BIKE_PICTOGRAM_SPACING metres along bike lane centerline.
 * Oriented to face travel direction, flat on road surface + 0.03m.
 */
function buildBikePictograms(roads, options) {
  if (!CONFIG.ENABLE_BIKE_LANES) return null;

  const VALID_CYCLEWAY = new Set(['lane', 'opposite_lane', 'track', 'opposite_track']);
  const SPACING = BCN_DIMS.BIKE_PICTOGRAM_SPACING; // 30m
  const BIKE_W  = BCN_DIMS.BIKE_LANE_WIDTH_ONEWAY;
  const PICTO_Y = 0.03; // above road surface

  // Collect all instance matrices
  const matrices = [];
  const _mat4 = new THREE.Matrix4();
  const _pos  = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scl  = new THREE.Vector3(1, 1, 1);
  const _up   = new THREE.Vector3(0, 1, 0);
  const _fwd  = new THREE.Vector3();

  for (const road of roads) {
    if (!road.cycleway || !VALID_CYCLEWAY.has(road.cycleway)) continue;
    if (road.tunnel) continue;

    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const roadWidth = Math.max(4, Math.min(30, Number(road.width) || 6));
    const half = roadWidth / 2;
    const sign = (road.cycleway === 'opposite_lane' || road.cycleway === 'opposite_track') ? -1 : +1;
    const laneOffset = sign * (half - BIKE_W / 2);
    const heights = getRoadPointHeights(road, options);

    // Compute cumulative distances
    const cumDist = [0];
    for (let i = 1; i < pts.length; i++) {
      cumDist.push(cumDist[i - 1] + Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y));
    }
    const totalLen = cumDist[cumDist.length - 1];
    if (totalLen < SPACING) continue;

    let d = SPACING / 2;
    while (d < totalLen - SPACING * 0.3) {
      // Interpolate position + direction at distance d
      for (let i = 1; i < pts.length; i++) {
        if (cumDist[i] >= d) {
          const segLen = cumDist[i] - cumDist[i - 1];
          const t = segLen > 0 ? (d - cumDist[i - 1]) / segLen : 0;
          const ax = pts[i-1].x, az = pts[i-1].y;
          const bx = pts[i].x,   bz = pts[i].y;
          const px = ax + t * (bx - ax);
          const pz = az + t * (bz - az);
          const dx = bx - ax, dz = bz - az;
          const len = Math.hypot(dx, dz) || 1;
          const dxn = dx / len, dzn = dz / len;
          // Lateral offset to bike lane center
          const perpX = -dzn, perpZ = dxn;
          const wx = px + perpX * laneOffset;
          const wz = pz + perpZ * laneOffset;
          const hA = heights ? heights[i-1] : (ROAD_OFFSET + ROAD_VISUAL_ABOVE_TERRAIN);
          const hB = heights ? heights[i]   : (ROAD_OFFSET + ROAD_VISUAL_ABOVE_TERRAIN);
          const wy = (hA + t * (hB - hA)) + PICTO_Y;

          _pos.set(wx, wy, wz);
          _fwd.set(dxn, 0, dzn);
          _quat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), _fwd);
          _mat4.compose(_pos, _quat, _scl);
          matrices.push(_mat4.clone());
          break;
        }
      }
      d += SPACING;
    }
  }

  if (matrices.length === 0) return null;

  const instMesh = new THREE.InstancedMesh(
    getBikePictogramGeometry(),
    getBikePictogramMaterial(),
    matrices.length
  );
  instMesh.frustumCulled = false;
  for (let i = 0; i < matrices.length; i++) instMesh.setMatrixAt(i, matrices[i]);
  instMesh.instanceMatrix.needsUpdate = true;
  instMesh.userData = { type: 'bikepictogram', noMerge: true };
  return instMesh;
}

// ─── ZONA 30 speed stencils (Phase 4C-A) ──────────────────────────────────────

let _zona30Texture = null;
function getZona30Texture() {
  if (_zona30Texture) return _zona30Texture;
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 128, 128);
  ctx.fillStyle = '#f5f5f5';
  ctx.font = 'bold 72px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('30', 64, 64);
  _zona30Texture = new THREE.CanvasTexture(canvas);
  _zona30Texture.needsUpdate = true;
  return _zona30Texture;
}

let _zona30Material = null;
function getZona30Material() {
  if (_zona30Material) return _zona30Material;
  _zona30Material = applyGroundLayer(new THREE.MeshBasicMaterial({
    map: getZona30Texture(),
    transparent: true,
    alphaTest: 0.05,
    depthWrite: false,
    side: THREE.DoubleSide,
  }), 'stencil');
  return _zona30Material;
}

let _zona30Geom = null;
function getZona30Geometry() {
  if (_zona30Geom) return _zona30Geom;
  // 2m wide × 3m tall flat quad, lying in XZ plane
  _zona30Geom = new THREE.PlaneGeometry(2.0, 3.0).rotateX(-Math.PI / 2);
  return _zona30Geom;
}

const ZONA30_ELIGIBLE = new Set(['residential', 'unclassified', 'tertiary', 'living_street']);
const ZONA30_SPACING  = 100; // metres between stencils
const ZONA30_Y_ABOVE  = 0.04;

/**
 * "30" speed limit stencils painted on road surface for ZONA 30 roads.
 * One stencil every 100m on qualifying residential/tertiary streets.
 */
function buildZona30Stencils(roads, options) {
  if (!CONFIG.ENABLE_ZONA_30) return null;

  const matrices = [];
  const _m = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scl = new THREE.Vector3(1, 1, 1);
  const _up = new THREE.Vector3(0, 1, 0);
  const _fwd = new THREE.Vector3();

  for (const road of roads) {
    if (!ZONA30_ELIGIBLE.has(road.highwayType)) continue;
    if (road.maxspeed !== 30) continue;
    if (road.tunnel || road.bridge) continue;
    const pts = road.points;
    if (!pts || pts.length < 2) continue;

    const heights = getRoadPointHeights(road, options);
    let cumDist = 0;
    let nextPlace = ZONA30_SPACING / 2; // start at midpoint of first segment

    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      const dirX = (b.x - a.x) / (segLen || 1);
      const dirZ = (b.y - a.y) / (segLen || 1);

      while (cumDist + segLen >= nextPlace) {
        const t = (nextPlace - cumDist) / segLen;
        const px = a.x + dirX * t * segLen;
        const pz = a.y + dirZ * t * segLen;
        let py = ROAD_OFFSET + ROAD_VISUAL_ABOVE_TERRAIN + ZONA30_Y_ABOVE;
        if (heights) {
          const hA = heights[i] ?? py, hB = heights[i + 1] ?? py;
          py = hA + t * (hB - hA) + ZONA30_Y_ABOVE;
        }

        _pos.set(px, py, pz);
        _fwd.set(dirX, 0, dirZ).normalize();
        _quat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), _fwd);
        _m.compose(_pos, _quat, _scl);
        matrices.push(_m.clone());
        nextPlace += ZONA30_SPACING;
      }
      cumDist += segLen;
    }
  }

  if (!matrices.length) return null;
  const inst = new THREE.InstancedMesh(getZona30Geometry(), getZona30Material(), matrices.length);
  inst.frustumCulled = false;
  matrices.forEach((m, i) => inst.setMatrixAt(i, m));
  inst.instanceMatrix.needsUpdate = true;
  inst.userData = { type: 'zona30Stencil', noMerge: true };
  return inst;
}

// ─── Tactile paving dots at crosswalk curb edges (Phase 4C-A) ─────────────────

let _tactileTex = null;
function getTactileTexture() {
  if (_tactileTex) return _tactileTex;
  const W = 128, H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#d9c896'; // beige tactile tile
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#b8a870'; // darker dot
  const spacing = 16, r = 5;
  for (let x = spacing / 2; x < W; x += spacing) {
    for (let y = spacing / 2; y < H; y += spacing) {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
  }
  _tactileTex = new THREE.CanvasTexture(canvas);
  _tactileTex.wrapS = _tactileTex.wrapT = THREE.RepeatWrapping;
  _tactileTex.needsUpdate = true;
  return _tactileTex;
}

let _tactileMat = null;
function getTactileMaterial() {
  if (_tactileMat) return _tactileMat;
  _tactileMat = applyGroundLayer(new THREE.MeshLambertMaterial({
    map: getTactileTexture(),
  }), 'tactile');
  return _tactileMat;
}

const TACTILE_DEPTH   = 0.6;  // depth of the strip (perpendicular to crosswalk)
const TACTILE_Y_ABOVE = BCN_DIMS.CURB_HEIGHT + 0.005; // on top of panot sidewalk
const TACTILE_ELIGIBLE = new Set(['primary', 'secondary', 'tertiary', 'primary_link', 'secondary_link', 'tertiary_link', 'residential', 'unclassified', 'living_street']);

/**
 * Beige dotted tactile paving strip at the sidewalk edge before each crosswalk.
 */
function buildTactilePaving(roads, options) {
  if (!CONFIG.ENABLE_TACTILE_PAVING) return null;

  const junctionPoints = getJunctionPoints(roads, JUNCTION_TOLERANCE);
  if (!junctionPoints.length) return null;
  const junctionMap = new Map();
  for (const j of junctionPoints) junctionMap.set(hashPoint(j.x, j.z, JUNCTION_TOLERANCE), j);

  const geoms = [];

  for (const road of roads) {
    const type = road.highwayType || '';
    if (!TACTILE_ELIGIBLE.has(type)) continue;
    if (road.tunnel || road.bridge) continue;
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const roadWidth = Math.max(4, Math.min(30, Number(road.width) || 6));
    const half = roadWidth / 2;
    const heights = getRoadPointHeights(road, options);

    for (const endIdx of [0, pts.length - 1]) {
      const ep = pts[endIdx];
      const junction = junctionMap.get(hashPoint(ep.x, ep.y, JUNCTION_TOLERANCE));
      if (!junction) continue;

      const clipR = Math.max(junction.radius > 0 ? junction.radius : 0, INTERSECTION_RADIUS);
      const setback = clipR + 1.5; // matches crosswalk setback
      const short = pts.length - 1; let roadLen = 0;
      for (let i = 0; i < short; i++) roadLen += Math.hypot(pts[i+1].x-pts[i].x, pts[i+1].y-pts[i].y);
      if (setback * 2 > roadLen) continue;

      // Direction along road (away from junction)
      const innerIdx = endIdx === 0 ? 1 : pts.length - 2;
      const dx = pts[innerIdx].x - ep.x, dz = pts[innerIdx].y - ep.y;
      const len = Math.hypot(dx, dz) || 1;
      const dirX = dx / len, dirZ = dz / len;
      const perpX = -dirZ, perpZ = dirX;

      // Strip center: setback away from junction + small inward offset
      const cx = ep.x + dirX * setback;
      const cz = ep.y + dirZ * setback;

      // Sidewalk outer edge: half + curb + sw_width
      const swWidth = _swWidthForRoadWidth(roadWidth);
      const swOuter = half + BCN_DIMS.CURB_WIDTH + swWidth;

      const hIdx = endIdx === 0 ? 0 : pts.length - 1;
      let baseY = ROAD_OFFSET + ROAD_VISUAL_ABOVE_TERRAIN;
      if (heights && heights[hIdx] != null) baseY = heights[hIdx];
      const ty = baseY + TACTILE_Y_ABOVE;

      // Build one tactile strip on each side (left + right of road)
      for (const sign of [-1, 1]) {
        // Strip center in XZ
        const sx = cx + perpX * sign * (half + BCN_DIMS.CURB_WIDTH + swWidth / 2);
        const sz = cz + perpZ * sign * (half + BCN_DIMS.CURB_WIDTH + swWidth / 2);
        // Strip corners (swWidth wide, TACTILE_DEPTH deep)
        const hw = swWidth / 2;
        const hd = TACTILE_DEPTH / 2;
        // Along road direction: TACTILE_DEPTH; perpendicular: swWidth
        const positions = new Float32Array([
          sx - perpX*hw + dirX*hd, ty, sz - perpZ*hw + dirZ*hd,
          sx + perpX*hw + dirX*hd, ty, sz + perpZ*hw + dirZ*hd,
          sx - perpX*hw - dirX*hd, ty, sz - perpZ*hw - dirZ*hd,
          sx + perpX*hw - dirX*hd, ty, sz + perpZ*hw - dirZ*hd,
        ]);
        const uvs = new Float32Array([0,1, 1,1, 0,0, 1,0]);
        const idx = new Uint32Array([0,1,2, 1,3,2]);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        g.setIndex(new THREE.BufferAttribute(idx, 1));
        g.computeVertexNormals();
        geoms.push(g);
      }
    }
  }

  if (!geoms.length) return null;
  const merged = mergeGeometries(geoms);
  geoms.forEach(g => g.dispose());
  if (!merged) return null;
  const mesh = new THREE.Mesh(merged, getTactileMaterial());
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  mesh.userData = { sharedMaterial: true, type: 'tactilePaving' };
  return mesh;
}

// ─── No-parking / no-stopping yellow curb stripes (Phase 4A) ─────────────────

const NO_STOP_VALUES  = new Set(['no_stopping']);
const NO_PARK_VALUES  = new Set(['no_parking']);
const STRIPE_Y_ABOVE  = 0.04;   // above lane lines (0.03m), matches crosswalk height
const STRIPE_W        = BCN_DIMS.LINE_WIDTH_LONGITUDINAL; // 0.10m

let _noParkingMaterial = null;
function getNoParkingMaterial() {
  if (_noParkingMaterial) return _noParkingMaterial;
  _noParkingMaterial = applyGroundLayer(new THREE.MeshLambertMaterial({
    color: BCN_COLORS.PAINT_YELLOW,
  }), 'parkingZone');
  return _noParkingMaterial;
}

/**
 * Build yellow no-parking / no-stopping curb stripes from parking:lane:* OSM tags.
 * Continuous = no_stopping; dashed (2m/2m) = no_parking.
 * Stripe is at road edge (road_half_width - stripe_half_width from center).
 */
function buildNoParkingStripes(roads, options) {
  if (!CONFIG.ENABLE_NO_PARKING_STRIPES) return null;

  const VALID = new Set(['no_parking', 'no_stopping']);
  const geoms = [];

  for (const road of roads) {
    if (road.tunnel) continue;
    const left  = road.parkingLeft;
    const right = road.parkingRight;
    if (!left && !right) continue;

    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const roadWidth = Math.max(4, Math.min(30, Number(road.width) || 6));
    const half = roadWidth / 2;
    // Stripe center: just inside road edge (half - STRIPE_W/2)
    const stripeOffset = half - STRIPE_W / 2;

    const roadHeights = getRoadPointHeights(road, options);

    const sides = [
      { val: left,  sign: -1 },
      { val: right, sign: +1 },
    ];

    for (const { val, sign } of sides) {
      if (!val || !VALID.has(val)) continue;
      const offsetPts = getOffsetPolyline(pts, sign * stripeOffset);
      const stripeHeights = roadHeights
        ? roadHeights.map(h => h + STRIPE_Y_ABOVE)
        : (ROAD_OFFSET + ROAD_VISUAL_ABOVE_TERRAIN + STRIPE_Y_ABOVE);

      if (NO_STOP_VALUES.has(val)) {
        // Continuous stripe
        const g = buildFlatRibbonGeometry(offsetPts, STRIPE_W, stripeHeights);
        if (g) geoms.push(g);
      } else {
        // Dashed stripe: 2m dash / 2m gap
        const subs = extractDashSubPolylines(
          offsetPts,
          BCN_DIMS.DASH_LENGTH_URBAN,
          BCN_DIMS.DASH_GAP_URBAN,
          roadHeights  // source heights (extractDash preserves them; we add offset after)
        );
        for (const sub of subs) {
          const h = sub.heights
            ? sub.heights.map(v => v + STRIPE_Y_ABOVE)
            : (ROAD_OFFSET + ROAD_VISUAL_ABOVE_TERRAIN + STRIPE_Y_ABOVE);
          const g = buildFlatRibbonGeometry(sub.points, STRIPE_W, h);
          if (g) geoms.push(g);
        }
      }
    }
  }

  if (!geoms.length) return null;
  try {
    const merged = mergeGeometries(geoms);
    geoms.forEach(g => g.dispose());
    if (!merged) return null;
    merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, getNoParkingMaterial());
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = true;
    mesh.userData = { sharedMaterial: true, type: 'noparking' };
    return mesh;
  } catch { geoms.forEach(g => g.dispose()); return null; }
}

// ─── Blue regulated parking stripes (Phase 4C-B: Zona Blava) ─────────────────

let _blueZoneMaterial = null;
function getBlueZoneMaterial() {
  if (_blueZoneMaterial) return _blueZoneMaterial;
  _blueZoneMaterial = applyGroundLayer(new THREE.MeshLambertMaterial({
    color: _decalNight ? 0x3a6ea8 : BCN_COLORS.PAINT_BLUE,   // night lift — see setRoadDecalNightMode
  }), 'parkingZone');
  return _blueZoneMaterial;
}

/**
 * Continuous blue stripe along curb where parking is paid (Zona Blava).
 * Triggered by parkingPaidLeft/Right === 'paid'. Placed at same position as yellow stripes.
 */
function buildBlueZoneStripes(roads, options) {
  if (!CONFIG.ENABLE_BLUE_PARKING_ZONES) return null;
  const geoms = [];
  for (const road of roads) {
    if (road.tunnel) continue;
    const left  = road.parkingPaidLeft;
    const right = road.parkingPaidRight;
    if (left !== 'paid' && right !== 'paid') continue;
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const roadWidth = Math.max(4, Math.min(30, Number(road.width) || 6));
    const half = roadWidth / 2;
    const stripeOffset = half - STRIPE_W / 2;
    const roadHeights = getRoadPointHeights(road, options);
    for (const { val, sign } of [{ val: left, sign: -1 }, { val: right, sign: +1 }]) {
      if (val !== 'paid') continue;
      const offsetPts = getOffsetPolyline(pts, sign * stripeOffset);
      const h = roadHeights
        ? roadHeights.map(y => y + STRIPE_Y_ABOVE)
        : (ROAD_OFFSET + ROAD_VISUAL_ABOVE_TERRAIN + STRIPE_Y_ABOVE);
      const g = buildFlatRibbonGeometry(offsetPts, STRIPE_W, h);
      if (g) geoms.push(g);
    }
  }
  if (!geoms.length) return null;
  try {
    const merged = mergeGeometries(geoms);
    geoms.forEach(g => g.dispose());
    if (!merged) return null;
    merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, getBlueZoneMaterial());
    mesh.castShadow = false; mesh.receiveShadow = false; mesh.frustumCulled = true;
    mesh.userData = { sharedMaterial: true, type: 'bluezone' };
    return mesh;
  } catch { geoms.forEach(g => g.dispose()); return null; }
}

/** Build sidewalk + edge strip geometries for eligible roads; merge and return meshes. */
function buildSidewalkAndEdgeMeshes(roads, options) {
  if (!CONFIG.ENABLE_SIDEWALKS && !CONFIG.ENABLE_ROAD_EDGE_DETAIL) return { sidewalkMesh: null, edgeStripMesh: null };
  const sidewalkGeoms = [];
  const edgeStripGeoms = [];
  const junctionPoints = getJunctionPoints(roads, JUNCTION_TOLERANCE);
  const getElevationAt = options?.getElevationAt;

  for (const road of roads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const type = road.highwayType || '';
    const roadWidth = Math.max(4, Math.min(30, Number(road.width) || 6));
    const half = roadWidth / 2;
    const roadHeights = getRoadPointHeights(road, options);

    const sidewalkWidth = getSidewalkWidthForRoad(type);
    const roadLayer = road.layer != null && Number.isFinite(road.layer) ? road.layer : 0;
    const sidewalkBaseOffset = roadLayer * LAYER_HEIGHT_STEP + SIDEWALK_OFFSET;
    if (false && CONFIG.ENABLE_SIDEWALKS && sidewalkWidth > 0) { // superseded by buildSidewalks() Phase 3
      // offsetDistance = (roadWidth/2) + (sidewalkWidth/2): centerline at road edge + half sidewalk width so mesh sits fully outside road
      const offsetFromCenter = half + sidewalkWidth / 2;
      const leftSidewalk = getOffsetPolyline(pts, -offsetFromCenter);
      const rightSidewalk = getOffsetPolyline(pts, offsetFromCenter);
      const getJunctionRadius = (j) => (j.radius != null ? j.radius : INTERSECTION_RADIUS);
      const leftRuns = junctionPoints.length > 0
        ? clipPolylineNearJunctions(leftSidewalk, junctionPoints, getJunctionRadius)
        : [leftSidewalk];
      const rightRuns = junctionPoints.length > 0
        ? clipPolylineNearJunctions(rightSidewalk, junctionPoints, getJunctionRadius)
        : [rightSidewalk];
      for (const run of leftRuns) {
        const heights = getElevationAt ? run.map((p) => { const { lat, lon } = worldToLatLon(p.x, p.y); return (getElevationAt(lat, lon) ?? 0) + sidewalkBaseOffset; }) : sidewalkBaseOffset;
        const g = buildFlatRibbonGeometry(run, sidewalkWidth, heights);
        if (g) sidewalkGeoms.push(g);
      }
      for (const run of rightRuns) {
        const heights = getElevationAt ? run.map((p) => { const { lat, lon } = worldToLatLon(p.x, p.y); return (getElevationAt(lat, lon) ?? 0) + sidewalkBaseOffset; }) : sidewalkBaseOffset;
        const g = buildFlatRibbonGeometry(run, sidewalkWidth, heights);
        if (g) sidewalkGeoms.push(g);
      }
    }

    if (CONFIG.ENABLE_ROAD_EDGE_DETAIL
        // NO edge strips on motorways/trunks (user call 2026-07-11): the dark bands flanking the
        // Ronda Litoral carriageways read as broad black lines, not kerb detail. Highways keep
        // clean asphalt edges; city streets keep the strip.
        && type !== 'motorway' && type !== 'motorway_link' && type !== 'trunk' && type !== 'trunk_link') {
      const leftEdge = getOffsetPolyline(pts, -half);
      const rightEdge = getOffsetPolyline(pts, half);
      const yLeft = roadHeights || EDGE_STRIP_Y_OFFSET;
      const yRight = roadHeights || EDGE_STRIP_Y_OFFSET;
      const e1 = buildFlatRibbonGeometry(leftEdge, EDGE_STRIP_WIDTH, yLeft);
      const e2 = buildFlatRibbonGeometry(rightEdge, EDGE_STRIP_WIDTH, yRight);
      if (e1) edgeStripGeoms.push(e1);
      if (e2) edgeStripGeoms.push(e2);
    }
  }

  // Merge sidewalk + edge strip into one mesh using vertex colors
  const out = { sidewalkMesh: null, edgeStripMesh: null };
  const sidewalkColor = new THREE.Color(0xb8bab5);
  const edgeColor = new THREE.Color(0x6e7580);
  const allPedestrianGeoms = [];

  if (sidewalkGeoms.length > 0) {
    const merged = mergeGeometries(sidewalkGeoms);
    sidewalkGeoms.forEach((g) => g.dispose());
    if (merged) {
      if (!merged.attributes.uv) console.warn('[UV] Sidewalk merged geometry missing uv attribute');
      clampSidewalkVerticesOutsideRoads(roads, merged.attributes.position);
      merged.attributes.position.needsUpdate = true;
      merged.computeVertexNormals();
      // Bake sidewalk color
      const count = merged.attributes.position.count;
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) { colors[i*3] = sidewalkColor.r; colors[i*3+1] = sidewalkColor.g; colors[i*3+2] = sidewalkColor.b; }
      merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      allPedestrianGeoms.push(merged);
    }
  }
  if (edgeStripGeoms.length > 0) {
    const merged = mergeGeometries(edgeStripGeoms);
    edgeStripGeoms.forEach((g) => g.dispose());
    if (merged) {
      // Bake edge strip color
      const count = merged.attributes.position.count;
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) { colors[i*3] = edgeColor.r; colors[i*3+1] = edgeColor.g; colors[i*3+2] = edgeColor.b; }
      merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      allPedestrianGeoms.push(merged);
    }
  }

  if (allPedestrianGeoms.length > 0) {
    // Ensure compatible attributes — add missing 'uv' or 'normal' to make mergeGeometries work
    const hasUV = allPedestrianGeoms.some(g => g.attributes.uv);
    const hasNormal = allPedestrianGeoms.some(g => g.attributes.normal);
    for (const g of allPedestrianGeoms) {
      if (hasUV && !g.attributes.uv) {
        g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      }
      if (hasNormal && !g.attributes.normal) {
        g.computeVertexNormals();
      }
    }
    const finalMerge = allPedestrianGeoms.length === 1 ? allPedestrianGeoms[0] : mergeGeometries(allPedestrianGeoms);
    if (allPedestrianGeoms.length > 1) allPedestrianGeoms.forEach(g => g.dispose());
    if (finalMerge) {
      if (!_mergedPedestrianMaterial) {
        _mergedPedestrianMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
      }
      out.sidewalkMesh = new THREE.Mesh(finalMerge, _mergedPedestrianMaterial);
      out.sidewalkMesh.castShadow = false;
      out.sidewalkMesh.receiveShadow = false;
      out.sidewalkMesh.frustumCulled = false;
      out.sidewalkMesh.userData.sharedMaterial = true;
    }
  }
  return out;
}

let sharedPillarMaterial = null;
function getPillarMaterial() {
  if (sharedPillarMaterial) return sharedPillarMaterial;
  sharedPillarMaterial = new THREE.MeshLambertMaterial({
    color: 0x7a7570,
    flatShading: false,
    // Safety net: pillars are the only LIT element in the bridge-dressing set. A pillar
    // sunk in a shadowed trench gets almost no incident light and renders near-black
    // (the "giant black mass" bug). A dim emissive floor guarantees it never goes fully
    // dark even when occluded, while still reading as a 3D shaded cylinder in the open.
    emissive: 0x35322f,
    emissiveIntensity: 1.0,
  });
  return sharedPillarMaterial;
}

/**
 * Check if position (x, z) is on a ground-level road surface.
 * Uses a flat array of ground road segments: [ax, az, bx, bz, halfWidth, ...]
 */
function isOnGroundRoad(x, z, groundRoadSegs) {
  for (let k = 0; k < groundRoadSegs.length; k += 5) {
    const ax = groundRoadSegs[k], az = groundRoadSegs[k + 1];
    const bx = groundRoadSegs[k + 2], bz = groundRoadSegs[k + 3];
    const hw = groundRoadSegs[k + 4];
    const dx = bx - ax, dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    if (lenSq < 1e-12) continue;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lenSq));
    const nx = ax + t * dx - x, nz = az + t * dz - z;
    if (nx * nx + nz * nz < hw * hw) return true;
  }
  return false;
}

/** Build flat array of ground-level (layer 0, non-bridge) road segments for collision check. */
function buildGroundRoadSegments(roads) {
  const segs = [];
  for (const road of roads || []) {
    if (road.bridge || road.tunnel) continue;
    const layer = (road.layer != null && Number.isFinite(road.layer)) ? road.layer : 0;
    if (layer !== 0) continue;
    const pts = road.points || [];
    const hw = ((WIDTH_BY_TYPE[road.highwayType] ?? 6) / 2) + 1; // half-width + margin
    for (let i = 0; i < pts.length - 1; i++) {
      segs.push(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, hw);
    }
  }
  return segs;
}

// Trench corridor footprint: roadHalf + this margin. Must cover the carved trench
// (trenchAuthor TRENCH_MARGIN 4m + BATTER_WIDTH 8m) so a bridge spanning a daylighted
// corridor never drops pillars into the open trench/roadway below it.
const TRENCH_PILLAR_SKIP_MARGIN = 12;

/** Build flat array of trench-corridor segments (carved tunnel roads) for pillar exclusion. */
function buildTrenchCorridorSegments(roads) {
  const segs = [];
  for (const road of roads || []) {
    if (!road.tunnel) continue;
    const pts = road.points || [];
    const hw = ((WIDTH_BY_TYPE[road.highwayType] ?? 6) / 2) + TRENCH_PILLAR_SKIP_MARGIN;
    for (let i = 0; i < pts.length - 1; i++) {
      segs.push(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, hw);
    }
  }
  return segs;
}

/**
 * Build bridge pillar meshes for roads with bridge=yes.
 * Pillars every PILLAR_SPACING m along road, cylinder from ground/SEA_LEVEL to bridge deck.
 * Skips pillar placement where it would intersect a ground-level road or a trench corridor.
 */
function buildBridgePillarMeshes(roads, options) {
  const getElevationAt = options?.getElevationAt || (() => 0);

  // Pre-compute ground road segments to avoid placing pillars on roads
  const groundRoadSegs = buildGroundRoadSegments(roads);
  // Trench corridors: a bridge over a daylighted trench must not plant pillars in it
  // (the slice-② carve sank the heightfield there, so getElevationAt returns the deep
  // trench floor → 10-15m columns standing in the open roadway = the black-mass bug).
  const trenchSegs = buildTrenchCorridorSegments(roads);

  const pillarGeoms = [];
  const pillarPositions = [];  // { x, z, groundY, height }
  for (const road of roads || []) {
    if (!road.bridge || !road.points?.length) continue;
    const roadHeights = getRoadPointHeights(road, options);
    if (!roadHeights) continue;

    const pts = road.points;
    let totalDist = 0;
    let nextPillarAt = PILLAR_SPACING;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dz = b.y - a.y;
      const segLen = Math.hypot(dx, dz);
      if (segLen < 1e-6) continue;

      while (nextPillarAt <= totalDist + segLen) {
        const local = nextPillarAt - totalDist;
        const t = local / segLen;
        const x = a.x + t * dx;
        const z = a.y + t * dz;

        // Skip if pillar would land on a ground-level road
        if (groundRoadSegs.length > 0 && isOnGroundRoad(x, z, groundRoadSegs)) {
          nextPillarAt += PILLAR_SPACING;
          continue;
        }

        // Skip if pillar would stand inside a carved trench corridor (Option L)
        if (trenchSegs.length > 0 && isOnGroundRoad(x, z, trenchSegs)) {
          nextPillarAt += PILLAR_SPACING;
          continue;
        }

        const bridgeY = (1 - t) * roadHeights[i] + t * roadHeights[i + 1];
        const { lat, lon } = worldToLatLon(x, z);
        const groundY = getPillarBottomY(lat, lon, getElevationAt);
        const height = bridgeY - groundY;
        if (height >= MIN_BRIDGE_STRUCTURE_HEIGHT) {
          const geom = new THREE.CylinderGeometry(PILLAR_RADIUS, PILLAR_RADIUS, height, 8);
          geom.translate(x, (groundY + bridgeY) / 2, z);
          pillarGeoms.push(geom);
          pillarPositions.push({ x, z, groundY, height });
        }
        nextPillarAt += PILLAR_SPACING;
      }
      totalDist += segLen;
    }
  }

  if (pillarGeoms.length === 0) return { mesh: null, positions: [] };
  const merged = mergeGeometries(pillarGeoms);
  pillarGeoms.forEach((g) => g.dispose());
  if (!merged) return { mesh: null, positions: [] };

  const mesh = new THREE.Mesh(merged, getPillarMaterial());
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  mesh.userData.type = 'bridgePillar';
  return { mesh, positions: pillarPositions };
}

let sharedSlabMaterial = null;
function getSlabMaterial() {
  if (sharedSlabMaterial) return sharedSlabMaterial;
  // MeshBasicMaterial: unlit, always same color from any angle — guarantees the underside
  // is visible when looking up, matching the guard rail colour.
  sharedSlabMaterial = new THREE.MeshBasicMaterial({ color: 0x706b66, side: THREE.DoubleSide });
  return sharedSlabMaterial;
}

let sharedGuardRailMaterial = null;
function getGuardRailMaterial() {
  if (sharedGuardRailMaterial) return sharedGuardRailMaterial;
  sharedGuardRailMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, vertexColors: true });
  return sharedGuardRailMaterial;
}

let sharedRailingMaterial = null;
function getRailingMaterial() {
  if (sharedRailingMaterial) return sharedRailingMaterial;
  sharedRailingMaterial = new THREE.MeshBasicMaterial({ color: 0x707070, side: THREE.DoubleSide }); // galvanized grey steel (Barcelona motorway standard)
  return sharedRailingMaterial;
}

/**
 * Dim/restore guard rail, railing and slab colours for night mode.
 * All use MeshBasicMaterial (unlit), so they must be darkened manually.
 */
export function setRoadMarkingNightMode(isNight) {
  // Lane lines + zebra crosswalks use an UNLIT MeshBasicMaterial, so they don't darken with the scene at
  // night → they glared bright white. Dim the shared colour by hand: moonlit worn paint, not glowing.
  _markingNight = isNight; // persist so crosswalks/lines built later also come up dimmed
  if (_mergedMarkingMaterial) _mergedMarkingMaterial.color.set(isNight ? MARK_NIGHT : MARK_DAY);
}

export function setGuardRailNightMode(isNight) {
  // MeshBasicMaterial ignores scene lighting — colors must look right on their own.
  // Night: cool blue-gray moonlit concrete; avoid any warm/beige tint.
  if (sharedGuardRailMaterial) sharedGuardRailMaterial.color.set(isNight ? 0x586068 : 0xffffff);
  if (sharedRailingMaterial)   sharedRailingMaterial.color.set(isNight ? 0x404040 : 0x707070);
  if (sharedSlabMaterial)      sharedSlabMaterial.color.set(isNight ? 0x404448 : 0x706b66);
}

// ── Billboard night glow ──────────────────────────────────────────────────────
const _billboardFrontMats = [];

/** Register a billboard front material for night-mode toggling. */
export function registerBillboardMat(mat) {
  _billboardFrontMats.push(mat);
}

/** Toggle soft emissive glow on bridge billboards at night. */
export function setBillboardNightMode(isNight) {
  for (const mat of _billboardFrontMats) {
    if (isNight) {
      mat.emissive.setHex(0xffffff);
      mat.emissiveIntensity = 0.35;
    } else {
      mat.emissive.setHex(0x000000);
      mat.emissiveIntensity = 0;
    }
  }
}

/**
 * Compute left and right edge vertex arrays for a road ribbon. Uses averaged tangent perpendicular
 * at each vertex (simpler than full miter, suitable for slab/guardrail geometry).
 * @returns {{ leftEdge: {x,y,z}[], rightEdge: {x,y,z}[] } | null}
 */
function getRibbonEdgeVerts(points, roadWidth, heights) {
  if (!points || points.length < 2) return null;
  const n = points.length;
  const isYArray = Array.isArray(heights);
  const getY = (i) => (isYArray ? (heights[i] != null ? heights[i] : 0) : (heights ?? 0));
  const half = (typeof roadWidth === 'number' ? roadWidth : 6) / 2;

  const leftEdge = [];
  const rightEdge = [];

  for (let i = 0; i < n; i++) {
    const p = points[i];
    const x = p.x, z = p.y;
    const y = getY(i) + ROAD_ZFIGHT_OFFSET;

    let dx, dz;
    if (i === 0) {
      dx = points[1].x - x; dz = points[1].y - z;
    } else if (i === n - 1) {
      dx = x - points[n - 2].x; dz = z - points[n - 2].y;
    } else {
      dx = points[i + 1].x - points[i - 1].x; dz = points[i + 1].y - points[i - 1].y;
    }
    const len = Math.hypot(dx, dz);
    let nx, nz;
    if (len < 1e-10) {
      // degenerate: repeat previous or use default
      if (leftEdge.length > 0) {
        leftEdge.push({ x: leftEdge[leftEdge.length - 1].x, y, z: leftEdge[leftEdge.length - 1].z });
        rightEdge.push({ x: rightEdge[rightEdge.length - 1].x, y, z: rightEdge[rightEdge.length - 1].z });
      } else {
        leftEdge.push({ x, y, z }); rightEdge.push({ x, y, z });
      }
      continue;
    }
    nx = -dz / len; nz = dx / len;
    leftEdge.push({ x: x - nx * half, y, z: z - nz * half });
    rightEdge.push({ x: x + nx * half, y, z: z + nz * half });
  }

  return leftEdge.length >= 2 ? { leftEdge, rightEdge } : null;
}

/**
 * Build slab (side faces + bottom face) for bridge and elevated roads to give them visible thickness.
 * Adds left side wall, right side wall, and bottom ribbon at Y − SLAB_THICKNESS.
 * @returns {THREE.Mesh|null}
 */
function buildBridgeSlabGeometry(roads, options) {
  const slabGeoms = [];

  for (const road of roads || []) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;

    const heights = getRoadPointHeights(road, options);
    const hVals = heights || [];
    // Structural test ONLY — terrain-inclusive height/slope must never flag a surface road
    // as elevated (that was the spurious-canopy bug). Real bridges/ramps carry these flags.
    const isElevated = road.bridge
      || (road.layer != null && road.layer > 0)
      || road.isRamp
      || road.crossesTrench === true; // Option L: streets bridging daylighted tunnel corridors get full bridge dressing
    if (!isElevated) continue;

    // Above-terrain height drives the slab taper (real height above ground, not terrain elevation).
    const atVals = getAboveTerrainHeights(road, options, heights) || hVals;
    const atMax  = atVals.length ? Math.max(...atVals) : 0;

    const roadWidth = Number.isFinite(Number(road.width))
      ? Math.max(3, Math.min(30, Number(road.width)))
      : (WIDTH_BY_TYPE[road.highwayType] ?? 6);
    const edges = getRibbonEdgeVerts(pts, roadWidth, heights);
    if (!edges) continue;

    const { leftEdge, rightEdge } = edges;
    const n = leftEdge.length;
    if (n < 2) continue;

    // Left and right side faces — taper slab thickness at ends and near ground
    const SLAB_TAPER = Math.min(5, Math.floor(n / 3));
    for (const edge of [leftEdge, rightEdge]) {
      const pos = new Float32Array(n * 6);
      const uvs = new Float32Array(n * 4);
      const idx = [];
      for (let i = 0; i < n; i++) {
        const e = edge[i];
        // End taper (smooth transition at bridge start/end)
        let taper = 1;
        if (SLAB_TAPER > 0) {
          if (i < SLAB_TAPER) taper = i / SLAB_TAPER;
          else if (i >= n - SLAB_TAPER) taper = (n - 1 - i) / SLAB_TAPER;
          taper = taper * taper * (3 - 2 * taper); // smoothstep
        }
        // Height taper: fade out slab when road deck is close to LOCAL terrain (above-terrain rise)
        const h = atVals[i] ?? atMax;
        if (h < MIN_BRIDGE_STRUCTURE_HEIGHT) {
          taper *= Math.max(0, h / MIN_BRIDGE_STRUCTURE_HEIGHT);
        }
        const depth = SLAB_THICKNESS * taper;
        pos[i * 6 + 0] = e.x; pos[i * 6 + 1] = e.y;           pos[i * 6 + 2] = e.z;
        pos[i * 6 + 3] = e.x; pos[i * 6 + 4] = e.y - depth;   pos[i * 6 + 5] = e.z;
        const u = i / Math.max(1, n - 1);
        uvs[i * 4 + 0] = u; uvs[i * 4 + 1] = 1;
        uvs[i * 4 + 2] = u; uvs[i * 4 + 3] = 0;
      }
      for (let i = 0; i < n - 1; i++) {
        const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
        idx.push(a, b, d, a, d, c);
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geom.setIndex(idx);
      geom.computeVertexNormals();
      slabGeoms.push(geom);
    }

    // Bottom face (flat ribbon at deck height − SLAB_THICKNESS), tapered near ground
    const bottomHeights = heights
      ? heights.map((hy, i) => {
          const at = atVals[i] ?? atMax;
          const t = at < MIN_BRIDGE_STRUCTURE_HEIGHT ? Math.max(0, at / MIN_BRIDGE_STRUCTURE_HEIGHT) : 1;
          return hy - SLAB_THICKNESS * t;
        })
      : ROAD_OFFSET - SLAB_THICKNESS;
    const bottomGeom = buildFlatRibbonGeometry(pts, roadWidth, bottomHeights);
    if (bottomGeom) {
      // Remove halfWidth attribute — slab geoms don't have it, and mergeGeometries requires consistency
      if (bottomGeom.attributes.halfWidth) bottomGeom.deleteAttribute('halfWidth');
      slabGeoms.push(bottomGeom);
    }
  }

  if (slabGeoms.length === 0) return null;
  const merged = mergeGeometries(slabGeoms);
  slabGeoms.forEach((g) => g.dispose());
  if (!merged) return null;

  const mesh = new THREE.Mesh(merged, getSlabMaterial());
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  mesh.userData.type = 'bridgeSlab';
  return mesh;
}

// ---------------------------------------------------------------------------
// Junction detection — find where ramp/link endpoints meet other roads
// ---------------------------------------------------------------------------
const JUNCTION_SNAP_DIST = 8.0; // metres — endpoints within this distance count as junction
const JUNCTION_SKIP_DIST = 15;  // skip geometry within this many metres of junction end

/**
 * For each road, determine how many vertices to skip at the start and end
 * because they are at a junction with another road.
 * Returns a Map<roadIndex, { skipStart: number, skipEnd: number }>.
 */
function computeJunctionSkips(roads) {
  const skips = new Map();
  if (!roads || roads.length === 0) return skips;

  // Collect all road endpoints for fast matching
  // endpoints[i] = { sx, sz, ex, ez, layer, isBridge, halfW }
  const info = [];
  for (let ri = 0; ri < roads.length; ri++) {
    const road = roads[ri];
    const pts = road.points;
    if (!pts || pts.length < 2) { info.push(null); continue; }
    const w = Number.isFinite(Number(road.width))
      ? Math.max(3, Math.min(30, Number(road.width)))
      : (WIDTH_BY_TYPE[road.highwayType] ?? 6);
    const layer = (road.layer != null && Number.isFinite(road.layer)) ? road.layer : 0;
    info.push({
      sx: pts[0].x, sz: pts[0].y,
      ex: pts[pts.length - 1].x, ez: pts[pts.length - 1].y,
      layer, isBridge: !!road.bridge, halfW: w / 2,
    });
  }

  for (let ri = 0; ri < roads.length; ri++) {
    const a = info[ri];
    if (!a) continue;
    const road = roads[ri];
    const pts = road.points;

    let skipStart = 0, skipEnd = 0;

    for (let oi = 0; oi < roads.length; oi++) {
      if (oi === ri) continue;
      const b = info[oi];
      if (!b) continue;
      // Don't match bridge vs ground road below
      if (a.isBridge && !b.isBridge && b.layer === 0 && a.layer > 0) continue;
      if (b.isBridge && !a.isBridge && a.layer === 0 && b.layer > 0) continue;

      const snapDist = JUNCTION_SNAP_DIST + b.halfW;

      // Method 1: endpoint-to-endpoint matching (shared nodes)
      if (!skipStart) {
        const d1 = Math.hypot(a.sx - b.sx, a.sz - b.sz);
        const d2 = Math.hypot(a.sx - b.ex, a.sz - b.ez);
        if (d1 < snapDist || d2 < snapDist) skipStart = JUNCTION_SKIP_DIST;
      }
      if (!skipEnd) {
        const d1 = Math.hypot(a.ex - b.sx, a.ez - b.sz);
        const d2 = Math.hypot(a.ex - b.ex, a.ez - b.ez);
        if (d1 < snapDist || d2 < snapDist) skipEnd = JUNCTION_SKIP_DIST;
      }

      // Method 2: endpoint-to-polyline (ramp merging mid-segment)
      if (!skipStart || !skipEnd) {
        const oPts = roads[oi].points;
        for (let j = 0; j < oPts.length - 1; j++) {
          const ax2 = oPts[j].x, az2 = oPts[j].y;
          const bx2 = oPts[j + 1].x, bz2 = oPts[j + 1].y;
          if (!skipStart) {
            const d = pointToSegmentDist(a.sx, a.sz, ax2, az2, bx2, bz2);
            if (d < snapDist) skipStart = JUNCTION_SKIP_DIST;
          }
          if (!skipEnd) {
            const d = pointToSegmentDist(a.ex, a.ez, ax2, az2, bx2, bz2);
            if (d < snapDist) skipEnd = JUNCTION_SKIP_DIST;
          }
          if (skipStart && skipEnd) break;
        }
      }
      if (skipStart && skipEnd) break;
    }

    if (skipStart || skipEnd) {
      // Cap total skip to 40% of road length so short ramps keep guard rails in the middle
      const pts2 = roads[ri].points;
      let roadLen = 0;
      for (let k = 1; k < pts2.length; k++) {
        roadLen += Math.hypot(pts2[k].x - pts2[k-1].x, pts2[k].y - pts2[k-1].y);
      }
      const maxSkip = roadLen * 0.4;
      if (skipStart > maxSkip) skipStart = maxSkip;
      if (skipEnd > maxSkip) skipEnd = maxSkip;
      // If both skips together would consume the whole road, shrink proportionally
      if (skipStart + skipEnd > roadLen * 0.8) {
        const scale = (roadLen * 0.8) / (skipStart + skipEnd);
        skipStart *= scale;
        skipEnd *= scale;
      }
      skips.set(ri, { skipStart, skipEnd });
    }
  }
  return skips;
}

/** Distance from point (px,pz) to line segment (ax,az)-(bx,bz). */
function pointToSegmentDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-10) return Math.hypot(px - ax, pz - az);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/**
 * Detect which side of a bridge road is adjacent to another parallel bridge (same layer).
 * Returns Map<roadIndex, { skipLeft: boolean, skipRight: boolean }>.
 */
function detectSharedBridgeEdges(roads) {
  const result = new Map();
  const bridgeInfos = [];
  for (let ri = 0; ri < (roads || []).length; ri++) {
    const road = roads[ri];
    if (!road.bridge || !road.points || road.points.length < 2) continue;
    const roadWidth = Number.isFinite(Number(road.width))
      ? Math.max(3, Math.min(30, Number(road.width)))
      : (WIDTH_BY_TYPE[road.highwayType] ?? 6);
    const layer = road.layer ?? 1;
    const pts = road.points;
    // Sample 3 points along centerline with normals
    let totalLen = 0;
    for (let i = 1; i < pts.length; i++) totalLen += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
    const samples = [];
    for (let si = 1; si <= 3; si++) {
      const target = (si / 4) * totalLen;
      let cum = 0;
      for (let i = 1; i < pts.length; i++) {
        const segLen = Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
        if (cum + segLen >= target) {
          const t = segLen > 1e-6 ? (target - cum) / segLen : 0;
          const sx = pts[i-1].x + t * (pts[i].x - pts[i-1].x);
          const sz = pts[i-1].y + t * (pts[i].y - pts[i-1].y);
          const dx = pts[i].x - pts[i-1].x, dz = pts[i].y - pts[i-1].y;
          const len = Math.hypot(dx, dz) || 1;
          samples.push({ sx, sz, nx: -dz / len, nz: dx / len });
          break;
        }
        cum += segLen;
      }
    }
    bridgeInfos.push({ ri, road, roadWidth, layer, samples });
  }
  if (bridgeInfos.length < 2) return result;

  // Check all pairs at same layer
  for (let a = 0; a < bridgeInfos.length; a++) {
    for (let b = a + 1; b < bridgeInfos.length; b++) {
      const ia = bridgeInfos[a], ib = bridgeInfos[b];
      if (ia.layer !== ib.layer) continue;
      const threshold = (ia.roadWidth / 2 + ib.roadWidth / 2) * 2.0;

      // Check which side of A road B lies on
      const checkSide = (src, tgt) => {
        let leftC = 0, rightC = 0;
        const tPts = tgt.road.points;
        for (const s of src.samples) {
          let minD = Infinity, cx = 0, cz = 0;
          for (let i = 1; i < tPts.length; i++) {
            const ax = tPts[i-1].x, az = tPts[i-1].y, bx = tPts[i].x, bz = tPts[i].y;
            const edx = bx - ax, edz = bz - az, lenSq = edx * edx + edz * edz;
            const t = lenSq > 1e-10 ? Math.max(0, Math.min(1, ((s.sx - ax) * edx + (s.sz - az) * edz) / lenSq)) : 0;
            const px = ax + t * edx, pz = az + t * edz;
            const d = Math.hypot(s.sx - px, s.sz - pz);
            if (d < minD) { minD = d; cx = px; cz = pz; }
          }
          if (minD > threshold) continue;
          const dot = (cx - s.sx) * s.nx + (cz - s.sz) * s.nz;
          if (dot > 0) rightC++; else leftC++;
        }
        return { leftC, rightC };
      };

      const sideA = checkSide(ia, ib);
      if (sideA.rightC >= 2) {
        if (!result.has(ia.ri)) result.set(ia.ri, { skipLeft: false, skipRight: false });
        result.get(ia.ri).skipRight = true;
      } else if (sideA.leftC >= 2) {
        if (!result.has(ia.ri)) result.set(ia.ri, { skipLeft: false, skipRight: false });
        result.get(ia.ri).skipLeft = true;
      }
      const sideB = checkSide(ib, ia);
      if (sideB.rightC >= 2) {
        if (!result.has(ib.ri)) result.set(ib.ri, { skipLeft: false, skipRight: false });
        result.get(ib.ri).skipRight = true;
      } else if (sideB.leftC >= 2) {
        if (!result.has(ib.ri)) result.set(ib.ri, { skipLeft: false, skipRight: false });
        result.get(ib.ri).skipLeft = true;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Smart guard-rail placement — shared suppression mask
// ---------------------------------------------------------------------------
// Previously every elevated road extruded guard rails along its FULL length on
// BOTH edges with no awareness of its neighbours, so at interchanges/roundabouts
// dozens of rails piled into each other. computeGuardRailMask runs ONE pass over
// the roads and decides, per centerline point per side, whether a rail belongs
// there. Both the visual geometry and the physics colliders consume this same
// mask (keyed by road object), so they can never drift apart. Suppression rules:
//   1. Endpoint margin  — no rail within END_MARGIN (arc) of a road's own ends
//                         (in OSM-split data, a road's ends ARE junctions).
//   2. Junction nodes   — no rail near any node where ≥2 roads meet (T/merge).
//   3. Roundabouts      — no rail near a roundabout center (the ring is skipped).
//   4. Parallel dedup   — where two elevated edges run within DEDUP_DIST, keep
//                         only the earlier road's edge (kills double median walls).
const GUARD_RAIL_END_MARGIN = 7;       // m — clear of a road's own endpoints
const GUARD_RAIL_JUNCTION_PAD = 3;     // m — beyond a junction node's radius
const GUARD_RAIL_ROUNDABOUT_PROX = 22; // m — beyond a roundabout's outer radius
const GUARD_RAIL_DEDUP_DIST = 1.6;     // m — coincident-edge merge distance

function guardRailWidth(road) {
  return Number.isFinite(Number(road.width))
    ? Math.max(3, Math.min(30, Number(road.width)))
    : (WIDTH_BY_TYPE[road.highwayType] ?? 6);
}

/**
 * The single authoritative "should this road carry guard rails?" gate. Structural
 * flags are authoritative; link roads only qualify if they actually rise above local
 * terrain (above-terrain frame, so smooth/bumpy terrain can't false-trigger — Phase 2
 * audit D3). Shared by the geometry + collider builders and the mask so all three agree.
 */
function isElevatedGuardRailRoad(road, options) {
  if (!road || road.closedLoop || road.tunnel) return false;
  const heights = getRoadPointHeights(road, options);
  const atVals = getAboveTerrainHeights(road, options, heights) || (heights || []);
  const atMax = atVals.length ? Math.max(...atVals) : 0;
  const atMin = atVals.length ? Math.min(...atVals) : 0;
  const isLink = road.highwayType && road.highwayType.endsWith('_link');
  return road.bridge
    || road.isRamp
    || (road.layer != null && road.layer > 0)
    || road.crossesTrench === true // Option L: streets bridging daylighted tunnel corridors
    || (isLink && (atMax > 0.5 || (atMax - atMin) > 1.0));
}

function detectRoundaboutZonesForRails(roads) {
  const zones = [];
  for (const road of roads || []) {
    const pts = road.points;
    if (!pts || pts.length < 3) continue;
    const first = pts[0], last = pts[pts.length - 1];
    const dx = last.x - first.x, dz = last.y - first.y;
    if (!(road.closedLoop || (dx * dx + dz * dz < 25))) continue; // closed loop = roundabout
    let cx = 0, cz = 0;
    for (const p of pts) { cx += p.x; cz += p.y; }
    cx /= pts.length; cz /= pts.length;
    let maxD = 0;
    for (const p of pts) { const d = (p.x - cx) ** 2 + (p.y - cz) ** 2; if (d > maxD) maxD = d; }
    const r = Math.sqrt(maxD) + GUARD_RAIL_ROUNDABOUT_PROX;
    zones.push({ cx, cz, rSq: r * r });
  }
  return zones;
}

/**
 * Compute per-road, per-side, per-point keep masks for guard rails.
 * Returns Map<road, { keepL: Uint8Array, keepR: Uint8Array }> indexed by centerline point.
 * Deterministic and input-order-independent: tunnels are filtered out internally and
 * dedup ties break on a stable sequence over the filtered elevated set, so the geometry
 * builder (all roads) and the collider builder (non-tunnel roads) produce identical masks.
 */
function computeGuardRailMask(roads, options) {
  const mask = new Map();
  if (!roads || !roads.length) return mask;
  const surface = roads.filter((r) => r && !r.tunnel);
  const junctions = getJunctionPoints(surface, JUNCTION_TOLERANCE); // {x,z,radius}
  const roundabouts = detectRoundaboutZonesForRails(surface);

  // Gather elevated roads (stable seq) + their thickness-offset edges (1:1 with points)
  const elevated = [];
  let seq = 0;
  for (const road of surface) {
    if (!isElevatedGuardRailRoad(road, options)) continue;
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const heights = getRoadPointHeights(road, options);
    const edges = getRibbonEdgeVerts(pts, guardRailWidth(road) + GUARD_RAIL_THICKNESS * 2, heights);
    if (!edges) continue;
    elevated.push({ road, seq: seq++, pts, left: edges.leftEdge, right: edges.rightEdge });
  }

  // Spatial hash of every elevated edge point for parallel-dedup
  const CELL = 4;
  const hash = new Map();
  const cellKey = (x, z) => `${Math.floor(x / CELL)}|${Math.floor(z / CELL)}`;
  for (const e of elevated) {
    for (let i = 0; i < e.left.length; i++) {
      for (const pt of [e.left[i], e.right[i]]) {
        const k = cellKey(pt.x, pt.z);
        if (!hash.has(k)) hash.set(k, []);
        hash.get(k).push({ x: pt.x, z: pt.z, seq: e.seq });
      }
    }
  }
  const dedupSq = GUARD_RAIL_DEDUP_DIST * GUARD_RAIL_DEDUP_DIST;
  // Suppress this point if an EARLIER (lower-seq) elevated edge runs coincident with it.
  const losesDedup = (x, z, ownSeq) => {
    const bx = Math.floor(x / CELL), bz = Math.floor(z / CELL);
    for (let cx = bx - 1; cx <= bx + 1; cx++) {
      for (let cz = bz - 1; cz <= bz + 1; cz++) {
        const arr = hash.get(`${cx}|${cz}`);
        if (!arr) continue;
        for (const q of arr) {
          if (q.seq >= ownSeq) continue;
          const dx = q.x - x, dz = q.z - z;
          if (dx * dx + dz * dz < dedupSq) return true;
        }
      }
    }
    return false;
  };

  for (const e of elevated) {
    const n = e.pts.length;
    const keepL = new Uint8Array(n).fill(1);
    const keepR = new Uint8Array(n).fill(1);
    const arc = new Array(n); arc[0] = 0;
    for (let i = 1; i < n; i++) arc[i] = arc[i - 1] + Math.hypot(e.pts[i].x - e.pts[i - 1].x, e.pts[i].y - e.pts[i - 1].y);
    const total = arc[n - 1];
    for (let i = 0; i < n; i++) {
      const cx = e.pts[i].x, cz = e.pts[i].y;
      let drop = arc[i] < GUARD_RAIL_END_MARGIN || (total - arc[i]) < GUARD_RAIL_END_MARGIN; // rule 1
      if (!drop) for (const j of junctions) { // rule 2
        const rr = (j.radius || 4) + GUARD_RAIL_JUNCTION_PAD;
        if ((cx - j.x) ** 2 + (cz - j.z) ** 2 < rr * rr) { drop = true; break; }
      }
      if (!drop) for (const r of roundabouts) { // rule 3
        if ((cx - r.cx) ** 2 + (cz - r.cz) ** 2 < r.rSq) { drop = true; break; }
      }
      if (drop) { keepL[i] = 0; keepR[i] = 0; continue; }
      if (losesDedup(e.left[i].x, e.left[i].z, e.seq)) keepL[i] = 0;   // rule 4
      if (losesDedup(e.right[i].x, e.right[i].z, e.seq)) keepR[i] = 0;
    }
    // Morphological cleanup: reconnect dedup salt-and-pepper, drop junction stubs.
    cleanupKeepMask(keepL, arc, n, 4, 10);
    cleanupKeepMask(keepR, arc, n, 4, 10);
    mask.set(e.road, { keepL, keepR });
  }
  return mask;
}

/**
 * Morphological cleanup of a per-point keep mask so rails read as clean continuous runs
 * instead of fragmented stubs: (1) fill short gaps (≤ maxGap m) — kills the salt-and-pepper
 * holes parallel-dedup punches into otherwise-continuous edges; (2) drop short runs
 * (< minRun m) — removes the tiny floating stubs left around junctions/roundabouts.
 * Real junction breaks are longer than maxGap so they survive. Mutates `keep` in place.
 */
function cleanupKeepMask(keep, arc, n, maxGap, minRun) {
  if (!keep || n < 2) return;
  // 1. fill short gaps (runs of 0 bounded by 1 on both sides, shorter than maxGap)
  let i = 0;
  while (i < n) {
    if (keep[i]) { i++; continue; }
    let j = i;
    while (j < n && !keep[j]) j++;
    const boundedBoth = i > 0 && j < n; // interior gap
    if (boundedBoth && (arc[j] - arc[i - 1]) <= maxGap) {
      for (let k = i; k < j; k++) keep[k] = 1;
    }
    i = j;
  }
  // 2. drop short runs (runs of 1 shorter than minRun)
  i = 0;
  while (i < n) {
    if (!keep[i]) { i++; continue; }
    let j = i;
    while (j < n && keep[j]) j++;
    if ((arc[j - 1] - arc[i]) < minRun) {
      for (let k = i; k < j; k++) keep[k] = 0;
    }
    i = j;
  }
}

/** Split a per-point keep mask into maximal runs of kept indices [start,end] (inclusive, ≥2 pts). */
function guardRailKeepRuns(keep, n) {
  const runs = [];
  let i = 0;
  while (i < n) {
    if (keep && !keep[i]) { i++; continue; }
    let j = i;
    while (j + 1 < n && (!keep || keep[j + 1])) j++;
    if (j > i) runs.push([i, j]);
    i = j + 1;
  }
  return runs;
}

/**
 * Emit one contiguous guard-rail run: concrete wall + posts + beam for the given
 * sub-slices of inner/outer edge verts (and per-point above-terrain heights).
 * Pushes geometries into railGeoms / railingGeoms. Extracted verbatim from the old
 * inline per-edge build so the smart mask can drive it run-by-run.
 */
function emitGuardRailRun(innerEdge, outerEdge, atVals, atMax, railGeoms, railingGeoms) {
  const count = innerEdge.length;
  if (count < 2) return;
  // 6 vertices per cross-section (see original convention): inner wall, outer wall, top face.
  const VPP = 6;
  const pos = new Float32Array(count * VPP * 3);
  const col = new Float32Array(count * VPP * 3);
  const idx = [];
  const innR = 0.38, innG = 0.36, innB = 0.34;    // inner/left wall
  const outR = 0.28, outG = 0.26, outB = 0.25;    // outer/right wall (darker)
  const topR = 0.48, topG = 0.46, topB = 0.44;    // top face (lighter)
  for (let ii = 0; ii < count; ii++) {
    const inn = innerEdge[ii];
    const out = outerEdge[ii];
    const ptH = atVals[ii] ?? atMax;
    const hScale = ptH < MIN_BRIDGE_STRUCTURE_HEIGHT ? Math.max(0, ptH / MIN_BRIDGE_STRUCTURE_HEIGHT) : 1;
    const h = GUARD_RAIL_HEIGHT * hScale;
    const b = ii * VPP * 3;
    pos[b]    = inn.x; pos[b+1]  = inn.y;     pos[b+2]  = inn.z;
    col[b]    = innR;  col[b+1]  = innG;      col[b+2]  = innB;
    pos[b+3]  = inn.x; pos[b+4]  = inn.y + h; pos[b+5]  = inn.z;
    col[b+3]  = innR;  col[b+4]  = innG;      col[b+5]  = innB;
    pos[b+6]  = out.x; pos[b+7]  = out.y;     pos[b+8]  = out.z;
    col[b+6]  = outR;  col[b+7]  = outG;      col[b+8]  = outB;
    pos[b+9]  = out.x; pos[b+10] = out.y + h; pos[b+11] = out.z;
    col[b+9]  = outR;  col[b+10] = outG;      col[b+11] = outB;
    pos[b+12] = inn.x; pos[b+13] = inn.y + h; pos[b+14] = inn.z;
    col[b+12] = topR;  col[b+13] = topG;      col[b+14] = topB;
    pos[b+15] = out.x; pos[b+16] = out.y + h; pos[b+17] = out.z;
    col[b+15] = topR;  col[b+16] = topG;      col[b+17] = topB;
  }
  for (let ii = 0; ii < count - 1; ii++) {
    const c = ii * VPP, n2 = (ii + 1) * VPP;
    idx.push(c+0, n2+0, n2+1, c+0, n2+1, c+1);   // inner wall
    idx.push(c+2, c+3, n2+3, c+2, n2+3, n2+2);   // outer wall
    idx.push(c+4, n2+4, n2+5, c+4, n2+5, c+5);   // top face
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geom.setIndex(idx);
  geom.computeVertexNormals();
  railGeoms.push(geom);

  // --- Red metal railing on top ---
  const arcLen = [0];
  for (let ii = 1; ii < count; ii++) {
    arcLen.push(arcLen[ii - 1] + Math.hypot(
      innerEdge[ii].x - innerEdge[ii - 1].x,
      innerEdge[ii].z - innerEdge[ii - 1].z
    ));
  }
  const totalLen = arcLen[count - 1];
  if (totalLen < 2) return;

  const posAtArc = (s) => {
    s = Math.max(0, Math.min(totalLen, s));
    let lo = 0;
    for (let ii = 1; ii < count; ii++) { if (arcLen[ii] >= s) { lo = ii - 1; break; } lo = ii - 1; }
    const hi = Math.min(lo + 1, count - 1);
    const segLen = arcLen[hi] - arcLen[lo];
    const t = segLen > 1e-6 ? (s - arcLen[lo]) / segLen : 0;
    return {
      x: innerEdge[lo].x + t * (innerEdge[hi].x - innerEdge[lo].x),
      y: innerEdge[lo].y + t * (innerEdge[hi].y - innerEdge[lo].y),
      z: innerEdge[lo].z + t * (innerEdge[hi].z - innerEdge[lo].z),
    };
  };
  const tangentAtArc = (s) => {
    const eps = 0.1;
    const a2 = posAtArc(Math.max(0, s - eps));
    const b2 = posAtArc(Math.min(totalLen, s + eps));
    const dx2 = b2.x - a2.x, dz2 = b2.z - a2.z;
    const len2 = Math.hypot(dx2, dz2) || 1;
    return { ax: dx2/len2, az: dz2/len2, px: -dz2/len2, pz: dx2/len2 };
  };

  const numPosts = Math.max(2, Math.floor(totalLen / RAILING_POST_SPACING) + 1);
  const postSpacing = totalLen / (numPosts - 1);
  const pH = RAILING_POST_SIZE / 2;
  for (let pi2 = 0; pi2 < numPosts; pi2++) {
    const s = pi2 * postSpacing;
    const p = posAtArc(s);
    const baseY = p.y + GUARD_RAIL_HEIGHT;
    const tang = tangentAtArc(s);
    const alX = tang.ax * pH, alZ = tang.az * pH;
    const prX = tang.px * pH, prZ = tang.pz * pH;
    const postPos2 = new Float32Array(8 * 3);
    const sv = (vi, x2, y2, z2) => { postPos2[vi*3]=x2; postPos2[vi*3+1]=y2; postPos2[vi*3+2]=z2; };
    sv(0, p.x-alX-prX, baseY,                       p.z-alZ-prZ);
    sv(1, p.x+alX-prX, baseY,                       p.z+alZ-prZ);
    sv(2, p.x+alX+prX, baseY,                       p.z+alZ+prZ);
    sv(3, p.x-alX+prX, baseY,                       p.z-alZ+prZ);
    sv(4, p.x-alX-prX, baseY + RAILING_POST_HEIGHT, p.z-alZ-prZ);
    sv(5, p.x+alX-prX, baseY + RAILING_POST_HEIGHT, p.z+alZ-prZ);
    sv(6, p.x+alX+prX, baseY + RAILING_POST_HEIGHT, p.z+alZ+prZ);
    sv(7, p.x-alX+prX, baseY + RAILING_POST_HEIGHT, p.z-alZ+prZ);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(postPos2, 3));
    pg.setIndex([0,1,5, 0,5,4, 1,2,6, 1,6,5, 2,3,7, 2,7,6, 3,0,4, 3,4,7, 4,5,6, 4,6,7]);
    pg.computeVertexNormals();
    railingGeoms.push(pg);
  }

  const BEAM_STEPS = Math.max(numPosts * 2, Math.ceil(totalLen / 2));
  const beamPos2 = [];
  const beamIdx2 = [];
  for (let si = 0; si <= BEAM_STEPS; si++) {
    const s = (si / BEAM_STEPS) * totalLen;
    const p = posAtArc(s);
    const beamCenterY = p.y + GUARD_RAIL_HEIGHT + RAILING_POST_HEIGHT - RAILING_BEAM_HALF;
    const tang = tangentAtArc(s);
    const bD = RAILING_BEAM_DEPTH / 2;
    beamPos2.push(
      p.x - tang.px*bD, beamCenterY - RAILING_BEAM_HALF, p.z - tang.pz*bD,
      p.x - tang.px*bD, beamCenterY + RAILING_BEAM_HALF, p.z - tang.pz*bD,
      p.x + tang.px*bD, beamCenterY - RAILING_BEAM_HALF, p.z + tang.pz*bD,
      p.x + tang.px*bD, beamCenterY + RAILING_BEAM_HALF, p.z + tang.pz*bD,
    );
  }
  for (let si = 0; si < BEAM_STEPS; si++) {
    const a2 = si*4, e2 = (si+1)*4;
    beamIdx2.push(a2, e2, e2+1, a2, e2+1, a2+1);
    beamIdx2.push(a2+2, a2+3, e2+3, a2+2, e2+3, e2+2);
    beamIdx2.push(a2+1, e2+1, e2+3, a2+1, e2+3, a2+3);
    beamIdx2.push(a2, a2+2, e2+2, a2, e2+2, e2);
  }
  if (beamPos2.length > 0) {
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(beamPos2, 3));
    bg.setIndex(beamIdx2);
    bg.computeVertexNormals();
    railingGeoms.push(bg);
  }
}

/**
 * Build low guard-rail walls + red metal railing along both edges of bridge and elevated roads.
 * Returns { wallMesh, railingMesh } — concrete wall + red metal railing on top.
 * Placement is driven by the smart suppression mask (computeGuardRailMask) so rails no
 * longer pile up at junctions/roundabouts or double-wall parallel carriageways.
 */
function buildBridgeGuardRailGeometry(roads, options) {
  const railGeoms = [];
  const railingGeoms = [];
  const mask = computeGuardRailMask(roads, options);
  for (const road of roads || []) {
    if (!isElevatedGuardRailRoad(road, options)) continue;
    const pts = road.points;
    if (!pts || pts.length < 2) continue;

    const heights = getRoadPointHeights(road, options);
    const atVals = getAboveTerrainHeights(road, options, heights) || (heights || []);
    const atMax = atVals.length ? Math.max(...atVals) : 0;

    const roadWidth  = guardRailWidth(road);
    const edges      = getRibbonEdgeVerts(pts, roadWidth, heights);
    const outerEdges = getRibbonEdgeVerts(pts, roadWidth + GUARD_RAIL_THICKNESS * 2, heights);
    if (!edges || !outerEdges) continue;

    const m = mask.get(road); // smart suppression mask (per-point keep, per side)
    const edgeSides = [
      { inner: edges.leftEdge,  outer: outerEdges.leftEdge,  keep: m && m.keepL },
      { inner: edges.rightEdge, outer: outerEdges.rightEdge, keep: m && m.keepR },
    ];
    for (const { inner: innerEdge, outer: outerEdge, keep } of edgeSides) {
      const n = innerEdge.length;
      if (n < 2) continue;
      // Emit each maximal run of kept points as its own wall+railing (gaps at junctions/dedup).
      for (const [s, e] of guardRailKeepRuns(keep, n)) {
        emitGuardRailRun(
          innerEdge.slice(s, e + 1),
          outerEdge.slice(s, e + 1),
          atVals.slice(s, e + 1),
          atMax,
          railGeoms,
          railingGeoms,
        );
      }
    }
  }

  // Concrete wall mesh
  let wallMesh = null;
  if (railGeoms.length > 0) {
    const merged = mergeGeometries(railGeoms);
    railGeoms.forEach((g) => g.dispose());
    if (merged) {
      wallMesh = new THREE.Mesh(merged, getGuardRailMaterial());
      wallMesh.castShadow = false;
      wallMesh.receiveShadow = false;
      wallMesh.frustumCulled = true;
      wallMesh.userData.type = 'bridgeGuardRail';
    }
  }

  // Red metal railing mesh
  let railingMesh = null;
  if (railingGeoms.length > 0) {
    const merged2 = mergeGeometries(railingGeoms);
    railingGeoms.forEach((g) => g.dispose());
    if (merged2) {
      railingMesh = new THREE.Mesh(merged2, getRailingMaterial());
      railingMesh.castShadow = false;
      railingMesh.receiveShadow = false;
      railingMesh.frustumCulled = true;
      railingMesh.userData = { sharedMaterial: true, type: 'metalRailing' };
    }
  }

  return { wallMesh, railingMesh };
}

// ---------------------------------------------------------------------------
// Bridge guard-rail physics colliders
// ---------------------------------------------------------------------------

/**
 * Build CANNON.Body with box shapes along both edges of every bridge guard rail.
 * One box per segment between edge vertices. Must be called with cannon-es CANNON.
 * @param {object[]} roads
 * @param {object} options - { getElevationAt?, elevationOffset? }
 * @param {object} CANNON - cannon-es module
 * @param {{ x: number, z: number }} physicsOrigin
 * @returns {object|null} CANNON.Body or null if no guard rails
 */
export function buildBridgeGuardRailColliders(roads, options, CANNON, physicsOrigin) {
  const body = new CANNON.Body({ mass: 0 });
  let shapeCount = 0;
  // Same smart suppression mask the visual rails use → colliders line up exactly with
  // what's drawn (computeGuardRailMask filters tunnels + is order-independent, so the
  // geometry builder's all-roads call and this non-tunnel call agree per road object).
  const mask = computeGuardRailMask(roads, options);
  for (const road of roads || []) {
    if (!isElevatedGuardRailRoad(road, options)) continue;
    const pts = road.points;
    if (!pts || pts.length < 2) continue;

    const heights = getRoadPointHeights(road, options);
    const roadWidth = guardRailWidth(road);
    const edges = getRibbonEdgeVerts(pts, roadWidth + GUARD_RAIL_THICKNESS * 2, heights);
    if (!edges) continue;

    const m = mask.get(road);
    const edgeArrays = [
      { arr: edges.leftEdge, keep: m && m.keepL },
      { arr: edges.rightEdge, keep: m && m.keepR },
    ];
    for (const { arr: edgeArr, keep } of edgeArrays) {
      const n = edgeArr.length;
      if (n < 2) continue;

      for (let i = 0; i < n - 1; i++) {
        if (keep && (!keep[i] || !keep[i + 1])) continue; // suppressed run → no collider here
        const a = edgeArr[i];
        const b = edgeArr[i + 1];

        // Convert from visual world coords to physics coords
        // Visual: x = worldX, z = worldZ (stored as .z in edge verts)
        // Physics: px = -(worldX - origin.x), pz = worldZ - origin.z  (X negated due to worldGroup.scale.x = -1)
        const ax = -(a.x - physicsOrigin.x);
        const az = a.z - physicsOrigin.z;
        const ay = a.y;
        const bx = -(b.x - physicsOrigin.x);
        const bz = b.z - physicsOrigin.z;
        const by = b.y;

        const dx = bx - ax, dz = bz - az;
        const segLen = Math.hypot(dx, dz);
        if (segLen < 0.1) continue;

        const halfH = GUARD_RAIL_HEIGHT / 2;
        const halfT = GUARD_RAIL_THICKNESS / 2;
        const halfL = segLen / 2;

        const shape = new CANNON.Box(new CANNON.Vec3(halfT, halfH, halfL));

        const yaw = Math.atan2(dx, dz);
        const q = new CANNON.Quaternion();
        q.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);

        const midX = (ax + bx) / 2;
        const midY = (ay + by) / 2 + halfH; // bottom at deck level
        const midZ = (az + bz) / 2;

        body.addShape(shape, new CANNON.Vec3(midX, midY, midZ), q);
        shapeCount++;
      }
    }
  }

  return shapeCount > 0 ? body : null;
}

// ---------------------------------------------------------------------------
// Bridge / ramp ground shadows — soft shadow ribbon on terrain below elevated roads
// ---------------------------------------------------------------------------
const BRIDGE_SHADOW_EXTRA_WIDTH = 3;  // metres extra on each side beyond road width
const BRIDGE_SHADOW_Y = 0.10;         // above ground-level road surfaces (~0.07m) so shadow is visible on roads below

let bridgeShadowTexture = null;
let bridgeShadowMaterial = null;

function getBridgeShadowTexture() {
  if (bridgeShadowTexture) return bridgeShadowTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  // Vertical gradient: dark center strip fading to transparent edges
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0,    'rgba(0,0,0,0)');
  g.addColorStop(0.15, 'rgba(0,0,0,0.22)');
  g.addColorStop(0.35, 'rgba(0,0,0,0.40)');
  g.addColorStop(0.5,  'rgba(0,0,0,0.45)');
  g.addColorStop(0.65, 'rgba(0,0,0,0.40)');
  g.addColorStop(0.85, 'rgba(0,0,0,0.22)');
  g.addColorStop(1,    'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  bridgeShadowTexture = new THREE.CanvasTexture(canvas);
  bridgeShadowTexture.wrapS = THREE.RepeatWrapping;
  bridgeShadowTexture.wrapT = THREE.ClampToEdgeWrapping;
  return bridgeShadowTexture;
}

function getBridgeShadowMaterial() {
  if (bridgeShadowMaterial) return bridgeShadowMaterial;
  bridgeShadowMaterial = new THREE.MeshBasicMaterial({
    map: getBridgeShadowTexture(),
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    opacity: 1.0,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    // Stencil: prevent double-drawing where bridge + ramp shadows overlap.
    // First shadow pixel at any screen location writes stencil 0→1 and draws.
    // Any subsequent shadow pixel at same location fails (stencil != 0) → discarded.
    stencilWrite: true,
    stencilFunc: THREE.EqualStencilFunc,
    stencilRef: 0,
    stencilZPass: THREE.IncrementStencilOp,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
  });
  return bridgeShadowMaterial;
}

/**
 * Build shadow ribbons on the ground below elevated roads (bridges, ramps, slopes).
 * Shadow sits at terrain level (or Y=0) with a soft cross-fade texture.
 */
function buildBridgeShadowMesh(roads, options) {
  const getElevationAt = options?.getElevationAt;
  const vertExag = CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null
    && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION)
    ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;
  const shadowGeoms = [];

  for (const road of roads || []) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;

    const heights = getRoadPointHeights(road, options);
    const hVals = heights || [];
    // Structural test only — a shadow belongs under a real elevated structure, not a sloped surface road.
    const isElevated = road.bridge
      || (road.layer != null && road.layer > 0)
      || road.isRamp
      || road.crossesTrench === true; // Option L: streets bridging daylighted tunnel corridors get full bridge dressing
    if (!isElevated) continue;

    // Above-terrain rise drives the height-based shadow fade.
    const atVals = getAboveTerrainHeights(road, options, heights) || hVals;

    const roadWidth = Number.isFinite(Number(road.width))
      ? Math.max(3, Math.min(30, Number(road.width)))
      : (WIDTH_BY_TYPE[road.highwayType] ?? 6);
    const isRampOrLink = road.isRamp || (road.highwayType && road.highwayType.endsWith('_link'));
    const extraW = isRampOrLink ? 1 : BRIDGE_SHADOW_EXTRA_WIDTH; // narrower shadow for ramps
    const shadowHalf = roadWidth / 2 + extraW;
    const n = pts.length;

    // Build a flat ribbon on the ground with per-vertex alpha for height-based fade.
    const positions = new Float32Array(n * 2 * 3);
    const uvs = new Float32Array(n * 2 * 2);
    const colors = new Float32Array(n * 2 * 4); // RGBA vertex colors
    let lengthAlong = 0;

    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const x = p.x, z = p.y;

      // Ground Y at this point
      let groundY = BRIDGE_SHADOW_Y;
      if (getElevationAt) {
        const { lat, lon } = worldToLatLon(x, z);
        groundY = ((getElevationAt(lat, lon) ?? 0) * vertExag) + BRIDGE_SHADOW_Y;
      }

      // Height-based shadow fade: no shadow below 1m, full shadow above 4m (above-terrain rise)
      const h = (atVals[i] ?? 0);
      const heightAlpha = Math.min(1, Math.max(0, (h - 1.0) / 3.0));

      // Direction along road for perpendicular
      let dx, dz;
      if (i === 0) {
        dx = pts[1].x - x; dz = pts[1].y - z;
      } else if (i === n - 1) {
        dx = x - pts[n - 2].x; dz = z - pts[n - 2].y;
      } else {
        dx = pts[i + 1].x - pts[i - 1].x; dz = pts[i + 1].y - pts[i - 1].y;
      }
      const len = Math.hypot(dx, dz);
      if (len < 1e-10) continue;
      const nx = -dz / len, nz = dx / len;

      if (i > 0) lengthAlong += Math.hypot(x - pts[i - 1].x, z - pts[i - 1].y);

      const b = i * 6;
      positions[b]     = x - nx * shadowHalf;
      positions[b + 1] = groundY;
      positions[b + 2] = z - nz * shadowHalf;
      positions[b + 3] = x + nx * shadowHalf;
      positions[b + 4] = groundY;
      positions[b + 5] = z + nz * shadowHalf;

      const uAlong = lengthAlong / 8;
      uvs[i * 4]     = uAlong;
      uvs[i * 4 + 1] = 0;
      uvs[i * 4 + 2] = uAlong;
      uvs[i * 4 + 3] = 1;

      // Vertex color: white RGB, alpha = height fade
      const ci = i * 8;
      colors[ci]     = 1; colors[ci + 1] = 1; colors[ci + 2] = 1; colors[ci + 3] = heightAlpha;
      colors[ci + 4] = 1; colors[ci + 5] = 1; colors[ci + 6] = 1; colors[ci + 7] = heightAlpha;
    }

    const indices = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
    if (indices.length === 0) continue;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    shadowGeoms.push(geo);
  }

  if (shadowGeoms.length === 0) return null;
  const merged = mergeGeometries(shadowGeoms);
  shadowGeoms.forEach((g) => g.dispose());
  if (!merged) return null;

  const mesh = new THREE.Mesh(merged, getBridgeShadowMaterial());
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  mesh.renderOrder = -1;
  mesh.userData = { sharedMaterial: true, type: 'bridgeShadow' };
  return mesh;
}

// ---------------------------------------------------------------------------
// Roadside blend strip — gradient ribbon: road dust → shoulder → terrain green
// ---------------------------------------------------------------------------
// 3-row ribbon per side: inner (on road), mid (road edge), outer (into terrain)
const BLEND_INNER_OVERLAP = 0.2;  // metres overlapping onto road surface
const BLEND_SHOULDER_W    = 0.4;  // metres of dust shoulder at road edge
const BLEND_OUTER_FADE    = 0.6;  // metres fading into terrain
const BLEND_STRIP_Y_OFFSET = 0.10; // above terrain AND green area meshes for consistent visibility

// Vertex colors for the 3 rows (linear sRGB approximations)
const BLEND_COL_INNER = { r: 0.46, g: 0.49, b: 0.56 };  // road grey with slight dust (~#768090)
const BLEND_COL_MID   = { r: 0.52, g: 0.53, b: 0.40 };  // dusty earth (~#868840)
const BLEND_COL_OUTER = { r: 0.38, g: 0.56, b: 0.32 };  // terrain green (~#618F52)

// Bridge/ramp edge: dust-only gradient (no grass), narrower
const BRIDGE_COL_INNER = { r: 0.46, g: 0.49, b: 0.56 };  // road grey
const BRIDGE_COL_MID   = { r: 0.52, g: 0.50, b: 0.42 };  // dusty concrete
const BRIDGE_COL_OUTER = { r: 0.48, g: 0.46, b: 0.38 };  // dust edge

let blendStripMaterial = null;
function getBlendStripMaterial() {
  if (!blendStripMaterial) {
    blendStripMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  }
  return blendStripMaterial;
}

/**
 * Build gradient ribbons along both sides of roads.
 * Ground-level roads: 3-row ribbon (asphalt → dust → green).
 * Bridges/ramps: narrower 3-row ribbon (asphalt → dust → dark dust, no grass).
 */
function buildRoadsideBlendStrip(roads, options) {
  const stripGeoms = [];
  const junctionSkips = computeJunctionSkips(roads);
  for (let ri = 0; ri < (roads || []).length; ri++) {
    const road = roads[ri];
    if (road.tunnel) continue;
    const layer = road.layer != null && Number.isFinite(road.layer) ? road.layer : 0;
    const isLink = road.highwayType && road.highwayType.endsWith('_link');
    let isBridgeOrRamp = road.bridge || road.isRamp || isLink;
    // Ground roads: only layer 0, not bridges/ramps
    if (!isBridgeOrRamp && layer !== 0) continue;
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const roadWidth = Number.isFinite(Number(road.width)) ? Math.max(3, Math.min(20, Number(road.width))) : (WIDTH_BY_TYPE[road.highwayType] ?? 6);
    const half = roadWidth / 2;
    const heights = getRoadPointHeights(road, options);
    const n = pts.length;

    // Detect elevated approach roads: if any point is well above ground, treat as ramp
    if (!isBridgeOrRamp && Array.isArray(heights)) {
      const maxH = Math.max(...heights);
      if (maxH > 2.0) isBridgeOrRamp = true;
    }

    // Junction skip: suppress blend strip at ends where ramp meets another road
    const jSkip = junctionSkips.get(ri) || { skipStart: 0, skipEnd: 0 };

    // Pre-compute cumulative arc lengths for distance-based junction skipping
    const arcLens = [0];
    for (let i = 1; i < n; i++) {
      arcLens.push(arcLens[i - 1] + Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y));
    }
    const totalArc = arcLens[n - 1];

    for (const side of [-1, 1]) {
      const normals = [];
      const yVals = [];
      let validCount = 0;

      for (let i = 0; i < n; i++) {
        const p = pts[i];
        const x = p.x, z = p.y;
        const isYArray = Array.isArray(heights);
        const y = (isYArray ? (heights[i] ?? 0) : (heights ?? 0)) + BLEND_STRIP_Y_OFFSET;

        // Skip vertices at junction ends (distance-based)
        if ((jSkip.skipStart > 0 && arcLens[i] < jSkip.skipStart) ||
            (jSkip.skipEnd > 0 && (totalArc - arcLens[i]) < jSkip.skipEnd)) {
          normals.push(null);
          yVals.push(y);
          continue;
        }

        // Miter-corrected perpendicular — matches road ribbon geometry so blend
        // strip tracks the road edge accurately at bends/curves.
        let nx, nz, miterScale;
        if (i === 0) {
          const ddx = pts[1].x - x, ddz = pts[1].y - z;
          const dl = Math.hypot(ddx, ddz);
          if (dl < 1e-10) { normals.push(null); yVals.push(y); continue; }
          nx = -ddz / dl * side; nz = ddx / dl * side;
          miterScale = 1;
        } else if (i === n - 1) {
          const ddx = x - pts[n - 2].x, ddz = z - pts[n - 2].y;
          const dl = Math.hypot(ddx, ddz);
          if (dl < 1e-10) { normals.push(null); yVals.push(y); continue; }
          nx = -ddz / dl * side; nz = ddx / dl * side;
          miterScale = 1;
        } else {
          // Segment A: prev→current, Segment B: current→next
          const adx = x - pts[i - 1].x, adz = z - pts[i - 1].y;
          const bdx = pts[i + 1].x - x, bdz = pts[i + 1].y - z;
          const aLen = Math.hypot(adx, adz), bLen = Math.hypot(bdx, bdz);
          if (aLen < 1e-10 && bLen < 1e-10) { normals.push(null); yVals.push(y); continue; }
          if (aLen < 1e-10) {
            nx = -bdz / bLen * side; nz = bdx / bLen * side; miterScale = 1;
          } else if (bLen < 1e-10) {
            nx = -adz / aLen * side; nz = adx / aLen * side; miterScale = 1;
          } else {
            const perpAx = -adz / aLen, perpAz = adx / aLen;
            const perpBx = -bdz / bLen, perpBz = bdx / bLen;
            let mx = perpAx + perpBx, mz = perpAz + perpBz;
            const mLen = Math.hypot(mx, mz);
            if (mLen < 1e-10) {
              nx = perpBx * side; nz = perpBz * side; miterScale = 1;
            } else {
              mx /= mLen; mz /= mLen;
              const denom = mx * perpBx + mz * perpBz;
              if (Math.abs(denom) < 0.2) {
                nx = perpBx * side; nz = perpBz * side; miterScale = 1;
              } else {
                miterScale = Math.min(1 / denom, 3); // clamp to avoid extreme spikes
                nx = mx * side; nz = mz * side;
              }
            }
          }
        }
        normals.push({ nx, nz, miterScale });
        yVals.push(y);
        validCount++;
      }

      if (validCount < 2) continue;

      // 3 vertex rows × n points; fill positions + vertex colors
      const ROWS = 3;
      // Bridges/ramps: narrower dust-only strip; ground roads: full grass fade
      const offsets = isBridgeOrRamp
        ? [
            half - BLEND_INNER_OVERLAP,       // inner: slightly inside road
            half + 0.3,                       // mid: narrow dust edge
            half + 0.6,                       // outer: thin dust lip
          ]
        : [
            half - BLEND_INNER_OVERLAP,       // inner: slightly inside road
            half + BLEND_SHOULDER_W,          // mid: just past road edge
            half + BLEND_SHOULDER_W + BLEND_OUTER_FADE, // outer: into terrain
          ];
      const rowColors = isBridgeOrRamp
        ? [BRIDGE_COL_INNER, BRIDGE_COL_MID, BRIDGE_COL_OUTER]
        : [BLEND_COL_INNER, BLEND_COL_MID, BLEND_COL_OUTER];

      const positions = [];
      const colors = [];
      const idxMap = []; // idxMap[i] = base vertex index for point i, or -1 if skipped

      for (let i = 0; i < n; i++) {
        const norm = normals[i];
        if (!norm) { idxMap.push(-1); continue; }
        const p = pts[i];
        const y = yVals[i];
        const ms = norm.miterScale || 1;
        idxMap.push(positions.length / 3);
        for (let row = 0; row < ROWS; row++) {
          const d = offsets[row] * ms;
          positions.push(p.x + norm.nx * d, y, p.y + norm.nz * d);
          const c = rowColors[row];
          colors.push(c.r, c.g, c.b);
        }
      }

      if (positions.length < ROWS * 2 * 3) continue;

      // Build triangle indices between consecutive valid points
      const indices = [];
      let prevBase = -1;
      for (let i = 0; i < n; i++) {
        const base = idxMap[i];
        if (base < 0) { prevBase = -1; continue; }
        if (prevBase >= 0) {
          for (let row = 0; row < ROWS - 1; row++) {
            const a = prevBase + row;
            const b = prevBase + row + 1;
            const c = base + row;
            const d = base + row + 1;
            indices.push(a, c, b);
            indices.push(b, c, d);
          }
        }
        prevBase = base;
      }

      if (indices.length === 0) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(colors), 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      stripGeoms.push(geo);
    }
  }
  if (stripGeoms.length === 0) return null;
  const merged = mergeGeometries(stripGeoms);
  stripGeoms.forEach((g) => g.dispose());
  if (!merged) return null;
  const mesh = new THREE.Mesh(merged, getBlendStripMaterial());
  mesh.castShadow = false;
  mesh.receiveShadow = !!CONFIG.ENABLE_SHADOWS;
  mesh.frustumCulled = true;
  mesh.userData = { sharedMaterial: true, type: 'blendStrip' };
  return mesh;
}

// ── Bridge billboard ads ────────────────────────────────────────────────────

const BILLBOARD_SPACING = 40;     // metres between billboards along bridge
const BILLBOARD_W = 7;            // width in metres
const BILLBOARD_H = 2;            // height in metres
const BILLBOARD_D = 0.15;        // depth / thickness in metres
const BILLBOARD_DROP = 0.3;       // how far below deck bottom
const BILLBOARD_MIN_BRIDGE_LEN = 30; // skip very short bridges

// Deterministic hash for billboard variety
function billboardHash(v) {
  let h = (v * 2654435761) >>> 0;
  h = ((h >> 16) ^ h) * 0x45d9f3b >>> 0;
  return h;
}

// Procedural billboard textures — cached and reused
const _billboardTexCache = [];
const BILLBOARD_TEX_COUNT = 12;

function getBillboardTextures() {
  if (_billboardTexCache.length > 0) return _billboardTexCache;

  // Spanish/Catalan PARODY brands (GTA-style: the tone of the real thing, never the name —
  // user call 2026-07-11, replaces the Delhi-era Indian ads). Keep them fictional.
  const designs = [
    // [bgColor, accentColor, text lines, style]
    { bg: '#b3202c', accent: '#f2c744', lines: ['ESTRELLA', 'DORADA'], sub: 'La cervesa de la platja' },
    { bg: '#cc2222', accent: '#ffffff', lines: ['REBAIXES', '50%'], sub: 'Mercat del Diumenge' },
    { bg: '#00427a', accent: '#ffd23f', lines: ['LA CAPSA'], sub: 'El teu banc de sempre' },
    { bg: '#f7c600', accent: '#3a3a3a', lines: ['VOLARING'], sub: 'Vola barat, vola ja' },
    { bg: '#1c1c1c', accent: '#f5f5f5', lines: ['ZURA'], sub: 'Moda nova cada setmana' },
    { bg: '#5a2d0c', accent: '#f2e3c8', lines: ['CACAOLIT'], sub: 'El batut de Barcelona' },
    { bg: '#f2b705', accent: '#212121', lines: ['MORTIZ'], sub: 'Nascuda al Raval' },
    { bg: '#0b4ea2', accent: '#7ee081', lines: ['MOVIESTAR', '5G'], sub: 'Connecta tota Espanya' },
    { bg: '#7a1030', accent: '#f8bbd0', lines: ['CHUPA', 'XUPS'], sub: 'Dolç per sempre' },
    { bg: '#0d3b2e', accent: '#e8c840', lines: ['JAMÓN', 'IBERIQO'], sub: 'De veritat, de debò' },
    { bg: '#821432', accent: '#f2c744', lines: ['LA LLIGA'], sub: 'Cada cap de setmana' },
    { bg: '#263238', accent: '#4fc3f7', lines: ['ASIENTO', 'MOTORS'], sub: 'Passió mediterrània' },
  ];

  for (const d of designs) {
    const canvas = document.createElement('canvas');
    const cW = 512;
    const cH = Math.round(cW * (BILLBOARD_H / BILLBOARD_W));
    canvas.width = cW;
    canvas.height = cH;
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = d.bg;
    ctx.fillRect(0, 0, cW, cH);

    // Border accent
    ctx.strokeStyle = d.accent;
    ctx.lineWidth = 6;
    ctx.strokeRect(6, 6, cW - 12, cH - 12);

    // Main text
    ctx.fillStyle = d.accent;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (d.lines.length === 1) {
      ctx.font = `bold ${Math.round(cH * 0.38)}px Arial, sans-serif`;
      ctx.fillText(d.lines[0], cW / 2, cH * 0.4);
    } else {
      ctx.font = `bold ${Math.round(cH * 0.3)}px Arial, sans-serif`;
      ctx.fillText(d.lines[0], cW / 2, cH * 0.3);
      ctx.fillText(d.lines[1], cW / 2, cH * 0.6);
    }

    // Subtitle
    ctx.font = `${Math.round(cH * 0.12)}px Arial, sans-serif`;
    ctx.fillStyle = d.accent;
    ctx.globalAlpha = 0.75;
    ctx.fillText(d.sub, cW / 2, d.lines.length === 1 ? cH * 0.75 : cH * 0.85);
    ctx.globalAlpha = 1.0;

    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    _billboardTexCache.push(tex);
  }

  return _billboardTexCache;
}

/**
 * Billboard texture atlas: packs all 12 individual billboard textures into a
 * single 4×3 grid canvas, enabling one draw call for all billboards per tile.
 */
let _billboardAtlas = null;
function getBillboardAtlas() {
  if (_billboardAtlas) return _billboardAtlas;
  const textures = getBillboardTextures();
  const cols = 4, rows = 3;
  const cellW = 512;
  const cellH = Math.round(cellW * (BILLBOARD_H / BILLBOARD_W));
  const atlasCanvas = document.createElement('canvas');
  atlasCanvas.width = cellW * cols;
  atlasCanvas.height = cellH * rows;
  const ctx = atlasCanvas.getContext('2d');
  for (let i = 0; i < textures.length && i < cols * rows; i++) {
    ctx.drawImage(textures[i].image, (i % cols) * cellW, Math.floor(i / cols) * cellH);
  }
  const tex = new THREE.CanvasTexture(atlasCanvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  _billboardAtlas = { tex, cols, rows };
  return _billboardAtlas;
}

let _billboardAtlasMaterial = null;
function getBillboardAtlasMaterial() {
  if (_billboardAtlasMaterial) return _billboardAtlasMaterial;
  const atlas = getBillboardAtlas();
  _billboardAtlasMaterial = new THREE.MeshStandardMaterial({
    map: atlas.tex,
    roughness: 0.6,
    emissiveMap: atlas.tex,
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 0,
    side: THREE.DoubleSide,
  });
  registerBillboardMat(_billboardAtlasMaterial);
  return _billboardAtlasMaterial;
}

/**
 * Build billboard ad panels hanging on the sides of bridges/flyovers.
 * All billboards are merged into a single mesh using a texture atlas.
 */
function buildBridgeBillboards(roads, options) {
  // First pass: collect placements
  const placements = [];
  let texIdx = 0;

  for (const road of roads || []) {
    if (!road.bridge) continue;
    const pts = road.points;
    if (!pts || pts.length < 2) continue;

    const heights = getRoadPointHeights(road, options);
    const hVals = heights || [];
    const hMax = hVals.length ? Math.max(...hVals) : 0;
    if (hMax < 5) continue;

    let totalLen = 0;
    const arcLens = [0];
    for (let i = 1; i < pts.length; i++) {
      totalLen += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
      arcLens.push(totalLen);
    }
    if (totalLen < BILLBOARD_MIN_BRIDGE_LEN) continue;

    const roadWidth = Number.isFinite(Number(road.width))
      ? Math.max(3, Math.min(30, Number(road.width)))
      : (WIDTH_BY_TYPE[road.highwayType] ?? 6);
    const halfW = roadWidth / 2;

    const startDist = 15;
    const endDist = totalLen - 15;
    if (endDist <= startDist) continue;

    for (let dist = startDist; dist < endDist; dist += BILLBOARD_SPACING) {
      let segI = 0;
      for (let i = 1; i < arcLens.length; i++) {
        if (arcLens[i] >= dist) { segI = i - 1; break; }
      }
      const segLen = arcLens[segI + 1] - arcLens[segI];
      const t = segLen > 0 ? (dist - arcLens[segI]) / segLen : 0;
      const px = pts[segI].x + (pts[segI+1].x - pts[segI].x) * t;
      const pz = pts[segI].y + (pts[segI+1].y - pts[segI].y) * t;

      const h0 = hVals[segI] ?? 0;
      const h1 = hVals[segI + 1] ?? 0;
      const deckY = h0 + (h1 - h0) * t;
      if (deckY < 5) continue;

      const dx = pts[segI+1].x - pts[segI].x;
      const dz = pts[segI+1].y - pts[segI].y;
      const dLen = Math.hypot(dx, dz);
      if (dLen < 0.1) continue;
      const nx = -dz / dLen, nz = dx / dLen;

      const billTopY = deckY + 0.5;
      const billCenterY = billTopY - BILLBOARD_H / 2;

      for (const side of [-1, 1]) {
        const ox = px + nx * (halfW + 0.5) * side;
        const oz = pz + nz * (halfW + 0.5) * side;
        const faceNx = nx * side, faceNz = nz * side;
        const angle = Math.atan2(faceNx, faceNz);
        placements.push({ ox, oz, billCenterY, angle, tIdx: (texIdx++) % BILLBOARD_TEX_COUNT });
      }
    }
  }

  if (placements.length === 0) return [];

  // Second pass: build single merged geometry with atlas UVs
  const atlas = getBillboardAtlas();
  const hw = BILLBOARD_W / 2;
  const hh = BILLBOARD_H / 2;
  const count = placements.length;
  const positions = new Float32Array(count * 4 * 3);
  const uvs = new Float32Array(count * 4 * 2);
  const indices = new Uint32Array(count * 6);

  for (let i = 0; i < count; i++) {
    const { ox, oz, billCenterY, angle, tIdx } = placements[i];
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const base = i * 4;

    // Quad verts: BL, BR, TR, TL — billboard width along road direction (local X rotated by angle around Y)
    // Y-axis rotation: x' = x*cos + z*sin, z' = -x*sin + z*cos. Since local z=0: x'=x*cos, z'=-x*sin
    const localX = [-hw, hw, hw, -hw];
    const localY = [-hh, -hh, hh, hh];
    for (let c = 0; c < 4; c++) {
      const vi = (base + c) * 3;
      positions[vi]     = ox + localX[c] * cos;
      positions[vi + 1] = billCenterY + localY[c];
      positions[vi + 2] = oz - localX[c] * sin;
    }

    // Atlas UVs — cell position in the 4×3 grid
    const col = tIdx % atlas.cols;
    const row = Math.floor(tIdx / atlas.cols);
    const u0 = col / atlas.cols;
    const u1 = (col + 1) / atlas.cols;
    const v0 = 1 - (row + 1) / atlas.rows;
    const v1 = 1 - row / atlas.rows;

    const ui = base * 2;
    uvs[ui]     = u1; uvs[ui + 1] = v0;  // BL — flip U for correct text reading
    uvs[ui + 2] = u0; uvs[ui + 3] = v0;  // BR
    uvs[ui + 4] = u0; uvs[ui + 5] = v1;  // TR
    uvs[ui + 6] = u1; uvs[ui + 7] = v1;  // TL

    // Two triangles per quad
    const ii = i * 6;
    indices[ii]     = base;
    indices[ii + 1] = base + 1;
    indices[ii + 2] = base + 2;
    indices[ii + 3] = base;
    indices[ii + 4] = base + 2;
    indices[ii + 5] = base + 3;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  geom.computeVertexNormals();

  const mesh = new THREE.Mesh(geom, getBillboardAtlasMaterial());
  mesh.frustumCulled = true;
  mesh.userData = { type: 'bridgeBillboard', noMerge: true };
  return [mesh];
}

// ---------------------------------------------------------------------------
// Debug: colored wireframe overlay — one wireframe mesh per road, colored by type
// ---------------------------------------------------------------------------
const DEBUG_WIRE_COLORS = {
  ground_0:  0x00ff00,  // layer 0 ground — green
  ground_1:  0x00ccff,  // layer 1 — cyan
  ground_2:  0x0066ff,  // layer 2 — blue
  ground_n1: 0xff00ff,  // layer -1 — magenta
  ground_n2: 0x9900cc,  // layer -2 — purple
  bridge:    0xff8800,  // bridge — orange
  ramp:      0xff0000,  // ramp/slope — red
  tunnel:    0xffff00,  // tunnel — yellow
  link:      0xff44aa,  // link roads — pink
};

function getDebugWireColor(road) {
  if (road.tunnel) return DEBUG_WIRE_COLORS.tunnel;
  if (road.isRamp) return DEBUG_WIRE_COLORS.ramp;
  if (road.bridge) return DEBUG_WIRE_COLORS.bridge;
  if (road.highwayType && road.highwayType.endsWith('_link')) return DEBUG_WIRE_COLORS.link;
  const layer = (road.layer != null && Number.isFinite(road.layer)) ? road.layer : 0;
  if (layer >= 2) return DEBUG_WIRE_COLORS.ground_2;
  if (layer === 1) return DEBUG_WIRE_COLORS.ground_1;
  if (layer === -1) return DEBUG_WIRE_COLORS.ground_n1;
  if (layer <= -2) return DEBUG_WIRE_COLORS.ground_n2;
  return DEBUG_WIRE_COLORS.ground_0;
}

/**
 * Build debug outline overlays for all roads in a tile.
 * Renders left/right edge ribbons and cross-hatches as thin flat quads
 * (0.4m wide) so they're clearly visible — WebGL LineSegments are always 1px.
 * Grouped by road type/color.
 */
function buildDebugRoadWireframes(roads, options) {
  const group = new THREE.Group();
  group.name = 'debugRoadWireframes';
  const Y_LIFT = 0.5;        // metres above road surface
  const RIBBON_W = 0.15;     // ribbon half-width in metres (total 0.3m visible)

  // Bucket: hex → { positions[], indices[], vertCount }
  const buckets = new Map();

  function getBucket(hex) {
    if (!buckets.has(hex)) buckets.set(hex, { pos: [], idx: [], vc: 0 });
    return buckets.get(hex);
  }

  // Add a flat quad ribbon segment between two points
  function addRibbon(hex, x1, y1, z1, x2, y2, z2) {
    const b = getBucket(hex);
    // Direction along segment
    const dx = x2 - x1, dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return;
    // Perpendicular in XZ plane
    const px = -dz / len * RIBBON_W, pz = dx / len * RIBBON_W;
    const base = b.vc;
    b.pos.push(
      x1 + px, y1 + Y_LIFT, z1 + pz,
      x1 - px, y1 + Y_LIFT, z1 - pz,
      x2 + px, y2 + Y_LIFT, z2 + pz,
      x2 - px, y2 + Y_LIFT, z2 - pz,
    );
    b.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    b.vc += 4;
  }

  for (const road of roads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const roadWidth = Number.isFinite(Number(road.width))
      ? Math.max(3, Math.min(30, Number(road.width)))
      : (WIDTH_BY_TYPE[road.highwayType] ?? 6);
    const half = roadWidth / 2;
    const heights = getRoadPointHeights(road, options);
    const hex = getDebugWireColor(road);

    let prevLx, prevLz, prevRx, prevRz, prevY;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const x = p.x, z = p.y;
      const y = Array.isArray(heights) ? (heights[i] ?? 0) : (heights ?? ROAD_OFFSET);

      let ddx, ddz;
      if (i === 0) { ddx = pts[1].x - x; ddz = pts[1].y - z; }
      else if (i === pts.length - 1) { ddx = x - pts[i-1].x; ddz = z - pts[i-1].y; }
      else { ddx = pts[i+1].x - pts[i-1].x; ddz = pts[i+1].y - pts[i-1].y; }
      const dl = Math.hypot(ddx, ddz) || 1;
      const nx = -ddz / dl, nz = ddx / dl;

      const lx = x + nx * half, lz = z + nz * half;
      const rx = x - nx * half, rz = z - nz * half;

      if (i > 0) {
        addRibbon(hex, prevLx, prevY, prevLz, lx, y, lz);
        addRibbon(hex, prevRx, prevY, prevRz, rx, y, rz);
      }
      // Cross-hatch every 5 points
      if (i % 5 === 0) {
        addRibbon(hex, lx, y, lz, rx, y, rz);
      }

      prevLx = lx; prevLz = lz;
      prevRx = rx; prevRz = rz;
      prevY = y;
    }
  }

  for (const [hex, b] of buckets) {
    if (b.pos.length === 0) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    geo.setIndex(b.idx);
    const mat = new THREE.MeshBasicMaterial({
      color: hex,
      side: THREE.DoubleSide,
      depthTest: false,
      transparent: true,
      opacity: 0.85,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 999;
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  return group.children.length > 0 ? group : null;
}

// ---------------------------------------------------------------------------
// Ramp divergence: laterally offset ramp start points toward the main road
// so the ramp peels off gradually instead of forking from the centerline.
// ---------------------------------------------------------------------------


/**
 * For each ramp, detect which endpoint connects to a wider main road and
 * shift the first/last N points laterally toward the main road's centerline.
 * Returns a new array of roads with modified point copies for ramps.
 */
function applyRampDivergence(roads) {
  // Build junction lookup: hash → [{ roadIdx, isStart, road }]
  const jMap = new Map();
  for (let ri = 0; ri < roads.length; ri++) {
    const road = roads[ri];
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    for (const isStart of [true, false]) {
      const p = isStart ? pts[0] : pts[pts.length - 1];
      const h = hashPoint(p.x, p.y, JUNCTION_TOLERANCE);
      if (!jMap.has(h)) jMap.set(h, []);
      jMap.get(h).push({ ri, isStart, road });
    }
  }

  // For each ramp, find the main road at its junction end
  const modified = roads.map((road) => road); // shallow copy array
  for (let ri = 0; ri < roads.length; ri++) {
    const road = roads[ri];
    if (!road.isRamp && !(road.highwayType && road.highwayType.endsWith('_link'))) continue;
    const pts = road.points;
    if (!pts || pts.length < 3) continue;

    const rampWidth = getRoadWidth(road);

    // Check both endpoints for a junction with a wider (main) road
    for (const isStart of [true, false]) {
      const ep = isStart ? pts[0] : pts[pts.length - 1];
      const h = hashPoint(ep.x, ep.y, JUNCTION_TOLERANCE);
      const group = jMap.get(h);
      if (!group || group.length < 2) continue;

      // Find the widest non-ramp road at this junction (the "main" road)
      let mainRoad = null;
      let mainWidth = 0;
      for (const entry of group) {
        if (entry.ri === ri) continue; // skip self
        const w = getRoadWidth(entry.road);
        if (w > mainWidth) {
          mainWidth = w;
          mainRoad = entry;
        }
      }
      if (!mainRoad || mainWidth <= rampWidth) continue;

      // Compute main road direction at the junction
      const mPts = mainRoad.road.points;
      if (!mPts || mPts.length < 2) continue;
      const mStart = mainRoad.isStart;
      // Direction: pointing away from junction along main road
      let mdx, mdz;
      if (mStart) {
        mdx = mPts[1].x - mPts[0].x;
        mdz = mPts[1].y - mPts[0].y;
      } else {
        const last = mPts.length - 1;
        mdx = mPts[last - 1].x - mPts[last].x;
        mdz = mPts[last - 1].y - mPts[last].y;
      }
      const mLen = Math.hypot(mdx, mdz);
      if (mLen < 0.01) continue;
      mdx /= mLen; mdz /= mLen;

      // Main road perpendicular (used for distance check below)
      const perpX = -mdz, perpZ = mdx;

      // Trim the ramp: remove points that fall inside the main road's half-width
      // so the ramp surface only starts where it visually exits the main road.
      const mainHalf = mainWidth / 2;
      // Walk from junction end; find where the ramp's perpendicular distance
      // from the main road centerline exceeds mainHalf (ramp exits main road).
      // Main road centerline point at junction
      const mJunc = mainRoad.isStart ? mPts[0] : mPts[mPts.length - 1];

      let trimCount = 0;
      for (let i = 0; i < pts.length; i++) {
        const idx = isStart ? i : (pts.length - 1 - i);
        const p = pts[idx];
        // Perpendicular distance from main road centerline (using main road direction)
        const dx = p.x - mJunc.x;
        const dz = p.y - mJunc.y;
        const perpDist = Math.abs(dx * perpX + dz * perpZ);
        if (perpDist >= mainHalf * 0.85) break; // outside main road — start ramp here
        trimCount++;
      }

      // Keep at least 2 points so the ramp still renders
      if (trimCount > 0 && trimCount < pts.length - 1) {
        const newPts = isStart
          ? pts.slice(trimCount)
          : pts.slice(0, pts.length - trimCount);
        if (newPts.length >= 2) {
          modified[ri] = { ...road, points: newPts };
        }
      }
      break; // only adjust one end per ramp
    }
  }
  return modified;
}

/**
 * Render all roads for a tile: merged ribbon meshes, Norma 8.2-IC road markings, sidewalks, edge strips, bridge pillars.
 * tileData: { roads }. options: { getElevationAt } for terrain.
 */
export async function renderTileRoads(tileData, options, yieldFn) {
  const rawRoads = tileData?.roads || [];
  if (rawRoads.length === 0) {
    return { roadMeshes: [], whiteMarkingsMesh: null, yellowMarkingsMesh: null, sidewalkMesh: null, edgeStripMesh: null, crosswalkMesh: null, onewayArrowMesh: null, bcnSidewalkMesh: null, bcnCurbMesh: null, bcnBikeLaneMesh: null, bcnBikePictoMesh: null, noParkingMesh: null, zona30Mesh: null, tactileMesh: null, bluezoneMesh: null, pillarMesh: null, blendStripMesh: null };
  }

  // Apply ramp divergence (lateral offset at junction ends)
  const roads = applyRampDivergence(rawRoads);

  // Check for pre-baked road surface data
  const bakedRoads = options?.bakedRoads;

  const roadMaterial = getSharedRoadMaterial();
  const roadMeshes = [];

  // Baked road geometry stores ABSOLUTE DEM Y (baked offline, no runtime offset). The rendered
  // frame is spawn-anchored, so the baked geometry must be normalized to (DEM−offset)*vertExag —
  // the same frame the runtime ribbon path produces via getRoadPointHeights → toNormalizedRoadY
  // (which already subtracts the offset; that is why markings draped but the baked surface floated
  // +offset). We bake the shift into the GEOMETRY (not mesh.position) because mergeMeshesByMaterial
  // merges raw geometries and drops per-mesh transforms. See gotchas G-44.
  const bakedOffset = options?.elevationOffset !== undefined
    ? options.elevationOffset : (getWorldElevationOffset() ?? 0);
  const bakedVertExag = vertExag();

  // Roads use the baked geometry, which is baked at the (now smoothed) DEM — so roads already drape on the
  // smoothed terrain (both read the same smoothed DEM). Forcing the runtime path produced spiking ribbons
  // (bridges/tunnels diving) and is unnecessary now that the bake conforms. (Cloth visual via the bake.)
  if (bakedRoads && Array.isArray(bakedRoads.layers) && bakedRoads.layers.length > 0) {
    // ─── Fast path: use pre-baked geometry ────────────────────────────────
    for (const bakedLayer of bakedRoads.layers) {
      if (!bakedLayer.positions || !bakedLayer.indices) continue;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(
        bakedLayer.positions instanceof Float32Array ? bakedLayer.positions : new Float32Array(bakedLayer.positions), 3));
      if (bakedLayer.normals) {
        geom.setAttribute('normal', new THREE.BufferAttribute(
          bakedLayer.normals instanceof Float32Array ? bakedLayer.normals : new Float32Array(bakedLayer.normals), 3));
      }
      if (bakedLayer.uvs) {
        geom.setAttribute('uv', new THREE.BufferAttribute(
          bakedLayer.uvs instanceof Float32Array ? bakedLayer.uvs : new Float32Array(bakedLayer.uvs), 2));
      }
      if (bakedLayer.halfWidths) {
        geom.setAttribute('halfWidth', new THREE.BufferAttribute(
          bakedLayer.halfWidths instanceof Float32Array ? bakedLayer.halfWidths : new Float32Array(bakedLayer.halfWidths), 1));
      }
      geom.setIndex(new THREE.BufferAttribute(
        bakedLayer.indices instanceof Uint32Array ? bakedLayer.indices : new Uint32Array(bakedLayer.indices), 1));
      applyRoadVertexColors(geom);
      // Normalize absolute baked Y into the spawn-anchored frame, baked into geometry so it
      // survives mergeMeshesByMaterial: Yrender = (DEM − offset) × vertExag.
      if (bakedVertExag !== 1) geom.scale(1, bakedVertExag, 1);
      // Normalize absolute baked Y to (DEM-offset)*vertExag AND lift above the terrain mesh (the baked path
      // skipped the ROAD_VISUAL_ABOVE_TERRAIN lift the runtime path applies → roads sat at terrain Y and got
      // occluded in dips). Lift baked into geometry so it survives mergeMeshesByMaterial.
      geom.translate(0, -bakedOffset * bakedVertExag + ROAD_VISUAL_ABOVE_TERRAIN, 0);
      const mesh = new THREE.Mesh(geom, roadMaterial);
      mesh.castShadow = false;
      mesh.receiveShadow = !!CONFIG.ENABLE_SHADOWS;
      mesh.frustumCulled = false; // tile-level LOD handles visibility
      mesh.userData = {
        highwayType: 'all',
        layer: bakedLayer.layer,
        sharedMaterial: true,
      };
      roadMeshes.push(mesh);
    }
  } else {
    // ─── Original path: build ribbon geometry per road ─────────────────────
    // Use rawRoads for junction width detection — diverged endpoints may not hash-match
    const junctionWidthMap = buildJunctionWidthMap(rawRoads, JUNCTION_TOLERANCE);

    // --- Build ribbon geometry per road, yielding every BATCH_SIZE to avoid jank ---
    const ROAD_BATCH = 25;
    const byLayer = new Map();
    const roadMeta = [];
    for (let ri = 0; ri < roads.length; ri++) {
      const road = roads[ri];
      const taperedWidths = computeTaperedWidths(road, junctionWidthMap, JUNCTION_TOLERANCE);
      const geom = createRoadMesh(road, options, taperedWidths);
      if (!geom) continue;
      const layer = road.layer != null && Number.isFinite(road.layer) ? road.layer : 0;
      if (!byLayer.has(layer)) byLayer.set(layer, []);
      byLayer.get(layer).push(geom);
      roadMeta.push({
        id: road.id,
        highwayType: road.highwayType || 'unclassified',
        layer,
        lanes: road.lanes,
        maxSpeed: road.maxSpeed,
        isOneWay: road.isOneWay,
      });
      if (yieldFn && (ri + 1) % ROAD_BATCH === 0) await yieldFn();
    }

    if (yieldFn) await yieldFn();

    // --- Merge by layer + apply vertex colors ---
    for (const [layer, geoms] of byLayer) {
      if (geoms.length === 0) continue;
      const merged = mergeGeometries(geoms);
      geoms.forEach((g) => g.dispose());
      if (merged) {
        if (!merged.attributes.uv) console.warn('[UV] Road merged geometry missing uv attribute (layer', layer, ')');
        applyRoadVertexColors(merged);
        const mesh = new THREE.Mesh(merged, roadMaterial);
        mesh.castShadow = false;
        mesh.receiveShadow = !!CONFIG.ENABLE_SHADOWS;
        mesh.frustumCulled = false; // tile-level LOD handles visibility
        mesh.userData = {
          highwayType: 'all',
          layer,
          roads: roadMeta.filter((r) => r.layer === layer),
          sharedMaterial: true,
        };
        roadMeshes.push(mesh);
      }
    }
  }

  if (yieldFn) await yieldFn();

  // --- Markings + sidewalks + crosswalks + one-way arrows + Phase 3 ---
  const { whiteMarkingsMesh, yellowMarkingsMesh } = buildRoadMarkings(roads, options);
  const { sidewalkMesh, edgeStripMesh } = buildSidewalkAndEdgeMeshes(roads, options);
  const crosswalkMesh      = buildCrosswalks(roads, options);
  const onewayArrowMesh    = buildOnewayArrows(roads, options);
  // Phase 3 Barcelona (OSM-driven sidewalks, curbs, bike infrastructure).
  // v8 tiles carry PRE-BAKED sidewalk/curb geometry (sidewalkBaker.js — pre-clipped, zero build
  // cost); v7 tiles fall back to the runtime generators, which must stay behaviour-identical.
  let bcnSidewalkMesh, bcnCurbMesh;
  if (options?.bakedSidewalks) {
    ({ sidewalkMesh: bcnSidewalkMesh, curbMesh: bcnCurbMesh } =
      buildBakedSidewalkMeshes(options.bakedSidewalks, bakedOffset, bakedVertExag));
  } else {
    bcnSidewalkMesh = buildSidewalks(roads, options);
    bcnCurbMesh     = buildCurbs(roads, options);
  }
  const bcnBikeLaneMesh    = buildBikeLanes(roads, options);
  const bcnBikePictoMesh   = buildBikePictograms(roads, options);
  // Phase 4A Barcelona (tram handled in tileManager via createTramMeshes; no-parking stripes here)
  const noParkingMesh      = buildNoParkingStripes(roads, options);
  // Phase 4C-A Barcelona (ZONA 30 stencils + tactile paving dots)
  const zona30Mesh         = buildZona30Stencils(roads, options);
  const tactileMesh        = buildTactilePaving(roads, options);
  // Phase 4C-B Barcelona (blue regulated parking stripes)
  const bluezoneMesh       = buildBlueZoneStripes(roads, options);

  if (yieldFn) await yieldFn();

  // --- Bridge structures ---
  const { mesh: pillarMesh, positions: pillarPositions } = buildBridgePillarMeshes(roads, options);
  const bridgeSlabMesh = buildBridgeSlabGeometry(roads, options);

  if (yieldFn) await yieldFn();

  const { wallMesh: bridgeGuardRailMesh, railingMesh: metalRailingMesh } = buildBridgeGuardRailGeometry(roads, options);
  const blendStripMesh = CONFIG.ENABLE_ROAD_SHOULDERS ? buildRoadsideBlendStrip(roads, options) : null;
  const bridgeShadowMesh = buildBridgeShadowMesh(roads, options);

  if (yieldFn) await yieldFn();

  // --- Billboards ---
  let bridgeBillboards = [];
  try { bridgeBillboards = buildBridgeBillboards(roads, options); }
  catch (e) { console.warn('Billboard build error:', e); }

  // --- Debug: colored wireframe overlay per road type ---
  let debugWireframeGroup = null;
  if (CONFIG.DEBUG_ROAD_WIREFRAMES) {
    debugWireframeGroup = buildDebugRoadWireframes(roads, options);
  }

  return {
    roadMeshes,
    whiteMarkingsMesh,
    yellowMarkingsMesh,
    sidewalkMesh,
    edgeStripMesh,
    crosswalkMesh,
    onewayArrowMesh,
    bcnSidewalkMesh,
    bcnCurbMesh,
    bcnBikeLaneMesh,
    bcnBikePictoMesh,
    noParkingMesh,
    zona30Mesh,
    tactileMesh,
    bluezoneMesh,
    pillarMesh,
    pillarPositions,
    bridgeSlabMesh,
    bridgeGuardRailMesh,
    metalRailingMesh,
    blendStripMesh,
    bridgeShadowMesh,
    bridgeBillboards,
    debugWireframeGroup,
  };
}

// ---------------------------------------------------------------------------
// Gore polygon rendering — triangulated wedge between diverging roads at
// merge/exit junctions. Data comes from backend MergeGeometryBuilder, stored
// in tile JSON as junctions[].gore { vertices (flat xyz), indices }.
// ---------------------------------------------------------------------------

/** Shared material for gore polygons — matches road asphalt colour. */
let goreMaterial = null;
function getGoreMaterial() {
  if (goreMaterial) return goreMaterial;
  // Same dark asphalt grey as road surface, slightly lighter to hint at paint/hatch
  goreMaterial = applyGroundLayer(new THREE.MeshStandardMaterial({
    color: 0x556270,
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide,
    depthWrite: true,
  }), 'gore');   // on asphalt, below all paint
  return goreMaterial;
}

/**
 * Build gore polygon meshes from junction data.
 * @param {Array} junctions — tile junctions (from mapLoader, world coords)
 * @returns {THREE.Mesh|null}
 */
export function buildGoreMeshes(junctions) {
  if (!junctions || junctions.length === 0) return null;
  const geoms = [];
  for (const j of junctions) {
    if (j.type !== 'merge_exit' || !j.gore) continue;
    const { vertices, indices } = j.gore;
    if (!vertices || vertices.length < 9 || !indices || indices.length < 3) continue;
    const vertCount = vertices.length / 3;
    let validIndices = true;
    for (let k = 0; k < indices.length; k++) {
      if (indices[k] >= vertCount) { validIndices = false; break; }
    }
    if (!validIndices) continue; // corrupt data — skip

    const posArr = new Float32Array(vertices.length);
    for (let i = 0; i < vertices.length; i += 3) {
      posArr[i]     = vertices[i];     // x (world)
      posArr[i + 1] = vertices[i + 1] + 0.06; // y — slight lift above road surface
      posArr[i + 2] = vertices[i + 2]; // z (world)
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geom.setIndex([...indices]);
    geom.computeVertexNormals();
    geoms.push(geom);
  }
  if (geoms.length === 0) return null;

  const merged = mergeGeometries(geoms);
  geoms.forEach((g) => g.dispose());
  if (!merged) return null;

  const mesh = new THREE.Mesh(merged, getGoreMaterial());
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  mesh.userData.type = 'gorePolygon';
  return mesh;
}

// ─── Chamfered intersection fill (Phase 4B-1) ─────────────────────────────────
// Octagonal asphalt polygon at Eixample-scale crossing junctions.
// Replaces the bare terrain void left by road ribbon clipping.

let _chamferMaterial = null;
function getChamferMaterial() {
  if (_chamferMaterial) return _chamferMaterial;
  // Match gore polygon style — solid asphalt, slightly above terrain
  _chamferMaterial = applyGroundLayer(new THREE.MeshLambertMaterial({
    color: 0x4a4a4a,   // BCN_COLORS.ASPHALT_BASE
  }), 'gore');   // junction chamfer fill: same slot as gores — asphalt-plane fills under paint
  return _chamferMaterial;
}

/**
 * Returns true if this junction should receive a chamfered asphalt fill.
 * Targets Eixample-style orthogonal grid crossings; excludes narrow Gràcia alleys,
 * Diagonal skew crossings, roundabouts, and merge/exit ramps.
 */
function isChamferEligibleJunction(j) {
  if (j.type !== 'crossing') return false;
  const apps = j.approaches;
  if (!apps || apps.length < 3) return false;  // need at least 3 roads
  if (!j.radius || j.radius < 8) return false; // narrow streets excluded (< 8m road width)

  const angles = apps.map(a => a.angle).sort((a, b) => a - b);
  const TWO_PI = 2 * Math.PI;
  const TOL = 20 * Math.PI / 180; // 20° tolerance around 90°

  if (angles.length >= 4) {
    // 4-way: every adjacent pair should be ~90° apart (wrapping last→first)
    for (let i = 0; i < angles.length; i++) {
      const next = angles[(i + 1) % angles.length];
      let diff = next - angles[i];
      if (diff < 0) diff += TWO_PI;
      if (Math.abs(diff - Math.PI / 2) > TOL) return false;
    }
    return true;
  } else if (angles.length === 3) {
    // T-intersection: at least one pair of adjacent approaches should be ~90°
    for (let i = 0; i < angles.length; i++) {
      const next = angles[(i + 1) % angles.length];
      let diff = next - angles[i];
      if (diff < 0) diff += TWO_PI;
      if (Math.abs(diff - Math.PI / 2) <= TOL) return true;
    }
    return false;
  }
  return false;
}

/**
 * Compute world-space vertices for the octagonal (or hexagonal for T-intersections) chamfer fill polygon.
 * Returns [{x, z}] in CCW order, relative to world origin, or null if degenerate.
 */
function chamferPolygonVertices(junction) {
  const { x: jx, z: jz, radius: R, approaches } = junction;
  if (!R || R <= 0 || !approaches?.length) return null;

  // Sort approaches CCW by angle (already sorted from bake, but ensure here)
  const apps = [...approaches].sort((a, b) => a.angle - b.angle);
  const n = apps.length;

  // For each approach i, compute the two edge endpoints at the clip boundary:
  //   edgeA (+perp / CW side, toward next approach in CCW order): R*dir + h*perp_right
  //   edgeB (-perp / CCW side, toward prev approach): R*dir - h*perp_right
  // where dir = (cosθ, sinθ), perp_right = (sinθ, -cosθ)
  const edgeA = new Array(n);
  const edgeB = new Array(n);
  for (let i = 0; i < n; i++) {
    const { angle: θ, width: w } = apps[i];
    const h = w / 2;
    const cosT = Math.cos(θ), sinT = Math.sin(θ);
    edgeA[i] = { x: R * cosT + h * sinT, z: R * sinT - h * cosT };
    edgeB[i] = { x: R * cosT - h * sinT, z: R * sinT + h * cosT };
  }

  // Polygon CCW: [edgeB_0, edgeA_1, edgeB_1, edgeA_2, ..., edgeB_{n-1}, edgeA_0]
  const verts = [];
  for (let i = 0; i < n; i++) {
    verts.push(edgeB[i]);
    verts.push(edgeA[(i + 1) % n]);
  }

  // Translate to world coords
  return verts.map(v => ({ x: jx + v.x, z: jz + v.z }));
}

/**
 * Build a single chamfer fill BufferGeometry for one junction.
 * Uses fan triangulation from vertex 0 (valid for convex polygons).
 */
function buildChamferFillGeometry(junction, options) {
  const verts = chamferPolygonVertices(junction);
  if (!verts || verts.length < 3) return null;

  // Terrain height at junction center
  const { lat, lon } = worldToLatLon(junction.x, junction.z);
  let baseY = options?.getElevationAt ? options.getElevationAt(lat, lon) : 0;
  if (!Number.isFinite(baseY)) baseY = 0;
  const scale = CONFIG.ELEVATION_VERTICAL_EXAGGERATION ?? 1;
  // Match road surface: (baseY + ROAD_OFFSET) * scale + ROAD_VISUAL_ABOVE_TERRAIN
  const y = (baseY + ROAD_OFFSET) * scale + ROAD_VISUAL_ABOVE_TERRAIN + ROAD_ZFIGHT_OFFSET + 0.01;

  const n = verts.length;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3]     = verts[i].x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = verts[i].z;
  }

  // Fan triangulation from vertex 0 (convex polygon)
  const idxArr = new Uint32Array((n - 2) * 3);
  for (let i = 1; i < n - 1; i++) {
    idxArr[(i - 1) * 3]     = 0;
    idxArr[(i - 1) * 3 + 1] = i;
    idxArr[(i - 1) * 3 + 2] = i + 1;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setIndex(new THREE.BufferAttribute(idxArr, 1));
  geom.computeVertexNormals();
  return geom;
}

/**
 * Build merged asphalt fill mesh for all chamfer-eligible junctions in a tile.
 * @param {object[]} junctions — tile junctions with radius + approaches (Phase 4B-1 bake)
 * @param {{ getElevationAt?: Function }} [options]
 * @returns {THREE.Mesh|null}
 */
export function buildChamferFills(junctions, options) {
  if (!CONFIG.ENABLE_CHAMFER_FILLS || !junctions?.length) return null;

  const geoms = [];
  let eligible = 0, skipped = 0;

  for (const j of junctions) {
    if (!isChamferEligibleJunction(j)) continue;
    eligible++;
    const g = buildChamferFillGeometry(j, options);
    if (g) geoms.push(g);
    else skipped++;
  }

  if (!geoms.length) return null;
  const merged = mergeGeometries(geoms);
  geoms.forEach(g => g.dispose());
  if (!merged) return null;

  const mesh = new THREE.Mesh(merged, getChamferMaterial());
  mesh.castShadow = false;
  mesh.receiveShadow = !!CONFIG.ENABLE_SHADOWS;
  mesh.frustumCulled = true;
  mesh.userData = { type: 'chamferFill', sharedMaterial: true, eligible, skipped };
  return mesh;
}

// ─── Phase 4B-2: chamfer corner sidewalk triangles + diagonal curb ────────────

/** Resolve sidewalk width for a given road width (mirrors buildSidewalks logic). */
function _swWidthForRoadWidth(roadWidth) {
  if (roadWidth >= 25) return BCN_DIMS.SIDEWALK_WIDTH_BOULEVARD;
  if (roadWidth < 12)  return BCN_DIMS.SIDEWALK_WIDTH_NARROW;
  return BCN_DIMS.SIDEWALK_WIDTH_EIXAMPLE;
}

/**
 * For each adjacent approach pair of a chamfer junction, compute the triangular
 * panot sidewalk fill at the corner and the diagonal curb strip.
 * Returns { swGeoms, curbGeoms } arrays (to be merged by callers).
 */
function _chamferCornerGeoms(junction, options) {
  const { x: jx, z: jz, radius: R, approaches } = junction;
  const apps = [...approaches].sort((a, b) => a.angle - b.angle);
  const n = apps.length;

  const { lat, lon } = worldToLatLon(jx, jz);
  let baseY = options?.getElevationAt ? options.getElevationAt(lat, lon) : 0;
  if (!Number.isFinite(baseY)) baseY = 0;
  const scale = CONFIG.ELEVATION_VERTICAL_EXAGGERATION ?? 1;
  const roadY = (baseY + ROAD_OFFSET) * scale + ROAD_VISUAL_ABOVE_TERRAIN + ROAD_ZFIGHT_OFFSET;
  const swY   = roadY + BCN_DIMS.CURB_HEIGHT + 0.005;  // sidewalk: atop curb + z-fight margin
  const curbTopY = roadY + BCN_DIMS.CURB_HEIGHT;

  const swGeoms   = [];
  const curbGeoms = [];

  for (let i = 0; i < n; i++) {
    const iNext = (i + 1) % n;
    const { angle: θA, width: wA } = apps[i];
    const { angle: θB, width: wB } = apps[iNext];
    const hA = wA / 2, hB = wB / 2;
    const cosA = Math.cos(θA), sinA = Math.sin(θA);
    const cosB = Math.cos(θB), sinB = Math.sin(θB);

    const swA  = _swWidthForRoadWidth(wA);
    const swB  = _swWidthForRoadWidth(wB);
    const CURB = BCN_DIMS.CURB_WIDTH;

    // Outer sidewalk offset from road center for each approach (to outer edge of sidewalk)
    const outA = hA + CURB + swA;  // road_half + curb_w + sw_width
    const outB = hB + CURB + swB;

    // --- SIDEWALK TRIANGLE ---
    // V1: outer edge of approach A, left side (facing B)
    const v1x = jx + R * cosA - outA * sinA;
    const v1z = jz + R * sinA + outA * cosA;
    // V2: outer edge of approach B, right side (facing A)
    const v2x = jx + R * cosB + outB * sinB;
    const v2z = jz + R * sinB - outB * cosB;
    // V3: outer corner where the two sidewalk outer edges meet
    const v3x = jx + outB * cosA + outA * cosB;
    const v3z = jz + outB * sinA + outA * sinB;

    // Build triangle
    const swPos = new Float32Array([
      v1x, swY, v1z,
      v2x, swY, v2z,
      v3x, swY, v3z,
    ]);
    const swIdx = new Uint32Array([0, 1, 2]);
    const swGeom = new THREE.BufferGeometry();
    swGeom.setAttribute('position', new THREE.BufferAttribute(swPos, 3));
    // World-space UV for panot tiling (0.2m per tile)
    const uvScale = 1 / BCN_DIMS.PANOT_TILE_SIZE;
    const uvArr = new Float32Array([
      v1x * uvScale, v1z * uvScale,
      v2x * uvScale, v2z * uvScale,
      v3x * uvScale, v3z * uvScale,
    ]);
    swGeom.setAttribute('uv', new THREE.Float32BufferAttribute(uvArr, 2));
    // halfWidth attribute required for merge consistency with bcnSidewalks
    swGeom.setAttribute('halfWidth', new THREE.Float32BufferAttribute(new Float32Array(3).fill(swA / 2), 1));
    swGeom.setIndex(new THREE.BufferAttribute(swIdx, 1));
    swGeom.computeVertexNormals();
    swGeoms.push(swGeom);

    // --- DIAGONAL CURB ---
    // Inner road edge of approach A (left side = edgeB_A)
    const iaX = jx + R * cosA - hA * sinA,  iaZ = jz + R * sinA + hA * cosA;
    // Inner road edge of approach B (right side = edgeA_B)
    const ibX = jx + R * cosB + hB * sinB,  ibZ = jz + R * sinB - hB * cosB;
    // Outer curb edge of A side (shifted by CURB_WIDTH outward)
    const oaX = jx + R * cosA - (hA + CURB) * sinA,  oaZ = jz + R * sinA + (hA + CURB) * cosA;
    // Outer curb edge of B side
    const obX = jx + R * cosB + (hB + CURB) * sinB,  obZ = jz + R * sinB - (hB + CURB) * cosB;

    // Top face (horizontal strip at curb top height)
    const topPos = new Float32Array([
      iaX, curbTopY, iaZ,  ibX, curbTopY, ibZ,  oaX, curbTopY, oaZ,
      oaX, curbTopY, oaZ,  ibX, curbTopY, ibZ,  obX, curbTopY, obZ,
    ]);
    const topUV = new Float32Array(12).fill(0);
    // halfWidth not needed for curb — add dummy to stay consistent with gTop
    const topHW = new Float32Array(6).fill(CURB / 2);
    const topGeom = new THREE.BufferGeometry();
    topGeom.setAttribute('position', new THREE.BufferAttribute(topPos, 3));
    topGeom.setAttribute('uv', new THREE.Float32BufferAttribute(topUV, 2));
    topGeom.setAttribute('halfWidth', new THREE.Float32BufferAttribute(topHW, 1));
    topGeom.computeVertexNormals();
    curbGeoms.push(topGeom);

    // Outer vertical face
    const vtPos = new Float32Array([
      oaX, curbTopY, oaZ,  obX, curbTopY, obZ,  oaX, roadY, oaZ,
      oaX, roadY, oaZ,     obX, curbTopY, obZ,   obX, roadY, obZ,
    ]);
    const vtUV = new Float32Array(12).fill(0);
    const vtHW = new Float32Array(6).fill(CURB / 2);
    const vtGeom = new THREE.BufferGeometry();
    vtGeom.setAttribute('position', new THREE.BufferAttribute(vtPos, 3));
    vtGeom.setAttribute('normal',   new THREE.BufferAttribute(new Float32Array(18).fill(0), 3));
    vtGeom.setAttribute('uv',       new THREE.Float32BufferAttribute(vtUV, 2));
    vtGeom.setAttribute('halfWidth', new THREE.Float32BufferAttribute(vtHW, 1));
    vtGeom.computeVertexNormals();
    curbGeoms.push(vtGeom);
  }

  return { swGeoms, curbGeoms };
}

/**
 * Triangular panot sidewalk fills at each chamfer corner.
 * Completes the sidewalk wrap at Eixample-style 4-way intersections (Phase 4B-2).
 */
export function buildChamferSidewalks(junctions, options) {
  if (!CONFIG.ENABLE_CHAMFER_SIDEWALKS || !junctions?.length) return null;
  const geoms = [];
  for (const j of junctions) {
    if (!isChamferEligibleJunction(j)) continue;
    const { swGeoms } = _chamferCornerGeoms(j, options);
    geoms.push(...swGeoms);
  }
  if (!geoms.length) return null;
  const merged = mergeGeometries(geoms);
  geoms.forEach(g => g.dispose());
  if (!merged) return null;
  const mesh = new THREE.Mesh(merged, getPanotMaterial());
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  mesh.userData = { sharedMaterial: true, type: 'chamferSidewalk', noMerge: true };
  return mesh;
}

/**
 * Short L-profile diagonal curb along each chamfer edge (Phase 4B-2).
 * Connects the two adjacent road curbs across the chamfer cut.
 */
export function buildChamferCurbs(junctions, options) {
  if (!CONFIG.ENABLE_CHAMFER_CURBS || !junctions?.length) return null;
  const geoms = [];
  for (const j of junctions) {
    if (!isChamferEligibleJunction(j)) continue;
    const { curbGeoms } = _chamferCornerGeoms(j, options);
    geoms.push(...curbGeoms);
  }
  if (!geoms.length) return null;
  const merged = mergeGeometries(geoms);
  geoms.forEach(g => g.dispose());
  if (!merged) return null;
  const mesh = new THREE.Mesh(merged, getCurbMaterial());
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  mesh.userData = { sharedMaterial: true, type: 'chamferCurb', noMerge: true };
  return mesh;
}

/**
 * Create all road-related meshes for a tile (roads, markings, sidewalks, edge strips, bridge pillars).
 * @param {object[]} roads
 * @param {{ getElevationAt?: (lat: number, lon: number) => number }} [options]
 * @returns {THREE.Mesh[]}
 */
export async function createRoadMeshes(roads, options, yieldFn) {
  const result = await renderTileRoads({ roads: roads || [] }, options, yieldFn);
  const meshes = [...result.roadMeshes];
  if (result.whiteMarkingsMesh) meshes.push(result.whiteMarkingsMesh);
  if (result.yellowMarkingsMesh) meshes.push(result.yellowMarkingsMesh);
  if (result.sidewalkMesh) meshes.push(result.sidewalkMesh);
  if (result.edgeStripMesh) meshes.push(result.edgeStripMesh);
  if (result.crosswalkMesh)    meshes.push(result.crosswalkMesh);
  if (result.onewayArrowMesh)  meshes.push(result.onewayArrowMesh);
  if (result.bcnSidewalkMesh)  meshes.push(result.bcnSidewalkMesh);
  if (result.bcnCurbMesh)      meshes.push(result.bcnCurbMesh);
  if (result.bcnBikeLaneMesh)  meshes.push(result.bcnBikeLaneMesh);
  if (result.bcnBikePictoMesh) meshes.push(result.bcnBikePictoMesh);
  if (result.noParkingMesh)    meshes.push(result.noParkingMesh);
  if (result.zona30Mesh)       meshes.push(result.zona30Mesh);
  if (result.tactileMesh)      meshes.push(result.tactileMesh);
  if (result.bluezoneMesh)     meshes.push(result.bluezoneMesh);
  if (result.pillarMesh) meshes.push(result.pillarMesh);
  if (result.bridgeSlabMesh) meshes.push(result.bridgeSlabMesh);
  if (result.bridgeGuardRailMesh) meshes.push(result.bridgeGuardRailMesh);
  if (result.metalRailingMesh) meshes.push(result.metalRailingMesh);
  if (result.blendStripMesh) meshes.push(result.blendStripMesh);
  if (result.bridgeShadowMesh) meshes.push(result.bridgeShadowMesh);
  if (result.bridgeBillboards) meshes.push(...result.bridgeBillboards);
  if (result.debugWireframeGroup) meshes.push(result.debugWireframeGroup);
  meshes._pillarPositions = result.pillarPositions || [];
  return meshes;
}
