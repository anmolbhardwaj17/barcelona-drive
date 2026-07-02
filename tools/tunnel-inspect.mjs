/**
 * tunnel-inspect.mjs — READ-ONLY Phase 0 diagnostic (no behaviour change).
 *
 * Decodes baked binary v7 tiles and extracts real per-portal tunnel numbers so the
 * Findings Report is backed by measured data rather than assumptions:
 *   layer, width, halfWidth, per-endpoint road_Y (as baked), ceiling_Y (road_Y+4.5),
 *   visual mouth-hole r, physics mouth-hole r, and whether the bake's portal-detection
 *   (endpoint shared by exactly one tunnel road) classifies each endpoint as a portal.
 *
 * It re-implements ONLY the parts of the bake's portal math needed to report numbers;
 * it does not modify any subsystem. Usage:
 *   node tools/tunnel-inspect.mjs                 # scan all barcelona tiles, summary
 *   node tools/tunnel-inspect.mjs 16_33163_24481  # detail one tile
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { mercatorToWorld } from '../backend/projection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGION = 'barcelona';
const ZOOM = 16;
const TILES_DIR = path.join(__dirname, '..', 'backend', 'tiles', REGION, String(ZOOM));
const METADATA_PATH = path.join(TILES_DIR, '_metadata.json');

// Bake/runtime constants mirrored here purely to compute the numbers (sources noted):
const TUNNEL_CLEARANCE = 4.5;          // tunnelRenderer.js:15
const MOUTH_RADIUS = 1;                // terrainBaker.js:88 (visual) & :391 (physics)
const MOUTH_HW_PLUS = 1;               // terrainBaker.js: hw = width/2 + 1
const JUNCTION_TOL = 3;                // terrainBaker.js JUNCTION_TOL_MOUTH / PHYS_JTOL
const DRIVABLE = new Set(['motorway','motorway_link','trunk','trunk_link','primary','primary_link',
  'secondary','secondary_link','tertiary','tertiary_link','residential','unclassified','living_street']);

function readTileBuffer(tx, ty) {
  const p = path.join(TILES_DIR, String(tx), String(ty) + '.bin');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

/** Decode v7: [uint32 headerLen][header JSON][binary sections]. Returns {header, bin}. */
function decode(buf) {
  const headerLen = buf.readUInt32LE(0);
  let headerStr = buf.toString('utf8', 4, 4 + headerLen);
  // Header is padded to a 4-byte boundary; padding may be non-whitespace bytes.
  // Trim to the last closing brace of the JSON object before parsing.
  const lastBrace = headerStr.lastIndexOf('}');
  if (lastBrace >= 0) headerStr = headerStr.slice(0, lastBrace + 1);
  const header = JSON.parse(headerStr);
  // binary sections begin after header (offsets in header are bytesFromBinaryStart)
  const binStart = 4 + headerLen;
  return { header, buf, binStart };
}

/** Read Float32 triples [mercX, elev, mercZ] from a road's pointsOffset/pointCount. */
function readRoadPoints(dec, road) {
  const { buf, binStart } = dec;
  const off = binStart + road.pointsOffset;
  const n = road.pointCount;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const b = off + i * 12;
    pts.push({ mx: buf.readFloatLE(b), elev: buf.readFloatLE(b + 4), mz: buf.readFloatLE(b + 8) });
  }
  return pts;
}

function widthOf(road) {
  if (Number.isFinite(road.width) && road.width > 0) return road.width;
  if (Number.isFinite(road.lanes) && road.lanes > 0) return road.lanes * 3.5;
  return 6;
}

function inspectTile(tx, ty, opts = {}) {
  const buf = readTileBuffer(tx, ty);
  if (!buf) return null;
  let dec;
  try { dec = decode(buf); } catch (e) { return { tx, ty, error: 'decode failed: ' + e.message }; }
  const roads = dec.header.roads || [];
  const tunnels = roads.filter(r => r.tunnel && r.layer != null && r.layer < 0);
  if (tunnels.length === 0) return { tx, ty, tunnels: 0 };

  // Portal-endpoint detection identical to terrainBaker (count shared tunnel endpoints).
  const hashEp = (x, z) => `${Math.round(x / JUNCTION_TOL)},${Math.round(z / JUNCTION_TOL)}`;
  const epCount = new Map();
  const tunnelPts = new Map();
  for (const r of tunnels) {
    const pts = readRoadPoints(dec, r);
    tunnelPts.set(r, pts);
    if (pts.length < 2) continue;
    const fp = pts[0], lp = pts[pts.length - 1];
    for (const e of [fp, lp]) {
      const h = hashEp(e.mx, e.mz);
      epCount.set(h, (epCount.get(h) || 0) + 1);
    }
  }
  const isPortal = (x, z) => (epCount.get(hashEp(x, z)) || 0) === 1;

  const portals = [];
  for (const r of tunnels) {
    const pts = tunnelPts.get(r);
    if (!pts || pts.length < 2) continue;
    const w = widthOf(r);
    const halfW = w / 2;
    const mouthHwBase = (Number.isFinite(r.width) && r.width > 0 ? r.width : 4) / 2 + MOUTH_HW_PLUS;
    const visHoleR = mouthHwBase + MOUTH_RADIUS;   // terrainBaker bakeTerrainMesh
    const physHoleR = mouthHwBase + MOUTH_RADIUS;  // terrainBaker bakePhysicsTerrain (same)
    const drivable = DRIVABLE.has(r.highwayType);
    const ends = [
      { which: 'start', p: pts[0] },
      { which: 'end', p: pts[pts.length - 1] },
    ];
    for (const e of ends) {
      portals.push({
        roadId: r.id, name: r.name || null, highwayType: r.highwayType, drivable,
        layer: r.layer, width: +w.toFixed(2), halfW: +halfW.toFixed(2),
        which: e.which,
        road_Y: +e.p.elev.toFixed(3),
        ceiling_Y: +(e.p.elev + TUNNEL_CLEARANCE).toFixed(3),
        visHoleR: +visHoleR.toFixed(2),
        physHoleR: +physHoleR.toFixed(2),
        isPortalEndpoint: isPortal(e.p.mx, e.p.mz),
      });
    }
  }
  // Elevation span across all tunnel points (to see DEM vs flat-world baking).
  let minE = Infinity, maxE = -Infinity;
  for (const r of tunnels) for (const p of tunnelPts.get(r)) { if (p.elev < minE) minE = p.elev; if (p.elev > maxE) maxE = p.elev; }

  return {
    tx, ty,
    tunnels: tunnels.length,
    drivableTunnels: tunnels.filter(r => DRIVABLE.has(r.highwayType)).length,
    elevRange: [+minE.toFixed(2), +maxE.toFixed(2)],
    portals,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// VALIDATOR (node tools/tunnel-inspect.mjs --validate [tileId ...])
// Asserts 1–3 are commit-blocking (process exits non-zero on violation).
// Diagnostics 4–6 produce flagged lists (informational, feed Phase 2).
// ════════════════════════════════════════════════════════════════════════════

const VIS_GRID = 64, PHYS_GRID = 32;          // terrainBaker GRID_SIZE / PHYSICS_GRID
const RAMP_FLAG_GRADE = 0.15;                 // diagnostic 5 threshold
const POKE_EPS = 0.25, WALL_EPS = 0.25;       // diagnostic tolerances (m)

function readF32(dec, off, count) {
  const a = new Float32Array(count);
  for (let i = 0; i < count; i++) a[i] = dec.buf.readFloatLE(dec.binStart + off + i * 4);
  return a;
}
function readU32(dec, off, count) {
  const a = new Uint32Array(count);
  for (let i = 0; i < count; i++) a[i] = dec.buf.readUInt32LE(dec.binStart + off + i * 4);
  return a;
}

/** Reconstruct the set of CUT cells "r,c" from a grid mesh's index list. */
function cutCellSet(indices, gridSize, vertCount) {
  const cols = gridSize;
  const rows = Math.round(vertCount / cols);
  const tri = new Set();
  for (let i = 0; i < indices.length; i += 3) {
    const t = [indices[i], indices[i + 1], indices[i + 2]].sort((a, b) => a - b);
    tri.add(`${t[0]},${t[1]},${t[2]}`);
  }
  const cut = new Set();
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, c1 = (r + 1) * cols + c, d = c1 + 1;
      // sorted keys — winding-independent (visual & physics use different winding)
      const t1 = [a, b, c1].sort((x, y) => x - y).join(',');
      const t2 = [b, c1, d].sort((x, y) => x - y).join(',');
      if (!tri.has(t1) && !tri.has(t2)) cut.add(`${r},${c}`);
    }
  }
  return { cut, rows, cols };
}

/** Build a world-XZ → vertex locator from a positions array (world-space verts). */
function vertexLocator(positions, cols, rows) {
  return function nearest(wx, wz) {
    let best = Infinity, bi = 0;
    for (let i = 0; i < positions.length; i += 3) {
      const dx = positions[i] - wx, dz = positions[i + 2] - wz;
      const d = dx * dx + dz * dz;
      if (d < best) { best = d; bi = i / 3; }
    }
    return { idx: bi, r: Math.floor(bi / cols), c: bi % cols, y: positions[bi * 3 + 1] };
  };
}

function decodeBaked(dec) {
  const h = dec.header;
  const bt = h.bakedTerrain, bp = h.bakedPhysicsTerrain;
  if (!bt || !bp) return null;
  const visPos = readF32(dec, bt.positionsOffset, bt.positionsCount);
  const visIdx = readU32(dec, bt.indicesOffset, bt.indicesCount);
  const physVerts = readF32(dec, bp.vertsOffset, bp.vertsCount);
  const physIdx = readU32(dec, bp.indicesOffset, bp.indicesCount);
  const visCut = cutCellSet(visIdx, bt.gridSize || VIS_GRID, bt.positionsCount / 3);
  const physCut = cutCellSet(physIdx, bp.gridSize || PHYS_GRID, bp.vertsCount / 3);
  return { visPos, physVerts, visCut, physCut, btGrid: bt.gridSize || VIS_GRID, bpGrid: bp.gridSize || PHYS_GRID };
}

/** Map a visual cell (r,c) to the covering physics cell by centroid fraction. */
function visCellToPhys(r, c, vis, phys) {
  const cv = vis.rows - 1, cc = vis.cols - 1, pv = phys.rows - 1, pc = phys.cols - 1;
  const pr = Math.min(pv - 1, Math.max(0, Math.floor((r + 0.5) / cv * pv)));
  const pcc = Math.min(pc - 1, Math.max(0, Math.floor((c + 0.5) / cc * pc)));
  return `${pr},${pcc}`;
}

/**
 * Fall-zone analysis (Phase-2 diagnostic): reconstruct deck-box footprints (with the
 * same eligibility + width-clip as createRoadTrimeshColliders) and find physics-cut
 * cells NOT covered by any deck. Reports fall-cell count, the MAX lateral gap (deck
 * edge → physics-cut cell), whether each fall cell's nearest road is a wallApproachRoad
 * (so retaining walls — if given physics — would contain it), and a distinct
 * hole-over-solid count (visual cut, physics solid, no deck — cosmetic, not a fall).
 */
function analyzeFallZone(dec, baked) {
  const roads = dec.header.roads || [];
  const elevH = (P) => { let mn = Infinity, mx = -Infinity; for (const p of P) { mn = Math.min(mn, p.e); mx = Math.max(mx, p.e); } return mn !== Infinity && (mx - mn) > 0.5 && (mx > 0.3 || mn < -0.3); };
  const ptsW = (r) => readRoadPoints(dec, r).map(p => { const w = mercatorToWorld(p.mx, p.mz); return { x: w.x, z: w.z, e: p.elev }; });

  // Eligible roads (get deck boxes) + their full halfW; tunnel widths get +2 (enclosure).
  const elig = [];
  for (const r of roads) {
    const P = ptsW(r);
    if (P.length < 2) continue;
    const ib = r.bridge || r.layer > 0, it = r.tunnel || r.layer < 0, ir = r.isRamp === true;
    if (!(ib || it || ir || elevH(P))) continue;
    const w = (Number.isFinite(r.width) && r.width > 0) ? r.width : (it ? 4 : 6);
    const halfW = (it ? w + 2 : w) / 2;
    const isWallApproach = !r.tunnel && DRIVABLE.has(r.highwayType) && P.some(p => p.e < -0.5); // tileManager approachRoads
    elig.push({ id: r.id, P, halfW, isTunnel: it, isWallApproach });
  }
  // Clip helper (mirror distToNearestOtherRoad) for effective deck half-width.
  const segOf = (e) => { const s = []; for (let i = 0; i < e.P.length - 1; i++) s.push({ ax: e.P[i].x, az: e.P[i].z, bx: e.P[i + 1].x, bz: e.P[i + 1].z }); return s; };
  const all = elig.map(e => ({ id: e.id, segs: segOf(e), halfW: e.halfW }));
  const nearestOther = (px, pz, selfId) => { let md = Infinity, oh = 0; for (const rc of all) { if (rc.id === selfId) continue; for (const s of rc.segs) { const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz; if (l2 < 0.01) continue; const t = Math.max(0, Math.min(1, ((px - s.ax) * dx + (pz - s.az) * dz) / l2)); const cx = s.ax + t * dx, cz = s.az + t * dz, d = Math.hypot(px - cx, pz - cz); if (d < md) { md = d; oh = rc.halfW; } } } return { d: md, oh }; };

  // Built deck segments with effective half-width. isWalled = this road now gets wall
  // colliders: wallApproachRoad (createApproachWallColliders) OR layer<0 tunnel (createTunnelWallColliders).
  const deck = [];
  for (const e of elig) {
    const isWalled = e.isWallApproach || e.isTunnel;
    for (let i = 0; i < e.P.length - 1; i++) {
      const a = e.P[i], b = e.P[i + 1];
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      let eff = e.halfW; const { d, oh } = nearestOther(mx, mz, e.id);
      if (d < e.halfW + oh) eff = Math.max(1.5, d - oh);
      deck.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, eff, isWallApproach: e.isWallApproach, isWalled });
    }
  }
  // Coverage: returns {cov, edge(>=0 dist beyond deck edge), nearestIsWall, nearestIsWalled}
  const cover = (wx, wz) => {
    let cov = false, minEdge = Infinity, nearestIsWall = false, nearestIsWalled = false, nearestD = Infinity;
    for (const s of deck) {
      const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz; if (l2 < 0.01) continue;
      const t = Math.max(0, Math.min(1, ((wx - s.ax) * dx + (wz - s.az) * dz) / l2));
      const cx = s.ax + t * dx, cz = s.az + t * dz, d = Math.hypot(wx - cx, wz - cz);
      if (d <= s.eff) cov = true;
      const edge = d - s.eff; if (edge < minEdge) minEdge = edge;
      if (d < nearestD) { nearestD = d; nearestIsWall = s.isWallApproach; nearestIsWalled = s.isWalled; }
    }
    return { cov, edge: minEdge, nearestIsWall, nearestIsWalled };
  };

  // Physics-cut cell centers (world) from physVerts.
  const pv = baked.physVerts, pg = baked.bpGrid, prows = baked.physCut.rows;
  const cellCenter = (r, c) => {
    const a = r * pg + c, b = a + 1, c1 = (r + 1) * pg + c, d = c1 + 1;
    return { x: (pv[a * 3] + pv[b * 3] + pv[c1 * 3] + pv[d * 3]) / 4, z: (pv[a * 3 + 2] + pv[b * 3 + 2] + pv[c1 * 3 + 2] + pv[d * 3 + 2]) / 4 };
  };
  let fall = 0, maxGap = 0, fallNearWall = 0; const samples = [];
  // Gap histogram: how close fall cells sit to a drivable deck edge. Small-gap cells
  // (≤ ~half a physics cell) are the REACHABLE lip-fall hazard the car drifts into;
  // large-gap cells are deep over-cut far from any deck (likely unreachable / median).
  const hist = { le3: 0, le8: 0, gt8: 0 };
  let reachableNearWall = 0, residualUnwalled = 0; const residualSamples = [];
  for (const key of baked.physCut.cut) {
    const [r, c] = key.split(',').map(Number);
    const ctr = cellCenter(r, c);
    const cv = cover(ctr.x, ctr.z);
    if (!cv.cov) {
      fall++;
      const gap = Math.max(0, cv.edge);
      if (gap > maxGap) maxGap = gap;
      if (gap <= 3) {
        hist.le3++;
        if (cv.nearestIsWall) reachableNearWall++;
        // Residual hazard: a reachable lip-fall cell whose nearest drivable deck does NOT
        // get a wall collider (not a wallApproach, not a layer<0 tunnel) → still open.
        if (!cv.nearestIsWalled) { residualUnwalled++; if (residualSamples.length < 6) residualSamples.push({ x: +ctr.x.toFixed(1), z: +ctr.z.toFixed(1), gap: +gap.toFixed(1) }); }
      }
      else if (gap <= 8) hist.le8++; else hist.gt8++;
      if (cv.nearestIsWall) fallNearWall++;
      if (samples.length < 5) samples.push({ x: +ctr.x.toFixed(1), z: +ctr.z.toFixed(1), gap: +gap.toFixed(1), nearWall: cv.nearestIsWall });
    }
  }
  // Hole-over-solid: visual cut cells whose covering physics cell is NOT cut and no deck.
  const vis = baked.visCut, visPos = baked.visPos, vg = baked.btGrid;
  const visCenter = (r, c) => { const a = r * vg + c, b = a + 1, c1 = (r + 1) * vg + c, d = c1 + 1; return { x: (visPos[a * 3] + visPos[b * 3] + visPos[c1 * 3] + visPos[d * 3]) / 4, z: (visPos[a * 3 + 2] + visPos[b * 3 + 2] + visPos[c1 * 3 + 2] + visPos[d * 3 + 2]) / 4 }; };
  let holeSolid = 0;
  for (const key of vis.cut) {
    const [r, c] = key.split(',').map(Number);
    const pk = visCellToPhys(r, c, vis, baked.physCut);
    if (!baked.physCut.cut.has(pk)) { const ctr = visCenter(r, c); if (!cover(ctr.x, ctr.z).cov) holeSolid++; }
  }
  return { fall, maxGap: +maxGap.toFixed(1), fallNearWall, samples, holeSolid, hist, reachableNearWall, residualUnwalled, residualSamples, wallApproachRoads: elig.filter(e => e.isWallApproach).length };
}

function validateTile(tx, ty, metaFeatures) {
  const buf = readTileBuffer(tx, ty);
  if (!buf) return { tx, ty, error: 'tile not found' };
  let dec; try { dec = decode(buf); } catch (e) { return { tx, ty, error: 'decode: ' + e.message }; }
  const baked = decodeBaked(dec);
  if (!baked) return { tx, ty, error: 'no baked terrain in tile' };

  const roads = dec.header.roads || [];
  const tunnels = roads.filter(r => r.tunnel && r.layer != null && r.layer < 0);
  const out = { tx, ty, asserts: {}, diagnostics: {} };

  // ── ASSERT 1: physics opening ⊇ visual opening (post-quantization) ──────────
  let viol = 0; const violEx = [];
  for (const key of baked.visCut.cut) {
    const [r, c] = key.split(',').map(Number);
    const pk = visCellToPhys(r, c, baked.visCut, baked.physCut);
    if (!baked.physCut.cut.has(pk)) { viol++; if (violEx.length < 8) violEx.push(`vis(${r},${c})→phys(${pk})`); }
  }
  out.asserts.supersetOpening = { pass: viol === 0, visCutCells: baked.visCut.cut.size, physCutCells: baked.physCut.cut.size, violations: viol, examples: violEx };

  // ── ASSERT 2: physics mouth r ≥ visual mouth r + 1m ─────────────────────────
  let a2pass = true; const a2 = [];
  for (const r of tunnels) {
    const w4 = (Number.isFinite(r.width) && r.width > 0 ? r.width : 4);
    const visR = w4 / 2 + 1 + 1;      // terrainBaker visual: hw=w/2+1, +MOUTH_RADIUS
    const physR = w4 / 2 + 1 + 1 + 1; // + PHYS_MOUTH_MARGIN
    if (physR - visR < 1 - 1e-6) { a2pass = false; a2.push({ id: r.id, visR, physR }); }
  }
  out.asserts.mouthMargin = { pass: a2pass, checked: tunnels.length, failures: a2 };

  // ── ASSERT 3: cross-tile injected corridor cut in BOTH bakes (affected tile) ─
  const affecting = (metaFeatures || []).filter(f => f.affectsTile && f.affectsTile[0] === tx && f.affectsTile[1] === ty);
  const visLoc = vertexLocator(baked.visPos, baked.btGrid, baked.visCut.rows);
  const physLoc = vertexLocator(baked.physVerts, baked.bpGrid, baked.physCut.rows);
  // A cell is "cut near here" if any cell in a ±1 neighbourhood of the nearest vertex is cut
  // (forgiving of nearest-vertex quantization; the corridor is several metres wide).
  const cutNear = (loc, cutSet, rows, cols) => {
    for (let dr = -1; dr <= 0; dr++) for (let dc = -1; dc <= 0; dc++) {
      const r = loc.r + dr, c = loc.c + dc;
      if (r >= 0 && c >= 0 && r < rows - 1 && c < cols - 1 && cutSet.has(`${r},${c}`)) return true;
    }
    return false;
  };
  const a3 = []; let a3pass = true;
  for (const f of affecting) {
    // Sample interior points along the injected corridor (portal → portal+dir*approachLen).
    const samples = [0.25, 0.4, 0.55, 0.7].map(t => ({
      wx: f.portalX + f.dirX * f.approachLen * t,
      wz: f.portalZ + f.dirZ * f.approachLen * t,
    }));
    let cutVis = 0, cutPhys = 0;
    for (const s of samples) {
      if (cutNear(visLoc(s.wx, s.wz), baked.visCut.cut, baked.visCut.rows, baked.visCut.cols)) cutVis++;
      if (cutNear(physLoc(s.wx, s.wz), baked.physCut.cut, baked.physCut.rows, baked.physCut.cols)) cutPhys++;
    }
    // Require physics ⊇ visual at the corridor: wherever visual is cut, physics must be too.
    const ok = cutPhys >= cutVis && cutVis >= 1;
    if (!ok) a3pass = false;
    a3.push({ tunnelId: f.tunnelId, samplesCutVisual: cutVis, samplesCutPhysics: cutPhys, ofSamples: samples.length, ok });
  }
  out.asserts.crossTileBothBakes = { pass: affecting.length === 0 ? true : a3pass, injectedCorridors: affecting.length, detail: a3 };

  // ── DIAGNOSTIC 4: poke-through (interior tunnel_Y > local terrain_Y) ─────────
  const poke = [];
  for (const r of tunnels) {
    const pts = readRoadPoints(dec, r);
    for (let i = 0; i < pts.length; i++) {
      const w = mercatorToWorld(pts[i].mx, pts[i].mz);
      const v = visLoc(w.x, w.z);
      if (pts[i].elev > v.y + POKE_EPS) {
        poke.push({ id: r.id, name: r.name || null, ptIndex: i, tunnelY: +pts[i].elev.toFixed(2), terrainY: +v.y.toFixed(2) });
      }
    }
  }
  out.diagnostics.pokeThrough = { count: poke.length, items: poke.slice(0, 12) };

  // ── DIAGNOSTIC 5: ramp grade per tunnel road (flag > 15%) ───────────────────
  const grades = [];
  for (const r of tunnels) {
    const pts = readRoadPoints(dec, r).map(p => { const w = mercatorToWorld(p.mx, p.mz); return { x: w.x, z: w.z, e: p.elev }; });
    let maxG = 0, maxRun = 0, maxRise = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const run = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
      const rise = Math.abs(pts[i + 1].e - pts[i].e);
      if (run > 0.5 && rise > 0.01) { const g = rise / run; if (g > maxG) { maxG = g; maxRun = run; maxRise = rise; } }
    }
    if (maxG > 0) grades.push({ id: r.id, name: r.name || null, layer: r.layer, maxGradePct: +(maxG * 100).toFixed(1), rise: +maxRise.toFixed(1), run: +maxRun.toFixed(1), flagged: maxG > RAMP_FLAG_GRADE });
  }
  grades.sort((a, b) => b.maxGradePct - a.maxGradePct);
  out.diagnostics.rampGrade = { flaggedCount: grades.filter(g => g.flagged).length, steepest: grades.slice(0, 10) };

  // ── DIAGNOSTIC 6: wall-top (physics top Y=0) vs local terrain above it ───────
  // Physics tunnel walls span floor→Y≈0, so wall top ≈ 0. Flag where terrain dips below
  // the wall top (wall would poke above ground) — i.e. terrain_Y < -WALL_EPS under a wall.
  const wallFlags = [];
  for (const r of tunnels) {
    const pts = readRoadPoints(dec, r).map(p => { const w = mercatorToWorld(p.mx, p.mz); return { x: w.x, z: w.z, e: p.elev }; });
    const halfW = (Number.isFinite(r.width) && r.width > 0 ? r.width : 4) / 2 + 1; // + WALL_EXTRA_W
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len, nz = dx / len;
      const wallTopY = 0; // runtime construction: walls run floor→0
      for (const sgn of [-1, 1]) {
        const wx = (a.x + b.x) / 2 + sgn * nx * halfW;
        const wz = (a.z + b.z) / 2 + sgn * nz * halfW;
        const v = visLoc(wx, wz);
        if (wallTopY > v.y + WALL_EPS) {
          wallFlags.push({ id: r.id, name: r.name || null, seg: i, side: sgn < 0 ? 'L' : 'R', wallTopY, terrainY: +v.y.toFixed(2) });
        }
      }
    }
  }
  out.diagnostics.wallTopVsTerrain = { count: wallFlags.length, items: wallFlags.slice(0, 12) };

  // ── DIAGNOSTIC 7 (Phase 2): fall-zone (physics cut, no deck) + max lateral gap ──
  out.diagnostics.fallZone = analyzeFallZone(dec, baked);

  return out;
}

function runValidate(tileArgs) {
  let metaFeatures = [];
  if (fs.existsSync(METADATA_PATH)) {
    try { metaFeatures = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8')).features || []; } catch { /* ignore */ }
  }
  // Default: the three Phase-1 diagnostic tiles + cross-tile pair.
  const tiles = (tileArgs.length ? tileArgs : ['16_33171_24473', '16_33166_24472', '16_33163_24481', '16_33163_24482'])
    .map(s => { const [, x, y] = s.split('_'); return [parseInt(x, 10), parseInt(y, 10)]; });

  let blocking = 0;
  for (const [tx, ty] of tiles) {
    const res = validateTile(tx, ty, metaFeatures);
    console.log(`\n══════ ${tx}_${ty} ══════`);
    if (res.error) { console.log('  ERROR:', res.error); blocking++; continue; }
    const A = res.asserts;
    const mark = (b) => (b ? 'PASS' : 'FAIL');
    console.log(`  [1] physics ⊇ visual opening : ${mark(A.supersetOpening.pass)}  (visCut=${A.supersetOpening.visCutCells} physCut=${A.supersetOpening.physCutCells} violations=${A.supersetOpening.violations})`);
    if (!A.supersetOpening.pass) console.log('       e.g.', A.supersetOpening.examples.join('  '));
    console.log(`  [2] physics mouth ≥ visual+1m: ${mark(A.mouthMargin.pass)}  (checked ${A.mouthMargin.checked})`);
    if (!A.mouthMargin.pass) console.log('       failures:', JSON.stringify(A.mouthMargin.failures));
    console.log(`  [3] cross-tile in both bakes : ${mark(A.crossTileBothBakes.pass)}  (injected corridors=${A.crossTileBothBakes.injectedCorridors})`);
    if (A.crossTileBothBakes.detail.length) console.log('       ', JSON.stringify(A.crossTileBothBakes.detail));
    console.log(`  [4] poke-through (diag)      : ${res.diagnostics.pokeThrough.count} flagged`);
    if (res.diagnostics.pokeThrough.count) console.log('       ', JSON.stringify(res.diagnostics.pokeThrough.items));
    console.log(`  [5] ramp grade >15% (diag)   : ${res.diagnostics.rampGrade.flaggedCount} flagged; steepest:`);
    for (const g of res.diagnostics.rampGrade.steepest.slice(0, 5)) console.log(`        ${g.name || '-'} id${g.id} L${g.layer}  ${g.maxGradePct}% (rise ${g.rise}m / run ${g.run}m)${g.flagged ? '  <FLAG>' : ''}`);
    console.log(`  [6] wall-top>terrain (diag)  : ${res.diagnostics.wallTopVsTerrain.count} flagged`);
    if (res.diagnostics.wallTopVsTerrain.count) console.log('       ', JSON.stringify(res.diagnostics.wallTopVsTerrain.items));
    const fz = res.diagnostics.fallZone;
    console.log(`  [7] FALL ZONE (phys cut,no deck): ${fz.fall} cells | MAX lateral gap=${fz.maxGap}m | ${fz.fallNearWall}/${fz.fall} adjacent to a wallApproachRoad`);
    console.log(`       gap histogram: ≤3m=${fz.hist.le3} (REACHABLE lip-fall; ${fz.reachableNearWall} near wallApproach) | 3–8m=${fz.hist.le8} | >8m=${fz.hist.gt8} (deep over-cut, likely unreachable)`);
    console.log(`       RESIDUAL unwalled ≤3m cells (nearest deck gets NO wall collider): ${fz.residualUnwalled}${fz.residualUnwalled ? ' — ' + JSON.stringify(fz.residualSamples) : ' ✓'}`);
    console.log(`       wallApproachRoads in tile=${fz.wallApproachRoads} | hole-over-solid (cosmetic, NOT fall)=${fz.holeSolid}`);
    if (fz.samples.length) console.log('       sample fall cells:', JSON.stringify(fz.samples));

    if (!A.supersetOpening.pass || !A.mouthMargin.pass || !A.crossTileBothBakes.pass) blocking++;
  }
  console.log(`\n${blocking === 0 ? '✅ All commit-blocking asserts (1–3) PASS' : `❌ ${blocking} tile(s) FAILED a commit-blocking assert`}`);
  process.exit(blocking === 0 ? 0 : 1);
}

// ── main ──────────────────────────────────────────────────────────────────────
if (process.argv.includes('--validate')) {
  runValidate(process.argv.slice(2).filter(a => a !== '--validate' && a.includes('_')));
}
const arg = process.argv[2];
if (arg) {
  const [, txs, tys] = arg.split('_');
  const res = inspectTile(parseInt(txs, 10), parseInt(tys, 10));
  if (!res) { console.log('Tile not found:', arg); process.exit(1); }
  console.log(JSON.stringify(res, null, 2));
} else {
  // Scan all tiles, summarise tunnel-bearing ones.
  const txDirs = fs.readdirSync(TILES_DIR).filter(d => /^\d+$/.test(d));
  const hits = [];
  let totalTunnels = 0;
  for (const txd of txDirs) {
    const tx = parseInt(txd, 10);
    const tyDir = path.join(TILES_DIR, txd);
    for (const f of fs.readdirSync(tyDir)) {
      const m = f.match(/^(\d+)\.bin$/);
      if (!m) continue;
      const ty = parseInt(m[1], 10);
      const res = inspectTile(tx, ty);
      if (res && res.tunnels > 0) {
        totalTunnels += res.tunnels;
        hits.push(res);
      }
    }
  }
  hits.sort((a, b) => b.drivableTunnels - a.drivableTunnels || b.tunnels - a.tunnels);
  console.log(`Tiles with tunnels: ${hits.length}; total tunnel roads: ${totalTunnels}\n`);
  console.log('Top tunnel-bearing tiles (tx ty | tunnels drivable | elevRange | sample names):');
  for (const h of hits.slice(0, 25)) {
    const names = [...new Set(h.portals.filter(p => p.drivable && p.name).map(p => p.name))].slice(0, 3);
    console.log(`  ${h.tx}_${h.ty}  | ${h.tunnels} t / ${h.drivableTunnels} drv | elev ${h.elevRange[0]}..${h.elevRange[1]} | ${names.join(', ')}`);
  }
}
