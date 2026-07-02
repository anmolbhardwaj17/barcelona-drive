/**
 * Bush layer: InstancedMesh using GLB models, placement in parks/grass, residential roads, building edges.
 * Max 800 per tile. One InstancedMesh per variety per tile, shared material.
 * options.getElevationAt(lat, lon) places bush base on terrain.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { worldToLatLon } from '../projection.js';
import { CONFIG } from '../config.js';
import { isVegetationAllowed } from './vegetationMask.js';

const MAX_BUSHES_PER_TILE = 800;
const BUSH_Y_OFFSET = 0;
const DENSITY_PARK_GRASS = 1 / 50;
const RESIDENTIAL_SPACING_MIN = 20;
const RESIDENTIAL_SPACING_MAX = 40;
const RESIDENTIAL_OFFSET = 4;

// ---------------------------------------------------------------------------
// GLB bush assets
// ---------------------------------------------------------------------------
const GLB_BUSH_URLS = [
  '/models/vegetation/bushes/bush_01.glb',
  '/models/vegetation/bushes/bush_02.glb',
  '/models/vegetation/bushes/bush_03.glb',
  '/models/vegetation/bushes/bush_04.glb',
];

const BUSH_TEXTURE_URL = '/models/vegetation/textures/T_Bush_temp_climate.png';

let bushGeometries = new Array(4).fill(null);
let bushMaterial   = null;
let bushLoadPromise = null;

export function preloadBushModels() {
  if (bushLoadPromise) return bushLoadPromise;

  bushLoadPromise = (async () => {
    const texLoader = new THREE.TextureLoader();
    const bushTex = await new Promise((resolve) => {
      texLoader.load(
        BUSH_TEXTURE_URL,
        (t) => { t.colorSpace = THREE.SRGBColorSpace; t.flipY = false; resolve(t); },
        undefined,
        () => resolve(null)
      );
    });

    bushMaterial = new THREE.MeshStandardMaterial({
      map: bushTex,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
      roughness: 0.9,
      metalness: 0,
    });

    const loader = new GLTFLoader();
    await Promise.all(
      GLB_BUSH_URLS.map((url, i) =>
        new Promise((resolve) => {
          loader.load(
            url,
            (gltf) => {
              const geos = [];
              gltf.scene.traverse((child) => {
                if (child.isMesh && child.geometry) geos.push(child.geometry.clone());
              });
              if (geos.length === 0) { resolve(); return; }
              let geo = geos.length === 1 ? geos[0] : mergeGeometries(geos);
              if (geos.length > 1) geos.forEach((g) => g.dispose());
              geo.computeBoundingBox();
              geo.translate(0, -geo.boundingBox.min.y, 0);
              bushGeometries[i] = geo;
              resolve();
            },
            undefined,
            () => resolve()
          );
        })
      )
    );
  })();

  return bushLoadPromise;
}

// ---------------------------------------------------------------------------
// Procedural fallback geometry (3 merged spheres)
// ---------------------------------------------------------------------------
let fallbackBushGeometry = null;
let fallbackBushMaterial = null;

function getFallbackBushResources() {
  if (!fallbackBushGeometry) {
    const s1 = new THREE.SphereGeometry(0.35, 5, 4);
    s1.translate(0, 0.35, 0);
    const s2 = new THREE.SphereGeometry(0.28, 4, 3);
    s2.translate(0.15, 0.55, -0.1);
    const s3 = new THREE.SphereGeometry(0.22, 4, 3);
    s3.translate(-0.1, 0.7, 0.12);
    fallbackBushGeometry = mergeGeometries([s1, s2, s3]);
    s1.dispose(); s2.dispose(); s3.dispose();
  }
  if (!fallbackBushMaterial) {
    fallbackBushMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0,
      vertexColors: true,
    });
  }
  return { geometry: fallbackBushGeometry, material: fallbackBushMaterial };
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function seeded(i, s) {
  const x = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function polygonArea(poly) {
  let area = 0;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return Math.abs(area) / 2;
}

function pointInPolygon(px, py, polygon) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if (yi > py !== yj > py && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function getBbox(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

function scatterInPolygon(polygon, density, seed, maxCount) {
  if (!polygon || polygon.length < 3) return [];
  const area = polygonArea(polygon);
  const count = Math.min(Math.floor(area * density), maxCount);
  if (count <= 0) return [];
  const { minX, minY, maxX, maxY } = getBbox(polygon);
  const out = [];
  let tries = count * 40;
  while (out.length < count && tries-- > 0) {
    const x = minX + seeded(out.length + seed, 1) * (maxX - minX);
    const y = minY + seeded(out.length + seed, 2) * (maxY - minY);
    if (pointInPolygon(x, y, polygon)) out.push({ x, y });
  }
  return out;
}


function positionsAlongResidentialRoads(roads) {
  const out = [];
  const residential = roads.filter((r) =>
    (r.highwayType === 'residential' || r.highwayType === 'living_street') &&
    !r.bridge && !r.tunnel && (r.layer == null || r.layer === 0)
  );
  for (const road of residential) {
    const pts = road.points || [];
    if (pts.length < 2) continue;
    const spacing = RESIDENTIAL_SPACING_MIN + seeded(road.id, 0) * (RESIDENTIAL_SPACING_MAX - RESIDENTIAL_SPACING_MIN);
    let dist = 0;
    let side = seeded(road.id, 1) > 0.5 ? 1 : -1;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dz = b.y - a.y;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      while (dist < len && out.length < 400) {
        const t = dist / len;
        const x = a.x + (dx / len) * t;
        const z = a.y + (dz / len) * t;
        const perpX = (-dz / len) * side * RESIDENTIAL_OFFSET;
        const perpZ = (dx / len) * side * RESIDENTIAL_OFFSET;
        out.push({ x: x + perpX, y: z + perpZ });
        dist += spacing;
        side *= -1;
      }
      dist -= len;
    }
  }
  return out;
}

function positionsNearBuildingEdges(buildings, seed, maxCount) {
  const out = [];
  for (const b of buildings || []) {
    const fp = b.footprint || [];
    if (fp.length < 3) continue;
    const step = 8 + seeded(b.id + seed, 0) * 6;
    let d = 0;
    for (let i = 0; i < fp.length; i++) {
      const a = fp[i];
      const b_ = fp[(i + 1) % fp.length];
      const len = Math.hypot(b_.x - a.x, b_.y - a.y);
      while (d < len && out.length < maxCount) {
        const t = d / (len || 1);
        const off = 1.5 + seeded(out.length + b.id, 1) * 1.5;
        const nx = -(b_.y - a.y) / (len || 1);
        const nz = (b_.x - a.x) / (len || 1);
        out.push({
          x: a.x + t * (b_.x - a.x) + nx * off,
          y: a.y + t * (b_.y - a.y) + nz * off,
        });
        d += step;
      }
      d -= len;
    }
  }
  return out;
}


function collectBushPositions(tileData, tileKey, vegMask) {
  const positions = [];
  const seed = (tileKey || '').length * 11;

  function isExcluded(x, z) {
    return !isVegetationAllowed(vegMask, x, z, 1.5);
  }

  const roads = tileData?.roads || [];
  const roadPts = positionsAlongResidentialRoads(roads);
  for (const p of roadPts) {
    if (!isExcluded(p.x, p.y)) positions.push(p);
    if (positions.length >= MAX_BUSHES_PER_TILE) return positions.slice(0, MAX_BUSHES_PER_TILE);
  }

  const buildingPts = positionsNearBuildingEdges(tileData?.buildings || [], seed, 150);
  for (const p of buildingPts) {
    if (!isExcluded(p.x, p.y)) positions.push(p);
    if (positions.length >= MAX_BUSHES_PER_TILE) return positions.slice(0, MAX_BUSHES_PER_TILE);
  }

  return positions.slice(0, MAX_BUSHES_PER_TILE);
}

// ---------------------------------------------------------------------------
// Mesh builder
// ---------------------------------------------------------------------------

function buildInstancedMesh(geometry, material, positions, getElevationAt, useFallbackColor) {
  const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
  mesh.count = positions.length;
  mesh.frustumCulled = true;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.userData.sharedGeometry = true;
  mesh.userData.sharedMaterial = true;

  if (useFallbackColor) {
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(positions.length * 3), 3);
  }

  const vertExag =
    CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION)
      ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();

  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const rnd = (s) => seeded(i, s);
    const scaleH = 0.5 + rnd(1);
    const scaleXY = 0.85 + rnd(2) * 0.3;
    const rotY = rnd(3) * Math.PI * 2;
    const { lat, lon } = worldToLatLon(p.x, p.y);
    const y = getElevationAt ? (getElevationAt(lat, lon) ?? 0) * vertExag : BUSH_Y_OFFSET;
    position.set(p.x, y, p.y);
    quat.setFromEuler(new THREE.Euler(0, rotY, 0, 'XYZ'));
    scale.set(scaleXY, scaleH, scaleXY);
    matrix.compose(position, quat, scale);
    mesh.setMatrixAt(i, matrix);
    if (useFallbackColor) {
      color.setHSL(0.25 + rnd(4) * 0.1, 0.5, 0.28);
      mesh.setColorAt(i, color);
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (useFallbackColor && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render bushes for a tile. Returns array of InstancedMesh (one per GLB variant) or single fallback mesh.
 * @param {object} tileData
 * @param {string} [tileKey]
 * @param {{ getElevationAt?: (lat, lon) => number }} [options]
 * @returns {THREE.InstancedMesh[]|THREE.InstancedMesh|null}
 */
export function renderBushes(tileData, tileKey, options) {
  const positions = collectBushPositions(tileData, tileKey, options?.vegetationMask || null);
  if (positions.length === 0) return null;

  const getElevationAt = options?.getElevationAt;
  const hasGLB = bushGeometries.some((g) => g != null);

  if (hasGLB) {
    const seed = (tileKey || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0);
    const buckets = [[], [], [], []];
    for (let i = 0; i < positions.length; i++) {
      const v = Math.floor(seeded(i, seed) * 4) % 4;
      buckets[v].push(positions[i]);
    }
    const meshes = [];
    for (let v = 0; v < 4; v++) {
      if (buckets[v].length === 0) continue;
      const geo = bushGeometries[v] ?? bushGeometries.find((g) => g != null);
      if (!geo) continue;
      meshes.push(buildInstancedMesh(geo, bushMaterial, buckets[v], getElevationAt, false));
    }
    return meshes.length > 0 ? meshes : null;
  }

  // Fallback: procedural sphere bush
  const { geometry, material } = getFallbackBushResources();
  return buildInstancedMesh(geometry, material, positions, getElevationAt, true);
}
