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
const FRAME      = 0.13;   // mullion / frame bar width
// ── The shop-row layout. EXPORTED because awningRenderer lays its toldos over these exact bays;
//    every awning must sit on a storefront, so the two must not be able to drift apart. ──
export const SHOP_ROW = {
  SEG_LEN:     3.4,   // one storefront ≈ one shop
  SEG_GAP:     0.4,
  EDGE_MARGIN: 0.5,   // keep the row off the building corners
  MIN_EDGE:    6,
  // Per-tile budget. Was 260, which a dense Eixample tile exhausted on whatever buildings happened
  // to come first in the array — the rest of the tile got no shops at all, biased by array order.
  SEG_CAP:     650,
  // Was 4: a 4-bay row is 14.8 m, so a 25 m parcel frontage got one short island of shops in the
  // middle and blank wall either side. 8 lets the frontage decide; the cap only exists to stop a
  // single very long edge becoming an unbroken shop wall.
  MAX_SEGS_PER_BUILDING: 8,
};
const { SEG_LEN, SEG_GAP, EDGE_MARGIN, MIN_EDGE, SEG_CAP, MAX_SEGS_PER_BUILDING } = SHOP_ROW;

// Deterministic per-segment skip (~35%) so shop rows breathe. MUST stay IDENTICAL to
// awningRenderer's copy — both renderers segment the same edge with the same indices, and a
// skipped storefront must also skip its awning.
export function shopSegSkipped(cx, cz, s) {
  let h = ((Math.round(cx * 10) * 73856093) ^ (Math.round(cz * 10) * 19349663) ^ ((s + 1) * 83492791)) >>> 0;
  return (h % 1000) < 350;
}

// Quantize ground height to 0.75 m steps — IDENTICAL in awningRenderer. Adjacent narrow buildings
// with sub-step elevation differences share one level, so a shop row doesn't jitter up/down;
// genuine slopes still step.
export function shopGroundY(y) { return Math.round(y / 0.75) * 0.75; }

const C_FRAME = 0x26262b;  // dark frame / mullions / lintel
const C_KICK  = 0x595961;  // stone stallriser
const GLASS_DAY   = 0x16242c;
const GLASS_NIGHT = 0xb0813f; // dimmer warm amber — 0xffcf87 was so bright it bloomed into a wall of glow at night

let _glassMat = null;
let _frameMat = null;
let _glassNight = false;

/**
 * NIGHT ONLY. The 3D shopfront predates P3-05, which bakes a full shopfront — joinery, glazing bars,
 * produce, signage — into the facade's GROUND array layer. In daylight the two stack, and the 3D one
 * wins because its glass is an unlit MeshBasic at 0x16242c: a flat dark-navy slab parked in front of
 * the artwork. At night the roles invert — the texture has no interior light, and the glass pane
 * glowing warm amber is exactly what makes a shop read as open. So the texture owns the day and the
 * geometry owns the night.
 *
 * The switch is on the MATERIAL, not the mesh: `mesh.visible` is already owned by the per-tile
 * distance LOD in tileManager (~:3041), which rewrites it every time the viewer moves, so a
 * mesh-level toggle here would survive about one frame.
 */
export function setShopfrontNightMode(isNight) {
  _glassNight = isNight;
  if (_glassMat) { _glassMat.color.setHex(isNight ? GLASS_NIGHT : GLASS_DAY); _glassMat.visible = isNight; }
  if (_frameMat) _frameMat.visible = isNight;
}
function getGlassMaterial() {
  if (!_glassMat) {
    _glassMat = new THREE.MeshBasicMaterial({ color: _glassNight ? GLASS_NIGHT : GLASS_DAY, fog: true, side: THREE.DoubleSide });
    _glassMat.visible = _glassNight;
  }
  return _glassMat;
}
// Shared singleton like the glass: no per-tile state (vertex colours carry the frame/kick split), so
// a per-tile copy was an allocation per tile AND left the night toggle with nothing to switch.
function getFrameMaterial() {
  if (!_frameMat) {
    _frameMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    _frameMat.visible = _glassNight;
  }
  return _frameMat;
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
      groundY = shopGroundY((getElevationAt(lat, lon) ?? 0) * vertExag);
    }

    const usable = edgeLen - 2 * EDGE_MARGIN;
    if (usable < SEG_LEN * 0.6) continue;
    const stride = SEG_LEN + SEG_GAP;
    const n = Math.min(MAX_SEGS_PER_BUILDING, Math.max(1, Math.floor((usable + SEG_GAP) / stride)));
    const rowLen = n * SEG_LEN + (n - 1) * SEG_GAP;
    let t = EDGE_MARGIN + (usable - rowLen) / 2;

    const ax = a.x, az = a.y;
    const GO = 0.03, FO = 0.07;   // glass recessed, frame proud

    for (let s = 0; s < n && segCount < SEG_CAP; s++, t += stride) {
      if (shopSegSkipped(cx, cz, s)) continue;
      const t0 = t, t1 = t + SEG_LEN;

      // ── glass: ONE uniform display band per storefront (no lower centre "entrance" pane — the
      //    stepped door glass made the night glow read as uneven heights) ──
      quad(gPos, gIdx, null, ax, az, dx, dz, nx, nz, GO, t0 + FRAME, t1 - FRAME, KICK_TOP, GLASS_TOP, groundY);

      // ── frame: full-width kickplate, lintel across the top, edge mullions ──
      quad(fPos, fIdx, fCol, ax, az, dx, dz, nx, nz, FO, t0, t1, 0, KICK_TOP, groundY, C_KICK);
      quad(fPos, fIdx, fCol, ax, az, dx, dz, nx, nz, FO, t0, t1, GLASS_TOP, LINTEL_TOP, groundY, C_FRAME);  // lintel
      for (const mt of [t0, t1]) {  // vertical mullions at the segment edges
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
    const m = new THREE.Mesh(g, getFrameMaterial());
    m.castShadow = false; m.receiveShadow = false;
    m.userData = { type: 'shopfrontFrame', sharedMaterial: true };  // frame mat is a singleton too
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
