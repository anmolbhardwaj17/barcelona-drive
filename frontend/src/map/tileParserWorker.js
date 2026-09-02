/**
 * Web Worker: parse tile data off the main thread.
 *
 * Supports TWO formats:
 *   1. Binary v6 (application/octet-stream) — parsed via inline binary parser
 *   2. JSON v5 fallback — parsed + coordinate-converted as before
 *
 * Receives: { url, originX, originY, tileVersion, id }
 * Returns:  parsed + converted tile data (same shape as mapLoader output)
 */

// ═══════════════════════════════════════════════════════════════════════════════
//  Binary v6 parser (inlined — workers can't use ES module imports)
// ═══════════════════════════════════════════════════════════════════════════════

// Unstretch-X (vertical-model-foundation-spec §3): baked horizontal coords are absolute
// Mercator; after subtracting the origin, multiply by cos(ORIGIN_LAT) so world XZ = real metres.
// Applied to every Mercator→world subtraction below. MUST match frontend/src/projection.js
// MERCATOR_UNSTRETCH (ORIGIN_LAT = 41.350). Vertical (elevation) is never scaled.
const MERCATOR_UNSTRETCH = Math.cos((41.350 * Math.PI) / 180);

import { buildTerrainFromGrid } from './terrainGrid.js';   // v3 P4-01 — see the note at bakedTerrain
import { smoothPolyline } from './roadSmoothing.js';

const textDecoder = new TextDecoder();

// Pack an array of features' point rings into two transferable typed arrays: `coords` = interleaved x,y
// (Float32), `offsets` = cumulative point counts (Uint32, length = nRings+1). Empty rings are dropped.
function packRings(features, key) {
  let total = 0, n = 0;
  for (const f of features) { const p = f[key]; if (p && p.length) { total += p.length; n++; } }
  const coords = new Float32Array(total * 2);
  const offsets = new Uint32Array(n + 1);
  let ci = 0, oi = 0;
  for (const f of features) {
    const p = f[key];
    if (!p || !p.length) continue;
    for (let i = 0; i < p.length; i++) { coords[ci++] = p[i].x; coords[ci++] = p[i].y; }
    offsets[++oi] = ci >> 1;
  }
  return { coords, offsets };
}

// Pack the LITE (custom-map) features into transferable typed arrays. The whole-city background load ships
// 426 of these; returning them as nested {x,y} object graphs made the main-thread structured-clone RECEIVE
// (mapLoader `_worker.onmessage`) the #1 allocator (~64% of GC) AND a synchronous mid-frame burst that
// stuttered driving. Typed arrays transfer zero-copy, so the receive costs nothing; ingestTile re-inflates
// on the idle-paced side. Road width/type/name stay as plain arrays (few, string-interned → cheap to clone).
function packLite(roads, water, greens, beaches) {
  const road = packRings(roads, 'points');
  const nR = road.offsets.length - 1;
  const rWidth = new Float32Array(nR);
  const rType = new Array(nR);
  const rName = new Array(nR);
  let k = 0;
  for (const r of roads) {
    if (!r.points || !r.points.length) continue;
    rWidth[k] = Number.isFinite(r.width) && r.width > 0 ? r.width : -1;
    rType[k] = r.highwayType || '';
    rName[k] = r.name || '';
    k++;
  }
  const wat = packRings(water, 'polygon');
  const grn = packRings(greens, 'polygon');
  const bch = packRings(beaches || [], 'polygon');
  return {
    packed: true,
    rCoords: road.coords, rOffsets: road.offsets, rWidth, rType, rName,
    wCoords: wat.coords, wOffsets: wat.offsets,
    pCoords: grn.coords, pOffsets: grn.offsets,
    bCoords: bch.coords, bOffsets: bch.offsets,
  };
}

/**
 * The binary tile format this build understands (v10: + the R-W1 width section).
 *
 * ⚠ THIS IS THE CACHE KEY THAT WAS MISSING. The JSON fallback path has always compared versions,
 * but the BINARY path parsed whatever IndexedDB held and served it — forever. That is precisely why
 * CLAUDE.md tells every player to run `window._clearTileCache()` by hand after a re-bake: the
 * manual step existed because the code did not do it, and forgetting it means driving a stale city
 * with no warning. `peekBinaryVersion` closes that, so a re-bake now invalidates itself.
 *
 * Bump this whenever convertToBinary.js' `header.version` changes; they must move together.
 */
const BINARY_TILE_VERSION = 10;

/** Read just the version out of a binary tile, without parsing the rest. */
function peekBinaryVersion(buffer) {
  try {
    const headerLen = new DataView(buffer, 0, 4).getUint32(0, true);
    const bytes = new Uint8Array(buffer, 4, headerLen);
    let end = headerLen;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return JSON.parse(textDecoder.decode(new Uint8Array(buffer, 4, end))).version ?? null;
  } catch {
    return null;
  }
}

function parseBinaryTile(buffer, originX, originY, lite = false) {
  const headerView = new DataView(buffer, 0, 4);
  const headerLen = headerView.getUint32(0, true); // includes padding to 4-byte boundary
  const headerBytes = new Uint8Array(buffer, 4, headerLen);
  // Trim trailing null padding bytes before parsing JSON
  let jsonEnd = headerLen;
  while (jsonEnd > 0 && headerBytes[jsonEnd - 1] === 0) jsonEnd--;
  const header = JSON.parse(textDecoder.decode(new Uint8Array(buffer, 4, jsonEnd)));

  const binOffset = 4 + headerLen;
  const ox = originX || 0;
  const oy = originY || 0;

  const roads = header.roads
    ? readRoads(header.roads, buffer, binOffset, ox, oy)
    : [];

  const water = header.water
    ? readPolygonFeatures(header.water, buffer, binOffset, 'polygonOffset', 'polygonCount', ox, oy)
    : [];

  const greens = header.greens
    ? readGreens(header.greens, buffer, binOffset)
    : [];

  // LITE parse (custom-map background load): only the 2D features it draws. Skips buildings, the heavy
  // elevation grid (Array.from a Float32 grid — the #1 allocator), vegetation, terrain, and all POIs.
  if (lite) {
    const liteBeaches = header.beaches ? readAreaFeatures(header.beaches, buffer, binOffset) : [];
    return packLite(roads, water, greens, liteBeaches.filter((b) => !b.isLine));
  }

  const buildings = header.buildings
    ? readBuildings(header.buildings, buffer, binOffset)
    : [];

  let elevation = null;
  if (header.elevation) {
    elevation = readElevation(header.elevation, buffer, binOffset);
  }

  const barriers = header.barriers
    ? readBarriers(header.barriers, buffer, binOffset)
    : [];

  const junctions = header.junctions
    ? readJunctions(header.junctions, buffer, binOffset)
    : [];

  const busStops = header.busStops
    ? readBusStops(header.busStops, buffer, binOffset)
    : [];

  const parking = header.parking
    ? readParking(header.parking, buffer, binOffset)
    : [];

  const urbanFeatures = header.urbanFeatures
    ? readUrbanFeatures(header.urbanFeatures, buffer, binOffset)
    : [];

  // ── v7 features (absent in v6 tiles → empty arrays, backward compatible) ──
  const beaches = header.beaches
    ? readAreaFeatures(header.beaches, buffer, binOffset)
    : [];
  const pedestrianAreas = header.pedestrianAreas
    ? readAreaFeatures(header.pedestrianAreas, buffer, binOffset)
    : [];
  const marinas = header.marinas
    ? readAreaFeatures(header.marinas, buffer, binOffset)
    : [];
  // P-D1: what each exit of each junction leads to. Positions are mercator like every other point
  // feature and are converted with the same helper; the exits ride the header as plain objects.
  const junctionSigns = Array.isArray(header.junctionSigns)
    ? header.junctionSigns.map((j) => {
        const f32 = new Float32Array(buffer, binOffset + j.pointOffset, 2);
        const w = mercatorToWorld(f32[0], f32[1], originX, originY);
        return { point: [w.x, w.z], exits: j.exits };
      })
    : [];
  const trafficSignals = header.trafficSignals
    ? readPointList(header.trafficSignals, buffer, binOffset, (entry, f32) => {
        const r = { id: entry.id, point: [f32[0], f32[1]] };
        if (entry.direction != null) r.direction = entry.direction;
        return r;
      })
    : [];
  const streetLamps = header.streetLamps
    ? readPointList(header.streetLamps, buffer, binOffset, (entry, f32) => {
        const r = { id: entry.id, point: [f32[0], f32[1]] };
        if (entry.height != null) r.height = entry.height;
        return r;
      })
    : [];
  const trees = (header.trees && header.treePositions)
    ? readTrees(header.trees, header.treePositions, buffer, binOffset)
    : [];
  const tourismPois = header.tourismPois
    ? readPointList(header.tourismPois, buffer, binOffset, (entry, f32) => {
        const r = { id: entry.id, type: entry.type, point: [f32[0], f32[1]] };
        if (entry.name) r.name = entry.name;
        return r;
      })
    : [];
  const metroStations = header.metroStations
    ? readPointList(header.metroStations, buffer, binOffset, (entry, f32) => {
        const r = { id: entry.id, point: [f32[0], f32[1]] };
        if (entry.name)    r.name    = entry.name;
        if (entry.network) r.network = entry.network;
        if (entry.lines)   r.lines   = entry.lines;
        return r;
      })
    : [];
  const healthcare = header.healthcare
    ? readPointList(header.healthcare, buffer, binOffset, (entry, f32) => {
        const r = { id: entry.id, type: entry.type, point: [f32[0], f32[1]] };
        if (entry.name) r.name = entry.name;
        return r;
      })
    : [];
  const shops = (header.shops && header.shopPositions && header.shopCategories)
    ? readShops(header.shops, header.shopPositions, header.shopCategories, buffer, binOffset)
    : [];

  // v3 P4-01: GENERATE the terrain mesh from the elevation grid instead of reading the baked one.
  //
  // The bake shipped positions/normals/uvs/indices per tile — 384.6 MB, 68.4% of the tile store —
  // all of it derived from the 55.5 MB elevation grid sitting beside it. `terrainRegenProof.mjs`
  // reproduced 442 of 444 tiles bit-for-bit from that grid alone, so the payload was pure
  // redundancy. Generating here costs a per-tile mesh build in the worker (off the main thread,
  // where the tile is already being parsed) and saves the download and the parse of four arrays.
  //
  // The two tiles that did NOT reproduce were baked at gridSize 64 against a 128 grid and already
  // failed the renderer's `useBaked` gate, so they were taking a runtime path in production anyway;
  // generating fixes them rather than changing them.
  //
  // Shape matches `readBakedTerrain` exactly so the renderer's baked path consumes it unchanged —
  // except indices are Uint16 (max vertex index across all 444 tiles is 16 383, measured).
  let bakedTerrain = elevation ? buildTerrainFromGrid(elevation) : null;
  if (!bakedTerrain && header.bakedTerrain) {
    // Belt and braces: a tile whose grid is missing or unreadable still renders from its bake.
    bakedTerrain = readBakedTerrain(header.bakedTerrain, buffer, binOffset);
  }

  // v3 P0-12: bakedPhysicsTerrain parsing DELETED. Its only consumer was createTerrainTrimesh
  // (tileManager), which has zero call sites — terrain physics is a Heightfield, not a Trimesh.
  // The section is still present in v9 tiles; it is simply no longer read into memory.


  const result = {
    roads,
    buildings,
    railways: header.railways
      ? readRailways(header.railways, buffer, binOffset, ox, oy)
      : [],
    vegetation: { trees: [], greenAreas: [] },
    water,
    greens,
    barriers,
    junctions,
    busStops,
    parking,
    urbanFeatures,
    elevation,
    // v7 features (empty arrays for v6 tiles)
    beaches,
    pedestrianAreas,
    marinas,
    trafficSignals,
    junctionSigns,
    streetLamps,
    trees,
    tourismPois,
    metroStations,
    healthcare,
    shops,
  };

  if (bakedTerrain) result.bakedTerrain = bakedTerrain;
  if (header.bakedVegetation) {
    result.bakedVegetation = readBakedVegetation(header.bakedVegetation, buffer, binOffset, ox, oy);
  }
  if (header.bakedRoads) {
    result.bakedRoads = readBakedRoads(header.bakedRoads, buffer, binOffset);
  }
  if (header.bakedSidewalks) {   // v8 — baked sidewalk/curb geometry (absent on v7 → runtime generator)
    result.bakedSidewalks = readBakedSidewalks(header.bakedSidewalks, buffer, binOffset);
  }
  if (header.aoGrid) {           // v9 — baked sky-visibility AO (absent → treat sky as fully open)
    // Bytes were packed 4-per-u32 LSB-first at bake, so on little-endian a plain byte view of the
    // section IS the original uint8 grid. Copy (don't alias) — the tile buffer gets transferred.
    const a = header.aoGrid;
    result.aoGrid = {
      resolution: a.resolution,
      data: new Uint8Array(new Uint8Array(buffer, binOffset + a.dataOffset, a.byteLength)),
    };
  }
  if (header.roadOnlyMode) result.roadOnlyMode = true;

  return result;
}

function readFloat32Triples(buffer, binOffset, offset, count, ox, oy) {
  const byteStart = binOffset + offset;
  const f32 = new Float32Array(buffer, byteStart, count * 3);
  const out = new Array(count);
  // cos belongs exactly where origin-subtraction happens. Callers that pass ox/oy hold ABSOLUTE
  // Mercator → subtract origin AND unstretch here. (Road points are always Mercator-stored.)
  const offX = ox || 0, offY = oy || 0;
  const scale = (ox != null || oy != null) ? MERCATOR_UNSTRETCH : 1;
  for (let i = 0, j = 0; i < count; i++, j += 3) {
    const pt = { x: (f32[j] - offX) * scale, y: (f32[j + 2] - offY) * scale, elevation: f32[j + 1] };
    out[i] = pt;
  }
  return out;
}

function readFloat32Pairs(buffer, binOffset, offset, count, ox, oy) {
  const byteStart = binOffset + offset;
  const f32 = new Float32Array(buffer, byteStart, count * 2);
  const out = new Array(count);
  const offX = ox || 0;
  const offY = oy || 0;
  // cos belongs exactly where origin-subtraction happens. Callers passing ox/oy hold ABSOLUTE
  // Mercator (roads-via-pairs, water) → subtract + unstretch. Callers WITHOUT ox/oy (building
  // footprints, greens, parking) are already real-metre WORLD from the bake's mercatorToWorld
  // (which now applies cos) → read raw, do NOT cos again (that was a double-correction split).
  const scale = (ox != null || oy != null) ? MERCATOR_UNSTRETCH : 1;
  for (let i = 0, j = 0; i < count; i++, j += 2) {
    out[i] = { x: (f32[j] - offX) * scale, y: (f32[j + 1] - offY) * scale };
  }
  return out;
}

function readRoads(rawRoads, buffer, binOffset, ox, oy) {
  const out = new Array(rawRoads.length);
  for (let i = 0; i < rawRoads.length; i++) {
    const r = rawRoads[i];
    // ⚠ SMOOTHING GOES HERE, ON THE BINARY PATH. It was first applied in `roadToWorld`, which is
    // only reached by `parseJsonTile` — "a rare fallback" by its own comment — so it rounded
    // nothing in the shipped game. Tiles are binary v10 and every one of them lands in readRoads.
    //
    // This is still the single choke point the fix needs: the ribbon, kerbs, markings, guard-rail
    // mask and the per-segment physics box colliders all read `road.points` from here, so the
    // player and the car cannot end up with different geometry.
    const points = smoothPolyline(
      readFloat32Triples(buffer, binOffset, r.pointsOffset, r.pointCount, ox, oy));
    out[i] = {
      id: r.id,
      width: r.width,          // R-W1: alias of kerbToKerbW — the DRAWN paved surface
      highwayType: r.highwayType,
      points,
      // R-W1: the width SECTION (v10). Copied unconditionally, not behind `!== undefined`, so a
      // pre-v10 tile yields explicit `undefined` and roadWidths.js' fallback fires — rather than
      // the field quietly not existing, which is how nine consumers ended up each inventing one.
      carriagewayW:  r.carriagewayW,
      parkingLeftW:  r.parkingLeftW,
      parkingRightW: r.parkingRightW,
      shoulderW:     r.shoulderW,
      kerbToKerbW:   r.kerbToKerbW,
      sidewalkW:     r.sidewalkW,
      corridorW:     r.corridorW,
    };
    if (r.bridge !== undefined) out[i].bridge = r.bridge;
    if (r.crossesTrench !== undefined) out[i].crossesTrench = r.crossesTrench; // OPTION L: deck colliders over daylighted corridors
    if (r.crossing !== undefined) out[i].crossing = r.crossing; // marked crossing — renderer skips the ribbon
    if (r.tunnel !== undefined) out[i].tunnel = r.tunnel;
    if (r.layer !== undefined) out[i].layer = r.layer;
    if (r.name !== undefined) out[i].name = r.name;
    if (r.oneway !== undefined) out[i].oneway = r.oneway;
    if (r.lanes !== undefined) out[i].lanes = r.lanes;
    if (r.surface !== undefined) out[i].surface = r.surface;
    if (r.lit !== undefined) out[i].lit = r.lit;
    if (r.maxspeed !== undefined) out[i].maxspeed = r.maxspeed;
    if (r.divider !== undefined) out[i].divider = r.divider;
    if (r.sidewalk !== undefined) out[i].sidewalk = r.sidewalk;
    if (r.cycleway !== undefined) out[i].cycleway = r.cycleway;
    if (r.parkingLeft      !== undefined) out[i].parkingLeft      = r.parkingLeft;      // Phase 4A
    if (r.parkingRight     !== undefined) out[i].parkingRight     = r.parkingRight;     // Phase 4A
    if (r.parkingPaidLeft  !== undefined) out[i].parkingPaidLeft  = r.parkingPaidLeft;  // Phase 4C-B
    if (r.parkingPaidRight !== undefined) out[i].parkingPaidRight = r.parkingPaidRight; // Phase 4C-B
    if (r.isRamp      !== undefined) out[i].isRamp      = r.isRamp;
    if (r.isRoundabout !== undefined) out[i].isRoundabout = r.isRoundabout;
    if (r.serviceSubtype !== undefined) out[i].serviceSubtype = r.serviceSubtype;
  }
  return out;
}

function readRailways(rawRailways, buffer, binOffset, ox, oy) {
  const out = new Array(rawRailways.length);
  for (let i = 0; i < rawRailways.length; i++) {
    const r = rawRailways[i];
    const points = readFloat32Pairs(buffer, binOffset, r.pointsOffset, r.pointCount, ox, oy);
    out[i] = {
      id: r.id,
      railwayType: r.railwayType,
      layer: r.layer || 0,
      bridge: r.bridge || false,
      tunnel: r.tunnel || false,
      points,
    };
  }
  return out;
}

function readBuildings(rawBuildings, buffer, binOffset) {
  const out = new Array(rawBuildings.length);
  for (let i = 0; i < rawBuildings.length; i++) {
    const b = rawBuildings[i];
    const footprint = readFloat32Pairs(buffer, binOffset, b.footprintOffset, b.footprintCount);

    const bld = {
      id: b.id,
      height: b.height,
      levels: b.levels,
      type: b.type,
      footprint,
    };

    if (b.innerRingsOffset !== undefined && b.innerRingCounts && b.innerRingCounts.length > 0) {
      const byteStart = binOffset + b.innerRingsOffset;
      let totalPts = 0;
      for (let k = 0; k < b.innerRingCounts.length; k++) totalPts += b.innerRingCounts[k];
      const f32 = new Float32Array(buffer, byteStart, totalPts * 2);

      const innerRings = new Array(b.innerRingCounts.length);
      let idx = 0;
      for (let k = 0; k < b.innerRingCounts.length; k++) {
        const cnt = b.innerRingCounts[k];
        const ring = new Array(cnt);
        for (let p = 0; p < cnt; p++, idx += 2) {
          ring[p] = { x: f32[idx], y: f32[idx + 1] };
        }
        innerRings[k] = ring;
      }
      bld.innerRings = innerRings;
    }

    if (b.minHeight !== undefined) bld.minHeight = b.minHeight;
    if (b.colour !== undefined) bld.colour = b.colour;
    if (b.material !== undefined) bld.material = b.material;
    if (b.roofShape !== undefined) bld.roofShape = b.roofShape;
    if (b.roofHeight !== undefined) bld.roofHeight = b.roofHeight;
    if (b.roofColour !== undefined) bld.roofColour = b.roofColour;
    if (b.name !== undefined) bld.name = b.name;

    out[i] = bld;
  }
  return out;
}

function readElevation(elev, buffer, binOffset) {
  const byteStart = binOffset + elev.elevationsOffset;
  const count = elev.gridRows * elev.gridCols;
  const f32 = new Float32Array(buffer, byteStart, count);
  // Convert to plain Array so Array.isArray() checks in terrain renderer pass
  const elevations = Array.from(f32);

  return {
    resolution: elev.resolution,
    min: elev.min,
    max: elev.max,
    south: elev.south,
    west: elev.west,
    north: elev.north,
    east: elev.east,
    // Stage 2 (DEM-on): force null so all 6 consumption sites use the spawn-anchored
    // getWorldElevationOffset() instead of the per-tile rebasing fork (and elevationIsRebased→false).
    // Single region-wide baseline: every Y = rawAbsoluteDEM − spawnElev → spawn normalizes to ~0.
    tileMinElevation: null,
    tileMaxElevation: elev.tileMaxElevation,
    gridRows: elev.gridRows,
    gridCols: elev.gridCols,
    elevations,
  };
}

function readPolygonFeatures(items, buffer, binOffset, offsetKey, countKey, ox, oy) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const polygon = readFloat32Pairs(buffer, binOffset, item[offsetKey], item[countKey], ox, oy);
    out[i] = { id: item.id, type: item.type, polygon };
  }
  return out;
}

function readGreens(rawGreens, buffer, binOffset) {
  const out = new Array(rawGreens.length);
  for (let i = 0; i < rawGreens.length; i++) {
    const g = rawGreens[i];
    const polygon = readFloat32Pairs(buffer, binOffset, g.polygonOffset, g.polygonCount);
    out[i] = { id: g.id, polygon, type: g.type };
  }
  return out;
}

function readBarriers(rawBarriers, buffer, binOffset) {
  const out = new Array(rawBarriers.length);
  for (let i = 0; i < rawBarriers.length; i++) {
    const b = rawBarriers[i];
    // Barrier renderer expects points as arrays [x, z], not {x, y} objects
    const byteStart = binOffset + b.pointsOffset;
    const f32 = new Float32Array(buffer, byteStart, b.pointCount * 2);
    const points = new Array(b.pointCount);
    for (let p = 0, j = 0; p < b.pointCount; p++, j += 2) {
      points[p] = [f32[j], f32[j + 1]];
    }
    out[i] = {
      id: b.id,
      type: b.type,
      isArea: b.isArea,
      height: b.height,
      points,
      gates: b.gates || [],
    };
  }
  return out;
}

function readJunctions(rawJunctions, buffer, binOffset) {
  const out = new Array(rawJunctions.length);
  for (let i = 0; i < rawJunctions.length; i++) {
    const j = rawJunctions[i];
    const junc = {
      nodeId: j.nodeId,
      x: j.x,
      z: j.z,
      type: j.type,
      layer: j.layer,
      roads: j.roads,
    };
    if (j.radius    != null)  junc.radius    = j.radius;     // Phase 4B-1
    if (j.approaches?.length) junc.approaches = j.approaches; // Phase 4B-1

    if (j.gore) {
      if (j.gore.verticesOffset !== undefined && j.gore.verticesCount > 0) {
        const vByteStart = binOffset + j.gore.verticesOffset;
        const vF32 = new Float32Array(buffer, vByteStart, j.gore.verticesCount);
        const vertices = new Array(j.gore.verticesCount);
        for (let k = 0; k < vertices.length; k++) vertices[k] = vF32[k];

        let indices = [];
        if (j.gore.indicesOffset !== undefined && j.gore.indicesCount > 0) {
          const iByteStart = binOffset + j.gore.indicesOffset;
          const u32 = new Uint32Array(buffer, iByteStart, j.gore.indicesCount);
          indices = new Array(j.gore.indicesCount);
          for (let k = 0; k < indices.length; k++) indices[k] = u32[k];
        }

        junc.gore = { vertices, indices };
      }
    }

    out[i] = junc;
  }
  return out;
}

function readBusStops(rawStops, buffer, binOffset) {
  const out = new Array(rawStops.length);
  for (let i = 0; i < rawStops.length; i++) {
    const bs = rawStops[i];
    const byteStart = binOffset + bs.pointOffset;
    const f32 = new Float32Array(buffer, byteStart, 2);
    const entry = { id: bs.id, point: [f32[0], f32[1]] };
    if (bs.name !== undefined) entry.name = bs.name;
    out[i] = entry;
  }
  return out;
}

function readParking(rawParking, buffer, binOffset) {
  const out = new Array(rawParking.length);
  for (let i = 0; i < rawParking.length; i++) {
    const p = rawParking[i];
    const polygon = readFloat32Pairs(buffer, binOffset, p.polygonOffset, p.polygonCount);
    out[i] = {
      id: p.id,
      polygon,
      parkingType: p.parkingType,
      capacity: p.capacity,
    };
  }
  return out;
}

function readUrbanFeatures(rawFeatures, buffer, binOffset) {
  const out = new Array(rawFeatures.length);
  for (let i = 0; i < rawFeatures.length; i++) {
    const uf = rawFeatures[i];
    const byteStart = binOffset + uf.pointOffset;
    const f32 = new Float32Array(buffer, byteStart, 2);
    out[i] = {
      id: uf.id,
      type: uf.type,
      point: [f32[0], f32[1]],
      tags: uf.tags,
    };
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Baked terrain readers
// ═══════════════════════════════════════════════════════════════════════════════

// ── v7 reader functions ────────────────────────────────────────────────────

/** Read polygon features (beaches, pedestrianAreas, marinas). Same encoding as greens. */
function readAreaFeatures(rawFeatures, buffer, binOffset) {
  const out = new Array(rawFeatures.length);
  for (let i = 0; i < rawFeatures.length; i++) {
    const f = rawFeatures[i];
    const byteStart = binOffset + f.polygonOffset;
    const f32 = new Float32Array(buffer, byteStart, f.polygonCount * 2);
    const polygon = new Array(f.polygonCount);
    for (let j = 0, k = 0; j < f.polygonCount; j++, k += 2) {
      polygon[j] = { x: f32[k], y: f32[k + 1] };
    }
    const entry = { id: f.id, type: f.type, polygon };
    if (f.isLine) entry.isLine = true;
    out[i] = entry;
  }
  return out;
}

/** Generic point feature reader. buildEntry(headerEntry, float32View) → object. */
function readPointList(rawList, buffer, binOffset, buildEntry) {
  const out = new Array(rawList.length);
  for (let i = 0; i < rawList.length; i++) {
    const entry = rawList[i];
    const byteStart = binOffset + entry.pointOffset;
    const f32 = new Float32Array(buffer, byteStart, 2);
    out[i] = buildEntry(entry, f32);
  }
  return out;
}

/** Read trees — positions stored as flat Float32 array, metadata per-entry in header. */
function readTrees(rawEntries, posInfo, buffer, binOffset) {
  const count = posInfo.count;
  const byteStart = binOffset + posInfo.offset;
  const f32 = new Float32Array(buffer, byteStart, count * 2);
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const entry = { id: rawEntries[i].id, point: [f32[i * 2], f32[i * 2 + 1]] };
    if (rawEntries[i].species) entry.species = rawEntries[i].species;
    if (rawEntries[i].height != null) entry.height = rawEntries[i].height;
    out[i] = entry;
  }
  return out;
}

/** Read shops — positions as flat Float32 array, categories as packed Uint32, names in header. */
function readShops(rawEntries, posInfo, catInfo, buffer, binOffset) {
  const count = posInfo.count;
  // Positions
  const posByteStart = binOffset + posInfo.offset;
  const posF32 = new Float32Array(buffer, posByteStart, count * 2);
  // Categories (packed Uint8 in Uint32)
  const catByteStart = binOffset + catInfo.offset;
  const catU32 = new Uint32Array(buffer, catByteStart, catInfo.count);
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const wi = i >> 2;
    const cat = (catU32[wi] >> ((i & 3) * 8)) & 0xFF;
    const entry = {
      id: rawEntries[i].id,
      cat,
      point: [posF32[i * 2], posF32[i * 2 + 1]],
    };
    if (rawEntries[i].name) entry.name = rawEntries[i].name;
    out[i] = entry;
  }
  return out;
}

// ── isRoundabout: already stored in road header entry, readRoads picks it up ──

function readBakedTerrain(bt, buffer, binOffset) {
  const result = {
    gridSize: bt.gridSize,
    vertExag: bt.vertExag,
  };
  if (bt.positionsOffset !== undefined && bt.positionsCount > 0) {
    result.positions = new Float32Array(buffer, binOffset + bt.positionsOffset, bt.positionsCount);
  }
  if (bt.normalsOffset !== undefined && bt.normalsCount > 0) {
    result.normals = new Float32Array(buffer, binOffset + bt.normalsOffset, bt.normalsCount);
  }
  if (bt.uvsOffset !== undefined && bt.uvsCount > 0) {
    result.uvs = new Float32Array(buffer, binOffset + bt.uvsOffset, bt.uvsCount);
  }
  if (bt.indicesOffset !== undefined && bt.indicesCount > 0) {
    result.indices = new Uint32Array(buffer, binOffset + bt.indicesOffset, bt.indicesCount);
  }
  return result;
}


function readBakedVegetation(bv, buffer, binOffset, ox, oy) {
  ox = ox || 0;
  oy = oy || 0;

  // Helper: read Float32 pairs and subtract origin to convert Mercator → world coords
  function readPositionPairs(offset, count) {
    const src = new Float32Array(buffer, binOffset + offset, count * 2);
    const out = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      out[i * 2]     = (src[i * 2]     - ox) * MERCATOR_UNSTRETCH;  // x
      out[i * 2 + 1] = (src[i * 2 + 1] - oy) * MERCATOR_UNSTRETCH;  // z
    }
    return out;
  }

  const result = {
    treeCount: bv.treeCount || 0,
    bushCount: bv.bushCount || 0,
    zoneTreeCount: bv.zoneTreeCount || 0,
    zoneBushCount: bv.zoneBushCount || 0,
  };
  if (bv.treePositionsOffset !== undefined && bv.treePositionsCount > 0) {
    result.treePositions = readPositionPairs(bv.treePositionsOffset, bv.treeCount);
  }
  if (bv.treeVariantsOffset !== undefined && bv.treeVariantsCount > 0) {
    // Unpack Uint32 back to Uint8Array
    const packed = new Uint32Array(buffer, binOffset + bv.treeVariantsOffset, bv.treeVariantsCount);
    const variants = new Uint8Array(result.treeCount);
    for (let i = 0; i < result.treeCount; i++) {
      const u32Idx = (i >> 2);
      const byteIdx = (i & 3);
      variants[i] = (packed[u32Idx] >> (byteIdx * 8)) & 0xFF;
    }
    result.treeVariants = variants;
  }
  if (bv.bushPositionsOffset !== undefined && bv.bushPositionsCount > 0) {
    result.bushPositions = readPositionPairs(bv.bushPositionsOffset, bv.bushCount);
  }
  if (bv.zoneTreePositionsOffset !== undefined && bv.zoneTreePositionsCount > 0) {
    result.zoneTreePositions = readPositionPairs(bv.zoneTreePositionsOffset, bv.zoneTreeCount);
  }
  if (bv.zoneTreeVariantsOffset !== undefined && bv.zoneTreeVariantsCount > 0) {
    const packed = new Uint32Array(buffer, binOffset + bv.zoneTreeVariantsOffset, bv.zoneTreeVariantsCount);
    const variants = new Uint8Array(result.zoneTreeCount);
    for (let i = 0; i < result.zoneTreeCount; i++) {
      const u32Idx = (i >> 2);
      const byteIdx = (i & 3);
      variants[i] = (packed[u32Idx] >> (byteIdx * 8)) & 0xFF;
    }
    result.zoneTreeVariants = variants;
  }
  if (bv.zoneTreeScalesOffset !== undefined && bv.zoneTreeScalesCount > 0) {
    result.zoneTreeScales = new Float32Array(buffer, binOffset + bv.zoneTreeScalesOffset, bv.zoneTreeScalesCount);
  }
  if (bv.zoneBushPositionsOffset !== undefined && bv.zoneBushPositionsCount > 0) {
    result.zoneBushPositions = readPositionPairs(bv.zoneBushPositionsOffset, bv.zoneBushCount);
  }
  return result;
}

function readBakedRoads(br, buffer, binOffset) {
  if (!br || !Array.isArray(br.layers)) return null;
  const layers = [];
  for (const layer of br.layers) {
    const entry = { layer: layer.layer };
    if (layer.positionsOffset !== undefined && layer.positionsCount > 0) {
      entry.positions = new Float32Array(buffer, binOffset + layer.positionsOffset, layer.positionsCount);
    }
    if (layer.normalsOffset !== undefined && layer.normalsCount > 0) {
      entry.normals = new Float32Array(buffer, binOffset + layer.normalsOffset, layer.normalsCount);
    }
    if (layer.uvsOffset !== undefined && layer.uvsCount > 0) {
      entry.uvs = new Float32Array(buffer, binOffset + layer.uvsOffset, layer.uvsCount);
    }
    if (layer.halfWidthsOffset !== undefined && layer.halfWidthsCount > 0) {
      entry.halfWidths = new Float32Array(buffer, binOffset + layer.halfWidthsOffset, layer.halfWidthsCount);
    }
    if (layer.indicesOffset !== undefined && layer.indicesCount > 0) {
      entry.indices = new Uint32Array(buffer, binOffset + layer.indicesOffset, layer.indicesCount);
    }
    layers.push(entry);
  }
  return { layers };
}

/** v8: baked sidewalk + curb blobs ({sidewalk, curbTop, curbFace}, each positions[/normals/uvs]+indices). */
function readBakedSidewalks(bs, buffer, binOffset) {
  if (!bs) return null;
  const out = {};
  for (const part of ['sidewalk', 'curbTop', 'curbFace']) {
    const blob = bs[part];
    if (!blob || blob.positionsOffset === undefined || !(blob.positionsCount > 0)) continue;
    const entry = { positions: new Float32Array(buffer, binOffset + blob.positionsOffset, blob.positionsCount) };
    if (blob.normalsOffset !== undefined && blob.normalsCount > 0) {
      entry.normals = new Float32Array(buffer, binOffset + blob.normalsOffset, blob.normalsCount);
    }
    if (blob.uvsOffset !== undefined && blob.uvsCount > 0) {
      entry.uvs = new Float32Array(buffer, binOffset + blob.uvsOffset, blob.uvsCount);
    }
    if (blob.indicesOffset !== undefined && blob.indicesCount > 0) {
      entry.indices = new Uint32Array(buffer, binOffset + blob.indicesOffset, blob.indicesCount);
    }
    out[part] = entry;
  }
  return Object.keys(out).length ? out : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  JSON v5 path (fallback)
// ═══════════════════════════════════════════════════════════════════════════════

function mercatorToWorld(mx, my, originX, originY) {
  return { x: (mx - originX) * MERCATOR_UNSTRETCH, z: (my - originY) * MERCATOR_UNSTRETCH };
}

function roadToWorld(road, ox, oy) {
  // ⚠ SMOOTHING BELONGS HERE AND NOWHERE ELSE. Every consumer — the road ribbon, the kerbs, the
  // markings, the physics colliders, the guard-rail mask — reads `road.points` after this function.
  // Rounding corners in the renderer alone would give the player a smooth road and the car a
  // faceted collider to catch on. One choke point, one geometry.
  return {
    ...road,
    points: smoothPolyline((road.points || []).map((p) => {   // JSON fallback; readRoads is the live path
      const isArray = Array.isArray(p);
      const mx = isArray ? p[0] : p.x;
      const my = isArray ? (p.length >= 3 ? p[2] : p[1]) : p.y;
      const elevation = isArray && p.length >= 3 ? p[1] : undefined;
      const w = mercatorToWorld(mx, my, ox, oy);
      const out = { x: w.x, y: w.z };
      if (elevation !== undefined && Number.isFinite(elevation)) out.elevation = elevation;
      return out;
    })),
  };
}

function buildingV4ToRenderer(b) {
  if (!b || !b.footprint) return b;
  const first = b.footprint[0];
  if (!Array.isArray(first)) return b;
  const out = {
    ...b,
    footprint: b.footprint.map((p) => ({ x: p[0], y: p[1] })),
  };
  if (b.innerRings && b.innerRings.length > 0) {
    out.innerRings = b.innerRings.map((ring) =>
      ring.map((p) => ({ x: p[0], y: p[1] }))
    );
  }
  return out;
}

function railwayToWorld(railways, ox, oy) {
  if (!railways || !Array.isArray(railways)) return [];
  return railways.map((r) => ({
    ...r,
    points: (r.points || []).map((p) => {
      const px = Array.isArray(p) ? p[0] : p.x;
      const py = Array.isArray(p) ? p[1] : p.y;
      const w = mercatorToWorld(px, py, ox, oy);
      return { x: w.x, y: w.z };
    }),
  }));
}

function waterToWorld(waterAreas, ox, oy) {
  if (!waterAreas || !Array.isArray(waterAreas)) return [];
  return waterAreas.map((area) => ({
    id: area.id,
    polygon: (area.polygon || []).map((p) => {
      const w = mercatorToWorld(p.x, p.y, ox, oy);
      return { x: w.x, y: w.z };
    }),
  }));
}

function vegetationToWorld(vegetation, ox, oy) {
  if (!vegetation) return { trees: [], greenAreas: [] };
  const trees = (vegetation.trees || []).map((p) => {
    const w = mercatorToWorld(p.x, p.y, ox, oy);
    return { x: w.x, y: w.z };
  });
  const greenAreas = (vegetation.greenAreas || []).map((area) => ({
    id: area.id,
    type: area.type,
    polygon: (area.polygon || []).map((p) => {
      const w = mercatorToWorld(p.x, p.y, ox, oy);
      return { x: w.x, y: w.z };
    }),
  }));
  return { trees, greenAreas };
}

function parseJsonTile(data, originX, originY, lite = false) {   // eslint-disable-line no-unused-vars (JSON is a rare fallback; lite optimization is on the binary path)
  const roads = (data.roads || []).map(r => roadToWorld(r, originX, originY));
  const buildings = (data.buildings || []).map(buildingV4ToRenderer);
  const railways = railwayToWorld(data.railways, originX, originY);
  const vegetation = vegetationToWorld(data.vegetation, originX, originY);
  const water = waterToWorld(data.water, originX, originY);
  const greens = data.greens || [];
  const barriers = data.barriers || [];

  const junctions = (data.junctions || []).map((j) => {
    if (!j.gore) return j;
    const verts = j.gore.vertices;
    const worldVerts = [];
    for (let i = 0; i < verts.length; i += 3) {
      const w = mercatorToWorld(verts[i], verts[i + 2], originX, originY);
      worldVerts.push(w.x, verts[i + 1], w.z);
    }
    return { ...j, gore: { vertices: worldVerts, indices: j.gore.indices } };
  });

  const result = {
    roads, buildings, railways, vegetation, water, greens, barriers, junctions,
    busStops: data.busStops || [],
    parking: data.parking || [],
    urbanFeatures: data.urbanFeatures || [],
  };
  if (data.elevation) result.elevation = data.elevation;
  if (data.roadOnlyMode) result.roadOnlyMode = true;

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  IndexedDB tile cache (inline — workers can't use ES module imports)
// ═══════════════════════════════════════════════════════════════════════════════

const IDB_NAME = 'delhi-drive-tiles';
const IDB_VERSION = 1;
const IDB_STORE = 'tiles';
const IDB_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

let _idb = null;
let _idbReady = null;

function openIDB() {
  if (_idbReady) return _idbReady;
  _idbReady = new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => { _idb = req.result; resolve(_idb); };
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  return _idbReady;
}

function idbGet(key) {
  return new Promise((resolve) => {
    if (!_idb) return resolve(null);
    try {
      const tx = _idb.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => {
        const r = req.result;
        if (!r) return resolve(null);
        if (Date.now() - r.ts > IDB_MAX_AGE) {
          idbDel(key);
          return resolve(null);
        }
        resolve(r);
      };
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

function idbPut(key, data, ct) {
  if (!_idb) return;
  try {
    const tx = _idb.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ key, data, ct, ts: Date.now() });
  } catch { /* non-critical */ }
}

function idbDel(key) {
  if (!_idb) return;
  try {
    const tx = _idb.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
  } catch { /* ignore */ }
}

// Post a parsed result, transferring the packed typed-array buffers (LITE map tiles) zero-copy so the main
// thread never pays a structured-clone deserialize. Non-packed (gameplay) results post normally.
// Heavy top-level sections posted as separate messages. Each message's structured-clone
// deserialize runs in its own main-thread task, so rAF frames can interleave between parts
// instead of eating one 20-30ms monolithic clone per gameplay tile.
const PART_KEYS = [
  'roads', 'buildings', 'water', 'greens', 'barriers', 'junctions', 'urbanFeatures',
  'trees', 'streetLamps', 'pedestrianAreas', 'marinas', 'beaches',
  'bakedVegetation', 'bakedTerrain', 'bakedRoads', 'bakedSidewalks',
  'elevation', 'aoGrid',
];
// Slice size for the big object arrays (roads/buildings). 150 was still 10-20ms of
// structured-clone per message in dense Eixample (each road carries hundreds of {x,y,elevation}
// point objects) — the worst-frame 'other 20-25ms' survivor. 30 keeps each deserialize task
// ~1-4ms so rAF actually interleaves; total clone cost is unchanged, just spread across frames.
const PART_CHUNK = 30;

function postResult(id, result) {
  if (result && result.packed) {
    self.postMessage({ id, result }, [
      result.rCoords.buffer, result.rOffsets.buffer, result.rWidth.buffer,
      result.wCoords.buffer, result.wOffsets.buffer, result.pCoords.buffer, result.pOffsets.buffer,
    ]);
    return;
  }
  if (!result || typeof result !== 'object') {
    self.postMessage({ id, result });
    return;
  }
  for (const k of PART_KEYS) {
    const v = result[k];
    if (v == null) continue;
    if (Array.isArray(v) && v.length > PART_CHUNK) {
      for (let i = 0; i < v.length; i += PART_CHUNK) {
        self.postMessage({ id, part: k, data: v.slice(i, i + PART_CHUNK), append: i > 0 });
      }
    } else {
      self.postMessage({ id, part: k, data: v, append: false });
    }
    delete result[k];
  }
  self.postMessage({ id, result });
}

// Open DB eagerly so it's ready by first tile request
openIDB();

// ═══════════════════════════════════════════════════════════════════════════════
//  Worker message handler
// ═══════════════════════════════════════════════════════════════════════════════

self.onmessage = async (e) => {
  const { url, originX, originY, tileVersion, id, lite } = e.data;

  // Special message: clear the IndexedDB cache
  if (e.data.action === 'clearCache') {
    if (_idb) {
      try {
        const tx = _idb.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).clear();
      } catch { /* ignore */ }
    }
    return;
  }

  try {
    // Strip direction params from cache key (vx/vz don't affect tile content)
    const cacheKey = url.replace(/&?v[xz]=[^&]*/g, '').replace(/\?$/, '');

    // ── Check IndexedDB cache first ──────────────────────────────────────
    await openIDB();
    const cached = await idbGet(cacheKey);
    if (cached) {
      try {
        if (cached.ct === 'binary') {
          // Reject a tile baked by an older format rather than silently serving the stale city.
          const v = peekBinaryVersion(cached.data);
          if (v !== BINARY_TILE_VERSION) {
            idbDel(cacheKey);
          } else {
            const result = parseBinaryTile(cached.data, originX, originY, lite);
            postResult(id, result);
            return;
          }
        } else if (cached.ct === 'json') {
          const data = JSON.parse(cached.data);
          if (data.version === tileVersion) {
            const result = parseJsonTile(data, originX, originY, lite);
            postResult(id, result);
            return;
          }
          // Version mismatch — re-fetch
          idbDel(cacheKey);
        }
      } catch {
        // Cache corrupted — delete and re-fetch
        idbDel(cacheKey);
      }
    }

    // ── Fetch from network ───────────────────────────────────────────────
    const res = await fetch(url);
    if (!res.ok) {
      self.postMessage({ id, error: 'not_found', status: res.status });
      return;
    }

    const contentType = res.headers.get('content-type') || '';

    // A STATIC HOST CAN ANSWER 200 WITH A WEB PAGE. Cloudflare Pages serves index.html for any
    // unmatched path — that is what makes the client-routed /game work — so a tile beyond the baked
    // region came back as 34 KB of HTML with status 200, sailed past the `!res.ok` check above, and
    // was parsed as a binary tile. Treat HTML as the not-found it actually is, whatever the status
    // line claims.
    //
    // ⚠ A `_redirects` rule (`/tiles/* /404-tile 404`) was tried first and MEASURED AS INERT on
    // Pages — the asset fallback still won and the response was still 200 text/html. It was removed
    // rather than left in place looking like protection. This guard is the whole fix. The cost of
    // the fallback is a 34 KB HTML body per out-of-bounds request, once each, then the result is
    // cached as PLACEHOLDER.
    if (contentType.includes('text/html')) {
      self.postMessage({ id, error: 'not_found', status: res.status });
      return;
    }

    if (contentType.includes('octet-stream')) {
      // ── Binary v6 path ──────────────────────────────────────────────────
      const buffer = await res.arrayBuffer();
      // Cache the raw ArrayBuffer
      idbPut(cacheKey, buffer.slice(0), 'binary');
      const result = parseBinaryTile(buffer, originX, originY, lite);
      postResult(id, result);
    } else {
      // ── JSON v5 fallback ────────────────────────────────────────────────
      const text = await res.text();
      const data = JSON.parse(text);
      if (data.version !== tileVersion) {
        self.postMessage({ id, error: 'bad_version', version: data.version });
        return;
      }
      // Cache the raw JSON string
      idbPut(cacheKey, text, 'json');
      const result = parseJsonTile(data, originX, originY, lite);
      postResult(id, result);
    }
  } catch (err) {
    self.postMessage({ id, error: 'fetch_failed', message: err.message });
  }
};
