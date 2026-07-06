# Changelog

Running log of changes. Append an entry at the top for every session. For structural/architectural changes, also update the relevant `/docs/context/` file. For trivial fixes, a one-line entry here is sufficient.

Format: `YYYY-MM-DD — description`

## 2026-07-02 — Pedestrians (real low-poly, walk-cycle flipbook, knockdown) + car width
- **Pedestrians = real low-poly people** (Poly Pizza rigged GLBs: man/woman-casual/woman-dress/punk/adventurer, in `public/models/people/`). Rigged models can't be instanced, so `carModels.loadWalkFramesTemplate` BAKES each character into N=8 static walk-frames + 1 idle pose (evaluate an animation frame via AnimationMixer.setTime + SkinnedMesh.applyBoneTransform, bake material colours → vertex colours, merge). `pedestrians.js` runs a **flipbook**: one InstancedMesh per (character × frame) + idle; each ped cycles frames by a speed-scaled phase → legs move while staying instanced/light. Crowd ~110, sidewalk-assigned, ground sampled on centerline.
- **Pedestrian knockdown** (GTA-style, no physics bodies): distance check vs the car centre (HIT_RADIUS 2.6 m, > 6 km/h) flips a ped to a `thrown` projectile — launched away+up (∝ speed), tumbling under gravity, lands, lies LIE_TIME then clears. ~30 lines in pedestrians.js; main.js passes `speedKmh` to `pedestrians.update`.
- **Prior pedestrian attempts REMOVED** (Kenney Blocky = style clash; Kenney animated FBX = too heavy). Added dep **`fflate`** (FBXLoader needs it) — still installed even though FBX path was dropped.
- **Kenney car width** 0.85 → **0.95×** (were too thin); height stays 0.82×. Both merged (parked) + scene (traffic) loaders.
- Dead code note: `carModels.js` still has the unused Blocky loaders (loadCharacterTemplate/loadPeopleTemplates/loadStaticPersonTemplate) — harmless, safe to prune later.

## 2026-07-01 — Kenney cars: fixed the white/no-detail (missing external texture)
The Kenney GLBs reference an EXTERNAL `Textures/colormap.png` (image has no bufferView/mimeType — uri only). Only the .glb files had been copied, so every car 404'd its texture → rendered flat white. Fix: copied `colormap.png` to `frontend/public/models/cars/Textures/`. Now windows/head+tail lights/body colours render. Traffic uses full-detail scene clones (carModels.loadCarSceneTemplate); parked cars use the merged InstancedMesh path (carModels.loadCarTemplate) with baked vertex colours (wheels forced black) + per-instance tint for body variety. `car/carModels.js` is the shared loader. Also: non-uniform squash (W×0.85, H×0.82) + ~3.8 m length so the chunky Kenney proportions read as cars; MAX_CARS 16 (5-mesh detail clones).

## 2026-07-01 — Real low-poly cars (Kenney Car Kit) for traffic + parked (frontend)
Added `car/carModels.js` — loads a Kenney Car Kit GLB (public/models/cars/*.glb, CC0), merges body+wheels into one geometry (shared atlas material), scales to 4.4 m, orients length→+Z, recentres wheels-at-0. `loadCityCarTemplates` loads the city set (sedan/suv/van/taxi/police/delivery/…). Parked cars (`parkedCars.js`) now use one InstancedMesh PER variant (deterministic distribution → variety, ~9 draw calls). Traffic (`trafficSystem.js`) clones a random variant per car (shared geo+material → cheap; MAX_CARS 18→24). Player keeps the BMW. Also this round: parked-car density cut (SPACING 6.6→14, ~45% empty slots, deterministic/stable), building colliders → oriented boxes (fix invisible walls on angled Diagonal buildings), no parking in junctions, traffic brakes when the lane ahead is blocked (player/other car), pedestrians cache ground-Y (fixes the 40 FPS drop), parked-car height sampled on-centerline (fixes cars sunk under the road).

## 2026-07-01 — "Make it a game" Phases 1–3 + city life (all frontend)
- **Phase 1 Sound:** engine RPM/exhaust/crackle/screech already existed + wired (carDriver→carSound). Added to carSound.js: city-ambience bed, speed-driven wind, collision thud (sharp single-frame speed drop).
- **Phase 2 Car feel & camera:** carCamera.js camera shake (impact punch on speed drop + high-speed rumble; shake offset added/removed each frame so it doesn't accumulate). **Collision fix (the big one):** tree/pillar colliders were created with NO collision group → defaulted to GROUND, which the chassis mask (WORLD|TERRAIN) filters out → drive-through. Set them to WORLD/VEHICLE. **Buildings had no colliders at all** → added `buildBuildingColliders` (footprint-AABB box per building, batched, WORLD group, streamed in/out with the tile). Car now collides with trees + buildings.
- **Phase 3 AI traffic** (`car/trafficSystem.js`): kinematic NPC cars following loaded road centerlines (right lane), static box collider (WORLD/VEHICLE) so the player hits them, pool of 18, spawn 32–185 m, despawn 240 m. Uses the SAME BMW GLB as the player (loaded once, cloned + recoloured per car, recentred wheels-at-0). Wired in main.js (physics-frame, player pos = lp.lx/lz). getLoadedRoadSegments now also returns width+oneway.
- **City life:** `car/parkedCars.js` (InstancedMesh, 900 cap, both curbs, rebuilt on >35 m player move, visual-only v1), `car/pedestrians.js` (InstancedMesh, 140 cap, walk sidewalks back-and-forth with bob). Config: ENABLE_TRAFFIC / ENABLE_PARKED_CARS / ENABLE_PEDESTRIANS (all true).
- **Atmosphere:** vegetationWorker foliage greens lightened (0x4F7D42→0x6E9A4C + palette) — airier street trees, not a dark forest. Day fog eased (0.007→0.0052, lighter warmer colour) so the city stays crisp.
- **Spawn → Avinguda Diagonal** (41.3948, 2.1602) — wide central avenue.
- Silenced the per-tile `[Tile] Phase1` console spam (behind `window._ddTilePerf`).

## 2026-07-01 — Church detail, city-polish flags, building cornice/brick (all frontend)
- **Church massing (buildingWorker.js religious block):** bell tower built from `makeBoxGeom` (the `createCylinderFull` tower rendered dark — box primitive lights correctly); cornice bands + tall window slots per tower face; tapered slate spire + 4 corner pinnacles + cross; buttresses along long walls; rose window (`createOrientedDisc`) + arched portal on the longest facade edge; small CAPPED central fléche. Tower placed 55% from centroid→bbox-corner (a raw bbox corner can fall outside an irregular footprint → floating tower+cross) and tower height capped (`towerExtra` 7–14 m) so tall parts don't spawn a 50 m floating-cross spike. Religious FACADE+ROOF palettes → sandstone/grey-stone + dark slate (was bright red). **Gabled-roof attempt REVERTED** — a bbox gable becomes a giant tent over a huge complex footprint (Sagrada Família). `meshMaterializer` shikhara material → warm sandstone (0xCAB695).
- **Spawn → Sagrada Família** (`spawnConfig.js` 41.4036, 2.1744).
- **City-polish flags (config.js):** ENABLE_TRAFFIC_LIGHTS, ENABLE_SIDEWALKS, ENABLE_ROAD_EDGE_DETAIL, **ENABLE_STREETLIGHTS** → true. ENABLE_DAY_NIGHT left **false** (the fixed warm lighting reads better; the auto-cycle's day went grey). Procedural-infill stays off (Delhi-era).
- **Night de-faded (`ui/envToggle.js` NIGHT preset):** ambientIntensity 1.6 → 0.75 (the 1.6 flat flood — added to compensate for streetlights being OFF — washed the city grey), exposure 1.1 → 1.0, moonlight 0.25 → 0.30, lampEmissive → 5.0. Streetlights now light the streets so the night reads dark+moody.
- **Building detail (buildingWorker.js):** industrial FACADE_PALETTE → Poblenou red brick; uniform cornice lip (projecting roofline) on all masonry edges via balconySlabGeoms.
- **Phase 3 (terrain/tunnel rework) marked DONE** in the rework tracker.
- **Slice ③ floor validator → COMMIT-BLOCKING (locked in).** The 5 layer-1 floor-gap roads (terrain rising 3.6–8.3 m through the roadway — mis-tagged tunnels) identified via `DISTINCT_FLOOR_GAP_ROADS` report dump: `18524460, 1394468622, 18520976, 1394468619, 123268593`. Added `KNOWN_FLOOR_GAP_ROADS` set in buildRegion.js → dropped at the payload.roads chokepoint (accept-the-gap) + passed as the validator `whitelist`. Default flipped to **block** (`TRENCH_VALIDATOR=report` to bypass). Confirm bake: `[FloorGap] dropped 5` + `[FloorValidator] ✅ 0 violations`, exit 0. Future carve regressions now hard-fail the bake. **Tiles regenerated** — run `window._clearTileCache()` + hard reload to drop the 5 broken roads.

## 2026-06-30 — Barcelona building redesign: PORTED to the worker (the real generator) — ⏳ verifying
CRITICAL: buildings are generated in the Web Worker `frontend/src/workers/buildingWorker.js` (geometry) + `meshMaterializer.js` (materials/window textures). `map/buildingRenderer.js` is DEAD reference code — editing it had zero effect (the audit agent missed the worker path; CLAUDE.md notes buildings are offloaded to workers). All the Barcelona changes below were re-applied in the worker + materializer: warm FACADE_PALETTES, generic→residential default + no height→glass, ENABLE_DELHI_DETAILS=false (water tanks/shikhara/AC/billboards/boundary-walls/setback), BALCONY_CATEGORIES (residential/commercial/office), WINDOW_STYLES Eixample rhythm, shopfront ground floors, lightened sky-glass windows (drawRecessedWindow + curtain-wall), church block (shikharaGeoms tower + flagPoleGeoms slate spire + templeBandGeoms cross via createCylinderFull/makeBoxGeom), shikhara material → warm sandstone. Vite-verified serving the new worker. (buildingRenderer.js carries the same edits for parity but is unused.)

## 2026-06-30 — Barcelona building redesign (frontend, no re-bake) — superseded: edits were in dead code
Systematic per-type rework of `buildingRenderer.js` from Delhi-flavoured generic blocks → Barcelona Eixample masonry. Classification (OSM type → category) preserved; only the LOOK changed.
- **Palettes** warmed for all categories (cream/ochre/sandstone/pale-yellow/rose/warm-stone); cold blue-greys + dark glass gone. `commercial_glass` lightened and gated to explicit glass tags only.
- **Killed the glass-office default:** generic/untagged buildings → warm `residential` masonry (was `commercial`→glass); removed the `height≥18→commercial_glass` auto-conversion (the root cause of dark-tower city).
- **Delhi ornament removed** via `ENABLE_DELHI_DETAILS=false`: perimeter boundary walls+gates, driveway SETBACK, Hindu shikhara/kalasha/flag, rooftop ad-billboards, upper-floor AC clutter, garage-shutter ground floors.
- **Ground floors → Barcelona shopfronts** (glazed bays + fascia sign band).
- **Wrought-iron balconies + floor bands** extended from residential-only to `BALCONY_CATEGORIES` (residential/commercial/office).
- **Window rhythm → Eixample:** WINDOW_STYLES retuned to tall ~2 m French-window openings at ~3 m floor period (aligns painted rows with the 3 m 3D balconies) + taller ~3.5–4 m ground floor for shops.
- REMAINING (next passes): uniform 3D cornice on all masonry (parapet currently commercial-only); industrial→Poblenou brick; religious→church massing; chamfered corners (`xamfrans`, bake-side).

## 2026-06-30 — Lane lines on trench roads + floating-vegetation cull (both frontend, no re-bake)
- **Missing lane markings on Ronda de Dalt / trench roads:** `roadRenderer.js:1038` skipped markings for ANY `road.tunnel` (Delhi-era guard). With Option-L daylighted trenches the corridor is a normal asphalt deck → its paint was suppressed. Now only skips fully-COVERED tunnels (`tunnel && layer >= 0`); `layer<0` daylighted corridors get proper center/lane/edge lines (heights already in the baked frame +0.03 m, no z-fight).
- **Floating trees/stones (images 11/12):** the vegetation WORKER's `fastElevationAt` CLAMPED out-of-tile samples to the high edge elevation, so baked roadside trees + clusters scattered onto neighbour-tile overhangs (long Ronda de Dalt ramps; Tibidabo slopes) hung in mid-air. Fixed at the sampler: returns NaN beyond OOB=3 cells outside the tile DEM footprint; all 7 veg builders (tree/shadow/bush/zone-tree/zone-bush/grass) cull non-finite Y to a zero-scale (invisible) instance. Covers every veg path (the earlier cluster-renderer guard only covered the main-thread cluster path).

## 2026-06-30 — City restore + skip broken-ramp roads (vibe > survey accuracy) — ⏳ verifying
- **City un-stripped:** `ENABLE_BUILDINGS`/`ENABLE_TREES` → true (config.js). Buildings + trees render on the finished terrain (no re-bake — tile data already carried them). Scale audited & correct: car 4.79 m (real M3), residential road 10 m, trunk 26 m, trees ~9 m tall — proportions right; the "trees feel big" is density + canopy overhang + trees-on-road (placement, NOT scale). Trees-on-road follow-up open (mask doesn't exclude multi-level/elevated road footprints).
- **Broken-ramp road skip (user-approved direction):** mangled half-ramp roads are DROPPED at the bake rather than rendered. FIRST tried a PROFILE-grade>0.20 heuristic → dropped **608 region-wide** (over-aggressive: caught legit steep ramps/short bridges; no clean grade cutoff exists). SWITCHED to RampResolver's PRECISE flag: `flattenedShortTunnel && !flat` (the exact Case-C case it gave up fitting a dip for — a steep monotonic connector between surface roads at different layers). Plumbed as `road.brokenRamp` through RampResolver→RoadGeometryBuilder→deepCloneRoad→tileSplit×2 (the four-whitelist pattern). `isBrokenRampRoad`: drop if `brokenRamp` OR profile grade > 0.60 (backstop for one-sided near-vertical cracks only); EXCLUDES drivable below-grade tunnel corridors (trench-carved). Filtered at the `payload.roads` chokepoint. Focused bake: **10 dropped** (vs 29 grade / 608 region) — surgical. Knob: `BROKEN_RAMP_GRADE` env (backstop only).
- **Trees-on-road fixed at source:** `vegetationBaker.js` AND frontend `vegetationMask.js` were SKIPPING tunnel/layer<0 roads when stamping the no-veg mask → trees/bushes landed on daylighted trench corridors and multi-level roads ("trees on the road where one is above"). Both now block EVERY road footprint (minor cost: thin no-tree strip over deep sealed tunnels). Also fixes bushes-in-trench.
- **Floor validator (slice ③) now CLEAN in the focused area** (0 violations) after the min-cell + asymmetric + layer-scope fixes — full-region confirm pending to flip to hard-block.
- All three (broken-ramp skip, tree mask, floor confirm) bundled into one full re-bake.

## 2026-06-30 — Phase 3 slice ③: commit-blocking floor validator in the bake — ⏳ confirming
New `backend/worldBuilder/terrain/validateTunnelFloors.js` + wired into buildRegion.js (collect per tile right after `carveTrenchesIntoGrid` with the DRAPED roads; report+throw after the tile loop). Enforces the keystone invariant **drivable-surface-implies-floor**: each drivable tunnel road (layer<0 whitelist) sampled @2m must have the carved grid within tolerance of `roadY − FLOOR_BELOW_ROAD(0.15)`. Default **commit-blocking** (throws, non-zero exit); `TRENCH_VALIDATOR=report` downgrades to a warning for diagnosis.
- **Check is ASYMMETRIC** (key correction): only flags grid TOO HIGH (`gridY − expectedFloor > 0.3` = terrain intruding above the roadway). A grid BELOW the floor is still a floor (carved deeper, e.g. overlapping deeper corridors cut shared cells) — safe, not flagged. Symmetric `abs()` falsely flagged 2346 deeper-carve samples → asymmetric drops to ~1 borderline.
- Tolerance 0.30 m LOCKED (design §5). Forward check only; the inverse clause (surface roads floating over a trench footprint; 2 native-dip roads 23792470/34099200) is a recorded follow-up, out of this check's scope.
- Focused-area report: 1 violation @0.49m (layer-1, near the bbox clip edge). Running a FULL-region report to get the true count before flipping the committed default to blocking.

## 2026-06-30 — Trench dressing RESOLVED at the source: wide smoothstep batter, walls off ✅ (user: "i like it")
The frontend wall iterations (overlap → sawtooth → giant slab → median fins → jutting block) were whack-a-mole on a noisy carved surface. User chose the bake-side fix. Done:
- **`trenchAuthor.js`**: `BATTER_WIDTH` 8→14 m + new `smoothstep()` easing in the carve AND the matching `flagFloatersOverCarve` prediction (kept consistent so floater flags still mirror the actual surface). The trench wall is now a wide S-curve graded slope (~4 grid cells, real-cutting look) joining floor and natural terrain with zero slope at both ends → the 3.6 m sawtooth is gone at the source. AABB prefilter margin in `buildTrenchCorridors` widened to reach `halfW+BATTER` (else wide-batter cells fall outside the candidate window and never cut). Min-only and floor (`FLOOR_BELOW_ROAD`) unchanged → drivable floor + deck colliders intact.
- **Frontend trench walls DISABLED** (`tileManager.js`): the graded terrain IS the clean trench, so `buildTrenchRetainingWalls` is no longer called (kept in source). Removes every wall artifact in one move.
- Focused re-bake of the spawn trench area (75 tiles, 269 s) verified on screen by the user. **Full-region re-bake running** to make the whole city consistent and remove the focused-area seam.
- Knob: `BATTER_WIDTH` (gentler/steeper vs how much terrain it eats). `buildTrenchCliffWalls`/`buildTrenchRetainingWalls`/`buildTrenchPortals` all remain in source, uncalled.

## 2026-06-30 — Trench walls → SMOOTH median-aware + floating-vegetation fix (superseded by the bake-side fix above)
On screen: smooth walls + grounded bushes both confirmed working; the wall over-grew into a giant slab on a hillside cut (probed bank top = hilltop 20 m+). Added TRENCH_WALL_MAX_RISE=7 m cap (tunnelRenderer.js) → bounded realistic retaining wall, natural slope above. Knob to tune.
Two fixes, both frontend-only, no re-bake:
- **GRID CLIFF WALLS REJECTED (sawtooth).** The grid-edge approach put a panel on every grid step, so it traced the carved sawtooth instead of hiding it — on screen it was two jagged zigzag walls. Replaced with a SMOOTH, MEDIAN-AWARE `buildTrenchRetainingWalls` (tunnelRenderer.js): walls follow the road edge (smooth, not the grid) from deck to probed bank-top (+0.4 m cap), and a new `facesMedian()`/`buildTrenchSegList()` test SKIPS any side within MEDIAN_LOOK (22 m) of a parallel carriageway — so the inner walls that used to overlap into a grey mass are never built. Outer banks only. `buildTrenchCliffWalls` left in source, uncalled. Rewired in tileManager.js.
- **Floating bushes FIXED.** Root cause (agent-confirmed against disk tiles): cluster centers are scattered across a bbox built from road/building points that include CLIPPED roads overhanging the tile by 200-460 m (long Ronda de Dalt ramps); `getElevationAt` then CLAMPS those out-of-tile samples to the edge elevation, so on the hillside the bushes hang at a constant high edge value while the neighbour tile draws the terrain lower downhill = a horizontal line of bushes in the sky. Fix (environmentClusterRenderer.js): skip any cluster item whose worldToLatLon falls outside the tile's own `elevation.{south,north,west,east}` footprint (that ground belongs to the neighbour tile, which plants its own veg). NOT grid-vs-baked divergence (refuted: baked visual ≡ elevations grid byte-for-byte; trench carve is in both).
- Secondary veg bug NOTED (not yet fixed): vegetationMask skips tunnel/layer<0 roads, so daylighted trench corridors aren't stamped blocked → some bushes grow IN the trench. Separate from the floaters.

## 2026-06-30 — Trench dressing redesign: GRID CLIFF WALLS (the polished one-time fix) — superseded same day (sawtooth)
Replaced the per-road both-sides retaining walls (which overlapped into a grey mess on stacked carriageways and never matched the jagged carve) with `buildTrenchCliffWalls(elevation)` in `tunnelRenderer.js`, wired in `tileManager.js` (gated ENABLE_RETAINING_WALLS, tracked on `entry.trenchWallMesh`). Mechanism: scan the carved terrain grid (`elevation.elevations`, the same source as the heightfield/getGroundY); wherever two adjacent grid cells differ by ≥ CLIFF_MIN_STEP (2.0 m, ≤ CLIFF_MAX_STEP 40 m) stand a vertical concrete panel on that grid edge using the exact buildTerrainMesh world mapping (x linear in lon, z per-row via latLonToWorld; y=(raw−offset)·vertExag). Why this is the right fix:
- **Median-aware by construction** — a flat median between parallel carriageways has no step → no wall, so the grey-overlap mess is impossible (each grid edge dressed exactly once).
- **Occludes the sawtooth** — the jagged earth step is replaced by a clean vertical panel sitting on the grid edge.
- **Caps the exposed cliff** under crossing streets so the daylighted trench reads as a walled cut (the "road ends over a cliff" complaint).
- Co-framed with physics (≤0.01 m per D-16), visual-only under worldGroup (auto X-mirror, latLonToWorld coords — no manual negation), no re-bake.
- Knobs: CLIFF_MIN_STEP (raise to dress fewer/only-major cliffs), CLIFF_MAX_STEP. Could not self-verify on screen (automated tab is `visibilityState:hidden` → rAF-throttled, load stalls); awaiting user drive-test in a foreground tab. `node --check` clean.
NOTE: `buildTrenchRetainingWalls`/`buildTrenchPortals` remain in source but UNCALLED (kept for reference); the cliff-wall pass supersedes them.

## 2026-06-30 — Trench retaining walls DISABLED (confirmed on screen) — grey-plane mess gone
After reverting the coping/portals the grey-plane mess REMAINED → root cause was the pre-existing `buildTrenchRetainingWalls` itself: per-road both-sides vertical walls on the stacked Ronda de Dalt carriageways overlap into a chaotic grey mass. Commented out the `buildTrenchRetainingWalls` call in `tileManager.js` (function kept for a median-aware redesign). Verified on the rendered screen (own tab, FPS 118 after interaction un-throttled it): trench at lat 41.4088 Ronda de Dalt now shows clean carved terrain + descending carriageways, NO grey planes. Remaining: terrain sawtooth on the cut edges (3.6m grid aliasing — separate Phase-4 item) and the inherent multi-ribbon look of the trunk. Note: the trench is now visually undressed (raw earth banks); a future median-aware wall pass should dress only the OUTER bank of a carriageway group.

## 2026-06-30 — Slice-② feedback round 2 follow-up: REVERTED the two visual additions (#3 coping/cap, #4 portals)
User drive showed the outward coping ledge + portal frames overlapping in the MEDIAN between Ronda de Dalt's parallel carriageways → dark triangular "tent" mass down the middle. Both were unverifiable on my end (backgrounded-tab rAF throttle) and clearly backfired. Reverted:
- `buildTrenchRetainingWalls` (`tunnelRenderer.js`) restored to the prior vertical-wall-only form (PROBES [6,10,14,18], MIN_RISE 0.4, no cap, no coping). The sawtooth returns but no median mess.
- `buildTrenchPortals` call disabled in `tileManager.js` (function + import left in place for a future median-aware redesign).
- KEPT: #1 black-pillar fix (trench-corridor pillar skip + emissive) and #2 streaming-jump fix (heightfield-first). Those are the solid wins.
- Lesson: trench dressing must be median-aware (only dress the OUTER bank of a carriageway group, not every road's both sides). Revisit when an on-screen-verifiable path exists.

## 2026-06-30 — Slice-② drive-feedback round 2: black-pillar mass, streaming jump, trench-wall sawtooth, undefined portal (⏳ pending on-screen gate)
User drive of the Ronda de Dalt ramps surfaced 4 defects; diagnosed read-only (3 parallel agents) then fixed. ALL frontend-only, no re-bake. **Not yet confirmed on screen** — my verification tab was rAF-throttled in the background (spawn tile Phase1 logged 203 289 ms wall / 140 ms work = the cooperative loader starving while the tab is hidden), so the scene never finished loading for me to screenshot. Code verified via `node --check` + runtime tile log (spawn tile completed Phase1 `tunnels+setup:11.7ms` with no exception). Awaiting user drive-test.
- **Black floating slab (Image #2) = bridge PILLARS, not a deck.** Real `bridge=yes` crossing streets build pillars whose bottom samples `getElevationAt` — now the deep trenched grid → 10–15 m Lambert columns sunk in the trench, near-black when occluded. The changelog's earlier "pillars got crossesTrench" claim was wrong; the slice-② carve resurrected pillars that used to be ~0 m. Fix (`roadRenderer.js`): new `buildTrenchCorridorSegments` + skip in `buildBridgePillarMeshes` for any pillar landing inside a tunnel-road corridor (roadHalf + 12 m, covers TRENCH_MARGIN 4 + BATTER 8); pillar material gets `emissive 0x35322f` so it can never render pure black.
- **Streaming "jump where roads emerge" = late ground collider.** Heightfield was built AFTER the slow visual `buildTerrainMesh` + its `_perfYield` chain, so a car reaching a still-loading tile free-falls onto the −50 m plane → collider added under the penetrating chassis → impulse shove. Fix (`tileManager.js`): moved the Heightfield build+`addBody` to run FIRST in the terrain block (depends only on `elevation`+`key`), shrinking the groundless window.
- **Sawtooth trench walls (Image #1).** `buildTrenchRetainingWalls` (`tunnelRenderer.js`): MIN_RISE 0.4→0.12 (continuous, no gaps), denser probes [4,7,10,13,16,19], top raised TRENCH_WALL_CAP 0.5 m proud of the bank so grid-stepped earth can't poke over the straight top, + new horizontal coping ledge (TRENCH_WALL_COPING_OUT 2.5 m) burying the jagged cut edge behind a flat shelf.
- **Undefined tunnel entrance.** New `buildTrenchPortals` (`tunnelRenderer.js`, wired in `tileManager.js` next to the trench walls, gated by ENABLE_RETAINING_WALLS, tracked on the tile entry for cleanup): concrete headwall + portal lintel framing the carriageway where the road first drops PORTAL_ENTER_DEPTH (3 m) below the probed natural bank — terrain-relative (no absolute-Y, G-47 clean), the cut-and-cover mouth look for the Option-L open trench. Most experimental of the four; easy to disable if it reads wrong.

---

## 2026-06-10 — Production terrain pipeline: BILINEAR DEM sampling + 128-grid mesh (kill the terraced "boxes")

User reported the terrain looked fake — a regular grid-aligned stair-step / quilted pattern, and roads sinking
into it. Root cause: `demLoader.sampleElevation` used **nearest-pixel** sampling (`Math.floor`), so the fine
mesh snapped many vertices to the same coarse ~30 m DEM pixel → flat patches + hard steps (terraces). Fixes:
- **Bilinear DEM interpolation** (`demLoader.sampleElevation`) — interpolate the 4 surrounding DEM pixels
  (NoData-aware) → continuous natural surface, no terraces; roads (sampled the same way) conform.
- **Terrain mesh 64 → 128** (`terrainBaker GRID_SIZE=128`, `CONFIG.TERRAIN_MAX_GRID=128`) — full DEM grid, no
  downsample; mesh = getElevationAt = baked roads, all one surface. Budget freed by stripping non-essentials.
- Kept the global DEM box blur (`smoothRaster`, env `DEM_SMOOTH_RADIUS/ITERS`) for gentle relief.
Also (debugging aid): CONFIG stripped to terrain + road surface + bridges/tunnels/ramps only (buildings,
vegetation, urban features, carts, barriers, road infra, water, markings, etc. OFF). Re-bake required.

## 2026-06-10 — Terrain-as-truth: smoothing + bake-draped roads SHIPPED; heightfield-only physics REVERTED (D-16)

Net result after iteration: **smoothing (Stage A) shipped**, **roads drape via the bake** (baked at the smoothed
DEM → conform to the smoothed terrain), **physics simplification reverted**.
- Kept: `demLoader.smoothRaster` (global DEM box blur, env-tunable). Roads use the baked fast path (now baked at
  smoothed DEM, so they drape).
- Reverted (regressed): the runtime road drape (`getRoadPointHeights` surface branch + disabling the baked
  fast path) caused spiking ribbons (forced-runtime bridges/tunnels dove underground); and the heightfield-only
  physics + dropping surface-road colliders trapped the car BELOW the terrain (heightfield orientation). Physics
  back to visual-aligned Trimesh + chassis mask WORLD + original road-collider gate. See D-16 status note.

## 2026-06-10 — (superseded by the line above) Terrain-as-truth pivot attempt: drape + heightfield-only physics

Architectural pivot (user-driven) that resolves the road-vs-terrain / fall-through tangle at the root.
- **Stage A (bake):** `demLoader.smoothRaster` — separable NoData-aware box blur over the global DEM at load
  (env `DEM_SMOOTH_RADIUS`/`DEM_SMOOTH_ITERS`, default 2/2). Global pre-smooth → gentle + seamless hills
  (both visual mesh and physics heightfield read the smoothed grid). Re-bake required.
- **Stage B (render):** `roadRenderer.getRoadPointHeights` — surface roads (layer 0, not bridge/tunnel/ramp)
  now drape on the terrain (sample `getElevationAt`, ignore baked `p.elevation`); all road features cascade.
  Baked road fast path disabled (`USE_BAKED_ROAD_FASTPATH=false`) so surface ribbons build at runtime + drape.
- **Stage C (physics):** `tileManager.createRoadTrimeshColliders` gate → `if (!isBridge && !isTunnel &&
  !isRamp) continue;` — surface roads get NO collider; they ride the terrain heightfield. Only
  ramps/tunnels/bridges keep structural colliders.
Net: roads conform exactly to terrain (no float/z-fight, junctions meet at one height); one heightfield is the
drivable surface (wheels grip, no fall-through); surface-road collider class eliminated. See D-16, G-49.

## 2026-06-10 — Off-road fall-through, part 3 (FIX): chassis body-collision backstop on terrain (G-49)

The heightfield attempt (part 2) still fell — its untested world→physics transform misplaced the collider. Reverted.
Final fix uses what's PROVEN: the visual-aligned terrain Trimesh (runtime gap = 0.00 m) in group TERRAIN(16), and
the car chassis now collides with it (`chassis.mask = WORLD | TERRAIN`). Ray-vs-trimesh misses (D-10), but
BOX-vs-trimesh narrowphase is reliable, so the chassis box catches the car instead of free-falling. Own group keeps
the chassis off the road-deck GROUND boxes (no edge-seam stutter); box bottom rides ~0.1 m above the surface so it
only engages once wheels lose contact. Limitation: wheel rays still miss the trimesh → no off-road wheel
suspension/traction (car rests on chassis, can't drive far onto terrain); roads remain the gameplay surface. See G-49.

## 2026-06-10 — Off-road fall-through, part 2: terrain physics switched Trimesh → Heightfield (G-49)

After the alignment fix (below) the collider was provably correct (gap 0.00 m) yet the car STILL free-fell
off-road. Live probes (window._debugVehicle/_debugWorld) showed wheels over terrain `inContact=false` and manual
`world.rayTest` over terrain returning MISS while rays over road boxes HIT — i.e. cannon-es `rayTest` can't hit
our `CANNON.Trimesh` (fragile octree rayQuery; same reason roads are boxes, D-10), and the chassis doesn't
collide with ground by design (ground = wheel rays only). Fix: terrain physics now uses the pre-existing-but-
unused `buildTerrainHeightfield` (`CANNON.Heightfield`, group TERRAIN=16) instead of `createTerrainTrimesh`.
Heightfields raycast via direct grid lookup → wheel rays hit reliably → car drives on terrain, no fall-through.
Same 64-grid + `(y-offset)*vertExag` as the visual mesh (co-framed); caller applies the world→physics X-negation.
Trimesh kept as fallback only. Heightfield can't carve tunnel pits (Stage 3; spawn tunnel-free). See G-49.

## 2026-06-10 — Fix off-road fall-through: physics terrain now uses the VISUAL baked mesh (G-49)

User report: driving off-road = falling through terrain. Live probe (window._debugWorld): terrain collider
present, up-normals, GROUND group — but the trimesh surface under the car was ~8.7 m ABOVE the car. Root:
physics terrain was baked at PHYSICS_GRID 32 while the visual mesh is GRID_SIZE 64; on Montjuïc's steep slopes
the two sampled different DEM cells, so the collider sat metres off the drawn surface. The chassis doesn't
collide with ground (by design) — only the short (~1 m) RaycastVehicle wheel rays do — so the wheels missed the
displaced collider and the car fell. Fix: `createTerrainTrimesh` now prefers `bakedTerrain.positions/indices`
(the visual 64-grid mesh) over `bakedPhysicsTerrain`, with the same `(wy−offset)·vertExag` transform → collider
byte-identical to the visual surface. Render-side, **no re-bake** (reuses existing baked visual verts). See G-49.

## 2026-06-09 — Consolidation: documented the Stage-2 elevation-pipeline fixes (ADRs D-13/14/15, gotchas G-46/47/48)

Doc-only pass (no game code changed) capturing this session's elevation fixes before Stage 3, with verified
current state:
- **D-12** extended: single offset enforced at every consumer (no `tileMinElevation` branch anywhere),
  gated by `whenElevationOffsetReady()` + fail-fast `assertElevationOffsetResolved()`; consumer sites listed.
- **D-13**: `useBaked` is the live terrain path — `TERRAIN_MAX_GRID=64` must equal bake `gridSize=64`, else
  the buggy runtime fallback (water cones) silently renders while fixes target the baked mesh.
- **D-14**: road DEM-drape writes `p[3]` (serialized elevation field), not `p[1]`; road height is now
  terrain-inclusive → CRITICAL coupling: height thresholds must use above-terrain / structural, never absolute.
- **D-15**: bridge detection gates on structural flags (bridge/layer/isRamp) + above-terrain, not normalized height.
- **G-46**: parser `{x,y}` object data-shape contract (greens/parking fixed; flagged residual at parkingRenderer:82).
- **G-47**: the "fine at terrain≈0, wrong with real DEM" failure class — catalogue of instances.
- **G-48**: required verification checklist (identify rendered object → log runtime value → verify on screen →
  full reload/fresh bundle → never trust a report over the screen).

## 2026-06-09 — Standardize ground anchoring across ALL world-placed renderers (G-45)

Deep sweep after the user reported walls/barriers, washrooms, vendor carts and tunnel gates still
floating. Root: these were the only placed-mesh renderers tileManager called WITHOUT an elevation
function — they hardcoded `makeTranslation(wx, 0, wz)` (Y=0: floats below-spawn, buries above-spawn) or
read raw absolute `road.points[].elevation` (floats +offset). Fix: tileManager now defines a canonical
`getGroundY(wx,wz)` (normalized terrain render-Y) and passes it to barrier, tunnel (all 4 builders),
urbanFeature and vendorCart renderers.
- urbanFeature / vendorCart: `makeTranslation(wx, getGroundY(wx,wz), wz)`.
- barrier: per-vertex `drapeToGround` post-pass (geometry is world-X/Z + local-Y) — matches the
  per-segment ground Y the colliders already used.
- tunnel: `_normTunnelElev` (offset-normalize) for road-anchored Y; `getGroundY` for surface constants
  (`topY/surfY/botY`); skip/threshold tests made terrain-relative (`elev > groundY−k`, was absolute
  `−0.5`/`0`). Deep tunnel-enclosure depth/skip correctness remains Stage 3.
Render-side, no re-bake. See gotchas G-45 (umbrella), siblings G-43/G-44.

## 2026-06-09 — Fix floating BAKED road surface (v7 fast path stored absolute DEM, never offset-normalized)

The actual "roads in the sky" web: `renderTileRoads`' pre-baked fast path (`options.bakedRoads.layers`)
loads `bakedLayer.positions` verbatim — baked offline at absolute DEM Y — with no offset shift. So the
road SURFACE floated exactly +offset (~80 m on Montjuïc) while runtime-built markings draped (they use
`toNormalizedRoadY`). Live probe: overhead meshes were `MeshStandardMaterial`+`vertexColors` with attrs
`position,normal,uv,halfWidth,color` (= shared road material + flat ribbon), vertexY−terrainY ≈ +80
everywhere. Fix: normalize the baked geometry into the spawn frame — `geom.scale(1,vertExag,1)` +
`geom.translate(0,-offset*vertExag,0)` — baked into the GEOMETRY (not mesh.position) so it survives
`mergeMeshesByMaterial`, which merges raw geos and drops per-mesh transforms. Render-side, no re-bake.
See gotchas G-44. (The earlier "road surface confirmed draped" reading came from the runtime path /
range-aggregate; the baked path was the real consumer.)

## 2026-06-09 — Fix floating road-infrastructure "web" (offset not subtracted; downstream of road-drape)

`roadInfraRenderer` anchors signs/boards/poles/gantries to `road.points[i].elevation`, which is raw
absolute DEM after the road-drape fix. It receives no `getElevationAt`/`elevationOffset` from tileManager,
so it placed infra at absolute DEM — ~80 m above the draped road on Montjuïc — a dark `#bbbbbb` web
overhead (live probe: 462 overhead meshes at Y 87–192 vs terrain −15 under the camera). Road surface +
markings were always correct (they use `toNormalizedRoadY`); only these road-anchored decorations bypassed
the offset. Fix: added `normRoadElev()` (`(rawDEM − worldElevationOffset) × vertExag`) and routed all
elevation→baseY seams (interpolate/walkPolyline readers + junction `connectedRoads` entries) through it;
junction entries now also carry a normalized elevation so traffic lights terrain-follow. Render-side, no
re-bake. Note: `urbanFeatureRenderer`/`vendorCartRenderer` still place at `Y=0` (sink on slopes, not float)
— separate latent issue. See gotchas G-43.

## 2026-06-09 — Fix spurious bridge structures (render-side; downstream of the road-drape fix)

Bridge slab/guard-rail/shadow/collider builders in `roadRenderer.js` decided "is this elevated" from
terrain-INCLUSIVE road height (`hMax > 4.0`, `Δh > 2.5`, `rawElevMax/Range` off absolute `p.elevation`).
Correct in flat-world (height = layer profile); broken after the road-drape fix made height = `DEM − offset`,
so terrain elevation/slope fired on ~60% of surface roads → slabs+rails fabricated over Montjuïc as a dark
"overhead canopy" (draped correctly, but should not exist). Bridge Y itself was always correct (offset
subtracted) — this was a detection bug, not a positioning bug.

Fix: gate all four builders on **structural flags** (`road.bridge || road.layer > 0 || road.isRamp`); `_link`
roads only when they have a real **above-terrain** rise. Added `getAboveTerrainHeights()` (subtracts
`getElevationAt`, cancels DEM, leaves layer/ramp component); `MIN_BRIDGE_STRUCTURE_HEIGHT` taper and shadow
`heightAlpha` now key off it. No re-bake (render-side). Counts on bridge-free tiles: slab 165→3 / 184→2
(remaining are genuine ramps); real bridges/ramps still get structures. See gotchas G-42.

## 2026-06-09 — Road DEM-drape fix: DEM-add wrote the wrong field (p[1], not the serialized p[3])

The last elevation bug: 238/240 surface roads baked at elevation 0 → render flat at −80 while terrain rises. Root: the bake's road DEM-add wrote `p[1] += groundElev`, but road points are `[mercX, yUp, mercZ, elev]` (`RoadGeometryBuilder:44`, p[1]=p[3]=yUp initially) and **convertToBinary serializes elevation from p[3]** (`flattenRoadPoints` prefers the `elevation` array = p[3] whenever finite; p[3]=0 is finite). So the DEM landed in the ignored fallback field; serialized elevation (p[3]) stayed at yUp=0 → flat. The 2 "draped" roads only survived because RampResolver had modified their p[3] (a DEM-free *relative* layer profile — not real terrain).

- **Fix (`buildRegion.js:~1200`):** add `groundElev` to **p[3]** (the serialized elevation), keeping `p[1] +=` as the 3-element fallback. p[3] holds the layer-relative profile (0 surface / ramp descent), and RampResolver is explicitly DEM-free, so adding groundDEM drapes every road with no double-count: surface → DEM, ramp/bridge → DEM + relative profile.
- **Predicted before→after (Poble Sec, terrain raw ~30, offset 80):** surface road serialized elev 0 → **30**; rendered Y −80 (flat, buried) → **−50 (= terrain, draped)**. Ramps (Miramar) go from relative-profile-over-0 to profile + real DEM (now actually on terrain).
- **Re-bake REQUIRED** (road elevation is baked data) + full reload. Acceptance: road traverse rows should span the terrain relief (not pinned ~−80), roads follow slopes / sit between buildings.

## 2026-06-09 — Fix greens/parking polygon data-shape mismatch (the "floating gray planes")

The flat gray features floating over the city were **collapsed greens & parking polygons**, not roads. Root cause: the tile parser (`readFloat32Pairs` via `readGreens`/`readPolygonFeatures`) delivers polygon points as **`{x, y}` objects**, but `greensRenderer` and `parkingRenderer` indexed them as **arrays `point[0]/point[1]`** → every coord read `undefined` → `shape.moveTo(undefined,undefined)` → `ShapeGeometry` collapsed to the origin → rendered flat at worldGroup-local (0,0) = world ~(3661,−2067), far from terrain, at y=0. Dormant in the flat world (origin-collapsed at y=0 looked like terrain at y=0); DEM exposed it when terrain went negative. `waterRenderer` reads `.x/.y` — that's why water was always correct.

- **Fix:** switched both renderers to `.x/.y` (matching the parser + waterRenderer convention). `greensRenderer.js` polygonCentroid (`:40,43-44`) + shape build (`:85-86`); `parkingRenderer.js` pointInPoly (`:31-32`), centroid (`:55-56`), shape (`:66-67`), uniqueNodes (`:77`). Stale `[[x,z]]` docstrings updated to `{x,y}`.
- **Scoped — no other victims:** grep of all renderers for `[i][0]/[1]` point access: barrier consumers (vegetation/cluster) read `barrier.points` which `readBarriers` returns as arrays (correct); `vegetationMask` is defensive (`.x ?? [0]`); `crashBarrier` uses local arrays; beaches/pedAreas have no array-index renderer. Only greens + parking were broken.
- **Symptom chain explained:** the earlier `getElevationAt→0` was downstream — a collapsed polygon at origin queries `worldToLatLon(0,0)` ≈ origin lat/lon, misses the tile → 0. The offset/gate/sky/worker investigations were red herrings; the offset path stays exonerated.
- No re-bake (baked coords were correct). Render-side only; full reload.

## 2026-06-09 — Stage 2: remove the tileMinElevation offset gate everywhere (finish D-12 → fixes road float)

The `useBaked` terrain co-frame shift used `getWorldElevationOffset()` **ungated** (=80), while roads / `getElevationAt` / fallback terrain / physics-trimesh used the **gated** `tileMinElevation != null ? 0 : getWorldElevationOffset()`. At runtime `tileMinElevation` was non-null (baked tiles carry it, e.g. 28; the parser's `null` override wasn't reliably live in the worker), so the gated sites resolved to **0** → terrain shifted 80, everything else shifted 0 → **~80 m road float** (roads on flat planes cutting through buildings). The `useBaked` switch exposed it (old fallback terrain shared the gated offset with roads, so they matched).

- **Fix (Option 1b, completes ADR D-12):** removed the `tileMinElevation`/`elevationIsRebased` gate at **every** consumer — all now unconditionally use `getWorldElevationOffset()`. Sites: `terrainRenderer.js:136` (mesh) & `:736` (heightfield), `tileManager.js:355` (road trimesh), `:821` (terrain trimesh), `:1036` (entry flag → false), `:1332` (vegetation/road options), `:1400`+`:1410` (road collider — removed the local flag & param), `:2625` (road-height query). `useBaked` (`:699`) already ungated — now matches everyone.
- **Worker-staleness now irrelevant:** no consumer reads `tileMinElevation`, so whether the worker reports `28` or `null` cannot split the frame. Grep-confirmed: only the parser-null (`tileParserWorker.js:330`, now moot) + convertToBinary write (harmless, unused) remain — zero branching.
- **Result (computed, Montjuïc tile 16_33161_24481):** terrain `raw−80` = [−52..+26]; roads `toNormalizedRoadY(0,80)` = −80 — **same offset, no systematic float** (was +52..−26 floating). Fail-fast: all consumers share one source, covered by the `processTileData` gate (`whenElevationOffsetReady` + assert) which runs before any build.
- **NOT fixed (separate, next):** roads baked at elevation 0 (no DEM drape, `buildRegion.js:1200`). So roads are now co-framed but FLAT at −80 → **flush with terrain at sea level, BURIED 28–106 m under Montjuïc**. Expect on screen: float gone, but roads sink into hillsides until the drape fix. No re-bake (render-side); hard reload.

## 2026-06-06 — Stage 2: RENDER THE BAKED TERRAIN MESH (useBaked was silently false → fallback cones)

Root finding: the frontend was rendering the runtime FALLBACK terrain mesh, never the pre-baked one — the gate `useBaked = bakedTerrain.gridSize === CONFIG.TERRAIN_MAX_GRID` was `64 === 32` = false. So every Stage-2 terrain fix + validation targeted the UNUSED baked mesh, while the screen showed the fallback, whose water-depression (`terrainRenderer.js:246`) set water vertices to an **absolute** `~-2` (not offset-corrected) → ~72 m up-cones at El Raval's dense water polygons. This is why "data clean" disagreed with "screen shows cones."

- **Fix (Option 2):** `CONFIG.TERRAIN_MAX_GRID 32 → 64` to match the bake's `gridSize` (terrainBaker `GRID_SIZE=64`) → `useBaked = true`, so the pre-baked mesh (carrying the co-frame shift + closed-only water-sink, all verified) renders and the buggy fallback is bypassed. One-time `[Terrain] useBaked=TRUE` log added.
- **Baked mesh verified good** (never been rendered): 4096 verts/tile, 4096 valid normals (0 zero/bad), ~7800 tris, **0 degenerate**, clean Y (El Raval 8–32, Montjuïc 28–106). Hole-punching for tunnels is baked into its indices.
- **No physics impact:** `buildTerrainHeightfield` (the other `TERRAIN_MAX_GRID` consumer) is imported but never called; physics uses `createTerrainTrimesh` with its own `PHYSICS_GRID=32`. Only visual mesh res rises 32→64 (4×, modest).
- **Defense-in-depth:** also fixed the fallback's `terrainRenderer.js:246` to `y = seaLevelNorm + depthTarget` (offset-relative) so the now-bypassed path isn't a latent cone landmine. Stale "useBaked is always true" comment corrected.
- **Co-frame after fix:** baked land renders `(grid−offset)` = −72…−48 (El Raval); closed water at `(surfaceElev−2.5−offset)` ≈ −82 (flush with sea); NO cones (baked grid has no open-polyline streams). Buildings drape via `getElevationAt` (same normalized frame) → sit correctly. **Roads remain flat at elevation 0 (separate known bug — road DEM-add not landing); they will NOT drape until that is fixed.**
- No re-bake (baked data exists/clean). Hard reload + cache clear. Acceptance is on the RENDERED screen (cones gone, FPS) — pending user confirm.

## 2026-06-06 — Stage 2: water-sink #2 — exclude OPEN polylines (streams/canals/coastlines)

The relative-flat sink (#1) fixed small closed ponds but left large artifacts: the terrain sink ran point-in-polygon on OPEN polylines too — `stream`/`canal`/`coastline`/`wetland` features are buffered LINE geometry (3–5 km, `closed=false`, spanning up to 244 m elevation). PiP on a non-closed ring flattens arbitrary terrain patches to one garbage median → raised mesas/sheets (coastal end of a stream lifted to ~100 m), cones (islanded high points), region-wide (streams are unclipped, present in every tile). The renderer already excludes these (`waterRenderer.js:164 isOpenPolyline`); the bake didn't — they disagreed.

- **Fix (`buildRegion.js` water-sink):** only flatten terrain for CLOSED AREA water. New `isClosedAreaWater(poly,type,closed)` mirrors the renderer — skips `closed===false`, linear types (`stream`/`canal`/`coastline`/`wetland`/…), and open polylines (first≠last by ≥1.5 Mercator ≈ 1 m world). The build keeps `type`/`closed` metadata (was discarding it). **Safety net:** any kept body whose shoreline DEM spans >18 m returns `null` → not flattened (catches mis-tagged multi-elevation polys). `type`/`closed` come from `waterNormalize.js:119-123`.
- **Result (re-baked, verified):** spike/pit tiles **8 → 0**; worst spike 83.5 m → 7.5 m, worst pit 90.5 m → 4.5 m (both now normal terrain steepness). The worst-pit point (`33154_24472`, was flattened to 61.5 by stream `1351520321` span 186 m) restored to **154 m** real terrain. Per port tile: **69 open polylines skipped, 183 closed bodies still sunk** — closed sea/harbour/ponds still dip to ~−2.5 (regression-safe). Mesas/cones/raised sheet gone region-wide. Streams get no flat sink (no valid 'inside'); a visible sloped channel, if ever wanted, is future per-segment carving.

## 2026-06-06 — Stage 2: relative (flat) water-sink — fixes DEM spikes/pits

`WATER_BAKE_DEPTH = -2.5` (absolute) was slamming every water-polygon grid point to sea level regardless of the body's real elevation. Dormant in the flat world; DEM-on exposed it: inland/high water (e.g. a 154 m pond) → −2.5 = deep pits; real terrain islanded by sunk neighbours → spikes; both bilinear-smeared into cones, concentrated at water/coast. (DEM itself is clean — nodata −32768 is read+filtered, zero void pixels.)

- **Fix (`buildRegion.js` water-sink ~:1067-1122):** sink RELATIVE to each polygon's real surface. `WATER_SINK_DELTA = 2.5` m below a per-polygon **flat** `surfaceElev` = median DEM at the polygon's shoreline vertices (`mercatorToLatLon` + `demSampler`; fallback 0 → −2.5, preserving flat-world/sea behaviour). `data[idx] = surfaceElev[pi] - WATER_SINK_DELTA`. Removed the now-meaningless `<= WATER_BAKE_DEPTH` skip.
- **Marina framing checked — OK:** `worldToMercator` (`projection.js:45`) is the exact inverse of `mercatorToWorld`, same raw-Mercator frame as the grid's `latLonToMercator`. Not contributing. No change.
- **Result (re-baked, verified):** sea/coast unchanged (−2.5); spike/pit tiles **29 → 8**; worst pit 156 m → 90 m, worst spike 132 m → 83 m; no more −2.5 values. **Residual 8 tiles** (e.g. 16_33154_24472 pit 90 m): a flat-median surface applied to a point amid much-higher terrain → likely sloped/linear water (median wrong) or an over-broad/unclipped polygon catching stray grid points. Follow-up: skip sinking grid points whose raw DEM is ≫ the polygon surface, or handle sloped water with a gradient. Did NOT touch tunnel trench geometry (Stage-3; port trench is compounded by 5 tunnel-road portals).

## 2026-06-06 — Stage 2 co-frame: elevation-offset BUILD GATE (Path B, root fix)

The earlier per-layer offset fix only re-applied to the terrain *visual* (an `onSpawnElevationReady` self-heal); the other 5 consumers (terrain physics, road visual/physics, vegetation, terrainMinY/maxY) froze the build-time offset, so any tile built before `worldElevationOffset` resolved baked the absolute frame → mixed state (ground correct, roads/trees/physics floating +offset). Replaced with a **single happens-before gate** instead of per-layer re-apply (which re-creates the every-layer-must-resync fragility).

- **Gate:** `processTileData` (`tileManager.js`) now `await whenElevationOffsetReady()` as its first statement — no elevation layer builds until the offset is resolved. The offset comes from the spawn tile's *parse* (`main.js:106`), independent of geometry builds, so it cannot deadlock; resolves immediately in normal flow. New `elevationOffset.js: whenElevationOffsetReady()`.
- **Fail-fast:** `elevationOffset.js: assertElevationOffsetResolved(where)` throws loudly if any consumer is reached with the offset null (gate bypassed) — called in `processTileData` and `terrainRenderer.buildTerrainMesh`. Production-grade: fail loud, never silently bake the absolute frame.
- **Removed** the `onSpawnElevationReady` self-heal (`terrainRenderer.js`) and the `onSpawnElevationReady` export entirely (grep-clean). Terrain visual now sets `position.y = -offset·vertExag` once, gated.
- Verified: spawn tile `16_33161_24481`, `worldElevationOffset = 80.00 m`, spawn → Y 0; all layers co-framed `(rawDEM − 80)·vertExag` at startup. Build green. Runtime only — no re-bake; hard reload.

## 2026-06-05 — Vertical-model Stage 2: DEM-on (real terrain elevation)

Per [vertical-model-foundation-spec.md](vertical-model-foundation-spec.md) §4, onto the Stage-1 honest coordinate space. Turns on the dormant DEM bake path, unifies the elevation baseline, removes the flat ground plane. **Structural — atomic three-step: code → full region re-bake → `window._clearTileCache()` + hard reload. The world is split/lying until all three are done.** Stage-3 absolute-Y items (wall/portal/trench heights, deck-gate clause, tunnel fall-through, SEA_LEVEL) deliberately NOT touched — expected to look wrong on the drive.

- **Un-gated DEM (1 line):** `buildRegion.js:383` — removed `cleanRoadPipeline ||` from `phase1Pure2D`. `cleanRoadPipeline` (road-fidelity: raw/all-highways/skip-simplify) no longer forces flat-world; the DEM loader (`:928`) now fires because `cfg.phase1Pure2D:false`. `:384` untouched. DEM on/off is now controlled solely by `cfg.phase1Pure2D`. Co-frame confirmed: terrain (`:1046`) and roads (`p[1]+=groundElev`, `:1155`) share one sampler guard → tunnel Y = `DEM + layer·−6`.
- **Unified elevation baseline (the chokepoint):** `tileParserWorker.js:327` `tileMinElevation: elev.tileMinElevation` → `null`. Flips all 6 consumption sites to the spawn-anchored `getWorldElevationOffset()` and all `elevationIsRebased` flags to false. The per-tile `tileMinElevation` fork is dead; `worldElevationOffset` is the single region-wide baseline. Every Y = `rawAbsoluteDEM − spawnElev` → spawn (Sagrada Família, DEM +45m) normalizes to ~0; Montjuïc ≈ +144m, seafront ≈ −45m. (`convertToBinary.js:132` still emits the now-ignored field — optional cleanup, not done.)
- **Removed the flat ground plane:** `scene.js` — the 2000×2000 `groundMesh` pinned to Y=0 is gone (`groundMesh = null`; `worldGroup` kept). A single flat plane can't conform to a height field (slices up-slopes / hides down-slopes) and had no physics role (per-tile Trimesh colliders + Y=−50 fallback floor handle ground). `main.js:314` / `carDriver.js:83` guard on null. Real DEM relief now reads cleanly.
- **Known-deferred to Stage 3** (will look wrong, NOT regressions): floating/buried tunnel walls & portals, portal trench depth, spurious deck boxes on slopes, tunnel fall-through (Gran Via/Plaça Cerdà), SEA_LEVEL frame. Stage-2 follow-up: RampResolver profiles run topologically (endpoints land correct; profile doesn't hug terrain yet).
- Frontend build green. **Re-bake not yet run (handed to user).**

## 2026-06-05 — Vertical-model Stage 1: Unstretch-X (1 unit = 1 real metre)

Per [vertical-model-foundation-spec.md](vertical-model-foundation-spec.md) §3 (corrected). Makes horizontal world coords real metres so XZ matches Y; foundation for DEM-on (Stage 2). See ADR **D-11** and [coordinate-systems.md](coordinate-systems.md) unit invariant. **Structural — requires a full region re-bake (not yet run; handed to user).**

- **Projection factor at 6 paths:** `MERCATOR_UNSTRETCH = cos(ORIGIN_LAT)≈0.7507` applied after origin subtraction. `frontend/src/projection.js` (exports it; fwd `mercatorToWorld` ×, inverse `worldToMercator` ÷), `backend/projection.js`, `tileParserWorker.js` (4 sites: triples/pairs/baked-veg/JSON), `vegetationWorker.js` (latLonToWorld + worldToLatLon + its createFastElevation bounds), `buildingWorker.js` (elev-grid bounds), `fastElevation.js` (imports the factor). `latLonToMercator` + slippy `latLonToTile` 1/cos(lat) untouched. X-negation downstream, unaffected. `bboxToTile`/`worldToTile` are dead/uncalled — left.
- **Car scaled by provenance (eye-tuned):** `carPhysics.js` imports the factor; chassis box XZ (0.70/1.55), track/wheelbase (±0.68/±1.2), `WHEEL_RADIUS` (0.3) ×factor as one rigid unit; chassis height + connection-Y + suspension untouched. Real-metre-authored constants (BCN_DIMS, road `lanes×3.5`, terrainBaker margins, `DEFAULT_SIDEWALK_WIDTH=1.2`) left — they self-correct. True car real-size + drive feel deferred to the **FEEL GATE**.
- **Two islands purged:** `RampResolver.cumulativeGroundDist` now measures in honest world coords (no `cos(lat)`); `buildingRenderer MERCATOR_SCALE=cos(28.5°)` deleted (UV uses real-metre wall length).
- **Deleted dead `tunnelTerrainCarver.js`** + its tileManager import.
- **Validator** inherited honesty (no code change): ramp-grade now reports real grades (stubs 43%/56% → **57.7%/74.4%**).
- Frontend build green; backend syntax green.

**CORRECTION / scope expansion (same session, post first re-bake):** the Stage-1 inventory ("six paths") audited only the named `mercatorToWorld`/`latLonToWorld` functions and **missed two whole classes** of conversion, caught by the static cross-path verifier (`tools/_stage1_verify.mjs`) when buildings/trees came out misplaced:
  1. **Frontend parse double-cos.** `readFloat32Pairs` (building footprints, greens, parking) and the baked-veg reader are called for BOTH absolute-Mercator data (subtract origin) and world-stored data. World-stored data is already cos'd at bake, so the blanket parse `×cos` double-corrected it. Fix: gate the parse `×cos` on origin-subtraction (`ox/oy` present) — cos belongs exactly where origin-subtraction happens.
  2. **Bake-side inline conversions.** ~10 sites bypassed `mercatorToWorld`: forward feature-storage (`buildRegion` bus stops, parking, urban features, point features→trees/lamps/signals/shops via `pointToTile`) stored *stretched* world; and inverse `world+origin` tile-assignment round-trips (`buildingNormalize`/`greenNormalize`/`waterNormalize`/`pbfAreaFeatures` centroid→tile, marina water-sink test) computed the *wrong tile* once world is real-metre. Fix: route every forward site through `mercatorToWorld` and every inverse through a new `worldToMercator` (÷cos) added to `backend/projection.js`. **Principle: ALL Mercator↔world conversions go through the projection functions; no inline subtraction.** Required a second full re-bake.
- **Also (unrelated, user request): `ENABLE_CAR: false`** (fly / free-camera mode).

---

## 2026-06-05 — Tunnel fix Phase 2 Option A: retaining-wall containment

Confirmed root cause (portal diagnostic + Phase-2 measurement): the physics terrain cut is far wider than the deck (measured max lateral gap 31–87 m), leaving undecked physics strips beside drivable deck edges that the car drops into. Fix = physics walls at drivable deck edges so the over-cut width is irrelevant (NOT widen-deck — gaps are 30–90 m; NOT narrow the cut — reopens the Phase-1 in-mouth raycast fix). **Runtime-only; no re-bake.**

- **Doc correction:** changelog (2026-05-30) + `gotchas.md` G-39 claimed approach-road physics was "handled by existing wall colliders" — FALSE. `buildRetainingWalls` is visual-only and `createTunnelWallColliders` runs only for layer<0 tunnelRoads; L0 `wallApproachRoads` had a deck and no wall physics. Corrected both.
- **Flag:** `config.js ENABLE_RETAINING_WALLS: false → true` (gates both visual walls and the new approach colliders).
- **New `createApproachWallColliders` (`tileManager.js`):** thin vertical CANNON.Box walls along both deck edges (road/2) of each L0 `wallApproachRoad` descent segment, spanning road floor → surface (Y≈0.05), X-negated. Wired into Phase-1 build, entry storage, distance-management, removal, count. Three guarded failure modes: (1) **overlap-skip across BOTH road sets** (approach + tunnel-ramp corridors) so coincident walls don't double up → solver NaN; (2) **open at mouth** — side walls only, gated by elevation, no face cap; (3) **finite guard** on every addShape (skip+warn).
- **Lip extension (`tunnelRenderer.js` + collider):** wall descent threshold lowered −0.2 → −0.05 so walls reach the surface lip with no top step. `RETAINING_MIN_WALL_H = 0.5` keeps the shallow lip wall a robust box.
- **Validator (`tunnel-inspect --validate`):** added residual-unwalled-≤3m-cell report (static guide; walls are runtime so it can only estimate via nearest-deck-gets-a-wall). Residuals are non-drivable descents (service/footway/steps — not DRIVABLE so not wallApproachRoads), flat roads grazing a tunnel-mouth cut, and a bridge misattribution — all follow-ups, not the primary drivable-approach fall (now walled).

Acceptance (a) static guide done; (b)/(c)/(d) require a drive — handed to user.

## 2026-06-05 — Tunnel fix Phase 1: bake-data correctness + physics finite guards

Per `docs/context/tunnel-fix-playbook.md` Phase 1 (bake-data correctness only; no Phase-2 geometry).

**Baseline correction (important):** the Phase-0 report assumed "terrain carries DEM." It does not — `cleanRoadPipeline:true` forces `phase1Pure2D:true` (`buildRegion.js:383`), which skips DEM loading (`:933`). The on-disk bake is **flat-world**: terrain grid ≈ 0 (only the −2.5 m water-sink), all surface roads at Y=0, tunnels at exact layer multiples (−6/−12/…). Re-baking reproduces this flat baseline (no DEM shift).

**TASK 0 — physics finite guards (C4):** `assertFiniteShape()` helper in `tileManager.js`; guards on every `addShape` (deck box, both tunnel walls, ramp trimesh). Non-finite x/y/z/extent → `console.warn` (road id + seg + field) and skip the shape instead of poisoning the cannon-es solver. Behaviourally inert except in the NaN case.

**TASK A — Case C ramp surface-anchoring (`RampResolver.js`):** Case B already anchored to the connected surface road's real `baseHeight` (left unchanged). Case C (short tunnel, both ends connect to a different layer) was previously left flat at depth (abrupt walls). Now length-aware: builds a valley (surface-anchored both ends → layer-space interior depth, gentle ≤12% ramps); if too short to descend+ascend at ≤15%, connects the two ends with a monotonic linear profile (flat when ends match = covered road; short ramp when they differ — endpoints always match, no vertical crack). Interior depth of normal tunnels untouched. Result on the 4 tiles' region scan: 250 Case-B, 47 Case-C valley, 107 Case-C flattened/linear.

**TASK B — physics terrain consumes corridors (C5/C4b, `terrainBaker.js`):** `bakePhysicsTerrain` previously ignored `approachRoads` and `crossTileApproaches` (cut inward-only for ramp-fixed portals) → "visual hole over solid physics" + sealed cross-tile seams. Now cuts the SAME corridor set as the visual baker (cross-tile + Source A bidirectional all-portals + Source B), with each cut region dilated by the physics half-cell-diagonal so the coarse 32×32 opening is a guaranteed SUPERSET of the 64×64 visual opening. Tradeoff: bounded over-cut (~1 physics-cell ring beyond the visual hole); physics-only, tunable later.

**TASK C — physics mouth margin (C3, `terrainBaker.js`):** physics mouth radius = visual + 1 m (`PHYS_MOUTH_MARGIN`) so wheel raycasts can't catch terrain just inside the visible mouth.

**Validator (`tools/tunnel-inspect.mjs --validate`):** commit-blocking asserts (1) physics⊇visual opening post-quantization, (2) physics mouth ≥ visual+1m, (3) cross-tile corridor cut in both bakes; diagnostics (4) poke-through, (5) ramp grade >15%, (6) wall-top vs terrain. Verified to FAIL on pre-rebake tiles and PASS after. Re-baked the 4 diagnostic tiles (33171_24473, 33166_24472, 33163_24481, 33163_24482); asserts 1–3 PASS; diagnostics surface the expected steep Case-B links (Glòries-area 43%, link 55.9%) — deferred to Phase 2.

Not done (Phase 2): trench depth tracking layer (still hard-coded −6 in `buildPortalApproaches`/`tunnelRenderer.js`), wall-top vs ceiling height, steep Case-B link grades. `tunnelTerrainCarver.js` left as dead code (delete/keep decided separately).

---

## 2026-05-30 — Tunnel terrain cut: bake-side portal corridor strips (Option X)

**Root cause investigation:** All tunnel road points in `payload.roads` at bake time are in **Mercator coordinates** (~237,000), not world coords (~1,600). The terrain grid uses world coords. Original circular portal holes (`tunnelMouths`) were placed at Mercator positions, comparing against world-coord terrain vertices → holes NEVER fired. Terrain above tunnels was never actually cut by the baker (only by old `carveTunnelTerrain` which we disabled).

**Coordinate fix:** `terrainBaker.js` now converts all tunnel road points via `mercatorToWorld(pts[i][0], pts[i][2])` before any position comparisons. Same fix applied to circular tunnel mouth holes. Road elevation data correctly read from `road.elevation[]` array (not `pts[i][1]` which is bridge yUp height).

**Portal corridor algorithm:** For each true portal endpoint (count=1 in within-tile junction map), generate bidirectional corridor spanning ±TRENCH_LEN (80m). Outward: approach zone (may be in adjacent tile for boundary portals). Inward: tunnel entry zone (always within this tile). `inApproachCorridor` uses perpendicular distance-to-segment test. `BCN_DIMS.APPROACH_RAMP_CUT_MARGIN = 2.5m` defines corridor halfwidth beyond road edge.

**Result:** Average 271 terrain triangles removed per tunnel tile. Verified across 5 tunnel tiles: 36–470 triangles cut per tile. Re-bake: 399s. Frontend dead-code comment added to terrainRenderer.js. See G-42, G-43.

---

## 2026-05-30 — Tunnel bug fixes: whitelist classification + portal hole radius

**Fix 1 — DRIVABLE_TUNNEL_TYPES whitelist (tileManager.js):** Replaced `PEDESTRIAN_TYPES` blacklist with `DRIVABLE_TUNNEL_TYPES` whitelist for tunnel classification. Root cause: Moll d'Espanya marina/mall passages are `highway=service tunnel=yes layer=-1` — not in PEDESTRIAN_TYPES, so they got full tunnel treatment (enclosure + terrain holes). 5 service roads × 2 endpoints = 10 terrain holes scattered across the Port Vell area. With whitelist approach, service/track/cycleway/path/etc. tunnels all go to pedestrianPortalRoads → portal frame only, no terrain holes. Approach roads also filtered to DRIVABLE_TUNNEL_TYPES (non-drivable approaches no longer get retaining walls either). See G-40.

**Fix 2 — Terrain hole radius (terrainRenderer.js):** Removed `MOUTH_RADIUS = 1` constant. New formula: `hw + PORTAL_WING + HOLE_OVERLAP = (road.width/2 + 1) + 3 + 0.5`. Hole now matches portal frame total half-width plus 0.5m overlap, preventing the portal frame from overhanging the terrain edge and creating seam gaps. Constants commented to link with tunnelRenderer.js. See G-41.

---

## 2026-05-30 — Tunnel system overhaul (Option B: retaining walls)

**Architecture:** Replaced terrain-carving-for-all with a three-way classification: (1) drivable tunnels with layer<0 get full interior enclosure (unchanged), (2) non-pedestrian approach roads split into `carveApproachRoads` (motorway/trunk >60m horizontal) which get terrain carving, and `wallApproachRoads` (everything else, including all urban approaches) which get vertical retaining walls, (3) pedestrian/footway tunnels get portal-frame-only, no interior.

**Task 1 — Retaining walls:** `buildRetainingWalls(wallApproachRoads)` in tunnelRenderer.js generates vertical concrete wall quads on each side of descent segments (eA<-0.1m). Material: light grey concrete (0x8a8a85, MeshLambertMaterial). Physics pit no longer applied to wall approaches. `isHillsideApproach()` filter: must be motorway/trunk/link AND ≥60m horizontal span from surface to deepest point.

> **CORRECTION (2026-06-05):** the original wording here — "wall colliders already handle physics" for wall approaches — was FALSE. `buildRetainingWalls` is VISUAL-ONLY, and `createTunnelWallColliders` runs only for `tunnelRoads` (layer<0). The L0 `wallApproachRoads` had a deck but no wall physics, so the car dropped off the deck edge into the over-cut terrain strip. Fixed in Phase-2 Option A by adding `createApproachWallColliders` (own CANNON boxes along approach deck edges) and gating both the visual walls and the colliders behind `ENABLE_RETAINING_WALLS`.

**Task 2 — Pedestrian portals:** `buildPedestrianPortals(pedestrianPortalRoads)` generates small rectangular portal frames (3m wide, 2.8m tall, 0.4m frame thickness) at each endpoint of pedestrian/footway/path/steps tunnel ways. Dark charcoal (0x3a3a3a). Includes dark inner face quad to suggest depth. No interior, no terrain carving, no terrain holes.

**Task 3 — Canopy disabled:** `buildApproachCanopy` now returns empty group. Delhi-era arched shed over tunnel ramps removed. All calls preserved for interface compatibility.

**Task 4 — Barcelona tunnel interior:** Rewrote buildTunnelMeshes completely. Removed: chevron curbs, guardrails, discrete ceiling spotlights. Added: cream ceramic tile walls (0xEFE8DB, MeshLambertMaterial), LED ceiling strips at wall-ceiling junction (0xFFF8E8, MeshBasicMaterial — self-lit), yellow safety stripes at road edge (0xF5D000). Ceiling height: relative (road_elev + TUNNEL_CLEARANCE=4.5m), not fixed at Y=-1.5m. Sign: per-road-name "TÚNEL DE [NAME]" on dark blue background, Canvas2D texture cached per name. All materials switched to MeshLambertMaterial (removed MeshStandardMaterial from tunnel).

**Config flags added:** ENABLE_RETAINING_WALLS, ENABLE_PEDESTRIAN_PORTALS.

---

## 2026-05-30 — Phases 4B-2, 4C-A, 4C-B, 4D — Barcelona road system final sweep

**4B-2 — Chamfer corner sidewalk + diagonal curbs:**
`buildChamferSidewalks` + `buildChamferCurbs` exported from roadRenderer. For each adjacent approach pair of a chamfer-eligible junction: (a) triangular panot sidewalk fill at outer corner using world-space UV, fan-triangulated; (b) L-profile diagonal granite curb (top face + outer vertical face) matching Phase 3 curb geometry. Both tracked in tileManager. LOD 80m (sw) / 200m (curb) × altMult.

**4C-A — ZONA 30 stencils + tactile paving:**
`buildZona30Stencils`: InstancedMesh with Canvas2D "30" texture, one per 100m on residential/tertiary roads with maxspeed=30 (1,396 qualified roads). `buildTactilePaving`: beige dotted strip at each crosswalk-sidewalk interface, Canvas2D dot pattern, 0.6m deep × full sidewalk width. Both tracked, LOD 50m / 60m × altMult.

**4C-B — Blue Zona Blava stripes + yellow parking fix:**
OUTCOME A confirmed (Barcelona uses parking:both:restriction, parking:left/right:restriction, parking:condition:*, parking:*:fee). Added 12 new tag keys to pbfHighways.js KEEP_TAGS. buildRegion.js normalizes all schemas into parkingLeft/Right (restriction values) and parkingPaidLeft/Right (paid/free). Re-bake completed (439s). Result: 54 roads with restriction data, 40 roads with paid parking. `buildBlueZoneStripes` implemented (paid → blue stripe). `buildNoParkingStripes` now produces output (23+31 restriction roads). LOD 80m × altMult for both.

**4D — Loose ends:**
(1) Direction board signs: removed Hindi transliteration and "Pin Code 110001" (Delhi postal code). Now shows Catalan road name in white on green background, consistent with real Spanish road signs. (2) Tunnel sign: replaced "सुरंग / TUNNEL" with "TÚNEL" (Barcelona-correct). (3) Ghost-wall filter (4D.2): `buildBarrierMeshes` now accepts `buildings` parameter; barrier=wall polylines with midpoint within 5m of any building centroid are skipped (prevents double-rendered OSM boundary walls). `ENABLE_GHOST_WALL_FILTER: true`. (4) Terrain restored (`ENABLE_TERRAIN: true`). Spawn reset to Eixample core (Carrer de la Diputació).

---

## 2026-05-30 — Phase 4B-1: chamfered intersection asphalt fill

**Bake enrichment:** `buildRegion.js` junction payload now includes `radius` (full max road width in metres) and `approaches: [{angle, width}]` sorted ascending by angle. `convertToBinary.js` and `tileParserWorker.js` updated with conditional read/write. Re-bake completed (437.7s). Verified: 100% of junctions now carry radius + approaches fields.

**Chamfer renderer (`roadRenderer.js`):** New exports `buildChamferFills(junctions, options)` and helper `isChamferEligibleJunction`. Eligibility: `type=crossing`, ≥3 approaches, `radius ≥ 8m`, adjacent approaches within 20° of orthogonal. Geometry: octagonal (4-way) or hexagonal (T-junction) polygon computed from approach angles + widths; fan-triangulated from vertex 0 (convex polygon, always valid). Y height = `(baseY + ROAD_OFFSET) * scale + ROAD_VISUAL_ABOVE_TERRAIN + ROAD_ZFIGHT_OFFSET + 0.01` (matches road surface). Material: `MeshLambertMaterial`, ASPHALT_BASE color.

**Wiring:** `tileManager.js` calls `buildChamferFills(junctions, options)` after `buildGoreMeshes`. Chamfer mesh pushed into `roadMeshes` (inherits road mesh lifecycle/cleanup). `CONFIG.ENABLE_CHAMFER_FILLS: true` added.

**Stats:** 263 of 3284 total junctions eligible (8%). Densest tile 33163/24476: 17 eligible × 8 verts = 136 verts total — negligible vertex budget impact.

**Decisions:** Option 2 (bake-side enrichment) over Option 1 (spatial matching) — single source of truth. `radius = max(approach.width)` full road width to match frontend `getJunctionPoints()` convention. Fan triangulation over ShapeUtils (avoids winding order dependency for convex polygon). 20° orthogonality tolerance covers slightly skewed Eixample-like grids.

**Phase 4B-2 (deferred):** Triangular panot sidewalk corner fills, diagonal granite curb segments along chamfer edges.

---

## 2026-05-30 — Phase 4A patch: tram rail height + curb merge fix

**Tram rail height (Issue 1):** `createTramMeshes` was calling `getRailwayPointHeights` which returns `(baseY + RAILWAY_OFFSET) * scale = baseY + 0.07`. This placed rails 25mm below the road surface (`baseY + 0.075` vs road `baseY + 0.10`), occluded by the asphalt. Added `getTramSurfaceHeights(pts, getElevationAt)` in `railwayRenderer.js` using the road-surface formula: `(baseY + _ROAD_OFFSET) * scale + _ROAD_VISUAL`. `buildTramRailGeometry` adds `TRAM_RAIL_Y_ABOVE = 0.005` on top → final `baseY + 0.105` (5mm proud of asphalt). See G-32.

**Curb mergeGeometries warning (Issue 2):** `buildCurbs` was merging `gTop` (from `buildFlatRibbonGeometry`, which has `halfWidth`) with `gFace` (custom vertical face geometry, which lacked `halfWidth`). Added dummy `halfWidth = CURB_W / 2` attribute to `gFace` before merge. Warning was at `roadRenderer.js:1689` (end of buildCurbs), not in `buildNoParkingStripes` as initially suspected.

---

## 2026-05-29 — Phase 4A: tram tracks + yellow no-parking stripes

**Feature 1 — Tram tracks (`railwayRenderer.js`):**
- New export `createTramMeshes(railways, options)` — filters to `railway=tram` and `light_rail` only; skips tunnels/underground segments.
- Two parallel rail ribbons per segment at `±TRAM_GAUGE/2` (±0.7175m) from centerline, each `TRAM_RAIL_WIDTH` (0.06m) wide.
- `getTramMaterial()` — `MeshLambertMaterial`, `BCN_COLORS.TRAM_RAIL_STEEL` (0x8a8a8a).
- `buildTramRailGeometry()` — custom buffer geometry (position, normal, uv) with Y = road surface + 0.005m.
- Imported `BCN_COLORS` and `BCN_DIMS` into `railwayRenderer.js`.
- `tileManager.js` — `createTramMeshes` called after `createRailwayMeshes`. Entry slot `tramRailMesh`. LOD: 200m × altMult. Fog-cull + cleanup wired.
- Heavy rail (`railway=rail`, `subway`) unchanged — still uses existing ballasted ribbon path.
- `CONFIG.ENABLE_TRAM_TRACKS: true` added to config.js.

**Feature 2 — Yellow no-parking stripes (`roadRenderer.js`):**
- OSM fields added: `parking:lane:left`, `parking:lane:right`, `parking:lane:both` → KEEP_TAGS in `pbfHighways.js`.
- `buildRegion.js` — `phase2ById` and road payload emit `parkingLeft`/`parkingRight` (with `:both` as fallback for both sides).
- `convertToBinary.js` — conditional writes for `parkingLeft`/`parkingRight`.
- `tileParserWorker.js` — conditional reads for same.
- New `buildNoParkingStripes(roads, options)` in roadRenderer: continuous ribbon for `no_stopping`, dashed (2m/2m) for `no_parking`. Y = road surface + 0.04m. `getNoParkingMaterial()` — `MeshLambertMaterial`, `BCN_COLORS.PAINT_YELLOW`. Stripe width 0.10m, positioned at `half - stripe_half_width` (just inside road edge).
- Wired into `renderTileRoads` return and `createRoadMeshes`.
- `tileManager.js` — entry slot `noParkingMesh`, LOD: 80m × altMult. Fog-cull + cleanup wired.
- `CONFIG.ENABLE_NO_PARKING_STRIPES: true` added.

**Re-bake result:** Full Barcelona re-bake completed (483.4s). No parking restriction stripes appear in current tile coverage — the 355 OSM ways with `no_parking`/`no_stopping` values are located in neighborhoods (Gràcia, Nou Barris, Sant Andreu) outside the current tile extent. The pipeline is correctly wired and will render stripes when coverage expands. Tram data confirmed in 8 tiles (37 segments, Trambesòs route).

**Vertex budget (densest tile 33166/24479, 583 roads):** Road ~46k + sidewalk+curb ~37k + tram ~200 = ~84k total. Well under 250k soft / 300k hard budget.

---

## 2026-05-29 — Phase 3 polish: material heap fix + wall toning

**Problem 2 — Heap:** `getPanotMaterial()` in `roadRenderer.js`: `MeshStandardMaterial` → `MeshLambertMaterial`. Removed `roughness: 0.85` and `metalness: 0.0` (Lambert ignores these). Sidewalk tile is a flat-lit diffuse surface; Lambert renders identically at play distance. Saves ~30–60MB of compiled shader program memory.

**Problem 3a/b/c — Wall toning:** `barrierRenderer.js`: `BARRIER_CONFIGS.wall.minHeight` 3.5→1.0m (Barcelona property walls are 1–2m, not 3.5m Indian compound walls). `compound_wall.minHeight` 3.5→1.5m. Removed `'wall'` from `PRECAST_WALL_TYPES` — Barcelona walls no longer get Indian pillar+panel+wire geometry. Added `'wall'` to `TEXTURED_WALL_TYPES` — UV-mapped stone texture instead.

**3d/3e investigation — no re-bake needed:** Default tile height for walls is 2.0m (`BARRIER_DEFAULT_HEIGHTS.wall`). After minHeight reduction: `Math.max(2.0, 1.0) = 2.0m` — default unchanged. Explicit OSM heights respected for all values ≥ 1m. `retaining_wall` has no `minHeight` in BARRIER_CONFIGS — always uses full OSM height (or 2.5m default). Sound barriers (explicit `height=4m+`) floor at 1.0m and pass through unchanged. `retaining=yes` property tag not in PBF but not needed: `barrier=retaining_wall` already routes to a separate config with no minHeight floor.

**3f — Ghost-wall filtering deferred.** Documented in barcelona-road-system.md Section 7.

---

## 2026-05-29 — Phase 3 fixes: panot texture, sidewalk inference + scoping

**Fix 1 — Panot texture invisible (color × texture contrast collapse):** `getPanotMaterial()` had `color: BCN_COLORS.SIDEWALK_PANOT`. In `MeshStandardMaterial`, `.color` multiplies texture RGB per channel. Setting both material color and texture to the same beige value (~0.78) squared the value (~0.61) and collapsed the petal/background contrast to ~7 RGB units. Fix: `color: 0xffffff` — texture supplies all color, no tinting.

**Fix 2 — Sidewalk inference (OSM coverage was 1.4% of all roads, 6.3% of drivable roads):** Replaced strict `road.sidewalk in ['both','left','right']` filter with `inferSidewalkSide()` — 3-priority helper: (1) OSM explicit tag wins, (2) `sidewalk=no` respected, (3) road-type fallback: infer `'both'` for all drivable types not in the skip set. Skip set: `motorway`, `trunk`, `motorway_link`, `trunk_link`, `service`, `track`, `path`, `cycleway`, `footway`, `steps`, `pedestrian`, `living_street`.

**Fix 3 — Building proximity gate:** Inference was too broad — sidewalks appeared on rural roads, through parks, along open coastline. Gate: skip any road with no building centroid within 30m of any road point. 30m calibrated from road half-width + curb + sidewalk + building half-depth for Eixample (typical: ~23m). Threshold eliminates open-terrain roads while preserving urban streets. `buildings` threaded into `options` via `tileManager.js:1052`; no race condition — buildings decoded before `createRoadMeshes` is called.

**Fix 4 — Junction clip radius:** Previous radius `INTERSECTION_RADIUS=3m` was applied to the already-offset sidewalk polyline (offset 6–17m from center). Since `dist(offset_polyline, junction_center) ≥ offsetFromCenter`, clip at 3m never reached the sidewalk — all corners overlapped. Fix: `swJunctionRadius = base_radius + offsetFromCenter` per-road; `curbJunctionRadius = base_radius + curbOffset`. Corners now trim cleanly.

**Vertex budget impact:** Max inferred sidewalk roads per tile: 153 (tile 33159/24480). Estimated sidewalk+curb vertex contribution: 9,792 — well under 250k soft / 300k hard budget.

---

## 2026-05-29 — Phase 3: Sidewalks (panot), curbs (granite), bike lanes + pictograms

New file: `frontend/src/map/generate-road-atlas.js` — procedural Canvas2D textures for panot Flor de Barcelona (256×256, seamless) and bike pictogram (128×128 white icon).

`roadRenderer.js`: 4 new material functions (getPanotMaterial, getCurbMaterial, getBikeLaneMaterial, getBikePictogramMaterial) + setRendererAnisotropy upgraded to apply to panot texture. Old sidewalk path in buildSidewalkAndEdgeMeshes disabled (superseded). New functions: buildSidewalks (world-space UV, OSM-strict), buildCurbs (L-profile: top face + outer vertical face), buildBikeLanes (green ribbon at road edge), buildBikePictograms (InstancedMesh, 30m spacing).

`tileManager.js`: 4 new phase 3 mesh types (bcnSidewalkMesh/bcnCurbMesh/bcnBikeLaneMesh/bcnBikePictoMesh) with altitude-aware LOD thresholds (80/200/120/50m × altMult). Vertex budget: 150k→250k soft, 300k hard.

`config.js`: ENABLE_SIDEWALKS true, ENABLE_CURBS true, ENABLE_BIKE_LANES true.

No re-bake. OSM sidewalk/cycleway data from Phase 2 bake drives rendering.

---

## 2026-05-29 — Phase 2: OSM road data + one-way arrows (re-bake required)

**Gate 1 fix** (`pbfHighways.js:17`): added `oneway`, `sidewalk`, `cycleway`, `maxspeed` to KEEP_TAGS (4 tags were silently dropped at PBF parse time).

**Gate 2 fix** (`buildRegion.js:1025-1052`): emit 6 new fields in road payload — `oneway` (tri-state: forward/backward/no/null), `lanes` (int [1,12] or null), `sidewalk`, `cycleway`, `surface`, `maxspeed`. Gates 3 (convertToBinary) and 4 (tileParserWorker) pre-built, no changes needed.

**Renderer** (`roadRenderer.js:982`): `road.lanes ?? LANES_BY_TYPE[type] ?? 2` — use OSM lane count when available.

**New feature** (`roadRenderer.js`): `buildOnewayArrows()` — white triangle arrows on road surface every 30m for `road.oneway === 'forward'|'backward'`. Skips motorway/trunk/bridge/tunnel. Tagged `noMerge+onewayArrows` for 80m LOD. `ENABLE_ONEWAY_ARROWS: true` in config.

**tileManager.js**: `entry.onewayArrowMesh` tracked alongside `crosswalkMesh` — init, find, fog-cull, LOD-cull at 80m, cleanup.

**Docs**: bake-pipeline.md (Phase 2 OSM fields section), map-system.md (road tile format updated), gotchas.md G-21 (5-gate pipeline), barcelona-road-system.md §6 + §7.

**Re-bake pending.** Existing tiles have all 6 fields as null until re-bake.

---

## 2026-05-29 — LOD altitude multiplier tuning

`tileManager.js:1850`: `Math.max(1, Math.min(4, 1 + (y-5)/50))` → `Math.max(1.25, Math.min(5, 1.25 + (y-5)/35))`

Ground (Y≤5m): 1.0× → 1.25×. Y=100m: 2.9× → ~3.96×. Cap: 4× → 5×.

---

## 2026-05-29 — Phase 1: Barcelona road paint + crosswalks (Norma 8.2-IC)

New file: `frontend/src/map/barcelona-constants.js` — BCN_COLORS and BCN_DIMS, single source of truth for all road visual constants.

Changes to `frontend/src/map/roadRenderer.js`:
- Import BCN_COLORS, BCN_DIMS from barcelona-constants.js
- File docstring + constants comment: "IRC 35" → "Norma 8.2-IC"
- `CENTER_LINE_WIDTH`, `MARKING_EDGE_LINE_WIDTH`, `LANE_DIVIDER_WIDTH`: 0.15m/0.12m → `BCN_DIMS.LINE_WIDTH_LONGITUDINAL` (0.10m)
- Active vertex-color path (lines ~1025-1026): `0xe8e4dc` → `BCN_COLORS.PAINT_WHITE` (0xf5f5f5)
- Legacy material singletons (~778, ~787): same update for consistency
- New `buildCrosswalks()` function: zebra crosswalks at all eligible junctions, setback = max(junction.radius, INTERSECTION_RADIUS) + 1.5m, LOD via userData.noMerge+type tags
- Wired into `renderTileRoads` return and `createRoadMeshes`

Changes to `frontend/src/config.js`: `ENABLE_CROSSWALKS: true`

Changes to `frontend/src/map/tileManager.js`:
- `entry.crosswalkMesh: null` in entry init
- Track crosswalk mesh reference after road mesh population
- Hide at fog-cull (>FOG_FULL_DIST) and at detailDist=80m LOD threshold
- Remove from scene on tile unload

No re-bake. All frontend-only.

---

## 2026-05-29 — Camera-altitude-aware building LOD thresholds

`tileManager.js` lines 1843–1844 (multiplier) and 1974–1977 (application):
- Added `altMult = clamp(1, 4, 1 + (cameraY - 5) / 50)` computed once before the per-tile loop
- All four building thresholds (`bldgMaxDist`, `bldgDetailDist`, `lodStart`, `lodEnd`) scaled by `altMult`
- At ground (cameraY ≤ 5m): multiplier = 1, existing behaviour preserved exactly
- At 100m altitude: multiplier ≈ 2.9×, detail visible to ~522m instead of 180m
- Capped at 4× to prevent runaway at extreme altitude
- `camera?.position.y ?? 0` guard handles null camera

No re-bake. No change to Phase 2 dispatch (there is no distance gate on worker dispatch — it runs for all tiles in the 3×3 grid unconditionally).

See gotchas.md G-19 for the dead-zone that results from partial threshold scaling. See rendering.md for fog interaction note.

---

## 2026-05-29 — Three LOD/streaming fixes

**Fix 1 — Early-exit tautology (tileManager.js lines 1686–1715):**
`currentTx = tx` was assigned before `if (tx === currentTx)` — always true. Effective check was `if (allLoaded) return`, freezing LOD updates and streaming every frame once tiles loaded. Fixed: cache `prevTx/prevTy` before mutation, compare against cached values. See gotchas.md G-18.

**Fix 2 — Fog culling ignores CONFIG.ENABLE_FOG (tileManager.js line 1854):**
`FOG_FULL_DIST = 280` was hardcoded. With fog disabled for development, vegetation was still force-hidden at 280m, making tree billboards and distant meshes invisible. Fixed: `CONFIG.ENABLE_FOG ? 280 : Infinity`.

**Fix 3 — LOD/detail mutual exclusion (tileManager.js line 1983–1984):**
LOD simplified box (`lodBuildingMesh`) could show simultaneously with detail buildings (`buildingMeshes`) in the 110–180m overlap band. The LOD update loop is now the single source of truth: `lodBuildingMesh.visible = !detailLoaded && nearEdgeDist > lodStart && nearEdgeDist <= lodEnd`. Detail loaded → LOD box always hidden.

No re-bake required.

---

## 2026-05-29 — Phase 3: NaN source fix + systematic safeSceneAdd

Root cause confirmed by diagnostic probes: `greenMeshP1` was firing `[NaN SOURCE]` at position index 1 (Y coordinate). Vegetation, grass, streetlights, and embankment all silent.

**STEP 1 — Root cause fix (`greensRenderer.js:80-81`):**
- `(getElevationAt ? getElevationAt(lat, lon) : 0) ?? 0` → `Number.isFinite(rawY) ? rawY : 0`
- `?? 0` passes NaN through (NaN is neither null nor undefined); `Number.isFinite` does not

**STEP 2 — Systematic replacement (tileManager.js):**
- All 30 bare `scene.add()` calls in `processTileData` replaced with `safeSceneAdd(scene, m)`
- Covers: terrainMesh, tunnelMeshGroup, canopyMeshGroup, goreMesh, debugPhysicsHelpers, greenMeshesP1, railwayMeshes, vegMeshBatch, grassMesh, embankmentMesh, propMesh, clusterMeshes, trafficLightMesh, shoulderMesh, all streetlight meshes, barrierMeshes, crashBarrierMesh, reflectorGroup, busStopMeshes, parkingMeshes, roadInfraMeshes, decalMeshes, urbanFeatureMeshes, vendorCartMeshes

**STEP 3 — Removed diagnostic probes (`_checkNaN` helper + 5 call sites)**

**STEP 4 — docs:** G-16 in gotchas.md updated with pattern note; changelog.md updated.

No re-bake required.

---

## 2026-05-29 — Four-fix batch: NaN geometry + water type field

**Issue 2 (cosmetic) — water type field missing from tileParserWorker:**
- `tileParserWorker.js:321`: added `type: item.type` to `readPolygonFeatures` return object
- Effect: water filter logs now show real type breakdown (`stream:X canal:Y`) instead of `undefined:N`; coastline filter now works independently of open-polyline filter

**Issue 1 — NaN BufferGeometry flooding console every frame:**
Root cause: NaN values in baked elevation grids (G-06) propagate through `fastElevation` → `renderLODBuildings` (no `isFinite` guard) → LOD box vertex positions → merged `lodBuildingMesh` → `scene.add()` without NaN check.

Three-layer fix applied:

- `buildingRenderer.js:2417-2418` (Option A): `Number.isFinite(rawBaseY) ? rawBaseY : 0` — guards elevation NaN at source; buildings on NaN-elevation cells placed at Y=0 instead of NaN
- `tileManager.js:1248,1258` (Option B): `scene.add(buildingMeshes[i])` and `scene.add(lodMesh)` → `safeSceneAdd(...)` — NaN meshes never enter scene graph
- `tileManager.js:meshHasNaN` (Option C): replaced 90+30 sampler with full array scan; added one-time `console.warn('[meshHasNaN] caught NaN...')` so we can verify if Option B is actually firing

- `docs/context/gotchas.md`: G-15 (readPolygonFeatures missing type), G-16 (NaN elevation chain), G-17 (meshHasNaN full scan invariant)

No re-bake required for any of these fixes.

---

## 2026-05-29 — Open-polyline water filter (stream/canal wedge fix)

- `frontend/src/config.js`: added `RENDER_OPEN_WATER_AS_POLYGONS: false`
- `frontend/src/map/waterRenderer.js`: `isOpenPolyline()` helper (gap ≥ 1m = open); open-polyline filter applied to `rawAreas` before rendering; per-tile log shows `open-polylines:N (stream:N canal:N)` breakdown; marina/dock path (`marinaWaterPolys`) unaffected
- `docs/context/gotchas.md`: G-14 — `bufferPolyline` self-intersections documented
- `docs/context/rendering.md`: open-polyline filter section added
- `docs/context/config-reference.md`: new flag entry
- `docs/context/roadmap.md`: "Fix bufferPolyline self-intersections" and "OSM coastline assembly" added as re-bake work items

Root cause: `waterNormalize.js:bufferPolyline()` uses per-vertex normal averaging; sharp centerline bends produce self-intersecting ribbon polygons; `THREE.ShapeGeometry` fills crossings as spurious triangle lobes. 21 streams + 9 canals affected across Barcelona coastal tiles. No re-bake.

---

## 2026-05-29 — B-renderer: skip coastline water polygons (tunnel water fix)

- `frontend/src/config.js`: added `RENDER_COASTLINE_AS_POLYGONS: false`
- `frontend/src/map/waterRenderer.js`: filter out `type=coastline` water features when flag is false; logs `[Water tileId] skipped N coastline polygon(s)` per tile
- `frontend/src/map/tileManager.js`: pass `tileKey: key` to `renderWater` opts for log context
- `docs/context/gotchas.md`: documented G-13 (closePath + open coastline = inland water triangle)
- `docs/context/rendering.md`: coastline handling section added
- `docs/context/config-reference.md`: new flag entry

Root cause confirmed by tile inspection: `natural=coastline` way `id=500581857` in tile `16_33167_24479` has a 620m open gap; `closePath()` closure fills a 25,000m² inland triangle covering the Ronda Litoral tunnel approach. No re-bake required.

---

## 2026-05-29 — Ocean plane + water rendering fixes

- `scene.js`: groundMesh shrunk back to 3000m (was 60000m), ocean blue color
- `main.js`: groundMesh Y pinned to normalized seaLevelY−1.0 in animate loop (was Y=0 = spawn elev above sea → showed through coastal terrain)
- `buildRegion.js`: bake-side auto water/marina elevation fix — grid points inside water/marina polygons baked to −2.5m so terrain naturally dips at water bodies; eliminates need for runtime hole-cutting per tile
- `waterRenderer.js`: marina water uses consistent global seaLevelY (no per-tile variation → no z-fighting); depthWrite=false on water material; pier polygons rendered as gray elevated slabs +0.35m
- `tileManager.js`: marina polygons passed to buildTerrainMesh waterPolys for smooth terrain transition
- `pbfWater.js`: added leisure=marina, waterway=dock|basin to water feature capture

DEM depth note: SRTM/Copernicus DEMs have no bathymetric data (sea = 0m or nodata). The −12m in the DEM range is below-sea-level excavated port land (not actual sea floor). The bake fix sets water grid points to −2.5m artificially to create the correct visual dip.

---

## 2026-05-29 — v7 tile format: 10 new OSM feature types extracted + serialized (bake only, no renderers)

New parser files:
- `backend/worldBuilder/pbfAreaFeatures.js` — beaches, pedestrian areas, marinas (single 2-pass scan)
- `backend/worldBuilder/pbfPointFeatures.js` — traffic signals, street lamps, trees, tourism POIs, metro stations, healthcare, shops (single 2-phase scan)

Modified files:
- `pbfHighways.js` — added 'junction' to KEEP_TAGS for isRoundabout detection
- `buildRegion.js` — isRoundabout in enrichment+cloneRoad+payload; all new parsers wired; per-tile v7 count logging
- `convertToBinary.js` — v7 (was v6); new binary sections for all 10 feature types + isRoundabout on roads
- `tileParserWorker.js` — readAreaFeatures, readPointList, readTrees, readShops; all v7 fields in result; isRoundabout on roads; backward compatible with v6 (absent = [])
- `backend/worldBuilder/config.js` — 10 bake kill-switch flags (all default true)
- `docs/context/map-system.md` — tile format updated to v7
- `docs/context/roadmap.md` — NEW: deferred features backlog
- `CLAUDE.md` — roadmap.md added to TOC

Binary encoding summary:
- Area polygons: Float32 pairs [wx, wz] (same as greens)
- Simple points: Float32 pair [wx, wz] per entry via pointOffset
- Trees: flat Float32 array via treePositions + per-entry metadata in header
- Shops: flat Float32 array via shopPositions + Uint8 categories packed as Uint32 + per-entry names

NOT changed: no frontend renderers, no physics, no scene-graph additions.

---

## 2026-05-29 — Barcelona source data verified; DEM path fix

- DEM: `N41E002_DEM.tif` (SRTM GL1, OpenTopography) moved to `data/regions/barcelona/` (flat layout, matching Delhi convention)
- `backend/worldBuilder/config.js` `demPaths` corrected — removed incorrect `dem/` subfolder (it never existed)
- `docs/context/bake-pipeline.md` DEM path reference corrected to match
- OSM PBF confirmed valid (251 MB binary protobuf, not HTML)
- DEM confirmed covers bbox (lon 2.083–2.269, lat 41.330–41.467); elevation range −12 to 515 m; NoData −32768
- Delhi tiles confirmed preserved at `backend/tiles/delhi/`
- Osmium not installed — full Catalonia PBF will be used unclipped (acceptable; bake pipeline already clips to bbox internally)
- Feature gap documented: beaches (`natural=beach`), marina, metro stations, individual trees, traffic signals, shops, tourism POIs, Montjuïc cable car — all ignored, available for future enrichment
- **Ready to bake**: `cd backend && node worldBuilder/buildRegion.js --area eixample`

---

## 2026-05-28 — Barcelona migration scaffold + spawn refactor

**Region migrated: Delhi → Barcelona.** No re-bake yet — Delhi tiles preserved as fallback.

Files changed:
- `frontend/src/spawnConfig.js` — NEW: single source of truth for spawn (41.3915°N, 2.1649°E)
- `frontend/src/projection.js` — ORIGIN updated (28.49/77.08 → 41.350/2.115); START_LAT/LON re-exported from spawnConfig
- `frontend/src/main.js` — imports START_LAT/LON from spawnConfig; uses getActiveSpawn() for spawn tile
- `frontend/src/scene.js` — imports START_LAT/LON from spawnConfig
- `frontend/src/workers/vegetationWorker.js` — ORIGIN_LAT/LON updated
- `frontend/src/workers/buildingWorker.js` — ORIGIN_LAT/LON + MERCATOR_SCALE updated (28.5°→41.4°)
- `frontend/src/map/mapLoader.js` — REGION default 'delhi'→'barcelona'
- `backend/projection.js` — ORIGIN_LAT/LON updated
- `backend/worldBuilder/config.js` — complete rewrite for Barcelona bbox + DEM paths
- `backend/worldBuilder/demLoader.js` — test point: India Gate → Sagrada Família
- `backend/worldBuilder/buildRegion.js` — DEM loading + terrain grid sampling + road DEM elevation
- `backend/worldBuilder/convertToBinary.js` — hardcoded 'delhi' → CLI arg (default 'barcelona')
- `docs/context/spawn-system.md` — NEW: spawn system documentation
- `docs/context/coordinate-systems.md` — updated origin values + 5-file sync warning
- `docs/context/bake-pipeline.md` — DEM sourcing steps + Barcelona-specific risks
- `CLAUDE.md` — updated description + quick-start commands + spawn-system TOC entry

**Needs external data before bake:**
1. `data/regions/barcelona/region.osm.pbf` (Geofabrik Catalonia)
2. `data/regions/barcelona/dem/N41E002_DEM.tif` (Copernicus GLO-30)

**IMPORTANT — do not delete** `backend/tiles/delhi/` until Barcelona bake verified.

---

## 2026-05-28 — Context system created

Initial creation of the full `/docs/context/` persistent context system from deep technical analysis of the codebase. Documents created:
- `CLAUDE.md` — root index + golden rules + quick-start
- `docs/context/architecture.md` — full stack, scene graph, game loop, ASCII diagram
- `docs/context/coordinate-systems.md` — all coordinate spaces, X-mirror, elevation
- `docs/context/map-system.md` — tile format, loading flow, LOD, collision stack
- `docs/context/vehicle-system.md` — physics model, transmission, input, camera
- `docs/context/rendering.md` — materials, post-processing, shadows, geometry merging
- `docs/context/bake-pipeline.md` — OSM→binary pipeline, re-bake guide
- `docs/context/config-reference.md` — all CONFIG flags, live/dead status
- `docs/context/gotchas.md` — 12 documented invariants and landmines
- `docs/context/decisions.md` — 10 ADR-style decision records
- `docs/context/glossary.md` — confusing terms and naming pitfalls
- `docs/context/changelog.md` — this file

State at time of analysis:
- `CONFIG.ENABLE_CAR: true` (car mode active)
- `CONFIG.ENABLE_DAY_NIGHT: false`
- Binary tile format v6 in use; NaN water fix pending re-bake
- Worker pool: 2–4 geometry workers; 1 tile parser worker
- Physics: NaiveBroadphase (SAP blocked by Trimesh AABB issue)

## 2026-06-10 — Simple-tunnel deck now renders (fix: carved pit with no ramp)
- Root cause: simple-tunnel mode carved the ramp opening but drew no road in it — `buildTunnelMeshes` (the only descending-deck renderer) is gated behind `ENABLE_TUNNEL_VISUALS:false`, and `roadRenderer` skips `road.tunnel`. Result: a disconnected pit ("weird position, no ramp going in").
- Verified baked data is correct: tunnel decks descend to ~−6 m, portals ramp 0→−6 m (depth profiles measured per-tile). The depth-window carve (−0.3…−5 m) was opening the right band.
- Added `buildTunnelFloor()` (tunnelRenderer.js): lean deck-only mesh (no walls/ceiling/LED/portal/sign), wired into the simple-tunnel `else` branch in tileManager.js. Renders the descending deck wherever it's below local terrain → road is continuous down the opening and under the terrain roof.
- Frontend-only; no re-bake. See G-50.

## 2026-06-10 — Terrain & tunnel rework: plan saved, Phase 0 surveys done
- Added `docs/context/terrain-tunnel-rework-plan.md` (working tracker, 5 phases, drive-test-gated) + TOC entry in CLAUDE.md.
- Phase 0 surveys complete (read-only): smoothing chokepoint = the global raster pass in `demLoader.js` (`smoothRaster` :93; all sampling funnels through `sampleElevation` :174 — Phase 1 extends this, not a new subsystem); full emergent-tunnel inventory (bake carve constants, remaining absolute-Y constants, fall-through mechanism) recorded in the plan's Phase 0 Findings.
- `parkingRenderer.js` `[0]/[1]` residual: already fixed (G-46), full-file grep clean — no change.
- G-49 collider fix code-verified (`createTerrainTrimesh` prefers 64-grid visual bakedTerrain, exact rendered transform). Awaiting user Montjuïc drive test = Phase 0 gate.
- Spawn moved to Montjuïc approach (41.3700, 2.1600, tile 16_33161_24481) for the Phase 0 slope drive-test gate; previous Gran Via tunnel spawn (41.40606, 2.12031) noted in spawnConfig.js for Phase 3 restore. CLAUDE.md spawn line was stale (said Sagrada Família) — corrected.

## 2026-06-11 — Phase 0 gate fixes: off-road fall-through + spawn-drop tunneling
- Headless runtime diagnosis (Playwright probes of _debugWorld/_debugVehicle): terrain trimeshes are correct (128-grid visual-baked path, 16384 verts/tile, AABBs tile correctly, road-vs-terrain co-framed to 0.23 m) but collided with NOTHING — chassis mask was WORLD only (D-16 revert under-restored it; G-49 backstop needs WORLD|TERRAIN), and cannon-es rays can't hit Trimesh (reconfirmed: interior down-rays MISS).
- Fix 1: carPhysics.js chassis collisionFilterMask → WORLD | TERRAIN. D-16 status annotated (revert correction).
- Fix 2: main.js spawn Y — was hardcoded y:2 in the spawn-lat/lon frame while the snapped road sat ~18 m downhill (Montjuïc) → ~20 m free-fall tunneled wheels through the deck on impact. findRoadSpawn now returns interpolated elevRaw; spawn y = toNormalizedRoadY(elevRaw)+0.5 (~2.5 m drop with carDriver's +2).
- Both runtime-verified headless (mask=20, pair-check=true, chassis settles at road level). Awaiting user on-screen Phase 0 gate re-test.
- G-51 hygiene (same fix, follow-up): added `assertTerrainVehicleHandshake()` in collisionGroups.js, called from BOTH creation sites (createTerrainTrimesh + chassis setup) — a future one-sided mask revert now throws at startup instead of silent fall-through. New gotcha G-51 (two-sided filter contract, cites the D-16 revert incident). Corrected stale "64-grid" labels to 128-grid (gotchas G-49, tracker, tileManager comment). Build green; startup assert verified passing headless (5 trimeshes created after chassis → assert exercised non-vacuously, pairCheck=true, mask=20).

## 2026-06-11 — Terrain physics rebuilt on Heightfield (gate attempt 2 root cause)
- User still fell off-road after the mask fix. Engine source + runtime: cannon-es has NO box-vs-trimesh narrowphase (only sphere/plane); manual-stepped drop test fell through the trimesh with zero contacts → the G-49 chassis-backstop-on-trimesh premise was always false. G-49 gotcha corrected.
- Found the original heightfield bug (why D-16 reverted it): buildTerrainHeightfield downsampled to TERRAIN_MAX_GRID=64 but indexed the 128-wide source grid with 64-range indices → SW quadrant stretched over the tile ("car trapped below terrain"). Fixed by using the full source grid.
- tileManager Phase 1 now builds a per-tile CANNON.Heightfield (group TERRAIN, mask VEHICLE, physics-frame conversion, G-51 assert); inert trimesh build removed (−88 ms/tile). Runtime-verified: placement ≤0.01 m vs trimesh (33 samples), slope drop-tests settle with wheel contact, wheel rays hit heightfields → genuine off-road driving. D-16 physics half now effectively shipped.
- Accepted consequences: no carved tunnel-mouth physics holes until Phase 3; ground plane at y=−50 vs coastal terrain below −57 is a Phase 2 item.

## 2026-06-11 — Phase 0 ✅ (gate passed on screen) · Phase 1 selective terrain smoothing implemented
- Phase 0 gate confirmed by user: car holds off-road on Montjuïc, FPS holds. Tracker updated with full gate history (attempt 1: chassis-mask handshake → attempt 2: no box-trimesh narrowphase → heightfield rebuild → attempt 3 PASS).
- Phase 1: added `selectiveSmoothRaster` in demLoader.js after the uniform box blur — two-scale frequency split + soft shrinkage (`out = bigBase + shrink(base−bigBase, FLATTEN) + shrink(src−base, FLOOR)`). Knobs: TERRAIN_RELIEF_FLOOR=2.5m, TERRAIN_FLATTEN_THRESHOLD=3m, split radii 10px(~300m)/30px(~900m); both=0 disables. Docs: bake-pipeline.md.
- Orphan terrain/terrainSmoothing.js reviewed: 3×3 per-tile primitives + uniform blend — wrong scale/place, not reused.
- A/B through real sampleElevation: Montjuïc climb 143.3→133.7m (93% kept), coast descent 16.9→16.8m (kept), Eixample wiggle RMS 0.398→0.017m (96% gone). Chokepoint verified: no consumer bypasses the raster.
- Full-region re-bake launched with default knobs (tune by driving).

## 2026-06-11 — Phase 2: audit + approved deletions (foundation simpler on smooth terrain)
- Audit numbers: false bridges 163/277 & 172/338 → **0/277 & 0/338** (tiles 16_33160_24481 / 16_33161_24481; region-wide 47 bridge roads, all OSM-structural). Terrain-physics build 65–91 ms → **0.5–3 ms/tile** (heightfield vs trimesh). G-51 assert clean on every tile. Water-sink machinery audited: all KEEP (guards OSM data quality, terrain-relative — not noise-cope).
- D1 DELETED: `isElevatedByHeight` deck-collider gate + its mirror in the overlap pre-pass (tileManager.js) — phantom-deck factory + live G-47 absolute-Y bug. Deck colliders are now structural-flags-only; surface roads ride the heightfield. Dependency on Phase-0 heightfield recorded in D-16.
- D2 DELETED: `smoothElevation` per-road moving average (elevationProcessor.js) — never enabled (window=0 everywhere), purpose handled at source. No re-bake needed (dead code, baked output unchanged).
- D3 KEPT with rationale comment at roadRenderer.js guardrail gate: above-terrain-frame test, not noise-cope — do not re-flag.
- Smoke after deletions: build green, 4-wheel off-road hold on slope drop, surface roads deckless, no page errors. Awaiting Phase 2 sanity drive.
- Phase 2 follow-ups from sanity drive: ROAD_VISUAL_ABOVE_TERRAIN 0.22→0.06 (was sized for bumpy DEM; with wheels on the heightfield post-D1 the slab floated ~30cm above wheel contact → tires sank into the road visual). Camera follow distance 6.5→8.2 (+height 1.7→2.1, clamp 7.5→9.3) per user feedback. Frontend-only, no re-bake.
- Camera "too close at spawn" root cause: tunnel-cam mode gated by absolute `p.y < -1` (G-47) — permanently active on Montjuïc (car Y≈−16). Now gated by isInTunnelZone(x,z) corridor registry; TUNNEL_Y_THRESHOLD removed. Verified on rendered screen. (The 8.2m follow distance applies now.)

## 2026-06-11 — Phase 3 slice ①: floor-validator baseline (report-only, no code touched)
- Design approved (authored-tunnels-design.md) with distribution-report adjustment + Phase-4 carve hand-off note.
- Validator walked all 376 drivable tunnel road-copies on the current bake: 53,026 samples @2m — every gap ≤0.05m, zero holes, zero NaN/degenerate. Triage: 376 CLEAN / 0 GAPPED / 0 HOLES. Centerline floors are own-deck-guaranteed; real risks are lateral shrink + joint wedges (gate-drive items). Proposed blocking tolerance for ③: 0.3m. Entry (sealed grid) confirmed as the only blocker → slice ② trench authoring is the critical path.

## 2026-06-11 — Phase 3 slice ②: open-cut trenches authored into the elevation grid
- New worldBuilder/terrain/trenchAuthor.js + buildRegion wiring (global corridors pre-loop, per-tile carve as last grid mutation, water-cell guard). 218 drivable tunnel roads → 685 corridor segments; 53 tiles cut in the full re-bake (372s, clean).
- FORBIDDEN-BAND rule replaced profile classification: cell = open-to-floor OR roof ≥5m (=CARVE_COVER); between → cut to roadY−0.15. Portal cliff self-places where real cover hits 5m (past the lip).
- Measured: adjacent drivable-road depression 0.000m; floor validator still 376/376 clean (≤0.05m, zero holes); 2.8% forbidden-band residue at portal-lip transition cells → slice ④ blend. Screenshot: car below grade inside the trench, holding.
- Trench knobs: TRENCH_MARGIN=1.5m, FLOOR_BELOW_ROAD=0.15m, ROOF_CLEARANCE=5m, MIN_CUT=0.05m.
- Spawn moved to the Sant Gervasi/Ronda de Dalt trench portal (41.4098, 2.1257, tile 16_33154_24471) for the slice-② trench drive check. Previous spawns noted in spawnConfig.js.
- Tunnel-zone camera pulled back: distance 4.0→5.5 (new TUNNEL_CAM_DISTANCE const), height 1.0→1.2, per user feedback.

## 2026-06-11 — Phase 3 slice ② Option L: daylighted corridors + crossesTrench decks
- Geometric impossibility recorded (design §2): heightfield y(x,z) can't open its own cliff face → sealed-roof tunnels are un-enterable, definitionally. Option L approved: corridors carved open end-to-end; crossing streets flagged crossesTrench at bake → deck colliders via the structural-flags gate; Phase 4 adds physics-free visual roof.
- En-route fixes: TRENCH_MARGIN 1.5→4.0 (car-blocking sawtooth wedges in roadway), legacy visual mouth/corridor culling DISABLED (punched holes in the trenched mesh), crossesTrench plumbed through 4 whitelist layers + parser + deck gate, flag skirt pad 5.5m (bilinear trench skirt).
- Full bake clean (589s): corridor continuity 52,083 open samples, portal-face band GONE (was the wall); floors 376/376 ≤0.05m zero holes; 434 crossing roads flagged; inverse clause finds 32 deckless floating samples on 2 roads — pre-existing native-dip class, not trench-caused (slice ③ scoping note).

## 2026-06-11 — Slice ② drive-feedback round: R-key recovery, shoulder cuts, closure pass
- R = recover (carDriver.js): breadcrumb of last upright ≥3-wheel pose every 2s; R teleports back (+0.8m, velocities zeroed, 1s cooldown) — escape from trench-wedge/flip/stuck (user got pinned at a trench wall with no recourse).
- Half-buried parallel roads (trench wall slicing through road width): SHOULDER CUTS — near-trench spans of drivable surface roads carve the grid to their own roadY−0.15 (min-only; deeper trench under bridges untouched) → roads sit on benches, sawtooth wall pushed off road edges. 1,533 shoulder segments.
- Shoulder cascade closed analytically: flagFloatersOverCarve flags roads floating >2m over the FINAL carved surface (corridors+shoulders, computable pre-tile-loop) → +109 roads flagged (685 total tile-copies). Inverse-clause violations 170→32 — all remaining are the 2 pre-existing native-dip roads (not trench-caused).
- Floors remain 376/376 CLEAN ≤0.05m, zero holes. Bake 641s clean.
- Known visual remainders for Phase 4: flagged crossing streets float without bridge structure (physics correct via decks); trench wall sawtooth silhouette (3.6m cell aliasing) to be dressed by retaining-wall/portal visuals; visual roof for covered sections.
- Floating crossings → full bridge dressing: added `crossesTrench` to all four isElevated visual gates in roadRenderer (bridge slab + pillars + guard rails + metal railing). The existing production bridge renderers now dress flagged crossing streets; pillars reach the trench floor via getElevationAt (trenched grid). Frontend-only, no re-bake. The at-grade spans of flagged roads stay undressed automatically (min-structure-height gate).
- 2026-07-02: Building colliders — chamfered/angled (non-rectangular convex) footprints now get an exact CANNON.ConvexPolyhedron prism collider instead of an over-covering OBB box. Fixes car getting stuck on the corner sidewalk at Eixample chamfered corners (invisible wall from the box over-covering the 45deg cut). Rectangles keep the cheap OBB; concave footprints fall back to OBB. Face windings auto-corrected outward so a winding mistake can't silently break building collision. (tileManager.js buildConvexPrism + buildBuildingColliders)
- 2026-07-02: Car handling — tamed tail-happy oversteer on normal turns. (1) turnDrift (non-handbrake rear grip loss) cap 0.4->0.1 & ramp /80->/130 so steering alone no longer breaks the rear loose. (2) Added quadratic anti-spin stability: torque.y -= yawRate*|yawRate|*YAW_SPIN_DAMP(2600) when NOT handbraking & speed>3 — negligible in normal turns, firm on a fishtail/spin. Handbrake drift path untouched (DRIFT_YAW_ASSIST + rearSlip only when _handbraking). carPhysics.js
- 2026-07-02: Perf — TREE_MAX_DISTANCE 220->170, TREE_FULL_DISTANCE 90->80. Diagnosis from live metrics (53 FPS, 5.1M tris, 129k trees): tree GEOMETRY already minimal (TRUNK_RADIAL_SEGMENTS=3, FOLIAGE_DETAIL=0, ~117 tris/tree), so the only lever is 3D-tree COUNT. Pulling the 3D radius 220->170 cuts ~40% of full-3D trees (area r^2: 170^2/220^2~0.6); rest become 2-tri billboards, fog+billboard-look mask the swap. Scene is GPU-vertex-bound (686 draw calls fine). config.js
- 2026-07-02: Tile-load car jitter — time-sliced the per-tile collider finalize (buildSceneryColliders/buildBuildingColliders + world.addBody now yield between steps) so a dense tile's collider burst spreads across frames instead of freezing one (the freeze jolts the car at speed). tileManager.js
- 2026-07-02: Night road markings/crosswalks too bright — added setRoadMarkingNightMode() (dims shared unlit _mergedMarkingMaterial 0xB0B0B0->0x3d4247 at night); wired into envToggle night toggle. roadRenderer.js, envToggle.js
- 2026-07-02: Skid marks regressed (only handbrake). Root causes: ENABLE_SKID_MARKS was false + skid gated on handbrake-only _driftFactor. Fix: added physics.getSkidLevel() (max of steering/handbrake drift, real sideways slide |lateralSpeed|/4, and hard-braking lockup >22kmh); carEffects uses it; ENABLE_SKID_MARKS->true. carPhysics.js, carEffects.js, config.js
- 2026-07-02: Direction boards restyled Delhi green -> Barcelona/Spanish white urban directional: white retroreflective panel, charcoal border+keyline, solid charcoal arrow, single street name in Catalan Title Case (toCatalanTitleCase, particles lowercase) shrink-to-fit — replaces duplicated ALL-CAPS. Removed dead HINDI_MAP/transliterateToHindi. roadInfraRenderer.js
- 2026-07-02: Skid marks invisible — were placed at wheel-contact hit.y+0.02, but hit.y is the TERRAIN heightfield and the visual asphalt floats ~0.11m above it (ROAD_OFFSET+ROAD_VISUAL_ABOVE_TERRAIN) → buried under the road. Lifted to hit.y+0.15 (on asphalt, under paint at +0.19). Also eased getSkidLevel triggers (slide /4->/3, brake floor 22->18kmh) so hard turns/braking actually leave marks. carEffects.js, carPhysics.js
- 2026-07-02: Direction board — long street names now wrap to two balanced lines (splitTwoLines) when a single shrunk-to-40px line won't fit, else single line. roadInfraRenderer.js
- 2026-07-02: New-area stutter — reworked the tile-build frame budget into a SHARED per-frame budget: _frameBudgetStart now resets once per frame in tileManager.update() (not per-yield), and yieldToMain no longer resets it, so all tiles finalizing concurrently share one cap. FRAME_BUDGET_MS 6->4. Made materializeVegetationMeshes async + yield every 600 instances (was the biggest un-yielded block: double loop over every tree instance). Net: total tile build work per frame is bounded no matter how many tiles enter range → area loads spread across frames instead of freezing. tileManager.js, meshMaterializer.js
- 2026-07-02: Removed roadside/tree-base bush tufts (scattered grass clumps on streets/crosswalks) — new CONFIG.ENABLE_BUSHES:false gates bushMesh creation in materializeVegetationMeshes (main + zone). Also trims per-tile load cost. config.js, meshMaterializer.js
- 2026-07-02: Pedestrians vanishing on approach — reassign() wiped the whole crowd (peds.length=0) and respawned a random set every REBUILD_DIST(40m), so anyone you drove toward got deleted+replaced at the boundary. Rewrote reassign to be INCREMENTAL: keep in-range peds (thrown ones finish first), cull only those who left RANGE, top up to target with newcomers spawned >30m away (no pop-in nearby). pedestrians.js
- 2026-07-02: Traffic cars vanishing on approach — cars followed a SINGLE road segment and were deleted at its end (v1 no-chain), so they popped out of existence at every segment end in view. Added road CHAINING: buildPath now returns start/end world coords + takes a direction; extendPath() appends the best forward-continuation connected road (CONNECT_DIST 9m) as a car nears its path end; dead-end fallback U-turns near the player / despawns only if far (>45m). trafficSystem.js
- 2026-07-02: City life pass 1 — tree variety + density. FOLIAGE_COLORS reworked Delhi 'dusty greens' -> fresh varied Mediterranean palettes (plane/elm/cypress/mixed); DUST_BLEND_MAX 0.35->0.12 (Barcelona isn't dusty); variant labels updated. PED_CAP 110->150 (instanced, cheap), MAX_CARS 22->28 (modest). vegetationRenderer.js, pedestrians.js, trafficSystem.js
- 2026-07-02: Color grade — rewrote the near-neutral warm-tint pass into a proper filmic grade: saturation (x1.18), gentle contrast S-curve (pivot 0.18, x1.10), warm-highlight/cool-shadow split-tone, black lift, stronger vignette (0.24). Scalable via uGradeStrength (window._colorGradePass). colorGradePass.js
- 2026-07-02: Grass REALLY removed — root cause was 'config.MAX_GRASS_PER_TILE || 50000' in vegetationWorker: 0||50000 = 50000 (falsy-zero), so MAX_GRASS_PER_TILE:0 produced MAX grass. Fixed to ?? + early-return when <=0; also gate the whole grass phase in tileManager when <=0 (skips the worker). vegetationWorker.js, tileManager.js
- 2026-07-02: LOD tree billboards matched to 3D trees — atlas colours updated Delhi-olive+dust -> fresh Mediterranean greens (per FOLIAGE_COLORS), removed dust gradient. Added setTreeBillboardNightMode (unlit billboards now darken at night like the lit 3D trees; 4 shared mats so all tiles update). Wired into envToggle. vegetationRenderer.js, envToggle.js
- 2026-07-02: Night streetlights — added setStreetlightNightMode (lamp emissive 0.25->2.8, ground pool opacity 0->0.95 at night; day defaults now dark), LIGHT_SPACING 30->22 (denser), wired into envToggle. streetlightRenderer.js, envToggle.js
- 2026-07-02: Traffic cars now have glowing head/tail lights — addCarLights() attaches 4 emissive quads (white +Z front, red -Z rear) to the unscaled outer template group so every clone inherits them (shared geo+2 mats). carModels.js
- 2026-07-02: Night too dark — NIGHT preset lifted: ambient 0.75->1.15, hemi 0.08->0.20, moonlight dir 0.30->0.45, exposure 1.0->1.05, bg slightly lifted. envToggle.js
- 2026-07-02: Shop name boards — new shopSignRenderer.js: atlas of 24 Spanish/Catalan+English shop names, one InstancedMesh per tile (per-instance aUvOffset picks the cell; text U flipped for worldGroup mirror), placed on each building's longest street-facing edge at fascia height. Wired into tileManager Phase 4 + unload sweep; CONFIG.ENABLE_SHOP_SIGNS. shopSignRenderer.js, tileManager.js, config.js
- 2026-07-02: Crosswalk/markings still bright at night — timing bug: the shared marking material could be created AFTER the night toggle fired (fresh = bright). Persisted _markingNight state + getMarkingMaterial() applies it at creation; darkened night value 0x3d4247->0x2a2f36. roadRenderer.js
- 2026-07-02: Parked cars too dark at night — added glowing head(white)/tail(red) lights: two shared InstancedMeshes populated per parked car from per-variant local light-quad matrices (dims-based), transformed by the car matrix. parkedCars.js
- 2026-07-02: Marking brightness re-tuned (unlit, hand-set per time of day): MARK_DAY 0xB0B0B0->0x8a8a8a (too bright by day), MARK_NIGHT ->0x565b62 (soft moonlit grey; 0x2a2f36 was too dark). roadRenderer.js
- 2026-07-02: ESC menu (ui/escMenu.js) — gamified pause overlay opened by ESC (+ ☰ button top-left). Global place SEARCH via Nominatim geocoding: valid Barcelona-area place -> reload with ?spawn=lat,lon (spawnConfig applies it at init); out-of-bbox place -> error. 8 quick-spawn landmark chips. Re-parents the car-colour panel (#dd-car-color-panel) + day/night toggle into the menu. HUD-metrics toggle (hides metricsPanel+performancePanel, persisted). spawnConfig.js parses ?spawn; carControls ignores keys while typing in an input; carDriver sound-toggle lookup now by id. escMenu.js, spawnConfig.js, main.js, carModel.js, carDriver.js, carControls.js
- 2026-07-02: ESC menu redesigned to FULL-SCREEN dashboard — two-column: left = spawn search + landmark button-grid + car colour + day/night + HUD-metrics toggle; right = LIVE STATS cards (speed, fps, road, lat, lon, heading, draw calls, triangles) updated each frame while open via escMenu.update() (reads renderer.info; rolling fps). escMenu.js, main.js
- 2026-07-02: ESC menu -> Firewatch-style settings screen: gold-on-dusk, top logo + tabs (GENERAL/GRAPHICS/CONTROLS/STATS), centered section headers, sliders + checkboxes, ESCAPE·BACK. GENERAL=spawn search+landmarks+car colour; GRAPHICS=Brightness+Colour sliders (wired to colorGradePass uBrightness/uGradeStrength, persisted) + Night mode + HUD metrics checkboxes; CONTROLS=key map; STATS=live cards. escMenu.js, main.js
- 2026-07-02: colorGradePass — added uBrightness uniform (overall exposure multiplier) for the Graphics brightness slider. colorGradePass.js
- 2026-07-02: ESC settings restyled to game UI — Rajdhani display font, angular clip-path notched panels/buttons/toggles, gold glow + hover, section header bars, scanline/sheen overlay, chunky ON/OFF toggle switches, keycap control rows. escMenu.js
- 2026-07-02: Bus stops floating/sunk (also the 'black object with a light' embedded in the road) — busStopRenderer calls its elevation fn with WORLD coords, but tileManager passed getElevationAt (lat/lon) → garbage heights. Now passes getGroundY (world-coord). tileManager.js
- 2026-07-02: Car looks sunk at crossings — root: wheels ride the terrain heightfield (D-16) while road slab+paint float above. Shaved ROAD_VISUAL_ABOVE_TERRAIN 0.06->0.05, CROSSWALK_Y_ABOVE 0.08->0.055, MARKING_Y_ABOVE_ROAD 0.08->0.06, ARROW_Y_ABOVE 0.04->0.035 (all still clear the ±3.5cm road noise) so paint no longer floats ~0.14m over the wheels. No re-bake; the residual ~0.05m is by-design (D-16, not reopening the physics-instability tradeoff). roadRenderer.js
- 2026-07-02: Settings menu -> Brawl-Stars style: Lilita One font, chunky 3D press-buttons (bottom drop-shadow), bright colours, uses the supplied BARCELONA DRIVE logo image (public/logo-barcelona-drive.png, mix-blend-mode:screen drops its black bg). escMenu.js
- 2026-07-02: Loading screen — branded game loader in index.html (logo + bobbing animation + red/gold indeterminate bar + 'Loading Barcelona'), shown instantly before the JS bundle; main.js fades it out after the first frames render (+20s safety net). Title -> Barcelona Drive. index.html, main.js
- 2026-07-02: UI sounds — new ui/uiSound.js (synthesized WebAudio blips, no assets; respects the shared dd_soundMuted mute). Wired into the settings menu: click on buttons/swatches, toggle chirp, open/back whooshes, GO confirm chirp. escMenu.js
- 2026-07-02: Loading screen now holds until the spawn-area tiles are actually built — added tileManager.isInitialLoadComplete() (no tiles in-flight/queued after loading started); main.js polls it (150ms, ~20s cap) before fading the loader, so the world isn't visibly popping in. tileManager.js, main.js
- 2026-07-02: Loading screen shows rotating Barcelona facts — 32 facts/stats, random every 3s, via an inline script in index.html (runs before the JS bundle so they appear instantly). index.html
- 2026-07-03: Sound system rework (sample-based, graceful fallback). New audio/audioManager.js — single shared AudioContext + master gain (volume+mute, persisted), buffer loader tolerating missing files. carSound.js: routes through the shared master; adds sample engine (idle/mid/high crossfade+pitch by RPM), sample skid + ambience; SYNTH kept as fallback when files absent. uiSound.js routed through the same master. Settings: Sound section (Volume slider + Sound on) wired to audioManager; hid the old speaker btn. Horn (H) plays horn sample. Drop files into public/audio/ (see README). audioManager.js, carSound.js, uiSound.js, escMenu.js, carDriver.js
- 2026-07-03: Traffic pass-by whoosh (audio.whoosh — car_pass sample or synth doppler sweep, panned by side, fired once per pass in trafficSystem) + day/night ambience swap (carSound.setNight crossfades ambience/ambience_night samples, or nudges the synth bed; wired via onNightModeChange). audioManager.js, trafficSystem.js, carSound.js, carDriver.js, main.js
- 2026-07-03: Engine sound reworked — was too bassy + not tracking gears. Fixed carSound RPM constants to match physics (850/6500, was 800/5500 → saturated early). Switched from muddy 3-pitch-variant crossfade to a SINGLE engine loop pitched 0.7x→2.0x by RPM (clear rev sweep per gear + drop on shift), routed through a high-pass (160Hz+, opens with revs) + 1.6kHz presence peak to cut boom. audio.loop gained a dest param. carSound.js, audioManager.js
- 2026-07-03: Removed the synth wind (it masked the engine) + boosted engine sample gain (idle 0.5->0.9, full boost too). carSound.js
- 2026-07-03: (1) Speed camera shake — rumble now starts ~30km/h (was 95) and ~3.4x stronger (carCamera.js). (2) Engine louder — high-pass 160->85Hz (was cutting the body/loudness) + car submix MASTER_VOLUME 0.55->0.78. (3) City ambience audible — setNight was capping the single bed at 0.16; raised to 0.6 day / 0.45 night. carSound.js
- 2026-07-03: Speed shake was shaking at slow speed — raised threshold 30->85 km/h, amplitude 0.12->0.05 (subtle, high-speed only). carCamera.js
- 2026-07-03: Sidewalk 'collision' was actually the STREET TREE colliders (boxes at the curb, WORLD group) — car stopped dead on touching a sidewalk. Added CONFIG.ENABLE_TREE_COLLISION (false) to gate them off; trees now decorative/drive-through, buildings still block. (Barriers/crash-barriers already off; normal streets have no road trimesh collider.) config.js, tileManager.js
- 2026-07-03: Title/start screen — index.html #dd-title (shared sky background + centered logo + gamified PLAY button, z above the loader). Shows on first load; PLAY fades it out and drops into the game (which loads in the background meanwhile). Added public/title-bg.png. index.html
- 2026-07-03: Title screen background — grayscale->colour reveal on load (ddColorIn 2.2s) + slow breathing zoom in/out (ddBreathe 20s) + stronger vignette. Background moved to its own .bg layer so the effect doesn't touch the logo/text. index.html
- 2026-07-03: Title screen — grayscale->colour reveal now via an expanding radial MASK from centre (two stacked bg layers: grayscale base + colour revealed by animated mask-size). Tagline restyled: solid black parallelogram (clip-path), bold (Poppins 700), tighter letter-spacing. index.html
- 2026-07-03: Title-screen routing — title now shows ONLY on fresh entry to '/'. PLAY does history.replaceState to '/game' + sets sessionStorage dd_played; on load the title is skipped if pathname is /game OR ?spawn present OR dd_played set. Fixes the PLAY screen reappearing after a Settings spawn-location change (which reloads with ?spawn). index.html
- 2026-07-03: Default mode = CAR (CONFIG.ENABLE_CAR true). Fly mode now opt-in via Settings toggle (persists dd_flyMode, reloads to switch) or ?mode=fly. main.js reads dd_flyMode after URL params. Loading screen: removed 'Loading Barcelona' text, pushed 'Did you know?' lower. config.js, main.js, escMenu.js, index.html
- 2026-07-03: Day/night toggle (top-right) restyled to gamified chunky 3D pill (gold/sun day, blue/moon night, press-down) to match settings toggles. envToggle.js
- 2026-07-03: City-life pass. NEW awningRenderer.js — projecting fabric "toldo" awnings over ground-floor shopfronts, laid as short segments along each building's longest street-facing edge (same edge as the shop signs), sloped canopy + vertical front valance, 8-colour Barcelona palette, all merged into ONE vertex-coloured MeshLambert per tile (1 draw call, dims with day/night lights). New flag CONFIG.ENABLE_AWNINGS (default true); wired in tileManager Phase 4 next to shop signs + added to the unload sweep. Denser crowds: pedestrians PED_CAP 150->210, CAP_PER_CELL 40->55, density target 0.5->0.62 of candidates (instanced flipbook, cheap). Fixed stale "Indian roadside trees" comment in vegetationRenderer (variants are already Barcelona plane/elm/cypress/mixed). awningRenderer.js, tileManager.js, config.js, pedestrians.js, vegetationRenderer.js
- 2026-07-03: City-life pass #2. NEW cafeTerraceRenderer.js — café terraces (parasol + round table + 2 chairs) on the sidewalk in front of a deterministic ~34% of buildings with a wide (>=12 m) street-facing frontage. Tables sit ~1.95 m out from the façade (past the awning line), 1-4 per frontage, random yaw. Two InstancedMeshes per tile sharing one set of per-table transforms: furniture (merged table+poles+chairs, baked vertex colours) + canopies (parasol cone, per-instance setColorAt from a 7-colour palette) → 2 draw calls/tile, dims with day/night. Shared singleton geo/mat flagged sharedGeometry+sharedMaterial so tile unload doesn't dispose them. Decorative only (no colliders, drive-through like trees). New flag CONFIG.ENABLE_CAFE_TERRACES (default true); wired in tileManager Phase 4 + unload sweep. cafeTerraceRenderer.js, tileManager.js, config.js
- 2026-07-03: NEW collisionDebug.js — ?debug=collision (alias ?debug=walls) draws EVERY collidable physics shape within 50 m of the car as tracking wireframes: box (green), ConvexPolyhedron/building corner-prisms (magenta), trimesh (orange), Cylinder (cyan), Sphere (yellow). Skips Plane + Heightfield so only hittable things show. Bottom-left HUD counts each type. Fills the gap in debugColliders.js (which only draws Box/Plane/Heightfield) — invisible convex/cylinder colliders that stop the car are now visible. Wired in main.js (init + per-frame update). collisionDebug.js, main.js
- 2026-07-03: Loading bar fill flat orange (#ff7a1a) instead of red→yellow gradient. index.html
- 2026-07-03: collisionDebug.js reworked — range filter now anchored on the CAMERA (rides with the car) instead of a guessed "first dynamic body" (which could be a wrong/absent body and filter everything out). Added runtime K-key toggle (works without the URL param) + a diagnostics HUD (total bodies / static / shown counts by type). main.js passes camera. collisionDebug.js, main.js
- 2026-07-03: Bus stop placement fix — shelters were landing mid-road when a stop snapped to a narrow service lane beside a wide avenue (offset used only the snapped road's half-width). busStopRenderer now searches outward on the preferred side, then the other side, for a spot that clears EVERY nearby road's carriageway (intrudesOnRoad + distToRoad helpers, clearance = shelter half-depth); if none clears (e.g. stranded between dual carriageways) the stop is skipped instead of planted in a lane. Render-time fix, no re-bake. busStopRenderer.js
- 2026-07-03: Building collider over-cover fix. Concave footprints (L/U-shaped Eixample blocks) previously fell back to a single oriented bounding box, which fills the notch and juts out over the sidewalk/road as an invisible wall — the cause of "car stops in the middle of nowhere". Now concave (>4-vertex) footprints are traced with thin per-edge perimeter wall colliders (addPerimeterWalls) that hug the real wall line. Walls are 2 m thick, offset fully INWARD so the outer face sits exactly on the footprint edge (zero outward intrusion) and they resist fast-car tunneling. Rectangles keep the cheap OBB, convex >4 keep the exact convex prism. Runtime fix, no re-bake. tileManager.js. Also added a Collision-wireframes toggle in ESC → Display (escMenu.js) wired to collisionDebug.
- 2026-07-03: Intensive QA pass — fixes across subsystems. CRITICAL: Phase-4 tile build now re-checks aborted() after every yield + before collider add-loops (was adding phantom colliders/meshes to unloaded tiles → invisible walls + unbounded leak). Night materials re-applied after spawn tiles build + persisted night flags (loading into night no longer half-day); shoulder day-opacity default fixed; shop signs dim at night. Input: new inputGate.js — ESC menu blocks car/recover/horn input while open; free-camera WASD bails while typing (search box usable); Escape closes menu from search; minimap Escape no longer opens settings; collision-wireframes checkbox live-syncs. Fly-mode toggle strips URL ?mode on reload + reflects resolved mode. Tile leaks: tunnel ramp bodies tracked/removed, unregisterTunnelZones(key) fix, grass+bus-stop shared-material flags, InstancedMesh instance-buffer disposal, neighborRoads key fix. Also: synth horn fallback, ?spawn bounds check, anti-flip righting at full inversion, café-terrace road clearance, single mute source of truth, whoosh rate/voice cap, volume-0==mute, recover-teleport camera-shake suppression. Files: tileManager.js, envToggle.js, shoulderRenderer.js, shopSignRenderer.js, vegetationRenderer.js, busStopRenderer.js, cafeTerraceRenderer.js, inputGate.js(new), carControls.js, carDriver.js, carPhysics.js, carCamera.js, carModel.js, carSound.js, audioManager.js, escMenu.js, minimap.js, freeCameraController.js, spawnConfig.js, main.js
- 2026-07-03: High-speed streaming stutter — two fixes. (1) Speed-scaled look-ahead: the driving-direction tile look-ahead now extends further the faster you go (LOOKAHEAD_RADIUS + min(3, speedKmh/55)), so the next tile row is fetched+built with lead time instead of bursting right as you cross the boundary. main.js passes speedKmh to update(); MAX_CONCURRENT_TILE_LOADS 2->3 so fetch keeps up. (2) One-time GPU shader warmup: renderer.compileAsync(scene,camera) after the spawn tiles build — materials are shared singletons so this compiles nearly every program the session uses, killing the first-render shader-compile stall as new tiles stream in. tileManager.js, main.js. Also: NEW shopfrontRenderer.js (ground-floor storefronts under awnings); floating peds/parked cars fixed (ground on terrain not road height).
- 2026-07-04: ROOT-CAUSE fix for floating buildings + pedestrians in hilly/port areas. The world is shifted down by the spawn elevation offset (Y = rawDEM - worldElevationOffset), so real ground at the port/hills sits at Y ≈ -offset (negative). Multiple placement paths fell back to ABSOLUTE Y=0 when the terrain sample failed — but Y=0 is the spawn-height plane, ~offset metres ABOVE the real ground, so anything hitting the fallback floated. (Car + terrain mesh never hit it → stayed grounded; per-prop fixes swapped sources but never removed the ->0 sentinel.) Fixes: getTerrainHeightAt now borrows the nearest loaded neighbour tile's terrain sampler when the exact tile has none (partial/road-only tiles); getSurfaceHeightAt + main.js terrainGroundY + buildingRenderer LOD (`:0` guard) + buildingWorker createFastElevation stub now fall back to the spawn-normalized ground floor (-offset*vertExag) instead of absolute 0. New tileManager.normalizedGroundFloor() helper. tileManager.js, main.js, buildingRenderer.js, buildingWorker.js
- 2026-07-04: Visual polish. Car paint: upgraded to MeshPhysicalMaterial w/ subtle clearcoat (metalness 0.35, clearcoat 0.4, envMapIntensity 0.5) — glossy but keeps its colour (first pass at 0.6/1.0/1.15 washed it white). Night glow pass: bloom is now day/night-aware via envToggle — DAY strength 0.5/threshold 1.1 (unchanged, daytime doesn't bloom), NIGHT strength 0.95/threshold 0.62 so streetlamps, lit windows, signs, shopfront glass and vehicle head/tail lights all bloom. main.js passes setBloom into createEnvToggle; envToggle lerps bloomStrength/bloomThreshold in the day/night transition. carModel.js, main.js, ui/envToggle.js
- 2026-07-04: More night polish. Lit night-window density 12%->16% (skyline reads as more alive, especially with the new night bloom). Player headlights now day/night-aware — soft DRL (intensity 3) by day, blazing beam (16) at night — via carModel.setNight, routed through carDriver.setNight (already fired by onNightModeChange + envToggle.reapply). buildingRenderer.js, carModel.js, carDriver.js
- 2026-07-04: Richer daylight. Warmer, firmer sun (DAY dirColor 0xffeedd->0xffe6c2, dirIntensity 3.1->3.35, ambient 0.36->0.32 for deeper shadows), and a modest grade bump (saturation 1.18->1.24, contrast 1.10->1.15, warmer golden highlights) so the default daytime view looks less flat. Grounding reviewed: entities already get pooled blob contact shadows, trees darken terrain (darkenTerrainAroundTrees), poles have shadow decals, everything casts directional shadows — SSAO skipped (perf) as grounding is already covered. envToggle.js, colorGradePass.js
- 2026-07-04: NEW game/dashMode.js — "Checkpoint Dash" time-trial. START button (top-centre, car mode only) lays a chain of ~6 glowing gates along the loaded road network (greedy forward-biased route from the car, 90-210 m apart), each with a pillar of light so the next is findable from afar. Drive through in order against a running clock; clear the last to finish; best time saved to localStorage dd_dashBest. Only the next two gates show (cyan next, gold after). Gate meshes live in the scene/physics frame like traffic (px=-(wx-ox), pz=wz-oz); hit radius 15 m; synth ding per gate. Wired in main.js (created in the car-mode block, updated each frame with the car physics pos). main.js, game/dashMode.js(new)
- 2026-07-04: Dash polish — countdown, medals, minimap marker. (1) 3·2·1·GO countdown after Start (big centre pop animation + beeps); the clock + hit-testing only begin at GO. (2) Finish medals by avg time/gate: gold <6.5s, silver <9s, bronze <13s, else finished; finish screen shows medal emoji+label+time and ★ NEW BEST when beaten. (3) Minimap objective dot — minimap.setObjectiveMarker(wx,wz) places a cyan heading-up dot to the next checkpoint clamped to the rim (m/px from zoom 17); dashMode drives it on each gate change (via lazy getMinimap since minimap is assigned after dashMode in init) and clears on stop/finish. game/dashMode.js, ui/minimap.js, main.js. Also earlier: 10 gates 45-120m apart; slimmer pointier direction arrow; labelled NEXT-CHECKPOINT compass + on-gate NEXT tag.
- 2026-07-04: Game-styled map + M key. Minimap base switched from raw OSM tiles to CARTO Positron (light_nolabels) — a clean, minimal roads+water base — tinted to the game palette (warm parchment by day, deep navy by night) via new FILTER_DAY/NIGHT; the tint now persists in the expanded map too. Expanded map frame restyled with a gold game border + darker backdrop. New key M toggles the big map (guarded against firing while typing). ui/minimap.js. README credits updated for CARTO.
- 2026-07-04: NEW game/taxiMode.js — "City Cab" delivery mode (second game mode). Green Start Shift button (top-left, below the dash button). A green PICK-UP marker spawns on a nearby road (120-340m); reach it → a gold DROP-OFF marker (180-520m) appears with a decaying tip meter; deliver for payout = round(base(3+dist*0.02) * (1+tip)), tip 0.6→0 over ~expected drive time. Fares chain endlessly; running total $ + fare count; +$X float popup on delivery; End Shift saves best payday (dd_taxiBest). Reuses dash's marker/arrow/on-tag/minimap patterns; single reusable marker recoloured per objective. Wired in main.js car-mode loop. Idle HUD hidden so it doesn't overlap the dash HUD (run one mode at a time). game/taxiMode.js, main.js
- 2026-07-04: UX pass — one Play launcher for game modes + surfaced controls. NEW game/gameLauncher.js replaces the per-mode Start buttons (gold Dash + green Taxi were competing CTAs that wouldn't scale). Single gold "🎮 Play" pill (top-left below the ☰ menu) opens a mode menu (Checkpoint Dash / City Cab / Free Roam) with one-line descriptions + a CONTROLS cheatsheet (WASD/Space/H/R/M/Esc) so new players know how to drive. Enforces one-mode-at-a-time (starting a mode stops the others). While a mode runs the pill turns red "✕ Quit"; polls isRunning so it flips back when a mode ends itself. dashMode/taxiMode refactored to drop their own buttons and expose {name, icon, start, stop, isRunning}. main.js wires createGameLauncher([dashMode, taxiMode]). game/gameLauncher.js(new), game/dashMode.js, game/taxiMode.js, main.js
- 2026-07-04: UX batch — recover hint + taxi confirmation. carPhysics exposes getUpDot() (chassis-up · world-up); carDriver forwards it. main.js shows a "🔄 Flipped over — press R to recover" banner when upDot<-0.05 for >0.6s (the recover key was otherwise undiscoverable when stuck upside-down). Taxi shows a "🧍 Passenger aboard — drop off!" toast on pickup so the state change is unmistakable. carPhysics.js, carDriver.js, main.js, game/taxiMode.js
- 2026-07-04: Juice + map + signs. NEW game/gameFx.js — fxFlash / fxConfetti / fxBanner (WAAPI, self-cleaning). Wired: taxi pickup (PASSENGER ABOARD banner + green confetti), taxi delivery (DELIVERED/⭐FARE COMPLETE banner + gold confetti + payout, bigger for fast/high-tip), dash checkpoint (small cyan confetti+flash each gate), dash finish (medal banner + big confetti). Minimap base switched CARTO Positron→Voyager (no-labels) — coloured roads/parks/water instead of near-white; lighter filter (saturate/contrast, no heavy sepia) so it keeps colour + detail. Direction/gantry sign faces now THREE.DoubleSide (were FrontSide → invisible from behind); dropped the unreliable gray back plane on the roadside board. game/gameFx.js(new), game/dashMode.js, game/taxiMode.js, ui/minimap.js, map/roadInfraRenderer.js
- 2026-07-05: Fix floating buildings (+ floating peds/cars/scenery) — the big one. Root cause: the rendered/physics ground uses the BAKED terrain mesh (tunnel carving + water dips applied at bake), but `terrain.getElevationAt(lat,lon)` read the RAW `elevation` grid (no carving/dips). Every consumer of getElevationAt — building base-Y, building/scenery colliders, `getTerrainHeightAt` (peds, parked cars, game gates) — therefore floated over any carved/dipped area. Fix: getElevationAt now bilinear-samples the baked mesh POSITIONS directly (reconstructing the grid: vi=r*cols+c, x linear per column, z per row) and returns sampledY−offset, falling back to the raw grid only when unbaked. No re-bake needed (the carving is already in the baked positions). One change cascades to all consumers → everything now sits on the exact ground the car drives on. frontend/src/map/terrainRenderer.js. Also: no parked cars on living_street / roads <6.5m wide (car/parkedCars.js); urban-feature road clearance 2.0→3.0m (map/urbanFeatureRenderer.js).

- 2026-07-06 — Added GTAOPass ambient occlusion (rally-only, after RenderPass): soft contact AO grounding cars/buildings/curbs/trees for the art-of-rally diorama look. world radius 2.2 m, scale 1.35, 8 samples + poisson denoise (perf-safe). Tunable via window._gtaoPass / window._gtaoTune. Also traffic cars now use the merged tint-ready template with per-car body tint (dark glass/wheels), matching parked cars; liveried taxi/police/delivery keep their livery.

- 2026-07-06 — Rally sky: added a warm sun-scatter glow to the gradient sky shader (tight sun disc + broad horizon wash toward the sun azimuth, fades above horizon so the zenith stays clean blue). Additive + rally-gated (uRally), does not touch the shared SKY_/fog/ambient palette; auto-hidden at night (sky dome invisible). Fed by sunDir via skyMat.uniforms.uSunDir.

- 2026-07-06 — Rally player-car paint pop: saturate the body base colour (HSL s*1.25+0.06) and use a cleaner, stronger clear-coat (metalness 0.28, roughness 0.30, clearcoat 0.6) so the hero car stands out against the flat-shaded world. Rally-gated; non-rally paint unchanged.

- 2026-07-06 — Rally tire dust: enable the tyre-smoke pool in rally (even when CONFIG.ENABLE_TIRE_SMOKE is off), warm tan puff colour + soft radial-gradient texture, and a new speed-dust emitter — light low-opacity dust flung backward behind the rear wheels above ~43 km/h (no drift needed), opacity scaling with speed and capped subtle. Pool 50→ 90 so drift smoke + dust do not starve. Default (non-rally) smoke path unchanged.
