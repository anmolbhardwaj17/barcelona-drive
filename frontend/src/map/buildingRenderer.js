/**
 * Building renderer: facade preset system, one merged mesh per material per tile.
 * 7 facade categories: residential, commercial, office, hospital, school, industrial, religious.
 * Shared materials; UV repeat by wall length/height.
 * Supports terrain: options.getElevationAt(lat, lon) for baseY at footprint center.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { worldToLatLon } from '../projection.js';
import { findNearestRoadSegment } from './spatialIndex.js';
import { getWorldElevationOffset } from '../elevationOffset.js';

const CYLINDER_RADIAL_SEGMENTS = 5;
const MAX_VERTICES_PER_TILE = 35000;

// ── Shared material caches (singletons, created on first use) ───────────────
let _vertexColorMat = null;
let _tankMat = null;
let _pipeMat = null;
let _wallMat = null;
let _shikharaMat = null;
let _flagMat = null;

// ── Helper: bake a flat color into geometry vertex colors ─────────────────────
function bakeVertexColor(geo, hexColor) {
  const c = new THREE.Color(hexColor);
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3]     = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geo;
}

/**
 * Merge multiple geometry arrays (each with a distinct color) into one mesh
 * using vertex colors. Returns the mesh or null.
 */
function mergeColoredGroups(groups, shadowsOn, castShadow = false) {
  // groups: [{ geoms: BufferGeometry[], color: number }]
  const allGeoms = [];
  for (const { geoms, color } of groups) {
    for (const g of geoms) {
      bakeVertexColor(g, color);
      allGeoms.push(g);
    }
  }
  if (allGeoms.length === 0) return null;
  try {
    const merged = mergeGeometries(allGeoms, false);
    allGeoms.forEach(g => g.dispose());
    if (!merged) return null;
    if (!_vertexColorMat) _vertexColorMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const mat = _vertexColorMat;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = castShadow && shadowsOn;
    mesh.receiveShadow = castShadow && shadowsOn;
    mesh.frustumCulled = true;
    mesh.userData.isBuildingDetail = true; // LOD: hide at shorter distance
    return mesh;
  } catch (e) {
    allGeoms.forEach(g => g.dispose());
    return null;
  }
}

// ── Shared brick wall texture (procedural, created once) ─────────────────────
let _brickWallTex = null;
function getBrickWallTexture() {
  if (_brickWallTex) return _brickWallTex;
  const W = 128, H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  // Base mortar color (slightly darker than brick)
  ctx.fillStyle = '#8a8580';
  ctx.fillRect(0, 0, W, H);
  // Brick rows
  const brickH = 16, brickW = 32, mortarW = 2;
  const rows = Math.ceil(H / brickH);
  for (let row = 0; row < rows; row++) {
    const y = row * brickH;
    const offset = (row % 2 === 0) ? 0 : brickW / 2; // stagger every other row
    for (let col = -1; col < Math.ceil(W / brickW) + 1; col++) {
      const x = col * brickW + offset;
      // Slight color variation per brick
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
// ── "SHOPPING MALL" sign texture (red text on dark backing) ─────────────────
let _mallSignTex = null;
function getMallSignTexture() {
  if (_mallSignTex) return _mallSignTex;
  const W = 512, H = 64;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  // Dark backing
  ctx.fillStyle = '#1A1A1A';
  ctx.fillRect(0, 0, W, H);
  // Thin border
  ctx.strokeStyle = '#FF2222';
  ctx.lineWidth = 2;
  ctx.strokeRect(2, 2, W - 4, H - 4);
  // Red glowing text
  ctx.fillStyle = '#FF2020';
  ctx.font = 'bold 38px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#FF0000';
  ctx.shadowBlur = 12;
  ctx.fillText('SHOPPING MALL', W / 2, H / 2);
  // Second pass for extra glow
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

// ── Billboard ad textures (random colorful ads) ─────────────────────────────
const _billboardTexCache = [];
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
  // Border
  ctx.strokeStyle = ad.fg;
  ctx.lineWidth = 4;
  ctx.strokeRect(4, 4, W - 8, H - 8);
  // Text
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

/** Max footprint vertices before simplification. */
const MAX_FOOTPRINT_VERTICES = 16;
const DEBUG_BUILDINGS = false;
// Barcelona redesign: Delhi-era ornament OFF (perimeter boundary walls + gates, Hindu-temple
// shikhara/kalasha/flag, rooftop ad-billboards, garage-shutter ground floors). Barcelona buildings
// front the street directly with masonry facades, balconies, shopfronts — not compound walls/temples.
const ENABLE_DELHI_DETAILS = false;
// Barcelona masonry blocks that get wrought-iron balconies + floor bands (the Eixample signature).
// Apartment + mixed-use + offices-in-masonry; excludes industrial/religious/glass.
const BALCONY_CATEGORIES = new Set(['residential', 'commercial', 'office']);
/** Slight Y offset above terrain to avoid z-fighting. */
const BUILDING_Z_OFFSET = 0.05;

// ── Roof palettes per building category ──
const ROOF_PALETTES = {
  residential: [0xCCC6BC, 0xBEB8AE, 0xB8B2A8],
  commercial:  [0xC8CCD2, 0xC2C6CC, 0xD8D4CC, 0xD4CCC0],
  office:      [0xC0C8D0, 0xC4CCD4, 0xCAD0D6],
  hospital:    [0xDCD8D2, 0xD0CCC6, 0xCCC8C2],
  school:      [0xD8D2B8, 0xCCC6AE, 0xC8C2AA],
  industrial:  [0xBAB6AE, 0xACA8A0, 0xC0BCB4],
  religious:   [0xB05040, 0xC86050, 0xD4A870],
  commercial_glass: [0xA0B0C0, 0xA8B8C8, 0xB0C0D0],
};

const roofMaterialCache = new Map();
function getRoofMaterial(hexColor) {
  if (hexColor == null) hexColor = 0xD9CFC1;
  if (roofMaterialCache.has(hexColor)) return roofMaterialCache.get(hexColor);
  const mat = new THREE.MeshLambertMaterial({ color: hexColor, vertexColors: true, side: THREE.DoubleSide });
  roofMaterialCache.set(hexColor, mat);
  return mat;
}

function getRoofMaterialForBuilding(category, buildingId) {
  const pal = ROOF_PALETTES[category] ?? ROOF_PALETTES.residential;
  const idx = deterministicIndex(buildingId + 7) % pal.length;
  return getRoofMaterial(pal[idx]);
}
// Larger repeat = texture spans more wall = bigger windows on facades (6m horizontal, 5m vertical per repeat)
const FLOOR_HEIGHT = 10;
const WALL_REPEAT_HORIZONTAL_M = 12;
// (Unstretch-X, vertical-model-foundation-spec §3) The old MERCATOR_SCALE was a Delhi-latitude
// unit-correction island for facade UV repeats. Purged: wall lengths are now real
// metres straight from the honest projection, so UV repeat = wallLength / WALL_REPEAT_HORIZONTAL_M.

// ── Per-category window style definitions ────────────────────────────────────
// Each category has distinct window size, spacing and feel.
// Dimensions in metres; converted to pixels during texture generation.
// Barcelona Eixample rhythm: TALL French-window/balcony-door openings (~2 m), ~3 m floor period
// (winH + gapV ≈ 3) so painted window rows line up with the 3 m 3D balconies, and a TALLER ground
// floor (marginB ~3.5–4 m) for the street-level shopfronts.
const WINDOW_STYLES = {
  residential: { winW: 1.1, winH: 2.0, gapH: 1.4, gapV: 1.0, marginB: 3.8, seed: 42  },
  commercial:  { winW: 1.2, winH: 1.9, gapH: 1.2, gapV: 1.1, marginB: 4.0, seed: 137 },
  commercial_glass: { winW: 1.8, winH: 2.4, gapH: 0.20, gapV: 0.6, marginB: 3.5, seed: 313 },
  office:      { winW: 1.3, winH: 1.8, gapH: 0.8, gapV: 1.2, marginB: 3.5, seed: 271 },
  hospital:    { winW: 1.0, winH: 1.6, gapH: 1.2, gapV: 1.4, marginB: 3.0, seed: 389 },
  school:      { winW: 1.4, winH: 1.6, gapH: 1.4, gapV: 1.4, marginB: 3.0, seed: 503 },
  industrial:  { winW: 1.6, winH: 1.4, gapH: 1.6, gapV: 1.6, marginB: 3.0, seed: 631 },
  religious:   { winW: 0.7, winH: 2.4, gapH: 2.2, gapV: 1.4, marginB: 1.5, seed: 757 },
};

// ── Procedural window grid textures (one per category, cached) ───────────────
const _windowTexCache = new Map();

/**
 * Draw a single recessed window with shadow edges for depth illusion.
 * Top + left edges darkest (shadow from indent overhang), bottom lighter (sill),
 * right slightly lighter. Center = glass.
 */
function drawRecessedWindow(ctx, x, y, w, h, rnd) {
  const edge = Math.max(2, Math.round(Math.min(w, h) * 0.14));

  // Top shadow (reveal/lintel shadow into the recess — medium, not a black void)
  ctx.fillStyle = '#4A5460';
  ctx.fillRect(x, y, w, edge);

  // Left shadow (side reveal — slightly lighter)
  ctx.fillStyle = '#566069';
  ctx.fillRect(x, y + edge, edge, h - edge);

  // Bottom sill (lightest edge — catches downward light)
  ctx.fillStyle = '#3E4E5C';
  ctx.fillRect(x + edge, y + h - edge, w - edge, edge);

  // Right edge (slightly lighter than glass — reflected fill light)
  ctx.fillStyle = '#283848';
  ctx.fillRect(x + w - edge, y + edge, edge, h - edge * 2);

  // Glass center — DAYTIME sky reflection (pale blue-grey), so windows read as glass, not black
  // holes. Most windows reflect the bright sky; a minority are darker (shutters closed / interior).
  const v = rnd();
  const base = v < 0.20 ? 82 : (v < 0.55 ? 130 : 160);
  const r = base + Math.round(rnd() * 12);
  const g = base + 10 + Math.round(rnd() * 12);
  const b = base + 20 + Math.round(rnd() * 14);
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(x + edge, y + edge, w - edge * 2, h - edge * 2);

  // Subtle highlight streak in upper-left of glass (reflection)
  if (w - edge * 2 > 6 && h - edge * 2 > 8) {
    ctx.fillStyle = `rgba(180,200,220,0.08)`;
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

  // Wall base: near-white so building material color shows through when multiplied
  ctx.fillStyle = '#F2F0EC';
  ctx.fillRect(0, 0, W, H);

  // Pixels per metre
  const pxW = W / WALL_REPEAT_HORIZONTAL_M;
  const pxH = H / FLOOR_HEIGHT;

  // Window dimensions in pixels
  const winW    = Math.round(style.winW * pxW);
  const winH    = Math.round(style.winH * pxH);
  const periodH = winW + Math.round(style.gapH * pxW);
  const periodV = winH + Math.round(style.gapV * pxH);
  const marginL = Math.round(0.6 * pxW);
  const marginB = Math.round(style.marginB * pxH);

  // Deterministic PRNG (unique seed per category)
  let seed = style.seed;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

  const isResidential = (category === 'residential');
  const isCommercial = (category === 'commercial');
  const isGlass = (category === 'commercial_glass');

  // ── Glass curtain wall: full-height glass panels with thin aluminium mullions ──
  if (isGlass) {
    // Dark blue-tinted base (ground floor lobby)
    const groundH = Math.round(marginB);
    ctx.fillStyle = '#1A2830';
    ctx.fillRect(0, H - groundH, W, groundH);
    // Lobby entrance (large glass panel)
    const lobbyW = Math.round(4.0 * pxW);
    const lobbyH = Math.round(groundH * 0.85);
    const lobbyX = Math.round((W - lobbyW) / 2);
    const lobbyY = H - groundH + Math.round(groundH * 0.1);
    ctx.fillStyle = '#142028';
    ctx.fillRect(lobbyX, lobbyY, lobbyW, lobbyH);
    // Thin aluminium mullion frame
    ctx.fillStyle = '#5A6A78';
    ctx.fillRect(lobbyX, lobbyY, lobbyW, 1);
    ctx.fillRect(lobbyX, lobbyY + lobbyH - 1, lobbyW, 1);
    ctx.fillRect(lobbyX, lobbyY, 1, lobbyH);
    ctx.fillRect(lobbyX + lobbyW - 1, lobbyY, 1, lobbyH);

    // Glass panels with thin mullions for all upper floors
    for (let y = H - marginB - winH; y >= 0; y -= periodV) {
      for (let x = marginL; x + winW <= W; x += periodH) {
        // Glass panel — varied blue/dark tint
        const v = rnd();
        const base = v < 0.2 ? 20 : (v < 0.5 ? 30 : 40);
        const r = base + Math.round(rnd() * 8);
        const g = base + 14 + Math.round(rnd() * 10);
        const b2 = base + 28 + Math.round(rnd() * 12);
        ctx.fillStyle = `rgb(${r},${g},${b2})`;
        ctx.fillRect(x, y, winW, winH);
        // Subtle sky reflection in upper third
        ctx.fillStyle = `rgba(140,170,200,0.06)`;
        ctx.fillRect(x + 1, y + 1, winW - 2, Math.round(winH * 0.3));
        // Thin aluminium mullion border
        ctx.fillStyle = '#5A6A78';
        ctx.fillRect(x, y, winW, 1); // top
        ctx.fillRect(x, y + winH - 1, winW, 1); // bottom
        ctx.fillRect(x, y, 1, winH); // left
        ctx.fillRect(x + winW - 1, y, 1, winH); // right
      }
      // Horizontal mullion band between floors
      const mullionY = y + winH;
      ctx.fillStyle = '#4A5A68';
      ctx.fillRect(0, mullionY, W, Math.max(2, Math.round(0.08 * pxH)));
    }
    // Top edge — dark cap
    ctx.fillStyle = '#3A4A58';
    ctx.fillRect(0, 0, W, Math.max(3, Math.round(0.15 * pxH)));
  }

  // ── Commercial: shopfront ground floor + signboard band ──
  if (isCommercial) {
    const groundH = Math.round(marginB);
    // Shopfront glass (dark teal/grey — display windows)
    ctx.fillStyle = '#2A3840';
    ctx.fillRect(0, H - groundH, W, groundH);
    // Individual shop bays with glass + frame
    const bayW = Math.round(3.0 * pxW);
    const bayGap = Math.round(0.15 * pxW);
    const bayH = Math.round(groundH * 0.7);
    const bayY = H - groundH + Math.round(groundH * 0.25);
    for (let sx = Math.round(0.2 * pxW); sx + bayW <= W; sx += bayW + bayGap) {
      // Shop frame (aluminium)
      ctx.fillStyle = '#6E7880';
      ctx.fillRect(sx, bayY, bayW, bayH);
      // Glass interior — varied tints
      const v = rnd();
      const tint = v < 0.3 ? '#1E2E38' : (v < 0.6 ? '#283A44' : '#2C3C48');
      ctx.fillStyle = tint;
      ctx.fillRect(sx + 2, bayY + 2, bayW - 4, bayH - 4);
      // Center divider (mullion)
      ctx.fillStyle = '#6E7880';
      ctx.fillRect(sx + Math.round(bayW / 2) - 1, bayY, 2, bayH);
    }
    // Signboard band above shopfront (bright colored strip)
    const signH = Math.max(4, Math.round(0.35 * pxH));
    const signY = H - groundH - signH;
    // Pick a sign color based on seed
    const signColors = ['#1A5276', '#7B241C', '#196F3D', '#7D6608', '#4A235A', '#1B4F72', '#6E2C00'];
    const signColor = signColors[seed % signColors.length];
    ctx.fillStyle = signColor;
    ctx.fillRect(0, signY, W, signH);
    // Sign text suggestion (light horizontal line to simulate text)
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    const textY = signY + Math.round(signH * 0.35);
    const textH = Math.max(2, Math.round(signH * 0.3));
    ctx.fillRect(Math.round(0.15 * W), textY, Math.round(0.7 * W), textH);
  }

  // ── Residential/Eixample ground floor: street-level SHOPFRONTS (Barcelona) ──
  // Glazed shop bays with stone surrounds + a fascia sign band — the ground floor of every
  // Eixample block is retail, not a parking shutter.
  if (isResidential) {
    const groundH = Math.round(marginB);
    const baseY = H - groundH;
    // Warm-stone shopfront base (a touch darker than the masonry above)
    ctx.fillStyle = '#A89A82';
    ctx.fillRect(0, baseY, W, groundH);
    // Fascia sign band (where shop names sit)
    const fasciaH = Math.round(groundH * 0.18);
    ctx.fillStyle = '#6E6456';
    ctx.fillRect(0, baseY, W, fasciaH);
    // Shop windows: large glazed bays separated by pilasters
    const bayW = Math.max(8, Math.round(3.2 * pxW));
    const pilasterW = Math.max(2, Math.round(0.5 * pxW));
    const winTop = baseY + fasciaH + Math.round(groundH * 0.08);
    const winH2 = Math.max(4, groundH - fasciaH - Math.round(groundH * 0.22));
    for (let sx = pilasterW; sx + bayW <= W; sx += bayW + pilasterW) {
      ctx.fillStyle = '#2A3A42';                                   // shop glass
      ctx.fillRect(sx, winTop, bayW, winH2);
      ctx.fillStyle = '#46606C';                                   // glass highlight
      ctx.fillRect(sx + 2, winTop + 2, Math.round(bayW * 0.35), winH2 - 4);
      ctx.fillStyle = '#7A6E5C';                                   // stall riser under glass
      ctx.fillRect(sx, winTop + winH2, bayW, Math.round(groundH * 0.1));
    }
  }

  // ── Draw windows with residential enhancements ──
  // Canvas y=0 is top (UV y=1), y=H is bottom (UV y=0 = ground level)
  let floorIdx = 0;
  for (let y = H - marginB - winH; y >= 0; y -= periodV) {

    // ── Residential: floor slab band at bottom of each floor ──
    if (isResidential) {
      const slabH = Math.max(2, Math.round(0.12 * pxH));
      const slabY = y + winH + Math.round(0.15 * pxH);
      // Concrete slab line — darker band
      ctx.fillStyle = '#9A9590';
      ctx.fillRect(0, slabY, W, slabH);
      // Subtle shadow below slab
      ctx.fillStyle = 'rgba(60,55,50,0.15)';
      ctx.fillRect(0, slabY + slabH, W, Math.max(1, Math.round(0.04 * pxH)));
    }

    for (let x = marginL; x + winW <= W; x += periodH) {
      drawRecessedWindow(ctx, x, y, winW, winH, rnd);

      // Sill ledge below window (subtle horizontal line)
      ctx.fillStyle = '#A09890';
      const sillH = Math.max(1, Math.round(0.06 * pxH));
      ctx.fillRect(x - 1, y + winH, winW + 2, sillH);

      // (3D balcony geometry handles railings — no texture railing needed)
    }
    floorIdx++;
  }

  // ── Residential: accent stripe / cornice at parapet (top edge) ──
  if (isResidential) {
    const corniceH = Math.max(2, Math.round(0.15 * pxH));
    ctx.fillStyle = '#8A8580';
    ctx.fillRect(0, 0, W, corniceH);
    // Subtle shadow below cornice
    ctx.fillStyle = 'rgba(60,55,50,0.12)';
    ctx.fillRect(0, corniceH, W, Math.max(1, Math.round(0.05 * pxH)));
  }

  // ── Religious (temple): ornamental bands + arched window tops + brick tint ──
  if (category === 'religious') {
    // Horizontal ornamental bands in cream/gold at floor levels
    const bandColors = ['#D4B870', '#C8A858', '#DCC080', '#B89840'];
    let bandIdx = 0;
    for (let y = H - marginB - winH; y >= 0; y -= periodV) {
      const bandY = y + winH + Math.round(0.05 * pxH);
      const bandH = Math.max(3, Math.round(0.14 * pxH));
      ctx.fillStyle = bandColors[bandIdx % bandColors.length];
      ctx.fillRect(0, bandY, W, bandH);
      // Thin dark line above band (shadow)
      ctx.fillStyle = 'rgba(40,20,10,0.25)';
      ctx.fillRect(0, bandY - 1, W, 1);
      bandIdx++;
    }
    // Arched tops on windows (draw semicircle above each window)
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
        // Cream keystone dot at apex
        ctx.beginPath();
        ctx.arc(archCx, archCy - archR + 2, 2, 0, Math.PI * 2);
        ctx.fillStyle = '#D4B870';
        ctx.fill();
      }
    }
    // Bold cornice at parapet
    const corniceH = Math.max(4, Math.round(0.25 * pxH));
    ctx.fillStyle = '#D4B870';
    ctx.fillRect(0, 0, W, corniceH);
    ctx.fillStyle = 'rgba(60,25,10,0.3)';
    ctx.fillRect(0, corniceH, W, 2);
    // Base plinth band at bottom
    const plinthH = Math.max(4, Math.round(0.3 * pxH));
    ctx.fillStyle = '#A08060';
    ctx.fillRect(0, H - plinthH, W, plinthH);
  }

  // ── Commercial: parapet line + floor bands ──
  if (isCommercial) {
    // Parapet cornice at top (prominent dark band)
    const corniceH = Math.max(3, Math.round(0.2 * pxH));
    ctx.fillStyle = '#5A5550';
    ctx.fillRect(0, 0, W, corniceH);
    ctx.fillStyle = 'rgba(40,35,30,0.2)';
    ctx.fillRect(0, corniceH, W, Math.max(1, Math.round(0.06 * pxH)));

    // Floor separation bands (thin dark lines between floors)
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

// ── Night window emissive textures (one per category, cached) ─────────────────
const _nightTexCache = new Map();

/**
 * Generate a night emissive texture: same window grid as day, but on a black
 * background with ~35% of windows glowing warm yellow (interior lights).
 * Used as emissiveMap on facade materials at night.
 */
/**
 * Generate night emissive textures. We create a larger atlas (4x4 tile grid = 1024x1024)
 * so the repeating pattern is much less obvious. Only ~12% of windows are lit.
 */
function getNightEmissiveTexture(category) {
  if (_nightTexCache.has(category)) return _nightTexCache.get(category);

  const style = WINDOW_STYLES[category] || WINDOW_STYLES.residential;
  // 4x4 grid of the base tile pattern — reduces visible tiling
  const GRID = 4;
  const BASE = 256;
  const W = BASE * GRID, H = BASE * GRID;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);

  const pxW = BASE / WALL_REPEAT_HORIZONTAL_M;
  const pxH = BASE / FLOOR_HEIGHT;
  const winW    = Math.round(style.winW * pxW);
  const winH    = Math.round(style.winH * pxH);
  const periodH = winW + Math.round(style.gapH * pxW);
  const periodV = winH + Math.round(style.gapV * pxH);
  const marginL = Math.round(0.6 * pxW);
  const marginB = Math.round(style.marginB * pxH);
  const edge    = Math.max(2, Math.round(Math.min(winW, winH) * 0.14));

  // Different seed per category, large prime offsets for variety
  let seed = style.seed * 31 + 77773;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

  // Draw across the full atlas
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const ox = gx * BASE;
      const oy = gy * BASE;
      for (let y = oy + BASE - marginB - winH; y >= oy; y -= periodV) {
        for (let x = ox + marginL; x + winW <= ox + BASE; x += periodH) {
          // ~16% chance to be lit — a bit denser so the night skyline reads as alive (was 12%)
          if (rnd() > 0.16) continue;

          const warmth = rnd();
          // Vary color: warm yellow, cool white, or orange
          const type = rnd();
          let r, g, b;
          if (type < 0.6) {
            // Warm yellow
            r = 255; g = 190 + Math.round(warmth * 40); b = 70 + Math.round(warmth * 30);
          } else if (type < 0.85) {
            // Cool white (fluorescent)
            r = 200 + Math.round(warmth * 40); g = 210 + Math.round(warmth * 30); b = 220 + Math.round(warmth * 20);
          } else {
            // Warm orange (dim lamp)
            r = 240; g = 150 + Math.round(warmth * 40); b = 40 + Math.round(warmth * 30);
          }
          const alpha = 0.6 + rnd() * 0.4;
          ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
          ctx.fillRect(x + edge, y + edge, winW - edge * 2, winH - edge * 2);
        }
      }
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  // Scale UVs so 4x4 atlas maps to 4x4 tile repeats
  tex.repeat.set(1 / GRID, 1 / GRID);
  _nightTexCache.set(category, tex);
  return tex;
}

let _buildingNightMode = false;
const NIGHT_EMISSIVE_INTENSITY = 1.4; // window-glow strength at night

/**
 * Toggle building window glow for night mode.
 * Adds/removes emissiveMap on all cached facade materials.
 */
export function setBuildingNightMode(isNight) {
  _buildingNightMode = isNight;
  for (const [cacheKey, mat] of facadeMaterialCache.entries()) {
    const category = cacheKey.split('_')[1] || 'residential';
    applyNightToMaterial(mat, category, isNight);
  }
}

function applyNightToMaterial(mat, category, isNight) {
  // The emissiveMap is baked in at material creation (see getFacadeMaterial), so night mode is just a
  // uniform toggle — no post-hoc emissiveMap add (that silently failed to recompile shared/merged
  // materials, so the windows never lit). Safety net: attach the map if a material somehow lacks it.
  if (isNight && !mat.emissiveMap) { mat.emissiveMap = getNightEmissiveTexture(category); mat.needsUpdate = true; }
  mat.emissiveIntensity = isNight ? NIGHT_EMISSIVE_INTENSITY : 0;
}

// ---------------------------------------------------------------------------
// Flat stylized facade color palettes per building category.
// ---------------------------------------------------------------------------

// Barcelona Eixample facade palette — warm stucco/masonry. Cream, pale ochre, sandstone, pale
// yellow, soft rose, warm light stone, occasional terracotta. NO cold blue-greys, NO dark glass.
const FACADE_PALETTES = {
  residential: [
    // off-white / cream
    0xEDE6D6, 0xF2ECDE, 0xE7DECB,
    // pale ochre / sand
    0xE2D2AC, 0xD9C79C, 0xCFBD90,
    // warm beige
    0xDED2BA, 0xD3C5A8,
    // pale yellow (very Barcelona)
    0xE8DBAC, 0xDFD09A,
    // soft rose / faded pink
    0xE0C8B6, 0xD6BBA6,
    // warm light stone-grey
    0xCFC7B6, 0xC5BBA8,
    // terracotta accent (rare — 1 of 15)
    0xC89A78,
  ],
  commercial:  [
    // warm ground-floor-shop blocks: ochre/sand/cream, a touch bolder
    0xE6D8BE, 0xDCCBA8, 0xD2BE96,
    0xE8E0CE, 0xDED3BC,
    0xD8B89C, 0xCBA888,   // terracotta / warm
    0xE2D6A0,             // ochre-yellow
    0xD0C7B2,             // warm grey
  ],
  office:      [0xDED6C4, 0xD4CAB4, 0xE2DBCB, 0xCFC6B2],   // warm institutional stone
  hospital:    [0xE8E2D4, 0xDED8C8, 0xD6CFBE],             // clean warm stone
  school:      [0xE0D8C2, 0xD6CCB4, 0xCFC6AE],             // warm
  industrial:  [0xCBBBA4, 0xC0AE94, 0xBFB6A6],             // warm brick/grey
  religious:   [
    // terracotta / brick + sandstone (Barcelona churches)
    0xB05040, 0xC05848, 0xC86050, 0xA84838, 0x984030,
    0xDCD0A8, 0xD4C898, 0xD0C090,
  ],
  commercial_glass: [
    // Only for EXPLICITLY glass-tagged buildings now. Light, clean blue-green (Barcelona modern
    // glass, e.g. Torre Glòries) — never the old near-black towers.
    0xAEC4CE, 0xBCCFD6, 0xC2D2D2, 0xA8C0BE, 0xB6CBC8,
  ],
};

function deterministicIndex(id) {
  const h = (id * 9301 + 49297) % 233280;
  return Math.abs(h);
}

// ── Phase A.1: OSM building field helpers ────────────────────────────────────

/**
 * Parse an OSM colour string (CSS named color or #hex) into a THREE.Color hex int.
 * Returns null for unknown/invalid values — caller falls back to type palette.
 * Handles: "white", "tan", "grey", "#bb8877", "#FFE4C4", etc.
 */
function parseOsmColour(str) {
  if (!str || typeof str !== 'string') return null;
  try {
    return new THREE.Color(str.trim()).getHex();
  } catch {
    return null; // unrecognised CSS name or malformed hex → fall through
  }
}

/**
 * Map OSM building:material to a facade category override and/or hex tint.
 * Returns { categoryOverride: string|null, hexTint: number|null }.
 * categoryOverride replaces the type-derived category entirely.
 * hexTint adjusts the palette-selected color (multiplicative warm/cool shift).
 */
function resolveMaterialOverride(materialStr) {
  if (!materialStr) return { categoryOverride: null, hexTint: null };
  const m = materialStr.trim().toLowerCase();
  // Glass/mirror → full commercial_glass category (curtain wall treatment)
  if (m === 'glass' || m === 'mirror') return { categoryOverride: 'commercial_glass', hexTint: null };
  // Brick: warm terracotta tint (#C8906C — brick-orange)
  if (m === 'brick') return { categoryOverride: null, hexTint: 0xC8906C };
  // Plaster/render: neutral, no shift (existing palette is already plaster-like)
  if (m === 'plaster' || m === 'render' || m === 'stucco') return { categoryOverride: null, hexTint: null };
  // Concrete: cool grey tint (#B0B4B8)
  if (m === 'concrete') return { categoryOverride: null, hexTint: 0xB0B4B8 };
  // Stone/limestone: warm off-white (#C8C0A8)
  if (m === 'stone' || m === 'limestone') return { categoryOverride: null, hexTint: 0xC8C0A8 };
  // Metal: cool steel grey (#A0A8B0)
  if (m === 'metal' || m === 'steel' || m === 'aluminum' || m === 'aluminium') return { categoryOverride: null, hexTint: 0xA0A8B0 };
  // Wood: warm brown (#B87848)
  if (m === 'wood' || m === 'timber') return { categoryOverride: null, hexTint: 0xB87848 };
  // Unknown materials: no override, fall through to type palette
  return { categoryOverride: null, hexTint: null };
}

/** Cached MeshLambertMaterial per hex color. */
const facadeMaterialCache = new Map();

// Fog color must match scene.js fog (0xBFD7EE)
const FOG_COLOR_VEC = 'vec3(0.749, 0.843, 0.933)';

function getFacadeMaterial(hexColor, category = 'residential') {
  const cacheKey = hexColor + '_' + category;
  if (facadeMaterialCache.has(cacheKey)) return facadeMaterialCache.get(cacheKey);
  const isGlass = (category === 'commercial_glass');
  const isTemple = (category === 'religious');
  // Bake the night window-glow emissiveMap in at creation (intensity 0 by day). Night mode then only
  // toggles emissiveIntensity — reliable, vs adding an emissiveMap to an already-compiled shared/merged
  // material later (which didn't recompile → the reason no windows lit up at night).
  const emis = { emissive: new THREE.Color(0xffffff), emissiveMap: getNightEmissiveTexture(category), emissiveIntensity: _buildingNightMode ? NIGHT_EMISSIVE_INTENSITY : 0 };
  let mat;
  if (isGlass) {
    mat = new THREE.MeshPhongMaterial({
      color: hexColor, vertexColors: true, map: getWindowTexture(category),
      specular: 0x8899AA, shininess: 60, reflectivity: 0.4, side: THREE.DoubleSide, ...emis,
    });
  } else if (isTemple) {
    mat = new THREE.MeshPhongMaterial({
      color: hexColor, vertexColors: true, map: getWindowTexture(category),
      specular: 0x442211, shininess: 12, side: THREE.DoubleSide, ...emis,
    });
  } else {
    mat = new THREE.MeshLambertMaterial({ color: hexColor, vertexColors: true, map: getWindowTexture(category), side: THREE.DoubleSide, ...emis });
  }
  // Inject extra distance-based fade toward fog color so distant buildings soften
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
        // Clean fade to fog — no warm desaturation
        gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
      #endif`
    );
  };
  // If night mode is already active, apply emissive to this new material
  if (_buildingNightMode) {
    applyNightToMaterial(mat, category, true);
  }
  facadeMaterialCache.set(cacheKey, mat);
  return mat;
}

function getMaterialForBuilding(category, buildingId) {
  const pal = FACADE_PALETTES[category] ?? FACADE_PALETTES.commercial;
  const idx = deterministicIndex(buildingId) % pal.length;
  return getFacadeMaterial(pal[idx], category);
}

/**
 * Map normalised OSM building type to a facade category.
 * Only generic/null types fall back to the road-context heuristic.
 */
const TYPE_TO_CATEGORY = {
  residential: 'residential',
  commercial:  'commercial',
  retail:      'commercial',
  shop:        'commercial',
  office:      'office',
  industrial:  'industrial',
  warehouse:   'industrial',
  factory:     'industrial',
  hospital:    'hospital',
  healthcare:  'hospital',
  school:      'school',
  religious:   'religious',
  mall:        'commercial',
  government:  'office',
  // generic/null → resolved below via road heuristic
};

/**
 * Derive facade category for a building.
 * Explicit OSM types use TYPE_TO_CATEGORY; generic/null fall back to nearest-road heuristic.
 * @param {object} building - normalised building with .type
 * @param {object[]} roads
 * @param {number} worldX
 * @param {number} worldZ
 * @returns {string} one of the FACADE_PRESETS keys
 */
function getBuildingCategory(building, roads, worldX, worldZ) {
  const mapped = TYPE_TO_CATEGORY[building.type];
  if (mapped) return mapped;
  // generic / null (the bulk of Barcelona's OSM, building=yes) → warm Eixample MASONRY by default.
  // Barcelona is overwhelmingly residential perimeter-block masonry, not a glass-office district,
  // so the default is 'residential' (warm facade + wrought-iron balconies), NOT 'commercial'/glass.
  // Buildings fronting a busy artery get warm 'commercial' (ground-floor shops) for street variety.
  if (roads && roads.length > 0) {
    const nearest = findNearestRoadSegment(roads, worldX, worldZ);
    if (nearest) {
      const t = nearest.highwayType;
      if (t === 'primary' || t === 'secondary' || t === 'primary_link' || t === 'secondary_link') {
        return 'commercial';
      }
    }
  }
  return 'residential';
}

/**
 * Per-building brightness variation (±8%) applied via vertex colors.
 */
function getFacadeTint(building) {
  const v = 0.85 + (deterministicIndex(building.id) % 21) / 100;
  return new THREE.Color(v, v, v);
}

/** Apply tint color to all vertices (multiplies with texture when vertexColors: true). */
function applyVertexColor(geometry, color) {
  const pos = geometry.attributes.position;
  if (!pos) return;
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const r = color.r, g = color.g, b = color.b;
  for (let i = 0; i < count; i++) {
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/**
 * Custom UV generator for extruded walls: repeat by wall length (4 m) and floor height (3 m).
 */
function createFacadeUVGenerator(buildingHeight) {
  const verticalRepeat = buildingHeight / FLOOR_HEIGHT;
  return {
    generateTopUV(_geometry, _vertices, _indexA, _indexB, _indexC) {
      // Roof is barely visible from street level; return stable [0,1] UVs.
      return [
        new THREE.Vector2(0, 0),
        new THREE.Vector2(1, 0),
        new THREE.Vector2(1, 1),
      ];
    },
    generateSideWallUV(geometry, vertices, indexA, indexB, indexC, indexD) {
      const a_x = vertices[indexA * 3];
      const a_y = vertices[indexA * 3 + 1];
      const b_x = vertices[indexB * 3];
      const b_y = vertices[indexB * 3 + 1];
      const wallLength = Math.hypot(b_x - a_x, b_y - a_y);
      const verticalRepeat = buildingHeight / FLOOR_HEIGHT;
      const horizontalRepeat = wallLength / WALL_REPEAT_HORIZONTAL_M;  // wallLength is real metres (Unstretch-X)
      return [
        new THREE.Vector2(0, 0),
        new THREE.Vector2(horizontalRepeat, 0),
        new THREE.Vector2(horizontalRepeat, verticalRepeat),
        new THREE.Vector2(0, verticalRepeat),
      ];
    },
  };
}

/**
 * Normalize geometry for merge: ensure position, normal, uv, color attributes exist.
 * Keeps indexed geometry when possible to reduce vertex count.
 */
function normalizeForMerge(geometry) {
  if (!geometry || !geometry.attributes.position) return null;
  const geom = geometry;
  if (!geom.attributes.normal) geom.computeVertexNormals();
  const count = geom.attributes.position.count;
  if (!geom.attributes.color) {
    const colors = new Float32Array(count * 3);
    colors.fill(0.6);
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  if (!geom.attributes.uv) {
    geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  return geom;
}

function logGeometryAttributes(geometries, prefix) {
  if (!DEBUG_BUILDINGS) return;
  geometries.forEach((g, i) => {
    const names = g.attributes ? Object.keys(g.attributes) : [];
  });
}

/** Ray-casting point-in-polygon test for footprint [{x,y}]. */
function pointInFootprint(px, pz, fp) {
  let inside = false;
  for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) {
    const xi = fp[i].x, zi = fp[i].y, xj = fp[j].x, zj = fp[j].y;
    if ((zi > pz) !== (zj > pz) && px < (xj - xi) * (pz - zi) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ── Footprint simplification (Ramer-Douglas-Peucker) ────────────────────────

/**
 * Perpendicular distance from point p to line segment a-b.
 */
function perpDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Ramer-Douglas-Peucker polyline simplification.
 */
function rdpSimplify(points, epsilon) {
  if (points.length <= 2) return points;
  let maxDist = 0, maxIdx = 0;
  const first = points[0], last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], first, last);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist > epsilon) {
    const left = rdpSimplify(points.slice(0, maxIdx + 1), epsilon);
    const right = rdpSimplify(points.slice(maxIdx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

/**
 * Simplify a building footprint if it has too many vertices.
 * Preserves shape at game scale (epsilon = 0.3m).
 */
function simplifyFootprint(footprint) {
  if (!footprint || footprint.length <= MAX_FOOTPRINT_VERTICES) return footprint;
  // Iteratively increase epsilon until we're under the limit
  let epsilon = 0.3;
  let simplified = rdpSimplify(footprint, epsilon);
  while (simplified.length > MAX_FOOTPRINT_VERTICES && epsilon < 3) {
    epsilon *= 1.5;
    simplified = rdpSimplify(footprint, epsilon);
  }
  // Ensure at least 3 points
  return simplified.length >= 3 ? simplified : footprint;
}

// ── Shared geometry helpers ──────────────────────────────────────────────────

/** Extract { cx, cy, radius } for a cylinder building. Returns null if footprint is degenerate. */
function getCylinderParams(building) {
  if (building.center != null && building.radius != null && Number.isFinite(building.radius)) {
    return { cx: building.center.x, cy: building.center.y, radius: building.radius };
  }
  const footprint = building.footprint || [];
  if (footprint.length < 3) return null;
  const pts =
    footprint.length > 1 &&
    footprint[0].x === footprint[footprint.length - 1].x &&
    footprint[0].y === footprint[footprint.length - 1].y
      ? footprint.slice(0, -1)
      : footprint;
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const radius = pts.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length;
  return { cx, cy, radius };
}

/** Build a THREE.Shape + centroid for a polygon building footprint. Returns null if degenerate. */
function buildPolygonShape(building) {
  let footprint = building.footprint || [];
  if (footprint.length < 3) return null;
  // Simplify complex footprints
  footprint = simplifyFootprint(footprint);
  const n =
    footprint.length -
    (footprint[0].x === footprint[footprint.length - 1].x &&
     footprint[0].y === footprint[footprint.length - 1].y
      ? 1 : 0);
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += footprint[i].x; cy += footprint[i].y; }
  cx /= n; cy /= n;

  const shape = new THREE.Shape();
  shape.moveTo(footprint[0].x - cx, cy - footprint[0].y);
  for (let i = 1; i < footprint.length; i++) {
    shape.lineTo(footprint[i].x - cx, cy - footprint[i].y);
  }
  shape.closePath();

  if (building.innerRings && building.innerRings.length > 0) {
    for (let ring of building.innerRings) {
      if (!ring || ring.length < 3) continue;
      ring = simplifyFootprint(ring);
      const hole = new THREE.Path();
      hole.moveTo(ring[0].x - cx, cy - ring[0].y);
      for (let i = 1; i < ring.length; i++) {
        hole.lineTo(ring[i].x - cx, cy - ring[i].y);
      }
      hole.closePath();
      shape.holes.push(hole);
    }
  }
  return { shape, cx, cy };
}

// ── Wall geometry (facade-textured) ─────────────────────────────────────────

/**
 * Cylinder walls only (open-ended) with facade UV scaling.
 */
export function createCylinderBuilding(building, baseY = 0) {
  const params = getCylinderParams(building);
  if (!params) return null;
  const { cx, cy, radius } = params;
  const h = building.height;

  // openEnded:true → side walls only, no caps
  const geom = new THREE.CylinderGeometry(radius, radius, h, CYLINDER_RADIAL_SEGMENTS, 1, true);
  geom.translate(cx, baseY + h / 2, cy);

  const perimeter = 2 * Math.PI * radius;
  const horizontalRepeat = perimeter / WALL_REPEAT_HORIZONTAL_M;  // perimeter is real metres (Unstretch-X)
  const verticalRepeat = h / FLOOR_HEIGHT;
  const uvAttr = geom.getAttribute('uv');
  if (uvAttr) {
    const uvs = uvAttr.array;
    for (let i = 0; i < uvs.length; i += 2) {
      uvs[i]     *= horizontalRepeat;
      uvs[i + 1] *= verticalRepeat;
    }
    uvAttr.needsUpdate = true;
  }
  return geom;
}

/**
 * Polygon walls only (ExtrudeGeometry side-wall group) with facade UV generator.
 */
export function createPolygonBuilding(building, baseY = 0) {
  const s = buildPolygonShape(building);
  if (!s) return null;
  const { shape, cx, cy } = s;

  const uvGen = createFacadeUVGenerator(building.height);
  const extruded = new THREE.ExtrudeGeometry(shape, {
    depth: building.height,
    bevelEnabled: false,
    steps: 1,
    UVGenerator: uvGen,
  });

  // Keep only the side-wall faces (materialIndex 1); discard top/bottom caps.
  const wallGroup = extruded.groups.find(g => g.materialIndex === 1);
  let geom;
  if (wallGroup && extruded.index) {
    const wallIdx = extruded.index.array.subarray(wallGroup.start, wallGroup.start + wallGroup.count);
    geom = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(extruded.attributes)) {
      geom.setAttribute(name, attr);
    }
    geom.setIndex(new THREE.BufferAttribute(new Uint32Array(wallIdx), 1));
    extruded.dispose();
  } else {
    geom = extruded;
  }

  geom.rotateX(-Math.PI / 2);
  geom.translate(cx, baseY, cy);
  return geom;
}

// ── Roof geometry (plain, no UV texture) ────────────────────────────────────

/** Small Y lift to sit just above the wall top edge and avoid z-fighting. */
const ROOF_Y_OFFSET = 0.03;

/** Flat disc at the top of a cylinder building. */
function createCylinderRoofGeometry(building, baseY = 0) {
  const params = getCylinderParams(building);
  if (!params) return null;
  const { cx, cy, radius } = params;
  const geom = new THREE.CircleGeometry(radius, CYLINDER_RADIAL_SEGMENTS);
  geom.rotateX(-Math.PI / 2);
  geom.translate(cx, baseY + building.height + ROOF_Y_OFFSET, cy);
  return geom;
}

/** Flat polygon cap at the top of a polygon building. */
function createPolygonRoofGeometry(building, baseY = 0) {
  const s = buildPolygonShape(building);
  if (!s) return null;
  const { shape, cx, cy } = s;
  const geom = new THREE.ShapeGeometry(shape);
  geom.rotateX(-Math.PI / 2);
  geom.translate(cx, baseY + building.height + ROOF_Y_OFFSET, cy);
  return geom;
}

/**
 * Render all buildings for a tile: group by material, merge per group, return one mesh per material.
 * Uses tileData.roads for category; presets for shared materials; UVs and tint per building.
 * @param {object} tileData - { buildings, roads }
 * @param {object} options - { getElevationAt }
 * @returns {THREE.Mesh[]}
 */
export function renderTileBuildings(tileData, options) {
  const buildings = tileData?.buildings;
  const roads = tileData?.roads || [];
  if (!buildings || buildings.length === 0) return [];
  const getElevationAt = options?.getElevationAt;

  /** @type {Map<THREE.Material, { geometries: THREE.BufferGeometry[], vertexCount: number, toDispose: THREE.BufferGeometry[] }>} */
  const byMaterial = new Map();
  const metaByMaterial = new Map();

  // Roof geometries collected per-material (like facades) for category color variation.
  /** @type {Map<THREE.Material, { geometries: THREE.BufferGeometry[], vertexCount: number, toDispose: THREE.BufferGeometry[] }>} */
  const roofByMaterial = new Map();

  // Detail collection: water tanks + pipes (rendered as InstancedMesh after merge)
  const tankInstances = [];   // { x, y, z, scale }
  const pipeInstances = [];   // { x, y, z, height, radius }

  // Residential 3D detail geometry (balcony slabs + railings + floor bands)
  const balconySlabGeoms = [];   // concrete slab geometry
  const balconyRailGeoms = [];   // metal railing geometry
  let balconySlabVerts = 0;
  let balconyRailVerts = 0;
  const BALCONY_VERT_CAP = 20000;

  // Commercial 3D detail geometry
  const awningGeoms = [];       // shop awning canopies
  const acUnitGeoms = [];       // AC outdoor unit boxes
  const acFanGeoms = [];        // AC fan circles (dark disc on front face)
  const parapetGeoms = [];      // parapet wall on roof edge
  const pillarGeoms = [];       // ground floor columns
  const signboardGeoms = [];    // signboard backing panels
  const barExtrudeGeoms = [];   // random decorative bar extrusions
  let commercialVerts = 0;
  const COMMERCIAL_VERT_CAP = 20000;

  // Mall-specific: billboard panels + "SHOPPING MALL" sign
  const mallBillboardGeoms = [];  // ad billboard panels on walls
  const mallSignGeoms = [];       // "SHOPPING MALL" text sign below roof
  let mallVerts = 0;
  const MALL_VERT_CAP = 6000;

  // Religious (temple) 3D detail geometry
  const shikharaGeoms = [];     // tower/spire cones on top
  const templeBaseGeoms = [];   // stepped plinth at ground
  const templeBandGeoms = [];   // horizontal ornamental bands on walls
  const flagPoleGeoms = [];     // flag pole cylinders
  const flagGeoms = [];         // triangular saffron flags
  let religiousVerts = 0;
  const RELIGIOUS_VERT_CAP = 12000;

  // Boundary wall + gate geometry for residential buildings
  const boundaryWallGeoms = [];  // concrete boundary wall
  const gateGeoms = [];          // gate pillars + metal gate
  let boundaryVerts = 0;
  const BOUNDARY_VERT_CAP = 15000;

  for (const b of buildings) {
    // Skip underground structures (metro stations, tunnels, etc.)
    if (b.layer != null && b.layer < 0) continue;

    let cx, cy;
    if (b.center != null) {
      cx = b.center.x;
      cy = b.center.y;
    } else {
      const footprint = b.footprint || [];
      const pts =
        footprint.length > 1 &&
        footprint[0].x === footprint[footprint.length - 1].x &&
        footprint[0].y === footprint[footprint.length - 1].y
          ? footprint.slice(0, -1)
          : footprint;
      if (pts.length === 0) continue;
      cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    }

    const vertExag =
      CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION)
        ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION
        : 1;
    let baseY = 0;
    if (getElevationAt && cx != null && cy != null) {
      const { lat, lon } = worldToLatLon(cx, cy);
      baseY = (getElevationAt(lat, lon) ?? 0) * vertExag + BUILDING_Z_OFFSET;
    } else {
      baseY = BUILDING_Z_OFFSET;
    }

    let category = getBuildingCategory(b, roads, cx, cy);
    // Barcelona redesign: NO height-based auto-glass. The old `commercial && height>=18 → glass`
    // rule turned every default 18 m building into a dark reflective tower — the entire reason the
    // city read as a glass office district. Glass now appears ONLY when OSM explicitly tags it
    // (building=office at real height, or building:material=glass — handled below). Barcelona's
    // tall buildings are masonry, not curtain wall.

    // OSM building:material may override category (e.g., glass → commercial_glass).
    const { categoryOverride, hexTint } = resolveMaterialOverride(b.material);
    if (categoryOverride) category = categoryOverride;

    // Phase A.1: b.roofShape stored on building — available for future geometry polish.
    // No geometry change this session; field confirmed to flow through pipeline.
    // (b.roofShape is already on the object from tileParserWorker — no action needed here)

    const isCommercial = (category === 'commercial' || category === 'commercial_glass');

    // ── Residential setback: push road-facing edge inward to create driveway gap ──
    // Barcelona: OFF — Eixample blocks build right up to the pavement (no front driveway/setback).
    let originalFootprint = null;  // saved for gate placement later
    const RESIDENTIAL_SETBACK = 3.0; // metres inward from road-facing edge
    if (ENABLE_DELHI_DETAILS && BALCONY_CATEGORIES.has(category) && b.shapeType !== 'cylinder'
        && b.footprint?.length >= 3 && b.height >= 6) {
      const fp = b.footprint;
      const nearest = findNearestRoadSegment(roads, cx, cy);
      if (nearest && nearest.distance < 25) {
        // Find road-facing edge
        let bestEi = -1, bestDist = Infinity;
        for (let ei = 0; ei < fp.length; ei++) {
          const pp0 = fp[ei], pp1 = fp[(ei + 1) % fp.length];
          const emx = (pp0.x + pp1.x) / 2, emz = (pp0.y + pp1.y) / 2;
          const elen = Math.hypot(pp1.x - pp0.x, pp1.y - pp0.y);
          if (elen < 3) continue;
          const roadPts = nearest.road.points || [];
          let minDSq = Infinity;
          for (let ri = 0; ri < roadPts.length - 1; ri++) {
            const ra = roadPts[ri], rb = roadPts[ri + 1];
            const rdx = rb.x - ra.x, rdz = rb.y - ra.y;
            const rlenSq = rdx * rdx + rdz * rdz;
            let t = rlenSq > 0 ? ((emx - ra.x) * rdx + (emz - ra.y) * rdz) / rlenSq : 0;
            t = Math.max(0, Math.min(1, t));
            const qx = ra.x + t * rdx, qz = ra.y + t * rdz;
            const dSq = (emx - qx) ** 2 + (emz - qz) ** 2;
            if (dSq < minDSq) minDSq = dSq;
          }
          if (minDSq < bestDist) { bestDist = minDSq; bestEi = ei; }
        }
        if (bestEi >= 0 && bestDist < 20 * 20) {
          const pp0 = fp[bestEi], pp1 = fp[(bestEi + 1) % fp.length];
          const edx2 = pp1.x - pp0.x, edz2 = pp1.y - pp0.y;
          const elen2 = Math.hypot(edx2, edz2);
          let fnx = -edz2 / elen2, fnz = edx2 / elen2;
          // Ensure normal points outward
          let fcx3 = 0, fcz3 = 0;
          for (const p of fp) { fcx3 += p.x; fcz3 += p.y; }
          fcx3 /= fp.length; fcz3 /= fp.length;
          const emx2 = (pp0.x + pp1.x) / 2, emz2 = (pp0.y + pp1.y) / 2;
          if ((emx2 - fcx3) * fnx + (emz2 - fcz3) * fnz < 0) { fnx = -fnx; fnz = -fnz; }
          // Save original footprint, then push front edge vertices inward
          originalFootprint = fp.map(p => ({ x: p.x, y: p.y }));
          const i0 = bestEi, i1 = (bestEi + 1) % fp.length;
          fp[i0] = { x: fp[i0].x - fnx * RESIDENTIAL_SETBACK, y: fp[i0].y - fnz * RESIDENTIAL_SETBACK };
          fp[i1] = { x: fp[i1].x - fnx * RESIDENTIAL_SETBACK, y: fp[i1].y - fnz * RESIDENTIAL_SETBACK };
        }
      }
    }

    let geom = null;
    if (b.shapeType === 'cylinder') {
      geom = createCylinderBuilding(b, baseY);
    } else {
      geom = createPolygonBuilding(b, baseY);
    }

    if (!geom) {
      if (originalFootprint) b.footprint = originalFootprint;
      continue;
    }

    // Phase A.1: material selection priority:
    //   1. OSM building:colour (specific hex or CSS name) → exact colour
    //   2. OSM building:material hexTint                 → tinted type palette colour
    //   3. Type palette (existing fallback)               → unchanged behaviour
    let material;
    const osmColourHex = parseOsmColour(b.colour);
    if (osmColourHex != null) {
      // OSM colour wins — use it directly with window texture for category
      material = getFacadeMaterial(osmColourHex, category);
    } else if (hexTint != null) {
      // Material tint: use the tint colour instead of palette colour
      material = getFacadeMaterial(hexTint, category);
    } else {
      // No OSM colour/material override — existing type palette (unchanged behaviour)
      material = getMaterialForBuilding(category, b.id);
    }
    if (!material) {
      if (originalFootprint) b.footprint = originalFootprint;
      continue;
    }
    applyVertexColor(geom, getFacadeTint(b));

    const normalized = normalizeForMerge(geom);
    if (!normalized) {
      geom.dispose();
      if (originalFootprint) b.footprint = originalFootprint;
      continue;
    }
    if (normalized !== geom) {
      if (!byMaterial.has(material)) byMaterial.set(material, { geometries: [], vertexCount: 0, toDispose: [] });
      byMaterial.get(material).toDispose.push(geom);
    }

    const count = normalized.attributes.position.count;
    if (!byMaterial.has(material)) {
      byMaterial.set(material, { geometries: [], vertexCount: 0, toDispose: [] });
      metaByMaterial.set(material, []);
    }
    const entry = byMaterial.get(material);
    if (entry.vertexCount + count > MAX_VERTICES_PER_TILE) {
      if (originalFootprint) b.footprint = originalFootprint;
      continue;
    }
    entry.geometries.push(normalized);
    entry.vertexCount += count;
    metaByMaterial.get(material).push({ id: b.id, tags: b.tags || {}, height: b.height });

    // ── Roof cap — use CURRENT (setback) footprint so roof matches walls ──
    let roofRaw = b.shapeType === 'cylinder'
      ? createCylinderRoofGeometry(b, baseY)
      : createPolygonRoofGeometry(b, baseY);

    // Save setback footprint for balcony placement (matches actual wall positions)
    const setbackFootprint = originalFootprint ? b.footprint.map(p => ({ x: p.x, y: p.y })) : null;

    // Restore original footprint AFTER roof creation (gate uses original edge position)
    if (originalFootprint) {
      b.footprint = originalFootprint;
    }
    if (roofRaw) {
      applyVertexColor(roofRaw, getFacadeTint(b));
      const roofNorm = normalizeForMerge(roofRaw);
      if (roofNorm) {
        const roofMat = getRoofMaterialForBuilding(category, b.id);
        if (!roofByMaterial.has(roofMat)) roofByMaterial.set(roofMat, { geometries: [], vertexCount: 0, toDispose: [] });
        const rEntry = roofByMaterial.get(roofMat);
        if (roofNorm !== roofRaw) rEntry.toDispose.push(roofRaw);
        const rc = roofNorm.attributes.position.count;
        if (rEntry.vertexCount + rc <= MAX_VERTICES_PER_TILE) {
          rEntry.geometries.push(roofNorm);
          rEntry.vertexCount += rc;
        } else {
          roofNorm.dispose();
        }
      } else {
        roofRaw.dispose();
      }
    }

    // ── Collect water tank positions in groups (buildings > 6m) ── Barcelona: removed
    // (Delhi-style rooftop water tanks). Barcelona rooftops are terraces, not tank farms.
    if (ENABLE_DELHI_DETAILS && b.height > 6 && b.footprint?.length >= 3) {
      const fp = b.footprint;
      let fmnX = Infinity, fmxX = -Infinity, fmnZ = Infinity, fmxZ = -Infinity;
      for (const p of fp) {
        if (p.x < fmnX) fmnX = p.x; if (p.x > fmxX) fmxX = p.x;
        if (p.y < fmnZ) fmnZ = p.y; if (p.y > fmxZ) fmxZ = p.y;
      }
      const roofY = baseY + b.height + ROOF_Y_OFFSET;
      const roofW = fmxX - fmnX, roofD = fmxZ - fmnZ;
      // 1–2 tank groups per building
      const groupCount = 1 + deterministicIndex(b.id + 13) % 2;
      const padX = roofW * 0.25, padZ = roofD * 0.25;
      for (let gi = 0; gi < groupCount; gi++) {
        // Group centre on the roof
        const gcx = fmnX + padX + (deterministicIndex(b.id * 5 + gi) % 100) / 100 * (roofW - 2 * padX);
        const gcz = fmnZ + padZ + (deterministicIndex(b.id * 5 + gi + 99) % 100) / 100 * (roofD - 2 * padZ);
        // Only proceed if group centre is inside the actual footprint polygon
        if (!pointInFootprint(gcx, gcz, fp)) continue;
        // 2–4 tanks per group, tightly clustered
        const tanksInGroup = 2 + deterministicIndex(b.id * 7 + gi + 30) % 3;
        for (let ti = 0; ti < tanksInGroup; ti++) {
          const angle = (ti / tanksInGroup) * Math.PI * 2 + deterministicIndex(b.id + ti + gi) * 0.3;
          const dist = 0.8 + (deterministicIndex(b.id * 3 + ti + gi * 10) % 60) / 100;
          const tx = gcx + Math.cos(angle) * dist;
          const tz = gcz + Math.sin(angle) * dist;
          // Must be inside the actual building footprint
          if (!pointInFootprint(tx, tz, fp)) continue;
          const s = 0.55 + (deterministicIndex(b.id * 11 + ti + gi * 7 + 41) % 55) / 100;
          tankInstances.push({ x: tx, y: roofY, z: tz, scale: s });
        }
      }
    }

    // ── Collect pipe positions (~35% of buildings taller than 4m) ─────────────
    if (b.height > 4 && b.footprint?.length >= 3 && deterministicIndex(b.id + 21) % 100 < 35) {
      const fp = b.footprint;
      const edgeIdx = deterministicIndex(b.id + 33) % Math.max(1, fp.length - 1);
      const p0 = fp[edgeIdx], p1 = fp[(edgeIdx + 1) % fp.length];
      const edx = p1.x - p0.x, edz = p1.y - p0.y;
      const elen = Math.hypot(edx, edz);
      if (elen > 0.5) {
        const mx = (p0.x + p1.x) / 2, mz = (p0.y + p1.y) / 2;
        const nx = -edz / elen, nz = edx / elen;
        // Push outward (away from centroid)
        const toCx = cx - mx, toCz = cy - mz;
        const sign = (toCx * nx + toCz * nz) < 0 ? 1 : -1;
        const pipeR = 0.05 + (deterministicIndex(b.id + 55) % 30) / 1000; // 0.05–0.08
        pipeInstances.push({
          x: mx + nx * 0.12 * sign,
          y: baseY,
          z: mz + nz * 0.12 * sign,
          height: b.height,
          radius: pipeR,
        });
      }
    }

    // Helper: create a box geometry given 2 edge points + outward normal + thickness + base Y + height
    function makeBoxGeom(ax, az, bxx, bz, nrx, nrz, thick, y0, h) {
      const pos = new Float32Array(8 * 3);
      pos[0]=ax;           pos[1]=y0;   pos[2]=az;
      pos[3]=bxx;          pos[4]=y0;   pos[5]=bz;
      pos[6]=bxx;          pos[7]=y0+h; pos[8]=bz;
      pos[9]=ax;           pos[10]=y0+h; pos[11]=az;
      pos[12]=ax+nrx*thick; pos[13]=y0;   pos[14]=az+nrz*thick;
      pos[15]=bxx+nrx*thick; pos[16]=y0;   pos[17]=bz+nrz*thick;
      pos[18]=bxx+nrx*thick; pos[19]=y0+h; pos[20]=bz+nrz*thick;
      pos[21]=ax+nrx*thick; pos[22]=y0+h; pos[23]=az+nrz*thick;
      const idx=[0,1,2,0,2,3, 4,6,5,4,7,6, 3,2,6,3,6,7, 0,5,1,0,4,5, 0,3,7,0,7,4, 1,5,6,1,6,2];
      // UVs: tile brick pattern based on edge length and height
      const edgeLen = Math.hypot(bxx - ax, bz - az);
      const BRICK_TILE = 2.0; // metres per UV repeat
      const uLen = edgeLen / BRICK_TILE;
      const vH = h / BRICK_TILE;
      const uT = thick / BRICK_TILE;
      // 8 verts: front(0-3), back(4-7). Front face: 0=BL 1=BR 2=TR 3=TL
      const uvs = new Float32Array([
        0,0,  uLen,0,  uLen,vH,  0,vH,      // front face
        uLen,0,  0,0,  0,vH,  uLen,vH,      // back face
      ]);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      return g;
    }

    // ── Residential 3D balconies: extruded slab + railing per floor per edge ──
    // Use setback footprint (if available) so balconies match actual wall positions
    if (BALCONY_CATEGORIES.has(category) && b.shapeType !== 'cylinder'
        && b.height >= 6 && b.footprint?.length >= 3
        && balconySlabVerts < BALCONY_VERT_CAP) {
      const fp = setbackFootprint || b.footprint;
      const floorH = 3.0;
      const numFloors = Math.floor(b.height / floorH);
      const SLAB_DEPTH = 0.9;      // how far balcony sticks out
      const SLAB_THICK = 0.25;     // slab thickness (visible concrete floor)
      const RAIL_H = 0.85;         // railing height
      const RAIL_BAR_W = 0.04;     // railing bar thickness
      const RAIL_BAR_SPACING = 0.25;
      const FLOOR_BAND_H = 0.12;   // horizontal floor band thickness
      const FLOOR_BAND_DEPTH = 0.06; // how far band protrudes

      // Compute centroid for outward normal direction
      let fcx = 0, fcz = 0;
      for (const p of fp) { fcx += p.x; fcz += p.y; }
      fcx /= fp.length; fcz /= fp.length;

      for (let ei = 0; ei < fp.length; ei++) {
        const p0 = fp[ei], p1 = fp[(ei + 1) % fp.length];
        const edx = p1.x - p0.x, edz = p1.y - p0.y;
        const edgeLen = Math.hypot(edx, edz);
        if (edgeLen < 2.0) continue; // skip tiny edges

        // Edge direction and outward normal
        const ex = edx / edgeLen, ez = edz / edgeLen;
        let nx = -ez, nz = ex;
        // Ensure normal points outward (away from centroid)
        const mx = (p0.x + p1.x) / 2, mz = (p0.y + p1.y) / 2;
        if ((mx - fcx) * nx + (mz - fcz) * nz < 0) { nx = -nx; nz = -nz; }

        // Deterministic: does this edge get any balconies at all?
        const edgeHash = deterministicIndex(b.id * 31 + ei * 7);
        const edgeHasBalconies = (edgeHash % 100) < 55;

        // Divide edge into individual balcony slots (~2.5m wide each)
        const SLOT_W = 2.5;           // width of each balcony slot
        const SLOT_GAP = 0.4;         // gap between slots
        const SLOT_INSET = 0.5;       // inset from edge corners
        const availLen = edgeLen - SLOT_INSET * 2;
        if (availLen < SLOT_W) continue;
        const numSlots = Math.max(1, Math.floor(availLen / (SLOT_W + SLOT_GAP)));
        const actualSpacing = availLen / numSlots;
        const slotStart = SLOT_INSET;

        for (let fi = 1; fi < numFloors; fi++) {
          const floorY = baseY + fi * floorH;
          if (balconySlabVerts >= BALCONY_VERT_CAP) break;

          // ── Floor band (thin strip along entire edge) ──
          balconySlabGeoms.push(makeBoxGeom(p0.x, p0.y, p1.x, p1.y, nx, nz, FLOOR_BAND_DEPTH, floorY - FLOOR_BAND_H, FLOOR_BAND_H));
          balconySlabVerts += 8;

          if (!edgeHasBalconies) continue;

          // ── Per-slot individual balconies (patchy) ──
          for (let si2 = 0; si2 < numSlots; si2++) {
            if (balconySlabVerts >= BALCONY_VERT_CAP) break;
            // Deterministic: ~55% of slots on each floor get a balcony
            const slotHash = deterministicIndex(b.id * 17 + ei * 113 + fi * 53 + si2 * 7);
            if ((slotHash % 100) >= 55) continue;

            const slotT0 = (slotStart + si2 * actualSpacing) / edgeLen;
            const slotT1 = (slotStart + si2 * actualSpacing + SLOT_W) / edgeLen;
            const sx0 = p0.x + edx * slotT0, sz0 = p0.y + edz * slotT0;
            const sx1 = p0.x + edx * slotT1, sz1 = p0.y + edz * slotT1;

            // Balcony slab — start slightly inside building wall so it connects seamlessly
            const SLAB_INSET = 0.15; // penetrate into wall to avoid visible gap
            const ix0 = sx0 - nx * SLAB_INSET, iz0 = sz0 - nz * SLAB_INSET;
            const ix1 = sx1 - nx * SLAB_INSET, iz1 = sz1 - nz * SLAB_INSET;
            balconySlabGeoms.push(makeBoxGeom(ix0, iz0, ix1, iz1, nx, nz, SLAB_DEPTH + SLAB_INSET, floorY, SLAB_THICK));
            balconySlabVerts += 8;

            // Railing: 3 sides (front + left return + right return) as solid panels
            const railBaseY = floorY + SLAB_THICK;
            const d = SLAB_DEPTH; // railing at outer edge (not inset)
            const hw = RAIL_BAR_W * 1.5;
            // Front railing panel
            balconyRailGeoms.push(makeBoxGeom(sx0+nx*d, sz0+nz*d, sx1+nx*d, sz1+nz*d, nx, nz, hw, railBaseY, RAIL_H));
            balconyRailVerts += 8;
            // Left side return (wall→outer)
            balconyRailGeoms.push(makeBoxGeom(sx0, sz0, sx0+nx*d, sz0+nz*d, -ex, -ez, hw, railBaseY, RAIL_H));
            balconyRailVerts += 8;
            // Right side return (outer→wall)
            balconyRailGeoms.push(makeBoxGeom(sx1+nx*d, sz1+nz*d, sx1, sz1, ex, ez, hw, railBaseY, RAIL_H));
            balconyRailVerts += 8;

            // Vertical bars on front edge only (fewer for perf)
            const slotLen = Math.hypot(sx1-sx0, sz1-sz0);
            const numBars = Math.max(2, Math.floor(slotLen / RAIL_BAR_SPACING));
            for (let bi = 0; bi <= numBars; bi++) {
              if (balconyRailVerts >= BALCONY_VERT_CAP) break;
              const bt = bi / numBars;
              const bpx = sx0 + (sx1-sx0)*bt + nx*d;
              const bpz = sz0 + (sz1-sz0)*bt + nz*d;
              const bhw = RAIL_BAR_W / 2;
              balconyRailGeoms.push(makeBoxGeom(bpx-ex*bhw, bpz-ez*bhw, bpx+ex*bhw, bpz+ez*bhw, nx, nz, bhw*2, railBaseY, RAIL_H));
              balconyRailVerts += 8;
            }
          }
        }
      }
    }

    // ── Commercial 3D details: awnings, AC units, parapet, pillars ──
    if (isCommercial && b.shapeType !== 'cylinder'
        && b.footprint?.length >= 3 && b.height >= 5
        && commercialVerts < COMMERCIAL_VERT_CAP) {
      const fp = b.footprint;
      const floorH = 3.0;
      const numFloors = Math.floor(b.height / floorH);

      // Compute centroid for outward normal direction
      let ccx = 0, ccz = 0;
      for (const p of fp) { ccx += p.x; ccz += p.y; }
      ccx /= fp.length; ccz /= fp.length;

      for (let ei = 0; ei < fp.length; ei++) {
        if (commercialVerts >= COMMERCIAL_VERT_CAP) break;
        const p0 = fp[ei], p1 = fp[(ei + 1) % fp.length];
        const edx = p1.x - p0.x, edz = p1.y - p0.y;
        const edgeLen = Math.hypot(edx, edz);
        if (edgeLen < 2.5) continue;

        const ex = edx / edgeLen, ez = edz / edgeLen;
        let nx = -ez, nz = ex;
        const mx = (p0.x + p1.x) / 2, mz = (p0.y + p1.y) / 2;
        if ((mx - ccx) * nx + (mz - ccz) * nz < 0) { nx = -nx; nz = -nz; }

        const edgeHash = deterministicIndex(b.id * 31 + ei * 13);

        // ── Ground-floor pillars (columns) — recessed ground floor look ──
        if (edgeLen >= 5 && numFloors >= 2) {
          const PILLAR_SPACING = 3.0;
          const PILLAR_W = 0.3;
          const PILLAR_D = 0.3;
          const PILLAR_H = floorH - 0.1;
          const numPillars = Math.max(2, Math.floor(edgeLen / PILLAR_SPACING));
          for (let pi = 0; pi <= numPillars; pi++) {
            if (commercialVerts >= COMMERCIAL_VERT_CAP) break;
            const t = pi / numPillars;
            const px = p0.x + edx * t;
            const pz = p0.y + edz * t;
            // Pillar slightly in front of wall
            const ox = px + nx * 0.05, oz = pz + nz * 0.05;
            pillarGeoms.push(makeBoxGeom(
              ox - ex * PILLAR_W / 2, oz - ez * PILLAR_W / 2,
              ox + ex * PILLAR_W / 2, oz + ez * PILLAR_W / 2,
              nx, nz, PILLAR_D, baseY, PILLAR_H
            ));
            commercialVerts += 8;
          }
        }

        // ── Shop awnings above ground floor (~3m height, on select edges) ──
        if ((edgeHash % 100) < 65 && edgeLen >= 3) {
          const AWNING_DEPTH = 1.2;
          const AWNING_THICK = 0.06;
          const awningY = baseY + floorH - 0.3;
          // Flat slab awning over shopfront
          awningGeoms.push(makeBoxGeom(
            p0.x + edx * 0.05, p0.y + edz * 0.05,
            p0.x + edx * 0.95, p0.y + edz * 0.95,
            nx, nz, AWNING_DEPTH, awningY, AWNING_THICK
          ));
          commercialVerts += 8;
        }

        // ── Signboard panel above awning (colored rectangle backing) ──
        if ((edgeHash % 100) < 50 && edgeLen >= 4) {
          const SIGN_H = 0.6;
          const SIGN_D = 0.05;
          const signY = baseY + floorH + 0.1;
          signboardGeoms.push(makeBoxGeom(
            p0.x + edx * 0.08, p0.y + edz * 0.08,
            p0.x + edx * 0.92, p0.y + edz * 0.92,
            nx, nz, SIGN_D, signY, SIGN_H
          ));
          commercialVerts += 8;
        }

        // ── AC outdoor units on upper floors ── Barcelona: removed (Delhi-style facade clutter).
        if (ENABLE_DELHI_DETAILS && edgeLen >= 3) {
          const AC_W = 0.7, AC_H = 0.5, AC_D = 0.3;
          const AC_OFFSET = 0.15; // push out from wall to avoid z-fighting
          const AC_SPACING = 2.2; // metres between AC units along edge
          const maxACs = Math.floor((edgeLen - 1.0) / AC_SPACING);
          for (let fi = 1; fi < numFloors; fi++) {
            if (commercialVerts >= COMMERCIAL_VERT_CAP) break;
            // Deterministic: does this floor-edge combo get ACs? (~60%)
            const floorHash = deterministicIndex(b.id * 7 + ei * 53 + fi * 11);
            if ((floorHash % 100) >= 60) continue;
            // Place multiple ACs along the edge
            const numAC = Math.max(1, Math.min(maxACs, 1 + (floorHash % Math.max(1, maxACs))));
            const startT = 0.1;
            const endT = 0.9;
            for (let ai = 0; ai < numAC; ai++) {
              if (commercialVerts >= COMMERCIAL_VERT_CAP) break;
              // Deterministic per-slot skip (~70% of slots get an AC)
              const acSlotHash = deterministicIndex(b.id * 13 + ei * 37 + fi * 19 + ai * 7);
              if ((acSlotHash % 100) >= 70) continue;
              const t = numAC === 1
                ? 0.5
                : startT + (endT - startT) * (ai / (numAC - 1));
              const acx = p0.x + edx * t;
              const acz = p0.y + edz * t;
              const acY = baseY + fi * floorH + 0.3 + (acSlotHash % 30) / 100; // slight Y variation
              // Push out from wall so it's clearly mounted on the facade
              const ox = acx + nx * AC_OFFSET;
              const oz = acz + nz * AC_OFFSET;
              acUnitGeoms.push(makeBoxGeom(
                ox - ex * AC_W / 2, oz - ez * AC_W / 2,
                ox + ex * AC_W / 2, oz + ez * AC_W / 2,
                nx, nz, AC_D, acY, AC_H
              ));
              commercialVerts += 8;
              // Fan circle on front face of AC unit
              const fanR = Math.min(AC_W, AC_H) * 0.35;
              const fanCx = ox + nx * (AC_D + 0.01); // just in front of box
              const fanCz = oz + nz * (AC_D + 0.01);
              const fanCy = acY + AC_H * 0.5;
              const fan = new THREE.CircleGeometry(fanR, 10);
              // Orient circle to face outward along normal
              // Default CircleGeometry faces +Z; we need it facing (nx, 0, nz)
              const fanAngle = Math.atan2(nx, nz);
              fan.rotateY(fanAngle);
              fan.translate(fanCx, fanCy, fanCz);
              acFanGeoms.push(fan);
              commercialVerts += 12;
            }
          }
        }

        // ── Parapet wall along roof edge ──
        if (b.height >= 6) {
          const PARAPET_H = 0.5;
          const PARAPET_D = 0.15;
          parapetGeoms.push(makeBoxGeom(
            p0.x, p0.y, p1.x, p1.y,
            nx, nz, PARAPET_D, baseY + b.height, PARAPET_H
          ));
          commercialVerts += 8;
        }

        // ── Random decorative bar extrusions (horizontal ledges at random heights) ──
        if (edgeLen >= 4 && numFloors >= 2) {
          const BAR_H = 0.15;     // bar thickness (height)
          const BAR_D = 0.2;      // how far it protrudes
          const BAR_OFFSET = 0.02; // push out from wall
          // 1-3 bars per edge, at random floor levels
          const numBars = 1 + (edgeHash % 3);
          for (let bi = 0; bi < numBars; bi++) {
            if (commercialVerts >= COMMERCIAL_VERT_CAP) break;
            const barHash = deterministicIndex(b.id * 23 + ei * 41 + bi * 67);
            // Pick a floor level (skip ground floor)
            const barFloor = 1 + (barHash % Math.max(1, numFloors - 1));
            const barY = baseY + barFloor * floorH - 0.1;
            // Bar spans part or all of the edge
            const barStartT = (barHash % 20) / 100;          // 0-0.19
            const barEndT = 0.8 + (barHash % 20) / 100;      // 0.8-0.99
            barExtrudeGeoms.push(makeBoxGeom(
              p0.x + edx * barStartT + nx * BAR_OFFSET,
              p0.y + edz * barStartT + nz * BAR_OFFSET,
              p0.x + edx * barEndT + nx * BAR_OFFSET,
              p0.y + edz * barEndT + nz * BAR_OFFSET,
              nx, nz, BAR_D, barY, BAR_H
            ));
            commercialVerts += 8;
          }
        }
      }
    }

    // ── Mall/shop: billboard ad panels + "SHOPPING MALL" sign ── Barcelona: removed (Delhi ads).
    const isMallType = (b.type === 'shop' || b.type === 'mall' || b.type === 'retail');
    if (ENABLE_DELHI_DETAILS && isMallType && b.shapeType !== 'cylinder'
        && b.footprint?.length >= 3 && b.height >= 6
        && mallVerts < MALL_VERT_CAP) {
      const fp = b.footprint;

      // Compute centroid for outward normal
      let mcx = 0, mcz = 0;
      for (const p of fp) { mcx += p.x; mcz += p.y; }
      mcx /= fp.length; mcz /= fp.length;

      // Find the longest edge (for the main sign) and other long edges (for billboards)
      const edges = [];
      for (let ei = 0; ei < fp.length; ei++) {
        const p0 = fp[ei], p1 = fp[(ei + 1) % fp.length];
        const edx = p1.x - p0.x, edz = p1.y - p0.y;
        const edgeLen = Math.hypot(edx, edz);
        if (edgeLen < 3) continue;
        const ex = edx / edgeLen, ez = edz / edgeLen;
        let nx = -ez, nz = ex;
        const mx = (p0.x + p1.x) / 2, mz = (p0.y + p1.y) / 2;
        if ((mx - mcx) * nx + (mz - mcz) * nz < 0) { nx = -nx; nz = -nz; }
        edges.push({ p0, p1, edx, edz, edgeLen, ex, ez, nx, nz, ei });
      }
      edges.sort((a, b2) => b2.edgeLen - a.edgeLen);

      // "SHOPPING MALL" sign on the longest edge, just below roofline
      if (edges.length > 0) {
        const e = edges[0];
        const SIGN_H = 1.5;
        const SIGN_D = 0.08;
        const signY = baseY + b.height - SIGN_H - 0.3; // just below roof
        const signW = Math.min(e.edgeLen * 0.7, 12); // cap at 12m
        const halfW = signW / 2;
        const emx = (e.p0.x + e.p1.x) / 2, emz = (e.p0.y + e.p1.y) / 2;
        // Sign quad: 4 corners (front face only, textured)
        const s0x = emx - e.ex * halfW + e.nx * SIGN_D;
        const s0z = emz - e.ez * halfW + e.nz * SIGN_D;
        const s1x = emx + e.ex * halfW + e.nx * SIGN_D;
        const s1z = emz + e.ez * halfW + e.nz * SIGN_D;
        const signVerts = new Float32Array([
          s0x, signY, s0z,
          s1x, signY, s1z,
          s1x, signY + SIGN_H, s1z,
          s0x, signY + SIGN_H, s0z,
          // Back face
          s1x, signY, s1z,
          s0x, signY, s0z,
          s0x, signY + SIGN_H, s0z,
          s1x, signY + SIGN_H, s1z,
        ]);
        const signUvs = new Float32Array([
          0, 0,  1, 0,  1, 1,  0, 1,
          0, 0,  1, 0,  1, 1,  0, 1,
        ]);
        const signIdx = [0,1,2, 0,2,3, 4,5,6, 4,6,7];
        const signGeo = new THREE.BufferGeometry();
        signGeo.setAttribute('position', new THREE.BufferAttribute(signVerts, 3));
        signGeo.setAttribute('uv', new THREE.BufferAttribute(signUvs, 2));
        signGeo.setIndex(signIdx);
        signGeo.computeVertexNormals();
        mallSignGeoms.push(signGeo);
        mallVerts += 8;
      }

      // Billboard ad panels on other long edges (1-3 billboards)
      const maxBillboards = Math.min(3, edges.length - 1);
      for (let bi = 0; bi < maxBillboards; bi++) {
        if (mallVerts >= MALL_VERT_CAP) break;
        const e = edges[1 + bi];
        if (!e || e.edgeLen < 5) continue;
        const BB_H = 2.5;
        const BB_D = 0.1;
        // Place billboard at mid-height of building
        const bbFloor = 1 + deterministicIndex(b.id * 11 + bi * 37) % Math.max(1, Math.floor(b.height / 3) - 1);
        const bbY = baseY + bbFloor * 3;
        if (bbY + BB_H > baseY + b.height - 2) continue; // don't overlap sign
        const bbW = Math.min(e.edgeLen * 0.6, 8);
        const halfBB = bbW / 2;
        const emx = (e.p0.x + e.p1.x) / 2, emz = (e.p0.y + e.p1.y) / 2;
        const b0x = emx - e.ex * halfBB + e.nx * BB_D;
        const b0z = emz - e.ez * halfBB + e.nz * BB_D;
        const b1x = emx + e.ex * halfBB + e.nx * BB_D;
        const b1z = emz + e.ez * halfBB + e.nz * BB_D;
        const bbVerts = new Float32Array([
          b0x, bbY, b0z,
          b1x, bbY, b1z,
          b1x, bbY + BB_H, b1z,
          b0x, bbY + BB_H, b0z,
          // Back face
          b1x, bbY, b1z,
          b0x, bbY, b0z,
          b0x, bbY + BB_H, b0z,
          b1x, bbY + BB_H, b1z,
        ]);
        const bbUvs = new Float32Array([
          0, 0,  1, 0,  1, 1,  0, 1,
          0, 0,  1, 0,  1, 1,  0, 1,
        ]);
        const bbIdx = [0,1,2, 0,2,3, 4,5,6, 4,6,7];
        const bbGeo = new THREE.BufferGeometry();
        bbGeo.setAttribute('position', new THREE.BufferAttribute(bbVerts, 3));
        bbGeo.setAttribute('uv', new THREE.BufferAttribute(bbUvs, 2));
        bbGeo.setIndex(bbIdx);
        bbGeo.computeVertexNormals();
        // Tag with billboard index for per-billboard texture
        bbGeo.userData = { billboardSeed: deterministicIndex(b.id * 7 + bi * 31) };
        mallBillboardGeoms.push(bbGeo);
        mallVerts += 8;
      }
    }

    // ── Religious 3D details: Hindu-temple shikhara spire/kalasha/flag ──
    // Barcelona: removed — churches here are Gothic/Modernisme, not Hindu temples. The warm
    // terracotta/sandstone masonry + tall massing reads as a Barcelona church; the spire is wrong.
    if (ENABLE_DELHI_DETAILS && category === 'religious' && b.shapeType !== 'cylinder'
        && b.footprint?.length >= 3 && b.height >= 4
        && religiousVerts < RELIGIOUS_VERT_CAP) {
      const fp = b.footprint;
      const roofY = baseY + b.height;

      // Compute footprint bounding box and centroid
      let tmnX = Infinity, tmxX = -Infinity, tmnZ = Infinity, tmxZ = -Infinity;
      let tcx = 0, tcz = 0;
      for (const p of fp) {
        if (p.x < tmnX) tmnX = p.x; if (p.x > tmxX) tmxX = p.x;
        if (p.y < tmnZ) tmnZ = p.y; if (p.y > tmxZ) tmxZ = p.y;
        tcx += p.x; tcz += p.y;
      }
      tcx /= fp.length; tcz /= fp.length;
      const bboxW = tmxX - tmnX, bboxD = tmxZ - tmnZ;
      const minDim = Math.min(bboxW, bboxD);

      // ── Shikhara (tower/spire) on roof — tapered cone/pyramid ──
      // Main central shikhara
      const shikharaR = Math.min(minDim * 0.35, 3.0);
      const shikharaH = Math.max(b.height * 0.6, 4);
      const SHIKHARA_SEGS = 8;
      // Multi-tiered: 3 stacked cones tapering upward (like Nagara style)
      const tiers = 3;
      for (let ti = 0; ti < tiers; ti++) {
        const tFrac = ti / tiers;
        const tFracNext = (ti + 1) / tiers;
        const rBot = shikharaR * (1 - tFrac * 0.7);
        const rTop = shikharaR * (1 - tFracNext * 0.7);
        const tierH = shikharaH / tiers;
        const tierY = roofY + ti * tierH;
        const tier = new THREE.CylinderGeometry(rTop, rBot, tierH, SHIKHARA_SEGS);
        tier.translate(tcx, tierY + tierH / 2, tcz);
        shikharaGeoms.push(tier);
        religiousVerts += SHIKHARA_SEGS * 4;
      }
      // Amalaka disc (flattened torus at top of shikhara)
      const amalakaR = shikharaR * 0.4;
      const amalaka = new THREE.TorusGeometry(amalakaR, amalakaR * 0.25, 6, SHIKHARA_SEGS);
      amalaka.rotateX(Math.PI / 2);
      amalaka.translate(tcx, roofY + shikharaH + 0.1, tcz);
      shikharaGeoms.push(amalaka);
      religiousVerts += 50;

      // Kalasha (finial pot at very top)
      const kalasha = new THREE.SphereGeometry(amalakaR * 0.5, 6, 4);
      kalasha.translate(tcx, roofY + shikharaH + amalakaR * 0.5 + 0.2, tcz);
      shikharaGeoms.push(kalasha);
      religiousVerts += 30;

      // ── Corner mini-shikharas (smaller towers at footprint corners, if building large enough) ──
      if (minDim > 6) {
        const cornerR = shikharaR * 0.35;
        const cornerH = shikharaH * 0.5;
        // Place at up to 4 corners of bounding box
        const corners = [
          { x: tmnX + bboxW * 0.15, z: tmnZ + bboxD * 0.15 },
          { x: tmxX - bboxW * 0.15, z: tmnZ + bboxD * 0.15 },
          { x: tmnX + bboxW * 0.15, z: tmxZ - bboxD * 0.15 },
          { x: tmxX - bboxW * 0.15, z: tmxZ - bboxD * 0.15 },
        ];
        const maxCorners = Math.min(4, 1 + deterministicIndex(b.id + 77) % 4);
        for (let ci = 0; ci < maxCorners; ci++) {
          if (religiousVerts >= RELIGIOUS_VERT_CAP) break;
          if (!pointInFootprint(corners[ci].x, corners[ci].z, fp)) continue;
          const cc = new THREE.CylinderGeometry(cornerR * 0.3, cornerR, cornerH, 6);
          cc.translate(corners[ci].x, roofY + cornerH / 2, corners[ci].z);
          shikharaGeoms.push(cc);
          religiousVerts += 30;
          // Small kalasha on top
          const ck = new THREE.SphereGeometry(cornerR * 0.3, 5, 3);
          ck.translate(corners[ci].x, roofY + cornerH + cornerR * 0.3, corners[ci].z);
          shikharaGeoms.push(ck);
          religiousVerts += 20;
        }
      }

      // ── Stepped plinth/base (2 steps below building) ──
      const STEP_H = 0.3;
      const STEP_OUT = 0.5; // how far each step extends outward
      for (let si = 0; si < 2; si++) {
        if (religiousVerts >= RELIGIOUS_VERT_CAP) break;
        const stepY = baseY - (si + 1) * STEP_H;
        const expand = (si + 1) * STEP_OUT;
        // Simple box around the bounding box
        const sx0 = tmnX - expand, sx1 = tmxX + expand;
        const sz0 = tmnZ - expand, sz1 = tmxZ + expand;
        // 4 walls of the step
        templeBaseGeoms.push(makeBoxGeom(sx0, sz0, sx1, sz0, 0, 0, 0.01, stepY, STEP_H)); // front
        templeBaseGeoms.push(makeBoxGeom(sx0, sz1, sx1, sz1, 0, 0, -0.01, stepY, STEP_H)); // back
        templeBaseGeoms.push(makeBoxGeom(sx0, sz0, sx0, sz1, 0, 0, 0.01, stepY, STEP_H)); // left
        templeBaseGeoms.push(makeBoxGeom(sx1, sz0, sx1, sz1, 0, 0, -0.01, stepY, STEP_H)); // right
        // Top surface
        const topGeo = new THREE.PlaneGeometry(sx1 - sx0, sz1 - sz0);
        topGeo.rotateX(-Math.PI / 2);
        topGeo.translate((sx0 + sx1) / 2, stepY + STEP_H, (sz0 + sz1) / 2);
        templeBaseGeoms.push(topGeo);
        religiousVerts += 36;
      }

      // ── Ornamental horizontal bands around walls ──
      const floorH = 3.0;
      const numFloors = Math.floor(b.height / floorH);
      let bfcx = 0, bfcz = 0;
      for (const p of fp) { bfcx += p.x; bfcz += p.y; }
      bfcx /= fp.length; bfcz /= fp.length;
      for (let ei = 0; ei < fp.length; ei++) {
        if (religiousVerts >= RELIGIOUS_VERT_CAP) break;
        const p0 = fp[ei], p1 = fp[(ei + 1) % fp.length];
        const edx = p1.x - p0.x, edz = p1.y - p0.y;
        const edgeLen = Math.hypot(edx, edz);
        if (edgeLen < 1.5) continue;
        let bnx = -edz / edgeLen, bnz = edx / edgeLen;
        const bmx = (p0.x + p1.x) / 2, bmz = (p0.y + p1.y) / 2;
        if ((bmx - bfcx) * bnx + (bmz - bfcz) * bnz < 0) { bnx = -bnx; bnz = -bnz; }

        // Ornamental bands at each floor level
        for (let fi = 1; fi <= numFloors; fi++) {
          if (religiousVerts >= RELIGIOUS_VERT_CAP) break;
          const bandY = baseY + fi * floorH - 0.2;
          const BAND_H = 0.2;
          const BAND_D = 0.15;
          templeBandGeoms.push(makeBoxGeom(
            p0.x + bnx * 0.01, p0.y + bnz * 0.01,
            p1.x + bnx * 0.01, p1.y + bnz * 0.01,
            bnx, bnz, BAND_D, bandY, BAND_H
          ));
          religiousVerts += 8;
        }
      }

      // ── Saffron/orange triangular flag on top of main shikhara ──
      const flagPoleH = 2.0;
      const poleR = 0.04;
      const poleBaseY = roofY + shikharaH + amalakaR * 0.5 + 0.2;
      // Flag pole (thin cylinder)
      const pole = new THREE.CylinderGeometry(poleR, poleR, flagPoleH, 4);
      pole.translate(tcx, poleBaseY + flagPoleH / 2, tcz);
      flagPoleGeoms.push(pole);
      religiousVerts += 12;

      // Triangular flag (two triangles forming a pennant)
      const FLAG_W = 1.2;
      const FLAG_H = 0.8;
      const flagTopY = poleBaseY + flagPoleH;
      const flagVerts = new Float32Array([
        // Triangle 1 (front)
        tcx, flagTopY, tcz,                          // top of pole
        tcx + FLAG_W, flagTopY - FLAG_H * 0.5, tcz,  // tip
        tcx, flagTopY - FLAG_H, tcz,                  // bottom of pole
        // Triangle 2 (back — same but flipped normal)
        tcx, flagTopY, tcz,
        tcx, flagTopY - FLAG_H, tcz,
        tcx + FLAG_W, flagTopY - FLAG_H * 0.5, tcz,
      ]);
      const flagGeo = new THREE.BufferGeometry();
      flagGeo.setAttribute('position', new THREE.BufferAttribute(flagVerts, 3));
      flagGeo.computeVertexNormals();
      flagGeoms.push(flagGeo);
      religiousVerts += 6;
    }

    // ── Barcelona CHURCH: bell tower (campanile) + slate pyramidal spire + cross ──
    // Replaces the Hindu-temple shikhara. Reuses the religious merge plumbing: shikharaGeoms →
    // warm-stone tower, flagPoleGeoms → dark slate (belfry + spire), templeBandGeoms → light stone cross.
    if (category === 'religious' && b.shapeType !== 'cylinder'
        && b.footprint?.length >= 3 && b.height >= 4
        && religiousVerts < RELIGIOUS_VERT_CAP) {
      const fp = b.footprint;
      let cmnX = Infinity, cmxX = -Infinity, cmnZ = Infinity, cmxZ = -Infinity;
      for (const p of fp) {
        if (p.x < cmnX) cmnX = p.x; if (p.x > cmxX) cmxX = p.x;
        if (p.y < cmnZ) cmnZ = p.y; if (p.y > cmxZ) cmxZ = p.y;
      }
      const bw = cmxX - cmnX, bd = cmxZ - cmnZ;
      const minDim = Math.min(bw, bd);
      const towerW = Math.max(2.5, Math.min(minDim * 0.45, 5.5));
      // Place the tower at a deterministic corner (varies per church), inset from the edge.
      const corners = [
        { x: cmnX + towerW * 0.6, z: cmnZ + towerW * 0.6 },
        { x: cmxX - towerW * 0.6, z: cmnZ + towerW * 0.6 },
        { x: cmnX + towerW * 0.6, z: cmxZ - towerW * 0.6 },
        { x: cmxX - towerW * 0.6, z: cmxZ - towerW * 0.6 },
      ];
      const corner = corners[deterministicIndex(b.id + 91) % 4];
      const twx = corner.x, twz = corner.z;
      // Tower rises ~0.8× the body height above the roof.
      const towerExtra = Math.max(b.height * 0.8, 6);
      const towerTotalH = b.height + towerExtra;
      const towerTopY = baseY + towerTotalH;
      const tower = new THREE.BoxGeometry(towerW, towerTotalH, towerW);
      tower.translate(twx, baseY + towerTotalH / 2, twz);
      shikharaGeoms.push(tower);
      religiousVerts += 24;
      // Belfry band (dark, slightly proud) near the top — reads as the bell openings.
      const belfryH = Math.min(towerExtra * 0.28, 1.8);
      const belfry = new THREE.BoxGeometry(towerW * 1.06, belfryH, towerW * 1.06);
      belfry.translate(twx, towerTopY - belfryH * 0.9, twz);
      flagPoleGeoms.push(belfry);
      religiousVerts += 24;
      // Slate pyramidal spire (4-sided pyramid aligned to the tower).
      const spireH = towerW * 1.6;
      const spire = new THREE.ConeGeometry(towerW * 0.74, spireH, 4);
      spire.rotateY(Math.PI / 4);
      spire.translate(twx, towerTopY + spireH / 2, twz);
      flagPoleGeoms.push(spire);
      religiousVerts += 16;
      // Cross at the apex (light stone).
      const apexY = towerTopY + spireH;
      const crossV = new THREE.BoxGeometry(0.18, 1.8, 0.18); crossV.translate(twx, apexY + 0.9, twz);
      const crossH = new THREE.BoxGeometry(1.0, 0.18, 0.18); crossH.translate(twx, apexY + 1.2, twz);
      templeBandGeoms.push(crossV, crossH);
      religiousVerts += 24;
    }

    // ── Residential boundary wall (full perimeter) + gate on road-facing edge ──
    // Barcelona: removed — Eixample blocks front the street directly (no compound walls).
    if (ENABLE_DELHI_DETAILS && category === 'residential' && b.shapeType !== 'cylinder'
        && b.footprint?.length >= 3 && boundaryVerts < BOUNDARY_VERT_CAP) {
      const fp = b.footprint;
      const WALL_H = 2.2;
      const WALL_THICK = 0.15;
      const GATE_W = 3.5;
      const PILLAR_W = 0.35;
      const PILLAR_H = 2.8;
      const GATE_BAR_W = 0.03;
      const GATE_H = 2.0;

      // Compute centroid for outward normals
      let wcx = 0, wcz = 0;
      for (const p of fp) { wcx += p.x; wcz += p.y; }
      wcx /= fp.length; wcz /= fp.length;

      // Find road-facing edge index
      let bestEdgeIdx = -1;
      const nearest = findNearestRoadSegment(roads, cx, cy);
      if (nearest && nearest.distance < 25) {
        let bestEdgeDist = Infinity;
        for (let ei = 0; ei < fp.length; ei++) {
          const pp0 = fp[ei], pp1 = fp[(ei + 1) % fp.length];
          const emx = (pp0.x + pp1.x) / 2, emz = (pp0.y + pp1.y) / 2;
          if (Math.hypot(pp1.x - pp0.x, pp1.y - pp0.y) < 3) continue;
          const roadPts = nearest.road.points || [];
          let minDSq = Infinity;
          for (let ri = 0; ri < roadPts.length - 1; ri++) {
            const ra = roadPts[ri], rb = roadPts[ri + 1];
            const rdx = rb.x - ra.x, rdz = rb.y - ra.y;
            const rlenSq = rdx * rdx + rdz * rdz;
            let t = rlenSq > 0 ? ((emx - ra.x) * rdx + (emz - ra.y) * rdz) / rlenSq : 0;
            t = Math.max(0, Math.min(1, t));
            const qx = ra.x + t * rdx, qz = ra.y + t * rdz;
            const dSq = (emx - qx) ** 2 + (emz - qz) ** 2;
            if (dSq < minDSq) minDSq = dSq;
          }
          if (minDSq < bestEdgeDist) { bestEdgeDist = minDSq; bestEdgeIdx = ei; }
        }
        if (bestEdgeDist > 20 * 20) bestEdgeIdx = -1;
      }

      // Build walls on ALL edges; gate only on road-facing edge
      for (let ei = 0; ei < fp.length; ei++) {
        if (boundaryVerts >= BOUNDARY_VERT_CAP) break;
        const ep0 = fp[ei], ep1 = fp[(ei + 1) % fp.length];
        const edx = ep1.x - ep0.x, edz = ep1.y - ep0.y;
        const elen = Math.hypot(edx, edz);
        if (elen < 1) continue;
        const eex = edx / elen, eez = edz / elen;
        let enx = -eez, enz = eex;
        const emx = (ep0.x + ep1.x) / 2, emz = (ep0.y + ep1.y) / 2;
        if ((emx - wcx) * enx + (emz - wcz) * enz < 0) { enx = -enx; enz = -enz; }

        const isGateEdge = (ei === bestEdgeIdx && elen > GATE_W + PILLAR_W * 2 + 1);

        if (!isGateEdge) {
          // Simple solid wall along this edge — offset outward to avoid z-fighting with building wall
          const WALL_OFFSET = 0.3;
          const ox0 = ep0.x + enx * WALL_OFFSET, oz0 = ep0.y + enz * WALL_OFFSET;
          const ox1 = ep1.x + enx * WALL_OFFSET, oz1 = ep1.y + enz * WALL_OFFSET;
          boundaryWallGeoms.push(makeBoxGeom(ox0, oz0, ox1, oz1, enx, enz, WALL_THICK, baseY, WALL_H));
          boundaryVerts += 8;
        } else {
          // Road-facing edge: wall with gate opening in center
          const gateCT = 0.5;
          const gateHalfT = (GATE_W / 2) / elen;
          const pillarT = PILLAR_W / elen;

          // Left wall segment
          const glt = gateCT - gateHalfT - pillarT;
          if (glt > 0.02) {
            const a = { x: ep0.x, y: ep0.y };
            const b2 = { x: ep0.x + edx * glt, y: ep0.y + edz * glt };
            boundaryWallGeoms.push(makeBoxGeom(a.x, a.y, b2.x, b2.y, enx, enz, WALL_THICK, baseY, WALL_H));
            boundaryVerts += 8;
          }
          // Right wall segment
          const grt = gateCT + gateHalfT + pillarT;
          if (grt < 0.98) {
            const a = { x: ep0.x + edx * grt, y: ep0.y + edz * grt };
            boundaryWallGeoms.push(makeBoxGeom(a.x, a.y, ep1.x, ep1.y, enx, enz, WALL_THICK, baseY, WALL_H));
            boundaryVerts += 8;
          }
          // Gate pillars
          const plt0 = gateCT - gateHalfT - pillarT, plt1 = gateCT - gateHalfT;
          boundaryWallGeoms.push(makeBoxGeom(ep0.x+edx*plt0, ep0.y+edz*plt0, ep0.x+edx*plt1, ep0.y+edz*plt1, enx, enz, WALL_THICK+0.05, baseY, PILLAR_H));
          boundaryVerts += 8;
          const prt0 = gateCT + gateHalfT, prt1 = gateCT + gateHalfT + pillarT;
          boundaryWallGeoms.push(makeBoxGeom(ep0.x+edx*prt0, ep0.y+edz*prt0, ep0.x+edx*prt1, ep0.y+edz*prt1, enx, enz, WALL_THICK+0.05, baseY, PILLAR_H));
          boundaryVerts += 8;

          // Gate bars
          const gx0 = ep0.x + edx * plt1, gz0 = ep0.y + edz * plt1;
          const gx1 = ep0.x + edx * prt0, gz1 = ep0.y + edz * prt0;
          const hw = GATE_BAR_W / 2;
          // Top + middle horizontal bars
          gateGeoms.push(makeBoxGeom(gx0, gz0, gx1, gz1, enx, enz, hw*3, baseY + GATE_H, hw*3));
          gateGeoms.push(makeBoxGeom(gx0, gz0, gx1, gz1, enx, enz, hw*2, baseY + GATE_H*0.5, hw*2));
          // Vertical bars
          const numBars = Math.max(3, Math.floor(GATE_W / 0.12));
          for (let bi = 0; bi <= numBars; bi++) {
            if (boundaryVerts >= BOUNDARY_VERT_CAP) break;
            const bt = bi / numBars;
            const bpx = gx0 + (gx1-gx0)*bt, bpz = gz0 + (gz1-gz0)*bt;
            gateGeoms.push(makeBoxGeom(bpx-eex*hw, bpz-eez*hw, bpx+eex*hw, bpz+eez*hw, enx, enz, hw*2, baseY, GATE_H));
            boundaryVerts += 8;
          }
        }
      }
    }
  }

  const meshes = [];
  const shadowsOn = !!CONFIG.ENABLE_SHADOWS;

  for (const [material, entry] of byMaterial.entries()) {
    if (entry.geometries.length === 0) {
      entry.toDispose.forEach((g) => g.dispose());
      continue;
    }
    logGeometryAttributes(entry.geometries, 'Pre-merge');
    let merged = null;
    try {
      merged = mergeGeometries(entry.geometries, false);
    } catch (err) {
      console.error('mergeGeometries failed:', err);
      entry.geometries.forEach((g) => g.dispose());
      entry.toDispose.forEach((g) => g.dispose());
      continue;
    }
    entry.geometries.forEach((g) => g.dispose());
    entry.toDispose.forEach((g) => g.dispose());

    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = shadowsOn;
    mesh.receiveShadow = shadowsOn;
    mesh.frustumCulled = true;
    mesh.userData = {
      buildings: metaByMaterial.get(material) || [],
      sharedMaterial: true,
    };
    meshes.push(mesh);
  }

  // ── Roof meshes — merged per material for category color variation ─────────
  for (const [roofMat, rEntry] of roofByMaterial.entries()) {
    if (rEntry.geometries.length === 0) {
      rEntry.toDispose.forEach((g) => g.dispose());
      continue;
    }
    let mergedRoof = null;
    try {
      mergedRoof = mergeGeometries(rEntry.geometries, false);
    } catch (err) {
      console.warn('mergeGeometries failed (roofs):', err);
    }
    rEntry.geometries.forEach((g) => g.dispose());
    rEntry.toDispose.forEach((g) => g.dispose());
    if (mergedRoof) {
      const roofMesh = new THREE.Mesh(mergedRoof, roofMat);
      roofMesh.castShadow = shadowsOn;
      roofMesh.receiveShadow = shadowsOn;
      roofMesh.frustumCulled = true;
      roofMesh.userData.sharedMaterial = true;
      meshes.push(roofMesh);
    }
  }

  // ── Water tanks (InstancedMesh) — white plastic Sintex-style ────────────────
  if (tankInstances.length > 0) {
    // Build compound tank: tapered body + lid cap + 3 horizontal ridge rings
    const bodyH = 1.4;
    const body = new THREE.CylinderGeometry(0.7, 0.85, bodyH, 10);
    body.translate(0, bodyH / 2, 0);
    // Flat lid on top
    const lid = new THREE.CylinderGeometry(0.45, 0.7, 0.15, 10);
    lid.translate(0, bodyH + 0.075, 0);
    // Small cap nub on lid
    const cap = new THREE.CylinderGeometry(0.22, 0.25, 0.1, 8);
    cap.translate(0, bodyH + 0.15 + 0.05, 0);
    // Horizontal ridge rings (3 bands around body)
    const ridgeParts = [];
    for (let ri = 0; ri < 3; ri++) {
      const ry = 0.3 + ri * 0.4;
      const rFrac = ry / bodyH;
      const rRadius = 0.85 + (0.7 - 0.85) * rFrac; // interpolate taper
      const ridge = new THREE.TorusGeometry(rRadius + 0.02, 0.025, 4, 10);
      ridge.rotateX(Math.PI / 2);
      ridge.translate(0, ry, 0);
      ridgeParts.push(ridge);
    }
    const tankGeo = mergeGeometries([body, lid, cap, ...ridgeParts], false);
    if (!_tankMat) _tankMat = new THREE.MeshLambertMaterial({ color: 0xE8E4DC });
    const tankMesh = new THREE.InstancedMesh(tankGeo, _tankMat, tankInstances.length);
    const _d = new THREE.Object3D();
    for (let i = 0; i < tankInstances.length; i++) {
      const t = tankInstances[i];
      _d.position.set(t.x, t.y, t.z);
      const sy = 0.8 + (deterministicIndex(i * 11 + 77) % 40) / 100;
      _d.scale.set(t.scale, sy, t.scale);
      _d.rotation.set(0, deterministicIndex(i * 3 + 60) % 628 / 100, 0);
      _d.updateMatrix();
      tankMesh.setMatrixAt(i, _d.matrix);
    }
    tankMesh.instanceMatrix.needsUpdate = true;
    tankMesh.frustumCulled = true;
    meshes.push(tankMesh);
  }

  // ── Pipes (InstancedMesh) ──────────────────────────────────────────────────
  if (pipeInstances.length > 0) {
    const pipeGeo = new THREE.CylinderGeometry(1, 1, 1, 5); // unit radius/height, scaled per instance
    pipeGeo.translate(0, 0.5, 0); // origin at base
    if (!_pipeMat) _pipeMat = new THREE.MeshLambertMaterial({ color: 0x6E6E6E });
    const pipeMesh = new THREE.InstancedMesh(pipeGeo, _pipeMat, pipeInstances.length);
    const _d = new THREE.Object3D();
    for (let i = 0; i < pipeInstances.length; i++) {
      const p = pipeInstances[i];
      _d.position.set(p.x, p.y, p.z);
      _d.scale.set(p.radius, p.height, p.radius);
      _d.rotation.set(0, 0, 0);
      _d.updateMatrix();
      pipeMesh.setMatrixAt(i, _d.matrix);
    }
    pipeMesh.instanceMatrix.needsUpdate = true;
    pipeMesh.frustumCulled = true;
    meshes.push(pipeMesh);
  }

  // ── Merged building details: combine similar-material geometry via vertex colors ──
  // Group 1: Concrete details (slabs, parapets, pillars, ledges) → 1 mesh with shadows
  {
    const concreteGroups = [
      { geoms: balconySlabGeoms, color: 0xB8B4AE },
      { geoms: parapetGeoms,     color: 0x9A9590 },
      { geoms: pillarGeoms,      color: 0xC0BCB6 },
      { geoms: barExtrudeGeoms,  color: 0xA8A4A0 },
    ].filter(g => g.geoms.length > 0);
    const m = mergeColoredGroups(concreteGroups, shadowsOn, true);
    if (m) meshes.push(m);
  }

  // Group 2: Dark metal details (railings, gates, AC fans, flag poles) → 1 mesh, no shadow
  {
    const metalGroups = [
      { geoms: balconyRailGeoms, color: 0x3A3835 },
      { geoms: gateGeoms,       color: 0x2E2C2A },
      { geoms: acFanGeoms,      color: 0x2A3A4A },
      { geoms: flagPoleGeoms,   color: 0x5A5550 },
    ].filter(g => g.geoms.length > 0);
    const m = mergeColoredGroups(metalGroups, shadowsOn, false);
    if (m) meshes.push(m);
  }

  // Group 3: Commercial misc (AC units, awnings, signboards) → 1 mesh, no shadow
  {
    const miscGroups = [
      { geoms: acUnitGeoms,    color: 0xD8D4CE },
      { geoms: awningGeoms,    color: 0x3A5060 },
      { geoms: signboardGeoms, color: 0x2A5070 },
    ].filter(g => g.geoms.length > 0);
    const m = mergeColoredGroups(miscGroups, shadowsOn, false);
    if (m) meshes.push(m);
  }

  // Group 4: Temple details (base, bands) → 1 mesh, shadows on base
  {
    const templeGroups = [
      { geoms: templeBaseGeoms, color: 0xC8A870 },
      { geoms: templeBandGeoms, color: 0xD4B870 },
    ].filter(g => g.geoms.length > 0);
    const m = mergeColoredGroups(templeGroups, shadowsOn, true);
    if (m) meshes.push(m);
  }

  // Boundary walls — kept separate (uses brick texture map)
  if (boundaryWallGeoms.length > 0) {
    try {
      const merged = mergeGeometries(boundaryWallGeoms, false);
      boundaryWallGeoms.forEach(g => g.dispose());
      if (merged) {
        if (!_wallMat) _wallMat = new THREE.MeshLambertMaterial({ color: 0xA8A49E, map: getBrickWallTexture() });
        const wallMesh = new THREE.Mesh(merged, _wallMat);
        wallMesh.castShadow = shadowsOn;
        wallMesh.receiveShadow = shadowsOn;
        wallMesh.frustumCulled = true;
        meshes.push(wallMesh);
      }
    } catch (e) {
      boundaryWallGeoms.forEach(g => g.dispose());
    }
  }

  // Mall signs — kept separate (Phong + emissive)
  if (mallSignGeoms.length > 0) {
    const signMat = new THREE.MeshPhongMaterial({
      map: getMallSignTexture(),
      emissive: 0xFF1111,
      emissiveIntensity: 0.3,
      specular: 0x220000,
      shininess: 20,
      side: THREE.DoubleSide,
    });
    try {
      const merged = mergeGeometries(mallSignGeoms, false);
      mallSignGeoms.forEach(g => g.dispose());
      if (merged) {
        const signMesh = new THREE.Mesh(merged, signMat);
        signMesh.castShadow = false;
        signMesh.receiveShadow = false;
        signMesh.frustumCulled = true;
        signMesh.userData.isMallSign = true;
        meshes.push(signMesh);
      }
    } catch (e) { mallSignGeoms.forEach(g => g.dispose()); }
  }

  // Mall billboards — kept separate (each has unique texture)
  if (mallBillboardGeoms.length > 0) {
    for (const bbGeo of mallBillboardGeoms) {
      const seed = bbGeo.userData?.billboardSeed || 0;
      const bbMat = new THREE.MeshLambertMaterial({
        map: getBillboardTexture(seed),
        side: THREE.DoubleSide,
      });
      const bbMesh = new THREE.Mesh(bbGeo, bbMat);
      bbMesh.castShadow = false;
      bbMesh.receiveShadow = false;
      bbMesh.frustumCulled = true;
      meshes.push(bbMesh);
    }
  }

  // Temple shikhara — kept separate (Phong material)
  if (shikharaGeoms.length > 0) {
    try {
      const merged = mergeGeometries(shikharaGeoms, false);
      shikharaGeoms.forEach(g => g.dispose());
      if (merged) {
        if (!_shikharaMat) _shikharaMat = new THREE.MeshLambertMaterial({ color: 0xCAB695 }); // warm sandstone church tower
        const shikharaMesh = new THREE.Mesh(merged, _shikharaMat);
        shikharaMesh.castShadow = shadowsOn;
        shikharaMesh.receiveShadow = shadowsOn;
        shikharaMesh.frustumCulled = true;
        meshes.push(shikharaMesh);
      }
    } catch (e) { shikharaGeoms.forEach(g => g.dispose()); }
  }

  // Saffron flags — kept separate (DoubleSide + unique color)
  if (flagGeoms.length > 0) {
    try {
      const merged = mergeGeometries(flagGeoms, false);
      flagGeoms.forEach(g => g.dispose());
      if (merged) {
        if (!_flagMat) _flagMat = new THREE.MeshLambertMaterial({ color: 0xFF6600, side: THREE.DoubleSide });
        const flagMesh = new THREE.Mesh(merged, _flagMat);
        flagMesh.castShadow = false;
        flagMesh.receiveShadow = false;
        flagMesh.frustumCulled = true;
        meshes.push(flagMesh);
      }
    } catch (e) { flagGeoms.forEach(g => g.dispose()); }
  }

  return meshes;
}

/**
 * Create building meshes for a tile (API for tileManager: returns array of meshes).
 * Accepts tileData { buildings, roads } so category can be derived from nearest road.
 * @param {object} tileData - { buildings, roads? }
 * @param {{ getElevationAt?: (lat: number, lon: number) => number }} [options]
 * @returns {THREE.Mesh[]}
 */
export function createBuildingMeshes(tileData, options) {
  const buildings = tileData?.buildings;
  if (!buildings || buildings.length === 0) return [];
  return renderTileBuildings(tileData || { buildings, roads: tileData?.roads || [] }, options || {});
}

// ── LOD building renderer: simple extruded boxes for distant buildings ────────

let _lodBuildingMat = null;
function getLODBuildingMaterial() {
  if (_lodBuildingMat) return _lodBuildingMat;
  _lodBuildingMat = new THREE.MeshLambertMaterial({
    color: 0xC8C4BE,
    vertexColors: true,
  });
  return _lodBuildingMat;
}

/**
 * Create simplified LOD building mesh (flat-colored boxes from footprint AABB).
 * Used for 300-800m distance range where full detail isn't visible.
 * @param {object[]} buildings - Array of { footprint, height, levels, type }
 * @param {Function} [getWorldElevation] - (wx, wz) => elevation in meters
 * @returns {THREE.Mesh|null}
 */
export function renderLODBuildings(buildings, getWorldElevation) {
  if (!buildings || buildings.length === 0) return null;

  const positions = [];
  const normals = [];
  const colors = [];
  let vertCount = 0;
  const MAX_LOD_VERTS = 18000;

  // Shared color palette for LOD buildings (muted urban tones)
  const LOD_COLORS = [
    [0.78, 0.76, 0.72], // warm grey
    [0.74, 0.73, 0.70], // cool grey
    [0.80, 0.78, 0.74], // light beige
    [0.72, 0.70, 0.68], // medium grey
    [0.76, 0.74, 0.70], // taupe
  ];

  for (let bi = 0; bi < buildings.length; bi++) {
    if (vertCount >= MAX_LOD_VERTS) break;
    const b = buildings[bi];
    const fp = b.footprint;
    if (!fp || fp.length < 3) continue;

    const height = b.height || (b.levels || 2) * 3;
    if (height < 2) continue;

    // Compute AABB of footprint
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of fp) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minZ) minZ = p.y;
      if (p.y > maxZ) maxZ = p.y;
    }
    const w = maxX - minX;
    const d = maxZ - minZ;
    if (w < 1 || d < 1) continue;

    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const rawBaseY = getWorldElevation ? getWorldElevation(cx, cz) : NaN;
    // guard: NaN/absent elevation (G-06 water bug in baked grids). Fall back to the spawn-normalized ground
    // floor (≈ -offset), NOT absolute 0 — 0 is the spawn-height plane and floats port/hill buildings ~30 m up.
    const baseY = Number.isFinite(rawBaseY) ? rawBaseY : -(getWorldElevationOffset() ?? 0);
    const topY = baseY + height;
    const hw = w / 2, hd = d / 2;

    // Color with slight variation per building
    const ci = bi % LOD_COLORS.length;
    const variation = 0.95 + (((bi * 127) & 255) / 255) * 0.1;
    const cr = LOD_COLORS[ci][0] * variation;
    const cg = LOD_COLORS[ci][1] * variation;
    const cb = LOD_COLORS[ci][2] * variation;

    // 4 wall quads + 1 top cap = 30 vertices (5 quads × 2 triangles × 3 verts)
    // Front wall (facing +Z)
    addQuad(positions, normals, colors,
      cx - hw, baseY, cz + hd,  cx + hw, baseY, cz + hd,
      cx + hw, topY, cz + hd,   cx - hw, topY, cz + hd,
      0, 0, 1, cr, cg, cb);
    // Back wall (facing -Z)
    addQuad(positions, normals, colors,
      cx + hw, baseY, cz - hd,  cx - hw, baseY, cz - hd,
      cx - hw, topY, cz - hd,   cx + hw, topY, cz - hd,
      0, 0, -1, cr, cg, cb);
    // Left wall (facing -X)
    addQuad(positions, normals, colors,
      cx - hw, baseY, cz - hd,  cx - hw, baseY, cz + hd,
      cx - hw, topY, cz + hd,   cx - hw, topY, cz - hd,
      -1, 0, 0, cr * 0.9, cg * 0.9, cb * 0.9);
    // Right wall (facing +X)
    addQuad(positions, normals, colors,
      cx + hw, baseY, cz + hd,  cx + hw, baseY, cz - hd,
      cx + hw, topY, cz - hd,   cx + hw, topY, cz + hd,
      1, 0, 0, cr * 0.9, cg * 0.9, cb * 0.9);
    // Top cap
    addQuad(positions, normals, colors,
      cx - hw, topY, cz - hd,  cx - hw, topY, cz + hd,
      cx + hw, topY, cz + hd,  cx + hw, topY, cz - hd,
      0, 1, 0, cr * 1.05, cg * 1.05, cb * 1.05);

    vertCount += 30;
  }

  if (positions.length === 0) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

  const mesh = new THREE.Mesh(geo, getLODBuildingMaterial());
  mesh.frustumCulled = true;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.userData.isLODBuilding = true;
  mesh.userData.sharedMaterial = true;
  return mesh;
}

/** Push 2 triangles (6 vertices) forming a quad into position/normal/color arrays. */
function addQuad(pos, nrm, col,
  x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3,
  nx, ny, nz, cr, cg, cb) {
  // Triangle 1: v0, v1, v2
  pos.push(x0, y0, z0, x1, y1, z1, x2, y2, z2);
  // Triangle 2: v0, v2, v3
  pos.push(x0, y0, z0, x2, y2, z2, x3, y3, z3);
  for (let i = 0; i < 6; i++) {
    nrm.push(nx, ny, nz);
    col.push(cr, cg, cb);
  }
}
