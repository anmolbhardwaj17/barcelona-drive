/**
 * roadFitProbe — measures how the RENDERED road sits against the RENDERED terrain.
 *
 * WHY THIS EXISTS. Surface roads are reported buried in the terrain "in some places": the asphalt
 * disappears and only the paint, which rides 4.5-5 cm above the road deck, still shows. The two
 * paths disagree and one already says so — `getSurfaceHeightAt` clamps to
 * `Math.max(roadHeight, terrainY)` with the comment "never below terrain", while the road RENDERER
 * consults terrain nowhere at all. So placement is safe and the visuals are not.
 *
 * "In some places" is not something a fix can be chosen against. This turns it into a distribution,
 * a worst case with coordinates, and a slope correlation — which is what separates the candidate
 * causes (smoothing pass ordering vs simplified polylines vs triangulation error).
 *
 * ⚠ MEASUREMENT ONLY. It changes nothing and renders nothing. See D-23: an instrument that alters
 * what the player sees gets reported as a rendering bug.
 *
 * Bridges and tunnels are EXCLUDED — they are supposed to be above and below the ground.
 */
import { ROAD_VISUAL_ABOVE_TERRAIN, BAKED_SURFACE_ABOVE_ROAD_Y } from '../map/groundLayers.js';

/** Terrain slope (m/m) at (x,z), from a 4 m cross probe. Hills are the suspected worst case. */
function terrainSlopeAt(tileManager, x, z) {
  // ⚠ MUST EXCEED THE TERRAIN CELL SIZE. This was 2 m against a ~3.9 m grid (128 samples over a
  // 500 m tile), so a cross probe frequently landed inside ONE cell and every corner returned the
  // same height -> slope 0.000. The first run reported "BURIAL TRACKS SLOPE" in aggregate while
  // seven of its eight worst points read exactly 0.000, which is the signature of this bug, not of
  // flat ground. 6 m spans at least two cells in every direction.
  const H = 6;
  const e = tileManager.getTerrainHeightAt?.(x + H, z), w = tileManager.getTerrainHeightAt?.(x - H, z);
  const n = tileManager.getTerrainHeightAt?.(x, z + H), s = tileManager.getTerrainHeightAt?.(x, z - H);
  if (e == null || w == null || n == null || s == null) return null;
  const dx = (e - w) / (2 * H), dz = (n - s) / (2 * H);
  return Math.hypot(dx, dz);
}

/**
 * Walk every resident surface road and compare drawn asphalt against drawn terrain.
 * @returns {object|null} summary, also stashed on window._ddRoadFit
 */
export function probeRoadFit(tileManager, { offset, vertExag, bakedIsRaw }) {
  const entries = tileManager.__debugTileEntries?.();
  if (!entries) { console.warn('[roadfit] no tile access — probe not wired'); return null; }

  const samples = [];
  let skippedStructure = 0, noTerrain = 0;

  for (const entry of entries) {
    if (!entry?.roads) continue;
    for (const road of entry.roads) {
      const isBridge = road.bridge === true || (Number.isFinite(road.layer) && road.layer > 0);
      const isTunnel = road.tunnel === true || (Number.isFinite(road.layer) && road.layer < 0);
      if (isBridge || isTunnel) { skippedStructure++; continue; }
      for (const p of road.points || []) {
        const raw = p.elevation;
        if (raw == null || !Number.isFinite(raw)) continue;
        const deckY = (bakedIsRaw ? (raw - offset) * vertExag : raw * vertExag) + ROAD_VISUAL_ABOVE_TERRAIN;
        const asphaltY = deckY + BAKED_SURFACE_ABOVE_ROAD_Y;
        const terrainY = tileManager.getTerrainHeightAt?.(p.x, p.y);
        if (terrainY == null) { noTerrain++; continue; }
        // positive = terrain is ABOVE the drawn asphalt = the road is buried by this much
        samples.push({ buriedBy: terrainY - asphaltY, x: p.x, z: p.y, id: road.id ?? road.wayId ?? '?',
                       cls: road.highwayType || '?', name: road.name || '' });
      }
    }
  }

  if (!samples.length) { console.warn('[roadfit] no surface-road samples — drive first, then re-run'); return null; }

  const buried = samples.filter((s) => s.buriedBy > 0);
  const sorted = [...samples].sort((a, b) => b.buriedBy - a.buriedBy);
  const q = (f) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))].buriedBy;
  const worst = sorted.slice(0, 8);
  for (const w of worst) w.slope = terrainSlopeAt(tileManager, w.x, w.z);

  // Does burial track slope? If hills are the cause, the buried set is steeper than the clean set.
  const meanSlope = (set) => {
    const v = set.slice(0, 400).map((s) => terrainSlopeAt(tileManager, s.x, s.z)).filter((n) => n != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const slopeBuried = meanSlope(buried);
  const slopeClean = meanSlope(samples.filter((s) => s.buriedBy <= 0));
  const fmt = (n) => (n == null ? 'n/a' : n.toFixed(3));

  console.warn(
`[roadfit] ${samples.length} surface-road points over ${entries.length} resident tiles (${skippedStructure} bridge/tunnel roads skipped${noTerrain ? `, ${noTerrain} without terrain` : ''})
  BURIED    ${buried.length} of ${samples.length} (${(100 * buried.length / samples.length).toFixed(1)}%)  — terrain above the drawn asphalt
  spread    p50 ${q(0.5).toFixed(3)}m   p95 ${q(0.05).toFixed(3)}m   worst ${sorted[0].buriedBy.toFixed(3)}m   best ${sorted[sorted.length - 1].buriedBy.toFixed(3)}m
  slope     mean terrain slope, buried ${fmt(slopeBuried)} vs clean ${fmt(slopeClean)}  -> ${
      slopeBuried != null && slopeClean != null
        ? (slopeBuried > slopeClean * 1.3 ? 'BURIAL TRACKS SLOPE (hills)' : 'burial does NOT track slope — look past terrain steepness')
        : 'inconclusive'}
  worst points (x, z, buriedBy, slope):
${worst.map((w) => `    ${w.x.toFixed(1)}, ${w.z.toFixed(1)}  ${w.buriedBy.toFixed(3)}m  slope ${fmt(w.slope)}  way ${w.id}`).join('\n')}`);

  // BAND THE BURIAL. The first run showed a median of -0.079 m (correct) with a tail at +9.6 m —
  // two different failures wearing one number. Shallow burial is a co-planarity problem you see as
  // paint poking through asphalt; metre-deep burial is a road inside a hill, which is a DATA defect
  // (an untagged tunnel is the leading candidate — this probe only excludes roads OSM has tagged).
  // Reporting one aggregate over both invites fixing the wrong one.
  const band = (lo, hi) => buried.filter((s) => s.buriedBy > lo && s.buriedBy <= hi).length;
  const shallow = band(0, 0.5), mid = band(0.5, 2), deep = buried.filter((s) => s.buriedBy > 2).length;
  const deepPts = buried.filter((s) => s.buriedBy > 2);
  const waysDeep = new Set(deepPts.map((s) => s.id));

  // WHICH ROAD CLASSES? Hotspot A was checked on the ground and had no tunnel and no plausible need
  // for one, which weakens "untagged tunnel" for a residential street. Grade separation lives on
  // motorway / trunk / primary, so the class mix is the discriminator: if deep burial concentrates
  // on those, missing structure is still the story; if it is spread across residential, it is bad
  // elevation data instead. Normalised per class — 4 deep points out of 40 matters more than 40
  // out of 4000.
  const byClass = new Map();
  for (const smp of samples) {
    const e = byClass.get(smp.cls) || { total: 0, deep: 0, ways: new Set(), worst: -Infinity, at: null };
    e.total++;
    if (smp.buriedBy > 2) {
      e.deep++; e.ways.add(smp.id);
      if (smp.buriedBy > e.worst) { e.worst = smp.buriedBy; e.at = smp; }
    }
    byClass.set(smp.cls, e);
  }
  const classRows = [...byClass.entries()]
    .filter(([, e]) => e.deep > 0)
    .sort((a, b) => (b[1].deep / b[1].total) - (a[1].deep / a[1].total));
  if (classRows.length) {
    console.warn('  DEEP >2m BY ROAD CLASS (worst rate first) — grade separation lives on motorway/trunk/primary:\n' +
      classRows.map(([cls, e]) =>
        `    ${String(cls).padEnd(14)} ${String(e.deep).padStart(5)}/${String(e.total).padEnd(6)} pts` +
        ` (${(100 * e.deep / e.total).toFixed(1).padStart(5)}%)  ${String(e.ways.size).padStart(3)} ways` +
        `  worst ${e.worst.toFixed(2)}m at ${e.at.x.toFixed(0)},${e.at.z.toFixed(0)}` +
        `  way ${e.at.id}${e.at.name ? ` "${e.at.name}"` : ''}`).join('\n'));
  } else {
    console.warn('  DEEP >2m BY ROAD CLASS — none. Every buried point is under 2 m; this is purely co-planarity.');
  }
  console.warn(
`  BANDS     shallow <=0.5m ${shallow}  ·  0.5-2m ${mid}  ·  DEEP >2m ${deep} across ${waysDeep.size} distinct ways
            shallow = co-planarity (the visible paint-through-asphalt bug)
            deep    = a road inside terrain: untagged tunnel / bad elevation -> OSM repair layer, class V1/V5`);

  const out = { total: samples.length, buried: buried.length, p50: q(0.5), p95: q(0.05),
                worst: sorted[0].buriedBy, slopeBuried, slopeClean, worstPoints: worst,
                bands: { shallow, mid, deep, deepWays: [...waysDeep] } };
  window._ddRoadFitResult = out;   // NOT _ddRoadFit — that stays the callable, so re-running works
  return out;
}
