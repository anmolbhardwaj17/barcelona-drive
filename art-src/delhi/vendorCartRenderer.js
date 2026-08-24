/**
 * Delhi street vendor carts — procedurally scattered along roads in clusters.
 * Low-poly cart with sign board, vendor person, and 1-2 standing customers.
 * Clusters of 2-4 carts placed side by side like real Delhi food areas.
 * Sign boards illuminate at night.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { isVegetationAllowed } from './vegetationMask.js';
import { buildGroundRoadGrid, isOnGroundRoad } from './vegetationRenderer.js';

// ─── Shared materials ────────────────────────────────────────────────────────
let _matSteel, _matDarkGray, _matSkin, _matHair, _matWhite, _matConcrete;
function shared(mat) { mat.userData = { sharedMaterial: true }; return mat; }
function matSteel()    { return _matSteel    || (_matSteel    = shared(new THREE.MeshLambertMaterial({ color: 0x999999 }))); }
function matDarkGray() { return _matDarkGray || (_matDarkGray = shared(new THREE.MeshLambertMaterial({ color: 0x444444 }))); }
function matSkin()     { return _matSkin     || (_matSkin     = shared(new THREE.MeshLambertMaterial({ color: 0xc68642 }))); }
function matHair()     { return _matHair     || (_matHair     = shared(new THREE.MeshLambertMaterial({ color: 0x222222 }))); }
function matWhite()    { return _matWhite    || (_matWhite    = shared(new THREE.MeshLambertMaterial({ color: 0xeeeeee }))); }
function matConcrete() { return _matConcrete || (_matConcrete = shared(new THREE.MeshLambertMaterial({ color: 0xbbbbbb }))); }

// Cart body colors — Delhi street vendor palette
const CART_COLORS = [
  0xcc2222, // red
  0x2255aa, // blue
  0x22aa55, // green
  0xdd8811, // orange
  0xcc2266, // magenta/pink
  0x8833aa, // purple
  0xddaa11, // golden yellow
];

// Sign board names — Delhi street food variety
const SIGN_NAMES = [
  'MOMO CORNER',
  'RAJU CHAT BHANDAR',
  'BBQ CART',
  '99 DOSA',
  'SHARMA JI MOMOS',
  'DELHI CHAAT WALA',
  'GOLI VADA PAV',
  'TIKKI KING',
  'CHOLE BHATURE',
  'ROLL POINT',
  'KULFI WALA',
  'JUICE CORNER',
  'EGG ROLL CENTRE',
  'PANEER TIKKA',
  'SOUTH INDIAN DOSA',
  'MAGIC MOMOS',
];

// Per-cart-color materials (created lazily)
const _cartColorMats = new Map();
function matCartColor(color) {
  if (!_cartColorMats.has(color)) {
    _cartColorMats.set(color, shared(new THREE.MeshLambertMaterial({ color })));
  }
  return _cartColorMats.get(color);
}

// ─── Night-illuminated sign board materials ──────────────────────────────────
// MeshStandardMaterial with emissive so we can toggle glow at night.
// Cached per sign name + bg color.
const _signMatCache = new Map();
const _allSignMats = [];  // track all for night mode toggle

function makeSignMaterial(name, bgColor) {
  const key = `${name}_${bgColor}`;
  if (_signMatCache.has(key)) return _signMatCache.get(key);

  const w = 256, h = 64;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');

  // Background — same as cart color
  const r = (bgColor >> 16) & 0xff, g = (bgColor >> 8) & 0xff, b = bgColor & 0xff;
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, w, h);

  // Thin border
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.strokeRect(2, 2, w - 4, h - 4);

  // Text
  ctx.fillStyle = '#ffdd00';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const fontSize = name.length > 14 ? 20 : 26;
  ctx.font = `bold ${fontSize}px Arial, sans-serif`;
  ctx.fillText(name, w / 2, h / 2);

  const tex = new THREE.CanvasTexture(c);
  tex.repeat.x = -1; tex.offset.x = 1; // scene X-mirror fix

  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    emissive: new THREE.Color(bgColor).lerp(new THREE.Color(0xffffff), 0.3),
    emissiveIntensity: 0,
    roughness: 0.5,
  });
  mat.userData = { sharedMaterial: false };
  _signMatCache.set(key, mat);
  _allSignMats.push(mat);
  return mat;
}

// ─── Night illumination: glow panel under canopy + ground light pool ─────────
let _vendorGlowMat = null;
let _vendorPoolMat = null;

const GLOW_DAY = 0.0, GLOW_NIGHT = 2.5;
const POOL_DAY = 0.0, POOL_NIGHT = 0.5;

let _vendorPoolTex = null;
function createVendorPoolTexture() {
  if (_vendorPoolTex) return _vendorPoolTex;
  const size = 64;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255, 220, 160, 0.7)');
  grad.addColorStop(0.5, 'rgba(255, 200, 120, 0.3)');
  grad.addColorStop(1, 'rgba(255, 180, 100, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  _vendorPoolTex = new THREE.CanvasTexture(c);
  _vendorPoolTex.needsUpdate = true;
  return _vendorPoolTex;
}

function getVendorGlowMat() {
  if (!_vendorGlowMat) {
    _vendorGlowMat = new THREE.MeshBasicMaterial({
      color: 0xffd898,
      transparent: true,
      opacity: GLOW_DAY,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }
  return _vendorGlowMat;
}

function getVendorPoolMat() {
  if (!_vendorPoolMat) {
    _vendorPoolMat = new THREE.MeshBasicMaterial({
      map: createVendorPoolTexture(),
      transparent: true,
      opacity: POOL_DAY,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
  }
  return _vendorPoolMat;
}

/**
 * Toggle sign board + overhead illumination at night.
 */
export function setVendorCartNightMode(isNight) {
  const intensity = isNight ? 1.5 : 0;
  for (const mat of _allSignMats) {
    mat.emissiveIntensity = intensity;
  }
  if (_vendorGlowMat) _vendorGlowMat.opacity = isNight ? GLOW_NIGHT : GLOW_DAY;
  if (_vendorPoolMat) _vendorPoolMat.opacity = isNight ? POOL_NIGHT : POOL_DAY;
}

// Shirt colors for people
const SHIRT_COLORS = [0x885533, 0x335588, 0x558833, 0xaa5533, 0x666666, 0x993333, 0xcc8844];
const _shirtMats = new Map();
function matShirt(color) {
  if (!_shirtMats.has(color)) {
    _shirtMats.set(color, shared(new THREE.MeshLambertMaterial({ color })));
  }
  return _shirtMats.get(color);
}

const PANT_COLORS = [0x333344, 0x444433, 0x554433, 0x333333, 0x2a2a3a];
const _pantMats = new Map();
function matPant(color) {
  if (!_pantMats.has(color)) {
    _pantMats.set(color, shared(new THREE.MeshLambertMaterial({ color })));
  }
  return _pantMats.get(color);
}

// ─── Seeded RNG ──────────────────────────────────────────────────────────────
function seededRng(seed) {
  let s = seed | 0;
  return () => { s = (s * 1664525 + 1013904223) & 0x7fffffff; return s / 0x7fffffff; };
}

// ─── Geometry builders ───────────────────────────────────────────────────────

/**
 * Build a low-poly person standing at origin, facing +Z. height ~ 1.7m
 */
function buildPerson(rng) {
  const geos = [];
  const shirtColor = SHIRT_COLORS[Math.floor(rng() * SHIRT_COLORS.length)];
  const pantColor = PANT_COLORS[Math.floor(rng() * PANT_COLORS.length)];

  for (const side of [-1, 1]) {
    const leg = new THREE.CylinderGeometry(0.07, 0.08, 0.8, 5);
    leg.translate(side * 0.1, 0.4, 0);
    geos.push({ geo: leg, matRef: matPant(pantColor) });
  }

  const torso = new THREE.BoxGeometry(0.35, 0.55, 0.2);
  torso.translate(0, 1.07, 0);
  geos.push({ geo: torso, matRef: matShirt(shirtColor) });

  for (const side of [-1, 1]) {
    const arm = new THREE.CylinderGeometry(0.05, 0.05, 0.5, 5);
    arm.translate(side * 0.24, 1.0, 0);
    geos.push({ geo: arm, matRef: matShirt(shirtColor) });
  }

  const head = new THREE.SphereGeometry(0.12, 6, 5);
  head.translate(0, 1.48, 0);
  geos.push({ geo: head, matRef: matSkin() });

  const hair = new THREE.SphereGeometry(0.13, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2);
  hair.translate(0, 1.5, 0);
  geos.push({ geo: hair, matRef: matHair() });

  return geos;
}

/**
 * Build vendor cart at origin facing +Z (road side).
 * Cart is ~3.0m wide, ~1.3m deep, ~2.6m tall (with sign board + canopy).
 * Returns { geos, roofY } — roofY used for glow panel placement.
 */
function buildCart(rng, cartColor, signName) {
  const geos = [];
  const cw = 3.0, cd = 1.3, ch = 1.1; // cart body w, d, h

  // Cart body (box)
  const body = new THREE.BoxGeometry(cw, ch, cd);
  body.translate(0, ch / 2 + 0.35, 0);
  geos.push({ geo: body, matKey: 'cartColor', color: cartColor });

  // Counter top (steel)
  const counter = new THREE.BoxGeometry(cw + 0.2, 0.06, cd + 0.2);
  counter.translate(0, ch + 0.35 + 0.03, 0);
  geos.push({ geo: counter, matKey: 'steel' });

  // Front counter extension (serving shelf)
  const shelf = new THREE.BoxGeometry(cw + 0.2, 0.05, 0.5);
  shelf.translate(0, ch + 0.35, cd / 2 + 0.28);
  geos.push({ geo: shelf, matKey: 'steel' });

  // Wheels (4 wheels — bigger)
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = new THREE.CylinderGeometry(0.2, 0.2, 0.1, 8);
      wheel.rotateZ(Math.PI / 2);
      wheel.translate(sx * (cw / 2 + 0.05), 0.2, sz * (cd / 2 - 0.15));
      geos.push({ geo: wheel, matKey: 'darkGray' });
    }
  }

  // Vertical frame posts for sign board (4 posts)
  const topY = ch + 0.35;
  const signH = 0.7;
  const signTopY = topY + 1.0;
  for (const sx of [-1, 1]) {
    for (const sz of [-0.8, 0.8]) {
      const postH = signTopY - topY + signH * 0.3 + 0.15;
      const post = new THREE.BoxGeometry(0.05, postH, 0.05);
      post.translate(sx * (cw / 2 - 0.03), topY + postH / 2, sz * cd / 2);
      geos.push({ geo: post, matKey: 'steel' });
    }
  }

  // Roof / canopy (overhangs front)
  const roofY = signTopY + signH / 2 + 0.08;
  const roof = new THREE.BoxGeometry(cw + 0.35, 0.04, cd + 0.5);
  roof.translate(0, roofY, 0.1);
  geos.push({ geo: roof, matKey: 'steel' });

  // Sign board — front face (4:1 aspect to match 256x64 canvas)
  const signW = cw - 0.1;
  const signGeo = new THREE.PlaneGeometry(signW, signH);
  signGeo.translate(0, signTopY, cd / 2 + 0.01);
  geos.push({ geo: signGeo, matKey: 'sign', signName, color: cartColor });

  // Side frame panels
  for (const sx of [-1, 1]) {
    const sidePanel = new THREE.BoxGeometry(0.03, signTopY - topY, cd - 0.1);
    sidePanel.translate(sx * cw / 2, topY + (signTopY - topY) / 2, 0);
    geos.push({ geo: sidePanel, matKey: 'steel' });
  }

  // Gas cylinder underneath
  const cylinder = new THREE.CylinderGeometry(0.12, 0.12, 0.4, 6);
  cylinder.translate(0.6, 0.22, -cd / 2 + 0.18);
  geos.push({ geo: cylinder, matKey: 'darkGray' });

  // Cooking pan / steamer on top
  const pan = new THREE.CylinderGeometry(0.28, 0.25, 0.16, 8);
  pan.translate(-0.5, topY + 0.11, 0);
  geos.push({ geo: pan, matKey: 'steel' });

  // Second cooking vessel
  const pan2 = new THREE.CylinderGeometry(0.22, 0.2, 0.12, 8);
  pan2.translate(0.4, topY + 0.09, -0.08);
  geos.push({ geo: pan2, matKey: 'steel' });

  // Third item — small pot
  const pot = new THREE.CylinderGeometry(0.15, 0.14, 0.1, 6);
  pot.translate(0, topY + 0.08, 0.15);
  geos.push({ geo: pot, matKey: 'darkGray' });

  return { geos, roofY, cw, cd };
}

// ─── Road placement helpers ──────────────────────────────────────────────────

function angleToNearestRoad(wx, wz, roads) {
  if (!roads || roads.length === 0) return 0;
  let bestDist = Infinity, bestAngle = 0;
  for (const road of roads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i].x, az = pts[i].y;
      const bx = pts[i + 1].x, bz = pts[i + 1].y;
      const dx = bx - ax, dz = bz - az;
      const len2 = dx * dx + dz * dz;
      if (len2 < 0.01) continue;
      const t = Math.max(0, Math.min(1, ((wx - ax) * dx + (wz - az) * dz) / len2));
      const cx = ax + t * dx, cz = az + t * dz;
      const d = Math.hypot(wx - cx, wz - cz);
      if (d < bestDist) {
        bestDist = d;
        bestAngle = Math.atan2(cx - wx, cz - wz);
      }
    }
  }
  return bestAngle;
}


/** Check if point is inside any building footprint (simple AABB check). */
function isInsideBuilding(px, pz, buildings) {
  if (!buildings) return false;
  for (const b of buildings) {
    const fp = b.footprint;
    if (!fp || fp.length < 3) continue;
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (const pt of fp) {
      const x = pt.x ?? pt[0], z = pt.y ?? pt[1];
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
    if (px >= mnx && px <= mxx && pz >= mnz && pz <= mxz) return true;
  }
  return false;
}

// ─── Scatter vendor cart CLUSTERS along roads ────────────────────────────────

const CLUSTER_SPACING = 50;  // minimum metres between cluster centers
const CART_GAP = 5.0;        // gap between carts in a cluster (side by side)
const MAX_CARTS_PER_TILE = 16; // hard cap

/**
 * Generate vendor cart cluster positions for a tile.
 * Each cluster = 2-3 carts placed side by side along road direction.
 * Placement along ALL non-motorway roads including trunk, primary, secondary.
 */
function scatterVendorPositions(roads, buildings, tileKey, vegMask) {
  if (!roads || roads.length === 0) return [];

  const seed = tileKey.split('_').reduce((a, v) => a * 31 + (parseInt(v) || 0), 7);
  const rng = seededRng(seed + 9999);

  // Ground-road occupancy grid: O(1) check to keep carts off road surfaces
  const groundGrid = buildGroundRoadGrid(roads);

  const clusters = [];
  const allCarts = [];

  // Sort roads so big roads are processed first (they get priority placement)
  const BIG_TYPES = new Set(['trunk', 'trunk_link', 'primary', 'primary_link', 'secondary']);
  const sortedRoads = [...roads].sort((a, b) => {
    const aB = BIG_TYPES.has(a.highwayType || '') ? 0 : 1;
    const bB = BIG_TYPES.has(b.highwayType || '') ? 0 : 1;
    return aB - bB;
  });

  for (const road of sortedRoads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const hw = (road.width || 6) / 2;

    const ht = road.highwayType || '';
    if (ht === 'motorway' || ht === 'motorway_link' || ht === 'secondary_link') continue;
    if (road.bridge || road.tunnel) continue;
    // Skip ramp/link roads that descend below ground (tunnel approaches)
    if (pts.some(p => p.elevation != null && p.elevation < -0.5)) continue;

    const isBigRoad = BIG_TYPES.has(ht);
    const isLink = ht.endsWith('_link');
    // Big roads: always attempt, every 25-35m. Small roads: 35% chance, every 50m.
    const placeChance = isBigRoad ? 0.85 : 0.35;
    const spacing = isBigRoad ? 30 : CLUSTER_SPACING;

    // Precompute total road length and segment start distances for _link skip
    const LINK_SKIP_DIST = 20;
    let totalLen = 0;
    const segStarts = [0];
    for (let si = 0; si < pts.length - 1; si++) {
      totalLen += Math.hypot(pts[si + 1].x - pts[si].x, pts[si + 1].y - pts[si].y);
      segStarts.push(totalLen);
    }

    let accumulated = rng() * spacing * 0.3;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i].x, az = pts[i].y;
      const bx = pts[i + 1].x, bz = pts[i + 1].y;
      const sdx = bx - ax, sdz = bz - az;
      const segLen = Math.hypot(sdx, sdz);
      if (segLen < 1) continue;

      const perpX = sdz / segLen, perpZ = -sdx / segLen;

      while (accumulated < segLen) {
        if (allCarts.length >= MAX_CARTS_PER_TILE) break;

        if (rng() > placeChance) {
          accumulated += spacing * (0.2 + rng() * 0.3);
          continue;
        }

        // Skip first/last 20m of _link roads (merge/diverge zones)
        if (isLink) {
          const cumDist = segStarts[i] + accumulated;
          if (cumDist < LINK_SKIP_DIST || cumDist > totalLen - LINK_SKIP_DIST) {
            accumulated += spacing * (0.3 + rng() * 0.3);
            continue;
          }
        }

        const t = accumulated / segLen;
        const cx = ax + t * sdx, cz = az + t * sdz;

        // Offset perpendicular from THIS road's edge
        const side = rng() > 0.5 ? 1 : -1;
        const edgeGap = 3 + rng() * 1.5;
        const offset = hw + edgeGap;
        const wx = cx + side * perpX * offset;
        const wz = cz + side * perpZ * offset;

        // Check spacing from existing clusters (use smaller radius for big roads)
        const minClusterDist = isBigRoad ? 20 : spacing;
        let tooClose = false;
        for (const cl of clusters) {
          if (Math.hypot(wx - cl[0], wz - cl[1]) < minClusterDist) {
            tooClose = true;
            break;
          }
        }
        // Check against individual carts from other clusters
        if (!tooClose) {
          for (const cart of allCarts) {
            if (Math.hypot(wx - cart.x, wz - cart.z) < 10) {
              tooClose = true;
              break;
            }
          }
        }

        // Reject if cluster center is on a road surface or too close to road edge
        if (!tooClose) {
          if (isOnGroundRoad(groundGrid, wx, wz)) tooClose = true;
          else if (!isVegetationAllowed(vegMask, wx, wz, 2)) tooClose = true;
        }

        if (!tooClose && !isInsideBuilding(wx, wz, buildings)) {
          clusters.push([wx, wz]);
          const angle = angleToNearestRoad(wx, wz, roads);

          const numCarts = rng() < 0.45 ? 2 : 3;
          const totalW = (numCarts - 1) * CART_GAP;
          const sinA = Math.sin(angle), cosA = Math.cos(angle);
          const rx = cosA, rz = -sinA;

          for (let c = 0; c < numCarts; c++) {
            if (allCarts.length >= MAX_CARTS_PER_TILE) break;
            const lateralOff = -totalW / 2 + c * CART_GAP + (rng() - 0.5) * 0.8;
            const depthOff = (rng() - 0.5) * 0.6;
            const cartX = wx + rx * lateralOff + sinA * depthOff;
            const cartZ = wz + rz * lateralOff + cosA * depthOff;
            const cartAngle = angle + (rng() - 0.5) * 0.45;

            if (!isOnGroundRoad(groundGrid, cartX, cartZ) && isVegetationAllowed(vegMask, cartX, cartZ, 1) && !isInsideBuilding(cartX, cartZ, buildings)) {
              allCarts.push({
                x: cartX, z: cartZ, angle: cartAngle,
                seed: seed + allCarts.length * 137,
              });
            }
          }
        }

        accumulated += spacing * (0.5 + rng() * 0.4);
      }
      accumulated -= segLen;
      if (allCarts.length >= MAX_CARTS_PER_TILE) break;
    }
    if (allCarts.length >= MAX_CARTS_PER_TILE) break;
  }

  return allCarts;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Build vendor cart meshes for a tile.
 */
export function buildVendorCartMeshes(roads, buildings, tileKey, vegMask, getGroundY) {
  const groundYAt = typeof getGroundY === 'function' ? getGroundY : () => 0;
  const positions = scatterVendorPositions(roads, buildings, tileKey, vegMask);
  if (positions.length === 0) return [];

  const byMat = new Map();
  const byMatRef = new Map();
  const signGeos = [];
  const glowGeoms = [];
  const poolGeoms = [];

  const _rot = new THREE.Matrix4();
  const _trans = new THREE.Matrix4();
  const _combined = new THREE.Matrix4();

  for (const pos of positions) {
    const rng = seededRng(pos.seed);
    const cartColor = CART_COLORS[Math.floor(rng() * CART_COLORS.length)];
    const signName = SIGN_NAMES[Math.floor(rng() * SIGN_NAMES.length)];

    const { geos: cartParts, roofY, cw, cd } = buildCart(rng, cartColor, signName);

    // Vendor behind cart
    const vendorParts = buildPerson(rng);
    for (const p of vendorParts) {
      p.geo.translate(0, 0, -0.8);
    }

    // 1-2 customers in front
    const numCustomers = 1 + Math.floor(rng() * 2);
    const customerParts = [];
    for (let c = 0; c < numCustomers; c++) {
      const person = buildPerson(rng);
      const px = -0.7 + c * 1.2 + (rng() - 0.5) * 0.3;
      const pz = 1.2 + rng() * 0.5;
      for (const p of person) {
        p.geo.translate(px, 0, pz);
      }
      customerParts.push(...person);
    }

    // Transform — scale down 55% so vendors are proportional to car
    const _scale = new THREE.Matrix4().makeScale(0.55, 0.55, 0.55);
    const wy = groundYAt(pos.x, pos.z); // anchor to terrain (was hardcoded 0)
    if (pos.angle !== 0) {
      _rot.makeRotationY(pos.angle);
      _trans.makeTranslation(pos.x, wy, pos.z);
      _combined.multiplyMatrices(_trans, _rot);
      _combined.multiply(_scale);
    } else {
      _combined.makeTranslation(pos.x, wy, pos.z);
      _combined.multiply(_scale);
    }

    for (const part of cartParts) {
      part.geo.applyMatrix4(_combined);
      if (part.matKey === 'sign') {
        const mat = makeSignMaterial(part.signName, part.color);
        signGeos.push({ geo: part.geo, mat });
      } else if (part.matKey === 'cartColor') {
        const mat = matCartColor(part.color);
        if (!byMatRef.has(mat)) byMatRef.set(mat, []);
        byMatRef.get(mat).push(part.geo);
      } else {
        if (!byMat.has(part.matKey)) byMat.set(part.matKey, []);
        byMat.get(part.matKey).push(part.geo);
      }
    }

    for (const part of [...vendorParts, ...customerParts]) {
      part.geo.applyMatrix4(_combined);
      if (!byMatRef.has(part.matRef)) byMatRef.set(part.matRef, []);
      byMatRef.get(part.matRef).push(part.geo);
    }

    // Glow panel under canopy (facing down)
    const glowW = cw - 0.3, glowD = cd - 0.2;
    const glow = new THREE.PlaneGeometry(glowW, glowD);
    glow.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    glow.translate(0, roofY - 0.06, 0);
    glow.applyMatrix4(_combined);
    glowGeoms.push(glow);

    // Ground light pool (facing up)
    const poolSize = cw + 1.5;
    const pool = new THREE.PlaneGeometry(poolSize, poolSize);
    pool.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    pool.translate(0, 0.1, 0);
    pool.applyMatrix4(_combined);
    poolGeoms.push(pool);
  }

  const MAT_LOOKUP = {
    steel: matSteel, darkGray: matDarkGray, white: matWhite, concrete: matConcrete,
  };

  const meshes = [];

  for (const [matKey, geos] of byMat) {
    if (geos.length === 0) continue;
    const merged = mergeGeometries(geos);
    geos.forEach(g => g.dispose());
    if (!merged) continue;
    const matFn = MAT_LOOKUP[matKey];
    const mat = matFn ? matFn() : matConcrete();
    const mesh = new THREE.Mesh(merged, mat);
    mesh.userData.sharedMaterial = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    meshes.push(mesh);
  }

  for (const [mat, geos] of byMatRef) {
    if (geos.length === 0) continue;
    const merged = mergeGeometries(geos);
    geos.forEach(g => g.dispose());
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.userData.sharedMaterial = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    meshes.push(mesh);
  }

  const signByMat = new Map();
  for (const { geo, mat } of signGeos) {
    if (!signByMat.has(mat)) signByMat.set(mat, []);
    signByMat.get(mat).push(geo);
  }
  for (const [mat, geos] of signByMat) {
    const merged = mergeGeometries(geos);
    geos.forEach(g => g.dispose());
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.userData.sharedMaterial = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    meshes.push(mesh);
  }

  // Glow panel mesh (under canopy, warm light, opacity controlled by night mode)
  if (glowGeoms.length > 0) {
    const merged = mergeGeometries(glowGeoms);
    glowGeoms.forEach(g => g.dispose());
    if (merged) {
      const m = new THREE.Mesh(merged, getVendorGlowMat());
      m.userData.sharedMaterial = true;
      m.castShadow = false;
      m.receiveShadow = false;
      meshes.push(m);
    }
  }

  // Ground pool mesh (radial gradient, opacity controlled by night mode)
  if (poolGeoms.length > 0) {
    const merged = mergeGeometries(poolGeoms);
    poolGeoms.forEach(g => g.dispose());
    if (merged) {
      const m = new THREE.Mesh(merged, getVendorPoolMat());
      m.userData.sharedMaterial = true;
      m.castShadow = false;
      m.receiveShadow = false;
      meshes.push(m);
    }
  }

  return meshes;
}

/**
 * Get exclusion zones for tree placement near vendor carts.
 */
export function getVendorCartExclusionZones(roads, buildings, tileKey, vegMask) {
  const positions = scatterVendorPositions(roads, buildings, tileKey, vegMask);
  return positions.map(p => ({ x: p.x, y: p.z, r: 4 }));
}
