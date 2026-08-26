/**
 * roadTexturePack.js — the authored road/pavement surfaces. v3 P3-07b / P3-08.
 *
 * Replaces two procedural canvas generators: `createAsphaltTexture` (an LCG grain field) and
 * `makePanotCanvas` (drawn flower geometry). Both stay in the tree as fallbacks and as the authoring
 * tools they always were — the panot generator in particular is still the better source if the
 * photographic plate is ever reframed, because the Flor de Barcelona is exact geometry.
 *
 * SPAN IS DECLARED, NOT ASSUMED. Every surface states how many real metres one repeat covers, and
 * the renderer uses that number. It is a physical claim about what the surface IS: the kerb granite
 * first shipped at a 1 m span and read as gravel, because the plate's ~1 cm speckle then WAS 1 cm of
 * stone. Asphalt is 4.0 m (matching the existing uAsphaltRepeatM), panot is 0.40 m because the plate
 * is a 2x2 of 20 cm tiles.
 */
import * as THREE from 'three';
import MANIFEST from './roadTextures.js';

const BASE = '/textures/road';
const _cache = new Map();
const _all = [];

function load(url, srgb) {
  const t = new THREE.TextureLoader().load(url);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;   // tiling surfaces, unlike the cutout atlases
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;   // roads are seen at the most grazing angle of anything in the game
  _all.push(t);
  return t;
}

/** `{ albedo, normal, spanM }` for a surface named in roadTextures.js. */
export function getRoadSurface(name) {
  if (_cache.has(name)) return _cache.get(name);
  const spec = MANIFEST.surfaces.find((s) => s.name === name);
  if (!spec) throw new Error(`[roadTexturePack] unknown surface "${name}"`);
  const pack = {
    albedo: load(`${BASE}/${name}_albedo.png`, true),
    normal: load(`${BASE}/${name}_normal.png`, false),
    spanM: spec.spanM,
    // Mean linear luminance. Needed wherever the plate is used as a MULTIPLIER rather than a base
    // albedo — divide by it and the texture modulates around 1.0 instead of darkening by ~9x.
    meanLuma: spec.meanLuma ?? 1.0,
    // Per-channel means. A scalar luma divisor leaves an unbalanced plate tinting whatever it
    // multiplies — asphalt_worn is red-heavy enough to turn the whole carriageway beige.
    meanRGB: spec.meanRGB ?? [1, 1, 1],
  };
  _cache.set(name, pack);
  return pack;
}

/**
 * Upload every road texture during boot.
 *
 * Same reason as the vegetation atlases: three uploads a texture AND generates its mip chain on the
 * frame that first draws it, and that frame is mid-drive. Measured on Gran Via before the vegetation
 * atlases were preloaded — `renderer.render()` burning 116-228 ms of CPU with the GPU at 6-7 ms.
 * Road textures are drawn on the very first frame of every drive, so they would land squarely in it.
 */
export function preloadRoadTextures(renderer) {
  if (!renderer?.initTexture) return;
  for (const t of _all) {
    const go = () => { try { renderer.initTexture(t); } catch { /* retry on draw */ } };
    if (t.image && t.image.width) go();
    else {
      let tries = 0;
      const poll = () => ((t.image && t.image.width) || tries++ > 200) ? go() : setTimeout(poll, 50);
      poll();
    }
  }
}
