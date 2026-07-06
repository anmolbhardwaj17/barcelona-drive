/**
 * meshMaterializer.js — Main-thread code that wraps raw typed-array buffers
 * from Web Workers into Three.js Mesh / InstancedMesh objects.
 *
 * This file runs on the MAIN THREAD and uses Three.js freely.
 * All geometry data arrives pre-merged from workers — no mergeGeometries calls.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import {
  buildProceduralTreeGeometries,
  getProceduralMaterial,
  getBushGeometry,
  getBushMaterial,
  getTreeBillboardMaterial,
} from '../map/vegetationRenderer.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const FLOOR_HEIGHT = 10;
const WALL_REPEAT_HORIZONTAL_M = 12;

const FOG_COLOR_VEC = 'vec3(0.749, 0.843, 0.933)';

const SHADOW_TEX_SIZE = 128;
const SHADOW_Y_OFFSET = 0.02;

// ─── Window style definitions per category ───────────────────────────────────

// Barcelona Eixample: tall ~2 m French-window openings, ~3 m floor period (aligns with 3 m balconies),
// taller ~3.5–4 m ground floor for shopfronts.
const WINDOW_STYLES = {
  residential:      { winW: 1.1, winH: 2.0, gapH: 1.4, gapV: 1.0, marginB: 3.8, seed: 42  },
  commercial:       { winW: 1.2, winH: 1.9, gapH: 1.2, gapV: 1.1, marginB: 4.0, seed: 137 },
  commercial_glass: { winW: 1.8, winH: 2.4, gapH: 0.20, gapV: 0.6, marginB: 3.5, seed: 313 },
  office:           { winW: 1.3, winH: 1.8, gapH: 0.8, gapV: 1.2, marginB: 3.5, seed: 271 },
  hospital:         { winW: 1.0, winH: 1.6, gapH: 1.2, gapV: 1.4, marginB: 3.0, seed: 389 },
  school:           { winW: 1.4, winH: 1.6, gapH: 1.4, gapV: 1.4, marginB: 3.0, seed: 503 },
  industrial:       { winW: 1.6, winH: 1.4, gapH: 1.6, gapV: 1.6, marginB: 3.0, seed: 631 },
  religious:        { winW: 0.7, winH: 2.4, gapH: 2.2, gapV: 1.4, marginB: 1.5, seed: 757 },
};

// ─── Detail material definitions ─────────────────────────────────────────────

const DETAIL_MATERIAL_DEFS = {
  balconySlab:  { color: 0xB8B4AE, shadows: true },
  balconyRail:  { color: 0x3A3835, shadows: false },
  boundaryWall: { color: 0xA8A49E, shadows: true, useBrickTexture: true },
  gate:         { color: 0x2E2C2A, shadows: false },
  awning:       { color: 0x3A5060, shadows: true },
  acUnit:       { color: 0xD8D4CE, shadows: false },
  acFan:        { color: 0x2A3A4A, shadows: false },
  parapet:      { color: 0x9A9590, shadows: false },
  pillar:       { color: 0xC0BCB6, shadows: true },
  signboard:    { color: 0x2A5070, shadows: false },
  barExtrude:   { color: 0xA8A4A0, shadows: false },
  shikhara:     { color: 0xCAB695, shadows: true }, // Barcelona: warm sandstone church bell-tower
  templeBase:   { color: 0xC8A870, shadows: true },
  templeBand:   { color: 0xD4B870, shadows: false },
  flagPole:     { color: 0x5A5550, shadows: false },
  flag:         { color: 0xFF6600, shadows: false, doubleSide: true },
};

// ─── Billboard ad definitions ────────────────────────────────────────────────

const BILLBOARD_COLORS = [
  { bg: '#1B3A5C', fg: '#FFFFFF', text: 'SALE' },
  { bg: '#8B0000', fg: '#FFD700', text: 'BIG BAZAAR' },
  { bg: '#003366', fg: '#00CCFF', text: 'ELECTRONICS' },
  { bg: '#2E0854', fg: '#FF66AA', text: 'FASHION' },
  { bg: '#004D00', fg: '#FFFF00', text: 'FRESH DEALS' },
  { bg: '#333333', fg: '#FF4400', text: 'MEGA OFFER' },
  { bg: '#0A1628', fg: '#44BBFF', text: 'NEW ARRIVALS' },
  { bg: '#4A0E0E', fg: '#FFD700', text: '50% OFF' },
];

// ─── Texture caches (lazy, created on first access) ──────────────────────────

const _windowTexCache = new Map();
const _billboardTexCache = [];
let _brickWallTex = null;
let _mallSignTex = null;

// ─── Material caches ─────────────────────────────────────────────────────────

const _facadeMaterialCache = new Map();
const _roofMaterialCache = new Map();
const _detailMaterialCache = new Map();
let _tankMaterial = null;
let _pipeMaterial = null;
let _mallSignMaterial = null;

// ─── Shadow texture / material / geometry caches ─────────────────────────────

let _shadowTexture = null;
let _shadowMaterial = null;
let _shadowGeometry = null;

// ─── Tank / Pipe geometry caches ─────────────────────────────────────────────

let _tankGeometry = null;
let _pipeGeometry = null;

// =============================================================================
//  TEXTURE GENERATION (canvas-based, lazy)
// =============================================================================

/**
 * Draw a single recessed window with shadow edges for depth illusion.
 */
function drawRecessedWindow(ctx, x, y, w, h, rnd) {
  const edge = Math.max(2, Math.round(Math.min(w, h) * 0.14));

  // Top reveal shadow (medium, not a black void)
  ctx.fillStyle = '#4A5460';
  ctx.fillRect(x, y, w, edge);

  // Left reveal
  ctx.fillStyle = '#566069';
  ctx.fillRect(x, y + edge, edge, h - edge);

  // Bottom sill (lightest edge)
  ctx.fillStyle = '#7A828C';
  ctx.fillRect(x + edge, y + h - edge, w - edge, edge);

  // Right edge
  ctx.fillStyle = '#5E6872';
  ctx.fillRect(x + w - edge, y + edge, edge, h - edge * 2);

  // Glass center — DAYTIME sky reflection (pale blue-grey), not black holes
  const v = rnd();
  const base = v < 0.20 ? 82 : (v < 0.55 ? 130 : 160);
  const r = base + Math.round(rnd() * 12);
  const g = base + 10 + Math.round(rnd() * 12);
  const b = base + 20 + Math.round(rnd() * 14);
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(x + edge, y + edge, w - edge * 2, h - edge * 2);

  // Subtle highlight streak
  if (w - edge * 2 > 6 && h - edge * 2 > 8) {
    ctx.fillStyle = 'rgba(180,200,220,0.08)';
    ctx.fillRect(x + edge + 1, y + edge + 1, Math.round((w - edge * 2) * 0.3), Math.round((h - edge * 2) * 0.5));
  }
}

function getWindowTexture(category) {
  if (_windowTexCache.has(category)) return _windowTexCache.get(category);

  const style = WINDOW_STYLES[category] || WINDOW_STYLES.residential;
  const W = 256, H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Wall base
  ctx.fillStyle = '#F2F0EC';
  ctx.fillRect(0, 0, W, H);

  const pxW = W / WALL_REPEAT_HORIZONTAL_M;
  const pxH = H / FLOOR_HEIGHT;
  const winW    = Math.round(style.winW * pxW);
  const winH    = Math.round(style.winH * pxH);
  const periodH = winW + Math.round(style.gapH * pxW);
  const periodV = winH + Math.round(style.gapV * pxH);
  const marginL = Math.round(0.6 * pxW);
  const marginB = Math.round(style.marginB * pxH);

  let seed = style.seed;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

  const isResidential = (category === 'residential');
  const isCommercial  = (category === 'commercial');
  const isGlass       = (category === 'commercial_glass');

  // ── Glass curtain wall ──
  if (isGlass) {
    const groundH = Math.round(marginB);
    ctx.fillStyle = '#1A2830';
    ctx.fillRect(0, H - groundH, W, groundH);
    const lobbyW = Math.round(4.0 * pxW);
    const lobbyH = Math.round(groundH * 0.85);
    const lobbyX = Math.round((W - lobbyW) / 2);
    const lobbyY = H - groundH + Math.round(groundH * 0.1);
    ctx.fillStyle = '#142028';
    ctx.fillRect(lobbyX, lobbyY, lobbyW, lobbyH);
    ctx.fillStyle = '#5A6A78';
    ctx.fillRect(lobbyX, lobbyY, lobbyW, 1);
    ctx.fillRect(lobbyX, lobbyY + lobbyH - 1, lobbyW, 1);
    ctx.fillRect(lobbyX, lobbyY, 1, lobbyH);
    ctx.fillRect(lobbyX + lobbyW - 1, lobbyY, 1, lobbyH);

    for (let y = H - marginB - winH; y >= 0; y -= periodV) {
      for (let x = marginL; x + winW <= W; x += periodH) {
        const v = rnd();
        const base = v < 0.2 ? 95 : (v < 0.5 ? 135 : 165); // Barcelona: light sky-reflecting glass
        const r = base + Math.round(rnd() * 10);
        const g = base + 12 + Math.round(rnd() * 10);
        const b2 = base + 22 + Math.round(rnd() * 12);
        ctx.fillStyle = `rgb(${r},${g},${b2})`;
        ctx.fillRect(x, y, winW, winH);
        ctx.fillStyle = 'rgba(140,170,200,0.06)';
        ctx.fillRect(x + 1, y + 1, winW - 2, Math.round(winH * 0.3));
        ctx.fillStyle = '#5A6A78';
        ctx.fillRect(x, y, winW, 1);
        ctx.fillRect(x, y + winH - 1, winW, 1);
        ctx.fillRect(x, y, 1, winH);
        ctx.fillRect(x + winW - 1, y, 1, winH);
      }
      const mullionY = y + winH;
      ctx.fillStyle = '#4A5A68';
      ctx.fillRect(0, mullionY, W, Math.max(2, Math.round(0.08 * pxH)));
    }
    ctx.fillStyle = '#3A4A58';
    ctx.fillRect(0, 0, W, Math.max(3, Math.round(0.15 * pxH)));
  }

  // ── Commercial: shopfront + signboard ──
  if (isCommercial) {
    const groundH = Math.round(marginB);
    ctx.fillStyle = '#2A3840';
    ctx.fillRect(0, H - groundH, W, groundH);
    const bayW = Math.round(3.0 * pxW);
    const bayGap = Math.round(0.15 * pxW);
    const bayH = Math.round(groundH * 0.7);
    const bayY = H - groundH + Math.round(groundH * 0.25);
    for (let sx = Math.round(0.2 * pxW); sx + bayW <= W; sx += bayW + bayGap) {
      ctx.fillStyle = '#6E7880';
      ctx.fillRect(sx, bayY, bayW, bayH);
      const v = rnd();
      const tint = v < 0.3 ? '#1E2E38' : (v < 0.6 ? '#283A44' : '#2C3C48');
      ctx.fillStyle = tint;
      ctx.fillRect(sx + 2, bayY + 2, bayW - 4, bayH - 4);
      ctx.fillStyle = '#6E7880';
      ctx.fillRect(sx + Math.round(bayW / 2) - 1, bayY, 2, bayH);
    }
    const signH = Math.max(4, Math.round(0.35 * pxH));
    const signY = H - groundH - signH;
    const signColors = ['#1A5276', '#7B241C', '#196F3D', '#7D6608', '#4A235A', '#1B4F72', '#6E2C00'];
    const signColor = signColors[seed % signColors.length];
    ctx.fillStyle = signColor;
    ctx.fillRect(0, signY, W, signH);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    const textY = signY + Math.round(signH * 0.35);
    const textH = Math.max(2, Math.round(signH * 0.3));
    ctx.fillRect(Math.round(0.15 * W), textY, Math.round(0.7 * W), textH);
  }

  // ── Residential/Eixample ground floor: street-level SHOPFRONTS (Barcelona) ──
  if (isResidential) {
    const groundH = Math.round(marginB);
    const baseY = H - groundH;
    ctx.fillStyle = '#A89A82';                       // warm-stone shopfront base
    ctx.fillRect(0, baseY, W, groundH);
    const fasciaH = Math.round(groundH * 0.18);
    ctx.fillStyle = '#6E6456';                       // fascia sign band
    ctx.fillRect(0, baseY, W, fasciaH);
    const bayW = Math.max(8, Math.round(3.2 * pxW));
    const pilasterW = Math.max(2, Math.round(0.5 * pxW));
    const winTop = baseY + fasciaH + Math.round(groundH * 0.08);
    const winH2 = Math.max(4, groundH - fasciaH - Math.round(groundH * 0.22));
    for (let sx = pilasterW; sx + bayW <= W; sx += bayW + pilasterW) {
      ctx.fillStyle = '#2A3A42'; ctx.fillRect(sx, winTop, bayW, winH2);                 // shop glass
      ctx.fillStyle = '#46606C'; ctx.fillRect(sx + 2, winTop + 2, Math.round(bayW * 0.35), winH2 - 4); // highlight
      ctx.fillStyle = '#7A6E5C'; ctx.fillRect(sx, winTop + winH2, bayW, Math.round(groundH * 0.1));     // stall riser
    }
  }

  // ── Draw windows ──
  let floorIdx = 0;
  for (let y = H - marginB - winH; y >= 0; y -= periodV) {
    if (isResidential) {
      const slabH = Math.max(2, Math.round(0.12 * pxH));
      const slabY = y + winH + Math.round(0.15 * pxH);
      ctx.fillStyle = '#9A9590';
      ctx.fillRect(0, slabY, W, slabH);
      ctx.fillStyle = 'rgba(60,55,50,0.15)';
      ctx.fillRect(0, slabY + slabH, W, Math.max(1, Math.round(0.04 * pxH)));
    }

    for (let x = marginL; x + winW <= W; x += periodH) {
      drawRecessedWindow(ctx, x, y, winW, winH, rnd);
      ctx.fillStyle = '#A09890';
      const sillH = Math.max(1, Math.round(0.06 * pxH));
      ctx.fillRect(x - 1, y + winH, winW + 2, sillH);
    }
    floorIdx++;
  }

  // ── Residential parapet cornice ──
  if (isResidential) {
    const corniceH = Math.max(2, Math.round(0.15 * pxH));
    ctx.fillStyle = '#8A8580';
    ctx.fillRect(0, 0, W, corniceH);
    ctx.fillStyle = 'rgba(60,55,50,0.12)';
    ctx.fillRect(0, corniceH, W, Math.max(1, Math.round(0.05 * pxH)));
  }

  // ── Religious: ornamental bands + arched windows ──
  if (category === 'religious') {
    const bandColors = ['#D4B870', '#C8A858', '#DCC080', '#B89840'];
    let bandIdx = 0;
    for (let y = H - marginB - winH; y >= 0; y -= periodV) {
      const bandY = y + winH + Math.round(0.05 * pxH);
      const bandH = Math.max(3, Math.round(0.14 * pxH));
      ctx.fillStyle = bandColors[bandIdx % bandColors.length];
      ctx.fillRect(0, bandY, W, bandH);
      ctx.fillStyle = 'rgba(40,20,10,0.25)';
      ctx.fillRect(0, bandY - 1, W, 1);
      bandIdx++;
    }
    for (let y = H - marginB - winH; y >= 0; y -= periodV) {
      for (let x = marginL; x + winW <= W; x += periodH) {
        const archR = winW / 2;
        const archCx = x + winW / 2;
        const archCy = y;
        ctx.beginPath();
        ctx.arc(archCx, archCy, archR, Math.PI, 0);
        ctx.closePath();
        ctx.fillStyle = '#5A2A18';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(archCx, archCy - archR + 2, 2, 0, Math.PI * 2);
        ctx.fillStyle = '#D4B870';
        ctx.fill();
      }
    }
    const corniceH = Math.max(4, Math.round(0.25 * pxH));
    ctx.fillStyle = '#D4B870';
    ctx.fillRect(0, 0, W, corniceH);
    ctx.fillStyle = 'rgba(60,25,10,0.3)';
    ctx.fillRect(0, corniceH, W, 2);
    const plinthH = Math.max(4, Math.round(0.3 * pxH));
    ctx.fillStyle = '#A08060';
    ctx.fillRect(0, H - plinthH, W, plinthH);
  }

  // ── Commercial parapet + floor bands ──
  if (isCommercial) {
    const corniceH = Math.max(3, Math.round(0.2 * pxH));
    ctx.fillStyle = '#5A5550';
    ctx.fillRect(0, 0, W, corniceH);
    ctx.fillStyle = 'rgba(40,35,30,0.2)';
    ctx.fillRect(0, corniceH, W, Math.max(1, Math.round(0.06 * pxH)));
    for (let y = H - marginB - winH; y >= 0; y -= periodV) {
      const bandY = y + winH + Math.round(0.1 * pxH);
      const bandH = Math.max(2, Math.round(0.08 * pxH));
      ctx.fillStyle = '#8A8680';
      ctx.fillRect(0, bandY, W, bandH);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  _windowTexCache.set(category, tex);
  return tex;
}

function getBrickWallTexture() {
  if (_brickWallTex) return _brickWallTex;
  const W = 128, H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#8a8580';
  ctx.fillRect(0, 0, W, H);
  const brickH = 16, brickW = 32, mortarW = 2;
  const rows = Math.ceil(H / brickH);
  for (let row = 0; row < rows; row++) {
    const y = row * brickH;
    const offset = (row % 2 === 0) ? 0 : brickW / 2;
    for (let col = -1; col < Math.ceil(W / brickW) + 1; col++) {
      const x = col * brickW + offset;
      const v = 0.92 + Math.random() * 0.16;
      const r = Math.round(168 * v), g = Math.round(164 * v), b = Math.round(158 * v);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x + mortarW, y + mortarW, brickW - mortarW * 2, brickH - mortarW * 2);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  _brickWallTex = tex;
  return tex;
}

function getMallSignTexture() {
  if (_mallSignTex) return _mallSignTex;
  const W = 512, H = 64;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1A1A1A';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#FF2222';
  ctx.lineWidth = 2;
  ctx.strokeRect(2, 2, W - 4, H - 4);
  ctx.fillStyle = '#FF2020';
  ctx.font = 'bold 38px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#FF0000';
  ctx.shadowBlur = 12;
  ctx.fillText('SHOPPING MALL', W / 2, H / 2);
  ctx.shadowBlur = 6;
  ctx.fillText('SHOPPING MALL', W / 2, H / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  _mallSignTex = tex;
  return tex;
}

function getBillboardTexture(seed) {
  const idx = Math.abs(seed) % BILLBOARD_COLORS.length;
  if (_billboardTexCache[idx]) return _billboardTexCache[idx];
  const W = 256, H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const ad = BILLBOARD_COLORS[idx];
  ctx.fillStyle = ad.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = ad.fg;
  ctx.lineWidth = 4;
  ctx.strokeRect(4, 4, W - 8, H - 8);
  ctx.fillStyle = ad.fg;
  ctx.font = 'bold 32px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ad.text, W / 2, H / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  _billboardTexCache[idx] = tex;
  return tex;
}

// =============================================================================
//  SHADOW TEXTURE / MATERIAL / GEOMETRY (for tree shadows)
// =============================================================================

function getShadowTexture() {
  if (_shadowTexture) return _shadowTexture;
  const canvas = document.createElement('canvas');
  canvas.width = SHADOW_TEX_SIZE;
  canvas.height = SHADOW_TEX_SIZE;
  const ctx = canvas.getContext('2d');
  const cx = SHADOW_TEX_SIZE / 2, cy = SHADOW_TEX_SIZE / 2;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cx);
  g.addColorStop(0,    'rgba(0,0,0,0.45)');
  g.addColorStop(0.4,  'rgba(0,0,0,0.40)');
  g.addColorStop(0.65, 'rgba(0,0,0,0.22)');
  g.addColorStop(0.85, 'rgba(0,0,0,0.06)');
  g.addColorStop(1,    'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SHADOW_TEX_SIZE, SHADOW_TEX_SIZE);
  _shadowTexture = new THREE.CanvasTexture(canvas);
  return _shadowTexture;
}

function getShadowMaterial() {
  if (_shadowMaterial) return _shadowMaterial;
  _shadowMaterial = new THREE.MeshBasicMaterial({
    map: getShadowTexture(),
    transparent: true,
    depthWrite: false,
    opacity: 1.0,
    side: THREE.DoubleSide,
  });
  return _shadowMaterial;
}

function getShadowGeometry() {
  if (_shadowGeometry) return _shadowGeometry;
  _shadowGeometry = new THREE.PlaneGeometry(1, 1);
  _shadowGeometry.rotateX(-Math.PI / 2);
  return _shadowGeometry;
}

// =============================================================================
//  TANK / PIPE GEOMETRY (compound, cached)
// =============================================================================

function getTankGeometry() {
  if (_tankGeometry) return _tankGeometry;

  // Compound tank: tapered body + lid cap + 3 horizontal ridge rings
  const bodyH = 1.4;
  const body = new THREE.CylinderGeometry(0.7, 0.85, bodyH, 10);
  body.translate(0, bodyH / 2, 0);
  const lid = new THREE.CylinderGeometry(0.45, 0.7, 0.15, 10);
  lid.translate(0, bodyH + 0.075, 0);
  const cap = new THREE.CylinderGeometry(0.22, 0.25, 0.1, 8);
  cap.translate(0, bodyH + 0.15 + 0.05, 0);
  const ridgeParts = [];
  for (let ri = 0; ri < 3; ri++) {
    const ry = 0.3 + ri * 0.4;
    const rFrac = ry / bodyH;
    const rRadius = 0.85 + (0.7 - 0.85) * rFrac;
    const ridge = new THREE.TorusGeometry(rRadius + 0.02, 0.025, 4, 10);
    ridge.rotateX(Math.PI / 2);
    ridge.translate(0, ry, 0);
    ridgeParts.push(ridge);
  }
  _tankGeometry = mergeGeometries([body, lid, cap, ...ridgeParts], false);
  // Dispose source geometries
  body.dispose(); lid.dispose(); cap.dispose();
  ridgeParts.forEach(r => r.dispose());
  return _tankGeometry;
}

function getTankMaterial() {
  if (!_tankMaterial) {
    _tankMaterial = new THREE.MeshLambertMaterial({ color: 0xE8E4DC });
  }
  return _tankMaterial;
}

function getPipeGeometry() {
  if (_pipeGeometry) return _pipeGeometry;
  _pipeGeometry = new THREE.CylinderGeometry(1, 1, 1, 5);
  _pipeGeometry.translate(0, 0.5, 0); // origin at base
  return _pipeGeometry;
}

function getPipeMaterial() {
  if (!_pipeMaterial) {
    _pipeMaterial = new THREE.MeshLambertMaterial({ color: 0x6E6E6E });
  }
  return _pipeMaterial;
}

// =============================================================================
//  MATERIAL REGISTRY
// =============================================================================

/**
 * Inject fog shader modification into a material so distant buildings
 * fade cleanly toward the fog color.
 */
function injectFogShader(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <fog_fragment>',
      `#ifdef USE_FOG
        float fogDepth = vFogDepth;
        #ifdef FOG_EXP2
          float fogFactor = 1.0 - exp(-fogDensity * fogDensity * fogDepth * fogDepth);
        #else
          float fogFactor = smoothstep(fogNear, fogFar, fogDepth);
        #endif
        // Clean fade to fog -- no warm desaturation
        gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
      #endif`
    );
  };
}

// Building winding is INCONSISTENT across the worker's geometry (some facades/roofs are wound CW, some
// CCW), so NO single side renders every building correctly — FrontSide left some buildings inside-out
// (a giant flat plane where a near wall was culled), BackSide made others hollow. DoubleSide is the only
// reliable choice; backface culling here would need the worker to emit consistent winding first (deferred).
const BUILDING_SIDE = THREE.DoubleSide;

/**
 * Create or retrieve a facade material by category and hex color.
 * Matches the logic in buildingRenderer.js getFacadeMaterial().
 */
function getFacadeMaterial(hexColor, category) {
  const cacheKey = hexColor + '_' + category;
  if (_facadeMaterialCache.has(cacheKey)) return _facadeMaterialCache.get(cacheKey);

  const isGlass  = (category === 'commercial_glass');
  const isTemple = (category === 'religious');
  let mat;

  if (isGlass) {
    mat = new THREE.MeshPhongMaterial({
      color: hexColor,
      vertexColors: true,
      map: getWindowTexture(category),
      specular: 0x8899AA,
      shininess: 60,
      reflectivity: 0.4,
      side: BUILDING_SIDE,
    });
  } else if (isTemple) {
    mat = new THREE.MeshPhongMaterial({
      color: hexColor,
      vertexColors: true,
      map: getWindowTexture(category),
      specular: 0x442211,
      shininess: 12,
      side: BUILDING_SIDE,
    });
  } else {
    mat = new THREE.MeshLambertMaterial({
      color: hexColor,
      vertexColors: true,
      map: getWindowTexture(category),
      side: BUILDING_SIDE,
    });
  }

  injectFogShader(mat);
  _facadeMaterialCache.set(cacheKey, mat);
  return mat;
}

/**
 * Create or retrieve a roof material (simple Lambert with vertexColors).
 */
function getRoofMaterial(hexColor) {
  if (hexColor == null) hexColor = 0xD9CFC1;
  if (_roofMaterialCache.has(hexColor)) return _roofMaterialCache.get(hexColor);
  const mat = new THREE.MeshLambertMaterial({ color: hexColor, vertexColors: true, side: BUILDING_SIDE });
  _roofMaterialCache.set(hexColor, mat);
  return mat;
}

/**
 * Create or retrieve a detail material by type name.
 */
function getDetailMaterial(type) {
  if (_detailMaterialCache.has(type)) return _detailMaterialCache.get(type);

  const def = DETAIL_MATERIAL_DEFS[type];
  if (!def) {
    // Fallback: neutral grey Lambert
    const fallback = new THREE.MeshLambertMaterial({ color: 0x888888, side: THREE.DoubleSide });
    _detailMaterialCache.set(type, fallback);
    return fallback;
  }

  let mat;
  if (def.phong) {
    mat = new THREE.MeshPhongMaterial({
      color: def.color,
      specular: def.specular || 0x111111,
      shininess: def.shininess || 30,
      side: THREE.DoubleSide,
    });
  } else {
    const opts = { color: def.color, side: THREE.DoubleSide };
    if (def.useBrickTexture) opts.map = getBrickWallTexture();
    mat = new THREE.MeshLambertMaterial(opts);
  }

  _detailMaterialCache.set(type, mat);
  return mat;
}

/**
 * Get mall sign material (emissive red text on dark backing).
 */
function getMallSignMaterial() {
  if (!_mallSignMaterial) {
    _mallSignMaterial = new THREE.MeshLambertMaterial({
      map: getMallSignTexture(),
      side: THREE.DoubleSide,
    });
  }
  return _mallSignMaterial;
}

/**
 * Resolve a materialKey string to a Three.js Material.
 *
 * Key formats:
 *   facade_<category>_<hexColor>
 *   roof_<hexColor>
 *   mallSign
 *   mallBillboard_<seed>
 *   <detailType>
 */
function getMaterialByKey(materialKey) {
  if (!materialKey) return getDetailMaterial('_fallback');

  // facade_<category>_<hexColor>
  if (materialKey.startsWith('facade_')) {
    const rest = materialKey.slice(7); // after "facade_"
    const lastUnderscore = rest.lastIndexOf('_');
    if (lastUnderscore !== -1) {
      const category = rest.slice(0, lastUnderscore);
      const hexStr = rest.slice(lastUnderscore + 1);
      const hexColor = parseInt(hexStr, 16);
      return getFacadeMaterial(hexColor, category);
    }
  }

  // roof_<hexColor>
  if (materialKey.startsWith('roof_')) {
    const hexStr = materialKey.slice(5);
    const hexColor = parseInt(hexStr, 16);
    return getRoofMaterial(hexColor);
  }

  // mallSign
  if (materialKey === 'mallSign') {
    return getMallSignMaterial();
  }

  // mallBillboard_<seed>
  if (materialKey.startsWith('mallBillboard_')) {
    const seed = parseInt(materialKey.slice(14), 10) || 0;
    return new THREE.MeshLambertMaterial({
      map: getBillboardTexture(seed),
      side: THREE.DoubleSide,
    });
  }

  // Detail type
  return getDetailMaterial(materialKey);
}

// =============================================================================
//  BUILDING MATERIALIZER
// =============================================================================

/**
 * Takes the output from processBuildingsInWorker and creates Three.js meshes.
 * All geometry data comes pre-merged from the worker as typed arrays.
 *
 * @param {object} workerResult - Output from building worker
 * @returns {THREE.Mesh[]} Array of ready-to-render meshes
 */
/** Check first few positions for NaN — skip bad groups to avoid Three.js errors */
function hasNaNPositions(positions) {
  if (!positions || positions.length === 0) return false;
  const check = Math.min(positions.length, 30);
  for (let i = 0; i < check; i++) {
    if (isNaN(positions[i])) return true;
  }
  return false;
}

/**
 * Materialize a single geometry group into a THREE.Mesh.
 */
function materializeGroup(group, material, shadowsOn) {
  if (hasNaNPositions(group.positions)) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(group.positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(group.normals, 3));
  if (group.uvs) geo.setAttribute('uv', new THREE.Float32BufferAttribute(group.uvs, 2));
  if (group.colors) geo.setAttribute('color', new THREE.Float32BufferAttribute(group.colors, 3));
  if (group.indices) geo.setIndex(new THREE.Uint32BufferAttribute(group.indices, 1));

  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = shadowsOn;
  mesh.receiveShadow = shadowsOn;
  mesh.frustumCulled = true;
  mesh.userData.sharedMaterial = true;
  return mesh;
}

/**
 * Async building materializer — yields to main thread between wall/roof/detail
 * phases so GPU uploads don't cause a single long frame stall.
 *
 * @param {object} workerResult
 * @param {Function} yieldFn - async function that yields a frame (e.g. yieldToMain)
 * @returns {Promise<THREE.Mesh[]>}
 */
export async function materializeBuildingMeshes(workerResult, yieldFn) {
  const meshes = [];
  const shadowsOn = !!CONFIG.ENABLE_SHADOWS;

  // ── Building wall groups (batch of 3 per yield) ───────────────────────────
  const wallGroups = workerResult.buildingGroups || [];
  for (let i = 0; i < wallGroups.length; i++) {
    const group = wallGroups[i];
    const material = getMaterialByKey(group.materialKey);
    const mesh = materializeGroup(group, material, shadowsOn);
    if (mesh) meshes.push(mesh);
    if (yieldFn && (i + 1) % 3 === 0) await yieldFn();
  }
  if (yieldFn && wallGroups.length > 0) await yieldFn();

  // ── Roof groups ───────────────────────────────────────────────────────────
  for (const group of workerResult.roofGroups || []) {
    const material = getMaterialByKey(group.materialKey);
    const mesh = materializeGroup(group, material, shadowsOn);
    if (mesh) meshes.push(mesh);
  }
  if (yieldFn && (workerResult.roofGroups || []).length > 0) await yieldFn();

  // ── Detail groups (balconies, AC units, pillars, etc.) ────────────────────
  const detailGroups = workerResult.detailGroups || [];
  for (let i = 0; i < detailGroups.length; i++) {
    const group = detailGroups[i];
    if (hasNaNPositions(group.positions)) continue;
    const material = getMaterialByKey(group.materialKey || group.type);
    const def = DETAIL_MATERIAL_DEFS[group.type];
    const mesh = materializeGroup(group, material, shadowsOn && !!(def && def.shadows));
    if (mesh) {
      if (group.type === 'mallSign') mesh.userData.isMallSign = true;
      // Flag building detail (balconies, rails, parapets, pillars, AC units, awnings) so the tileManager
      // LOD cull hides it past bldgDetailDist (120 m) instead of the full bldgMaxDist (180 m) — it's
      // sub-pixel under fog at that range. Signs are kept visible to the full distance (no flag).
      else mesh.userData.isBuildingDetail = true;
      meshes.push(mesh);
    }
    if (yieldFn && (i + 1) % 4 === 0) await yieldFn();
  }
  if (yieldFn && detailGroups.length > 0) await yieldFn();

  // ── Tank instances (InstancedMesh) ────────────────────────────────────────
  if (workerResult.tankInstances && workerResult.tankInstances.count > 0) {
    const { matrices, count } = workerResult.tankInstances;
    const tankMesh = new THREE.InstancedMesh(getTankGeometry(), getTankMaterial(), count);
    tankMesh.instanceMatrix = new THREE.InstancedBufferAttribute(
      matrices instanceof Float32Array ? matrices : new Float32Array(matrices), 16
    );
    tankMesh.count = count;
    tankMesh.instanceMatrix.needsUpdate = true;
    tankMesh.frustumCulled = true;
    tankMesh.castShadow = false;
    tankMesh.receiveShadow = false;
    tankMesh.userData.sharedGeometry = true;
    tankMesh.userData.sharedMaterial = true;
    meshes.push(tankMesh);
  }

  // ── Pipe instances (InstancedMesh) ────────────────────────────────────────
  if (workerResult.pipeInstances && workerResult.pipeInstances.count > 0) {
    const { matrices, count } = workerResult.pipeInstances;
    const pipeMesh = new THREE.InstancedMesh(getPipeGeometry(), getPipeMaterial(), count);
    pipeMesh.instanceMatrix = new THREE.InstancedBufferAttribute(
      matrices instanceof Float32Array ? matrices : new Float32Array(matrices), 16
    );
    pipeMesh.count = count;
    pipeMesh.instanceMatrix.needsUpdate = true;
    pipeMesh.frustumCulled = true;
    pipeMesh.castShadow = false;
    pipeMesh.receiveShadow = false;
    pipeMesh.userData.sharedGeometry = true;
    pipeMesh.userData.sharedMaterial = true;
    meshes.push(pipeMesh);
  }

  return meshes;
}

// =============================================================================
//  VEGETATION MATERIALIZER
// =============================================================================

/**
 * Takes the output from processVegetationInWorker and creates Three.js
 * InstancedMeshes for trees, shadows, and bushes.
 *
 * @param {object} workerResult - Output from vegetation worker
 * @returns {{ treeMeshes: THREE.InstancedMesh[], shadowMesh: THREE.InstancedMesh|null, bushMesh: THREE.InstancedMesh|null, treePositions: {x:number, y:number}[] }}
 */
export async function materializeVegetationMeshes(workerResult, yieldFn) {
  const treeMeshes = [];
  const YIELD_EVERY = 600; // instances between cooperative yields (keeps this off the critical frame)

  // ── Tree BatchedMesh: all 4 variants in a single draw call ─────────────
  const geometries = buildProceduralTreeGeometries();
  const material = getProceduralMaterial();

  const variants = (workerResult.treeVariants || []).filter(
    v => v.count > 0 && v.variantIndex >= 0 && v.variantIndex < geometries.length
  );

  if (variants.length > 0) {
    // Compute totals for BatchedMesh allocation
    let totalInstances = 0;
    let totalVertices = 0;
    let totalIndices = 0;
    for (const v of variants) {
      totalInstances += v.count;
      const geo = geometries[v.variantIndex];
      totalVertices += geo.getAttribute('position').count;
      totalIndices += geo.getIndex() ? geo.getIndex().count : 0;
    }

    const bm = new THREE.BatchedMesh(totalInstances, totalVertices, totalIndices, material);

    // Add each variant geometry once
    const geoIds = new Map();
    for (const v of variants) {
      if (!geoIds.has(v.variantIndex)) {
        geoIds.set(v.variantIndex, bm.addGeometry(geometries[v.variantIndex]));
      }
    }

    // Add all instances + collect positions for distance sorting
    const _m = new THREE.Matrix4();
    const _color = new THREE.Color();
    const instanceData = []; // { id, x, z }

    let _added = 0;
    for (const variant of variants) {
      const geoId = geoIds.get(variant.variantIndex);
      const matrices = variant.matrices instanceof Float32Array ? variant.matrices : new Float32Array(variant.matrices);
      const colors = variant.colors instanceof Float32Array ? variant.colors : (variant.colors ? new Float32Array(variant.colors) : null);

      for (let i = 0; i < variant.count; i++) {
        const off = i * 16;
        _m.fromArray(matrices, off);
        const instanceId = bm.addInstance(geoId);
        bm.setMatrixAt(instanceId, _m);
        if (colors) {
          _color.fromArray(colors, i * 3);
          bm.setColorAt(instanceId, _color);
        }
        instanceData.push({ id: instanceId, x: matrices[off + 12], z: matrices[off + 14] });
        if (yieldFn && (++_added % YIELD_EVERY) === 0) await yieldFn();
      }
    }

    // Sort instances by distance from centroid (≈ tile center) for LOD
    let cx = 0, cz = 0;
    for (const d of instanceData) { cx += d.x; cz += d.z; }
    cx /= instanceData.length; cz /= instanceData.length;
    instanceData.sort((a, b) => {
      const da = (a.x - cx) ** 2 + (a.z - cz) ** 2;
      const db = (b.x - cx) ** 2 + (b.z - cz) ** 2;
      return da - db;
    });
    const sortedIds = new Int32Array(instanceData.map(d => d.id));

    bm.frustumCulled = false;
    // Trees do NOT cast real shadow-map shadows — the blob shadow planes (shadowMesh below) already
    // ground them, and pushing ~128k trees through the directional shadow depth pass every frame was the
    // single biggest tree GPU cost (the dead InstancedMesh path warned this "tanked the shadow pass").
    bm.castShadow = false;
    bm.receiveShadow = true;
    bm.userData = {
      sharedGeometry: true,
      sharedMaterial: true,
      isTreeBatchedMesh: true,
      maxInstanceCount: totalInstances,
      _sortedIds: sortedIds,
      _lastVisibleCount: totalInstances,
    };
    treeMeshes.push(bm);
  }

  // ── Shadow mesh ───────────────────────────────────────────────────────────
  let shadowMesh = null;
  if (workerResult.shadowInstances && workerResult.shadowInstances.count > 0) {
    const { matrices, count } = workerResult.shadowInstances;
    shadowMesh = new THREE.InstancedMesh(getShadowGeometry(), getShadowMaterial(), count);
    shadowMesh.instanceMatrix = new THREE.InstancedBufferAttribute(
      matrices instanceof Float32Array ? matrices : new Float32Array(matrices), 16
    );
    shadowMesh.count = count;
    shadowMesh.frustumCulled = true;
    shadowMesh.castShadow = false;
    shadowMesh.receiveShadow = false;
    shadowMesh.renderOrder = -1;
    shadowMesh.userData.sharedGeometry = true;
    shadowMesh.userData.sharedMaterial = true;
    shadowMesh.userData.isTreeMesh = true;
    shadowMesh.userData.maxInstanceCount = count;
  }

  // ── Bush mesh ─────────────────────────────────────────────────────────────
  let bushMesh = null;
  if (CONFIG.ENABLE_BUSHES !== false && workerResult.bushInstances && workerResult.bushInstances.count > 0) {
    const { matrices, colors, count } = workerResult.bushInstances;
    bushMesh = new THREE.InstancedMesh(getBushGeometry(), getBushMaterial(), count);
    bushMesh.instanceMatrix = new THREE.InstancedBufferAttribute(
      matrices instanceof Float32Array ? matrices : new Float32Array(matrices), 16
    );
    if (colors) {
      bushMesh.instanceColor = new THREE.InstancedBufferAttribute(
        colors instanceof Float32Array ? colors : new Float32Array(colors), 3
      );
    }
    bushMesh.count = count;
    bushMesh.frustumCulled = true;
    bushMesh.castShadow = false;
    bushMesh.receiveShadow = true;
    bushMesh.userData.sharedGeometry = true;
    bushMesh.userData.sharedMaterial = true;
  }

  // ── Tree positions for colliders ──────────────────────────────────────────
  const treePositions = [];
  const posArr = workerResult.treePositions;
  if (posArr) {
    for (let i = 0; i < posArr.length; i += 2) {
      treePositions.push({ x: posArr[i], y: posArr[i + 1] });
    }
  }

  // ── Tree billboard impostors (2 triangles per tree for distant LOD) ──────
  const treeBillboardMeshes = [];
  const BB_W = 5, BB_H = 7;
  let _bbGeo = null;
  function getBBGeo() {
    if (_bbGeo) return _bbGeo;
    _bbGeo = new THREE.PlaneGeometry(BB_W, BB_H);
    const pa = _bbGeo.getAttribute('position');
    for (let i = 0; i < pa.count; i++) pa.setY(i, pa.getY(i) + BB_H / 2);
    pa.needsUpdate = true;
    return _bbGeo;
  }

  for (const variant of workerResult.treeVariants || []) {
    if (variant.count === 0) continue;
    const vi = variant.variantIndex;
    const bbMat = getTreeBillboardMaterial(vi);
    const bbMesh = new THREE.InstancedMesh(getBBGeo(), bbMat, variant.count);

    // Reuse instance matrices but strip rotation (billboard shader handles facing)
    const srcMat = variant.matrices instanceof Float32Array ? variant.matrices : new Float32Array(variant.matrices);
    const bbMatrices = new Float32Array(srcMat.length);
    const _m = new THREE.Matrix4();
    const _pos = new THREE.Vector3();
    const _sc = new THREE.Vector3();
    const _identQ = new THREE.Quaternion();
    for (let i = 0; i < variant.count; i++) {
      const off = i * 16;
      _m.fromArray(srcMat, off);
      // Extract position (column 3) and scale (column lengths)
      _pos.set(_m.elements[12], _m.elements[13], _m.elements[14]);
      _sc.set(
        Math.hypot(_m.elements[0], _m.elements[1], _m.elements[2]),
        Math.hypot(_m.elements[4], _m.elements[5], _m.elements[6]),
        Math.hypot(_m.elements[8], _m.elements[9], _m.elements[10])
      );
      _m.compose(_pos, _identQ, _sc);
      _m.toArray(bbMatrices, off);
      if (yieldFn && (i % YIELD_EVERY) === (YIELD_EVERY - 1)) await yieldFn();
    }

    bbMesh.instanceMatrix = new THREE.InstancedBufferAttribute(bbMatrices, 16);
    bbMesh.count = variant.count;
    bbMesh.frustumCulled = false; // billboard shader moves verts
    bbMesh.castShadow = false;
    bbMesh.receiveShadow = false;
    bbMesh.visible = false; // hidden by default — LOD shows at distance
    bbMesh.userData = {
      isTreeBillboard: true,
      maxInstanceCount: variant.count,
      sharedGeometry: true,
      sharedMaterial: true,
    };
    treeBillboardMeshes.push(bbMesh);
  }

  return { treeMeshes, treeBillboardMeshes, shadowMesh, bushMesh, treePositions };
}

// =============================================================================
//  GRASS MATERIALIZER
// =============================================================================

/**
 * Takes grass instance data from a worker and wraps it into an InstancedMesh
 * using caller-provided geometry and material.
 *
 * @param {object} workerResult - Output from grass worker
 * @param {THREE.BufferGeometry} grassGeometry - Shared grass blade geometry
 * @param {THREE.Material} grassMaterial - Shared grass material
 * @returns {THREE.InstancedMesh|null}
 */
export function materializeGrassMeshes(workerResult, grassGeometry, grassMaterial) {
  if (!workerResult.grassInstances || !workerResult.grassInstances.count) return null;

  const { matrices, colors, count } = workerResult.grassInstances;
  const mesh = new THREE.InstancedMesh(grassGeometry, grassMaterial, count);
  mesh.instanceMatrix = new THREE.InstancedBufferAttribute(
    matrices instanceof Float32Array ? matrices : new Float32Array(matrices), 16
  );
  if (colors) {
    mesh.instanceColor = new THREE.InstancedBufferAttribute(
      colors instanceof Float32Array ? colors : new Float32Array(colors), 3
    );
  }
  mesh.count = count;
  mesh.frustumCulled = true;
  return mesh;
}
