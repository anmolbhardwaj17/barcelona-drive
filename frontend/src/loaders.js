/**
 * Shared GLTF loader factory. Our models use WebP textures (EXT_texture_webp), which GLTFLoader decodes
 * natively in any modern browser — no decoder setup needed. Geometry is left uncompressed on purpose:
 * meshopt/Draco quantization broke the car meshes, which are merged + matrix-transformed at load
 * (loadCarTemplate), and the geometry is a tiny fraction of the size anyway (textures were the real win).
 *
 * (KTX2 GPU-texture support may be added here in a later optimization phase.)
 */
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export function makeGLTFLoader() {
  return new GLTFLoader();
}
