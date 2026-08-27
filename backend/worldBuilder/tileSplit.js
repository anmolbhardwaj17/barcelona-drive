/**
 * Split road segments by slippy tiles and clip geometry at tile boundaries.
 * Exports tileMercatorBounds and clipRoadsForTile for per-tile streaming.
 */
import { latLonToTile, tileToBBox, latLonToMercator } from '../projection.js';

/** Get mercator bounds for tile (tx, ty) at zoom. minY/maxY = mercator z (north-south). margin (m) expands bounds. */
export function tileMercatorBounds(tx, ty, zoom, margin = 0) {
  const bbox = tileToBBox(tx, ty, zoom);
  const sw = latLonToMercator(bbox.south, bbox.west);
  const ne = latLonToMercator(bbox.north, bbox.east);
  const m = Math.abs(margin) || 0;
  return {
    minX: sw.x - m,
    minY: sw.y - m,
    maxX: ne.x + m,
    maxY: ne.y + m,
  };
}

const EPS = 1e-12;
const TRACE_WAY_ID = 29534879;

/** Explicit line-rectangle intersection fallback. Returns [t0,t1] or null. */
function clipSegmentExplicit(a, b, bounds) {
  const [x0, y0] = a;
  const [x1, y1] = b;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const ts = [];
  if (Math.abs(dx) > EPS) {
    const tLeft = (bounds.minX - x0) / dx;
    const tRight = (bounds.maxX - x0) / dx;
    const yLeft = y0 + tLeft * dy;
    const yRight = y0 + tRight * dy;
    if (tLeft >= 0 && tLeft <= 1 && yLeft >= bounds.minY - EPS && yLeft <= bounds.maxY + EPS) ts.push(tLeft);
    if (tRight >= 0 && tRight <= 1 && yRight >= bounds.minY - EPS && yRight <= bounds.maxY + EPS) ts.push(tRight);
  }
  if (Math.abs(dy) > EPS) {
    const tBottom = (bounds.minY - y0) / dy;
    const tTop = (bounds.maxY - y0) / dy;
    const xBottom = x0 + tBottom * dx;
    const xTop = x0 + tTop * dx;
    if (tBottom >= 0 && tBottom <= 1 && xBottom >= bounds.minX - EPS && xBottom <= bounds.maxX + EPS) ts.push(tBottom);
    if (tTop >= 0 && tTop <= 1 && xTop >= bounds.minX - EPS && xTop <= bounds.maxX + EPS) ts.push(tTop);
  }
  const inside0 = x0 >= bounds.minX - EPS && x0 <= bounds.maxX + EPS && y0 >= bounds.minY - EPS && y0 <= bounds.maxY + EPS;
  const inside1 = x1 >= bounds.minX - EPS && x1 <= bounds.maxX + EPS && y1 >= bounds.minY - EPS && y1 <= bounds.maxY + EPS;
  if (inside0) ts.push(0);
  if (inside1) ts.push(1);
  if (ts.length < 2) return null;
  ts.sort((u, v) => u - v);
  const t0 = ts[0];
  const t1 = ts[ts.length - 1];
  if (t1 - t0 < EPS) return null;
  return [Math.max(0, t0), Math.min(1, t1)];
}

/** Intersect segment (a -> b) with bounds; return [t0, t1] in [0,1] for the visible sub-segment, or null. */
function clipSegmentT(a, b, bounds) {
  let [x0, y0] = a;
  let [x1, y1] = b;
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  for (const { p, q } of [
    { p: -dx, q: x0 - bounds.minX },
    { p: dx, q: bounds.maxX - x0 },
    { p: -dy, q: y0 - bounds.minY },
    { p: dy, q: bounds.maxY - y0 },
  ]) {
    if (Math.abs(p) < EPS) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      t0 = Math.max(t0, t);
    } else {
      if (t < t0) return null;
      t1 = Math.min(t1, t);
    }
  }
  t0 = Math.max(0, Math.min(1, t0));
  t1 = Math.max(0, Math.min(1, t1));
  if (t1 - t0 < EPS) return null;
  return [t0, t1];
}

/** Points are [x, yUp, z] or [x, yUp, z, terrainHeight]. Clip in (x,z) plane; interpolate yUp and 4th component. */
function clipOneSegment(p0, p1, bounds) {
  const a2d = [p0[0], p0[2]];
  const b2d = [p1[0], p1[2]];
  let t = clipSegmentT(a2d, b2d, bounds);
  if (!t) t = clipSegmentExplicit(a2d, b2d, bounds);
  if (!t) return null;
  const [t0, t1] = t;
  const lerp = (a, b, s) => a + s * (b - a);
  const x0 = lerp(p0[0], p1[0], t0);
  const yUp0 = lerp(p0[1], p1[1], t0);
  const z0 = lerp(p0[2], p1[2], t0);
  const x1 = lerp(p0[0], p1[0], t1);
  const yUp1 = lerp(p0[1], p1[1], t1);
  const z1 = lerp(p0[2], p1[2], t1);
  const hasFourth = p0.length >= 4 && p1.length >= 4;
  const fourth0 = hasFourth ? lerp(p0[3], p1[3], t0) : undefined;
  const fourth1 = hasFourth ? lerp(p0[3], p1[3], t1) : undefined;
  return [
    fourth0 !== undefined ? [x0, yUp0, z0, fourth0] : [x0, yUp0, z0],
    fourth1 !== undefined ? [x1, yUp1, z1, fourth1] : [x1, yUp1, z1],
  ];
}

/**
 * Clip a road polyline to a tile; return array of sub-segments (each is array of [x,yUp,z] or [x,yUp,z,terrainHeight], length >= 2).
 */
function clipRoadToTile(points, bounds) {
  if (!points || points.length < 2) return [];
  const segments = [];
  let run = null;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const clipped = clipOneSegment(p0, p1, bounds);
    if (!clipped) {
      // R-J5 FIX: FLUSH the accumulated run before dropping it.
      //
      // This used to be a bare `run = null`, which threw away every point gathered so far. A run is
      // only ever pushed when a NEW run starts (the else branch below) or when the polyline ENDS —
      // so any run terminated by the road LEAVING the tile was silently discarded, and that is the
      // common case: a road enters the tile, crosses it, and exits.
      //
      // Measured: a 103-point path with 42 consecutive segments fully inside tile 16_33153_24471
      // clipped to ZERO runs. A 2-point road from the same polyline clipped correctly, which is
      // what made this invisible — the bug needs a polyline that both enters and leaves.
      //
      // This very likely explains `noClipTileStrategy: true`: with the clipper eating roads, not
      // clipping at all was the only thing that produced a complete city. The strategy can stay
      // (the DATA does want continuity) — but the RENDER clip R-J5 added depends on this working.
      if (run && run.length >= 2) segments.push(run);
      run = null;
      continue;
    }
    const [a, b] = clipped;
    const dist = (run && run.length >= 2)
      ? Math.hypot(run[run.length - 1][0] - a[0], run[run.length - 1][2] - a[2])
      : Infinity;
    if (run && run.length >= 2 && dist < 1e-4) {
      run.push(b);
    } else {
      if (run && run.length >= 2) segments.push(run);
      run = [a, b];
    }
  }
  if (run && run.length >= 2) segments.push(run);
  return segments;
}

/**
 * No-clip mode: write full way geometry for each road. No clipping, no splitting.
 * Ways may exist in multiple tiles when bbox intersects. Guarantees continuous roads.
 *
 * @param {object[]} roads - Each { id, points, width, bridge, tunnel, layer, highwayType }
 * @param {string} [tileId] - Optional tile id for debug tracing
 * @returns {object[]} Array of { id, points, width, bridge, tunnel, layer, highwayType }
 */
export function roadsForTileNoClip(roads, tileId = null) {
  const out = [];
  for (const road of roads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const pointsCopy = pts.map((p) => (Array.isArray(p) ? [...p] : p));
    out.push({
      id: road.id,
      nodeIds: road.nodeIds ? [...road.nodeIds] : [],
      points: pointsCopy,
      width: road.width,
      // ⚠ R-W1 / D-42: this is a FIELD-BY-FIELD COPY, i.e. a whitelist. Anything not named here
      // ceases to exist downstream, silently, as `undefined`. The width section must survive the
      // tile split or every consumer falls back to guessing again.
      carriagewayW:  road.carriagewayW,
      parkingLeftW:  road.parkingLeftW,
      parkingRightW: road.parkingRightW,
      shoulderW:     road.shoulderW,
      kerbToKerbW:   road.kerbToKerbW,
      sidewalkW:     road.sidewalkW,
      corridorW:     road.corridorW,
      lanes:         road.lanes,
      bridge: road.bridge,
      tunnel: road.tunnel,
      layer: road.layer,
      highwayType: road.highwayType,
      name: road.name || '',
      serviceSubtype: road.serviceSubtype || null,
      isRamp: road.isRamp || false,
      brokenRamp: road.brokenRamp || false,
      crossesTrench: road.crossesTrench || false, // OPTION L flag must survive tile split
    });
    if (road.id === TRACE_WAY_ID && tileId != null) {
      console.log(`  [TRACE ${TRACE_WAY_ID}] noClip tile ${tileId}: full way, ${pts.length} points`);
    }
  }
  return out;
}

/**
 * Clip a list of roads to one tile's bounds. Returns segment objects for that tile only.
 * Same output structure as splitRoadsByTile for a single tile.
 *
 * @param {object[]} roads - Each { id, points, width, bridge, tunnel, layer, highwayType }
 * @param {{ minX, minY, maxX, maxY }} bounds - Mercator bounds (minY/maxY = z)
 * @param {string} [tileId] - Optional tile id for debug tracing (e.g. way 29534879)
 * @returns {object[]} Array of { id, points, width, bridge, tunnel, layer, highwayType }
 */
export function clipRoadsForTile(roads, bounds, tileId = null) {
  const out = [];
  for (const road of roads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    let segments = clipRoadToTile(pts, bounds);
    if (road.id === TRACE_WAY_ID && tileId != null) {
      const nSegIn = pts.length - 1;
      console.log(`  [TRACE ${TRACE_WAY_ID}] clip tile ${tileId}: ${nSegIn} segments in, ${segments.length} segment(s) out`);
    }
    for (const seg of segments) {
      out.push({
        id: road.id,
        nodeIds: road.nodeIds ? [...road.nodeIds] : [],
        points: seg,
        width: road.width,
      // ⚠ R-W1 / D-42: this is a FIELD-BY-FIELD COPY, i.e. a whitelist. Anything not named here
      // ceases to exist downstream, silently, as `undefined`. The width section must survive the
      // tile split or every consumer falls back to guessing again.
      carriagewayW:  road.carriagewayW,
      parkingLeftW:  road.parkingLeftW,
      parkingRightW: road.parkingRightW,
      shoulderW:     road.shoulderW,
      kerbToKerbW:   road.kerbToKerbW,
      sidewalkW:     road.sidewalkW,
      corridorW:     road.corridorW,
      lanes:         road.lanes,
        bridge: road.bridge,
        tunnel: road.tunnel,
        layer: road.layer,
        highwayType: road.highwayType,
        name: road.name || '',
        serviceSubtype: road.serviceSubtype || null,
        isRamp: road.isRamp || false,
        brokenRamp: road.brokenRamp || false,
        crossesTrench: road.crossesTrench || false, // OPTION L flag must survive tile split
      });
    }
  }
  return out;
}

/**
 * Split roads into per-tile segments (legacy: processes all tiles at once).
 * Points are [x, yUp, z] or [x, yUp, z, terrainHeight]; 4th preserved for tile elevation array.
 * @param {object[]} roads - Each { points: [[x,yUp,z] or [x,yUp,z,terrainHeight], ...], width, bridge, tunnel, layer, highwayType }
 * @param {{ minLon, minLat, maxLon, maxLat }} bbox - WGS84
 * @param {number} zoom
 * @returns {Map<string, object[]>} Tile key "z_x_y" -> array of road segments for that tile
 */
export function splitRoadsByTile(roads, bbox, zoom) {
  const minT = latLonToTile(bbox.maxLat, bbox.minLon, zoom);
  const maxT = latLonToTile(bbox.minLat, bbox.maxLon, zoom);
  const minTileX = Math.min(minT.x, maxT.x);
  const maxTileX = Math.max(minT.x, maxT.x);
  const minTileY = Math.min(minT.y, maxT.y);
  const maxTileY = Math.max(minT.y, maxT.y);

  const tiles = new Map();

  for (const road of roads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    for (let ty = minTileY; ty <= maxTileY; ty++) {
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        const bounds = tileMercatorBounds(tx, ty, zoom);
        const segments = clipRoadToTile(pts, bounds);
        if (segments.length === 0) continue;
        const key = `${zoom}_${tx}_${ty}`;
        if (!tiles.has(key)) tiles.set(key, []);
        for (const seg of segments) {
          tiles.get(key).push({
            id: road.id,
            nodeIds: road.nodeIds ? [...road.nodeIds] : [],
            points: seg,
            width: road.width,
            // ⚠ R-W1 / D-42: this is a FIELD-BY-FIELD COPY, i.e. a whitelist. Anything not named here
            // ceases to exist downstream, silently, as `undefined`. The width section must survive the
            // tile split or every consumer falls back to guessing again.
            carriagewayW:  road.carriagewayW,
            parkingLeftW:  road.parkingLeftW,
            parkingRightW: road.parkingRightW,
            shoulderW:     road.shoulderW,
            kerbToKerbW:   road.kerbToKerbW,
            sidewalkW:     road.sidewalkW,
            corridorW:     road.corridorW,
            lanes:         road.lanes,
      // ⚠ R-W1 / D-42: this is a FIELD-BY-FIELD COPY, i.e. a whitelist. Anything not named here
      // ceases to exist downstream, silently, as `undefined`. The width section must survive the
      // tile split or every consumer falls back to guessing again.
      carriagewayW:  road.carriagewayW,
      parkingLeftW:  road.parkingLeftW,
      parkingRightW: road.parkingRightW,
      shoulderW:     road.shoulderW,
      kerbToKerbW:   road.kerbToKerbW,
      sidewalkW:     road.sidewalkW,
      corridorW:     road.corridorW,
      lanes:         road.lanes,
            bridge: road.bridge,
            tunnel: road.tunnel,
            layer: road.layer,
            highwayType: road.highwayType,
          });
        }
      }
    }
  }

  return tiles;
}
