/**
 * JUNCTION CONTINUITY — do two ways that SHARE A NODE actually meet there?
 *
 * ── WHY THIS DID NOT EXIST, AND SHOULD HAVE ───────────────────────────────────────────────────
 * The bake has three validators: tunnel floors (`validateTunnelFloors`), surface roads against the
 * terrain they rest on (R-P1), and roads floating over the trench carve (`flagFloatersOverCarve`).
 * Every one of them compares a road to the GROUND. Not one asks whether a road meets the ROAD IT IS
 * CONNECTED TO.
 *
 * So the single most obvious defect in the city was invisible to the pipeline. User, looking at it:
 * "if you see them from top they look merged but actually there is height difference — why is our
 * common sense engine not able to find this?" Measured over the shipped tiles: **743 way ends sit
 * within 4 m of another way in plan and more than 1 m from it in height**, 637 of those because one
 * side is a tunnel, at a plan distance of ZERO — the same point, up to 24 m apart vertically. That
 * is a road ending in mid-air above a buried tunnel, and it is where the missing portals are.
 *
 * A node is a JOIN. Two ways sharing one are the same piece of road. If their heights disagree
 * there, the city has a step in it, and one of the two heights is wrong — no ramp between them can
 * be right, because there is no distance to ramp over.
 *
 * ── REPORT ONLY, DELIBERATELY ─────────────────────────────────────────────────────────────────
 * This does not throw. The cause is the layer model (`layer × LAYER_STEP`, 6 m a layer, so a
 * layer-4 tunnel is placed 24 m down when a real Barcelona road tunnel runs 5-10 m below the
 * street), and that is governed by the LOCKED vertical-model spec. Failing the bake on a defect
 * nobody is allowed to fix yet would only mean disabling the check. It exists to make the number
 * move measurably when the depth model is fixed.
 */

/** Height difference at a shared node that counts as a break in the road, metres. */
const CONTINUITY_TOL_M = 1.0;

/**
 * @param {object[]} roads - post-geometry roads: { id, nodeIds, points:[[x,y,z,absY]], ... }
 * @returns {{ total: number, byReason: object, worst: object[] }}
 */
export function collectJunctionContinuity(roads) {
  // node id -> [{ road, y }] using the height each way assigns AT THAT NODE
  const atNode = new Map();
  for (const r of roads || []) {
    const ids = r.nodeIds;
    if (!ids || !r.points || ids.length !== r.points.length) continue;
    for (let i = 0; i < ids.length; i++) {
      const p = r.points[i];
      const y = (p.length >= 4 && Number.isFinite(p[3])) ? p[3] : p[1];
      if (!Number.isFinite(y)) continue;
      if (!atNode.has(ids[i])) atNode.set(ids[i], []);
      atNode.get(ids[i]).push({ r, y });
    }
  }

  const byReason = {};
  const worst = [];
  let total = 0;
  for (const [nid, list] of atNode) {
    if (list.length < 2) continue;
    let lo = list[0], hi = list[0];
    for (const e of list) { if (e.y < lo.y) lo = e; if (e.y > hi.y) hi = e; }
    const dy = hi.y - lo.y;
    if (dy <= CONTINUITY_TOL_M) continue;
    total++;
    // Name the cause from the TAGS, so the report says what to fix rather than that something is wrong.
    const a = lo.r, b = hi.r;
    const reason = (!!a.tunnel !== !!b.tunnel) ? 'surface meets TUNNEL — a portal belongs here'
      : (!!a.bridge !== !!b.bridge) ? 'surface meets BRIDGE — an abutment belongs here'
      : ((a.layer ?? 0) !== (b.layer ?? 0)) ? `LAYER disagreement (${a.layer ?? 0} vs ${b.layer ?? 0})`
      : (!!a.isRamp !== !!b.isRamp) ? 'one side carries a RAMP profile and the other does not'
      : 'NO REASON IN THE TAGS — both at the same layer, neither bridge nor tunnel';
    byReason[reason] = (byReason[reason] || 0) + 1;
    worst.push({ nid, dy, reason, a: a.highwayType, b: b.highwayType,
                 name: a.name || b.name || '' });
  }
  worst.sort((x, y2) => y2.dy - x.dy);
  return { total, byReason, worst: worst.slice(0, 10) };
}

/** Print it the way the other bake censuses print — one block, no throw. */
export function reportJunctionContinuity(result) {
  const { total, byReason, worst } = result;
  if (!total) {
    console.log('  [Continuity] ✅ every shared node meets in height (tol '
      + `${CONTINUITY_TOL_M} m) — no steps in the road network.`);
    return;
  }
  console.log(`  [Continuity] ⚠ ${total} shared nodes where the connected ways DISAGREE about height `
    + `by more than ${CONTINUITY_TOL_M} m — a road with a step in it. Report only.`);
  for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(v).padStart(5)}  ${k}`);
  }
  for (const w of worst.slice(0, 5)) {
    console.log(`     worst: ${w.dy.toFixed(1)} m  ${w.a} / ${w.b}  ${w.name || '(unnamed)'}`);
  }
}

export const __test__ = { CONTINUITY_TOL_M };
