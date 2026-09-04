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
import { pickPedClips } from './pedClips.js';
import { makeGLTFLoader } from '../loaders.js';
import { registerMaterial } from '../map/materialRegistry.js';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { onCarEnvMap } from './carModel.js';   // V-2 — traffic reflects the same sky

const _loader = makeGLTFLoader();

/** Every canonical car geometry is built at this length; consumers scale from it. */
export const CANON_LENGTH = 4.0;

export const CAR_KIT_PATH = '/models/cars/';

// The normal city cars from the kit (skip tractors/karts/race/debris).
// ── THE FLEET IS THE AUTHORED HATCHBACK, FOR NOW (V-5) ────────────────────────────────────────
// User: "lets have all hatchback for now remove old one and leave rest". The nine kit models stay
// ON DISK — nothing is deleted — they are simply not in the fleet. Put a name back in this list and
// it returns; that is the whole mechanism.
//
// Variety now comes from PAINT rather than from shape (BODY_COLORS in carFleet.js), which is closer
// to a real street anyway: a Barcelona block is mostly the same handful of hatchbacks in different
// colours. More authored bodies join this list as they arrive — taxi, van, sedan.
export const CITY_CARS = ['hatchback-euro'];

/** Kit models kept on disk and out of the fleet. Restore by moving a name into CITY_CARS. */
export const RETIRED_KIT_CARS = [
  'sedan', 'sedan-sports', 'suv', 'suv-luxury',
  'hatchback-sports', 'van', 'taxi', 'police', 'delivery',
];

// ⚠ The shared material is built from the SEDAN, deliberately, even though it is no longer in the
// fleet. WHITE_UV below is a texel measured in the SEDAN's atlas, and every authored car's UVs are
// pinned to it — so if the material came from CITY_CARS[0] (now the hatchback, with its own
// unrelated atlas) those coordinates would land on some arbitrary swatch and paint the whole fleet
// that colour. The atlas this material carries must stay the one WHITE_UV was measured against.
const KIT_MATERIAL_SOURCE = 'sedan';

// ── AUTHORED CARS RIDE THE SHARED MATERIAL WITHOUT ITS ATLAS (V-4) ────────────────────────────
// Every car in the world shares ONE BatchedMesh and therefore ONE material, built from
// CITY_CARS[0]. A model brought in from outside the kit has its own UV layout, so left alone it
// samples the SEDAN's colour atlas through unrelated coordinates and renders as garbage — the real
// blocker behind "can traffic look like the BMW", and it is not fixed by better art.
//
// A second BatchedMesh would mean splitting instance allocation across two pools in both the
// traffic and parked-car systems. Not needed: `aPart` already ASSIGNS the colour of glass, lamps,
// rubber, chrome and cabin in the shader, so an authored car does not want the atlas at all — it
// only needs the map to get out of the way.
//
// So its UVs are pinned to a texel that is pure white. Measured, not guessed: the kit atlas is
// 512x512 and has an all-white block of radius 12 px centred at (402,370), which stays white down
// to mip level 4 — so bilinear filtering and mipmapping cannot bleed a neighbouring swatch in.
// White multiplies to nothing, leaving vertex colour (the per-car tint) and aPart doing the work.
const AUTHORED_CARS = new Set(['hatchback-euro']);

/**
 * Does every car in the fleet carry REAL lamp geometry?
 *
 * The kit models have none — their lights are painted into the colour atlas — so both car systems
 * overlay head/tail QUADS from `createLightPool` to fake them. On an authored model those quads sit
 * on top of real, modelled lamps and read as cubes stuck to the bodywork (user, first drive with
 * the hatchback in). When the whole fleet is authored the overlay is not just redundant, it is the
 * defect, so the systems skip it and the `aPart` LIGHT branch lights the real geometry instead.
 */
export function fleetHasRealLights() {
  return CITY_CARS.every((n) => AUTHORED_CARS.has(n));
}
// ⚠ V IS MEASURED FROM THE TOP. glTF textures load with `flipY = FALSE` in three, unlike textures
// three loads itself — so v = y/height, NOT 1 - y/height. The first version used the bottom-left
// convention and pinned every authored car to pixel (402,141), which is (206, 84, 80): a dusty
// RED. The whole fleet was multiplied by it — white paint became maroon, dark paint near-black —
// and the user reported exactly "only black or maroonish or red cars".
//
// The colour census is what found it. `setColorAt applied 2315 times, 9 distinct` including 464
// cars told to be WHITE proved the palette and the tint path were both correct, which moved the
// search downstream to the texel. Three rounds of reasoning had not got there.
const WHITE_UV = [0.78516, 0.72266];   // = (402/512, 370/512), top-down v — verified (255,255,255)

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
 * Built from KIT_MATERIAL_SOURCE rather than "whichever template resolved first" so the result does
 * not depend on network ordering — and specifically NOT from CITY_CARS[0], see the note there. Registered with the material registry so the boot warm-up compiles
 * its USE_BATCHING / USE_INSTANCING variants instead of letting the first car on screen do it
 * mid-drive (the `programs.length` delta gate).
 */
function getKitMaterial() {
  if (_kitMatPromise) return _kitMatPromise;
  _kitMatPromise = loadGLTF(CAR_KIT_PATH + KIT_MATERIAL_SOURCE + '.glb').then((gltf) => {
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
    // ── SHADE BY PART, STILL ONE DRAW (V-3) ──────────────────────────────────────────────────
    // `aPart` is baked per vertex in prepGeo. Without this patch it is inert data and a dropped-in
    // model renders body paint on its glass.
    //
    // ⚠ Declares its OWN varying rather than reusing three's. `vColor` exists only under
    // USE_COLOR and `vMapUv` only under USE_MAP — D-30 cost a drive when a patch assumed one of
    // those was present. This one compiles whether or not the fleet material ends up with a map.
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPart;\nvarying float vPart;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPart = aPart;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vPart;')
        // Real lamps EMIT. Applied at emissivemap_fragment because that is where
        // totalEmissiveRadiance exists; doing it in color_fragment would only tint the albedo.
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vPart > 1.5 && vPart < 2.5) totalEmissiveRadiance += vec3(0.34, 0.31, 0.26);
        else if (vPart > 5.5 && vPart < 6.5) totalEmissiveRadiance += vec3(0.30, 0.020, 0.012);
        else if (vPart > 6.5) totalEmissiveRadiance += vec3(0.26, 0.115, 0.010);`)
        .replace('#include <color_fragment>', `#include <color_fragment>
        // 1 glass · 2 light · 3 tyre · 4 chrome. Compared with a tolerance because the value is
        // interpolated across the triangle even when every vertex agrees.
        if (vPart > 0.5 && vPart < 1.5) {
          // Dark, slightly blue: a car window reads as a hole with a sky sheen, never as paint.
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.055, 0.065, 0.085), 0.88);
        } else if (vPart > 5.5 && vPart < 6.5) {
          // Tail lamps. Deep red lens, and RED emissive — a white-emitting tail light is the single
          // most obvious tell that a car is faked.
          diffuseColor.rgb = vec3(0.42, 0.045, 0.035);
        } else if (vPart > 6.5) {
          // Indicators: amber.
          diffuseColor.rgb = vec3(0.62, 0.30, 0.03);
        } else if (vPart > 1.5 && vPart < 2.5) {
          // Lamp lenses stay bright at any angle so traffic reads at distance. Diffuse alone is not
          // enough — a Lambert surface facing away from the sun goes dark, and headlights that
          // vanish when a car turns are worse than painted-on ones. The emissive add below is what
          // makes them read, and what bloom picks up at night.
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.95, 0.93, 0.86), 0.6);
        } else if (vPart > 2.5 && vPart < 3.5) {
          // Rubber: near-black and, crucially, NOT tinted by the per-car body colour.
          diffuseColor.rgb = vec3(0.045);
        } else if (vPart > 3.5 && vPart < 4.5) {
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.63, 0.66), 0.75);
        } else if (vPart > 4.5) {
          // Cabin. Seen THROUGH the glass, so a body-coloured interior is the giveaway that a car
          // is a painted shell — and it is never tinted by the per-car paint colour.
          diffuseColor.rgb = vec3(0.075, 0.072, 0.068);
        }`);
    };
    // Distinct key or three reuses a program compiled WITHOUT this patch — the same cache-key trap
    // roofArray documents.
    material.customProgramCacheKey = () => 'cityCarParts-v1';
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
// ── PART IDS: REAL MATERIALS INSIDE ONE DRAW CALL (V-3) ───────────────────────────────────────
// Every car in the world, traffic and parked, lives in ONE BatchedMesh with ONE material — that is
// what took the fleet from 41 draw calls to 1, and a BatchedMesh cannot have per-part materials.
// So a better car model dropped in today would render with body paint on its windows.
//
// The fix is the trick this codebase already uses twice: facades and roofs carry a per-VERTEX
// attribute and a shader patch selects behaviour from it. Cars now carry `aPart`, so glass, lights,
// tyres and chrome shade differently while still costing one draw.
//
// Classification reads the MESH name and the MATERIAL name, because GLB exporters disagree about
// which one carries the meaning. The current Kenney-style kit names meshes but has a single
// `colormap` material, so only wheels separate — the point of this is that a model with real
// material names (the hero M3 has CarPaint / Window / RearLight / Rims / Tires) classifies fully
// and drops straight in. See R5 in docs/context/asset-requests.md.
export const PART = { BODY: 0, GLASS: 1, LIGHT: 2, TYRE: 3, CHROME: 4, INTERIOR: 5,
                      TAIL: 6, SIGNAL: 7 };

// ── THE NAMES ARE NOT IN ENGLISH, AND THAT IS NOT AN EDGE CASE ────────────────────────────────
// First real model tested against this classifier — a Turkish-authored hatchback — matched 5 of its
// 14 materials. The miss that mattered: **`CAM` is Turkish for GLASS**, so the windscreen would
// have rendered as body paint. That is precisely the failure `aPart` was built to prevent, and it
// would have looked like the whole feature was broken.
//
// Free car models come from everywhere, so the vocabulary is multilingual by necessity: Turkish
// (cam, far, lastik, jant, ayna), Russian (okna, kuzov, kolesa, steklo, zerkalo), Spanish, German,
// French, Italian. Cheap to add, and each term is one more model that drops in without code.
//
// ⚠ ORDER MATTERS: LIGHT is tested BEFORE GLASS. `ÖNFARCAM` is a headlight LENS — it contains both
// "far" (light) and "cam" (glass) — and it should read bright, not as a dark window. Testing glass
// first would darken every lamp lens on the car.
// `far(?!be)` and not `\bfar`: Turkish compounds run the words together — `önfarışıkları`,
// `ÖNFARCAM` — so a word boundary never matches, and those are a headlight and a headlight
// LENS. The lookahead excludes German `farbe` (paint), the one plausible false positive.
const RE_LIGHT  = /light|lamp|headlamp|blinker|indicator|far(?!be)|lamba|sinyal|fener|svet|luz|licht|phare/;
const RE_GLASS  = /glass|window|windscreen|windshield|transparent|\bcam\b|camlar|okna|steklo|vidrio|glas|scheibe|verre|vetro/;
const RE_TYRE   = /tyre|tire|rubber|lastik|kolesa|shina|rueda|reifen|pneu|goma/;
const RE_CHROME = /rim|chrome|metal|trim|exhaust|mirror|jant|ayna|disk|krom|zerkalo|espejo|spiegel|grill|izgara|bumper/;
const RE_INNER  = /interior|salon|cabin|seat|koltuk|sitze|dashboard|dash\b/;

// ── A LAMP IS NOT JUST A LAMP (V-9) ───────────────────────────────────────────────────────────
// The first version collapsed every lamp into one LIGHT class and painted them all warm white, so
// traffic drove around with WHITE tail lights — user-reported, and obviously wrong next to the
// player's car, which has proper red ones because its GLB keeps its own materials.
//
// The information was there all along and I threw it away: the model separates `rearlight`,
// `frontlight` and `sinyal`. Tested BEFORE the general light pattern, most specific first, or
// `rearlight` matches "light" and lands in the white bucket.
const RE_TAIL   = /tail|rear\s*(light|lamp)|(light|lamp)\s*rear|rearlight|arka|brake\s*light|stop\s*lamp/;
const RE_SIGNAL = /signal|sinyal|blinker|indicator|turn\s*(light|lamp)|amber/;

function classifyPart(meshName, matName) {
  const n = `${meshName || ''} ${matName || ''}`.toLowerCase();
  if (RE_SIGNAL.test(n)) return PART.SIGNAL;    // most specific first
  if (RE_TAIL.test(n)) return PART.TAIL;
  if (RE_LIGHT.test(n)) return PART.LIGHT;      // before GLASS — see the order note above
  if (RE_GLASS.test(n)) return PART.GLASS;
  if (RE_TYRE.test(n)) return PART.TYRE;
  if (RE_CHROME.test(n)) return PART.CHROME;
  if (RE_INNER.test(n)) return PART.INTERIOR;
  // `wheel` last: it matches whole wheel assemblies where rim and tyre are one mesh, and the tyre
  // is the larger, more visible half of that.
  if (/wheel/.test(n)) return PART.TYRE;
  return PART.BODY;
}

function prepGeo(src, isWheel, keepIndex, part = PART.BODY, authored = false) {
  let g = src.clone();
  if (g.index && !keepIndex) g = g.toNonIndexed();
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.position.count;
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  if (authored) {
    // Overwrite, not fill-if-missing: an authored model HAS UVs, and they point into its own atlas.
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { uv[i * 2] = WHITE_UV[0]; uv[i * 2 + 1] = WHITE_UV[1]; }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  const cv = isWheel ? 0.03 : 1.0;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) col[i] = cv;
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // Per-vertex, not per-face: the id is constant across a part, so it survives shared vertices and
  // the geometry can stay INDEXED. Keeping the index matters — `toNonIndexed` takes the kit from
  // 31,887 to 59,106 vertices, on the largest instanced population in the scene.
  const parts = new Float32Array(n);
  parts.fill(part);
  g.setAttribute('aPart', new THREE.BufferAttribute(parts, 1));
  return g;
}

/** Build (once per URL) the merged, canonically-scaled, recentred geometry for one car. */
function getCanonicalGeometry(url) {
  let p = _canonCache.get(url);
  if (p) return p;
  const isAuthored = AUTHORED_CARS.has((url.split('/').pop() || '').replace('.glb', ''));
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
      const g = prepGeo(m.geometry, /wheel/i.test(m.name), keepIndex,
                        classifyPart(m.name, m.material?.name), isAuthored);
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
    // ── THE KENNEY SQUASH IS FOR KENNEY MODELS ONLY (V-10) ──────────────────────────────────
    // This non-uniform correction exists because the kit's proportions are deliberately chunky —
    // narrowing to 0.95 and LOWERING TO 0.82 is what makes those blocks read as cars. Applied to a
    // model that already has real proportions it does the opposite: it flattens it.
    //
    // Measured on the authored hatchback (true world bbox, via Blender, so node transforms are
    // included): 1 : 0.493 : 0.337, which at 4.30 m long is 2.12 W x 1.45 H — within centimetres of
    // the player's M3 at 2.18 x 1.47. The squash took that 1.45 down to 1.19, a 19% height deficit
    // against the car parked beside it, and the user saw it immediately: "do you see car size
    // difference".
    //
    // Same shape as the white-texel bug and the lamp quads: a correction built for the kit, applied
    // blindly to a model that does not need it. An authored car is scaled UNIFORMLY and keeps the
    // proportions it was modelled with.
    if (isAuthored) merged.scale(scale, scale, scale);
    else merged.scale(scale * 0.95, scale * 0.82, scale);

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
  // ── SHADING: creased, not flat ────────────────────────────────────────────────────────────────
  // `toNonIndexed()` + `computeVertexNormals()` gives every triangle its own normal, i.e. FLAT
  // shading. On a 1,786-2,776 triangle human that is the whole reason they read as origami: the
  // model is not especially low-poly for a background crowd, it was being lit as if it were faceted
  // on purpose. `toCreasedNormals` averages normals across edges under the crease angle and keeps
  // the hard ones, so a cheek and a shoulder round off while a collar, a cuff and a shoe sole stay
  // sharp. Same triangles, same draw calls, same memory — only the normal attribute changes.
  return toCreasedNormals(out, PED_CREASE_ANGLE);
}

// 55°: above a jacket seam, below the angle between a torso facet and an arm facet. At 60° (the
// helper's default) the shoulders bled into the arms; below ~45° the head goes back to faceted.
const PED_CREASE_ANGLE = (55 * Math.PI) / 180;

/**
 * Walk-cycle FLIPBOOK: bake `frameCount` frames of the walk animation + one idle pose into static
 * vertex-coloured geometries. Pedestrians cycle through the frames → legs actually move, while each
 * frame is still an InstancedMesh (light). All frames share ONE scale + ground offset so the body
 * doesn't jitter. Returns { frames:[geo…], run:[geo…], idle:geo, stand:geo, fall:geo, material }.
 * `run` and `stand` are empty/null on a file that has no such clip — the caller falls back.
 */
export async function loadWalkFramesTemplate(url, targetHeight = 1.8, frameCount = 8) {
  const gltf = await _loader.loadAsync(url);
  const model = gltf.scene;
  const meshes = [];
  model.traverse((c) => { if (c.isMesh) meshes.push(c); });
  if (!meshes.length) throw new Error('no meshes ' + url);
  // P-3: clip choice lives in pedClips.js so it can be tested without three.js or a 4 MB GLB. It
  // also documents the clips that are deliberately NOT baked (Sitting has nothing to sit on).
  // `fallClip` is the collapsed pose for knocked-down pedestrians: a real death/hit/fall clip near
  // its end reads as a crumpled body, instead of the rigid standing plank a tumbled idle pose gives.
  const { walk, idle: idleClip, run: runClip, stand: standClip, fall: fallClip } = pickPedClips(gltf.animations);
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
  // YIELD between frames. Each bake is a full re-skin + creased-normal pass over the whole character,
  // and there are now `frameCount` of them per variant; done in one synchronous loop that is a single
  // multi-hundred-millisecond frame during load. Nothing waits on these — the crowd appears when it
  // appears — so paying a macrotask per frame costs nothing and keeps the hitch out of the loop.
  for (let f = 0; f < frameCount; f++) {
    frames.push(bakeAt(walk, (dur * f) / frameCount));
    if (f % 2 === 1) await new Promise((r) => setTimeout(r, 0));
  }
  const idle = bakeAt(idleClip, 0);
  // Run: fewer frames than the walk on purpose. A run cycle is roughly half the duration, so 8
  // frames is a comparable sample rate for a third of the bake cost and a third of the meshes.
  const RUN_FRAMES = 8;
  const run = [];
  if (runClip) {
    for (let f = 0; f < RUN_FRAMES; f++) {
      run.push(bakeAt(runClip, (runClip.duration * f) / RUN_FRAMES));
      if (f % 2 === 1) await new Promise((r) => setTimeout(r, 0));
    }
  }
  const stand = standClip ? bakeAt(standClip, standClip.duration * 0.35) : null;
  // near the end of the fall/death clip = fully collapsed on the ground
  let fall = fallClip ? bakeAt(fallClip, fallClip.duration * 0.92) : null;

  // one shared scale + ground offset (from the idle reference) applied to every walk frame
  idle.computeBoundingBox();
  const bb = idle.boundingBox;
  const s = (bb.max.y - bb.min.y) > 0.001 ? targetHeight / (bb.max.y - bb.min.y) : 1;
  const tx = -(bb.min.x + bb.max.x) / 2, ty = -bb.min.y, tz = -(bb.min.z + bb.max.z) / 2;
  const fix = (g) => { if (!g) return g; g.scale(s, s, s); g.translate(tx * s, ty * s, tz * s); return g; };
  frames.forEach(fix); fix(idle); run.forEach(fix); fix(stand);

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
  return { frames, run, idle, stand, fall, material: pedMat };
}

export async function loadPeopleWalkTemplates(basePath = '/models/people/', targetHeight = 1.8, frameCount = 8) {
  const out = [];
  for (const name of PEOPLE) {
    try { out.push(await loadWalkFramesTemplate(basePath + name + '.glb', targetHeight, frameCount)); }
    catch (e) { console.warn('[carModels] walk-frames load failed', name, e?.message || e); }
  }
  return out;
}
