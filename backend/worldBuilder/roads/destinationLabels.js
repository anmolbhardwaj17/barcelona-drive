/**
 * destinationLabels.js — what a direction board at a junction should SAY.
 *
 * ── WHY THIS IS NOT roadInfraRenderer's JOB ───────────────────────────────────────────────────
 * The shipped board logic collects "unique names of OTHER roads branching off at this junction"
 * (roadInfraRenderer.js:1028). That is a street NAME. A Spanish direction sign states where the
 * road LEADS, which is a property of the graph beyond the junction, not of the junction itself. It
 * also cannot be answered per-tile at render time: a destination 1.5 km away is several tiles over.
 * So it is derived once, at bake, over the whole road graph.
 *
 * Deliberately NOT read: OSM `destination` / `destination:ref` tags. The user asked for our own
 * logic, and the tags are sparse and inconsistent in Barcelona anyway.
 *
 * ── THE ONE THING THAT MAKES OR BREAKS IT ─────────────────────────────────────────────────────
 * The walk must stay COMMITTED TO ITS HEADING. A free best-first search finds the most important
 * road anywhere within reach, so every exit of a junction returns the same answer — measured: it
 * reported 100% coverage while all eight sampled exits said "Via Augusta". Two constraints fix it:
 * every step must make radial progress away from the junction, and must stay inside CONE_DEG of the
 * exit bearing. Coverage drops to 98.7%, and that lower number is the correct one.
 */

const REACH_M = 1500;        // how far a sign may promise
const CONE_DEG = 62;         // half-angle the walk may wander from the exit bearing
const MIN_DEST_M = 300;      // nearer than this is "you are here", not a destination
const MAX_DEPTH = 40;
const BEAM = 12;             // frontier width per step — best-first, not exhaustive

const CLASS_RANK = {
  motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4,
  residential: 6, unclassified: 6, living_street: 7, service: 8,
};
const LINK_RANK = {
  motorway_link: 0.5, trunk_link: 1.5, primary_link: 2.5, secondary_link: 3.5, tertiary_link: 4.5,
};
export const DRIVABLE = new Set([...Object.keys(CLASS_RANK), ...Object.keys(LINK_RANK)]);
const rankOf = (t) => (CLASS_RANK[t] ?? LINK_RANK[t] ?? 9);

/**
 * A sign says "Diagonal", not "Avinguda Diagonal (lateral muntanya)".
 *
 * OSM carries the full administrative name plus disambiguating suffixes for each carriageway of a
 * dual road. Both are correct data and both are wrong on a 2 m board read at 60 km/h.
 */
export function signName(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  s = s.replace(/\s*\([^)]*\)\s*$/, '');                     // "(lateral muntanya)", "(sentit Besòs)"
  // Generic Catalan/Spanish street-type prefixes carry no information on a direction board — every
  // Barcelona street is a Carrer. The proper noun is what identifies the destination.
  // ⚠ STRIP ONLY THE TRULY GENERIC PREFIX. Every Barcelona street is a "Carrer", so it identifies
  // nothing and a board saying "Carrer de Balmes" wastes half its width — "Balmes" is what the
  // driver is looking for. But the others are PART of the name: stripping them gave
  // "Passeig de Gràcia" -> "Gràcia", which is a different DISTRICT, and
  // "Travessera de les Corts" -> "Corts", likewise. Measured on real output, not assumed.
  s = s.replace(/^Carrer\s+(de\s+les|de\s+la|dels|del|de\s+l'|de|d')?\s*/i, '');
  s = s.replace(/^Passatge\s+(de\s+les|de\s+la|dels|del|de\s+l'|de|d')?\s*/i, '');
  return s.trim();
}

/**
 * @param {Array} ways  [{ id, name, highwayType, pts:[{x,z}] }] in a metric frame
 * @returns {Map<string, Array<{bearing:number, name:string, type:string, distM:number}>>}
 *   key `${x}|${z}` of the junction node → one entry per exit
 */
export function deriveJunctionDestinations(ways) {
  const SNAP = 1.0;
  const key = (x, z) => `${Math.round(x / SNAP)},${Math.round(z / SNAP)}`;
  const nodes = new Map();
  const byId = new Map();
  for (const w of ways) {
    if (!DRIVABLE.has(w.highwayType) || !w.pts || w.pts.length < 2) continue;
    byId.set(w.id, w);
    for (const p of [w.pts[0], w.pts[w.pts.length - 1]]) {
      const k = key(p.x, p.z);
      if (!nodes.has(k)) nodes.set(k, { x: p.x, z: p.z, ends: [] });
      nodes.get(k).ends.push(w);
    }
  }

  const coneCos = Math.cos((CONE_DEG * Math.PI) / 180);
  const lengthOf = (w) => {
    let l = 0;
    for (let i = 0; i < w.pts.length - 1; i++) l += Math.hypot(w.pts[i+1].x - w.pts[i].x, w.pts[i+1].z - w.pts[i].z);
    return l;
  };
  const farEnd = (w, j) => {
    const a = w.pts[0], b = w.pts[w.pts.length - 1];
    return Math.hypot(a.x - j.x, a.z - j.z) > Math.hypot(b.x - j.x, b.z - j.z) ? a : b;
  };

  const out = new Map();
  for (const [k, j] of nodes) {
    if (j.ends.length < 3) continue;                       // not a junction; nothing to sign
    const exits = [];
    for (const startWay of j.ends) {
      const f0 = farEnd(startWay, j);
      let bx = f0.x - j.x, bz = f0.z - j.z;
      const bl = Math.hypot(bx, bz);
      if (bl < 1e-3) continue;
      bx /= bl; bz /= bl;

      const ownName = signName(startWay.name);
      let best = null;
      const seen = new Set([startWay.id]);
      let frontier = [{ w: startWay, dist: 0, radius: bl }];
      for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
        frontier.sort((a, b) => a.w.rank - b.w.rank || a.dist - b.dist);
        const next = [];
        for (const cur of frontier.slice(0, BEAM)) {
          const w = cur.w;
          const d = cur.dist + lengthOf(w);
          const nm = signName(w.name);
          // ⚠ A board must not name the road you are already on, and must not promise something
          // 40 m away. Without both, most exits resolve to themselves at 0.0 km — measured.
          if (nm && nm !== ownName && d >= MIN_DEST_M) {
            const score = rankOf(w.highwayType) + d / 20000;   // class first, then nearer wins
            if (!best || score < best.score) best = { name: nm, type: w.highwayType, distM: d, score };
          }
          if (d > REACH_M) continue;
          for (const p of [w.pts[0], w.pts[w.pts.length - 1]]) {
            const n = nodes.get(key(p.x, p.z));
            if (!n) continue;
            for (const e of n.ends) {
              if (seen.has(e.id)) continue;
              const fp = farEnd(e, j);
              const rx = fp.x - j.x, rz = fp.z - j.z;
              const rr = Math.hypot(rx, rz);
              if (rr <= cur.radius) continue;                       // must move AWAY from the junction
              if ((rx / rr) * bx + (rz / rr) * bz < coneCos) continue;  // and stay in this exit's cone
              seen.add(e.id);
              e.rank = rankOf(e.highwayType);
              next.push({ w: e, dist: d, radius: rr });
            }
          }
        }
        frontier = next;
      }
      if (best) {
        exits.push({ bearing: +(Math.atan2(bx, bz) * 180 / Math.PI).toFixed(1),
                     name: best.name, type: best.type, distM: Math.round(best.distM) });
      }
    }
    if (exits.length) out.set(k, exits);
  }
  return out;
}
