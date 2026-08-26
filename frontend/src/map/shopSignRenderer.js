/**
 * Shop name boards — a fascia sign on each building's street-facing edge, with a random shop name.
 *
 * All names live in ONE canvas atlas (COLS×ROWS cells); every sign is one instance of a shared unit
 * plane in a single InstancedMesh, picking its cell via a per-instance `aUvOffset` attribute. So all the
 * signs in a tile cost ONE draw call. Text U is flipped in the shader to cancel worldGroup.scale.x = -1
 * (tile meshes live in the mirrored world group, same as the direction boards).
 */
import * as THREE from 'three';
import { patchMaterial } from './materialRegistry.js';   // v3 P1-03
import { worldToLatLon } from '../projection.js';

const COLS = 4, ROWS = 6;
const CELL_W = 384, CELL_H = 96;          // atlas cell px (4:1 board) — 128 texels/m on a 3 m fascia
const SIGN_W = 3.0, SIGN_H = 0.72;        // world metres
const SIGN_Y = 3.15;                       // fascia height above ground (ground floor ≈ 3.5–4 m)
const MIN_EDGE = 6;                        // skip buildings whose longest edge is shorter than this
const CAP_PER_TILE = 60;

// Catalan/Spanish shop names + a few English. 24 total (COLS×ROWS).
const NAMES = [
  'Farmàcia', 'Forn de Pa', 'Cafè Central', 'Bar Manolo',
  'Òptica', 'Queviures', 'Floristeria', 'Carnisseria',
  'Llibreria', 'Ferreteria', 'Perruqueria', 'Pastisseria',
  'Bodega', 'Rellotgeria', 'Tapes & Vins', 'Xocolateria',
  'Restaurante', 'Panadería', 'Zapatería', 'Joyería',
  'Corner Café', 'City Books', 'Barcelona Store', 'The Market',
];
/**
 * [background, text] pairs. Normalized against the Barcelona palette and pre-graded (art bible
 * step 6), like every other authored surface.
 *
 * The previous set was raw hex picked by eye and SIX OF EIGHT failed gate 4 — the maroon in the
 * reference screenshot measured C* 53.1, nearly double the highest material class, at L* 32. That
 * combination (very dark, very saturated, perfectly flat) is most of why the boards read as vector
 * art pasted onto the wall rather than painted metal.
 *
 * These are NOT snapped to a surface class. There is no signage class, and a sign's colour is its
 * identity rather than a material sample — the same reasoning that stopped the shopfront plates
 * being bleached to the `facade` class L* 74. Instead: chroma ceiling 42 (above `fabric`'s 30,
 * because signage is deliberately an accent; far below the raw 53-60), L* floored off black, and
 * every entry checked to ΔE ≤ 15 against the city palette. Green and burgundy sit in hue gaps and
 * needed a ±6° nudge to reach an anchor at all; both keep full chroma at 42.
 */
const BOARDS = [
  ['#7D352F', '#F4ECDB'],  // maroon      dE 14.21 poblenou_brick
  ['#324768', '#FFFFFF'],  // navy        dE  9.55 mediterrani_blue
  ['#3D6E3B', '#F1E9D3'],  // green       dE 12.72 platanus_green
  ['#BC9C5F', '#231A0C'],  // ochre       dE 11.25 modernisme_rose
  ['#9B4A4F', '#E1CA8E'],  // burgundy    dE 12.44 teula_clay
  ['#474747', '#FFFFFF'],  // near-black  dE  2.84 carriageway_grey
  ['#295A5A', '#ECFCFA'],  // teal        dE 14.09 mediterrani_blue
  ['#C9C0AE', '#6D2C28'],  // cream       dE  3.02 ochre_sand
];

/**
 * Paint ONE fascia board.
 *
 * A flat `fillRect` plus a 2 px stroke is a vector rectangle, and no amount of palette work makes a
 * vector rectangle look like a painted board. Four things give it a surface, cheapest first:
 *
 *  1. A vertical shade ramp. A fascia hangs UNDER an awning, so its top is occluded and its lower
 *     half catches bounce off the pavement. This is the single biggest cue and costs one gradient.
 *  2. A bevel — light along the top inner edge, dark along the bottom — so the plate reads as having
 *     thickness rather than being a decal at zero depth.
 *  3. Grain and corner grime, seeded per cell so it is stable across reloads. Real signage is dusty
 *     at the edges; perfectly clean corners read as CG.
 *  4. A soft drop shadow under the letters, so the name sits ON the board instead of being punched
 *     through it.
 */
function paintBoard(ctx, x, y, bg, fg, name, k) {
  // deterministic per-cell noise — same board, same speckle, every reload
  let seed = (k * 2654435761 + 40503) >>> 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, CELL_W, CELL_H); ctx.clip();

  ctx.fillStyle = bg;
  ctx.fillRect(x, y, CELL_W, CELL_H);

  // 1 — occluded top, bounce-lit bottom
  const ramp = ctx.createLinearGradient(x, y, x, y + CELL_H);
  ramp.addColorStop(0.0, 'rgba(0,0,0,0.30)');
  ramp.addColorStop(0.42, 'rgba(0,0,0,0.04)');
  ramp.addColorStop(1.0, 'rgba(255,255,255,0.07)');
  ctx.fillStyle = ramp;
  ctx.fillRect(x, y, CELL_W, CELL_H);

  // 3 — grain
  for (let i = 0; i < 260; i++) {
    const gx = x + rnd() * CELL_W, gy = y + rnd() * CELL_H;
    ctx.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.055)' : 'rgba(255,255,255,0.045)';
    ctx.fillRect(gx, gy, 1 + rnd() * 2, 1);
  }
  // 3 — grime gathering at the corners
  for (const [cx, cy] of [[x, y], [x + CELL_W, y], [x, y + CELL_H], [x + CELL_W, y + CELL_H]]) {
    const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, CELL_H * 0.75);
    gr.addColorStop(0, 'rgba(0,0,0,0.20)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gr;
    ctx.fillRect(x, y, CELL_W, CELL_H);
  }

  // 2 — bevel: the plate has thickness
  const b = Math.max(2, CELL_H * 0.05);
  ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fillRect(x, y, CELL_W, b);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';       ctx.fillRect(x, y + CELL_H - b, CELL_W, b);
  ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fillRect(x, y, b, CELL_H);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';       ctx.fillRect(x + CELL_W - b, y, b, CELL_H);

  // inset keyline, kept faint — this used to be the ONLY detail and it read as clip art
  ctx.strokeStyle = fg; ctx.globalAlpha = 0.30; ctx.lineWidth = Math.max(1, CELL_H * 0.022);
  const inset = CELL_H * 0.09;
  ctx.strokeRect(x + inset, y + inset, CELL_W - inset * 2, CELL_H - inset * 2);
  ctx.globalAlpha = 1;

  // 4 — the name, shrink-to-fit, sitting on the board
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let fp = Math.round(CELL_H * 0.62);
  const maxW = CELL_W - CELL_H * 0.44;
  do {
    ctx.font = `700 ${fp}px "Helvetica Neue", Arial, sans-serif`;
    if (ctx.measureText(name).width <= maxW || fp <= CELL_H * 0.28) break;
    fp -= 2;
  } while (true);
  const tx = x + CELL_W / 2, ty = y + CELL_H / 2 + CELL_H * 0.03;
  ctx.fillStyle = 'rgba(0,0,0,0.38)';
  ctx.fillText(name, tx, ty + Math.max(1, CELL_H * 0.028), maxW);
  ctx.fillStyle = fg;
  ctx.fillText(name, tx, ty, maxW);

  ctx.restore();
}

let _atlasTex = null;

function getShopSignAtlas() {
  if (_atlasTex) return _atlasTex;
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W * COLS;
  canvas.height = CELL_H * ROWS;
  const ctx = canvas.getContext('2d');

  for (let k = 0; k < NAMES.length; k++) {
    const col = k % COLS, row = (k / COLS) | 0;
    const x = col * CELL_W, y = row * CELL_H;
    const [bg, fg] = BOARDS[k % BOARDS.length];

    paintBoard(ctx, x, y, bg, fg, NAMES[k], k);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Mipmaps, not LinearFilter. A 3 m board seen from a moving car is a textbook minification case,
  // and unmipped text crawls and sparkles the whole way down the street. Cells are 384x96, so the
  // only mips coarse enough to bleed between neighbours are ones where the sign is a few pixels.
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;   // fascias are read at a glancing angle from the carriageway
  _atlasTex = tex;
  return _atlasTex;
}

let _signMaterial = null;
let _signNight = false;   // persisted so signs built after a night toggle come up correct
// Illuminated fascia, applied THROUGH the emissive map so each board glows in its own colour rather
// than every sign lifting to the same grey. Warm, and modest: bloom is driven by area x level, and
// these are small but there are up to 60 per tile.
const _SIGN_EMISSIVE_NIGHT = 0x2e2318;

/** Shop-name boards light with the scene; at night their own fascia lighting comes up. */
export function setShopSignNightMode(isNight) {
  _signNight = isNight;
  if (_signMaterial) _signMaterial.emissive.setHex(isNight ? _SIGN_EMISSIVE_NIGHT : 0x000000);
}

function getShopSignMaterial() {
  if (_signMaterial) return _signMaterial;
  const cw = (1 / COLS).toFixed(6), ch = (1 / ROWS).toFixed(6);
  // Lambert, NOT Basic. An unlit board is the same brightness at noon, at dusk and under an awning,
  // which is exactly what "pasted on" looks like — and the old fix for that was to swap `color` to a
  // flat grey at night, i.e. a hand-drawn substitute for the lighting it was opting out of. Lambert
  // costs no extra draw call here (still one InstancedMesh) and picks up the sun AND the P2-04 light
  // grid, so a sign under a street lamp is now genuinely brighter than one between two.
  //
  // emissiveMap is bound at CONSTRUCTION even though emissive is black in daylight: adding it later
  // changes the defines and forces a recompile mid-drive (G-53).
  const atlas = getShopSignAtlas();
  const mat = new THREE.MeshLambertMaterial({
    map: atlas, emissiveMap: atlas, fog: true,
    emissive: new THREE.Color(_signNight ? _SIGN_EMISSIVE_NIGHT : 0x000000),
  });
  patchMaterial(mat, (shader) => {
    shader.vertexShader = 'attribute vec2 aUvOffset;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
       vec2 cellUv = vec2((1.0 - uv.x) * ${cw} + aUvOffset.x, uv.y * ${ch} + aUvOffset.y);
       vMapUv = cellUv;
       // three declares a SEPARATE varying per map slot, so binding emissiveMap without this line
       // leaves every sign's glow sampling cell 0 of the atlas while its albedo samples the right
       // one. Same U flip: these live in the mirrored worldGroup (scale.x = -1).
       vEmissiveMapUv = cellUv;`
    );
  }, 'shopSign');
  _signMaterial = mat;
  return _signMaterial;
}

/**
 * Build one InstancedMesh of shop-name boards for a tile's buildings.
 * @param {Array<{footprint:{x:number,y:number}[], height?:number}>} buildings
 * @param {{ getElevationAt?: (lat:number,lon:number)=>number|null, vertExag?: number }} opts
 * @returns {THREE.InstancedMesh|null}
 */
export function buildShopSignMesh(buildings, opts = {}) {
  if (!buildings || !buildings.length) return null;
  const getElevationAt = opts.getElevationAt;
  const vertExag = Number.isFinite(opts.vertExag) ? opts.vertExag : 1;

  const matrices = [];
  const cellOffsets = [];
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3(SIGN_W, SIGN_H, 1);
  const YAXIS = new THREE.Vector3(0, 1, 0);
  let seed = 1;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  for (const b of buildings) {
    if (matrices.length >= CAP_PER_TILE) break;
    const fp = b.footprint;
    if (!fp || fp.length < 3) continue;
    if ((b.height || 6) < 4) continue;

    // longest edge + centroid
    let bestLen = 0, bi = -1, cx = 0, cz = 0;
    for (const p of fp) { cx += p.x; cz += p.y; }
    cx /= fp.length; cz /= fp.length;
    for (let i = 0; i < fp.length; i++) {
      const a = fp[i], c = fp[(i + 1) % fp.length];
      const dx = c.x - a.x, dz = c.y - a.y;
      const l = dx * dx + dz * dz;
      if (l > bestLen) { bestLen = l; bi = i; }
    }
    if (bi < 0 || Math.sqrt(bestLen) < MIN_EDGE) continue;

    const a = fp[bi], c = fp[(bi + 1) % fp.length];
    const mx = (a.x + c.x) / 2, mz = (a.y + c.y) / 2;      // edge midpoint (world)
    let dx = c.x - a.x, dz = c.y - a.y;
    const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
    // outward normal (away from centroid)
    let nx = dz, nz = -dx;
    if (nx * (mx - cx) + nz * (mz - cz) < 0) { nx = -nx; nz = -nz; }

    let groundY = 0;
    if (getElevationAt) {
      const { lat, lon } = worldToLatLon(mx, mz);
      groundY = (getElevationAt(lat, lon) ?? 0) * vertExag;
    }

    _p.set(mx + nx * 0.35, groundY + SIGN_Y, mz + nz * 0.35);
    _q.setFromAxisAngle(YAXIS, Math.atan2(nx, nz));          // face outward
    _m.compose(_p, _q, _s);
    matrices.push(_m.clone());

    const cell = (rand() * NAMES.length) | 0;
    cellOffsets.push((cell % COLS) / COLS, (ROWS - 1 - ((cell / COLS) | 0)) / ROWS);
  }

  if (!matrices.length) return null;

  const geo = new THREE.PlaneGeometry(1, 1);
  const mesh = new THREE.InstancedMesh(geo, getShopSignMaterial(), matrices.length);
  for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
  geo.setAttribute('aUvOffset', new THREE.InstancedBufferAttribute(new Float32Array(cellOffsets), 2));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData = { sharedMaterial: true, type: 'shopSign' };
  return mesh;
}
