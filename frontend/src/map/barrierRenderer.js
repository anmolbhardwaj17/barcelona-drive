/**
 * Barrier renderer v3.
 *
 * Geometry contract:
 *   • Two offset polylines (inner / outer) define wall faces — visible physical thickness.
 *   • Miter joins on smooth curves; bevel fallback on sharp corners.
 *     A bevel NEVER removes wall segments — it adds fill geometry instead.
 *   • Road crossings split the segment at the exact intersection t-value.
 *     Only a GATE_HALF_WIDTH window is removed; the rest of the segment is kept.
 *   • Gate pillars (box) are emitted at each gate boundary.
 *   • flatShading:true → crisp wall faces without computing vertex normals (color-only types).
 *
 * Textured wall types (wall, compound_wall, city_wall, retaining_wall):
 *   • wall_01.jpg loaded once from /textures/wall/wall_01.jpg, shared across all tiles.
 *   • UV.x = running wall distance / 4.0 m   (one texture repeat per 4 m along wall)
 *   • UV.y = world Y / 2.0 m                 (one texture repeat per 2 m of height)
 *   • computeVertexNormals() called on merged geometry (smooth shading with texture).
 *   • Depth write enabled — decals placed at +0.01 offset will render cleanly on top.
 */
import * as THREE from 'three';
import { getKTX2TextureSync } from '../loaders.js';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';

// ─── Config ───────────────────────────────────────────────────────────────────
const BARRIER_CONFIGS = {
  wall:           { thickness: 0.60, color: 0xC8B89A, roughness: 0.90, minHeight: 1.0 },  // warm sandstone; Barcelona property walls 1-2m
  city_wall:      { thickness: 1.50, color: 0xB5A08A, roughness: 0.95, minHeight: 5.0 },  // aged stone
  retaining_wall: { thickness: 0.80, color: 0xA09585, roughness: 0.90 },                   // concrete grey-brown; no minHeight — full OSM height used
  fence:          { thickness: 0.10, color: 0x6A6A68, roughness: 0.70, minHeight: 2.5 },  // dark iron
  hedge:          { thickness: 0.80, color: 0x4A7238, roughness: 0.95 },                   // dark foliage green
  guard_rail:     { thickness: 0.20, color: 0x8A8580, roughness: 0.60 },                   // weathered metal
  jersey_barrier: { thickness: 0.60, color: 0xB0AAA0, roughness: 0.80 },                   // pale concrete
  kerb:           { thickness: 0.25, color: 0x9A9590, roughness: 0.80 },                   // kerb stone grey
  compound_wall:  { thickness: 1.00, color: 0xD4C0A0, roughness: 0.85, minHeight: 1.5 },  // campus perimeter; Delhi default was 3.5m
};

/** Wall types that receive the base wall texture (UV-mapped geometry). */
const TEXTURED_WALL_TYPES = new Set(['city_wall', 'retaining_wall', 'wall']);

/** Wall types rendered as Indian precast compound wall (pillars + panels + wire supports). */
const PRECAST_WALL_TYPES = new Set(['compound_wall']);

// ─── Precast compound wall constants ──────────────────────────────────────────
const PRECAST_PILLAR_SPACING = 3.0;   // metres between pillar centres
const PRECAST_PILLAR_W       = 0.40;  // pillar width (across wall)
const PRECAST_PILLAR_D       = 0.40;  // pillar depth (along wall)
const PRECAST_PANEL_THICK    = 0.18;  // concrete panel thickness
const PRECAST_PILLAR_RISE    = 0.15;  // pillar extends above panel top
const PRECAST_WIRE_LEN       = 0.45;  // angled wire support length
const PRECAST_WIRE_THICK     = 0.03;  // wire support bar thickness
const PRECAST_WIRE_ANGLE     = Math.PI / 4; // 45° outward lean
const PRECAST_PANEL_COLOR    = 0xC0B8A8; // concrete block grey-beige
const PRECAST_PILLAR_COLOR   = 0xA8A098; // slightly darker concrete
const PRECAST_WIRE_COLOR     = 0x505050; // dark metal
// Gate pillar constants (larger stone pillars flanking gate openings)
const GATE_PILLAR_W          = 0.70;  // gate pillar width (across wall)
const GATE_PILLAR_D          = 0.70;  // gate pillar depth (along wall)
const GATE_PILLAR_RISE       = 0.8;   // how much taller than wall
const GATE_PILLAR_CAP_H      = 0.15;  // cap slab height on top of pillar
const GATE_PILLAR_CAP_OVERHANG = 0.08; // cap extends past pillar face
const GATE_FINIAL_RADIUS     = 0.22;  // ball finial radius
const GATE_FINIAL_SEGMENTS   = 6;     // low-poly sphere segments

const MITER_LIMIT     = 4.0;  // max miter scale before bevel fallback (no segment removal)
const GATE_HALF_WIDTH = 4.0;  // half-width of gate opening (8 m total)
const PILLAR_DEPTH    = 1.0;  // pillar extent along wall direction (m)
const PILLAR_SCALE    = 2.2;  // pillar thickness relative to wall thickness

// ─── Gate leaf constants ──────────────────────────────────────────────────────
const GATE_COLOR      = 0x1A1A1A;  // near-black iron
const GATE_OPEN_ANGLE = Math.PI * 0.6;  // ~108° swing open
const GATE_BAR_RADIUS = 0.035; // vertical bar thickness (half-extent)
const GATE_FRAME_T    = 0.08;  // frame tube thickness
const GATE_RAIL_COUNT = 4;     // horizontal rails between top & bottom frame
const GATE_BAR_COUNT  = 14;    // vertical bars per leaf (dense, like reference)
const GATE_ARCH_RISE  = 0.6;   // how much the arch rises above wall height (m)
const GATE_MIN_HEIGHT = 3.5;   // minimum gate height (m)

/** Texture tiling: 1 repeat per N metres of wall surface. */
const WALL_UV_U = 4.0;  // metres per horizontal texture repeat
const WALL_UV_V = 2.0;  // metres per vertical texture repeat

// ─── Shared wall texture + material (one instance, loaded once) ───────────────
let _wallMat = null;

function getWallTexMat() {
  if (_wallMat) return _wallMat;

  // Create the material immediately with a warm fallback color.
  // The texture is applied asynchronously and triggers needsUpdate.
  _wallMat = new THREE.MeshStandardMaterial({
    color:     0xd4c4a0,  // sandy fallback while texture loads
    roughness: 0.7,
    metalness: 0.05,
    // depthWrite: true (default) — decals offset by +0.01 will render on top without z-fighting
    // flatShading: false (default) — smooth normals computed per vertex for texture shading
  });
  _wallMat.userData.sharedMaterial = true;

  // KTX2 (v3 P3-GATE-01). Assigned here rather than in a load callback: giving a material a `map`
  // it was not built with changes the defines and forces a mid-drive recompile (G-53). The handle
  // is valid immediately; only its pixels arrive later.
  _wallMat.map = getKTX2TextureSync('/textures/wall/wall_01.ktx2', { srgb: true, tiling: true, aniso: 8 });

  return _wallMat;
}

// ─── Shared color materials (flat-shaded, for non-textured types) ─────────────
const sharedMats = {};
function getMat(type) {
  if (sharedMats[type]) return sharedMats[type];
  const cfg = BARRIER_CONFIGS[type] || BARRIER_CONFIGS.wall;
  const m = new THREE.MeshStandardMaterial({
    color: cfg.color, roughness: cfg.roughness, metalness: 0, flatShading: true,
  });
  m.userData.sharedMaterial = true;
  sharedMats[type] = m;
  return m;
}

// ─── Geometry helpers: color-only (no UV) ────────────────────────────────────
function quad(pos, idx, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) {
  const b = pos.length / 3;
  pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
  idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
}
function tri(pos, idx, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const b = pos.length / 3;
  pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  idx.push(b, b + 1, b + 2);
}

function slab(pos, idx, x0, z0, ox0, oz0, x1, z1, ox1, oz1, yB, yT, capStart, capEnd) {
  const ouX0 = x0 + ox0, ouZ0 = z0 + oz0;
  const ouX1 = x1 + ox1, ouZ1 = z1 + oz1;
  const inX0 = x0 - ox0, inZ0 = z0 - oz0;
  const inX1 = x1 - ox1, inZ1 = z1 - oz1;
  quad(pos, idx, ouX0, yB, ouZ0, ouX0, yT, ouZ0, ouX1, yT, ouZ1, ouX1, yB, ouZ1);
  quad(pos, idx, inX1, yB, inZ1, inX1, yT, inZ1, inX0, yT, inZ0, inX0, yB, inZ0);
  quad(pos, idx, ouX0, yT, ouZ0, ouX1, yT, ouZ1, inX1, yT, inZ1, inX0, yT, inZ0);
  if (capStart) quad(pos, idx, inX0, yB, inZ0, inX0, yT, inZ0, ouX0, yT, ouZ0, ouX0, yB, ouZ0);
  if (capEnd)   quad(pos, idx, ouX1, yB, ouZ1, ouX1, yT, ouZ1, inX1, yT, inZ1, inX1, yB, inZ1);
}

// ─── Geometry helpers: UV-mapped (for textured wall types) ───────────────────

/** Emit one quad with explicit per-vertex UVs. */
function quadUV(pos, uv, idx,
  ax, ay, az, ua, va,
  bx, by, bz, ub, vb,
  cx, cy, cz, uc, vc,
  dx, dy, dz, ud, vd,
) {
  const base = pos.length / 3;
  pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
  uv.push(ua, va,  ub, vb,  uc, vc,  ud, vd);
  idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * Emit one textured wall slab for the range [uStart, uEnd] along the wall (metres).
 * Outer face, inner face, top cap, optional end caps.
 */
function slabUV(pos, uv, idx,
  x0, z0, ox0, oz0, x1, z1, ox1, oz1,
  yB, yT, capStart, capEnd, uStart, uEnd,
) {
  const ouX0 = x0 + ox0, ouZ0 = z0 + oz0;
  const ouX1 = x1 + ox1, ouZ1 = z1 + oz1;
  const inX0 = x0 - ox0, inZ0 = z0 - oz0;
  const inX1 = x1 - ox1, inZ1 = z1 - oz1;

  const us = uStart / WALL_UV_U;
  const ue = uEnd   / WALL_UV_U;
  const vB = yB / WALL_UV_V;
  const vT = yT / WALL_UV_V;

  // outer face (bottom-left → top-left → top-right → bottom-right)
  quadUV(pos, uv, idx,
    ouX0, yB, ouZ0, us, vB,
    ouX0, yT, ouZ0, us, vT,
    ouX1, yT, ouZ1, ue, vT,
    ouX1, yB, ouZ1, ue, vB,
  );
  // inner face (reversed so normal faces inward)
  quadUV(pos, uv, idx,
    inX1, yB, inZ1, ue, vB,
    inX1, yT, inZ1, ue, vT,
    inX0, yT, inZ0, us, vT,
    inX0, yB, inZ0, us, vB,
  );
  // top cap (u along wall, v across thickness 0→1)
  quadUV(pos, uv, idx,
    ouX0, yT, ouZ0, us, 0,
    ouX1, yT, ouZ1, ue, 0,
    inX1, yT, inZ1, ue, 1,
    inX0, yT, inZ0, us, 1,
  );
  // end caps at gate openings (u across thickness, v by height)
  if (capStart) {
    quadUV(pos, uv, idx,
      inX0, yB, inZ0, 0, vB,
      inX0, yT, inZ0, 0, vT,
      ouX0, yT, ouZ0, 1, vT,
      ouX0, yB, ouZ0, 1, vB,
    );
  }
  if (capEnd) {
    quadUV(pos, uv, idx,
      ouX1, yB, ouZ1, 0, vB,
      ouX1, yT, ouZ1, 0, vT,
      inX1, yT, inZ1, 1, vT,
      inX1, yB, inZ1, 1, vB,
    );
  }
}

// ─── Procedural brick texture for precast panels ────────────────────────────
let _precastBrickTex = null;
function getPrecastBrickTexture() {
  if (_precastBrickTex) return _precastBrickTex;
  const W = 128, H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  // Mortar color (pale cream)
  ctx.fillStyle = '#d4d0c8';
  ctx.fillRect(0, 0, W, H);
  // Brick rows
  const brickH = 16, brickW = 32, mortarW = 2;
  const rows = Math.ceil(H / brickH);
  for (let row = 0; row < rows; row++) {
    const y = row * brickH;
    const offset = (row % 2 === 0) ? 0 : brickW / 2;
    for (let col = -1; col < Math.ceil(W / brickW) + 1; col++) {
      const x = col * brickW + offset;
      const v = 0.96 + Math.random() * 0.08;
      const r = Math.round(240 * v), g = Math.round(234 * v), b = Math.round(222 * v);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x + mortarW, y + mortarW, brickW - mortarW * 2, brickH - mortarW * 2);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  _precastBrickTex = tex;
  return tex;
}

/** UV tiling: 1 texture repeat per N metres. */
const PRECAST_UV_U = 2.0; // metres per horizontal repeat
const PRECAST_UV_V = 2.0; // metres per vertical repeat

// ─── Precast compound wall materials ──────────────────────────────────────────
let _precastPanelMat = null, _precastPillarMat = null, _precastWireMat = null;
function getPrecastPanelMat() {
  if (!_precastPanelMat) {
    _precastPanelMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.92, metalness: 0,
      map: getPrecastBrickTexture(),
    });
    _precastPanelMat.userData.sharedMaterial = true;
  }
  return _precastPanelMat;
}
function getPrecastPillarMat() {
  if (!_precastPillarMat) {
    _precastPillarMat = new THREE.MeshStandardMaterial({
      color: PRECAST_PILLAR_COLOR, roughness: 0.88, metalness: 0, flatShading: true,
    });
    _precastPillarMat.userData.sharedMaterial = true;
  }
  return _precastPillarMat;
}
function getPrecastWireMat() {
  if (!_precastWireMat) {
    _precastWireMat = new THREE.MeshStandardMaterial({
      color: PRECAST_WIRE_COLOR, roughness: 0.5, metalness: 0.4, flatShading: true,
    });
    _precastWireMat.userData.sharedMaterial = true;
  }
  return _precastWireMat;
}
let _gatePillarMat = null;
function getGatePillarMat() {
  if (!_gatePillarMat) {
    _gatePillarMat = new THREE.MeshStandardMaterial({
      color: 0xB8AB96, roughness: 0.82, metalness: 0, flatShading: false,
    });
    _gatePillarMat.userData.sharedMaterial = true;
  }
  return _gatePillarMat;
}

// ─── Precast compound wall geometry builder ───────────────────────────────────
/**
 * Build Indian precast compound wall: concrete pillars at regular intervals,
 * flat panels between them, angled wire supports on top of each pillar.
 * Returns { panelGeoms, pillarGeoms, wireGeoms } arrays of BufferGeometry.
 */
function buildPrecastWallGeometry(points, height, gates, roadSegs) {
  const n = points.length;
  if (n < 2) return null;

  const segGates = computeSegGates(points, gates, roadSegs);
  const panelPos = [], panelIdx = [], panelUV = [];
  const pillarPos = [], pillarIdx = [];
  const wirePos = [], wireIdx = [];

  // Helper: axis-aligned box emitter
  function emitBox(pos, idx, corners, yB, yT) {
    // corners = [[x,z], [x,z], [x,z], [x,z]] — 4 corners in order
    const b = pos.length / 3;
    for (const [cx, cz] of corners) { pos.push(cx, yB, cz); }
    for (const [cx, cz] of corners) { pos.push(cx, yT, cz); }
    // 4 side faces + top
    for (let f = 0; f < 4; f++) {
      const a = f, bn = (f + 1) % 4;
      idx.push(b + a, b + bn, b + bn + 4, b + a, b + bn + 4, b + a + 4);
    }
    idx.push(b + 4, b + 5, b + 6, b + 4, b + 6, b + 7); // top
  }

  // Walk polyline computing arc lengths and collecting wall ranges
  let cumLen = 0;
  const segStarts = [0]; // cumulative distance at start of each segment
  for (let i = 0; i < n - 1; i++) {
    const dx = points[i + 1][0] - points[i][0];
    const dz = points[i + 1][1] - points[i][1];
    cumLen += Math.hypot(dx, dz);
    segStarts.push(cumLen);
  }
  const totalLen = cumLen;
  if (totalLen < 1) return null;

  // Position at arc distance s along polyline
  function posAt(s) {
    s = Math.max(0, Math.min(totalLen, s));
    for (let i = 0; i < n - 1; i++) {
      if (segStarts[i + 1] >= s - 1e-6) {
        const segLen = segStarts[i + 1] - segStarts[i];
        const t = segLen > 1e-6 ? (s - segStarts[i]) / segLen : 0;
        return {
          x: points[i][0] + t * (points[i + 1][0] - points[i][0]),
          z: points[i][1] + t * (points[i + 1][1] - points[i][1]),
        };
      }
    }
    return { x: points[n - 1][0], z: points[n - 1][1] };
  }

  function tangentAt(s) {
    const eps = 0.15;
    const a = posAt(Math.max(0, s - eps));
    const b = posAt(Math.min(totalLen, s + eps));
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    return { dx: dx / len, dz: dz / len, px: -dz / len, pz: dx / len };
  }

  // Build flat list of wall ranges (arc distances) excluding gate openings
  // Each range: { from, to } in arc-length metres
  const wallRanges = [];
  for (let i = 0; i < n - 1; i++) {
    const x0 = points[i][0], z0 = points[i][1];
    const x1 = points[i + 1][0], z1 = points[i + 1][1];
    const segLen = Math.hypot(x1 - x0, z1 - z0);
    if (segLen < 1e-6) continue;
    const sStart = segStarts[i];

    const gts = segGates[i];
    let prev = 0;
    const ranges = [];
    for (const [gs, ge] of gts) {
      if (gs > prev + 1e-5) ranges.push([prev, gs]);
      prev = ge;
    }
    if (prev < 1 - 1e-5) ranges.push([prev, 1]);

    for (const [ta, tb] of ranges) {
      wallRanges.push({ from: sStart + ta * segLen, to: sStart + tb * segLen });
    }
  }

  // Merge adjacent wall ranges
  const merged = [];
  for (const r of wallRanges) {
    if (merged.length && Math.abs(r.from - merged[merged.length - 1].to) < 0.1) {
      merged[merged.length - 1].to = r.to;
    } else {
      merged.push({ ...r });
    }
  }

  const yB = 0;
  const panelTop = height;
  const pillarTop = height + PRECAST_PILLAR_RISE;
  const hp = PRECAST_PILLAR_W / 2;
  const hpd = PRECAST_PILLAR_D / 2;
  const hpt = PRECAST_PANEL_THICK / 2;

  for (const range of merged) {
    const rangeLen = range.to - range.from;
    if (rangeLen < 0.5) continue;

    // Place pillars at regular intervals within this range
    const numPillars = Math.max(2, Math.round(rangeLen / PRECAST_PILLAR_SPACING) + 1);
    const spacing = rangeLen / (numPillars - 1);

    for (let pi = 0; pi < numPillars; pi++) {
      const s = range.from + pi * spacing;
      const p = posAt(s);
      const t = tangentAt(s);

      // Pillar box corners: along-wall ± hpd, across-wall ± hp
      const corners = [
        [p.x + t.dx * hpd + t.px * hp, p.z + t.dz * hpd + t.pz * hp],
        [p.x + t.dx * hpd - t.px * hp, p.z + t.dz * hpd - t.pz * hp],
        [p.x - t.dx * hpd - t.px * hp, p.z - t.dz * hpd - t.pz * hp],
        [p.x - t.dx * hpd + t.px * hp, p.z - t.dz * hpd + t.pz * hp],
      ];
      emitBox(pillarPos, pillarIdx, corners, yB, pillarTop);

      // Wire supports: two angled bars on top, leaning outward on each side
      const wireYBase = pillarTop;
      const cosA = Math.cos(PRECAST_WIRE_ANGLE);
      const sinA = Math.sin(PRECAST_WIRE_ANGLE);
      const wh = PRECAST_WIRE_THICK / 2;

      for (const side of [1, -1]) {
        // Bar goes from pillar top outward at angle
        const tipX = p.x + t.px * side * (hp + PRECAST_WIRE_LEN * sinA);
        const tipZ = p.z + t.pz * side * (hp + PRECAST_WIRE_LEN * sinA);
        const tipY = wireYBase + PRECAST_WIRE_LEN * cosA;
        const baseX = p.x + t.px * side * hp;
        const baseZ = p.z + t.pz * side * hp;

        // Simple box along the bar direction
        const bIdx = wirePos.length / 3;
        // 4 verts at base, 4 at tip
        wirePos.push(
          baseX + t.dx * wh, wireYBase - wh, baseZ + t.dz * wh,
          baseX + t.dx * wh, wireYBase + wh, baseZ + t.dz * wh,
          baseX - t.dx * wh, wireYBase + wh, baseZ - t.dz * wh,
          baseX - t.dx * wh, wireYBase - wh, baseZ - t.dz * wh,
          tipX + t.dx * wh, tipY - wh, tipZ + t.dz * wh,
          tipX + t.dx * wh, tipY + wh, tipZ + t.dz * wh,
          tipX - t.dx * wh, tipY + wh, tipZ - t.dz * wh,
          tipX - t.dx * wh, tipY - wh, tipZ - t.dz * wh,
        );
        wireIdx.push(
          bIdx, bIdx+1, bIdx+5, bIdx, bIdx+5, bIdx+4,
          bIdx+2, bIdx+3, bIdx+7, bIdx+2, bIdx+7, bIdx+6,
          bIdx+1, bIdx+2, bIdx+6, bIdx+1, bIdx+6, bIdx+5,
          bIdx+3, bIdx, bIdx+4, bIdx+3, bIdx+4, bIdx+7,
        );
      }
    }

    // Panels between pillars (with UVs for brick texture)
    for (let pi = 0; pi < numPillars - 1; pi++) {
      const sA = range.from + pi * spacing + hpd + 0.02;
      const sB = range.from + (pi + 1) * spacing - hpd - 0.02;
      if (sB - sA < 0.2) continue;

      const pA = posAt(sA);
      const pB = posAt(sB);
      const tA = tangentAt(sA);
      const tB = tangentAt(sB);

      const panelW = Math.hypot(pB.x - pA.x, pB.z - pA.z);
      const uL = 0;
      const uR = panelW / PRECAST_UV_U;
      const vBot = yB / PRECAST_UV_V;
      const vTop = panelTop / PRECAST_UV_V;

      // Outer face: 4 unique verts with UVs
      const bO = panelPos.length / 3;
      panelPos.push(
        pA.x + tA.px * hpt, yB, pA.z + tA.pz * hpt,
        pB.x + tB.px * hpt, yB, pB.z + tB.pz * hpt,
        pB.x + tB.px * hpt, panelTop, pB.z + tB.pz * hpt,
        pA.x + tA.px * hpt, panelTop, pA.z + tA.pz * hpt,
      );
      panelUV.push(uL, vBot, uR, vBot, uR, vTop, uL, vTop);
      panelIdx.push(bO, bO+1, bO+2, bO, bO+2, bO+3);

      // Inner face: 4 unique verts (reversed winding)
      const bI = panelPos.length / 3;
      panelPos.push(
        pB.x - tB.px * hpt, yB, pB.z - tB.pz * hpt,
        pA.x - tA.px * hpt, yB, pA.z - tA.pz * hpt,
        pA.x - tA.px * hpt, panelTop, pA.z - tA.pz * hpt,
        pB.x - tB.px * hpt, panelTop, pB.z - tB.pz * hpt,
      );
      panelUV.push(uR, vBot, uL, vBot, uL, vTop, uR, vTop);
      panelIdx.push(bI, bI+1, bI+2, bI, bI+2, bI+3);

      // Top cap
      const bT = panelPos.length / 3;
      panelPos.push(
        pA.x + tA.px * hpt, panelTop, pA.z + tA.pz * hpt,
        pB.x + tB.px * hpt, panelTop, pB.z + tB.pz * hpt,
        pB.x - tB.px * hpt, panelTop, pB.z - tB.pz * hpt,
        pA.x - tA.px * hpt, panelTop, pA.z - tA.pz * hpt,
      );
      panelUV.push(uL, 0, uR, 0, uR, 1, uL, 1);
      panelIdx.push(bT, bT+1, bT+2, bT, bT+2, bT+3);

      // Left end cap
      const bL = panelPos.length / 3;
      panelPos.push(
        pA.x - tA.px * hpt, yB, pA.z - tA.pz * hpt,
        pA.x + tA.px * hpt, yB, pA.z + tA.pz * hpt,
        pA.x + tA.px * hpt, panelTop, pA.z + tA.pz * hpt,
        pA.x - tA.px * hpt, panelTop, pA.z - tA.pz * hpt,
      );
      panelUV.push(0, vBot, 1, vBot, 1, vTop, 0, vTop);
      panelIdx.push(bL, bL+1, bL+2, bL, bL+2, bL+3);

      // Right end cap
      const bR = panelPos.length / 3;
      panelPos.push(
        pB.x + tB.px * hpt, yB, pB.z + tB.pz * hpt,
        pB.x - tB.px * hpt, yB, pB.z - tB.pz * hpt,
        pB.x - tB.px * hpt, panelTop, pB.z - tB.pz * hpt,
        pB.x + tB.px * hpt, panelTop, pB.z + tB.pz * hpt,
      );
      panelUV.push(0, vBot, 1, vBot, 1, vTop, 0, vTop);
      panelIdx.push(bR, bR+1, bR+2, bR, bR+2, bR+3);
    }
  }

  // ── Gate pillars with ball finials at each gate opening boundary ────────────
  const gatePillarPos = [], gatePillarIdx = [];
  const ghp = GATE_PILLAR_W / 2;
  const ghd = GATE_PILLAR_D / 2;
  const gatePillarTop = height + GATE_PILLAR_RISE;
  const capTop = gatePillarTop + GATE_PILLAR_CAP_H;
  const capHp = ghp + GATE_PILLAR_CAP_OVERHANG;
  const capHd = ghd + GATE_PILLAR_CAP_OVERHANG;

  // Collect gate boundary positions from segGates
  for (let i = 0; i < n - 1; i++) {
    const x0 = points[i][0], z0 = points[i][1];
    const x1 = points[i + 1][0], z1 = points[i + 1][1];
    const dx = x1 - x0, dz = z1 - z0;
    const segLen = Math.hypot(dx, dz);
    if (segLen < 1e-6) continue;

    for (const [gs, ge] of segGates[i]) {
      // Place a gate pillar at each boundary of the opening
      for (const gt of [gs, ge]) {
        const gx = x0 + gt * dx;
        const gz = z0 + gt * dz;
        const dirX = dx / segLen, dirZ = dz / segLen;
        const perpX = -dz / segLen, perpZ = dx / segLen;

        // Main pillar shaft
        const corners = [
          [gx + dirX * ghd + perpX * ghp, gz + dirZ * ghd + perpZ * ghp],
          [gx + dirX * ghd - perpX * ghp, gz + dirZ * ghd - perpZ * ghp],
          [gx - dirX * ghd - perpX * ghp, gz - dirZ * ghd - perpZ * ghp],
          [gx - dirX * ghd + perpX * ghp, gz - dirZ * ghd + perpZ * ghp],
        ];
        emitBox(gatePillarPos, gatePillarIdx, corners, yB, gatePillarTop);

        // Cap slab (slightly wider overhang)
        const capCorners = [
          [gx + dirX * capHd + perpX * capHp, gz + dirZ * capHd + perpZ * capHp],
          [gx + dirX * capHd - perpX * capHp, gz + dirZ * capHd - perpZ * capHp],
          [gx - dirX * capHd - perpX * capHp, gz - dirZ * capHd - perpZ * capHp],
          [gx - dirX * capHd + perpX * capHp, gz - dirZ * capHd + perpZ * capHp],
        ];
        emitBox(gatePillarPos, gatePillarIdx, capCorners, gatePillarTop, capTop);

        // Ball finial on top — low-poly sphere (latitude/longitude mesh)
        const ballCx = gx, ballCz = gz;
        const ballCy = capTop + GATE_FINIAL_RADIUS;
        const R = GATE_FINIAL_RADIUS;
        const segs = GATE_FINIAL_SEGMENTS;
        const bBase = gatePillarPos.length / 3;

        // Bottom pole
        gatePillarPos.push(ballCx, ballCy - R, ballCz);
        // Latitude rings
        for (let lat = 1; lat < segs; lat++) {
          const phi = (lat / segs) * Math.PI;
          const rY = -R * Math.cos(phi);
          const rR = R * Math.sin(phi);
          for (let lon = 0; lon < segs; lon++) {
            const theta = (lon / segs) * Math.PI * 2;
            gatePillarPos.push(
              ballCx + rR * Math.cos(theta),
              ballCy + rY,
              ballCz + rR * Math.sin(theta),
            );
          }
        }
        // Top pole
        gatePillarPos.push(ballCx, ballCy + R, ballCz);

        const topIdx = bBase + 1 + (segs - 2) * segs + segs; // == bBase + total - 1
        // Bottom cap triangles
        for (let lon = 0; lon < segs; lon++) {
          const a = bBase; // bottom pole
          const b2 = bBase + 1 + lon;
          const c = bBase + 1 + (lon + 1) % segs;
          gatePillarIdx.push(a, b2, c);
        }
        // Middle quads
        for (let lat = 0; lat < segs - 2; lat++) {
          for (let lon = 0; lon < segs; lon++) {
            const cur = bBase + 1 + lat * segs + lon;
            const nxt = bBase + 1 + lat * segs + (lon + 1) % segs;
            const curUp = bBase + 1 + (lat + 1) * segs + lon;
            const nxtUp = bBase + 1 + (lat + 1) * segs + (lon + 1) % segs;
            gatePillarIdx.push(cur, nxt, nxtUp, cur, nxtUp, curUp);
          }
        }
        // Top cap triangles
        const lastRing = bBase + 1 + (segs - 2) * segs;
        for (let lon = 0; lon < segs; lon++) {
          const a = topIdx;
          const b2 = lastRing + lon;
          const c = lastRing + (lon + 1) % segs;
          gatePillarIdx.push(a, c, b2);
        }
      }
    }
  }

  const result = { panelGeom: null, pillarGeom: null, wireGeom: null, gatePillarGeom: null };

  if (panelPos.length > 0) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(panelPos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(panelUV, 2));
    g.setIndex(panelIdx);
    g.computeVertexNormals();
    result.panelGeom = g;
  }
  if (pillarPos.length > 0) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pillarPos, 3));
    g.setIndex(pillarIdx);
    g.computeVertexNormals();
    result.pillarGeom = g;
  }
  if (wirePos.length > 0) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(wirePos, 3));
    g.setIndex(wireIdx);
    g.computeVertexNormals();
    result.wireGeom = g;
  }
  if (gatePillarPos.length > 0) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(gatePillarPos, 3));
    g.setIndex(gatePillarIdx);
    g.computeVertexNormals();
    result.gatePillarGeom = g;
  }

  return result;
}

// ─── Road segment extraction ──────────────────────────────────────────────────
function buildRoadSegs(roads) {
  const s = [];
  for (const r of roads || []) {
    const pts = r.points || [];
    for (let i = 0; i < pts.length - 1; i++)
      s.push(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
  }
  return s;
}

function roadCrossings(wx0, wz0, wx1, wz1, roadSegs) {
  const ts = [];
  const wdx = wx1 - wx0, wdz = wz1 - wz0;
  for (let k = 0; k < roadSegs.length; k += 4) {
    const rdx = roadSegs[k + 2] - roadSegs[k];
    const rdz = roadSegs[k + 3] - roadSegs[k + 1];
    const denom = wdx * rdz - wdz * rdx;
    if (Math.abs(denom) < 1e-10) continue;
    const t = ((roadSegs[k] - wx0) * rdz - (roadSegs[k + 1] - wz0) * rdx) / denom;
    const u = ((roadSegs[k] - wx0) * wdz - (roadSegs[k + 1] - wz0) * wdx) / denom;
    if (t > 0.01 && t < 0.99 && u >= -0.1 && u <= 1.1) ts.push(t);
  }
  return ts;
}

// ─── Miter / bevel offset computation (shared between both geometry builders) ─
/**
 * Compute per-vertex miter offset vectors and per-segment start/end offsets.
 * Returns { spx, spz, sox, soz, eox, eoz, bevel }.
 */
function computeOffsets(points, halfThick) {
  const n = points.length;
  const spx = new Float64Array(n - 1);
  const spz = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const dx = points[i + 1][0] - points[i][0];
    const dz = points[i + 1][1] - points[i][1];
    const len = Math.hypot(dx, dz);
    spx[i] = len > 1e-6 ? -dz / len : 0;
    spz[i] = len > 1e-6 ?  dx / len : 1;
  }

  const vtxOx = new Float64Array(n);
  const vtxOz = new Float64Array(n);
  const bevel  = new Uint8Array(n);

  vtxOx[0]     = spx[0]     * halfThick;  vtxOz[0]     = spz[0]     * halfThick;
  vtxOx[n - 1] = spx[n - 2] * halfThick;  vtxOz[n - 1] = spz[n - 2] * halfThick;

  for (let i = 1; i < n - 1; i++) {
    const px = spx[i - 1], pz = spz[i - 1];
    const qx = spx[i],     qz = spz[i];
    let mx = px + qx, mz = pz + qz;
    const mag = Math.hypot(mx, mz);
    if (mag < 1e-6) { bevel[i] = 1; vtxOx[i] = px * halfThick; vtxOz[i] = pz * halfThick; continue; }
    mx /= mag; mz /= mag;
    const dot = mx * px + mz * pz;
    if (dot < 1e-3) { bevel[i] = 1; vtxOx[i] = px * halfThick; vtxOz[i] = pz * halfThick; continue; }
    const scale = halfThick / dot;
    if (scale > halfThick * MITER_LIMIT) {
      bevel[i] = 1; vtxOx[i] = px * halfThick; vtxOz[i] = pz * halfThick;
    } else {
      vtxOx[i] = mx * scale; vtxOz[i] = mz * scale;
    }
  }

  const sox = new Float64Array(n - 1);
  const soz = new Float64Array(n - 1);
  const eox = new Float64Array(n - 1);
  const eoz = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    sox[i] = bevel[i]     ? spx[i] * halfThick : vtxOx[i];
    soz[i] = bevel[i]     ? spz[i] * halfThick : vtxOz[i];
    eox[i] = bevel[i + 1] ? spx[i] * halfThick : vtxOx[i + 1];
    eoz[i] = bevel[i + 1] ? spz[i] * halfThick : vtxOz[i + 1];
  }

  return { spx, spz, sox, soz, eox, eoz, bevel };
}

/** Compute gate intervals (complement = wall ranges) for every segment. */
function computeSegGates(points, gates, roadSegs) {
  const n = points.length;
  const segGates = [];
  for (let i = 0; i < n - 1; i++) {
    const x0 = points[i][0], z0 = points[i][1];
    const x1 = points[i + 1][0], z1 = points[i + 1][1];
    const segLen = Math.hypot(x1 - x0, z1 - z0);
    const intervals = [];
    const halfT = segLen > 1e-6 ? GATE_HALF_WIDTH / segLen : 0.5;
    for (const [gx, gz] of (gates || [])) {
      const dx = x1 - x0, dz = z1 - z0;
      const t = segLen > 1e-6 ? ((gx - x0) * dx + (gz - z0) * dz) / (segLen * segLen) : 0.5;
      if (t >= 0 && t <= 1) intervals.push([Math.max(0, t - halfT), Math.min(1, t + halfT)]);
    }
    for (const t of roadCrossings(x0, z0, x1, z1, roadSegs || [])) {
      intervals.push([Math.max(0, t - halfT), Math.min(1, t + halfT)]);
    }
    intervals.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const iv of intervals) {
      if (merged.length && iv[0] <= merged[merged.length - 1][1])
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], iv[1]);
      else merged.push([...iv]);
    }
    segGates.push(merged);
  }
  return segGates;
}

// ─── Core wall geometry builder: color-only (no UV) ──────────────────────────
function buildWallGeometry(points, height, thickness, gates, roadSegs) {
  const n = points.length;
  if (n < 2) return null;
  const halfThick = thickness / 2;
  const yB = 0, yT = height;

  const { spx, spz, sox, soz, eox, eoz, bevel } = computeOffsets(points, halfThick);
  const segGates = computeSegGates(points, gates, roadSegs);

  const pos = [], idx = [];

  for (let i = 0; i < n - 1; i++) {
    const x0 = points[i][0], z0 = points[i][1];
    const x1 = points[i + 1][0], z1 = points[i + 1][1];
    const dx = x1 - x0, dz = z1 - z0;
    const segLen = Math.hypot(dx, dz);
    if (segLen < 1e-6) continue;

    const gts = segGates[i];
    let prev = 0;
    const wallRanges = [];
    for (const [gs, ge] of gts) {
      if (gs > prev + 1e-5) wallRanges.push([prev, gs]);
      prev = ge;
    }
    if (prev < 1 - 1e-5) wallRanges.push([prev, 1]);

    for (const [ta, tb] of wallRanges) {
      const xa = x0 + ta * dx, za = z0 + ta * dz;
      const xb = x0 + tb * dx, zb = z0 + tb * dz;
      const oxa = sox[i] + (eox[i] - sox[i]) * ta;
      const oza = soz[i] + (eoz[i] - soz[i]) * ta;
      const oxb = sox[i] + (eox[i] - sox[i]) * tb;
      const ozb = soz[i] + (eoz[i] - soz[i]) * tb;
      slab(pos, idx, xa, za, oxa, oza, xb, zb, oxb, ozb, yB, yT, ta > 1e-5, tb < 1 - 1e-5);
    }

    const dirX = dx / segLen, dirZ = dz / segLen;
    const perpX = spx[i], perpZ = spz[i];
    for (const [gs, ge] of gts) {
      pillar(pos, idx, x0 + gs * dx, z0 + gs * dz, perpX, perpZ, dirX, dirZ, thickness, height);
      pillar(pos, idx, x0 + ge * dx, z0 + ge * dz, perpX, perpZ, dirX, dirZ, thickness, height);
    }
  }

  for (let j = 1; j < n - 1; j++) {
    if (!bevel[j]) continue;
    const [xj, zj] = points[j];
    const prevOx = spx[j - 1] * halfThick, prevOz = spz[j - 1] * halfThick;
    const nextOx = spx[j]     * halfThick, nextOz = spz[j]     * halfThick;
    const cross = (xj - points[j - 1][0]) * (points[j + 1][1] - zj)
                - (zj - points[j - 1][1]) * (points[j + 1][0] - xj);
    const ax = xj + prevOx, az = zj + prevOz;
    const bx = xj + nextOx, bz = zj + nextOz;
    if (cross > 0) {
      quad(pos, idx, ax, yB, az, ax, yT, az, bx, yT, bz, bx, yB, bz);
      const cx = xj - (prevOx + nextOx) * 0.5, cz = zj - (prevOz + nextOz) * 0.5;
      tri(pos, idx, ax, yT, az, bx, yT, bz, cx, yT, cz);
    } else if (cross < 0) {
      const ix = xj - prevOx, iz = zj - prevOz;
      const jx = xj - nextOx, jz = zj - nextOz;
      quad(pos, idx, jx, yB, jz, jx, yT, jz, ix, yT, iz, ix, yB, iz);
    }
  }

  if (pos.length === 0) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setIndex(idx);
  return geom;
}

// ─── Textured wall geometry builder (UV-mapped) ───────────────────────────────
/**
 * Same structural logic as buildWallGeometry but emits a `uv` attribute.
 * UV.x tracks accumulated wall distance (resets to 0 at start of each polyline).
 * UV.y is world Y (0 = ground, yT = wall top).
 */
function buildTexturedWallGeometry(points, height, thickness, gates, roadSegs) {
  const n = points.length;
  if (n < 2) return null;
  const halfThick = thickness / 2;
  const yB = 0, yT = height;

  const { spx, spz, sox, soz, eox, eoz, bevel } = computeOffsets(points, halfThick);
  const segGates = computeSegGates(points, gates, roadSegs);

  const pos = [], uv = [], idx = [];
  let cumU = 0; // accumulated wall distance in metres for UV.x

  for (let i = 0; i < n - 1; i++) {
    const x0 = points[i][0], z0 = points[i][1];
    const x1 = points[i + 1][0], z1 = points[i + 1][1];
    const dx = x1 - x0, dz = z1 - z0;
    const segLen = Math.hypot(dx, dz);
    if (segLen < 1e-6) continue;

    const gts = segGates[i];
    let prev = 0;
    const wallRanges = [];
    for (const [gs, ge] of gts) {
      if (gs > prev + 1e-5) wallRanges.push([prev, gs]);
      prev = ge;
    }
    if (prev < 1 - 1e-5) wallRanges.push([prev, 1]);

    for (const [ta, tb] of wallRanges) {
      const xa = x0 + ta * dx, za = z0 + ta * dz;
      const xb = x0 + tb * dx, zb = z0 + tb * dz;
      const oxa = sox[i] + (eox[i] - sox[i]) * ta;
      const oza = soz[i] + (eoz[i] - soz[i]) * ta;
      const oxb = sox[i] + (eox[i] - sox[i]) * tb;
      const ozb = soz[i] + (eoz[i] - soz[i]) * tb;
      const uStart = cumU + ta * segLen;
      const uEnd   = cumU + tb * segLen;
      slabUV(pos, uv, idx, xa, za, oxa, oza, xb, zb, oxb, ozb, yB, yT,
        ta > 1e-5, tb < 1 - 1e-5, uStart, uEnd);
    }

    // Pillars: simple solid, no UV needed — use pillar helper which writes to pos/idx.
    // NOTE: mergeGeometries requires all sub-geometries to share the same attribute set,
    // so we skip pillar geometry for textured walls rather than mixing UV/non-UV.

    cumU += segLen; // advance cumulative distance by full segment length (including gate gaps)
  }

  // Bevel fills: small triangular corner fills with approximate UVs
  cumU = 0;
  for (let i = 0; i < n - 1; i++) {
    cumU += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
    if (i + 1 >= n - 1) break;

    const j = i + 1;
    if (!bevel[j]) continue;

    const [xj, zj] = points[j];
    const prevOx = spx[j - 1] * halfThick, prevOz = spz[j - 1] * halfThick;
    const nextOx = spx[j]     * halfThick, nextOz = spz[j]     * halfThick;
    const cross = (xj - points[j - 1][0]) * (points[j + 1][1] - zj)
                - (zj - points[j - 1][1]) * (points[j + 1][0] - xj);
    const uj = cumU / WALL_UV_U;
    const vB = yB / WALL_UV_V;
    const vT = yT / WALL_UV_V;

    if (cross > 0) {
      const ax = xj + prevOx, az = zj + prevOz;
      const bx = xj + nextOx, bz = zj + nextOz;
      // Outer vertical fill quad
      quadUV(pos, uv, idx,
        ax, yB, az, uj, vB,
        ax, yT, az, uj, vT,
        bx, yT, bz, uj, vT,
        bx, yB, bz, uj, vB,
      );
      // Top triangle apex
      const cx = xj - (prevOx + nextOx) * 0.5, cz = zj - (prevOz + nextOz) * 0.5;
      const base3 = pos.length / 3;
      pos.push(ax, yT, az, bx, yT, bz, cx, yT, cz);
      uv.push(uj, 0,  uj, 0,  uj, 0);
      idx.push(base3, base3 + 1, base3 + 2);
    } else if (cross < 0) {
      const ix = xj - prevOx, iz = zj - prevOz;
      const jx = xj - nextOx, jz = zj - nextOz;
      quadUV(pos, uv, idx,
        jx, yB, jz, uj, vB,
        jx, yT, jz, uj, vT,
        ix, yT, iz, uj, vT,
        ix, yB, iz, uj, vB,
      );
    }
  }

  if (pos.length === 0) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute('uv',       new THREE.Float32BufferAttribute(uv,  2));
  geom.setIndex(idx);
  return geom;
}

const _dummy = new THREE.Object3D();

// ─── Shared gate material ─────────────────────────────────────────────────────
let _gateMat = null;
function getGateMaterial() {
  if (_gateMat) return _gateMat;
  _gateMat = new THREE.MeshStandardMaterial({
    color: GATE_COLOR,
    roughness: 0.55,
    metalness: 0.6,
    flatShading: true,
  });
  _gateMat.userData.sharedMaterial = true;
  return _gateMat;
}

// ─── Gate leaf geometry (arched Indian institutional style) ───────────────────
/**
 * Build a single gate leaf with arched top, dense vertical bars, spear finials.
 * Inspired by classic Indian campus/university wrought-iron gates.
 *
 * Local space: X = width (0..leafW), Y = height, Z = depth (~0).
 * The hinge is at X=0. The arch rises above `h` at the center by GATE_ARCH_RISE.
 */
function buildGateLeaf(leafW, h) {
  const pos = [], idx = [];
  const ft = GATE_FRAME_T;
  const br = GATE_BAR_RADIUS;
  const archRise = GATE_ARCH_RISE;

  // Helper: axis-aligned box in local coords
  function box(x0, y0, z0, x1, y1, z1) {
    const b = pos.length / 3;
    pos.push(
      x0, y0, z0,  x1, y0, z0,  x1, y1, z0,  x0, y1, z0,
      x0, y0, z1,  x1, y0, z1,  x1, y1, z1,  x0, y1, z1,
    );
    idx.push(
      b,b+1,b+2, b,b+2,b+3,
      b+5,b+4,b+7, b+5,b+7,b+6,
      b+4,b,b+3, b+4,b+3,b+7,
      b+1,b+5,b+6, b+1,b+6,b+2,
      b+3,b+2,b+6, b+3,b+6,b+7,
      b+4,b+5,b+1, b+4,b+1,b,
    );
  }

  // Arch profile: for a given x (0..leafW), return the top Y of the arch.
  // Semi-elliptical arch — highest at the free edge (x=leafW), meets wall height at hinge (x=0).
  function archTopAt(x) {
    // Normalize: t=0 at hinge, t=1 at free end
    const t = x / leafW;
    // Arch: circular-ish rise, peaks at free edge (where two leaves meet)
    return h + archRise * Math.sin(t * Math.PI / 2);
  }

  // ── Bottom rail ──
  box(0, 0, -ft / 2, leafW, ft, ft / 2);

  // ── Hinge stile (left, full height to wall top) ──
  box(0, 0, -ft / 2, ft * 1.5, h, ft / 2);

  // ── Free stile (right, taller — up to arch peak) ──
  const freeTop = archTopAt(leafW);
  box(leafW - ft * 1.5, 0, -ft / 2, leafW, freeTop, ft / 2);

  // ── Arched top rail — built as a series of small box segments following the arch curve ──
  const archSegs = 12;
  for (let s = 0; s < archSegs; s++) {
    const x0 = ft * 1.5 + (leafW - ft * 3) * (s / archSegs);
    const x1 = ft * 1.5 + (leafW - ft * 3) * ((s + 1) / archSegs);
    const y0 = archTopAt(x0);
    const y1 = archTopAt(x1);
    const yLo = Math.min(y0, y1) - ft;
    const yHi = Math.max(y0, y1);
    // Slanted box approximation: front and back quads following the arch slope
    const b = pos.length / 3;
    const d = ft / 2;
    pos.push(
      x0, y0 - ft, -d,  x1, y1 - ft, -d,  x1, y1, -d,  x0, y0, -d,  // front
      x0, y0 - ft,  d,  x1, y1 - ft,  d,  x1, y1,  d,  x0, y0,  d,  // back
    );
    idx.push(
      b,b+1,b+2, b,b+2,b+3,       // front
      b+5,b+4,b+7, b+5,b+7,b+6,   // back
      b+4,b,b+3, b+4,b+3,b+7,     // left
      b+1,b+5,b+6, b+1,b+6,b+2,   // right
      b+3,b+2,b+6, b+3,b+6,b+7,   // top
      b+4,b+5,b+1, b+4,b+1,b,     // bottom
    );
  }

  // ── Horizontal rails (evenly spaced between bottom frame and the straight part of the wall) ──
  const railZone = h * 0.85; // rails stay in the straight section
  for (let r = 1; r <= GATE_RAIL_COUNT; r++) {
    const ry = ft + (railZone - ft) * (r / (GATE_RAIL_COUNT + 1));
    box(ft * 1.5, ry - ft / 2, -br, leafW - ft * 1.5, ry + ft / 2, br);
  }

  // ── Thicker mid-height decorative rail (prominent horizontal band like reference) ──
  const midY = h * 0.55;
  box(ft * 1.5, midY - ft * 0.8, -br * 1.5, leafW - ft * 1.5, midY + ft * 0.8, br * 1.5);

  // ── Vertical bars — dense, each reaching up to the arch profile ──
  const innerW = leafW - ft * 3;
  for (let v = 1; v <= GATE_BAR_COUNT; v++) {
    const vx = ft * 1.5 + (innerW * v) / (GATE_BAR_COUNT + 1);
    const barTop = archTopAt(vx) - ft; // stop just below the arch rail
    box(vx - br, ft, -br, vx + br, barTop, br);
  }

  // ── Spear finials on top of each bar (along the arch) ──
  for (let v = 1; v <= GATE_BAR_COUNT; v++) {
    const vx = ft * 1.5 + (innerW * v) / (GATE_BAR_COUNT + 1);
    const barTop = archTopAt(vx);
    const tipH = 0.22;
    const tipR = br * 2.2;
    // Diamond base + spear point
    const bv = pos.length / 3;
    // Diamond bulge at bar top
    pos.push(
      vx - tipR, barTop, 0,        // 0 left
      vx, barTop, -tipR,           // 1 front
      vx + tipR, barTop, 0,        // 2 right
      vx, barTop, tipR,            // 3 back
      vx, barTop - tipR * 0.6, 0,  // 4 bottom center
      vx, barTop + tipH, 0,        // 5 spear tip
    );
    // Bottom diamond (4 tris converging to bottom)
    idx.push(
      bv, bv + 1, bv + 4,
      bv + 1, bv + 2, bv + 4,
      bv + 2, bv + 3, bv + 4,
      bv + 3, bv, bv + 4,
    );
    // Top spear (4 tris converging to tip)
    idx.push(
      bv, bv + 5, bv + 1,
      bv + 1, bv + 5, bv + 2,
      bv + 2, bv + 5, bv + 3,
      bv + 3, bv + 5, bv,
    );
  }

  // ── Spear finials on hinge stile and free stile tops ──
  for (const sx of [ft * 0.75, leafW - ft * 0.75]) {
    const stileTop = archTopAt(sx);
    const tipH = 0.25;
    const tipR = ft * 0.8;
    const bv = pos.length / 3;
    pos.push(
      sx - tipR, stileTop, 0,
      sx, stileTop, -tipR,
      sx + tipR, stileTop, 0,
      sx, stileTop, tipR,
      sx, stileTop - tipR * 0.5, 0,
      sx, stileTop + tipH, 0,
    );
    idx.push(
      bv, bv+1, bv+4,  bv+1, bv+2, bv+4,  bv+2, bv+3, bv+4,  bv+3, bv, bv+4,
      bv, bv+5, bv+1,  bv+1, bv+5, bv+2,  bv+2, bv+5, bv+3,  bv+3, bv+5, bv,
    );
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setIndex(idx);
  return geom;
}

/**
 * Place two gate leaves (swung open) at a gate opening.
 * hingeL/hingeR are the two pillar positions (world XZ).
 * dirX, dirZ = wall direction; perpX, perpZ = perpendicular.
 */
function buildGatePair(hingeLx, hingeLz, hingeRx, hingeRz, dirX, dirZ, height) {
  const leafW = Math.hypot(hingeRx - hingeLx, hingeRz - hingeLz) / 2;
  if (leafW < 0.3) return null; // too narrow

  const gateH = Math.max(height, GATE_MIN_HEIGHT);
  const baseGeom = buildGateLeaf(leafW, gateH);
  const parts = [];

  // Wall-direction angle
  const wallAngle = Math.atan2(-dirZ, dirX);

  // Left leaf: hinged at left pillar, swings inward-left
  {
    const g = baseGeom.clone();
    _dummy.position.set(hingeLx, 0, hingeLz);
    _dummy.rotation.set(0, wallAngle + Math.PI - GATE_OPEN_ANGLE, 0);
    _dummy.scale.set(1, 1, 1);
    _dummy.updateMatrix();
    g.applyMatrix4(_dummy.matrix);
    parts.push(g);
  }

  // Right leaf: hinged at right pillar, swings inward-right (mirrored)
  {
    const g = baseGeom.clone();
    _dummy.position.set(hingeRx, 0, hingeRz);
    _dummy.rotation.set(0, wallAngle + GATE_OPEN_ANGLE, 0);
    _dummy.scale.set(1, 1, 1);
    _dummy.updateMatrix();
    g.applyMatrix4(_dummy.matrix);
    parts.push(g);
  }

  baseGeom.dispose();
  return parts;
}

// ─── Pillar (box at gate openings) — color-only types only ───────────────────
function pillar(pos, idx, cx, cz, perpX, perpZ, dirX, dirZ, thickness, height) {
  const hp = (thickness * PILLAR_SCALE) / 2;
  const hd = PILLAR_DEPTH / 2;
  const yT = height + 1.0;  // pillars rise above the wall/gate arch
  const corners = [
    [cx + perpX * hp + dirX * hd, cz + perpZ * hp + dirZ * hd],
    [cx + perpX * hp - dirX * hd, cz + perpZ * hp - dirZ * hd],
    [cx - perpX * hp - dirX * hd, cz - perpZ * hp - dirZ * hd],
    [cx - perpX * hp + dirX * hd, cz - perpZ * hp + dirZ * hd],
  ];
  for (let f = 0; f < 4; f++) {
    const [ax, az] = corners[f];
    const [bx, bz] = corners[(f + 1) % 4];
    quad(pos, idx, ax, 0, az, ax, yT, az, bx, yT, bz, bx, 0, bz);
  }
  quad(pos, idx,
    corners[0][0], yT, corners[0][1],
    corners[1][0], yT, corners[1][1],
    corners[2][0], yT, corners[2][1],
    corners[3][0], yT, corners[3][1],
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────
/**
 * @param {object[]} barriers - tile barriers array
 * @param {object[]} [roads]  - tile roads (world coords, for road-opening detection)
 * @returns {THREE.Mesh[]}
 */
/**
 * Collect all gate opening positions from a barrier's points and gate/road data.
 * Returns array of { gx, gz, dirX, dirZ, height, halfW } for each opening.
 */
function collectGatePositions(points, height, gates, roadSegs) {
  const n = points.length;
  if (n < 2) return [];
  const segGates = computeSegGates(points, gates, roadSegs);
  const result = [];

  for (let i = 0; i < n - 1; i++) {
    const x0 = points[i][0], z0 = points[i][1];
    const x1 = points[i + 1][0], z1 = points[i + 1][1];
    const dx = x1 - x0, dz = z1 - z0;
    const segLen = Math.hypot(dx, dz);
    if (segLen < 1e-6) continue;
    const dirX = dx / segLen, dirZ = dz / segLen;

    for (const [gs, ge] of segGates[i]) {
      const cx = x0 + ((gs + ge) / 2) * dx;
      const cz = z0 + ((gs + ge) / 2) * dz;
      const halfW = ((ge - gs) * segLen) / 2;
      result.push({
        // Hinge positions (at pillar edges of the opening)
        hingeLx: x0 + gs * dx, hingeLz: z0 + gs * dz,
        hingeRx: x0 + ge * dx, hingeRz: z0 + ge * dz,
        dirX, dirZ, height, halfW,
      });
    }
  }
  return result;
}

/**
 * Drape a barrier geometry onto terrain. Barrier geometry is built with local Y (base 0..height)
 * over WORLD X/Z, so adding getGroundY(x,z) per vertex anchors it to the terrain. Walls stay
 * vertical (top & bottom of an edge share X/Z → identical ground shift). Without this the visual
 * wall floats at Y=0 (below-spawn terrain) while the collider — which already uses getGroundY —
 * sits correctly. See gotchas G-45.
 */
function drapeToGround(geom, getGroundY) {
  const pos = geom?.attributes?.position;
  if (!pos || typeof getGroundY !== 'function') return;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, pos.getY(i) + getGroundY(pos.getX(i), pos.getZ(i)));
  }
  pos.needsUpdate = true;
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
}

export function buildBarrierMeshes(barriers, roads, buildings, getGroundY) {
  if (!barriers || barriers.length === 0) return [];
  const roadSegs = roads ? buildRoadSegs(roads) : null;

  // Ghost-wall filter (4D.2): skip wall barriers whose midpoint is within 5m of any building centroid.
  // Filters OSM double-tagging where barrier=wall coincides with building perimeter.
  let filteredBarriers = barriers;
  if (CONFIG.ENABLE_GHOST_WALL_FILTER && buildings?.length) {
    const bCentroids = buildings.map(b => {
      if (b.center) return { x: b.center.x, z: b.center.y };
      const fp = b.footprint || [];
      if (!fp.length) return null;
      return { x: fp.reduce((s,p)=>s+p.x,0)/fp.length, z: fp.reduce((s,p)=>s+p.y,0)/fp.length };
    }).filter(Boolean);
    const GHOST_DIST_SQ = 5 * 5;
    filteredBarriers = barriers.filter(b => {
      if (b.type !== 'wall') return true; // only filter wall type
      const pts = b.points;
      if (!pts || pts.length < 2) return true;
      // Check midpoint of barrier polyline
      const mid = pts[Math.floor(pts.length / 2)];
      const mx = mid[0], mz = mid[1];
      for (const c of bCentroids) {
        const dx = mx - c.x, dz = mz - c.z;
        if (dx*dx + dz*dz < GHOST_DIST_SQ) return false; // skip: ghost wall
      }
      return true;
    });
  }

  const byType = {};
  for (const b of filteredBarriers) {
    const t = b.type || 'wall';
    (byType[t] ??= []).push(b);
  }

  const meshes = [];
  const gateGeoms = []; // collect gate leaf geometries across all barrier types

  // Collect precast geometries across all barriers of that type, then merge per-material
  const allPrecastPanels = [], allPrecastPillars = [], allPrecastWires = [], allGatePillars = [];

  for (const [type, group] of Object.entries(byType)) {
    const cfg = BARRIER_CONFIGS[type] || BARRIER_CONFIGS.wall;
    const geoms = [];

    if (PRECAST_WALL_TYPES.has(type)) {
      // ── Precast compound wall: pillars + panels + wire supports ────────────
      for (const b of group) {
        const bh = Math.max(b.height, cfg.minHeight || 0);
        const result = buildPrecastWallGeometry(b.points, bh, b.gates || [], roadSegs);
        if (result) {
          if (result.panelGeom)  allPrecastPanels.push(result.panelGeom);
          if (result.pillarGeom) allPrecastPillars.push(result.pillarGeom);
          if (result.wireGeom)       allPrecastWires.push(result.wireGeom);
          if (result.gatePillarGeom) allGatePillars.push(result.gatePillarGeom);
        }
        // Collect gate positions for this barrier
        for (const gp of collectGatePositions(b.points, bh, b.gates || [], roadSegs)) {
          const leaves = buildGatePair(gp.hingeLx, gp.hingeLz, gp.hingeRx, gp.hingeRz, gp.dirX, gp.dirZ, gp.height);
          if (leaves) gateGeoms.push(...leaves);
        }
      }

    } else if (TEXTURED_WALL_TYPES.has(type)) {
      // ── Textured path: UV-mapped geometry, smooth normals ──────────────────
      for (const b of group) {
        const bh = Math.max(b.height, cfg.minHeight || 0);
        const g = buildTexturedWallGeometry(b.points, bh, cfg.thickness, b.gates || [], roadSegs);
        if (g) geoms.push(g);
        for (const gp of collectGatePositions(b.points, bh, b.gates || [], roadSegs)) {
          const leaves = buildGatePair(gp.hingeLx, gp.hingeLz, gp.hingeRx, gp.hingeRz, gp.dirX, gp.dirZ, gp.height);
          if (leaves) gateGeoms.push(...leaves);
        }
      }
      if (!geoms.length) continue;
      let merged;
      try { merged = mergeGeometries(geoms, false); }
      catch (e) { console.warn('[barrierRenderer] merge failed (textured):', type, e); geoms.forEach(g => g.dispose()); continue; }
      geoms.forEach(g => g.dispose());
      if (!merged) continue;
      merged.computeVertexNormals();
      const mesh = new THREE.Mesh(merged, getWallTexMat());
      mesh.userData.sharedMaterial = true;
      mesh.castShadow  = false;
      mesh.receiveShadow = false;
      meshes.push(mesh);

    } else {
      // ── Color-only path: flat-shaded, no UV (original behaviour) ──────────
      for (const b of group) {
        const bh = Math.max(b.height, cfg.minHeight || 0);
        const g = buildWallGeometry(b.points, bh, cfg.thickness, b.gates || [], roadSegs);
        if (g) geoms.push(g);
        for (const gp of collectGatePositions(b.points, bh, b.gates || [], roadSegs)) {
          const leaves = buildGatePair(gp.hingeLx, gp.hingeLz, gp.hingeRx, gp.hingeRz, gp.dirX, gp.dirZ, gp.height);
          if (leaves) gateGeoms.push(...leaves);
        }
      }
      if (!geoms.length) continue;
      let merged;
      try { merged = mergeGeometries(geoms, false); }
      catch (e) { console.warn('[barrierRenderer] merge failed:', type, e); geoms.forEach(g => g.dispose()); continue; }
      geoms.forEach(g => g.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, getMat(type));
      mesh.userData.sharedMaterial = true;
      mesh.castShadow  = false;
      mesh.receiveShadow = false;
      meshes.push(mesh);
    }
  }

  // ── Merge precast wall geometries into per-material meshes ─────────────────
  function mergeAndPush(geoArr, mat) {
    if (!geoArr.length) return;
    let merged;
    try { merged = mergeGeometries(geoArr, false); }
    catch (e) { console.warn('[barrierRenderer] precast merge failed:', e); }
    geoArr.forEach(g => g.dispose());
    if (!merged) return;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.userData.sharedMaterial = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    meshes.push(mesh);
  }
  mergeAndPush(allPrecastPanels, getPrecastPanelMat());
  mergeAndPush(allPrecastPillars, getPrecastPillarMat());
  mergeAndPush(allPrecastWires, getPrecastWireMat());
  mergeAndPush(allGatePillars, getGatePillarMat());

  // ── Merge all gate leaf geometries into one mesh ───────────────────────────
  if (gateGeoms.length > 0) {
    let gMerged;
    try { gMerged = mergeGeometries(gateGeoms, false); }
    catch (e) { console.warn('[barrierRenderer] gate merge failed:', e); }
    gateGeoms.forEach(g => g.dispose());
    if (gMerged) {
      gMerged.computeVertexNormals();
      const gateMesh = new THREE.Mesh(gMerged, getGateMaterial());
      gateMesh.userData.sharedMaterial = true;
      gateMesh.castShadow  = false;
      gateMesh.receiveShadow = false;
      meshes.push(gateMesh);
    }
  }

  // Anchor all barrier geometry to terrain (built at local Y over world X/Z). Matches the
  // per-segment ground Y the colliders already use; without it walls floated at Y=0.
  for (const m of meshes) drapeToGround(m.geometry, getGroundY);

  return meshes;
}

// ---------------------------------------------------------------------------
// Barrier physics colliders — CANNON.Box shapes following barrier polylines
// ---------------------------------------------------------------------------

/** Types that should block the car. */
const COLLISION_BARRIER_TYPES = new Set([
  'wall', 'compound_wall', 'city_wall', 'retaining_wall',
  'fence', 'guard_rail', 'jersey_barrier',
]);

/**
 * Build a single CANNON.Body with per-segment CANNON.Box shapes for all barriers in a tile.
 * Follows the same pattern as createRoadTrimeshColliders for elevated roads.
 *
 * @param {object[]} barriers - tile barriers array [{type, height, points: [[x,z],...], ...}]
 * @param {{ physicsOrigin: {x:number, z:number}, getGroundYAt?: (wx:number, wz:number)=>number }} opts
 * @returns {CANNON.Body|null}
 */
export function buildBarrierColliders(barriers, opts) {
  if (!barriers || barriers.length === 0) return null;
  const { physicsOrigin } = opts;
  const getGroundY = opts.getGroundYAt || (() => 0);
  const roadSegs = opts.roads ? buildRoadSegs(opts.roads) : null;

  const body = new CANNON.Body({ mass: 0 });
  let shapeCount = 0;

  for (const barrier of barriers) {
    const type = barrier.type || 'wall';
    if (!COLLISION_BARRIER_TYPES.has(type)) continue;

    const cfg = BARRIER_CONFIGS[type] || BARRIER_CONFIGS.wall;
    const pts = barrier.points || [];
    if (pts.length < 2) continue;

    const height = Math.max(barrier.height || 2, cfg.minHeight || 0);
    const thickness = cfg.thickness || 0.5;

    // Compute gate intervals so colliders skip gate/road openings
    const segGates = computeSegGates(pts, barrier.gates || [], roadSegs || []);

    for (let i = 0; i < pts.length - 1; i++) {
      const wx0 = pts[i][0],   wz0 = pts[i][1];
      const wx1 = pts[i+1][0], wz1 = pts[i+1][1];
      const wdx = wx1 - wx0, wdz = wz1 - wz0;
      const segLen = Math.hypot(wdx, wdz);
      if (segLen < 0.5) continue;

      // Compute wall ranges (complement of gate intervals)
      const gts = segGates[i];
      let prev = 0;
      const wallRanges = [];
      for (const [gs, ge] of gts) {
        if (gs > prev + 1e-5) wallRanges.push([prev, gs]);
        prev = ge;
      }
      if (prev < 1 - 1e-5) wallRanges.push([prev, 1]);

      for (const [ta, tb] of wallRanges) {
        // Interpolate world positions for this wall sub-segment
        const sWx0 = wx0 + ta * wdx, sWz0 = wz0 + ta * wdz;
        const sWx1 = wx0 + tb * wdx, sWz1 = wz0 + tb * wdz;

        // Convert to physics space (worldGroup.scale.x = -1 mirrors X)
        const x0 = -(sWx0 - physicsOrigin.x);
        const z0 = sWz0 - physicsOrigin.z;
        const x1 = -(sWx1 - physicsOrigin.x);
        const z1 = sWz1 - physicsOrigin.z;

        const dx = x1 - x0, dz = z1 - z0;
        const len = Math.hypot(dx, dz);
        if (len < 0.3) continue;

        // Ground elevation at sub-segment midpoint
        const midWx = (sWx0 + sWx1) / 2;
        const midWz = (sWz0 + sWz1) / 2;
        const groundY = getGroundY(midWx, midWz);

        const halfThick = thickness / 2;
        const halfH = height / 2;
        const halfLen = len / 2;

        const shape = new CANNON.Box(new CANNON.Vec3(halfThick, halfH, halfLen));
        const yaw = Math.atan2(dx, dz);
        const q = new CANNON.Quaternion();
        q.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);

        const midX = (x0 + x1) / 2;
        const midZ = (z0 + z1) / 2;
        const posY = groundY + halfH;

        body.addShape(shape, new CANNON.Vec3(midX, posY, midZ), q);
        shapeCount++;
      }
    }
  }

  if (shapeCount === 0) return null;
  return body;
}
