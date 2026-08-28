/**
 * OsmDataFixer: preprocessing pass that cleans up OSM data before
 * junction classification and ramp resolution.
 *
 * Rules (applied in order):
 *   4. Orphan Short Bridge Cleaner
 *   5. Duplicate Road Remover
 *   1. Bridge Layer Conflict Resolver
 *   6. Ground Road Lateral Offset Under Bridges
 *
 * Pure topology + geometry fixes. No DEM. No terrain.
 */

// ─── Highway type priority (higher = more important / wider) ─────────────
const HIGHWAY_PRIORITY = {
  motorway: 10, trunk: 9, primary: 8, secondary: 7, tertiary: 6,
  motorway_link: 5, trunk_link: 5, primary_link: 5,
  secondary_link: 4, tertiary_link: 4,
  residential: 3, living_street: 3, unclassified: 3,
  service: 2, track: 1,
};

function highwayPriority(type) {
  return HIGHWAY_PRIORITY[type] ?? 2;
}

// ─── Synthetic node ID counter ───────────────────────────────────────────
let syntheticNodeId = -1000000;
function nextSyntheticId() {
  return syntheticNodeId--;
}

// ═══════════════════════════════════════════════════════════════════════════
// Geometry helpers
// ═══════════════════════════════════════════════════════════════════════════

const DEG_TO_M = 111320;

/**
 * Haversine-lite: approximate lat/lon delta to metres.
 * Returns { dx (east-west), dz (north-south) }.
 */
function toMeters(lat1, lon1, lat2, lon2) {
  const dz = (lat2 - lat1) * DEG_TO_M;
  const dx = (lon2 - lon1) * DEG_TO_M * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return { dx, dz };
}

/**
 * Polyline length in metres from nodeIds + nodeMap.
 */
function wayLength(way, nodeMap) {
  const ids = way.nodeIds;
  if (!ids || ids.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < ids.length; i++) {
    const a = nodeMap.get(ids[i - 1]);
    const b = nodeMap.get(ids[i]);
    if (!a || !b) continue;
    const { dx, dz } = toMeters(a.lat, a.lon, b.lat, b.lon);
    total += Math.sqrt(dx * dx + dz * dz);
  }
  return total;
}

/**
 * Point-to-segment distance in metres (2D, using metric coords).
 */
function pointToSegDist(px, pz, ax, az, bx, bz) {
  const abx = bx - ax;
  const abz = bz - az;
  const lenSq = abx * abx + abz * abz;
  if (lenSq === 0) {
    const ex = px - ax;
    const ez = pz - az;
    return Math.sqrt(ex * ex + ez * ez);
  }
  let t = ((px - ax) * abx + (pz - az) * abz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * abx;
  const cz = az + t * abz;
  const ex = px - cx;
  const ez = pz - cz;
  return Math.sqrt(ex * ex + ez * ez);
}

/**
 * Minimum distance from a point to a polyline (array of {dx, dz} metric coords).
 */
function pointToPolylineDist(px, pz, polyMetric) {
  let minD = Infinity;
  for (let i = 0; i < polyMetric.length - 1; i++) {
    const d = pointToSegDist(px, pz, polyMetric[i].dx, polyMetric[i].dz,
      polyMetric[i + 1].dx, polyMetric[i + 1].dz);
    if (d < minD) minD = d;
  }
  return minD;
}

/**
 * 2D segment-segment intersection test.
 * Returns true if segments (a1→a2) and (b1→b2) cross.
 */
function segmentsIntersect(a1x, a1z, a2x, a2z, b1x, b1z, b2x, b2z) {
  const d1x = a2x - a1x, d1z = a2z - a1z;
  const d2x = b2x - b1x, d2z = b2z - b1z;
  const cross = d1x * d2z - d1z * d2x;
  if (Math.abs(cross) < 1e-10) return false; // parallel
  const dx = b1x - a1x, dz = b1z - a1z;
  const t = (dx * d2z - dz * d2x) / cross;
  const u = (dx * d1z - dz * d1x) / cross;
  return t > 0 && t < 1 && u > 0 && u < 1;
}

/**
 * Compute bounding box of a way in approximate metres, relative to
 * the way's first node (origin). Returns { minX, minZ, maxX, maxZ, originLat, originLon }.
 */
function wayBbox(way, nodeMap) {
  const ids = way.nodeIds;
  if (!ids || ids.length === 0) return null;
  const origin = nodeMap.get(ids[0]);
  if (!origin) return null;

  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  let validCount = 0;
  for (const nid of ids) {
    const n = nodeMap.get(nid);
    if (!n) continue;
    const { dx, dz } = toMeters(origin.lat, origin.lon, n.lat, n.lon);
    if (dx < minX) minX = dx;
    if (dx > maxX) maxX = dx;
    if (dz < minZ) minZ = dz;
    if (dz > maxZ) maxZ = dz;
    validCount++;
  }
  if (validCount < 2) return null;
  return { minX, minZ, maxX, maxZ, originLat: origin.lat, originLon: origin.lon };
}

/**
 * Compute bounding box in lat/lon (no metric conversion needed for overlap test).
 */
function wayBboxLatLon(way, nodeMap) {
  const ids = way.nodeIds;
  if (!ids || ids.length === 0) return null;
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  let valid = 0;
  for (const nid of ids) {
    const n = nodeMap.get(nid);
    if (!n) continue;
    if (n.lat < minLat) minLat = n.lat;
    if (n.lat > maxLat) maxLat = n.lat;
    if (n.lon < minLon) minLon = n.lon;
    if (n.lon > maxLon) maxLon = n.lon;
    valid++;
  }
  if (valid < 2) return null;
  return { minLat, minLon, maxLat, maxLon };
}

/**
 * Check if two lat/lon bboxes overlap with a margin in degrees.
 */
function bboxOverlapLatLon(a, b, marginDeg) {
  if (!a || !b) return false;
  return a.minLat - marginDeg <= b.maxLat &&
         a.maxLat + marginDeg >= b.minLat &&
         a.minLon - marginDeg <= b.maxLon &&
         a.maxLon + marginDeg >= b.minLon;
}

/**
 * Convert a way's node coordinates to metric coords relative to a reference point.
 */
function wayToMetric(way, nodeMap, refLat, refLon) {
  const result = [];
  for (const nid of way.nodeIds) {
    const n = nodeMap.get(nid);
    if (!n) continue;
    const { dx, dz } = toMeters(refLat, refLon, n.lat, n.lon);
    result.push({ dx, dz, nodeId: nid });
  }
  return result;
}

/**
 * Sample points along a polyline at approximately the given interval (metres).
 * Input: array of { dx, dz }.
 * Returns array of { dx, dz }.
 */
function samplePolyline(polyMetric, interval) {
  if (polyMetric.length < 2) return [...polyMetric];
  const samples = [polyMetric[0]];
  let carry = 0;
  for (let i = 1; i < polyMetric.length; i++) {
    const segDx = polyMetric[i].dx - polyMetric[i - 1].dx;
    const segDz = polyMetric[i].dz - polyMetric[i - 1].dz;
    const segLen = Math.sqrt(segDx * segDx + segDz * segDz);
    if (segLen === 0) continue;
    let pos = interval - carry;
    while (pos <= segLen) {
      const t = pos / segLen;
      samples.push({
        dx: polyMetric[i - 1].dx + t * segDx,
        dz: polyMetric[i - 1].dz + t * segDz,
      });
      pos += interval;
    }
    carry = segLen - (pos - interval);
  }
  return samples;
}


// ═══════════════════════════════════════════════════════════════════════════
// Rule 4: Orphan Short Bridge Cleaner
// ═══════════════════════════════════════════════════════════════════════════

function rule4_orphanShortBridge(wayMap, nodeToWays, nodeMap) {
  let fixed = 0;
  for (const [wayId, way] of wayMap) {
    if (!way.bridge && (way.layer || 0) <= 0) continue;
    if ((way.highwayType || '').includes('rail')) continue;

    const ids = way.nodeIds;
    if (!ids || ids.length < 2) continue;

    // Check length < 30m
    const len = wayLength(way, nodeMap);
    if (len >= 30) continue;

    // Check if start AND end are truly orphaned (not shared with any other way)
    const startNodeId = ids[0];
    const endNodeId = ids[ids.length - 1];

    const startWays = nodeToWays.get(startNodeId);
    const endWays = nodeToWays.get(endNodeId);

    const startOrphaned = !startWays || startWays.size <= 1;
    const endOrphaned = !endWays || endWays.size <= 1;

    if (!startOrphaned || !endOrphaned) continue;

    // Demote: remove bridge status
    way.bridge = false;
    way.layer = 0;
    fixed++;
  }
  return fixed;
}



// ═══════════════════════════════════════════════════════════════════════════
// Rule 7: Missing Link Synthesiser  (N-32)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Two ends of one street, pointing at each other, with nothing between them.
 *
 * ── WHY THIS IS SOUND AND NOT INVENTION ──────────────────────────────────────────────────────
 * The user put it exactly right: "we should be smart enough to know here there is a road, which is
 * tunnel, otherwise these 2 roads wont merge". If a named street terminates and the SAME named
 * street of the SAME class resumes 150 m further on, aimed straight back at the first, the link
 * physically exists — OSM simply has no way for it, usually because it runs under something. The
 * evidence is the pair of dead ends, and a real dead end does not point at another dead end.
 *
 * Measured over the shipped tiles before writing this: 3,877 unconnected endpoints, **554 pairs**
 * facing each other within 25 deg at 5-250 m, of which **41 share a street NAME** (Carrer del
 * Milanesat 208 m, Rambla del Poblenou 146 m, Carrer de la Muntanya 150 m).
 *
 * ── THE GUARDS, AND WHY EACH ONE IS THERE ────────────────────────────────────────────────────
 * Synthesising road is the most dangerous thing in this file, so every condition is a veto:
 *   · SAME NAME and SAME CLASS. Name is the evidence. 554 pairs drop to 41 — precision over recall,
 *     because a wrong link is a road through a building and a missed one is only a gap.
 *   · Both ends genuinely FREE: no other way's node within CONNECT_M. A junction is not a gap.
 *   · Each end points at the other (cos >= 0.90 both ways). Two parallel dead ends are not a link.
 *   · The straight line must not CROSS another drivable way at grade — that would be a junction it
 *     should have joined, not a tunnel under it.
 *   · Length bounded. Under MIN it is a survey artifact; over MAX it is two unrelated streets that
 *     happen to share a common Barcelona name.
 * Emitted as `tunnel`/`layer:-1` so the existing tunnel pipeline gives it portals, lining and
 * colliders — this rule adds a WAY, it does not add a renderer.
 */
const LINK_CONNECT_M = 2.0;     // an endpoint this close to another way is already joined
const LINK_MIN_M = 8;
// N-34: a SHORT facing gap does not need a matching name. Two free ends 15 m apart, aimed at each
// other, same class, with nothing crossing between them, are one road — the name is only needed as
// evidence when the gap is long enough that two unrelated streets could be confused. User-reported:
// "2 roads very close to each other but no ramp and just exiting like this thats wrong for sure".
// Measured over the shipped tiles: 33 facing pairs within 25 m, 27 of them same-class — so this
// admits roughly a dozen beyond what the name rule already caught, not a flood.
const SHORT_LINK_M = 25;
const LINK_MAX_M = 250;
const LINK_COS = 0.90;          // ~25 deg

function rule7_missingLinkSynthesiser(wayMap, nodeToWays, nodeMap) {
  const stats = { pairsConsidered: 0, freeEnds: 0, created: 0, shortUnnamedLinks: 0,
                  rejectedName: 0, rejectedAim: 0, rejectedCrossing: 0 };

  const ways = [...wayMap.values()].filter((w) =>
    w.nodeIds && w.nodeIds.length >= 2 && DRIVABLE_FOR_LINK.has(w.highwayType));

  // node -> how many ways touch it, so a "free end" is cheap to test
  const touch = new Map();
  for (const w of ways) for (const nid of w.nodeIds) touch.set(nid, (touch.get(nid) || 0) + 1);

  const ends = [];
  for (const w of ways) {
    const n = w.nodeIds.length;
    for (const [nid, innerId] of [[w.nodeIds[0], w.nodeIds[1]], [w.nodeIds[n - 1], w.nodeIds[n - 2]]]) {
      if ((touch.get(nid) || 0) > 1) continue;          // shared node = already connected
      const a = nodeMap.get(nid), b = nodeMap.get(innerId);
      if (!a || !b) continue;
      const { dx, dz } = toMeters(b.lat, b.lon, a.lat, a.lon);   // pointing OUT of the way
      const len = Math.hypot(dx, dz) || 1;
      ends.push({ way: w, nid, lat: a.lat, lon: a.lon, dx: dx / len, dz: dz / len });
    }
  }
  stats.freeEnds = ends.length;

  // reject a candidate link that crosses another drivable way at grade
  const crossesAnyWay = (aLat, aLon, bLat, bLon, skipA, skipB) => {
    const o = toMeters(aLat, aLon, bLat, bLon);
    for (const w of ways) {
      if (w.id === skipA || w.id === skipB) continue;
      if (w.tunnel || (w.layer ?? 0) !== 0) continue;   // under/over is exactly what we allow
      const ids = w.nodeIds;
      for (let i = 0; i < ids.length - 1; i++) {
        const p = nodeMap.get(ids[i]), q = nodeMap.get(ids[i + 1]);
        if (!p || !q) continue;
        const P = toMeters(aLat, aLon, p.lat, p.lon), Q = toMeters(aLat, aLon, q.lat, q.lon);
        if (segmentsIntersect(0, 0, o.dx, o.dz, P.dx, P.dz, Q.dx, Q.dz)) return true;
      }
    }
    return false;
  };

  const used = new Set();
  for (let i = 0; i < ends.length; i++) {
    if (used.has(i)) continue;
    const a = ends[i];
    const nameA = String(a.way.tags?.name ?? '').trim();
    if (!nameA) continue;                                // no name, no evidence
    for (let j = i + 1; j < ends.length; j++) {
      if (used.has(j)) continue;
      const b = ends[j];
      if (b.way.id === a.way.id) continue;
      if (b.way.highwayType !== a.way.highwayType) continue;
      const nameB = String(b.way.tags?.name ?? '').trim();

      const { dx, dz } = toMeters(a.lat, a.lon, b.lat, b.lon);
      const gap = Math.hypot(dx, dz);
      if (gap < LINK_MIN_M || gap > LINK_MAX_M) continue;
      // Name is EVIDENCE, and how much evidence you need depends on the gap. Over SHORT_LINK_M the
      // names must match or two unrelated streets pointing at each other across a block become one
      // road. Under it, the geometry is already conclusive.
      if (nameB !== nameA && gap > SHORT_LINK_M) { stats.rejectedName++; continue; }
      if (nameB !== nameA) stats.shortUnnamedLinks++;
      stats.pairsConsidered++;

      const tx = dx / gap, tz = dz / gap;
      if ((a.dx * tx + a.dz * tz) < LINK_COS) { stats.rejectedAim++; continue; }
      if ((b.dx * -tx + b.dz * -tz) < LINK_COS) { stats.rejectedAim++; continue; }
      if (crossesAnyWay(a.lat, a.lon, b.lat, b.lon, a.way.id, b.way.id)) {
        stats.rejectedCrossing++; continue;
      }

      const id = nextSyntheticId();
      wayMap.set(id, {
        id,
        nodeIds: [a.nid, b.nid],
        // A LONG gap is a road passing under something: tunnel. A SHORT one is two ends that simply
        // were not joined — link them at grade, because burying a 15 m connector would carve a hole
        // in the street for no reason.
        tags: { ...(a.way.tags || {}),
                ...(gap > SHORT_LINK_M ? { tunnel: 'yes', layer: '-1' } : {}),
                _synthetic: 'missing_link' },
        bridge: false,
        tunnel: gap > SHORT_LINK_M,
        layer: gap > SHORT_LINK_M ? -1 : 0,
        highwayType: a.way.highwayType,
        closedLoop: false,
        points: null,
      });
      for (const nid of [a.nid, b.nid]) {
        if (!nodeToWays.has(nid)) nodeToWays.set(nid, new Set());
        nodeToWays.get(nid).add(id);
      }
      used.add(i); used.add(j);
      stats.created++;
      break;
    }
  }
  return stats;
}

const DRIVABLE_FOR_LINK = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified',
  'living_street', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]);

// ═══════════════════════════════════════════════════════════════════════════
// Rule 5: Duplicate Road Remover
// ═══════════════════════════════════════════════════════════════════════════

function rule5_duplicateRoadRemover(wayMap, nodeToWays, nodeMap) {
  let removed = 0;
  let removedStrict = 0, removedSameName = 0;   // D-23 proof of work: which branch actually fires

  // Margin ~50m in degrees (approx)
  const MARGIN_DEG = 50 / DEG_TO_M;
  const SAMPLE_INTERVAL = 10; // metres

  // ── N-1 · TWO THRESHOLDS, BECAUSE THE NAME IS EVIDENCE ────────────────────────────────────────
  //
  // This rule already does most of the work — 8,748 ways removed in a full Barcelona bake. What it
  // left behind is a TAIL just outside its limits, measured on the shipped tiles: 57 pairs where
  // one way is >70% covered by another of the same class, at centreline separations of 0.6-4 m.
  // `Avinguda de Pedralbes` carries THREE stacked ways over 56 m. Each is drawn at full width, so
  // the ribbons overlap almost completely — two coplanar surfaces at the same depth bias.
  //
  // Loosening the limits for everything would be wrong: Barcelona has real dual carriageways with
  // narrow medians, and at 5 m the rule would start eating them. But of those 57 pairs, **44 share
  // a street NAME and only 5 differ** — and two same-class ways carrying the same name over the
  // same ground are a duplicate, not two streets. So the name buys the extra reach, and anything
  // unnamed or differently-named keeps the strict limits.
  const STRICT     = { maxDist: 3, minRatio: 0.8 };
  const SAME_NAME  = { maxDist: 5, minRatio: 0.7 };

  // Build bbox + length for all ways
  const wayEntries = [];
  for (const [wayId, way] of wayMap) {
    const ids = way.nodeIds;
    if (!ids || ids.length < 2) continue;
    const bbox = wayBboxLatLon(way, nodeMap);
    if (!bbox) continue;
    const len = wayLength(way, nodeMap);
    wayEntries.push({ wayId, way, bbox, len });
  }

  // Sort by length descending so we process longer roads first
  wayEntries.sort((a, b) => b.len - a.len);

  const removedSet = new Set();

  for (let i = 0; i < wayEntries.length; i++) {
    const ea = wayEntries[i];
    if (removedSet.has(ea.wayId)) continue;

    for (let j = i + 1; j < wayEntries.length; j++) {
      const eb = wayEntries[j];
      if (removedSet.has(eb.wayId)) continue;

      // Must have same highway type
      if (ea.way.highwayType !== eb.way.highwayType) continue;

      // Skip if one is bridge and other isn't
      if (ea.way.bridge !== eb.way.bridge) continue;

      // Bbox overlap check
      if (!bboxOverlapLatLon(ea.bbox, eb.bbox, MARGIN_DEG)) continue;

      // eb is the shorter (or equal) road since sorted desc
      const shorter = eb;
      const longer = ea;

      // Use the first node of the shorter road as metric origin
      const firstNode = nodeMap.get(shorter.way.nodeIds[0]);
      if (!firstNode) continue;

      const shorterMetric = wayToMetric(shorter.way, nodeMap, firstNode.lat, firstNode.lon);
      const longerMetric = wayToMetric(longer.way, nodeMap, firstNode.lat, firstNode.lon);

      if (shorterMetric.length < 2 || longerMetric.length < 2) continue;

      // Sample the shorter road
      const samples = samplePolyline(shorterMetric, SAMPLE_INTERVAL);
      if (samples.length === 0) continue;

      const nameA = String(ea.way.tags?.name ?? '').trim();
      const nameB = String(eb.way.tags?.name ?? '').trim();
      const sameName = nameA !== '' && nameA === nameB;
      const lim = sameName ? SAME_NAME : STRICT;

      // Check how many samples are within lim.maxDist of the longer road
      let withinCount = 0;
      for (const s of samples) {
        const d = pointToPolylineDist(s.dx, s.dz, longerMetric);
        if (d <= lim.maxDist) withinCount++;
      }

      if (withinCount / samples.length >= lim.minRatio) {
        // Remove the shorter road
        removedSet.add(shorter.wayId);
        wayMap.delete(shorter.wayId);
        // Clean nodeToWays
        for (const nid of shorter.way.nodeIds) {
          const waySet = nodeToWays.get(nid);
          if (waySet) {
            waySet.delete(shorter.wayId);
            if (waySet.size === 0) nodeToWays.delete(nid);
          }
        }
        removed++;
        if (sameName) removedSameName++; else removedStrict++;
      }
    }
  }

  return { removed, strict: removedStrict, sameName: removedSameName };
}


// ═══════════════════════════════════════════════════════════════════════════
// Rule 1: Bridge Layer Conflict Resolver
// ═══════════════════════════════════════════════════════════════════════════

function rule1_bridgeLayerConflict(wayMap, nodeToWays, nodeMap) {
  let fixed = 0;
  const MARGIN_DEG = 100 / DEG_TO_M;

  // Collect all elevated roads
  const elevated = [];
  for (const [wayId, way] of wayMap) {
    if (!way.bridge && (way.layer || 0) <= 0) continue;
    const ids = way.nodeIds;
    if (!ids || ids.length < 2) continue;
    const bbox = wayBboxLatLon(way, nodeMap);
    if (!bbox) continue;
    elevated.push({ wayId, way, bbox });
  }

  for (let i = 0; i < elevated.length; i++) {
    const ea = elevated[i];
    for (let j = i + 1; j < elevated.length; j++) {
      const eb = elevated[j];

      // Skip if different layers already
      if ((ea.way.layer || 0) !== (eb.way.layer || 0)) continue;

      // Skip if they share any nodeId (connected = intentional)
      const nodeSetA = new Set(ea.way.nodeIds);
      let shared = false;
      for (const nid of eb.way.nodeIds) {
        if (nodeSetA.has(nid)) { shared = true; break; }
      }
      if (shared) continue;

      // Bbox overlap check
      if (!bboxOverlapLatLon(ea.bbox, eb.bbox, MARGIN_DEG)) continue;

      // Convert to metric for intersection test
      const firstNodeA = nodeMap.get(ea.way.nodeIds[0]);
      if (!firstNodeA) continue;

      const metricA = wayToMetric(ea.way, nodeMap, firstNodeA.lat, firstNodeA.lon);
      const metricB = wayToMetric(eb.way, nodeMap, firstNodeA.lat, firstNodeA.lon);

      if (metricA.length < 2 || metricB.length < 2) continue;

      // Test segment-segment crossings
      let crossing = false;
      for (let si = 0; si < metricA.length - 1 && !crossing; si++) {
        for (let sj = 0; sj < metricB.length - 1 && !crossing; sj++) {
          if (segmentsIntersect(
            metricA[si].dx, metricA[si].dz, metricA[si + 1].dx, metricA[si + 1].dz,
            metricB[sj].dx, metricB[sj].dz, metricB[sj + 1].dx, metricB[sj + 1].dz,
          )) {
            crossing = true;
          }
        }
      }

      if (!crossing) continue;

      // Bump the narrower (lower priority) road's layer
      const prioA = highwayPriority(ea.way.highwayType);
      const prioB = highwayPriority(eb.way.highwayType);
      if (prioA <= prioB) {
        ea.way.layer = (ea.way.layer || 0) + 1;
      } else {
        eb.way.layer = (eb.way.layer || 0) + 1;
      }
      fixed++;
    }
  }

  return fixed;
}


// ═══════════════════════════════════════════════════════════════════════════
// Rule 6: Ground Road Lateral Offset Under Bridges
// ═══════════════════════════════════════════════════════════════════════════

function rule6_groundRoadOffset(wayMap, nodeToWays, nodeMap) {
  let fixed = 0;
  const MARGIN_DEG = 100 / DEG_TO_M;
  const BLEND_DIST = 20; // metres for smooth blending
  const EXTRA_CLEARANCE = 3; // metres beyond bridge half-width

  // Collect ground roads and elevated roads
  const groundRoads = [];
  const elevatedRoads = [];
  for (const [wayId, way] of wayMap) {
    const ids = way.nodeIds;
    if (!ids || ids.length < 2) continue;
    const bbox = wayBboxLatLon(way, nodeMap);
    if (!bbox) continue;

    if ((way.layer || 0) === 0 && !way.bridge) {
      groundRoads.push({ wayId, way, bbox });
    } else if (way.bridge || (way.layer || 0) > 0) {
      elevatedRoads.push({ wayId, way, bbox });
    }
  }

  for (const gEntry of groundRoads) {
    const gWay = gEntry.way;
    const gIds = gWay.nodeIds;

    for (const eEntry of elevatedRoads) {
      const eWay = eEntry.way;

      // Bbox overlap check
      if (!bboxOverlapLatLon(gEntry.bbox, eEntry.bbox, MARGIN_DEG)) continue;

      // Skip if they share a nodeId (connected at junction)
      const eNodeSet = new Set(eWay.nodeIds);
      let shared = false;
      for (const nid of gIds) {
        if (eNodeSet.has(nid)) { shared = true; break; }
      }
      if (shared) continue;

      // Compute approximate direction of each road
      const gFirst = nodeMap.get(gIds[0]);
      const gLast = nodeMap.get(gIds[gIds.length - 1]);
      if (!gFirst || !gLast) continue;

      const eIds = eWay.nodeIds;
      const eFirst = nodeMap.get(eIds[0]);
      const eLast = nodeMap.get(eIds[eIds.length - 1]);
      if (!eFirst || !eLast) continue;

      const gDir = toMeters(gFirst.lat, gFirst.lon, gLast.lat, gLast.lon);
      const eDir = toMeters(eFirst.lat, eFirst.lon, eLast.lat, eLast.lon);

      const gLen = Math.sqrt(gDir.dx * gDir.dx + gDir.dz * gDir.dz);
      const eLen = Math.sqrt(eDir.dx * eDir.dx + eDir.dz * eDir.dz);
      if (gLen === 0 || eLen === 0) continue;

      // Normalize and compute dot product
      const dot = (gDir.dx * eDir.dx + gDir.dz * eDir.dz) / (gLen * eLen);

      // Skip if roughly perpendicular (crossing is fine)
      if (Math.abs(dot) < 0.7) continue;

      // Convert bridge to metric relative to gFirst
      const bridgeMetric = wayToMetric(eWay, nodeMap, gFirst.lat, gFirst.lon);
      if (bridgeMetric.length < 2) continue;

      // Estimate bridge half-width (rough: 4m default)
      const bridgeHalfWidth = 4 + EXTRA_CLEARANCE;

      // For each ground road point, check if it's in the overlap zone
      let wayModified = false;
      // Track which indices are in the zone and their offsets
      const offsets = new Array(gIds.length).fill(0);
      const inZone = new Array(gIds.length).fill(false);

      for (let pi = 0; pi < gIds.length; pi++) {
        const gNode = nodeMap.get(gIds[pi]);
        if (!gNode) continue;

        const { dx: px, dz: pz } = toMeters(gFirst.lat, gFirst.lon, gNode.lat, gNode.lon);

        // Distance to bridge centerline
        const distToBridge = pointToPolylineDist(px, pz, bridgeMetric);

        if (distToBridge < bridgeHalfWidth) {
          inZone[pi] = true;

          // Find closest point on bridge to determine offset direction
          let minD = Infinity;
          let closestSeg = 0;
          for (let si = 0; si < bridgeMetric.length - 1; si++) {
            const d = pointToSegDist(px, pz,
              bridgeMetric[si].dx, bridgeMetric[si].dz,
              bridgeMetric[si + 1].dx, bridgeMetric[si + 1].dz);
            if (d < minD) { minD = d; closestSeg = si; }
          }

          // Bridge segment direction
          const bsDx = bridgeMetric[closestSeg + 1].dx - bridgeMetric[closestSeg].dx;
          const bsDz = bridgeMetric[closestSeg + 1].dz - bridgeMetric[closestSeg].dz;
          const bsLen = Math.sqrt(bsDx * bsDx + bsDz * bsDz);
          if (bsLen === 0) continue;

          // Perpendicular to bridge segment (right-hand normal)
          let perpDx = -bsDz / bsLen;
          let perpDz = bsDx / bsLen;

          // Determine which side the ground point is on
          const toPx = px - bridgeMetric[closestSeg].dx;
          const toPz = pz - bridgeMetric[closestSeg].dz;
          const side = toPx * perpDx + toPz * perpDz;
          if (side < 0) { perpDx = -perpDx; perpDz = -perpDz; }

          // Push point to bridgeHalfWidth distance from bridge center
          const pushDist = bridgeHalfWidth - distToBridge;
          if (pushDist > 0) {
            offsets[pi] = pushDist;
          }
        }
      }

      // Check if any points need offsetting
      if (!offsets.some(o => o > 0)) continue;

      // Apply offsets with blending at zone boundaries
      // Find zone boundaries for blending
      for (let pi = 0; pi < gIds.length; pi++) {
        if (offsets[pi] <= 0) continue;

        // Compute blend factor based on distance to zone edge
        let blendFactor = 1.0;

        // Find cumulative distance from zone start
        let distFromStart = 0;
        for (let k = pi - 1; k >= 0; k--) {
          const nA = nodeMap.get(gIds[k]);
          const nB = nodeMap.get(gIds[k + 1]);
          if (!nA || !nB) break;
          const { dx, dz } = toMeters(nA.lat, nA.lon, nB.lat, nB.lon);
          distFromStart += Math.sqrt(dx * dx + dz * dz);
          if (!inZone[k]) break;
        }

        // Find cumulative distance to zone end
        let distToEnd = 0;
        for (let k = pi + 1; k < gIds.length; k++) {
          const nA = nodeMap.get(gIds[k - 1]);
          const nB = nodeMap.get(gIds[k]);
          if (!nA || !nB) break;
          const { dx, dz } = toMeters(nA.lat, nA.lon, nB.lat, nB.lon);
          distToEnd += Math.sqrt(dx * dx + dz * dz);
          if (!inZone[k]) break;
        }

        const edgeDist = Math.min(distFromStart, distToEnd);
        if (edgeDist < BLEND_DIST) {
          blendFactor = edgeDist / BLEND_DIST;
          blendFactor = blendFactor * blendFactor * (3 - 2 * blendFactor); // smoothstep
        }

        const finalOffset = offsets[pi] * blendFactor;
        if (finalOffset < 0.1) continue;

        // Get the node and compute offset direction
        const gNode = nodeMap.get(gIds[pi]);
        if (!gNode) continue;

        const { dx: px, dz: pz } = toMeters(gFirst.lat, gFirst.lon, gNode.lat, gNode.lon);

        // Find closest bridge segment for perpendicular direction
        let minD = Infinity;
        let closestSeg = 0;
        for (let si = 0; si < bridgeMetric.length - 1; si++) {
          const d = pointToSegDist(px, pz,
            bridgeMetric[si].dx, bridgeMetric[si].dz,
            bridgeMetric[si + 1].dx, bridgeMetric[si + 1].dz);
          if (d < minD) { minD = d; closestSeg = si; }
        }

        const bsDx = bridgeMetric[closestSeg + 1].dx - bridgeMetric[closestSeg].dx;
        const bsDz = bridgeMetric[closestSeg + 1].dz - bridgeMetric[closestSeg].dz;
        const bsLen = Math.sqrt(bsDx * bsDx + bsDz * bsDz);
        if (bsLen === 0) continue;

        let perpDx = -bsDz / bsLen;
        let perpDz = bsDx / bsLen;
        const toPx = px - bridgeMetric[closestSeg].dx;
        const toPz = pz - bridgeMetric[closestSeg].dz;
        const side = toPx * perpDx + toPz * perpDz;
        if (side < 0) { perpDx = -perpDx; perpDz = -perpDz; }

        // Convert offset back to lat/lon delta
        const offsetDx = perpDx * finalOffset;
        const offsetDz = perpDz * finalOffset;
        const cosLat = Math.cos(gNode.lat * Math.PI / 180);
        const dLon = offsetDx / (DEG_TO_M * cosLat);
        const dLat = offsetDz / DEG_TO_M;

        // Create a new synthetic node instead of mutating shared nodes
        const newNodeId = nextSyntheticId();
        nodeMap.set(newNodeId, { lat: gNode.lat + dLat, lon: gNode.lon + dLon });

        // Replace nodeId in the ground way
        const oldNodeId = gIds[pi];
        gWay.nodeIds[pi] = newNodeId;

        // Update nodeToWays: remove old mapping for this way, add new
        const oldSet = nodeToWays.get(oldNodeId);
        if (oldSet) {
          oldSet.delete(gEntry.wayId);
          if (oldSet.size === 0) nodeToWays.delete(oldNodeId);
        }
        if (!nodeToWays.has(newNodeId)) nodeToWays.set(newNodeId, new Set());
        nodeToWays.get(newNodeId).add(gEntry.wayId);

        wayModified = true;
      }

      if (wayModified) fixed++;
    }
  }

  return fixed;
}


// ═══════════════════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fix OSM data issues in the road graph.
 * Mutates graph.wayMap, graph.nodeToWays, and nodeMap in place.
 *
 * @param {object} graph - { wayMap, nodeToWays, nodeMap } from buildFromWays
 * @param {Map} nodeMap - nodeId → { lat, lon }
 * @returns {{ rule4, rule5, rule1, rule6 }} counts of fixes applied per rule
 */
export function fixOsmData(graph, nodeMap) {
  const { wayMap, nodeToWays } = graph;

  // Use graph's nodeMap if separate nodeMap not provided
  const nm = nodeMap || graph.nodeMap;

  const rule4 = rule4_orphanShortBridge(wayMap, nodeToWays, nm);
  const rule5 = rule5_duplicateRoadRemover(wayMap, nodeToWays, nm);
  const rule1 = rule1_bridgeLayerConflict(wayMap, nodeToWays, nm);
  const rule6 = rule6_groundRoadOffset(wayMap, nodeToWays, nm);
  // N-32: runs LAST — it reads the connectivity the other rules leave behind, so a gap created by
  // rule 5 removing a duplicate is a gap it should consider, not one it should have pre-empted.
  const rule7 = rule7_missingLinkSynthesiser(wayMap, nodeToWays, nm);

  return { rule4, rule5, rule1, rule6, rule7 };
}

/** Exported for tests only — see frontend/test/duplicateRoadRemover.test.js (N-1). */
export const __test__ = { rule5_duplicateRoadRemover, rule7_missingLinkSynthesiser };
