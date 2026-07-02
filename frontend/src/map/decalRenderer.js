/**
 * Wall decal system — lightweight urban detail for building facades and barrier walls.
 *
 * Each decal type uses a single THREE.InstancedMesh per tile so draw-call cost is
 * O(types) rather than O(decals). Geometry is one 1×1 PlaneGeometry (2 triangles).
 * Textures are PNGs with alpha; alphaTest:0.1 discards transparent fragments cheaply.
 *
 * Types: paan_stain, movie_poster, political_poster, wall_notice
 * Textures loaded from: /textures/decals/<type>_01.png … _N.png (auto-probed)
 */
import * as THREE from 'three';

// ─── Placement config ────────────────────────────────────────────────────────

// Density: expected placements per metre of barrier wall length.
// One attempt is made every DECAL_SPACING_M metres along each segment.
const DECAL_TYPES = [
  { key: 'paan_stain',       densityPerM: 0.15, minSize: 0.35, maxSize: 0.70, maxPerTile: 60 },
  { key: 'movie_poster',     densityPerM: 0.04, minSize: 0.90, maxSize: 1.60, maxPerTile: 10 },
  { key: 'political_poster', densityPerM: 0.04, minSize: 0.90, maxSize: 1.60, maxPerTile: 10 },
  { key: 'wall_notice',      densityPerM: 0.02, minSize: 0.60, maxSize: 1.00, maxPerTile: 15 },
];

const MAX_DECALS_PER_TILE   = 120;
const MAX_POSTER_TYPES      = ['movie_poster', 'political_poster'];
const MAX_POSTERS_PER_TILE  = 20;

const HEIGHT_MIN = 0.4;  // metres above building base
const HEIGHT_MAX = 2.2;

const Z_FIGHT_OFFSET = 0.55;  // metres outward from wall centreline (clears compound_wall halfThick of 0.5m)
const ROTATION_JITTER = (5 * Math.PI) / 180; // ±5 degrees

// ─── Texture loader ──────────────────────────────────────────────────────────

const textureLoader = new THREE.TextureLoader();

/** Cache: key → Promise<THREE.Texture[]> — stores the load Promise so any caller can await it. */
const typeTexturePromises = new Map();

function tryLoadTexture(path) {
  return new Promise((resolve) => {
    textureLoader.load(path, resolve, undefined, () => resolve(null));
  });
}

function loadTypeTextures(typeKey) {
  if (typeTexturePromises.has(typeKey)) return typeTexturePromises.get(typeKey);
  const p = (async () => {
    const list = [];
    for (let i = 1; i <= 9; i++) {
      const slot = String(i).padStart(2, '0');
      const tex = await tryLoadTexture(`/textures/decals/${typeKey}_${slot}.png`);
      if (!tex) break;
      tex.colorSpace = THREE.SRGBColorSpace;
      list.push(tex);
    }
    return list;
  })();
  typeTexturePromises.set(typeKey, p);
  return p;
}

// Kick off texture loading for all types on module load (non-blocking).
DECAL_TYPES.forEach((t) => loadTypeTextures(t.key));

// ─── Cached materials keyed by texture instance ─────────────────────────────
const _decalMatCache = new Map();

// ─── Geometry (shared, 1×1 plane, two triangles) ────────────────────────────

let _planeGeom = null;
function getPlaneGeom() {
  if (!_planeGeom) _planeGeom = new THREE.PlaneGeometry(1, 1);
  return _planeGeom;
}

// ─── Seeded RNG (deterministic per tile so decals are stable across reloads) ─

function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function tileKeyToSeed(tileKey) {
  // tileKey is "tx_ty" — combine both numbers into a seed
  const parts = tileKey.split('_').map(Number);
  return (parts[0] * 73856093) ^ (parts[1] * 19349663);
}

// ─── Core placement logic ────────────────────────────────────────────────────

/**
 * Collect wall segments from barrier polylines.
 * data.barriers = Array<{ type, points: [{x,z,y},...] }>
 */
function extractBarrierSegments(barriers) {
  const segments = [];
  for (const barrier of barriers) {
    const pts = barrier.points;
    if (!pts || pts.length < 2) continue;
    // Only decal solid walls/compound walls
    const t = barrier.type || '';
    if (t !== 'wall' && t !== 'city_wall' && t !== 'compound_wall' && t !== 'retaining_wall') continue;
    // Points are [x, z] arrays (barrierRenderer format)
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i], p1 = pts[i + 1];
      const x0 = p0[0], z0 = p0[1];
      const x1 = p1[0], z1 = p1[1];
      const dx = x1 - x0, dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      if (len < 1.0) continue;
      const nx = -dz / len;
      const nz =  dx / len;
      segments.push({ x0, z0, x1, z1, nx, nz, baseY: 0, len });
    }
  }
  return segments;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build InstancedMesh array for all decals on this tile.
 * Returns a Promise resolving to an array of THREE.InstancedMesh (one per type that has ≥1 instance).
 * Awaits texture loading so decals are never silently dropped on first tile load.
 *
 * @param {{ barriers?: object[] }} tileData
 * @param {string} tileKey  e.g. "46823_27337"
 * @returns {Promise<THREE.InstancedMesh[]>}
 */
export async function buildDecalMeshes(tileData, tileKey) {
  // Await all texture loads and collect resolved lists indexed by typeKey.
  const textureLists = new Map(
    await Promise.all(
      DECAL_TYPES.map(async (t) => [t.key, await loadTypeTextures(t.key)])
    )
  );
  // Decals go on barrier walls only (compound_wall, wall, city_wall, retaining_wall).
  const barriers  = tileData?.barriers || [];
  const allSegs   = extractBarrierSegments(barriers);

  if (allSegs.length === 0) return [];

  const rng = seededRng(tileKeyToSeed(tileKey));

  // Per-type instance staging
  const staged = new Map();
  for (const td of DECAL_TYPES) staged.set(td.key, { cfg: td, placements: [] });

  let totalDecals  = 0;
  let totalPosters = 0;

  const dummy      = new THREE.Object3D();
  const qWall      = new THREE.Quaternion();

  for (const seg of allSegs) {
    if (totalDecals >= MAX_DECALS_PER_TILE) break;

    // Number of placement attempts scales with wall length so longer walls get more decals.
    const attempts = Math.max(1, Math.round(seg.len * Math.max(...DECAL_TYPES.map(t => t.densityPerM))));

    for (let a = 0; a < attempts; a++) {
      if (totalDecals >= MAX_DECALS_PER_TILE) break;

      for (const td of DECAL_TYPES) {
        if (totalDecals >= MAX_DECALS_PER_TILE) break;

        const st = staged.get(td.key);
        if (st.placements.length >= td.maxPerTile) continue;
        if (MAX_POSTER_TYPES.includes(td.key) && totalPosters >= MAX_POSTERS_PER_TILE) continue;

        // Poisson-like: probability per attempt = densityPerM / attempts_per_metre
        const attemptsPerM = attempts / seg.len;
        if (rng() > td.densityPerM / attemptsPerM) continue;

        const texList = textureLists.get(td.key);
        if (!texList || texList.length === 0) continue;

        const t  = rng();
        const px = seg.x0 + (seg.x1 - seg.x0) * t;
        const pz = seg.z0 + (seg.z1 - seg.z0) * t;
        const py = seg.baseY + HEIGHT_MIN + rng() * (HEIGHT_MAX - HEIGHT_MIN);

        const ox = seg.nx * Z_FIGHT_OFFSET;
        const oz = seg.nz * Z_FIGHT_OFFSET;

        const size = td.minSize + rng() * (td.maxSize - td.minSize);

        const wallNormal = new THREE.Vector3(seg.nx, 0, seg.nz).normalize();
        qWall.setFromUnitVectors(new THREE.Vector3(0, 0, 1), wallNormal);

        const tiltAngle = (rng() - 0.5) * 2 * ROTATION_JITTER;
        qWall.premultiply(new THREE.Quaternion().setFromAxisAngle(wallNormal, tiltAngle));

        dummy.position.set(px + ox, py, pz + oz);
        dummy.quaternion.copy(qWall);
        dummy.scale.set(size, size, 1);
        dummy.updateMatrix();

        const texIdx = Math.floor(rng() * texList.length);
        st.placements.push({ matrix: dummy.matrix.clone(), texIdx });
        totalDecals++;
        if (MAX_POSTER_TYPES.includes(td.key)) totalPosters++;
      }
    }
  }

  // Build InstancedMeshes
  const meshes = [];
  const geom   = getPlaneGeom();

  for (const td of DECAL_TYPES) {
    const { placements } = staged.get(td.key);
    if (placements.length === 0) continue;

    const texList = textureLists.get(td.key);
    if (!texList || texList.length === 0) continue;

    // If multiple textures for this type, group by texIdx to keep one InstancedMesh
    // per texture variant (avoids per-instance texture switching which is unsupported).
    // For simplicity and performance, group all into one InstancedMesh using the most
    // common texture. Full multi-texture support would require one IMesh per texture.
    const byTex = new Map();
    for (const p of placements) {
      if (!byTex.has(p.texIdx)) byTex.set(p.texIdx, []);
      byTex.get(p.texIdx).push(p.matrix);
    }

    for (const [texIdx, matrices] of byTex.entries()) {
      const tex = texList[texIdx];
      if (!tex) continue;

      let mat = _decalMatCache.get(tex);
      if (!mat) {
        mat = new THREE.MeshStandardMaterial({
          map:        tex,
          transparent: true,
          alphaTest:  0.1,
          depthWrite: false,
          roughness:  0.9,
          metalness:  0,
          side:       THREE.FrontSide,
        });
        _decalMatCache.set(tex, mat);
      }

      const iMesh = new THREE.InstancedMesh(geom, mat, matrices.length);
      iMesh.castShadow    = false;
      iMesh.receiveShadow = false;
      iMesh.frustumCulled = true;
      iMesh.userData.decalType = td.key;
      iMesh.userData.ownsMaterial = false; // material is cached & shared

      for (let i = 0; i < matrices.length; i++) {
        iMesh.setMatrixAt(i, matrices[i]);
      }
      iMesh.instanceMatrix.needsUpdate = true;

      meshes.push(iMesh);
    }
  }

  return meshes;
}

/**
 * Dispose an array of decal InstancedMeshes (does not remove from scene — caller does that).
 */
export function disposeDecalMeshes(meshes) {
  for (const m of meshes) {
    // geometry is shared — do not dispose
    if (m.userData?.ownsMaterial) {
      m.material?.dispose();
    }
  }
}
