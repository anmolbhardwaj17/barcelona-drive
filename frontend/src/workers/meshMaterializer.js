/**
 * meshMaterializer.js — Main-thread code that wraps raw typed-array buffers
 * from Web Workers into Three.js Mesh / InstancedMesh objects.
 *
 * This file runs on the MAIN THREAD and uses Three.js freely.
 * All geometry data arrives pre-merged from workers — no mergeGeometries calls.
 */
import * as THREE from 'three';
import { patchMaterial } from '../map/materialRegistry.js';   // v3 P1-03
import { FLOOR_HEIGHT, WALL_REPEAT_HORIZONTAL_M, FACADE_GROUND_H_M } from '../buildingConstants.js';   // v3 P1-13: single source (was mirrored here)
import { markShared } from '../sharedMaterial.js';
import { createFacadeArrays, patchFacadeArrayMaterial } from '../map/facadeArray.js';   // v3 P3-04
import { createRoofArray, patchRoofArrayMaterial } from '../map/roofArray.js';   // v3 P3-06
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import {
  getTreeGeometries,
  getTreeMaterial,
  getTreeBillboardMaterial,
  getTreeBillboardGeometry,
  getBushGeometries,
  getBushCardsMaterial,
  getBushVariantCount,
} from '../map/vegetationRenderer.js';
import { classifyBush } from '../map/treeSpeciesSets.js';
import { createVegPoolSet } from '../map/vegPools.js';
import { bindAoScaleUniform, AO_FRAG_APPLY } from '../map/aoSampler.js';
import { getNightEmissiveTexture, NIGHT_EMISSIVE_INTENSITY, HERO_EMISSIVE_INTENSITY } from '../map/buildingRenderer.js';
import { getBeaconMat, getBeaconGeom } from '../map/urbanFeatureRenderer.js';

// ─── Constants ───────────────────────────────────────────────────────────────


const FOG_COLOR_VEC = 'vec3(0.749, 0.843, 0.933)';

const SHADOW_TEX_SIZE = 128;
const SHADOW_Y_OFFSET = 0.02;

// ─── Window style definitions per category ───────────────────────────────────

// Barcelona Eixample: tall ~2 m French-window openings, ~3 m floor period (aligns with 3 m balconies),
// taller ~3.5–4 m ground floor for shopfronts.
// v3 P3-02: `marginB` now comes from FACADE_GROUND_H_M in buildingConstants — the storey-band
// geometry places its ground band against the SAME number, and two copies would drift until the
// shopfront straddled the band seam.
const WINDOW_STYLES = {
  residential:      { winW: 1.1, winH: 2.0, gapH: 1.4, gapV: 1.0, marginB: FACADE_GROUND_H_M.residential,      seed: 42  },
  commercial:       { winW: 1.2, winH: 1.9, gapH: 1.2, gapV: 1.1, marginB: FACADE_GROUND_H_M.commercial,       seed: 137 },
  commercial_glass: { winW: 1.8, winH: 2.4, gapH: 0.20, gapV: 0.6, marginB: FACADE_GROUND_H_M.commercial_glass, seed: 313 },
  office:           { winW: 1.3, winH: 1.8, gapH: 0.8, gapV: 1.2, marginB: FACADE_GROUND_H_M.office,           seed: 271 },
  hospital:         { winW: 1.0, winH: 1.6, gapH: 1.2, gapV: 1.4, marginB: FACADE_GROUND_H_M.hospital,         seed: 389 },
  school:           { winW: 1.4, winH: 1.6, gapH: 1.4, gapV: 1.4, marginB: FACADE_GROUND_H_M.school,           seed: 503 },
  industrial:       { winW: 1.6, winH: 1.4, gapH: 1.6, gapV: 1.6, marginB: FACADE_GROUND_H_M.industrial,       seed: 631 },
  religious:        { winW: 0.7, winH: 2.4, gapH: 2.2, gapV: 1.4, marginB: FACADE_GROUND_H_M.religious,        seed: 757 },
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

// Spanish/Catalan parody shop signage (GTA-style tone, fictional names — matches the bridge
// billboards in roadRenderer.getBillboardTextures).
const BILLBOARD_COLORS = [
  { bg: '#1B3A5C', fg: '#FFFFFF', text: 'REBAIXES' },
  { bg: '#8B0000', fg: '#FFD700', text: 'SUPERMERCAT' },
  { bg: '#003366', fg: '#00CCFF', text: 'ELECTRÒNICA' },
  { bg: '#2E0854', fg: '#FF66AA', text: 'MODA ZURA' },
  { bg: '#004D00', fg: '#FFFF00', text: 'FRUITES FRESQUES' },
  { bg: '#333333', fg: '#FF4400', text: 'GRAN OFERTA' },
  { bg: '#0A1628', fg: '#44BBFF', text: 'NOVETATS' },
  { bg: '#4A0E0E', fg: '#FFD700', text: '50% DESCOMPTE' },
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

  // ── Glass curtain wall — FULL-GLASS mosaic (Torre Agbar reference, user call 2026-07-11) ──
  // No visible wall at all: a dense grid of small panes covering the whole facade, cool
  // sky-reflecting blues/teals with occasional warm amber/red accent panes and rare dark ones,
  // separated by thin near-black mullions. Reads as a shimmering glazed skin, not masonry.
  if (isGlass) {
    ctx.fillStyle = '#10181e';                     // mullion grid shows through pane gaps
    ctx.fillRect(0, 0, W, H);
    const paneW = Math.max(4, Math.round(1.05 * pxW));
    const paneH = Math.max(4, Math.round(1.15 * pxH));
    const gap = Math.max(1, Math.round(0.06 * pxW));
    for (let y = 0; y + paneH <= H + paneH; y += paneH + gap) {
      for (let x = 0; x + paneW <= W + paneW; x += paneW + gap) {
        const v = rnd();
        let r, g, b2;
        if (v < 0.055) {                            // warm accent pane (Agbar's amber/red flecks)
          const t = rnd();
          r = 185 + Math.round(t * 55); g = 95 + Math.round(t * 45); b2 = 45 + Math.round(t * 25);
        } else if (v < 0.13) {                      // dark pane (blinds / unlit depth)
          r = 40 + Math.round(rnd() * 18); g = 55 + Math.round(rnd() * 18); b2 = 70 + Math.round(rnd() * 20);
        } else {                                    // cool glass: steel-blue → teal → pale cyan
          const t = rnd();
          r = 95 + Math.round(t * 55);
          g = 130 + Math.round(t * 55);
          b2 = 155 + Math.round(t * 55);
        }
        ctx.fillStyle = `rgb(${r},${g},${b2})`;
        ctx.fillRect(x, y, Math.min(paneW, W - x), Math.min(paneH, H - y));
        // sky-reflection sheen on the top third of each pane
        ctx.fillStyle = 'rgba(200,225,245,0.10)';
        ctx.fillRect(x, y, Math.min(paneW, W - x), Math.max(1, Math.round(paneH * 0.3)));
      }
    }
    // Ground floor: taller dark lobby glazing band
    const groundH = Math.round(marginB * 0.8);
    ctx.fillStyle = '#16222b';
    ctx.fillRect(0, H - groundH, W, groundH);
    ctx.fillStyle = '#3c4c58';
    for (let x = 0; x < W; x += Math.round(2.2 * pxW)) ctx.fillRect(x, H - groundH, 1, groundH);
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
 * (No-op since L2.) The old per-material "clean fade" fog replacement is retired — the GLOBAL
 * aerial-perspective fog chunk in scene.js now handles distance fade for every material, so buildings
 * fog consistently with roads/terrain (desaturation + blue-shift + sun-side warmth + altitude thinning).
 */
function injectFogShader(_mat) {}

// Building winding is INCONSISTENT across the worker's geometry (some facades/roofs are wound CW, some
// CCW), so NO single side renders every building correctly — FrontSide left some buildings inside-out
// (a giant flat plane where a near wall was culled), BackSide made others hollow. DoubleSide is the only
// reliable choice; backface culling here would need the worker to emit consistent winding first (deferred).
// v3 P3-03 — building face culling, and why this is still DoubleSide.
//
// Backface culling was switched on and REVERTED on 2026-07-06: "building geometry has inconsistent
// triangle winding, so no single side renders every building right (FrontSide left some inside-out
// as a giant flat plane; BackSide made others hollow)". P3-03 fixed the CAUSE — every ring is now
// normalised by signed area in the worker, walls CW and courtyard holes CCW, roofs to match.
//
// RESOLVED BY DRIVE, 2026-08-25: **FrontSide**. BackSide rendered buildings hollow (you saw the far
// interior wall through the near one); FrontSide is correct.
//
// This settles a contradiction that stood since July. The 2026-07-06 note reasoned that
// `worldGroup.scale.x = -1` inverts triangle handedness and therefore "exterior = BackSide". The
// mirror does invert handedness — but that note was written against INCONSISTENTLY WOUND geometry,
// where neither side was right for every building, so its conclusion described a broken state rather
// than the mirror's real effect. With rings normalised (walls CW, courtyard holes CCW, roofs to
// match) the extruder's outward convention plus the mirror lands on FrontSide. The task text was
// right and the changelog's inference was not; only a drive could tell them apart, which is why the
// flag was made selectable instead of guessed.
//
// Escape hatch kept — `?buildingside=back|front|double`. If a future geometry change breaks culling,
// `?buildingside=double` restores the old always-safe behaviour in one reload, without a rebuild.
//
// ⚠ Do NOT change this default without a drive that checked courtyards and cylinders — those are the
// shapes most likely to escape the normalisation, and a street of plain boxes will not reveal them.
const BUILDING_SIDE = (() => {
  let pick = null;
  try { pick = new URLSearchParams(location.search).get('buildingside'); } catch { /* worker/no-DOM */ }
  if (pick === 'back') return THREE.BackSide;
  if (pick === 'double') return THREE.DoubleSide;
  return THREE.FrontSide;   // default — measured, not assumed
})();

/**
 * Create or retrieve a facade material by category and hex color.
 * Matches the logic in buildingRenderer.js getFacadeMaterial().
 */
// Night state for the facade materials THIS module creates (the live path — tileManager builds
// buildings through materializeBuildingMeshes, NOT through buildingRenderer's legacy cache, so the
// window night-glow must be baked in HERE or windows never light up after dark).
let _facadeNight = false;
// Near-black detail materials crush to VOID-black under the blue night rig (balcony rails/gates
// read as floating black boxes). Lift them to moonlit blue-grey at night; day colours untouched.
const DETAIL_NIGHT_LIFT = { balconyRail: 0x4b5468, gate: 0x424a5c, acFan: 0x3d4a5e, signboard: 0x3f5a74 };
export function setFacadeNightMode(isNight) {
  _facadeNight = isNight;
  for (const [type, nightHex] of Object.entries(DETAIL_NIGHT_LIFT)) {
    const mat = _detailMaterialCache.get(type);
    if (mat) mat.color.setHex(isNight ? nightHex : DETAIL_MATERIAL_DEFS[type].color);
  }
  // The peach roof palette (raised blue channel, user-approved by day) multiplies with the BLUE
  // night rig into pink-maroon. Counter on the shared roof material at night only: pull blue back
  // and ease red so roofs fall into neutral dark clay after dark. White (identity) by day.
  for (const mat of _roofMaterialCache.values()) {
    if (isNight) mat.color.setHex(mat.userData._dayHex ?? 0xffffff).multiply(_ROOF_NIGHT_TINT);
    else mat.color.setHex(mat.userData._dayHex ?? 0xffffff);
  }
  for (const [cacheKey, mat] of _facadeMaterialCache.entries()) {
    if (!mat.emissiveMap) continue;
    mat.emissiveIntensity = isNight
      ? (cacheKey.includes('#hero') ? HERO_EMISSIVE_INTENSITY : NIGHT_EMISSIVE_INTENSITY)
      : 0;
  }
}

// v3 P3-04 — the array-texture facade path, OPT-IN.
//
// Default OFF on purpose. The placeholder layers are deliberately plain (flat plaster, window rows,
// no weathering or normal detail) — they exist to prove the SHADER PATH before P3-05 commits six days
// of art to a UV spec nobody has rendered. Switching them on by default would make the city look
// WORSE than today's canvas facade while claiming progress.
//
//   ?facadearray=1   array path — mid-air shopfronts go to 0, facades look plainer
//   (absent)         today's canvas facade
//
// Flip the default when P3-05's real layers land, NOT before.
// Reads CONFIG so main thread and worker cannot disagree — see CONFIG.FACADE_ARRAY for why the
// worker cannot read the URL itself.
const FACADE_ARRAY_ON = !!CONFIG.FACADE_ARRAY;
let _facadeArrays = null;
let _roofArray = null;   // v3 P3-06
function facadeArrays() {
  if (!_facadeArrays) _facadeArrays = createFacadeArrays(THREE);
  return _facadeArrays;
}

function getFacadeMaterial(hexColor, category) {
  const cacheKey = hexColor + '_' + category;
  if (_facadeMaterialCache.has(cacheKey)) return _facadeMaterialCache.get(cacheKey);

  // '#hero' marker (set by the building worker on a sparse set of tall buildings): same day look,
  // dense all-warm windows + stronger glow at night.
  const hero = category.endsWith('#hero');
  const baseCategory = hero ? category.slice(0, -5) : category;

  const isGlass  = (baseCategory === 'commercial_glass');
  const isTemple = (baseCategory === 'religious');
  // Bake the night window-glow emissiveMap in at creation (intensity 0 by day) — adding an
  // emissiveMap to an already-compiled shared material later doesn't recompile it.
  const emis = {
    emissive: new THREE.Color(0xffffff),
    emissiveMap: getNightEmissiveTexture(baseCategory, hero),
    emissiveIntensity: _facadeNight ? (hero ? HERO_EMISSIVE_INTENSITY : NIGHT_EMISSIVE_INTENSITY) : 0,
  };
  let mat;

  if (isGlass) {
    mat = new THREE.MeshPhongMaterial({
      color: hexColor,
      vertexColors: true,
      map: getWindowTexture(baseCategory),
      // Softened (user report): 0x8899AA/60 painted a giant white sun-streak up the CURVED bullet
      // towers at grazing angles — smooth revolves focus specular into one hot stripe. Keep a
      // gentle sheen so glass still reads glossy vs the matte masonry.
      specular: 0x2e3a44,
      shininess: 22,
      reflectivity: 0.4,
      side: BUILDING_SIDE,
      ...emis,
    });
  } else if (isTemple) {
    mat = new THREE.MeshPhongMaterial({
      color: hexColor,
      vertexColors: true,
      map: getWindowTexture(baseCategory),
      specular: 0x442211,
      shininess: 12,
      side: BUILDING_SIDE,
      ...emis,
    });
  } else {
    mat = new THREE.MeshLambertMaterial({
      color: hexColor,
      vertexColors: true,
      map: getWindowTexture(baseCategory),
      side: BUILDING_SIDE,
      ...emis,
    });
  }

  // v3 P2-05: the warm lower-floor "ground glow" wash is GONE. It painted vec3(1.0,0.62,0.34)
  // emissive onto the bottom ~7 m of every facade to imply street light reflecting up — light that
  // now genuinely exists, so keeping it meant the same wall was lit twice and the base of every
  // building glowed whether or not a lamp was near it. The aWash attribute it read is no longer
  // consumed by any shader.
  //
  // The v9 baked sky-AO in this same block STAYS: it is measured occlusion, not faked light.
  patchMaterial(mat, (shader) => {
    bindAoScaleUniform(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAO;\nvarying float vAoDark;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAoDark = aAO;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uAoScale;\nvarying float vAoDark;')
      // Baked sky-AO darkening (v9): street-canyon facades shade at the base. Attribute stores the
      // DARKENING amount, so geometry without it (default 0) is untouched — never black.
      // uAoScale softens AO under the night rig (aoSampler.setAoNightScale).
      .replace('#include <color_fragment>', `#include <color_fragment>\n${AO_FRAG_APPLY}`);
  }, 'facade');

  injectFogShader(mat);
  // v3 P3-04: array-texture facade. Goes through the material registry like every other patch, so it
  // composes with the AO chunk above rather than clobbering it (P1-03's whole point).
  if (FACADE_ARRAY_ON) {
    // The canvas map stays bound but unsampled until P3-05 makes the array path the default and
    // `getWindowTexture` is deleted. It is NOT load-bearing for the shader any more: the patch
    // carries its own `vFacadeUv` varying precisely so it does not depend on which maps a material
    // binds — the glass path is a MeshPhongMaterial and broke when the patch relied on `vMapUv`.
    patchFacadeArrayMaterial(mat, facadeArrays());
  }
  _facadeMaterialCache.set(cacheKey, markShared(mat));
  return mat;
}

/**
 * Create or retrieve a roof material (simple Lambert with vertexColors).
 */
const _ROOF_NIGHT_TINT = new THREE.Color(0.9, 0.97, 0.78);   // counters the peach palette going pink under blue night light

function getRoofMaterial(hexColor) {
  if (hexColor == null) hexColor = 0xD9CFC1;
  if (_roofMaterialCache.has(hexColor)) return _roofMaterialCache.get(hexColor);
  const mat = new THREE.MeshLambertMaterial({ color: hexColor, vertexColors: true, side: BUILDING_SIDE });
  mat.userData._dayHex = hexColor;
  if (_facadeNight) mat.color.multiply(_ROOF_NIGHT_TINT);
  // v3 P3-06: every roof in the city shares this material (`getRoofMaterialKey()` is a literal), so
  // binding the array here dresses all of them. Rides the SAME flag as the facade array — both are
  // placeholder art, and shipping half a look is worse than shipping neither.
  if (FACADE_ARRAY_ON) {
    if (!_roofArray) _roofArray = createRoofArray(THREE);
    patchRoofArrayMaterial(mat, _roofArray);
  }
  _roofMaterialCache.set(hexColor, markShared(mat));
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
    _detailMaterialCache.set(type, markShared(fallback));
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

  _detailMaterialCache.set(type, markShared(mat));
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
  // v3 P2-05: aWash is NOT uploaded any more — the facade wash that read it is deleted. The worker
  // still computes group.wash; leaving the upload in would cost VRAM and bandwidth per building for
  // an attribute no shader reads. (Removing its PRODUCTION is a worker change, tracked separately.)
  if (group.ao) geo.setAttribute('aAO', new THREE.Float32BufferAttribute(group.ao, 1));
  // v3 P3-04: array-texture layer index, one per vertex. Uploaded as float — GLSL ES 3.0 takes a
  // float third coordinate for texture(sampler2DArray, vec3), and an integer attribute would need
  // flat-qualified varyings that three's chunk system does not expose.
  if (group.layers) geo.setAttribute('aLayer', new THREE.Float32BufferAttribute(group.layers, 1));
  if (group.indices) geo.setIndex(new THREE.Uint32BufferAttribute(group.indices, 1));

  const mesh = new THREE.Mesh(geo, material);
  mesh.userData._nanChecked = true;   // hasNaNPositions ran above — safeSceneAdd skips its re-scan
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
    if (yieldFn) await yieldFn();   // budget-gated: no-op under 3ms, so every group is fine
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
    if (yieldFn) await yieldFn();
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

  // v3 P2-06: the per-building warm ground-spill decal is DELETED. It put a soft amber gradient at
  // the base of EVERY building to fake "buildings light the street around them" — the same trick as
  // the streetlight ground pools, and removed for the same reason: the light grid now casts real
  // light, so this was a second, fake copy of it painted on the pavement. It also had the tell a
  // real spill does not: a hard disc edge that slid over the ground as the camera moved, and it was
  // frustumCulled = false, so every one of them was submitted every frame at every distance.
  //
  // workerResult.heroSpills is no longer consumed. (Removing its PRODUCTION is a worker change,
  // tracked with the aWash removal in the same note.)

  // ── Water-tower beacons — pulsing red lights on the finials (user call 2026-07-11) ──────────
  // Shares the comm-tower beacon material, which updateTowerBeacons() breathes every frame.
  if (workerResult.beaconPoints && workerResult.beaconPoints.length >= 3) {
    const bp = workerResult.beaconPoints;
    for (let i = 0; i + 2 < bp.length; i += 3) {
      const beacon = new THREE.Mesh(getBeaconGeom(), getBeaconMat());
      beacon.position.set(bp[i], bp[i + 1], bp[i + 2]);
      beacon.frustumCulled = true;
      beacon.userData.sharedGeometry = true;
      beacon.userData.sharedMaterial = true;
      meshes.push(beacon);
    }
  }

  return meshes;
}

/**
 * Pre-create every facade/roof/detail material VARIANT the tile builder can ever produce, so the
 * boot-time renderer.compileAsync warm-up compiles them all. Without this, the first tile that
 * introduces a new variant (e.g. a '#hero' facade of a category not yet seen) triggers a
 * SYNCHRONOUS shader compile mid-drive — measured as one-off ~100 ms render frames.
 */
export function warmAllBuildingMaterials() {
  const cats = ['residential', 'commercial', 'office', 'hospital', 'school', 'industrial', 'religious', 'commercial_glass'];
  const mats = [];
  for (const c of cats) {
    mats.push(getFacadeMaterial(0xFFFFFF, c));
    mats.push(getFacadeMaterial(0xFFFFFF, c + '#hero'));
  }
  mats.push(getRoofMaterial(0xFFFFFF));
  for (const type of Object.keys(DETAIL_MATERIAL_DEFS)) mats.push(getDetailMaterial(type));
  // One-off singletons that otherwise sync-compile on FIRST appearance (mall district, industrial
  // area) — each is a distinct shader-define combo, so one hidden triangle each covers it.
  mats.push(getMallSignMaterial(), getTankMaterial(), getPipeMaterial());
  return mats;
}

// ── Hero spill shared resources + night toggle ───────────────────────────────

// =============================================================================
//  VEGETATION MATERIALIZER
// =============================================================================

// ── Global vegetation pools (one BatchedMesh per kind for ALL tiles) ─────────
// Created once, added to the tile parent group; tiles add/remove instances via handles.
// Collapses ~3 scene objects per resident tile (trees/shadows/bushes ×[main+zone]) to 3 total,
// plus up to 4 billboard-impostor meshes per tile to 4 total (one pool per variant material).


let _vegPools = null;
export function getVegPools(parentGroup) {
  if (_vegPools) return _vegPools;
  // POOL SETS with FIXED 16384 capacity (data textures stay 256²/1 MB): when a pool fills, a
  // sibling pool spawns instead of growing in place — in-place growth reallocated + re-uploaded
  // all textures (60-110ms stalls), and bigger caps quadrupled the per-upload cost to 4 MB.
  _vegPools = {
    trees: createVegPoolSet({
      name: 'trees', geometries: getTreeGeometries(), material: getTreeMaterial(),
      capacity: 16384, castShadow: false, receiveShadow: true,
      // castShadow stays false — blob shadows ground the trees; the directional shadow depth pass
      // over 100k+ tree verts was the single biggest tree GPU cost.
    }, parentGroup),
    shadows: createVegPoolSet({
      name: 'treeShadows', geometries: [getShadowGeometry()], material: getShadowMaterial(),
      capacity: 16384, castShadow: false, receiveShadow: false, renderOrder: -1,
    }, parentGroup),
    bushes: createVegPoolSet({
      name: 'bushes', geometries: getBushGeometries(), material: getBushCardsMaterial(),
      capacity: 16384, castShadow: false, receiveShadow: true,
    }, parentGroup),
    // Billboard impostors — one pool set per variant (each has its own atlas-offset material).
    // v3 P3-10(c): ONE impostor pool for the whole city. This was one pool set and one material per
    // variant; the atlas cell now lives in each variant's geometry UVs and setGeometryIdAt picks it,
    // exactly as the solid-tree pool already worked.
    billboards: createVegPoolSet({
      name: 'treeBillboards',
      geometries: Array.from({ length: CONFIG.NUM_TREE_VARIANTS }, (_, vi) => getTreeBillboardGeometry(vi)),
      material: getTreeBillboardMaterial(),
      capacity: 16384, castShadow: false, receiveShadow: false,
    }, parentGroup),
  };

  // Dev probe: `_ddVegCount()` in the console reports what each vegetation pool actually holds.
  // Added because "I can't see bushes" is ambiguous between not-generated, not-added, not-visible
  // and not-where-I-was-looking, and hunting for a 1 m shrub in the Eixample to tell those apart is
  // a bad use of a drive. Counts come straight from the pools, so they answer it in one line.
  if (typeof window !== 'undefined') {
    window._ddVegPools = _vegPools;
    window._ddVegCount = () => {
      // A pool SET wraps an array of pools (a sibling spawns when one fills), so totals are summed.
      const row = (name, set) => {
        const ps = set?.pools || [];
        let inst = 0, vis = 0, geo = 0, drawn = 0; let mat = null;
        for (const p of ps) {
          const bm = p.mesh;
          inst += bm.instanceCount ?? 0;
          // ALLOCATED vs DRAWN. instanceCount is what the pool holds; visibleInstances is what the
          // LOD has actually switched on. Reporting only the former cannot tell "no trees were
          // made" from "trees were made and something is hiding them", which is the case that
          // matters when a hillside looks empty.
          drawn += p.visibleInstances ?? 0;
          if (bm.visible) vis++;
          geo = p.geometries?.length ?? geo;
          mat = bm.material;
        }
        return `${name.padEnd(12)} pools ${String(ps.length).padStart(2)}  allocated ${String(inst).padStart(6)}` +
               `  DRAWN ${String(drawn).padStart(6)}  visiblePools ${vis}  geometries ${geo}` +
               `  ${mat?.type || '?'}${mat ? (mat.map ? ' +map' : ' NO-MAP') : ''}`;
      };
      return [row('trees', _vegPools.trees), row('bushes', _vegPools.bushes),
              row('shadows', _vegPools.shadows), row('billboards', _vegPools.billboards)].join('\n');
    };
  }

  return _vegPools;
}

/**
 * Takes the output from processVegetationInWorker and creates Three.js
 * InstancedMeshes for trees, shadows, and bushes.
 *
 * @param {object} workerResult - Output from vegetation worker
 * @returns {{ treeMeshes: THREE.InstancedMesh[], shadowMesh: THREE.InstancedMesh|null, bushMesh: THREE.InstancedMesh|null, treePositions: {x:number, y:number}[] }}
 */
export async function materializeVegetationMeshes(workerResult, yieldFn, pools = null) {
  const treeMeshes = [];
  const poolHandles = [];
  const YIELD_EVERY = 600; // instances between cooperative yields (keeps this off the critical frame)

  // ── Tree BatchedMesh: all 4 variants in a single draw call ─────────────
  const geometries = getTreeGeometries();
  const material = getTreeMaterial();

  const variants = (workerResult.treeVariants || []).filter(
    v => v.count > 0 && v.variantIndex >= 0 && v.variantIndex < geometries.length
  );

  if (pools && variants.length > 0) {
    // Global-pool path: instances go into the shared cross-tile BatchedMesh instead of a per-tile one.
    const h = await pools.trees.add(
      variants.map((v) => ({ geoIndex: v.variantIndex, count: v.count, matrices: v.matrices, colors: v.colors })),
      yieldFn,
    );
    if (h) { h.kind = 'tree'; poolHandles.push(h); }
  } else if (variants.length > 0) {
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

    // Add all instances + collect positions for distance sorting. Parallel typed arrays instead of an
    // array of { id, x, z } objects — the object array was ~4300 short-lived allocations PER TILE (heavy
    // GC pressure on the streaming hot path); typed arrays are ~6x smaller and far cheaper for the GC.
    const _m = new THREE.Matrix4();
    const _color = new THREE.Color();
    const _ids = new Int32Array(totalInstances);
    const _xs = new Float32Array(totalInstances);
    const _zs = new Float32Array(totalInstances);
    let _di = 0;

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
        _ids[_di] = instanceId; _xs[_di] = matrices[off + 12]; _zs[_di] = matrices[off + 14]; _di++;
        if (yieldFn && (++_added % YIELD_EVERY) === 0) await yieldFn();
      }
    }

    // Sort instance IDs by distance from centroid (≈ tile center) for LOD — sort an index array in place.
    let cx = 0, cz = 0;
    for (let i = 0; i < _di; i++) { cx += _xs[i]; cz += _zs[i]; }
    cx /= (_di || 1); cz /= (_di || 1);
    const order = new Int32Array(_di);
    for (let i = 0; i < _di; i++) order[i] = i;
    order.sort((a, b) => ((_xs[a] - cx) ** 2 + (_zs[a] - cz) ** 2) - ((_xs[b] - cx) ** 2 + (_zs[b] - cz) ** 2));
    const sortedIds = new Int32Array(_di);
    for (let i = 0; i < _di; i++) sortedIds[i] = _ids[order[i]];

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
  if (pools && workerResult.shadowInstances && workerResult.shadowInstances.count > 0) {
    const s = workerResult.shadowInstances;
    const h = await pools.shadows.add([{ geoIndex: 0, count: s.count, matrices: s.matrices }], yieldFn);
    if (h) { h.kind = 'shadow'; poolHandles.push(h); }
  } else if (workerResult.shadowInstances && workerResult.shadowInstances.count > 0) {
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

  /**
 * Bucket a flat bush instance list into one group per species.
 *
 * Returns the pool's group format. On the blob path getBushVariantCount() is 1 and this collapses
 * to the single group it always was, so nothing changes behind `?treecards=0`.
 */
function splitBushesBySpecies(b, kind) {
  const n = getBushVariantCount();
  if (n <= 1) return [{ geoIndex: 0, count: b.count, matrices: b.matrices, colors: b.colors }];

  const mats = b.matrices instanceof Float32Array ? b.matrices : new Float32Array(b.matrices);
  const cols = b.colors ? (b.colors instanceof Float32Array ? b.colors : new Float32Array(b.colors)) : null;
  const idx = Array.from({ length: n }, () => []);
  for (let i = 0; i < b.count; i++) {
    const o = i * 16;
    idx[classifyBush(mats[o + 12], mats[o + 14], kind, n)].push(i);
  }

  const groups = [];
  for (let v = 0; v < n; v++) {
    const list = idx[v];
    if (list.length === 0) continue;
    const m = new Float32Array(list.length * 16);
    const c = cols ? new Float32Array(list.length * 3) : null;
    for (let k = 0; k < list.length; k++) {
      m.set(mats.subarray(list[k] * 16, list[k] * 16 + 16), k * 16);
      if (c) c.set(cols.subarray(list[k] * 3, list[k] * 3 + 3), k * 3);
    }
    groups.push({ geoIndex: v, count: list.length, matrices: m, colors: c });
  }
  return groups;
}

// ── Bush mesh ─────────────────────────────────────────────────────────────
  let bushMesh = null;
  if (pools && CONFIG.ENABLE_BUSHES !== false && workerResult.bushInstances && workerResult.bushInstances.count > 0) {
    const b = workerResult.bushInstances;
    // Split into per-species groups. The worker emits one flat instance list, but the pool selects
    // geometry per instance via geoIndex — so the species choice happens here, from each bush's own
    // world position (columns 12/14 of its matrix). These are the WORKER's bushes: placed against
    // roads, barriers and buildings, i.e. municipal planting, so they draw from the 'urban' set.
    const h = await pools.bushes.add(splitBushesBySpecies(b, 'urban'), yieldFn);
    if (h) { h.kind = 'bush'; poolHandles.push(h); }
  } else if (CONFIG.ENABLE_BUSHES !== false && workerResult.bushInstances && workerResult.bushInstances.count > 0) {
    const { matrices, colors, count } = workerResult.bushInstances;
    bushMesh = new THREE.InstancedMesh(getBushGeometries()[0], getBushCardsMaterial(), count);
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
  // Quad geometry comes from getTreeBillboardGeometry so the per-tile fallback and the pooled path
  // cannot disagree about impostor size or atlas cell. (It also stops allocating a fresh
  // PlaneGeometry per tile — the old local cache was scoped to this call, so every tile built one.)
  const treeBillboardMeshes = [];

  for (const variant of workerResult.treeVariants || []) {
    if (variant.count === 0) continue;
    const vi = variant.variantIndex;

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

    if (pools && vi >= 0 && vi < CONFIG.NUM_TREE_VARIANTS) {
      // Global-pool path: added HIDDEN — billboards only show in their 500–800 m band once the
      // tile LOD pass runs (default-visible would double-draw over the 3D trees).
      const h = await pools.billboards.add([{ geoIndex: vi, count: variant.count, matrices: bbMatrices }], yieldFn, false);
      if (h) { h.kind = 'billboard'; poolHandles.push(h); }
      continue;
    }

    const bbMesh = new THREE.InstancedMesh(getTreeBillboardGeometry(vi), getTreeBillboardMaterial(), variant.count);
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

  return { treeMeshes, treeBillboardMeshes, shadowMesh, bushMesh, treePositions, poolHandles };
}

// =============================================================================
//  GRASS MATERIALIZER
// =============================================================================

// v3 P1-17: materializeGrassMeshes() removed — unreachable since the grass block was deleted.
