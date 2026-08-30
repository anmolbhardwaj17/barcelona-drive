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
const LINK_COS = 0.90;
/**
 * Metres between interpolated nodes on a synthesised link — see the densify note at the emit site.
 *
 * 5 m, and both halves of that number are load-bearing. The FIRST attempt used 15 m with
 * `floor(gap / spacing)` steps, which fixed one of the two failing links and left the other with a
 * byte-identical 0.51 m gap — because it was 27.6 m long, `floor(27.6/15)` is 1, and the loop that
 * adds interior nodes never ran. The rule had a hole exactly the size of the remaining failure.
 * `ceil` with a floor of 2 steps means EVERY link gets at least a midpoint, and 5 m is finer than
 * the terrain grid's own cell, so the carved floor cannot bow away from the ground between nodes.
 */
const LINK_NODE_SPACING_M = 5;          // ~25 deg

function rule7_missingLinkSynthesiser(wayMap, nodeToWays, nodeMap) {
  const stats = { pairsConsidered: 0, freeEnds: 0, created: 0, shortUnnamedLinks: 0,
                  rejectedName: 0, rejectedAim: 0, rejectedCrossing: 0, nodesAdded: 0,
                  rejectedHairline: 0, rejectedOnExistingRoad: 0 };

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
      // ── SPLIT, BECAUSE ONE COUNTER CANNOT NAME A CAUSE (D-23, one level down) ────────────────
      // These two gates reject for opposite reasons and want opposite fixes. `hairline` means the
      // ends are already touching and no connector is wanted at all. `onExistingRoad` means a road
      // ALREADY RUNS along the path — the street does continue, it just continues as a different
      // way, so what is missing is a topological JOIN, not a new ribbon. Counted together, those
      // two are indistinguishable, and the recovery plan for the 49 -> 56 dead-end regression
      // depends entirely on which one dominates.
      if (!hasRealSurfaceGap(gap, a.way, b.way)) { stats.rejectedHairline++; continue; }
      if (lineLiesOnExistingRoad(a.lat, a.lon, b.lat, b.lon, ways, nodeMap, a.way.id, b.way.id)) {
        stats.rejectedOnExistingRoad++; continue;
      }
      if (crossesAnyWay(a.lat, a.lon, b.lat, b.lon, a.way.id, b.way.id)) {
        stats.rejectedCrossing++; continue;
      }

      const id = nextSyntheticId();
      // ── DENSIFY. A two-point way is not enough geometry to build a tunnel from. ───────────────
      //
      // `buildTrenchCorridors` carves the trench floor as a straight line between a segment's
      // endpoints, while the road itself is draped on the DEM at every point it has. With only two
      // points 224 m apart on a hillside those two lines are the same line, so the floor tracks
      // nothing and the terrain comes back up through the deck in the middle. That is precisely what
      // the commit-blocking FloorValidator caught: 4 violations, both roads synthetic (-1000011,
      // -1000056), worst gap 0.51 m against a 0.30 m tolerance. Real OSM tunnels never hit it
      // because they carry a node every few metres and their corridors follow the ground.
      //
      // So the link gets a node every LINK_NODE_SPACING_M. Nodes go into the SHARED `nodeMap` — the
      // same in-place mutation rule 6 relies on — which is the half of the fixer that was reaching
      // the output even before N-37.
      const nodeIds = [a.nid];
      const steps = Math.max(2, Math.ceil(gap / LINK_NODE_SPACING_M));
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        const nid = nextSyntheticId();
        nodeMap.set(nid, { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
        nodeIds.push(nid);
        stats.nodesAdded++;
      }
      nodeIds.push(b.nid);
      wayMap.set(id, {
        id,
        nodeIds,
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

  // ── N-40 · NEVER DELETE THE LAST WAY CARRYING A STREET NAME ───────────────────────────────────
  //
  // Measured with a PAIRED bake — same district, same bbox, removals on vs off, so nothing but this
  // rule differs. It deletes 791 ways in Eixample, 617 of them `footway`; ~79 are drivable. That is
  // the rule working. But TWO named streets lost every way they had — `Mestres Casals i Martorell`
  // and `passatge de Francesca Simon` — and a street that disappears from the city is not a
  // deduplicated street, it is a missing one. Those two are the entire downside of the rule, and
  // they are cheap to prevent: keep a live count per name and refuse the removal that would take a
  // name to zero.
  //
  // Unnamed ways are not counted — there is no street to lose, and a duplicate footway with no name
  // is exactly what this rule is for.
  const nameCount = new Map();
  for (const e of wayEntries) {
    const n = String(e.way.tags?.name ?? '').trim();
    if (n) nameCount.set(n, (nameCount.get(n) || 0) + 1);
  }
  let keptLastOfName = 0;   // D-23: a guard that never fires must be visibly a no-op, not invisible

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
        const shorterName = String(shorter.way.tags?.name ?? '').trim();
        if (shorterName && (nameCount.get(shorterName) || 0) <= 1) {
          keptLastOfName++;                 // N-40: this is the last of its name — keep the street
          continue;
        }
        // Remove the shorter road
        if (shorterName) nameCount.set(shorterName, nameCount.get(shorterName) - 1);
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

return { removed, strict: removedStrict, sameName: removedSameName, keptLastOfName };
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


/**
 * N-52 · IS THERE ACTUALLY A GAP IN THE ROAD SURFACE?
 *
 * Measured on the shipped tiles after rules 8 and 9 first ran: **313 of 366 synthetic at-grade
 * connectors (86%) lay more than half inside an existing road ribbon at the same height, several of
 * them 100%.** That is what the user saw as z-fighting and "choppy" roads — a second coplanar
 * ribbon drawn over a carriageway that was already continuous.
 *
 * The cause is measuring the wrong gap. Two carriageways whose CENTRELINES are 8 m apart, each 12 m
 * wide, already touch: the surface is continuous and only the topology is missing. Connecting them
 * adds no drivable ground — the car could already cross — and costs a duplicate ribbon.
 *
 * Exactly the N-1 lesson repeating: centreline distance is not ribbon distance.
 */
/**
 * N-52b · Does the proposed connector LIE ON a road that is already there?
 *
 * `hasRealSurfaceGap` tests the distance to the target NODE, and that is the endpoint, not the path.
 * A connector reaching a node off to one side runs diagonally ACROSS the target's ribbon for most of
 * its length while its endpoint distance looks fine. Measured after the endpoint gate shipped: the
 * count fell 366 → 184 but **134 of the survivors, 73%, still lay inside an existing ribbon.**
 *
 * So sample the line itself — the same test the offline probe uses to find the problem. Testing the
 * thing being drawn rather than a proxy for it is the whole lesson of this session, applied to my
 * own fix.
 */
function lineLiesOnExistingRoad(aLat, aLon, bLat, bLon, ways, nodeMap, skipA, skipB) {
  const SAMPLES = 8;
  let inside = 0, seen = 0;
  for (let k = 0; k <= SAMPLES; k++) {
    const f = k / SAMPLES;
    const lat = aLat + (bLat - aLat) * f, lon = aLon + (bLon - aLon) * f;
    seen++;
    let hit = false;
    for (const w of ways) {
      if (w.id === skipA || w.id === skipB || w.tunnel) continue;
      const half = ((Number.isFinite(w.width) && w.width > 0 ? w.width : 6) / 2);
      const ids = w.nodeIds;
      for (let i = 0; i < ids.length - 1 && !hit; i++) {
        const p = nodeMap.get(ids[i]), q = nodeMap.get(ids[i + 1]);
        if (!p || !q) continue;
        const P = toMeters(lat, lon, p.lat, p.lon), Q = toMeters(lat, lon, q.lat, q.lon);
        const dx = Q.dx - P.dx, dz = Q.dz - P.dz, l2 = dx * dx + dz * dz;
        if (l2 < 1e-9) continue;
        const t = Math.max(0, Math.min(1, (-P.dx * dx + -P.dz * dz) / l2));
        if (Math.hypot(P.dx + t * dx, P.dz + t * dz) < half) hit = true;
      }
      if (hit) break;
    }
    if (hit) inside++;
  }
  return seen > 0 && inside / seen > 0.5;
}

function hasRealSurfaceGap(gapM, wayA, wayB) {
  const wA = Number.isFinite(wayA?.width) && wayA.width > 0 ? wayA.width : 6;
  const wB = Number.isFinite(wayB?.width) && wayB.width > 0 ? wayB.width : 6;
  // Half of each ribbon, plus a metre so a hairline gap does not qualify either.
  return gapM > (wA + wB) / 2 + 1;
}

// ═══════════════════════════════════════════════════════════════════════════
// RULE 8 · A SLIP ROAD THAT DIES BESIDE THE ROAD IT SHOULD JOIN
// ═══════════════════════════════════════════════════════════════════════════
/**
 * User: "2 roads very close to each other but no ramp and just exiting like this thats wrong for
 * sure — they should have a smooth ramp or just a ramp for now, first lets connect the roads".
 *
 * Rule 7 joins two free ends FACING each other. A merge is a different shape and rule 7 is blind to
 * it: a slip road ends ALONGSIDE the carriageway it should join, pointing roughly the SAME way, and
 * its endpoint lands on the other road's FLANK rather than on another dead end.
 *
 * Measured over the shipped tiles before writing a line of this (`backend/tools/missedMergeAudit.mjs`):
 *   10,258 drivable ways · 3,865 free ends
 *   445 of those die beside another road's flank (<= 14 m, |cos| >= 0.7)
 *   389 of the 445 are within 1 m of it VERTICALLY — connectable at grade
 *
 * This rule takes the at-grade 389 only. The other 56 need a real ramp, and a connector that climbs
 * 6 m over 12 m of ground is a wall, not a road.
 *
 * ⚠ It connects to the target's nearest EXISTING NODE rather than splitting the target at the
 * projection point. Splitting is geometrically prettier and mutates a way that other rules, the
 * ramp resolver and the trench flagger have all already reasoned about; joining to a node that is
 * already there cannot invalidate any of that. The connector is a few metres off perpendicular as a
 * result, which at these distances is invisible.
 */
/**
 * Rule 8's own way set — WIDER than rule 7's, and the difference is the point.
 *
 * Rule 7 synthesises TUNNELS between named streets, so `DRIVABLE_FOR_LINK` deliberately excludes
 * `service`: boring a tunnel for a driveway is absurd. Rule 8 draws a short connector at grade,
 * which is exactly what a car-park aisle or a slip lane needs.
 *
 * Sharing rule 7's set cost the first bake most of its yield. The counters said it plainly —
 * `freeEnds: 858` here against **3,865** in the audit, `beside: 64` against **445** — because the
 * audit counted `service` and the rule did not, and the audit's closest merges were almost all
 * service-to-service. Same trap as N-42: a set named for one question reused to answer another.
 */
const MERGEABLE = new Set([...DRIVABLE_FOR_LINK, 'service', 'busway']);

const MERGE_NEAR_M = 12;      // how close the dead end must be to the other road's flank
const MERGE_COS = 0.70;       // |cos| between the stub's heading and that flank — parallel, not crossing
const MERGE_MAX_CONNECT_M = 22;  // longest connector worth drawing to the nearest existing node

function rule8_stubMergeConnector(wayMap, nodeToWays, nodeMap) {
  const stats = { freeEnds: 0, beside: 0, created: 0, nodesAdded: 0,
                  rejectedLayer: 0, rejectedAim: 0, rejectedFar: 0, rejectedCrossing: 0,
                  rejectedHairline: 0, rejectedOnExistingRoad: 0 };

  const ways = [...wayMap.values()].filter((w) =>
    w.nodeIds && w.nodeIds.length >= 2 && MERGEABLE.has(w.highwayType));

  const touch = new Map();
  for (const w of ways) for (const nid of w.nodeIds) touch.set(nid, (touch.get(nid) || 0) + 1);

  for (const w of ways) {
    const n = w.nodeIds.length;
    for (const [nid, innerId] of [[w.nodeIds[0], w.nodeIds[1]], [w.nodeIds[n - 1], w.nodeIds[n - 2]]]) {
      if ((touch.get(nid) || 0) > 1) continue;
      const e = nodeMap.get(nid), inner = nodeMap.get(innerId);
      if (!e || !inner) continue;
      stats.freeEnds++;
      const out = toMeters(inner.lat, inner.lon, e.lat, e.lon);   // stub heading, pointing outward
      const ol = Math.hypot(out.dx, out.dz) || 1;
      const sx = out.dx / ol, sz = out.dz / ol;

      let best = null;
      for (const o of ways) {
        if (o.id === w.id) continue;
        // AT GRADE ONLY, and the fixer has no DEM — so layer/bridge/tunnel is the whole height
        // model available here, and it is exactly what separates the 389 from the 56.
        if (!!o.tunnel !== !!w.tunnel || !!o.bridge !== !!w.bridge) { continue; }
        if ((o.layer ?? 0) !== (w.layer ?? 0)) continue;
        const ids = o.nodeIds;
        for (let i = 0; i < ids.length - 1; i++) {
          const a = nodeMap.get(ids[i]), b = nodeMap.get(ids[i + 1]);
          if (!a || !b) continue;
          const A = toMeters(e.lat, e.lon, a.lat, a.lon), B = toMeters(e.lat, e.lon, b.lat, b.lon);
          const dx = B.dx - A.dx, dz = B.dz - A.dz;
          const l2 = dx * dx + dz * dz;
          if (l2 < 1e-6) continue;
          const t = Math.max(0, Math.min(1, (-A.dx * dx + -A.dz * dz) / l2));
          if (t <= 0.01 || t >= 0.99) continue;      // near the target's own END is rule 7's job
          const d = Math.hypot(A.dx + t * dx, A.dz + t * dz);
          if (d > MERGE_NEAR_M) continue;
          const cos = Math.abs((sx * dx + sz * dz) / Math.sqrt(l2));
          if (cos < MERGE_COS) { stats.rejectedAim++; continue; }
          // join to whichever END of this segment is nearer — an EXISTING node, never a new split
          const dA = Math.hypot(A.dx, A.dz), dB = Math.hypot(B.dx, B.dz);
          const targetNid = dA <= dB ? ids[i] : ids[i + 1];
          const targetD = Math.min(dA, dB);
          if (!best || targetD < best.targetD) best = { o, targetNid, targetD, d };
        }
      }
      if (!best) continue;
      stats.beside++;
      if (best.targetD > MERGE_MAX_CONNECT_M) { stats.rejectedFar++; continue; }
      if (best.targetNid === nid) continue;
      // N-52: if the two ribbons already overlap there is no gap to fill, only a duplicate to draw.
      if (!hasRealSurfaceGap(best.targetD, w, best.o)) { stats.rejectedHairline++; continue; }
      if (lineLiesOnExistingRoad(e.lat, e.lon, nodeMap.get(best.targetNid).lat,
          nodeMap.get(best.targetNid).lon, ways, nodeMap, w.id, best.o.id)) {
        stats.rejectedOnExistingRoad++; continue;
      }

      const t = nodeMap.get(best.targetNid);
      if (!t) continue;
      const id = nextSyntheticId();
      // Densified for the same reason rule 7's links are — a two-point way gives the terrain
      // machinery a straight line to work from where the ground is not straight.
      const g = toMeters(e.lat, e.lon, t.lat, t.lon);
      const gap = Math.hypot(g.dx, g.dz);
      const nodeIds = [nid];
      const steps = Math.max(2, Math.ceil(gap / LINK_NODE_SPACING_M));
      for (let k = 1; k < steps; k++) {
        const f = k / steps;
        const mid = nextSyntheticId();
        nodeMap.set(mid, { lat: e.lat + (t.lat - e.lat) * f, lon: e.lon + (t.lon - e.lon) * f });
        nodeIds.push(mid);
        stats.nodesAdded++;
      }
      nodeIds.push(best.targetNid);

      wayMap.set(id, {
        id,
        nodeIds,
        // The connector inherits the STUB's class, not the target's: a service road joining a trunk
        // is still a service road, and promoting it would put a trunk-width ribbon on a driveway.
        tags: { ...(w.tags || {}), _synthetic: 'stub_merge' },
        bridge: !!w.bridge,
        tunnel: !!w.tunnel,
        layer: w.layer ?? 0,
        highwayType: w.highwayType,
        closedLoop: false,
        points: null,
      });
      for (const id2 of nodeIds) {
        if (!nodeToWays.has(id2)) nodeToWays.set(id2, new Set());
        nodeToWays.get(id2).add(id);
      }
      touch.set(nid, (touch.get(nid) || 0) + 1);
      stats.created++;
    }
  }
  return stats;
}


// ═══════════════════════════════════════════════════════════════════════════
// RULE 9 · A NAMED STREET THAT RESUMES ACROSS A GAP
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Rule 7 joins two free ends FACING each other. Rule 8 joins a stub dying BESIDE a flank. Neither
 * catches the case the dead-end triage put at the top of the city:
 *
 *   score gap same width  len   class      name
 *      14   38  YES   12    279  trunk      Gran Via de les Corts Catalanes
 *      13   43  YES 15.5    125  motorway   Autovia de Castelldefels
 *      13   64  YES   12    200  primary    Avinguda Meridiana
 *      12   76  YES 10.9    318  secondary  Rambla de Prim
 *
 * A 15.5 m motorway that stops dead, with a way of THE SAME NAME resuming 43 m further on, is not a
 * cul-de-sac. Rule 7 cannot see it because it demands both ends be free and mutually aimed; here the
 * street resumes part-way along another way, so the far end is not an end at all.
 *
 * The name IS the evidence. Two ways carrying the same street name, one ending and one resuming
 * within 90 m along the same heading, are one street with its middle missing. That is a much
 * stronger signal than geometry alone, which is why this rule may reach 90 m where rule 8 stops at
 * 12: rule 8 has only proximity to go on.
 *
 * Measured population before writing it (`backend/tools/deadEndTriage.mjs`): of 1,176 unjoined
 * drivable ends, 69 score >= 8 and 29 score >= 10; 11 of the 29 carry a same-named continuation.
 * The long tail — 542 at score 1 — is ordinary cul-de-sacs and is deliberately left alone.
 */
const RESUME_MIN_M = 5;
const RESUME_MAX_M = 90;
const RESUME_COS = 0.60;   // the stub must actually point at it, not merely be near it

function rule9_namedStreetResumes(wayMap, nodeToWays, nodeMap) {
  const stats = { freeEnds: 0, named: 0, candidates: 0, created: 0, nodesAdded: 0,
                  rejectedAim: 0, rejectedCrossing: 0, rejectedClass: 0, rejectedHairline: 0, rejectedOnExistingRoad: 0 };

  const ways = [...wayMap.values()].filter((w) =>
    w.nodeIds && w.nodeIds.length >= 2 && MERGEABLE.has(w.highwayType));

  // name -> ways carrying it. A street with no name gives no evidence and is skipped entirely.
  const byName = new Map();
  for (const w of ways) {
    const n = String(w.tags?.name ?? '').trim();
    if (!n) continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(w);
  }

  const touch = new Map();
  for (const w of ways) for (const nid of w.nodeIds) touch.set(nid, (touch.get(nid) || 0) + 1);

  const crossesAnyWay = (aLat, aLon, bLat, bLon, skipA, skipB) => {
    const o = toMeters(aLat, aLon, bLat, bLon);
    for (const w of ways) {
      if (w.id === skipA || w.id === skipB) continue;
      if (w.tunnel || (w.layer ?? 0) !== 0) continue;
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

  for (const w of ways) {
    const name = String(w.tags?.name ?? '').trim();
    const n = w.nodeIds.length;
    for (const [nid, innerId] of [[w.nodeIds[0], w.nodeIds[1]], [w.nodeIds[n - 1], w.nodeIds[n - 2]]]) {
      if ((touch.get(nid) || 0) > 1) continue;
      stats.freeEnds++;
      if (!name) continue;
      stats.named++;
      const e = nodeMap.get(nid), inner = nodeMap.get(innerId);
      if (!e || !inner) continue;
      const out = toMeters(inner.lat, inner.lon, e.lat, e.lon);
      const ol = Math.hypot(out.dx, out.dz) || 1;
      const sx = out.dx / ol, sz = out.dz / ol;

      let best = null;
      for (const o of byName.get(name) || []) {
        if (o.id === w.id) continue;
        // The missing middle of a street is the same KIND of road at both ends. A footway sharing a
        // plaza's name must not be welded to its carriageway.
        if (o.highwayType !== w.highwayType) { stats.rejectedClass++; continue; }
        for (const oid of o.nodeIds) {
          const q = nodeMap.get(oid);
          if (!q) continue;
          const d = toMeters(e.lat, e.lon, q.lat, q.lon);
          const dist = Math.hypot(d.dx, d.dz);
          if (dist < RESUME_MIN_M || dist > RESUME_MAX_M) continue;
          if ((d.dx * sx + d.dz * sz) / dist < RESUME_COS) continue;
          if (!best || dist < best.dist) best = { dist, oid, o, q };
        }
      }
      if (!best) continue;
      stats.candidates++;
      if (!hasRealSurfaceGap(best.dist, w, best.o)) { stats.rejectedHairline++; continue; }
      if (lineLiesOnExistingRoad(e.lat, e.lon, best.q.lat, best.q.lon, ways, nodeMap, w.id, best.o.id)) {
        stats.rejectedOnExistingRoad++; continue;
      }
      if (crossesAnyWay(e.lat, e.lon, best.q.lat, best.q.lon, w.id, best.o.id)) {
        stats.rejectedCrossing++; continue;
      }

      const id = nextSyntheticId();
      const nodeIds = [nid];
      const steps = Math.max(2, Math.ceil(best.dist / LINK_NODE_SPACING_M));
      for (let k = 1; k < steps; k++) {
        const f = k / steps;
        const mid = nextSyntheticId();
        nodeMap.set(mid, { lat: e.lat + (best.q.lat - e.lat) * f,
                           lon: e.lon + (best.q.lon - e.lon) * f });
        nodeIds.push(mid);
        stats.nodesAdded++;
      }
      nodeIds.push(best.oid);

      // Same convention as rule 7: a long gap is a road passing under something, a short one is a
      // join that was never made. Keeps portals, lining and colliders coming from one pipeline.
      const deep = best.dist > SHORT_LINK_M;
      wayMap.set(id, {
        id,
        nodeIds,
        tags: { ...(w.tags || {}), ...(deep ? { tunnel: 'yes', layer: '-1' } : {}),
                _synthetic: 'named_resume' },
        bridge: false,
        tunnel: deep,
        layer: deep ? -1 : 0,
        highwayType: w.highwayType,
        closedLoop: false,
        points: null,
      });
      for (const id2 of nodeIds) {
        if (!nodeToWays.has(id2)) nodeToWays.set(id2, new Set());
        nodeToWays.get(id2).add(id);
      }
      touch.set(nid, (touch.get(nid) || 0) + 1);
      stats.created++;
    }
  }
  return stats;
}

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
  // N-44: runs after rule 7, so an end that rule 7 has already joined is no longer free and this
  // rule will not also weld it sideways into a neighbour.
  const rule8 = rule8_stubMergeConnector(wayMap, nodeToWays, nm);
  // N-49: last, so an end already joined by 7 or 8 is no longer free and cannot be joined twice.
  const rule9 = rule9_namedStreetResumes(wayMap, nodeToWays, nm);

  return { rule4, rule5, rule1, rule6, rule7, rule8, rule9 };
}

/** Exported for tests only — see frontend/test/duplicateRoadRemover.test.js (N-1). */
export const __test__ = { rule5_duplicateRoadRemover, rule7_missingLinkSynthesiser,
                          rule8_stubMergeConnector, rule9_namedStreetResumes };
