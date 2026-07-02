/**
 * Way stitching: merge consecutive ways that share endpoints and same road type
 * into a single polyline. Run before simplify.
 * Uses endpoint spatial hashing for O(N) performance — no global comparison.
 */

function cellKey(x, z, cellSize) {
  const cx = Math.floor(x / cellSize);
  const cz = Math.floor(z / cellSize);
  return `${cx},${cz}`;
}

function distSq(ax, az, bx, bz) {
  return (ax - bx) ** 2 + (az - bz) ** 2;
}

function pointsMatch(p1, p2, tolSq) {
  const ax = Array.isArray(p1) ? p1[0] : p1.x;
  const az = Array.isArray(p1) ? p1[2] : (p1.y ?? p1.z);
  const bx = Array.isArray(p2) ? p2[0] : p2.x;
  const bz = Array.isArray(p2) ? p2[2] : (p2.y ?? p2.z);
  return distSq(ax, az, bx, bz) <= tolSq;
}

function wayKey(road) {
  return `${road.highwayType || ''}|${!!road.bridge}|${!!road.tunnel}|${road.layer ?? 0}`;
}

const CELL_OFFSETS = [
  [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/**
 * Build endpoint index: bucketKey -> [{ idx, x, z, isStart, key }]
 * Same bucket = same spatial cell. Only compare within bucket.
 */
function buildEndpointIndex(roads, cellSize, getPoint) {
  const index = new Map();
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    if (!r.points || r.points.length < 2) continue;
    const key = wayKey(r);
    const start = getPoint(r, 0);
    const end = getPoint(r, r.points.length - 1);
    const ckS = cellKey(start[0], start[1], cellSize);
    const ckE = cellKey(end[0], end[1], cellSize);
    const add = (ck, x, z, isStart) => {
      const bucketKey = `${ck}|${key}`;
      if (!index.has(bucketKey)) index.set(bucketKey, []);
      index.get(bucketKey).push({ idx: i, x, z, isStart });
    };
    add(ckS, start[0], start[1], true);
    add(ckE, end[0], end[1], false);
  }
  return index;
}

/**
 * Find ways in same bucket whose endpoint matches (x,z) within tolerance.
 * Only searches 9 cells (current + neighbors) for edge cases.
 */
function findInBucket(index, x, z, key, excludeIdx, used, tolSq, cellSize) {
  const cx = Math.floor(x / cellSize);
  const cz = Math.floor(z / cellSize);
  const out = [];
  for (const [dx, dz] of CELL_OFFSETS) {
    const ck = `${cx + dx},${cz + dz}`;
    const bucketKey = `${ck}|${key}`;
    const list = index.get(bucketKey);
    if (!list) continue;
    for (const { idx, x: ox, z: oz } of list) {
      if (idx === excludeIdx || used.has(idx)) continue;
      if (distSq(x, z, ox, oz) <= tolSq) out.push(idx);
    }
  }
  return out;
}

/**
 * Merge consecutive ways sharing endpoints and same road type into single polylines.
 * Near O(N) via endpoint spatial hashing — no global O(N²) comparison.
 * @param {object[]} roads - Each { points, highwayType, bridge, tunnel, layer, width, id, ... }
 * @param {{ nodeSnapDistance?: number, topologySnapTolerance?: number }} config
 * @returns {object[]} Merged roads (fewer, longer polylines)
 */
export function stitchWays(roads, config) {
  console.time('stitchWays');

  const snapThreshold = config.nodeSnapDistance ?? config.topologySnapTolerance ?? 1;
  const tolSq = snapThreshold * snapThreshold;
  if (snapThreshold <= 0 || !roads?.length) {
    console.timeEnd('stitchWays');
    return roads;
  }

  const cellSize = Math.max(snapThreshold * 1.5, 1e-9);
  const merged = roads.map((r) => ({ ...r, points: r.points.map((p) => [...p]) }));
  const used = new Set();

  function getPoint(road, i) {
    const p = road.points[i];
    return [p[0], p[2]];
  }

  // Build endpoint index ONCE — bucket by (cell, wayKey)
  const index = buildEndpointIndex(merged, cellSize, (r, i) => getPoint(r, i));
  const bucketCount = index.size;
  console.log('stitchWays: endpoint buckets:', bucketCount, 'ways:', merged.length);

  function extendForward(wayIdx) {
    const r = merged[wayIdx];
    const key = wayKey(r);
    let [ex, ez] = getPoint(r, r.points.length - 1);
    let any = true;
    while (any) {
      any = false;
      const candidates = findInBucket(index, ex, ez, key, wayIdx, used, tolSq, cellSize);
      for (const j of candidates) {
        const other = merged[j];
        const [osx, osz] = getPoint(other, 0);
        const [oex, oez] = getPoint(other, other.points.length - 1);
        if (pointsMatch([ex, 0, ez], [osx, 0, osz], tolSq)) {
          used.add(j);
          r.points = r.points.concat(other.points.slice(1));
          [ex, ez] = [oex, oez];
          any = true;
          break;
        }
        if (pointsMatch([ex, 0, ez], [oex, 0, oez], tolSq)) {
          used.add(j);
          const rev = other.points.slice().reverse().map((p) => [...p]);
          r.points = r.points.concat(rev.slice(1));
          [ex, ez] = [rev[rev.length - 1][0], rev[rev.length - 1][2]];
          any = true;
          break;
        }
      }
    }
  }

  function extendBackward(wayIdx) {
    const r = merged[wayIdx];
    const key = wayKey(r);
    let [sx, sz] = getPoint(r, 0);
    let any = true;
    while (any) {
      any = false;
      const candidates = findInBucket(index, sx, sz, key, wayIdx, used, tolSq, cellSize);
      for (const j of candidates) {
        const other = merged[j];
        const [osx, osz] = getPoint(other, 0);
        const [oex, oez] = getPoint(other, other.points.length - 1);
        if (pointsMatch([sx, 0, sz], [oex, 0, oez], tolSq)) {
          used.add(j);
          r.points = other.points.slice(0, -1).concat(r.points);
          [sx, sz] = [osx, osz];
          any = true;
          break;
        }
        if (pointsMatch([sx, 0, sz], [osx, 0, osz], tolSq)) {
          used.add(j);
          const rev = other.points.slice().reverse().map((p) => [...p]);
          r.points = rev.slice(0, -1).concat(r.points);
          [sx, sz] = [rev[0][0], rev[0][2]];
          any = true;
          break;
        }
      }
    }
  }

  // Single pass: for each unused way, extend forward and backward (only within buckets)
  for (let i = 0; i < merged.length; i++) {
    if (used.has(i)) continue;
    extendForward(i);
    extendBackward(i);
  }

  const result = merged.filter((_, i) => !used.has(i));
  for (const r of result) {
    if (r.points.length < 2) continue;
    const [sx, sz] = getPoint(r, 0);
    const [ex, ez] = getPoint(r, r.points.length - 1);
    if (distSq(sx, sz, ex, ez) <= tolSq) r.closedLoop = true;
  }

  console.log('stitchWays: merged', roads.length, '->', result.length);
  console.timeEnd('stitchWays');
  return result;
}
