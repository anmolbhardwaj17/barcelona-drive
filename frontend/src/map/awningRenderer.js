/**
 * Shop awnings — the projecting fabric canopies over Barcelona ground-floor shopfronts.
 *
 * For each eligible building we take its longest street-facing edge (same edge the shop-sign
 * fascia sits on) and lay a row of short awning segments along it, each projecting out over the
 * sidewalk and sloping down toward the street, with a short vertical front valance. Solid deep
 * "toldo" colours (burgundy, bottle green, navy, mustard, cream…) picked deterministically per
 * segment. Everything in a tile is merged into ONE MeshLambert (vertex-coloured) mesh, so the whole
 * street's worth of awnings is a single draw call, and it dims naturally with the day/night lights.
 *
 * Built in world coords and added to the mirrored worldGroup, same as the shop signs.
 */
import * as THREE from 'three';
import { worldToLatLon } from '../projection.js';
import { shopSegSkipped, shopGroundY } from './shopfrontRenderer.js';

const AWN_TOP_Y      = 2.9;    // back edge height on the building face (below the ~3.15 m sign fascia)
const AWN_PROJECT    = 1.35;   // how far it reaches out over the sidewalk (metres)
const AWN_FRONT_DROP = 0.34;   // front edge lower than the back → the slope
const AWN_FLAP       = 0.34;   // vertical front valance drop
const SEG_LEN        = 3.4;    // one awning ≈ one shopfront
const SEG_GAP        = 0.4;    // gap between neighbouring awnings
const EDGE_MARGIN    = 0.5;    // keep awnings off the building corners
const MIN_EDGE       = 6;      // skip buildings whose longest edge is shorter than this
const SEG_CAP        = 260;    // per-tile segment budget (perf guard)

// Classic toldo palette — deep saturated fabrics + a couple of pale ones.
const COLORS = [
  0x8a2620, // burgundy
  0x1f4e33, // bottle green
  0x1c3557, // navy
  0xb5842a, // mustard/ochre
  0x5a1f2a, // maroon
  0xdccba6, // cream
  0x2f6d6a, // teal
  0x7a3410, // terracotta
];

/**
 * @param {Array<{footprint:{x:number,y:number}[], height?:number}>} buildings
 * @param {{ getElevationAt?: (lat:number,lon:number)=>number|null, vertExag?: number }} opts
 * @returns {THREE.Mesh|null}
 */
export function buildAwningMesh(buildings, opts = {}) {
  if (!buildings || !buildings.length) return null;
  const getElevationAt = opts.getElevationAt;
  const vertExag = Number.isFinite(opts.vertExag) ? opts.vertExag : 1;

  const positions = [];
  const colors = [];
  const indices = [];
  let segCount = 0;

  // cheap deterministic PRNG so colours are stable across reloads
  let seed = 2654435761 >>> 0;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  const _col = new THREE.Color();

  function pushSegment(ax, az, dx, dz, nx, nz, t0, t1, groundY, colorHex) {
    const topY = groundY + AWN_TOP_Y;
    const frontY = topY - AWN_FRONT_DROP;
    const flapY = frontY - AWN_FLAP;
    // back edge sits just off the façade to avoid z-fighting
    const bo = 0.06;

    const base = positions.length / 3;
    // 0 BL, 1 BR (on façade)   2 FL, 3 FR (front, projected)   4 FLb, 5 FRb (valance bottoms)
    positions.push(
      ax + dx * t0 + nx * bo,        topY,   az + dz * t0 + nz * bo,        // BL
      ax + dx * t1 + nx * bo,        topY,   az + dz * t1 + nz * bo,        // BR
      ax + dx * t0 + nx * AWN_PROJECT, frontY, az + dz * t0 + nz * AWN_PROJECT, // FL
      ax + dx * t1 + nx * AWN_PROJECT, frontY, az + dz * t1 + nz * AWN_PROJECT, // FR
      ax + dx * t0 + nx * AWN_PROJECT, flapY,  az + dz * t0 + nz * AWN_PROJECT, // FLb
      ax + dx * t1 + nx * AWN_PROJECT, flapY,  az + dz * t1 + nz * AWN_PROJECT, // FRb
    );

    _col.setHex(colorHex);
    for (let i = 0; i < 6; i++) colors.push(_col.r, _col.g, _col.b);

    // top slope (BL,BR,FR,FL) + front valance (FL,FR,FRb,FLb)
    indices.push(
      base + 0, base + 1, base + 3,  base + 0, base + 3, base + 2,
      base + 2, base + 3, base + 5,  base + 2, base + 5, base + 4,
    );
    segCount++;
  }

  for (const b of buildings) {
    if (segCount >= SEG_CAP) break;
    const fp = b.footprint;
    if (!fp || fp.length < 3) continue;
    if ((b.height || 6) < 4) continue;

    // longest edge + centroid (same selection as the shop signs)
    let bestLen = 0, bi = -1, cx = 0, cz = 0;
    for (const p of fp) { cx += p.x; cz += p.y; }
    cx /= fp.length; cz /= fp.length;
    for (let i = 0; i < fp.length; i++) {
      const a = fp[i], c = fp[(i + 1) % fp.length];
      const dx = c.x - a.x, dz = c.y - a.y;
      const l = dx * dx + dz * dz;
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
      // quantized like the shopfronts so the awning row sits level with them (no per-building jitter)
      groundY = shopGroundY((getElevationAt(lat, lon) ?? 0) * vertExag);
    }

    // lay segments along the edge, leaving a margin at each corner
    const usable = edgeLen - 2 * EDGE_MARGIN;
    if (usable < SEG_LEN * 0.6) continue;
    const stride = SEG_LEN + SEG_GAP;
    // capped + sparsified IDENTICALLY to shopfrontRenderer — every awning must sit over a storefront
    const n = Math.min(4, Math.max(1, Math.floor((usable + SEG_GAP) / stride)));
    // centre the row of awnings on the edge
    const rowLen = n * SEG_LEN + (n - 1) * SEG_GAP;
    let t = EDGE_MARGIN + (usable - rowLen) / 2;

    for (let s = 0; s < n && segCount < SEG_CAP; s++) {
      const color = COLORS[(rand() * COLORS.length) | 0];
      if (!shopSegSkipped(cx, cz, s)) pushSegment(a.x, a.y, dx, dz, nx, nz, t, t + SEG_LEN, groundY, color);
      t += stride;
    }
  }

  if (!positions.length) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  mesh.userData = { type: 'awning' };
  return mesh;
}
