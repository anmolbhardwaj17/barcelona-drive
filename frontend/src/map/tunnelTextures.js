/**
 * tunnelTextures.js — the tunnel lining surface. v3 P4-18.
 *
 * ── WHY GENERATED AND NOT AUTHORED ────────────────────────────────────────────────────────────
 * `public/textures/` carries road, wall, sky, vegetation, railway and water packs. There is no
 * tunnel pack, and `terrain/` holds nothing but a README — so a lining plate would have to be a new
 * authored asset, and the art budget (§0: <=24 MB total) is not the place to spend on a surface the
 * player sees only inside two corridors. A Barcelona road tunnel is ceramic tile on a grid, which is
 * exact geometry rather than photography: the same argument roadTexturePack makes for the panot
 * generator being the better source for the Flor de Barcelona. So it is drawn, not shot.
 *
 * ── SPAN IS DECLARED, NOT ASSUMED ─────────────────────────────────────────────────────────────
 * `TILE_M` states the real size of one ceramic tile and `SPAN_M` the metres covered by one texture
 * repeat. `buildQuad` emits UVs IN METRES, so a material divides by the span and nothing anywhere
 * guesses a scale. Getting this wrong is not subtle — roadTexturePack records the kerb granite
 * shipping at a 1 m span and reading as gravel, because at that span its ~1 cm speckle WAS 1 cm.
 *
 * ── THE NORMAL MAP IS DERIVED FROM THE SAME DRAW ──────────────────────────────────────────────
 * Grout lines are recessed, so the normal map is generated from the albedo's own luminance rather
 * than hand-authored: the grooves land exactly where the grout was drawn and cannot drift out of
 * register with it. Tangent-space, +Y up (three.js convention).
 */
import * as THREE from 'three';

/** Real size of one ceramic tile, metres. Barcelona tunnel tile is ~20 cm. */
const TILE_M = 0.2;
/** Tiles per texture repeat. 10 x 10 tiles => a 2 m span at 512px = ~51 px per tile. */
const TILES_PER_SPAN = 10;
/** Metres covered by one repeat of this texture. */
export const LINING_SPAN_M = TILE_M * TILES_PER_SPAN;

const TEX_PX = 512;

let _albedo = null;
let _normal = null;
let _concreteAlbedo = null;
let _concreteNormal = null;

/**
 * Board-formed concrete. Metres per repeat.
 *
 * NOT `wall_01.ktx2`, which already exists and would have been free: that plate is the MASONRY
 * boundary wall `barrierRenderer` draws on compound walls. A road trench and a tunnel portal are
 * board-formed concrete — poured against timber shuttering, so horizontal board seams and rows of
 * tie-holes, not coursed stone. Reusing the masonry plate is the cheap wrong answer, and the Ronda
 * trench wall is the surface directly beside the spawn.
 */
export const CONCRETE_SPAN_M = 2.4;
/** Height of one form board, metres — 8 boards to the 2.4 m span. */
const BOARD_M = 0.3;

/** Deterministic value noise — no Math.random, so the lining is identical every load. */
function hash2(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function drawAlbedo() {
  const c = document.createElement('canvas');
  c.width = c.height = TEX_PX;
  const g = c.getContext('2d');
  const px = TEX_PX / TILES_PER_SPAN;      // pixels per tile
  const grout = Math.max(1, Math.round(px * 0.06));

  // Grout bed. Everything else is drawn on top of it, so the lines need no separate stroke pass.
  g.fillStyle = '#6f6d68';
  g.fillRect(0, 0, TEX_PX, TEX_PX);

  for (let ty = 0; ty < TILES_PER_SPAN; ty++) {
    for (let tx = 0; tx < TILES_PER_SPAN; tx++) {
      // Per-tile tone. Real tunnel tile is off-white and unevenly aged; a single flat cream reads
      // as plastic, and this is the cheapest thing that stops it.
      const n = hash2(tx + 0.5, ty + 0.5);
      const l = 214 + Math.round((n - 0.5) * 18);          // ~205..223
      const warm = 4;                                       // ceramic is faintly warm, not blue
      g.fillStyle = `rgb(${l + warm}, ${l + 1}, ${l - 3})`;
      g.fillRect(tx * px + grout, ty * px + grout, px - grout * 2, px - grout * 2);

      // A soft highlight on the upper-left of each tile: glazed ceramic catches the lamp strip.
      const hi = g.createLinearGradient(tx * px, ty * px, tx * px + px, ty * px + px);
      hi.addColorStop(0, 'rgba(255,255,255,0.10)');
      hi.addColorStop(0.5, 'rgba(255,255,255,0.0)');
      g.fillStyle = hi;
      g.fillRect(tx * px + grout, ty * px + grout, px - grout * 2, px - grout * 2);
    }
  }

  // Traffic grime, heaviest low on the wall. V is ACROSS the tunnel (see buildQuad), so this
  // gradient runs bottom-to-top of the texture and lands at the road edge once applied.
  const grime = g.createLinearGradient(0, TEX_PX, 0, 0);
  grime.addColorStop(0.0, 'rgba(46,42,36,0.42)');
  grime.addColorStop(0.28, 'rgba(46,42,36,0.14)');
  grime.addColorStop(0.6, 'rgba(46,42,36,0.0)');
  g.fillStyle = grime;
  g.fillRect(0, 0, TEX_PX, TEX_PX);

  return c;
}

/** Sobel the albedo's luminance into a tangent-space normal map. */
function deriveNormal(albedoCanvas, strength = 2.0) {
  const src = albedoCanvas.getContext('2d').getImageData(0, 0, TEX_PX, TEX_PX).data;
  const lum = new Float32Array(TEX_PX * TEX_PX);
  for (let i = 0; i < TEX_PX * TEX_PX; i++) {
    lum[i] = (src[i * 4] * 0.299 + src[i * 4 + 1] * 0.587 + src[i * 4 + 2] * 0.114) / 255;
  }
  const c = document.createElement('canvas');
  c.width = c.height = TEX_PX;
  const g = c.getContext('2d');
  const out = g.createImageData(TEX_PX, TEX_PX);
  const at = (x, y) => lum[((y + TEX_PX) % TEX_PX) * TEX_PX + ((x + TEX_PX) % TEX_PX)];
  for (let y = 0; y < TEX_PX; y++) {
    for (let x = 0; x < TEX_PX; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const i = (y * TEX_PX + x) * 4;
      out.data[i] = (nx * 0.5 + 0.5) * 255;
      out.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      out.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      out.data[i + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  return c;
}

function drawConcrete() {
  const c = document.createElement('canvas');
  c.width = c.height = TEX_PX;
  const g = c.getContext('2d');
  const boardPx = TEX_PX / (CONCRETE_SPAN_M / BOARD_M);   // pixels per form board

  g.fillStyle = '#9a9892';
  g.fillRect(0, 0, TEX_PX, TEX_PX);

  // Per-board tone. Each pour lift cures slightly differently, and that banding is the single
  // strongest read of board-formed concrete — without it this is a flat grey card.
  const boards = Math.round(CONCRETE_SPAN_M / BOARD_M);
  for (let b = 0; b < boards; b++) {
    const n = hash2(b * 3.7, 11.3);
    const l = 154 + Math.round((n - 0.5) * 16);
    g.fillStyle = `rgb(${l}, ${l - 1}, ${l - 5})`;
    g.fillRect(0, b * boardPx, TEX_PX, boardPx);
    // Seam between boards: a thin dark recess, and a thin bright lip under it where grout wept.
    g.fillStyle = 'rgba(60,58,54,0.55)';
    g.fillRect(0, b * boardPx, TEX_PX, Math.max(1, boardPx * 0.035));
    g.fillStyle = 'rgba(255,255,255,0.06)';
    g.fillRect(0, b * boardPx + boardPx * 0.035, TEX_PX, Math.max(1, boardPx * 0.02));
  }

  // Form-tie holes, on the regular grid the shuttering imposes.
  const tieCols = 4;
  for (let b = 1; b < boards; b += 2) {
    for (let i = 0; i < tieCols; i++) {
      const x = (i + 0.5) * (TEX_PX / tieCols);
      const y = b * boardPx;
      const r = Math.max(1.5, boardPx * 0.10);
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(58,56,52,0.75)');
      grad.addColorStop(1, 'rgba(58,56,52,0)');
      g.fillStyle = grad;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
  }

  // Vertical staining, heaviest at the top where runoff enters. Trench walls streak.
  for (let i = 0; i < 26; i++) {
    const x = hash2(i * 5.1, 2.9) * TEX_PX;
    const w = 2 + hash2(i * 1.7, 8.2) * 10;
    const st = g.createLinearGradient(0, 0, 0, TEX_PX);
    st.addColorStop(0, 'rgba(70,66,58,0.20)');
    st.addColorStop(0.55, 'rgba(70,66,58,0.06)');
    st.addColorStop(1, 'rgba(70,66,58,0)');
    g.fillStyle = st;
    g.fillRect(x, 0, w, TEX_PX);
  }
  return c;
}

function build() {
  if (_albedo) return;
  const canvas = drawAlbedo();
  _albedo = new THREE.CanvasTexture(canvas);
  _albedo.colorSpace = THREE.SRGBColorSpace;
  _normal = new THREE.CanvasTexture(deriveNormal(canvas));
  for (const t of [_albedo, _normal]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    // UVs are in METRES, so one repeat must cover LINING_SPAN_M of real surface.
    t.repeat.set(1 / LINING_SPAN_M, 1 / LINING_SPAN_M);
    t.anisotropy = 8;        // the ask, not the grant — the registry clamps to the hardware max
    t.needsUpdate = true;
  }
}

/** @returns {{ map: THREE.Texture, normalMap: THREE.Texture }} the shared concrete pair. */
export function getConcreteTextures() {
  if (!_concreteAlbedo) {
    const canvas = drawConcrete();
    _concreteAlbedo = new THREE.CanvasTexture(canvas);
    _concreteAlbedo.colorSpace = THREE.SRGBColorSpace;
    _concreteNormal = new THREE.CanvasTexture(deriveNormal(canvas, 1.4));
    for (const t of [_concreteAlbedo, _concreteNormal]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(1 / CONCRETE_SPAN_M, 1 / CONCRETE_SPAN_M);
      t.anisotropy = 8;
      t.needsUpdate = true;
    }
  }
  return { map: _concreteAlbedo, normalMap: _concreteNormal };
}

/** @returns {{ map: THREE.Texture, normalMap: THREE.Texture }} the shared lining pair. */
export function getLiningTextures() {
  build();
  return { map: _albedo, normalMap: _normal };
}

/** Free the pair. Shared and cached, so only a full teardown should call this. */
export function disposeLiningTextures() {
  _albedo?.dispose(); _normal?.dispose();
  _concreteAlbedo?.dispose(); _concreteNormal?.dispose();
  _albedo = _normal = _concreteAlbedo = _concreteNormal = null;
}
