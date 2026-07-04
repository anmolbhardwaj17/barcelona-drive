/**
 * Tile-based streaming: keep 3x3 tiles around viewer, unload tiles > 2 away.
 * All feature toggles from CONFIG; no geometry generated when disabled.
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { worldToSlippyTile, tileCenterToWorld, worldToLatLon, latLonToWorld, TILE_ZOOM, getTileBboxLatLon } from '../projection.js';
import { loadTile } from './mapLoader.js';
import { getWorldElevationOffset, whenElevationOffsetReady, assertElevationOffsetResolved } from '../elevationOffset.js';
import { getOriginOffset } from '../originOffset.js';
import { CONFIG } from '../config.js';
import { COLLISION_GROUP_GROUND, COLLISION_GROUP_VEHICLE, COLLISION_GROUP_WORLD, COLLISION_GROUP_TERRAIN, assertTerrainVehicleHandshake } from '../collisionGroups.js';
import { toNormalizedRoadY } from '../roadElevation.js';
import { getCarContactMaterials } from '../car/carPhysics.js';
import { renderTrafficLights } from './trafficLightRenderer.js';
import { getJunctionPoints, buildBridgeGuardRailColliders, buildGoreMeshes, buildChamferFills, buildChamferSidewalks, buildChamferCurbs } from './roadRenderer.js';
// import { buildDividers } from './dividerRenderer.js'; // disabled
import { buildStreetlights } from './streetlightRenderer.js';
import { buildShoulderMesh } from './shoulderRenderer.js';
import { buildTerrainMesh, buildTerrainHeightfield, getHeightfieldWorldAABB, darkenTerrainAroundTrees } from './terrainRenderer.js';
import { renderWater } from './waterRenderer.js';
import { createRailwayMeshes, createTramMeshes } from './railwayRenderer.js';
import { createGreensMeshes } from './greensRenderer.js';
import { buildBarrierMeshes, buildBarrierColliders } from './barrierRenderer.js';
import { buildBusStopMeshes } from './busStopRenderer.js';
import { buildParkingMeshes } from './parkingRenderer.js';
import { buildShopSignMesh } from './shopSignRenderer.js';
import { buildAwningMesh } from './awningRenderer.js';
import { buildCafeTerrace } from './cafeTerraceRenderer.js';
import { buildShopfrontMeshes } from './shopfrontRenderer.js';
import { buildDecalMeshes, disposeDecalMeshes } from './decalRenderer.js';
import { renderProps } from './propRenderer.js';
import { renderEnvironmentClusters } from './environmentClusterRenderer.js';
import { renderZoneVegetation } from './zoneVegetationRenderer.js';
import { buildCrashBarriers, buildCrashBarrierColliders } from './crashBarrierRenderer.js';
import { buildReflectors } from './reflectorRenderer.js';
import { buildRoadInfrastructure } from './roadInfraRenderer.js';
import { buildUrbanFeatureMeshes, getUrbanFeatureExclusionZones } from './urbanFeatureRenderer.js';
import { buildVendorCartMeshes, getVendorCartExclusionZones } from './vendorCartRenderer.js';
import { buildTunnelMeshes, buildTunnelFloor, buildApproachCanopy, buildRetainingWalls, buildTrenchRetainingWalls, buildTrenchCliffWalls, buildTrenchPortals, buildPedestrianPortals, buildPortalApproaches } from './tunnelRenderer.js';
import { registerTunnelZones, unregisterTunnelZones } from '../tunnelZones.js';
import { buildVegetationMask } from './vegetationMask.js';
import { renderGrass, getFallbackGrassGeometry, getProceduralGrassMaterial } from './grassRenderer.js';
import { renderLODBuildings } from './buildingRenderer.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createFastElevation } from './fastElevation.js';
import { initWorkerPool, processBuildings as workerProcessBuildings, processVegetation as workerProcessVegetation, processGrass as workerProcessGrass, cancelTile } from '../workers/workerPool.js';
import { materializeBuildingMeshes, materializeVegetationMeshes, materializeGrassMeshes } from '../workers/meshMaterializer.js';

let _loggedHfPlacement = false; // one-time terrain-heightfield placement log (G-49 debugging)
const GRID_RADIUS = 1; // 3x3 tiles around viewer (9 tiles)
const LOOKAHEAD_RADIUS = 2; // extend 1 extra tile in driving direction for seamless look-ahead
const UNLOAD_DISTANCE = 3; // keep tiles cached beyond grid to avoid reload churn
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

/** Safe scene.add that skips meshes with NaN positions to prevent render errors. */
function safeSceneAdd(scene, mesh) {
  if (!mesh) return false;
  if (mesh.isGroup) { scene.add(mesh); return true; }
  if (meshHasNaN(mesh)) {
    mesh.geometry.dispose();
    return false;
  }
  scene.add(mesh);
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
      merged = mergeGeometries(bucket.geos, false);
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
function addPerimeterWalls(body, pts, groundY, h) {
  const YAX = new CANNON.Vec3(0, 1, 0);
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
    const box = new CANNON.Box(new CANNON.Vec3(len / 2, h / 2, half));
    const quat = new CANNON.Quaternion();
    quat.setFromAxisAngle(YAX, -theta);            // box local X → along this edge
    body.addShape(box, new CANNON.Vec3(mx + nx * half, groundY + h / 2, mz + nz * half), quat);
  }
}

function buildBuildingColliders(buildings, physicsOrigin, getElevationAt, vertExag) {
  const bodies = [];
  if (!buildings || buildings.length === 0) return bodies;
  const BATCH = 40;
  for (let start = 0; start < buildings.length; start += BATCH) {
    const end = Math.min(start + BATCH, buildings.length);
    const body = new CANNON.Body({ mass: 0 });
    let any = false;
    for (let bi = start; bi < end; bi++) {
      const b = buildings[bi];
      const fp = b.footprint;
      if (!fp || fp.length < 3) continue;
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
      const clean = [];
      for (const p of pfp) {
        const last = clean[clean.length - 1];
        if (!last || Math.abs(last.x - p.x) > 1e-3 || Math.abs(last.z - p.z) > 1e-3) clean.push(p);
      }
      if (clean.length > 1) {
        const f0 = clean[0], fl = clean[clean.length - 1];
        if (Math.abs(f0.x - fl.x) < 1e-3 && Math.abs(f0.z - fl.z) < 1e-3) clean.pop();
      }
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
        // Triangle / quad (rectangles) → cheap tight oriented box.
        const box = new CANNON.Box(new CANNON.Vec3(hu, h / 2, hv));
        const quat = new CANNON.Quaternion();
        quat.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), -phi); // box local X → footprint's dominant edge
        body.addShape(box, new CANNON.Vec3(px, groundY + h / 2, pz), quat);
      }
      any = true;
    }
    if (any) {
      body.collisionFilterGroup = COLLISION_GROUP_WORLD;
      body.collisionFilterMask  = COLLISION_GROUP_VEHICLE;
      bodies.push(body);
    }
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

/** @type {Map<string, { roads: object[], buildings: object[], roadMeshes?: THREE.Mesh[], buildingMeshes?: THREE.Mesh[], spatialIndex?: object }>} */
const tileCache = new Map();
/** Tile keys currently being loaded – avoid starting duplicate requests */
const loadingKeys = new Set();
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

      // Clip box width if it would overlap another road's corridor at merge zones
      let effectiveHalfW = halfW;
      const { dist, otherHalfW } = distToNearestOtherRoad(midX, midZ, road.id);
      if (dist < halfW + otherHalfW) {
        // Reduce our halfW so our edge stops at the other road's edge
        effectiveHalfW = Math.max(1.5, dist - otherHalfW);
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

      // Wall height: from road elevation to ceiling (Y ≈ 0)
      const wallH = Math.max(Math.abs(eA), Math.abs(eB));
      if (wallH < 0.5) continue;
      const halfH = wallH / 2;

      // Yaw to face along the segment
      const yaw = Math.atan2(dx, dz);
      const qYaw = new CANNON.Quaternion();
      qYaw.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);

      const midYA = eA / 2; // midpoint between ceiling (0) and floor (eA)
      const midYB = eB / 2;
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

/**
 * Create a CANNON.Trimesh collider from the full terrain elevation grid.
 * Matches the visual terrain mesh exactly — flat ground at Y=0, carved ramp
 * slopes, everything. Replaces the infinite ground plane so physics follows
 * the actual terrain shape.
 */
function createTerrainTrimesh(elevation, world, roadMaterial, tunnelRoads, bakedPhysicsTerrain, bakedTerrain) {
  if (!elevation?.elevations?.length || !world) return null;

  const { south, west, north, east, gridRows, gridCols, elevations } = elevation;
  if (!gridRows || !gridCols) return null;

  const physicsOrigin = getOriginOffset();
  const vertExag = CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION) ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;
  const offset = getWorldElevationOffset() ?? 0; // D-12: single spawn-anchored baseline; tileMinElevation gate removed

  let verts, indices;

  // ── Source the physics surface. PREFER the VISUAL baked terrain (bakedTerrain.positions) over the
  //    separate 32-grid bakedPhysicsTerrain: the visual mesh is 128-grid and the physics bake was 32-grid,
  //    so on steep terrain (Montjuïc) the two sampled DIFFERENT source cells and the collider sat several
  //    metres off the surface the player sees → wheels (short ~1m ray) missed it → off-road fall-through.
  //    The visual baked positions are world-space raw DEM with the SAME transform the visual mesh renders
  //    with (scale.y=vertExag, position.y=−offset·vertExag) → pY = (wy−offset)·vertExag, so the collider is
  //    byte-identical to the drawn surface. (Trades the physics-only tunnel-mouth margin for exact match;
  //    spawn is tunnel-free and tunnels are Stage 3.) See gotchas G-49. Falls back to physics bake / runtime.
  const visualBaked = (bakedTerrain && bakedTerrain.positions && bakedTerrain.indices
    && bakedTerrain.positions.length > 0 && bakedTerrain.indices.length > 0) ? bakedTerrain : null;
  const srcBaked = visualBaked
    ? { verts: bakedTerrain.positions, indices: bakedTerrain.indices }
    : ((bakedPhysicsTerrain && bakedPhysicsTerrain.verts && bakedPhysicsTerrain.indices
        && bakedPhysicsTerrain.verts.length > 0 && bakedPhysicsTerrain.indices.length > 0) ? bakedPhysicsTerrain : null);

  if (srcBaked) {
    // Baked verts are in world space — convert to physics space here (negate X, normalize Y to spawn frame)
    const srcVerts = srcBaked.verts;
    const vertCount = srcVerts.length / 3;
    verts = new Array(srcVerts.length);
    for (let i = 0; i < vertCount; i++) {
      const wx = srcVerts[i * 3];
      const wy = srcVerts[i * 3 + 1];
      const wz = srcVerts[i * 3 + 2];
      // Physics coords: negate X, apply elevation offset (matches the visual mesh's rendered Y)
      verts[i * 3]     = -(wx - physicsOrigin.x);
      verts[i * 3 + 1] = (wy - offset) * vertExag;
      verts[i * 3 + 2] = wz - physicsOrigin.z;
    }
    indices = Array.from(srcBaked.indices);
  } else {
  // ── Fallback: compute at runtime ──────────────────────────────────────
  // Downsample for physics — car doesn't need 128×128 visual resolution.
  // 32×32 is smooth enough for wheel raycasts and 16× faster to build.
  const PHYSICS_GRID = 32;
  const rows = Math.min(gridRows, PHYSICS_GRID);
  const cols = Math.min(gridCols, PHYSICS_GRID);

  // Build vertex grid in physics space (negated X), keep world-space XZ for hole masking
  verts = [];  // flat array [x,y,z, x,y,z, ...]
  const worldXZ = []; // per-vertex [wx, wz] for tunnel hole test
  for (let r = 0; r < rows; r++) {
    const lat = south + (north - south) * (rows <= 1 ? 0.5 : r / (rows - 1));
    // Map downsampled r,c back to source grid indices
    const srcR = Math.min(gridRows - 1, Math.round(r / (rows - 1) * (gridRows - 1)));
    for (let c = 0; c < cols; c++) {
      const lon = west + (east - west) * (cols <= 1 ? 0.5 : c / (cols - 1));
      const { x: wx, z: wz } = latLonToWorld(lat, lon);
      const srcC = Math.min(gridCols - 1, Math.round(c / (cols - 1) * (gridCols - 1)));
      const idx = srcR * gridCols + srcC;
      let y = elevations[idx] != null && Number.isFinite(elevations[idx]) ? elevations[idx] : 0;
      y = (y - offset) * vertExag;

      // Physics coords: negate X
      const px = -(wx - physicsOrigin.x);
      const pz = wz - physicsOrigin.z;
      verts.push(px, y, pz);
      worldXZ.push(wx, wz);
    }
  }

  // Punch terrain holes ONLY at tunnel mouth openings (first/last point of each tunnel road).
  const MOUTH_RADIUS = 1;
  const tunnelMouths = [];
  if (tunnelRoads && tunnelRoads.length > 0) {
    for (const road of tunnelRoads) {
      const pts = road.points;
      if (!pts || pts.length < 2) continue;
      const hw = (road.width || 4) / 2 + 1;
      tunnelMouths.push({ x: pts[0].x, z: pts[0].y, r: hw + MOUTH_RADIUS });
      tunnelMouths.push({ x: pts[pts.length - 1].x, z: pts[pts.length - 1].y, r: hw + MOUTH_RADIUS });
    }
  }

  function inTunnelZone(wx, wz) {
    for (const m of tunnelMouths) {
      if (Math.hypot(wx - m.x, wz - m.z) < m.r) return true;
    }
    return false;
  }

  // Build indices — skip triangles whose center falls in a tunnel corridor
  // Winding order is REVERSED vs visual mesh because physics X is negated,
  // which flips handedness. Without reversal, face normals point downward
  // and RaycastVehicle wheel rays (skipBackfaces:true) pass right through.
  indices = [];
  const hasTunnels = tunnelMouths.length > 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const c1 = (r + 1) * cols + c;
      const d = c1 + 1;

      if (hasTunnels) {
        // Triangle 1 (a, b, c1) — test centroid in world space
        const cx1 = (worldXZ[a * 2] + worldXZ[b * 2] + worldXZ[c1 * 2]) / 3;
        const cz1 = (worldXZ[a * 2 + 1] + worldXZ[b * 2 + 1] + worldXZ[c1 * 2 + 1]) / 3;
        if (!inTunnelZone(cx1, cz1)) indices.push(a, b, c1);

        // Triangle 2 (b, d, c1) — test centroid in world space
        const cx2 = (worldXZ[b * 2] + worldXZ[d * 2] + worldXZ[c1 * 2]) / 3;
        const cz2 = (worldXZ[b * 2 + 1] + worldXZ[d * 2 + 1] + worldXZ[c1 * 2 + 1]) / 3;
        if (!inTunnelZone(cx2, cz2)) indices.push(b, d, c1);
      } else {
        indices.push(a, b, c1);
        indices.push(b, d, c1);
      }
    }
  }
  } // end fallback

  if (indices.length === 0) return null;

  const trimesh = new CANNON.Trimesh(verts, indices);
  const body = new CANNON.Body({ mass: 0 });
  body.addShape(trimesh);
  if (roadMaterial) body.material = roadMaterial;
  // Own group (TERRAIN) so the chassis can collide with terrain as a body-collision backstop against
  // fast off-road tunnel-through of the thin wheel ray, WITHOUT clipping on road-deck box edges (GROUND). G-49.
  body.collisionFilterGroup = COLLISION_GROUP_TERRAIN;
  body.collisionFilterMask  = COLLISION_GROUP_VEHICLE;
  body.position.set(0, 0, 0);
  world.addBody(body);
  assertTerrainVehicleHandshake(world); // G-51: terrain asks for VEHICLE → chassis must ask for TERRAIN

  return body;
}

/**
 * Create tile manager. Requires roadRenderer, buildingRenderer, and renderVegetation.
 * Optional: renderBushes, renderTrafficLights.
 * @param {THREE.Group} scene - worldGroup to add meshes to
 * @param {(roads: object[]) => THREE.Mesh[]} createRoadMeshes
 * @param {(buildings: object[]) => THREE.Mesh[]} createBuildingMeshes
 * @param {(roads: object[]) => object} createSpatialIndex
 * @param {(tileData: object, tileKey?: string) => { treeMeshes: THREE.InstancedMesh[], greenAreaMeshes: THREE.Mesh[] }} renderVegetation
 * @param {THREE.Camera} [camera]
 * @param {CANNON.World} [world] - physics world; required for terrain heightfield colliders
 * @param {CANNON.Body} [groundBody] - flat plane body; removed when first heightfield is added, re-added when last is removed
 */
export function createTileManager(scene, createRoadMeshes, createBuildingMeshes, createSpatialIndex, renderVegetation, camera = null, world = null, groundBody = null) {
  const tileManagerState = { numHeightfieldBodies: 0 };
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
  const FRAME_BUDGET_MS = 4;      // baseline ms of tile build work per frame when the frame rate is healthy
  const BUDGET_MIN = 1.2, BUDGET_MAX = 5;
  let _budgetMs = FRAME_BUDGET_MS; // ADAPTIVE: shrinks when frames run long (heavy streaming at speed),
                                   //           grows back when they're smooth — so build never compounds a slow frame
  let _lastUpdateAt = 0;
  const _wantedSet = new Set();   // reused every frame in update() to avoid per-frame Set allocation
  let _frameBudgetStart = performance.now();

  const yieldToMain = () => {
    const elapsed = performance.now() - _frameBudgetStart;
    if (elapsed < _budgetMs) {
      // Budget not exhausted this frame — continue working without yielding
      return Promise.resolve();
    }
    // Budget exceeded — yield to the browser for rendering. Do NOT reset _frameBudgetStart here;
    // update() owns the per-frame reset so concurrent tiles keep sharing one budget.
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
      else setTimeout(() => resolve(), 0);
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
      propMesh: null,
      clusterMeshes: [],
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
      decalMeshes: [],
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
    let pedestrianPortalRoads = [];

    if (CONFIG.ENABLE_TUNNELS) {
      // Full enclosure: drivable-scale tunnels only (whitelist)
      tunnelRoads = (roads || []).filter(r =>
        r.tunnel && r.layer != null && r.layer < 0 &&
        DRIVABLE_TUNNEL_TYPES.has(r.highwayType)
      );
      // Portal frame only: everything else underground (service, path, footway, etc.)
      pedestrianPortalRoads = (roads || []).filter(r =>
        r.tunnel && r.layer != null && r.layer < 0 &&
        !DRIVABLE_TUNNEL_TYPES.has(r.highwayType)
      );
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
        const hf = buildTerrainHeightfield(elevation, key);
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

      const terrain = await buildTerrainMesh(elevation, key, [...tunnelRoads, ...carveApproachRoads], roads, waterPolys, _perfYield, data.bakedTerrain);
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
    // Pedestrian portal frames
    let pedestrianPortalMesh = null;
    if (CONFIG.ENABLE_TUNNELS && pedestrianPortalRoads.length > 0) {
      pedestrianPortalMesh = buildPedestrianPortals(pedestrianPortalRoads, getGroundY);
      if (pedestrianPortalMesh) safeSceneAdd(scene, pedestrianPortalMesh);
    }
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
    if (data.bakedRoads) options.bakedRoads = data.bakedRoads;
    const tileData = { roads, buildings, railways: railways || [], vegetation: vegetation || { trees: [], greenAreas: [] }, water: water || [], greens: greens || [], barriers: data.barriers || [], urbanFeatures: data.urbanFeatures || [] };
    if (data.bakedVegetation) tileData.bakedVegetation = data.bakedVegetation;

    _perfMark('tunnels+setup');
    await _perfYield();

    // Roads — async with frame yields to prevent jank
    const roadMeshesRaw = await createRoadMeshes(roads, options, _perfYield);
    const pillarPositions = roadMeshesRaw._pillarPositions || [];

    const roadMeshes = await mergeMeshesByMaterial(roadMeshesRaw, _perfYield);
    roadMeshes._pillarPositions = pillarPositions;
    roadMeshes.forEach((m) => { m.visible = true; safeSceneAdd(scene, m); });

    // Track crosswalk mesh separately for 80m LOD culling (Phase 1 Barcelona road overhaul).
    // The crosswalk mesh is already in scene via the forEach above; we just keep a reference.
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
      await _perfYield();

      const result = createRoadTrimeshColliders(roads, { offset, vertExag, world, roadMaterial, tileKey: key, getGroundYAt });
      bridgeBodies = result.bridgeBodies;
      tunnelBodies = result.tunnelBodies;
      trimeshBody = result.trimeshBody;

      _perfMark('road-physics');
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

    // Green areas — lightweight flat meshes, build in Phase 1 so they appear with terrain
    const greenMeshesP1 = !skipNonRoad && tileData.greens?.length ? createGreensMeshes(tileData.greens, getElevationAt) : [];
    greenMeshesP1.forEach((m) => safeSceneAdd(scene, m));
    _perfMark('greens');

    // Populate entry with Phase 1 results and store in cache immediately
    entry.greenMeshes = greenMeshesP1;
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
    tileCache.set(key, entry);
    // Invalidate LOD cache so new tile gets correct visibility on next frame
    _lastLodX = -Infinity;

    // Helper: abort if tile was unloaded between phases (user drove away)
    const aborted = () => tileCache.get(key) !== entry;

    await yieldToMain();
    if (aborted()) return entry;

    // -----------------------------------------------------------------------
    // PHASE 2: Buildings + Railways (next frame)
    // -----------------------------------------------------------------------

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

    const railwayMeshes = await mergeMeshesByMaterial(skipNonRoad ? [] : createRailwayMeshes(railways, options), yieldToMain);
    railwayMeshes.forEach((m) => safeSceneAdd(scene, m));
    entry.railwayMeshes = railwayMeshes;

    // Phase 4A: tram rails — separate from heavy rail, always rendered when present
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
          { buildings: filteredTileData.buildings, roads: filteredTileData.roads },
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
          // Materialize main trees + zone trees
          const mainVeg = await materializeVegetationMeshes(vegWorkerResult, yieldToMain);
          vegTreePositions = mainVeg.treePositions || [];
          vegTreePositionsFlat = vegWorkerResult.treePositions; // keep flat version for grass

          const vegMeshBatch = [];
          (mainVeg.treeMeshes || []).forEach((m) => { vegMeshBatch.push(m); vegetationMeshes.push(m); });
          (mainVeg.treeBillboardMeshes || []).forEach((m) => { vegMeshBatch.push(m); vegetationMeshes.push(m); });
          if (mainVeg.shadowMesh) { vegMeshBatch.push(mainVeg.shadowMesh); vegetationMeshes.push(mainVeg.shadowMesh); }
          if (mainVeg.bushMesh) { vegMeshBatch.push(mainVeg.bushMesh); vegetationMeshes.push(mainVeg.bushMesh); }

          // Zone vegetation (included in same worker result)
          if (vegWorkerResult.zoneTreeVariants) {
            const zoneResult = await materializeVegetationMeshes({
              treeVariants: vegWorkerResult.zoneTreeVariants,
              shadowInstances: vegWorkerResult.zoneShadowInstances,
              bushInstances: vegWorkerResult.zoneBushInstances,
              treePositions: null,
            }, yieldToMain);
            (zoneResult.treeMeshes || []).forEach((m) => { vegMeshBatch.push(m); vegetationMeshes.push(m); });
            if (zoneResult.shadowMesh) { vegMeshBatch.push(zoneResult.shadowMesh); vegetationMeshes.push(zoneResult.shadowMesh); }
            if (zoneResult.bushMesh) { vegMeshBatch.push(zoneResult.bushMesh); vegetationMeshes.push(zoneResult.bushMesh); }
          }

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

    // Green meshes already built in Phase 1 — add to vegetation list for cleanup tracking
    if (entry.greenMeshes) entry.greenMeshes.forEach((m) => vegetationMeshes.push(m));

    entry.vegetationMeshes = vegetationMeshes;

    await yieldToMain();

    if (aborted()) return entry;
    // -----------------------------------------------------------------------
    // PHASE 4: Grass + Water + Props + Infra + Details (background)
    // -----------------------------------------------------------------------

    // Grass (off main thread) — skipped entirely when disabled (no worker cost either).
    if (!skipNonRoad && (CONFIG.MAX_GRASS_PER_TILE ?? 0) > 0) {
      let vegTileBounds = null;
      if (elevation) {
        vegTileBounds = { south: elevation.south, west: elevation.west, north: elevation.north, east: elevation.east };
      } else {
        vegTileBounds = getTileBboxLatLon(tx0, ty0, TILE_ZOOM);
      }

      try {
        const grassWorkerResult = await workerProcessGrass(
          key,
          tileData,
          elevation,
          elevationOffset,
          CONFIG,
          vegTreePositionsFlat || new Float32Array(0),
          vegTileBounds,
          options.neighborRoads || [],
        );
        if (!aborted() && grassWorkerResult?.grassInstances?.count > 0) {
          const grassMesh = materializeGrassMeshes(grassWorkerResult, getFallbackGrassGeometry(), getProceduralGrassMaterial());
          if (grassMesh) {
            grassMesh.userData.type = 'grass';
            grassMesh.userData.maxInstanceCount = grassMesh.count;
            // geometry + material are module-level singletons (getFallbackGrassGeometry/getProceduralGrassMaterial)
            // — flag them so tile unload doesn't dispose them out from under every other grass tile.
            grassMesh.userData.sharedGeometry = true;
            grassMesh.userData.sharedMaterial = true;
            safeSceneAdd(scene, grassMesh);
            vegetationMeshes.push(grassMesh);
          }
        }
      } catch (err) {
        if (!aborted()) console.warn('[TileManager] Grass worker error:', err.message);
      }
    }

    await yieldToMain();

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

    // Props
    if (!skipNonRoad) {
      entry.propMesh = renderProps(tileData, key, options);
      if (entry.propMesh) safeSceneAdd(scene, entry.propMesh);
    }

    // Environment clusters
    if (!skipNonRoad) {
      entry.clusterMeshes = await mergeMeshesByMaterial(renderEnvironmentClusters(tileData, key, options), yieldToMain);
      entry.clusterMeshes.forEach((m) => safeSceneAdd(scene, m));
    }

    await yieldToMain();

    // Traffic lights
    if (!skipNonRoad && CONFIG.ENABLE_TRAFFIC_LIGHTS) {
      entry.trafficLightMesh = renderTrafficLights(tileData, key);
      if (entry.trafficLightMesh) safeSceneAdd(scene, entry.trafficLightMesh);
    }

    // Shoulders + Dividers + Streetlights
    if (CONFIG.ENABLE_ROAD_SHOULDERS) {
      entry.shoulderMesh = buildShoulderMesh(roads);
      if (entry.shoulderMesh) safeSceneAdd(scene, entry.shoulderMesh);
    }
    // Dividers disabled

    await yieldToMain();
    if (aborted()) return entry;

    if (CONFIG.ENABLE_STREETLIGHTS) {
      const jp = getJunctionPoints(roads, 2);
      const sl = buildStreetlights(roads, jp, options);
      if (sl) {
        entry.streetlightPoleMesh = sl.poleMesh;
        entry.streetlightArmMesh = sl.armMesh;
        entry.streetlightLampMesh = sl.lampMesh;
        entry.streetlightPoolMesh = sl.poolMesh;
        entry.streetlightPoleShadowMesh = sl.poleShadowMesh;
        entry.streetlightPositions = sl.positions;
        entry.streetlightWireMesh = sl.wireMesh || null;
        entry.setBridgeNightMode = sl.setBridgeNightMode || null;
        safeSceneAdd(scene, sl.poleMesh); safeSceneAdd(scene, sl.armMesh); safeSceneAdd(scene, sl.lampMesh);
        safeSceneAdd(scene, sl.poolMesh); safeSceneAdd(scene, sl.poleShadowMesh);
        if (sl.wireMesh) safeSceneAdd(scene, sl.wireMesh);
        if (sl.mirrorDiscMesh) safeSceneAdd(scene, sl.mirrorDiscMesh);
        if (sl.mirrorRimMesh) safeSceneAdd(scene, sl.mirrorRimMesh);
        if (sl.mirrorBackMesh) safeSceneAdd(scene, sl.mirrorBackMesh);
      }
    }

    await yieldToMain();
    if (aborted()) return entry;

    // Barriers
    if (CONFIG.ENABLE_BARRIERS && data.barriers?.length) {
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

    if (CONFIG.ENABLE_CRASH_BARRIERS) {
      entry.crashBarrierMesh = buildCrashBarriers(roads);
      if (entry.crashBarrierMesh) safeSceneAdd(scene, entry.crashBarrierMesh);
      if (world) {
        entry.crashBarrierBody = buildCrashBarrierColliders(roads);
        if (entry.crashBarrierBody) world.addBody(entry.crashBarrierBody);
      }
    }

    if (CONFIG.ENABLE_ROAD_INFRA) {
      entry.reflectorGroup = buildReflectors(roads);
      if (entry.reflectorGroup) safeSceneAdd(scene, entry.reflectorGroup);
    }

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
      const { meshes: infraMeshesRaw } = buildRoadInfrastructure(roads, key, getGroundY);
      entry.roadInfraMeshes = await mergeMeshesByMaterial(infraMeshesRaw, yieldToMain);
      for (const m of entry.roadInfraMeshes) { safeSceneAdd(scene, m); }
    }

    // Decals
    if (!skipNonRoad && CONFIG.ENABLE_DECALS) {
      const dm = await buildDecalMeshes({ buildings: buildings || [], barriers: data.barriers || [] }, key);
      for (const m of dm) { safeSceneAdd(scene, m); entry.decalMeshes.push(m); }
    }

    await yieldToMain();
    if (aborted()) return entry;

    // Urban features + Vendor carts
    if (CONFIG.ENABLE_URBAN_FEATURES && data.urbanFeatures?.length) {
      entry.urbanFeatureMeshes = await mergeMeshesByMaterial(buildUrbanFeatureMeshes(data.urbanFeatures, roads, buildings, getGroundY), yieldToMain);
      for (const m of entry.urbanFeatureMeshes) { safeSceneAdd(scene, m); }
    }
    if (CONFIG.ENABLE_VENDOR_CARTS && roads.length > 0) {
      entry.vendorCartMeshes = await mergeMeshesByMaterial(buildVendorCartMeshes(roads, buildings, key, options.vegetationMask, getGroundY), yieldToMain);
      for (const m of entry.vendorCartMeshes) { safeSceneAdd(scene, m); }
    }

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
        if ((i & 7) === 7) { await yieldToMain(); if (aborted()) return entry; }
      }
      await yieldToMain();
      if (aborted()) return entry;
      // Building colliders — solid shapes so the car can't drive through buildings.
      entry.buildingBodies = (CONFIG.ENABLE_BUILDINGS && filteredTileData.buildings?.length)
        ? buildBuildingColliders(filteredTileData.buildings, physicsOrigin, getElevationAt, vertExag) : [];
      await yieldToMain();
      if (aborted()) return entry;
      for (let i = 0; i < entry.buildingBodies.length; i++) {
        world.addBody(entry.buildingBodies[i]);
        if ((i & 3) === 3) { await yieldToMain(); if (aborted()) return entry; }
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
      tileCache.set(key, {
        roads: [],
        buildings: [],
        roadMeshes: [],
        railwayMeshes: [],
        buildingMeshes: [],
        vegetationMeshes: [],
        propMesh: null,
        clusterMeshes: [],
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
        decalMeshes: [],
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
        tileCache.set(key, {
          roads: [],
          buildings: [],
          roadMeshes: [],
          railwayMeshes: [],
          buildingMeshes: [],
          vegetationMeshes: [],
          waterMesh: null,
          waterIds: [],
          clusterMeshes: [],
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
          decalMeshes: [],
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
  async function update(localX, localZ, opts) {
    // Start of a new frame → reset the shared tile-work budget (see yieldToMain). All in-flight tile
    // finalizes measure against this single per-frame reference, capping total build work per frame.
    const _now = performance.now();
    // Adaptive budget: the gap between update() calls ≈ the last frame's duration. If frames are running
    // long (streaming + render can't keep 60fps), shrink the build budget so tile work stops piling onto an
    // already-slow frame (the high-speed stutter); when frames are smooth again, grow it back to catch up.
    if (_lastUpdateAt) {
      const frameMs = _now - _lastUpdateAt;
      if (frameMs > 20) _budgetMs = Math.max(BUDGET_MIN, _budgetMs - 0.6);        // < ~50 fps → back off
      else if (frameMs < 17) _budgetMs = Math.min(BUDGET_MAX, _budgetMs + 0.4);   // ~60 fps → resume
    }
    _lastUpdateAt = _now;
    _frameBudgetStart = _now;
    if (opts && Number.isFinite(opts.headingDeg)) {
      cameraHeadingRad = opts.headingDeg * Math.PI / 180;
    }
    if (!Number.isFinite(localX) || !Number.isFinite(localZ)) return;
    const o = getOriginOffset();
    const worldX = localX + o.x;
    const worldZ = localZ + o.z;
    const { x: tx, y: ty } = worldToSlippyTile(worldX, worldZ);
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;
    const prevTx = currentTx;
    const prevTy = currentTy;
    currentTx = tx;
    currentTy = ty;

    // Tiles we want loaded: 3×3 core grid + look-ahead tiles in driving direction.
    // Reuse a persistent Set (cleared) instead of allocating one every frame → far less GC churn.
    const wanted = _wantedSet; wanted.clear();
    for (let dx = -GRID_RADIUS; dx <= GRID_RADIUS; dx++) {
      for (let dy = -GRID_RADIUS; dy <= GRID_RADIUS; dy++) {
        wanted.add(tileKey(tx + dx, ty + dy));
      }
    }
    // Add look-ahead tiles in the driving direction. Extend FURTHER the faster you go, so the fetch +
    // build burst for the next tile row happens with lead time (spread over more frames) instead of
    // landing right as you cross the boundary — that just-in-time burst is the high-speed stutter.
    const speedKmh = (opts && Number.isFinite(opts.speedKmh)) ? opts.speedKmh : 0;
    const dynLookahead = LOOKAHEAD_RADIUS + Math.min(3, Math.floor(speedKmh / 55));
    const camDirTileX = Math.round(Math.sin(cameraHeadingRad));
    const camDirTileZ = Math.round(Math.cos(cameraHeadingRad));
    for (let r = GRID_RADIUS + 1; r <= dynLookahead; r++) {
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
    for (const [key, entry] of tileCache.entries()) {
      if (!entry._tx) { const p = key.split('_'); entry._tx = +p[0]; entry._ty = +p[1]; }
      if (tileDistance(entry._tx, entry._ty, tx, ty) > UNLOAD_DISTANCE) {
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
        // Green meshes built in Phase 1 may not be in vegetationMeshes if aborted early
        if (entry.greenMeshes) {
          for (const m of entry.greenMeshes) {
            if (!entry.vegetationMeshes || !entry.vegetationMeshes.includes(m)) {
              collectAndRemove(m);
            }
          }
        }
        collectAndRemove(entry.propMesh);
        collectArrayAndRemove(entry.clusterMeshes);
        collectAndRemove(entry.waterMesh);
        if (entry.waterIds) (entry.waterIds).forEach((id) => renderedWaterIds.delete(id));
        collectAndRemove(entry.trafficLightMesh);
        for (const meshKey of ['shoulderMesh', 'dividerMesh', 'streetlightPoleMesh', 'streetlightArmMesh', 'streetlightLampMesh', 'streetlightPoolMesh', 'streetlightPoleShadowMesh', 'streetlightWireMesh']) {
          collectAndRemove(entry[meshKey]);
        }
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
        if (entry.decalMeshes?.length) entry.decalMeshes.forEach((m) => scene.remove(m));
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
        _pendingDisposals.push({ meshes: allMeshes, decals: entry.decalMeshes || null, entry });
        tileCache.delete(key);
      }
    }

    // Process deferred GPU disposals — one tile per frame to avoid GC spikes
    if (_pendingDisposals.length > 0) {
      const disposal = _pendingDisposals.shift();
      for (const m of disposal.meshes) {
        if (m.isGroup || m.children?.length) {
          m.traverse((child) => {
            if (child.isMesh) {
              child.geometry?.dispose();
              if (!child.userData?.sharedMaterial) {
                if (child.material?.map) child.material.map.dispose();
                if (child.material?.dispose) child.material.dispose();
              }
            }
          });
        } else if (m.isMesh) {
          if (!m.userData?.sharedGeometry) m.geometry?.dispose();
          if (!m.userData?.sharedMaterial && m.material) {
            if (Array.isArray(m.material)) m.material.forEach((mat) => { if (mat.map) mat.map.dispose(); mat.dispose(); });
            else { if (m.material.map) m.material.map.dispose(); m.material.dispose(); }
          }
          // InstancedMesh/BatchedMesh own per-mesh instanceMatrix/instanceColor GPU buffers that
          // geometry.dispose() does NOT free — release them explicitly (safe: doesn't touch shared geo/mat).
          if (m.isInstancedMesh || m.isBatchedMesh) { m.instanceMatrix?.dispose?.(); m.instanceColor?.dispose?.(); }
        }
      }
      if (disposal.decals) disposeDecalMeshes(disposal.decals);
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
    const treeFullDist = typeof CONFIG.TREE_FULL_DISTANCE === 'number' ? CONFIG.TREE_FULL_DISTANCE : 200;
    const treeMaxDist = typeof CONFIG.TREE_MAX_DISTANCE === 'number' ? CONFIG.TREE_MAX_DISTANCE : 500;
    const treeFadeRange = Math.max(1, treeMaxDist - treeFullDist);
    const grassMaxDist = typeof CONFIG.GRASS_MAX_DISTANCE === 'number' ? CONFIG.GRASS_MAX_DISTANCE : 250;

    // Camera-altitude-aware multiplier — scales building LOD/detail thresholds so drone/fly
    // mode loads detail at greater distances. Ground driving (cameraY ≤ 5m) → multiplier = 1,
    // preserving existing behaviour exactly. Clamped at 4× to prevent runaway at extreme altitude.
    const _cameraY = camera?.position.y ?? 0;
    const altMult = Math.max(1.25, Math.min(5, 1.25 + (_cameraY - 5) / 35));

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
      const FOG_FULL_DIST = CONFIG.ENABLE_FOG ? 280 : Infinity;
      if (nearEdgeDist > FOG_FULL_DIST) {
        const hideAll = (meshes) => { if (meshes) for (const m of meshes) m.visible = false; };
        hideAll(entry.vegetationMeshes);
        hideAll(entry.buildingMeshes);
        hideAll(entry.roadInfraMeshes);
        hideAll(entry.barrierMeshes);
        hideAll(entry.busStopMeshes);
        hideAll(entry.urbanFeatureMeshes);
        hideAll(entry.vendorCartMeshes);
        hideAll(entry.decalMeshes);
        hideAll(entry.clusterMeshes);
        if (entry.terrainMesh) entry.terrainMesh.visible = false;
        if (entry.lodBuildingMesh) entry.lodBuildingMesh.visible = false;
        if (entry.propMesh) entry.propMesh.visible = false;
        if (entry.reflectorGroup) entry.reflectorGroup.visible = false;
        if (entry.crashBarrierMesh) entry.crashBarrierMesh.visible = false;
        if (entry.crosswalkMesh)    entry.crosswalkMesh.visible    = false;
        if (entry.onewayArrowMesh)  entry.onewayArrowMesh.visible  = false;
        if (entry.bcnSidewalkMesh)  entry.bcnSidewalkMesh.visible  = false;
        if (entry.bcnCurbMesh)      entry.bcnCurbMesh.visible      = false;
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
        for (const mk of ['streetlightPoleMesh', 'streetlightArmMesh', 'streetlightLampMesh', 'streetlightPoolMesh', 'streetlightPoleShadowMesh', 'streetlightWireMesh']) {
          if (entry[mk]) entry[mk].visible = false;
        }
        // Keep road meshes visible (roads extend into fog for continuity)
        continue;
      }

      // ── Close tile: ensure terrain + water are visible (may have been fog-hidden) ──
      if (entry.terrainMesh) entry.terrainMesh.visible = true;
      if (entry.waterMesh) entry.waterMesh.visible = true;

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
            const bbStart = treeMaxDist;   // 500m from nearest edge — where 3D trees fully fade out
            const bbEnd = bbStart + 300;   // 800m — billboard fade-out
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
          } else {
            m.visible = dist <= treeMaxDist;
          }
        }
      }
      if (entry.propMesh) {
        entry.propMesh.visible = dist <= treeMaxDist;
      }
      for (const m of entry.clusterMeshes || []) {
        m.visible = dist <= treeMaxDist;
      }

      const bldgMaxDist    = (typeof CONFIG.BUILDING_MAX_DISTANCE === 'number' ? CONFIG.BUILDING_MAX_DISTANCE : 180) * altMult;
      const bldgDetailDist = 120 * altMult;
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
      const infraDist = 140;   // road infra (signs, gantries, signals)
      const detailDist = 80 * altMult;   // fine details (barriers, bus stops, vendor carts, decals) — altitude-aware
      const lightDist = 140;   // streetlights

      // Road infrastructure
      if (entry.roadInfraMeshes) {
        const show = nearEdgeDist <= infraDist;
        for (const m of entry.roadInfraMeshes) m.visible = show;
      }

      // Streetlights (6 mesh types)
      const showLights = nearEdgeDist <= lightDist;
      for (const meshKey of ['streetlightPoleMesh', 'streetlightArmMesh', 'streetlightLampMesh', 'streetlightPoolMesh', 'streetlightPoleShadowMesh', 'streetlightWireMesh']) {
        if (entry[meshKey]) entry[meshKey].visible = showLights;
      }

      // Traffic lights, shoulders, dividers
      if (entry.trafficLightMesh) entry.trafficLightMesh.visible = nearEdgeDist <= infraDist;
      if (entry.shoulderMesh) entry.shoulderMesh.visible = nearEdgeDist <= infraDist;
      if (entry.dividerMesh) entry.dividerMesh.visible = nearEdgeDist <= infraDist;

      // Fine detail meshes — barriers, bus stops, parking, urban features, vendor carts, decals
      const showDetail = nearEdgeDist <= detailDist;
      if (entry.crosswalkMesh)    entry.crosswalkMesh.visible    = showDetail;
      if (entry.onewayArrowMesh)  entry.onewayArrowMesh.visible  = showDetail;
      // Phase 3: altitude-aware thresholds (altMult from building LOD, same variable)
      if (entry.bcnSidewalkMesh)  entry.bcnSidewalkMesh.visible  = nearEdgeDist <= 80  * altMult;
      if (entry.bcnCurbMesh)      entry.bcnCurbMesh.visible      = nearEdgeDist <= 200 * altMult;
      if (entry.bcnBikeLaneMesh)  entry.bcnBikeLaneMesh.visible  = nearEdgeDist <= 120 * altMult;
      if (entry.bcnBikePictoMesh) entry.bcnBikePictoMesh.visible = nearEdgeDist <= 50  * altMult;
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
      for (const m of entry.decalMeshes || []) m.visible = showDetail;

      // Water
      if (entry.waterMesh) entry.waterMesh.visible = nearEdgeDist <= bldgMaxDist;

      // ── Physics body add/remove by distance ────────────────────────────
      // Actually remove far bodies from the world to reduce NaiveBroadphase
      // O(n²) cost. Use a flag instead of world.bodies.includes() (O(n)).
      const physActive = nearEdgeDist <= 200; // just beyond fog visibility
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
      if (entry.roadInfraMeshes) roadInfraCount += entry.roadInfraMeshes.length;
      if (entry.streetlightPoleMesh) streetlightCount++;
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
  function getLoadedRoadSegments() {
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
        });
      }
    }
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
  function getStreetlightPositions() {
    const out = [];
    for (const entry of tileCache.values()) {
      if (entry.streetlightPositions?.length) out.push(...entry.streetlightPositions);
    }
    return out;
  }

  function getTunnelBodyCount() {
    let n = 0;
    for (const entry of tileCache.values()) n += (entry.tunnelBodies || []).length;
    return n;
  }

  // True once the initial spawn-area tiles have finished loading (nothing in-flight or queued after
  // loading has begun). Used to hold the loading screen until the world around the car is actually built.
  function isInitialLoadComplete() {
    if (inFlightCount > 0 || pendingQueue.length > 0) { _startedLoading = true; return false; }
    return _startedLoading && tileCache.size > 0;
  }

  return {
    update,
    isInitialLoadComplete,
    getLoadedRoadSegments,
    injectSpawnTile,
    getDebugMetrics,
    getTerrainElevationRange,
    getHeightfieldBodyCount,
    getHeightfieldBodyForTileKey,
    getBridgeBodyCount,
    getTunnelBodyCount,
    getTerrainHeightAt,
    getRoadHeightAt,
    getSurfaceHeightAt,
    normalizedGroundFloor,
    getCurrentTileTerrainRange,
    getStreetlightPositions,
  };
}
