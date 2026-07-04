/**
 * Ground-floor shopfronts — the storefront that sits UNDER the awning + name-sign so a shop reads as a
 * real entrance (glass display windows flanking a central door, framed) instead of a blank wall.
 *
 * Placed on the same street-facing edge the awnings/signs use, segmented one storefront per shop. Two
 * merged meshes per tile:
 *   1. frame  — mullions, lintel, stallriser/kickplate (vertex-coloured MeshLambert, dims with the lights)
 *   2. glass  — the window + door panes, ONE shared MeshBasic material that switches from dark reflective
 *               (day) to a warm interior glow (night) via setShopfrontNightMode → lit shops at night.
 *
 * Built in world coords, added to the mirrored worldGroup (same frame as awnings / shop signs).
 */
import * as THREE from 'three';
import { worldToLatLon } from '../projection.js';

const KICK_TOP   = 0.42;   // top of the stallriser (bottom solid band)
const GLASS_TOP  = 2.55;   // top of the display glass (below the ~2.9 m awning back)
const LINTEL_TOP = 2.80;   // top of the header band
const DOOR_H     = 2.20;   // door height
const DOOR_W     = 1.10;   // door width
const FRAME      = 0.13;   // mullion / frame bar width
const SEG_LEN    = 3.4;    // one storefront ≈ one shop (matches the awning segmentation)
const SEG_GAP    = 0.4;
const EDGE_MARGIN = 0.5;
const MIN_EDGE   = 6;
const SEG_CAP    = 260;

const C_FRAME = 0x26262b;  // dark frame / mullions / lintel
const C_KICK  = 0x595961;  // stone stallriser
const GLASS_DAY   = 0x16242c;
const GLASS_NIGHT = 0xb0813f; // dimmer warm amber — 0xffcf87 was so bright it bloomed into a wall of glow at night

let _glassMat = null;
let _glassNight = false;
export function setShopfrontNightMode(isNight) {
  _glassNight = isNight;
  if (_glassMat) _glassMat.color.setHex(isNight ? GLASS_NIGHT : GLASS_DAY);
}
function getGlassMaterial() {
  if (!_glassMat) _glassMat = new THREE.MeshBasicMaterial({ color: _glassNight ? GLASS_NIGHT : GLASS_DAY, fog: true, side: THREE.DoubleSide });
  return _glassMat;
}

/**
 * @param {Array<{footprint:{x:number,y:number}[], height?:number}>} buildings
 * @param {{ getElevationAt?: (lat:number,lon:number)=>number|null, vertExag?: number }} opts
 * @returns {THREE.Mesh[]|null}  [frameMesh, glassMesh]
 */
export function buildShopfrontMeshes(buildings, opts = {}) {
  if (!buildings || !buildings.length) return null;
  const getElevationAt = opts.getElevationAt;
  const vertExag = Number.isFinite(opts.vertExag) ? opts.vertExag : 1;

  const fPos = [], fCol = [], fIdx = [];   // frame (vertex-coloured)
  const gPos = [], gIdx = [];              // glass (uniform material)
  const _c = new THREE.Color();
  let segCount = 0;

  // one flat vertical quad on the façade: from (tA,y0) to (tB,y1), pushed out by `off` along the normal
  function quad(pos, col, colors, ax, az, dx, dz, nx, nz, off, tA, tB, y0, y1, groundY, hex) {
    const base = pos.length / 3;
    const oX = nx * off, oZ = nz * off;
    pos.push(
      ax + dx * tA + oX, groundY + y0, az + dz * tA + oZ,
      ax + dx * tB + oX, groundY + y0, az + dz * tB + oZ,
      ax + dx * tB + oX, groundY + y1, az + dz * tB + oZ,
      ax + dx * tA + oX, groundY + y1, az + dz * tA + oZ,
    );
    if (colors) { _c.setHex(hex); for (let i = 0; i < 4; i++) colors.push(_c.r, _c.g, _c.b); }
    col.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  for (const b of buildings) {
    if (segCount >= SEG_CAP) break;
    const fp = b.footprint;
    if (!fp || fp.length < 3) continue;
    if ((b.height || 6) < 4) continue;

    // longest edge + centroid (identical selection to awnings so storefronts sit under the awnings)
    let bestLen = 0, bi = -1, cx = 0, cz = 0;
    for (const p of fp) { cx += p.x; cz += p.y; }
    cx /= fp.length; cz /= fp.length;
    for (let i = 0; i < fp.length; i++) {
      const a = fp[i], c = fp[(i + 1) % fp.length];
      const ddx = c.x - a.x, ddz = c.y - a.y;
      const l = ddx * ddx + ddz * ddz;
      if (l > bestLen) { bestLen = l; bi = i; }
    }
    const edgeLen = Math.sqrt(bestLen);
    if (bi < 0 || edgeLen < MIN_EDGE) continue;

    const a = fp[bi], c = fp[(bi + 1) % fp.length];
    let dx = c.x - a.x, dz = c.y - a.y;
    const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
    let nx = dz, nz = -dx;
    const mx = (a.x + c.x) / 2, mz = (a.y + c.y) / 2;
    if (nx * (mx - cx) + nz * (mz - cz) < 0) { nx = -nx; nz = -nz; }

    let groundY = 0;
    if (getElevationAt) {
      const { lat, lon } = worldToLatLon(mx, mz);
      groundY = (getElevationAt(lat, lon) ?? 0) * vertExag;
    }

    const usable = edgeLen - 2 * EDGE_MARGIN;
    if (usable < SEG_LEN * 0.6) continue;
    const stride = SEG_LEN + SEG_GAP;
    const n = Math.max(1, Math.floor((usable + SEG_GAP) / stride));
    const rowLen = n * SEG_LEN + (n - 1) * SEG_GAP;
    let t = EDGE_MARGIN + (usable - rowLen) / 2;

    const ax = a.x, az = a.y;
    const GO = 0.03, FO = 0.07;   // glass recessed, frame proud

    for (let s = 0; s < n && segCount < SEG_CAP; s++, t += stride) {
      const t0 = t, t1 = t + SEG_LEN;
      const doorC = (t0 + t1) / 2, dL = doorC - DOOR_W / 2, dR = doorC + DOOR_W / 2;

      // ── glass panes ──
      // door
      quad(gPos, gIdx, null, ax, az, dx, dz, nx, nz, GO, dL, dR, 0.02, DOOR_H, groundY);
      // left + right display windows (skip if too narrow)
      if (dL - FRAME - (t0 + FRAME) > 0.35) quad(gPos, gIdx, null, ax, az, dx, dz, nx, nz, GO, t0 + FRAME, dL - FRAME, KICK_TOP, GLASS_TOP, groundY);
      if (t1 - FRAME - (dR + FRAME) > 0.35) quad(gPos, gIdx, null, ax, az, dx, dz, nx, nz, GO, dR + FRAME, t1 - FRAME, KICK_TOP, GLASS_TOP, groundY);

      // ── frame: kickplate under the windows, lintel across the top, vertical mullions ──
      if (dL - (t0) > 0.3) quad(fPos, fIdx, fCol, ax, az, dx, dz, nx, nz, FO, t0, dL, 0, KICK_TOP, groundY, C_KICK);
      if (t1 - dR > 0.3)   quad(fPos, fIdx, fCol, ax, az, dx, dz, nx, nz, FO, dR, t1, 0, KICK_TOP, groundY, C_KICK);
      quad(fPos, fIdx, fCol, ax, az, dx, dz, nx, nz, FO, t0, t1, GLASS_TOP, LINTEL_TOP, groundY, C_FRAME);  // lintel
      for (const mt of [t0, dL, dR, t1]) {  // vertical mullions
        quad(fPos, fIdx, fCol, ax, az, dx, dz, nx, nz, FO, mt - FRAME / 2, mt + FRAME / 2, 0, GLASS_TOP, groundY, C_FRAME);
      }
      segCount++;
    }
  }

  if (!fPos.length && !gPos.length) return null;
  const meshes = [];

  if (fPos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(fPos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(fCol, 3));
    g.setIndex(fIdx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    m.castShadow = false; m.receiveShadow = false; m.userData = { type: 'shopfrontFrame' };
    meshes.push(m);
  }
  if (gPos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(gPos, 3));
    g.setIndex(gIdx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, getGlassMaterial());
    m.castShadow = false; m.receiveShadow = false;
    m.userData = { type: 'shopfrontGlass', sharedMaterial: true };  // glass mat is a singleton
    meshes.push(m);
  }
  return meshes;
}
