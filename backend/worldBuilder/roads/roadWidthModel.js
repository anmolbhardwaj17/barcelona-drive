/**
 * roadWidthModel.js — THE road width model (R-W1).
 *
 * ═══ WHY THIS FILE EXISTS ═══════════════════════════════════════════════════════════════════════
 *
 * Before it, "how wide is this road" was answered in NINE places that disagreed:
 *
 *   buildRegion.WIDTH_BY_TYPE ·  roadBaker.WIDTH_BY_TYPE ·  roadRenderer.WIDTH_BY_TYPE
 *   roadOccupancyGrid ("mirror of roadRenderer") ·  vegetationMask ("mirror of roadRenderer")
 *   vegetationRenderer.ROAD_WIDTH_BY_TYPE ("matching roadRenderer exactly")
 *   parkedCars.HALFW_BY_TYPE ·  pedestrians.HALFW_BY_TYPE  (half-width scale, different numbers)
 *   sidewalkBaker's own `max(4, min(30, road.width || 6))`
 *
 * Three of them claim in a comment to mirror a fourth. None did. Worse, they disagreed about what
 * the number MEANS: `guardRailWidth()` treated `width` as the carriageway edge and put a rail at
 * `halfW`, while `parkedCars` treated it as kerb-to-kerb and parked at `halfW - 0.2`. Twenty
 * centimetres apart — which is the user-reported bug "cars parked ON the guard rails".
 *
 * ═══ WHAT WAS ACTUALLY MEASURED (2026-08-27, before writing a line of this) ══════════════════════
 *
 *  1. `getWidth()` read `tags.width` FIRST — but `pbfHighways.js` KEEP_TAGS never included `width`,
 *     so the tag was stripped before the bake could see it. **That branch had never once fired.**
 *     (4.41% of drivable ways in the Catalonia PBF do carry it, median 5.5 m.)
 *  2. Its `WIDTH_BY_TYPE` fallback was unreachable too: it fires only when `lanes` is null, and
 *     `getLanes()` always returns at least 1.
 *  3. So every width in the city was `clamp(lanes x 3.5, 4, 20)` — and read off the shipped tiles,
 *     that put **73% of residential streets, 99% of living_street, 97% of service and 100% of
 *     footway/pedestrian/steps at exactly 4 m**, the MIN_WIDTH clamp. Against an Eixample archetype
 *     of a 10 m roadway in a 20 m corridor. The road did not "seem short" — it was a third as wide.
 *
 * ═══ THE MODEL ══════════════════════════════════════════════════════════════════════════════════
 *
 * Widths are DERIVED from lane count and road class per Norma 8.2-IC, with the OSM `width` tag as a
 * bound rather than the source — the inversion R-W1 asks for. Every consumer is then handed a NAMED
 * field for the thing it actually needs, so nothing re-derives and nothing can disagree:
 *
 *      |<------------------------- corridorW ------------------------->|
 *      |         |<------------- kerbToKerbW ------------->|           |
 *      |         |      |<----- carriagewayW ----->|       |           |
 *      | sidewalk | park |  lane  |  lane  |  lane | park  | sidewalk  |
 *      ^          ^      ^                         ^       ^
 *   building    KERB   edge of                   edge    KERB
 *    line      LINE    asphalt                 of asphalt LINE
 *
 *   carriagewayW  the RUNNING LANES. What lane markings divide, what traffic drives in.
 *                 ⚠ NOT what roadRenderer draws — a parking bay is asphalt too, so the drawn
 *                 ribbon is kerbToKerbW. Draw carriagewayW and every street gets a strip of
 *                 terrain where its parking lane should be.
 *   parkingLeftW  / parkingRightW  parking strip per side, 0 where parking is impossible.
 *   kerbToKerbW   carriageway + both parking strips + shoulders. THE KERB LINE. Guard rails,
 *                 kerbs and sidewalk inner edges all hang off this one number.
 *   sidewalkW     per side, outside the kerb.
 *   corridorW     kerb-to-kerb + both sidewalks. What the vegetation mask and occupancy grid clear.
 *
 * ═══ A NOTE ON DUAL CARRIAGEWAYS — DO NOT "FIX" THIS ════════════════════════════════════════════
 *
 * OSM splits a dual carriageway into one way PER DIRECTION (measured: motorway ways are 100% oneway,
 * trunk 96%). So a motorway way with `lanes=3` is three lanes in ONE direction, and this model must
 * NOT add a median or double the lane count — the other carriageway is a separate way that gets its
 * own widths. This is also why motorways are the ONE class the old code got right: 3 x 3.5 + shoulders
 * lands at ~14 m, which is exactly what was already baked. Adding a median here would double the
 * motorway network's footprint overnight.
 *
 * `oneway` on a RESIDENTIAL street means something completely different — a one-way city street,
 * still with parking on both sides. Same tag, unrelated geometry. See defaultLanes().
 */

// ── Lane width, Norma 8.2-IC §2 + the Barcelona archetypes in barcelona-road-system.md §2 ────────
// Urban lanes are narrower than interurban ones. 3.0 m for the Eixample grid is what makes the
// archetype arithmetic come out: 2 lanes x 3.0 + 2 parking x 2.2 = 10.4 m, against a documented
// "10 m roadway". 3.5 m is the interurban/motorway figure.
const LANE_W = {
  motorway: 3.5, motorway_link: 3.5,
  trunk: 3.5, trunk_link: 3.5,
  primary: 3.25, primary_link: 3.25,
  secondary: 3.25, secondary_link: 3.25,
  tertiary: 3.0, tertiary_link: 3.0,
  residential: 3.0,
  unclassified: 3.0,
  living_street: 3.0,
  service: 2.75,
  busway: 3.5,
  road: 3.0,
};
const DEFAULT_LANE_W = 3.0;

// ── Minimum carriageway per class ───────────────────────────────────────────────────────────────
// OSM's convention is that an untagged two-way road has 2 lanes and an untagged one-way road has 1.
// Taken literally that gives a 3.0 m one-way Eixample street, which is narrower than any real one:
// those streets are one-way but 2-3 lanes wide. A per-class floor on the CARRIAGEWAY (not on the
// total, which is what the old MIN_WIDTH=4 clamp did) fixes that without inventing lane counts.
const MIN_CARRIAGEWAY = {
  motorway: 7.0, motorway_link: 3.5,
  trunk: 7.0, trunk_link: 3.5,
  primary: 6.5, primary_link: 3.5,
  secondary: 6.5, secondary_link: 3.5,
  tertiary: 6.0, tertiary_link: 3.5,
  residential: 6.0,
  unclassified: 6.0,
  living_street: 4.0,   // shared surface, no kerb — deliberately narrow
  service: 3.5,
};
const DEFAULT_MIN_CARRIAGEWAY = 3.0;

// ── Default lane count where OSM does not say ───────────────────────────────────────────────────
// 49% of drivable ways carry `lanes=*`. For the rest, OSM's own convention: 1 if oneway, else 2.
const DEFAULT_LANES_ONEWAY = {
  motorway: 3, trunk: 3, primary: 2, secondary: 2, tertiary: 1,
  motorway_link: 1, trunk_link: 1, primary_link: 1, secondary_link: 1, tertiary_link: 1,
  residential: 1, unclassified: 1, living_street: 1, service: 1,
};
// ...except for classes where "two-way" does not mean "two marked lanes". An alley and a Gracia
// shared-surface street are one lane that traffic takes turns on; the OSM doubling rule gave them
// 5.5 m and 6.0 m in a dry run, wider than the streets they represent. Their floor does the work.
const NEVER_DOUBLE = new Set(['service', 'living_street']);

// ── Parking (Barcelona: the defining feature of every Eixample kerb) ────────────────────────────
// 2.2 m is a regulated bay (`àrea verda`/`àrea blava`); the doc's archetype says "~2 m each".
const PARKING_W = 2.2;
// Classes that get kerbside parking when nothing forbids it. Motorways, trunks and every _link are
// excluded outright — as are bridges, ramps and elevated decks, which is the R-V1 physical gate.
const PARKING_CLASSES = new Set(['residential', 'unclassified', 'tertiary', 'secondary', 'primary']);

// ── Shoulders (arcén), Norma 8.2-IC. Urban streets have none — the kerb does that job. ──────────
const SHOULDER_W = {
  motorway: 2.5, trunk: 2.5,
  motorway_link: 1.0, trunk_link: 1.0,
};

// ── Sidewalk (vorera) per side ──────────────────────────────────────────────────────────────────
// The old table topped out at 2.5 m and gave residential 1.2 m. Real Eixample sidewalks are ~5 m —
// they are a third of the corridor and the single most Barcelona thing about the street section.
const SIDEWALK_W = {
  motorway: 0, motorway_link: 0,
  trunk: 0, trunk_link: 0,
  primary: 4.0, primary_link: 1.5,
  secondary: 3.5, secondary_link: 1.5,
  tertiary: 3.0, tertiary_link: 1.5,
  residential: 3.0,
  unclassified: 2.5,
  living_street: 0,   // shared surface: no kerb, no separate sidewalk
  service: 0.8,
};
const DEFAULT_SIDEWALK_W = 1.5;

// ── Non-drivable ways get an explicit width, NOT the drivable floor ─────────────────────────────
// The old MIN_WIDTH=4 was applied to everything, so every footway, pedestrian street and flight of
// steps in the city was baked as a 4 m ribbon. Measured: 100% of them.
const PATH_W = {
  footway: 2.0,
  path: 1.5,
  steps: 1.5,
  cycleway: 2.0,      // Barcelona carril bici
  pedestrian: 6.0,    // a pedestrianised STREET, genuinely wide
  track: 3.0,
  corridor: 2.0,
  platform: 3.0,
  bridleway: 2.0,
};

/** Absolute sanity bounds. Nothing in a city is outside these. */
const ABS_MIN_CARRIAGEWAY = 2.0;
const ABS_MAX_CARRIAGEWAY = 30.0;
const ABS_MAX_KERB_TO_KERB = 40.0;

const num = (v) => {
  if (v == null || v === '') return null;
  const m = String(v).match(/^[\d.]+/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const int = (v) => {
  if (v == null || v === '') return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Lane count for a way: OSM `lanes` when present, else the class default for its direction. */
export function resolveLanes(tags, highwayType, oneway) {
  const tagged = int(tags?.lanes);
  if (tagged) return Math.min(12, tagged);
  // `lanes:forward`/`lanes:backward` on a two-way road describe one direction each.
  const fwd = int(tags?.['lanes:forward']);
  const bwd = int(tags?.['lanes:backward']);
  if (fwd || bwd) return Math.min(12, (fwd || 0) + (bwd || 0)) || 1;
  if (oneway || NEVER_DOUBLE.has(highwayType)) return DEFAULT_LANES_ONEWAY[highwayType] ?? 1;
  return (DEFAULT_LANES_ONEWAY[highwayType] ?? 1) * 2;
}

/**
 * Does this way get kerbside parking, and on which sides?
 *
 * OSM's `parking:*` schema is authoritative where it exists (8% of residential) — `no`/`separate`
 * means no bay. Otherwise it follows road class, minus the physical cases: you do not park on a
 * bridge deck, a ramp, an elevated carriageway or inside a tunnel. Those are the same booleans the
 * guard-rail gate leads with, deliberately, so the two systems can never disagree about a road they
 * both act on (R-V1).
 */
function resolveParking(tags, highwayType, ctx) {
  if (!PARKING_CLASSES.has(highwayType)) return { left: 0, right: 0 };
  if (ctx.bridge || ctx.isRamp || ctx.tunnel || (ctx.layer != null && ctx.layer > 0)) {
    return { left: 0, right: 0 };
  }
  const denies = (v) => v != null && /^(no|separate|none)$/i.test(String(v).trim());
  const both = tags?.['parking:both'] ?? tags?.['parking:lane:both'];
  const left = tags?.['parking:left'] ?? tags?.['parking:lane:left'] ?? both;
  const right = tags?.['parking:right'] ?? tags?.['parking:lane:right'] ?? both;
  return {
    left: denies(left) ? 0 : PARKING_W,
    right: denies(right) ? 0 : PARKING_W,
  };
}

/**
 * The complete width section for one way, in metres.
 *
 * @param {object} road  { tags, highwayType, oneway, bridge, tunnel, isRamp, layer, serviceSubtype }
 * @returns {{lanes:number, laneW:number, carriagewayW:number, parkingLeftW:number,
 *            parkingRightW:number, shoulderW:number, kerbToKerbW:number, sidewalkW:number,
 *            corridorW:number, widthSource:string}}
 */
export function computeRoadWidths(road) {
  const tags = road?.tags || {};
  const t = road?.highwayType || '';
  const oneway = road?.oneway === true || road?.oneway === 'yes' || tags.oneway === 'yes';

  // ── Non-drivable ways: one number, no section. ──
  if (PATH_W[t] != null) {
    const osm = num(tags.width);
    const w = clamp(osm ?? PATH_W[t], 0.8, 12);
    return {
      lanes: 1, laneW: w, carriagewayW: w,
      parkingLeftW: 0, parkingRightW: 0, shoulderW: 0,
      kerbToKerbW: w, sidewalkW: 0, corridorW: w,
      widthSource: osm ? 'osm' : 'path-class',
    };
  }

  const lanes = resolveLanes(tags, t, oneway);
  const laneW = LANE_W[t] ?? DEFAULT_LANE_W;
  let carriagewayW = Math.max(lanes * laneW, MIN_CARRIAGEWAY[t] ?? DEFAULT_MIN_CARRIAGEWAY);

  // A service alley or driveway is a lane, not a street.
  if (t === 'service' && road?.serviceSubtype) {
    if (road.serviceSubtype === 'alley') carriagewayW = 3.0;
    else if (road.serviceSubtype === 'driveway') carriagewayW = 3.0;
  }

  const park = resolveParking(tags, t, road || {});
  const shoulderW = SHOULDER_W[t] ?? 0;
  let parkingLeftW = park.left;
  let parkingRightW = park.right;
  let widthSource = int(tags.lanes) ? 'osm-lanes' : 'class-default';

  // ── THE OSM TAG AS A BOUND, NOT A SOURCE (the inversion R-W1 asks for) ──
  //
  // Where OSM states a width it is a real measurement of a real street, and it is the only thing
  // that knows a pre-Cerdà Gràcia lane is 5 m wide between its buildings. So it CAPS the section
  // rather than replacing it: the derived carriageway keeps its lane structure, and the budget is
  // taken out of the parking strips first — which is exactly what happens on a real narrow street.
  const osmW = num(tags.width);
  if (osmW) {
    const capped = clamp(osmW, ABS_MIN_CARRIAGEWAY, ABS_MAX_KERB_TO_KERB);
    let total = carriagewayW + parkingLeftW + parkingRightW + shoulderW * 2;
    if (capped < total) {
      widthSource = 'osm-width-capped';
      let over = total - capped;
      const takeFrom = (v) => { const d = Math.min(v, over); over -= d; return v - d; };
      parkingRightW = takeFrom(parkingRightW);
      parkingLeftW = takeFrom(parkingLeftW);
      if (over > 0) carriagewayW = Math.max(ABS_MIN_CARRIAGEWAY, carriagewayW - over);
    }
  }

  carriagewayW = clamp(carriagewayW, ABS_MIN_CARRIAGEWAY, ABS_MAX_CARRIAGEWAY);
  const kerbToKerbW = Math.min(
    ABS_MAX_KERB_TO_KERB,
    carriagewayW + parkingLeftW + parkingRightW + shoulderW * 2,
  );
  const sidewalkW = SIDEWALK_W[t] ?? DEFAULT_SIDEWALK_W;

  return {
    lanes, laneW,
    carriagewayW: round2(carriagewayW),
    parkingLeftW: round2(parkingLeftW),
    parkingRightW: round2(parkingRightW),
    shoulderW: round2(shoulderW),
    kerbToKerbW: round2(kerbToKerbW),
    sidewalkW: round2(sidewalkW),
    corridorW: round2(kerbToKerbW + sidewalkW * 2),
    widthSource,
  };
}

function round2(v) { return Math.round(v * 100) / 100; }

/**
 * Distance from the centreline to the KERB — the one offset that guard rails, kerbs, parking bays
 * and sidewalk inner edges must all agree on. Every consumer calls this instead of halving a number
 * whose meaning it guessed.
 */
export function kerbOffset(w) { return w.kerbToKerbW / 2; }

/** Centre of the parking bay on the given side, from the centreline. 0 when there is no bay. */
export function parkingBayOffset(w, side) {
  const bay = side === 'left' ? w.parkingLeftW : w.parkingRightW;
  if (!bay) return 0;
  return w.carriagewayW / 2 + w.shoulderW + bay / 2;
}

export const WIDTH_MODEL_CONSTANTS = {
  LANE_W, MIN_CARRIAGEWAY, DEFAULT_LANES_ONEWAY, NEVER_DOUBLE, PARKING_W, PARKING_CLASSES,
  SHOULDER_W, SIDEWALK_W, PATH_W, DEFAULT_LANE_W, DEFAULT_MIN_CARRIAGEWAY,
  DEFAULT_SIDEWALK_W, ABS_MIN_CARRIAGEWAY, ABS_MAX_CARRIAGEWAY, ABS_MAX_KERB_TO_KERB,
};
