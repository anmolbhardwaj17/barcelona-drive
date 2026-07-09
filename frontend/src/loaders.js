/**
 * Shared GLTF loader factory. Wires the meshopt decoder so our compressed models (EXT_meshopt_compression)
 * load. WebP textures (EXT_texture_webp) are decoded natively by GLTFLoader in any modern browser — no extra
 * setup. Uncompressed GLBs still load fine (the decoder is only invoked when the extension is present).
 *
 * (KTX2 GPU-texture support will be added here in the next optimization phase.)
 */
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

export function makeGLTFLoader() {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}
