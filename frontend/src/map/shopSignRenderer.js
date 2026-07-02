/**
 * Shop name boards — a fascia sign on each building's street-facing edge, with a random shop name.
 *
 * All names live in ONE canvas atlas (COLS×ROWS cells); every sign is one instance of a shared unit
 * plane in a single InstancedMesh, picking its cell via a per-instance `aUvOffset` attribute. So all the
 * signs in a tile cost ONE draw call. Text U is flipped in the shader to cancel worldGroup.scale.x = -1
 * (tile meshes live in the mirrored world group, same as the direction boards).
 */
import * as THREE from 'three';
import { worldToLatLon } from '../projection.js';

const COLS = 4, ROWS = 6;
const CELL_W = 256, CELL_H = 64;          // atlas cell px (≈4:1 board)
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
// [background, text] colour pairs, cycled across cells for variety.
const BOARDS = [
  ['#8f2222', '#f5ecd8'], ['#1c3a5e', '#ffffff'], ['#25532f', '#f2e9d0'], ['#c79a2e', '#241a08'],
  ['#5e1f2a', '#e9c96a'], ['#161616', '#ffffff'], ['#1f5b5b', '#eafcfa'], ['#e7ddc7', '#7a1f1f'],
];

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

    ctx.fillStyle = bg;
    ctx.fillRect(x, y, CELL_W, CELL_H);
    // thin inset border
    ctx.strokeStyle = fg;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 5, y + 5, CELL_W - 10, CELL_H - 10);
    ctx.globalAlpha = 1;

    // shop name, shrink-to-fit
    const name = NAMES[k];
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let fp = 40;
    do { ctx.font = `700 ${fp}px "Helvetica Neue", Arial, sans-serif`; if (ctx.measureText(name).width <= CELL_W - 28 || fp <= 18) break; fp -= 2; } while (true);
    ctx.fillText(name, x + CELL_W / 2, y + CELL_H / 2 + 2, CELL_W - 24);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  _atlasTex = tex;
  return _atlasTex;
}

let _signMaterial = null;
function getShopSignMaterial() {
  if (_signMaterial) return _signMaterial;
  const cw = (1 / COLS).toFixed(6), ch = (1 / ROWS).toFixed(6);
  const mat = new THREE.MeshBasicMaterial({ map: getShopSignAtlas(), fog: true });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = 'attribute vec2 aUvOffset;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
       vMapUv = vec2((1.0 - uv.x) * ${cw} + aUvOffset.x, uv.y * ${ch} + aUvOffset.y);`
    );
  };
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
