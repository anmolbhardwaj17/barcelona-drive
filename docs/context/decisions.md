# Decision Log

ADR-style records of intentional architectural tradeoffs. Before "fixing" anything listed here, read the rationale. If the rationale no longer applies, update this doc and flag the change.

---

## D-16: Terrain is the drivable truth; roads drape on it (cloth) — VISUAL shipped via the bake; physics simplification REVERTED

> **Status (2026-06-10):** the VISUAL cloth + smoothing **shipped**; the **physics simplification was reverted**.
> - **Shipped:** DEM smoothing (Stage A) + roads draped on the smoothed terrain. Draping is achieved **via the
>   bake** (roads are baked at the same smoothed DEM the terrain uses, so the baked road geometry already
>   conforms) — NOT the runtime `getElevationAt` drape, which produced spiking ribbons (forced-runtime
>   bridges/tunnels dove underground) and was reverted along with the baked-fast-path disable.
> - **Reverted:** dropping surface-road colliders + heightfield-only physics. The heightfield's untested
>   world→physics transform trapped the car **below** the terrain, and removing surface colliders left the car
>   fully dependent on it. Physics is back to the prior model (visual-aligned **Trimesh** terrain, chassis mask
>   = WORLD, original road-collider gate). Revisit only after the terrain heightfield is *proven* (placement +
>   orientation + wheel-grip) on hilly terrain with a runtime check — see [[G-49]].
> - **Revert correction (2026-06-11):** the revert under-restored the chassis mask — the [[G-49]] model needs
>   `WORLD | TERRAIN` (the chassis-vs-trimesh backstop is the ONLY off-road hold; rays can't hit Trimesh).
>   With mask = WORLD the terrain trimesh collided with nothing (runtime pair-check `(16 & 4) = 0`) → off-road
>   free-fall. Mask restored to `WORLD | TERRAIN` in carPhysics.js after headless runtime diagnosis.
> - **Physics half SHIPPED (2026-06-11):** the mask fix alone couldn't hold the car — cannon-es has NO
>   box-vs-trimesh narrowphase (G-49 correction), so the trimesh backstop was physically impossible. Terrain
>   physics is now the **Heightfield** (the D-16-target shape): the old misplacement was a quadrant-indexing
>   bug in `buildTerrainHeightfield` (64-range indices into the 128-wide source grid), fixed with the full
>   grid; placement runtime-verified ≤ 0.01 m vs the trimesh, drop-tests settle with 4-wheel contact on
>   Montjuïc slopes. Trimesh terrain removed (was inert + 88 ms/tile). Surface-road colliders KEPT (not the
>   full target simplification yet). Heightfields can't be carved → tunnel-mouth physics holes are gone until
>   Phase 3 authored tunnels.
> - **Surface-road collider simplification SHIPPED (2026-06-11, Phase 2 deletion D1):** the deck-collider
>   gate in tileManager is now STRUCTURAL FLAGS ONLY (`bridge`/`tunnel`/`isRamp`/`layer`); the
>   `isElevatedByHeight` height-delta fallback was deleted — it was the phantom-deck factory and a live
>   [[G-47]] absolute-Y bug (spawn-frame ±0.3 m thresholds → off-spawn, EVERY sloped road minted deck
>   boxes). **Dependency: this deletion is safe ONLY because the Phase-0 terrain Heightfield exists** —
>   unflagged surface roads ride the heightfield (rays + chassis both work). Do not reintroduce a height
>   heuristic without a terrain-relative frame. This completes the D-16-target physics model: heightfield
>   everywhere + structural-only colliders.

The decision/aspiration below still stands as the target; only the physics half is deferred.

---

### (target architecture — physics half deferred)
## D-16-target: Terrain is the drivable truth; surface roads drape on it (cloth); physics = heightfield + structural-only colliders

**Decision:** The terrain is the single source of ground truth. **Surface roads** (layer 0, not
bridge/tunnel/ramp) are visual "cloth" draped on it — every road/marking/sidewalk vertex Y samples the
terrain height (`getElevationAt`, the same grid the terrain mesh + physics heightfield use), NOT the baked
`p.elevation`. Physics collapses to: the **terrain heightfield** is the drivable surface everywhere
(on-road and off); **surface roads get NO colliders**; only **ramps, tunnels, flyovers/bridges** (which
leave the ground) keep structural geometry + their own colliders. The terrain DEM is **smoothed once at
bake** (global pre-smooth) for gentle, seamless hills.

**Rationale:** Roads baked at per-point DEM never quite agreed with the terrain mesh → floating segments,
z-fighting, seams at junctions; and `RaycastVehicle` wheels fall through trimeshes / per-segment road boxes
were a constant fight (see [[D-10]], [[G-49]]). Making the terrain the truth and roads a cloth on it makes
conformance exact by construction: all roads at a junction meet at one height; a road rises over a hill and
dips into a valley because it *is* the terrain surface + a few cm. Physics then needs only ONE ground shape
to be right (the heightfield, which raycasts reliably) plus a handful of explicit structures for the
elevated/buried exceptions — eliminating the surface-road collider class entirely.

**Implementation:**
- **Smooth:** `demLoader.js smoothRaster` — separable NoData-aware box blur over the global DEM raster at
  load (env-tunable `DEM_SMOOTH_RADIUS`/`DEM_SMOOTH_ITERS`, default 2/2). Global (pre-tile) so slippy-tile
  edges stay matched → seamless. Needs a re-bake.
- **Drape:** `roadRenderer.getRoadPointHeights` — surface roads skip baked `p.elevation`, sample terrain;
  the baked road fast path is disabled (`USE_BAKED_ROAD_FASTPATH = false`) so surface ribbons build at
  runtime and drape (elevated roads still use `p.elevation`).
- **Physics:** `tileManager.createRoadTrimeshColliders` gate relaxed to `if (!isBridge && !isTunnel &&
  !isRamp) continue;` — surface roads get no deck collider; they ride the heightfield. Tunnel walls,
  approach walls, ramp portals, guard rails, barriers, scenery unchanged.

**Trade-off:** Roads follow terrain incl. cross-slope (no engineered cuttings/embankments). Underpasses /
cuttings that aren't tunnels are not modeled (they drape on the surface). Only bridge/tunnel/ramp are the
non-draped exceptions. Smoothing strength is a knob; default is "gentle but present."

**Revisit when:** engineered road grading is needed (cuttings/embankments), or a bake guarantees road
geometry exactly matches the terrain grid (then the baked fast path could be re-enabled).

---

## D-15: Bridge-structure detection gates on STRUCTURAL flags, not normalized road height

**Decision:** `buildBridgeSlabGeometry`, `buildBridgeGuardRailGeometry`, `buildBridgeShadowMesh` and
`buildBridgeGuardRailColliders` (roadRenderer.js) decide "is this elevated" from `road.bridge ||
road.layer > 0 || road.isRamp` — plus, for `_link` roads only, an **above-terrain** rise
(`getAboveTerrainHeights` = road height − local terrain). They never threshold the terrain-inclusive
normalized road height.

**Rationale:** The old gates were `hMax > 4.0 || (hMax − hMin) > 2.5` (slab) and `hMax > 0.5 || Δh > 1.0
|| rawElevMax/Range` (guardrail). Those were correct in the flat world where road height = layer profile
(0 for surface, +6 for a bridge). After the road-drape fix (D-14) road height became terrain-inclusive
(`DEM − offset`), so `hMax` now reflects **terrain elevation** (positive on Montjuïc) and `Δh` reflects
**terrain slope** — and the thresholds fired on ~60% of ordinary surface roads (measured 165/277 and
184/278 on bridge-free tiles), fabricating slabs + guard rails + metal railings that draped correctly but
should not exist (the dark "canopy" over Montjuïc). Structural flags are the authoritative OSM facts about
what a road *is* and are immune to terrain; the only legitimate height signal is **above-terrain**
(`road.elevation − terrainDEM`), never the absolute normalized height. See [[G-42]].

**Revisit when:** a real bridge lacks `bridge`/`layer`/`isRamp` tags in OSM (then add an above-terrain
height fallback, computed terrain-relative — never absolute).

---

## D-14: Road DEM drape writes p[3] (the serialized elevation field); road height is now terrain-inclusive

**Decision:** In `buildRegion.js` the per-point DEM add targets `p[3]` (`if (p.length >= 4) p[3] += groundElev`),
the field `convertToBinary.flattenRoadPoints` serializes as the road `elevation` array. Road points are
`[mercX, yUp, mercZ, elev]`; `p[3]` holds the layer-relative profile (0 for surface, ramp descent for ramps),
so `p[3] += DEM` yields the absolute draped elevation with no double-count. (`p[1]` is also kept in sync for
any 3-element fallback point.)

**Rationale:** The DEM add originally wrote `p[1]` (`yUp`), but the serializer reads `p[3]`, so the baked
elevation array stayed flat → roads rendered at a constant Y while terrain had relief. Writing `p[3]` drapes
roads onto the DEM (verified: road elevation == terrain DEM at co-located points, Δ≈0).

**CRITICAL COUPLING — read before touching any road-height threshold:** Because the road `elevation` is now
**terrain-inclusive** (`= layerProfile + DEM`), the runtime normalized road height `toNormalizedRoadY(elev) =
elev − offset = terrainNormalized + layerProfile` carries the **terrain elevation**, not just a layer profile.
Any downstream code that thresholds road "height" assuming it is ≈0 for surface roads (a flat-world relic)
WILL misfire on slopes / high terrain. This directly caused the spurious-bridge bug (D-15). **Rule:** road
height detection/thresholds must use the **above-terrain** component (`road.elevation − terrainDEM`) or
structural flags — never the absolute normalized height. Same root for the floating road-infra (signs read
raw absolute `p.elevation`) and the baked road surface ([[G-43]], [[G-44]]). See [[G-47]] (failure class).

**Revisit when:** the road point tuple layout changes, or the serializer stops preferring the elevation array.

---

## D-13: `useBaked` is the live terrain path — `TERRAIN_MAX_GRID` must equal the bake `gridSize` (64)

**Decision:** `CONFIG.TERRAIN_MAX_GRID = 64` matches `terrainBaker.js GRID_SIZE = 64`, so the terrainRenderer
gate `useBaked = bakedTerrain && bakedTerrain.gridSize === maxGrid && …` evaluates **true** and the pre-baked
terrain mesh renders (with the co-frame `position.y = −offset·vertExag` shift and the closed-polygon-only
water-sink). The runtime fallback mesh is bypassed. A one-time `[Terrain] useBaked=TRUE …` log confirms the live path.

**Rationale:** `TERRAIN_MAX_GRID` was 32 while the bake emitted `gridSize 64`, so the gate fell to the runtime
**fallback** mesh — whose absolute water-depth math produced the El Raval "water cones." The trap was insidious:
every fix and every validator targeted the *baked* mesh, but the *fallback* was what actually rendered. Matching
the gate (32 → 64) makes the baked mesh live and retires the buggy fallback path. (`TERRAIN_GRID_SIZE = 32`
remains in config but is dead/unused.)

**Revisit when:** the bake `GRID_SIZE` changes — `TERRAIN_MAX_GRID` must change with it in lockstep, or the
fallback silently takes over again. Treat them as a coupled pair.

---

## D-12: `worldElevationOffset` is the single region-wide elevation baseline (tileMinElevation fork removed)

**Decision:** Vertical-model Stage 2 (DEM-on, [vertical-model-foundation-spec.md](vertical-model-foundation-spec.md) §4). All terrain/road/heightfield elevation normalizes against one spawn-anchored offset, `worldElevationOffset` (= DEM elevation at the spawn). The competing per-tile `tileMinElevation` rebasing fork is retired by forcing `tileMinElevation: null` at the parser chokepoint (`tileParserWorker.js:327`).

**Rationale:** Two normalization schemes coexisted — global `worldElevationOffset` (spawn-anchored) and per-tile `tileMinElevation` (offset=0). Because every tile always baked `tileMinElevation`, the consumption ternary `tileMinElevation != null ? 0 : getWorldElevationOffset()` always took the per-tile branch, leaving the global offset dead. In the flat world both were ~0 so the conflict was invisible; under real DEM, per-tile minima diverge between neighbours → a vertical seam tear at every tile boundary (and no spawn normalization — the region would render at absolute altitude). One baseline region-wide is the only seam-free option; the spawn-anchored one is chosen so spawn sits at Y≈0.

**Why null-at-the-parser (not edit 6 sites):** `tileMinElevation` feeds 6 sites (terrainRenderer ×2, tileManager ×3, the `elevationIsRebased` flag) all from the single parsed `elevation` object. Nulling it at the parser flips all of them at once with one line; the ternaries remain as harmless no-ops. Grep-confirmed `tileMinElevation` has no other consumer (no physics floor / culling use), so nulling is safe. Preconditions hold: baked Y is raw-absolute (`BAKED_ROAD_ELEVATION_IS_RAW: true`; `terrainBaker.js:71`, `buildRegion.js:1155`) and `main.js:106` sets the offset to the spawn DEM elevation.

**Also in this change:** DEM un-gated by decoupling `cleanRoadPipeline` from `phase1Pure2D` (`buildRegion.js:383`); the flat Y=0 ground plane removed (`scene.js`) since a single flat plane can't conform to a height field and had no physics role.

**Consequence:** requires a full region re-bake with DEM on + browser cache flush (atomic three-step). Stage-3 absolute-Y constants (wall/portal/trench heights, deck-gate clause, tunnel fall-through, SEA_LEVEL) are intentionally untouched and will look wrong on a DEM drive until Stage 3 — that is expected, not a regression.

**Update (2026-06-09):** the parser-null left consumers still *branching* on `tileMinElevation` (`x != null ? 0 : offset`), and the `useBaked` terrain shift used the offset *ungated* — so when `tileMinElevation` was non-null at runtime (stale worker), terrain shifted 80 while roads/getElevationAt/physics shifted 0 → ~80 m road float. **Fixed by removing the gate at every consumer** (terrainRenderer ×2, tileManager ×5): all now unconditionally use `getWorldElevationOffset()`. No consumer branches on `tileMinElevation` anymore, so worker-staleness can't split the frame. The decision is now enforced in render code, not just the parser. (Field still written to the binary by convertToBinary — harmless/unused; optional future removal from the format.)

**Enforcement (how the single offset stays single):** `processTileData` awaits `whenElevationOffsetReady()` before any consumer runs, and the consumers call `assertElevationOffsetResolved(...)` (a fail-fast guard that throws if the write-once offset is still unresolved) rather than silently defaulting to 0. So the offset is resolved exactly once (= DEM at spawn, set in `main.js`), every consumer reads that same value, and a missing offset crashes loudly instead of producing a half-shifted frame. Verified current consumer sites all using `getWorldElevationOffset()`: `terrainRenderer.js` (×2: getElevationAt closure + useBaked shift), `tileManager.js` (×4: processTileData, the road-collider block, the runtime-elevation closure, the `entry.getElevationAt` closure), `roadElevation.toNormalizedRoadY`, `roadInfraRenderer` (`normRoadElev`), `tunnelRenderer` (`_normTunnelElev`), plus waterRenderer / streetlightRenderer / crashBarrierRenderer / reflectorRenderer. The only remaining `tileMinElevation`/`elevationIsRebased` references are the parser emit (`tileParserWorker.js` → `null`/`false`, no branch) and the bake-side write (`buildRegion.js` / `convertToBinary.js`) — neither is a render consumer.

**Revisit when:** Stage 3 converts the absolute-Y constants to terrain-relative; or if a future need arises for per-tile elevation rebasing (it would reintroduce the seam — don't, without a cross-tile blending scheme).

---

## D-11: Unstretch-X — 1 world unit = 1 real metre on all axes

**Decision:** Apply `MERCATOR_UNSTRETCH = cos(ORIGIN_LAT)` (≈0.7507) to every Mercator→world conversion so horizontal world units equal real metres, matching the Y axis (already real metres). This is Stage 1 of the vertical-model rebuild ([vertical-model-foundation-spec.md](vertical-model-foundation-spec.md) §3).

**Rationale:** Web Mercator stretches horizontal distance by `1/cos(lat)` (≈1.3321 at 41.35°N); Y was raw DEM/layer metres (1:1). The mismatch was invisible in the flat world but corrupts every grade once terrain has relief (real ΔY over stretched run → slopes render/drive ~25% too shallow). Fixing it at the projection — the single source — makes the coordinate space honest with **zero downstream correction factors**, which is the production-grade property (absence of a clever factor, not presence of one).

**Single-factor approximation:** Web Mercator scale varies with latitude (sec 41.358°=1.33228 → 41.413°=1.33340 across the bbox). A single `cos(ORIGIN_LAT)` factor has residual error **<0.1%** (bbox variance 0.085%) — below perceptible. Accepted in favour of keeping one factor; per-latitude correction rejected as needless complexity.

**Applied as a rule, not a fixed file list:** every Mercator↔world conversion routes through the projection — forward `mercatorToWorld` ×factor, inverse `worldToMercator` ÷factor (the latter added to `backend/projection.js` in this change). The factor+origin are inlined (workers can't import) in `frontend/src/projection.js` (authoritative, exports both), `backend/projection.js`, `vegetationWorker.js`, `buildingWorker.js`; `fastElevation.js` imports it. `latLonToMercator` and slippy `latLonToTile` (`1/cos(lat)`) untouched. X-negation downstream — unaffected.

**The first inventory's "six paths" was incomplete** (found by the static cross-path verifier). Two extra classes had to be fixed: (a) `tileParserWorker` parse-time cos must be **gated on origin-subtraction** — world-stored fields (footprints, greens) are already cos'd at bake and must be read raw, else double-corrected; (b) **bake-side inline conversions** (`pointToTile` for trees/lamps/signals/shops, bus stops, parking, urban features; and `world+origin` tile-assignment round-trips in `buildingNormalize`/`greenNormalize`/`waterNormalize`/`pbfAreaFeatures` + the marina water-sink test) bypassed the projection and were routed through `mercatorToWorld`/`worldToMercator`. **Lesson: forbid inline `mercator−origin`/`world+origin`; grep for them, not just for the named functions.**

**Consequences / done in the same change:**
- **Per-provenance constant scaling, NOT blanket.** Real-metre-authored constants (`BCN_DIMS`, road `lanes×3.5`, `terrainBaker` margins, `DEFAULT_SIDEWALK_WIDTH`) self-correct under unstretch — left unchanged. Only the **car** (comment: "scaled to match visual" = eye-tuned) was scaled ×factor as one rigid object (chassis box XZ, track/wheelbase, wheel radius; Y untouched) so the projection change leaves it identical; true real-size re-author deferred to the FEEL GATE.
- **Two unit-correction islands purged:** `RampResolver` `cumulativeGroundDist` now measures in honest world coords (no local `cos(lat)`); `buildingRenderer` `MERCATOR_SCALE = cos(28.5°)` (Delhi leftover) deleted — UV repeat uses real-metre wall length directly.
- **Dead code deleted:** `tunnelTerrainCarver.js` (imported-but-uncalled, full of stretched-unit literals).
- **Full region re-bake required** (baked terrain/building positions are pre-converted to world; they come out real-metre only after re-bake). Re-bake + the parse-time factor are atomic — both, or the world splits.

**Revisit when:** the origin latitude changes materially (recompute the factor), or if sub-0.1% horizontal error ever becomes significant (switch to per-latitude / a local ENU projection).

---

## D-01: NaiveBroadphase Over SAPBroadphase

**Decision:** Use `CANNON.NaiveBroadphase` (O(n²)) instead of the faster `SAPBroadphase`.

**Rationale:** cannon-es `CANNON.Trimesh` bodies (used for terrain heightfields) produce infinite axis-aligned bounding boxes. `SAPBroadphase` sorts bodies along an axis; an infinite AABB corrupts the sort, causing random missed collisions and phantom collisions. After testing, switching to SAP caused the car to pass through terrain unpredictably in tiles adjacent to the current one.

**Mitigation:** Physics bodies are removed from the world when their tile is > 200m from the player (`physActive` check in `tileManager.js` LOD loop). This caps the active body count and keeps O(n²) manageable.

**Revisit when:** cannon-es is upgraded/replaced with a library (e.g. Rapier) that handles infinite-AABB bodies correctly in its broadphase, or when terrain uses a different collider shape that has a finite AABB.

---

## D-02: Single Tile Parser Worker (Not Pooled)

**Decision:** Use a single `tileParserWorker.js` instance for all tile network fetches and parsing, rather than a pool.

**Rationale:** The tile parser worker sits behind IndexedDB — cache hits are nearly instant (just a JSON.parse or binary read). Cache misses involve a `fetch()` call that is I/O-bound, not CPU-bound. Pooling would help CPU-bound work; for I/O-bound fetch, multiple workers would just queue on the same network stack. The geometry worker pool (separate) handles the actual CPU-heavy work.

**Trade-off:** Tiles cannot be parsed in parallel from the network. If two tiles arrive simultaneously (cache miss for both), the second waits for the first to finish parsing.

**Revisit when:** Profiling shows parser CPU time (not fetch time) is a bottleneck, or when the binary parser becomes significantly more expensive.

---

## D-03: `worldGroup.scale.x = -1` Mirror

**Decision:** Apply a mirror transform to `worldGroup` rather than transforming coordinates in every renderer.

**Rationale:** The Mercator projection maps `+X = east`. With standard Three.js camera orientation (looking down -Z), east should appear to the right (+X). However, slippy tile indexing and the original coordinate assignment made the map appear mirrored without this flip. Applying the mirror at the Group level was the lowest-friction fix — it required no changes to any of the 20+ renderer modules that generate geometry.

**Trade-off:** Creates a permanent split between rendering (worldGroup, scale.x=-1) and physics (CANNON.World, no worldGroup transform). Every physics body must manually negate X. This is a pervasive invisible invariant.

**Documented in:** [gotchas.md G-01](gotchas.md) and [coordinate-systems.md](coordinate-systems.md).

**Revisit when:** A major refactor changes how all renderers compute geometry. At that point it may be cleaner to negate X in `roadToWorld()` / `readFloat32Triples()` and remove the Group mirror.

---

## D-04: Physics Bodies Removed Beyond 200m

**Decision:** `CANNON.Body` instances for terrain, road decks, and barriers are removed from `CANNON.World` when the containing tile is > 200m from the player, and re-added when it comes back in range.

**Rationale:** NaiveBroadphase checks every body pair — O(n²). At 9 tiles × ~10 bodies = 90 bodies, that's 4050 pair checks per step. Bodies on tiles at the maximum load distance (UNLOAD_DISTANCE=3) can be 1.5 km away. Removing distant bodies reduces the active count to the physically relevant set (~3 closest tiles × ~10 bodies ≈ 30 bodies = 450 pair checks).

**Trade-off:** Re-adding a body to the world has a small cost (AABB computation, broadphase insertion). If the player oscillates near the 200m boundary, bodies get added/removed repeatedly. The `_ddInWorld` flag avoids redundant `world.bodies.includes()` (O(n)) checks.

**Revisit when:** Moving to a better broadphase (see D-01) would eliminate the need for manual body management.

---

## D-05: Pre-Baked Tiles (No Runtime OSM Fetching)

**Decision:** All map data is baked offline into binary files. The backend is a static file server with no runtime processing.

**Rationale:** Runtime OSM fetching (e.g., from Overpass API) is slow (seconds per tile), rate-limited (429s during rapid movement), and non-deterministic (map data changes over time). Pre-baking gives instant tile serving, consistent geometry, and allows expensive preprocessing (ramp detection, junction gore, terrain smoothing) that would be too slow at runtime.

**Trade-off:** Map data is frozen at bake time. OSM updates (new roads, renamed streets, new buildings) require a re-bake. Re-baking is expensive (10–30 minutes for the full region).

**Revisit when:** A CDN or pre-baked tile hosting service is available, or when delta-baking (only re-bake changed tiles) is implemented.

---

## D-06: 4-Phase Progressive Tile Build

**Decision:** Split tile geometry creation into 4 phases (terrain+roads → buildings → trees → grass+details) across multiple frames.

**Rationale:** Building a full tile synchronously would block the main thread for 200–800ms, freezing the game during tile transitions. Splitting across frames keeps each frame's build work within ~6ms (enforced by `yieldToMain()`), allowing smooth 60fps while tiles load incrementally.

**Trade-off:** Features appear progressively — roads come first, then buildings "pop in," then trees, then grass. This is noticeable but preferable to a multi-second freeze. Phase 1 is committed to `tileCache` immediately so road queries work before the tile is fully built.

**Revisit when:** GPU streaming (OffscreenCanvas + WebGPU compute) makes it feasible to build geometry entirely off the main thread and upload in a single GPU command, eliminating the need for frame-split yielding.

---

## D-07: Terrain Physics Uses Trimesh Not Heightfield

**Decision:** Terrain physics colliders are `CANNON.Trimesh` (triangulated mesh) rather than `CANNON.Heightfield`.

**Rationale:** `CANNON.Heightfield` requires a rectangular grid with uniform spacing. The terrain mesh is pre-carved at tunnel approaches (vertices pushed down) and has water areas zeroed out. These modifications break the uniform-grid assumption. Trimesh handles arbitrary geometry.

**Trade-off:** Trimesh collision detection is slower than Heightfield and produces the infinite AABB that forces NaiveBroadphase (see D-01). Heightfield bodies also have infinite AABBs in cannon-es, so this tradeoff does not worsen the broadphase situation.

**Revisit when:** Tunnel carving is pre-baked into a separate collision mesh rather than applied as a runtime modification to the visual terrain.

---

## D-08: No Dynamic PointLights for Streetlamps

**Decision:** Streetlamps use emissive material + a decal ground pool rather than dynamic `THREE.PointLight` instances.

**Rationale:** A typical tile has 30–60 streetlamps. Dynamic PointLights each require shadow maps and per-light shading calculations. At 9 active tiles × 45 lamps, that's 405 potential PointLights — far beyond what any real-time renderer can handle without performance collapse.

**Visual compromise:** The emissive lamp material blooms under `UnrealBloomPass`, creating a convincing glow. The circular decal pool simulates the lit road surface. Without real PointLights, nearby geometry (building facades, passing cars) is not dynamically lit by streetlamps.

**Revisit when:** Clustered lighting / tiled deferred rendering is available in Three.js, making hundreds of small-radius point lights feasible.

---

## D-09: 6ms Frame Budget for Tile Work

**Decision:** The `yieldToMain()` function uses a 6ms budget before yielding to the browser.

**Rationale:** At 60fps, each frame takes ~16.7ms. A typical frame's render pass takes ~8–10ms (geometry, shadows, post-processing). Leaving 6ms for tile work gives ~2ms margin. The budget is checked at coarse granularity (between build phases), not at per-vertex level, so individual "chunks" can slightly exceed 6ms without breaking.

**Revisit when:** `scheduler.postTask()` becomes universally available and allows finer-grained priority control without `requestAnimationFrame` round-trips.

---

## D-10: Road Deck Colliders Are CANNON.Box Per Segment, Not Trimesh

**Decision:** Road bridge/tunnel/ramp deck physics use one `CANNON.Box` per road segment (yaw+pitch rotated to match slope), not a Trimesh of the visual road ribbon.

**Rationale:** Trimesh colliders were tried first. `RaycastVehicle` wheel rays have a `skipBackfaces` flag that, combined with near-flat geometry (road ribbons are very thin), caused rays to miss the trimesh entirely (rays hit the back face instead of the top face). Box shapes have well-defined normals and are not susceptible to near-flat Trimesh issues. Box shapes also build and update faster.

**Trade-off:** Box colliders approximate the road surface; there is no per-vertex elevation matching. Bumpy road surfaces (e.g., on ramps) are represented as the average slope, not the exact profile. The car may experience slight "stepping" at segment boundaries on long ramps.
