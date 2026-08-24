/**
 * loaders.js — THE asset registry (v3 P1-01).
 *
 * Before v3 this was `return new GLTFLoader()`: a fresh loader per call, five live consumers, no
 * KTX2, no Meshopt, and sampler settings (anisotropy, wrap, colorSpace, flipY) applied ad hoc at
 * ~48 call sites. Naive KTX2 wiring would have made that worse — a transcoder fetch and a worker
 * pool PER LOADER.
 *
 * Now: ONE KTX2Loader, ONE MeshoptDecoder, injected into every GLTFLoader; one promise-cached
 * texture fetch; one place that owns sampler policy.
 *
 * ⚠ `initAssetRegistry(renderer)` MUST be called once, after the renderer exists and before any
 * asset loads. KTX2Loader cannot choose a transcode target without `detectSupport()`.
 */
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import * as THREE from 'three';

const TRANSCODER_PATH = '/basis/';   // vendored from three/examples/jsm/libs/basis (576 KB, unhashed)

let _ktx2 = null;
let _renderer = null;
let _maxAniso = 1;

/**
 * Call ONCE after the renderer is created.
 *
 * Anisotropy is read here rather than guessed: it is a hardware limit, and the tiling world
 * surfaces P3 introduces are viewed at extreme grazing angles from a car, which is exactly the case
 * anisotropic filtering exists for. Without it, road texture turns to mush ~20 m ahead of the bumper.
 */
export function initAssetRegistry(renderer) {
  if (_renderer) return;
  _renderer = renderer;
  _maxAniso = renderer.capabilities.getMaxAnisotropy?.() ?? 1;
  _ktx2 = new KTX2Loader().setTranscoderPath(TRANSCODER_PATH).detectSupport(renderer);
  console.warn('[assets] registry ready — max anisotropy %d, KTX2 transcoder %s', _maxAniso, TRANSCODER_PATH);
}

/**
 * ⚠ THE BC7-vs-BC1 QUESTION (v3 budget, unresolved on purpose — do not flip this blind).
 *
 * three ranks BC7 above BC1 for ETC1S content (KTX2Loader FORMAT_OPTIONS: bptc priorityETC1S 3,
 * dxt 4). So on a BC platform (Windows/NVIDIA) an all-ETC1S library transcodes to BC7 at **8 bpp** —
 * UASTC-tier memory for ETC1S-tier quality — while this Mac gets ETC2 at 4 bpp. That is the
 * difference between ~160 MiB and ~300 MiB against a 200 MiB cap.
 *
 * FORMAT_OPTIONS lives inside the KTX2Loader WORKER BODY and is not exported, so it cannot be
 * patched from here. The only main-thread lever is to tell the worker BC7 is unsupported. That
 * works for ETC1S — but it also drops UASTC to BC1 (priority 2 → 5), which IS a real quality loss
 * on the few maps that would justify UASTC (foliage atlases, hero facades).
 *
 * Left OFF until there are assets to measure and a BC machine to measure them on. Flipping a
 * quality switch before either exists would be guessing.
 */
export function setPreferBC1ForETC1S(on) {
  if (!_ktx2) return false;
  const cfg = _ktx2.workerConfig;
  if (!cfg) return false;
  cfg.bptcSupported = !on;
  console.warn('[assets] BC7 %s — ETC1S will transcode to %s', on ? 'DISABLED' : 'enabled', on ? 'BC1 (4bpp)' : 'BC7 (8bpp)');
  return true;
}

/** GLTFLoader with KTX2 + Meshopt wired in. Same signature as before, so consumers are unchanged. */
export function makeGLTFLoader() {
  const loader = new GLTFLoader();
  if (_ktx2) loader.setKTX2Loader(_ktx2);
  // Meshopt, not Draco: it is a bundled ESM decoder (no extra file to serve, no second worker pool)
  // and it also compresses animation buffers, which are 21-31% of the people GLBs. Compress with
  // `gltfpack -cc` and NOT -vp/-vt — the recorded car regression was quantization, not the codec.
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

// ── Texture cache ──────────────────────────────────────────────────────────────────────────────
const _texCache = new Map();   // url -> Promise<Texture>

/**
 * Load a .ktx2 texture, cached by URL so the same map shared across renderers is fetched,
 * transcoded and uploaded exactly once.
 *
 * @param {string} url
 * @param {{srgb?: boolean, tiling?: boolean, aniso?: number}} opts
 *   srgb   — TRUE for albedo/colour, FALSE for normal/AO/roughness/mask. Getting this wrong is
 *            silent: three reads the transfer function off the KTX2 DFD and `verifyColorSpace`
 *            early-returns for compressed textures, so a mislabelled normal map just looks subtly
 *            wrong forever.
 *   tiling — RepeatWrapping vs ClampToEdge.
 */
export function getKTX2Texture(url, opts = {}) {
  if (_texCache.has(url)) return _texCache.get(url);
  if (!_ktx2) return Promise.reject(new Error('[assets] initAssetRegistry(renderer) not called yet'));
  const p = _ktx2.loadAsync(url).then((tex) => applySamplerPolicy(tex, opts));
  _texCache.set(url, p);
  return p;
}

/** The ONE place sampler state is decided. Never set these at a call site. */
export function applySamplerPolicy(tex, { srgb = true, tiling = true, aniso } = {}) {
  if (!tex) return tex;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = tiling ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.anisotropy = Math.min(aniso ?? 8, _maxAniso);
  // NOTE: flipY is deliberately NOT touched for compressed textures — WebGL ignores
  // UNPACK_FLIP_Y_WEBGL for them, so it must be handled at ENCODE time, not here.
  tex.needsUpdate = true;
  return tex;
}

/** Diagnostics for the metrics panel / benchmark. */
export function getAssetStats() {
  return { cachedTextures: _texCache.size, maxAnisotropy: _maxAniso, ktx2Ready: !!_ktx2 };
}

/** Free a cached texture (tile unload must NOT call this — library textures are city-wide). */
export function disposeKTX2Texture(url) {
  const p = _texCache.get(url);
  if (!p) return;
  _texCache.delete(url);
  p.then((t) => t?.dispose()).catch(() => {});
}
