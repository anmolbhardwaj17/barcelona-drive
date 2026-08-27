#!/usr/bin/env node
/**
 * convertToBinary.js
 *
 * Converts JSON tile files (v5) to a compact binary format (v6).
 *
 * Binary layout:
 *   [4 bytes]  uint32 LE — JSON header byte length
 *   [N bytes]  UTF-8 JSON header (metadata, no coordinate arrays)
 *   [rest]     packed Float32 / Uint32 coordinate sections
 *
 * All coordinate arrays in the JSON are replaced with { offset, count }
 * references into the binary tail.  "offset" is in BYTES from the start of
 * the binary section (i.e. after the header).
 *
 * Run:  node worldBuilder/convertToBinary.js
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── helpers ────────────────────────────────────────────────────────────────

/** Append Float32 values to a growing list; return { offset (bytes), count }. */
function packFloat32(collector, values) {
  if (!values || values.length === 0) return { offset: 0, count: 0 };
  const offset = collector.byteOffset;
  for (let i = 0; i < values.length; i++) {
    collector.f32.push(values[i]);
  }
  collector.byteOffset += values.length * 4;
  return { offset, count: values.length };
}

/** Append Uint32 values; return { offset (bytes), count }. */
function packUint32(collector, values) {
  if (!values || values.length === 0) return { offset: 0, count: 0 };
  // Align to 4 bytes (already guaranteed since we track in bytes and only
  // write 4-byte items, but be defensive).
  const offset = collector.byteOffset;
  for (let i = 0; i < values.length; i++) {
    collector.u32.push(values[i]);
  }
  collector.byteOffset += values.length * 4;
  return { offset, count: values.length };
}

/**
 * Flatten a 2D polygon [[x,z], [x,z], …] → [x0, z0, x1, z1, …]
 */
function flattenXZ(polygon) {
  if (!polygon || polygon.length === 0) return [];
  const out = new Array(polygon.length * 2);
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i];
    // Support both [x, z] arrays and {x, y} objects
    if (Array.isArray(p)) {
      out[i * 2]     = p[0];
      out[i * 2 + 1] = p[1];
    } else {
      out[i * 2]     = p.x;
      out[i * 2 + 1] = p.y;
    }
  }
  return out;
}

/**
 * Flatten road points [[x, yUp, z], …] interleaved with per-point elevation
 * → [x0, elev0, z0, x1, elev1, z1, …]
 *
 * If the road has a separate `elevation` array we use that; otherwise yUp
 * from the point itself is used.
 */
function flattenRoadPoints(points, elevation) {
  if (!points || points.length === 0) return [];
  const out = new Array(points.length * 3);
  const hasElev = Array.isArray(elevation) && elevation.length === points.length;
  for (let i = 0; i < points.length; i++) {
    out[i * 3]     = points[i][0];            // x
    // Use separate elevation array if it has valid numbers, otherwise fall back to yUp from point
    const elev = hasElev && Number.isFinite(elevation[i]) ? elevation[i] : points[i][1];
    out[i * 3 + 1] = Number.isFinite(elev) ? elev : 0;
    out[i * 3 + 2] = points[i][2];            // z
  }
  return out;
}

// ─── main conversion ────────────────────────────────────────────────────────

export function convertTile(jsonData) {
  // Collector accumulates raw numbers; we build the final buffer at the end.
  // We interleave Float32 and Uint32 sections, so we track them as tagged
  // entries and assemble one contiguous buffer.
  const sections = []; // { type: 'f32'|'u32', data: number[] }
  let byteOffset = 0;

  function pushF32(values) {
    if (!values || values.length === 0) return { offset: 0, count: 0 };
    const offset = byteOffset;
    sections.push({ type: 'f32', data: values });
    byteOffset += values.length * 4;
    return { offset, count: values.length };
  }

  function pushU32(values) {
    if (!values || values.length === 0) return { offset: 0, count: 0 };
    const offset = byteOffset;
    sections.push({ type: 'u32', data: values });
    byteOffset += values.length * 4;
    return { offset, count: values.length };
  }

  const header = {
    version: 10,  // v10: + the R-W1 width section on every road (carriagewayW / parkingLeftW /
                  //     parkingRightW / shoulderW / kerbToKerbW / sidewalkW / corridorW). `width`
                  //     is kept as an alias of kerbToKerbW so an unmigrated consumer reads the
                  //     paved surface rather than silently changing meaning.
                  //     ⚠ Must move in lockstep with BINARY_TILE_VERSION in tileParserWorker.js —
                  //     that is what makes a re-bake invalidate the browser cache by itself.
                  // v9: + aoGrid (baked sky-visibility AO; absent → frontend treats sky as fully
                  //     open). v8: + bakedSidewalks (frontend falls back to the runtime generator
                  //     when the section is absent — older tiles keep working).
    tileId: jsonData.tileId,
  };

  if (jsonData.roadOnlyMode) header.roadOnlyMode = true;

  // ── elevation ──────────────────────────────────────────────────────────
  if (jsonData.elevation) {
    const e = jsonData.elevation;
    const elev = {
      resolution:       e.resolution,
      min:              e.min,
      max:              e.max,
      tileMinElevation: e.tileMinElevation,
      tileMaxElevation: e.tileMaxElevation,
      south:            e.south,
      west:             e.west,
      north:            e.north,
      east:             e.east,
      gridRows:         e.gridRows,
      gridCols:         e.gridCols,
    };

    // elevation.data (the raw DEM data array)
    if (Array.isArray(e.data) && e.data.length > 0) {
      const ref = pushF32(e.data);
      elev.dataOffset = ref.offset;
      elev.dataCount  = ref.count;
    }

    // elevation.elevations (the interpolated grid)
    if (Array.isArray(e.elevations) && e.elevations.length > 0) {
      const ref = pushF32(e.elevations);
      elev.elevationsOffset = ref.offset;
      elev.elevationsCount  = ref.count;
    }

    header.elevation = elev;
  }

  // ── roads ──────────────────────────────────────────────────────────────
  header.roads = [];
  if (Array.isArray(jsonData.roads)) {
    for (const road of jsonData.roads) {
      const flat = flattenRoadPoints(road.points, road.elevation);
      const ref  = pushF32(flat);
      const entry = {
        id:          road.id,
        width:       road.width,   // R-W1: alias of kerbToKerbW — the DRAWN paved surface
        // R-W1: the width SECTION, so the frontend reads a named field instead of halving `width`
        // and guessing what it measured. Written unconditionally: an absent field is how the old
        // ambiguity crept back in, and `null` is a louder failure than a missing key.
        carriagewayW:  road.carriagewayW ?? null,
        parkingLeftW:  road.parkingLeftW ?? null,
        parkingRightW: road.parkingRightW ?? null,
        shoulderW:     road.shoulderW ?? null,
        kerbToKerbW:   road.kerbToKerbW ?? null,
        sidewalkW:     road.sidewalkW ?? null,
        corridorW:     road.corridorW ?? null,
        bridge:      road.bridge     || false,
        tunnel:      road.tunnel     || false,
        layer:       road.layer      || 0,
        highwayType: road.highwayType,
        isRamp:       road.isRamp       || false,
        isRoundabout: road.isRoundabout || false,
        pointCount:  road.points ? road.points.length : 0,
        pointsOffset: ref.offset,
      };
      if (road.crossesTrench)  entry.crossesTrench = true; // OPTION L: deck colliders over daylighted tunnel corridors
      if (road.crossing)       entry.crossing = true;      // marked crossing — runtime skips the ribbon
      if (road.serviceSubtype) entry.serviceSubtype = road.serviceSubtype;
      if (road.name)           entry.name = road.name;
      if (road.oneway != null) entry.oneway = road.oneway;
      if (road.lanes != null)  entry.lanes = road.lanes;
      if (road.surface)        entry.surface = road.surface;
      if (road.lit != null)    entry.lit = road.lit;
      if (road.maxspeed != null) entry.maxspeed = road.maxspeed;
      if (road.divider)        entry.divider = road.divider;
      if (road.sidewalk)       entry.sidewalk = road.sidewalk;
      if (road.cycleway)       entry.cycleway = road.cycleway;
      if (road.parkingLeft)      entry.parkingLeft      = road.parkingLeft;      // Phase 4A
      if (road.parkingRight)     entry.parkingRight     = road.parkingRight;     // Phase 4A
      if (road.parkingPaidLeft)  entry.parkingPaidLeft  = road.parkingPaidLeft;  // Phase 4C-B
      if (road.parkingPaidRight) entry.parkingPaidRight = road.parkingPaidRight; // Phase 4C-B
      header.roads.push(entry);
    }
  }

  // ── buildings ──────────────────────────────────────────────────────────
  header.buildings = [];
  if (Array.isArray(jsonData.buildings)) {
    for (const bld of jsonData.buildings) {
      const flat = flattenXZ(bld.footprint);
      const ref  = pushF32(flat);
      const entry = {
        id:              bld.id,
        height:          bld.height,
        levels:          bld.levels,
        type:            bld.type,
        footprintCount:  bld.footprint ? bld.footprint.length : 0,
        footprintOffset: ref.offset,
      };
      if (bld.name)         entry.name         = bld.name;
      if (bld.roofShape)    entry.roofShape     = bld.roofShape;
      if (bld.layer)        entry.layer         = bld.layer;
      if (bld.material)     entry.material      = bld.material;
      if (bld.colour)       entry.colour        = bld.colour;
      if (bld.roofMaterial) entry.roofMaterial   = bld.roofMaterial;
      if (bld.roofColour)   entry.roofColour     = bld.roofColour;

      // Inner rings (holes in the building footprint) — stored contiguously
      if (Array.isArray(bld.innerRings) && bld.innerRings.length > 0) {
        const counts = [];
        let firstOffset = null;
        for (const ring of bld.innerRings) {
          const rFlat = flattenXZ(ring);
          const rRef  = pushF32(rFlat);
          if (firstOffset === null) firstOffset = rRef.offset;
          counts.push(ring.length);
        }
        entry.innerRingsOffset = firstOffset;
        entry.innerRingCounts = counts;
      }

      if (bld.minHeight != null) entry.minHeight = bld.minHeight;
      if (bld.roofHeight != null) entry.roofHeight = bld.roofHeight;

      header.buildings.push(entry);
    }
  }

  // ── greens ─────────────────────────────────────────────────────────────
  header.greens = [];
  if (Array.isArray(jsonData.greens)) {
    for (const g of jsonData.greens) {
      const flat = flattenXZ(g.polygon);
      const ref  = pushF32(flat);
      header.greens.push({
        id:            g.id,
        type:          g.type,
        polygonCount:  g.polygon ? g.polygon.length : 0,
        polygonOffset: ref.offset,
      });
    }
  }

  // ── water ──────────────────────────────────────────────────────────────
  header.water = [];
  if (Array.isArray(jsonData.water)) {
    for (const w of jsonData.water) {
      const flat = flattenXZ(w.polygon);
      const ref  = pushF32(flat);
      const entry = {
        id:            w.id,
        type:          w.type,
        closed:        w.closed,
        polygonCount:  w.polygon ? w.polygon.length : 0,
        polygonOffset: ref.offset,
      };
      if (w.width != null) entry.width = w.width;
      header.water.push(entry);
    }
  }

  // ── barriers ───────────────────────────────────────────────────────────
  header.barriers = [];
  if (Array.isArray(jsonData.barriers)) {
    for (const b of jsonData.barriers) {
      const flat = flattenXZ(b.points);
      const ref  = pushF32(flat);
      const entry = {
        id:           b.id,
        type:         b.type,
        isArea:       b.isArea || false,
        height:       b.height,
        pointCount:   b.points ? b.points.length : 0,
        pointsOffset: ref.offset,
      };
      if (b.gates) entry.gates = b.gates; // keep as JSON (small, variable structure)
      header.barriers.push(entry);
    }
  }

  // ── railways ─────────────────────────────────────────────────────────
  header.railways = [];
  if (Array.isArray(jsonData.railways)) {
    for (const rw of jsonData.railways) {
      const flat = flattenXZ(rw.points);
      const ref  = pushF32(flat);
      const entry = {
        id:           rw.id,
        railwayType:  rw.railwayType,
        layer:        rw.layer || 0,
        bridge:       rw.bridge || false,
        tunnel:       rw.tunnel || false,
        pointCount:   rw.points ? rw.points.length : 0,
        pointsOffset: ref.offset,
      };
      header.railways.push(entry);
    }
  }

  // ── junctions ──────────────────────────────────────────────────────────
  header.junctions = [];
  if (Array.isArray(jsonData.junctions)) {
    for (const j of jsonData.junctions) {
      const entry = {
        nodeId: j.nodeId,
        x:      j.x,
        z:      j.z,
        type:   j.type,
        layer:  j.layer,
        roads:  j.roads,  // small array of road refs — keep in JSON
      };
      if (j.radius != null)        entry.radius    = j.radius;       // Phase 4B-1
      if (j.approaches?.length)    entry.approaches = j.approaches;  // Phase 4B-1

      if (j.gore) {
        const gore = {};
        if (Array.isArray(j.gore.vertices) && j.gore.vertices.length > 0) {
          const vRef = pushF32(j.gore.vertices); // already flat Float32
          gore.verticesOffset = vRef.offset;
          gore.verticesCount  = vRef.count;
        }
        if (Array.isArray(j.gore.indices) && j.gore.indices.length > 0) {
          const iRef = pushU32(j.gore.indices);  // Uint32 indices
          gore.indicesOffset = iRef.offset;
          gore.indicesCount  = iRef.count;
        }
        entry.gore = gore;
      }

      header.junctions.push(entry);
    }
  }

  // ── busStops ───────────────────────────────────────────────────────────
  header.busStops = [];
  if (Array.isArray(jsonData.busStops)) {
    for (const bs of jsonData.busStops) {
      const flat = (bs.point && bs.point.length >= 2) ? [bs.point[0], bs.point[1]] : [];
      const ref  = pushF32(flat);
      const entry = {
        id:          bs.id,
        pointOffset: ref.offset,
      };
      if (bs.name) entry.name = bs.name;
      header.busStops.push(entry);
    }
  }

  // ── parking ────────────────────────────────────────────────────────────
  header.parking = [];
  if (Array.isArray(jsonData.parking)) {
    for (const p of jsonData.parking) {
      const flat = flattenXZ(p.polygon);
      const ref  = pushF32(flat);
      const entry = {
        id:            p.id,
        parkingType:   p.parkingType,
        capacity:      p.capacity,
        polygonCount:  p.polygon ? p.polygon.length : 0,
        polygonOffset: ref.offset,
      };
      header.parking.push(entry);
    }
  }

  // ── urbanFeatures ──────────────────────────────────────────────────────
  header.urbanFeatures = [];
  if (Array.isArray(jsonData.urbanFeatures)) {
    for (const uf of jsonData.urbanFeatures) {
      const flat = (uf.point && uf.point.length >= 2) ? [uf.point[0], uf.point[1]] : [];
      const ref  = pushF32(flat);
      const entry = {
        id:          uf.id,
        type:        uf.type,
        pointOffset: ref.offset,
        tags:        uf.tags,  // keep as JSON (small, variable structure)
      };
      header.urbanFeatures.push(entry);
    }
  }

  // ── v7: area features — beaches, pedestrian areas, marinas ──────────────
  // Polygon format identical to greens: Float32 pairs [wx, wz] in world coords.
  for (const [key, label] of [['beaches', 'beaches'], ['pedestrianAreas', 'pedestrianAreas'], ['marinas', 'marinas']]) {
    header[key] = [];
    if (Array.isArray(jsonData[key])) {
      for (const f of jsonData[key]) {
        const flat = flattenXZ(f.polygon);
        const ref  = pushF32(flat);
        const entry = {
          id:            f.id,
          type:          f.type,
          polygonCount:  f.polygon ? f.polygon.length : 0,
          polygonOffset: ref.offset,
        };
        if (f.isLine) entry.isLine = true;
        header[key].push(entry);
      }
    }
  }

  // ── v7: point features — shared encoding (Float32 pair per feature) ──────
  // Traffic signals
  header.trafficSignals = [];
  if (Array.isArray(jsonData.trafficSignals)) {
    for (const f of jsonData.trafficSignals) {
      const ref = pushF32([f.point[0], f.point[1]]);
      const entry = { id: f.id, pointOffset: ref.offset };
      if (f.direction) entry.direction = f.direction;
      header.trafficSignals.push(entry);
    }
  }

  // Street lamps
  header.streetLamps = [];
  if (Array.isArray(jsonData.streetLamps)) {
    for (const f of jsonData.streetLamps) {
      const ref = pushF32([f.point[0], f.point[1]]);
      const entry = { id: f.id, pointOffset: ref.offset };
      if (f.height != null) entry.height = f.height;
      header.streetLamps.push(entry);
    }
  }

  // Individual trees — compact: all positions in one flat Float32 array,
  // species/height kept in JSON per-entry (small strings, optional).
  header.trees = [];
  if (Array.isArray(jsonData.trees) && jsonData.trees.length > 0) {
    const posFlat = new Array(jsonData.trees.length * 2);
    for (let i = 0; i < jsonData.trees.length; i++) {
      posFlat[i * 2]     = jsonData.trees[i].point[0];
      posFlat[i * 2 + 1] = jsonData.trees[i].point[1];
    }
    const posRef = pushF32(posFlat);
    // Minimal per-tree metadata in JSON (species/height stripped when null to save space)
    for (let i = 0; i < jsonData.trees.length; i++) {
      const t = jsonData.trees[i];
      const entry = { id: t.id };
      if (t.species) entry.species = t.species;
      if (t.height != null) entry.height = t.height;
      header.trees.push(entry);
    }
    header.treePositions = { offset: posRef.offset, count: jsonData.trees.length };
  }

  // Tourism POIs
  header.tourismPois = [];
  if (Array.isArray(jsonData.tourismPois)) {
    for (const f of jsonData.tourismPois) {
      const ref = pushF32([f.point[0], f.point[1]]);
      const entry = { id: f.id, type: f.type, pointOffset: ref.offset };
      if (f.name) entry.name = f.name;
      header.tourismPois.push(entry);
    }
  }

  // Metro stations
  header.metroStations = [];
  if (Array.isArray(jsonData.metroStations)) {
    for (const f of jsonData.metroStations) {
      const ref = pushF32([f.point[0], f.point[1]]);
      const entry = { id: f.id, pointOffset: ref.offset };
      if (f.name)    entry.name    = f.name;
      if (f.network) entry.network = f.network;
      if (f.lines)   entry.lines   = f.lines;
      header.metroStations.push(entry);
    }
  }

  // Healthcare
  header.healthcare = [];
  if (Array.isArray(jsonData.healthcare)) {
    for (const f of jsonData.healthcare) {
      const ref = pushF32([f.point[0], f.point[1]]);
      const entry = { id: f.id, type: f.type, pointOffset: ref.offset };
      if (f.name) entry.name = f.name;
      header.healthcare.push(entry);
    }
  }

  // Shops — compact: all positions in one flat Float32 array,
  // category as Uint8 packed in Uint32 (4 per word), names in per-entry JSON.
  header.shops = [];
  if (Array.isArray(jsonData.shops) && jsonData.shops.length > 0) {
    const shopCount = jsonData.shops.length;
    // Positions: flat Float32 pairs
    const shopPosFlat = new Array(shopCount * 2);
    for (let i = 0; i < shopCount; i++) {
      shopPosFlat[i * 2]     = jsonData.shops[i].point[0];
      shopPosFlat[i * 2 + 1] = jsonData.shops[i].point[1];
    }
    const shopPosRef = pushF32(shopPosFlat);
    // Categories: pack Uint8 into Uint32 (4 per word), same as treeVariants
    const catU32Count = Math.ceil(shopCount / 4);
    const catPacked = new Array(catU32Count).fill(0);
    for (let i = 0; i < shopCount; i++) {
      const cat = (jsonData.shops[i].cat ?? 0) & 0xFF;
      const wi  = i >> 2;
      catPacked[wi] |= (cat << ((i & 3) * 8));
    }
    const catRef = pushU32(catPacked);
    // Per-entry JSON: id + optional name
    for (let i = 0; i < shopCount; i++) {
      const s = jsonData.shops[i];
      const entry = { id: s.id };
      if (s.name) entry.name = s.name;
      header.shops.push(entry);
    }
    header.shopPositions   = { offset: shopPosRef.offset, count: shopCount };
    header.shopCategories  = { offset: catRef.offset,     count: catU32Count };
  }

  // ── bakedTerrain (visual mesh) ──────────────────────────────────────────
  if (jsonData.bakedTerrain) {
    const bt = jsonData.bakedTerrain;
    const terrain = {
      gridSize: bt.gridSize,
      vertExag: bt.vertExag,
    };
    if (bt.positions && bt.positions.length > 0) {
      const ref = pushF32(Array.from(bt.positions));
      terrain.positionsOffset = ref.offset;
      terrain.positionsCount  = ref.count;
    }
    if (bt.normals && bt.normals.length > 0) {
      const ref = pushF32(Array.from(bt.normals));
      terrain.normalsOffset = ref.offset;
      terrain.normalsCount  = ref.count;
    }
    if (bt.uvs && bt.uvs.length > 0) {
      const ref = pushF32(Array.from(bt.uvs));
      terrain.uvsOffset = ref.offset;
      terrain.uvsCount  = ref.count;
    }
    if (bt.indices && bt.indices.length > 0) {
      const ref = pushU32(Array.from(bt.indices));
      terrain.indicesOffset = ref.offset;
      terrain.indicesCount  = ref.count;
    }
    header.bakedTerrain = terrain;
  }

  // ── bakedPhysicsTerrain (collision mesh) ───────────────────────────────
  if (jsonData.bakedPhysicsTerrain) {
    const bp = jsonData.bakedPhysicsTerrain;
    const physics = {
      gridSize: bp.gridSize,
      vertExag: bp.vertExag,
    };
    if (bp.verts && bp.verts.length > 0) {
      const ref = pushF32(Array.from(bp.verts));
      physics.vertsOffset = ref.offset;
      physics.vertsCount  = ref.count;
    }
    if (bp.indices && bp.indices.length > 0) {
      const ref = pushU32(Array.from(bp.indices));
      physics.indicesOffset = ref.offset;
      physics.indicesCount  = ref.count;
    }
    header.bakedPhysicsTerrain = physics;
  }

  // ── bakedVegetation (pre-baked tree/bush positions) ────────────────────
  if (jsonData.bakedVegetation) {
    const bv = jsonData.bakedVegetation;
    const veg = {
      treeCount: bv.treeCount || 0,
      bushCount: bv.bushCount || 0,
      zoneTreeCount: bv.zoneTreeCount || 0,
      zoneBushCount: bv.zoneBushCount || 0,
    };
    if (bv.treePositions && bv.treePositions.length > 0) {
      const ref = pushF32(Array.from(bv.treePositions));
      veg.treePositionsOffset = ref.offset;
      veg.treePositionsCount  = ref.count;
    }
    if (bv.treeVariants && bv.treeVariants.length > 0) {
      // Pack Uint8Array as Uint32 (4 bytes per uint32)
      const u32Count = Math.ceil(bv.treeVariants.length / 4);
      const packed = new Array(u32Count);
      for (let i = 0; i < u32Count; i++) {
        const b0 = bv.treeVariants[i * 4] || 0;
        const b1 = bv.treeVariants[i * 4 + 1] || 0;
        const b2 = bv.treeVariants[i * 4 + 2] || 0;
        const b3 = bv.treeVariants[i * 4 + 3] || 0;
        packed[i] = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
      }
      const ref = pushU32(packed);
      veg.treeVariantsOffset = ref.offset;
      veg.treeVariantsCount  = ref.count;
    }
    if (bv.bushPositions && bv.bushPositions.length > 0) {
      const ref = pushF32(Array.from(bv.bushPositions));
      veg.bushPositionsOffset = ref.offset;
      veg.bushPositionsCount  = ref.count;
    }
    if (bv.zoneTreePositions && bv.zoneTreePositions.length > 0) {
      const ref = pushF32(Array.from(bv.zoneTreePositions));
      veg.zoneTreePositionsOffset = ref.offset;
      veg.zoneTreePositionsCount  = ref.count;
    }
    if (bv.zoneTreeVariants && bv.zoneTreeVariants.length > 0) {
      const u32Count = Math.ceil(bv.zoneTreeVariants.length / 4);
      const packed = new Array(u32Count);
      for (let i = 0; i < u32Count; i++) {
        const b0 = bv.zoneTreeVariants[i * 4] || 0;
        const b1 = bv.zoneTreeVariants[i * 4 + 1] || 0;
        const b2 = bv.zoneTreeVariants[i * 4 + 2] || 0;
        const b3 = bv.zoneTreeVariants[i * 4 + 3] || 0;
        packed[i] = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
      }
      const ref = pushU32(packed);
      veg.zoneTreeVariantsOffset = ref.offset;
      veg.zoneTreeVariantsCount  = ref.count;
    }
    if (bv.zoneTreeScales && bv.zoneTreeScales.length > 0) {
      const ref = pushF32(Array.from(bv.zoneTreeScales));
      veg.zoneTreeScalesOffset = ref.offset;
      veg.zoneTreeScalesCount  = ref.count;
    }
    if (bv.zoneBushPositions && bv.zoneBushPositions.length > 0) {
      const ref = pushF32(Array.from(bv.zoneBushPositions));
      veg.zoneBushPositionsOffset = ref.offset;
      veg.zoneBushPositionsCount  = ref.count;
    }
    header.bakedVegetation = veg;
  }

  // ── bakedRoads (pre-baked road surface geometry) ───────────────────────
  if (jsonData.bakedRoads && Array.isArray(jsonData.bakedRoads.layers)) {
    const br = jsonData.bakedRoads;
    const roadLayers = [];
    for (const layer of br.layers) {
      const entry = { layer: layer.layer };
      if (layer.positions && layer.positions.length > 0) {
        const ref = pushF32(Array.from(layer.positions));
        entry.positionsOffset = ref.offset;
        entry.positionsCount  = ref.count;
      }
      if (layer.normals && layer.normals.length > 0) {
        const ref = pushF32(Array.from(layer.normals));
        entry.normalsOffset = ref.offset;
        entry.normalsCount  = ref.count;
      }
      if (layer.uvs && layer.uvs.length > 0) {
        const ref = pushF32(Array.from(layer.uvs));
        entry.uvsOffset = ref.offset;
        entry.uvsCount  = ref.count;
      }
      if (layer.halfWidths && layer.halfWidths.length > 0) {
        const ref = pushF32(Array.from(layer.halfWidths));
        entry.halfWidthsOffset = ref.offset;
        entry.halfWidthsCount  = ref.count;
      }
      if (layer.indices && layer.indices.length > 0) {
        const ref = pushU32(Array.from(layer.indices));
        entry.indicesOffset = ref.offset;
        entry.indicesCount  = ref.count;
      }
      roadLayers.push(entry);
    }
    header.bakedRoads = { layers: roadLayers };
  }

  // ── bakedSidewalks (v8 — pre-baked sidewalk + curb geometry) ────────────
  // Three blobs (sidewalk / curbTop / curbFace), each {positions[, normals][, uvs], indices}.
  // Written like bakedRoads; the frontend uses them instead of the runtime generator when present.
  if (jsonData.bakedSidewalks) {
    const out = {};
    for (const part of ['sidewalk', 'curbTop', 'curbFace']) {
      const blob = jsonData.bakedSidewalks[part];
      if (!blob || !blob.positions || blob.positions.length === 0) continue;
      const entry = {};
      { const ref = pushF32(Array.from(blob.positions)); entry.positionsOffset = ref.offset; entry.positionsCount = ref.count; }
      if (blob.normals && blob.normals.length > 0) { const ref = pushF32(Array.from(blob.normals)); entry.normalsOffset = ref.offset; entry.normalsCount = ref.count; }
      if (blob.uvs && blob.uvs.length > 0) { const ref = pushF32(Array.from(blob.uvs)); entry.uvsOffset = ref.offset; entry.uvsCount = ref.count; }
      if (blob.indices && blob.indices.length > 0) { const ref = pushU32(Array.from(blob.indices)); entry.indicesOffset = ref.offset; entry.indicesCount = ref.count; }
      out[part] = entry;
    }
    if (Object.keys(out).length > 0) header.bakedSidewalks = out;
  }

  // ── aoGrid (v9 — baked sky-visibility AO) ───────────────────────────────
  // Uint8 sky-view factors (255 = open sky), same resolution/orientation as the elevation grid.
  // Packed 4-per-u32 LSB-first so the frontend reads the section directly as a Uint8Array
  // (all target platforms are little-endian).
  if (jsonData.aoGrid && jsonData.aoGrid.data && jsonData.aoGrid.data.length > 0) {
    const bytes = jsonData.aoGrid.data;
    const words = new Array(Math.ceil(bytes.length / 4)).fill(0);
    for (let i = 0; i < bytes.length; i++) {
      words[i >> 2] |= (bytes[i] & 0xff) << ((i & 3) * 8);
    }
    // JS bitwise ops are signed 32-bit — coerce to unsigned so pushU32 stores the right value.
    for (let i = 0; i < words.length; i++) words[i] = words[i] >>> 0;
    const ref = pushU32(words);
    header.aoGrid = {
      resolution: jsonData.aoGrid.resolution,
      byteLength: bytes.length,
      dataOffset: ref.offset,
      dataCount:  ref.count,
    };
  }

  // ── assemble binary ────────────────────────────────────────────────────
  const headerJson  = JSON.stringify(header);
  const headerBytes = Buffer.from(headerJson, 'utf8');

  // Pad header to 4-byte boundary so Float32Array views are aligned
  const headerPadded = headerBytes.length + ((4 - (headerBytes.length % 4)) % 4);

  // Total binary section size
  const binarySize = byteOffset;
  const totalSize  = 4 + headerPadded + binarySize;
  const outBuf     = Buffer.alloc(totalSize);

  // Write padded header length (uint32 LE) — includes padding bytes
  outBuf.writeUInt32LE(headerPadded, 0);

  // Write header JSON (padding bytes remain zero)
  headerBytes.copy(outBuf, 4);

  // Write binary sections (starts at aligned offset)
  let writePos = 4 + headerPadded;
  for (const sec of sections) {
    if (sec.type === 'f32') {
      for (let i = 0; i < sec.data.length; i++) {
        outBuf.writeFloatLE(sec.data[i], writePos);
        writePos += 4;
      }
    } else {
      // u32
      for (let i = 0; i < sec.data.length; i++) {
        outBuf.writeUInt32LE(sec.data[i], writePos);
        writePos += 4;
      }
    }
  }

  return outBuf;
}

// ─── CLI entry point ────────────────────────────────────────────────────────

function main() {
  // Read region from CLI: node convertToBinary.js barcelona  (defaults to 'barcelona')
  const region = process.argv[2] || 'barcelona';
  const tilesRoot = path.resolve(__dirname, '..', 'tiles', region, '16');

  if (!fs.existsSync(tilesRoot)) {
    console.error('Tiles directory not found:', tilesRoot);
    process.exit(1);
  }

  const xDirs = fs.readdirSync(tilesRoot).filter(d =>
    fs.statSync(path.join(tilesRoot, d)).isDirectory()
  );

  let totalJsonBytes   = 0;
  let totalBinaryBytes = 0;
  let convertedCount   = 0;
  let skippedCount     = 0;
  let errorCount       = 0;

  const startTime = Date.now();

  for (const xDir of xDirs) {
    const xPath = path.join(tilesRoot, xDir);
    const files = fs.readdirSync(xPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const jsonPath = path.join(xPath, file);
      const binPath  = path.join(xPath, file.replace('.json', '.bin'));

      try {
        const raw = fs.readFileSync(jsonPath, 'utf8');
        if (!raw || raw.trim().length === 0) {
          skippedCount++;
          continue;
        }

        const jsonData = JSON.parse(raw);
        const jsonSize = Buffer.byteLength(raw, 'utf8');

        const binBuf   = convertTile(jsonData);
        fs.writeFileSync(binPath, binBuf);

        totalJsonBytes   += jsonSize;
        totalBinaryBytes += binBuf.length;
        convertedCount++;

        if (convertedCount % 200 === 0) {
          process.stdout.write(`  converted ${convertedCount} tiles...\r`);
        }
      } catch (err) {
        errorCount++;
        if (errorCount <= 10) {
          console.error(`Error converting ${jsonPath}: ${err.message}`);
        }
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n=== Binary Tile Conversion Complete ===');
  console.log(`  Converted:  ${convertedCount} tiles`);
  console.log(`  Skipped:    ${skippedCount} (empty files)`);
  console.log(`  Errors:     ${errorCount}`);
  console.log(`  JSON total: ${(totalJsonBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  BIN total:  ${(totalBinaryBytes / 1024 / 1024).toFixed(2)} MB`);
  if (totalJsonBytes > 0) {
    const ratio = ((1 - totalBinaryBytes / totalJsonBytes) * 100).toFixed(1);
    console.log(`  Savings:    ${ratio}%`);
  }
  console.log(`  Time:       ${elapsed}s`);
}

// Only run main() when executed directly (not when imported)
const isMainModule = process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
if (isMainModule) {
  main();
}
