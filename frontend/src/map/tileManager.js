/**
 * Tile-based streaming: keep 3x3 tiles around viewer, unload tiles > 2 away.
 * All feature toggles from CONFIG; no geometry generated when disabled.
 */
import * as THREE from 'three';
import { requestShadowRefresh } from '../shadowRefresh.js';
import { isShared } from '../sharedMaterial.js';
import { disposeTileObject } from './tileDisposal.js';   // task #39: ONE disposal rule
import { assertGroundLayers } from './groundLayers.js';
import * as CANNON from 'cannon-es';
import { worldToSlippyTile, tileCenterToWorld, worldToLatLon, latLonToWorld, TILE_ZOOM, getTileBboxLatLon } from '../projection.js';
import { loadTile } from './mapLoader.js';
import { getWorldElevationOffset, whenElevationOffsetReady, assertElevationOffsetResolved } from '../elevationOffset.js';
import { getOriginOffset } from '../originOffset.js';
import { CONFIG } from '../config.js';
import { COLLISION_GROUP_GROUND, COLLISION_GROUP_VEHICLE, COLLISION_GROUP_WORLD, COLLISION_GROUP_TERRAIN, assertTerrainVehicleHandshake } from '../collisionGroups.js';
import { toNormalizedRoadY } from '../roadElevation.js';
import { getCarContactMaterials } from '../car/carPhysics.js';
import { getJunctionPoints, buildBridgeGuardRailColliders, buildGoreMeshes, buildChamferFills, buildChamferSidewalks, buildChamferCurbs, bakeRoadAO } from './roadRenderer.js';
import { createAoSampler, AO_DISABLED, AO_GREEN_STRENGTH } from './aoSampler.js';
import { mergeGeometriesChunked } from './chunkedMerge.js';
import { ingestCoastline } from './coastline.js';
import { buildStreetlights, registerBridgeNightCallback, unregisterBridgeNightCallback, BRIDGE_NIGHT_COLORS, DAY_POLE_COLOR } from './streetlightRenderer.js';
import { createVegPoolSet } from './vegPools.js';
import { buildTerrainMesh, buildTerrainHeightfield, getHeightfieldWorldAABB, darkenTerrainAroundTrees } from './terrainRenderer.js';
import { renderWater } from './waterRenderer.js';
import { createRailwayMeshes, createTramMeshes } from './railwayRenderer.js';
import { createGreensMeshes } from './greensRenderer.js';
import { createAreaFeatureMeshes } from './areaFeaturesRenderer.js';
import { recordChunk } from '../ui/frameAttribution.js';   // v3: name the work that lands between frames
import { buildBarrierMeshes, buildBarrierColliders } from './barrierRenderer.js';
import { buildBusStopMeshes } from './busStopRenderer.js';
import { queueWarmup } from './gpuWarmup.js';
import { buildParkingMeshes } from './parkingRenderer.js';
import { buildShopSignMesh } from './shopSignRenderer.js';
import { buildAwningMesh } from './awningRenderer.js';
import { buildCafeTerrace } from './cafeTerraceRenderer.js';
import { buildShopfrontMeshes } from './shopfrontRenderer.js';
import { buildRoadInfrastructure } from './roadInfraRenderer.js';
import { buildUrbanFeatureMeshes, getUrbanFeatureExclusionZones } from './urbanFeatureRenderer.js';
import { buildTunnelMeshes, buildTunnelFloor, buildApproachCanopy, buildRetainingWalls, buildTrenchRetainingWalls, buildTrenchCliffWalls, buildTrenchPortals, buildPortalApproaches } from './tunnelRenderer.js';
import { registerTunnelZones, unregisterTunnelZones } from '../tunnelZones.js';
import { buildVegetationMask } from './vegetationMask.js';
import { renderLODBuildings } from './buildingRenderer.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createFastElevation } from './fastElevation.js';
import { initWorkerPool, processBuildings as workerProcessBuildings, processVegetation as workerProcessVegetation, cancelTile } from '../workers/workerPool.js';
import { materializeBuildingMeshes, materializeVegetationMeshes, getVegPools } from '../workers/meshMaterializer.js';
import { buildTrafficSignals } from './trafficSignalRenderer.js';   // T-2 / T-3 / T-4

let _loggedHfPlacement = false; // one-time terrain-heightfield placement log (G-49 debugging)
// v3: ?debug=paint — per-second report of road-paint mesh state for the tile the car is in.
const _DEBUG_PAINT = (() => {
  try { return new URLSearchParams(location.search).get('debug') === 'paint'; } catch { return false; }
})();
let _paintDbgT = 0;
const _paintFrustum = new THREE.Frustum();
const _paintSphere = new THREE.Sphere();
const _paintMat = new THREE.Matrix4();
const GRID_RADIUS = 1; // 3x3 tiles around viewer (9 tiles)
const LOOKAHEAD_RADIUS = 2; // extend 1 extra tile in driving direction for seamless look-ahead
const UNLOAD_DISTANCE = 2; // keep fewer tiles resident (was 3 → up to 49 tiles → 1GB heap, 38fps)
// Photo Mode — for clean fly-through screenshots: load a wide area and disable ALL distance culling /
// LOD (every loaded mesh renders at full detail). Heavy + slow, but opt-in and not driving. The radius
// is live-adjustable ('+'/'-' in Photo Mode) so you can push it up until your machine strains — full
// geometry is built per tile, so large radii are memory-bound and will eventually crash the tab.
let _photoMode = false;
let _photoRadius = 4;  // ± tiles → (2N+1)² loaded; 4 = 9x9. Raise/lower live via setPhotoRadius.
function setPhotoMode(on) { _photoMode = !!on; }
function setPhotoRadius(n) { _photoRadius = Math.max(1, Math.min(20, Math.round(n))); return _photoRadius; }
function getPhotoRadius() { return _photoRadius; }
const MAX_VERTICES_PER_TILE = 250000;  // Phase 3 (sidewalks+curbs+bike lanes) soft budget
const VERTEX_BUDGET_HARD    = 300000;  // hard budget — investigate if any tile exceeds this

// ---------------------------------------------------------------------------
// Post-merge: collapse many meshes into fewer by merging those that share a material
// ---------------------------------------------------------------------------

// One-time-per-session flag so we know if safeSceneAdd is actually catching anything.
let _meshHasNaNLogged = false;

/**
 * Full NaN scan on a mesh's position buffer. Returns true if ANY position value is NaN.
 * Previously sampled first 90 + last 30 values — that misses NaN scattered in the middle
 * of large merged geometries (e.g. 170k-vertex LOD building meshes). Do NOT revert to a
 * sampler: NaN from a bad elevation cell lands at an unpredictable offset in the merged array.
 */
function meshHasNaN(mesh) {
  if (!mesh?.geometry?.attributes?.position) return false;
  const arr = mesh.geometry.attributes.position.array;
  if (!arr || arr.length === 0) return false;
  for (let i = 0; i < arr.length; i++) {
    if (isNaN(arr[i])) {
      if (!_meshHasNaNLogged) {
        console.warn(
          '[meshHasNaN] caught NaN in mesh position array — skipping scene.add.' +
          ' Root cause: NaN elevation in baked tile grid (G-06). (logging once per session)'
        );
        _meshHasNaNLogged = true;
      }
      return true;
    }
  }
  return false;
}

// Meshes at/above this vertex count are worth pre-uploading to the GPU (queueWarmup) — below it, the
// VBO upload on first render is negligible and not worth an extra draw. Buildings/roads/terrain/veg
// (the big merged meshes) clear this easily; small props (streetlights, reflectors) don't.
const WARMUP_MIN_VERTS = 1500;

/** Queue any sufficiently-large mesh children of a group for GPU pre-upload. */
function queueGroupWarmup(group) {
  group.traverse((o) => {
    if (o.isMesh && (o.geometry?.attributes?.position?.count || 0) >= WARMUP_MIN_VERTS) queueWarmup(o);
  });
}

/** Safe scene.add that skips meshes with NaN positions to prevent render errors. */
/**
 * v3 P1-19/20 — census of the OSM data that reaches the renderer. Logged once, ~8 s after the first
 * tile, so the corrected figures in the v3 plan (14,542 shops / 4,225 signals / 35,580 trees
 * city-wide) can be checked against what actually arrives rather than taken on faith.
 * Delete once the consumers exist and the counts are visible in-game.
 */
const _census = { tiles: 0, trees: 0, shops: 0, namedShops: 0, signals: 0 };
let _censusTimer = null;
function _censusAdd(td) {
  _census.tiles++;
  _census.trees += td.trees?.length || 0;
  _census.shops += td.shops?.length || 0;
  _census.namedShops += (td.shops || []).filter((x) => x?.name).length;
  _census.signals += td.trafficSignals?.length || 0;
  if (_censusTimer) return;
  _censusTimer = setTimeout(() => {
    if (CONFIG.DEBUG_INIT) {
      console.warn('[census] %d tiles → %d trees · %d shops (%d named) · %d traffic signals — all previously dropped',
        _census.tiles, _census.trees, _census.shops, _census.namedShops, _census.signals);
    }
  }, 8000);
}

function safeSceneAdd(scene, mesh) {
  if (!mesh) return false;
  // v3 P0-03: shadowMap.autoUpdate is false, so new geometry entering the scene would otherwise
  // render unshadowed until something else happened to request a refresh. This is the single funnel
  // for every tile mesh (45 call sites), so one line here covers all of them. The flag is idempotent
  // — setting it 45 times during one tile build costs nothing.
  requestShadowRefresh();
  assertGroundLayers(mesh);   // v3 P0-14 dev guard (no-op in prod)
  if (mesh.isGroup) { scene.add(mesh); queueGroupWarmup(mesh); return true; }
  if (!mesh.userData?._nanChecked && meshHasNaN(mesh)) {   // materializer-scanned meshes skip the 2nd full pass
    mesh.geometry.dispose();
    return false;
  }
  scene.add(mesh);
  if ((mesh.geometry?.attributes?.position?.count || 0) >= WARMUP_MIN_VERTS) queueWarmup(mesh);
  return true;
}

/**
 * Merge an array of THREE.Mesh objects by shared material reference.
 * InstancedMesh, Groups, and meshes with array materials are left untouched.
 * Returns a new array of (merged + untouched) meshes. Disposes old geometries.
 * Visual output is pixel-identical.
 */
/** Get a string key describing a geometry's attribute layout (names + itemSizes). */
function geoAttrKey(geo) {
  const names = Object.keys(geo.attributes).sort();
  return names.map(n => `${n}:${geo.attributes[n].itemSize}`).join(',');
}

async function mergeMeshesByMaterial(meshes, yieldFn) {
  if (!meshes || meshes.length <= 1) return meshes;

  // Group by material reference + attribute signature (must match for mergeGeometries)
  const buckets = new Map();   // "matId|attrKey" -> { mat, geos[], srcMeshes[] }
  const untouched = [];

  let matIdCounter = 0;
  const matIds = new Map();    // Material -> unique id

  for (const m of meshes) {
    // Skip InstancedMesh, Groups, multi-material, or meshes explicitly marked non-mergeable
    if (m.isInstancedMesh || m.isGroup || !m.isMesh || Array.isArray(m.material) || m.userData?.noMerge) {
      untouched.push(m);
      continue;
    }
    const mat = m.material;
    const geo = m.geometry;
    if (!mat || !geo) { untouched.push(m); continue; }

    if (!matIds.has(mat)) matIds.set(mat, matIdCounter++);
    const key = `${matIds.get(mat)}|${geoAttrKey(geo)}`;

    if (!buckets.has(key)) buckets.set(key, { mat, geos: [], srcMeshes: [] });
    const bucket = buckets.get(key);
    bucket.geos.push(geo);
    bucket.srcMeshes.push(m);
  }

  const result = [...untouched];
  let mergeCount = 0;

  for (const [, bucket] of buckets) {
    if (bucket.geos.length === 1) {
      result.push(bucket.srcMeshes[0]);
      continue;
    }

    let merged;
    try {
      // Chunked (yielding) merge first — the sync mergeGeometries on a big bucket was a measured
      // 20-36ms vsync-miss. Sync path stays as the fallback for exotic attribute layouts.
      merged = await mergeGeometriesChunked(bucket.geos, yieldFn);
      if (!merged) merged = mergeGeometries(bucket.geos, false);
    } catch {
      // Merge failed — keep originals
      result.push(...bucket.srcMeshes);
      continue;
    }
    if (!merged) {
      result.push(...bucket.srcMeshes);
      continue;
    }

    const newMesh = new THREE.Mesh(merged, bucket.mat);
    const src = bucket.srcMeshes[0];
    newMesh.castShadow = src.castShadow;
    newMesh.receiveShadow = src.receiveShadow;
    newMesh.frustumCulled = src.frustumCulled;
    newMesh.renderOrder = src.renderOrder;
    if (src.userData?.sharedMaterial) newMesh.userData.sharedMaterial = true;

    for (const srcM of bucket.srcMeshes) {
      srcM.geometry?.dispose();
    }

    result.push(newMesh);

    // Yield every 2 merges to prevent long frame stalls
    if (yieldFn && ++mergeCount % 2 === 0) await yieldFn();
  }

  return result;
}

// Tree trunk radius for collision (visual trunk is ~0.15-0.25m)
// Pillar collision uses PILLAR_RADIUS from roadRenderer (0.5m)
const PILLAR_COLLISION_RADIUS = 0.5;

/**
 * Build static CANNON.Body colliders for trees and pillars.
 * Returns an array of bodies (individual body per tree for reliable broadphase,
 * single body for all pillars).
 * @param {{ x: number, y: number }[]} treePositions  - world XZ (y = world Z)
 * @param {{ x: number, z: number, groundY: number, height: number }[]} pillarPositions
 * @param {{ x: number, z: number }} physicsOrigin
 * @param {(lat: number, lon: number) => number|null} [getElevationAt]
 * @param {number} vertExag
 * @returns {CANNON.Body[]}
 */
const TREE_COLLISION_RADIUS = 0.3;
const TREE_COLLISION_HEIGHT = 6;

function buildSceneryColliders(treePositions, pillarPositions, physicsOrigin, getElevationAt, vertExag) {
  const bodies = [];
  const treesToCollide = treePositions || [];

  // Trees — only positions that passed ground-road filtering reach here.
  // Gated: trees line the curb, so their colliders stopped the car dead on touching a sidewalk.
  if (CONFIG.ENABLE_TREE_COLLISION !== false && treesToCollide.length > 0) {
    const BATCH_SIZE = 200;
    for (let batchStart = 0; batchStart < treesToCollide.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, treesToCollide.length);
      const treeBody = new CANNON.Body({ mass: 0 });
      for (let ti = batchStart; ti < batchEnd; ti++) {
        const p = treesToCollide[ti];
        let groundY = 0;
        if (getElevationAt) {
          const { lat, lon } = worldToLatLon(p.x, p.y);
          groundY = (getElevationAt(lat, lon) ?? 0) * vertExag;
        }
        const px = -(p.x - physicsOrigin.x);
        const pz = p.y - physicsOrigin.z;
        const treeBox = new CANNON.Box(new CANNON.Vec3(TREE_COLLISION_RADIUS, TREE_COLLISION_HEIGHT / 2, TREE_COLLISION_RADIUS));
        treeBody.addShape(treeBox, new CANNON.Vec3(px, groundY + TREE_COLLISION_HEIGHT / 2, pz));
      }
      // WORLD group + VEHICLE mask so the chassis (mask = WORLD|TERRAIN) actually hits trees.
      // (Without this they default to group GROUND, which the chassis filters out → drive-through.)
      treeBody.collisionFilterGroup = COLLISION_GROUP_WORLD;
      treeBody.collisionFilterMask  = COLLISION_GROUP_VEHICLE;
      bodies.push(treeBody);
    }
  }

  // Pillars — single body with offsets
  if (pillarPositions && pillarPositions.length > 0) {
    const pillarBody = new CANNON.Body({ mass: 0 });
    for (const p of pillarPositions) {
      const pillarCyl = new CANNON.Cylinder(PILLAR_COLLISION_RADIUS, PILLAR_COLLISION_RADIUS, p.height, 6);
      const px = -(p.x - physicsOrigin.x);
      const pz = p.z - physicsOrigin.z;
      pillarBody.addShape(pillarCyl, new CANNON.Vec3(px, p.groundY + p.height / 2, pz));
    }
    pillarBody.collisionFilterGroup = COLLISION_GROUP_WORLD;
    pillarBody.collisionFilterMask  = COLLISION_GROUP_VEHICLE;
    bodies.push(pillarBody);
  }

  return bodies;
}

/**
 * Building colliders — one shape per building (× height), batched into a few static bodies per tile.
 * WORLD group + VEHICLE mask so the chassis stops at buildings instead of driving through them.
 * Rectangles → cheap oriented box (OBB). Non-rectangular *convex* footprints (chamfered Eixample
 * corners, angled blocks) → exact convex prism, so the collider hugs the real wall line instead of
 * over-covering the cut corner with an invisible wall that traps the car on the corner sidewalk.
 * Concave footprints fall back to the OBB box (rare; slight over-cover accepted).
 */
/**
 * Build an EXACT convex-prism collider from a footprint (physics-frame points), extruded groundY→groundY+h.
 * Used for non-rectangular *convex* footprints — chamfered Eixample corners especially — where a rectangular
 * OBB would over-cover the cut corner and plant an invisible wall on the corner sidewalk (car gets stuck there).
 * Returns { shape, offset } or null if the footprint is concave / degenerate (caller falls back to the OBB box).
 * Face windings are AUTO-CORRECTED to point outward, so a winding mistake can't silently break collision.
 */
function buildConvexPrism(pts, groundY, h) {
  const n = pts.length;
  if (n < 4 || n > 12) return null;
  // convexity: every consecutive turn must share the same sign
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], c = pts[(i + 2) % n];
    const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
    if (Math.abs(cross) < 1e-4) continue; // collinear — ok
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s; else if (s !== sign) return null; // concave
  }
  const yb = -h / 2, yt = h / 2;
  const cxp = pts.reduce((s, p) => s + p.x, 0) / n;
  const czp = pts.reduce((s, p) => s + p.z, 0) / n;
  const verts = [];
  for (let i = 0; i < n; i++) verts.push(new CANNON.Vec3(pts[i].x - cxp, yb, pts[i].z - czp)); // 0..n-1 bottom
  for (let i = 0; i < n; i++) verts.push(new CANNON.Vec3(pts[i].x - cxp, yt, pts[i].z - czp)); // n..2n-1 top
  const faces = [];
  faces.push(Array.from({ length: n }, (_, i) => i));       // bottom
  faces.push(Array.from({ length: n }, (_, i) => n + i));   // top
  for (let i = 0; i < n; i++) faces.push([i, (i + 1) % n, n + ((i + 1) % n), n + i]); // sides
  // auto-correct each face to CCW-as-seen-from-outside (normal must point away from body centroid)
  const cen = new CANNON.Vec3(0, 0, 0); // verts are centered on x/z; y centroid is 0
  for (const f of faces) {
    const v0 = verts[f[0]], v1 = verts[f[1]], v2 = verts[f[2]];
    const e1 = new CANNON.Vec3(v1.x - v0.x, v1.y - v0.y, v1.z - v0.z);
    const e2 = new CANNON.Vec3(v2.x - v0.x, v2.y - v0.y, v2.z - v0.z);
    const nrm = e1.cross(e2);
    let fx = 0, fy = 0, fz = 0;
    for (const idx of f) { fx += verts[idx].x; fy += verts[idx].y; fz += verts[idx].z; }
    const outward = new CANNON.Vec3(fx / f.length - cen.x, fy / f.length - cen.y, fz / f.length - cen.z);
    if (nrm.dot(outward) < 0) f.reverse();
  }
  let shape;
  try { shape = new CANNON.ConvexPolyhedron({ vertices: verts, faces }); }
  catch (e) { return null; }
  return { shape, offset: new CANNON.Vec3(cxp, groundY + h / 2, czp) };
}

/**
 * Trace a footprint outline with thin vertical wall boxes — one per edge — so the collider hugs the
 * real walls exactly, for ANY polygon (convex OR concave). Used for concave footprints (L/U-shaped
 * blocks) where a single oriented box would fill the notch and jut out over the sidewalk/road.
 * `pts` are cleaned physics-frame points {x,z}. Adds shapes to `body`.
 */
const PERIMETER_WALL_THICK = 2.0;   // thick → resists fast-car tunneling; offset fully INSIDE the footprint
const COLLINEAR_MERGE_RAD = 0.16;   // ~9° — merge consecutive wall edges flatter than this into one box

// Collapse near-collinear consecutive vertices of a closed ring, keeping only real corners. OSM footprints
// carry many near-collinear points; without this, addPerimeterWalls emits a CANNON.Box per tiny edge, and
// every Box recomputes its ConvexPolyhedron edges/normals — the #1 runtime allocator (~79% of GC garbage).
// Fewer corners → far fewer boxes → far less allocation, with a collider that's geometrically ~identical.
function mergeCollinearRing(pts, maxTurn) {
  const n = pts.length;
  if (n < 4) return pts;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i - 1 + n) % n], c = pts[i], q = pts[(i + 1) % n];
    const ax = c.x - p.x, az = c.z - p.z, bx = q.x - c.x, bz = q.z - c.z;
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1e-4 || lb < 1e-4) continue; // duplicate point → drop
    const dot = (ax * bx + az * bz) / (la * lb);
    const turn = Math.acos(Math.max(-1, Math.min(1, dot)));
    if (turn > maxTurn) out.push(c); // keep only significant corners; collinear runs collapse into a span
  }
  return out.length >= 3 ? out : pts;
}

// A box built as a ConvexPolyhedron directly, reusing the size-INDEPENDENT parts. Every CANNON.Box
// recomputes its convex representation (updateConvexPolyhedronRepresentation 27% + computeNormals 14% of
// all GC garbage) — but a box's faces, face-normals and axes are identical for ALL boxes; only the 8
// vertices scale. So we share those read-only templates and PROVIDE the normals (skips computeNormals),
// allocating only the per-box vertices. SAFE (each box has its own vertices → its own worldVertices cache,
// unlike the earlier shared-shape attempt). Geometry copied EXACTLY from cannon-es Box (dist line 3085).
const _V3 = CANNON.Vec3;
const _BOX_FACES = [[3, 2, 1, 0], [4, 5, 6, 7], [5, 4, 0, 1], [2, 3, 7, 6], [0, 4, 7, 3], [1, 2, 6, 5]];
const _BOX_NORMALS = [new _V3(0, 0, -1), new _V3(0, 0, 1), new _V3(0, -1, 0), new _V3(0, 1, 0), new _V3(-1, 0, 0), new _V3(1, 0, 0)];
const _BOX_AXES = [new _V3(0, 0, 1), new _V3(0, 1, 0), new _V3(1, 0, 0)];
// A box's uniqueEdges are ALWAYS these 6 directions. cannon-es computeEdges dedups WITHOUT a negation check
// (a known quirk — the `almostEquals(edge) || almostEquals(edge)` line), so it keeps both signs: ±x, ±y, ±z.
// Derived by hand from _BOX_FACES above and verified to match computeEdges()'s output order byte-for-byte.
// uniqueEdges is read-only during simulation (SAT copies each edge into a scratch Vec3, never mutates it),
// so ALL boxes safely share this ONE frozen template instead of each cloning 6 Vec3 at construction.
const _BOX_EDGES = [
  new _V3(-1, 0, 0), new _V3(0, 1, 0), new _V3(1, 0, 0),
  new _V3(0, -1, 0), new _V3(0, 0, 1), new _V3(0, 0, -1),
];
// ConvexPolyhedron whose per-box edge computation is replaced by the shared template. The base constructor
// ends with `this.computeEdges()` (dynamic dispatch → our override), so no per-box edge Vec3 are ever
// allocated. Per-box vertices (its own worldVertices cache) are unchanged → collisions are byte-identical to
// a plain box. Kills the cannon-es computeEdges allocator (~9% of runtime GC garbage).
class CheapBox extends CANNON.ConvexPolyhedron {
  computeEdges() { this.uniqueEdges = _BOX_EDGES; }
}
function makeCheapBox(hx, hy, hz) {
  // Rapier active: a NATIVE CANNON.Box is the lean path — its heavy ConvexPolyhedron rep is
  // stubbed at init (main.js), the adapter converts Box→cuboid straight from halfExtents
  // (cheaper than convexHull over 8 verts), and the allocation profile showed CheapBox's 8
  // Vec3s per wall segment were the #2 allocator of a streaming drive (11.7MB/20s). CheapBox
  // remains only for the pre-Rapier-init window (tiles that load before the flag is set) and
  // fly mode; the cannon engine path itself was deleted 2026-07-16.
  if (typeof window !== 'undefined' && window._ddRapierActive) {
    return new CANNON.Box(new _V3(hx, hy, hz));
  }
  const vertices = [
    new _V3(-hx, -hy, -hz), new _V3(hx, -hy, -hz), new _V3(hx, hy, -hz), new _V3(-hx, hy, -hz),
    new _V3(-hx, -hy, hz), new _V3(hx, -hy, hz), new _V3(hx, hy, hz), new _V3(-hx, hy, hz),
  ];
  return new CheapBox({
    vertices, faces: _BOX_FACES, normals: _BOX_NORMALS, axes: _BOX_AXES,
    boundingSphereRadius: Math.sqrt(hx * hx + hy * hy + hz * hz),
  });
}

function addPerimeterWalls(body, ptsRaw, groundY, h) {
  const YAX = new CANNON.Vec3(0, 1, 0);
  const pts = mergeCollinearRing(ptsRaw, COLLINEAR_MERGE_RAD);
  const n = pts.length;
  // centroid, to push each wall inward so its OUTER face lands exactly on the real wall line
  let ccx = 0, ccz = 0;
  for (const p of pts) { ccx += p.x; ccz += p.z; }
  ccx /= n; ccz /= n;
  const half = PERIMETER_WALL_THICK / 2;
  for (let i = 0; i < n; i++) {
    const a = pts[i], c = pts[(i + 1) % n];
    const dx = c.x - a.x, dz = c.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1.3) continue;                       // skip short edges → fewer wall boxes (perf)
    const mx = (a.x + c.x) / 2, mz = (a.z + c.z) / 2;
    // inward normal (toward centroid), normalized
    let nx = -dz / len, nz = dx / len;
    if (nx * (ccx - mx) + nz * (ccz - mz) < 0) { nx = -nx; nz = -nz; }
    const theta = Math.atan2(dz, dx);              // edge direction in XZ (physics frame)
    const box = makeCheapBox(len / 2, h / 2, half);
    const quat = new CANNON.Quaternion();
    quat.setFromAxisAngle(YAX, -theta);            // box local X → along this edge
    body.addShape(box, new CANNON.Vec3(mx + nx * half, groundY + h / 2, mz + nz * half), quat);
  }
}

const REACHABLE_DIST_SQ = 20 * 20; // m² — a building whose footprint is entirely farther than this from
                                   // ANY road can't be touched by the car (which stays on roads), so its
                                   // collider is pure waste. Skipping it cuts cannon-es Box garbage (the #1
                                   // GC source) at BOTH creation and per-frame collision. 20m = safe margin.
async function buildBuildingColliders(buildings, physicsOrigin, getElevationAt, vertExag, roads, yieldFn) {
  const bodies = [];
  if (!buildings || buildings.length === 0) return bodies;
  // Flat road-point list (world frame) for the reachability cull. Conservative: ALL roads (even footways)
  // count as reachable, so we only ever skip buildings that are far from EVERYTHING — never a real wall.
  const roadPts = [];
  for (const road of roads || []) { const p = road.points; if (p) for (let i = 0; i < p.length; i++) roadPts.push(p[i].x, p[i].y); }
  const nRoadPts = roadPts.length;
  function nearAnyRoad(fp) {
    if (!nRoadPts) return true; // no road data → keep collider (safe)
    for (let vi = 0; vi < fp.length; vi++) {
      const vx = fp[vi].x, vy = fp[vi].y;
      for (let r = 0; r < nRoadPts; r += 2) {
        const dx = vx - roadPts[r], dy = vy - roadPts[r + 1];
        if (dx * dx + dy * dy < REACHABLE_DIST_SQ) return true;
      }
    }
    return false;
  }
  const BATCH = 40;
  for (let start = 0; start < buildings.length; start += BATCH) {
    const end = Math.min(start + BATCH, buildings.length);
    const body = new CANNON.Body({ mass: 0 });
    let any = false;
    for (let bi = start; bi < end; bi++) {
      const b = buildings[bi];
      const fp = b.footprint;
      if (!fp || fp.length < 3) continue;
      if (!nearAnyRoad(fp)) continue; // unreachable interior building → no collider (car can't touch it)
      // ORIENTED bounding box (matches angled buildings — e.g. along Avinguda Diagonal — instead of
      // an AABB whose corners stick out into the roadway as an invisible wall). Work in the PHYSICS
      // frame directly so the box rotation is unambiguous under the X-mirror.
      const pfp = fp.map((p) => ({ x: -(p.x - physicsOrigin.x), z: p.y - physicsOrigin.z }));
      // dominant edge angle
      let phi = 0, bestLen = 0;
      for (let k = 0; k < pfp.length; k++) {
        const a = pfp[k], c2 = pfp[(k + 1) % pfp.length];
        const dx = c2.x - a.x, dz = c2.z - a.z;
        const l = dx * dx + dz * dz;
        if (l > bestLen) { bestLen = l; phi = Math.atan2(dz, dx); }
      }
      const cphi = Math.cos(phi), sphi = Math.sin(phi);
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (const p of pfp) {
        const u = p.x * cphi + p.z * sphi;
        const v = -p.x * sphi + p.z * cphi;
        if (u < minU) minU = u; if (u > maxU) maxU = u;
        if (v < minV) minV = v; if (v > maxV) maxV = v;
      }
      const hu = (maxU - minU) / 2, hv = (maxV - minV) / 2;
      if (hu < 0.6 || hv < 0.6) continue; // skip slivers
      const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
      const px = cu * cphi - cv * sphi;
      const pz = cu * sphi + cv * cphi;
      const h = Math.max(3, b.height || 6);
      let groundY = 0;
      if (getElevationAt) {
        const cxw = (fp.reduce((s, p) => s + p.x, 0) / fp.length);
        const czw = (fp.reduce((s, p) => s + p.y, 0) / fp.length);
        const { lat, lon } = worldToLatLon(cxw, czw);
        groundY = (getElevationAt(lat, lon) ?? 0) * vertExag;
      }
      // Clean footprint (drop closing dup + consecutive dups) for the convex test.
      let clean = [];
      for (const p of pfp) {
        const last = clean[clean.length - 1];
        if (!last || Math.abs(last.x - p.x) > 1e-3 || Math.abs(last.z - p.z) > 1e-3) clean.push(p);
      }
      if (clean.length > 1) {
        const f0 = clean[0], fl = clean[clean.length - 1];
        if (Math.abs(f0.x - fl.x) < 1e-3 && Math.abs(f0.z - fl.z) < 1e-3) clean.pop();
      }
      // Collapse near-collinear vertices up front — benefits BOTH the convex-prism path (fewer verts →
      // cheaper cannon-es ConvexPolyhedron) and the perimeter-wall path (fewer boxes). #1 GC allocator.
      clean = mergeCollinearRing(clean, COLLINEAR_MERGE_RAD);
      // Non-rectangular convex footprint (chamfered corner, angled block) → exact convex prism so the
      // collider hugs the real wall line and the corner sidewalk stays drivable. Rectangles use the cheap box.
      let prism = null;
      if (clean.length > 4) prism = buildConvexPrism(clean, groundY, h);
      if (prism) {
        body.addShape(prism.shape, prism.offset);
      } else if (clean.length > 4) {
        // Concave footprint (L/U-shaped block) — an OBB would fill the notch and jut into the road.
        // Trace the real outline with thin perimeter walls so the collider matches the visible building.
        addPerimeterWalls(body, clean, groundY, h);
      } else {
        // Triangle / quad (rectangles) → cheap tight oriented box (shared cache).
        const box = makeCheapBox(hu, h / 2, hv);
        const quat = new CANNON.Quaternion();
        quat.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), -phi); // box local X → footprint's dominant edge
        body.addShape(box, new CANNON.Vec3(px, groundY + h / 2, pz), quat);
      }
      any = true;
    }
    if (any) {
      body.collisionFilterGroup = COLLISION_GROUP_WORLD;
      body.collisionFilterMask  = COLLISION_GROUP_VEHICLE;
      body._ddKind = 'building';   // collisionDebug (K key) excludes buildings — user call 2026-07-12
      bodies.push(body);
    }
    // Yield between batches so a dense tile's collider creation spreads over a few frames instead of one
    // big synchronous burst (the "stutter when driving into a dense area"). The tile loads ahead of the
    // car, so the colliders still exist well before it arrives — no drive-through risk.
    if (yieldFn) await yieldFn();
  }
  return bodies;
}

function countVertices(meshes) {
  let n = 0;
  for (const m of meshes) {
    const pos = m.geometry?.attributes?.position;
    if (pos) n += pos.count;
  }
  return n;
}

/**
 * v3 P4-02 — terrain visibility and LOD ring.
 *
 * WHY TERRAIN LEFT THE GENERAL FOG CULL. Terrain used to be hidden with buildings and vegetation at
 * FOG_FULL_DIST (280 m). At the shipping FogExp2 density of 0.0025 that distance is only **38.7%
 * fogged** — the ground was being deleted while still ~61% visible — and it is the reason the city
 * has no distant landform at all: Montjuïc and the Collserola ridge stop existing 280 m out.
 * Buildings and vegetation are detail and stay culled; the ground is not detail.
 *
 * THE RINGS. `terrainGrid.js` emits three index sets over ONE vertex buffer (32,258 / 7,938 / 1,922
 * triangles), so switching is a `setIndex` — no vertex re-upload, no second mesh, no extra draw call.
 *
 * WHERE THE DISTANCES COME FROM, measured rather than chosen by eye:
 *   - FULL below 500 m, because roads drape on the full grid and a coarser ring would move the
 *     ground out from under them. This is a hard floor, not a preference.
 *   - 1:2 to 900 m. Fog is 89.5% at 600 m and 98.2% at 800 m, so mid-field detail is nearly gone.
 *   - 1:4 beyond that out to CUT, where fog is ~100% and the surface is pure fog colour. It still
 *     earns its place: a fog-coloured mass OCCLUDES the sky, and the sky dome is not the horizon
 *     colour higher up — that difference IS the silhouette. Expect a soft haze ridge, not detail.
 *
 * Hysteresis is a flat 60 m band so a tile sitting exactly on a boundary cannot flip ring every
 * frame; the ring only changes when the viewer has committed to crossing.
 */
const TERRAIN_LOD_FULL_M = 500;
const TERRAIN_LOD_MID_M  = 900;
const TERRAIN_CUT_M      = 1500;
const TERRAIN_LOD_HYST_M = 60;
// Distance past which guard-rail POSTS are dropped and only the beam line is drawn. 80 m: at the
// shipping fog density a 0.12 m post is already sub-pixel well before it, so this is conservative.
const RAIL_POST_DIST = 80;

/**
 * VEG-FIX-1 — billboard-impostor count fraction at `d`, ramping from full where the 3D trees give
 * out to zero at VEG_IMPOSTOR_CUT_M.
 *
 * This used to be clamped to FOG_FULL_DIST (280 m), which was correct while terrain died there too.
 * P4-02 took terrain to 1500 m and turned that clamp into a visible seam: bare ground from 280 m
 * out, with trees appearing and vanishing as tiles crossed the line. The cut is 600 m because that
 * is where FogExp2 at the shipping density of 0.0025 reaches 89.5% — vegetation past it cannot be
 * seen, so rendering it would be pure cost.
 */
const VEG_IMPOSTOR_CUT_M = 600;
const VEG_IMPOSTOR_HOLD_M = 300;   // full impostors until here, then fog takes over

/**
 * GROUND-COVER-FIX — how far the flat GROUND COVER survives the fog cull.
 *
 * THE SAME BUG, A THIRD TIME. Terrain draws to TERRAIN_CUT_M (1500 m) and roads are explicitly kept
 * "visible into fog for continuity" — but everything that COVERS the ground between them was still
 * dying at FOG_FULL_DIST (280 m). From a drone this reads as the whole city sitting on a lawn:
 * roads on bare grass-coloured terrain, with the buildings and plazas that belong there missing.
 *
 * P4-02 found this for terrain ("deleting ground that was still ~61% visible") and fixed terrain.
 * VEG-FIX-1 found the resulting seam for vegetation ("bare ground from 280 m out") and fixed
 * vegetation. Neither pass extended the built environment, so the ground it uncovered stayed bare.
 * Measured with `_ddGround()` from the air: greens 0 visible / 31 hidden, plazas 0 / 11, and the
 * pavement drawn on only 4 of 11 resident tiles.
 *
 * 600 m for the reason VEG_IMPOSTOR_CUT_M is 600: that is where FogExp2 at the shipping density of
 * 0.0025 reaches 89.5%. Past it the ground really is haze and drawing cover would be pure cost.
 *
 * ⚠ ONLY the cheap flat cover rides this. Park and plaza polygons are a handful of triangles each,
 * and `lodBuildingMesh` is the distant-building representation that already exists for this job.
 * Full building detail, pavements, kerbs and lane paint stay on the 280 m cull — they ARE detail,
 * they are the expensive half, and the frame budget is the binding constraint (v3: 246/450 draws).
 */
const GROUND_COVER_CUT_M = 600;

/**
 * ⚠ THE IMPOSTOR RAMP MUST COMPLEMENT THE 3D FADE, NOT FOLLOW IT.
 *
 * Measured before the fix, total tree presence driving toward a hill ran:
 *   400 m 0.47 -> 250 m 0.81 -> 171 m 1.00 -> **169 m 0.01** -> 120 m 0.56 -> 80 m 1.00
 * The 3D trees fade their COUNT out across 80-170 m while impostors did not begin until 170, so
 * that band was a hole and 170 m was a 100%->1% cliff the instant you crossed it going in. Trees
 * vanished as you approached and sprang back as you left. User-reported from a drive.
 *
 * So the ramp now rises where the 3D trees fall (80-170, summing to ~1), holds while the mid-field
 * is still clearly visible, and only then fades with the fog.
 */
function impostorFrac(d, treeFullDist, treeMaxDist) {
  if (d <= treeFullDist || d >= VEG_IMPOSTOR_CUT_M) return 0;
  // rising: fills in exactly what the 3D count fade is removing
  if (d < treeMaxDist) return (d - treeFullDist) / Math.max(1, treeMaxDist - treeFullDist);
  // holding: 3D trees are gone, impostors carry the canopy alone
  if (d <= VEG_IMPOSTOR_HOLD_M) return 1;
  // falling: FogExp2 at 0.0025 is 46% at 300 m and 89.5% at 600 m, so this fade hides inside the haze
  return 1 - (d - VEG_IMPOSTOR_HOLD_M) / (VEG_IMPOSTOR_CUT_M - VEG_IMPOSTOR_HOLD_M);
}

/**
 * Dev probe: `_ddVegLod()` — what the LOD decided for each loaded tile, right now.
 *
 * `_ddVegCount()` answers "do the trees exist and are any drawn" for the whole city. It cannot
 * answer "why is THIS hillside bare", because it aggregates every tile into one number. When trees
 * are visible from one spot and gone thirty metres later, the question is per-tile: which band is
 * that tile in, and what count did each of its handles get.
 *
 * Populated by the LOD pass each time it runs; reading it costs nothing.
 */
const _ddLodState = new Map();
if (typeof window !== 'undefined') {
  window._ddVegLod = () => {
    const rows = [...(_ddLodState.entries())]
      .sort((a, b) => a[1].d - b[1].d)
      .map(([key, v]) => {
        const parts = Object.entries(v.kinds)
          .map(([k, c]) => `${k} ${c.vis}/${c.total}`).join('  ');
        return `${key.padEnd(16)} nearEdge ${String(Math.round(v.d)).padStart(5)} m  ` +
               `frac ${v.frac.toFixed(2)}  bb ${v.bb.toFixed(2)}  ${v.fog ? 'FOG-CULLED' : 'near     '}  ${parts}`;
      });
    return rows.length ? rows.join('\n') : '(no tiles — is the LOD pass running?)';
  };
}

function _ddRecordLod(key, d, frac, bb, fog, handles) {
  if (typeof window === 'undefined') return;
  const kinds = {};
  for (const h of handles || []) {
    const k = h.kind || 'tree';
    (kinds[k] ||= { vis: 0, total: 0 });
    kinds[k].vis += h.visCount || 0;
    kinds[k].total += h.count || 0;
  }
  _ddLodState.set(key, { d, frac, bb, fog, kinds });
}

function applyTerrainLod(entry, nearEdgeDist) {
  const mesh = entry.terrainMesh;
  if (!mesh) return;
  if (CONFIG.TERRAIN_INVISIBLE) { mesh.visible = false; return; }

  mesh.visible = nearEdgeDist <= TERRAIN_CUT_M;
  if (!mesh.visible) return;

  const rings = mesh.geometry?.userData?.lodRings;
  if (!rings) return;   // a tile still on its baked mesh has no rings — leave its index alone

  const prev = entry._terrainRing || 'full';
  // Widen the band we must exit before stepping DOWN in detail, so the flip point differs by
  // direction — that asymmetry is what stops the oscillation.
  const h = TERRAIN_LOD_HYST_M;
  let next = prev;
  if (prev === 'full')      next = nearEdgeDist > TERRAIN_LOD_FULL_M + h ? 'mid' : 'full';
  else if (prev === 'mid')  next = nearEdgeDist < TERRAIN_LOD_FULL_M - h ? 'full'
                                 : nearEdgeDist > TERRAIN_LOD_MID_M + h ? 'far' : 'mid';
  else                      next = nearEdgeDist < TERRAIN_LOD_MID_M - h ? 'mid' : 'far';

  if (next !== prev) {
    entry._terrainRing = next;
    mesh.geometry.setIndex(rings[next]);
  }
}

/** @type {Map<string, { roads: object[], buildings: object[], roadMeshes?: THREE.Mesh[], buildingMeshes?: THREE.Mesh[], spatialIndex?: object }>} */
const tileCache = new Map();
// Dev diagnostic handle: `_ddOnRoad()` in main.js needs the resident tiles' road geometry to ask
// "which renderer put this instance on the road". Read-only; nothing in the game reads it back.
if (typeof window !== 'undefined') window._ddTiles = tileCache;
let _tileEpoch = 0;   // bumped on every tileCache add/delete — see getTileEpoch()

// Dev: window._findWhiteTiles() — hunts the "white terrain tile" (identify v2: 16384-vert Lambert
// white). Scans every loaded terrain mesh's colour/aAO/aCoast attributes for NaN or near-white
// and names the tile keys — the producing branch gets fixed from that.
if (typeof window !== 'undefined') {
  window._findWhiteTiles = () => {
    const out = [];
    for (const [key, e] of tileCache.entries()) {
      const g = e.terrainMesh?.geometry;
      if (!g) continue;
      const rep = { key };
      for (const [name, comps] of [['color', 3], ['aAO', 1], ['aCoast', 1]]) {
        const a = g.getAttribute(name);
        if (!a) { rep[name] = 'MISSING'; continue; }
        let nan = 0, sum = 0, n = a.count * comps;
        for (let i = 0; i < n; i++) { const v = a.array[i]; if (Number.isNaN(v)) nan++; else sum += v; }
        rep[name] = `${nan ? 'NaN×' + nan + ' ' : ''}mean ${(sum / Math.max(1, n - nan)).toFixed(3)}`;
      }
      const suspicious = /MISSING|NaN/.test(rep.color + rep.aAO + rep.aCoast)
        || parseFloat(String(rep.color).replace(/^.*mean /, '')) > 0.8;
      if (suspicious) out.push(rep);
    }
    console.warn('[whiteTiles]', out.length ? '' : 'none suspicious of ' + tileCache.size + ' tiles');
    for (const r of out) console.warn('[whiteTiles]', r.key, '| color', r.color, '| aAO', r.aAO, '| aCoast', r.aCoast);
    return out;
  };
}

// Dev: window._aoDebug() — ground truth on whether baked-AO attributes are live in the running
// session. Reports, per surface family, how many loaded meshes carry aAO and the darkening stats.
if (typeof window !== 'undefined') {
  window._aoDebug = () => {
    const fam = {};
    const scan = (mesh, name) => {
      if (!mesh?.geometry) return;
      const f = (fam[name] ||= { meshes: 0, withAO: 0, verts: 0, sum: 0, max: 0 });
      f.meshes++;
      const a = mesh.geometry.getAttribute('aAO');
      if (!a) return;
      f.withAO++;
      for (let i = 0; i < a.count; i++) {
        const v = a.getX(i);
        f.verts++; f.sum += v; if (v > f.max) f.max = v;
      }
    };
    for (const e of tileCache.values()) {
      scan(e.terrainMesh, 'terrain');
      (e.roadMeshes || []).forEach((m) => scan(m, 'roads'));
      (e.greenMeshes || []).forEach((m) => scan(m, 'greens'));
      (e.buildingMeshes || []).forEach((m) => scan(m, 'buildings'));
    }
    const out = {};
    for (const [k, f] of Object.entries(fam)) {
      out[k] = `${f.withAO}/${f.meshes} meshes with aAO · mean dark ${(f.verts ? f.sum / f.verts : 0).toFixed(3)} · max ${f.max.toFixed(3)}`;
    }
    // terrain stores a MULTIPLIER (≈1 = no AO), everything else stores DARKENING (0 = no AO)
    console.table(out);
    return out;
  };
}
/** Tile keys currently being loaded – avoid starting duplicate requests */
const loadingKeys = new Set();

// Custom minimap hooks — fired when a tile's 2D features become available / are unloaded, so a
// self-drawn vector map can mirror exactly the tiles that are loaded. No-ops unless wired.
let _onMapTileReady = null;    // (key, tileData)
let _onMapTileRemoved = null;  // (key)
export function setMapTileCallbacks(onReady, onRemoved) { _onMapTileReady = onReady; _onMapTileRemoved = onRemoved; }
/** Max concurrent tile requests to avoid Overpass 429 rate limit */
const MAX_CONCURRENT_TILE_LOADS = 3;  // fetch is async; the shared per-frame build budget still caps CPU work

function tileKey(tx, ty) {
  return `${tx}_${ty}`;
}

function tileDistance(tx1, ty1, tx2, ty2) {
  return Math.max(Math.abs(tx1 - tx2), Math.abs(ty1 - ty2));
}

/**
 * Create debug wireframe helpers for road box bodies and optional heightfield (DEBUG_PHYSICS_DECKS).
 * Returns a Group in worldGroup local coordinates (origin + scale.x = -1 applied).
 */
function createDebugPhysicsHelpers(trimeshBody, heightfieldBody, physicsOrigin) {
  const group = new THREE.Group();
  const roadColor = 0x00ff00;
  const terrainColor = 0xffaa00;

  if (trimeshBody) {
    // Draw a wireframe box for each segment shape
    for (let si = 0; si < trimeshBody.shapes.length; si++) {
      const s   = trimeshBody.shapes[si];
      if (!(s instanceof CANNON.Box)) continue;
      const off = trimeshBody.shapeOffsets[si];       // CANNON.Vec3
      const ori = trimeshBody.shapeOrientations[si];  // CANNON.Quaternion

      // physics → worldGroup local space
      // worldGroup.position = (originX, 0, -originZ), scale.x = -1
      // scene_x = originX + wx * (-1)  →  wx = originX - off.x
      // scene_z = -originZ + wz        →  wz = off.z + originZ
      const wx = physicsOrigin.x - off.x;
      const wy = off.y;
      const wz = off.z + physicsOrigin.z;

      const hx = s.halfExtents.x, hy = s.halfExtents.y, hz = s.halfExtents.z;

      const geom = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
      const mat  = new THREE.MeshBasicMaterial({ color: roadColor, wireframe: true, depthTest: false });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.renderOrder = 1000;
      mesh.frustumCulled = false;
      mesh.position.set(wx, wy, wz);
      // Mirror quaternion for worldGroup.scale.x=-1: M·Ry·M = Ry(-θ) and M·Rz·M = Rz(-θ)
      // so negate the y and z components to get the correct visual orientation.
      mesh.quaternion.set(ori.x, -ori.y, -ori.z, ori.w);
      group.add(mesh);
    }
  }

  if (heightfieldBody) {
    const aabb = getHeightfieldWorldAABB(heightfieldBody);
    if (aabb) {
      const lb = aabb.lowerBound;
      const ub = aabb.upperBound;
      const box3 = new THREE.Box3(
        new THREE.Vector3(physicsOrigin.x + lb.x, lb.y, lb.z + physicsOrigin.z),
        new THREE.Vector3(physicsOrigin.x + ub.x, ub.y, ub.z + physicsOrigin.z)
      );
      const helper = new THREE.Box3Helper(box3, terrainColor);
      group.add(helper);
    }
  }

  return group;
}

const DECK_THICKNESS = 0.20;  // total box height in metres — thin so end-caps (< chassis clearance of 0.28 m) don't block the car
const MIN_SEG_LENGTH = 0.2;   // skip degenerate segments shorter than this

/**
 * Phase-1 safety guard (playbook C4): never insert a physics shape with a non-finite
 * position / extent. A single NaN body position poisons the cannon-es solver and can
 * launch the car to infinity. Returns true when ALL provided values are finite; on
 * failure logs context (road id + segment index + which value) and the caller SKIPS
 * the shape. Behaviourally inert except in the exact NaN/Infinity case it catches.
 * @param {string} where   - call-site label (e.g. 'deckBox')
 * @param {(string|number)} roadId
 * @param {number} segIndex
 * @param {Record<string, number>} values - named scalars that must all be finite
 */
function assertFiniteShape(where, roadId, segIndex, values) {
  for (const k in values) {
    if (!Number.isFinite(values[k])) {
      console.warn(`[tunnel/physics] skip ${where} shape — non-finite ${k}=${values[k]} (road ${roadId}, seg ${segIndex})`);
      return false;
    }
  }
  return true;
}

/**
 * Create one CANNON.Body with per-segment CANNON.Box shapes for all elevated roads in a tile.
 * Replaces the old CANNON.Trimesh approach which failed with RaycastVehicle wheel raycasts
 * due to degenerate BVH AABBs on near-flat road ribbons.
 *
 * @param {object[]} roads - roads with points { x, y, elevation }
 * @param {{ offset: number, vertExag: number, world: CANNON.World, roadMaterial: CANNON.Material|null, tileKey?: string, getGroundYAt?: ((wx: number, wz: number) => number)|null }}
 */
function createRoadTrimeshColliders(roads, opts) {
  const { offset, vertExag, world, roadMaterial, tileKey } = opts;
  const physicsOrigin  = getOriginOffset();
  const elevationOffset = offset; // D-12: tileMinElevation retired — never rebased per-tile, always the spawn offset
  const toPhysY = (raw) => toNormalizedRoadY(raw, elevationOffset, vertExag);

  const halfThick = DECK_THICKNESS / 2;

  const body = new CANNON.Body({ mass: 0 });
  let shapeCount = 0;

  // Diagnostic: always log entry so we know the function was called

  // --- Pre-pass: collect centerlines of all eligible roads for overlap detection ---
  // Each entry: { roadId, segments: [{mx,mz}], halfW }
  // Used to skip box colliders whose center falls inside another road's corridor.
  const roadCenterlines = [];
  for (const road of roads || []) {
    const pts2 = road.points || [];
    if (pts2.length < 2) continue;
    const ib = road.bridge === true || (road.layer != null && Number.isFinite(road.layer) && road.layer > 0);
    const it = road.tunnel === true || (road.layer != null && Number.isFinite(road.layer) && road.layer < 0);
    const ir = road.isRamp === true;
    // Structural flags only — mirrors the deck-collider gate below (height heuristic deleted, Phase 2 D1).
    if (!ib && !it && !ir && road.crossesTrench !== true) continue;
    const segs = [];
    for (let j = 0; j < pts2.length - 1; j++) {
      const pa = pts2[j], pb = pts2[j + 1];
      const ax2 = -(pa.x - physicsOrigin.x), az2 = pa.y - physicsOrigin.z;
      const bx2 = -(pb.x - physicsOrigin.x), bz2 = pb.y - physicsOrigin.z;
      segs.push({ ax: ax2, az: az2, bx: bx2, bz: bz2 });
    }
    const w = Number.isFinite(road.width) && road.width > 0 ? road.width : 6;
    roadCenterlines.push({ roadId: road.id, segments: segs, halfW: w / 2 });
  }

  // Return the minimum distance from box center to any OTHER road's centerline.
  // Also returns that road's halfW. Used to clip box width at merge zones.
  function distToNearestOtherRoad(px, pz, thisRoadId) {
    let minDist = Infinity;
    let otherHalfW = 0;
    for (const rc of roadCenterlines) {
      if (rc.roadId === thisRoadId) continue;
      for (const seg of rc.segments) {
        const sdx = seg.bx - seg.ax, sdz = seg.bz - seg.az;
        const slen2 = sdx * sdx + sdz * sdz;
        if (slen2 < 0.01) continue;
        const t = Math.max(0, Math.min(1, ((px - seg.ax) * sdx + (pz - seg.az) * sdz) / slen2));
        const cx = seg.ax + t * sdx, cz = seg.az + t * sdz;
        const dist = Math.hypot(px - cx, pz - cz);
        if (dist < minDist) {
          minDist = dist;
          otherHalfW = rc.halfW;
        }
      }
    }
    return { dist: minDist, otherHalfW };
  }

  for (const road of roads || []) {
    const pts = road.points || [];
    if (pts.length < 2) continue;

    const isBridge = road.bridge === true ||
                     (road.layer != null && Number.isFinite(road.layer) && road.layer > 0);
    const isTunnel = road.tunnel === true ||
                     (road.layer != null && Number.isFinite(road.layer) && road.layer < 0);
    const isRamp   = road.isRamp === true;

    // STRUCTURAL FLAGS ONLY (Phase 2 deletion, D-15/D-16): surface roads get NO deck
    // colliders — they ride the terrain heightfield (raycastable + box-collidable since
    // Phase 0). The old `isElevatedByHeight` height-delta fallback here was the phantom-
    // deck factory AND a live G-47 absolute-Y bug (spawn-frame ±0.3 m thresholds → every
    // sloped road off-spawn minted deck boxes). Deletable ONLY because the heightfield
    // exists; do not reintroduce a height heuristic without a terrain-relative frame.
    // crossesTrench (Option L) is a BAKE-SET structural flag, not a height heuristic:
    // streets crossing above a daylighted tunnel corridor bridge it on deck colliders.
    const isTrenchCrossing = road.crossesTrench === true;
    if (!isBridge && !isTunnel && !isRamp && !isTrenchCrossing) continue;

    const rawWidth = Number.isFinite(road.width) && road.width > 0 ? road.width : (isTunnel ? 4 : 6);
    // Tunnel box colliders match enclosure width: road halfW + WALL_EXTRA_WIDTH (1m)
    const roadWidth = isTunnel ? rawWidth + 2 : rawWidth;
    const halfW     = roadWidth / 2;

    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i], p1 = pts[i + 1];

      const x0 = -(p0.x - physicsOrigin.x);  // negate X: worldGroup.scale.x = -1 mirrors road visuals
      const z0 = p0.y - physicsOrigin.z;
      const y0 = (p0.elevation != null && Number.isFinite(p0.elevation))
                 ? toPhysY(p0.elevation)
                 : (opts.getGroundYAt ? opts.getGroundYAt(p0.x, p0.y) : 0);

      const x1 = -(p1.x - physicsOrigin.x);  // negate X: worldGroup.scale.x = -1 mirrors road visuals
      const z1 = p1.y - physicsOrigin.z;
      const y1 = (p1.elevation != null && Number.isFinite(p1.elevation))
                 ? toPhysY(p1.elevation)
                 : (opts.getGroundYAt ? opts.getGroundYAt(p1.x, p1.y) : 0);

      const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
      const len3d = Math.hypot(dx, dy, dz);
      if (len3d < MIN_SEG_LENGTH) continue;

      // Step 1 — yaw (around global Y) to face horizontal heading
      const yaw = Math.atan2(dx, dz);
      const qYaw = new CANNON.Quaternion();
      qYaw.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);

      // Step 2 — pitch (around local X) to match slope
      const len2d  = Math.hypot(dx, dz);
      const pitch  = Math.atan2(dy, len2d);
      const qPitch = new CANNON.Quaternion();
      qPitch.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -pitch);

      const qFinal = new CANNON.Quaternion();
      qYaw.mult(qPitch, qFinal);

      const cosP = Math.cos(pitch);
      const sinP = Math.sin(pitch);
      const len2dSafe = Math.max(len2d, 1e-6);
      const midX = (x0 + x1) / 2;
      const midY = (y0 + y1) / 2;
      const midZ = (z0 + z1) / 2;

      // Clip box width if it would overlap another road's corridor at merge zones — but ONLY
      // near ground level. The clip exists to stop co-planar decks forming lips; on a HIGH deck
      // (flyover approaching its merge-down) clipping to 1.5m half-width left the car on the
      // full-width VISUAL deck (which ramp-divergence also shifts laterally up to ~2.4m) with no
      // collider under it → fell through at merges. Up high, plan-view overlap is harmless (the
      // other road is metres below); near ground the heightfield catches anything we miss.
      let effectiveHalfW = halfW;
      const midWorldX = (p0.x + p1.x) / 2, midWorldZ = (p0.y + p1.y) / 2;
      const gY = opts.getGroundYAt ? opts.getGroundYAt(midWorldX, midWorldZ) : null;
      const deckAboveGround = Number.isFinite(gY) ? (midY - gY) : 0;
      // ── N-29 · THE CLIP RELIES ON THE HEIGHTFIELD BEING RIGHT UNDER THE DECK ──────────────────
      //
      // Narrowing the collider where two corridors overlap is only safe if something else carries
      // the car there, and the note above says what that is: "near ground the heightfield catches
      // anything we miss". That holds when the deck IS the ground. At 1.5 m it does not — a deck
      // 1.4 m up with a clipped collider drops the car onto terrain, or through where the terrain
      // is missing, and the user sees exactly that at merges ("no proper merge so road falls").
      //
      // Two changes, both narrowing WHEN the clip applies rather than removing it:
      //   · CO_PLANAR_M 1.5 -> 0.35. The clip's own justification is co-planarity, and 0.35 m is
      //     kerb height — above that the surfaces are not co-planar and the lip argument does not
      //     apply either.
      //   · a floor of 60% of the road's OWN half-width, not a flat 1.5 m. On a 15 m trunk the old
      //     floor left 3 m of collider under 15 m of asphalt: the outer lanes had nothing at all.
      // A small lip where two decks overlap is a bump. A missing collider is a fall.
      const CO_PLANAR_M = 0.35;
      if (deckAboveGround < CO_PLANAR_M) {
        const { dist, otherHalfW } = distToNearestOtherRoad(midX, midZ, road.id);
        if (dist < halfW + otherHalfW) {
          // Stop at the other road's edge + 0.5m overlap margin so the seam has no gap; the
          // surfaces are near co-planar here, so the margin lip is a few cm at most.
          effectiveHalfW = Math.max(halfW * 0.6, Math.min(halfW, dist - otherHalfW + 0.5));
        }
      }

      // Box half-extents: width × thickness × half-length
      const shape = new CANNON.Box(new CANNON.Vec3(effectiveHalfW, halfThick, len3d / 2));

      // Position box center so the TOP FACE (local +Y) aligns with the road surface.
      const offset3 = new CANNON.Vec3(
        midX + halfThick * sinP * (dx / len2dSafe),
        midY - halfThick * cosP,
        midZ + halfThick * sinP * (dz / len2dSafe),
      );

      if (!assertFiniteShape('deckBox', road.id, i, {
        x: offset3.x, y: offset3.y, z: offset3.z,
        halfW: effectiveHalfW, halfLen: len3d / 2,
      })) continue;
      body.addShape(shape, offset3, qFinal);
      if (shapeCount === 0) {
        // Log first box center so we can compare to car position
      }
      shapeCount++;
    }
  }

  if (typeof window !== 'undefined') {
    if (!window._deckColliderDebug) window._deckColliderDebug = [];
    const entry = { tileKey: tileKey || 'unknown', boxShapes: shapeCount, body };
    window._deckColliderDebug.push(entry);
    // Helper: window._dumpBoxes() shows all ABOVE-GROUND box centers vs car position
    window._dumpBoxes = () => {
      if (window._debugWorld) {
        const car = window._debugWorld.bodies.find(b => b.mass > 0);
      }
      for (const e of window._deckColliderDebug) {
        if (!e.body || e.body.shapes.length === 0) continue;
        const s = e.body.shapeOffsets;
        // Only show boxes with center y > -0.5 (at or above ground level)
        const above = s.map((o, i) => ({ i, x: o.x, y: o.y, z: o.z })).filter(b => b.y > -0.5);
        if (above.length === 0) continue;
        for (const b of above.slice(0, 10)) {
        }
      }
    };
  }

  if (shapeCount === 0) {
    return { bridgeBodies: [], tunnelBodies: [], trimeshBody: null };
  }

  if (roadMaterial) body.material = roadMaterial;
  body.collisionFilterGroup = COLLISION_GROUP_GROUND;
  body.collisionFilterMask  = COLLISION_GROUP_VEHICLE;
  body.position.set(0, 0, 0);
  world.addBody(body);

  // Debug: log first few collisions so we know the box IS being hit

  return { bridgeBodies: [], tunnelBodies: [], trimeshBody: body };
}

const WALL_THICKNESS = 0.3;   // metres — thin wall collider
// N-33: a tunnel wall collider only has to CONTAIN the car, so it is the tunnel's own clearance,
// not the road's absolute elevation. tunnelRenderer draws the enclosure at TUNNEL_CLEARANCE = 4.5;
// a little more here keeps a bouncing car in without the wall poking through the visual ceiling.
const TUNNEL_WALL_H = 5.0;
const WALL_EXTRA_W   = 1;     // must match tunnelRenderer.js WALL_EXTRA_WIDTH

/**
 * Create CANNON wall colliders for tunnel enclosures.
 * Two thin vertical box shapes per road segment (left + right wall).
 */
function createTunnelWallColliders(tunnelRoads, world, roadMaterial) {
  if (!tunnelRoads?.length || !world) return null;

  const physicsOrigin = getOriginOffset();
  const body = new CANNON.Body({ mass: 0 });
  let shapeCount = 0;

  // Build centerlines for overlap detection — skip walls that fall inside another road
  const centerlines = [];
  for (const road of tunnelRoads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const segs = [];
    for (let j = 0; j < pts.length - 1; j++) {
      const pa = pts[j], pb = pts[j + 1];
      segs.push({
        ax: -(pa.x - physicsOrigin.x), az: pa.y - physicsOrigin.z,
        bx: -(pb.x - physicsOrigin.x), bz: pb.y - physicsOrigin.z,
      });
    }
    centerlines.push({ roadId: road.id, segments: segs, halfW: (road.width || 4) / 2 });
  }

  function isInsideOtherRoad(px, pz, thisRoadId) {
    for (const rc of centerlines) {
      if (rc.roadId === thisRoadId) continue;
      for (const seg of rc.segments) {
        const sdx = seg.bx - seg.ax, sdz = seg.bz - seg.az;
        const slen2 = sdx * sdx + sdz * sdz;
        if (slen2 < 0.01) continue;
        const t = Math.max(0, Math.min(1, ((px - seg.ax) * sdx + (pz - seg.az) * sdz) / slen2));
        const cx = seg.ax + t * sdx, cz = seg.az + t * sdz;
        const dist = Math.hypot(px - cx, pz - cz);
        if (dist < rc.halfW + 2) return true; // inside another tunnel road's corridor
      }
    }
    return false;
  }

  for (const road of tunnelRoads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;

    const halfW = (road.width || 4) / 2 + WALL_EXTRA_W;

    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const eA = a.elevation != null ? a.elevation : -6;
      const eB = b.elevation != null ? b.elevation : -6;

      // Physics-space coordinates (negated X for worldGroup mirror)
      const ax = -(a.x - physicsOrigin.x), az = a.y - physicsOrigin.z;
      const bx = -(b.x - physicsOrigin.x), bz = b.y - physicsOrigin.z;

      const dx = bx - ax, dz = bz - az;
      const segLen = Math.hypot(dx, dz);
      if (segLen < 0.2) continue;

      // Perpendicular direction in physics space
      const nx = -dz / segLen, nz = dx / segLen;

      // ── N-33 · A TUNNEL WALL IS AS TALL AS THE TUNNEL, NOT AS TALL AS THE HILL ───────────────
      //
      // This was `Math.max(Math.abs(eA), Math.abs(eB))` with the note "from road elevation to
      // ceiling (Y ~ 0)" — a FLAT-WORLD assumption: it takes the road's absolute Y as a height,
      // which is only a wall height if the ceiling really sits at zero. In the spawn-anchored frame
      // `eA` is just the road's Y, so a tunnel 40 m up the hill got a **40 m tall collider**. That
      // is the user's "really high collision boxes", and they are invisible without the K overlay
      // because a wall only has to be tall enough to contain the car.
      //
      // The vertical-model spec supersedes the flat-world assumptions this predates. A road tunnel
      // is TUNNEL_WALL_H tall, measured UP from its own floor, wherever that floor happens to be.
      const wallH = TUNNEL_WALL_H;
      const halfH = wallH / 2;

      // Yaw to face along the segment
      const yaw = Math.atan2(dx, dz);
      const qYaw = new CANNON.Quaternion();
      qYaw.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);

      // Centre the wall on its own segment: floor + half the wall, per end.
      const midYA = eA + halfH;
      const midYB = eB + halfH;
      const midY = (midYA + midYB) / 2;
      const midAlong = { x: (ax + bx) / 2, z: (az + bz) / 2 };

      // Left wall — skip if it falls inside another tunnel road
      const lx = midAlong.x - nx * halfW;
      const lz = midAlong.z - nz * halfW;
      if (!isInsideOtherRoad(lx, lz, road.id) &&
          assertFiniteShape('tunnelWallL', road.id, i, { x: lx, y: midY, z: lz, halfH, halfLen: segLen / 2 })) {
        body.addShape(
          new CANNON.Box(new CANNON.Vec3(WALL_THICKNESS / 2, halfH, segLen / 2)),
          new CANNON.Vec3(lx, midY, lz),
          qYaw,
        );
        shapeCount++;
      }

      // Right wall — skip if it falls inside another tunnel road
      const rx = midAlong.x + nx * halfW;
      const rz = midAlong.z + nz * halfW;
      if (!isInsideOtherRoad(rx, rz, road.id) &&
          assertFiniteShape('tunnelWallR', road.id, i, { x: rx, y: midY, z: rz, halfH, halfLen: segLen / 2 })) {
        body.addShape(
          new CANNON.Box(new CANNON.Vec3(WALL_THICKNESS / 2, halfH, segLen / 2)),
          new CANNON.Vec3(rx, midY, rz),
          qYaw,
        );
        shapeCount++;
      }
    }
  }

  if (shapeCount === 0) return null;

  if (roadMaterial) body.material = roadMaterial;
  body.collisionFilterGroup = COLLISION_GROUP_GROUND;
  body.collisionFilterMask  = COLLISION_GROUP_VEHICLE;
  body.position.set(0, 0, 0);
  world.addBody(body);

  return body;
}

const RETAINING_LIP_THRESHOLD = -0.05; // build wall where road dips below ~surface (matches tunnelRenderer)
const RETAINING_SURF_Y = 0.05;         // wall top = terrain surface (matches buildRetainingWalls topY)
const RETAINING_MIN_WALL_H = 0.5;      // min box height so the lip wall is a robust collider

/**
 * Physics containment walls for L0 wallApproachRoads (Phase-2 Option A).
 *
 * The L0 surface-approach carriageways descending into a portal get a deck box but, until
 * now, NO wall physics (createTunnelWallColliders only runs for layer<0 tunnelRoads). The
 * physics terrain cut is far wider than the deck (measured 31–87m), so the car drove off the
 * undecked deck edge into the cut. These thin vertical CANNON.Box walls sit at the deck edge
 * (road/2) and span the road floor up to the surface (RETAINING_SURF_Y) — containing the car
 * on the deck so the over-cut width is irrelevant. Mirrors createTunnelWallColliders.
 *
 * Constraints:
 *  - OVERLAP-SKIP across BOTH sets: a wall inside another approach OR tunnel-ramp corridor is
 *    skipped (tunnel ramps already have their own walls) — prevents overlapping boxes → solver NaN.
 *  - OPEN AT MOUTH: only side walls are built, per descent segment; the run ends where the road
 *    reaches the surface (elevation ≥ threshold). No wall is built across the mouth face.
 *  - Every addShape passes the Number.isFinite guard (skip+warn, never insert).
 */
function createApproachWallColliders(wallApproachRoads, tunnelRoads, world, roadMaterial) {
  if (!wallApproachRoads?.length || !world) return null;

  const physicsOrigin = getOriginOffset();
  const body = new CANNON.Body({ mass: 0 });
  let shapeCount = 0;

  // Combined corridors for overlap-skip: approach roads at road/2, tunnel ramps at road/2 +
  // WALL_EXTRA_W (where their walls actually sit). Skip any wall box inside another's corridor.
  const centerlines = [];
  const addCenterlines = (roads, extra) => {
    for (const road of roads || []) {
      const pts = road.points;
      if (!pts || pts.length < 2) continue;
      const segs = [];
      for (let j = 0; j < pts.length - 1; j++) {
        const pa = pts[j], pb = pts[j + 1];
        segs.push({ ax: -(pa.x - physicsOrigin.x), az: pa.y - physicsOrigin.z,
                    bx: -(pb.x - physicsOrigin.x), bz: pb.y - physicsOrigin.z });
      }
      centerlines.push({ roadId: road.id, segments: segs, halfW: (road.width || 6) / 2 + extra });
    }
  };
  addCenterlines(wallApproachRoads, 0);
  addCenterlines(tunnelRoads, WALL_EXTRA_W);

  function isInsideOtherRoad(px, pz, thisRoadId) {
    for (const rc of centerlines) {
      if (rc.roadId === thisRoadId) continue;
      for (const seg of rc.segments) {
        const sdx = seg.bx - seg.ax, sdz = seg.bz - seg.az;
        const slen2 = sdx * sdx + sdz * sdz;
        if (slen2 < 0.01) continue;
        const t = Math.max(0, Math.min(1, ((px - seg.ax) * sdx + (pz - seg.az) * sdz) / slen2));
        const cx = seg.ax + t * sdx, cz = seg.az + t * sdz;
        if (Math.hypot(px - cx, pz - cz) < rc.halfW + 2) return true; // inside another road's corridor
      }
    }
    return false;
  }

  for (const road of wallApproachRoads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const halfW = (road.width || 6) / 2; // deck edge (surface road — no WALL_EXTRA)

    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const eA = a.elevation != null ? a.elevation : 0;
      const eB = b.elevation != null ? b.elevation : 0;
      // Only where the road dips below the surface (extended to the lip). Open at mouth:
      // the surface-level segments are skipped, so no wall crosses the mouth face.
      if (eA >= RETAINING_LIP_THRESHOLD && eB >= RETAINING_LIP_THRESHOLD) continue;

      const ax = -(a.x - physicsOrigin.x), az = a.y - physicsOrigin.z;
      const bx = -(b.x - physicsOrigin.x), bz = b.y - physicsOrigin.z;
      const dx = bx - ax, dz = bz - az;
      const segLen = Math.hypot(dx, dz);
      if (segLen < 0.2) continue;

      const nx = -dz / segLen, nz = dx / segLen;
      const yaw = Math.atan2(dx, dz);
      const qYaw = new CANNON.Quaternion();
      qYaw.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);

      // Wall spans road floor (deepest endpoint) up to the surface; min height keeps the box robust.
      const top = RETAINING_SURF_Y;
      const bottom = Math.min(eA, eB, top - RETAINING_MIN_WALL_H);
      const halfH = (top - bottom) / 2;
      const midY = (top + bottom) / 2;
      const mid = { x: (ax + bx) / 2, z: (az + bz) / 2 };

      for (const sign of [-1, 1]) {
        const wx = mid.x + sign * nx * halfW;
        const wz = mid.z + sign * nz * halfW;
        if (isInsideOtherRoad(wx, wz, road.id)) continue;          // overlap-skip vs tunnel walls + approaches
        if (!assertFiniteShape(sign < 0 ? 'approachWallL' : 'approachWallR', road.id, i,
              { x: wx, y: midY, z: wz, halfH, halfLen: segLen / 2 })) continue;
        body.addShape(
          new CANNON.Box(new CANNON.Vec3(WALL_THICKNESS / 2, halfH, segLen / 2)),
          new CANNON.Vec3(wx, midY, wz),
          qYaw,
        );
        shapeCount++;
      }
    }
  }

  if (shapeCount === 0) return null;

  if (roadMaterial) body.material = roadMaterial;
  body.collisionFilterGroup = COLLISION_GROUP_GROUND;
  body.collisionFilterMask  = COLLISION_GROUP_VEHICLE;
  body.position.set(0, 0, 0);
  world.addBody(body);

  return body;
}

// v3 P0-12: createTerrainTrimesh() DELETED — it had zero call sites. Terrain physics is a
// cannon Heightfield (buildTerrainHeightfield), never a Trimesh; this was dormant reference
// code carrying the whole bakedPhysicsTerrain parse chain behind it.

/**
 * Create tile manager. Requires roadRenderer, buildingRenderer, and renderVegetation.
 * (v3 P1: renderBushes / renderTrafficLights removed — see decisions.md and the P1 deletions.)
 * @param {THREE.Group} scene - worldGroup to add meshes to
 * @param {(roads: object[]) => THREE.Mesh[]} createRoadMeshes
 * @param {(buildings: object[]) => THREE.Mesh[]} createBuildingMeshes
 * @param {(roads: object[]) => object} createSpatialIndex
 * @param {(tileData: object, tileKey?: string) => { treeMeshes: THREE.InstancedMesh[], greenAreaMeshes: THREE.Mesh[] }} renderVegetation
 * @param {THREE.Camera} [camera]
 * @param {CANNON.World} [world] - physics world; required for terrain heightfield colliders
 * @param {CANNON.Body} [groundBody] - flat plane body; removed when first heightfield is added, re-added when last is removed
 */
/** Live geometry count from the renderer, or -1 where there is no renderer (tests, workers). */
function geometryCount() {
  try { return globalThis.window?._ddRenderer?.info?.memory?.geometries ?? -1; } catch { return -1; }
}

/**
 * `?debug=leak` — task #39. Accumulates over the drive and prints on every tile unload.
 *
 * The two columns answer different questions, and the leak is whichever one drifts:
 *
 *   held / freed / shared   what the unload WALK saw on this tile's own objects. `held - freed -
 *                           shared` above zero means the walk is holding geometry it will not free.
 *   Δgeometries             what the RENDERER's count actually did. If the walk freed 40 and the
 *                           renderer only dropped 28, twelve geometries exist that this tile
 *                           created and never handed to the walk — a different bug, in a different
 *                           place, needing a different fix.
 */
let _leakTotals = null;
function reportUnloadAccounting(acct, before) {
  const after = geometryCount();
  const delta = (before >= 0 && after >= 0) ? after - before : null;
  _leakTotals ||= { tiles: 0, held: 0, freed: 0, shared: 0, rendererFreed: 0, unaccounted: 0 };
  _leakTotals.tiles++;
  _leakTotals.held += acct.held;
  _leakTotals.freed += acct.freed;
  _leakTotals.shared += acct.shared;
  if (delta != null) {
    _leakTotals.rendererFreed += -delta;
    _leakTotals.unaccounted += acct.freed - (-delta);
  }
  const t = _leakTotals;
  console.warn(
    `[leak] unload: held ${acct.held} · freed ${acct.freed} · shared ${acct.shared}`
    + (delta != null ? ` · Δgeometries ${delta}` : ' · Δgeometries n/a')
    + `  ||  totals over ${t.tiles} unloads: freed ${t.freed}, renderer released ${t.rendererFreed},`
    + ` UNACCOUNTED ${t.unaccounted}`
    + (t.held - t.freed - t.shared > 0 ? `, walk is HOLDING ${t.held - t.freed - t.shared}` : ''),
  );
}


export function createTileManager(scene, createRoadMeshes, createBuildingMeshes, createSpatialIndex, renderVegetation, camera = null, world = null, groundBody = null) {
  const tileManagerState = { numHeightfieldBodies: 0 };
  // Global cross-tile vegetation pools (trees/shadows/bushes as 3 shared BatchedMeshes).
  // Tiles add instances via handles in Phase 3 and release them on unload.
  const vegPools = CONFIG.ENABLE_TREES ? getVegPools(scene) : null;

  // ── Streetlight/traffic-light pooling adapter ───────────────────────────────
  // The builders keep producing per-tile InstancedMeshes (battle-tested placement code); this
  // strips their instance data into global pool sets keyed by part name. Pools are created
  // lazily from the FIRST mesh's geometry/material (all shared singletons), so the adapter
  // needs no knowledge of the renderer's internals.
  const _lightPools = {};
  async function poolLightIM(part, im) {
    if (!im || !im.count) return null;
    if (!_lightPools[part]) {
      _lightPools[part] = createVegPoolSet({
        name: `light_${part}`, geometries: [im.geometry], material: im.material,
        capacity: 4096, castShadow: !!im.castShadow, receiveShadow: !!im.receiveShadow,
        renderOrder: im.renderOrder || 0,
      }, scene);
    }
    return _lightPools[part].add([{
      geoIndex: 0,
      count: im.count,
      matrices: im.instanceMatrix.array,
      colors: im.instanceColor ? im.instanceColor.array : undefined,
    }], yieldToMain);
  }

  function releaseVegHandles(entry) {
    if (!entry?.vegPoolHandles) return;
    for (const h of entry.vegPoolHandles) h.pool.remove(h);
    entry.vegPoolHandles = [];
  }
  let currentTx = 0;
  let currentTy = 0;
  let inFlightCount = 0;
  let _startedLoading = false; // latches once the first tiles are requested (for the loading-screen gate)
  /** Track rendered water wayIds for dedupe across tiles. Removed on tile unload. */
  const renderedWaterIds = new Set();
  /** Queue of { key, tx0, ty0 } to load when a slot is free (avoids Overpass 429) */
  const pendingQueue = [];
  /** Deferred GPU disposal queue — one tile per frame to avoid GC spikes */
  const _pendingDisposals = [];

  /** LOD throttle — only recalc when viewer moves >15m */
  let _lastLodX = -Infinity, _lastLodZ = -Infinity;
  const LOD_THRESHOLD_SQ = 15 * 15;

  // Frame-budget yield: only actually yields to the browser when we've exceeded
  // the per-frame work budget. This prevents tile building from starving the
  // render loop while avoiding unnecessary rAF round-trips for cheap work.
  // Shared per-frame tile-work budget. Reset ONCE per frame in update() (not per-yield), so ALL tiles
  // finalizing concurrently share the same budget — total tile work per frame is capped no matter how
  // many tiles entered range at once. This is what keeps new areas from stuttering: work spreads across
  // frames instead of several tiles materializing in one frame. Kept small so the render always has headroom.
  const FRAME_BUDGET_MS = 3;      // baseline ms of tile build work per frame when the frame rate is healthy
  const BUDGET_MIN = 1.0, BUDGET_MAX = 3.5; // capped low: a finalizing tile can't brush the 16.6ms frame limit

  /**
   * ── THE INITIAL LOAD IS YIELD-BOUND, NOT WORK-BOUND ───────────────────────────────────────────
   *
   * Measured 2026-08-27, the first time anything read the per-phase build totals:
   *
   *     initial tile load COMPLETE after 108 polls (~16200 ms), 14 tiles resident
   *     main-thread time by build phase (3095 ms total): p1 physics 752/132 · p4 clusters 589/124 ·
   *       p2 buildings 465/163 · p4 urban 389/263 · p1 rg:markings 256/251 · ...
   *
   * **3,095 ms of work took 16,200 ms of wall time.** ~1,180 chunks at an average of 2.63 ms each —
   * which is exactly `FRAME_BUDGET_MS` — and every chunk ends in a yield that costs a whole 16.7 ms
   * frame. 1,180 frames ≈ 19.7 s. The main thread is IDLE for ~84% of the load, waiting for vsync.
   *
   * The 3 ms cap is right while DRIVING: it exists so tile work never piles onto a frame that is
   * already missing 60 fps. But during the initial load the only thing on screen is the loading
   * overlay, there is no car, and nothing needs to stay smooth — so the same cap that protects the
   * drive is spending 13 seconds of the load doing nothing at all.
   *
   * ⚠ This budget must END when the load does. The title screen's cinematic orbit runs AFTER
   * `isInitialLoadComplete()`, and that does need its frames.
   */
  const LOAD_BUDGET_MS = 12;      // ~72% of a frame — nothing is being kept smooth behind a loader
  let _initialLoadDone = false;
                                            // and drop a frame. Tiles appear a touch slower; driving stays smooth.
  let _budgetMs = FRAME_BUDGET_MS; // ADAPTIVE: shrinks when frames run long (heavy streaming at speed),
                                   //           grows back when they're smooth — so build never compounds a slow frame
  let _lastUpdateAt = 0;
  const _wantedSet = new Set();   // reused every frame in update() to avoid per-frame Set allocation
  let _frameBudgetStart = performance.now();

  // ── Build-chunk overrun attribution (diagnoses the STATS "other" stalls) ───
  // A synchronous op inside a build chunk that blows straight through the frame budget can't be
  // seen by the frame-loop cpuTimer — it lands as unattributed "other" time. The builder labels
  // its current phase; when a yield finds the budget badly overrun, the label takes the blame.
  // NOTE: `elapsed` is measured from the shared frame-budget start, so it includes the frame's own
  // work — treat the numbers as relative attribution, not exact chunk cost.
  const _buildOverruns = {};
  let _buildPhase = 'idle';
  const buildPhase = (label) => { _buildPhase = label; };
  function takeBuildOverruns() {
    const out = { ..._buildOverruns };
    for (const k in _buildOverruns) delete _buildOverruns[k];
    return out;
  }

  /**
   * TOTAL main-thread time per build phase, and how many chunks each took.
   *
   * `_buildOverruns` above keeps only the WORST overrun per phase, and it is cleared on read — good
   * for "what stuttered just now", useless for "where does the load go". And nothing called it: it
   * has been exported and unread. The load is the largest cost in the game — a boot that gives up
   * at its 19.65 s cap with SIX tiles built is ~3 s per tile — and the work is async yielded chunks,
   * so the frame loop's `tiles` lap reads 0.9-2.5 ms while the same work lands in `other` as
   * 2,000-3,000 ms. This is the only place the split can be seen.
   *
   * Accumulated where the chunk actually ENDS (after the budget early-return), because `_lastResume`
   * only moves on a real yield — adding it before that would count the same span again next call.
   */
  const _phaseTotals = Object.create(null);
  function getBuildPhaseTotals() {
    const out = [];
    for (const k in _phaseTotals) out.push({ phase: k, ms: +_phaseTotals[k].ms.toFixed(1), chunks: _phaseTotals[k].chunks });
    return out.sort((a, b) => b.ms - a.ms);
  }
  function resetBuildPhaseTotals() { for (const k in _phaseTotals) delete _phaseTotals[k]; }

  // Wall time at which the last yield handed control back. The span between one resume and the next
  // yield is a chunk of uninterrupted main-thread work — the true stutter unit.
  //
  // CAVEAT, stated because it changes how the number should be read: concurrent tiles share this,
  // so a span can cover work from more than one tile. That is deliberate. The question a stutter
  // asks is "how long was the main thread held?", not "which tile held it?" — and the answer to
  // the first is what the frame actually felt.
  let _lastResume = performance.now();

  const yieldToMain = () => {
    const _t = performance.now();
    const _chunk = _t - _lastResume;
    // Report BEFORE the early-return: a chunk that does not yield has not ended, so recording it
    // here would double-count the same span on the next call.
    const elapsed = performance.now() - _frameBudgetStart;
    if (elapsed < _budgetMs) {
      // Budget not exhausted this frame — continue working without yielding
      return Promise.resolve();
    }
    if (elapsed > _budgetMs + 3 && !(_buildOverruns[_buildPhase] >= elapsed)) {
      _buildOverruns[_buildPhase] = +elapsed.toFixed(1);
    }
    // This span is ending, so it can be attributed. Named by build phase, so a long frame reports
    // `⟨async: build:buildings 41⟩` instead of an anonymous `other`.
    if (_chunk >= 4) recordChunk('build:' + (_buildPhase || '?'), _chunk, _t);
    // Every chunk, not only the long ones: the load is death by a thousand 3 ms chunks as much as by
    // a few 40 ms ones, and only the total can tell those apart.
    const _pt = (_phaseTotals[_buildPhase] ||= { ms: 0, chunks: 0 });
    _pt.ms += _chunk; _pt.chunks++;
    // Budget exceeded — yield to the browser for rendering. Do NOT reset _frameBudgetStart here;
    // update() owns the per-frame reset so concurrent tiles keep sharing one budget.
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame !== 'function') { setTimeout(() => { _lastResume = performance.now(); resolve(); }, 0); return; }
      // STACKING GUARD (round 9): all waiting chunks resume on the same next rAF, and because
      // microtasks drain between successive rAF callbacks, each earlier chunk's whole span runs
      // before the next chunk's resume check. Without this check every waiter ran its span in
      // the SAME frame — per-frame build time was the SUM of spans (the uniform 13-17ms tags).
      // If the shared budget is already spent when we wake, sleep ONE more frame — once only,
      // so builds still progress on frames whose own work eats the budget.
      let deferred = false;
      const tryResume = () => {
        if (!deferred && (performance.now() - _frameBudgetStart) >= _budgetMs) {
          deferred = true;
          requestAnimationFrame(tryResume);
          return;
        }
        _lastResume = performance.now();
        resolve();
      };
      requestAnimationFrame(tryResume);
    });
  };

  // =========================================================================
  // Progressive tile builder — splits tile construction into 4 phases so
  // roads/terrain appear instantly and heavy detail fills in over frames.
  //
  //  Phase 1 (immediate):  Terrain + Roads + Physics colliders
  //  Phase 2 (next frame): Buildings + Railways
  //  Phase 3 (next frame): Trees + Zone vegetation
  //  Phase 4 (background): Grass + Water + Props + Infra + Details
  //
  // The entry object is written into tileCache at the end of Phase 1 so
  // road queries and spatial index work immediately.
  // =========================================================================

  async function processTileData(key, tx0, ty0, data) {
    // ── BUILD GATE (Stage-2 co-frame, Path B) ────────────────────────────────
    // No elevation-dependent layer (terrain visual/physics, roads, vegetation, terrainMinY/maxY)
    // may be built until worldElevationOffset is resolved. This is the single, airtight
    // happens-before edge: the offset (set from the spawn tile's PARSE in main.js, independent of
    // geometry builds) is guaranteed resolved before ANY consumer reads it — so every consumer
    // reads the correct value the first time and no layer freezes the absolute frame. Resolves
    // immediately in normal flow (offset set before any tile builds); only a stray early/warm-cache
    // build actually waits. Cannot deadlock (offset comes from parse, not from this build).
    await whenElevationOffsetReady();
    assertElevationOffsetResolved(`processTileData ${key}`);

    const { roads, buildings, railways, vegetation, water, greens, elevation, roadOnlyMode, junctions } = data;
    const skipNonRoad = CONFIG.ROAD_ONLY_DEBUG || roadOnlyMode;
    // Upgrade the coastline to the REAL OSM shore (tiles carry natural=coastline polylines) BEFORE
    // any terrain paints. Segments ACCUMULATE across tiles and a longer chain is adopted only if it
    // still passes the land-anchor check — "first tile wins" is what put the sea over Poblenou.
    // See coastline.js.
    try { ingestCoastline(water); } catch {}
    let getElevationAt = null;
    let terrainMesh = null;
    let terrainMinY = null;
    let terrainMaxY = null;
    let heightfieldBody = null;

    // Cache tile center for LOD (avoids split+map+trig in hot loop)
    const { x: _tcx, z: _tcz } = tileCenterToWorld(tx0, ty0, TILE_ZOOM);

    // The entry object — populated progressively and stored in tileCache early.
    const entry = {
      _centerX: _tcx,
      _centerZ: _tcz,
      roads: null,
      buildings: null,
      elevationIsRebased: false, // D-12: tileMinElevation retired — never rebased per-tile
      roadMeshes: [],
      railwayMeshes: [],
      buildingMeshes: [],
      vegetationMeshes: [],
      waterMesh: null,
      waterIds: [],
      terrainMesh: null,
      getElevationAt: null,
      terrainMinY: null,
      terrainMaxY: null,
      heightfieldBody: null,
      bridgeBodies: [],
      tunnelBodies: [],
      trimeshBody: null,
      trafficLightMesh: null,
      shoulderMesh: null,
      dividerMesh: null,
      streetlightPoleMesh: null,
      streetlightArmMesh: null,
      streetlightLampMesh: null,
      streetlightPoolMesh: null,
      streetlightPoleShadowMesh: null,
      streetlightWireMesh: null,
      streetlightPositions: [],
      setBridgeNightMode: null,
      barrierMeshes: [],
      barrierBody: null,
      crashBarrierMesh: null,
      crashBarrierBody: null,
      reflectorGroup: null,
      guardRailBody: null,
      sceneryBodies: [],
      buildingBodies: [],
      busStopMeshes: [],
      parkingMeshes: [],
      roadInfraMeshes: [],
      urbanFeatureMeshes: [],
      vendorCartMeshes: [],
      tunnelMeshGroup: null,
      canopyMeshGroup: null,
      retainingWallMesh: null,
      trenchWallMesh: null,
      trenchPortalMesh: null,
      pedestrianPortalMesh: null,
      tunnelWallBody: null,
      approachWallBody: null,
      rampBodies: [],
      tunnelShoulderBody: null,
      terrainTrimeshBody: null,
      spatialIndex: {},
      roadMinY: null,
      roadMaxY: null,
      debugPhysicsHelpers: null,
      crosswalkMesh: null,
      onewayArrowMesh: null,
      // Phase 3 Barcelona (OSM-driven sidewalks, curbs, bike infrastructure)
      bcnSidewalkMesh: null,
      bcnCurbMesh: null,
      bcnBikeLaneMesh: null,
      bcnBikePictoMesh: null,
      // Phase 4A Barcelona (tram rails, no-parking stripes)
      tramRailMesh: null,
      noParkingMesh: null,
      // Phase 4C-A/B Barcelona (ZONA 30, tactile paving, blue parking)
      zona30Mesh: null,
      tactileMesh: null,
      bluezoneMesh: null,
      // Phase 4B-1/2 Barcelona (chamfered intersection fills + sidewalk corners + diagonal curbs)
      chamferMesh: null,
      chamferSwMesh: null,
      chamferCurbMesh: null,
    };

    // -----------------------------------------------------------------------
    // PHASE 1: Terrain + Roads + Physics (appear immediately)
    // -----------------------------------------------------------------------
    // ── WHY THIS LABEL IS SUBDIVIDED (2026-08-31) ─────────────────────────────────────────────
    // A drive reported `p1 physics 3933ms/66` out of 5739 ms — **68% of the entire initial load**,
    // ~60 ms a tile, against `p2 buildings 305ms`. The docs still describe buildings as the biggest
    // cost, which was true when they were written and is not now. One label over the whole span
    // cannot say WHICH of terrain heightfield, tunnels, road merge, road colliders or greens is
    // spending it, and `window._ddTilePerf` only answers per tile, in the console, behind a flag.
    //
    // `_perfMark` already delimits these sections but deliberately does NOT report them, because it
    // subdivides a span `yieldToMain` reports as one chunk and recording both would double-count.
    // So instead the PHASE LABEL moves with the sections: same accounting, same single source, and
    // the unflagged `[perf] initial load ... by build phase` report breaks itself down.
    //
    // ⚠ READ A ZERO CAREFULLY. A label only collects time when a YIELD ends a chunk while it is
    // current, so a section with no yield inside it hands its cost to whichever label is current at
    // the next yield — `p1 phys:terrain-mesh` is exactly that case and will read ~0 while its work
    // shows up under `tunnels`. That is a limit of chunk accounting, not a free section. The big
    // ones (terrain, tunnels, roads+merge, road-physics, greens) each yield and do attribute.
    buildPhase('p1 phys:terrain');   // terrain trimesh/heightfield + colliders come first in p1

    // Performance instrumentation — tracks max single-chunk time (the stutter metric)
    const _perfT0 = performance.now();
    let _perfChunkStart = _perfT0;
    let _perfMaxChunk = 0;
    let _perfWorkTime = 0; // excludes yield wait time
    const _perfChunks = [];
    const _perfMark = (label) => {
      const now = performance.now();
      const chunkMs = now - _perfChunkStart;
      if (chunkMs > _perfMaxChunk) _perfMaxChunk = chunkMs;
      _perfWorkTime += chunkMs;
      _perfChunks.push({ label, ms: chunkMs });
      // NOT reported to frameAttribution: these marks SUBDIVIDE a span that yieldToMain already
      // reports as one chunk, so recording both would attribute the same wall time twice under two
      // labels and inflate the async list. yieldToMain is the single non-overlapping source.
      _perfChunkStart = now;
    };
    // Yield wrapper that tracks work time between yields (the true stutter metric)
    const _perfYield = async () => {
      const workEnd = performance.now();
      const chunkMs = workEnd - _perfChunkStart;
      if (chunkMs > _perfMaxChunk) _perfMaxChunk = chunkMs;
      _perfWorkTime += chunkMs;
      await yieldToMain();
      _perfChunkStart = performance.now();
    };

    // Tunnel classification — pedestrian excluded from full enclosure
    // Whitelist of highway types that get full tunnel treatment (enclosure + terrain holes).
    // Everything else (service, track, cycleway, footway, pedestrian, corridor, etc.)
    // gets pedestrian portal mode — small frame, no terrain holes, no interior.
    // This prevents marina service corridors and mall passages from punching terrain holes.
    const DRIVABLE_TUNNEL_TYPES = new Set([
      'motorway', 'motorway_link', 'trunk', 'trunk_link',
      'primary', 'primary_link', 'secondary', 'secondary_link',
      'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street',
    ]);

    function isHillsideApproach(road) {
      // Only carve terrain for long motorway/trunk approaches (>60m horizontal)
      if (!['motorway', 'trunk', 'motorway_link', 'trunk_link'].includes(road.highwayType)) return false;
      const pts = road.points || [];
      if (pts.length < 2) return false;
      let minElev = 0, minIdx = 0, surfaceIdx = -1;
      for (let i = 0; i < pts.length; i++) {
        const e = pts[i].elevation ?? 0;
        if (e >= -0.3 && surfaceIdx < 0) surfaceIdx = i;
        if (e < minElev) { minElev = e; minIdx = i; }
      }
      if (surfaceIdx < 0 || minIdx < 0) return false;
      let dist = 0;
      const lo = Math.min(surfaceIdx, minIdx), hi = Math.max(surfaceIdx, minIdx);
      for (let i = lo; i < hi; i++) {
        const a = pts[i], b = pts[i + 1];
        dist += Math.hypot(b.x - a.x, b.y - a.y);
      }
      return dist >= 60;
    }

    let tunnelRoads = [];
    let approachRoads = [];
    let carveApproachRoads = [];
    let wallApproachRoads = [];

    if (CONFIG.ENABLE_TUNNELS) {
      // Full enclosure: drivable-scale tunnels only (whitelist)
      tunnelRoads = (roads || []).filter(r =>
        r.tunnel && r.layer != null && r.layer < 0 &&
        DRIVABLE_TUNNEL_TYPES.has(r.highwayType)
      );
      // Non-drivable underground ways (corridor, footway, steps, path) are NOT rendered at all —
      // see the pedestrian-portal note further down. The list is no longer collected.

      // Approach roads: surface roads descending below grade (drivable types only)
      approachRoads = (roads || []).filter(r => {
        if (r.tunnel) return false;
        if (!DRIVABLE_TUNNEL_TYPES.has(r.highwayType)) return false;
        const pts = r.points;
        if (!pts || pts.length < 2) return false;
        return pts.some(p => p.elevation != null && p.elevation < -0.5);
      });
      // All drivable approaches get terrain carving. Retaining walls are additive (not a replacement).
      // The 60m hillside-only rule caused short trunk approaches to be uncarved → terrain buried road.
      carveApproachRoads = approachRoads;
      wallApproachRoads  = approachRoads; // same list — walls sit alongside carved terrain
    }

    // Terrain carving DISABLED — visual terrain stays flat at all tunnel approaches.
    // Portal approach geometry (buildPortalApproaches) covers terrain with a flat masking plane.
    // Physics carving still runs via createTerrainTrimesh so car can descend underground.
    // (carveTunnelTerrain call removed — was causing terrain warping along curves in urban areas)

    // Terrain mesh
    let terrainTrimeshBody = null;
    if (!skipNonRoad && CONFIG.ENABLE_TERRAIN && elevation && elevation.elevations?.length) {
      // Include marina/dock polygons in terrain water-sinking so terrain dips
      // smoothly at marina edges instead of creating a staircase at the grid boundary.
      const waterPolys = CONFIG.ENABLE_WATER
        ? [
            ...(data.water || []),
            ...(data.marinas || []).filter((m) => !m.isLine && m.polygon?.length >= 3),
          ]
        : [];
      // PRIORITY: build + add the terrain Heightfield collider FIRST, BEFORE the expensive
      // visual terrain mesh and its multi-frame _perfYield chain. The collider depends only on
      // `elevation`+`key` (not the visual mesh), and the heightfield build is cheap (~0.5–3 ms).
      // Getting ground physics into the world as early as possible closes the "groundless window"
      // that causes the streaming jump: if the car reaches a tile whose collider hasn't been added
      // yet, its wheel rays find only the −50 m fallback plane → it free-falls → the heightfield is
      // then added UNDER the penetrating chassis → cannon resolves it with a hard impulse = the jolt
      // "where roads are emerging." Adding the collider before the slow mesh work shrinks that window.
      if (world) {
        const { roadMaterial } = getCarContactMaterials(world);
        // Terrain physics = Heightfield. cannon-es has NO box-vs-trimesh narrowphase (only
        // sphere/plane-vs-trimesh) and rays can't hit Trimesh either, so a trimesh terrain can
        // never hold the car — the G-49 "chassis backstop on a trimesh" premise was false.
        // Heightfield supports BOTH boxHeightfield narrowphase (chassis backstop) AND ray
        // intersection (wheels genuinely drive off-road). The old quadrant-indexing bug that
        // misplaced it (D-16 revert) is fixed in buildTerrainHeightfield (full source grid);
        // placement runtime-verified against the (correct but inert) trimesh: gap ≤ 0.01 m.
        // NOTE: heightfields can't be carved — tunnel-mouth terrain holes are visual-only until
        // Phase 3 authored tunnels (createTerrainTrimesh kept dormant for reference).
        const hf = await buildTerrainHeightfield(elevation, key, yieldToMain);
        if (hf?.body) {
          const o = getOriginOffset();
          // Builder returns world-frame position (east-X, north-Z corner); convert to physics frame.
          hf.body.position.set(-(hf.body.position.x - o.x), 0, hf.body.position.z - o.z);
          hf.body.collisionFilterGroup = COLLISION_GROUP_TERRAIN;
          hf.body.collisionFilterMask  = COLLISION_GROUP_VEHICLE;
          if (roadMaterial) hf.body.material = roadMaterial;
          world.addBody(hf.body);
          heightfieldBody = hf.body;
          tileManagerState.numHeightfieldBodies += 1;
          assertTerrainVehicleHandshake(world); // G-51
        }
      }
      _perfMark('terrain-physics');
      buildPhase('p1 phys:terrain-mesh');

      const terrain = await buildTerrainMesh(elevation, key, [...tunnelRoads, ...carveApproachRoads], roads, waterPolys, _perfYield, data.bakedTerrain, data.aoGrid, data.beaches);
      terrainMesh = terrain.mesh;
      getElevationAt = terrain.getElevationAt;
      if (terrainMesh) {
        // TERRAIN_INVISIBLE: hide visual mesh but keep physics (terrainTrimeshBody still created)
        if (CONFIG.TERRAIN_INVISIBLE) terrainMesh.visible = false;
        safeSceneAdd(scene, terrainMesh);
        terrainMesh.geometry.computeBoundingBox();
        if (terrainMesh.geometry.boundingBox) {
          terrainMinY = terrainMesh.geometry.boundingBox.min.y;
          terrainMaxY = terrainMesh.geometry.boundingBox.max.y;
        }
      }

      _perfMark('terrain-mesh');
      buildPhase('p1 phys:tunnels');
      await _perfYield();
    }

    await _perfYield();

    // Canonical ground-Y for world-placed features (render-Y of the normalized terrain). Every
    // renderer that puts geometry "on the ground" must anchor to this instead of Y=0 / absolute DEM,
    // or it floats where terrain is below spawn and buries where above. See gotchas G-45.
    const _groundVertExag = CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION) ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;
    const getGroundY = getElevationAt
      ? (wx, wz) => { const { lat, lon } = worldToLatLon(wx, wz); const n = getElevationAt(lat, lon); return (n != null && Number.isFinite(n) ? n : 0) * _groundVertExag; }
      : () => 0;

    // Tunnel enclosures
    let tunnelMeshGroup = null;
    let tunnelWallBody = null;
    let approachWallBody = null;
    const rampBodies = [];   // tunnel-portal ramp trimeshes — tracked so unload removes them (was leaking)
    if (CONFIG.ENABLE_TUNNELS && tunnelRoads.length > 0) {
      // Simple-tunnel mode: VISUAL enclosure/trench/walls/gates OFF (just the road descending into the
      // carved terrain hole + ramp). PHYSICS colliders stay on (below) so the car drives through contained.
      if (CONFIG.ENABLE_TUNNEL_VISUALS) {
        tunnelMeshGroup = buildTunnelMeshes(tunnelRoads, getGroundY);
        if (tunnelMeshGroup.children.length > 0) safeSceneAdd(scene, tunnelMeshGroup);
        // Portal trench: sloped ramp floor + tapered walls at each portal approach.
        const portalTrench = buildPortalApproaches(tunnelRoads, getGroundY);
        if (portalTrench) safeSceneAdd(scene, portalTrench);
      } else {
        // Simple-tunnel mode: just the descending road deck (no walls/ceiling/gates), so the
        // road is visibly continuous down the carved opening and under the terrain roof. G-50.
        tunnelMeshGroup = buildTunnelFloor(tunnelRoads, getGroundY);
        if (tunnelMeshGroup.children.length > 0) safeSceneAdd(scene, tunnelMeshGroup);
      }

      if (world) {
        const { roadMaterial } = getCarContactMaterials(world);
        tunnelWallBody = createTunnelWallColliders(tunnelRoads, world, roadMaterial);

        // Ramp approach physics: trimesh colliders matching the sloped ramp floor geometry
        // so the car drives down the ramp rather than staying on flat terrain.
        const physicsOrigin = getOriginOffset();
        const RAMP_LEN = 90; // must match TRENCH_LEN in tunnelRenderer.js (80 + capsule halfW cap)
        for (const road of tunnelRoads) {
          const pts = road.points;
          if (!pts || pts.length < 2) continue;
          const hw = (road.width || 6) / 2;
          const buildRampBody = (portalPt, nextPt) => {
            const depth = portalPt.elevation ?? -6;
            if (depth >= -0.5) return; // ramp-fixed portal: flat at surface, no ramp physics needed
            const botY = depth + 0.05;
            const surfY = 0.05;
            const ddx = portalPt.x - nextPt.x, ddz = portalPt.y - nextPt.y;
            const dlen = Math.hypot(ddx, ddz) || 1;
            const outX = ddx / dlen, outZ = ddz / dlen;
            const perpX = -outZ, perpZ = outX;
            const farX = portalPt.x + outX * RAMP_LEN;
            const farZ = portalPt.y + outZ * RAMP_LEN;
            // Ramp floor vertices in Three.js world space → physics space (negate X)
            const v = (wx, wy, wz) => new CANNON.Vec3(
              -(wx - physicsOrigin.x), wy, wz - physicsOrigin.z,
            );
            // Sloped quad: 4 corners, 2 triangles
            const pL = v(portalPt.x + perpX*hw, botY,  portalPt.y + perpZ*hw);
            const pR = v(portalPt.x - perpX*hw, botY,  portalPt.y - perpZ*hw);
            const fL = v(farX       + perpX*hw, surfY, farZ       + perpZ*hw);
            const fR = v(farX       - perpX*hw, surfY, farZ       - perpZ*hw);
            const verts = [pL.x,pL.y,pL.z, pR.x,pR.y,pR.z, fL.x,fL.y,fL.z, fR.x,fR.y,fR.z];
            if (!verts.every(Number.isFinite)) {
              console.warn(`[tunnel/physics] skip ramp body — non-finite vert (road ${road.id})`);
              return;
            }
            const faces = [0,1,2, 1,3,2]; // two triangles covering the ramp quad
            const trimesh = new CANNON.Trimesh(verts, faces);
            const rampBody = new CANNON.Body({ mass: 0, material: roadMaterial });
            rampBody.addShape(trimesh);
            world.addBody(rampBody);
            rampBodies.push(rampBody);
          };
          buildRampBody(pts[0], pts[1]);
          buildRampBody(pts[pts.length - 1], pts[pts.length - 2]);
        }
      }
    }
    // Retaining walls: vertical concrete panels on sides of ramp wherever road is below grade.
    // Applied to both approach roads AND tunnel roads (tunnel road endpoints have below-grade pts).
    let retainingWallMesh = null;
    let trenchWallMesh = null;
    let trenchPortalMesh = null;
    if (CONFIG.ENABLE_TUNNELS) {
      const wallRoads = [...wallApproachRoads, ...tunnelRoads];
      if (CONFIG.ENABLE_TUNNEL_VISUALS && wallRoads.length > 0) {
        retainingWallMesh = buildRetainingWalls(wallRoads, getGroundY);
        if (retainingWallMesh) safeSceneAdd(scene, retainingWallMesh);
      }
      // Option-L open-trench retaining walls — dress the stepped earth bank along the
      // drivable trench corridors with clean vertical concrete. Decoupled from
      // ENABLE_TUNNEL_VISUALS (which gates the full enclosure/canopy we don't want) and
      // gated only by ENABLE_RETAINING_WALLS, since these ARE the trench's visible faces.
      if (CONFIG.ENABLE_RETAINING_WALLS && tunnelRoads.length > 0) {
        // Trench dressing DISABLED — the bake-side carve now produces a smooth, wide battered
        // cutting (trenchAuthor BATTER_WIDTH 14 + smoothstep), so the TERRAIN itself is the clean
        // trench and concrete wall dressing is unnecessary (and was the source of the overlap /
        // sawtooth / giant-slab / jutting-block artifacts). buildTrenchRetainingWalls kept in
        // source; re-enable if a dressed concrete look is wanted on top of the graded slope.
        // trenchWallMesh = buildTrenchRetainingWalls(tunnelRoads, getGroundY);
        // if (trenchWallMesh) safeSceneAdd(scene, trenchWallMesh);
        // Portal headwalls framing the trench mouths — REVERTED 2026-06-30: the outward coping +
        // these frames overlapped in the median between Ronda de Dalt's parallel carriageways,
        // filling it with a dark triangular mass. Disabled pending a median-aware redesign.
        // trenchPortalMesh = buildTrenchPortals(tunnelRoads, getGroundY);
        // if (trenchPortalMesh) safeSceneAdd(scene, trenchPortalMesh);
      }
      // Physics containment walls for L0 approach roads (tunnel ramps already have colliders).
      // Gated by the same flag as the visual walls so they stay in sync.
      if (CONFIG.ENABLE_RETAINING_WALLS && world && wallApproachRoads.length > 0) {
        const { roadMaterial } = getCarContactMaterials(world);
        approachWallBody = createApproachWallColliders(wallApproachRoads, tunnelRoads, world, roadMaterial);
      }
    }
    // ── PEDESTRIAN PORTAL FRAMES — REMOVED (v3 P4-18, 2026-08-28) ─────────────────────────────
    //
    // `pedestrianPortalRoads` is "everything underground that is NOT a drivable tunnel", and in
    // Barcelona that is overwhelmingly **`corridor`: 464 records**, against 205 service, 164 trunk
    // and 69 primary. A `corridor` is an INDOOR passageway — metro concourses, station subways,
    // shopping-centre links. Drawing a concrete portal frame at each one puts gate structures on
    // ordinary pavements, which is what the user found on Carrer de Sepulveda: 466 non-drivable
    // underground records citywide, all of them framed.
    //
    // The frames also got MORE prominent the moment `retwall` gained a concrete texture, which is
    // how they were noticed. Removed rather than gated: a metro concourse under a street is not a
    // feature this game renders, and a portal frame is the wrong object for one even if it were.
    // Real road tunnels are unaffected — they go through `tunnelRoads`, a separate whitelist.
    const pedestrianPortalMesh = null;
    // Approach canopy disabled — buildApproachCanopy returns empty group
    const canopyMeshGroup = null;
    if (CONFIG.ENABLE_TUNNELS) {
      const allSubsurfaceRoads = [...tunnelRoads, ...approachRoads];
      if (allSubsurfaceRoads.length > 0) registerTunnelZones(allSubsurfaceRoads, key, getOriginOffset());
    }

    const elevationOffset = getWorldElevationOffset() ?? 0; // D-12: single spawn-anchored baseline; tileMinElevation gate removed
    // Fast world-coord elevation: skips worldToLatLon trig for 18k+ vegetation/grass lookups
    const getWorldElevation = elevation ? createFastElevation(elevation, elevationOffset) : null;
    const options = getElevationAt ? { getElevationAt, elevationOffset, getWorldElevation, getGroundY, buildings: buildings || [] } : { elevationOffset, getGroundY, buildings: buildings || [] };
    options.buildPhase = buildPhase; // sub-attribution inside createRoadMeshes ('p1 rg:*' tags name the sync builder)
    if (data.bakedRoads) options.bakedRoads = data.bakedRoads;
    if (data.bakedSidewalks) options.bakedSidewalks = data.bakedSidewalks;   // v8 — pre-baked sidewalks/curbs
    const tileData = { roads, buildings, railways: railways || [], vegetation: vegetation || { trees: [], greenAreas: [] }, water: water || [], greens: greens || [], barriers: data.barriers || [], urbanFeatures: data.urbanFeatures || [], beaches: data.beaches || [],
      // v3 P1-19/20: real OSM trees, shops and traffic signals. tileParserWorker has been decoding
      // all three for a long time (readTrees / readShops / trafficSignals) and this whitelist
      // silently dropped them — note `vegetation.trees` above is EMPTY, so every tree in the city is
      // currently placed procedurally while 35k surveyed positions with species tags go unread.
      // No consumer yet; this is the plumbing P3 vegetation and P4 signage need. Costs one reference.
      trees: data.trees || [], shops: data.shops || [], trafficSignals: data.trafficSignals || [] };
    _censusAdd(tileData);
    if (data.bakedVegetation) tileData.bakedVegetation = data.bakedVegetation;

    _perfMark('tunnels+setup');
    buildPhase('p1 phys:roads+merge');
    await _perfYield();

    // Roads — async with frame yields to prevent jank
    buildPhase('p1 roadgen');        // road ribbon/marking generation (internal sync merges live here)
    const roadMeshesRaw = await createRoadMeshes(roads, options, _perfYield);
    const pillarPositions = roadMeshesRaw._pillarPositions || [];

    buildPhase('p1 merge');
    const roadMeshes = await mergeMeshesByMaterial(roadMeshesRaw, _perfYield);
    roadMeshes._pillarPositions = pillarPositions;

    // Night building-glow wash + baked sky-visibility AO: one pass over the road-family vertices
    // writes aWash (building proximity → night glow) and aAO (v9 AO grid → street-canyon
    // darkening). Buildingless tiles with AO data still get the AO half.
    const _tileSvfAt = createAoSampler(data.aoGrid, elevation);
    if ((tileData.buildings?.length || _tileSvfAt) && roadMeshes.length) {
      buildPhase('p1 road-wash');
      await bakeRoadAO(roadMeshes, _perfYield, _tileSvfAt);
    }

    roadMeshes.forEach((m) => { m.visible = true; safeSceneAdd(scene, m); });

    // Track crosswalk mesh separately for 80m LOD culling (Phase 1 Barcelona road overhaul).
    // The crosswalk mesh is already in scene via the forEach above; we just keep a reference.
    entry.markingsMesh     = roadMeshes.find(m => m.userData?.type === 'markings')       || null;
    // Alias into roadMeshes (disposed with them). Held so the LOD can cut its posts by drawRange.
    entry.metalRailingMesh = roadMeshes.find(m => m.userData?.type === 'metalRailing')   || null;
    entry.crosswalkMesh    = roadMeshes.find(m => m.userData?.type === 'crosswalk')      || null;
    entry.onewayArrowMesh  = roadMeshes.find(m => m.userData?.type === 'onewayArrows')  || null;
    // Phase 3 Barcelona
    entry.bcnSidewalkMesh  = roadMeshes.find(m => m.userData?.type === 'sidewalk')      || null;
    entry.bcnCurbMesh      = roadMeshes.find(m => m.userData?.type === 'curb')           || null;
    entry.bcnBikeLaneMesh  = roadMeshes.find(m => m.userData?.type === 'bikelane')      || null;
    entry.bcnBikePictoMesh = roadMeshes.find(m => m.userData?.type === 'bikepictogram') || null;
    entry.noParkingMesh    = roadMeshes.find(m => m.userData?.type === 'noparking')     || null;
    entry.zona30Mesh       = roadMeshes.find(m => m.userData?.type === 'zona30Stencil') || null;
    entry.tactileMesh      = roadMeshes.find(m => m.userData?.type === 'tactilePaving') || null;
    entry.bluezoneMesh     = roadMeshes.find(m => m.userData?.type === 'bluezone')      || null;

    const goreMesh = buildGoreMeshes(junctions);
    if (goreMesh) { goreMesh.visible = true; safeSceneAdd(scene, goreMesh); roadMeshes.push(goreMesh); }

    // Phase 4B-1: chamfered asphalt fill at Eixample-scale crossing junctions
    const chamferMesh = buildChamferFills(junctions, options);
    if (chamferMesh) { chamferMesh.visible = true; safeSceneAdd(scene, chamferMesh); roadMeshes.push(chamferMesh); }

    // Phase 4B-2: chamfer corner sidewalk triangles + diagonal curbs
    const chamferSwMesh   = buildChamferSidewalks(junctions, options);
    const chamferCurbMesh = buildChamferCurbs(junctions, options);
    if (chamferSwMesh)   { chamferSwMesh.visible = true;   safeSceneAdd(scene, chamferSwMesh);   entry.chamferSwMesh = chamferSwMesh; }
    if (chamferCurbMesh) { chamferCurbMesh.visible = true; safeSceneAdd(scene, chamferCurbMesh); entry.chamferCurbMesh = chamferCurbMesh; }

    _perfMark('roads+merge');
    buildPhase('p1 phys:road-minmax');
    await _perfYield();

    // Road min/max Y
    let tileRoadMinY = Infinity;
    let tileRoadMaxY = -Infinity;
    for (const road of roads || []) {
      for (const p of road.points || []) {
        if (p && Number.isFinite(p.elevation)) {
          tileRoadMinY = Math.min(tileRoadMinY, p.elevation);
          tileRoadMaxY = Math.max(tileRoadMaxY, p.elevation);
        }
      }
    }

    // Road physics — yield before and after to keep frames smooth
    let bridgeBodies = [];
    let tunnelBodies = [];
    let trimeshBody = null;
    if (world) {
      const offset = getWorldElevationOffset() ?? 0;
      const vertExag = CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION) ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;
      let roadMaterial = null;
      try { roadMaterial = getCarContactMaterials(world)?.roadMaterial ?? null; } catch { roadMaterial = null; }
      const getGroundYAt = getElevationAt
        ? (wx, wz) => { const { lat, lon } = worldToLatLon(wx, wz); const n = getElevationAt(lat, lon); return (n != null && Number.isFinite(n) ? n : 0) * vertExag; }
        : null;

      _perfMark('road-minmax');
      buildPhase('p1 phys:road-physics');
      await _perfYield();

      const result = createRoadTrimeshColliders(roads, { offset, vertExag, world, roadMaterial, tileKey: key, getGroundYAt });
      bridgeBodies = result.bridgeBodies;
      tunnelBodies = result.tunnelBodies;
      trimeshBody = result.trimeshBody;

      _perfMark('road-physics');
      buildPhase('p1 phys:greens');
      await _perfYield();
    }

    let debugPhysicsHelpers = null;
    if (CONFIG.DEBUG_PHYSICS_DECKS && (trimeshBody || heightfieldBody)) {
      debugPhysicsHelpers = createDebugPhysicsHelpers(trimeshBody || null, heightfieldBody || null, getOriginOffset());
      safeSceneAdd(scene, debugPhysicsHelpers);
    }

    // Spatial index + slim roads
    const spatialIndex = createSpatialIndex(roads);
    const slimRoads = (roads || []).map(r => {
      const s = { id: r.id, name: r.name || '', highwayType: r.highwayType || '', points: r.points };
      if (r.tunnel) s.tunnel = true;
      if (r.bridge) s.bridge = true;
      return s;
    });

    // Green areas — lightweight flat meshes, build in Phase 1 so they appear with terrain.
    // Pedestrian plazas (v7 area features, unrendered until 2026-07-11) ride the same lifecycle:
    // appended to greenMeshes so streaming/unload/disposal are shared. Beaches are NOT flat
    // meshes — they're painted into the terrain colours (buildTerrainMesh coast pass), where they
    // conform to the relief instead of getting buried under it.
    const greenMeshesP1 = !skipNonRoad && tileData.greens?.length ? createGreensMeshes(tileData.greens, getElevationAt) : [];
    if (!skipNonRoad) {
      greenMeshesP1.push(...createAreaFeatureMeshes(data.pedestrianAreas, 'pedArea', getElevationAt));
    }
    // Greens render ON TOP of the AO-darkened terrain — fill their aAO from the same grid or the
    // Eixample verges/parks glow bright over shaded ground (round-1 AO screenshot finding).
    if (_tileSvfAt && greenMeshesP1.length) {
      await bakeRoadAO(greenMeshesP1, _perfYield, _tileSvfAt, AO_GREEN_STRENGTH);
    }
    greenMeshesP1.forEach((m) => safeSceneAdd(scene, m));
    _perfMark('greens');
    buildPhase('p1 phys:tail');

    // Populate entry with Phase 1 results and store in cache immediately
    entry.greenMeshes = greenMeshesP1;
    entry.shops = tileData.shops;   // P-6: destinations for the pedestrian crowd
    entry.roads = slimRoads;
    entry.roadMeshes = roadMeshes;
    entry.terrainMesh = terrainMesh || null;
    entry.getElevationAt = getElevationAt || null;
    entry.terrainMinY = terrainMinY;
    entry.terrainMaxY = terrainMaxY;
    entry.heightfieldBody = heightfieldBody || null;
    entry.bridgeBodies = bridgeBodies;
    entry.tunnelBodies = tunnelBodies;
    entry.trimeshBody = trimeshBody || null;
    entry.tunnelMeshGroup      = tunnelMeshGroup      || null;
    entry.canopyMeshGroup      = canopyMeshGroup      || null;
    entry.retainingWallMesh    = retainingWallMesh    || null;
    entry.trenchWallMesh       = trenchWallMesh       || null;
    entry.trenchPortalMesh     = trenchPortalMesh     || null;
    entry.pedestrianPortalMesh = pedestrianPortalMesh || null;
    entry.tunnelWallBody = tunnelWallBody || null;
    entry.approachWallBody = approachWallBody || null;
    entry.rampBodies = rampBodies;
    entry.terrainTrimeshBody = terrainTrimeshBody || null;
    entry.spatialIndex = spatialIndex;
    entry.roadMinY = tileRoadMinY === Infinity ? null : tileRoadMinY;
    entry.roadMaxY = tileRoadMaxY === -Infinity ? null : tileRoadMaxY;
    entry.debugPhysicsHelpers = debugPhysicsHelpers || null;

    // Per-tile Phase1 timing — silenced (was console-spam). Set window._ddTilePerf = true to re-enable.
    _perfMark('phase1-end');
    if (typeof window !== 'undefined' && window._ddTilePerf) {
      const _perfTotal = performance.now() - _perfT0;
      console.log(
        `[Tile ${key}] Phase1: ${_perfTotal.toFixed(0)}ms wall, ${_perfWorkTime.toFixed(0)}ms work, max-chunk: ${_perfMaxChunk.toFixed(1)}ms | ` +
        _perfChunks.map(c => `${c.label}:${c.ms.toFixed(1)}`).join(' ')
      );
    }

    // Store in cache NOW so roads are usable immediately
    tileCache.set(key, entry); _tileEpoch++;
    if (_onMapTileReady) { try { _onMapTileReady(key, tileData); } catch (e) { /* minimap must never break tiles */ } }
    // Invalidate LOD cache so new tile gets correct visibility on next frame
    _lastLodX = -Infinity;

    // Helper: abort if tile was unloaded between phases (user drove away)
    const aborted = () => tileCache.get(key) !== entry;

    await yieldToMain();
    if (aborted()) return entry;

    // -----------------------------------------------------------------------
    // PHASE 2: Buildings + Railways (next frame)
    // -----------------------------------------------------------------------
    buildPhase('p2 buildings');

    // Vegetation mask (needed for Phase 3)
    {
      let tileBounds = null;
      if (elevation) {
        tileBounds = { south: elevation.south, west: elevation.west, north: elevation.north, east: elevation.east };
      } else {
        tileBounds = getTileBboxLatLon(tx0, ty0, TILE_ZOOM);
      }
      if (tileBounds && roads.length > 0) {
        const neighborRoads = [];
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const nk = tileKey(tx0 + dx, ty0 + dy);  // cache keys are 2-part `tx_ty` (was 3-part w/ zoom → never matched)
            const neighbor = tileCache.get(nk);
            if (neighbor?.roads) neighborRoads.push(...neighbor.roads);
          }
        }
        options.vegetationMask = buildVegetationMask(roads, buildings, water, tileBounds, neighborRoads);
        options.neighborRoads = neighborRoads;
      }
    }

    // CONFIG.ENABLE_RAILWAYS existed but was never checked here — the dark ballast ribbons along
    // the Rondas (the coastal rail corridor) read as "black border lines" (user, 2026-07-11).
    // Trams below are unaffected (embedded street rails, subtle).
    const railwayMeshes = await mergeMeshesByMaterial((skipNonRoad || !CONFIG.ENABLE_RAILWAYS) ? [] : createRailwayMeshes(railways, options), yieldToMain);
    railwayMeshes.forEach((m) => safeSceneAdd(scene, m));
    entry.railwayMeshes = railwayMeshes;

    // TRAM CONTRACT (v3 P1-25). The comment that used to sit here said trams were "always rendered
    // when present". That is FALSE: createTramMeshes() checks CONFIG.ENABLE_TRAM_TRACKS itself
    // (railwayRenderer.js:119) and returns null when it is off — which it is. No trams render today.
    // The gate is simply in the renderer rather than at this call site, which is why it reads as
    // ungated from here. Turning trams on is a legitimate scope decision for P4 (Barcelona has a
    // real network) — it is just not a P1 cleanup, because it CHANGES WHAT IS ON SCREEN.
    const tramMesh = skipNonRoad ? null : createTramMeshes(railways, options);
    if (tramMesh && safeSceneAdd(scene, tramMesh)) entry.tramRailMesh = tramMesh;

    await yieldToMain();

    // Filter buildings near tunnel approaches
    let filteredTileData = tileData;
    if (CONFIG.ENABLE_TUNNELS && approachRoads.length > 0 && tileData.buildings?.length > 0) {
      const approachSegs = [];
      for (const road of approachRoads) {
        const pts = road.points;
        if (!pts || pts.length < 2) continue;
        const hw = (road.width || 7) / 2 + 5;
        for (let ii = 0; ii < pts.length - 1; ii++) {
          approachSegs.push({ ax: pts[ii].x, az: pts[ii].y, bx: pts[ii + 1].x, bz: pts[ii + 1].y, hw });
        }
      }
      const isNearApproach = (bx, bz) => {
        for (const s of approachSegs) {
          const dx = s.bx - s.ax, dz = s.bz - s.az;
          const len2 = dx * dx + dz * dz;
          const t = len2 < 1e-10 ? 0 : Math.max(0, Math.min(1, ((bx - s.ax) * dx + (bz - s.az) * dz) / len2));
          const cx = s.ax + t * dx, cz = s.az + t * dz;
          if (Math.hypot(bx - cx, bz - cz) < s.hw) return true;
        }
        return false;
      };
      const filteredBuildings = tileData.buildings.filter(b => {
        const fp = b.footprint || [];
        if (fp.length === 0) return true;
        const bcx = fp.reduce((s, p) => s + p.x, 0) / fp.length;
        const bcz = fp.reduce((s, p) => s + p.y, 0) / fp.length;
        return !isNearApproach(bcx, bcz);
      });
      filteredTileData = { ...tileData, buildings: filteredBuildings };
    }
    let buildingMeshes = [];
    if (!skipNonRoad && CONFIG.ENABLE_BUILDINGS) {
      try {
        const buildingWorkerResult = await workerProcessBuildings(
          key,
          { buildings: filteredTileData.buildings, roads: filteredTileData.roads, aoGrid: AO_DISABLED ? null : data.aoGrid },
          elevation,
          elevationOffset,
          CONFIG,
        );
        if (!aborted()) {
          buildingMeshes = await materializeBuildingMeshes(buildingWorkerResult, yieldToMain);
        }
      } catch (err) {
        if (!aborted()) console.warn('[TileManager] Building worker error:', err.message);
      }
    }

    // Batch scene.add — add a few meshes per frame to spread GPU uploads
    for (let i = 0; i < buildingMeshes.length; i++) {
      safeSceneAdd(scene, buildingMeshes[i]); // NaN guard: building worker geometry may have NaN from degenerate footprints
      if ((i + 1) % 4 === 0) await yieldToMain();
    }
    entry.buildingMeshes = buildingMeshes;

    // LOD buildings: simplified boxes for distant rendering (300-800m)
    if (!skipNonRoad && CONFIG.ENABLE_BUILDINGS && filteredTileData.buildings?.length > 0) {
      const lodMesh = renderLODBuildings(filteredTileData.buildings, getWorldElevation);
      if (lodMesh) {
        lodMesh.visible = false; // starts hidden — LOD update will show when needed
        safeSceneAdd(scene, lodMesh); // NaN guard: elevation NaN (G-06) poisons LOD box positions
        entry.lodBuildingMesh = lodMesh;
      }
    }

    await yieldToMain();

    if (aborted()) return entry;
    // -----------------------------------------------------------------------
    // PHASE 3: Trees + Zone vegetation (next frame)
    // -----------------------------------------------------------------------
    buildPhase('p3 vegetation');

    const vegetationMeshes = [];
    let vegTreePositions = [];
    let vegTreePositionsFlat = null; // Float32Array for grass worker
    if (!skipNonRoad && CONFIG.ENABLE_TREES) {
      // Compute tile bounds for vegetation mask
      let vegTileBounds = null;
      if (elevation) {
        vegTileBounds = { south: elevation.south, west: elevation.west, north: elevation.north, east: elevation.east };
      } else {
        vegTileBounds = getTileBboxLatLon(tx0, ty0, TILE_ZOOM);
      }

      const { x: tcx, z: tcz } = tileCenterToWorld(tx0, ty0, TILE_ZOOM);
      const neighborRoads = options.neighborRoads || [];

      try {
        const vegWorkerResult = await workerProcessVegetation(
          key,
          tileData,
          elevation,
          elevationOffset,
          CONFIG,
          vegTileBounds,
          neighborRoads,
          { x: tcx, z: tcz },
        );

        if (!aborted()) {
          // Materialize main trees + zone trees — solid trees/shadows/bushes go into the GLOBAL pools
          // (handles on the entry); only billboards remain per-tile meshes.
          entry.vegPoolHandles = [];
          const mainVeg = await materializeVegetationMeshes(vegWorkerResult, yieldToMain, vegPools);
          vegTreePositions = mainVeg.treePositions || [];
          vegTreePositionsFlat = vegWorkerResult.treePositions; // keep flat version for grass

          const vegMeshBatch = [];
          (mainVeg.poolHandles || []).forEach((h) => entry.vegPoolHandles.push(h));
          (mainVeg.treeBillboardMeshes || []).forEach((m) => { vegMeshBatch.push(m); vegetationMeshes.push(m); });

          // Zone vegetation (included in same worker result)
          if (vegWorkerResult.zoneTreeVariants) {
            const zoneResult = await materializeVegetationMeshes({
              treeVariants: vegWorkerResult.zoneTreeVariants,
              shadowInstances: vegWorkerResult.zoneShadowInstances,
              bushInstances: vegWorkerResult.zoneBushInstances,
              treePositions: null,
            }, yieldToMain, vegPools);
            (zoneResult.poolHandles || []).forEach((h) => entry.vegPoolHandles.push(h));
          }

          // ⚠ RE-INVALIDATE THE LOD *AFTER* VEGETATION LANDS.
          //
          // `_lastLodX = -Infinity` is already set when the tile entry is created — but that is the
          // START of the build, and vegetation is materialized at the END, many awaits later. The
          // forced LOD pass has long since run and moved on by the time these handles exist.
          //
          // Tree handles are added with startVisible = TRUE, so until an LOD pass touches them
          // every tree in the tile draws at full density regardless of distance. The pass only runs
          // once the viewer has moved 15 m (LOD_THRESHOLD_SQ), so the tile sits over-populated until
          // then and visibly thins the moment it is corrected.
          //
          // User-reported exactly this, in both directions: "trees came there after I cross the
          // place" (the tile finished building and showed everything) and "when I came near them
          // they disappear" (15 m later the LOD ran and faded them to the correct fraction). Driving
          // fast keeps the LOD running constantly, which is why the canopy looked THINNER at speed —
          // that was the correct density, and the lush version was the bug.
          _lastLodX = -Infinity;

          // v3 P2-05: the per-instance vegetation "urban glow" wash is DELETED along with the rest
          // of the fake-night stack. It cost a washAt (~900 distance checks) AND a colour-texture
          // needsUpdate PER INSTANCE, across every tree and bush in a tile — the 'p3 veg-wash'
          // build tag. Street trees now catch real lamp light from the light grid instead.

          // If the tile got cancelled while we were adding instances, release them immediately —
          // the unload sweep may already have run for this entry.
          if (aborted()) releaseVegHandles(entry);

          // Spread GPU uploads across frames
          for (let vi = 0; vi < vegMeshBatch.length; vi++) {
            safeSceneAdd(scene, vegMeshBatch[vi]);
            if ((vi + 1) % 3 === 0) await yieldToMain();
          }
        }
      } catch (err) {
        if (!aborted()) console.warn('[TileManager] Vegetation worker error:', err.message);
      }
    }

    await yieldToMain();

    if (terrainMesh && vegTreePositions.length > 0) {
      darkenTerrainAroundTrees(terrainMesh, vegTreePositions);
    }

    // P-L2: canopy positions WITH ground Y, for the shadow-caster proxies (treeShadowProxies.js).
    // Flat [x, groundY, z] triples rather than objects: the proxy builder rescans every resident
    // tile's trees on each rebuild to find the ones inside the shadow frustum, and that scan is the
    // only per-rebuild cost worth caring about at ~2k trees a tile.
    // Ground Y is resolved HERE, once, while the tile's own elevation sampler is in scope — the
    // proxy builder runs long after that and has no way back to it.
    if (vegTreePositions.length > 0) {
      const _tp = new Float32Array(vegTreePositions.length * 3);
      for (let i = 0; i < vegTreePositions.length; i++) {
        const _p = vegTreePositions[i];
        _tp[i * 3]     = _p.x;
        _tp[i * 3 + 1] = getGroundY ? getGroundY(_p.x, _p.y) : 0;
        _tp[i * 3 + 2] = _p.y;      // ⚠ .y IS world Z on these records (see buildSceneryColliders)
      }
      entry.treeProxyData = _tp;
    }

    // Green meshes already built in Phase 1 — add to vegetation list for cleanup tracking
    if (entry.greenMeshes) entry.greenMeshes.forEach((m) => vegetationMeshes.push(m));

    entry.vegetationMeshes = vegetationMeshes;

    await yieldToMain();

    if (aborted()) return entry;
    // -----------------------------------------------------------------------
    // PHASE 4: Grass + Water + Props + Infra + Details (background)
    // -----------------------------------------------------------------------
    buildPhase('p4 grass/detail');

    // v3 P1-17: the grass block is GONE. It was gated on CONFIG.MAX_GRASS_PER_TILE, which has
    // been 0 since 2026-07-02, so the worker call, the materialize and grassRenderer.js itself
    // were all unreachable. Roadside greenery returns in P4 as part of the terrain splat.

    await yieldToMain();

    buildPhase('p4 water');
    // Water — use getWorldElevation for terrain-following water surface
    const waterAreas = (skipNonRoad || !CONFIG.ENABLE_WATER) ? [] : [
      ...(tileData.water || []),
      ...(tileData.marinas || []).filter((m) => !m.isLine),  // harbour basins rendered as water
    ];
    if (waterAreas.length > 0) {
      const wr = renderWater(tileData, { renderedWaterIds, getElevationAt, getWorldElevation, tileKey: key });
      entry.waterMesh = wr.mesh || null;
      entry.waterIds = wr.waterIds || [];
      if (wr.mesh && safeSceneAdd(scene, wr.mesh)) { entry.waterIds.forEach((id) => renderedWaterIds.add(id)); }
      if (wr.embankmentMesh) safeSceneAdd(scene, wr.embankmentMesh);
    }

    await yieldToMain();

    // The decorative rock/bush/small-tree scatter used to build here — two phases, `p4 props` and
    // `p4 clusters`, the latter the largest single build phase measured at 700-930 ms. Both are
    // gone: the objects were unwanted even where they landed legitimately, on verges and
    // pavements, and a placement rule that only ever admits "green space with no road" is a
    // question about MAP DATA, which belongs in the bake, not in a per-frame-budget renderer.
    // See docs/context/changelog.md 2026-08-28. Street trees are unaffected — they are baked.

    // Traffic lights — pooled like the streetlight parts (was 1 InstancedMesh per tile)
    // v3 P1-18: trafficLightRenderer DELETED — a disabled, hard-coded-Y=0 duplicate of the bulbed
    // traffic lights roadInfraRenderer already builds (ENABLE_ROAD_INFRA, which is ON).

    // Shoulders + Dividers + Streetlights
    // v3 P1-15: shoulderRenderer DELETED — Delhi dirt shoulders. Barcelona has kerbs.
    // Dividers disabled

    await yieldToMain();
    if (aborted()) return entry;

    if (CONFIG.ENABLE_STREETLIGHTS) {
      const jp = getJunctionPoints(roads, 2);
      const sl = buildStreetlights(roads, jp, options);
      if (sl) {
        // POOLED (draw audit: 6-9 IMs/tile ≈ 76+ draws citywide → ~9 global pool sets): the build
        // still produces per-tile InstancedMeshes; we strip their instance data into global pools
        // and DISCARD the meshes (never scene-added). Handles ride entry.vegPoolHandles → the
        // existing LOD fade / fog-zero / unload-release lifecycle applies unchanged. Also fixes
        // the old mirror-mesh leak (mirrors were scene-added but never tracked for unload).
        entry.vegPoolHandles = entry.vegPoolHandles || [];
        const poleHandle = await poolLightIM('pole', sl.poleMesh);
        for (const [part, im] of [['arm', sl.armMesh], ['lamp', sl.lampMesh],
                                  ['poleShadow', sl.poleShadowMesh], ['mirrorDisc', sl.mirrorDiscMesh],
                                  ['mirrorRim', sl.mirrorRimMesh], ['mirrorBack', sl.mirrorBackMesh]]) {
          const h = await poolLightIM(part, im);
          if (h) { h.kind = 'light'; entry.vegPoolHandles.push(h); }
        }
        if (poleHandle) {
          poleHandle.kind = 'light';
          entry.vegPoolHandles.push(poleHandle);
          // Bridge tricolor night cycling, pooled: address the i-th ADDED pole via rawIds.
          if (sl.bridgeIndices?.length) {
            const bridgeCb = (isNight) => {
              if (poleHandle.dead) { unregisterBridgeNightCallback(bridgeCb); return; }
              for (let bi = 0; bi < sl.bridgeIndices.length; bi++) {
                const id = poleHandle.rawIds[sl.bridgeIndices[bi]];
                poleHandle.pool.setColorAt(id, isNight ? BRIDGE_NIGHT_COLORS[Math.floor(bi / 2) % 3] : DAY_POLE_COLOR);
              }
            };
            registerBridgeNightCallback(bridgeCb);
          }
        }
        entry.streetlightPositions = sl.positions;
        entry.streetlightWireMesh = sl.wireMesh || null;
        if (sl.wireMesh) safeSceneAdd(scene, sl.wireMesh);
      }
    }

    await yieldToMain();
    if (aborted()) return entry;

    // Barriers
    if (CONFIG.ENABLE_BARRIERS && data.barriers?.length) {
      buildPhase('p4 barriers');
      entry.barrierMeshes = await mergeMeshesByMaterial(buildBarrierMeshes(data.barriers, roads, buildings, getGroundY), yieldToMain);
      for (const m of entry.barrierMeshes) safeSceneAdd(scene, m);
      if (world) {
        const physicsOrigin = getOriginOffset();
        const vertExag = CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION) ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;
        entry.barrierBody = buildBarrierColliders(data.barriers, {
          physicsOrigin, roads,
          getGroundYAt: getElevationAt ? (wx, wz) => { const { lat, lon } = worldToLatLon(wx, wz); return (getElevationAt(lat, lon) ?? 0) * vertExag; } : null,
        });
        if (entry.barrierBody) world.addBody(entry.barrierBody);
      }
    }

    // v3 P1-16: crashBarrierRenderer DELETED — Indian yellow-black crash barriers.

    // v3 P1-16: reflectorRenderer DELETED. It was gated on ENABLE_ROAD_INFRA, which is TRUE, so it
    // was LIVE: Indian cat's-eye studs every 6 m on Barcelona tertiary streets, ~42k tris and 18
    // draws per tile. Barcelona uses painted markings and reflective delineators, not road studs.

    await yieldToMain();
    if (aborted()) return entry;

    // Guard rails
    if (world) {
      const physicsOrigin = getOriginOffset();
      const tunnelRoadIds = new Set([...tunnelRoads, ...approachRoads].map(r => r.id).filter(Boolean));
      const nonTunnelRoads = (roads || []).filter(r => !tunnelRoadIds.has(r.id));
      entry.guardRailBody = buildBridgeGuardRailColliders(nonTunnelRoads, options, CANNON, physicsOrigin);
      if (entry.guardRailBody) {
        try { entry.guardRailBody.material = getCarContactMaterials(world)?.roadMaterial ?? null; } catch {}
        world.addBody(entry.guardRailBody);
      }
    }

    // Bus stops + Parking
    if (CONFIG.ENABLE_BUS_STOPS && data.busStops?.length) {
      // getGroundY takes WORLD coords (what busStopRenderer passes); getElevationAt takes lat/lon — passing
      // the latter mis-elevated every shelter (floating in one spot, sunk into the road in another).
      const { shelterMesh, markingMesh, glowMesh, poolMesh } = buildBusStopMeshes(data.busStops, roads, getGroundY);
      if (shelterMesh) { safeSceneAdd(scene, shelterMesh); entry.busStopMeshes.push(shelterMesh); }
      if (markingMesh) { safeSceneAdd(scene, markingMesh); entry.busStopMeshes.push(markingMesh); }
      if (glowMesh)    { safeSceneAdd(scene, glowMesh);    entry.busStopMeshes.push(glowMesh); }
      if (poolMesh)    { safeSceneAdd(scene, poolMesh);     entry.busStopMeshes.push(poolMesh); }
    }
    if (CONFIG.ENABLE_PARKING && data.parking?.length) {
      const { surfaceMesh, markingMesh: pkMarkingMesh } = buildParkingMeshes(data.parking, getElevationAt);
      if (surfaceMesh) { safeSceneAdd(scene, surfaceMesh); entry.parkingMeshes.push(surfaceMesh); }
      if (pkMarkingMesh) { safeSceneAdd(scene, pkMarkingMesh); entry.parkingMeshes.push(pkMarkingMesh); }
    }

    await yieldToMain();
    if (aborted()) return entry;

    // Road infra (signs, gantries)
    if (CONFIG.ENABLE_ROAD_INFRA) {
      buildPhase('p4 infra');
      // P-D1/P-D3: baked per-junction destinations — what each exit LEADS TO, derived over the
      // whole region at bake because it cannot be seen from inside one tile.
      const { meshes: infraMeshesRaw } = buildRoadInfrastructure(roads, key, getGroundY, data.junctionSigns);
      entry.roadInfraMeshes = await mergeMeshesByMaterial(infraMeshesRaw, yieldToMain);
      entry.laneArrowMesh = entry.roadInfraMeshes.find(m => m.userData?.type === 'laneArrows') || null;
      for (const m of entry.roadInfraMeshes) { safeSceneAdd(scene, m); }
    }

    // ── T-2 · TRAFFIC SIGNALS, FROM THE BAKED OSM NODES ──────────────────────────────────────
    // `data.trafficSignals` has been parsed all the way here and dropped for a long time (the v3
    // census counts them: 4,225 across the centre). They carry surveyed positions, so they sit at
    // real kerbs — unlike the old generateTrafficLights, which synthesised positions from
    // intersection geometry AND offset them to the left because it was written for Delhi.
    if (CONFIG.ENABLE_TRAFFIC_SIGNALS && data.trafficSignals?.length) {
      buildPhase('p4 signals');
      // Nearest road tangent, so a head faces oncoming traffic instead of an arbitrary direction —
      // lenses edge-on to the driver is most of why the old ones read as anonymous dark boxes.
      const nearestRoad = (x, z) => {
        let best = null, bestD = 1e9;
        for (const r of roads) {
          const pts = r.points;
          if (!pts || pts.length < 2) continue;
          for (let i = 0; i < pts.length - 1; i++) {
            const ax = pts[i].x, az = pts[i].y, bx = pts[i + 1].x, bz = pts[i + 1].y;
            const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
            if (l2 < 1e-6) continue;
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
            const qx = ax + t * dx, qz = az + t * dz;
            const d = (x - qx) ** 2 + (z - qz) ** 2;
            // Width travels with the tangent: a signal must step to ITS road's kerb, and a fixed
            // offset plants the pole mid-carriageway (measured: 2.0 m inside a 5 m road).
            if (d < bestD) {
              bestD = d; const l = Math.sqrt(l2);
              best = { tx: dx / l, tz: dz / l, width: r.width || 0 };
            }
          }
        }
        return bestD < 400 ? best : null;   // 20 m — beyond that it is not this signal's road
      };
      // T-3/T-4: the builder returns the metadata it ACTUALLY drew — axis and per-junction phase —
      // and the traffic AI consumes that rather than recomputing it. Deriving the same thing twice
      // is how a car ends up obeying a different phase from the lamp in front of it.
      const sig = buildTrafficSignals(data.trafficSignals, getGroundY, nearestRoad, roads);
      if (sig?.mesh) {
        entry.trafficSignalMesh = sig.mesh;
        entry.trafficSignalAxes = sig.meta;
        safeSceneAdd(scene, sig.mesh);
      }
    }

    // Decals
    // v3 P1-15: decalRenderer DELETED — Delhi-era wall posters.

    await yieldToMain();
    if (aborted()) return entry;

    // Urban features + Vendor carts
    if (CONFIG.ENABLE_URBAN_FEATURES && data.urbanFeatures?.length) {
      buildPhase('p4 urban');
      entry.urbanFeatureMeshes = await mergeMeshesByMaterial(await buildUrbanFeatureMeshes(data.urbanFeatures, roads, buildings, getGroundY, yieldToMain), yieldToMain);
      for (const m of entry.urbanFeatureMeshes) { safeSceneAdd(scene, m); }
    }
    // v3 P1-16: vendorCartRenderer DELETED — Delhi street vendors.

    // Shop name boards on building fronts (one InstancedMesh per tile).
    if (CONFIG.ENABLE_SHOP_SIGNS !== false && CONFIG.ENABLE_BUILDINGS && buildings?.length) {
      const signMesh = buildShopSignMesh(buildings, { getElevationAt, vertExag: _groundVertExag });
      if (signMesh) { entry.shopSignMesh = signMesh; safeSceneAdd(scene, signMesh); }
    }

    // Ground-floor shopfronts (glass windows + door) UNDER the awnings/signs so shops read as entrances.
    if (CONFIG.ENABLE_SHOPFRONTS !== false && CONFIG.ENABLE_BUILDINGS && buildings?.length) {
      const sfMeshes = buildShopfrontMeshes(buildings, { getElevationAt, vertExag: _groundVertExag });
      if (sfMeshes) { entry.shopfrontMeshes = sfMeshes; for (const m of sfMeshes) safeSceneAdd(scene, m); }
    }

    // Projecting fabric awnings over the ground-floor shopfronts (one merged mesh per tile).
    if (CONFIG.ENABLE_AWNINGS !== false && CONFIG.ENABLE_BUILDINGS && buildings?.length) {
      const awningMesh = buildAwningMesh(buildings, { getElevationAt, vertExag: _groundVertExag });
      if (awningMesh) { entry.awningMesh = awningMesh; safeSceneAdd(scene, awningMesh); }
    }

    // Café terraces (parasol + table + chairs clusters) on the sidewalks in front of some shops.
    if (CONFIG.ENABLE_CAFE_TERRACES !== false && CONFIG.ENABLE_BUILDINGS && buildings?.length) {
      const terraceMeshes = buildCafeTerrace(buildings, { getElevationAt, vertExag: _groundVertExag, roads });
      if (terraceMeshes) { entry.cafeTerraceMeshes = terraceMeshes; for (const m of terraceMeshes) safeSceneAdd(scene, m); }
    }

    await yieldToMain();
    if (aborted()) return entry;

    // Vertex count warning
    const totalVertices = countVertices(roadMeshes) + countVertices(entry.railwayMeshes) + countVertices(buildingMeshes);
    if (totalVertices > MAX_VERTICES_PER_TILE) {
      console.warn(`Tile ${key}: vertex count ${totalVertices} exceeds soft budget ${MAX_VERTICES_PER_TILE} (informational only — LOD culling keeps render cost low)`);
      if (totalVertices > VERTEX_BUDGET_HARD) {
        console.warn(`Tile ${key}: vertex count ${totalVertices} exceeds HARD budget ${VERTEX_BUDGET_HARD} — investigate geometry for this tile`);
      }
    }

    // Scenery + building colliders. Built and added in yielded steps so a dense tile's collider burst
    // (thousands of tree boxes + per-building convex/box shapes) spreads across a few frames instead of
    // freezing one — that freeze is what jolts the car at speed when a new tile finalizes.
    if (world) {
      const physicsOrigin = getOriginOffset();
      const treePos = vegTreePositions || [];
      const vertExag = CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION) ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;
      entry.sceneryBodies = buildSceneryColliders(treePos, pillarPositions, physicsOrigin, getElevationAt, vertExag);
      await yieldToMain();
      // If the tile was unloaded during any of these yields, STOP — otherwise we add colliders to a
      // dead entry the unload sweep already cleared → invisible phantom walls + a permanent physics leak.
      if (aborted()) return entry;
      // addBody recomputes each body's AABB over all its shapes (buildings can hold hundreds of perimeter-
      // wall boxes), so adding many in one synchronous burst jolts the frame. Yield every few bodies.
      for (let i = 0; i < entry.sceneryBodies.length; i++) {
        world.addBody(entry.sceneryBodies[i]);
        // yield check EVERY body — it's a no-op under budget, and one multi-shape body's AABB
        // recompute can alone chew several ms (fps-diagnosis: chunks must stay ≤~10ms)
        { await yieldToMain(); if (aborted()) return entry; }
      }
      await yieldToMain();
      if (aborted()) return entry;
      // Building colliders — solid shapes so the car can't drive through buildings.
      entry.buildingBodies = (CONFIG.ENABLE_BUILDINGS && filteredTileData.buildings?.length)
        ? await buildBuildingColliders(filteredTileData.buildings, physicsOrigin, getElevationAt, vertExag, filteredTileData.roads, yieldToMain) : [];
      await yieldToMain();
      if (aborted()) return entry;
      for (let i = 0; i < entry.buildingBodies.length; i++) {
        world.addBody(entry.buildingBodies[i]);
        // every body (see scenery loop note) — a building body can hold hundreds of wall boxes
        { await yieldToMain(); if (aborted()) return entry; }
      }
    }

    return entry;
  }

  function injectSpawnTile(key, tx, ty, data) {
    if (tileCache.has(key)) return Promise.resolve();
    return processTileData(key, tx, ty, data);
  }

  function startOneTileLoad(key, tx0, ty0) {
    if (tileCache.has(key)) return;
    if (!Number.isFinite(tx0) || !Number.isFinite(ty0)) {
    _tileEpoch++;
      tileCache.set(key, {
        roads: [],
        buildings: [],
        roadMeshes: [],
        railwayMeshes: [],
        buildingMeshes: [],
        vegetationMeshes: [],
        waterMesh: null,
        waterIds: [],
        trafficLightMesh: null,
        shoulderMesh: null,
        dividerMesh: null,
        streetlightPoleMesh: null,
        streetlightArmMesh: null,
        streetlightLampMesh: null,
        streetlightPoolMesh: null,
        streetlightPoleShadowMesh: null,
        streetlightPositions: [],
        barrierMeshes: [],
        barrierBody: null,
        crashBarrierMesh: null,
        crashBarrierBody: null,
        reflectorGroup: null,
        guardRailBody: null,
        sceneryBodies: [],
        buildingBodies: [],
        busStopMeshes: [],
        roadInfraMeshes: [],
        urbanFeatureMeshes: [],
        vendorCartMeshes: [],
        tunnelMeshGroup: null,
        canopyMeshGroup: null,
        tunnelWallBody: null,
      approachWallBody: null,
        tunnelShoulderBody: null,
        terrainTrimeshBody: null,
        spatialIndex: {},
        roadMinY: null,
        roadMaxY: null,
      });
      return;
    }
    loadingKeys.add(key);
    inFlightCount += 1;
    loadTile(tx0, ty0)
      .then((data) => processTileData(key, tx0, ty0, data))
      .catch((e) => {
        console.warn('Tile load failed', key, e);
    _tileEpoch++;
        tileCache.set(key, {
          roads: [],
          buildings: [],
          roadMeshes: [],
          railwayMeshes: [],
          buildingMeshes: [],
          vegetationMeshes: [],
          waterMesh: null,
          waterIds: [],
          trafficLightMesh: null,
          shoulderMesh: null,
          dividerMesh: null,
          streetlightPoleMesh: null,
          streetlightLampMesh: null,
          streetlightPoolMesh: null,
          streetlightPoleShadowMesh: null,
          streetlightPositions: [],
          barrierMeshes: [],
          barrierBody: null,
          crashBarrierMesh: null,
        crashBarrierBody: null,
        reflectorGroup: null,
        guardRailBody: null,
          roadInfraMeshes: [],
        urbanFeatureMeshes: [],
        vendorCartMeshes: [],
          tunnelMeshGroup: null,
        canopyMeshGroup: null,
          tunnelWallBody: null,
      approachWallBody: null,
        tunnelShoulderBody: null,
        terrainTrimeshBody: null,
          spatialIndex: {},
          roadMinY: null,
          roadMaxY: null,
        });
      })
      .finally(() => {
        loadingKeys.delete(key);
        inFlightCount -= 1;
        processNextPending();
      });
  }

  function processNextPending() {
    while (inFlightCount < MAX_CONCURRENT_TILE_LOADS && pendingQueue.length > 0) {
      const { key, tx0, ty0 } = pendingQueue.shift();
      if (tileCache.has(key) || loadingKeys.has(key)) continue;
      startOneTileLoad(key, tx0, ty0);
    }
  }

  // Camera heading (radians, 0 = +Z, positive = clockwise from top).
  // Updated each frame from main.js so tile priority knows where the player is looking.
  let cameraHeadingRad = 0;

  /**
   * Update loaded tiles based on viewer position (local x, z). Converts to world for tile logic.
   * @param {number} localX - viewer position in local space
   * @param {number} localZ - viewer position in local space
   * @param {{ headingDeg?: number }} [opts]
   */
  let _lastUpdateSkip = 'update() has never been called';
  let _updateCalls = 0;
  async function update(localX, localZ, opts) {
    _updateCalls++;
    // Start of a new frame → reset the shared tile-work budget (see yieldToMain). All in-flight tile
    // finalizes measure against this single per-frame reference, capping total build work per frame.
    const _now = performance.now();
    // Adaptive budget: the gap between update() calls ≈ the last frame's duration. If frames are running
    // long (streaming + render can't keep 60fps), shrink the build budget so tile work stops piling onto an
    // already-slow frame (the high-speed stutter); when frames are smooth again, grow it back to catch up.
    // While the loading overlay is still up there is nothing to keep smooth, so the drive-time cap
    // does not apply — see LOAD_BUDGET_MS. The latch is one-way: once the first ring has built, the
    // adaptive drive budget takes over for the rest of the session and never comes back here.
    if (!_initialLoadDone) {
      if (isInitialLoadComplete()) { _initialLoadDone = true; _budgetMs = FRAME_BUDGET_MS; }
      else _budgetMs = LOAD_BUDGET_MS;
    }
    if (_initialLoadDone && _lastUpdateAt) {
      const frameMs = _now - _lastUpdateAt;
      if (frameMs > 20) _budgetMs = Math.max(BUDGET_MIN, _budgetMs - 0.6);        // < ~50 fps → back off
      else if (frameMs < 17) _budgetMs = Math.min(BUDGET_MAX, _budgetMs + 0.4);   // ~60 fps → resume
    }
    _lastUpdateAt = _now;
    _frameBudgetStart = _now;
    if (opts && Number.isFinite(opts.headingDeg)) {
      cameraHeadingRad = opts.headingDeg * Math.PI / 180;
    }
    // ── WHY DID THIS FRAME NOT QUEUE ANYTHING? ───────────────────────────────────────────────
    // Both of these returns are silent, and between them they can leave a world with zero tiles and
    // no error anywhere — the "world never streams" blocker recorded 2026-08-30 and seen again on
    // 09-01/09-02, where _ddLoadState() reads started:false, inFlight:0, pending:0, resident:0.
    // That state says the streamer was never ASKED, which is a completely different bug from a
    // hung fetch, and nothing on screen or in the console distinguished them. One string does.
    if (!Number.isFinite(localX) || !Number.isFinite(localZ)) {
      _lastUpdateSkip = `viewer xz not finite (${localX}, ${localZ})`;
      return;
    }
    const o = getOriginOffset();
    const worldX = localX + o.x;
    const worldZ = localZ + o.z;
    const { x: tx, y: ty } = worldToSlippyTile(worldX, worldZ);
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
      _lastUpdateSkip = `tile xy not finite — viewer (${localX.toFixed(1)}, ${localZ.toFixed(1)}) `
        + `+ origin (${o.x}, ${o.z}) -> world (${worldX}, ${worldZ}) -> tile (${tx}, ${ty})`;
      return;
    }
    _lastUpdateSkip = null;
    const prevTx = currentTx;
    const prevTy = currentTy;
    currentTx = tx;
    currentTy = ty;

    // Tiles we want loaded: 3×3 core grid + look-ahead tiles in driving direction.
    // Reuse a persistent Set (cleared) instead of allocating one every frame → far less GC churn.
    const wanted = _wantedSet; wanted.clear();
    const gridR = _photoMode ? _photoRadius : GRID_RADIUS; // wider (live-adjustable) load area for photo mode
    for (let dx = -gridR; dx <= gridR; dx++) {
      for (let dy = -gridR; dy <= gridR; dy++) {
        wanted.add(tileKey(tx + dx, ty + dy));
      }
    }
    // Add look-ahead tiles in the driving direction. Extend FURTHER the faster you go, so the fetch +
    // build burst for the next tile row happens with lead time (spread over more frames) instead of
    // landing right as you cross the boundary — that just-in-time burst is the high-speed stutter.
    const speedKmh = (opts && Number.isFinite(opts.speedKmh)) ? opts.speedKmh : 0;
    const dynLookahead = LOOKAHEAD_RADIUS + Math.min(2, Math.floor(speedKmh / 75)); // less aggressive prefetch → fewer resident tiles
    const camDirTileX = Math.round(Math.sin(cameraHeadingRad));
    const camDirTileZ = Math.round(Math.cos(cameraHeadingRad));
    for (let r = gridR + 1; r <= dynLookahead; r++) {
      // Fan: center + two adjacent tiles in driving direction
      wanted.add(tileKey(tx + camDirTileX * r, ty + camDirTileZ * r));
      // Side tiles next to the center look-ahead
      if (camDirTileX !== 0) {
        wanted.add(tileKey(tx + camDirTileX * r, ty - 1));
        wanted.add(tileKey(tx + camDirTileX * r, ty + 1));
      }
      if (camDirTileZ !== 0) {
        wanted.add(tileKey(tx - 1, ty + camDirTileZ * r));
        wanted.add(tileKey(tx + 1, ty + camDirTileZ * r));
      }
    }
    let allLoaded = true;
    for (const k of wanted) { if (!tileCache.has(k)) { allLoaded = false; break; } } // no array spread / closure
    if (tx === prevTx && ty === prevTy && allLoaded) return;

    // Drop pending tiles that are no longer wanted (e.g. user drove away)
    const toKeep = pendingQueue.filter((p) => wanted.has(p.key));
    pendingQueue.length = 0;
    pendingQueue.push(...toKeep);

    // Unload tiles too far away — two-phase disposal to prevent GC spikes:
    // Phase A (immediate): remove from scene + physics (prevents rendering/simulation)
    // Phase B (deferred): GPU resource disposal spread across frames
    // In Photo Mode the wanted radius is huge — the unload distance MUST match it, or tiles past the
    // normal UNLOAD_DISTANCE load then immediately unload every frame (the "flickering / stuck" thrash).
    const unloadDist = _photoMode ? _photoRadius : UNLOAD_DISTANCE;
    for (const [key, entry] of tileCache.entries()) {
      if (!entry._tx) { const p = key.split('_'); entry._tx = +p[0]; entry._ty = +p[1]; }
      if (tileDistance(entry._tx, entry._ty, tx, ty) > unloadDist) {
        cancelTile(key);

        // Phase A: immediate scene removal (cheap — just detaches from scene graph)
        const allMeshes = [];
        const collectAndRemove = (m) => { if (m) { scene.remove(m); allMeshes.push(m); } };
        const collectArrayAndRemove = (arr) => { if (arr) arr.forEach(collectAndRemove); };

        collectArrayAndRemove(entry.roadMeshes);
        collectArrayAndRemove(entry.railwayMeshes);
        collectArrayAndRemove(entry.buildingMeshes);
        collectAndRemove(entry.lodBuildingMesh);
        collectArrayAndRemove(entry.vegetationMeshes);
        releaseVegHandles(entry);   // free this tile's instances in the global veg pools
        // Green meshes built in Phase 1 may not be in vegetationMeshes if aborted early
        if (entry.greenMeshes) {
          for (const m of entry.greenMeshes) {
            if (!entry.vegetationMeshes || !entry.vegetationMeshes.includes(m)) {
              collectAndRemove(m);
            }
          }
        }
        collectAndRemove(entry.waterMesh);
        if (entry.waterIds) (entry.waterIds).forEach((id) => renderedWaterIds.delete(id));
        collectAndRemove(entry.trafficLightMesh);
        for (const meshKey of ['shoulderMesh', 'dividerMesh', 'streetlightWireMesh'] /* streetlight parts live in global pools now */) {
          collectAndRemove(entry[meshKey]);
        }
        // T-2 signals own their merged geometry per tile (the MATERIAL is shared and must not be
        // disposed — userData.sharedMaterial marks it). tileDisposal.test.js caught this field
        // leaking the moment it was added, which is exactly what that test is for.
        if (entry.trafficSignalMesh) { scene.remove(entry.trafficSignalMesh); allMeshes.push(entry.trafficSignalMesh); }
        if (entry.crosswalkMesh)    { scene.remove(entry.crosswalkMesh);    allMeshes.push(entry.crosswalkMesh); }
        if (entry.onewayArrowMesh)  { scene.remove(entry.onewayArrowMesh);  allMeshes.push(entry.onewayArrowMesh); }
        if (entry.bcnSidewalkMesh)  { scene.remove(entry.bcnSidewalkMesh);  allMeshes.push(entry.bcnSidewalkMesh); }
        if (entry.bcnCurbMesh)      { scene.remove(entry.bcnCurbMesh);      allMeshes.push(entry.bcnCurbMesh); }
        if (entry.bcnBikeLaneMesh)  { scene.remove(entry.bcnBikeLaneMesh);  allMeshes.push(entry.bcnBikeLaneMesh); }
        if (entry.bcnBikePictoMesh) { scene.remove(entry.bcnBikePictoMesh); allMeshes.push(entry.bcnBikePictoMesh); }
        if (entry.tramRailMesh)     { scene.remove(entry.tramRailMesh);     allMeshes.push(entry.tramRailMesh); }
        if (entry.noParkingMesh)    { scene.remove(entry.noParkingMesh);    allMeshes.push(entry.noParkingMesh); }
        if (entry.chamferSwMesh)    { scene.remove(entry.chamferSwMesh);    allMeshes.push(entry.chamferSwMesh); }
        if (entry.chamferCurbMesh)  { scene.remove(entry.chamferCurbMesh);  allMeshes.push(entry.chamferCurbMesh); }
        if (entry.zona30Mesh)       { scene.remove(entry.zona30Mesh);       allMeshes.push(entry.zona30Mesh); }
        if (entry.tactileMesh)      { scene.remove(entry.tactileMesh);      allMeshes.push(entry.tactileMesh); }
        if (entry.bluezoneMesh)     { scene.remove(entry.bluezoneMesh);     allMeshes.push(entry.bluezoneMesh); }
        if (entry.crashBarrierMesh) { scene.remove(entry.crashBarrierMesh); allMeshes.push(entry.crashBarrierMesh); }
        if (entry.reflectorGroup) { scene.remove(entry.reflectorGroup); allMeshes.push(entry.reflectorGroup); }
        collectArrayAndRemove(entry.barrierMeshes);
        collectArrayAndRemove(entry.busStopMeshes);
        collectArrayAndRemove(entry.parkingMeshes);
        collectArrayAndRemove(entry.roadInfraMeshes);
        collectArrayAndRemove(entry.urbanFeatureMeshes);
        collectArrayAndRemove(entry.vendorCartMeshes);
        collectAndRemove(entry.terrainMesh);
        if (entry.tunnelMeshGroup)      { scene.remove(entry.tunnelMeshGroup);      allMeshes.push(entry.tunnelMeshGroup); }
        if (entry.canopyMeshGroup)      { scene.remove(entry.canopyMeshGroup);      allMeshes.push(entry.canopyMeshGroup); }
        if (entry.retainingWallMesh)    { scene.remove(entry.retainingWallMesh);    allMeshes.push(entry.retainingWallMesh); }
        if (entry.trenchWallMesh)       { scene.remove(entry.trenchWallMesh);       allMeshes.push(entry.trenchWallMesh); }
        if (entry.trenchPortalMesh)     { scene.remove(entry.trenchPortalMesh);     allMeshes.push(entry.trenchPortalMesh); }
        if (entry.pedestrianPortalMesh) { scene.remove(entry.pedestrianPortalMesh); allMeshes.push(entry.pedestrianPortalMesh); }
        if (entry.debugPhysicsHelpers) { scene.remove(entry.debugPhysicsHelpers); allMeshes.push(entry.debugPhysicsHelpers); }
        if (entry.shopSignMesh)        { scene.remove(entry.shopSignMesh);        allMeshes.push(entry.shopSignMesh); }
        if (entry.awningMesh)          { scene.remove(entry.awningMesh);          allMeshes.push(entry.awningMesh); }
        if (entry.cafeTerraceMeshes)   { for (const m of entry.cafeTerraceMeshes) { scene.remove(m); allMeshes.push(m); } }
        if (entry.shopfrontMeshes)     { for (const m of entry.shopfrontMeshes) { scene.remove(m); allMeshes.push(m); } }
        // ⚠ LEAK FIX (task #39). streetlightWireMesh is a per-tile LineSegments built in
        // streetlightRenderer.js:602 with its OWN geometry. It was added to the scene, had its
        // visibility driven every frame by three separate LOD branches — and was never disposed,
        // because it is the one entry field that is neither an alias into a disposed array nor a
        // pool handle. Measured: geometries climbing ~6/s at a CONSTANT resident tile count.
        if (entry.streetlightWireMesh) { scene.remove(entry.streetlightWireMesh); allMeshes.push(entry.streetlightWireMesh); }

        // Physics removal (immediate — must be synchronous for simulation correctness)
        // Also null out shape references to help GC reclaim CANNON memory
        const removeBodyAndShapes = (body) => {
          if (!body || !world) return;
          world.removeBody(body);
          body.shapes.length = 0;
          body.shapeOffsets.length = 0;
          body.shapeOrientations.length = 0;
        };
        removeBodyAndShapes(entry.tunnelWallBody);
        removeBodyAndShapes(entry.approachWallBody);
        removeBodyAndShapes(entry.tunnelShoulderBody);
        removeBodyAndShapes(entry.terrainTrimeshBody);
        if (entry.rampBodies?.length) for (const b of entry.rampBodies) removeBodyAndShapes(b);
        unregisterTunnelZones(key);   // was tileKey (the function) — registry keyed by the string `key`
        if (entry.heightfieldBody && world) {
          removeBodyAndShapes(entry.heightfieldBody);
          tileManagerState.numHeightfieldBodies -= 1;
        }
        removeBodyAndShapes(entry.trimeshBody);
        removeBodyAndShapes(entry.barrierBody);
        removeBodyAndShapes(entry.crashBarrierBody);
        removeBodyAndShapes(entry.guardRailBody);
        if (entry.sceneryBodies?.length && world) {
          for (const b of entry.sceneryBodies) removeBodyAndShapes(b);
        }
        if (entry.buildingBodies?.length && world) {
          for (const b of entry.buildingBodies) removeBodyAndShapes(b);
        }

        // Phase B: queue GPU disposal for deferred processing
        _pendingDisposals.push({ meshes: allMeshes, entry });
        tileCache.delete(key); _tileEpoch++;
        if (_onMapTileRemoved) { try { _onMapTileRemoved(key); } catch (e) { /* minimap must never break tiles */ } }
      }
    }

    // Process deferred GPU disposals — one tile per frame to avoid GC spikes
    if (_pendingDisposals.length > 0) {
      const disposal = _pendingDisposals.shift();
      const acct = CONFIG.DEBUG_LEAK ? { held: 0, freed: 0, shared: 0 } : null;
      const before = acct ? geometryCount() : -1;
      for (const m of disposal.meshes) disposeTileObject(m, acct);
      if (acct) reportUnloadAccounting(acct, before);
      // v3 P1-15 REGRESSION FIX: this called disposeDecalMeshes(), which went with decalRenderer.js.
      // entry.decalMeshes is now always [] — and an EMPTY ARRAY IS TRUTHY, so the guard passed and
      // threw a ReferenceError inside update() on every tile unload, aborting the rest of the frame's
      // work (including the whole LOD/culling pass). Decal plumbing removed entirely.
    }

    // Distance-based LOD — throttled: only recalc when viewer moves >15m
    const lodDx = worldX - _lastLodX, lodDz = worldZ - _lastLodZ;
    const lodNeedsUpdate = (lodDx * lodDx + lodDz * lodDz > LOD_THRESHOLD_SQ);
    if (lodNeedsUpdate) {
      _lastLodX = worldX;
      _lastLodZ = worldZ;
    }
    // Always run on first frame or when moved enough
    if (lodNeedsUpdate) {
    const treeFullDist = _photoMode ? Infinity : (typeof CONFIG.TREE_FULL_DISTANCE === 'number' ? CONFIG.TREE_FULL_DISTANCE : 200);
    const treeMaxDist = typeof CONFIG.TREE_MAX_DISTANCE === 'number' ? CONFIG.TREE_MAX_DISTANCE : 500;
    const treeFadeRange = Math.max(1, treeMaxDist - treeFullDist);
    const grassMaxDist = _photoMode ? Infinity : (typeof CONFIG.GRASS_MAX_DISTANCE === 'number' ? CONFIG.GRASS_MAX_DISTANCE : 250);

    // Camera-altitude-aware multiplier — scales building LOD/detail thresholds so drone/fly
    // mode loads detail at greater distances. Ground driving (cameraY ≤ 5m) → multiplier = 1,
    // preserving existing behaviour exactly. Clamped at 4× to prevent runaway at extreme altitude.
    const _cameraY = camera?.position.y ?? 0;
    const altMult = Math.max(1.0, Math.min(5, 1.0 + (_cameraY - 5) / 35));

    for (const [key, entry] of tileCache.entries()) {
      // Use cached tile center (set during tile creation) to avoid split+map+trig per frame
      const cx = entry._centerX, cz = entry._centerZ;
      if (cx == null) continue; // not yet set
      const centerDist = Math.hypot(worldX - cx, worldZ - cz);
      // Nearest-edge distance: 0 when player is inside or touching the tile,
      // actual distance to the closest edge otherwise. This prevents billboard
      // trees from appearing close when the player is near a tile boundary.
      const TILE_HALF = 250; // ~half of a zoom-16 tile in world metres
      const nearEdgeDist = Math.max(0, centerDist - TILE_HALF);
      const dist = centerDist; // keep center dist for non-tree LOD

      // ── Fog culling: hide EVERYTHING on tiles fully inside fog ──────────
      // With FogExp2 density 0.006, objects at 250m are ~90% fogged.
      // Skip all per-mesh checks for distant tiles → saves CPU + draw calls.
      // ⚠ Test the ACTUAL fog, not the config flag. `main.js` sets
      //     scene.fog.density = carDriver ? (...) : 0
      // so in FLY mode there is no fog AT ALL — yet this cull, reading only `CONFIG.ENABLE_FOG`,
      // went on deleting everything past 280 m "because it is fogged". Fly mode is how the city is
      // reviewed (H14), so the one mode with perfect visibility was the one throwing the city away.
      // Density is also altitude-faded, which is exactly when you can see furthest.
      const _fogDensity = CONFIG.ENABLE_FOG ? (scene?.fog?.density ?? 0) : 0;
      const FOG_FULL_DIST = (_photoMode || _fogDensity <= 1e-6) ? Infinity : 280;
      if (nearEdgeDist > FOG_FULL_DIST) {
        // GROUND-COVER-FIX: park/garden and plaza polygons are flat ground COVER, not detail —
        // they ride out to GROUND_COVER_CUT_M like the impostors below, or the terrain they are
        // supposed to hide shows through as a lawn. Everything else in this list still dies here.
        const coverLives = nearEdgeDist <= GROUND_COVER_CUT_M;
        const hideAll = (meshes) => { if (meshes) for (const m of meshes) m.visible = false; };
        const hideAllButCover = (meshes) => {
          if (!meshes) return;
          for (const m of meshes) {
            const t = m.userData?.type;
            m.visible = coverLives && (t === 'greens' || t === 'areaFeature');
          }
        };
        hideAllButCover(entry.vegetationMeshes);
        // VEG-FIX-1: BILLBOARD IMPOSTORS SURVIVE THE FOG CULL out to VEG_IMPOSTOR_CUT_M.
        //
        // P4-02 raised the terrain cut to 1500 m while vegetation still ended at this 280 m fog
        // boundary, which left ~1200 m of bare ground on screen and a hard line where trees popped
        // in and out. The mismatch was invisible before only because terrain died at 280 m too.
        //
        // Impostors, not 3D trees: a tree past 170 m is already a billboard, and the per-tile count
        // ramps to zero by the cut, so a far tile contributes a handful of quads rather than a
        // canopy. 600 m is where FogExp2 at 0.0025 reaches 89.5% — past that the ground is haze and
        // vegetation on it cannot be seen, so extending further would be pure cost.
        if (entry.vegPoolHandles) {
          const bbF = impostorFrac(nearEdgeDist, treeFullDist, treeMaxDist);
          _ddRecordLod(key, nearEdgeDist, 0, bbF, true, entry.vegPoolHandles);
          for (const h of entry.vegPoolHandles) {
            // Only 'billboard' survives out here. 3D trees and bushes stay culled — a bush is a
            // couple of pixels at this range and there are thousands of them per tile.
            const target = (h.kind === 'billboard' && bbF > 0)
              ? Math.max(1, Math.floor(bbF * h.count)) : 0;
            h.pool.setVisibleCount(h, target);
          }
        }
        hideAll(entry.buildingMeshes);
        hideAll(entry.roadInfraMeshes);
        hideAll(entry.barrierMeshes);
        hideAll(entry.busStopMeshes);
        hideAll(entry.urbanFeatureMeshes);
        hideAll(entry.vendorCartMeshes);
        // v3 P0-17: street dressing was absent from BOTH this block and the LOD loop below,
        // so shopfronts/awnings/signs/terraces rendered at every distance in every loaded tile.
        hideAll(entry.shopfrontMeshes);
        hideAll(entry.cafeTerraceMeshes);
        if (entry.shopSignMesh) entry.shopSignMesh.visible = false;
        if (entry.awningMesh)   entry.awningMesh.visible   = false;
        // v3 P4-02: TERRAIN IS NOT CULLED HERE ANY MORE. It was hidden with the rest of the tile at
        // FOG_FULL_DIST (280 m) — but at the shipping fog density of 0.0025, 280 m is only 38.7%
        // fogged, so this was deleting ground that was still ~61% visible, and it is why Barcelona
        // has no distant landform: Montjuïc and the Collserola ridge simply stop existing 280 m out.
        // Buildings and vegetation ARE detail and stay culled here; the ground is not detail.
        // Terrain visibility + LOD ring are decided by applyTerrainLod() below.
        applyTerrainLod(entry, nearEdgeDist);
        // GROUND-COVER-FIX: the distant-building LOD exists precisely to stand in for the city at
        // range; hiding it here is what left whole blocks as bare terrain from the air.
        if (entry.lodBuildingMesh) entry.lodBuildingMesh.visible = coverLives;
        if (entry.reflectorGroup) entry.reflectorGroup.visible = false;
        if (entry.crashBarrierMesh) entry.crashBarrierMesh.visible = false;
        if (entry.markingsMesh)     entry.markingsMesh.visible     = false;   // v3 P1-22
        if (entry.crosswalkMesh)    entry.crosswalkMesh.visible    = false;
        if (entry.onewayArrowMesh)  entry.onewayArrowMesh.visible  = false;
        // GROUND-COVER-FIX: pavement + kerb ride with the parks — see the pair in the near path.
        if (entry.bcnSidewalkMesh)  entry.bcnSidewalkMesh.visible  = coverLives;
        if (entry.bcnCurbMesh)      entry.bcnCurbMesh.visible      = coverLives;
        if (entry.bcnBikeLaneMesh)  entry.bcnBikeLaneMesh.visible  = false;
        if (entry.bcnBikePictoMesh) entry.bcnBikePictoMesh.visible = false;
        if (entry.tramRailMesh)     entry.tramRailMesh.visible     = false;
        if (entry.noParkingMesh)    entry.noParkingMesh.visible    = false;
        if (entry.chamferSwMesh)    entry.chamferSwMesh.visible    = false;
        if (entry.chamferCurbMesh)  entry.chamferCurbMesh.visible  = false;
        if (entry.zona30Mesh)       entry.zona30Mesh.visible       = false;
        if (entry.tactileMesh)      entry.tactileMesh.visible      = false;
        if (entry.bluezoneMesh)     entry.bluezoneMesh.visible     = false;
        if (entry.waterMesh) entry.waterMesh.visible = false;
        if (entry.trafficLightMesh) entry.trafficLightMesh.visible = false;
        if (entry.shoulderMesh) entry.shoulderMesh.visible = false;
        if (entry.dividerMesh) entry.dividerMesh.visible = false;
        for (const mk of ['streetlightWireMesh'] /* streetlight parts live in global pools now */) {
          if (entry[mk]) entry[mk].visible = false;
        }
        // Keep road meshes visible (roads extend into fog for continuity)
        continue;
      }

      // ── Close tile: ensure terrain + water are visible (may have been fog-hidden) ──
      applyTerrainLod(entry, nearEdgeDist);
      if (entry.waterMesh) entry.waterMesh.visible = true;

      // Global veg pools: per-tile count fade by nearest-edge distance (nearest-first id order —
      // same semantics the per-tile meshes had). Shadows/bushes ride the same fraction as trees;
      // billboard impostors use the inverse band (visible only past where the 3D trees fade out).
      if (entry.vegPoolHandles && entry.vegPoolHandles.length > 0) {
        const frac = nearEdgeDist <= treeFullDist ? 1
          : nearEdgeDist >= treeMaxDist ? 0
          : 1 - (nearEdgeDist - treeFullDist) / treeFadeRange;
        // VEG-FIX-1: one ramp, shared with the fog-culled branch above — see impostorFrac.
        const bbFrac = impostorFrac(nearEdgeDist, treeFullDist, treeMaxDist);
        // Bushes fade FAR nearer than trees. They rode the tree band (full to TREE_FULL_DISTANCE,
        // gone by TREE_MAX_DISTANCE), which is right for a 12 m plane tree and pure waste for a 1 m
        // shrub: at 100 m a bush is a couple of pixels tall, and there are ~3,000 of them per tile
        // against ~600 trees. As alpha-tested cards that is thousands of fragment-shaded quads
        // contributing nothing, which is what made the street go heavy the moment bushes came on.
        const bushFull = Math.min(treeFullDist, 45);
        const bushMax = Math.min(treeMaxDist, 90);
        const bushFrac = nearEdgeDist <= bushFull ? 1
          : nearEdgeDist >= bushMax ? 0
          : 1 - (nearEdgeDist - bushFull) / Math.max(1, bushMax - bushFull);

        for (const h of entry.vegPoolHandles) {
          const f = h.kind === 'billboard' ? bbFrac : h.kind === 'bush' ? bushFrac : frac;
          const target = f <= 0 ? 0 : f >= 1 ? h.count : Math.max(1, Math.floor(f * h.count));
          h.pool.setVisibleCount(h, target);
        }
        _ddRecordLod(key, nearEdgeDist, frac, bbFrac, false, entry.vegPoolHandles);
      }

      if (entry.vegetationMeshes) {
        for (const m of entry.vegetationMeshes) {
          if (m.userData.type === 'grass') {
            // Grass LOD: instance count fade using nearest-edge distance
            if (m.isInstancedMesh && m.userData.maxInstanceCount > 0) {
              const grassFull = 100;  // full count within 100m of tile edge
              if (nearEdgeDist <= grassFull) {
                m.visible = true;
                m.count = m.userData.maxInstanceCount;
              } else if (nearEdgeDist >= grassMaxDist) {
                m.visible = false;
              } else {
                const frac = 1 - (nearEdgeDist - grassFull) / (grassMaxDist - grassFull);
                m.count = Math.max(1, Math.floor(frac * m.userData.maxInstanceCount));
                m.visible = true;
              }
            } else {
              m.visible = nearEdgeDist <= grassMaxDist;
            }
          } else if (m.userData.isTreeBatchedMesh && m.userData.maxInstanceCount > 0) {
            // BatchedMesh 3D trees: LOD via setVisibleAt with sorted order
            let targetCount;
            if (nearEdgeDist <= treeFullDist) {
              targetCount = m.userData.maxInstanceCount;
              m.visible = true;
            } else if (nearEdgeDist >= treeMaxDist) {
              targetCount = 0;
              m.visible = false;
            } else {
              const frac = 1 - (nearEdgeDist - treeFullDist) / treeFadeRange;
              targetCount = Math.max(1, Math.floor(frac * m.userData.maxInstanceCount));
              m.visible = true;
            }
            const prev = m.userData._lastVisibleCount;
            if (targetCount !== prev) {
              const sorted = m.userData._sortedIds;
              if (targetCount > prev) {
                for (let si = prev; si < targetCount; si++) m.setVisibleAt(sorted[si], true);
              } else {
                for (let si = targetCount; si < prev; si++) m.setVisibleAt(sorted[si], false);
              }
              m.userData._lastVisibleCount = targetCount;
            }
          } else if (m.isInstancedMesh && m.userData.isTreeBillboard && m.userData.maxInstanceCount > 0) {
            // Billboard trees: show beyond where 3D ends, using nearest-edge distance
            const bbStart = treeMaxDist;   // where 3D trees fully fade out
            const bbEnd = Math.min(bbStart + 300, FOG_FULL_DIST);   // clamped — see the pooled path
            if (nearEdgeDist <= bbStart) {
              m.visible = false;
            } else if (nearEdgeDist >= bbEnd) {
              m.visible = false;
            } else {
              const frac = 1 - (nearEdgeDist - bbStart) / (bbEnd - bbStart);
              m.count = Math.max(1, Math.floor(frac * m.userData.maxInstanceCount));
              m.visible = true;
            }
          } else if (m.isInstancedMesh && m.userData.isTreeMesh && m.userData.maxInstanceCount > 0) {
            // 3D trees: LOD based on nearest-edge distance (not tile center)
            // This prevents 3D→billboard pop when player is near a tile boundary
            if (nearEdgeDist <= treeFullDist) {
              m.visible = true;
              m.count = m.userData.maxInstanceCount;
            } else if (nearEdgeDist >= treeMaxDist) {
              m.visible = false;
            } else {
              const frac = 1 - (nearEdgeDist - treeFullDist) / treeFadeRange;
              m.count = Math.max(1, Math.floor(frac * m.userData.maxInstanceCount));
              m.visible = true;
            }
          } else if (m.userData.type === 'greens' || m.userData.type === 'areaFeature') {
            // GROUND-COVER-FIX: park/garden and plaza polygons are FLAT GROUND, and they were
            // riding the tree rule — `dist <= TREE_MAX_DISTANCE` (170 m) on the distance to the
            // tile CENTRE, which includes the camera's height. From the air every tile centre is
            // past 170 m, so every park and plaza in the city was hidden at once (measured with
            // `_ddGround()`: greens 0 visible / 31 hidden, plazas 0 / 11) and the grass-coloured
            // terrain they should be covering showed through instead.
            //
            // Ground cover follows the GROUND: nearest-EDGE distance, like terrain and roads, out
            // to where fog actually hides it. A park is a few triangles; a tree is not.
            m.visible = nearEdgeDist <= GROUND_COVER_CUT_M;
          } else {
            m.visible = dist <= treeMaxDist;
          }
        }
      }

      const bldgMaxDist    = _photoMode ? Infinity : (typeof CONFIG.BUILDING_MAX_DISTANCE === 'number' ? CONFIG.BUILDING_MAX_DISTANCE : 180) * altMult;
      const bldgDetailDist = _photoMode ? Infinity : 120 * altMult;
      const lodStart       = (typeof CONFIG.BUILDING_LOD_START === 'number' ? CONFIG.BUILDING_LOD_START : 110) * altMult;
      const lodEnd         = (typeof CONFIG.BUILDING_LOD_END   === 'number' ? CONFIG.BUILDING_LOD_END   : 230) * altMult;
      if (entry.buildingMeshes) {
        for (const m of entry.buildingMeshes) {
          if (m.userData?.isBuildingDetail) {
            m.visible = nearEdgeDist <= bldgDetailDist;
          } else {
            m.visible = nearEdgeDist <= bldgMaxDist;
          }
        }
      }
      // LOD buildings: simplified boxes visible only when detail buildings are NOT yet loaded.
      // Single source of truth for LOD visibility — never shows when detail is present.
      if (entry.lodBuildingMesh) {
        const detailLoaded = entry.buildingMeshes && entry.buildingMeshes.length > 0;
        entry.lodBuildingMesh.visible = !detailLoaded && nearEdgeDist > lodStart && nearEdgeDist <= lodEnd;
      }

      // ── Distance culling for ALL remaining mesh types ──────────────────
      // These previously had NO distance culling and rendered on all 15 tiles.
      // Using nearEdgeDist for accuracy near tile boundaries.
      const infraDist = _photoMode ? Infinity : 140;   // road infra (signs, gantries, signals)
      const detailDist = _photoMode ? Infinity : 80 * altMult;   // fine details (barriers, bus stops, vendor carts, decals) — altitude-aware
      const lightDist = _photoMode ? Infinity : 140;   // streetlights

      // Road infrastructure
      if (entry.roadInfraMeshes) {
        const show = nearEdgeDist <= infraDist;
        for (const m of entry.roadInfraMeshes) m.visible = show;
      }

      // Streetlights (6 mesh types)
      const showLights = nearEdgeDist <= lightDist;
      for (const meshKey of ['streetlightWireMesh'] /* streetlight parts live in global pools now */) {
        if (entry[meshKey]) entry[meshKey].visible = showLights;
      }

      // Traffic lights, shoulders, dividers
      if (entry.trafficLightMesh) entry.trafficLightMesh.visible = nearEdgeDist <= infraDist;
      if (entry.shoulderMesh) entry.shoulderMesh.visible = nearEdgeDist <= infraDist;
      if (entry.dividerMesh) entry.dividerMesh.visible = nearEdgeDist <= infraDist;

      // Fine detail meshes — barriers, bus stops, parking, urban features, vendor carts, decals
      const showDetail = nearEdgeDist <= detailDist;
      // v3 P1-22: lane paint reads as the road's STRUCTURE at distance, not as detail, so it gets a
      // generous band of its own — 220 m vs infra's 140 m. That sits below the 280 m fog cull (where
      // FogExp2 has it ~90% attenuated anyway) so nothing should visibly pop, while still dropping
      // the mesh for the outer ring of loaded tiles. Altitude-aware so drone views keep it.
      // Most of this task's saving is the frustum culling enabled in roadRenderer, not this gate;
      // if paint ever pops on a long straight like Gran Via, raise this before disabling it.
      if (entry.markingsMesh)     entry.markingsMesh.visible     = nearEdgeDist <= 220 * altMult;
      // Guard-rail POST LOD. The merged railing geometry is ordered [beams..., posts...], so cutting
      // the posts is a draw-range change on the same buffer — no second mesh, no extra draw call.
      // Past RAIL_POST_DIST a 0.12 m post is sub-pixel and only the beam line reads; the posts are
      // ~1,656 triangles per 100 m of guarded road and there are 658 guarded segments.
      if (entry.metalRailingMesh) {
        const g = entry.metalRailingMesh.geometry;
        const beams = g?.userData?.beamIndexCount;
        if (beams > 0) {
          const total = g.getIndex() ? g.getIndex().count : 0;
          g.setDrawRange(0, nearEdgeDist > RAIL_POST_DIST ? beams : total);
        }
      }
      // ?debug=paint — answers "why did the arrows vanish when I got close?" definitively rather
      // than by inference. For the tile the car is IN, reports whether each paint mesh EXISTS at
      // all (some street classes bake with no markings), whether the LOD gate passed, and whether
      // three frustum-culled it anyway. On screen those three have identical symptoms.
      if (_DEBUG_PAINT && nearEdgeDist === 0 && performance.now() - _paintDbgT > 1000) {
        _paintDbgT = performance.now();
        // ABSENT is ambiguous on its own — "the feature is switched off" and "this street had no
        // such paint in OSM" look identical. Name the CONFIG flag when one is off, so the log
        // answers it rather than prompting a code search.
        const off = (flag) => flag === false ? 'ABSENT(config off)' : 'ABSENT(no data)';
        const st = (m, name, flag) => {
          if (!m) return `${name}:${off(flag)}`;
          if (!m.visible) return `${name}:HIDDEN(lod)`;
          // `frustumCulled: true` only says three MAY cull it; whether it did is what matters, and
          // a culled mesh looks exactly like one the LOD hid. So run the same test three runs.
          let culled = false;
          if (m.frustumCulled && m.geometry) {
            if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
            const sph = m.geometry.boundingSphere;
            if (sph) {
              _paintSphere.copy(sph).applyMatrix4(m.matrixWorld);
              culled = !_paintFrustum.intersectsSphere(_paintSphere);
            }
          }
          return `${name}:${culled ? 'CULLED(frustum)' : 'DRAWN'}`;
        };
        _paintFrustum.setFromProjectionMatrix(
          _paintMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
        console.warn('[paint] tile %s alt=%s — %s · %s · %s · %s · %s · %s',
          key, altMult.toFixed(2),
          st(entry.markingsMesh, 'markings', undefined),
          st(entry.onewayArrowMesh, 'arrows', CONFIG.ENABLE_ONEWAY_ARROWS),
          st(entry.crosswalkMesh, 'zebra', CONFIG.ENABLE_CROSSWALKS),
          st(entry.zona30Mesh, 'zona30', undefined),
          st(entry.bcnBikePictoMesh, 'bikePicto', CONFIG.ENABLE_BIKE_LANES),
          st(entry.laneArrowMesh, 'laneArrows', CONFIG.ENABLE_ROAD_INFRA));
      }
      if (entry.crosswalkMesh)    entry.crosswalkMesh.visible    = showDetail;
      if (entry.onewayArrowMesh)  entry.onewayArrowMesh.visible  = showDetail;
      // GROUND-COVER-FIX: THE PAVEMENT AND ITS OWN KERB ARE ONE SURFACE AND MUST SHARE A DISTANCE.
      //
      // They did not: the pavement died at 80 m while the kerb that edges it drew to 200 m. So from
      // 80 m out every street had kerb lines with BARE TERRAIN between them and the buildings — the
      // green strip along the kerb, which reads as a missing-pavement bug and is really an LOD one.
      // Measured with `_ddGround()` in PHOTO mode, where every other class is fully drawn:
      // markings 12/0, crosswalk 12/0, curb 11/1, and sidewalk 5 visible / 7 HIDDEN.
      //
      // Two things were wrong. These lines never honoured `_photoMode` (unlike `showDetail` beside
      // them), so the one mode whose whole purpose is "draw everything" still culled the pavement.
      // And the pavement is not fine detail — it is flat GROUND COVER, ~480 tris a tile against the
      // kerb's ~1,000, so it belongs on the ground rule with the parks and plazas, not on an
      // 80 m detail rule inherited from barriers and bus stops.
      const kerbLineDist = _photoMode ? Infinity : GROUND_COVER_CUT_M;
      if (entry.bcnSidewalkMesh)  entry.bcnSidewalkMesh.visible  = nearEdgeDist <= kerbLineDist;
      if (entry.bcnCurbMesh)      entry.bcnCurbMesh.visible      = nearEdgeDist <= kerbLineDist;
      if (entry.bcnBikeLaneMesh)  entry.bcnBikeLaneMesh.visible  = _photoMode || nearEdgeDist <= 120 * altMult;
      if (entry.bcnBikePictoMesh) entry.bcnBikePictoMesh.visible = _photoMode || nearEdgeDist <= 50  * altMult;
      // v3 P0-17: street dressing — ground-floor detail that is unreadable past ~140 m, but was
      // rendering in EVERY loaded tile at EVERY distance (absent from this loop entirely).
      // Altitude-aware like the Phase 3 meshes so drone/fly mode still sees it from above.
      const dressDist = _photoMode ? Infinity : 140 * altMult;
      if (entry.shopSignMesh)   entry.shopSignMesh.visible = nearEdgeDist <= dressDist;
      if (entry.awningMesh)     entry.awningMesh.visible   = nearEdgeDist <= dressDist;
      if (entry.shopfrontMeshes)   for (const m of entry.shopfrontMeshes)   m.visible = nearEdgeDist <= dressDist;
      if (entry.cafeTerraceMeshes) for (const m of entry.cafeTerraceMeshes) m.visible = nearEdgeDist <= dressDist;
      if (entry.tramRailMesh)     entry.tramRailMesh.visible     = nearEdgeDist <= 200 * altMult;
      if (entry.noParkingMesh)    entry.noParkingMesh.visible    = nearEdgeDist <= 80  * altMult;
      if (entry.chamferSwMesh)    entry.chamferSwMesh.visible    = nearEdgeDist <= 80  * altMult;
      if (entry.chamferCurbMesh)  entry.chamferCurbMesh.visible  = nearEdgeDist <= 200 * altMult;
      if (entry.zona30Mesh)       entry.zona30Mesh.visible       = nearEdgeDist <= 50  * altMult;
      if (entry.tactileMesh)      entry.tactileMesh.visible      = nearEdgeDist <= 60  * altMult;
      if (entry.bluezoneMesh)     entry.bluezoneMesh.visible     = nearEdgeDist <= 80  * altMult;
      if (entry.crashBarrierMesh) entry.crashBarrierMesh.visible = showDetail;
      if (entry.reflectorGroup) entry.reflectorGroup.visible = showDetail;
      for (const m of entry.barrierMeshes || []) m.visible = showDetail;
      for (const m of entry.busStopMeshes || []) m.visible = showDetail;
      for (const m of entry.parkingMeshes || []) m.visible = showDetail;
      for (const m of entry.urbanFeatureMeshes || []) m.visible = showDetail;
      for (const m of entry.vendorCartMeshes || []) m.visible = showDetail;

      // Water
      if (entry.waterMesh) entry.waterMesh.visible = nearEdgeDist <= bldgMaxDist;

      // ── Physics body add/remove by distance ────────────────────────────
      // Actually remove far bodies from the world to reduce NaiveBroadphase
      // O(n²) cost. Use a flag instead of world.bodies.includes() (O(n)).
      const physActive = nearEdgeDist <= 120; // colliders only near the car (was 200); 120 m from tile edge is ~6 s ahead at speed
      const bodies = [
        entry.heightfieldBody, entry.trimeshBody, entry.terrainTrimeshBody,
        entry.barrierBody, entry.crashBarrierBody, entry.guardRailBody,
        entry.tunnelWallBody,
        entry.approachWallBody,
      ];
      if (entry.sceneryBodies) bodies.push(...entry.sceneryBodies);
      if (entry.buildingBodies) bodies.push(...entry.buildingBodies);
      for (const b of bodies) {
        if (!b) continue;
        // Lazy-init flag on first encounter
        if (b._ddInWorld === undefined) b._ddInWorld = world.bodies.includes(b);
        if (physActive && !b._ddInWorld) {
          b._ddInWorld = true;
          world.addBody(b);
        } else if (!physActive && b._ddInWorld) {
          b._ddInWorld = false;
          world.removeBody(b);
        }
      }
    }
    } // end LOD throttle

    // Enqueue missing tiles; start up to MAX_CONCURRENT_TILE_LOADS at a time.
    // Sort by frustum priority: tiles in front of camera load first.
    const camDirX = Math.sin(cameraHeadingRad);
    const camDirZ = Math.cos(cameraHeadingRad);
    const needed = [];
    for (const key of wanted) {
      if (tileCache.has(key)) continue;
      if (loadingKeys.has(key)) continue;
      const alreadyQueued = pendingQueue.some((p) => p.key === key);
      if (alreadyQueued) continue;
      const parts = key.split('_');
      const tx0 = +parts[0], ty0 = +parts[1];
      const { x: cx, z: cz } = tileCenterToWorld(tx0, ty0, TILE_ZOOM);
      const dx = cx - worldX, dz = cz - worldZ;
      const len = Math.hypot(dx, dz) || 1;
      const dot = (dx * camDirX + dz * camDirZ) / len;
      const priority = (1 - dot) + tileDistance(tx0, ty0, tx, ty) * 0.5;
      needed.push({ key, tx0, ty0, priority });
    }
    needed.sort((a, b) => a.priority - b.priority);
    // Also re-sort pending queue by new priorities
    for (const p of pendingQueue) {
      const { x: cx, z: cz } = tileCenterToWorld(p.tx0, p.ty0, TILE_ZOOM);
      const dx = cx - worldX, dz = cz - worldZ;
      const len = Math.hypot(dx, dz) || 1;
      const dot = (dx * camDirX + dz * camDirZ) / len;
      p.priority = (1 - dot) + tileDistance(p.tx0, p.ty0, tx, ty) * 0.5;
    }
    pendingQueue.sort((a, b) => a.priority - b.priority);
    for (const t of needed) {
      if (inFlightCount < MAX_CONCURRENT_TILE_LOADS) {
        startOneTileLoad(t.key, t.tx0, t.ty0);
      } else {
        pendingQueue.push({ key: t.key, tx0: t.tx0, ty0: t.ty0, priority: t.priority });
      }
    }

  }

  /**
   * Get debug metrics for the performance panel (active tiles, buildings, trees, elevation).
   * @param {{ carX?: number, carZ?: number, cameraY?: number }} [opts] - optional position and camera Y for elevation metrics
   * @returns {{ activeTiles: number, buildingsCount: number, treesCount: number, tileMinY?: number|null, tileMaxY?: number|null, cameraY?: number, verticalExaggeration: number }}
   */
  function getDebugMetrics(opts) {
    let buildingsCount = 0;
    let totalBuildingObjects = 0;
    let treesCount = 0;
    let totalRoadMeshes = 0;
    let vegetationMeshCount = 0;
    let roadInfraCount = 0;
    let streetlightCount = 0;
    let physicsBodyCount = 0;
    let totalRoads = 0;
    for (const entry of tileCache.values()) {
      if (entry.buildingMeshes) buildingsCount += entry.buildingMeshes.length;
      if (entry.buildings) totalBuildingObjects += entry.buildings.length;
      if (entry.roadMeshes) totalRoadMeshes += entry.roadMeshes.length;
      if (entry.roads) totalRoads += entry.roads.length;
      if (entry.vegetationMeshes) {
        vegetationMeshCount += entry.vegetationMeshes.length;
        for (const m of entry.vegetationMeshes) {
          if (m.isInstancedMesh && m.userData.isTreeMesh) treesCount += m.count;
          if (m.userData.isTreeBatchedMesh) treesCount += (m.userData._lastVisibleCount || 0);
        }
      }
      if (entry.vegPoolHandles) {
        for (const h of entry.vegPoolHandles) {
          if (h.kind === 'tree') treesCount += h.visCount;
        }
      }
      if (entry.roadInfraMeshes) roadInfraCount += entry.roadInfraMeshes.length;
      if (entry.streetlightPositions?.length) streetlightCount += entry.streetlightPositions.length;
      if (entry.barrierBody) physicsBodyCount++;
      if (entry.crashBarrierBody) physicsBodyCount++;
      if (entry.guardRailBody) physicsBodyCount++;
      if (entry.trimeshBody) physicsBodyCount++;
      if (entry.terrainTrimeshBody) physicsBodyCount++;
      if (entry.tunnelWallBody) physicsBodyCount++;
      if (entry.approachWallBody) physicsBodyCount++;
      if (entry.tunnelShoulderBody) physicsBodyCount++;
      if (entry.sceneryBodies) physicsBodyCount += entry.sceneryBodies.length;
      if (entry.buildingBodies) physicsBodyCount += entry.buildingBodies.length;
    }
    const out = {
      activeTiles: tileCache.size,
      buildingsCount,
      totalBuildingObjects,
      treesCount,
      totalRoadMeshes,
      totalRoads,
      vegetationMeshCount,
      roadInfraCount,
      streetlightCount,
      physicsBodyCount,
      verticalExaggeration: CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION) ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1,
    };
    out.terrainMinY = null;
    out.terrainMaxY = null;
    if (opts && Number.isFinite(opts.carX) && Number.isFinite(opts.carZ)) {
      const origin = getOriginOffset();
      const worldCarX = opts.carX + origin.x;
      const worldCarZ = opts.carZ + origin.z;
      const { x: tx, y: ty } = worldToSlippyTile(worldCarX, worldCarZ);
      const key = tileKey(tx, ty);
      const entry = tileCache.get(key);
      out.roadsInCurrentTile = entry?.roads?.length ?? null;
      out.tileMinY = entry?.roadMinY ?? null;
      out.tileMaxY = entry?.roadMaxY ?? null;
      out.terrainMinY = entry?.terrainMinY ?? null;
      out.terrainMaxY = entry?.terrainMaxY ?? null;
      out.cameraY = Number.isFinite(opts.cameraY) ? opts.cameraY : null;
    }
    return out;
  }

  /**
   * Get all road segments from currently loaded tiles for street name lookup.
   * @returns {{ name: string, points: {x,y}[] }[]}
   */
  // v3: cached, invalidated by tile epoch.
  //
  // This allocated a FRESH OBJECT PER ROAD, for every road in every resident tile, on EVERY call —
  // thousands of objects across 9-18 tiles. And it has four hot callers: the street-name lookup
  // (every 10 m of movement), parked-car rebuild, pedestrian reassign, and traffic path extension,
  // which runs per CAR whenever a car's path runs out. That is a large, repeated allocation churn
  // feeding the GC pauses that show up as unattributed `other` time in the frame attributor.
  //
  // The contents only change when the resident tile set changes, which is exactly what _tileEpoch
  // tracks, so nearly every call is now a pointer return.
  //
  // ⚠ THE RETURNED ARRAY IS SHARED AND MUST BE TREATED AS READ-ONLY. Every current caller only
  // reads it (checked at the time of writing); a caller that sorts or splices it would corrupt the
  // list for all the others until the next tile load.
  let _segCache = null, _segCacheEpoch = -1;
  /**
   * Every loaded traffic signal, in WORLD coords, with the phase axis it governs. T-3.
   *
   * Cached against `_tileEpoch` like the road segments: signals only change when a tile loads or
   * unloads, and rebuilding this per frame for 28 cars would be pure waste.
   *
   * The axis is derived HERE, once, from the nearest road tangent — the same rule the renderer uses
   * to orient the head, so a car and the lamp it is looking at can never disagree about which phase
   * they are on. Deriving it independently in two places is how that drifts.
   */
  let _sigCache = null, _sigCacheEpoch = -1;
  function getLoadedTrafficSignals() {
    if (_sigCache !== null && _sigCacheEpoch === _tileEpoch) return _sigCache;
    const out = [];
    for (const entry of tileCache.values()) {
      if (!entry.trafficSignalAxes) continue;
      for (const s of entry.trafficSignalAxes) out.push(s);
    }
    _sigCache = out; _sigCacheEpoch = _tileEpoch;
    return out;
  }

  /**
   * Every shop in the resident tiles, as {point:[mercX,mercY], name, cat}.
   *
   * ⚠ `point` is real-metre WORLD, NOT Mercator — origin-subtracted and unstretched by the bake's
   * `mercatorToWorld`. Road points are stored in the tile as absolute Mercator and normalised to
   * world by `readRoads` (which is passed ox/oy); `readShops` is NOT passed ox/oy because its data
   * is already world. So the two spaces coexist IN THE FILE and agree by the time they reach here.
   * The consumer converts world → physics: `px = -(worldX - originX)`, `pz = worldZ - originZ`.
   *
   * Getting that wrong is silent. `backend/tools/shopSnapAudit.mjs` was first written comparing raw
   * shop positions against raw road points and reported 0% of shops within snapping distance, with
   * a median gap of 5,069,611 m — the Mercator northing itself. Same trap N-25 records for trees.
   * Corrected, it reports 95.7% of 14,541 shops within 12 m of a pavement, p50 2.2 m.
   *
   * This exists because P-6 was on the board as blocked on "shops are not baked at all", quoting the
   * v3 census line about 14,542 shops being parsed and discarded. The census describes what the
   * RENDERER dropped; the bake has carried `shops` + `shopPositions` + `shopCategories` since v10
   * and `readShops` has decoded them all along. The only thing missing was an accessor.
   *
   * Shares `_segCache`'s epoch discipline: the shop set changes only when the resident tile set does.
   */
  let _shopCache = null, _shopCacheEpoch = -1;
  function getLoadedShops() {
    if (_shopCache !== null && _shopCacheEpoch === _tileEpoch) return _shopCache;
    const out = [];
    for (const entry of tileCache.values()) {
      if (!entry.shops) continue;
      for (const shop of entry.shops) if (shop?.point) out.push(shop);
    }
    _shopCache = out; _shopCacheEpoch = _tileEpoch;
    return out;
  }

  function getLoadedRoadSegments() {
    if (_segCache !== null && _segCacheEpoch === _tileEpoch) return _segCache;
    const segments = [];
    for (const entry of tileCache.values()) {
      if (!entry.roads) continue;
      for (const road of entry.roads) {
        segments.push({
          name: road.name || '',
          points: road.points,
          id: road.id,
          highwayType: road.highwayType || '',
          width: road.width || 0,
          oneway: road.oneway || false,
          // ⚠ STRUCTURAL FLAGS ARE PART OF THE CONTRACT, not extras.
          //
          // This projection is a NEW object per road, so anything not copied here simply does not
          // exist for the entity systems — silently, as `undefined`. parkedCars.js gates street
          // parking on exactly these four ("no parking against a guard rail", R-V1) and that gate
          // had been dead since the day it was written: every term read undefined and the whole
          // condition was always false. Add a field here whenever a consumer needs one; do not
          // read a road property in an entity system without checking that it survives this copy.
          bridge: road.bridge === true,
          isRamp: road.isRamp === true,
          layer: road.layer ?? null,
          crossesTrench: road.crossesTrench === true,
          // P-2: a marked crossing (footway=crossing / cycleway=crossing). The bake has flagged these
          // since bake-surface-clipping Phase 1 and the parser has read them since v8 — but this
          // projection is a WHITELIST, so for that entire time the flag did not exist downstream,
          // silently, as `undefined`. 11,325 of them in the baked tiles (backend/tools/crossingCount.mjs),
          // median 14.5 m — a road's width, which is what a crossing is.
          crossing: road.crossing === true,
          // R-W1 width section. I added the four flags above with a comment warning that this
          // projection is a whitelist, then shipped a width model whose fields it does not copy —
          // so parked cars and pedestrians silently fell back to the class table and lost every
          // per-road OSM nuance (a `parking:left=no` kerb, a width-capped Gràcia street). Writing
          // the warning is not the same as reading it. SEVENTH copy site in this pipeline.
          carriagewayW:  road.carriagewayW,
          parkingLeftW:  road.parkingLeftW,
          parkingRightW: road.parkingRightW,
          shoulderW:     road.shoulderW,
          kerbToKerbW:   road.kerbToKerbW,
          sidewalkW:     road.sidewalkW,
          corridorW:     road.corridorW,
        });
      }
    }
    _segCache = segments;
    _segCacheEpoch = _tileEpoch;
    return segments;
  }

  /** Min/max terrain Y across loaded tiles (normalized; for elevation debug logging). */
  function getTerrainElevationRange() {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const entry of tileCache.values()) {
      if (!entry.terrainMesh?.geometry) continue;
      entry.terrainMesh.geometry.computeBoundingBox();
      const box = entry.terrainMesh.geometry.boundingBox;
      if (box) {
        minY = Math.min(minY, box.min.y);
        maxY = Math.max(maxY, box.max.y);
      }
    }
    if (minY === Infinity) return null;
    return { min: minY, max: maxY };
  }

  const vertExag = () =>
    CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION)
      ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION
      : 1;

  /** The spawn-normalized ground floor (Y where raw DEM == spawn elevation shifted to 0 → sea-level ≈ -offset).
   *  Used as a last-resort so an unknown-terrain sample never snaps an object to absolute Y=0 (which floats it
   *  ~offset metres above the real ground everywhere terrain is below spawn — the port/hill float bug). */
  function normalizedGroundFloor() {
    return -((getWorldElevationOffset() ?? 0) * vertExag());
  }

  /**
   * Terrain height at world (wx, wz) in same coordinate space as terrain mesh (normalized * vertExag).
   * Falls back to the nearest loaded neighbour tile that has terrain, so a partial/road-only tile under
   * the query point doesn't force the caller onto the absolute-0 fallback (which floats it).
   * @returns {number | null}
   */
  function getTerrainHeightAt(wx, wz) {
    const { x: tx, y: ty } = worldToSlippyTile(wx, wz);
    const { lat, lon } = worldToLatLon(wx, wz);
    let entry = tileCache.get(tileKey(tx, ty));
    if (!entry?.getElevationAt) {
      // exact tile has no terrain sampler — borrow the nearest neighbour that does (terrain is continuous)
      for (let r = 1; r <= 2 && !entry?.getElevationAt; r++) {
        for (let dx = -r; dx <= r && !entry?.getElevationAt; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            const e = tileCache.get(tileKey(tx + dx, ty + dy));
            if (e?.getElevationAt) { entry = e; break; }
          }
        }
      }
    }
    if (!entry?.getElevationAt) return null;
    const norm = entry.getElevationAt(lat, lon);
    return norm * vertExag();
  }

  /** Squared distance from (px, pz) to segment (ax,az)-(bx,bz); t = param along segment [0,1]. */
  function pointToSegmentSqAndT(px, pz, ax, az, bx, bz) {
    const dx = bx - ax;
    const dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    if (lenSq === 0) {
      const dSq = (px - ax) ** 2 + (pz - az) ** 2;
      return { dSq, t: 0 };
    }
    let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx;
    const qz = az + t * dz;
    const dSq = (px - qx) ** 2 + (pz - qz) ** 2;
    return { dSq, t };
  }

  /** Max distance (m) from segment center to consider "on road" for height sampling. */
  const ROAD_HEIGHT_MAX_DISTANCE_M = 10;

  /**
   * Road height at world (wx, wz) if within ROAD_HEIGHT_MAX_DISTANCE_M of a segment.
   * Uses same coordinate space as mesh: (baked elevation - worldElevationOffset) * vertExag (normalized once).
   * @returns {{ height: number, onRoad: true, tunnel: boolean, bridge: boolean, hA: number, hB: number } | null}
   */
  function getRoadHeightAt(wx, wz) {
    const scale = vertExag();
    const maxSq = ROAD_HEIGHT_MAX_DISTANCE_M * ROAD_HEIGHT_MAX_DISTANCE_M;
    let best = null;
    let bestSq = maxSq;
    for (const entry of tileCache.values()) {
      if (!entry.roads) continue;
      const offset = getWorldElevationOffset() ?? 0; // D-12: single spawn-anchored baseline; tileMinElevation gate removed
      for (const road of entry.roads) {
        const pts = road.points || [];
        if (pts.length < 2) continue;
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          const ax = a.x;
          const az = a.y;
          const bx = b.x;
          const bz = b.y;
          const { dSq, t } = pointToSegmentSqAndT(wx, wz, ax, az, bx, bz);
          if (dSq >= bestSq) continue;
          // worldElevationOffset subtracted ONLY ONCE: when baked is raw, (elevation - offset) * scale; when baked is already normalized, elevation * scale only.
          const rawA = a.elevation != null && Number.isFinite(a.elevation) ? a.elevation : null;
          const rawB = b.elevation != null && Number.isFinite(b.elevation) ? b.elevation : null;
          const hA =
            rawA != null
              ? (CONFIG.BAKED_ROAD_ELEVATION_IS_RAW ? (rawA - offset) * scale : rawA * scale)
              : getTerrainHeightAt(ax, az) ?? 0;
          const hB =
            rawB != null
              ? (CONFIG.BAKED_ROAD_ELEVATION_IS_RAW ? (rawB - offset) * scale : rawB * scale)
              : getTerrainHeightAt(bx, bz) ?? 0;
          const height = (1 - t) * hA + t * hB;
          bestSq = dSq;
          best = {
            height,
            onRoad: true,
            tunnel: !!road.tunnel,
            bridge: !!road.bridge,
            hA,
            hB,
            rawA: rawA ?? undefined,
            rawB: rawB ?? undefined,
          };
        }
      }
    }
    return best;
  }

  /**
   * Surface height at (wx, wz). Same coordinate space as terrain mesh and heightfield physics.
   * Roads are visual-only; no road physics. Spawn uses this terrain-based surfaceY.
   * When there is no terrain data at (wx, wz), physics ground is the flat plane at Y=0 — return 0
   * so we never use raw road elevation (which would place an object in the air).
   * @returns {{ surfaceY: number, onRoad: boolean }}
   */
  function getSurfaceHeightAt(wx, wz) {
    const terrainY = getTerrainHeightAt(wx, wz);
    const roadResult = getRoadHeightAt(wx, wz);
    // No terrain data → fall back to the spawn-normalized ground floor, NOT absolute Y=0 (which floats the
    // object ~offset metres up wherever real terrain is below spawn — the port/hill float bug). Never use
    // raw road elevation here (may be raw metres).
    if (terrainY == null) {
      return { surfaceY: normalizedGroundFloor(), onRoad: roadResult != null };
    }
    const terrainVal = terrainY;
    if (roadResult) {
      if (roadResult.tunnel) {
        return { surfaceY: roadResult.height, onRoad: true };
      }
      // Non-tunnel road: never below terrain (aligns visually, no sinking, slopes still work)
      return { surfaceY: Math.max(roadResult.height, terrainVal), onRoad: true };
    }
    return { surfaceY: terrainVal, onRoad: false };
  }

  /** Current tile terrain min/max Y for (wx, wz), or null. */
  function getCurrentTileTerrainRange(wx, wz) {
    const { x: tx, y: ty } = worldToSlippyTile(wx, wz);
    const entry = tileCache.get(tileKey(tx, ty));
    if (!entry || entry.terrainMinY == null || entry.terrainMaxY == null) return null;
    return { min: entry.terrainMinY, max: entry.terrainMaxY };
  }

  function getHeightfieldBodyCount() {
    return tileManagerState.numHeightfieldBodies;
  }

  /** Return heightfield body for a tile key (e.g. for spawn debug). */
  function getHeightfieldBodyForTileKey(key) {
    const entry = tileCache.get(key);
    return entry?.heightfieldBody ?? null;
  }

  function getBridgeBodyCount() {
    let n = 0;
    for (const entry of tileCache.values()) n += (entry.bridgeBodies || []).length;
    return n;
  }

  /**
   * Get all lamp-head world positions from loaded tiles (for dynamic PointLight placement).
   * @returns {{ x: number, y: number, z: number }[]}
   */
  /**
   * Per-tile [x, groundY, z] triples for every resident tile's trees (P-L2).
   * Returned as the raw array-of-arrays so the caller can scan without a concat allocation.
   */
  function getTreeProxyArrays() {
    const out = [];
    for (const entry of tileCache.values()) {
      if (entry.treeProxyData?.length) out.push(entry.treeProxyData);
    }
    return out;
  }

  function getStreetlightPositions() {
    const out = [];
    for (const entry of tileCache.values()) {
      if (entry.streetlightPositions?.length) out.push(...entry.streetlightPositions);
    }
    return out;
  }

  /**
   * Monotonic counter bumped whenever the resident tile set changes. Consumers that derive state
   * from ALL loaded tiles (the light grid's lamp list) poll this instead of rebuilding every frame
   * or rebuilding only on camera movement — a tile loading in while the car sits still must still
   * light its lamps.
   */
  function getTileEpoch() { return _tileEpoch; }

  function getTunnelBodyCount() {
    let n = 0;
    for (const entry of tileCache.values()) n += (entry.tunnelBodies || []).length;
    return n;
  }

  // True once the initial spawn-area tiles have finished loading (nothing in-flight or queued after
  // loading has begun). Used to hold the loading screen until the world around the car is actually built.
  /**
   * True once the first ring of tiles has finished streaming.
   *
   * ⚠ IT REQUIRES THE QUEUE TO BE COMPLETELY EMPTY, which is stricter than "the world is ready" and
   * is why `getInitialLoadState()` exists next to it. main.js polls this every 150 ms and gives up
   * after 130 polls — a 19.5 s cap — and three drives on 2026-08-27 measured time-to-drive at 19.4,
   * 20.0 and 21.3 s against a 6.94 s figure recorded in the ledger after P4-01. Numbers that land on
   * a timeout are usually the timeout, so the poll now reports WHICH it was.
   */
  function isInitialLoadComplete() {
    if (inFlightCount > 0 || pendingQueue.length > 0) { _startedLoading = true; return false; }
    return _startedLoading && tileCache.size > 0;
  }

  /** What the load is waiting on, so a caller that gives up can say what it gave up on. */
  function getInitialLoadState() {
    // `disposals` is the one that matters to a shader compile. three's compileAsync polls
    // `properties.get(material).currentProgram` on a timer, and a DISPOSED material returns an
    // empty properties object — so the poll throws `Cannot read properties of undefined (reading
    // 'isReady')` from inside a setTimeout, where no `.catch()` can reach it, and the promise never
    // settles. Tile unload is what disposes materials, so a caller can avoid the whole race by not
    // starting a compile while this is non-zero.
    return { inFlight: inFlightCount, pending: pendingQueue.length, disposals: _pendingDisposals.length,
             resident: tileCache.size, started: _startedLoading,
             // null when the last update() ran to completion; a reason string when it bailed early.
             lastUpdateSkip: _lastUpdateSkip, updates: _updateCalls };
  }

  return {
    update,
    isInitialLoadComplete,
    getInitialLoadState,
    takeBuildOverruns,
    getBuildPhaseTotals,
    resetBuildPhaseTotals,
    getLoadedTrafficSignals,
    getLoadedRoadSegments,
    getLoadedShops,
    injectSpawnTile,
    setPhotoMode,
    setPhotoRadius,
    getPhotoRadius,
    getDebugMetrics,
    getTerrainElevationRange,
    getHeightfieldBodyCount,
    getHeightfieldBodyForTileKey,
    getBridgeBodyCount,
    getTunnelBodyCount,
    getTileEpoch,
    getTerrainHeightAt,
    getRoadHeightAt,
    getSurfaceHeightAt,
    normalizedGroundFloor,
    getCurrentTileTerrainRange,
    getStreetlightPositions,
    getTreeProxyArrays,
    /** DEBUG ONLY — resident tile entries, for measurement probes (?debug=roadfit). Never used by the game. */
    __debugTileEntries: () => [...tileCache.values()],
  };
}
