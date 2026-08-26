/**
 * cardMesh.js — the crossed-quad card, shared by trees (P3-10) and bushes.
 *
 * WHY SHARED. A bush card and a tree card are the same object at different scales: two quads crossed
 * at 90°, standing on y=0, UV'd to the opaque sub-rect of an atlas cell, with dome normals so a flat
 * quad shades like a volume. Three separate things in this file took several rounds to get right —
 * the contentUV sizing, the dome normal, and cancelling three's double-sided normal flip — and a
 * second copy would carry none of the fixes. The Python side learned this twice already
 * (cardAtlas.py, assembleRings).
 */
import * as THREE from 'three';

// Where the canopy mass sits, as a fraction of card height — the origin of the dome normals.
const CANOPY_CENTRE_Y = 0.62;
// How much the dome is pulled back toward straight up. Pure radial makes the lower card face
// downward and read as dead shadow; this keeps the underside lit like foliage rather than a floor.
const DOME_UP_BIAS = 0.35;

export const CARD_GEOMETRY_CONSTANTS = { CANOPY_CENTRE_Y, DOME_UP_BIAS };

/**
 * One species' card: two quads crossed at 90°, standing on y=0, centred on the trunk.
 * 8 vertices, 4 triangles.
 *
 * SIZE. Height is `heightM`; width is `heightM × aspect` — the image's OWN proportions, not the
 * authored canopy width, because a stretched canopy is the most obvious card artefact there is.
 * UVs come from `contentUV`, the OPAQUE sub-rect of the cell: map the whole cell instead and the
 * transparent packing margin scales into the quad, so a card sized to heightM draws visibly shorter
 * than heightM.
 */
export function buildCardGeometry(species) {
  const h = species.heightM;
  const w = h * species.aspect;
  const hw = w / 2;
  const [u0, v0, du, dv] = species.contentUV;

  const pos = [], nrm = [], uv = [], idx = [];
  const cy = h * CANOPY_CENTRE_Y;

  // corners as (across, up) with `across` mapped onto X for one quad and Z for the other
  const corners = [[-hw, 0], [hw, 0], [hw, h], [-hw, h]];
  const uvs = [[u0, v0], [u0 + du, v0], [u0 + du, v0 + dv], [u0, v0 + dv]];

  for (let q = 0; q < 2; q++) {
    const base = q * 4;
    for (let c = 0; c < 4; c++) {
      const [a, y] = corners[c];
      const x = q === 0 ? a : 0;
      const z = q === 0 ? 0 : a;
      pos.push(x, y, z);

      // Dome normal: radiate from the canopy centre, then bias back toward up.
      let nx = x, ny = y - cy, nz = z;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      ny += DOME_UP_BIAS;
      const l2 = Math.hypot(nx, ny, nz) || 1;
      nrm.push(nx / l2, ny / l2, nz / l2);

      uv.push(uvs[c][0], uvs[c][1]);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  // The pools allocate from these bounds; a card that sways must still be inside them.
  geo.computeBoundingSphere();
  geo.userData.species = species.name;
  return geo;
}

/** Load an atlas pair with the filtering every card atlas needs. */
export function loadCardAtlas(albedoUrl, normalUrl) {
  const loader = new THREE.TextureLoader();
  // Loaded async, assigned NOW: three fills the image in later and simply re-uploads. It does not
  // recompile the program, because the map/normalMap slots are already declared on the material —
  // which is what keeps this clear of G-53 (no shader churn after the boot warm-up).
  const albedo = loader.load(albedoUrl);
  albedo.colorSpace = THREE.SRGBColorSpace;
  const normal = loader.load(normalUrl);
  normal.colorSpace = THREE.NoColorSpace;   // a normal map is data, not colour
  for (const t of [albedo, normal]) {
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;   // an atlas must never wrap into its neighbour
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = 4;                                 // canopies are viewed at grazing angles
  }
  _allCardTextures.push(albedo, normal);
  return { albedo, normal };
}

// Every atlas handed out by loadCardAtlas, so boot can force their upload before the drive starts.
const _allCardTextures = [];

/**
 * Upload every vegetation atlas to the GPU during boot.
 *
 * WHY THIS EXISTS. Atlases load asynchronously, so three uploads each one — and GENERATES ITS MIP
 * CHAIN — on whatever frame first draws it. That frame is mid-drive, and for a 3072x2048 page it is
 * enormous. Measured on Gran Via: `renderer.render()` burning 116-228 ms of CPU while the GPU sat
 * at 6-7 ms, with only ~400 draw calls and ~1M triangles in flight. Draw calls and triangles that
 * low with the GPU that idle cannot be a rendering cost; it is the CPU stalling on uploads.
 *
 * `renderer.initTexture` does that work now instead. Awaiting the image first matters: calling it
 * before the texture has data is a no-op, and the stall simply happens later as before.
 */
export function preloadCardAtlases(renderer) {
  if (!renderer?.initTexture) return Promise.resolve(0);
  const waits = _allCardTextures.map((t) => new Promise((resolve) => {
    const go = () => { try { renderer.initTexture(t); } catch { /* context lost — retry on draw */ } resolve(); };
    if (t.image && t.image.width) go();
    else {
      const src = t.source;
      let tries = 0;
      const poll = () => {
        if ((t.image && t.image.width) || tries++ > 200) go();
        else setTimeout(poll, 50);
      };
      void src; poll();
    }
  }));
  return Promise.all(waits).then(() => _allCardTextures.length);
}
