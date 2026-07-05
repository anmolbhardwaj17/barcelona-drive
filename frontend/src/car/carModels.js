/**
 * Shared low-poly car-model loader (Kenney Car Kit, CC0) for traffic + parked cars.
 *
 * Each Kenney car GLB = a body + wheels sharing ONE texture-atlas material. loadCarTemplate merges
 * them into a single geometry, scales to a target length, orients the length axis to +Z, and recentres
 * so the wheels sit at y=0 and the car is centred in X/Z. Returns { geometry, material, dims } that can
 * feed an InstancedMesh (parked cars) or a plain Mesh clone (traffic) — geometry+material are shared,
 * so hundreds of cars stay cheap.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const _loader = new GLTFLoader();

// The normal city cars from the kit (skip tractors/karts/race/debris).
export const CITY_CARS = [
  'sedan', 'sedan-sports', 'suv', 'suv-luxury',
  'hatchback-sports', 'van', 'taxi', 'police', 'delivery',
];

// Clone + flatten a mesh's geometry to a merge-compatible set (position/normal/uv/color), baking a
// per-PART vertex colour: wheels → near-black, everything else → white (so a per-car tint colours the
// body but the tyres stay black regardless of the texture).
function prepGeo(src, isWheel) {
  let g = src.clone();
  if (g.index) g = g.toNonIndexed();
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

export async function loadCarTemplate(url, targetLength = 4.4) {
  const gltf = await _loader.loadAsync(url);
  const model = gltf.scene;
  model.updateMatrixWorld(true);
  const meshes = [];
  model.traverse((c) => { if (c.isMesh) meshes.push(c); });
  if (!meshes.length) throw new Error('no meshes in ' + url);

  const material = (meshes[0].material?.clone?.() || meshes[0].material);
  if (material) {
    if (material.map) material.map.colorSpace = THREE.SRGBColorSpace;
    if (material.color) material.color.setRGB(1, 1, 1); // white base so per-car tint shows
    if ('metalness' in material) material.metalness = 0.0;
    if ('roughness' in material) material.roughness = 0.85;
    material.vertexColors = true; // wheels black / body white baked in prepGeo
    material.needsUpdate = true;
  }
  const geos = [];
  for (const m of meshes) {
    const isWheel = /wheel/i.test(m.name);
    const g = prepGeo(m.geometry, isWheel);
    g.applyMatrix4(m.matrixWorld);
    geos.push(g);
  }
  let merged = mergeGeometries(geos, false);
  if (!merged) throw new Error('merge failed ' + url);

  // orient length → Z
  merged.computeBoundingBox();
  const size = new THREE.Vector3(); merged.boundingBox.getSize(size);
  if (size.x > size.z) { merged.rotateY(Math.PI / 2); merged.computeBoundingBox(); merged.boundingBox.getSize(size); }
  const nativeLen = Math.max(size.x, size.z);
  const scale = nativeLen > 0.001 ? targetLength / nativeLen : 1;
  // Non-uniform: slightly narrow + lower the chunky Kenney proportions so they read as cars, not blocks.
  merged.scale(scale * 0.95, scale * 0.82, scale);

  // recentre: wheels at y=0, centred in X/Z
  merged.computeBoundingBox();
  const bb = merged.boundingBox;
  merged.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  merged.computeBoundingBox();
  const s2 = new THREE.Vector3(); merged.boundingBox.getSize(s2);

  return { geometry: merged, material, dims: { w: s2.x, h: s2.y, l: s2.z } };
}

/** Load the whole city-car set (merged, for InstancedMesh). Returns templates (failures skipped). */
export async function loadCityCarTemplates(basePath = '/models/cars/', targetLength = 4.4) {
  const out = [];
  for (const name of CITY_CARS) {
    try { const t = await loadCarTemplate(basePath + name + '.glb', targetLength); t.name = name; out.push(t); }
    catch (e) { console.warn('[carModels] failed to load', name, e?.message || e); }
  }
  return out;
}

/**
 * Full-detail scene template (keeps the original textured materials → windows, head/tail lights, body
 * colour as authored). Returns { scene, dims }; clone scene per car. For traffic (few cars, no merge).
 * The returned `scene` origin sits at the wheel-base centre (place at (x, groundY, z), rotate about Y).
 */
// Shared glowing-light resources for traffic cars (one geometry + two materials for all clones).
let _headLightMat = null, _tailLightMat = null, _carLightGeo = null;
export function addCarLights(outer, dims) {
  if (!_carLightGeo) {
    _carLightGeo   = new THREE.PlaneGeometry(0.28, 0.14);
    _headLightMat  = new THREE.MeshBasicMaterial({ color: 0xfff4d8, side: THREE.DoubleSide, fog: true });
    _tailLightMat  = new THREE.MeshBasicMaterial({ color: 0xff2a12, side: THREE.DoubleSide, fog: true });
  }
  const { w, h, l } = dims;
  const y = h * 0.42;
  const add = (mat, x, z, ry) => {
    const m = new THREE.Mesh(_carLightGeo, mat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    m.castShadow = false; m.renderOrder = 2;
    m.userData.sharedGeometry = true; m.userData.sharedMaterial = true;
    outer.add(m);
  };
  add(_headLightMat, -w * 0.30, l * 0.49, 0);          // front-left  (white, faces +Z)
  add(_headLightMat,  w * 0.30, l * 0.49, 0);          // front-right
  add(_tailLightMat, -w * 0.30, -l * 0.49, Math.PI);   // rear-left   (red, faces -Z)
  add(_tailLightMat,  w * 0.30, -l * 0.49, Math.PI);   // rear-right
}

export async function loadCarSceneTemplate(url, targetLength = 3.8) {
  const gltf = await _loader.loadAsync(url);
  const inner = gltf.scene;
  inner.traverse((c) => {
    if (!c.isMesh) return;
    c.castShadow = true;
    if (c.material) {
      if (c.material.map) c.material.map.colorSpace = THREE.SRGBColorSpace;
      if ('metalness' in c.material) c.material.metalness = 0.0;
      if ('roughness' in c.material) c.material.roughness = 0.8;
    }
  });
  inner.updateMatrixWorld(true);
  let bb = new THREE.Box3().setFromObject(inner);
  let size = bb.getSize(new THREE.Vector3());
  if (size.x > size.z) { inner.rotateY(Math.PI / 2); inner.updateMatrixWorld(true); bb = new THREE.Box3().setFromObject(inner); size = bb.getSize(new THREE.Vector3()); }
  const nativeLen = Math.max(size.x, size.z);
  const scale = nativeLen > 0.001 ? targetLength / nativeLen : 1;

  const scaler = new THREE.Group();
  scaler.scale.set(scale * 0.95, scale * 0.82, scale); // match the merged-template proportions
  scaler.add(inner);
  const outer = new THREE.Group();
  outer.add(scaler);
  outer.updateMatrixWorld(true);
  const bb2 = new THREE.Box3().setFromObject(outer);
  const s2 = bb2.getSize(new THREE.Vector3());
  // recentre so outer's origin = wheel-base centre
  scaler.position.set(-(bb2.min.x + bb2.max.x) / 2, -bb2.min.y, -(bb2.min.z + bb2.max.z) / 2);
  // Glowing head/tail lights so traffic reads at night (outer is unscaled, origin = wheelbase centre;
  // car travels along +Z so +Z = front/white, -Z = rear/red). Emissive-basic → bright + blooms.
  addCarLights(outer, { w: s2.x, h: s2.y, l: s2.z });
  return { scene: outer, dims: { w: s2.x, h: s2.y, l: s2.z } };
}

export async function loadCitySceneTemplates(basePath = '/models/cars/', targetLength = 3.8) {
  const out = [];
  for (const name of CITY_CARS) {
    try { out.push(await loadCarSceneTemplate(basePath + name + '.glb', targetLength)); }
    catch (e) { console.warn('[carModels] scene load failed', name, e?.message || e); }
  }
  return out;
}

// ── Real low-poly people (Poly Pizza rigged GLBs) for pedestrians ──
// Rigged → baked to static walk-frames + idle (loadWalkFramesTemplate) so they can be instanced.
export const PEOPLE = ['man', 'woman-casual', 'woman-dress', 'punk', 'adventurer'];

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

  // Subtle emissive floor so pedestrians never fall into a dark/underexposed silhouette in shadow.
  const pedMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: new THREE.Color(0x343434) }); // a bit more self-fill so peds read at night without going flat
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
