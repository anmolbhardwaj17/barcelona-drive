#!/usr/bin/env node
/**
 * World builder: OSM PBF -> static slippy tiles (tile format v5).
 * Uses REGION_CONFIG from config.js. Output: tiles/{regionName}/{z}/{x}/{y}.json
 *
 * Pipeline (phase1Pure2D / flat world):
 *   PBF parse -> road graph -> ramp resolver -> simplify -> spatial index.
 *   Per tile: query index -> clone subset -> topology normalize ->
 *   clip -> write (flat terrain grid, road Y from OSM layer/bridge/tunnel tags + ramp interpolation).
 *
 * Road Y values: normal=0, bridge=+6m, tunnel=-6m, layer*6m. Ramps smoothly interpolate at bridge approaches.
 * Terrain grid: all zeros (flat world). DEM support removed; re-add demLoader.js when needed.
 *
 * Tile v5 schema:
 *   version: 5
 *   tileId: "16_x_y"
 *   elevation: { resolution, data (all 0), min, max, south, west, north, east, gridRows, gridCols, elevations }
 *   roads: [{ id, points: [[x,yUp,z],...], elevation: [0,...], width, bridge, tunnel, layer, highwayType }]
 *   buildings: [{ id, footprint: [[x,z],...], height, levels, type, name, roofShape }]
 *   greens: [{ id, polygon: [[x,z],...], type }]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { REGION_CONFIG } from './config.js';
import { buildTrenchCorridors, carveTrenchesIntoGrid, flagTrenchCrossings, flagFloatersOverCarve } from './terrain/trenchAuthor.js';
import { collectTunnelFloorViolations, reportTunnelFloorValidation } from './terrain/validateTunnelFloors.js';

// ── Broken/incomplete-ramp road skip (vibe > survey accuracy; user-approved 2026-06-30) ──
// A layered/ramp road whose ramp couldn't be resolved (RampResolver Case-C "flattened" short
// tunnels between surface roads at different layers stretch a too-steep linear ramp; one-sided
// layer transitions leave a vertical crack) renders as a mangled half-ramp with broken lane
// lines. Better a clean gap than a mangled road. Detect by max along-road grade exceeding the
// ramp limit; EXCLUDE drivable below-grade tunnel corridors (carved into the trench grid by
// trenchAuthor — dropping one orphans the cut; they have proper ≤0.15 profiles anyway).
const _BROKEN_RAMP_GRADE = Number.isFinite(parseFloat(process.env.BROKEN_RAMP_GRADE)) ? parseFloat(process.env.BROKEN_RAMP_GRADE) : 0.60;
const _BR_K_UNSTRETCH = Math.cos((41.350 * Math.PI) / 180);
const _BR_R_EARTH = 6378137;
const _BR_DRIVABLE_TUNNEL = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street',
]);
// Measures the PROFILE grade (layer-relative height = absolute p[3] minus DEM), NOT absolute grade,
// so terrain slope is removed — a legit ramp/bridge on a hillside is NOT flagged; only a ramp whose
// PROFILE rises/falls faster than the ramp builder's cap (≤0.15) is. demSampler required; without it
// the check is skipped (keeps everything).
function isBrokenRampRoad(r, demSampler) {
  // Keep drivable below-grade tunnel corridors no matter what (trench-carved; orphan cut if dropped).
  if (r.tunnel && r.layer != null && r.layer < 0 && _BR_DRIVABLE_TUNNEL.has(r.highwayType)) return false;
  // PRIMARY signal: RampResolver's own flag for the Case-C mangled steep connector (short tunnel
  // between surface roads at DIFFERENT layers it couldn't fit a dip for). Precise — no false positives
  // on legit steep ramps. This replaces the old grade>0.20 heuristic that dropped 608 (over-aggressive).
  if (r.brokenRamp === true) return true;
  if (!demSampler) return false;
  // BACKSTOP for one-sided layer-transition cracks (near-vertical PROFILE step the flag misses). Very
  // high threshold so a legit steep ramp / short bridge is NEVER dropped here — only true cliffs.
  if (!(r.bridge || r.tunnel || r.isRamp || (r.layer != null && r.layer !== 0))) return false;
  const pts = r.points;
  if (!pts || pts.length < 2) return false;
  const profOf = (p) => {
    const lon = (p[0] / _BR_R_EARTH) * (180 / Math.PI);
    const lat = (2 * Math.atan(Math.exp(p[2] / _BR_R_EARTH)) - Math.PI / 2) * (180 / Math.PI);
    const dem = demSampler.sampleElevation(lat, lon);
    const abs = (p.length >= 4 && Number.isFinite(p[3])) ? p[3] : p[1];
    return abs - (Number.isFinite(dem) ? dem : 0); // layer-relative profile (terrain removed)
  };
  let maxGrade = 0;
  let prevProf = profOf(pts[0]);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const run = Math.hypot(b[0] - a[0], b[2] - a[2]) * _BR_K_UNSTRETCH;
    const profB = profOf(b);
    if (run >= 0.5) {
      const g = Math.abs(profB - prevProf) / run;
      if (g > maxGrade) maxGrade = g;
    }
    prevProf = profB;
  }
  return maxGrade > _BROKEN_RAMP_GRADE;
}
import { parsePbfHighways } from './pbfHighways.js';
import { parsePbfBuildings } from './pbfBuildings.js';
import { parsePbfGreens } from './pbfGreens.js';
import { parsePbfWater } from './pbfWater.js';
import { parsePbfBarriers } from './pbfBarriers.js';
import { parsePbfBusStops } from './pbfBusStops.js';
import { parsePbfRailways } from './pbfRailways.js';
import { parsePbfParking } from './pbfParking.js';
import { parsePbfUrbanFeatures, deduplicateUrbanFeatures } from './pbfUrbanFeatures.js';
import { normalizeBuilding, splitBuildingsByTile } from './buildingNormalize.js';
import { normalizeGreen, splitGreensByTile } from './greenNormalize.js';
import { normalizeWater, splitWatersByTile } from './waterNormalize.js';
import { douglasPeucker } from './simplify.js';
import { buildRoadIndex } from './roads/roadSpatialIndex.js';
import { normalizeRoadTopology } from './roads/roadTopologyNormalizer.js';
import { resampleRoads } from './roads/roadResampler.js';
import { tileMercatorBounds, clipRoadsForTile, roadsForTileNoClip } from './tileSplit.js';
import { buildFromWays } from './roads/RoadGraph.js';
import { resolveRamps } from './roads/RampResolver.js';
import { resolveBridgeToBridge } from './roads/BridgeToBridgeResolver.js';
import { fixOsmData } from './roads/OsmDataFixer.js';
import { buildRoadGeometry } from './roads/RoadGeometryBuilder.js';
import { clipPathsAgainstCarriageways } from './roads/pathCoverageClipper.js';
import { bakeSidewalks } from './sidewalkBaker.js';
import { bakeAoGrid, gatherAoOccluders } from './aoBaker.js';
import { classifyJunctions } from './junctions/JunctionClassifier.js';
import { buildMergeGeometry } from './junctions/MergeGeometryBuilder.js';
import { tileToBBox, latLonToTile, mercatorToWorld, worldToMercator, mercatorToLatLon, getOriginMercator, latLonToMercator } from '../projection.js';
import { convertTile } from './convertToBinary.js';
import { bakeTerrainMesh, bakePhysicsTerrain } from './terrainBaker.js';
import { bakeVegetation } from './vegetationBaker.js';
import { bakeRoadSurfaces } from './roadBaker.js';
import { loadDEM } from './demLoader.js';
import { parsePbfAreaFeatures, normalizeAreaFeature, splitAreaFeaturesByTile } from './pbfAreaFeatures.js';
import { parsePbfPointFeatures, SHOP_CATEGORY } from './pbfPointFeatures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DRIVABLE = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
  'residential', 'service', 'unclassified',
]);
const MIN_WIDTH = 4;
const MAX_WIDTH = 20;
const WIDTH_BY_TYPE = {
  motorway: 16, trunk: 14, primary: 12, secondary: 10, tertiary: 8,
  motorway_link: 10, trunk_link: 10, primary_link: 8, secondary_link: 8, tertiary_link: 6,
  residential: 6, service: 4, unclassified: 6,
};
const LANES_BY_TYPE = {
  motorway: 4, trunk: 3, primary: 2, secondary: 2, tertiary: 2,
  motorway_link: 2, trunk_link: 2, primary_link: 1, secondary_link: 1, tertiary_link: 1,
  residential: 1, service: 1, unclassified: 1,
};

function getTag(tags, key, def = '') {
  return tags && tags[key] != null ? String(tags[key]).trim() : def;
}
function parseIntStrict(str, fallback) {
  if (str == null || str === '') return fallback;
  const n = parseInt(String(str), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function parseNumeric(str, fallback) {
  if (str == null || str === '') return fallback;
  const m = String(str).match(/^[\d.]+/);
  return m ? parseFloat(m[0]) : fallback;
}
function getWidth(tags, highwayType, lanes) {
  const widthTag = getTag(tags, 'width');
  if (widthTag) {
    const w = parseNumeric(widthTag, null);
    if (w != null && w > 0) return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w));
  }
  const lanesTag = parseIntStrict(getTag(tags, 'lanes'), null);
  const L = lanesTag != null ? lanesTag : lanes;
  if (L != null && L > 0) return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, L * 3.5));
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, WIDTH_BY_TYPE[highwayType] ?? 6));
}
function getLanes(tags, highwayType) {
  const lanesTag = parseIntStrict(getTag(tags, 'lanes'), null);
  return lanesTag != null && lanesTag > 0 ? lanesTag : (LANES_BY_TYPE[highwayType] ?? 1);
}

function polylineLength(pts) {
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    len += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][2] - pts[i][2]);
  }
  return len;
}

function parseCliBbox(cfg) {
  const argv = process.argv.slice(2);
  const getArg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] != null ? argv[i + 1] : null;
  };
  const areaName = getArg('--area');
  if (areaName && cfg.testAreaPresets?.[areaName]) {
    return { ...cfg.testAreaPresets[areaName], fromCli: true, areaPreset: areaName };
  }
  const minLon = getArg('--minLon');
  const maxLon = getArg('--maxLon');
  const minLat = getArg('--minLat');
  const maxLat = getArg('--maxLat');
  if (minLon != null || maxLon != null || minLat != null || maxLat != null) {
    return {
      minLon: minLon != null ? parseFloat(minLon) : cfg.bbox.minLon,
      maxLon: maxLon != null ? parseFloat(maxLon) : cfg.bbox.maxLon,
      minLat: minLat != null ? parseFloat(minLat) : cfg.bbox.minLat,
      maxLat: maxLat != null ? parseFloat(maxLat) : cfg.bbox.maxLat,
      fromCli: true,
    };
  }
  return null;
}

function deepCloneRoad(road) {
  return {
    id: road.id,
    nodeIds: road.nodeIds ? [...road.nodeIds] : [],
    points: road.points.map((p) => [...p]),
    width: road.width,
    bridge: road.bridge,
    tunnel: road.tunnel,
    layer: road.layer,
    highwayType: road.highwayType,
    serviceSubtype: road.serviceSubtype || null,
    closedLoop: road.closedLoop,
    isRamp: road.isRamp,
    brokenRamp: road.brokenRamp || false, // Case-C mangled steep connector → dropped at payload chokepoint
    isRoundabout: road.isRoundabout || false,
    crossesTrench: road.crossesTrench || false, // OPTION L: street above a daylighted tunnel corridor → deck colliders
    name: road.name || '',
  };
}

/**
 * Phase B.2 — Cross-tile tunnel approach pre-pass.
 *
 * Scans ALL tunnel roads across the region, identifies true portal endpoints
 * (endpoint shared by exactly one tunnel segment = surface-to-underground transition),
 * then determines whether each portal's 80m outward approach corridor crosses into a
 * different tile. If so, emits a tunnel_approach feature into the in-memory map so
 * that tile's terrainBaker receives the correct approachSegment.
 *
 * Also writes backend/tiles/{region}/{zoom}/_metadata.json as a bake audit artifact
 * (NOT fetched by the frontend; purely for debugging and future reference).
 *
 * @param {Array} allRoads - Full simplified road array (region-wide, pre-spatial-index).
 * @param {number} zoom - Tile zoom level (16).
 * @param {string} outDir - Output directory (backend/tiles/{region}).
 * @returns {Map<string, object[]>} Map keyed by "tx_ty" of the affectsTile → feature array.
 */
function buildCrossTileMetadata(allRoads, zoom, outDir) {
  const TRENCH_LEN = 80;        // must match terrainBaker.js TRENCH_LEN
  const APPROACH_RAMP_CUT_MARGIN = 2.5; // must match terrainBaker.js constant
  const JUNCTION_TOL = 3;       // endpoint snap tolerance (metres)

  // Exclude non-drivable tunnel types from terrain cut pre-pass.
  // corridor/platform/busway/track are pedestrian passages, transit platforms, and agricultural
  // tracks — not drivable roads. They contaminate the pre-pass and produce spurious cut entries.
  // WHITELIST of real drivable-road tunnels (matches the runtime DRIVABLE_TUNNEL_TYPES). Only these are
  // detected as tunnels / generate approaches / carve terrain — footway/steps/path/pedestrian/cycleway/
  // service tunnels are NOT modelled as drivable and must not cut the hill (the "land crack" artifact).
  const DRIVABLE_TUNNEL_TYPES = new Set([
    'motorway', 'motorway_link', 'trunk', 'trunk_link',
    'primary', 'primary_link', 'secondary', 'secondary_link',
    'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street',
  ]);
  const tunnelRoads = allRoads.filter(r => r.tunnel && r.points && r.points.length >= 2
    && DRIVABLE_TUNNEL_TYPES.has(r.highwayType));

  // Convert Mercator point [mercX, yUp, mercZ] → world {x, z}
  const toWorld = (p) => {
    const w = mercatorToWorld(p[0], p[2]);
    return { x: w.x, z: w.z };
  };

  // World position → lat/lon → tile key
  const worldToTileKey = (wx, wz) => {
    const origin = getOriginMercator();
    const { lat, lon } = mercatorToLatLon(wx + origin.x, wz + origin.y);
    const { x: tx, y: ty } = latLonToTile(lat, lon, zoom);
    return { tx, ty, key: `${zoom}_${tx}_${ty}` };
  };

  // ── Step 1: count how many tunnel roads share each endpoint (true portal = count 1) ──
  const epCount = new Map();
  const hashEp = (x, z) => `${Math.round(x / JUNCTION_TOL)},${Math.round(z / JUNCTION_TOL)}`;
  for (const road of tunnelRoads) {
    const fp = toWorld(road.points[0]);
    const lp = toWorld(road.points[road.points.length - 1]);
    epCount.set(hashEp(fp.x, fp.z), (epCount.get(hashEp(fp.x, fp.z)) || 0) + 1);
    epCount.set(hashEp(lp.x, lp.z), (epCount.get(hashEp(lp.x, lp.z)) || 0) + 1);
  }
  const isPortal = (x, z) => (epCount.get(hashEp(x, z)) || 0) === 1;

  // ── Step 2: for each true portal, check if approach corridor crosses a tile boundary ──
  const features = [];
  const crossTileMap = new Map(); // affectsTile key → feature[]

  for (const road of tunnelRoads) {
    const pts = road.points;
    const halfW = (road.width || 6) / 2 + APPROACH_RAMP_CUT_MARGIN;

    const processPortal = (portalPt, nextPt) => {
      const portal = toWorld(portalPt);
      if (!isPortal(portal.x, portal.z)) return;

      const next = toWorld(nextPt);
      const dx = portal.x - next.x, dz = portal.z - next.z;
      const len = Math.hypot(dx, dz) || 1;
      const dirX = dx / len, dirZ = dz / len;

      const approachEndX = portal.x + dirX * TRENCH_LEN;
      const approachEndZ = portal.z + dirZ * TRENCH_LEN;

      const ownerInfo    = worldToTileKey(portal.x, portal.z);
      const affectsInfo  = worldToTileKey(approachEndX, approachEndZ);

      // Only emit cross-tile metadata when the approach endpoint lands in a DIFFERENT tile
      if (affectsInfo.key === ownerInfo.key) return;

      const feature = {
        type: 'tunnel_approach',
        tunnelId: road.id != null ? `way/${road.id}` : 'unknown',
        ownerTile:   [ownerInfo.tx,   ownerInfo.ty],
        affectsTile: [affectsInfo.tx, affectsInfo.ty],
        portalX:  Math.round(portal.x * 100) / 100,
        portalZ:  Math.round(portal.z * 100) / 100,
        dirX:     Math.round(dirX * 10000) / 10000,
        dirZ:     Math.round(dirZ * 10000) / 10000,
        halfW:    Math.round(halfW * 100) / 100,
        approachLen: TRENCH_LEN,
      };
      features.push(feature);

      if (!crossTileMap.has(affectsInfo.key)) crossTileMap.set(affectsInfo.key, []);
      crossTileMap.get(affectsInfo.key).push(feature);
    };

    // Front portal (first endpoint)
    if (pts.length >= 2) processPortal(pts[0], pts[1]);
    // Back portal (last endpoint)
    if (pts.length >= 2) processPortal(pts[pts.length - 1], pts[pts.length - 2]);
  }

  // ── Step 3: write audit file ──────────────────────────────────────────────
  const metadata = { version: 1, region: path.basename(outDir), zoom, features };
  const metaDir  = path.join(outDir, String(zoom));
  fs.mkdirSync(metaDir, { recursive: true });
  const metaPath = path.join(metaDir, '_metadata.json');
  fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));

  // ── Step 4: log summary ──────────────────────────────────────────────────
  console.log(`  Cross-tile tunnel approaches: ${features.length} entries across ${crossTileMap.size} affected tiles`);
  if (features.length > 0) {
    for (const [key, list] of crossTileMap) {
      console.log(`    tile ${key}: ${list.length} approach(es) from tunnel(s) ${list.map(f => f.tunnelId).join(', ')}`);
    }
  }
  console.log(`  Wrote cross-tile metadata → ${metaPath}`);

  return crossTileMap;
}

async function main() {
  const cfg = REGION_CONFIG;
  const cliBbox = parseCliBbox(cfg);
  const bbox = cliBbox ? { ...cliBbox } : { ...cfg.bbox };
  const zoom = (() => {
    const i = process.argv.indexOf('--zoom');
    if (i >= 0 && process.argv[i + 1] != null) return parseInt(process.argv[i + 1], 10);
    return cfg.zoom ?? 16;
  })();
  const simplifyTolerance = cfg.simplifyTolerance ?? 1.2;
  const resampleSpacing = cfg.resampleSpacing ?? 2;
  const outDir = path.join(__dirname, '..', 'tiles', cfg.name);

  const startTime = Date.now();

  // ── Overall progress bar ───────────────────────────────────────────────
  const PHASE_WEIGHTS = [15, 5, 5, 25, 50]; // PBF, graph, simplify+index, assets, tiles
  const TOTAL_WEIGHT = PHASE_WEIGHTS.reduce((a, b) => a + b, 0);
  let currentPhase = 0;
  let phaseProgress = 0; // 0..1 within current phase
  let lastOverallDraw = 0;
  const OVERALL_BAR_WIDTH = 50;

  function drawOverallProgress(force = false) {
    const now = Date.now();
    if (!force && now - lastOverallDraw < 150) return;
    lastOverallDraw = now;

    let completedWeight = 0;
    for (let i = 0; i < currentPhase; i++) completedWeight += PHASE_WEIGHTS[i];
    completedWeight += phaseProgress * (PHASE_WEIGHTS[currentPhase] || 0);
    const pct = completedWeight / TOTAL_WEIGHT;

    const filled = Math.round(pct * OVERALL_BAR_WIDTH);
    const empty = OVERALL_BAR_WIDTH - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    const pctStr = (pct * 100).toFixed(1).padStart(5);

    const elapsedMs = now - startTime;
    const elapsedStr = formatTime(elapsedMs / 1000);

    let etaStr = '--:--';
    if (pct > 0.01 && pct < 1) {
      const remainSec = (elapsedMs / pct) * (1 - pct) / 1000;
      etaStr = formatTime(remainSec);
    } else if (pct >= 1) {
      etaStr = '0:00';
    }

    process.stdout.write(`\r  [${bar}] ${pctStr}%  ${elapsedStr} elapsed  ETA ${etaStr}  `);
    if (pct >= 1) process.stdout.write('\n');
  }

  function advancePhase() {
    phaseProgress = 1;
    currentPhase++;
    phaseProgress = 0;
    drawOverallProgress(true);
  }

  function setPhaseProgress(p) {
    phaseProgress = Math.max(0, Math.min(1, p));
    drawOverallProgress();
  }

  // Wrap console.log to play nice with \r progress bar:
  // clear the progress line before printing, then redraw after.
  const _origLog = console.log.bind(console);
  const _origWarn = console.warn.bind(console);
  const _origErr = console.error.bind(console);
  console.log = (...args) => { process.stdout.write('\r\x1b[K'); _origLog(...args); drawOverallProgress(); };
  console.warn = (...args) => { process.stdout.write('\r\x1b[K'); _origWarn(...args); drawOverallProgress(); };
  console.error = (...args) => { process.stdout.write('\r\x1b[K'); _origErr(...args); drawOverallProgress(); };

  function formatTime(sec) {
    if (sec < 60) return `0:${Math.round(sec).toString().padStart(2, '0')}`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    if (m < 60) return `${m}:${s.toString().padStart(2, '0')}`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}:${rm.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  const isTestBbox = !!(cliBbox?.fromCli);
  console.log('');
  console.log('=== World Builder ===');
  console.log('  Region:', cfg.name);
  if (isTestBbox) console.log('  *** FOCUSED TEST BUILD: AIIMS area ***');
  if (cliBbox?.areaPreset) console.log('  Area preset:', cliBbox.areaPreset);
  console.log('  Bbox:  lon', bbox.minLon.toFixed(4), '..', bbox.maxLon.toFixed(4), ', lat', bbox.minLat.toFixed(4), '..', bbox.maxLat.toFixed(4));
  console.log('  Zoom:  ', zoom);
  console.log('  PBF:   ', cfg.pbfPath);
  console.log('  Out:   ', outDir);
  console.log('');

  const noClipTileStrategy = cfg.noClipTileStrategy ?? false;
  const roadGraphLayerMode = cfg.roadGraphLayerMode ?? false;
  const cleanRoadPipeline = cfg.cleanRoadPipeline ?? false;
  const roadOnlyDebugMode = cfg.roadOnlyDebugMode ?? false;
  // Stage 2 (DEM-on): cleanRoadPipeline is a ROAD-fidelity flag (raw/all-highways/skip-simplify) and
  // must NOT force flat-world. Decoupled from phase1Pure2D so the DEM loader (:928) fires while the
  // clean road graph is preserved. DEM on/off is now controlled solely by cfg.phase1Pure2D.
  const phase1Pure2D = roadOnlyDebugMode || (cfg.phase1Pure2D ?? false);
  const includeAllHighways = cleanRoadPipeline || roadOnlyDebugMode || (cfg.includeAllHighways ?? false);
  const skipTopologyMutation = phase1Pure2D || includeAllHighways || (cfg.stabilizeBaseSystem ?? false);
  const TRACE_WAY_ID = 29534879;
  if (noClipTileStrategy) console.log('  *** NO-CLIP TILE STRATEGY: full way geometry per tile, no clipping ***');
  if (roadGraphLayerMode) console.log('  *** ROAD GRAPH LAYER MODE: graph + ramps + height interpolation ***');
  if (cleanRoadPipeline) console.log('  *** CLEAN ROAD PIPELINE: no simplify/resample, raw OSM graph ***');
  if (roadOnlyDebugMode) console.log('  *** ROAD-ONLY DEBUG MODE: flat world, all highways, no buildings/greens/terrain ***');
  if (phase1Pure2D && !roadOnlyDebugMode && !cleanRoadPipeline) console.log('  Phase 1 Pure 2D: flat world, road Y from OSM tags only');
  if (includeAllHighways && !roadOnlyDebugMode && !cleanRoadPipeline) console.log('  Include all highways: no type filter, no snap/stitch/min-segment');

  drawOverallProgress(true);
  console.log('[1/8] Parsing OSM PBF (highways)...');
  const t1 = Date.now();
  const pbfProgress = (count, chunks, type) => {
    // PBF parsing is phase 0 — estimate progress from chunk count
    // Typical Delhi PBF has ~2000-4000 chunks per pass
    setPhaseProgress(Math.min(0.95, chunks / 3000));
  };
  const { roads, nodeMap } = await parsePbfHighways(cfg.pbfPath, bbox, pbfProgress);
  const totalWaysParsed = roads.length;
  console.log('  Roads (all highway=*):', totalWaysParsed, `(${((Date.now() - t1) / 1000).toFixed(1)}s)`);

  // Remove elevated/depressed pedestrian infrastructure (footbridges, underpasses).
  // Ground-level footways/paths are kept so pavements appear in the world.
  const PED_HIGHWAY_TYPES = new Set([
    'pedestrian', 'footway', 'path', 'steps', 'cycleway', 'bridleway',
  ]);
  const drivableRoads = roads.filter((r) => {
    if (!PED_HIGHWAY_TYPES.has(r.highwayType)) return true; // always keep driving roads
    // Drop pedestrian ways that are elevated (bridge) or underground (tunnel/negative layer)
    return !r.bridge && !r.tunnel && (r.layer == null || r.layer === 0);
  });
  console.log(`  Skipped ${roads.length - drivableRoads.length} elevated/underground pedestrian ways`);

  // Phase 2 OSM data: extract 6 tag fields from drivableRoads BEFORE graph/geometry pipeline
  // strips them via deepCloneRoad. Tags survive on drivableRoads but not on simplified/cloned roads.
  // IDs are preserved through the pipeline so we can join by road.id at payload time.
  const phase2ById = new Map();
  for (const road of drivableRoads) {
    const t = road.tags || {};
    const onewayRaw = t.oneway;
    phase2ById.set(road.id, {
      oneway: (onewayRaw === 'yes' || onewayRaw === 'true' || onewayRaw === '1') ? 'forward'
            : onewayRaw === '-1'                                                  ? 'backward'
            : (onewayRaw === 'no' || onewayRaw === 'false')                      ? 'no'
            : null,
      lanes:    t.lanes    ? (Math.max(1, Math.min(12, parseInt(t.lanes, 10))) || null) : null,
      sidewalk: t.sidewalk || null,
      cycleway: t.cycleway || null,
      surface:  t.surface  || null,
      maxspeed: t.maxspeed ? (parseInt(t.maxspeed, 10) || null) : null,
      'parking:lane:left':  t['parking:lane:left']  || null,
      'parking:lane:right': t['parking:lane:right'] || null,
      'parking:lane:both':  t['parking:lane:both']  || null,
      // Phase 4C-B: Barcelona's :restriction + :condition + :fee schemas
      'parking:left:restriction':  t['parking:left:restriction']  || null,
      'parking:right:restriction': t['parking:right:restriction'] || null,
      'parking:both:restriction':  t['parking:both:restriction']  || null,
      'parking:condition:left':    t['parking:condition:left']    || null,
      'parking:condition:right':   t['parking:condition:right']   || null,
      'parking:condition:both':    t['parking:condition:both']    || null,
      'parking:left:fee':  t['parking:left:fee']  || null,
      'parking:right:fee': t['parking:right:fee'] || null,
      'parking:both:fee':  t['parking:both:fee']  || null,
      'parking:left':  t['parking:left']  || null,
      'parking:right': t['parking:right'] || null,
      'parking:both':  t['parking:both']  || null,
    });
  }
  console.log(`  Phase 2 tag lookup built: ${phase2ById.size} roads`);

  // Marked crossings (footway=crossing etc.) — exempt from the path-coverage clipper (they live
  // INSIDE the carriageway by definition) and flagged in the tile payload so the runtime skips
  // drawing their ribbon (zebra decals come from the road side; polyline stays for gameplay).
  const crossingIds = new Set();
  for (const road of drivableRoads) {
    const t = road.tags || {};
    if (t.footway === 'crossing' || t.cycleway === 'crossing' || t.path === 'crossing' || t.crossing) {
      crossingIds.add(road.id);
    }
  }
  console.log(`  Marked crossings: ${crossingIds.size}`);

  advancePhase(); // Phase 0 (PBF) done → Phase 1 (graph)

  const enriched = drivableRoads.map((road) => {
    const lanes = getLanes(road.tags, road.highwayType);
    const width = getWidth(road.tags, road.highwayType, lanes);
    const junctionTag = road.tags?.junction || '';
    return {
      ...road,
      width,
      bridge: !!road.bridge,
      tunnel: !!road.tunnel,
      layer: road.layer != null && Number.isFinite(road.layer) ? road.layer : 0,
      highwayType: road.highwayType || 'unclassified',
      closedLoop: !!road.closedLoop,
      isRoundabout: junctionTag.toLowerCase() === 'roundabout',
    };
  });
  const graph = buildFromWays(enriched, nodeMap);
  const fixerStats = fixOsmData(graph, nodeMap);
  console.log('  OSM fixer:', fixerStats);
  const junctions = classifyJunctions(graph);
  console.log('  Junctions classified:', junctions.length);
  const rampResult = resolveRamps(graph);
  const b2bCount = resolveBridgeToBridge(graph, rampResult);
  if (b2bCount > 0) console.log('  Bridge-to-bridge transitions resolved:', b2bCount);
  const roadsToSimplify = buildRoadGeometry(enriched, nodeMap, rampResult);
  console.log('[2/8] Road graph + ramp resolution, roads:', roadsToSimplify.length);
  if (skipTopologyMutation) console.log('[3/8] Skipping way stitching');
  console.log('[4/8] Roads ready:', roadsToSimplify.length);
  advancePhase(); // Phase 1 (graph) done → Phase 2 (simplify+index)

  console.log('[5/8] Simplifying (Douglas-Peucker, tolerance:', simplifyTolerance, 'm)...');
  const simplifiedRaw = cleanRoadPipeline
    ? roadsToSimplify.filter((r) => r.points.length >= 2)
    : roadsToSimplify.map((road) => {
        const pts = douglasPeucker(road.points, simplifyTolerance);
        return { ...road, points: pts };
      }).filter((r) => r.points.length >= 2);
  if (cleanRoadPipeline) console.log('  Clean pipeline: skipping simplify, using raw OSM geometry');
  console.log('  Roads:', simplifiedRaw.length);

  // Bake Phase 1 (docs/context/bake-surface-clipping.md): clip path-family polylines out of
  // same-layer carriageway coverage so footpaths/cycleways never overlap drivable ribbons.
  // Region-wide (cross-tile consistent); runs emit with the SAME id like tile splitting does,
  // so EVERYTHING downstream (spatial index, trench flags, per-tile subsets) sees the clipped set.
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const clipResult = clipPathsAgainstCarriageways(simplifiedRaw, {
    cosLat: Math.cos((midLat * Math.PI) / 180),
    skipIds: crossingIds,
  });
  const simplified = clipResult.roads;
  console.log('  Path-coverage clip:', JSON.stringify(clipResult.stats));

  console.log('[6/8] Building spatial index...');
  const roadIndex = buildRoadIndex(simplified);

  const minT = latLonToTile(bbox.maxLat, bbox.minLon, zoom);
  const maxT = latLonToTile(bbox.minLat, bbox.maxLon, zoom);
  const minTileX = Math.min(minT.x, maxT.x);
  const maxTileX = Math.max(minT.x, maxT.x);
  const minTileY = Math.min(minT.y, maxT.y);
  const maxTileY = Math.max(minT.y, maxT.y);
  const tileCount = (maxTileX - minTileX + 1) * (maxTileY - minTileY + 1);
  console.log('  Tiles:', tileCount, '(x:', minTileX, '..', maxTileX, ', y:', minTileY, '..', maxTileY, ')');
  advancePhase(); // Phase 2 (simplify+index) done → Phase 3 (assets)

  const BARRIER_DEFAULT_HEIGHTS = {
    wall: 2.0, city_wall: 4.5, retaining_wall: 2.5, fence: 1.5,
    hedge: 1.2, guard_rail: 0.75, jersey_barrier: 0.9, kerb: 0.12,
    compound_wall: 2.5,
  };

  const MAX_COMPOUND_AREA   = 500_000;  // m²; larger = zoning polygon, not campus
  const MAX_INTERIOR_ROADS  = 2;        // major roads passing through → open zone
  const MAX_ROAD_DENSITY    = 0.004;    // m road / m² area
  const MIN_BLDG_DENSITY    = 1 / 20_000; // at least 1 building per 20,000 m²
  const MIN_AREA_BLDG_CHECK = 10_000;   // m²; skip building check for tiny polygons
  const MAJOR_ROAD_TYPES = new Set([
    'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
    'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
    'residential', 'unclassified',
  ]);
  // Arterial roads: a single through-crossing proves the area is open infrastructure
  const STRICT_ROAD_TYPES = new Set(['motorway', 'trunk', 'primary', 'secondary']);

  let buildingsByTile;
  let greensByTile;
  let watersByTile;
  let barriersByTile = new Map();
  let allGateNodes = new Map();
  const skipGreens = cfg.skipGreens ?? false;
  const skipWater = cfg.skipWater ?? false;
  if (roadOnlyDebugMode) {
    buildingsByTile = new Map();
    greensByTile = new Map();
    watersByTile = new Map();
    console.log('[7/8] Road-only mode: skipping buildings, greens, water');
  } else {
    console.log('[7/8] Parsing and splitting buildings...');
    const t7 = Date.now();
    const rawBuildings = await parsePbfBuildings(cfg.pbfPath, bbox, pbfProgress);
    const normalizedBuildings = rawBuildings.map((b) => normalizeBuilding(b, { includeRawTags: false }));
    buildingsByTile = splitBuildingsByTile(normalizedBuildings, zoom);
    console.log('  Buildings by tile:', buildingsByTile.size, `tiles with buildings (${((Date.now() - t7) / 1000).toFixed(1)}s)`);
    setPhaseProgress(0.15);
    if (skipGreens) {
      greensByTile = new Map();
      console.log('[8a/8] Skipping greens (skipGreens: true)');
    } else {
      console.log('[8a/8] Parsing and splitting greens...');
      const t8a = Date.now();
      const rawGreens = await parsePbfGreens(cfg.pbfPath, bbox, pbfProgress);
      const normalizedGreens = rawGreens.map((g) => normalizeGreen(g));
      greensByTile = splitGreensByTile(normalizedGreens, zoom);
      console.log('  Greens by tile:', greensByTile.size, `tiles with greens (${((Date.now() - t8a) / 1000).toFixed(1)}s)`);
    }
    setPhaseProgress(0.30);
    if (skipWater) {
      watersByTile = new Map();
      console.log('[8b/8] Skipping water (skipWater: true)');
    } else {
      console.log('[8b/8] Parsing and splitting water...');
      const t8b = Date.now();
      const { waters: rawWaters } = await parsePbfWater(cfg.pbfPath, bbox, pbfProgress);
      const normalizedWaters = rawWaters.map((w) => normalizeWater(w));
      watersByTile = splitWatersByTile(normalizedWaters, zoom, bbox);
      console.log('  Water by tile:', watersByTile.size, `tiles with water (${((Date.now() - t8b) / 1000).toFixed(1)}s)`);
    }
    setPhaseProgress(0.45);
    /** Polygon area via shoelace formula. pts = [[x, z], ...] */
    function polyArea(pts) {
      let a = 0;
      const n = pts.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
      }
      return Math.abs(a) / 2;
    }

    /** Ray-casting point-in-polygon. pts = [[x, z], ...] */
    function pointInPoly(px, pz, pts) {
      let inside = false;
      const n = pts.length;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = pts[i][0], zi = pts[i][1], xj = pts[j][0], zj = pts[j][1];
        if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi)
          inside = !inside;
      }
      return inside;
    }

    function filterCompoundWalls(rawBarriers, simplified, buildingsByTile) {
      // Pre-compute building centroids
      const bldgCentroids = [];
      for (const bs of buildingsByTile.values()) {
        for (const b of bs) {
          const fp = b.footprint;
          if (!fp?.length) continue;
          let cx = 0, cz = 0;
          for (const [x, z] of fp) { cx += x; cz += z; }
          bldgCentroids.push([cx / fp.length, cz / fp.length]);
        }
      }
      const majorRoads  = simplified.filter(r => MAJOR_ROAD_TYPES.has(r.highwayType));
      const strictRoads = simplified.filter(r => STRICT_ROAD_TYPES.has(r.highwayType));

      return rawBarriers.filter(b => {
        if (b.barrierType !== 'compound_wall') return true;

        // Tier 1: high-confidence campus → always keep, skip all rules
        if (b.campusClass === 'high_confidence') return true;

        // Convert Mercator points to world [x, z]
        const pts = b.pointsMercator.map(p => {
          const w = mercatorToWorld(p.x, p.y);
          return [w.x, w.z];
        });

        // Rule 4: polygon too large → zoning area (only for conditional)
        const area = polyArea(pts);
        if (area > MAX_COMPOUND_AREA) return false;

        // Barrier bbox
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const [x, z] of pts) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }

        // Rule 5: any single arterial through-road → open infrastructure, reject immediately
        for (const road of strictRoads) {
          const rpts = road.points;
          let rMinX = Infinity, rMaxX = -Infinity, rMinZ = Infinity, rMaxZ = -Infinity;
          for (const p of rpts) {
            if (p[0] < rMinX) rMinX = p[0]; if (p[0] > rMaxX) rMaxX = p[0];
            if (p[2] < rMinZ) rMinZ = p[2]; if (p[2] > rMaxZ) rMaxZ = p[2];
          }
          if (rMaxX < minX || rMinX > maxX || rMaxZ < minZ || rMinZ > maxZ) continue;
          let transitions = 0, prevInside = null;
          for (let i = 0; i < rpts.length - 1; i++) {
            const aInside = pointInPoly(rpts[i][0], rpts[i][2], pts);
            if (prevInside !== null && aInside !== prevInside) transitions++;
            prevInside = aInside;
          }
          if (transitions >= 2) return false; // arterial passes through → open zone
        }

        // Rules 1 & 2: roads that cross the polygon boundary (enter + exit = through-road)
        let throughRoadCount = 0;
        let totalInteriorLen = 0;
        for (const road of majorRoads) {
          const rpts = road.points;
          let rMinX = Infinity, rMaxX = -Infinity, rMinZ = Infinity, rMaxZ = -Infinity;
          for (const p of rpts) {
            if (p[0] < rMinX) rMinX = p[0]; if (p[0] > rMaxX) rMaxX = p[0];
            if (p[2] < rMinZ) rMinZ = p[2]; if (p[2] > rMaxZ) rMaxZ = p[2];
          }
          if (rMaxX < minX || rMinX > maxX || rMaxZ < minZ || rMinZ > maxZ) continue;

          // Count inside→outside or outside→inside transitions (boundary crossings)
          let transitions = 0;
          let prevInside = null;
          let interiorLen = 0;
          for (let i = 0; i < rpts.length - 1; i++) {
            const ax = rpts[i][0], az = rpts[i][2];
            const bx = rpts[i + 1][0], bz = rpts[i + 1][2];
            const midInside = pointInPoly((ax + bx) / 2, (az + bz) / 2, pts);
            if (midInside) interiorLen += Math.hypot(bx - ax, bz - az);
            const aInside = pointInPoly(ax, az, pts);
            if (prevInside !== null && aInside !== prevInside) transitions++;
            prevInside = aInside;
          }
          // Through-road: enters and exits (2+ boundary transitions)
          if (transitions >= 2) {
            throughRoadCount++;
            totalInteriorLen += interiorLen;
          }
        }
        if (throughRoadCount > MAX_INTERIOR_ROADS) return false;            // Rule 1
        if (area > 0 && totalInteriorLen / area > MAX_ROAD_DENSITY) return false; // Rule 2

        // Rule 3: building density — skip for leisure/park areas
        if (!b.isLeisure && area > MIN_AREA_BLDG_CHECK) {
          let bldgCount = 0;
          for (const [cx, cz] of bldgCentroids) {
            if (cx < minX || cx > maxX || cz < minZ || cz > maxZ) continue;
            if (pointInPoly(cx, cz, pts)) bldgCount++;
          }
          if (bldgCount < area * MIN_BLDG_DENSITY) return false;
        }

        return true;
      });
    }

    console.log('[8c/8] Parsing and splitting barriers...');
    const { barriers: rawBarriers, gateNodes } = await parsePbfBarriers(cfg.pbfPath, bbox, pbfProgress);
    allGateNodes = gateNodes;

    // Filter out compound walls for open/non-enclosed areas
    const filteredBarriers = filterCompoundWalls(rawBarriers, simplified, buildingsByTile);
    const rawCW  = rawBarriers.filter(b => b.barrierType === 'compound_wall').length;
    const keepCW = filteredBarriers.filter(b => b.barrierType === 'compound_wall').length;
    console.log(`  Compound wall filter: ${rawCW} → ${keepCW} (dropped ${rawCW - keepCW})`);

    // Assign each barrier to the tile containing its Mercator centroid
    const MERC_R = 6378137;
    for (const b of filteredBarriers) {
      if (!b.pointsMercator.length) continue;
      let cx = 0, cy = 0;
      for (const p of b.pointsMercator) { cx += p.x; cy += p.y; }
      cx /= b.pointsMercator.length;
      cy /= b.pointsMercator.length;
      // Convert Mercator centroid back to lat/lon for tile assignment
      const lon = (cx / MERC_R) * (180 / Math.PI);
      const latRad = 2 * Math.atan(Math.exp(cy / MERC_R)) - Math.PI / 2;
      const lat = latRad * (180 / Math.PI);
      const { x: tx, y: ty } = latLonToTile(lat, lon, zoom);
      const tid = `${zoom}_${tx}_${ty}`;
      if (!barriersByTile.has(tid)) barriersByTile.set(tid, []);
      barriersByTile.get(tid).push(b);
    }
    console.log('  Barriers by tile:', barriersByTile.size, 'tiles with barriers');
    setPhaseProgress(0.65);
  }

  // ── Railways ────────────────────────────────────────────────────────────
  let railwaysByTile = new Map();
  if (!roadOnlyDebugMode) {
    const rawRailways = await parsePbfRailways(cfg.pbfPath, bbox);
    const rwOrigin = getOriginMercator();
    const MERC_R_RW = 6378137;
    for (const rw of rawRailways) {
      if (!rw.pointsMercator.length) continue;
      // Assign to tile by centroid
      let cx = 0, cy = 0;
      for (const p of rw.pointsMercator) { cx += p.x; cy += p.y; }
      cx /= rw.pointsMercator.length;
      cy /= rw.pointsMercator.length;
      const lon = (cx / MERC_R_RW) * (180 / Math.PI);
      const latRad = 2 * Math.atan(Math.exp(cy / MERC_R_RW)) - Math.PI / 2;
      const lat = latRad * (180 / Math.PI);
      const { x: tx, y: ty } = latLonToTile(lat, lon, zoom);
      const tid = `${zoom}_${tx}_${ty}`;
      if (!railwaysByTile.has(tid)) railwaysByTile.set(tid, []);
      railwaysByTile.get(tid).push(rw);
    }
    console.log('  Railways by tile:', railwaysByTile.size, 'tiles with railways');
  }

  console.log('[8d/8] Parsing bus stops...');
  const rawBusStops = await parsePbfBusStops(cfg.pbfPath, bbox, pbfProgress);
  console.log('  Bus stops found:', rawBusStops.length);

  const busStopsByTile = new Map();
  for (const stop of rawBusStops) {
    const { x: wx, z: wz } = mercatorToWorld(stop.mx, stop.my);  // Unstretch-X: real-metre world
    const { x: tx, y: ty } = latLonToTile(stop.lat, stop.lon, zoom);
    const tid = `${zoom}_${tx}_${ty}`;
    if (!busStopsByTile.has(tid)) busStopsByTile.set(tid, []);
    busStopsByTile.get(tid).push({ id: stop.id, point: [wx, wz], name: stop.name });
  }

  console.log('[8e/8] Parsing parking areas...');
  const rawUrbanFeatures = await parsePbfUrbanFeatures(cfg.pbfPath, bbox, pbfProgress);
  const urbanFeatures = deduplicateUrbanFeatures(rawUrbanFeatures);
  console.log('  Urban features found:', urbanFeatures.length,
    Object.entries(urbanFeatures.reduce((m, f) => { m[f.type] = (m[f.type]||0)+1; return m; }, {}))
      .map(([k,v]) => `${k}:${v}`).join(', '));
  const rawParkings = await parsePbfParking(cfg.pbfPath, bbox, pbfProgress);

  const parkingsByTile = new Map();
  for (const p of rawParkings) {
    // Convert mercator polygon to world-relative [x, z] pairs (Unstretch-X: real-metre world)
    const polygon = p.pointsMercator.map((pt) => { const w = mercatorToWorld(pt.x, pt.y); return [w.x, w.z]; });
    // Compute centroid in world coords, convert back to mercator/lat/lon for tile assignment
    const cx = polygon.reduce((s, pt) => s + pt[0], 0) / polygon.length;
    const cy = polygon.reduce((s, pt) => s + pt[1], 0) / polygon.length;
    const cMerc = worldToMercator(cx, cy);
    const cLatLon = mercatorToLatLon(cMerc.x, cMerc.y);
    const { x: tx, y: ty } = latLonToTile(cLatLon.lat, cLatLon.lon, zoom);
    const tid = `${zoom}_${tx}_${ty}`;
    if (!parkingsByTile.has(tid)) parkingsByTile.set(tid, []);
    parkingsByTile.get(tid).push({ id: p.id, polygon, parkingType: p.parkingType, capacity: p.capacity });
  }
  console.log('  Parking areas by tile:', parkingsByTile.size, 'tiles with parking');
  setPhaseProgress(0.85);

  const urbanByTile = new Map();
  for (const f of urbanFeatures) {
    const { x: wx, z: wz } = mercatorToWorld(f.mx, f.my);  // Unstretch-X: real-metre world
    const { x: tx, y: ty } = latLonToTile(f.lat, f.lon, zoom);
    const tid = `${zoom}_${tx}_${ty}`;
    if (!urbanByTile.has(tid)) urbanByTile.set(tid, []);
    urbanByTile.get(tid).push({
      id: f.id, type: f.type, point: [wx, wz], tags: f.tags,
    });
  }
  console.log('  Urban features by tile:', urbanByTile.size, 'tiles with urban features');

  // ── New v7 feature types ──────────────────────────────────────────────────
  // Kill-switch flags from config (all default true)
  const bakeBeaches         = cfg.bakeBeaches         !== false;
  const bakePedestrianAreas = cfg.bakePedestrianAreas !== false;
  const bakeMarinas         = cfg.bakeMarinas         !== false;
  const bakeTrafficSignals  = cfg.bakeTrafficSignals  !== false;
  const bakeStreetLamps     = cfg.bakeStreetLamps     !== false;
  const bakeTrees           = cfg.bakeTrees           !== false;
  const bakeTourismPois     = cfg.bakeTourismPois     !== false;
  const bakeMetroStations   = cfg.bakeMetroStations   !== false;
  const bakeHealthcare      = cfg.bakeHealthcare      !== false;
  const bakeShops           = cfg.bakeShops           !== false;

  // ── Area features (beaches, pedestrian areas, marinas) ──────────────────
  let beachesByTile     = new Map();
  let pedAreasByTile    = new Map();
  let marinasByTile     = new Map();

  if (!roadOnlyDebugMode && (bakeBeaches || bakePedestrianAreas || bakeMarinas)) {
    console.log('[8f/8] Parsing area features (beaches, pedestrian areas, marinas)...');
    const t8f = Date.now();
    const { beaches: rawBeaches, pedestrianAreas: rawPedAreas, marinas: rawMarinas } =
      await parsePbfAreaFeatures(cfg.pbfPath, bbox, pbfProgress);

    if (bakeBeaches && rawBeaches.length > 0) {
      const normalized = rawBeaches.map((f) => normalizeAreaFeature(f, mercatorToWorld));
      beachesByTile = splitAreaFeaturesByTile(normalized, zoom, mercatorToLatLon, latLonToTile, getOriginMercator);
      console.log('  Beaches by tile:', beachesByTile.size);
    }
    if (bakePedestrianAreas && rawPedAreas.length > 0) {
      const normalized = rawPedAreas.map((f) => normalizeAreaFeature(f, mercatorToWorld));
      pedAreasByTile = splitAreaFeaturesByTile(normalized, zoom, mercatorToLatLon, latLonToTile, getOriginMercator);
      console.log('  Pedestrian areas by tile:', pedAreasByTile.size);
    }
    if (bakeMarinas && rawMarinas.length > 0) {
      const normalized = rawMarinas.map((f) => normalizeAreaFeature(f, mercatorToWorld));
      marinasByTile = splitAreaFeaturesByTile(normalized, zoom, mercatorToLatLon, latLonToTile, getOriginMercator);
      console.log('  Marinas/docks/piers by tile:', marinasByTile.size);
    }
    console.log(`  Area features done (${((Date.now() - t8f) / 1000).toFixed(1)}s)`);
  }

  // ── Point features (signals, lamps, trees, tourism, metro, health, shops) ─
  let signalsByTile   = new Map();
  let lampsByTile     = new Map();
  let treesByTile     = new Map();
  let tourismByTile   = new Map();
  let metroByTile     = new Map();
  let healthByTile    = new Map();
  let shopsByTile     = new Map();

  if (!roadOnlyDebugMode && (bakeTrafficSignals || bakeStreetLamps || bakeTrees ||
      bakeTourismPois || bakeMetroStations || bakeHealthcare || bakeShops)) {
    console.log('[8g/8] Parsing point features (signals, lamps, trees, tourism, metro, healthcare, shops)...');
    const t8g = Date.now();
    const {
      trafficSignals: rawSignals, streetLamps: rawLamps, trees: rawTrees,
      tourismPois: rawTourism, metroStations: rawMetro, healthcare: rawHealth,
      shops: rawShops,
    } = await parsePbfPointFeatures(cfg.pbfPath, bbox, pbfProgress);

    const pfOrigin = getOriginMercator();

    function pointToTile(f) {
      const { x: wx, z: wz } = mercatorToWorld(f.mx, f.my);  // Unstretch-X: real-metre world
      const { x: tx, y: ty } = latLonToTile(f.lat, f.lon, zoom);
      return { tid: `${zoom}_${tx}_${ty}`, wx, wz };
    }

    function buildPointByTile(features, extraFields) {
      const byTile = new Map();
      for (const f of features) {
        const { tid, wx, wz } = pointToTile(f);
        if (!byTile.has(tid)) byTile.set(tid, []);
        byTile.get(tid).push({ id: f.id, point: [wx, wz], ...extraFields(f) });
      }
      return byTile;
    }

    if (bakeTrafficSignals) {
      signalsByTile = buildPointByTile(rawSignals, (f) => ({ direction: f.direction }));
      console.log('  Traffic signals by tile:', signalsByTile.size, `(${rawSignals.length} total)`);
    }
    if (bakeStreetLamps) {
      lampsByTile = buildPointByTile(rawLamps, (f) => ({ height: f.height }));
      console.log('  Street lamps by tile:', lampsByTile.size, `(${rawLamps.length} total)`);
    }
    if (bakeTrees) {
      treesByTile = buildPointByTile(rawTrees, (f) => ({ species: f.species, height: f.height }));
      console.log('  Individual trees by tile:', treesByTile.size, `(${rawTrees.length} total)`);
    }
    if (bakeTourismPois) {
      tourismByTile = buildPointByTile(rawTourism, (f) => ({ type: f.type, name: f.name }));
      console.log('  Tourism POIs by tile:', tourismByTile.size, `(${rawTourism.length} total)`);
    }
    if (bakeMetroStations) {
      metroByTile = buildPointByTile(rawMetro, (f) => ({ name: f.name, network: f.network, lines: f.lines }));
      console.log('  Metro stations by tile:', metroByTile.size, `(${rawMetro.length} total)`);
    }
    if (bakeHealthcare) {
      healthByTile = buildPointByTile(rawHealth, (f) => ({ type: f.type, name: f.name }));
      console.log('  Healthcare by tile:', healthByTile.size, `(${rawHealth.length} total)`);
    }
    if (bakeShops) {
      const SHOP_WARN_THRESHOLD = 2000;
      shopsByTile = buildPointByTile(rawShops, (f) => ({ cat: f.cat, name: f.name }));
      for (const [tid, arr] of shopsByTile) {
        if (arr.length > SHOP_WARN_THRESHOLD) {
          console.warn(`  [WARN] Tile ${tid} has ${arr.length} shop entries (>${SHOP_WARN_THRESHOLD} threshold)`);
        }
      }
      console.log('  Shops/restaurants by tile:', shopsByTile.size, `(${rawShops.length} total)`);
    }
    console.log(`  Point features done (${((Date.now() - t8g) / 1000).toFixed(1)}s)`);
  }

  /** Terrain grid per tile: 128x128 heightfield. Must match frontend TERRAIN_GRID_SIZE/TERRAIN_MAX_GRID. */
  const TERRAIN_GRID = 128;

  // ── DEM loading ────────────────────────────────────────────────────────────
  // When phase1Pure2D=false and cfg.demPaths is set, sample real elevation per tile.
  // BAKED_ROAD_ELEVATION_IS_RAW=true in frontend CONFIG must stay true: baked road
  // Y values are raw DEM meters; the frontend subtracts worldElevationOffset at runtime.
  let demSampler = null;
  if (!phase1Pure2D && cfg.demPaths?.length) {
    console.log('[DEM] Loading', cfg.demPaths.length, 'tile(s)...');
    try {
      demSampler = await loadDEM(cfg.demPaths);
      console.log('[DEM] Ready.');
    } catch (err) {
      console.error('[DEM] Failed to load DEM — falling back to flat terrain:', err.message);
      demSampler = null;
    }
  } else if (!phase1Pure2D) {
    console.log('[DEM] No demPaths configured — using flat terrain (set cfg.demPaths to enable real elevation).');
  }

  const allTileIds = new Set();
  for (let ty = minTileY; ty <= maxTileY; ty++) {
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      allTileIds.add(`${zoom}_${tx}_${ty}`);
    }
  }
  for (const id of buildingsByTile.keys()) allTileIds.add(id);
  for (const id of greensByTile.keys()) allTileIds.add(id);
  for (const id of watersByTile.keys()) allTileIds.add(id);
  for (const id of barriersByTile.keys()) allTileIds.add(id);
  for (const id of railwaysByTile.keys()) allTileIds.add(id);
  for (const id of busStopsByTile.keys()) allTileIds.add(id);
  for (const id of parkingsByTile.keys()) allTileIds.add(id);
  for (const id of urbanByTile.keys()) allTileIds.add(id);
  // v7 feature types
  for (const id of beachesByTile.keys())  allTileIds.add(id);
  for (const id of pedAreasByTile.keys()) allTileIds.add(id);
  for (const id of marinasByTile.keys())  allTileIds.add(id);
  for (const id of signalsByTile.keys())  allTileIds.add(id);
  for (const id of lampsByTile.keys())    allTileIds.add(id);
  for (const id of treesByTile.keys())    allTileIds.add(id);
  for (const id of tourismByTile.keys())  allTileIds.add(id);
  for (const id of metroByTile.keys())    allTileIds.add(id);
  for (const id of healthByTile.keys())   allTileIds.add(id);
  for (const id of shopsByTile.keys())    allTileIds.add(id);

  /** Sorted by (ty, tx) so (tx-1, ty) and (tx, ty-1) are built before (tx, ty) for stitching. */
  let sortedTileIds = [...allTileIds].sort((a, b) => {
    const [za, xa, ya] = a.split('_').map(Number);
    const [zb, xb, yb] = b.split('_').map(Number);
    return ya !== yb ? ya - yb : xa - xb;
  });

  const singleTile = process.env.BAKE_SINGLE_TILE || (() => {
    const idx = process.argv.indexOf('--tile');
    return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
  })();
  if (singleTile) {
    sortedTileIds = sortedTileIds.filter((id) => id === singleTile);
    if (sortedTileIds.length === 0) {
      console.error('Single-tile mode: tile', singleTile, 'not in region. Available tiles include region bbox.');
      process.exit(1);
    }
    console.log('  Single-tile bake:', singleTile);
  }

  /** Edge storage for tile stitching: rightCol and bottomRow per tile. */
  const edgeStore = new Map();

  // ── Phase B.1/B.2: Cross-tile tunnel approach pre-pass ────────────────────
  // Scans ALL tunnel roads across the ENTIRE region before the per-tile loop.
  // For each true portal endpoint (endpoint shared by exactly one tunnel segment =
  // surface transition), compute which adjacent tile the 80m approach corridor
  // falls into. If it crosses into a different tile, emit a tunnel_approach feature
  // so that tile's terrainBaker can cut the correct terrain.
  //
  // Consumed ONLY at bake time. Frontend never fetches _metadata.json.
  // Diagonal portals (corridor crossing 2 tile boundaries) deferred — see gotchas G-44.
  const crossTileMap = buildCrossTileMetadata(simplified, zoom, outDir);

  // ── Phase B.3: authored trench corridors (terrain-tunnel rework slice ②) ──
  // Built ONCE from the GLOBAL road list (pre-drape layer profiles + the same DEM sampler
  // the grid uses) so every tile carves identical geometry → cross-tile seams agree by
  // construction. Carved per-tile as the LAST grid mutation. See authored-tunnels-design.md.
  const trenchCorridors = demSampler ? buildTrenchCorridors(simplified, demSampler) : [];
  // OPTION L: streets crossing above a daylighted corridor get deck colliders (bridge
  // mechanism). Flag set on the GLOBAL roads BEFORE the per-tile clones are taken.
  // Shoulder cuts (returned) un-bury near-trench surface roads — carved with the corridors.
  if (trenchCorridors.length) {
    const { shoulders } = flagTrenchCrossings(simplified, trenchCorridors, demSampler);
    trenchCorridors.push(...shoulders);
    // Closure: flag roads floating over the FINAL carved surface (incl. shoulder benches)
    flagFloatersOverCarve(simplified, trenchCorridors, demSampler);
  }

  advancePhase(); // Phase 3 (assets) done → Phase 4 (tiles)
  console.log('[9/9] Processing tiles (streaming)...');
  fs.mkdirSync(outDir, { recursive: true });
  let written = 0;
  let totalRoadSegmentsWritten = 0;
  const floorViolations = []; // slice ③ commit-blocking floor validator (drivable-surface-implies-floor)
  const droppedRampIds = new Set(); // broken/incomplete-ramp roads skipped (vibe > survey accuracy)
  // Slice ③ KNOWN floor-gap roads: layer-1 ways tagged tunnel but with native terrain rising
  // 3.6–8.3 m straight through the roadway (mis-tagged / un-carveable — not real drivable
  // corridors). DROPPED at bake (accept-the-gap) + WHITELISTED in the validator so the bake can
  // hard-block on any NEW regression. Re-derive with TRENCH_VALIDATOR=report (DISTINCT_FLOOR_GAP_ROADS).
  const KNOWN_FLOOR_GAP_ROADS = new Set([18524460, 1394468622, 18520976, 1394468619, 123268593]);
  const droppedFloorGapIds = new Set();
  const allAssignedWayIds = new Set();
  const allRenderedWayIds = new Set();
  const waysPerTileCount = new Map();
  const parsedWayIds = new Set(simplified.map((r) => r.id));
  for (const tileId of sortedTileIds) {
    const [zStr, xStr, yStr] = tileId.split('_');
    const z = parseInt(zStr, 10);
    const tx = parseInt(xStr, 10);
    const ty = parseInt(yStr, 10);
    const margin = cfg.tileBoundaryMargin ?? 0;
    const bounds = tileMercatorBounds(tx, ty, z, margin);

    const indices = roadIndex.query(bounds);
    if (indices.some((i) => simplified[i]?.id === TRACE_WAY_ID)) {
      console.log(`  [TRACE ${TRACE_WAY_ID}] assigned to tile ${tileId}`);
    }
    let subset = indices.map((i) => deepCloneRoad(simplified[i]));
    if (!skipTopologyMutation) normalizeRoadTopology(subset, cfg);
    if (!cleanRoadPipeline) subset = resampleRoads(subset, resampleSpacing).filter((r) => r.points.length >= 2);
    const tileJunctions = buildMergeGeometry(junctions, subset, bounds);
    // Build wayId→width lookup for junction enrichment (Phase 4B-1)
    const _wayWidth = new Map();
    for (const r of subset) { if (r.id != null) _wayWidth.set(r.id, r.width ?? 6); }
    let tileRoads = noClipTileStrategy ? roadsForTileNoClip(subset, tileId) : clipRoadsForTile(subset, bounds, tileId);
    if (!skipTopologyMutation) tileRoads = tileRoads.filter((r) => polylineLength(r.points) >= 1);
    if (tileRoads.some((r) => r.id === TRACE_WAY_ID)) {
      console.log(`  [TRACE ${TRACE_WAY_ID}] written to tile ${tileId}, segments:`, tileRoads.filter((r) => r.id === TRACE_WAY_ID).length);
    }
    for (const i of indices) allAssignedWayIds.add(simplified[i]?.id);
    for (const r of tileRoads) allRenderedWayIds.add(r.id);
    waysPerTileCount.set(tileId, tileRoads.length);

    const dir = path.join(outDir, zStr, xStr);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, yStr + '.bin');
    const tileBbox = tileToBBox(tx, ty, z);
    const { south, west, north, east } = tileBbox;

    // Terrain grid: sample DEM if available, else flat zeros.
    const data = new Array(TERRAIN_GRID * TERRAIN_GRID);
    const sunkCells = new Set(); // water-sunk cell indices — trench carve must not touch these
    if (demSampler) {
      for (let r = 0; r < TERRAIN_GRID; r++) {
        const lat = south + (north - south) * (r / (TERRAIN_GRID - 1));
        for (let c = 0; c < TERRAIN_GRID; c++) {
          const lon = west + (east - west) * (c / (TERRAIN_GRID - 1));
          const elev = demSampler.sampleElevation(lat, lon);
          data[r * TERRAIN_GRID + c] = (elev != null && Number.isFinite(elev)) ? elev : 0;
        }
      }
    } else {
      data.fill(0);
    }

    // ── Auto water/marina elevation fix ────────────────────────────────────
    // Grid points that fall inside water or marina polygons get a below-sea-level
    // elevation baked in. This removes the need for runtime terrain hole-cutting
    // and ensures the terrain naturally dips at water bodies.
    // Sink RELATIVE to each body's real water-surface elevation (flat), NOT an absolute depth.
    // Absolute -2.5 slammed inland/high water (e.g. a 154m pond) down to sea level → deep pits, and
    // left land islanded by sunk neighbours → spikes (both bilinear-smeared into cones). Dormant in
    // the flat world (all ~0); exposed by DEM-on. See changelog 2026-06-06.
    const WATER_SINK_DELTA = 2.5; // metres BELOW the body's real surface (sea DEM≈0 → -2.5, unchanged)
    {
      // Build list of polygons to test (Mercator coords), keeping type/closed so we can apply the SAME
      // open/closed discrimination the RENDERER uses (waterRenderer.js:164 isOpenPolyline). Only CLOSED
      // AREA water bodies (ponds/lakes/marinas/docks) get a flat terrain sink. OPEN polylines
      // (streams/canals/coastlines — buffered LINE features, 3–5km, spanning up to 244m elevation) have no
      // valid 'inside' for point-in-polygon and no single flat surface → they were flattening arbitrary
      // terrain patches to a garbage median (the mesas/cones/raised sheet). Skip them, exactly as the
      // renderer already refuses to draw them as water. See changelog 2026-06-06 (water-sink #2).
      const OPEN_WATER_TYPES = new Set(['stream', 'canal', 'coastline', 'wetland', 'river', 'ditch', 'drain']);
      const OPEN_POLY_EPS_MERC = 1.5; // Mercator units ≈ (1m world / cos) — mirrors waterRenderer OPEN_POLY_EPS
      const isClosedAreaWater = (poly, type, closed) => {
        if (closed === false) return false;                       // explicitly open
        if (type && OPEN_WATER_TYPES.has(type)) return false;     // linear water type
        if (!poly || poly.length < 3) return false;
        const f = poly[0], l = poly[poly.length - 1];
        if (Math.hypot(f.x - l.x, f.y - l.y) >= OPEN_POLY_EPS_MERC) return false; // open polyline (buffered line)
        return true;
      };
      const waterBodies = [
        ...(watersByTile.get(tileId) || []).map((w) => ({ poly: w.polygonMercator || [], type: w.type, closed: w.closed })),
        // Marinas are in world coords — convert back to Mercator for consistent testing (closed area bodies).
        ...(marinasByTile.get(tileId) || [])
          .filter((m) => !m.isLine && m.polygon?.length >= 3)
          .map((m) => ({
            poly: (m.polygon || []).map((p) => {
              const w = Array.isArray(p) ? { x: p[0], z: p[1] } : { x: p.x, z: p.y };
              return worldToMercator(w.x, w.z); // worldToMercator divides by cos (Unstretch-X inverse)
            }),
            type: m.type, closed: true,
          })),
      ].filter((b) => isClosedAreaWater(b.poly, b.type, b.closed));
      const waterPolysMercator = waterBodies.map((b) => b.poly);

      if (waterPolysMercator.length > 0) {
        // Pre-compute bounding boxes for fast rejection
        const polyBBoxes = waterPolysMercator.map((poly) => {
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          for (const p of poly) {
            if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
          }
          return { minX, maxX, minY, maxY };
        });

        // FLAT water-surface elevation per polygon: median DEM sampled at the polygon's SHORELINE
        // vertices. The waterline ≈ the body's real surface level, independent of the surrounding
        // terrain height — so this is one flat value per body, correct at any elevation (sea or a
        // hilltop pond). Fallback 0 (sea level) when no DEM sample is valid / no DEM loaded → -2.5,
        // preserving the flat-world behaviour. NOT per-vertex localDEM (that would follow terrain bumps).
        // SAFETY NET: reject any (closed) body whose shoreline DEM spans more than SHORELINE_SPAN_MAX — a
        // "closed" polygon covering that much elevation is mis-tagged/multi-elevation and must not be
        // flat-sunk (it would mesa/cone). Such polygons return null → skipped in the grid loop below.
        const SHORELINE_SPAN_MAX = 18; // metres
        const surfaceElev = waterPolysMercator.map((poly) => {
          if (!demSampler) return 0;
          const samples = [];
          for (const p of poly) {
            const ll = mercatorToLatLon(p.x, p.y);
            const e = demSampler.sampleElevation(ll.lat, ll.lon);
            if (e != null && Number.isFinite(e)) samples.push(e);
          }
          if (samples.length === 0) return 0;
          samples.sort((a, b) => a - b);
          if (samples[samples.length - 1] - samples[0] > SHORELINE_SPAN_MAX) return null; // multi-elevation → don't sink
          return samples[samples.length >> 1]; // median shoreline elevation (flat across the body)
        });

        function pointInPolyMercator(mx, my, poly) {
          let inside = false;
          for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i].x, yi = poly[i].y;
            const xj = poly[j].x, yj = poly[j].y;
            if (((yi > my) !== (yj > my)) && (mx < ((xj - xi) * (my - yi)) / (yj - yi) + xi))
              inside = !inside;
          }
          return inside;
        }

        for (let r = 0; r < TERRAIN_GRID; r++) {
          const lat = south + (north - south) * (r / (TERRAIN_GRID - 1));
          for (let c = 0; c < TERRAIN_GRID; c++) {
            const idx = r * TERRAIN_GRID + c;
            const lon = west + (east - west) * (c / (TERRAIN_GRID - 1));
            const m = latLonToMercator(lat, lon);
            for (let pi = 0; pi < waterPolysMercator.length; pi++) {
              const bb = polyBBoxes[pi];
              if (m.x < bb.minX || m.x > bb.maxX || m.y < bb.minY || m.y > bb.maxY) continue;
              if (pointInPolyMercator(m.x, m.y, waterPolysMercator[pi])) {
                if (surfaceElev[pi] == null) continue; // safety-net: multi-elevation body, do not flatten
                data[idx] = surfaceElev[pi] - WATER_SINK_DELTA; // flat, at the body's real surface
                sunkCells.add(idx);
                break;
              }
            }
          }
        }
      }
    }

    // Edge stitching store — right column and bottom row of this tile's elevation
    // so neighbouring tiles can blend across boundaries (prevents visible seams).
    const rightCol = new Array(TERRAIN_GRID);
    const bottomRow = new Array(TERRAIN_GRID);
    for (let r = 0; r < TERRAIN_GRID; r++) rightCol[r] = data[r * TERRAIN_GRID + (TERRAIN_GRID - 1)];
    for (let c = 0; c < TERRAIN_GRID; c++) bottomRow[c] = data[0 * TERRAIN_GRID + c];
    edgeStore.set(tileId, { rightCol, bottomRow });

    let minElev = Infinity, maxElev = -Infinity;
    for (const v of data) { if (v < minElev) minElev = v; if (v > maxElev) maxElev = v; }
    if (minElev === Infinity) { minElev = 0; maxElev = 0; }
    const tileMinElevation = minElev;
    const tileMaxElevation = maxElev;

    // ── Add DEM base elevation to road point Y values ───────────────────────
    // Road Y values from the elevation processor are offsets from ground (0 for
    // ground-level, +N*6 for bridges, -N*tunnelDepth for tunnels, etc.).
    // With real DEM, we add the sampled ground elevation at each point so that
    // road Y = groundDEM + layerOffset, giving correct absolute altitude.
    // BAKED_ROAD_ELEVATION_IS_RAW=true in frontend: frontend subtracts spawnElev.
    const tileRoadsFinal = tileRoads;
    if (demSampler) {
      const R_earth = 6378137;
      for (const road of tileRoadsFinal) {
        for (const p of road.points) {
          // p = [mercX, elevY, mercZ]  (Mercator X/Z, elevation Y from layer tags)
          const lon = (p[0] / R_earth) * (180 / Math.PI);
          const latRad = 2 * Math.atan(Math.exp(p[2] / R_earth)) - Math.PI / 2;
          const lat = latRad * (180 / Math.PI);
          const groundElev = demSampler.sampleElevation(lat, lon);
          if (groundElev != null && Number.isFinite(groundElev)) {
            // Road points are [mercX, yUp, mercZ, elev]. The SERIALIZED road elevation comes from p[3]
            // (convertToBinary flattenRoadPoints prefers the elevation array = p[3] whenever finite),
            // NOT p[1]. p[3] holds the layer-RELATIVE profile (0 for surface, ramp descent for ramps —
            // RampResolver is DEM-free), so adding groundDEM drapes every road on terrain: surface→DEM,
            // ramp→DEM+profile, no double-count. (Was `p[1] += groundElev` → wrong/ignored field → flat roads.)
            if (p.length >= 4) p[3] += groundElev;
            p[1] += groundElev; // keep the fallback (points[i][1]) consistent for any 3-element point
          }
        }
      }
    }
    // ── Authored trench carve (slice ②): LAST grid mutation — after water sink and road
    // drape, before payload assembly, so every consumer reads the trenched grid.
    if (trenchCorridors.length > 0) {
      const tr = carveTrenchesIntoGrid(data, { south, west, north, east, grid: TERRAIN_GRID }, trenchCorridors, sunkCells);
      if (tr.cellsCut > 0) console.log(`  [Trench] ${tileId}: cut ${tr.cellsCut} cells (max depth ${tr.maxCut.toFixed(1)}m)`);
      // Slice ③: validate drivable-surface-implies-floor on the CARVED grid with the DRAPED roads.
      floorViolations.push(...collectTunnelFloorViolations(tileId, tileRoadsFinal, data, { south, west, north, east }, TERRAIN_GRID));
    }

    const tileBuildings = buildingsByTile.get(tileId) || [];
    const tileGreens = greensByTile.get(tileId) || [];
    const tileWaters = watersByTile.get(tileId) || [];
    const tileBarriers = barriersByTile.get(tileId) || [];
    const tileRailways = railwaysByTile.get(tileId) || [];
    const tileBusStops = busStopsByTile.get(tileId) ?? [];
    const tileParkings = parkingsByTile.get(tileId) ?? [];
    const tileNodeIds = new Set();
    for (const r of tileRoadsFinal) {
      if (r.nodeIds) for (const nid of r.nodeIds) tileNodeIds.add(nid);
    }
    const tileNodes = {};
    for (const nid of tileNodeIds) {
      const n = nodeMap.get(nid);
      if (n) tileNodes[nid] = n;
    }
    const payload = {
      version: 5,
      tileId,
      ...(roadOnlyDebugMode && { roadOnlyMode: true }),
      elevation: {
        resolution: TERRAIN_GRID,
        data,
        min: minElev,
        max: maxElev,
        tileMinElevation,
        tileMaxElevation,
        south,
        west,
        north,
        east,
        gridRows: TERRAIN_GRID,
        gridCols: TERRAIN_GRID,
        elevations: data,
      },
      nodes: tileNodes,
      roads: tileRoadsFinal.filter((r) => {
        // Skip broken/incomplete-ramp roads — never baked (no mangled half-ramps / broken lines).
        if (isBrokenRampRoad(r, demSampler)) { droppedRampIds.add(r.id); return false; }
        // Skip known floor-gap roads (terrain spikes through the roadway — undrivable, accept gap).
        if (KNOWN_FLOOR_GAP_ROADS.has(r.id)) { droppedFloorGapIds.add(r.id); return false; }
        return true;
      }).map((r) => {
        // Phase 2: join pre-extracted tag data (tags are stripped by deepCloneRoad in graph pipeline)
        const p2 = phase2ById.get(r.id) || {};
        return {
          id: r.id,
          nodeIds: r.nodeIds || [],
          points: r.points.map((p) => [p[0], p[1], p[2]]),
          elevation: r.points.map((p) => p[3]),
          width: r.width,
          bridge: r.bridge,
          tunnel: r.tunnel,
          layer: r.layer,
          highwayType: r.highwayType,
          serviceSubtype: r.serviceSubtype || null,
          name: r.name || '',
          isRamp: r.isRamp === true,
          isRoundabout: r.isRoundabout === true,
          crossesTrench: r.crossesTrench === true, // OPTION L: deck colliders over daylighted corridors
          // Marked crossing — runtime skips the ribbon (bake-surface-clipping.md Phase 1)
          crossing: crossingIds.has(r.id) || null,
          // Phase 2 OSM fields via phase2ById lookup
          oneway:   p2.oneway   ?? null,
          lanes:    p2.lanes    ?? null,
          sidewalk: p2.sidewalk ?? null,
          cycleway: p2.cycleway ?? null,
          surface:  p2.surface  ?? null,
          maxspeed: p2.maxspeed ?? null,
          // Phase 4A+4C-B: parking restriction stripes.
          // Priority: :restriction > :condition > :lane. :both applies to both sides.
          parkingLeft: (
            p2['parking:left:restriction'] ||
            p2['parking:both:restriction'] ||
            p2['parking:condition:left']   ||
            p2['parking:condition:both']   ||
            p2['parking:lane:left']        ||
            p2['parking:lane:both']        ||
            null
          ),
          parkingRight: (
            p2['parking:right:restriction'] ||
            p2['parking:both:restriction']  ||
            p2['parking:condition:right']   ||
            p2['parking:condition:both']    ||
            p2['parking:lane:right']        ||
            p2['parking:lane:both']         ||
            null
          ),
          // Blue regulated parking: fee=yes, or parking=yes/lane/street_side
          parkingPaidLeft: (
            p2['parking:left:fee'] === 'yes' || p2['parking:both:fee'] === 'yes'
              ? 'paid'
              : (['yes','lane','street_side','diagonal','perpendicular'].includes(p2['parking:left']) ||
                 ['yes','lane','street_side','diagonal','perpendicular'].includes(p2['parking:both']))
                ? 'free' : null
          ),
          parkingPaidRight: (
            p2['parking:right:fee'] === 'yes' || p2['parking:both:fee'] === 'yes'
              ? 'paid'
              : (['yes','lane','street_side','diagonal','perpendicular'].includes(p2['parking:right']) ||
                 ['yes','lane','street_side','diagonal','perpendicular'].includes(p2['parking:both']))
                ? 'free' : null
          ),
        };
      }),
      buildings: tileBuildings.map((b) => {
        const entry = {
          id: b.id,
          footprint: b.footprint,
          height: b.height,
          levels: b.levels,
          type: b.type,
          name: b.name,
          roofShape: b.roofShape,
          layer: b.layer || 0,
        };
        if (b.innerRings && b.innerRings.length > 0) entry.innerRings = b.innerRings;
        if (b.material) entry.material = b.material;
        if (b.colour) entry.colour = b.colour;
        if (b.roofMaterial) entry.roofMaterial = b.roofMaterial;
        if (b.roofColour) entry.roofColour = b.roofColour;
        return entry;
      }),
      greens: tileGreens.map((g) => ({
        id: g.id,
        polygon: g.polygon,
        type: g.type,
      })),
      water: tileWaters.map((w) => ({
        id: w.id,
        type: w.type,
        polygon: w.polygonMercator || [],
        closed: w.closed,
        width: w.width,
      })),
      barriers: tileBarriers.map((b) => ({
        id: b.id,
        type: b.barrierType,
        isArea: b.isArea,
        height: b.heightOsm ?? BARRIER_DEFAULT_HEIGHTS[b.barrierType] ?? 2.0,
        points: b.pointsMercator.map((p) => {
          const w = mercatorToWorld(p.x, p.y);
          return [w.x, w.z];
        }),
        gates: b.gateNodeIds
          .map((id) => allGateNodes.get(id)).filter(Boolean)
          .map((p) => { const w = mercatorToWorld(p.x, p.y); return [w.x, w.z]; }),
      })),
      railways: tileRailways.map((rw) => ({
        id: rw.id,
        railwayType: rw.railwayType,
        layer: rw.layer,
        bridge: rw.bridge,
        tunnel: rw.tunnel,
        points: rw.pointsMercator.map((p) => [p.x, p.y]),
      })),
      junctions: tileJunctions.map(j => {
        const jWorld = mercatorToWorld(j.mx, j.my);
        // Phase 4B-1: enrich with radius (full max road width) and sorted approaches.
        // radius matches frontend getJunctionPoints() which uses maxWidth (full width, not half).
        const approaches = (j.roads || [])
          .map(r => ({ angle: r.angle, width: _wayWidth.get(r.wayId) ?? 6 }))
          .filter(r => Number.isFinite(r.angle))
          .sort((a, b) => a.angle - b.angle);
        const radius = approaches.length > 0 ? Math.max(...approaches.map(r => r.width)) : 0;
        return {
          nodeId: j.nodeId,
          x: jWorld.x, z: jWorld.z,
          type: j.type,
          layer: j.layer,
          roads: j.roads,
          radius,
          approaches,
          ...(j.gore ? { gore: j.gore } : {}),
        };
      }),
      busStops: tileBusStops,
      parking: tileParkings,
      urbanFeatures: urbanByTile.get(tileId) || [],
      // ── v7 features ──────────────────────────────────────────────────────
      beaches:          beachesByTile.get(tileId)  || [],
      pedestrianAreas:  pedAreasByTile.get(tileId) || [],
      marinas:          marinasByTile.get(tileId)  || [],
      trafficSignals:   signalsByTile.get(tileId)  || [],
      streetLamps:      lampsByTile.get(tileId)    || [],
      trees:            treesByTile.get(tileId)    || [],
      tourismPois:      tourismByTile.get(tileId)  || [],
      metroStations:    metroByTile.get(tileId)    || [],
      healthcare:       healthByTile.get(tileId)   || [],
      shops:            shopsByTile.get(tileId)    || [],
    };

    // ── Per-tile v7 feature count log (non-zero only) ─────────────────────
    const v7parts = [
      payload.beaches.length         && `beaches:${payload.beaches.length}`,
      payload.pedestrianAreas.length && `pedAreas:${payload.pedestrianAreas.length}`,
      payload.marinas.length         && `marinas:${payload.marinas.length}`,
      payload.trafficSignals.length  && `signals:${payload.trafficSignals.length}`,
      payload.streetLamps.length     && `lamps:${payload.streetLamps.length}`,
      payload.trees.length           && `trees:${payload.trees.length}`,
      payload.tourismPois.length     && `tourism:${payload.tourismPois.length}`,
      payload.metroStations.length   && `metro:${payload.metroStations.length}`,
      payload.healthcare.length      && `health:${payload.healthcare.length}`,
      payload.shops.length           && `shops:${payload.shops.length}`,
    ].filter(Boolean).join(' ');
    if (v7parts) console.log(`  [${tileId}] v7: ${v7parts}`);
    // ── Pre-bake terrain meshes ──────────────────────────────────────────
    // Only REAL drivable-road tunnels carve the terrain. WHITELIST (matches the runtime
    // DRIVABLE_TUNNEL_TYPES in tileManager.js) — a blacklist let footway/steps/path/pedestrian/cycleway/
    // SERVICE tunnels cut the hill, producing ugly "land cracks" (jagged sky-holes) on minor ways. Those
    // pedestrian/small tunnels are not modelled as drivable, so they must not carve.
    const _DRIVABLE_TUNNEL = new Set([
      'motorway', 'motorway_link', 'trunk', 'trunk_link',
      'primary', 'primary_link', 'secondary', 'secondary_link',
      'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street',
    ]);
    const tunnelRoadsForBake = (payload.roads || []).filter(r => r.tunnel && _DRIVABLE_TUNNEL.has(r.highwayType));

    // Approach ramp roads: surface roads (not tunnel-tagged) with at least one point
    // below -0.3m elevation. These are descent/ascent ramps where terrain must be cut
    // along the full corridor length. Points in payload.roads are [worldX, elev, worldZ].
    const approachRoadsForBake = (payload.roads || []).filter(r => {
      if (r.tunnel) return false;
      if (!_DRIVABLE_TUNNEL.has(r.highwayType)) return false; // only drivable-road ramps carve (no footway/service cracks)
      const pts = r.points || [];
      return pts.some(p => (Array.isArray(p) ? (p[1] ?? 0) : (p.elevation ?? 0)) < -0.3);
    });

    // Cross-tile tunnel approach corridors from adjacent tiles — Phase B.2/B.3
    // LEGACY TUNNEL CARVE DISABLED (slice ② — pulled forward from slice ⑤): the authored
    // trench is IN the elevation grid now, so the visual mesh shows the descent natively.
    // The old mouth-circle punching + corridor triangle-culling on top of that punched
    // see-through HOLES in the already-trenched mesh (sky visible through terrain at
    // portals). No tunnel/approach data is passed — the baker just meshes the grid.
    // v3 P4-01: NEITHER TERRAIN SECTION IS BAKED ANY MORE.
    //
    // `bakedTerrain` was 384.6 MB — 68.4% of a 565.9 MB tile store — and every byte of it was
    // derived from the 55.5 MB elevation grid shipping beside it. `backend/tools/terrainRegenProof.mjs`
    // re-ran this very function against each tile's own stored grid and reproduced 442 of 444 tiles
    // bit-for-bit. (The 2 that differed were baked at gridSize 64 against a 128 grid and already
    // failed the renderer's useBaked gate, so they were taking a runtime path in production.)
    // `frontend/src/map/terrainGrid.js` now generates the mesh in the parser worker, and
    // `frontend/test/terrainGrid.test.js` runs both implementations over real tiles to keep them
    // bit-equal.
    //
    // `bakedPhysicsTerrain` was a further 15.0 MB and has had ZERO consumers since v3 P0-12 deleted
    // its parse — terrain physics is a Heightfield built from the grid, never a Trimesh. It was
    // pure freight.
    //
    // Together: 399.6 MB of 565.9 MB, ~71% of the tile store.
    //
    // bakeTerrainMesh/bakePhysicsTerrain are kept in terrainBaker.js deliberately — the proof
    // harness runs the real function, so it must stay importable and must stay the reference the
    // frontend generator is tested against.
    void bakeTerrainMesh; void bakePhysicsTerrain;

    // ── Pre-bake vegetation positions ────────────────────────────────────
    if (!roadOnlyDebugMode) {
      const vegTileBounds = { south, west, north, east };
      const bakedVeg = bakeVegetation(payload, payload.elevation, vegTileBounds);
      if (bakedVeg && (bakedVeg.treeCount > 0 || bakedVeg.bushCount > 0 ||
                       bakedVeg.zoneTreeCount > 0 || bakedVeg.zoneBushCount > 0)) {
        payload.bakedVegetation = bakedVeg;
      }
    }

    // ── Pre-bake road surface geometry ──────────────────────────────────
    const bakedRoads = bakeRoadSurfaces(payload);
    if (bakedRoads && bakedRoads.layers.length > 0) {
      payload.bakedRoads = bakedRoads;
    }

    // ── Pre-bake sidewalk + curb geometry (v8) ──────────────────────────
    // Frontend uses these instead of the runtime generator when present (v7 tiles fall back).
    const bakedSidewalks = bakeSidewalks(payload);
    if (bakedSidewalks) payload.bakedSidewalks = bakedSidewalks;

    // ── Bake sky-visibility AO (v9) ──────────────────────────────────────
    // Occluders come from this tile + its 8 neighbours so street canyons darken correctly
    // across tile seams. Skipped in road-only debug mode (no buildings parsed).
    if (!roadOnlyDebugMode) {
      const aoGrid = bakeAoGrid(payload.elevation, gatherAoOccluders(tileId, buildingsByTile));
      if (aoGrid) payload.aoGrid = aoGrid;
    }

    const binBuf = convertTile(payload);
    fs.writeFileSync(filePath, binBuf);
    totalRoadSegmentsWritten += (payload.roads || []).length;
    written++;
    setPhaseProgress(written / sortedTileIds.length);
  }
  advancePhase(); // Phase 4 (tiles) done — 100%
  // Restore console after progress bar is done
  console.log = _origLog;
  console.warn = _origWarn;
  console.error = _origErr;
  process.stdout.write('\n');
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('  Wrote', written, 'tiles in', elapsed, 's to', outDir);
  console.log(`  [BrokenRamp] skipped ${droppedRampIds.size} broken/incomplete-ramp roads (grade > ${_BROKEN_RAMP_GRADE}) — not baked.`);

  // ── Slice ③: commit-blocking floor validator (drivable-surface-implies-floor) ──
  // Throws (non-zero exit) if any drivable tunnel road has a sample with no floor within
  // tolerance — a bad trench carve can never silently ship. TRENCH_VALIDATOR=report to
  // downgrade to a warning during diagnosis. The 2 pre-existing native-dip surface roads
  // are inverse-check (not forward-floor) cases — out of this check's scope, so unlisted.
  // Default BLOCK (slice ③ locked in 2026-07-01): the 5 known floor-gap roads are dropped + whitelisted,
  // so the in-scope count is 0 and any NEW carve regression hard-fails the bake. TRENCH_VALIDATOR=report
  // downgrades to a loud-but-non-fatal sentinel during diagnosis.
  if (droppedFloorGapIds.size) console.log(`  [FloorGap] dropped ${droppedFloorGapIds.size} known floor-gap roads (terrain through roadway) — not baked.`);


  const _validatorBlocking = process.env.TRENCH_VALIDATOR !== 'report';
  reportTunnelFloorValidation(floorViolations, { blocking: _validatorBlocking, whitelist: KNOWN_FLOOR_GAP_ROADS });

  const byType = {};
  let bridgeCount = 0;
  let tunnelCount = 0;
  for (const r of simplified) {
    const t = (r.highwayType || 'unknown').toLowerCase();
    byType[t] = (byType[t] || 0) + 1;
    if (r.bridge) bridgeCount++;
    if (r.tunnel) tunnelCount++;
  }
  const totalWaysRendered = simplified.length;
  console.log('');
  console.log('--- Road completeness debug ---');
  console.log('  Total ways parsed (highway=*):', totalWaysParsed);
  console.log('  Total ways rendered:', totalWaysRendered);
  console.log('  Highway type counts:', JSON.stringify(byType, null, 0));
  console.log('  Bridge roads:', bridgeCount);
  console.log('  Tunnel roads:', tunnelCount);

  // ── P-R1a · DEFECT CENSUS (osm-repair-layer.md §6) ────────────────────────────────────────────
  //
  // The bake already KNOWS which roads it threw away — `droppedRampIds` holds 332 of them — and
  // until now it printed a count and dropped the list on the floor. That list is the answer to
  // "why is there no road here when there obviously should be": these are not parse failures, they
  // are roads that parsed fine, were judged unusable by isBrokenRampRoad, and were deleted.
  //
  // P-R1 budgeted 1.5 days to build detectors. This half needed none of it: persisting a Set the
  // bake already holds turns the largest defect class from a number into an addressable list, and
  // every id here can be looked up on openstreetmap.org/way/<id>.
  //
  // Detection only, zero repairs — that is P-R1's whole contract.
  try {
    // alongside the PBF/DEM the census describes
    const censusPath = path.join(path.dirname(cfg.pbfPath), 'defect-census.json');
    const census = {
      generatedBy: 'buildRegion.js P-R1a',
      region: cfg.name,
      bbox,
      classes: {
        // V4 unresolvable-ramp — DELETED roads. The big one.
        V4_unresolvable_ramp: { count: droppedRampIds.size, ids: [...droppedRampIds] },
        // V5 terrain-conflict — hand-listed today, NOT a detector. The measured buried-road rate is
        // 8.8% of sampled points, so this count is a floor and not the class.
        V5_terrain_conflict_known: { count: droppedFloorGapIds.size, ids: [...droppedFloorGapIds],
          note: 'hand-listed KNOWN_FLOOR_GAP_ROADS only — the real V5 class needs the P-R1b detector' },
        // Unclassified shortfall between what was parsed and what reached a tile.
        unaccounted_ways: { parsed: totalWaysParsed, rendered: totalWaysRendered,
          count: Math.max(0, totalWaysParsed - totalWaysRendered) },
      },
      // Not counted because nothing looks: way stitching is disabled ([3/8] Skipping way stitching),
      // so an H3 count of zero would be a lie. Unknown is the honest value.
      unmeasured: ['H1_dangling_end', 'H2_near_miss_junction', 'H3_split_not_stitched',
                   'M1_implied_bridge', 'M2_implied_tunnel', 'M3_missing_connector'],
    };
    fs.writeFileSync(censusPath, JSON.stringify(census, null, 2));
    console.log(`  [Census] wrote ${censusPath} — V4 ${census.classes.V4_unresolvable_ramp.count} deleted ramps, ` +
                `${census.classes.unaccounted_ways.count} unaccounted ways`);
  } catch (e) {
    console.warn('  [Census] could not write defect census:', e.message);
  }

  console.log('  Total road segments written to tiles:', totalRoadSegmentsWritten);
  if (written > 0) {
    const avgPerTile = (totalRoadSegmentsWritten / written).toFixed(1);
    console.log('  Avg road segments per tile:', avgPerTile);
  }
  if ((cleanRoadPipeline || roadOnlyDebugMode) && written > 0) {
    console.log('  Total ways assigned to tiles (bbox-intersect):', allAssignedWayIds.size);
    console.log('  Total unique ways rendered in tiles:', allRenderedWayIds.size);
    const segCounts = [...waysPerTileCount.values()];
    console.log('  Segments per tile: min', Math.min(...segCounts), 'max', Math.max(...segCounts));
    if (parsedWayIds.size !== allRenderedWayIds.size) {
      const missing = [...parsedWayIds].filter((id) => !allRenderedWayIds.has(id));
      console.warn('  Parsed != rendered: missing', missing.length, 'ways');
      if (missing.length <= 20) console.warn('  Missing ids:', missing.join(', '));
      else console.warn('  Missing ids (first 20):', missing.slice(0, 20).join(', '));
    }
  }
  if (totalWaysRendered < totalWaysParsed) {
    console.warn('  WARNING: Rendered ways (' + totalWaysRendered + ') < parsed ways (' + totalWaysParsed + ')');
  }
  if (roadOnlyDebugMode) {
    console.log('  Road-only debug mode: buildings=0, greens=0, terrain=flat');
  }

  console.log('');
  console.log('=== Done in', elapsed, 's ===');
  console.log('');
}

main().catch((err) => {
  console.error('');
  console.error('Build failed:', err.message);
  console.error(err);
  process.exit(1);
});
