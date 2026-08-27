/**
 * roadWidths.js — the ONE place the frontend asks how wide a road is (R-W1).
 *
 * ═══ WHAT THIS REPLACES ═════════════════════════════════════════════════════════════════════════
 *
 * Nine call sites each answered this question for themselves, from the same ambiguous `road.width`:
 *
 *   roadRenderer.WIDTH_BY_TYPE ·  roadInfraRenderer.getRoadWidth ·  streetlightRenderer.getRoadWidth
 *   roadOccupancyGrid  ("mirror of roadRenderer")  ·  vegetationMask  ("mirror of roadRenderer")
 *   vegetationRenderer.ROAD_WIDTH_BY_TYPE  ("matching roadRenderer exactly")
 *   parkedCars.HALFW_BY_TYPE  ·  pedestrians.HALFW_BY_TYPE   (half-width scale, different numbers)
 *   tunnelZones  ((road.width || 6) / 2)
 *
 * Three claimed in a comment to mirror a fourth; none did. And they disagreed about what the number
 * MEANT — the guard rail treated it as the carriageway edge and sat at `halfW`, parked cars treated
 * it as kerb-to-kerb and sat at `halfW - 0.2`. Twenty centimetres apart, so the cars landed on the
 * barrier. That is the user-reported bug, and it was a semantics bug, not an arithmetic one.
 *
 * ═══ THE CONTRACT ═══════════════════════════════════════════════════════════════════════════════
 *
 * The widths are DERIVED IN THE BAKE (`backend/worldBuilder/roads/roadWidthModel.js`) and shipped in
 * the v10 tile as named fields. This module does not compute them — computing them here is how the
 * mirroring started. It reads them, and supplies a fallback for pre-v10 tiles.
 *
 *      |<------------------------- corridorW ------------------------->|
 *      |         |<------------- kerbToKerbW ------------->|           |
 *      |         |      |<----- carriagewayW ----->|       |           |
 *      | sidewalk | park |  lane  |  lane  |  lane | park  | sidewalk  |
 *      ^          ^      ^                         ^       ^
 *   building    KERB   edge of                   edge    KERB
 *    line      LINE    running lanes         of lanes    LINE
 *
 * WHICH ONE DO I WANT?
 *   · Drawing the asphalt ribbon, or asking "am I on the road"  → `pavedWidth()`  (kerb to kerb).
 *     A parking bay is asphalt. Drawing `carriagewayW` leaves a strip of bare terrain where every
 *     street's parking lane should be.
 *   · Laying out lane markings, or deciding where traffic drives → `carriagewayWidth()`.
 *   · Placing a kerb, a guard rail, a sidewalk inner edge, a streetlight → `kerbOffset()`.
 *     ⚠ Everything at the kerb line MUST use this one function, or they drift apart again.
 *   · Parking a car                                              → `parkingBayOffset()`.
 *   · Clearing vegetation, rasterising the occupancy grid        → `corridorWidth()`.
 */

/**
 * Fallback section for a pre-v10 tile, or a road the bake never classified.
 *
 * These are the model's own outputs for an untagged two-way way of each class, hard-coded so a v9
 * tile still renders something coherent. They are NOT a second width model to be tuned: if these
 * and roadWidthModel.js disagree, the model wins and this table is stale.
 * `test/roadWidths.test.js` asserts they still match.
 */
const FALLBACK = {
  motorway:       { carriageway: 10.5, park: 0,   shoulder: 2.5, sidewalk: 0 },
  motorway_link:  { carriageway: 3.5,  park: 0,   shoulder: 1.0, sidewalk: 0 },
  trunk:          { carriageway: 10.5, park: 0,   shoulder: 2.5, sidewalk: 0 },
  trunk_link:     { carriageway: 3.5,  park: 0,   shoulder: 1.0, sidewalk: 0 },
  primary:        { carriageway: 13.0, park: 2.2, shoulder: 0,   sidewalk: 4.0 },
  primary_link:   { carriageway: 3.5,  park: 0,   shoulder: 0,   sidewalk: 1.5 },
  secondary:      { carriageway: 13.0, park: 2.2, shoulder: 0,   sidewalk: 3.5 },
  secondary_link: { carriageway: 3.5,  park: 0,   shoulder: 0,   sidewalk: 1.5 },
  tertiary:       { carriageway: 6.0,  park: 2.2, shoulder: 0,   sidewalk: 3.0 },
  tertiary_link:  { carriageway: 3.5,  park: 0,   shoulder: 0,   sidewalk: 1.5 },
  residential:    { carriageway: 6.0,  park: 2.2, shoulder: 0,   sidewalk: 3.0 },
  unclassified:   { carriageway: 6.0,  park: 2.2, shoulder: 0,   sidewalk: 2.5 },
  living_street:  { carriageway: 4.0,  park: 0,   shoulder: 0,   sidewalk: 0 },
  service:        { carriageway: 3.5,  park: 0,   shoulder: 0,   sidewalk: 0.8 },
  footway:        { carriageway: 2.0,  park: 0,   shoulder: 0,   sidewalk: 0 },
  path:           { carriageway: 1.5,  park: 0,   shoulder: 0,   sidewalk: 0 },
  steps:          { carriageway: 1.5,  park: 0,   shoulder: 0,   sidewalk: 0 },
  cycleway:       { carriageway: 2.0,  park: 0,   shoulder: 0,   sidewalk: 0 },
  pedestrian:     { carriageway: 6.0,  park: 0,   shoulder: 0,   sidewalk: 0 },
  track:          { carriageway: 3.0,  park: 0,   shoulder: 0,   sidewalk: 0 },
};

/**
 * Which classes are typically ONE-WAY, measured over the Barcelona bbox: motorway 100%, trunk 96%,
 * every `_link` 94-100%. The fallback above is the model's output for the TYPICAL way of each
 * class, so these have to be fed to it as one-way or the comparison is against a road that does not
 * exist (an untagged two-way motorway derives 6 lanes and 21 m). `test/roadWidths.test.js` uses
 * this same set — it is exported so the test cannot quietly assume a different one.
 */
export const TYPICALLY_ONEWAY = new Set([
  'motorway', 'trunk', 'motorway_link', 'trunk_link',
  'primary_link', 'secondary_link', 'tertiary_link',
]);

const DEFAULT_FALLBACK = { carriageway: 6.0, park: 0, shoulder: 0, sidewalk: 1.5 };

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * The full width section for a road, in metres. Baked fields when present, fallback otherwise.
 *
 * @param {object} road a tile road record
 * @returns {{carriagewayW:number, parkingLeftW:number, parkingRightW:number, shoulderW:number,
 *            kerbToKerbW:number, sidewalkW:number, corridorW:number, baked:boolean}}
 */
export function roadSection(road) {
  const carriagewayW = num(road?.carriagewayW);
  if (carriagewayW != null) {
    const parkingLeftW = num(road.parkingLeftW) ?? 0;
    const parkingRightW = num(road.parkingRightW) ?? 0;
    const shoulderW = num(road.shoulderW) ?? 0;
    const kerbToKerbW = num(road.kerbToKerbW)
      ?? (carriagewayW + parkingLeftW + parkingRightW + shoulderW * 2);
    const sidewalkW = num(road.sidewalkW) ?? 0;
    return {
      carriagewayW, parkingLeftW, parkingRightW, shoulderW, kerbToKerbW, sidewalkW,
      corridorW: num(road.corridorW) ?? (kerbToKerbW + sidewalkW * 2),
      baked: true,
    };
  }
  const f = FALLBACK[road?.highwayType] ?? DEFAULT_FALLBACK;
  const kerbToKerbW = f.carriageway + f.park * 2 + f.shoulder * 2;
  return {
    carriagewayW: f.carriageway,
    parkingLeftW: f.park, parkingRightW: f.park,
    shoulderW: f.shoulder,
    kerbToKerbW,
    sidewalkW: f.sidewalk,
    corridorW: kerbToKerbW + f.sidewalk * 2,
    baked: false,
  };
}

/** The PAVED surface, kerb to kerb. What the asphalt ribbon is drawn at. */
export function pavedWidth(road) { return roadSection(road).kerbToKerbW; }

/** The RUNNING LANES only. What lane markings divide. Narrower than the asphalt. */
export function carriagewayWidth(road) { return roadSection(road).carriagewayW; }

/**
 * Centreline → KERB. The single offset that kerbs, guard rails, sidewalk inner edges, streetlights
 * and parking bays must all agree on. Never re-derive this by halving something.
 */
export function kerbOffset(road) { return roadSection(road).kerbToKerbW / 2; }

/** Centre of the parking bay on one side, from the centreline. 0 when the road has no bay. */
export function parkingBayOffset(road, side) {
  const s = roadSection(road);
  const bay = side === 'left' ? s.parkingLeftW : s.parkingRightW;
  if (!bay) return 0;
  return s.carriagewayW / 2 + s.shoulderW + bay / 2;
}

/** Width of the parking bay on one side (0 = no parking that side). */
export function parkingBayWidth(road, side) {
  const s = roadSection(road);
  return side === 'left' ? s.parkingLeftW : s.parkingRightW;
}

/** Sidewalk width per side, outside the kerb. */
export function sidewalkWidth(road) { return roadSection(road).sidewalkW; }

/** Building line to building line — what vegetation and the occupancy grid must clear. */
export function corridorWidth(road) { return roadSection(road).corridorW; }

export const ROAD_WIDTH_FALLBACK = FALLBACK;
