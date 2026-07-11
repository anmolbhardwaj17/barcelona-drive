# Bake-Level Surface Clipping (v8 track)

Goal: kill the co-planar ground-surface overlaps (footpaths drawn over carriageways, promenade
patches fighting roads) **at the source** — the bake — instead of runtime renderOrder/offset
tricks. Decision made 2026-07-11 with user: bake-level fixes FIRST, runtime layering table after.
User pre-authorized re-bakes.

## Phase 1 — clip path-family polylines out of carriageway coverage (NO format bump)

**What:** region-wide pass in `buildRegion.js`, inserted after `resolveRamps()` and before
`simplify()` (the point where the whole road graph is in hand — cross-tile paths clip
consistently, and `tileSplit.js` then splits the results exactly as it does today).

**Rule:** for every road with `highwayType ∈ {footway, path, cycleway, pedestrian, steps, track}`
at `layer == 0`, not bridge/tunnel:
- A polyline point is **covered** when its distance to the nearest drivable-road centerline
  SEGMENT is `< thatRoad.width/2 + 0.3 m`. Drivable = motorway/trunk/primary/secondary/tertiary/
  residential/unclassified/living_street/service (+ `_link`s), same-layer, not tunnel.
- Split the polyline into maximal **uncovered runs**; interpolate the boundary point where a
  segment crosses the coverage edge (same lerp approach as `tileSplit.clipOneSegment`).
- Drop runs shorter than 2.5 m (fragments).
- Emit each run as its own road record (id suffix `_c<k>`), all other fields copied. Consumers
  already handle one-way→many-records via tile splitting, so this is structurally invisible.

**Crossing exception:** ways tagged `footway=crossing` / `cycleway=crossing` are NOT clipped
(they'd vanish entirely — they live inside the carriageway by definition). Instead they are
emitted with a new optional field `crossing: true`; the runtime road renderer SKIPS drawing a
ribbon for them (zebra decals are generated separately from the road side, and the polyline
stays available to gameplay/pedestrian systems).

**Spatial acceleration:** hash grid of drivable centerline segments (cell 32 m ≥ max half-width +
margin; query 3×3 cells). Region scale: tens of thousands of segments — trivial memory.

**Format impact:** none (fewer/shorter polylines + one optional boolean field, which the v7
header already supports via conditional fields — gates 3/4 are generic). Reader unchanged except
gate-5 use of `crossing`.

## Phase 2 — baked sidewalk polygons (v8 bump)

Move `buildSidewalks()` / `buildCurbs()` (runtime `roadRenderer.js` Phase-3 work) into the bake,
riding the existing `bakedRoads` pattern (pre-computed positions/normals/uvs/indices blobs read
by `readBakedRoads`): a new `bakedSidewalks` section, pre-clipped against carriageways, chamfers
and junction circles at bake time. Bump `header.version` 7→8; reader treats a missing section as
"generate at runtime" (v7 fallback keeps old tiles working). Removes a chunk of per-tile
main-thread build cost (part of the STATS `other` stalls).

Details to be specced after Phase 1 verification; Phase 1 does not block on it.

## Verification protocol

1. `BAKE_SINGLE_TILE` dry-run + `--area eixample` test bake; check v7 counts still parse.
2. Drive-check the exact user-reported spots: Passeig Marítim promenade (41.3776, 2.1907 area)
   and Barceloneta crossings — no path ribbons over carriageways; zebra decals intact.
3. Full region re-bake (`npm run build:region`) — pre-authorized; then `window._clearTileCache()`
   + hard reload (stale-cache rule).

## Invariants honored

- Elevation untouched → `BAKED_ROAD_ELEVATION_IS_RAW: true` stays true (no vertical-model impact).
- No physics change: path-family roads' colliders follow their (now clipped) polylines; carriageway
  colliders unchanged.
