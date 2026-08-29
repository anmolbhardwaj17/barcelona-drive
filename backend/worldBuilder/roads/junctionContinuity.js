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
 * DRIVABLE only, split out — because the first run of this check reported 938 breaks and 586 of them
 * "surface meets TUNNEL", which read as 586 missing road portals. It is not: 464 of the 466
 * non-drivable underground ways in this city are indoor `corridor` (metro passageways), and a
 * pedestrian subway meeting a footway at a node is not a missing tunnel mouth — it is a staircase.
 * Counting them made the number big and unactionable, and would have sent the next fix at the wrong
 * population. A car cannot drive a corridor, so the number that matters is the drivable one.
 */
const DRIVABLE = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
  'residential', 'unclassified', 'living_street', 'service', 'busway',
]);

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

  const byReason = {}, byReasonDrivable = {};
  const worst = [];
  let total = 0, totalDrivable = 0;
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
    const drivable = DRIVABLE.has(a.highwayType) && DRIVABLE.has(b.highwayType);
    if (drivable) { totalDrivable++; byReasonDrivable[reason] = (byReasonDrivable[reason] || 0) + 1; }
    // Carry the WAY IDS and the tunnel side's shape. "366 missing portals" is a count; "way
    // 12345, tunnel, layer -1, 2 nodes, both ends underground" is something to fix. Without this
    // the next step is another offline probe re-deriving what the bake already knew.
    const tun = a.tunnel ? a : (b.tunnel ? b : null);
    // ── IS THE BREAK AT THE TUNNEL'S END, OR PARTWAY ALONG IT? ────────────────────────────────
    // RampResolver pins a portal's profile to surface height at the way's ENDPOINTS only. A surface
    // road that joins partway along a tunnel meets it at DEPTH, and no amount of fixing which
    // neighbour the endpoint targets can reach that node. N-46 aimed at the endpoint question and
    // moved the count by exactly zero, which is the signature of a change with no effect rather
    // than a small one — so ask the structural question instead of trying a third variation.
    const tunEnd = tun && tun.nodeIds
      ? (tun.nodeIds[0] === nid || tun.nodeIds[tun.nodeIds.length - 1] === nid) : null;
    // EVERY way at this node, with the height each one assigns here. The resolver trace proved the
    // portal reaches 0 at its surface end, so the disagreement must be at a node whose membership
    // the two disagree about — and a list of who is actually there ends that argument.
    const members = list.map((m) => `${m.r.id}${m.r.tunnel ? '(tun)' : ''}`
      + `${m.r.bridge ? '(br)' : ''}@${m.y.toFixed(1)}`).join(' ');
    worst.push({ nid, members, dy, reason, drivable, a: a.highwayType, b: b.highwayType,
                 aId: a.id, bId: b.id,
                 tunId: tun ? tun.id : null,
                 tunLayer: tun ? (tun.layer ?? 0) : null,
                 tunNodes: tun && tun.nodeIds ? tun.nodeIds.length : null,
                 tunRamp: tun ? !!tun.isRamp : null,
                 tunEnd,
                 name: a.name || b.name || '' });
  }
  worst.sort((x, y2) => y2.dy - x.dy);
  return { total, byReason, totalDrivable, byReasonDrivable,
           worst: worst.filter((w) => w.drivable).slice(0, 40) };
}

/** Print it the way the other bake censuses print — one block, no throw. */
export function reportJunctionContinuity(result) {
  const { total, byReason, totalDrivable, byReasonDrivable, worst } = result;
  console.log(`  [Continuity] DRIVABLE-to-drivable steps > ${CONTINUITY_TOL_M} m at a shared node: `
    + `${totalDrivable}   ← the number that matters; a car cannot drive a metro corridor`);
  for (const [k, v] of Object.entries(byReasonDrivable).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(v).padStart(5)}  ${k}`);
  }
  for (const w of worst.slice(0, 6)) {
    console.log(`     worst drivable: ${w.dy.toFixed(1)} m  node ${w.nid}  [${w.members}]`
      + (w.tunId ? `  tunEnd=${w.tunEnd}` : '') + `  ${w.name || '(unnamed)'}`);
  }
  // How many of the tunnel-side ways got a ramp profile at all? If a portal belongs at a node and
  // the tunnel there is NOT a ramp, RampResolver never classified it as a portal — which is a
  // different bug from a portal that exists and is shaped wrong.
  const tunCases = { rampedTunnel: 0, flatTunnel: 0, atTunnelEnd: 0, midTunnel: 0 };
  for (const w of worst) if (w.tunId != null) {
    tunCases[w.tunRamp ? 'rampedTunnel' : 'flatTunnel']++;
    if (w.tunEnd === true) tunCases.atTunnelEnd++;
    else if (w.tunEnd === false) tunCases.midTunnel++;
  }
  if (tunCases.rampedTunnel + tunCases.flatTunnel > 0) {
    console.log(`     of the worst listed, tunnel side ramped: ${tunCases.rampedTunnel}, `
      + `FLAT (never classified as a portal): ${tunCases.flatTunnel}`);
    console.log(`     break sits AT the tunnel's end: ${tunCases.atTunnelEnd}, `
      + `PARTWAY ALONG it: ${tunCases.midTunnel}   ← a portal can only be pinned at an END`);
  }
  console.log(`  [Continuity] (all classes, incl. footway/steps/corridor: ${total})`);
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
