/**
 * Environment filler clusters: groups of rocks + bushes placed in large empty
 * green terrain areas. Two shared InstancedMeshes per tile (rocks + bushes).
 * 5 cluster templates with randomised rotation/scale for natural variety.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { worldToLatLon, latLonToWorld } from '../projection.js';
import { isVegetationAllowed, isInsideOrNearBuilding, isOnAnyRoad } from './vegetationMask.js';
import { getTreeGeometries, getTreeMaterial, getBushGeometries, getBushCardsMaterial, getBushVariantCount } from './vegetationRenderer.js';
import { classifySpecies as classifyTreeSpecies, classifyBush, seededRand } from './treeSpeciesSets.js';
import { loadCardAtlas } from './cardMesh.js';
import { patchMaterial } from './materialRegistry.js';
import ROCK_ATLAS from './rockAtlas.js';

// ---------------------------------------------------------------------------
// Deterministic PRNG (same as vegetationRenderer)
// ---------------------------------------------------------------------------
function seeded(i, s) {
  const x = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// ---------------------------------------------------------------------------
// Shared geometry / materials (lazy-init, cached globally)
// ---------------------------------------------------------------------------
let _rockGeo = null;
let _rockMat = null;
function getRockGeometry() {
  if (_rockGeo) return _rockGeo;
  _rockGeo = new THREE.IcosahedronGeometry(1, 0); // 20 tris (was detail 1 = 80); the per-vertex distortion below still reads as an organic rock
  // Distort vertices for organic look
  const pos = _rockGeo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const nx = pos.getX(i), ny = pos.getY(i), nz = pos.getZ(i);
    const noise = 0.8 + Math.abs(Math.sin(nx * 5.1 + ny * 3.7) * Math.cos(nz * 4.3 + nx * 2.1)) * 0.4;
    pos.setXYZ(i, nx * noise, ny * noise * 0.6, nz * noise);
  }
  _rockGeo.translate(0, 0.3, 0);
  _rockGeo.computeVertexNormals();
  return _rockGeo;
}

/**
 * Stone material — three real Barcelona stones in one 1024 page.
 *
 * ONE MATERIAL, ONE DRAW CALL. The cell is picked PER INSTANCE via an instanced attribute rather
 * than by giving each stone its own material: rocks scatter across every wild tile, and three
 * materials would have tripled their draw calls across 9-18 resident tiles. That is the opposite of
 * what P3-10(c) just did to the tree impostors.
 *
 * The page is 1024, not 2048. VRAM is uncompressed RGBA plus mips, so 2048 costs 42.7 MiB across
 * albedo and normal — tree-atlas money for background boulders. 1024 costs 10.7 MiB and still gives
 * ~256 texels per real metre on a 2 m rock.
 */
function getRockMaterial() {
  if (_rockMat) return _rockMat;
  const { albedo, normal } = loadCardAtlas(
    '/textures/vegetation/rock_atlas_albedo.ktx2',
    '/textures/vegetation/rock_atlas_normal.ktx2');
  _rockMat = new THREE.MeshLambertMaterial({ color: 0xffffff, map: albedo, normalMap: normal });
  // AD-5: the normal map is calibrated at bake into the §3.7 masonry band, so 1.0 is correct.
  _rockMat.normalScale = new THREE.Vector2(1.0, 1.0);

  patchMaterial(_rockMat, (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aRockCell;')
      // The icosahedron's own spherical UVs are kept and simply squeezed into the instance's atlas
      // cell, so each boulder wears one stone rather than a slice of all three.
      .replace('#include <uv_vertex>',
        `#include <uv_vertex>
        vMapUv = aRockCell + fract(vMapUv) * vec2(${(1 / ROCK_ATLAS.cols).toFixed(6)}, ${(1 / ROCK_ATLAS.rows).toFixed(6)});
        vNormalMapUv = vMapUv;`);
  }, 'envRock');
  return _rockMat;
}

/** Per-instance atlas-cell origins, as an instanced attribute the shader reads. */
function buildRockCellAttribute(instances) {
  const n = ROCK_ATLAS.stones.length;
  const arr = new Float32Array(instances.length * 2);
  for (let i = 0; i < instances.length; i++) {
    const r = instances[i];
    // Position-seeded, like the bushes: a boulder keeps its stone whatever order it materialises in.
    const pick = ROCK_ATLAS.stones[
      Math.floor(seededRand(Math.round(r.x * 5.1), Math.round(r.z * 2.7)) * n) % n];
    arr[i * 2] = pick.uv[0];
    arr[i * 2 + 1] = pick.uv[1];
  }
  return new THREE.InstancedBufferAttribute(arr, 2);
}

/**
 * Tree geometry for a background/hillside cluster item.
 *
 * v3 P3-10 follow-up: this used to be a straight `variantIdx % geos.length`, i.e. uniform random
 * across all six card species — which put Washingtonia palms and bitter-orange ornamentals on
 * Collserola hillsides. Cluster trees are wild broadleaf, so they classify under the 'hill' set.
 * On the blob path classifySpecies returns the modulo untouched, so nothing changes there.
 */
function getClusterTreeGeometry(variantIdx) {
  const geos = getTreeGeometries();
  return geos[classifyTreeSpecies('hill', variantIdx, 85, geos.length, variantIdx)];
}

// ---------------------------------------------------------------------------
// Cluster templates
// Offsets are relative to cluster center. type: 'rock' | 'bush' | 'tree'
// ---------------------------------------------------------------------------
const CLUSTER_TEMPLATES = [
  { // A: large rock + 3 bushes
    items: [
      { type: 'rock', dx: 0, dz: 0, scale: 1.8 },
      { type: 'bush', dx: 2.2, dz: 0.8, scale: 1.1 },
      { type: 'bush', dx: -1.8, dz: 1.4, scale: 0.9 },
      { type: 'bush', dx: 0.5, dz: -2.0, scale: 1.0 },
    ],
  },
  { // B: 2 medium rocks + bushes
    items: [
      { type: 'rock', dx: -1.2, dz: 0.5, scale: 1.3 },
      { type: 'rock', dx: 1.5, dz: -0.8, scale: 1.1 },
      { type: 'bush', dx: 0, dz: 1.8, scale: 1.0 },
      { type: 'bush', dx: -0.5, dz: -1.5, scale: 0.8 },
    ],
  },
  { // C: small tree + 2 bushes + 1 rock
    items: [
      { type: 'tree', dx: 0, dz: 0, scale: 1.0 },
      { type: 'bush', dx: 1.8, dz: 0.6, scale: 1.0 },
      { type: 'bush', dx: -1.5, dz: 1.2, scale: 0.9 },
      { type: 'rock', dx: 1.0, dz: -1.6, scale: 0.9 },
    ],
  },
  { // D: 3 bushes
    items: [
      { type: 'bush', dx: 0, dz: 0, scale: 1.3 },
      { type: 'bush', dx: 1.6, dz: 1.0, scale: 1.0 },
      { type: 'bush', dx: -1.2, dz: 0.8, scale: 1.1 },
    ],
  },
  { // E: single large rock with bushes around it
    items: [
      { type: 'rock', dx: 0, dz: 0, scale: 2.2 },
      { type: 'bush', dx: 2.5, dz: 0, scale: 1.0 },
      { type: 'bush', dx: -2.0, dz: 1.5, scale: 0.9 },
      { type: 'bush', dx: 0.8, dz: -2.2, scale: 1.1 },
      { type: 'bush', dx: -1.0, dz: -1.8, scale: 0.8 },
    ],
  },
  { // F: tree + rocks + bushes — Delhi roadside style
    items: [
      { type: 'tree', dx: 0, dz: 0, scale: 1.2 },
      { type: 'rock', dx: 1.5, dz: 1.0, scale: 1.0 },
      { type: 'rock', dx: -1.0, dz: -1.5, scale: 0.7 },
      { type: 'bush', dx: 2.0, dz: -0.5, scale: 1.0 },
      { type: 'bush', dx: -2.2, dz: 0.8, scale: 1.1 },
      { type: 'bush', dx: 0.5, dz: 2.0, scale: 0.8 },
    ],
  },
  { // G: scattered rocks with bushes between — rubble patch
    items: [
      { type: 'rock', dx: 0, dz: 0, scale: 1.5 },
      { type: 'rock', dx: 2.0, dz: 1.2, scale: 0.8 },
      { type: 'rock', dx: -1.5, dz: -1.0, scale: 1.0 },
      { type: 'rock', dx: 0.8, dz: -2.0, scale: 0.6 },
      { type: 'bush', dx: 1.0, dz: 0.5, scale: 0.9 },
      { type: 'bush', dx: -0.8, dz: 1.5, scale: 1.0 },
    ],
  },
  { // H: twin trees + rock border — mini grove
    items: [
      { type: 'tree', dx: -1.5, dz: 0, scale: 1.0 },
      { type: 'tree', dx: 1.5, dz: 0, scale: 0.9 },
      { type: 'rock', dx: 0, dz: 2.0, scale: 1.2 },
      { type: 'bush', dx: 0, dz: -1.8, scale: 1.1 },
      { type: 'bush', dx: -2.5, dz: 1.2, scale: 0.9 },
      { type: 'bush', dx: 2.5, dz: 1.2, scale: 0.8 },
    ],
  },

  // ── WOODLAND templates (indices WOODLAND_FIRST..end) ────────────────────────────────────────
  // The eight above are urban roadside compositions — rock-and-rubble dressing with at most two
  // trees, and only three of them carry a tree at all. Scattered across Collserola they produce a
  // rubble field, not a forest. These are tree-DOMINANT and drop the rocks almost entirely.
  { // W1: dense stand
    items: [
      { type: 'tree', dx: 0, dz: 0, scale: 1.15 },
      { type: 'tree', dx: 4.2, dz: 1.6, scale: 1.0 },
      { type: 'tree', dx: -3.6, dz: 2.4, scale: 1.05 },
      { type: 'tree', dx: 1.2, dz: -4.0, scale: 0.9 },
      { type: 'bush', dx: -1.4, dz: -1.8, scale: 1.0 },
    ],
  },
  { // W2: open stand with undergrowth
    items: [
      { type: 'tree', dx: 0, dz: 0, scale: 1.25 },
      { type: 'tree', dx: -5.0, dz: -1.2, scale: 0.95 },
      { type: 'bush', dx: 2.4, dz: 1.6, scale: 1.2 },
      { type: 'bush', dx: -2.0, dz: 2.6, scale: 1.0 },
      { type: 'bush', dx: 3.0, dz: -2.2, scale: 0.9 },
    ],
  },
  { // W3: thicket
    items: [
      { type: 'tree', dx: 0, dz: 0, scale: 1.0 },
      { type: 'tree', dx: 3.0, dz: -2.8, scale: 1.1 },
      { type: 'tree', dx: -2.6, dz: -3.2, scale: 0.85 },
      { type: 'tree', dx: -4.4, dz: 1.8, scale: 1.0 },
      { type: 'tree', dx: 2.2, dz: 3.6, scale: 0.95 },
      { type: 'bush', dx: 0.6, dz: 1.2, scale: 1.1 },
    ],
  },
  { // W4: scrub margin — the edge of a stand, where woodland meets open ground
    items: [
      { type: 'tree', dx: 0, dz: 0, scale: 0.85 },
      { type: 'bush', dx: 2.6, dz: 0.8, scale: 1.3 },
      { type: 'bush', dx: -2.2, dz: 1.6, scale: 1.1 },
      { type: 'bush', dx: 0.4, dz: -2.4, scale: 1.2 },
      { type: 'rock', dx: -3.0, dz: -1.4, scale: 0.8 },
    ],
  },
];

/** Index of the first WOODLAND template. Everything before it is urban roadside dressing. */
const WOODLAND_FIRST = CLUSTER_TEMPLATES.length - 4;

// A zoom-16 tile is ~500x500 m = 250,000 m². At spacing 25 the theoretical maximum is 400 clusters,
// so the cap was the real limit: 120 clusters is one per ~2,000 m², which reads as an occasional
// bush rather than a wooded slope. Raised now that the bbox covers the whole tile (see getTileBbox)
// — before this, most of those clusters had nowhere to go anyway.
const CLUSTER_SPACING = 18;   // metres between cluster centres
const MAX_CLUSTERS_PER_TILE = 340;

// ── WILD TERRAIN ──────────────────────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS AND IS NOT DRIVEN BY OSM. Barcelona is wrapped in the Serra de Collserola, a
// forested natural park, and the entire baked region contains TEN `forest` polygons and twelve
// `scrub` (against 409 grass and 380 garden). The woodland is mapped as multipolygon relations and
// the bake reads ways only — but even with that fixed, OSM's coverage of open ground is not
// something to build a landscape on. Waiting for the data to describe a hillside means the hillside
// stays bare grass, which is what it looked like.
//
// So on ground the map says nothing about, the renderer makes the call: no roads, no buildings and
// no greens means WILD, and wild means wooded. This is generated, not surveyed, and it is meant to
// be — the alternative on offer is an empty green dome.
const WILD_MAX_CLUSTERS = 620;   // vs 340 urban: a hillside is denser than a verge
const OPEN_RADIUS = 32;          // metres of clear ground that makes a spot "open country"
const OPEN_RING_SAMPLES = 8;

/** Value noise in [0,1] — clumps woodland into stands and clearings instead of an even scatter. */
function _hash2(ix, iz) {
  const h = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function standDensity(x, z, scale) {
  const fx = x / scale, fz = z / scale;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const tx = fx - ix, tz = fz - iz;
  const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
  const a = _hash2(ix, iz),     b = _hash2(ix + 1, iz);
  const c = _hash2(ix, iz + 1), d = _hash2(ix + 1, iz + 1);
  return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sz;
}

/**
 * Is THIS SPOT open country?
 *
 * This was originally a per-TILE test — no buildings, no greens, few roads — and it was useless
 * exactly where it mattered. A zoom-16 tile is 500x500 m, and on the city edge where Vallvidrera
 * housing runs up into Collserola every tile holds a few blocks, so one building disqualified half
 * a square kilometre of hillside. Openness is a property of a PLACE, not of a tile.
 *
 * Cheap by construction: the vegetation mask is already a rasterised grid of everything roads and
 * buildings occupy, so "is there clear ground for 32 m around" is a ring of 8 lookups plus the
 * centre. A true margin test would be exact but the mask is 0.5 m per cell, which makes a 32 m
 * margin ~20,000 cell reads per candidate — thousands of candidates per tile makes that unaffordable.
 * The ring can miss a thin spur poking into the circle; the per-item checks downstream catch those.
 */
/** Point-in-polygon with a bbox prefilter — greens are few per tile but can be large. */
function insideAnyGreen(greens, x, z) {
  for (let g = 0; g < greens.length; g++) {
    const poly = greens[g].polygon;
    if (!poly || poly.length < 3) continue;
    let mnX = Infinity, mxX = -Infinity, mnZ = Infinity, mxZ = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const px = poly[i][0] ?? poly[i].x, pz = poly[i][1] ?? poly[i].y;
      if (px < mnX) mnX = px; if (px > mxX) mxX = px;
      if (pz < mnZ) mnZ = pz; if (pz > mxZ) mxZ = pz;
    }
    if (x < mnX || x > mxX || z < mnZ || z > mxZ) continue;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0] ?? poly[i].x, zi = poly[i][1] ?? poly[i].y;
      const xj = poly[j][0] ?? poly[j].x, zj = poly[j][1] ?? poly[j].y;
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

function isOpenGround(vegMask, x, z) {
  if (!vegMask) return true;
  if (!isVegetationAllowed(vegMask, x, z, 6)) return false;
  for (let i = 0; i < OPEN_RING_SAMPLES; i++) {
    const a = (i / OPEN_RING_SAMPLES) * Math.PI * 2;
    if (!isVegetationAllowed(vegMask, x + Math.cos(a) * OPEN_RADIUS, z + Math.sin(a) * OPEN_RADIUS, 0)) {
      return false;
    }
  }
  return true;
}
const GATE_CLUSTER_OFFSET = 6;  // metres from gate centre to place flanking clusters

// ---------------------------------------------------------------------------
// Placement — scatter across open terrain (bbox from tile data)
// ---------------------------------------------------------------------------

/** Derive bounding box from all road/building points in the tile. */
/**
 * The area over which background clusters may be scattered.
 *
 * THIS USED TO BE THE EXTENT OF THE ROADS AND BUILDINGS, and on open ground that is close to
 * nothing. A Collserola hillside tile has 0 roads and 0 buildings, so the bbox came back null and
 * the tile got ZERO clusters — the hill rendered as bare grass. A tile with one winding road got a
 * thin sliver around it, which is why trees hugged the carriageway and stopped dead at its edge.
 *
 * The right bound is the tile's ELEVATION footprint: it is the ground that actually exists here,
 * every tile has one (terrain is baked for all of them), and it is already the authority for which
 * items get placed — the per-item loop below rejects anything outside it, because getElevationAt
 * CLAMPS beyond the edge and would leave vegetation hanging in mid-air. Bounding the scatter by the
 * same rect makes those two agree instead of one throwing away what the other allowed.
 *
 * Falls back to the old road/building extent for any tile with no elevation block.
 */
function getTileBbox(tileData) {
  const e = tileData?.elevation;
  if (e && Number.isFinite(e.south) && Number.isFinite(e.north) &&
      Number.isFinite(e.west) && Number.isFinite(e.east)) {
    const a = latLonToWorld(e.south, e.west);
    const b = latLonToWorld(e.north, e.east);
    return {
      mnX: Math.min(a.x, b.x), mxX: Math.max(a.x, b.x),
      mnZ: Math.min(a.z, b.z), mxZ: Math.max(a.z, b.z),
    };
  }

  let mnX = Infinity, mxX = -Infinity, mnZ = Infinity, mxZ = -Infinity;
  for (const road of tileData.roads || []) {
    for (const p of road.points || []) {
      if (p.x < mnX) mnX = p.x; if (p.x > mxX) mxX = p.x;
      if (p.y < mnZ) mnZ = p.y; if (p.y > mxZ) mxZ = p.y;
    }
  }
  for (const b of tileData.buildings || []) {
    for (const p of b.footprint || []) {
      if (p.x < mnX) mnX = p.x; if (p.x > mxX) mxX = p.x;
      if (p.y < mnZ) mnZ = p.y; if (p.y > mxZ) mxZ = p.y;
    }
  }
  if (!Number.isFinite(mnX)) return null;
  return { mnX, mxX, mnZ, mxZ };
}

function findClusterCenters(tileData, tileKey, vegMask) {
  const bbox = getTileBbox(tileData);
  if (!bbox) return [];

  const buildings = tileData.buildings || [];
  const greens = tileData.greens || [];
  const centers = [];
  const globalSeed = ((tileKey || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0) * 17) + 41;

  const tileW = bbox.mxX - bbox.mnX;
  const tileH = bbox.mxZ - bbox.mnZ;
  const tileArea = tileW * tileH;
  // Headroom for a tile that turns out to be mostly open. Dense tiles never reach it: the mask
  // blocks their roads and buildings, so candidates fail placement long before the cap.
  const cap = (buildings.length <= 30) ? WILD_MAX_CLUSTERS : MAX_CLUSTERS_PER_TILE;
  const maxClusters = Math.min(Math.floor(tileArea / (CLUSTER_SPACING * CLUSTER_SPACING)), cap);
  let attempts = maxClusters * 10;

  while (centers.length < maxClusters && attempts-- > 0) {
    const idx = centers.length + attempts;
    const x = bbox.mnX + seeded(idx, globalSeed) * tileW;
    const z = bbox.mnZ + seeded(idx, globalSeed + 1) * tileH;

    if (!isVegetationAllowed(vegMask, x, z, 6)) continue;
    if (isInsideOrNearBuilding(x, z, buildings, 6)) continue;

    // Open ground clumps: two noise octaves gate acceptance, so a slope grows dense stands with
    // clearings between them. A flat probability would carpet the hill evenly, which reads as a
    // texture rather than a forest — the clearings are what make the stands look placed.
    // Open ground the MAP already describes belongs to the zone system, not to this one.
    // collectZoneVegetation plants greens polygons at their own per-type density (forest is
    // 1/25 m², cap 600), so generating woodland there as well would double-plant every mapped
    // wood — roughly 2,200 trees on a tile that should carry 600. The generated scatter exists to
    // fill ground OSM says nothing about, which is exactly the ground outside those polygons.
    const open = !insideAnyGreen(greens, x, z) && isOpenGround(vegMask, x, z);
    if (open) {
      const d = standDensity(x, z, 140) * 0.7 + standDensity(x, z, 45) * 0.3;
      if (seeded(idx, globalSeed + 3) > d * 1.25) continue;
    }

    // Check spacing against existing centers
    let tooClose = false;
    for (const c of centers) {
      if ((c.x - x) ** 2 + (c.z - z) ** 2 < CLUSTER_SPACING * CLUSTER_SPACING * 0.7) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    // Open ground draws only from the WOODLAND templates; anywhere near a road or building keeps
    // the urban roadside dressing. Decided per SPOT, so one hillside tile can carry both.
    const lo = open ? WOODLAND_FIRST : 0;
    const n = open ? CLUSTER_TEMPLATES.length - WOODLAND_FIRST : WOODLAND_FIRST;
    const templateIdx = lo + (Math.floor(seeded(idx, globalSeed + 2) * n) % n);
    centers.push({ x, z, templateIdx });
  }

  return centers;
}

// ---------------------------------------------------------------------------
// Gate-adjacent clusters — flanking decorative clusters near barrier gates
// ---------------------------------------------------------------------------

/** Detect road crossings along a barrier segment (same logic as barrierRenderer). */
function barrierRoadCrossings(wx0, wz0, wx1, wz1, roads) {
  const ts = [];
  const wdx = wx1 - wx0, wdz = wz1 - wz0;
  for (const road of roads) {
    const pts = road.points || [];
    for (let i = 0; i < pts.length - 1; i++) {
      const rdx = pts[i + 1].x - pts[i].x;
      const rdz = pts[i + 1].y - pts[i].y;
      const denom = wdx * rdz - wdz * rdx;
      if (Math.abs(denom) < 1e-10) continue;
      const t = ((pts[i].x - wx0) * rdz - (pts[i].y - wz0) * rdx) / denom;
      const u = ((pts[i].x - wx0) * wdz - (pts[i].y - wz0) * wdx) / denom;
      if (t > 0.01 && t < 0.99 && u >= -0.1 && u <= 1.1) ts.push(t);
    }
  }
  return ts;
}

/** Collect gate positions from barrier data. Returns [{x, z, perpX, perpZ}]. */
function collectGatePositions(tileData) {
  const barriers = tileData.barriers || [];
  const roads = tileData.roads || [];
  const gates = [];

  for (const barrier of barriers) {
    const pts = barrier.points || [];
    if (pts.length < 2) continue;

    // Explicit gates from OSM data
    const explicitGates = barrier.gates || [];

    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i][0], az = pts[i][1];
      const bx = pts[i + 1][0], bz = pts[i + 1][1];
      const dx = bx - ax, dz = bz - az;
      const segLen = Math.hypot(dx, dz);
      if (segLen < 1e-6) continue;
      const dirX = dx / segLen, dirZ = dz / segLen;
      const perpX = -dirZ, perpZ = dirX;

      // Road crossings as gate positions
      for (const t of barrierRoadCrossings(ax, az, bx, bz, roads)) {
        gates.push({
          x: ax + t * dx,
          z: az + t * dz,
          perpX, perpZ,
        });
      }

      // Explicit gate nodes that project onto this segment
      for (const [gx, gz] of explicitGates) {
        const t = segLen > 1e-6 ? ((gx - ax) * dx + (gz - az) * dz) / (segLen * segLen) : -1;
        if (t >= 0 && t <= 1) {
          gates.push({ x: gx, z: gz, perpX, perpZ });
        }
      }
    }
  }
  return gates;
}

/**
 * Place clusters flanking each gate opening (bush-heavy templates D or E).
 */
function findGateAdjacentClusters(tileData, vegMask) {
  const gatePositions = collectGatePositions(tileData);
  const buildings = tileData.buildings || [];
  const centers = [];

  for (let gi = 0; gi < gatePositions.length; gi++) {
    const gp = gatePositions[gi];
    // Place a cluster on each side of the gate (along the perpendicular = into/out of the compound)
    for (const side of [1, -1]) {
      const cx = gp.x + gp.perpX * GATE_CLUSTER_OFFSET * side;
      const cz = gp.z + gp.perpZ * GATE_CLUSTER_OFFSET * side;

      if (!isVegetationAllowed(vegMask, cx, cz, 4)) continue;
      if (isInsideOrNearBuilding(cx, cz, buildings, 3)) continue;

      // Use bush-heavy templates (D=3, E=4)
      const templateIdx = (gi + side) % 2 === 0 ? 3 : 4;
      centers.push({ x: cx, z: cz, templateIdx });
    }
  }
  return centers;
}

// ---------------------------------------------------------------------------
// InstancedMesh builders
// ---------------------------------------------------------------------------

/**
 * @param {object} tileData
 * @param {string} tileKey
 * @param {{ getElevationAt?: (lat: number, lon: number) => number }} [options]
 * @returns {THREE.Mesh[]}
 */
/** Exposed ONLY for `test/clusterRoadGuard.test.js`. A guard nobody tested was written twice. */
export function renderEnvironmentClusters(tileData, tileKey, options) {
  const vegMask = options?.vegetationMask || null;
  const centers = findClusterCenters(tileData, tileKey, vegMask);

  // Add gate-adjacent clusters
  const gateClusters = findGateAdjacentClusters(tileData, vegMask);
  for (const gc of gateClusters) centers.push(gc);

  if (centers.length === 0) return [];

  // GROUND SAMPLING. Prefer getWorldElevation — the single function tileManager builds from the
  // terrain mesh and hands to everything that has to sit on the ground, already carrying vertExag.
  // Recomputing `getElevationAt * vertExag` here duplicated that formula, and a duplicate is only
  // ever one edit away from disagreeing with the terrain it is supposed to match.
  const getWorldElevation = options?.getWorldElevation;
  const getElevationAt = options?.getElevationAt;
  const vertExag = Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION)
    ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;

  // NO GROUND, NO CLUSTERS. This used to fall through to y = 0 for every item when no sampler was
  // available. y = 0 is not "the ground" — it is the elevation-offset datum, i.e. the height of the
  // spawn tile. On flat ground near a road that is invisibly close to correct, which is why it
  // survived; scattered across a hillside that rises and falls 190 m it puts whole clusters in
  // mid-air wherever the terrain sits below the datum. Placing nothing is the honest failure.
  if (!getWorldElevation && !getElevationAt) return [];

  // Tile elevation footprint. Cluster centers are scattered across a bbox built from road/building
  // points that include CLIPPED roads overhanging the tile by 200-460 m (e.g. the long Ronda de Dalt
  // ramps). For an item landing outside this footprint, getElevationAt CLAMPS the sample to the edge
  // elevation — on a hillside that holds the high edge value while the real (neighbor-tile) terrain
  // drops away downhill, so the bush hangs in mid-air in a horizontal line. That terrain belongs to
  // the neighbour tile (which places its own vegetation), so skip any item outside these bounds.
  const _e = tileData?.elevation;
  const tileBounds = (_e && Number.isFinite(_e.south) && Number.isFinite(_e.north) && Number.isFinite(_e.west) && Number.isFinite(_e.east))
    ? { south: _e.south, north: _e.north, west: _e.west, east: _e.east } : null;

  // Collect all instance transforms per type
  const rockInstances = [];  // { x, y, z, scale, rotY }
  const bushInstances = [];
  const treeInstances = [];

  for (let ci = 0; ci < centers.length; ci++) {
    const c = centers[ci];
    const template = CLUSTER_TEMPLATES[c.templateIdx];
    // Cluster-level random rotation
    const clusterRot = seeded(ci, 50) * Math.PI * 2;
    const cos = Math.cos(clusterRot), sin = Math.sin(clusterRot);
    // Cluster-level scale jitter: 0.85–1.15
    const clusterScale = 0.85 + seeded(ci, 51) * 0.3;

    for (let ii = 0; ii < template.items.length; ii++) {
      const item = template.items[ii];
      // Rotate offset around cluster center
      const rx = item.dx * cos - item.dz * sin;
      const rz = item.dx * sin + item.dz * cos;
      const wx = c.x + rx * clusterScale;
      const wz = c.z + rz * clusterScale;

      // Skip items that land on or near roads — strict check per item.
      if (!isVegetationAllowed(vegMask, wx, wz, 4)) { _clusterRejects.mask++; continue; }
      // N-9: and a DIRECT test against the road geometry, because the mask alone was not enough.
      // `isVegetationAllowed` returns TRUE for anything outside its own grid (tile + PAD), so a
      // cluster centre near a tile edge scatters items past the boundary and every one of them is
      // waved through — which is how rocks ended up sitting on Gran Via. Identified with
      // `_ddPick`: the offender is this file's rock InstancedMesh, which carried no `userData.type`
      // and so reported only as a minified class name.
      // TREES ARE EXEMPT. A street tree standing at the kerb is the single most characteristic
      // object on a Barcelona avenue, and guarding it cost the whole of Gran Via twice: once at
      // corridorWidth (which includes the pavement it stands on) and once at the kerb, where the
      // pit legitimately sits. Rocks and bushes were the actual complaint; a tree in the road is
      // rare, obvious, and far cheaper to live with than an avenue with no trees.
      if (item.type !== 'tree' && isOnAnyRoad(tileData, wx, wz)) { _clusterRejects.road++; continue; }
      _clusterRejects.kept++;

      // Outside this tile's elevation footprint → sampling would clamp to the edge (= float). Skip;
      // the neighbour tile owns that ground and places its own vegetation there.
      const { lat, lon } = worldToLatLon(wx, wz);
      if (tileBounds && (lat < tileBounds.south || lat > tileBounds.north ||
                         lon < tileBounds.west || lon > tileBounds.east)) continue;

      let y;
      if (getWorldElevation) {
        y = getWorldElevation(wx, wz);
      } else {
        const e = getElevationAt(lat, lon);
        if (e == null || !Number.isFinite(e)) continue;   // no reading here → place nothing
        y = e * vertExag;
      }
      if (!Number.isFinite(y)) continue;

      const itemScale = item.scale * clusterScale * (0.9 + seeded(ci * 10 + ii, 52) * 0.2);
      const rotY = seeded(ci * 10 + ii, 53) * Math.PI * 2;

      const inst = { x: wx, y, z: wz, scale: itemScale, rotY };
      if (item.type === 'rock') rockInstances.push(inst);
      else if (item.type === 'bush') bushInstances.push(inst);
      else if (item.type === 'tree') treeInstances.push(inst);
    }
  }

  const meshes = [];
  const baseRockColor = new THREE.Color(0x8a8580);
  const baseBushColor = new THREE.Color(0x4F7D42);

  // Rock InstancedMesh
  if (rockInstances.length > 0) {
    const geo = getRockGeometry();
    const mat = getRockMaterial();
    const mesh = new THREE.InstancedMesh(geo, mat, rockInstances.length);
    mesh.count = rockInstances.length;
    mesh.geometry = geo.clone();          // per-tile attribute, shared vertex data
    mesh.geometry.setAttribute('aRockCell', buildRockCellAttribute(rockInstances));
    mesh.frustumCulled = false; // InstancedMesh bounding sphere = one base item at origin → getting close
                                // culled the WHOLE cluster (rocks/trees vanished). Tile-distance culling handles visibility.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData.type = 'clusterRock';   // N-9: untagged, so _ddPick could only report a minified
    mesh.userData.sharedGeometry = true;  // class name and the source took three passes to find
    mesh.userData.sharedMaterial = true;

    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const col = new THREE.Color();

    for (let i = 0; i < rockInstances.length; i++) {
      const r = rockInstances[i];
      p.set(r.x, r.y, r.z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.rotY);
      // Irregular rock scaling
      const sx = r.scale * (0.8 + seeded(i, 60) * 0.4);
      const sy = r.scale * (0.6 + seeded(i, 61) * 0.4);
      const sz = r.scale * (0.8 + seeded(i, 62) * 0.4);
      s.set(sx, sy, sz);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      // Color variation
      const bright = 0.8 + seeded(i, 63) * 0.3;
      col.copy(baseRockColor).multiplyScalar(bright);
      mesh.setColorAt(i, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    meshes.push(mesh);
  }

  // Bush InstancedMeshes — one per species. These are HILLSIDE scatter, not municipal planting, so
  // they draw from the 'wild' set: lentisc, kermes oak, rosemary, dwarf fan palm. A clipped box
  // hedge up Collserola is the same class of error as a seafront palm on a mountain.
  if (bushInstances.length > 0) {
    const bushGeos = getBushGeometries();
    const bushMat = getBushCardsMaterial();
    const nBush = getBushVariantCount();

    const bushBuckets = Array.from({ length: nBush }, () => []);
    for (const b of bushInstances) bushBuckets[classifyBush(b.x, b.z, 'wild', nBush)].push(b);

    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const col = new THREE.Color();

    for (let v = 0; v < nBush; v++) {
      const bucket = bushBuckets[v];
      if (bucket.length === 0) continue;
      const mesh = new THREE.InstancedMesh(bushGeos[v], bushMat, bucket.length);
      mesh.count = bucket.length;
      mesh.frustumCulled = false; // InstancedMesh bounding sphere = one base item at origin → getting close
                                  // culled the WHOLE cluster (rocks/trees vanished). Tile-distance culling handles visibility.
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.userData.type = 'clusterBush';        // N-9: tag every cluster mesh — see clusterRock
      mesh.userData.sharedGeometry = true;
      mesh.userData.sharedMaterial = true;

      for (let i = 0; i < bucket.length; i++) {
        const b = bucket[i];
        p.set(b.x, b.y, b.z);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.rotY);
        const sy = b.scale * (0.7 + seeded(i, 70) * 0.3);
        s.set(b.scale, sy, b.scale);
        m.compose(p, q, s);
        mesh.setMatrixAt(i, m);
        // Cards carry their own photographic colour; tinting them with the old flat bush green
        // would drag six normalized species back onto one hue. Blobs still need the tint.
        const bright = 0.82 + seeded(i, 71) * 0.26;
        if (nBush > 1) col.setScalar(bright);
        else col.copy(baseBushColor).multiplyScalar(bright);
        mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      meshes.push(mesh);
    }
  }

  // Tree InstancedMesh — reuse main procedural tree geometries (one mesh per variant)
  if (treeInstances.length > 0) {
    const treeGeos = getTreeGeometries();
    const treeMat = getTreeMaterial();
    const numVariants = treeGeos.length;

    // Group tree instances by species. Hillside and background scatter is wild broadleaf — see
    // getClusterTreeGeometry above for why this is no longer a uniform random pick.
    const buckets = Array.from({ length: numVariants }, () => []);
    for (let i = 0; i < treeInstances.length; i++) {
      const variant = classifyTreeSpecies(
        'hill', i, 85, numVariants, Math.floor(seeded(i, 85) * numVariants));
      buckets[variant].push(treeInstances[i]);
    }

    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const col = new THREE.Color();

    for (let vi = 0; vi < numVariants; vi++) {
      const bucket = buckets[vi];
      if (bucket.length === 0) continue;
      const mesh = new THREE.InstancedMesh(treeGeos[vi], treeMat, bucket.length);
      mesh.count = bucket.length;
      mesh.frustumCulled = false; // InstancedMesh bounding sphere = one base item at origin → getting close
                                // culled the WHOLE cluster (rocks/trees vanished). Tile-distance culling handles visibility.
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.userData.type = 'clusterTree';        // N-9: tag every cluster mesh — see clusterRock
      mesh.userData.sharedGeometry = true;
      mesh.userData.sharedMaterial = true;

      for (let i = 0; i < bucket.length; i++) {
        const t = bucket[i];
        p.set(t.x, t.y, t.z);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.rotY);
        // Smaller scale for cluster trees (0.4–0.7 of template items' scale)
        const sc = t.scale * 0.5;
        s.set(sc, sc, sc);
        m.compose(p, q, s);
        mesh.setMatrixAt(i, m);
        const bright = 0.88 + seeded(i, 80) * 0.24;
        col.setScalar(bright);
        mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      meshes.push(mesh);
    }
  }

  return meshes;
}
