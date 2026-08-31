/**
 * Shared low-poly car-model loader (Kenney Car Kit, CC0) for traffic + parked cars + police.
 *
 * Each Kenney car GLB = a body + wheels sharing ONE texture-atlas material. The canonical template
 * merges them into a single geometry, scales to CANON_LENGTH, orients the length axis to +Z, and
 * recentres so the wheels sit at y=0 and the car is centred in X/Z.
 *
 * ── v3 P4-15a: ONE PARSE, ONE MATERIAL, ONE ATLAS ─────────────────────────────────────────────
 * Three consumers used to call loadCityCarTemplates() with three different target lengths
 * (traffic 3.9, parked 3.8, police 4.4). Nothing was cached, so that was 27 GLB fetches, 27 merges,
 * 27 MeshStandardMaterials and 27 uploads of the SAME 3,110-byte colormap — verified identical:
 * every one of the nine GLBs embeds one material and one image with md5 609899c94d3c.
 *
 * Now: the GLB parse is cached per URL, the merged geometry is cached per URL at CANON_LENGTH, and
 * ALL nine templates share ONE material. A consumer that wants a different length gets a cheap
 * VIEW — same geometry, same material, plus a `scale` it folds into its instance matrix. That is
 * what lets traffic and parked cars live in one BatchedMesh (see carFleet.js): a BatchedMesh has
 * exactly one material, so sharing it is not an optimisation here, it is the enabling condition.
 *
 * ⚠ `tpl.geometry` and `tpl.material` are SHARED SINGLETONS. Never dispose them from a consumer.
 */
import * as THREE from 'three';
import { makeGLTFLoader } from '../loaders.js';
import { registerMaterial } from '../map/materialRegistry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { onCarEnvMap } from './carModel.js';   // V-2 — traffic reflects the same sky

const _loader = makeGLTFLoader();

/** Every canonical car geometry is built at this length; consumers scale from it. */
export const CANON_LENGTH = 4.0;

export const CAR_KIT_PATH = '/models/cars/';

// The normal city cars from the kit (skip tractors/karts/race/debris).
export const CITY_CARS = [
  'sedan', 'sedan-sports', 'suv', 'suv-luxury',
  'hatchback-sports', 'van', 'taxi', 'police', 'delivery',
];

// ── Caches. Keyed by URL, never evicted: the whole kit is 1.7 MB and lives for the session. ──
const _gltfCache = new Map();   // url -> Promise<gltf>
const _canonCache = new Map();  // url -> Promise<{ geometry, dims }>
let _kitMatPromise = null;      // Promise<Material> — ONE material for the whole kit

function loadGLTF(url) {
  let p = _gltfCache.get(url);
  if (!p) { p = _loader.loadAsync(url); _gltfCache.set(url, p); }
  return p;
}

/**
 * The ONE material every city car renders with.
 *
 * Built from CITY_CARS[0] rather than "whichever template resolved first" so the result does not
 * depend on network ordering. Registered with the material registry so the boot warm-up compiles
 * its USE_BATCHING / USE_INSTANCING variants instead of letting the first car on screen do it
 * mid-drive (the `programs.length` delta gate).
 */
function getKitMaterial() {
  if (_kitMatPromise) return _kitMatPromise;
  _kitMatPromise = loadGLTF(CAR_KIT_PATH + CITY_CARS[0] + '.glb').then((gltf) => {
    let src = null;
    gltf.scene.traverse((c) => { if (!src && c.isMesh && c.material) src = c.material; });
    if (!src) throw new Error('[carModels] no material in the kit source model');
    const material = src.clone();
    if (material.map) material.map.colorSpace = THREE.SRGBColorSpace;
    if (material.color) material.color.setRGB(1, 1, 1); // white base so per-car tint shows
    // ── CITY CARS ARE PAINTED METAL, NOT MATTE PLASTIC (V-2) ────────────────────────────────
    // These shipped at metalness 0 / roughness 0.85 with no env map — a perfectly diffuse surface,
    // which is why they read as toys beside the hero car. Measured, the gap is NOT polygons: the
    // kit averages 2,189 tris against the M3's 9,792, but it carries ONE material ("colormap")
    // against eleven, so there is no glass, no chrome and no paint response at all.
    //
    // Values are deliberately below the hero car's (0.35 / 0.36 / clearcoat 0.4). The kit bakes
    // WHEELS into the same material via vertex colour, so anything strongly metallic turns the
    // tyres to chrome. This is the most paint response the shared material can carry without that.
    if ('metalness' in material) material.metalness = 0.15;
    if ('roughness' in material) material.roughness = 0.55;
    if ('clearcoat' in material) material.clearcoat = 0.25;
    onCarEnvMap((env) => {
      material.envMap = env;
      material.envMapIntensity = 0.35;   // below the hero's 0.5 — traffic should not out-shine it
      material.needsUpdate = true;
    });
    material.vertexColors = true; // wheels black / body white baked in prepGeo
    material.needsUpdate = true;
    material.userData.sharedMaterial = true;   // ⚠ H6: shared-material disposal defaults to DISPOSE
    registerMaterial(material, 'cityCar');
    return material;
  });
  return _kitMatPromise;
}

// Clone + flatten a mesh's geometry to a merge-compatible set (position/normal/uv/color), baking a
// per-PART vertex colour: wheels → near-black, everything else → white (so a per-car tint colours the
// body but the tyres stay black regardless of the texture).
//
// `keepIndex` is decided ONCE for the whole model by the caller: mergeGeometries requires every
// input to agree. Keeping the index matters: measured over the nine GLBs, toNonIndexed() takes the
// kit from 31,887 vertices to 59,106 — 1.85×, i.e. 46% more vertex-shader work on the largest
// instanced population in the scene (~250 parked cars) — and buys nothing, because the vertex
// colour is per-PART, not per-face, so it survives shared vertices intact.
function prepGeo(src, isWheel, keepIndex) {
  let g = src.clone();
  if (g.index && !keepIndex) g = g.toNonIndexed();
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.position.count;
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  const cv = isWheel ? 0.03 : 1.0;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) col[i] = cv;
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Build (once per URL) the merged, canonically-scaled, recentred geometry for one car. */
function getCanonicalGeometry(url) {
  let p = _canonCache.get(url);
  if (p) return p;
  p = loadGLTF(url).then((gltf) => {
    const model = gltf.scene;
    model.updateMatrixWorld(true);
    const meshes = [];
    model.traverse((c) => { if (c.isMesh) meshes.push(c); });
    if (!meshes.length) throw new Error('no meshes in ' + url);

    // All-or-nothing: mergeGeometries rejects a mix, and computeVertexNormals on an indexed
    // geometry would smooth across the hard body creases these models rely on.
    const keepIndex = meshes.every((m) => m.geometry.index && m.geometry.attributes.normal);
    const geos = [];
    for (const m of meshes) {
      const g = prepGeo(m.geometry, /wheel/i.test(m.name), keepIndex);
      g.applyMatrix4(m.matrixWorld);
      geos.push(g);
    }
    let merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();   // the merge copied them; the clones are garbage now
    if (!merged) throw new Error('merge failed ' + url);

    // orient length → Z
    merged.computeBoundingBox();
    const size = new THREE.Vector3(); merged.boundingBox.getSize(size);
    if (size.x > size.z) { merged.rotateY(Math.PI / 2); merged.computeBoundingBox(); merged.boundingBox.getSize(size); }
    const nativeLen = Math.max(size.x, size.z);
    const scale = nativeLen > 0.001 ? CANON_LENGTH / nativeLen : 1;
    // Non-uniform: slightly narrow + lower the chunky Kenney proportions so they read as cars, not blocks.
    merged.scale(scale * 0.95, scale * 0.82, scale);

    // recentre: wheels at y=0, centred in X/Z
    merged.computeBoundingBox();
    const bb = merged.boundingBox;
    merged.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
    merged.computeBoundingBox();
    merged.computeBoundingSphere();   // BatchedMesh reads this for per-instance frustum culling
    const s2 = new THREE.Vector3(); merged.boundingBox.getSize(s2);
    merged.userData.sharedGeometry = true;

    return { geometry: merged, dims: { w: s2.x, h: s2.y, l: s2.z } };
  });
  _canonCache.set(url, p);
  return p;
}

/**
 * A car template at `targetLength`.
 *
 * `geometry` and `material` are the SHARED canonical singletons — do NOT dispose them. `scale` is
 * the uniform factor from CANON_LENGTH to the requested length; a consumer drawing a loose Mesh
 * must apply it (`mesh.scale.setScalar(tpl.scale)`), an instanced consumer folds it into the
 * instance matrix. `dims` is already in the requested length's units.
 */
export async function loadCarTemplate(url, targetLength = CANON_LENGTH) {
  const [canon, material] = await Promise.all([getCanonicalGeometry(url), getKitMaterial()]);
  const s = targetLength / CANON_LENGTH;
  return {
    geometry: canon.geometry,
    material,
    scale: s,
    dims: { w: canon.dims.w * s, h: canon.dims.h * s, l: canon.dims.l * s },
  };
}

/**
 * Load the whole city-car set. Failures are skipped, so the returned array's INDEX is not a stable
 * variant id — read `t.name` when you need to identify one.
 */
export async function loadCityCarTemplates(basePath = CAR_KIT_PATH, targetLength = CANON_LENGTH) {
  const settled = await Promise.all(CITY_CARS.map((name) =>
    loadCarTemplate(basePath + name + '.glb', targetLength)
      .then((t) => { t.name = name; return t; })
      .catch((e) => { console.warn('[carModels] failed to load', name, e?.message || e); return null; })));
  return settled.filter(Boolean);
}

// ── Real low-poly people (Poly Pizza rigged GLBs) for pedestrians ──
// Rigged → baked to static walk-frames + idle (loadWalkFramesTemplate) so they can be instanced.
// v3 P0-11: 'punk' (1.24 MB) and 'adventurer' (1.84 MB, a 10,198-tri fantasy RPG model with a
// 1,748-tri backpack) removed — 3.1 MB of page weight for two of five ped variants. The v3 plan
// cuts the pedestrian art pass entirely and drops PED_CAP 168→60, so variety here is not the lever.
export const PEOPLE = ['man', 'woman-casual', 'woman-dress'];

function bakePosedMesh(mesh) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const n = pos.count;
  const outPos = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  const skinned = mesh.isSkinnedMesh && typeof mesh.applyBoneTransform === 'function';
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i);
    if (skinned) mesh.applyBoneTransform(i, v); // bind → current (posed) local position
    v.applyMatrix4(mesh.matrixWorld);           // → world
    outPos[i * 3] = v.x; outPos[i * 3 + 1] = v.y; outPos[i * 3 + 2] = v.z;
  }
  // vertex colours from the material groups (each part → its baseColor). Boosted ~1.3× (clamped) because
  // the baked GLB albedos read underexposed under Lambert lighting — skin especially looked too dark.
  const cols = new Float32Array(n * 3).fill(0.82);
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const idx = geo.index;
  // The baked GLB albedos read muddy/desaturated under Lambert lighting (worst on the khaki
  // "adventurer"), so a flat brightness boost just washed them into monochrome. Push SATURATION and
  // lightness in HSL so clothes read as real colours, then a mild overall brighten. This is what
  // actually kills the "bland" look.
  const PED_BOOST = 1.12;   // overall brighten (was 1.3 — sat/lightness now do the lifting)
  const PED_SAT   = 1.5;    // colour pop
  const PED_LIGHT = 1.16;   // lift out of the mud
  const _hsl = { h: 0, s: 0, l: 0 };
  const _tmpC = new THREE.Color();
  const setCol = (vi, c) => {
    _tmpC.copy(c).getHSL(_hsl);
    _tmpC.setHSL(_hsl.h, Math.min(1, _hsl.s * PED_SAT), Math.min(1, _hsl.l * PED_LIGHT));
    cols[vi * 3]     = Math.min(1, _tmpC.r * PED_BOOST);
    cols[vi * 3 + 1] = Math.min(1, _tmpC.g * PED_BOOST);
    cols[vi * 3 + 2] = Math.min(1, _tmpC.b * PED_BOOST);
  };
  if (geo.groups && geo.groups.length) {
    for (const g of geo.groups) {
      const c = mats[g.materialIndex]?.color || new THREE.Color(0.7, 0.7, 0.7);
      for (let k = g.start; k < g.start + g.count; k++) setCol(idx ? idx.getX(k) : k, c);
    }
  } else {
    const c = mats[0]?.color || new THREE.Color(0.7, 0.7, 0.7);
    for (let i = 0; i < n; i++) setCol(i, c);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  out.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  if (idx) out.setIndex(Array.from(idx.array));
  const nono = out.toNonIndexed();
  nono.computeVertexNormals();
  return nono;
}

/**
 * Walk-cycle FLIPBOOK: bake `frameCount` frames of the walk animation + one idle pose into static
 * vertex-coloured geometries. Pedestrians cycle through the frames → legs actually move, while each
 * frame is still an InstancedMesh (light). All frames share ONE scale + ground offset so the body
 * doesn't jitter. Returns { frames:[geo…], idle:geo, material }.
 */
export async function loadWalkFramesTemplate(url, targetHeight = 1.8, frameCount = 8) {
  const gltf = await _loader.loadAsync(url);
  const model = gltf.scene;
  const meshes = [];
  model.traverse((c) => { if (c.isMesh) meshes.push(c); });
  if (!meshes.length) throw new Error('no meshes ' + url);
  const walk = gltf.animations.find((a) => /walk/i.test(a.name)) || gltf.animations.find((a) => /run/i.test(a.name)) || gltf.animations[0];
  const idleClip = gltf.animations.find((a) => /idle/i.test(a.name)) || walk;
  // Collapsed pose for knocked-down pedestrians — a real death/hit/fall clip near its end reads as a
  // crumpled body on the ground, instead of the rigid standing plank we get from tumbling the idle pose.
  const fallClip = gltf.animations.find((a) => /death|dead|die|hit|faint|collapse|defeat|ko/i.test(a.name))
                || gltf.animations.find((a) => /roll|fall/i.test(a.name)) || null;
  const mixer = new THREE.AnimationMixer(model);

  function bakeAt(clip, time) {
    mixer.stopAllAction();
    if (clip) { const act = mixer.clipAction(clip); act.reset().play(); mixer.setTime(time); }
    model.updateMatrixWorld(true);
    for (const m of meshes) if (m.isSkinnedMesh && m.skeleton) m.skeleton.update();
    const geos = meshes.map((m) => bakePosedMesh(m)).filter(Boolean);
    return mergeGeometries(geos, false);
  }

  const dur = walk ? walk.duration : 0;
  const frames = [];
  for (let f = 0; f < frameCount; f++) frames.push(bakeAt(walk, (dur * f) / frameCount));
  const idle = bakeAt(idleClip, 0);
  // near the end of the fall/death clip = fully collapsed on the ground
  let fall = fallClip ? bakeAt(fallClip, fallClip.duration * 0.92) : null;

  // one shared scale + ground offset (from the idle reference) applied to every walk frame
  idle.computeBoundingBox();
  const bb = idle.boundingBox;
  const s = (bb.max.y - bb.min.y) > 0.001 ? targetHeight / (bb.max.y - bb.min.y) : 1;
  const tx = -(bb.min.x + bb.max.x) / 2, ty = -bb.min.y, tz = -(bb.min.z + bb.max.z) / 2;
  const fix = (g) => { if (!g) return g; g.scale(s, s, s); g.translate(tx * s, ty * s, tz * s); return g; };
  frames.forEach(fix); fix(idle);

  // Fall pose: same scale (consistent body size), but self-centred x/z and resting its lowest point on
  // y=0 — it's already lying down in the clip, so the renderer places it flat with a plain yaw (no PI/2 flip).
  if (fall) {
    fall.scale(s, s, s);
    fall.computeBoundingBox();
    const fb = fall.boundingBox;
    fall.translate(-(fb.min.x + fb.max.x) / 2, -fb.min.y, -(fb.min.z + fb.max.z) / 2);
  }

  // Small emissive floor so peds never fall to a black silhouette in shadow — kept LOW because a big flat
  // gray fill (was 0x343434) washed them into pale, desaturated ghosts in BOTH day and night, flattening
  // contrast. Now that night ambient is raised, a light floor is enough; real light does the lifting.
  const pedMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: new THREE.Color(0x111111) });
  return { frames, idle, fall, material: pedMat };
}

export async function loadPeopleWalkTemplates(basePath = '/models/people/', targetHeight = 1.8, frameCount = 8) {
  const out = [];
  for (const name of PEOPLE) {
    try { out.push(await loadWalkFramesTemplate(basePath + name + '.glb', targetHeight, frameCount)); }
    catch (e) { console.warn('[carModels] walk-frames load failed', name, e?.message || e); }
  }
  return out;
}
