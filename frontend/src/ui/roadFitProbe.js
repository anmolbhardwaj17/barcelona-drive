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
  const H = 2;
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
        samples.push({ buriedBy: terrainY - asphaltY, x: p.x, z: p.y, id: road.id ?? road.wayId ?? '?' });
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

  const out = { total: samples.length, buried: buried.length, p50: q(0.5), p95: q(0.05),
                worst: sorted[0].buriedBy, slopeBuried, slopeClean, worstPoints: worst };
  window._ddRoadFitResult = out;   // NOT _ddRoadFit — that stays the callable, so re-running works
  return out;
}
