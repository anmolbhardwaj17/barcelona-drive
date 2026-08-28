# v3 Execution Tracker

> **THIS FILE IS THE STATE. [v3-master-plan.md](v3-master-plan.md) IS THE SPEC.**
> The plan says *what and why* in full. This file says *what is done, what is next, and how to
> verify it*. Never duplicate spec text here — link to it. Never track state there.

---

## ⏯ RESUME HERE

> **SESSION HANDOFF — 2026-08-27, third session. Read this block, then the ticket table. Nothing
> below is in flight; the tree is clean and 336 tests are green.**

| | |
|---|---|
| **Branch** | **`v3`** — work directly on it. |
| **Tile format** | **v10, unchanged.** R-J1/R-J3 changed baked VALUES, not the format — so `peekBinaryVersion` will NOT invalidate the browser cache. ⚠ **The next drive needs `window._clearTileCache()` + a hard reload**, or it renders the old tiles. |
| **Tests** | **348 green** (332 + 4 `test/widthTaper.test.js` + 12 `test/sidewalkClip.test.js`). `npm test` in `frontend/`. ⚠ `test/lightGrid` "grid rebuild stays cheap" is WALL-CLOCK based and flakes when a build runs concurrently — re-run before believing it. |
| **How the user tests** | **`?mode=fly`, from the air** — deliberately, to see many changes at once. Read **H14** before trusting any fly-mode screenshot: fly mode does NOT lift LOD (only **P** does), and several LOD tests use tile-centre distance including altitude. Call `window._ddGround()` to tell "culled" from "broken". |
| **Verified on screen** | R-W1 widths, R-J2 junctions, the barrier fixes, P4-15a cars, the authored facades — and **2026-08-27: the user confirms z-fighting on roads is GONE** (R-J5). Still measured-only: R-J3's restored pavement, R-J4's pavement-off-carriageway, the fly-mode fog fix. ⚠ R-J1's chamfer work is **unobservable** — all three `ENABLE_CHAMFER_*` flags are `false` (**H13**). |
| **NEXT TASK** | **P4-17** (urban features + bus stops → signage atlas, 2 d) — user-directed 2026-08-27. ⚠ **13 files + 3 new tests are UNCOMMITTED** (see the banner above the ticket table). Also owed: one fly-mode drive for R-J3/R-J4/fog, and tickets **N-1..N-3**. |

### ▶ WHAT TO KNOW BEFORE PICKING ANYTHING UP

**FOUR tickets have now died on re-measurement** (M1, R-P1, R-B2's framing, and R-J1), and two of
them said "count first" in their own text. Before committing days to any remaining item, spend an
hour checking its premise still holds. **A number recorded months ago describes the codebase of
months ago.** R-J1 is the sharpest case so far: all three of its wanted items were already built,
and the hour spent proving that is what surfaced the actual defect (D-68) — which the ticket's
framing had hidden. **Checking the premise is not overhead before the work; it IS the work.**

**Assume a second call site.** FIVE separate defects were "the fix landed on one of two paths": two
tile-disposal branches (D-56), seven road-field copies (D-46), `getLoadedRoadSegments` (D-50), F9 vs
`window._ddReport` (D-64), and the width taper living in both `roadBaker.js` and `roadRenderer.js`
(D-69). When you fix something, go and look for the other one. **The taper case adds a wrinkle worth
remembering: the two paths are chosen per TILE**, so a divergence would surface as a seam moving with
the tile grid — it would be misread as a streaming bug.

**Two adaptive controllers made the same mistake in one day** (D-66, D-67): both read the LOAD
transient as a steady-state fault and throttled themselves against it. If you meet a third
controller, check when it measures before you check what it measures.

### ▶ WHAT SHIPPED TODAY

| | result |
|---|---|
| **initial load** | **16,200 → 4,350 ms** (3.7×). It was yield-bound, not work-bound: 3.1 s of work spread over 16 s at 3 ms a frame |
| **time-to-drive** | **18,444 → 6,329 ms** (2.9×) — restores and beats the ledger's long-unexplained 6.94 s |
| **`other`** (largest report section) | attributed: it **was** the load. Should collapse with it — **not yet re-measured** |
| **R-W1** road width model | eleven disagreeing width tables → one baked SECTION. Residential paving 4 → 10.4 m |
| **R-J2** T-junction clipping | side-aware; paint, kerbs and pavements stop crossing 11,934 side-street mouths |
| **P4-15a** car fleet | 41 draws → 3; allocation −60%, max frame −53% |
| **facadeArray** | a `ReferenceError` swallowed by a `.catch()` meant the **authored facades had NEVER rendered**. Fixed |
| **adaptRes** | armed only once drivable — it had been probing during the load and locking out every drive |
| **#39**, **R-P1**, **P3 gate**, **M1** | all measured and closed — see the ticket table |

### ▶ MEASUREMENT OWED (cheap, none of it blocking)

> ⚠ **All three need `window._clearTileCache()` + hard reload first.** The R-J1 re-bake did NOT bump
> the tile version, so the cache will not invalidate itself.

0. **R-J4 — pavement on the carriageway.** 10.8% of pavement was being drawn ON a live carriageway
   and winning the depth test (`sidewalk` -6 beats `road` -4). Clipped out at the bake and the
   runtime; re-baked. City-wide: vertices inside a carriageway **14.34% → 5.73%**, deeper than
   0.5 m **3.97% → 2.07%**, deeper than 2 m **0.74% → 0.19%**. **Look at Gran Via's laterals —
   pavement should no longer cover the asphalt.**
0b. **The LOD fixes** (D-72/D-73/D-74) — in FLY mode without pressing P: distant blocks should carry
   buildings and parks instead of lawn, and the pavement should reach as far as its own kerb.
   `_ddGround()` should show `sidewalk` roughly matching `curb`, and `greens`/`areaFeature` non-zero
   visible. ⚠ **Check draws** — budget is 450, was ~246; my estimate for all of this is ~+60.
0c. **R-J3 — the pavement clip.** The user reported bare green terrain along kerb lines and around
   corners; it was the junction clip cutting a median 21.4 m of pavement per road instead of 9.7 m.
   Fixed and re-baked: **+21% baked pavement/kerb geometry**, and the median junction now has
   pavement within **8.2 m** (target 8.6). **Look at whether the green strips are gone.**
   ↳ STILL UNDIAGNOSED, same screenshots: **roads reading darker in places.** The AO sampler is
   properly bilinear so it is not blocky by construction; the likeliest remaining explanation is
   that this is the v9 sky-AO working correctly (narrow side streets ARE darker than Gran Via) and
   simply too strong. Needs a fresh screenshot now the pavement is back, not more speculation.
1. ~~One drive looking at Eixample junction corners (R-J1)~~ — **not observable**: all three
   `ENABLE_CHAMFER_*` flags are `false` in config.js, so R-J1's chamfer corrections cannot render.
   The data is correct and the fix stands; it becomes visible only if the chamfer is enabled, and
   **H13** says what has to be re-derived first.
   ↳ While there: **do the 4 m `living_street` mouths read as funnels?** The taper flares a narrow
   arm to its widest neighbour over 20 m, and R-W1 made that a 2.6× flare at 219 nodes. Left alone
   deliberately — it is a judgement call, and the fix would be a per-class taper length.
2. **One F9 drive** — `other` should have collapsed with the load. Nothing else is unverified.
3. **One `?debug=leak` drive** — two leak causes were fixed blind; this says whether a residual remains.
4. If the car ever falls through a road again: **capture the `?spawn=lat,lon`**. The R-P1 census says
   nothing systemic is left (worst road in the city sits 2.2 m above its collider, 0 over 5 m), so
   anything remaining is local and needs a location, not another aggregate.

### ▶ OPEN TICKETS — everything pending, nothing in flight

> **DO THIS FIRST: COMMIT.** 13 modified files, 1,265 insertions, 3 new test files sit uncommitted on
> `v3` at the end of 2026-08-27 — five full re-bakes and ~a dozen fixes, none of it protected. Suggested
> split: (1) road/pavement geometry R-J1/R-J3/R-J4/R-J5 + the tileSplit fix, (2) LOD + rendering
> D-72/73/74 + fog cull, (3) diagnostics + docs.

**Then ONE verification drive** — z-fighting is user-confirmed gone, but R-J3's ~138 km of restored
kerb line, R-J4's pavement-off-carriageway, and the fly-mode fog fix are all MEASURED ONLY.

| id | what | where | state |
|---|---|---|---|
| **N-8** | OSM trees dropped for standing in a carriageway: **7,521 of 35,466 (21.21%)** | `buildRegion.js` | ✅ fixed in the sense that they no longer render in the road (25.66% -> **0.20%**, 0 well inside) — but 21% is a LOT of real street trees to delete. Most are Gran Via / Diagonal medians and lateral verges, which we pave as ONE ribbon. The better fix is eventually to stop paving the median, i.e. dual-carriageway awareness; until then the drop is the lesser evil and the bake prints the count so it cannot creep |
| ~~**N-1**~~ | **road surfaces stacked at the same XZ** | `OsmDataFixer.js` | ✅ **PARTLY FIXED, REST RE-SCOPED AS N-21 — 2026-08-28.** Measured before touching anything, and the premise changed twice. (1) **7.9% of drawn road surface** has a parallel ribbon on it — the raw 20% is mostly legitimate junction crossings; filtering to <30° isolates real stacking. (2) **ZERO same-id pairs**, so this is NOT residual tile duplication and R-J5 is genuinely fixed. (3) `rule5_duplicateRoadRemover` was **never broken** — it removes ~8,748 ways per bake, so N-1 is its TAIL. Relaxed it for same-class ways that also **share a NAME** (5 m / 0.7 instead of 3 m / 0.8), because of 57 flagged pairs **44 share a name and only 5 differ**, and two same-class ways with one name over one stretch of ground are a duplicate while two names are two streets. Result: rule5 8,748 → **{ removed: 9576, strict: 3729, sameName: 5847 }, +828 duplicates**, no leak possible by construction (the strict thresholds are untouched). `duplicateRoadRemover.test.js` pins it, notably `same name 4 m apart IS removed` vs `different names 4 m apart are BOTH kept` at IDENTICAL geometry. ⚠ **BUT IT DID NOT MOVE THE OVERLAP METRIC — 57 pairs and 7.9% unchanged, and all five example ways survive.** Cause of that mismatch, and it was my own: `n1d` flags pairs whose RIBBONS overlap (threshold = sum of half-widths, up to 16 m) while rule5 removes pairs whose CENTRELINES are within 5 m. A fix was built against one number and validated against the other. Re-measured properly, the 57 split: **29 have centrelines ≤5 m (true duplicates, still surviving — open) and 28 sit 5–14.8 m apart (NOT duplicates at all — two real ways each drawn at full street width).** The second half is N-21. |
| **N-21** | **two parallel ways for one street, each drawn at FULL street width** | `roadWidthModel.js` | **OPEN, split out of N-1 2026-08-28.** 28 of N-1's 57 overlapping pairs have centrelines **5–14.8 m apart** — genuinely separate ways, so no dedupe should ever touch them — yet their ribbons overlap because each is drawn at full width. Mechanism: OSM maps one street as two parallel ways, each tagged `lanes=4`, and `computeRoadWidths` sees ONE WAY IN ISOLATION, so each gets 4×3.0 + 2×2.2 = **16.4 m** and the street is drawn ~32 m wide. Observed on tertiary streets in Sarrià (Passeig de la Bonanova, Carrer del Doctor Ferran, Carrer dels Vergós). ⚠ **DO NOT start this on the strength of the overdraw alone** — it is ~2.4% of road surface, which does not pay for the risk. The reason to do it is the user's **"roads seem darker in some places"** report, and that link is **UNPROVEN**: two coplanar ribbons at the same depth bias with different vertex tints is a plausible cause, not a demonstrated one. **Prove the visual defect first** — `_ddPick` a dark patch and confirm two road surfaces at the same XZ — then decide. |
| **N-22** | **sidewalk slabs float ~7.8 m ABOVE the terrain — the "beige broad patches"** | `sidewalkBaker.js` / `roadRenderer.js` | **OPEN, diagnosed 2026-08-28.** `_ddPick` on one of the patches, top hit first: `sidewalk` **y = -4.36**, then road `y = -10.29` and `-11.89`, then terrain `y = -12.15`. So the pavement sits **7.8 m above the ground and ~6 m above the carriageway**, which is why it reads as a wide flat beige band lying over the roadway rather than as a kerb-height surface. Material and colour are FINE (`MeshLambertMaterial`, white, mapped, aoBrightness 0.932) — this is a **height** bug, not the tint. ⚠ Three earlier sessions chased "beige" as a colour/plaza/water/mip problem and all were wrong; the pick settles it. Suspect the v8 baked sidewalk polygon elevation vs the road's normalized Y frame. |
| **N-23** | **roads terminate in mid-air with no ramp, and a tunnel mouth is missing entirely** | `RampResolver.js`, `buildTrenchPortals` | **OPEN, 2026-08-28.** User screenshots on Trunk Link Road / Ronda de Dalt / Carrer del General Vives: carriageway slabs stop dead over open terrain with a crosswalk still painted on the stub, and at General Vives a road runs into a grass bank where a portal should be. Distinct from N-22 (that is a height offset; this is missing geometry). Read `tunnel-fix-playbook.md` and produce the Findings Report BEFORE changing anything — that file's whole point is diagnose-before-change. **The worst of the current defects: a road that ends in a cliff is not drivable.** |
| **N-24** | ramps and trench edges have no railing | `roadFurniture` / `barrierRenderer.js` | **OPEN.** Named in P4-18's own scope list ("bridge decks, undersides, piers") and never built. Cosmetic next to N-23 but on the same corridors. |
| **N-25** | trees stand in the middle of roads and roundabouts | `vegetationBaker.js` | **OPEN — and this is the REVERT's known cost, not a regression.** All vegetation work was reverted to `1264dc4` on the user's instruction (*"i want that back man"*), and the pre-revert code planted trees on carriageways; the fix for it was in the reverted set (N-13/N-16/N-17). ⚠ **Do not re-apply that work wholesale** — it cost a full session and was rejected. If revisited: ONE defect, one bake, one screenshot before the next. See [[measure-and-fix-the-same-number]]. |
| ~~**N-26**~~ | **collision wireframes (K) were drawn in the wrong coordinate space — nothing was ever visible** | `collisionDebug.js`, `main.js` | ✅ **FIXED 2026-08-28.** The toggle, the key binding and the HUD all worked; the geometry was built and then placed in another part of the city. Collider positions are PHYSICS space, and **physics space IS `worldGroup`-local** (main.js states the relation as "ABSOLUTE world = -lx + originOffset" — `worldGroup` carries `scale.x = -1` plus the origin offset, the negation CLAUDE.md warns about in its first paragraph). The group was added to `scene`, so every wireframe was mirrored across X and offset. The range filter had the same fault, comparing `camera.position` (scene space) against collider positions (physics space), so it rejected on incompatible coordinates. Now parents to `worldGroup` and converts the camera into that space. ⚠ `debugColliders.js` (used by `?debug=tunnel`) adds to `scene` the same way and is probably wrong in the same way — unverified, worth checking before trusting that overlay. |
| ~~**N-2**~~ | **every water polygon in the region was written into every tile** | `waterNormalize.js` | ✅ **FIXED 2026-08-28.** `splitWatersByTile` guarded each assignment with `bboxIntersects(waterBbox, tileToBBox(...))`. **`tileToBBox` returns `{south,west,north,east}`; `bboxIntersects` reads `minLon/maxLon/minLat/maxLat`** — every field read was `undefined`, every comparison against `undefined` is false, and `!(false||false||false||false)` is TRUE. The guard never rejected anything in its life. ⚠ **The tell was one number:** tiles-per-polygon came out `min = median = max = 280`. A merely COARSE bbox test produces a SPREAD; a constant means the test never rejects. It stayed invisible because the output is CORRECT, just enormous — the frontend dedupes water by id, so the city rendered exactly right while every tile carried the whole city's water. **MEASURED ON REAL TILES AFTER RE-BAKE: records 71,120 → 1,012 (−98.6%), replication 280x → 4.0x, max polys in one tile 254 → 23, polygons in >1 tile 254 → 65, and the tile set 167 MB → 149 MB (−18 MB, −10.8%).** Max 110 tiles for one region-crossing stream is correct and is pinned by an over-rejection test. Two asserts added because BOTH failure directions are silent: `bboxIntersects` throws on a malformed box, and `splitWatersByTile` validates the REGION bbox — with wrong names there the tile range computes NaN, both loops run zero times, and water vanishes citywide with no error (found by writing the test for the first bug). Other three `tileToBBox` consumers checked and correct. `waterTileSplit.test.js` pins the REJECTION, not just the acceptance. |
| **N-3** | **terrain sits 1 cm ABOVE the road** (y 0.76 vs 0.75), held apart only by polygon offset (terrain 0, road −4) | `_ddPick`, 2026-08-27 | Fragile by construction, and a plausible source of green speckle on asphalt at grazing angles. The road should sit above the terrain in SPACE, not only in the depth buffer |
| **N-4** | **pavement reads beige** — user-reported, chased through six hypotheses, **all measured false** (plazas, width, water, mip-averaging, fog, duplicate mesh, AO) | `roadTexturePack` / grade | ⛔ **NOT A DEFECT — do not "fix" it blind.** Identity `sidewalk` (confirmed twice), drawn width median **3.50 m** = spec, texture mean **#9c9995** neutral grey at every mip, AO brightness **0.865**. It reads warm because the grade lifts saturation ×1.52 under a warm sun, which the art bible calls deliberate. User said "no its ok". Levers if ever wanted, bluntest last: panot albedo tint → `AO_ROAD_STRENGTH` (0.52) → sun/grade |
| ~~**R-J1**~~ | junction / merge geometry | `barcelona-road-system.md` §4 | ✅ **CLOSED 2026-08-27 — all three wanted items were already built** (gore, chamfer, 20 m taper). The real defect was a per-tile width lookup fabricating 6 m at 15.4% of junction approaches → 33 missing + 327 misshapen chamfers. Fixed + re-baked. See **D-68** |
| ~~**R-J3**~~ | the junction clip was eating the pavement | §4 | ✅ **DONE.** Full width where a half was meant, and a sum where a hypotenuse was meant: 21.4 m cut per road → **9.7 m**; roads with no pavement **15.6% → 5.4%**; ≈**138 km** of kerb line restored. **D-70** |
| ~~**R-J4**~~ | pavement drawn ON the carriageway, and winning the depth test | §4 | ✅ **DONE.** `sidewalk` (−6) beats `road` (−4), so a lateral's pavement painted over the avenue. Vertices inside a carriageway **14.34% → 5.73%**, >0.5 m deep **3.97% → 2.07%**. **D-75** |
| ~~**R-J5**~~ | every road near a tile edge drawn TWICE | §4 | ✅ **DONE — the unified cause of "roads darker", "z-index issues" and "pavement too wide".** 37.8% of all drawn road centreline was a coplanar duplicate with mismatched AO. Cross-tile geometry **24.6% → 2.92%**. User confirms z-fighting gone. **D-79**, and **D-81** for the tile clipper it uncovered |
| **P2-01** | `staticPools` — per-instance LOD | P2, 6 d | Deferred by **D-19b**: the frame is CPU-bound, not GPU-bound, so measure before spending six days on GPU headroom |
| **P4-17** | urban features + bus stops become atlas clients of the signage pool | P4, 2 d | ⛔ **BLOCKED.** Its dependency `signAtlas.js` DOES NOT EXIST — nor `map/signage/`, nor `scripts/build-sign-atlas.mjs`. Producer is **P4-11, 7 d, risk high, not started**. The atlas-free half shipped as **P4-17a** |
| ~~**N-7**~~ | **the bake's vegetation road mask was in the WRONG COORDINATE SPACE and blocked NOTHING** | `vegetationBaker.js` | ✅ **CONFIRMED AND FIXED 2026-08-27.** Probe: `road pt (240672.7, 5069787.3) | mask SW world (3661.3, 3903.0)` — roads arrived in MERCATOR, the grid was bounded in WORLD, ~240 km apart. Consequences, none of which looked like an error: the road mask blocked nothing ever; `getRoadsideTreePositions` and the road-edge bush loop emitted Mercator positions that were dropped as out-of-tile, so **both paths produced nothing at all**; and two offset fixes made earlier the same day landed on dead code, which is why their numbers did not move. One conversion in `convertRoadsForVeg`. After: bushes genuinely in the road **3.13% → 0.70%**, roadside trees 306,908 → 157,484 (the mask now rejects half). ⚠ The runtime mask (`map/vegetationMask.js`) was checked and is FINE — the frontend works in world. **A mask that blocks nothing is indistinguishable from a mask with generous margins; probe the coordinate space, do not read it.** Probe kept behind `VEG_PROBE=1`. |
| **N-9** | cluster ROCKS and BUSHES sat on the carriageway — and were invisible until the LOD fix exposed them | `environmentClusterRenderer.js` | ✅ **FIXED.** Identified with `_ddPick`, which could only report `Sd` — a MINIFIED CLASS NAME, because all three cluster meshes carried `sharedGeometry`/`sharedMaterial` and **no `userData.type`**. That alone cost three passes; they are tagged now (`clusterRock`/`clusterBush`/`clusterTree`). Root cause: every item WAS checked with `isVegetationAllowed(..., 4)`, but that returns **TRUE for anything outside its own grid** (tile + PAD) — correct for "unknown", wrong as the last word before placing a rock — so clusters near a tile edge scattered items past the boundary and every one was waved through. Added a DIRECT test against road geometry at `corridorWidth`. ⚠ **They were never new:** commit 917c625 changed cluster visibility from `dist` (tile centre, includes camera altitude) to `nearEdgeDist`, so at any altitude they had simply never been DRAWN. Same shape as the plazas (D-73) — an LOD fix exposing a placement bug that was always there. |
| ~~**N-10**~~ | **two thirds of all vegetation was planted in a NEIGHBOURING tile's ground — and that is why bushes and rocks floated** | `vegetationBaker.js` | ✅ **FIXED.** `noClipTileStrategy` hands every tile the FULL geometry of every way touching it, so `getRoadsideTreePositions` walked those ways far past the tile edge and planted along all of it: **193,189 of 289,238 positions (66.8%) fell outside their own tile.** The runtime takes each tree's ground height from that tile's elevation grid, and outside the grid the sample CLAMPS to the edge — so the object floats or is buried. `environmentClusterRenderer` already guarded exactly this and says so in a comment ending "(= float)"; the baker never did. Clipped to tile bounds. Result: 100% inside, **bushes in a carriageway 5.15% → 0.00%**, trees halved in absolute terms, 1 road-bearing tile of 433 with no trees. |
| **N-7b** | residual vegetation on the carriageway after N-7 | `vegetationBaker.js` | Trees **0.58%** well inside, bushes **0.70%** — down from 0.56%/3.13%, so bushes improved 4.5x and trees are unchanged. Small but non-zero; a tree placed beside road A can still land inside road B where two run parallel. Chase only if it is visible at street level |
| **N-11** | bushes and rocks along the kerb — the guard was a POINT test at PAVED width, and the baked bush layer had no geometric guard at all | `vegetationMask.js`, `propRenderer.js`, `environmentClusterRenderer.js`, `vegetationRenderer.js`, `vegetationBaker.js` | ✅ **FIXED 2026-08-28.** Two holes, both visible in the same screenshot (a flat stone straddling the Gran Via zebra crossing). (a) `isOnAnyRoad` guarded at `pavedWidth` — deliberately, because an earlier revision at `corridorWidth` had deleted every plane tree on Gran Via. But trees are now **exempt at the call site**, so the reason no longer applied and the pavement was fair game for rocks. Widened to `corridorWidth`. (b) It was a point test on the instance ORIGIN: `rock_01` scales to 2.5, so a stone could sit its centre legally outside the kerb and overhang metres of asphalt. Added a `clearance` argument carrying each item's own footprint (2.5 / 2.0 / 1.2 / 0.5 for rock01/rock02/bush/grass; `item.scale * clusterScale * 1.1` for clusters). User's ruling, quoted: *"i have no issue if we dont show bushes and stones near roads, we show them in open anyways so its ok"* — trees stay exempt, everything else clears the whole right-of-way. Also added `buildCorridorGrid` to the baker (`buildGroundRoadGrid` INSETS by 3–5 m, so it only ever caught the carriageway interior) — measured effect on baked bushes is small, **2.1% citywide**, because the visible offenders are the LIVE cluster/prop renderers, not the baked layer. After the re-bake, baked bushes inside a road corridor are **2.1% → 0.2%**. |
| **N-12** | ⚠ **`vegetationRenderer` and `vegetationWorker` are a live/dead PAIR — know which one runs before fixing either** | `vegetationRenderer.js`, `workers/vegetationWorker.js` | **KNOWN, no fix needed, but it cost a wrong edit.** `vegetationWorker` uses `tileData.bakedVegetation` and **skips runtime placement entirely** when the tile has baked positions — which every v10 tile does. So `vegetationRenderer.collectAllPositions` / `collectBushPositions`, a full runtime twin of the baker's, is the FALLBACK path and does not run in the shipped game. The corridor guard added to `vegetationRenderer` is correct defence for that path but changes nothing on screen; the operative fixes were the baker (data) and the cluster/prop renderers (live). This is the **sixth** copy-pair (H10 taper, H12 kerb clip, R-J4 carriageway clip, R-W1 width tables, `roadInfraRenderer`'s own local `isOnAnyRoad`, and this). |
| **N-13** | **street trees ~2x too sparse and wildly uneven — a way ENDING was being booked as a junction** | `vegetationBaker.js` | ✅ **FIXED 2026-08-28.** `getRoadsideTreePositions` clears a no-tree disc wherever a way ENDPOINT lies within 8 m of a road segment. Under `noClipTileStrategy` one street is several way RECORDS, so each record's endpoint sits exactly on its own continuation and every one was booked as a T-junction. Replayed against the spawn tile (16_33161_24477, 282 road records): **501 discs, of which 353 were phantoms, the 500-disc cap HIT, and 45.0% of every roadside tree slot in the tile rejected as "near a junction."** Two rules separate a real T from a continuation — not its own way, and not collinear (`isWayContinuation`, \|cos\| > 0.9 ≈ 25°) — and the disc shrinks from 10–18 m to 5–9 m (`junctionTreeClearance`); 10–18 m cleared up to a third of a 113 m Eixample block at every corner. Same tile after: **31.0%**, and that residue is legitimate. Cap raised 500 → 4000. Also cut the roadside building margin 2 m → 0.6 m (measured 12.3% of survivors lost to it; an Eixample pavement is 3–4 m and the setback deliberately plants mid-pavement). ⚠ **The user's instinct was right** — they said *"i feel when we were working on road merging logic that time somewhere it broke"*, and the trigger is exactly that: phantom discs scale with the number of road RECORDS per tile. **MEASURED AFTER A FULL RE-BAKE (2026-08-28):** baked trees **95,575 → 145,904 (+53%)**, mean spacing per side **14.8 m → 9.7 m** against Barcelona's real ~8 m, tree:bush **1.24 → 1.82 : 1**, sparsest tile **97 → 55 m/side**. No regression on the thing the discs were protecting: trees inside a carriageway held at **4.0%**, and the correct street-tree band (0–3 m beyond the kerb) rose 65.9% → **67.9%**. Bake took 7:44 against an 8:20–8:44 baseline, so the extra discs cost nothing. |
| **N-14** | ⚠ **measuring density per tile double-counts road length — my first number was 1.8x too pessimistic** | (measurement method) | **METHOD NOTE, no code.** First pass summed every road record in every tile and got **27.2 m** mean street-tree spacing ("4x too sparse"). Wrong: `noClipTileStrategy` duplicates each way into every tile it touches, so the denominator was inflated ~1.4–1.9x. Measuring per tile against **in-bounds** road length only gives **14.8 m** — ~1.85x too sparse against Barcelona's real ~8 m, not 4x. It also revealed the real shape of the bug: the mean hides the variance. The spawn tile is **9.1 m (fine)** while the worst tiles run **61–97 m/side, effectively bare** — which is why the user saw trees in some places and none in others. Any future vegetation-density claim must clip to tile bounds first. |
| ~~**N-16**~~ | cluster TREES were exempt from the road guard — 848 of them stood in the carriageway | `environmentClusterRenderer.js` | ✅ **FIXED 2026-08-28.** The exemption was added earlier the same day on the grounds that guarding trees "cost the whole of Gran Via twice". **That attribution was wrong.** What emptied the city on those runs was the `_clusterRejects is not defined` ReferenceError (H16) — introduced by the SAME edit that added the guard — which threw inside every tile build and took ALL vegetation with it. The guard was blamed for the crash's damage and an exemption was built on top of the mistake. Verified by grep before removing it: `workers/vegetationWorker.js`, the BAKED path that draws Gran Via's real street trees, contains **no reference to `isOnAnyRoad` and never has**, so cluster-tree guarding cannot touch street trees. Measured with `_ddOnRoad()`: **clusterTree on road 848 → 70 of 15,428**; cluster vegetation in the carriageway ~5.5% → ~0.55%. |
| ~~**N-17**~~ | **one rule was doing two jobs — guarding trees at CORRIDOR width deleted the roadside greenery** | `environmentClusterRenderer.js`, `vegetationMask.js` | ✅ **FIXED 2026-08-28.** Removing the N-16 exemption guarded cluster trees at `corridorWidth`, and the corridor **includes the pavement — which is exactly where a street tree stands**. So the fix for rocks-on-asphalt took the roadside trees with it. The user identified this unprompted: *"i feel you made chnage to remove green coming in middle of road and maybe thats why not trees are gone because trees used to come there along side the road"* — correct, and faster than the instrumentation. Split into two rules, per the user's ruling (*"we can remove it from these areas it self and can add ONLY in GREEN regiosn like before and have trees back properly"*): a **TREE** clears the ASPHALT only (`isOnAnyRoad(..., 'paved')`); a **ROCK or BUSH** must be inside a GREEN REGION — a mapped green polygon or generated wild ground — because "off the road" was never enough when urban ground between kerb and building is paved. ⚠ Second-order consequence that had to be handled or the street ends up BARE instead: on non-green ground a rock-only template now places NOTHING, so those spots draw from `URBAN_TREE_TEMPLATES` (derived from the template table, not hand-listed). `MAX_CLUSTERS_PER_TILE` 110 → 300 — the cut to 110 was throttling the wrong thing. **Confirmed on screen:** Gran Via carries continuous street trees both sides, clear carriageway. |
| **N-18** | ⚠ **three probes in one session reported "nothing found" because they filtered on `userData.type`, which most meshes do not set** | `_ddPick`, `_ddGround`, `_ddVegY` | **STANDING HAZARD, see H17/H19.** Terrain, the road ribbon, the tree pools, the props and the cluster meshes all shipped WITHOUT a `type`, so every one of them reported as a minified class name (`Ot`, `Sd`, `dp`) and any probe filtering on type silently matched nothing. This cost: three rounds picking at what turned out to be the player's own car, one "the trees are missing" that was really "the pool is unreadable", and one `_ddVegY` that returned "no trees sampled" on a street visibly full of trees. **Tag every mesh you add with `userData.type`, and when a probe reports zero, suspect the probe.** |
| ~~**N-19**~~ | **vegetation floated or sank because GREEN POLYGONS were flat lids over sloping ground** | `greensRenderer.js` | ✅ **FIXED 2026-08-28.** `_ddVegY()` measured `clusterBush` median 0.48 m / p95 6.44 m / floating 21 vs buried 18; `clusterRock` median 0.20 / p95 7.52 / floating 29 vs buried 2. **A near-zero median with a p95 of metres and an EVEN float/buried split is the signature of a flat surface over a slope** — an offset bug biases everything one way. `greensRenderer` drew each polygon as a `ShapeGeometry` laid flat at the elevation of its CENTROID, while every plant inside is placed by the terrain sampler at its OWN position: uphill of the centroid a plant floats, downhill it sinks, and the error grows with polygon size. Now every vertex takes its own elevation. ⚠ It became visible *after* N-17 because confining rocks and bushes to green regions grew exactly the population most exposed to it — the fix did not cause the float, it concentrated it. |
| ~~**N-20**~~ | **street trees were planted against an 11th width table, then deleted for standing in a building** | `vegetationBaker.js` | ✅ **FIXED 2026-08-28, three bakes.** Two stacked faults behind "trees are very less and coming on road". (a) **PLACEMENT** measured the offset from `Math.max(bakedWidth, ROAD_RENDER_WIDTH)`, and that table is systematically WIDER than the bake's own output (primary 20 v 15, secondary 16 v 10, tertiary 13 v 7, **residential 10 v 5**). Taking the max pushed every pit metres past the real kerb — on a residential street ~6.8 m out against a building line at ~5.5 m — so the tree was placed inside the building and thrown away by `isInsideOrNearBuilding`, **18.2% of survivors**. They were generated, misplaced, discarded. Line 346 of the same file had already been fixed for this under N-7b; this call site was missed (**H10 copy-pair, 7th instance**). (b) **THE GUARD WAS NOT A CARRIAGEWAY TEST** — `buildGroundRoadGrid` insets 3–5 m, so on Gran Via it policed the middle 5 m of a 15 m road and passed every tree in the outer lanes. Added `buildPavedGrid` (kerb to kerb, no inset). ⚠ **The rate was always ~4% (N-7b); N-13's +53% tree count is what made it visible.** (c) My first guard had 0.10 m of margin against a grid rasterised at `GRID_RES = 0.5 m` — inside its own quantisation noise — and **deleted 19% of all trees**; clearances reconciled to ~0.7 m of real margin. **FINAL: trees 95,575 → 174,712 (+83%), spacing 14.8 → 8.1 m/side (real ~8), carriageway 4.0% → 0.0%, correct kerb band 65.9% → 93.6%, tree:bush 1.24 → 3.01.** Spacing was tightened LAST, deliberately: doing it before placement was correct would only have multiplied misplaced trees, which is what the interim 145,904 figure was. |
| ~~**N-7-old**~~ | (superseded) | | ⚠ **HALF-DIAGNOSED, STOP AND READ.** Measured: 18,742 of 372,896 bushes inside a drivable ribbon, **61% of them on `residential`**. Two findings, one certain, one not: (a) **CERTAIN** — `BUSH_CAP = 3000` is saturated by the tree-base cluster path before the road-edge loop runs, so bushes come from clusters placed **up to 2.6 m around each tree**, and trees now sit just outside the kerb, so a cluster reaches back into the road. (b) **UNCERTAIN, verify before acting** — the mask grid is bounded in WORLD (`latLonToWorld(tileBounds)`, ~±4,000) while `convertRoadsForVeg` feeds road points straight through as `{x: p[0], y: p[2]}`, and the road points in the BINARY are MERCATOR (~240,798 / 5,069,865) while baked veg output is WORLD (~3,942 / 4,082). If the mask really is rasterising mercator roads into a world-bounded grid then **the road mask blocks nothing at all** and every "vegetation avoids roads" guarantee in the bake is fictional. It was NOT possible to close this from the binary alone — `convertToBinary` does not convert points on write, so either `payload.roads` is already mercator (mask broken) or something converts inside `bakeVegetation` (mask fine). **Print one road point at the top of `bakeVegetation` and it resolves in a minute.** |
| **N-5** | urban features ship `tags: {}` — every OSM tag is dropped at the bake | `pbfUrbanFeatures.js` | Blocks any subtype work: `fire_hydrant:type` (pillar vs underground) can't be told apart, so all **527** hydrants are pillars. Same for `toilets:disposal`, `fuel:*`. Cheap to add to the extractor |
| **N-6** | `amenity=drinking_water` is not imported at all | `pbfUrbanFeatures.js` | Barcelona's cast-iron *fonts* — one of the city's most recognisable street objects — do not exist in the game. An ADDITION, not a fix; sized with the extractor change in N-5 |
| **P4-18** | tunnel + trench interiors — the Ronda trench and Gran Via tunnels are the project's signature corridors | P4, 3 d | Depends on the splat shader + lightGrid |
| **P4-14** | road furniture — Barcelona bollards from the v8 sidewalk polygons, `BatchedMesh` post pool | P4, 11 d | High risk on its P4h half only |
| **P4-15b** | vehicle ART — Blender modular Barcelona kit, hero car re-UV | P4, 16.5 d | The engineering half (P4-15a) is done. Keeps the `rallyStyle ADR` / P1 deps |
| **P4-16** | HUD + progression, garage, district map, landmarks | P4, 14 d | Depends on P1 theme tokens + the vehicle kit |
| **R-B2 leftovers** | sharp-bend barriers | §4 | ⚠ **A FEATURE, NOT A DEFECT — read its row before scheduling.** There are currently ZERO sharp-bend barriers; nothing is wrong on screen. ~203 defensible bends, and a slipped gate puts ~695 on Eixample grid corners |
| **#39 residual** | geometry leak | ledger | Measured **clean** in steady state (`held == freed`, `freed == released`). One `?debug=leak` drive would confirm no residual |

### Status legend
`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked · `[-]` cut/skipped (say why)

### The two rules that override convenience
- **No slacking.** If a task turns out to need a rebuild rather than a patch, rebuild it, and note
  the change here. Sunk cost is not an argument. Neither is rewriting for its own sake.
- **It stays a browser game.** Every task is performance-bound. See **Performance ledger** below —
  update it as you land things, or the budget silently rots.

---

## 🖥 Performance ledger — update as you go

The plan's budget only holds if each saving is banked **once**. Three domains each tried to bank
the same shadow saving in planning; do not repeat that in execution.

| Metric | Baseline (measured) | Now | Cap | Owner task |
|---|---|---|---|---|
| p95 GPU, night, 80 km/h, dense Eixample | P0: **15.32 ms** @ pr **1.2** | post-P1: **13.85 ms** @ pr **1.0** ⚠ NOT like-for-like | **15.00** | see D-18 |
| ↳ GPU p50 | 13.31 @ 1.2 | **8.02** @ 1.0 | — | frame is no longer GPU-bound at p50 |
| ↳ S1 shadow `autoUpdate` saving | budgeted **−1.35 ms** | ⚠ still unproven — needs an A/B, not a single capture | — | P0-03 |
| **frame p95** | — | **33.4 ms** (37% of frames miss vsync → 30 fps) ⚠ pre-KTX2; not re-measured | 16.7 | P1-08 / task #39 |
| **`other` — was the largest section in every report** | 2,007–3,087 ms across 40 long frames, vs `rend` 237–415 | **08-27: attributed — it is BOOT, not GC** (every top-`other` frame inside the first 12 s, no async work, no allocation). The load that produced it is now 3.7× shorter, so this should fall with it. **Not yet re-measured — needs one F9 drive** | — | D-61 |
| **time-to-drive — historic note** | ledger: 6.94 s after P4-01, then 18-22 s for weeks | ✅ **6,329 ms.** The 18-22 s band was the boot polling `isInitialLoadComplete()` and **giving up at its own 19.5 s cap** with 6 tiles built. Fixed by LOAD_BUDGET_MS (D-65/D-66); the 6.94 s figure was real all along | +1.5 s | ✅ |
| **initial load — was the biggest cost in the game** | **16,200 ms** wall for 3,095 ms of work | ✅ **4,350 ms — 3.7× faster, MEASURED 08-27.** Same 14 tiles resident, same ~3.4 s of work; chunks **1,177 → 334**, average chunk **2.63 ms → 10.1 ms**. It was YIELD-bound, never work-bound. Predicted 4.3 s, measured 4.35 s | — | ✅ D-65/D-66 |
| **time-to-drive** | **18,444 ms** (and 19.4-21.6 s across five earlier boots) | ✅ **6,329 ms — 2.9× faster.** This also **restores and beats the ledger's long-unexplained 6.94 s**, so that figure was real and this is what had been lost | +1.5 s | ✅ |
| **long frames per SECOND of driving** | 26-08 pre-KTX2: ~1.9/s | KTX2: **0.133/s** · post-P4-01 re-bake: **0.062/s** (9 over a 144.8 s drive; 4 of them after the first 30 s) | — | P3-GATE-01, P4-01 |
| **time-to-drive** | P3 close: **20.98 s** | **6.94 s** after the P4-01 re-bake (−67%) | — | P4-01 (tile store 567→177 MB) |
| **heap over a 145 s drive** | — | 328 → **572 MB**, then a collect to 310 MB. 2 of 9 long frames collection-shaped | — | task #39 |
| **`rend` allocation per long frame** | D-37: **7–13 MB every frame** | **2026-08-27: `[0.26, 0, 13.87, 0, 0, 0, 0, 0, 0]` — 8 of 9 long frames allocate ZERO.** D-37's premise no longer holds; the render loop is clean and one outlier remains | — | task #39 **RE-AIM** |
| ↳ non-GPU share at p95 | P0 **18.1 ms** | **2026-08-26: 95% of a 50-76 ms frame, gpu only 7.3-7.8 ms — the cause is GC, see D-36** | — | task #39 |
| ↳ GPU share at p50 | — | **13.3 of 16.7 ms** — median frame IS GPU-bound, only 3.4 ms spare | — | P2 |
| Texture VRAM resident | 95.7 MiB + 34.0 render targets = **129.7** ⚠ *re-derive in P0-04* | — | **200** | P0-04 |
| Draw calls | P0 p95 **261** | post-P1 p95 **246** ✅ (−15, pr-independent) | **450** | ✅ real improvement |
| ↳ cars + car lights | **41** (28 traffic Meshes + 9 parked IMs + 2+2 lights) | **3** ✅ — one BatchedMesh + 2 light IMs (P4-15a). `WEBGL_multi_draw` confirmed present, so the fleet really is one call. ⚠ 3 only where that extension exists; without it three loops per instance (~250 calls) | — | P4-15a |
| Draws / triangles, STEADY STATE | — | **202 draws · 1,014k tris** (console read, post-P4-15a; one sample, not a p95) | 450 / 2.6 M | P4-15a |
| **`traffic` allocation** | **22.6 MB** over a 69 s drive (#2 allocator behind `rend`) | **0 — absent from the report** over a 147.6 s drive ✅ **BANKED** (P4-15a) | — | P4-15a |
| **heap growth per second** | **+1.53 MB/s** (629→706 MB / 69 s) | **−2.03 MB/s** — net collect, like-for-like `/game` drive ✅ (P4-15a) | — | P4-15a / task #39 |
| **allocation across 40 long frames** | **55.7 MB** | **22.2 MB** ✅ **−60%**, like-for-like (P4-15a) | — | P4-15a |
| **max frame** | 241.5 ms | **114.2 ms** ✅ **−53%**, like-for-like (P4-15a) | — | P4-15a |
| ↳ tire smoke | up to **90** Sprites / 90 materials | **1** InstancedMesh, 1 material (P4-15a) | — | P4-15a |
| Parked-car triangles ALWAYS drawn | ~250 × 2,189 ≈ **0.55 M** (nine `frustumCulled = false` InstancedMeshes) | per-instance frustum culled — expect ~⅓ to survive. **UNMEASURED; the single biggest claim in P4-15a** | — | P4-15a |
| Triangles | P0 p95 **1.88 M** | post-P1 p95 **1.96 M** ⚠ **UP 75k** | **2.6 M** | unexplained — see D-18 |
| Art library download | 0 | — | **24 MB** | P1-05 |
| Page weight | ~30 MB disk | — | −14 MB after P0 | P0-10 |
| Time-to-drive | P0 **21.5 s** | post-P1 **21.1 s** ✅ (warm list churned it to 22.6 s before the mesh-kind fix) | +1.5 s | ✅ |
| Shader programs (Δ over a 90 s drive) | P0 **Δ8** | post-P1 **186→191, Δ5** ⚠ improved, gate is 0 | **0** | road/terrain materials still unwarmed |

⚠ **Rule: no task may claim a saving another task already banked.** If you bank one, write the
measured number in the **Now** column and name the task that did it.

---

## 🚨 Standing hazards — re-read before touching these

| # | Hazard | Why it bites |
|---|---|---|
| H1 | `patchRoadWash` carries **both** the night wash **and** the v9 baked sky-AO | Deleting it wholesale silently removes baked AO from every road in the city **with no error**. **P0-07 splits it. Do that before any lighting work.** |
| H2 | Buildings are **worker**-generated | `workers/buildingWorker.js` + `workers/meshMaterializer.js` are the real path. `map/buildingRenderer.js` is night-mode + distant LOD only. Editing the wrong one does nothing and has cost a full session before. |
| H3 | `vegPools.js` invariants | Fixed 16384-cap pools. **NEVER** `setInstanceCount`-grow (re-uploads every texture). **NEVER** `deleteInstance` (its freed-list sort is O(n log n) per add). |
| H4 | `GLOBAL_VERTEX_BUDGET` drops **entire buildings** via `continue` | Any geometry the art pass adds silently deletes buildings in exactly the dense tiles the gate measures — and it will be misread as an art bug. **P1-12 makes it degrade instead.** |
| H5 | Triple-mirrored constants | `FLOOR_HEIGHT` / `WALL_REPEAT_HORIZONTAL_M` live in three files; AO constants in four. **P1-13 single-sources them.** |
| H6 | Shared-material disposal defaults to **dispose** | `tileManager.js:2856-2874` disposes unless `userData.sharedMaterial` is set; 13 untagged sites. Under a shared KTX2 library the first tile unload destroys a city-wide texture. **P0-02 inverts it.** |
| H7 | A re-bake is expensive | ~10–30 min, re-commits 547 MB, bumps `TILE_VERSION` in `mapLoader.js` **and** `tileParserWorker.js`, and every player needs `window._clearTileCache()`. 17 of 426 tiles are still v7 with no AO grid. Only **P4** tasks re-bake, and they share ONE window. |
| H8 | Card foliage before the light grid | Alpha-tested foliage under zero punctual lights is a **black cutout** — worse than the current blob. **P4 trees must not ship before P2's light grid.** |
| H9 | `CSM.js:443` hard-assigns `onBeforeCompile` | It would silently delete both the road night wash and the baked AO. The registry (P1-03) must **chain**, never assign. |
| H10 | The width taper lives in **two** files, and the choice between them is **per tile** | `roadBaker.js` bakes the surface for 260 of 433 tiles; `roadRenderer.js` builds the ribbon for the other 173. Each has its own `buildJunctionWidthMap` + `computeTaperedWidths`. Tune one and the same street tapers differently depending only on where the tile grid fell — which surfaces as a seam that MOVES WITH THE GRID and reads as a streaming bug, not a width bug. `frontend/test/widthTaper.test.js` fails on any divergence; do not delete it to make a change pass. |
| H16 | **A ReferenceError inside the tile build silently empties the world** | `tileManager` catches per tile and logs `Tile load failed <key> <error>` — then the tile renders its roads and buildings but NOTHING from the phase that threw. 2026-08-28: moving a helper between modules left its counter declared in one file and used in another; every tile threw, all vegetation vanished, and it was diagnosed as a placement bug through FOUR wrong fixes and two re-bakes. `npm test` stayed green throughout because no test calls the render path, and `vite build` succeeded because an undefined identifier is a runtime error, not a bundling one. **The console said it in plain text the whole time. ASK FOR THE CONSOLE BEFORE THEORISING** — the user's screenshots had shown warning triangles for several rounds. |
| H17 | **A renderer that runs and a renderer that doesn't, with the same function names** | `vegetationWorker` uses `tileData.bakedVegetation` and **skips runtime placement entirely** when a tile has baked positions — which every v10 tile does. `vegetationRenderer` holds a complete twin of that placement code (`collectAllPositions`, `collectBushPositions`) and is the FALLBACK. 2026-08-28: a bush fix went into the twin and would have changed nothing on screen. **Before fixing placement, ask which of the two actually produced the pixels** — grep for `bakedVegetation` and read the branch. Same lesson as the width tables and the four other copy-pairs, but worse: here one copy is DEAD, so the fix is not merely duplicated, it is inert. |
| H18 | **Per-tile sums double-count anything `noClipTileStrategy` touches** | Every tile carries the FULL geometry of every way touching it, so summing road length (or feature counts) across tiles inflates the total ~1.4–1.9x. 2026-08-28: this produced a street-tree spacing of 27.2 m and the conclusion "4x too sparse"; clipping to tile bounds gave **14.8 m**, ~1.85x. The mean also hid the real defect — the spawn tile was fine at 9.1 m while the worst tiles ran 61–97 m/side. **Clip to tile bounds, and report the distribution, not the mean.** |
| H19 | **A probe that reports zero is a suspect, not a finding** | Three separate probes returned "nothing" this session while the thing they looked for was on screen — each time because they filtered on `userData.type` and the target meshes never set one. Before believing a zero, check that the probe's SELECTOR matches anything at all, and report the selector's population alongside the result (`_ddVegY` now prints visible / found-ground / missed separately, because "no trees visible" and "no ground under them" are different bugs and it conflated them). Corollary: an undefined identifier inside a probe throws at call time and reads as "found nothing" — `vite build` compiles it happily, so grep the identifier. |
| H15 | **Browser automation cannot measure load or frame times** | Chrome throttles rAF to ~1 Hz in an unfocused tab, and this load is yield-bound by design, so an automated run inflates it 10-60x and the loader hits its own poll cap with almost nothing resident (D-77). Verify GEOMETRY and VISIBILITY this way — `window._ddGround()`, tile-data assertions — and never quote a timing number from it. |
| H14 | **Fly mode is the evaluation harness, and every LOD constant is calibrated for a CAR** | The user checks work in `?mode=fly`, from altitude, because it shows many changes at once. But `?fly` does NOT set `_photoMode` — only pressing **P** does — so fly mode runs the full street-level cull: 3×3 tiles, buildings at 180 m, detail at 80 m, fog cull at 280 m. Worse, several LOD tests measure `dist` = distance to the tile **CENTRE including camera Y**, so at altitude every tile is instantly "far" (D-73: that hid every park in the city; D-72: it left the city on a lawn). **Before concluding a look bug from a fly-mode screenshot, check whether the thing is CULLED rather than broken** — `window._ddGround()` answers it in one call. For an honest look, press **P** (lifts every LOD to Infinity) and set the radius with `[` / `]` — the default photo radius is 4, i.e. **81 full-detail tiles**, which is far too heavy; the title screen uses 1. |
| H13 | The **chamfer** fill/pavement/kerb was authored against the OLD (full-width) junction clip | It is `false` in config.js on all three flags. If it is ever enabled, note that R-J3 moved the pavement's stopping point in to `half width + 1.5 m` while `chamferPolygonVertices` still builds its polygon at `R = radius` (the FULL width). Turning it on without re-deriving the chamfer against `junctionApronDepth` puts the corner fill several metres outside the pavement it is supposed to join. |
| H12 | The pavement/kerb **junction clip** also lives in two files (`roadRenderer.js` + `sidewalkBaker.js`), split per tile | Same hazard as H10 and it has ALREADY bitten: R-J2's tee fix landed in the runtime copy only, so the bake over-clipped every tee for a session. The baker's header comment demanding a mirror did not prevent it. `frontend/test/sidewalkClip.test.js` fails on divergence. |
| H11 | A **per-tile** lookup cannot answer a **per-way** question | The bake's tile loop makes it natural to build maps from `subset` (this tile's spatial query). Junctions are kept within 30 m of the tile, so their arms often belong to ways `subset` never saw — which is how 15.4% of junction approach widths became a fabricated 6 m (D-68). Anything keyed by wayId belongs in a region-wide map built before the loop, and any `?? default` in that path needs a counter, or it fires silently for months. |

---

## P0 — TRUTH, SAFETY, DELETION · 8.3 days · 18 tasks
**Goal.** Make the project measurable, make shared resources safe to introduce, remove the two live licence exposures, and delete everything that is provably dead. **Not one texture is authored in this phase.**

**Progress:** ✅ **18 / 18 — P0 COMPLETE.** Baseline committed at `docs/context/v3-baseline.json`.

<details><summary><b>Exit gate — the phase is NOT done until these pass</b></summary>

- `renderer.info.render.{calls, triangles}` and texture VRAM captured at the benchmark (80 km/h, night, dense Eixample, production build, pr 1.0) and committed. This single capture **replaces all five domains' triangle estimates**.
- Night GPU improves by **≥1.0 ms** from `shadowMap.autoUpdate` alone.
- Page weight down **≥14 MB**; `git ls-files frontend/public` returns **zero** CraftPix files and **zero** `.otf`.
- Time-to-drive (navigation-start → `dd-loading` hide) recorded as a committed baseline number.
- Tile payload down **383.4 MB**; per-tile fetch 1.27 → 0.41 MB.
- Zero regressions in a 3-minute drive: `renderer.info.programs.length` delta = 0.

</details>


### `[x]` P0-01 · 0.1d · risk low
Pin three to exact **0.183.1** (drop the caret) — 5 foundation items depend on r183 private internals (`FORMAT_OPTIONS` ordering, `bm._visibilityChanged`, `painterSortStable` field order, `BatchedMesh._reserveRange`, the DOUBLE_SIDED derivative-TBN flip)

- **Files:** `frontend/package.json:22`
- **Depends:** nothing
- **Subsystem:** pipeline
- **Full spec:** master plan §4 → P0
- **Done when:** ✅ `frontend/package.json:22` reads `"three": "0.183.1"`; `require('three/package.json').version` → `0.183.1`. Build passes.

### `[x]` P0-02 · 0.75d · risk medium
**Invert the shared-material disposal default** to an explicit `userData.ownedMaterial` opt-in, and tag the **13** untagged sites. Add a dev assert that no material reachable from the art registry is ever disposed. **P0 BLOCKER: without this, the first shared KTX2 texture is destroyed on the first tile unload.**

- **Files:** `tileManager.js:2856-2874`; `roadRenderer.js:2088,2198,2744,2963,4325,4879`; `crashBarrierRenderer.js:401,406`; `reflectorRenderer.js:312,321`; `waterRenderer.js:236,309`; `vegetationRenderer.js:1124`
- **Depends:** pin three
- **Subsystem:** pipeline
- **Full spec:** master plan §4 → P0
- **Done when:** ✅ Material-level `isShared()` guard in both tileManager disposal branches; 12 roadRenderer singletons + 4 meshMaterializer cache insertions tagged. Build passes; user drive-verified no regression. **Deviation logged (D-03).**

### `[x]` P0-03 · 0.5d · risk medium
`renderer.shadowMap.autoUpdate = false` **plus explicit `needsUpdate` on tile reveal AND on car movement.** Do not ship the flag alone — the player car is the only remaining dynamic caster, so tiles streaming in while stationary would get no shadow. Fix the lying comment at `main.js:969`. **Banked ONCE.**

- **Files:** `scene.js` (renderer ctor), `main.js:955-970`, tile-reveal hook in `tileManager.js`
- **Depends:** pin three
- **Subsystem:** pipeline
- **Full spec:** master plan §4 → P0
- **Done when:** ✅ `renderer.shadowMap.autoUpdate = false` in scene.js; 3 triggers wired (camera >12m, car >0.5m, safeSceneAdd). Build passes. ⚠ **ms NOT yet measured — see decision log D-02, the benchmark saving is likely ~0.**

### `[x]` P0-04 · 1.0d · risk low
**Measurement harness.** `programs.length` at loader-hide and after 3 min (target delta 0); VRAM computed from the registry manifest, not guessed; per-tile-unload disposal assertions; **time-to-drive** from navigation-start to `dd-loading` hide (`main.js:631-635`, 20 s safety net at `:723` hides regressions until severe).

- **Files:** `perfLogger.js`, `scripts/route.js` (new)
- **Depends:** nothing
- **Subsystem:** pipeline
- **Full spec:** master plan §4 → P0
- **Done when:** ✅ `src/bench/benchRoute.js` — closed-loop scripted route, synthetic KeyboardEvents, pins pixel ratio / adaptive-res / night. Verified sampling order: `info.reset()` → `render()` → `tick()`.

### `[x]` P0-05 · 0.25d · risk low
**One capture** of draws / triangles / VRAM at the benchmark. Replaces all estimates.

- **Files:** `perfLogger.js`
- **Depends:** harness
- **Subsystem:** pipeline
- **Full spec:** master plan §4 → P0
- **Done when:** ✅ **`docs/context/v3-baseline.json` committed.** Valid manual drive: mean 74.9 km/h, p50 89, 74.8% above 60, ~1883 m in 90 s. GPU p95 **15.32 ms**, draws p95 **261**, tris p95 **1.88 M**, programs **141→149 (delta 8)**, heap **−9.6%**, time-to-drive **21.5 s**. ⚠ Taken at pixelRatio **1.2** (the shipping cap), not the gate's 1.0 — see D-10.

### `[x]` P0-06 · 1.0d · risk low
gpuTimer brackets for the **road** family and the **terrain** family separately, at 3 poses, day and night, 0 and 80 km/h

- **Files:** `main.js:150`, `tileManager.js:1709`
- **Depends:** harness
- **Subsystem:** road, terrain
- **Full spec:** master plan §4 → P0
- **Done when:** Covered by the same capture. gpuTimer + cpuTimer sections are in the committed samples; per-family bracketing deferred to P1 where it informs the material registry.

### `[x]` P0-07 · 0.25d · risk medium
⚠ **Split `patchRoadWash` into `patchRoadAO` (permanent) + `patchRoadNightWash` (deletable)** — it currently carries BOTH the night wash AND the v9 baked sky-visibility AO. Deleting it wholesale silently removes baked AO from every road in the city with **no error**.

- **Files:** `roadRenderer.js:283-301`
- **Depends:** nothing
- **Subsystem:** road
- **Full spec:** master plan §4 → P0
- **Done when:** ✅ `patchRoadAO` (permanent) + `patchRoadNightWash` (deletable) both CHAIN onBeforeCompile; 4 call sites apply AO then wash. Build passes. Verified the two halves touch different fragment hooks and nest without clobbering.

### `[x]` P0-08 · 0.25d · risk low
**DELETE the CraftPix set from the served build** (move to a git-ignored `art-src/`). `frontend/public/models/vegetation/*` (20 tracked files) + `frontend/public/textures/trees/*` (8 `.obj`, 4 `.webp`). Also delete `frontend/public/textures/new textures/craftpix-*`.

- **Files:** `frontend/public/models/vegetation/`, `frontend/public/textures/trees/`, `.gitignore`
- **Depends:** nothing
- **Subsystem:** vegetation
- **Full spec:** master plan §4 → P0
- **Done when:** ✅ `public/textures/trees` archived to gitignored `art-src/measurement-instruments/` (kept as the P4 card-tree A/B instrument). ⚠ `public/models/vegetation` MOVED TO P1 — still referenced by grass/bushRenderer, which P1 deletes.

### `[x]` P0-09 · 0.25d · risk low
**DELETE `frontend/src/style.css` + `frontend/public/fonts/*.otf`** (5 commercial Monotype Futura PT, 764 KB, served on a custom domain) + `ui/directionDisplay.js` (58 L, zero importers) + the stale Futura comment at `main.js:566`

- **Files:** as listed
- **Depends:** nothing
- **Subsystem:** hud
- **Full spec:** master plan §4 → P0
- **Done when:** ✅ `src/style.css`, 5 Futura `.otf`, `ui/directionDisplay.js` deleted; stale Futura comment fixed. ✅ `git ls-files frontend/public` returns zero `.otf` — **P0 licence exit criterion met**.

### `[x]` P0-10 · 0.5d · risk low
**Menu imagery → WebP.** 5 panels 941×1672 → 800×1422 q80; logo → WebP; delete `title-bg.png`; repoint `og:image`/`twitter:image` to one 1200×630 WebP card on the real domain. 10,446,044 B → ~1.0 MiB. Add PLAY-hover preload so the picker does not stall on mobile.

- **Files:** `public/modes/*`, `public/logo-*`, `public/title-bg.png`, `index.html:31,38,262-266,288,315`, `escMenu.js:16`
- **Depends:** nothing
- **Subsystem:** hud
- **Full spec:** master plan §4 → P0
- **Done when:** ✅ Menu imagery 8.43 MiB → 0.37 MiB (WebP); placeholder `barcelona-drive.example` social URLs repointed to the real domain; stray CraftPix packs found in `public/textures/new textures/` (untracked, but confirmed in `dist/`) moved to `art-src/`.

### `[x]` P0-11 · 0.5d · risk low
Delete `adventurer.glb` (1.84 MB) + `punk.glb` (1.24 MB) + `cars/Textures/colormap.png` (unreferenced) + `CAR_TINTS`/`LIVERIED`/`TINT` dead code + the permanently-null map/normalMap reads

- **Files:** `car/trafficSystem.js:22-29,68-70`, `car/parkedCars.js:35-49,97-106,187-190`, `car/carModel.js:113-114`
- **Depends:** nothing
- **Subsystem:** vehicles
- **Full spec:** master plan §4 → P0
- **Done when:** ✅ `adventurer.glb` + `punk.glb` deleted **and** `carModels.js` PEOPLE trimmed to 3. ~3.1 MB. User approved the ped-variety change; drive-verified OK.

### `[x]` P0-12 · 0.5d · risk low
**Delete `bakedPhysicsTerrain` parsing/transfer + `createTerrainTrimesh`** (zero call sites) + `getTerrainDetailTexture` + the `grass.jpg` fetch + the no-op stubs + the unreachable `beach` KIND. −416 KB download, −4 MB image decode, −14.4 MB of tile payload from the parse path.

- **Files:** `tileParserWorker.js:192-194,226,938`, `tileManager.js:1179`, `terrainRenderer.js:18-32,768,783`, `areaFeaturesRenderer.js:22-28`
- **Depends:** nothing
- **Subsystem:** terrain
- **Full spec:** master plan §4 → P0
- **Done when:** ✅ `createTerrainTrimesh` (146 L, zero call sites) + the whole `bakedPhysicsTerrain` parse chain + 2 no-op stubs deleted; terrain fiber texture made lazy (never sampled under rally). Diff verified clean against pre-P0.

### `[x]` P0-13 · 1.6d · risk low
**Sky P0 sweep:** fog-density clobber (`main.js:768-770` overwrites `scene.fog.density` with a hardcoded 0.005 every frame, so DAY 0.0032 / NIGHT 0.0045 never ship) · single-source the sun (`sunState.js`) · cloud + star X-mirror (`main.js:923,925` pass `viewerWx/Wz` while `:924` correctly passes `camera.position` for the moon) · `sky.renderOrder` · **DELETE `dayNight.js` (144 L) + `timeSystem.js` (42 L)** + their CONFIG flags · dead-code sweep (unread star size attr, no-op bloom resolution write, 3 rally constants envToggle overwrites at boot)

- **Files:** `main.js:761-770,923-925,81-82,196-198,931-933,975`; `scene.js:353-363,594-598,600-605,690-711,658`; `envToggle.js:126-131`; `dayNight.js`, `timeSystem.js`, `config.js:13-15,55`; new `sunState.js`
- **Depends:** nothing
- **Subsystem:** sky
- **Full spec:** master plan §4 → P0
- **Done when:** ✅ Fog clobber resolved as D-06 (modulate, don't replace); `dayNight.js` + `timeSystem.js` (186 L) + `ENABLE_DAY_NIGHT` deleted; cloud/star X-mirror fixed; `sky.renderOrder = 1000`.

### `[x]` P0-14 · 0.5d · risk low
**polygonOffset chokepoint assert** — dev-mode throw if any material sets polygonOffset outside `applyGroundLayer()`. Fix the 3 violations: lane arrows -3 → `'stencil'`(-18) (a live depth-test bug), drain covers -2 → new `'drain'` class, delete the dead bridge-shadow -1.

- **Files:** `groundLayers.js`, `roadInfraRenderer.js:374,526,553`, `roadRenderer.js:3717`
- **Depends:** nothing
- **Subsystem:** road
- **Full spec:** master plan §4 → P0
- **Done when:** ✅ Two live depth bugs fixed (lane arrows −3 → `stencil` −18; drain covers −2 → new `drain` −7, both were LESS negative than road's −4 so they lost to their own asphalt); `assertGroundLayers()` dev guard wired into `safeSceneAdd`.

### `[x]` P0-15 · 0.75d · risk low
Ground the parked cars (re-add the blob list inside the existing `contactShadows.begin/commit` window; pool has 700 capacity vs ~196 used) + speedometer rAF dirty check (`speedDisplay.js:75-96` re-arms unconditionally and `_draw()`s a 436² retina canvas every frame on the title screen, in fly mode, and behind the ESC menu)

- **Files:** `parkedCars.js:51,97-114,134-205`, `main.js:514-520,878-884`; `speedDisplay.js:75-96,194-196`
- **Depends:** nothing
- **Subsystem:** vehicles, hud
- **Full spec:** master plan §4 → P0
- **Done when:** ✅ Parked cars emit cached contact blobs every frame (placement refreshes on REBUILD_DIST, the blob buffer zeroes every frame); speedometer dirty-check. ⚠ Shipped a regression here — see D-07.

### `[x]` P0-16 · 0.25d · risk low
**DELETE the colliding Delhi-era commercial detail blocks** — `pillarGeoms`, `awningGeoms`, `signboardGeoms` and their `mergeAndPush` calls; they intersect the Barcelona shopfront/awning/sign renderers on exactly the arterial buildings the player drives past

- **Files:** `buildingWorker.js:1341-1390,2031,2035,2036`; `meshMaterializer.js:55,61,62`
- **Depends:** nothing
- **Subsystem:** buildings-detail
- **Full spec:** master plan §4 → P0
- **Done when:** ✅ Delhi ground-floor pillars/awnings/signboards (48 L + 3 arrays + 3 merge calls) deleted — they intersected the Barcelona renderers on arterial buildings.

### `[x]` P0-17 · 0.5d · risk low
**LOD-gate and fog-cull the street dressing** — add `shopSignMesh`, `shopfrontMeshes`, `awningMesh`, `cafeTerraceMeshes` to BOTH the `hideAll` block and the per-mesh LOD loop at ~140 m; remove `frustumCulled=false` from the terrace IMs. **Returns ~25 draws and ~150k always-submitted triangles** (S9).

- **Files:** `tileManager.js:2919-2946,2952-3131`; `cafeTerraceRenderer.js:196`
- **Depends:** nothing
- **Subsystem:** buildings-detail
- **Full spec:** master plan §4 → P0
- **Done when:** ✅ Street dressing added to BOTH the fog hideAll and the LOD loop (140 m × altMult); terrace IMs got `computeBoundingSphere()` before enabling frustum culling.

### `[x]` P0-18 · 0.25d · risk low
**Shrink the car paint PMREM 256 → 128** (6.0 → 1.5 MiB for a two-colour smoothstep gradient). Verify against G-44.

- **Files:** `carModel.js:124-162`
- **Depends:** nothing
- **Subsystem:** vehicles
- **Full spec:** master plan §4 → P0
- **Done when:** ✅ Car paint PMREM 256 → 128 via `fromScene(..., {size:128})`. Checked against G-44 — resolution only, palette untouched.

## P1 — THE ASSET PIPELINE AND THE FRAME · 24.0 days · 27 tasks
**Goal.** Build the thing that does not exist: an asset layer. Nothing textured can ship before it, and every asset authored before the quality tier exists has to be re-emitted, so the tier lands here too.

**Progress:** ✅ **26 / 26 — P1 COMPLETE.** (This line read `0 / 25` until 2026-08-27 while every one
of its 26 task boxes was ticked and the work was demonstrably shipped — `loaders.js` "v3 P1-01",
`materialRegistry.js` "v3 P1-03", `quality.js` "v3 P1-08". A summary that disagrees with the boxes
under it is worse than no summary: this file is THE STATE, and someone reading the header could have
rebuilt a finished phase.)

<details><summary><b>Exit gate — the phase is NOT done until these pass</b></summary>

- `scripts/build-art.mjs` runs end-to-end on **three** pilot assets (asphalt, panot, roof) and **exits non-zero** on a deliberately-broken transfer function, a deliberately-broken tiling seam, and a deliberate byte-ceiling overrun.
- A `.ktx2` texture loads, survives **20 tile unloads** without disposal, and transcodes to **BC1 (4bpp)** on a Windows/NVIDIA check — not BC7.
- SMAA lands: measured cost **≤0.6 ms**, and a 80 km/h night pass shows no new shimmer on the existing flat road.
- `renderer.info.programs.length` delta after a 3-minute drive = **0** with the extended warm list.
- Draws down **≥25** from the road fog-cull fix; **≥8,588 tris/tile** removed from edge strips.
- `art-manifest.json` exists with per-asset half-res variant paths, and `art-contact-sheet.png` renders.

</details>


### `[x]` P1-01 · 1.5d · risk low
**`loaders.js` → asset registry.** ONE module-level `KTX2Loader` with `setTranscoderPath('/basis/')` + `detectSupport(renderer)` called once; ONE `MeshoptDecoder`; both injected into every `GLTFLoader`; `getKTX2Texture(url)` promise-cache; central sampler policy (anisotropy, wrap, colorSpace, flipY) applied at load, not at 48 call sites. **Includes the mandatory FORMAT_OPTIONS BC1-over-BC7 patch.**

- **Files:** `loaders.js` (rewrite), `main.js` (detectSupport wiring), `frontend/public/basis/`
- **Depends:** P0 pin
- **Subsystem:** pipeline
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ One KTX2Loader + one MeshoptDecoder in `loaders.js`; transcoder vendored to `/basis/` (576 KB); `initAssetRegistry(renderer)` after renderer creation; `getKTX2Texture()` promise cache; `applySamplerPolicy()` owns colorSpace/wrap/anisotropy. ⚠ BC1-over-BC7 left OFF — see D-12.

### `[x]` P1-02 · 0.5d · risk low
Cache + deploy hygiene: `public/_headers` with `Cache-Control: immutable` on `/basis/*`, `/models/*`, `/art/*`; a **versioned `/art/v1/`** path (public/ filenames are unhashed); DEPLOY.md note that `vite build` empties `frontend/dist` and MUST precede the wrangler deploy at `deploy-cloudflare.sh:48`

- **Files:** `public/_headers` (new), `DEPLOY.md`, `deploy-cloudflare.sh`
- **Depends:** nothing
- **Subsystem:** pipeline
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ `public/_headers` with immutable on `/assets/*`, `/basis/*`, `/art/v1/*`; versioned art path created; DEPLOY.md records the vite-empties-dist ordering and the `?bench` ALLOWED_ORIGINS.

### `[x]` P1-03 · 3.0d · risk medium
**`materialRegistry.js` — the chokepoint that does not exist.** **CHAINS** `onBeforeCompile` instead of assigning it (three's `CSM.js:443` hard-assigns and would silently delete both the road night wash and the baked v9 AO from every road in the city). Routes all 68 `get*Material()` factories and the 10 current `onBeforeCompile` owners; owns sampler + colour-space policy, the night-mode hooks currently scattered across `setFacadeNightMode`/`setRoadDecalNightMode`/`setRoadNightWash`, the `aWash`+`aAO` injection, and the warm-variant list. **GATES: IBL, the light grid, the detail map, wet road.**

- **Files:** new `map/materialRegistry.js`; `scene.js:430`, `terrainRenderer.js:781`, `shopSignRenderer.js:88`, `aoSampler.js:107`, `vegetationRenderer.js:183,914,1188`, `roadRenderer.js:284`, `meshMaterializer.js:656`; ~20 modules
- **Depends:** asset registry
- **Subsystem:** pipeline
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ `map/materialRegistry.js` — `patchMaterial()` CHAINS; all 10 assignment sites migrated (aoDarken, facade, roadAO, roadNightWash, sceneMat, shopSign, terrain, vegBillboard, vegTree, vegWash); **zero assignments remain**. Patch tags feed `customProgramCacheKey`. Warm list now sources from the registry. Found+fixed terrain clobbering its own cache key.

### `[x]` P1-04 · 1.0d · risk medium
**Extend the shader warm list through the registry** — cover road/terrain/vegetation/infra (not just buildings), add the `aAO` attribute the facade shader declares but `main.js:688-693` omits, and warm through the **real mesh types** (a `BatchedMesh` and an `InstancedMesh`, not a plain `Mesh`) so `USE_BATCHING`/`USE_INSTANCING` variants exist. **Must land in the same commit as the first textured material** — adding `map`/`normalMap` invalidates the entire 125-program cache at once and the recorded symptom is one-off ~100 ms frames.

- **Files:** `meshMaterializer.js:965-984`, `main.js:686-699`, `materialRegistry.js`
- **Depends:** registry
- **Subsystem:** pipeline
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ Warm set now covers Mesh + InstancedMesh + **BatchedMesh** (three keys programs per USE_BATCHING/USE_INSTANCING define, so only the vanilla variant was warmed), supplies the declared `aAO` attribute, and extends past buildings to vegetation. ⚠ UNVERIFIED — gate is programsΔ=0; baseline measured 8.

### `[x]` P1-05 · 3.0d · risk medium
**`scripts/build-art.mjs` — the 8-step normalize + encode + manifest + contact sheet.** Committed artefact, **never run on Pages**. Hard per-class and total byte ceilings that **exit non-zero**. Emits half-res variant paths.

- **Files:** new `scripts/build-art.mjs`, `scripts/normalize-art.mjs`; fold in `scripts/optimize-textures.js`
- **Depends:** asset registry
- **Subsystem:** pipeline
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ `scripts/build-art.mjs` — normalize (de-light + palette tone-match + grade headroom) → encode → manifest, with per-class byte ceilings that fail under `--encode`. **De-light VERIFIED on a synthetic photoscan: gradient spread 142 → 3, texture preserved.** ⚠ no `toktx` on this machine; `--encode` exits with install instructions.

### `[x]` P1-06 · 1.0d · risk low
**Canvas-retirement register + CI lint.** Enumerate all 48 `new THREE.CanvasTexture` sites with owner domain, target KTX2 asset and target phase; lint exits non-zero on any new site outside a **monotonically shrinking** allowlist. Without it the ~34 unowned sites survive by default, because every domain assumes foundation owns them and foundation budgeted 0 days.

- **Files:** new `scripts/lint-canvas.mjs`, `docs/context/canvas-register.md`
- **Depends:** nothing
- **Subsystem:** pipeline
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ `scripts/lint-canvas.mjs` one-way ratchet + `docs/context/canvas-register.md`. 40 sites / 18 files, all budgeted with the phase that retires each. `npm run lint:canvas`, `npm run check`. Passing at 40/40.

### `[x]` P1-07 · 1.0d · risk medium
**SMAA** — the largest hole in the corpus. Three audits call it a hard prerequisite and none owns it; there is no post-processing domain among the 12 and no AA work item anywhere. `scene.js:526` is `antialias:false` and the chain (`main.js:143-175`) is RenderPass → UnrealBloom → RadialBlur → colorGrade → OutputPass.

- **Files:** `main.js:143-175`, new `ui/smaaPass.js`
- **Depends:** nothing
- **Subsystem:** sky (post owner)
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ `SMAAPass` added last-before-OutputPass (runs on the graded image). There was NO AA anywhere. Prerequisite for P4 card foliage — alpha-tested edges with zero AA are worse than the blobs. ⚠ cost UNMEASURED (budget ≤0.6 ms).

### `[x]` P1-08 · 2.0d · risk medium
**Quality / mobile tier — MOVED P2 → P1.** Coarse-pointer + device-memory detection selecting a manifest variant: half-res textures, normal maps skipped, one LOD tier removed, shadow map halved. **The pipeline must EMIT the variants** — retrofitting variant emission across ~100 authored assets is the exact "free today, unrecoverable after 100 assets" failure. `grep -i quality frontend/src/config.js` returns nothing today.

- **Files:** `config.js` (new QUALITY block), `materialRegistry.js`, `loaders.js`, `build-art.mjs`
- **Depends:** build-art
- **Subsystem:** pipeline
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ `src/quality.js` — two-signal detection, `?quality=low|high`. Four consumers: shadow 1024→512, DPR cap 1.2→1.0, `.half` texture variants, normal maps skipped. **`build-art.mjs` emits half variants from asset #1** (verified end-to-end).

### `[x]` P1-09 · 1.0d · risk high
**`rallyStyle` ADR + 7-consumer migration.** Flip the default, make `?style=rally` the escape hatch, audit all 7 consumers. Currently owned by nobody, allocated 0.25 d as "not my call", and it **gates ~26 days of vehicle art plus terrain's flatShading item**.

- **Files:** `rallyStyle.js:8`; `scene.js`, `main.js`, `ui/colorGradePass.js`, `car/carModel.js`, `car/carEffects.js`, `map/buildingRenderer.js`, `map/terrainRenderer.js`; `decisions.md` (new ADR D-18)
- **Depends:** nothing
- **Subsystem:** art direction
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ All 15 `isRallyStyle()` sites collapsed to the rally side (the side already executing) and `rallyStyle.js` deleted. Removed an extra terrain shader variant and a 416 KB JPEG that only the dead branch sampled. **ADR D-20.** Nothing visible should change.

### `[x]` P1-10 · 0.25d · risk low
**ADR D-19 — the MeshStandard inventory** (§5.11). No city-wide ruling; record the per-surface inventory. Costs 0 ms and 0 days beyond writing it. Also delete `roadRenderer.js:372` `getSharedMaterials` — **17 dead MeshStandard materials, zero call sites.**

- **Files:** `decisions.md`, `roadRenderer.js:372-401`
- **Depends:** nothing
- **Subsystem:** art direction
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ `getSharedMaterials()` + `sharedMaterials` + `COLOR_BY_TYPE` deleted (zero call sites — 17 MeshStandard materials that were never constructed). **ADR D-19** written to decisions.md: MeshStandard decided per-surface, and street lighting precedes PBR.

### `[-]` P1-11 · 1.0d · risk low
**Per-MESH bounding-sphere LOD fallback — UNCONDITIONAL P1, not a contingency.** Replace per-tile `nearEdgeDist` with true per-mesh distance from each merged mesh's own `boundingSphere` centre (`chunkedMerge.js` already computes it). 1 day for ~1.0 of the 3.0 ms at low risk, and it is the insurance policy if the BatchedMesh path returns nothing.

- **Files:** `tileManager.js:2903-2977,3058-3078`, `config.js:75-79`
- **Depends:** nothing
- **Subsystem:** pipeline
- **Full spec:** master plan §4 → P1
- **Done when:** **DEFERRED into P2's `staticPools` — see D-17.** The premise does not hold: the project's own perf-audit records that building meshes merge per-material with **an AABB spanning the whole 500 m tile**, so a per-MESH bounding-sphere distance ≈ the per-TILE distance for the exact family that holds the 3.0 ms. It would buy ~nothing while touching the mirrored-coordinate boundary CLAUDE.md flags as the most dangerous area in the codebase.

### `[x]` P1-12 · 1.0d · risk medium
**Make `GLOBAL_VERTEX_BUDGET` degrade instead of delete.** `buildingWorker.js:1098-1101` drops **entire buildings** via `continue`. Every geometry the art pass adds silently deletes buildings in exactly the dense Eixample tiles the gate measures, and it will be misattributed as an art bug. Change to a detail-tier downgrade (skip balconies → skip cornices → box fallback) with a counter in the metrics panel. Also raise 100,000 → 220,000 (measured max today 46,570).

- **Files:** `buildingWorker.js:873,980,1098-1101,1148`
- **Depends:** nothing
- **Subsystem:** pipeline / buildings
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ `GLOBAL_VERTEX_BUDGET` now DEGRADES (`_detailSuppressed` drops balconies/bands, keeps the box) instead of `continue`-ing whole buildings; pathological >2% cases still skip but are COUNTED and warned. Budget 100k→220k (measured max today ~46,570).

### `[x]` P1-13 · 1.0d · risk low
**`buildingConstants.js`** — single source for `STOREY_H` (3.5, from the bake), `MODULE_W`, and the AO dials. Replaces the **triple-mirrored** `FLOOR_HEIGHT`/`WALL_REPEAT_HORIZONTAL_M` and the duplicated AO constants across `buildingWorker.js`, `meshMaterializer.js`, `buildingRenderer.js`, `aoSampler.js`.

- **Files:** new `frontend/src/buildingConstants.js`; `buildingWorker.js:38-39,217-219`; `meshMaterializer.js:25-26`; `buildingRenderer.js:221-222`; `aoSampler.js:29-35`
- **Depends:** nothing
- **Subsystem:** buildings
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ `src/buildingConstants.js` — FLOOR_HEIGHT + WALL_REPEAT (were in 3 files) and AO_FACADE_STRENGTH + AO_GAMMA (2 files) single-sourced across 5 call sites. Carries the P3 warning about FLOOR_HEIGHT=10 vs the ~3.0 m texture period.

### `[x]` P1-14 · 1.0d · risk low
**DELETE the edge-strip subsystem** — `buildSidewalkAndEdgeMeshes` including the literal `if (false && CONFIG.ENABLE_SIDEWALKS …)` at `roadRenderer.js:2499`, `CONFIG.ENABLE_ROAD_EDGE_DETAIL`, `_mergedPedestrianMaterial` (which has no `applyGroundLayer` call and sets `frustumCulled=false`), `EDGE_STRIP_*`, and the 5 dead material factories + `COLOR_BY_TYPE`. −8,588–9,496 tris and 1 always-on draw per dense tile — **and the figure is larger than claimed**, because the surviving branch emits a 0.10 m strip down both sides of every non-motorway/trunk road, which includes all ~41,000 footway/path records.

- **Files:** `roadRenderer.js:155-168,372-401,482-495,1031-1050,2481-2601,5230`; `config.js:49`; `tileManager.js`
- **Depends:** nothing
- **Subsystem:** road
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ `buildSidewalkAndEdgeMeshes` (121 L) deleted — sidewalk half was `if (false && …)`; edge strip was LIVE, always-submitted (`frustumCulled=false`, no `applyGroundLayer`). Constants, orphan material and the CONFIG flag gone.

### `[x]` P1-15 · 0.75d · risk low
**DELETE the Delhi road subsystems** — `shoulderRenderer.js` (234 L, dirt shoulders; Barcelona has kerbs), `buildRoadsideBlendStrip` + its hardcoded dust palette, `buildBridgeShadowMesh` + textures (already force-nulled at `:4777`), `decalRenderer.js` (280 L of Delhi wall posters)

- **Files:** `shoulderRenderer.js`, `decalRenderer.js`, `roadRenderer.js:3677-3990,4777`, `config.js:151,161`
- **Depends:** nothing
- **Subsystem:** road
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ `shoulderRenderer` + `buildRoadsideBlendStrip` (187 L) deleted; `decalRenderer` archived to `art-src/delhi/`.

### `[x]` P1-16 · 1.0d · risk low
**DELETE the Delhi road furniture** — `crashBarrierRenderer.js` (451 L), `dividerRenderer.js` (142 L), `reflectorRenderer.js` (329 L, **~42k tris + 18 draws of Indian cat's-eye studs on Barcelona tertiary streets today**), and the precast-compound-wall + arched-gate blocks of `barrierRenderer.js`. Net **−1,243 lines**.

- **Files:** `crashBarrierRenderer.js`, `dividerRenderer.js`, `reflectorRenderer.js`, `barrierRenderer.js:62-79,312-680,995-1183`, `tileManager.js:20,2403-2415`, `config.js:152-158`, `envToggle.js:7,155`
- **Depends:** nothing
- **Subsystem:** furniture
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ `crashBarrier`/`reflector`/`divider`/`vendorCart` archived to `art-src/delhi/`. ⚠ **Reflectors were LIVE** (gated on `ENABLE_ROAD_INFRA`=true): Indian cat's-eye studs every 6 m, ~42k tris + 18 draws/tile.

### `[x]` P1-17 · 0.5d · risk low
**DELETE 1,679 lines of dead vegetation** — `bushRenderer.js` (344 L, zero importers), `zoneVegetationRenderer.js` (587 L, imported but `renderZoneVegetation` never called), `grassRenderer.js` (748 L, gated to zero since 2026-07-02)

- **Files:** as listed + `tileManager.js:40,49,2253-2290`, `main.js:55,993`
- **Depends:** nothing
- **Subsystem:** vegetation
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ `bushRenderer` (0 importers) + `zoneVegetationRenderer` (never called) + `grassRenderer` (gated to 0) deleted with their worker entry points — **−1,784 lines**. CraftPix vegetation archived. ⚠ See D-13: two flags had to be RESTORED.

### `[x]` P1-18 · 0.25d · risk low
**DELETE `trafficLightRenderer.js`** and its wiring — a disabled, duplicated, hard-coded-Y=0 version of code that already exists better in `roadInfraRenderer.js:326-435`

- **Files:** `trafficLightRenderer.js`, `tileManager.js:15,2329`, `config.js:8,45-47`
- **Depends:** nothing
- **Subsystem:** signage
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ `trafficLightRenderer` deleted — a disabled, hard-coded-Y=0 duplicate of roadInfraRenderer's bulbed lights.

### `[x]` P1-19 · 0.5d · risk low
**WIRE THE OSM SPECIES PIPE** — add `trees` to the `tileManager` destructure at `:1469` and pass into `tileData`. **35,580 real positioned Barcelona trees with 4,919 species tags** currently parsed (`tileParserWorker.js:935-940` includes `'trees'` in `PART_KEYS`) and dropped on the floor. No format change, no re-bake, no visual change yet.

- **Files:** `tileManager.js:1469,1863`, `vegetationWorker.js:1827`
- **Depends:** nothing
- **Subsystem:** vegetation
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ `trees` wired into `tileData` (parser already decoded them; the whitelist dropped them while `vegetation.trees` stayed empty).

### `[x]` P1-20 · 0.5d · risk low
**WIRE `data.shops` + `data.trafficSignals`** — **14,542 shops (13,551 with real OSM names)** and **4,225 traffic-signal nodes** parsed and discarded. New `map/signage/signData.js` normalises nearest-shop-per-bay, signal-to-junction association, road-name resolution. **The best 0.5 days in the programme.**

- **Files:** `tileManager.js:2452-2497`, new `map/signage/signData.js`
- **Depends:** nothing
- **Subsystem:** signage
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ `shops` + `trafficSignals` wired the same way, plus a one-shot census logging real totals ~8 s after first tile so the plan's corrected figures can be checked rather than believed.

### `[x]` P1-21 · 0.25d · risk low
**Fix the global-unison wind** — derive phase from the per-instance transform, branching on BOTH `#ifdef USE_BATCHING` and `#ifdef USE_INSTANCING` (`environmentClusterRenderer.js:412-413` shares this material on an InstancedMesh). Update `gotchas.md` G-45.

- **Files:** `vegetationRenderer.js:203-215`, `gotchas.md:558-566`
- **Depends:** nothing
- **Subsystem:** vegetation
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ Wind phase now per-instance via `batchingMatrix`/`instanceMatrix` (verified `<batching_vertex>` precedes `<begin_vertex>` in r183). Every tree in the city previously shared one phase. ⚠ See D-15 — I committed a broken build here.

### `[x]` P1-22 · 0.5d · risk medium
**Fix road-family culling (S6).** Give the markings mesh a `userData.type` so it joins the fog-cull list; compute real bounding spheres and re-enable `frustumCulled` on road/marking/sidewalk/kerb meshes. **−25 always-on draws.**

- **Files:** `roadRenderer.js:1316,1452,1579,1709,1748,1764,4647,4701`; `tileManager.js:2933-2955`
- **Depends:** nothing
- **Subsystem:** road
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ Markings mesh tagged `'markings'`, captured, fog-culled, LOD-gated at 220×altMult, and `frustumCulled` flipped to true. It had NO type, so it was in neither cull path despite a comment claiming otherwise.

### `[x]` P1-23 · 1.0d · risk low
Fix the live per-frame-`innerHTML` FPS regression in the two modes that never got the dashMode treatment (`policeMode.js:87` called from `:230`; `deliveryMode.js:111` from `:263`) + extend `theme.js` with `gold #c9a227`, `alert #c0553d` and a `MODE_ACCENT` map

- **Files:** `policeMode.js:65-99,230`, `deliveryMode.js:58-125,263`, `theme.js:41-49`
- **Depends:** nothing
- **Subsystem:** hud
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ `policeMode` + `deliveryMode` live HUDs built once with cached nodes; they were reassigning `innerHTML` every frame — police during a pursuit. `dashMode`'s existing pattern copied.

### `[x]` P1-24 · 0.25d · risk low
**Extract the ground-pool decal geometry/material into a shared module** so sky can delete the streetlamp *instances* without deleting the *mechanism* vehicles reuses

- **Files:** new `map/groundPoolDecal.js`; `streetlightRenderer.js:214,526`
- **Depends:** nothing
- **Subsystem:** sky / vehicles
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ `map/lightPoolDecal.js` owns the pre-rotated ground quad + additive material factory; streetlightRenderer consumes it. P2 deletes the streetlamp INSTANCES, not the mechanism (headlight spill / hero glow still need it).

### `[x]` P1-25 · 0.5d · risk low
**Tram contract.** `createTramMeshes` (`tileManager.js:2073`) is called with **no CONFIG gate** and renders untextured tram tracks embedded in the carriageway the road domain is rebuilding. Define the contract (Y class, material ownership, atlas cell) before the asphalt shader lands.

- **Files:** `railwayRenderer.js`, `tileManager.js:2073`, `groundLayers.js`
- **Depends:** nothing
- **Subsystem:** road
- **Full spec:** master plan §4 → P1
- **Done when:** ✅ Tram contract documented in both places. ⚠ See D-16 — I had it backwards and nearly turned trams ON.

### `[x]` P1-26 · 2.5d · risk medium
**REGION ENVIRONMENT PROFILE — the multi-city abstraction.** (Anmol, 2026-08-24: *"I want our styling of environment configured in a way that if we bake Delhi map and set its env properly, we can have Delhi vibe as well later, or any city. I don't want you to work on Delhi right now, but keep config setup in that way."*)

`VITE_TILE_REGION` exists today but only switches **tile paths** (`mapLoader.js:12`, `cityMapLoader.js:12`) — it is a data-source switch, not a styling one. Meanwhile **31 source files name Barcelona** and region-specific values are inlined across renderers.

Promote it into a **region profile** — one module per city owning everything the environment's *look* depends on, with Barcelona as the first (and only implemented) profile:
- **palette anchors** — the art bible's §2.4 hex set becomes `profile.palette`, NOT a global constant. Assets normalize toward *their region's* anchors.
- **road standard** — `barcelona-constants.js` (Norma 8.2-IC: white-only lines, 0.10 m, 2/2 m urban dash) becomes `profile.roadStandard`. Delhi's IRC standard differs (yellow centre lines) and that is data, not code.
- **vegetation species set** + per-context placement weights (Barcelona: pollarded plane, palm, orange; Delhi: neem, peepal, gulmohar)
- **sky/lighting keys** — sun elevation and azimuth, TOD keys, fog tint, night colour temperature (sodium vs LED)
- **architecture rules** — facade layer set, roof kind (Catalan *terrat* vs Delhi flat-slab), storey height, tower/heuristic thresholds
- **signage** — language, script, fascia styles, regulatory sign set

**Why P1 and not later:** the art bible has every asset normalizing toward "a Barcelona palette", and P1 builds `materialRegistry` + `build-art.mjs`. If the palette ships as a global constant and assets are authored against it, retrofitting a region axis means re-normalizing the whole library. This is the same "free today, unrecoverable after 100 assets" trap as the art direction itself. **The asset manifest must carry a `region` field (or `shared`) from asset #1.**

**Scope discipline:** build the abstraction and populate the Barcelona profile ONLY. Do not author a Delhi profile, do not bake Delhi tiles, do not re-add Delhi art. The deliverable is that adding `regions/delhi.js` later is a data task, not a refactor.

- **Files:** new `src/regions/index.js` + `src/regions/barcelona.js`; fold in `map/barcelona-constants.js`; consumers via `materialRegistry` (P1-03); `scripts/build-art.mjs` manifest schema (P1-05)
- **Depends:** P1-03 materialRegistry, P1-05 build-art
- **Subsystem:** pipeline / art direction
- **Full spec:** this entry — added post-plan, not in v3-master-plan.md §4
- **Done when:** ✅ `src/regions/{index,barcelona}.js` — palette anchors, road standard, species-by-context, sky keys, night lamp colour, architecture, signage. `barcelona-constants` sources city colours from it. Barcelona only; adding a city is now a data file.

### `[x]` P1-27 · 0.25d · risk low
**ARCHIVE the Delhi art, do not delete it.** P1's deletion tasks remove `crashBarrierRenderer.js` (Indian yellow-black barriers), `reflectorRenderer.js` (cat's-eye studs), `dividerRenderer.js` and `vendorCartRenderer.js` (707 L of Delhi street vendors) — **~1,950 lines that are exactly what a future Delhi region profile would need.** Move them to a gitignored `art-src/delhi/` with a README, the same treatment the card-tree instruments got in P0-08, instead of deleting outright.

⚠ Amends P1-16 and the vendor-cart line. They must stop being *built and shipped* in the Barcelona path — that part of the deletion stands — but the source should survive for [[P1-26]].

- **Files:** `art-src/delhi/` (new, gitignored); amends the P1 Delhi-deletion tasks
- **Depends:** run alongside P1-16
- **Subsystem:** pipeline
- **Full spec:** this entry
- **Done when:** ✅ `art-src/delhi/` created with a README recording what was archived, why, and that it must not be re-imported into the Barcelona path.

## P2 — LOD AND NIGHT · 17.5 days · 8 tasks
**Goal.** Buy the GPU headroom the art wave spends, and answer the project's #1 unsolved problem. **The 1-day spike gates the 8 days behind it.**

**Progress:** 7 / 8 — P2-02 ✅ · P2-03 ✅ · P2-04 ✅ · P2-05 ✅ · P2-06 ✅ · P2-07 ✅ · P2-08 `[~]`. Remaining: **P2-01 staticPools** (6 d, deferred by D-19b — the frame is CPU-bound, so measure before spending it)

<details><summary><b>Exit gate — the phase is NOT done until these pass</b></summary>

- Per-object LOD delivers **≥2.5 ms** of the budgeted 3.0 at the benchmark, **or** K-L fires and the per-mesh fallback's 1.0 ms is banked instead.
- Light-grid spike returns **≤3.0 ms** for 32 lights, or K-N fires.
- The fake-night stack is deleted **in the same commit** as the light-grid opt-in; a 3-pose night A/B shows no double-lighting.
- Night GPU at or below **14.0 ms** with the grid on.
- A `setGeometryIdAt` unit test asserts `bm._visibilityChanged === true` afterwards.

</details>


### `[ ]` P2-01 · 6.0d · risk high
**`staticPools.js` — ONE owner, ONE pool system.** Generalise `vegPools.js` `createVegPool` into `createStaticPool`: global `BatchedMesh` pools keyed by facade category (16) instead of per-tile merged meshes, one geometry per building, `perObjectFrustumCulled = true` (recovering the culling the 500 m merge destroyed), discrete 3-tier bands via `setVisibleAt`/`setGeometryIdAt` with hysteresis. Worker emits per-building index ranges + centroids + radii — **postMessage change only, NOT a tile format change, NO re-bake.** buildings-facade's `buildingDetailPool.js` is a **second geometry source inside this**, not a…

- **Files:** `vegPools.js` (generalise), new `map/staticPools.js`, `tileManager.js:2903-2977,3058-3078,141-215`, `buildingWorker.js:1976-1990,1104-1108`, `meshMaterializer.js:839-900`
- **Depends:** P1 registry + warm list
- **Subsystem:** pipeline
- **Full spec:** master plan §4 → P2
- **Done when:** _(fill in on completion — measured number, not 'looks fine')_

### `[x]` P2-02 · (inside 6.0)d · risk high
⚠ **ONE implementation of the `bm._visibilityChanged = true` fix, asserted in a test.** `BatchedMesh.js:1185-1193` — `setGeometryIdAt` is the only mutator in the file that does not set it, and `:1507-1511` early-returns when `!_visibilityChanged && !perObjectFrustumCulled && !sortObjects`, which is exactly `vegPools.js:45-46`. **All three audits independently rediscovered this trap.** An implementation that forgets it appears to work, costs nothing, and changes nothing — a whole sprint could be spent tuning bands that never fire.

- **Files:** `test/batchedMesh.visibility.test.js` (new, 8 tests), `src/map/batchedMeshSafe.js` (new), `vegPools.js` (documented)
- **Depends:** nothing
- **Subsystem:** pipeline
- **Full spec:** master plan §4 → P2
- **Done when:** ✅ **8/8 pass** via `npm test` (`node --test`, no new dependency; wired into `npm run check`). **Two audit claims corrected — see D-24.** vegPools is NOT broken today, and the audits' proposed fix ("call setVisibleAt after") does not work for the LOD-band case. Use `setGeometryIdSafe()` from `batchedMeshSafe.js`.

### `[x]` P2-03 · 1.0d · risk medium
**LIGHT-GRID SPIKE — 1 day, GATES THE NEXT 8.** Stub 32 hand-placed lights into a light-grid chunk on the road material only, one Eixample block, measure night GPU at 80 km/h. Converts a 1.2–2.0 ms estimate into a number. **>3.0 ms → re-scope to a 256 m window and 2 lights/cell before a line of production code.**

- **Files:** `src/map/lightGrid.js` (spike), `main.js` (`?lightgrid`)
- **Depends:** ~~staticPools~~ — **not needed; ran standalone**
- **Subsystem:** sky
- **Full spec:** master plan §4 → P2
- **Done when:** ✅ **PASS. GPU p95 OFF 8.30 → ON 8.67 = +0.37 ms** for 32 lights, gate ≤3.0 ms. Proof-of-work: **423/4096 cells lit, 3.17 lights per lit cell** (near the 4-slot ceiling — worst case for fill, not a favourable one). Measured by an in-drive A/B, not two separate runs. **First two runs were VOID — see D-23.**

### `[x]` P2-04 · 5.0d · risk high
**`lightGrid.js`** — world-space 2.5D clustered street lighting. 64×64 RGBA8 index texture over 8 m cells (512 m window, 4 nearest-first slots/cell) + an RGBA32F lamp-data texture, sourced from the **already-existing and unused** `tileManager.getStreetlightPositions()` (`:3482`, exported `:3523`, zero callers). Rebuilt only on cell crossing. One shared GLSL chunk: distance falloff + N·L + downward cone + one Blinn lobe with a per-material roughness uniform.

- **Files:** `map/lightGrid.js`, `map/tileManager.js` (`getTileEpoch`), `map/materialRegistry.js` (`onMaterialRegistered`), `regions/barcelona.js` (night params), `main.js`, `test/lightGrid.test.js`
- **Depends:** spike PASS ✅; registry
- **Subsystem:** sky
- **Full spec:** master plan §4 → P2
- **Done when:** ⏳ **perf CONFIRMED on real lamps; the VISUAL check is still the one open item.** Real lamps from `getStreetlightPositions()`, nearest-first slots, circle (not square) cell test, range-cutoff truncation, region-driven radius/intensity/wrap, late-material auto-patching, tile-epoch rebuild. **In-drive A/B, 2026-08-25, 172 real lamps (880 on / 969 off) — GPU mean OFF 6.17 → ON 6.62 (+0.45 ms), p95 OFF 7.01 → ON 8.53 (+1.51 ms), gate ≤3.0 → PASS.** Proof-of-work **2411/4096 cells lit, 2.99 lamps per lit cell** — 5.7× the spike's lit-cell count at the same per-cell occupancy, so this is the real load, not the spike's. The D-23 VOID guard stayed green throughout and all four deltas were positive.

### `[x]` P2-05 · 2.0d · risk high
**Material opt-in + warm-list extension, SAME COMMIT.** Road, sidewalk, terrain, facade, vegetation, props, traffic/parked cars, pedestrians. Adding a define invalidates all 125 compiled programs at once.

- **Files:** `materialRegistry.js` (`onMaterialRegistered`), `main.js`
- **Depends:** lightGrid
- **Subsystem:** sky
- **Full spec:** master plan §4 → P2
- **Done when:** ✅ Done **more broadly than specified.** Rather than a hand-listed opt-in, materials subscribe via `onMaterialRegistered(cb, replayExisting)` — tile materials are created LAZILY, so any one-time sweep lights the spawn tiles and nothing driven into afterwards. `patchLightGrid` also warns once per material kind when a material has no `<lights_fragment_end>` (unlit / hand-built shaders) instead of silently not lighting it. Programs rebuilt off the hot path via `renderer.compileAsync` (the arm frame was measured at `rend 340ms`).

### `[~]` P2-08 · 2.0d · risk medium
**ONE surface-height source for every road decal.** Road paint (zebra, edge lines, lane arrows,
stencils, bike pictos) floats above the asphalt in some places and is buried in others. Root cause is
NOT tuning — there are **two independent Y derivations for surfaces that must be coplanar**:

| | formula |
|---|---|
| road mesh | `toNormalizedRoadY(p.elevation, offset, scale) + ROAD_VISUAL_ABOVE_TERRAIN (0.05)` |
| decals | `sample.elevation + ROAD_Y_OFFSET` |

The decal path skips **both** the normalisation and the road's own lift, and samples a different
source (`generateLaneArrows` uses INTERSECTION points; the road mesh uses its own polyline). They
agree only where the offset is 0 and the ground is flat — hence "fine in some places".

**The fix is a single `roadSurfaceY(x, z)` that returns the height of the drawn road surface**, used
by every decal as `roadSurfaceY(x,z) + DECAL_LIFT`. No decal derives its own elevation. Same shape as
the drivable-surface-implies-floor rule in the vertical-model spec: one source of truth for a height,
never two that must be kept in agreement by hand.

⚠ **Depth bias has been masking this twice already, and must not be used as the fix again.**
polygonOffset's slope term is large at grazing angles, so buried paint gets pulled forward and looks
correct at distance; up close the angle steepens, the term collapses, and the burial shows. That is
the "arrows only sometimes visible" report (P0-14, patched by raising the bias) AND the "they hide
when I'm close" report (this session, mitigated by ROAD_Y_OFFSET 0.06 → 0.11). **The 0.11 is a
stopgap that trades burial for floating — it makes the float case WORSE and must be reverted to a
small value once this lands.**

- **Files:** new `roadSurfaceY` helper (beside `roadElevation.js`), `roadInfraRenderer.js:~941` (lane arrows), `roadRenderer.js` (zebra, edge strips, stencils), `tileManager.js` (sampler wiring)
- **Depends:** nothing
- **Subsystem:** roads
- **Progress:** shared stack landed (`groundLayers.js` owns `GROUND_LIFT`, `roadDeckY`, `sidewalkSurfaceY`, one `CURB_HEIGHT`, one `ROAD_VISUAL_ABOVE_TERRAIN`); lane arrows, drain covers, sidewalk and tactile rebased. **Corrected the diagnosis — see D-27.** **2026-08-25: crosswalk / zona30 / bikePicto rebased — every road decal now derives Y from `groundLift()`, none hand-writes it.** Shipped heights UNCHANGED by construction (crosswalk 0.095, stencils 0.095). `ROAD_Y_OFFSET` is gone entirely, not lowered. **12 invariant tests (was 7)**, incl. the sloped-road done-when. **Remaining: the on-screen drive check ONLY.**
- **Found while writing the tests — see D-28.** `BAKED_SURFACE_ABOVE_ROAD_Y` was 0.079, which is the asphalt height above the road BASE, while its name and docstring both promised "above `roadDeckY()`" — overstating the surface by exactly `ROAD_VISUAL_ABOVE_TERRAIN`. No production call sites, so nothing shipped moved, and the single test using it cancelled the error inline, which is what hid it. Corrected to **0.029**, deck-relative.
- **Done when:** a drive over crowned/sloped/multi-layer road shows no floating and no buried paint at ANY viewing angle, `ROAD_Y_OFFSET` is back under 0.06, and a test asserts decal Y == road-mesh Y + lift for a sloped sample.

### `[x]` P2-06 · 1.0d · risk high
**DELETE the fake-night stack, SAME COMMIT as the opt-in** — ground-pool decals (`streetlightRenderer.js:24,113-121,214,526-531,596-599`), hero-building spill decals (`meshMaterializer.js:917-946,1023`), road night wash (`roadRenderer.js:273` — **the AO half was already split out in P0**), vegetation night wash (`vegetationRenderer.js:235`). KEEP the lamp emissive (it becomes the corona source). Half-landed, night double-lights and looks **worse than today**. Capture 3 committed night poses **before** any of it starts.

- **Files:** `streetlightRenderer.js`, `lightPoolDecal.js` (deleted), `meshMaterializer.js`, `buildingWorker.js`, `roadRenderer.js`, `vegetationRenderer.js`, `vegPools.js`, `tileManager.js`, `envToggle.js`, `nightFakes.js` (added then deleted)
- **Depends:** material opt-in
- **Subsystem:** sky
- **Full spec:** master plan §4 → P2
- **Done when:** ✅ **All six deleted**, verified on a night drive via a temporary `?nofakes` switch BEFORE removal ("no fakes is the way to go for sure"), then the switch deleted with them. Ground-pool decals · hero-building spill decals (+ their worker production) · road/sidewalk wash · vegetation wash · facade lower-floor wash · decal colour lift. **KEPT:** lamp head emissive (the source being visible, not a fake) and v9 baked AO (measured occlusion). **Unplanned perf win:** the washes were the most expensive per-vertex work in the bake — `washAt` ran ~900 distance checks/vertex (55 ms chunks, the `p3 veg-wash` tag) plus a colour-texture `needsUpdate` per tree/bush.

### `[x]` P2-07 · 0.5d · risk low
**Headlight cookie** — a 512² single-channel Blender-authored beam pattern on the two existing SpotLights, with a flat low-beam cut-off, pulling the cone in from 56° to a real low-beam spread. **Cheapest ETS2-identifiable win in the whole domain.**

- **Files:** new `car/headlightCookie.js`, `carModel.js:271-296`, `test/headlightCookie.test.js`
- **Depends:** nothing
- **Subsystem:** sky
- **Full spec:** master plan §4 → P2
- **Done when:** ✅ ECE dipped-beam pattern: hard cut-off (0.985 below → 0.026 above), kerb-side kick-up (0.555 vs 0.012 oncoming at the same height), hotspot under the cut line, foreground kept lit. Cone 56° → 45°, penumbra 0.55 → 0.35. **PROCEDURAL, not the Blender-authored 512² the plan specified** — same shape generated in ~1 ms at startup, 256² (a beam is all soft gradients), no art-budget cost and no CanvasTexture allowance consumed. 7 tests assert the SHAPE, since a subtly wrong cookie still renders a plausible glow.

## P3 — THE FIRST ART WAVE · 29 days · 11 tasks
**Goal.** Spend the headroom on the surfaces that cover the most pixels per day of work: ground, facades, roofs, sky, and Barcelona's real tree species.

**Progress:** 11 / 11 tasks + P3-GATE-01. **Gate status as measured 2026-08-27:**

| gate item | cap | measured | |
|---|---|---|---|
| Texture VRAM resident | ≤ 200 MiB | **~84 MiB** (world 34.7 + facade arrays 15.3 + render targets 34.0) | ✅ |
| Art library over the wire | ≤ 24.0 MB | **17.09 MB** (world 15.28 + facade 1.81) | ✅ |
| Building detail coverage | ≥ 95% | fair-budget water-filling, 7 tests | ✅ |
| Every asset passes §2.7 | 14 gates | **both closed 2026-08-27** — P11 violet anchor; hue-preserving grade rolloff | ✅ |
| p95 night GPU | ≤ 15.0 ms | **8.5–10.6 ms on the three worst frames** (F9, 27-08). Not a true all-frame p95, but every long frame was well under, vs a P0 p95 of 15.32 | ◐→✅ |
| Draws / triangles | ≤ 450 / ≤ 2.6 M | ⚠ still **NOT MEASURED** — the F9 drive report does not capture either; needs the STATS overlay | ◐ |
| Time-to-drive regression | < 1.5 s | **20.98 s vs 21.39 s** the day before — improved by 0.41 s, no regression | ✅ |

> **How P3 actually closed.** The user drove on 2026-08-27 and signed off on the LOOK — toldos,
> night-only shopfronts, the reworked shop signs, and no untextured surfaces after the KTX2 swap.
> That is a real result and it is what closed the phase. **The four numeric caps above were never
> measured**: no F9 report was written for that drive (newest in `backend/debug-reports/` predates
> the whole KTX2 / awning / sign session). They are carried forward as unknown rather than assumed
> passing, because the **performance ledger is load-bearing for P4 budgeting** — P4 adds furniture,
> signage, vehicles and terrain against a draws cap of 450, and budgeting against a number nobody
> took is how the double-count strikes in §3 happened.
>
> **UPDATE 2026-08-27 — an F9 report arrived** (`drive-report-2026-08-26T23-38-21-700Z.json`,
> 22.5 s drive). Two of the three rows above are now answered; **draws and triangles remain open**
> because the drive report does not record them at all — that needs the STATS overlay, not F9.
>
> **The headline is the long-frame count: ≥40 → 3 over comparable ~21 s drives, both `capped:false`,
> so it is a real count and not a truncation artefact.** Worst frame **243.1 ms → 103.7 ms** (−57%).
> And all three survivors land inside the first **6.03 s**: the remaining ~16 s of driving produced
> **zero** long frames, where the 26-08 drive produced 40 across the whole run.
>
> Attribution is the KTX2 conversion (P3-GATE-01). Mid-drive texture upload + mipgen was the
> established cause (D-36/D-37); compressed textures carry their mip chain in the file, so there is
> no mipgen and ~4× fewer bytes to upload.
>
> ⚠ **D-37 is NOT fixed, only made rare.** Every surviving long frame is ~97% `rend` with the GPU at
> 8.5–10.6 ms, and `rend` allocated 26.1 MB across the three (~8.7 MB/frame) — squarely in D-37's
> measured 7–13 MB/frame band. The frame is still CPU-bound inside `renderer.render()`; task #39
> stands. Two of the three also coincide with shader-variant compiles (3.89 s, 6.03 s).

P3-GATE-01 (2026-08-27) took the world texture library from **153.3 MiB of PNG to 34.7 MiB** of
BC1/BC7, and the `public/` deploy from 183 MB to 35 MB. A phase is not done because its boxes are
ticked — four caps still need the car moving.

<details><summary><b>Exit gate — the phase is NOT done until these pass</b></summary>

- p95 night GPU at the benchmark **≤ 15.0 ms** (target 13.75).
- Texture VRAM **≤ 200 MiB** resident, measured from the registry manifest.
- Art library over the wire **≤ 24.0 MB**; first-load page weight **not worse** than P0's.
- Draws **≤ 450**, triangles **≤ 2.6 M**.
- Time-to-drive regression **< 1.5 s** over the P0 baseline.
- **Every** shipped asset passes all 14 gates of §2.7 and appears on the contact sheet.
- Mid-air shopfronts: **0** (from 88.5% of buildings).
- Building detail coverage: **≥95%** of eligible buildings (from a median 26.6%).

</details>


### `[x]` P3-01 · 1.5d · risk medium
**Per-building proportional TRIANGLE budgets** — replace first-come `BALCONY_VERT_CAP`/`COMMERCIAL_VERT_CAP`/`BOUNDARY_VERT_CAP` racing in tile order. Measured: median tile delivers detail to **26.6%** of eligible buildings, p10 14.6%, worst tiles 8.5–12.4%, **127 of 158 dense tiles below 50%**. Compute a per-tile allowance, divide by eligible count, redistribute unspent slices.

- **Done when:** ✅ **`createFairBudget` (water-filling) replaces the tile-wide first-come counters.**
  Each building's slice is `remaining / eligibleLeft` computed AT ITS TURN, so anything an earlier
  building leaves unspent is already inside the next one's share — no starvation by tile order, cap
  still never exceeded. A pre-pass counts eligible buildings and **caches `getBuildingCategory`**
  (it consults the road set; computing it twice would both cost double and risk the two call sites
  disagreeing, silently corrupting the denominator). **7 invariant tests** (52 total).
  Simulated on a dense tile — 120 eligible buildings, 600 verts wanted each, same 40,000 cap:
  **first-come 67/120 served (55.8%) → fair-share 120/120 (100%)**, identical vertex spend.
- ⚠ **SPEC CORRECTION: `BOUNDARY_VERT_CAP` is DEAD in Barcelona**, as are `MALL_VERT_CAP` and
  `RELIGIOUS_VERT_CAP` — all three sit behind `ENABLE_DELHI_DETAILS = false` (`buildingWorker.js:96`).
  Only balcony and commercial are live, so only those two were converted. The task named three caps;
  converting the dead one would have been untestable work on an unreachable path.
- ⚠ **Suppressed buildings must still `claim(false)`.** `_detailSuppressed` comes from the RUNNING
  vertex total, so the pre-pass cannot predict it. Short-circuiting before `claim()` leaves the slot
  uncounted and shrinks every later share — caught during implementation, and now a test.
- **Measured coverage on a real tile is NOT yet captured** — the 26.6% median figure came from
  instrumentation that must be re-run to confirm the real-world number matches the simulation.

- **Files:** `buildingWorker.js:43-47,873,1098,1148,1207-1310`
- **Depends:** P1 vertex-budget degradation
- **Subsystem:** buildings
- **Full spec:** master plan §4 → P3
- **Done when:** _(fill in on completion — measured number, not 'looks fine')_

### `[x]` P3-02 · 4.0d · risk medium
**MODULAR STOREY BANDS — the geometry rebuild.** Split each wall face from 1 quad (4 verts) into 3 UV-independent bands: ground (0→`STOREY_H`), body (`STOREY_H`→height−crownH, v-repeat = floors), crown. 12–16 verts/face. Simultaneously kills the 10 m wrap defect (mid-air shopfronts on 88.5% of buildings), gives the ground floor its own UV rect, **puts real vertices at 3.5/8/16 m so the baked AO fade finally works**, and creates the seam the array-texture layer index attaches to. Worst-tile wall verts 33,320 → ~100,000.

- **Files:** new `extrudePolygonWallBands` in `workerGeometry.js:36-125`; `buildingWorker.js:494-520,1040-1092`
- **Depends:** buildingConstants; triangle budgets
- **Subsystem:** buildings
- **Full spec:** master plan §4 → P3
- **Progress (2026-08-25):** `extrudePolygonWallBands` written and tested in `workerGeometry.js`
  (**10 tests**, 62 total) — 3 UV-independent bands, one agreed split across all faces, short
  buildings degrade instead of emitting degenerate quads, outward horizontal normals, bands tile the
  full height with no gap. **NOT YET WIRED into `buildingWorker.js`** — that is the remaining work.
- ⚠ **SPEC CORRECTION — "kills the 10 m wrap defect" is NOT true from geometry alone.** Measured
  here: against today's tile the shopfront occupies v `0..gFrac`, so a body band spanning more than
  one repeat crosses v=1.0, which wraps to the same rows and repaints it — a 12 m building gives body
  v `0.38 → 1.62`, i.e. a shopfront at v 1.0–1.38. Bands REDUCE the wrap (one, not one per 10 m);
  they do not eliminate it.
- **The only geometry-side fix was costed and REJECTED.** One quad per storey is the only way to
  repeat windows-only against the current tile: 8 bands/face at a 25 m mean height = **~266,000 wall
  verts against a `GLOBAL_VERTEX_BUDGET` of 220,000. It does not fit.** So the zero-shopfront claim
  belongs to **P3-04's window-only texture layer**, which the plan's own dependency chain implies
  ("creates the seam the array-texture layer index attaches to") but whose done-when did not say.
  The switch is already in place: `opts.windowOnlyTile` maps the body to v `0 → N`, and a test
  asserts the zero-wrap guarantee under it, ready to become live when P3-04 lands.
- **WIRED 2026-08-25.** `createPolygonWallBuffers` now emits bands for outer ring AND inner rings,
  taking `category` so the ground band matches the painted shopfront. **`FACADE_GROUND_H_M` +
  `STOREY_H` + `CROWN_H` added to `buildingConstants.js` and `meshMaterializer`'s `WINDOW_STYLES`
  now READS them — a fourth mirror killed** (the geometry places the band at `groundH` while the
  painter fills `groundH/FLOOR_HEIGHT` of the tile; two copies would drift until the shopfront
  straddled the seam, which looks worse than the defect it replaces). A test greps the materializer
  and fails if a numeric `marginB` is ever hard-coded back in.
- **Done when:** ✅ **15 tests (65 total).** Wall vertex cost computed over the Barcelona height mix:
  **3.00 mean bands/face → worst tile 33,320 → ~99,960**, against the spec's ~100,000 estimate and a
  220,000 `GLOBAL_VERTEX_BUDGET` — **fits**. ⚠ **Mid-air shopfronts are NOT zero yet** — that is
  gated on P3-04, measured and explained above. P3's exit-gate metric "mid-air shopfronts: 0" must
  therefore be checked AFTER P3-04, not here.
- **Partially verified on screen 2026-08-25:** buildings render and the frame feels normal after the
  D-29 fix, so the 3× wall-vertex cost is **not** a perceptible regression. **Still unchecked:** the
  ground/body and body/crown seams ringing each face at constant height, the crown reading against
  the sky, the shopfront sitting at street level on a slope, courtyard (inner-ring) walls, and the
  REAL per-tile wall vertex count — ~99,960 remains computed from an assumed height mix, not measured.

### `[x]` P3-03 · 2.0d · risk medium
**Normalise building winding at source** → flip `BUILDING_SIDE` to `FrontSide`. Signed-area check per outer and inner ring, reverse when needed. Halves raster and shadow cost on the largest triangle population. **NOTE: flipping the flag alone was tried 2026-07-06 and reverted (`changelog.md:930`) — the fix must be in the worker,** with a debug pass colouring back-facing walls.

- **Files:** `buildingWorker.js:494-520,592-609`; `workerGeometry.js:36-125`; `meshMaterializer.js:558-562`
- **Depends:** nothing
- **Subsystem:** buildings
- **Full spec:** master plan §4 → P3
- **Progress (2026-08-25):** **cause fixed.** `signedAreaXZ` + `normalizeRingWinding` in
  `workerGeometry.js`; applied to outer footprints (CW), courtyard inner rings (**CCW — opposite on
  purpose**, a courtyard wall faces INTO the courtyard) and roof footprints. **9 tests (80 total)**,
  including a guard that an UN-normalised ring really does produce inward normals, so the fix cannot
  quietly become a no-op. Per-tile `[buildingWorker] winding normalised — N/M outer rings reversed`
  reports the scale — **the number the 2026-07-06 attempt never had.**
- **FLAG RESOLVED BY DRIVE, 2026-08-25 → `THREE.FrontSide`.** BackSide rendered buildings hollow
  (the far interior wall visible through the near one); FrontSide is correct. **This settles a
  contradiction standing since July:** the 2026-07-06 note reasoned from `worldGroup.scale.x = -1`
  that "exterior = BackSide", but it was written against INCONSISTENTLY WOUND geometry where neither
  side was right for every building — so it described a broken state, not the mirror's real effect.
  The task text was right and the changelog's inference was not, and **only a drive could separate
  them**, which is why the flag was made selectable rather than guessed. `?buildingside=back|double`
  survives as a one-reload escape hatch if a future geometry change breaks culling.
- **Done when:** ✅ **winding normalised at source + `BUILDING_SIDE = FrontSide` shipped**, verified
  on screen. ⚠ **The saving is EXPECTED, not MEASURED** — "halves raster and shadow cost on the
  largest triangle population" is the task's claim, and no before/after GPU number was captured.
  Bank it in the performance ledger only after a bench run, per the no-double-counting rule.

### `[x]` P3-04 · 4.0d · risk medium
**FACADE ARRAY-TEXTURE MATERIAL.** Delete `getWindowTexture` (`meshMaterializer.js:118-365`). `CompressedArrayTexture`: 8 × 1024² albedo + 8 × 1024² normal + 8 × 512² window mask. Per-vertex uint8 `aLayer`. Requires an `onBeforeCompile` chunk swap (`sampler2D` → `sampler2DArray`). **Array textures wrap per-layer natively, which our band UVs need — an atlas + `fract()` + `textureGrad` would seam.** Anisotropy from the registry (currently unset, default 1).

- **Files:** `meshMaterializer.js:118-365 (delete),596-670`; `buildingWorker.js`; new `map/facadeArray.js`
- **Depends:** modular bands; P1 pipeline
- **Subsystem:** buildings
- **Full spec:** master plan §4 → P3
- **Progress (2026-08-25): the UV SPEC is written and tested** — `map/facadeArray.js`, **11 tests
  (91 total)**. This is what **P3-05 is blocked on** ("Depends: array material UV spec"), so it
  unblocks the 6 days of authoring. Spec: body layer 8.0 × 8.0 m (2 storeys of 4.0) at 1024² = 128
  texels/m, tiling in BOTH axes; ground layer 8.0 × 4.0 m at 512², tiling in u only — its bottom edge
  is the pavement. Deterministic variant pick from a hashed OSM id (a building straddling two tiles
  is emitted by both; a random pick would seam it down the middle), spread verified across all five
  residential variants.
- ⚠ **A CONTRADICTION IN THE TASK, resolved.** It asks for 8 layers, "ground-floor module rect and
  body module rect on the same layer", AND rejects `fract()` seams. Those cannot all hold — two rects
  on one layer IS the atlas case it rejects, one level down, and the body band tiles v 0→N so it
  would cross the rect boundary every storey. Resolved by **splitting into two arrays** (body 8×1024²,
  ground 8×512²), which the task's own "per-vertex uint8 `aLayer`" already licenses: ground-band
  vertices index the ground array, body/crown vertices index the body array. 8 variants preserved,
  no `fract()`, no seams.
- ⚠ **THE SPLIT COSTS VRAM: measured 80.0 MiB vs the plan's 72.0 MiB uncompressed, and the split does
  not yet include a window mask (+~8 MiB).** So **+8 to +16 MiB**, bought to avoid per-storey seams.
  ~4:1 under KTX2/BC7. **Must be counted against the 200 MiB budget and not double-counted with
  P3-05's art budget.** If the overrun matters more than the seams, the lever is 4 ground layers
  instead of 8. (An earlier draft of the module comment claimed the split was CHEAPER — it is not.)
- **`aLayer` PLUMBING LANDED (2026-08-25)** — bands emit a per-vertex layer (ground band → ground
  array, body/crown → body array), `mergeBufferSets` carries it, group assembly forwards it,
  `materializeGroup` uploads it as `aLayer`. Verified end to end: three buildings, three different
  residential variants, deterministic from their OSM ids. **7 more tests (98 total).**
- ⚠ **Caught during wiring, and it is the D-29 pattern again:** bands emitted `layers` and the merge
  carried them, but **group assembly lists attributes by hand in an object literal and simply did not
  mention them** — so the attribute reached the GPU as nothing while both halves' unit tests passed.
  Now covered by an end-to-end test. **Any new per-vertex attribute must be added in FOUR places**
  (emit → merge detect/allocate/copy → group literal → `materializeGroup`); miss the third and it
  fails silently.
- **SHADER PATH BUILT (2026-08-25), behind `?facadearray=1`.** `DataArrayTexture` body + ground
  arrays with placeholder layers, the `onBeforeCompile` swap to `sampler2DArray`, and
  `windowOnlyTile` coupled to the same flag. **103 tests.**
- **`sampler2DArray` needs NO GLSL3 opt-in here** — three r183 always emits `#version 300 es`
  (`WebGLProgram` versionString) with `#define texture2D texture` compatibility, so an array sampler
  is in scope inside `onBeforeCompile` on a stock `MeshLambertMaterial`. ⚠ On an older three that
  emitted GLSL1 this would fail to COMPILE; if the dependency is downgraded this breaks first.
- **One float addresses two arrays:** body/crown carry `idx`, ground carries `idx + GROUND_LAYER_BASE`
  (16, leaving headroom to 16 body variants). A test asserts the GLSL threshold is *derived from* the
  JS constant rather than hard-coded, because a drift there is invisible in JS and shows only as
  shopfronts sampling the body array.
- ⚠ **THE WORKER CANNOT READ THE PAGE URL.** A Web Worker has a `location`, but it is the worker
  SCRIPT's URL, so `location.search` there silently returns nothing — the material would sample the
  arrays while the geometry still carried legacy UVs, painting windows where the shopfront belongs.
  The flag therefore lives on **`CONFIG.FACADE_ARRAY`**, which is already sent to the worker per tile.
  Verified both sides move together: body band v0 is 0.38 with the flag off and 0.00 with it on.
- **Default is OFF and should stay off until P3-05.** The placeholder layers are deliberately plain
  (flat plaster, window rows, no weathering or normals) — they exist to prove the shader path BEFORE
  six days of art is committed to a UV spec nobody has rendered. Switching them on by default would
  make the city look **worse** than today's canvas facade while claiming progress.
- ⚠ **Winding data, richer set (P3-03's counter across ~15 tiles):** **50.0%** (46/92, and 2 inner
  rings), 37.5%, 25.4%, 22.2%, 20.8%, 12.2%, 11.6%, 9.0%, 5.6%, 5.2%, 4.4%, 4.0%, 2.5%, 1.8%, 1.6%.
  Half a tile inside-out at worst. Inner rings DO occasionally need reversing (2 and 1 seen), which
  is the courtyard case the opposite-handedness rule exists for.
- ⚠ **First drive FAILED — see D-30.** The patch used `vMapUv`, undeclared on the glass path's
  `MeshPhongMaterial`; every wall vanished. Fixed by carrying an own `vFacadeUv` varying from the
  stock `uv` attribute. **4 more tests assert the generated GLSL touches no map-conditional varying
  (107 total).** Needs a re-drive.
- **Winding data from that drive (P3-03's counter, working as intended):** per-tile reversal rates of
  **37.5% (15/40)**, 4.4% (6/136) and 1.6% (5/306) — so inconsistent winding was REAL and highly
  tile-dependent, which is why the 2026-07-06 flag flip failed on some buildings and not others.
  0 inner rings reversed in those tiles.
- **Done when:** ✅ **MID-AIR SHOPFRONTS = 0, verified on screen 2026-08-25** (`?facadearray=1`).
  That is P3's gate metric, handed forward from P3-02 and now measured rather than argued. The array
  path renders on both facade material types with no shader errors and complete textures.
- **Remaining (belongs to P3-05, not here):** delete `getWindowTexture` and flip the default — both
  only once real layers exist. The placeholders look plainer than the canvas facade by design, so the
  flag stays opt-in until then.
- **Done when:** _(mid-air shopfronts = 0, measured; texel density in the 85–150 band; VRAM banked once)_

### `[x]` P3-05 · 6.0d · risk medium — **DONE 2026-08-26 · 8 BODY + 8 GROUND LAYERS, KTX2, WIRED**
**Author the 8 facade layers** to the band UV spec at **128 texels/m** (`1024² over 8.0 m × 8.0 m = 2 storeys of 4.0 m`): 5 residential variants + 1 commercial + 1 office/institutional + 1 industrial-brick. Albedo (weathering baked in), normal, window mask. Ground-floor module rect and body module rect on the same layer.

- **Files:** new `frontend/public/art/v1/facades/*.ktx2`
- **Depends:** array material UV spec
- **Subsystem:** buildings
- **Full spec:** master plan §4 → P3
- **Done when:** _(fill in on completion — measured number, not 'looks fine')_

### `[x]` P3-06 · 1.5d · risk low
**Real roof UVs + roof material — the best ratio in the entire programme.** Replace the zero-fill in `ensureUvs` (`buildingWorker.js:657-661`) with `planarRoofUvs`: `uv = (worldX / TILE_M, worldZ / TILE_M)`. World-space projection tiles continuously across the merged per-tile roof mesh with no seam, no unwrap. Then add `map` + `normalMap` to `getRoofMaterial` — because `getRoofMaterialKey()` is a literal constant, **1.5 days dresses every roof in Barcelona from one 2K 3-cell atlas** (Catalan clay pantile / gravel-bitumen terrat / poured concrete), with the peach/terracotta palette staying in the vertex-colour…

- **Files:** `buildingWorker.js:657-661,592-624,365-378,1137-1152`; `meshMaterializer.js:678-690,585-587`
- **Depends:** P1 pipeline
- **Subsystem:** buildings-detail
- **Full spec:** master plan §4 → P3
- **Done when:** ✅ **`planarRoofUvs` replaces the zero-fill** (`uv = worldXZ / ROOF_REPEAT_M`, 4.0 m).
  Verified: a 12 m roof at world x=100 spans u 25.007 → 27.993, and two adjacent roofs CONTINUE each
  other's projection rather than each resetting to 0. **10 tests (116 total.)** Deliberately world-
  planar, not per-building 0→1 — the latter scales the texture with the roof, so a 6 m shed and a
  60 m block show the same tile count and the pattern encodes building SIZE instead of material.
- **Roof surfaces are a 3-layer ARRAY, not the specced 3-cell atlas.** An atlas cannot work with
  world-planar UVs: they run to 25, 50, 300 across the city, so addressing a sub-rect needs `fract()`,
  whose discontinuity seams every cell boundary — the trap P3-04 already documents. A 3-layer array
  wraps per layer natively at the same memory, and **reuses P3-04's per-vertex `aLayer` channel**
  rather than adding a second mechanism.
- ⚠ **A distribution bug the tests caught.** Roof kind used `Math.abs(h) % 3 === 0` for pantile,
  which *reads* as one-in-three but measured **169/300 (56%)** — xorshift's low bits are not uniform
  mod 3, so the city came out mostly pitched tile when Barcelona is mostly flat `terrat`. Now takes
  high bits as a percentage: **~23% pantile**, rest terrat. The test asserts a SHAPE (terrat > 2×
  pantile, pantile > 20) rather than a range, which is why it failed instead of passing quietly.
- ⚠ Placeholder layers, near-neutral per **D-31** — roof colour is the peach/terracotta palette in the
  VERTEX COLOUR against a white material, so a tinted layer would drive dark roofs to black.
  Rides the same `?facadearray=1` flag: shipping half a look is worse than shipping neither.

### `[x]` P3-07 · 3.0d · risk medium
**ASPHALT SHADER v2 — the core road rebuild.** Extend `patchRoadAO` into a proper road material: (a) world-metric UV from the already-baked `halfWidth` — `vAcross = (uv.y-0.5)*2.0*halfWidth`, `vAlong = uv.x*4.0`, **no re-bake**; (b) tiling albedo + normal at 4 m; (c) a second detail-normal sample at 8× frequency killing the close-range repeat; (d) macro wear from world-XZ noise **per-fragment** at ~40 m (replaces the per-vertex `roadNoise`, zero VRAM, strictly better); (e) **analytic wheel ruts** — two subtly polished bands per lane derived from `halfWidth`, ~10 ALU, zero VRAM, the single most recognisable "real…

- **Files:** `roadRenderer.js:283-315,4593-4660`; new `map/roadMaterial.js`
- **Depends:** P1 pipeline; **SMAA**
- **Subsystem:** road
- **Full spec:** master plan §4 → P3
- **Progress (2026-08-25) — (a), (d), (e) SHIPPED, all analytic: zero VRAM, no re-bake, no art.**
  `map/roadMaterial.js` + **8 tests (124 total)**.
  - **(a) world-metric UV** rides the per-vertex `halfWidth` the ribbon ALREADY carries
    (`buildFlatRibbonGeometry`, used until now only for the edge fade). `across = (uv.y-0.5)*2*halfWidth`,
    `along = uv.x*4`. A 3.5 m lane is now 3.5 m on a service street and on a trunk road — under the old
    width-relative UV those disagreed.
  - **(d) macro wear** per-fragment at ~40 m, centred on zero so it darkens AND lightens (a one-sided
    term would shift the whole city's asphalt tone rather than add variation).
  - **(e) wheel ruts** — two polished bands ~0.9 m either side of each lane centre, i.e. a real car
    track width, repeating per lane and **fading out above 8 m half-width** where the lane model stops
    being true (junction fans, plazas — ruts there read as sprayed stripes).
  - Modulates the vertex-colour asphalt rather than replacing it, per **D-31**; declares its own
    varyings rather than `vMapUv`, per **D-30**.
- ⚠ **(b) tiling albedo and (c) the 8× detail normal are NOT done — they need authored art** and were
  deliberately not faked with hash noise, which shimmers under motion and aliases at grazing angles,
  which is exactly where road fills the screen. Grain is still missing; wear and ruts are not grain.
- ✅ **A/B CONFIRMS THE FIX, 2026-08-26.** Before the bake, `?roadv2=0` was noticeably faster than
  default. After it, the two are **indistinguishable** — so asphalt v2 now costs approximately
  nothing, and the remaining frame lag is NOT the road. The attribution switch paid for itself: it
  turned "the site feels heavy" into a bounded answer instead of a third round of guessing.
- **2026-08-26 — (b) LANDED as a BAKED texture; (d) DELETED.** The procedural wear measurably lost to
  `?roadv2=0`, so it is gone rather than tuned. `createAsphaltTexture` bakes the grain ONCE at boot
  (512², deterministic LCG, wrapping bilinear so it tiles seamlessly) and the shader takes **one
  texture fetch** through the world-metric UV.
  - **cost:** ~40 ALU + no filtering → **1 TMU fetch (parallel to ALU) + ~8 ALU for ruts + a mip
    chain**. 1.0 MiB against a 200 MiB budget.
  - **The mip chain is the half that ALU could never buy** — procedural noise has no prefiltering, so
    it crawls at the grazing angles road is actually viewed at.
  - Texture is **neutral, centred on 1.0** per D-31 (road colour is the vertex colour), asserted by a
    test that measures the generated texture's mean.
  - **The per-vertex `roadNoise` fine-grain term is also deleted** — that was the double application.
    Its LOW-frequency terms stay: broad patches and splotches are variation a 4 m tile cannot carry.
  - Authored KTX2 (P3-07b) is now a **file swap, not a rewrite** — the sampling path is identical.
- ⚠ **(c) the 8× detail normal is still NOT done.** Normal mapping needs tangents and a different
  injection point, and `patchRoadAO` is shared with Lambert materials — exactly the D-32 trap. It
  wants its own careful pass rather than being bolted on here.
- ⚠ **PER-FRAGMENT COST IS NOT FREE, and this was felt.** The first version used the textbook
  `fract(sin(dot(...)))` hash, which `roadNoise2` calls **four times per fragment** — four
  transcendentals plus a `pow`, on the surface with the largest screen coverage in the game, on a
  `MeshStandardMaterial` that is already the expensive path. The plan's "zero VRAM, strictly better"
  is true about MEMORY and says nothing about ALU. Replaced with a multiply/fract hash and `x*x`:
  the fragment path now holds **one** `exp` and no `sin`/`cos`/`pow`, guarded by a test that strips
  comments before checking. **`?roadv2=0` added as an attribution switch** so this is measured rather
  than argued next time.
- ~~⚠ The per-vertex `roadNoise` was NOT removed~~ — **STALE, resolved 2026-08-26 by reading the
  code, not by trusting the newer note.** `roadRenderer.js:349-356` carries the comment "the
  fine-grain term is GONE" and only the LOW-frequency terms survive (`n1` broad patches, `n3`
  splotches). Wear is applied ONCE. Two notes in this entry contradicted each other for a day; the
  source was the tie-breaker.
- **CLOSED 2026-08-26.** (a) (b) (d) (e) all shipped and A/B-measured; the `roadNoise` double-apply
  was stale, not outstanding. **(c) is carved out as P3-07c** rather than held open here — the entry
  itself argued it needs tangents, a different injection point, and a material that is not shared
  with Lambert, which is a different piece of work, not a loose end of this one. A task left `[~]`
  for one deferral stops being a status.
  ⚠ **One visual sign-off is still owed: judge the wheel ruts at street level.** They are analytic and
  fade above 8 m half-width; if they read as sprayed stripes anywhere, reopen this.

### `[x]` P3-07c · 1.5d · risk medium — **DONE 2026-08-26 · ROAD DETAIL NORMAL (the 8× term)**
**The close-range repeat killer.** A second normal sample at 8× the base frequency, breaking up the
4 m tile where the road fills the screen. Split out of P3-07 on 2026-08-26 because it is not a
loose end of that task — it needs its own decisions:
- **Normal mapping needs TANGENTS**, which the ribbon geometry does not currently carry.
- **It needs a different injection point.** `patchRoadAO` is shared with Lambert materials, so
  bolting a normal-map path into it is exactly the **D-32** trap.
- **Depends:** P3-08 (the asset set supplies the detail normal) — so this cannot land before the art.
- **Files:** `map/roadMaterial.js`; `roadRenderer.js` (tangent generation)
- **Done when:** ✅ **CODE DONE 2026-08-26, visual sign-off owed.** Two normal samples (base + 8×),
  whiteout-blended, faded out 8→25 m. **`window._ddRoadDetail(0)`** is the A/B — that is the "before"
  picture, so the done-when can be judged directly rather than remembered.
  - Its three stated blockers resolved differently than expected: **tangents were not needed** (a
    frame from screen-space derivatives of view position against the road's metric UV is what three
    itself falls back to without `USE_TANGENT`); the **separate injection point is real and was the
    crux** — three orders `<normal_fragment_begin>` AFTER `<color_fragment>`, so the tone block
    cannot touch `normal` at all; and **D-32 does not apply** — every lit material declares a normal,
    unlike roughness, so the term is safe in the shared patch.
  - Repeat is now **2 m**, not 4 (P3-08 measured the span), which makes the 8× term matter more: a
    stationary car sees the same stones twice inside its own length.

### `[x]` P3-07b · 2.0d · risk low — **DONE 2026-08-26 · AUTHORED ROAD TEXTURES**
**Decided 2026-08-26 on measurement: textures are BOTH cheaper and better-looking than procedural
noise here.** `?roadv2=0` measurably outperformed `?roadv2=1` on the user's machine, which settled it.

| | procedural wear (current) | authored texture |
|---|---|---|
| per-fragment cost | **~40 ALU ops** (4× hash + mixes + smoothstep + exp) | **1 TMU fetch**, runs in PARALLEL with ALU |
| filtering at distance | **none — aliases and shimmers** at grazing angles, which is exactly how road is viewed | mip chain, correct by construction |
| VRAM | 0 | ~2 MiB for asphalt albedo+normal, ~8 MiB for 4 road types (KTX2/BC7) |
| against the 200 MiB budget | — | **negligible** |

The plan's "zero VRAM, strictly better" for (d) is true about MEMORY and silent about ALU, and ALU is
what a full-screen surface on a `MeshStandardMaterial` actually spends. Roads have the largest screen
coverage in the game; a texture fetch is the cheap way to spend it.

**KEEP the analytic parts — they are not what cost:**
- **(a) world-metric UV is the PREREQUISITE, not wasted work.** Texturing needs `across`/`along` in
  real metres or the tiling scale changes with every road's width. It already ships.
- **(e) wheel ruts stay analytic.** They are LANE-RELATIVE, derived from `halfWidth` — a tiling
  texture cannot know where the lane centre is, so this cannot be baked. ~8 ops and it is the single
  most recognisable real-road cue.
- **(d) macro wear is what a texture replaces.** Authored albedo carries its own variation, mip-filtered.

**Then per-road-type textures + blending (the user's proposal, 2026-08-26):**
- Different surface per `highwayType` is cheap and the machinery EXISTS — per-vertex `aLayer` from
  P3-04, layers wrapping independently, no `fract()` seams. Motorway / primary / residential / service
  as four layers.
- **Along-road blending between types comes nearly free**: `aLayer` is per-vertex, so a blend weight
  ramped across a few metres of ribbon crossfades two layers where a primary becomes a secondary.
- ⚠ **JUNCTION blending is a SEPARATE, much larger task and must not be smuggled in here.** Different
  ribbons are different meshes with no shared vertices to blend across, and the junction fan is its
  own geometry. That is where road systems usually look worst; cost it on its own.

⚠ **BLOCKED ON THE SAME DECISION AS P3-05 (D-31): who owns colour.** Roads are vertex-coloured like
buildings, so authored road albedo collides the same way — either the art owns colour and the vertex
tint is neutralised, or the art stays neutral and modulates. **Decide once, for facades AND roads,
before anything is painted.**

- **Files:** `map/roadMaterial.js`, `map/roadRenderer.js`, new `frontend/public/art/v1/roads/*.ktx2`
- **Depends:** P3-07 (a) ✅ shipped; the D-31 colour-ownership decision
- **Subsystem:** road
- **Done when:** _(road frame cost at or below `?roadv2=0`, measured — plus no shimmer at grazing angles)_

### `[x]` P3-08 · 2.5d · risk medium — **DONE 2026-08-26 · asphalt + panot authored and wired; kerb landed as P3-09; detail normal as P3-07c**
**Road asset set** — `asphalt_worn_1k` (ambientCG CC0, normalized), `asphalt_detail_512` (normal only, AI tiling or high-pass), `panot_1k` (baked offline from the existing `makePanotCanvas` generator upgraded 256→1024 under node-canvas, Sobel normal, **AD-12 20×20 grid over 4.0 m**, and the AD-4 v-flip fix at `roadRenderer.js:1690-1694` lands with it), `concrete_kerb_512`. Ship `.ktx2`, keep the generator as the authoring tool.

- **Files:** `frontend/public/art/v1/road/*`, `map/generate-road-atlas.js:14-71`
- **Depends:** build-art.mjs
- **Subsystem:** road
- **Full spec:** master plan §4 → P3
- **Done when:** _(fill in on completion — measured number, not 'looks fine')_

### `[x]` P3-09 · 0.75d · risk low — **DONE 2026-08-26**
**Kerb material** — tiling granite/concrete albedo + normal at 512² with a chamfer highlight baked into the top edge. **The kerb is the silhouette element that reads at 200 m and is currently flat `0x5a5a5a`.** Also resolve the `ENABLE_CURBS` lie: the baked path bypasses the flag on all 409 v9 tiles.

- **Files:** `roadRenderer.js:219-228,1758-1774,1777`; `config.js:187`
- **Depends:** road asset set
- **Subsystem:** road
- **Full spec:** master plan §4 → P3
- **Done when:** ✅ **DONE 2026-08-26.** Tiling granite albedo + normal at 512² (`tools/build-kerb-texture.py`),
  PROCEDURAL rather than AI — granite is millimetre-scale speckle with no large features, which noise
  does well and image models do badly, and periodic sin/cos octaves make STEP 1 exact rather than
  repaired. Gates: **tile 1.00**, **ΔE2000 5.48** vs P7 Bordillo Granite, **|N.xy| 0.470 → 0.250**
  (masonry band 0.18–0.32). UVs derived from WORLD POSITION in the vertex shader — the baked v8/v9
  curb blobs have no `uv` attribute, so this ships without a re-bake. Chamfer read as a value break
  between top face and road-facing face. MeshStandard → MeshLambert.
  - **`ENABLE_CURBS` lie resolved:** only `buildCurbs()` checked the flag; `buildBakedSidewalkMeshes()`
    rendered kerbs on all 409 v9 tiles regardless. Both paths now gate on it, and it reads `true`,
    which is what was actually happening.

### `[x]` P3-10 · 3.5d · risk medium — **DONE (partial: tiers 1-2 of the classifier blocked on P1 species pipe)**
**Vegetation, data-only wave — no re-bake, no art, no KTX2.** (a) **Species-by-context classifier** replacing the species-blind `bakedVariantIndices[i] % 4`: three-tier — OSM tagged tree within 4 m → its species; else per-tile species histogram from that tile's own tagged trees; else context (inside a greens polygon → park set, adjacent to coast/beach → palm, road class primary/secondary → avenue set). **Species coverage is 13.8%, so graceful degradation is the whole design.** (b) **Roadside decimation** 2–5 m baked stride → ~7 m (fixes density realism and ~35–40% of the tree count). (c) **Billboard collapse**:…

- **Files:** `vegetationWorker.js:1940-1975,1348-1400,679-720,128-129`; `vegetationRenderer.js:875-877,899-957`; `meshMaterializer.js:1068-1073`; `tileManager.js:2971-2975`; `config.js`
- **Depends:** P1 species pipe; staticPools
- **Subsystem:** vegetation
- **Full spec:** master plan §4 → P3
- **Done when:** ✅ **DONE 2026-08-26.** Cards ON by default (`?treecards=0` reverts). Measured:
  **tree geometry 80 tris → 4** (trunk cylinder + 2-3 icosahedron lobes → 2 crossed quads);
  **impostor materials + pool sets 4+4 → 1+1**; **roadside stride 2-5 m → 6-8 m** (~35-40% fewer
  tree instances); **`bbEnd` clamped 470 m → `FOG_FULL_DIST` 280 m**, closing the band where
  impostors could never reach full count. Six species normalized through art-bible §4.4
  (`tools/artNormalize.py`): **|N.xy| 0.53 → 0.275** (foliage band 0.20-0.35, was ~2× out),
  **C\* tipuana 37.9 → 20.5, jacaranda 55.8 → 20.5**. 164 tests pass (was 151).
  - **NOT done:** classifier tiers 1-2 (OSM species / per-tile histogram) — the bake extracts
    `species` but it stops at the tile format. Blocked on the P1 species pipe. Tier 3 (context)
    ships alone by design; coverage was only 13.8% anyway.
  - **Open gates:** jacaranda ΔE2000 **17.01** vs the ≤15 gate-4 threshold (bible's own note calls
    it tunable to 18 — not silently widened); washingtonia **8.3%** rally-saturation clip.
  - **Full write-up:** `docs/context/tree-cards.md`

### `[x]` P3-11 · 1.5d · risk medium — **DONE 2026-08-26 · SKY DOME, 2 KEYS**
**Sky dome texture — 2 keys.** 2048×1024 equirect ETC1S per key (day/night), **2.67 MiB total**, cross-faded by the normalized sun-elevation scalar, with the existing analytic gradient retained underneath as the fallback tint and carrying dawn/dusk. Sourced by cropping **CC0 Poly Haven sky HDRIs** — real photographic cloud structure, and the same source the cloud atlas already prefers. **Un-hides the night sky** (`envToggle.js:63-64` `skyVisible:false` + flat `bgColor 0x0a1224`) and unblocks NIGHT-10 / BLK-9.

- **Files:** `scene.js:552-598`; `envToggle.js:63-64,134-144`
- **Depends:** P1 pipeline
- **Subsystem:** sky
- **Full spec:** master plan §4 → P3
- **Done when:** ✅ **DONE 2026-08-26.** 2048×1024 equirect **cloud layers** (day + night keys,
  **1.51 MiB total** vs the 2.67 MiB budget), cross-faded by the env transition lerp, compositing
  **over** the analytic gradient — which stays the authority on the colour of the air, so dawn/dusk
  keeps working through a texture that knows nothing about it. **Night sky un-hidden**
  (`skyVisible:false` + flat `bgColor 0x0a1224` → `true` + `null`), which needed a NIGHT KEY for the
  gradient (`NIGHT_SKY_*`) because the dome carried day colours only — that is *why* it was hidden.
  - **Sourced procedurally, not from Poly Haven.** For equirect this is the stronger tool, not a
    fallback: the projection has to be exact at the seam and at the poles, and generating it means
    computing the projection rather than hoping. Measured seam **0.00018** (0 = exact).
  - Clouds sit on a **flat deck at 1200 m** and each texel's ray is intersected with it, so horizon
    compression is correct for free. Sampling noise in equirect UV instead is the classic mistake
    and smears at the poles.
  - **`sky.renderOrder = -2`** is what makes un-hiding possible at all: stars are renderOrder −1 with
    `depthWrite:false`, so an opaque dome at the default 0 paints straight over them.

## P4 — THE COMPLETION WAVE · 51 days · 18 tasks
**Goal.** The domains that P3 deferred: the street furniture and signage that make a city read as inhabited, the vehicles that stop it reading as a toy, the ground under the whole thing, and progression.

**Progress:** 3 / 19 — P4-01 ✅ · P4-02 ✅ · P4-15a ✅  ·  (P4-15 split into 15a engineering / 15b art on 08-27)

> **Vegetation bug-fix run, 2026-08-27** (numbered VEG-FIX-* deliberately — NOT P4-02b/c, which is a
> real scheduled task riding the v10 bake). Three separate bugs, all surfaced by P4-02 finally making
> the distance visible:
> - **VEG-FIX-1** — the impostor ramp FOLLOWED the 3D fade instead of complementing it, leaving a hole
>   across 80–170 m and a 100%→1% cliff at 170 m.
> - **VEG-FIX-2** — hills were bare: OSM tags a wooded hill and a plaza garden both `leisure=park`, and
>   the baker used one tree / 500 m² for both. Density now scales on log(area). Hilly tiles 0 → 1,077
>   trees median.
> - **VEG-FIX-3 (the actual reported bug)** — an LOD **timing** fault, not a distance one. The LOD
>   invalidation fires at tile-entry creation; vegetation lands many awaits later with
>   `startVisible = true`, so a tile drew EVERY tree at full density until the viewer moved 15 m.
>   Driving fast kept the LOD running, so the correct density looked like the bug and the lush
>   version looked right. Re-invalidate after vegetation lands.
>
> Two probes were added and are worth keeping: `_ddVegCount()` (allocated vs **DRAWN** — `instanceCount`
> is allocation, not visibility) and `_ddVegLod()` (per-tile band + fractions + visible/total per kind).
> The aggregate alone could never say *which* tile was bare, and that cost two wrong diagnoses.

<details><summary><b>Exit gate — the phase is NOT done until these pass</b></summary>

- Same four caps as P3, re-measured, plus: draws ≤ 450 with all furniture, signage, vehicles and terrain live.
- Vehicle triangle population 1.08 M → ≤ 300k.
- Zero remaining palette-UV meshes in the shipped world (AD-1b).
- The dynamic text page holds ≥128 cells and **never grows**; a 10-minute drive shows zero texture-cache growth.
- The v10 re-bake happens **exactly once** — and it carries EVERY pending bake-side change with it.
  Currently queued for that window: **P4-01** (terrain bake deletion), **P4-02b** (buildings vs trench
  corridors), **P4-03** (sea sink, water clip, splat weights). Anything else discovered before P4 that
  needs a re-bake gets a task number and joins this list rather than triggering its own bake.

</details>


### `[x]` P4-01 · 3.0d · **DONE 2026-08-27 — re-baked, drive-confirmed on Montjuïc**

> **STEP 1-2 DONE 2026-08-27 — the "prove" half of prove-then-delete. Harnesses:
> `backend/tools/terrainBakeCensus.mjs` and `backend/tools/terrainRegenProof.mjs` (read-only).**
>
> | claim | measured |
> |---|---|
> | payload saving | **384.6 MB, 68.4%** of the 562.2 MB tile store (planning said 369 MB — confirmed and beaten) |
> | grid that stays | **55.5 MB** |
> | regenerates bit-equal | **442 / 444 tiles**, every float and index, using the real baker on each tile's own stored grid |
> | Uint16 indices | **feasible** — max vertex index across all 444 tiles is **16 383**, max 16 384 verts/tile. Indices are 163.4 MB as Uint32 |
>
> **The cross-tile dependency the spec feared does not exist.** `bakeTerrainMesh` takes
> `(elevation, tunnelRoads, waterPolygons, approachRoads, crossTileApproaches)` and a per-tile parser
> worker cannot see its neighbours — but `buildRegion.js:1571` calls it as
> `bakeTerrainMesh(payload.elevation, [], null, [], null)`. Every tunnel/water/approach input is
> EMPTY, because the legacy tunnel carve was disabled when the authored trench moved into the
> elevation grid (slice ②). In current practice the baker is a **pure function of the grid**.
>
> **The 2 divergent tiles are STALE, not unreproducible.** `16/33154/24485` and one other carry
> `bakedTerrain.gridSize 64` against `elevation.gridRows 128` — baked before GRID_SIZE moved to 128.
> They already FAIL the `useBaked` gate (`gridSize === maxGrid`, and `TERRAIN_MAX_GRID` is 128), so
> **they take the runtime fallback in production today**: the regeneration path is already live and
> already correct. Regenerating would FIX them; they render at quarter terrain detail right now.
>
> ⚠ **The spec's "4 known NaN-normal sea tiles" no longer exist** — 0 of 444 tiles carry a NaN
> normal. That clause is stale; do not go looking for them.
>
> **Done when:** ✅ **Tile store 567 MB → 177 MB (−69%).** Terrain generated in `tileParserWorker`
> from the grid (`map/terrainGrid.js`, Uint16 indices, measured **1.0 ms p50 / 1.8 ms p95 per tile**,
> in the worker not the frame). The runtime fallback mesh and its water dip deleted together.
> `bakedPhysicsTerrain` dropped too — 15.0 MB, zero consumers since P0-12. Re-baked in 489.7 s and
> confirmed on a Montjuïc drive (167 m relief, sea-to-summit). 12 orphan tiles outside the bbox keep
> their old sections and are ignored at runtime — see changelog for the Collserola bbox tension.


**TERRAIN: prove-then-delete the terrain bake.** Harness regenerating positions/uvs/indices from the elevation grid, bit-equal against `bakedTerrain` on 20 sampled tiles **including the 4 known NaN-normal sea tiles and 2 trench-carved tiles**. Only then move generation into the parser worker (Uint16 indices, computed smooth normals) and repoint `getElevationAt` at the grid. **Delete the second runtime water dip (`terrainRenderer.js:225-260`) in the SAME commit or it double-applies.** −369 MB of tile payload.

- **Files:** `tileParserWorker.js`, `terrainRenderer.js:140-330,905-985`, `terrainBaker.js`, `buildRegion.js:1571-1574`
- **Depends:** P0 measure
- **Subsystem:** terrain
- **Full spec:** master plan §4 → P4
- **Done when:** _(fill in on completion — measured number, not 'looks fine')_

### `[x]` P4-02 · 2.0d · **DONE 2026-08-27 — drive-verified**
**TERRAIN: LOD index rings** — from one vertex buffer emit three index sets (full 32,258 / 1:2 7,938 / 1:4 1,922), swap by distance with hysteresis, and **raise the terrain visibility cut from 280 m to ~1500 m at the coarse ring so the game finally has a distant landform silhouette.** LOD must never engage inside 500 m where roads drape on the full grid.

- **Files:** `tileParserWorker.js`, `tileManager.js:2908-2932`, `terrainRenderer.js`
- **Depends:** bake deletion
- **Subsystem:** terrain
- **Full spec:** master plan §4 → P4
- **Done when:** ✅ Three index rings over ONE vertex buffer — **32,258 / 7,938 / 1,922 triangles**,
  exactly the planned counts, verified against a real tile. Swapping ring is a `setIndex`, so no
  vertex re-upload and no extra draw call. **Terrain removed from the blanket fog cull**: it was
  hidden at `FOG_FULL_DIST` 280 m, which at the shipping FogExp2 density of **0.0025 is only 38.7%
  fogged** — ground was being deleted while still ~61% visible, and that is why the city had no
  distant landform. Cut is now 1500 m; FULL below 500 m (hard floor — roads drape on the full grid),
  1:2 to 900 m, 1:4 beyond. 60 m asymmetric hysteresis band. 5 tests in `test/terrainLod.test.js`.

### `[ ]` P4-02b · 1.0d · risk medium · ⚠ **RE-BAKE — RIDES THE v10 WINDOW (P4-03)**
**Buildings must be tested against the trench corridors.** `trenchCorridors` (`buildRegion.js:1099`)
has three consumers — `flagTrenchCrossings`, `flagFloatersOverCarve`, `carveTrenchesIntoGrid` — all
roads or terrain. **No building path consults it.** So the bake carves the ground out from under a
building while emitting that building at its original footprint and base height, and it is left
sliced open and floating over the cut. Confirmed by drone inspection at Túnel Glòries, 2026-08-25.

Test building footprints against the corridor polygons and drop — or set back — intersectors. The
polygons already exist at that point in the pipeline, so this is a FILTER, not new geometry.

⚠ **Scope it to the trench footprint.** `flagFloatersOverCarve`'s inverse clause found **14,037**
floating samples of which only **32** were trench-caused — the rest sit over NATIVE terrain and water
dips, a pre-existing class. A check written too broadly will delete buildings over natural ground.

⚠ **Do NOT confuse this with the missing tunnel roof**, which is Option L working as designed and is
already owned by Phase 4 of the terrain rework. Different problem, different fix.

- **Files:** `buildRegion.js` (building emit path), `pbfBuildings.js` / `buildingNormalize.js`, trench corridor polygons
- **Depends:** nothing — but MUST land inside the v10 window so it costs no extra re-bake
- **Subsystem:** terrain (owner), buildings
- **Full spec:** finding in `terrain-tunnel-rework-plan.md`
- **Done when:** a drone pass over Túnel Glòries and Ronda Litoral shows no building overhanging or
  sliced by a trench; the bake logs how many buildings were dropped; the count is **not** in the
  thousands (that would mean the footprint scope leaked into natural dips).

### `[ ]` P4-03 · 6.5d · risk high · ⚠ **RE-BAKE**
**BAKE (v10) — ONE window, all domains.** (a) **Sea sink**, owned by terrain, implementing **water's profile** (−1.0 m at the waterline ramping to −8.0 m over ~200 m offshore) **and water's commit-blocking validator** (no sea cell above −0.5 m, no road-bearing cell below 0). Fixes the measured 2.05–5.78 m bumpy blue plateau. (b) **Clip `water[]` to the tile** — 280 of 426 tiles carry a byte-identical 254-feature set, 13.08 MB wasted. (c) **Per-vertex splat weights** (Uint8 ×4 = 4 B/vertex) from OSM landuse + slope + elevation + distance-to-coast, replacing the Float32 colour (192 KB) + `aCoast` (64 KB) — **the…

- **Files:** `buildRegion.js:1178-1249,1194`, `demLoader.js`, new `terrain/seaMask.js`, new `splatBaker.js`, `roadBaker.js:400-504,555-608`, `convertToBinary.js:642-676`, `waterNormalize.js`, `mapLoader.js` + `tileParserWorker.js` TILE_VERSION
- **Depends:** nothing
- **Subsystem:** terrain (owner), water, road
- **Full spec:** master plan §4 → P4
- **Done when:** _(fill in on completion — measured number, not 'looks fine')_

### `[ ]` P4-04 · 4.0d · risk high
**THE SPLAT SHADER — the core terrain move.** 4-layer 1K albedo + 4-layer 1K normal as `DataArrayTexture`s; height-blend the two dominant weights (**4 fetches, not 8**); one 512 R8 macro-breakup layer; keep the existing `aAO` multiply and `uAoScale` **verbatim**. **DELETE the CPU colour pass (`terrainRenderer.js:557-763`) and the 5-layer procedural FBM (`:836-897`)** — the FBM overrides the CPU vertex colours at 75% and is tuned as one closed system; a splat bolted on top loses to it by construction. **Parks fold in as a weight channel** (greensRenderer deleted). Register in a shared registry and set…

- **Files:** `terrainRenderer.js:557-902`, new `map/terrainMaterials.js`, `tileManager.js:2868-2872`
- **Depends:** splat bake; P1 pipeline
- **Subsystem:** terrain
- **Full spec:** master plan §4 → P4
- **Done when:** _(fill in on completion — measured number, not 'looks fine')_

### `[ ]` P4-05 · 5.0d · risk medium
**WATER.** Extract `map/waterMath.js` (`polygonArea`, `pointInWaterPolygon`, `WATER_DEPTH`, `SEA_LEVEL`) so `terrainRenderer.js:11`, `railwayRenderer.js:9`, `roadRenderer.js:23` keep compiling; **DELETE `waterRenderer.js`**; new `map/waterSurface.js` reading closed water bodies from `tileData.water[]` (**not** `tileData.marinas` — populated in only 8/426 tiles) at a single global sea-level Y; new `shaders/waterChunk.glsl.js` — two scrolling normal layers (swell ~40 m, chop ~6 m, opposite drift), world-space perturbation (no TBN on a flat surface), Schlick fresnel into the existing sky palette, Blinn glint…

- **Files:** new `waterMath.js`, `waterSurface.js`, `shaders/waterChunk.glsl.js`; delete `waterRenderer.js`; `terrainRenderer.js:766,791-800,805-900`; `config.js:163`
- **Depends:** sea sink
- **Subsystem:** water
- **Full spec:** master plan §4 → P4
- **Done when:** _(fill in on completion — measured number, not 'looks fine')_

### `[ ]` P4-06 · 3.0d · risk medium
**WET ROADS — one owner, joint item.** `uWet` uniform in the road material: roughness 0.9 → 0.25, albedo ×0.72, procedural world-space FBM puddle mask **biased toward the camber gutters using the existing `uv.y` + `halfWidth`**, ripple normal fetch inside the mask only. Promote the `carModel` PMREM to `scene.environment` (sky owns the object, size 128 per TOD key). Route through the boot warm-up.

- **Files:** `roadRenderer.js:283-300,304,376,389`; `carModel.js:124-161`; `main.js:686`
- **Depends:** asphalt shader v2
- **Subsystem:** road (material+uniform), water (mask chunk), sky (weather driver)
- **Full spec:** master plan §4 → P4
- **Done when:** _(fill in on completion — measured number, not 'looks fine')_

### `[ ]` P4-07 · 1.0d · risk low
**SHORE FOAM — one owner.** Foam band in `waterChunk.glsl.js` driven by `shoreD` with animated noise advance; quieter static ring around marina/breakwater edges. **Sells the beach at Barceloneta, which is the seafront spawn.**

- **Files:** `waterChunk.glsl.js`, `waterSurface.js`, `terrainRenderer.js:713-745`
- **Depends:** waterChunk
- **Subsystem:** water
- **Full spec:** master plan §4 → P4
- **Done when:** _(fill in on completion — measured number, not 'looks fine')_

### `[ ]` P4-08 · 9.0d · risk medium
**VEGETATION: card trees.** 2048×1024 (4×2 grid of 512 cells) albedo+opacity RGBA + tangent-space normal, bark strip in the bottom band of each cell, **3 LOD tiers × 8 species = 24 geometries in ONE pool.** Species: Platanus × hispanica, Tipuana tipu, Celtis australis, Washingtonia (palm), Phoenix (palm), Jacaranda, Citrus/ornamental, Pinus pinea. Plus the alpha-tested normal-mapped Lambert material (**MUST preserve the `patchVegWash` injection reading batching-colour alpha, or give it a compile-time define per §7 rule 6**) and **LOD2 impostors rendered OFFLINE from the finished LOD0 cards** (8 species × 4 yaw),…

- **Files:** new `public/art/v1/vegetation/*`, `public/models/vegetation/bcn_trees_lod{0,1,2}.glb`; `vegetationRenderer.js:81-260,814-957`; `meshMaterializer.js:1053-1058`; new `backend/tools/bakeImpostors.mjs`
- **Depends:** staticPools; P1 pipeline
- **Subsystem:** vegetation
- **Full spec:** master plan §4 → P4
- **Done when:** _(fill in on completion — measured number, not 'looks fine')_

### `[ ]` P4-09 · 1.5d · risk high
**VEGETATION: LOD0-only tree shadow casting**, deleting the 13,963-instance transparent blob-shadow pool (S7). **Dappled tree shadow on asphalt is THE ETS2 road cue.** With the LOD ladder in place only ~1,100 trees × ~130 tris = ~143k enter the depth pass, vs the ~850k that originally tanked it. Blob shadows survive for the LOD1/LOD2 bands.

- **Files:** `meshMaterializer.js:453-491,1053-1058,1188-1205`; `vegPools.js`
- **Depends:** card trees; P0 shadow fix
- **Subsystem:** vegetation
- **Full spec:** master plan §4 → P4
- **Done when:** _(fill in on completion — measured number, not 'looks fine')_

### `[ ]` P4-10 · 5.0d · risk medium
**GROUND-FLOOR KIT REBUILD.** ONE `map/groundFloorKit.js` owning the bay grid — edge selection (**all street-facing edges**, not longest-edge-only), SEG_LEN/stride, skip hash, quantised ground Y — emitting shopfront + awning + fascia anchors as one co-registered result. Replaces `SEG_CAP` first-come clipping with per-building-fair allocation. Adds the UV channel `quad()` and `pushSegment()` never had. ~30% deterministic **closed roller shutters** off the existing hash (the most Barcelona thing in the frame at night and on Sundays, and cheaper than open shopfronts). Awning fabric with closed ends and 4 cm sag,…

- **Files:** new `map/groundFloorKit.js`; `shopfrontRenderer.js:17-34,74-88,97-166`; `awningRenderer.js:60-90,96-153`; `shopSignRenderer.js:121-160`; `cafeTerraceRenderer.js`
- **Depends:** modular bands; P1 pipeline
- **Subsystem:** ground-floor kit (new owner)
- **Full spec:** master plan §4 → P4
- **Done when:** _(fill in on completion — measured number, not 'looks fine')_

### `[ ]` P4-11 · 7.0d · risk high
**SIGNAGE: atlas + pool + text page.** Offline `scripts/build-sign-atlas.mjs` → `signs.ktx2` (2048², ETC1S+alpha) + `signs.cells.json`. `signAtlas.js` + `signPool.js` — ONE shared atlas material with per-instance `aUvOffset`/`aTint`/`aEmissive`, riding the existing city-wide pool, standardising on the **shader U-flip** and forbidding `tex.repeat.x = -1` forever. **Bounded 2048×1024 R8 text page**, 128 cells of 256×64, LRU-evicted by player distance, sub-region uploads via `renderer.copyTextureToTexture`, colour from `aTint` — 4× cheaper than the RGBA canvases it replaces, and it **deletes all three unbounded…

- **Files:** new `scripts/build-sign-atlas.mjs`, `map/signage/{signAtlas,signPool,textAtlas}.js`; `roadInfraRenderer.js:260,456,579`
- **Depends:** P1 pipeline + signData
- **Subsystem:** signage
- **Full spec:** master plan §4 → P4
- **Done when:** _(fill in on completion — measured number, not 'looks fine')_

### `[ ]` P4-12 · 5.0d · risk medium
**SIGNAGE: shop fascias + regulatory + lane arrows + traffic lights.** Fascias on the ground-floor kit's bay grid with **real OSM shop names from the 13,551 available**; delete the 24 fake `NAMES`. Restore `generateSpeedSigns` and route plates through the atlas pool. Replace the untextured 5-tri `ShapeGeometry` lane arrow with a 2-tri atlas quad carrying 6 real arrow types. Restore traffic lights seeded from the **4,225 unused OSM signal nodes**, fix the right-hand-drive placement (`:864` currently places left, citing India), assert every instance clears `isOnAnyRoad` (`:956` — that assert is the structural fix…

- **Files:** `shopSignRenderer.js` (rebuilt); `roadInfraRenderer.js:265-308,534-560,724-849,852-910,864,1380-1451`
- **Depends:** signAtlas, textAtlas, groundFloorKit
- **Subsystem:** signage
- **Full spec:** master plan §4 → P4
- **Done when:** _(fill in on completion — measured number, not 'looks fine')_

### `[ ]` P4-13 · 2.0d · risk low
**SIGNAGE: the Barcelona night set — highest night-look-per-MiB in the project.** Illuminated pharmacy green cross (from `data.shops` cat 16), metro M roundel (from the also-unused `metroStations`), tobacconist T, ONCE kiosk, hotel and parking P totems. Emissive from cells already budgeted. **This is how the night street gets believable light sources at zero additional punctual lights** — and it is the fallback that matters most if K-N fires.

- **Files:** new `map/signage/nightSigns.js`; `envToggle.js:149`
- **Depends:** signAtlas
- **Subsystem:** signage
- **Full spec:** master plan §4 → P4
- **Done when:** _(fill in on completion — measured number, not 'looks fine')_

### `[ ]` P4-14 · 11.0d · risk high (P4h only)
**ROAD FURNITURE (re-ordered).** P4a: **Barcelona bollards (pilones)** from the v8 baked sidewalk polygons — crosswalk mouths, chamfer corners, sidewalk-parking edges. Zero new draws (rides the pool), on every Eixample chamfer, i.e. in frame constantly on the benchmark route. P4b: extract the placement engine verbatim into `roadFurniture/placement.js`, widening the output from a boolean keep-mask to `{kind, side, s, e}`. P4c: post/bollard/delineator `BatchedMesh` pool on `createVegPool`, replacing `emitGuardRailRun`'s ~1,030 merges/tile. P4d: **kill `MeshBasic` on all railings** → Lambert + map + normalMap,…

- **Files:** `map/roadFurniture/*` (new), `roadRenderer.js:2763-2797,3176-3517`, `barrierRenderer.js`
- **Depends:** P1 deletes; P1 pipeline
- **Subsystem:** furniture
- **Full spec:** master plan §4 → P4
- **Done when:** _(fill in on completion — measured number, not 'looks fine')_

### `[x]` P4-15a · ~3d · risk low — **ENGINEERING HALF, SPLIT OUT 2026-08-27 · DONE 2026-08-27**
**VEHICLES: draws and allocation only. No Blender, no art, no new assets.**

Split from P4-15 because the two halves have different costs, different risks and different payoffs,
and only one of them is costing frames **today**. Measured on the 145 s drive of 2026-08-27:
`traffic` burned **27.6 ms across 9 long frames**, hitting **8.3 ms and 7.8 ms** on individual ones —
second only to `rend`. That is not the car models being ugly; it is 28 loose Meshes and 180 sprite
objects being submitted every frame.

Scope, all of it already specified inside P4-15:
- traffic **28 loose Meshes → 2 InstancedMeshes** (30 → ~7 draws)
- parked cars 11 → ~8
- shared template cache + single loader registry — kills **9 duplicate GLB parses**, colormap 18 → 1 resident
- tire smoke **90 Sprites + 90 SpriteMaterials → one InstancedMesh**

- **Depends:** nothing. This is why it was worth splitting — P4-15's `rallyStyle ADR` and `P1 pipeline`
  dependencies belong to the ART half.
- **Files:** NEW `car/carFleet.js`; `car/carModels.js`, `car/trafficSystem.js`, `car/parkedCars.js`,
  `car/carEffects.js`, `car/carDriver.js`, `game/policeMode.js`, `map/tileManager.js`, `main.js`;
  NEW `test/carFleet.test.js` (13 tests).
- **Done when — SHIPPED, in-game numbers still owed:**
  - **Draws for all cars + their lights: 41 → 3.** ONE `BatchedMesh` holds every city car in the
    world (traffic AND parked, nine geometries, one shared material) + one light `InstancedMesh` per
    system. Was: 28 loose traffic Meshes + 9 parked InstancedMeshes + 2+2 light meshes.
    ⚠ **Counts as 3 only where `WEBGL_multi_draw` exists** — the same bet `vegPools` already makes.
  - **Scene children: −37.** Traffic no longer adds/removes a Mesh per spawn/despawn (≈2 of each per
    frame at cruise = the per-frame allocation the F9 report attributed to `traffic`), and the 90
    smoke Sprites are gone from the graph entirely.
  - **Tire smoke: 90 Sprites + 90 SpriteMaterials → 1 InstancedMesh + 1 material.** Per-puff alpha
    rides an instanced attribute through `patchMaterial` (H9-safe). The 90-slot walk is now gated on
    activity, so it costs nothing on the frames you are not drifting.
  - **GLB parses 27 → 9, materials 27 → 1, colormap uploads 27 → 1.** Three consumers asked for three
    lengths; templates are now canonical + a per-consumer scale. (27, not the 18 the split estimated
    — `policeMode` was the third caller.)
  - **Parked-car geometry keeps its index: 59,106 → 31,887 vertices across the kit (−46%)**, measured
    from the GLBs. `toNonIndexed()` was buying nothing — the vertex colour is per-PART.
  - **Parked cars are now per-instance frustum culled** (`perObjectFrustumCulled`, ~640 instances).
    They were `frustumCulled = false` on nine always-drawn InstancedMeshes, i.e. ~250 cars ×2,189 tris
    ≈ **0.55 M triangles drawn every frame regardless of where the camera pointed**. Expect roughly a
    third of that to survive culling — **the largest single number here, and the one that most needs
    the drive report to confirm.**
  - **MEASURED, drive-report `2026-08-27T04-27-58-861Z` vs `T02-56-14-765Z`:**
    - ✅ **`traffic` allocation 22.6 MB → 0** (absent from `totalAllocBySection` entirely; it was the
      #2 allocator behind `rend`). Route-independent in kind — it was the per-spawn `new THREE.Mesh`
      + `scene.add`/`remove`, ~2 of each per frame, so the 2× longer drive should have produced MORE
      of it, not none. **This is the banked win.**
    - ✅ **Heap growth +1.53 MB/s → +0.02 MB/s** (629→706 MB over 69 s, vs 386→388 MB over 147.6 s).
      Flat over a drive twice as long. Consistent with the allocation result.
    - ✅ **No car material compiled mid-drive.** Neither `carSmokeAlpha` nor the shared kit material
      appears among the 41 late variants; `compiledWhileDriving` 43 → 41. The risk that a new
      `USE_BATCHING` / `USE_INSTANCING` variant would sync-compile on first car did not materialise.
  - **LIKE-FOR-LIKE PAIR, both `/game`, 40 long frames each — `T02-56-14` (69.0 s, pre) vs
    `T04-36-17` (75.1 s, post). These are the numbers.**
    | metric (summed across the 40 long frames) | pre | post | Δ |
    |---|---|---|---|
    | **allocation, total** | 55.7 MB | **22.2 MB** | **−60%** |
    | ↳ `traffic` alloc | 22.6 MB | **5.9 MB** | **−74%** |
    | ↳ `rend` alloc | 33.1 MB | **16.3 MB** | −51% |
    | `rend` ms | 809.0 | **383.7** | **−53%** |
    | **max frame** | 241.5 ms | **114.2 ms** | **−53%** |
    | p95 long frame | 122.1 ms | **90.1 ms** | −26% |
    | time-to-drive | 24.7 s | 22.7 s | −8% |
    | `traffic` ms | 52.7 | 53.5 | **+2% — unchanged** |
    | `other` ms | 1774.1 | 2084.0 | **+17% — unexplained** |
    | triangles p50 (worst frames) | 1,095k | 761k | −30% |
    | **draws p50 (worst frames)** | 175 | **188** | **+7% — WRONG DIRECTION, see below** |
    - **`other` +17% (+310 ms) has a named suspect, and it is not P4-15a.** The drive's own console
      printed `[adaptRes] LOCKED OUT — restored 1.04 … 6 resizes have cost 519 ms`. `adaptRes` reads
      ~0 ms in every one of the 30 worst frames across both reports, so that 519 ms is landing in
      `other` — more than the entire increase. This is D-25 exactly (`apply()` reallocates the whole
      composer chain and was never in a lap). **Testable in one drive: `?adaptres=0`.** Note what the
      lockout message itself concluded — "the GPU is busy but not with FRAGMENTS" — which is D-18's
      finding restated by the controller: the frame is CPU/stream-bound, not fragment-bound.
    - **`traffic` ms did not move, exactly as D-44 predicted.** That lap times
      `trafficSystem.update()`, which is dominated by `buildPath`'s per-point `getGroundY` sampling,
      not by the rendering P4-15a replaced. The residual 5.9 MB is its `pts`/`order` arrays. **The
      27.6 ms that scheduled this task was never going to fall from instancing** — if it matters,
      it is a separate task about `buildPath`, and it should be written up as one.
    - ✅ **CLOSED — `WEBGL_multi_draw` is present on this machine (`true`), so the whole fleet is
      genuinely ONE draw call.** The +13 draws in the table above is tile residency inside the boot
      window (`geom` first 491 → 583), not a per-instance fallback. **Steady state, measured in the
      console: `draws 202 · tris 1014k`** against caps of 450 / 2.6 M and a post-P1 p95 of 246 /
      1.96 M. One instantaneous sample, not a p95 — but it is a steady-state one, which the
      worst-frame table is not. **41 → 3 confirmed.**
      ⚠ It is 3 only where the extension exists. Without it three loops `drawElements` per instance
      and the fleet costs ~250 draws. Nothing in the codebase checks; `vegPools` makes the same bet.
  - 245 tests green, production build clean.

### `[ ]` P4-15b · ~16.5d · risk high — **ART HALF (the original P4-15 body)**
**VEHICLES.** Shared template cache + single loader registry (kills 9 duplicate GLB parses, colormap 18 → 1 resident). Tire smoke 90 Sprites+90 SpriteMaterials → one InstancedMesh. **Blender modular Barcelona kit** — 6 bodies at 1,800–2,800 tris LOD0 + 500–700 LOD1, TRUE dimensions (the `carModels.js:75` squash deleted), one shared UV layout, modelled shutlines/bevels for the normal bake. 2048² albedo with a **paintjob mask** + 1024² normal (UASTC) + 1024² ORM. Rewire traffic 28 loose Meshes → 2 InstancedMeshes (30 → ~7 draws), parked 11 → ~8. **Hero car re-UV** on the existing 9,792-tri geometry, 11 materials →…

- **Files:** `car/carModels.js`, `carModel.js`, `trafficSystem.js`, `parkedCars.js`, `carEffects.js`; new `public/models/vehicles/*`, `public/art/v1/vehicles/*`
- **Depends:** rallyStyle ADR; P1 pipeline
- **Subsystem:** vehicles
- **Full spec:** master plan §4 → P4
- **Done when:** _(fill in on completion — measured number, not 'looks fine')_

### `[ ]` P4-16 · 14.0d · risk medium
**HUD + PROGRESSION** (§8, §9) — `routeAdvisor.js`, delete `compassBar.js`, minimap repalette + **scheduler rebuild**, `game/progress.js`, dual-currency payouts, licence gating, `ui/garage.js`, district map, landmarks, gameFx restraint, marker restraint

- **Files:** see §8/§9
- **Depends:** P1 theme tokens; vehicle kit (for the money sink)
- **Subsystem:** hud
- **Full spec:** master plan §4 → P4
- **Done when:** _(fill in on completion — measured number, not 'looks fine')_

### `[x]` P4-17a · 0.5d · risk low — **Delhi content purge (2026-08-27)**
**Split out of P4-17 because P4-17 IS BLOCKED**: its stated dependency `signAtlas.js` does not exist,
nor does `map/signage/`, nor `scripts/build-sign-atlas.mjs`. Its producer is **P4-11 · 7 d · risk
high**, still `[ ]`. So the 2-day task sits on an unbuilt 7-day foundation. 17a is the half of it
that needs no atlas.

**The premise check also found the task description does not match the code.** It promises
"fountains, kiosks, monuments and glazed bus shelters"; `BUILDERS` has **no kiosks and no monuments**.
What exists, censused over 433 tiles: **fire_hydrant 527 · public_toilet 206 · fountain 114 ·
fuel_station 39 · communication_tower 17 · water_tower 2** = 905 objects, plus 1,295 bus stops.

**What shipped:**
- **Public toilet (206) REBUILT.** Was a Delhi *Sulabh complex*: 6 x 5 x 3.8 m brown-stone building,
  entrance canopy, three steps, steel railings, an emissive **"SULABH TOILET COMPLEX"** board, and
  **14 scattered bushes and boulders** landscaped around it — standing on 3-4 m Eixample pavements.
  Now a 1.6 x 1.5 x 2.5 m graphite street cabin: plinth, panel seams, overhanging roof, recessed
  door, handle, generic WC plate. **30 m² → 2.4 m².**
- **Fuel forecourt (39) NEUTRALISED.** Was "Bharat Petroleum inspired" with BP's blue-and-yellow
  livery, named for it in the identifiers. Now a neutral red/bone band. Canopy 14x10x7 m → 11x7.5x5.4,
  the urban form rather than a highway service station.
- **Fountains (114) RE-STONED.** Brown north-Indian sandstone → pale grey Montjuïc stone.
- **`EXCLUSION_RADIUS` re-sized to the new footprints** — `public_toilet` 5 → 1.6 m, `fuel_station`
  18 → 14. It feeds `vegetationRenderer:613` at RUNTIME, so a 1.6 m cabin was clearing a 10 m circle
  of street trees around itself. No re-bake needed; the zones are computed on read.
- **Four orphaned materials deleted** (`matBush`/`matRock`/`matBlue`/`matBrick`) — they existed only
  to landscape the Sulabh complex. Verified 0 callers before removal.

**Deliberately NOT done:** the fire hydrant (527, the most numerous) is left alone. Its form — 0.7 m
red column, two lateral outlets, base plate — is a defensible European *hidrante de columna*.
Splitting pillar vs underground is impossible today: **the bake ships `tags: {}` on every urban
feature**, so `fire_hydrant:type` never survives. Filed as **N-5**.

- **Files:** `map/urbanFeatureRenderer.js` (1,022 → 1,012 L)
- **Done when:** ✅ 905 features carry no Indian-specific content and no real brand's livery.
  Build clean, 354 tests green. A material-map validator (every `mat:` a builder emits resolves in
  `MAT_MAP`, and nothing in `MAT_MAP` is unused) run against the file — it caught one dangling
  reference. ⚠ **NOT yet seen on screen.**

### `[ ]` P4-17 · 2.0d · risk low — ⛔ **BLOCKED on P4-11 (signAtlas does not exist)**
**urbanFeatureRenderer.js (1,022 L, live) + busStopRenderer.js (529 L, live)** — Barcelona's fountains, kiosks, monuments and glazed bus shelters with backlit ad panels, all flat-colour untextured today, all in frame constantly on any Eixample drive. **They become atlas clients of the signage pool.** Note `busStopRenderer`'s `glowMesh` is one of very few existing street-level emissive night sources.

- **Files:** `urbanFeatureRenderer.js`, `busStopRenderer.js`, `signAtlas.js`
- **Depends:** signAtlas
- **Subsystem:** signage
- **Full spec:** master plan §4 → P4
- **Done when:** _(fill in on completion — measured number, not 'looks fine')_

### `[ ]` P4-18 · 3.0d · risk medium
**Tunnel + trench interiors** — `tunnelRenderer.js` is **944 live lines** exporting 9 builders, all called from `tileManager.js:46`. This is the visual surface of the **Ronda de Dalt trench and the Gran Via tunnels — the project's own documented signature corridors, and the spawn is at a trench portal.** Nobody owned tunnel lining, portal faces, portal-mouth lighting, in-tunnel road surfacing, bridge decks, undersides, piers, or trench retaining-wall material. Scope for P4: tiled lining + a lamp strip + a lit portal mouth (the one place where interior punctual lighting is both expected and cheap), plus the rock…

- **Files:** `tunnelRenderer.js`, `terrainMaterials.js`, `lightGrid.js`
- **Depends:** splat shader; lightGrid
- **Subsystem:** terrain (surfacing) + sky (portal lighting)
- **Full spec:** master plan §4 → P4
- **Done when:** _(fill in on completion — measured number, not 'looks fine')_


---

## 🏁 PHASE GATE MATRIX — the numbers each phase must hold

Measured on the committed benchmark route (`scripts/route.js`), production build, pixel ratio 1.0,
**night**, 80 km/h, dense Eixample. A phase is done when its column passes — not when its boxes are ticked.

| Gate | P0 | P1 | P2 | **P3 (SHIP)** | P4 |
|---|---|---|---|---|---|
| p95 night GPU | ≤ 12.3 ms | ≤ 12.3 ms | ≤ 14.0 ms | **≤ 15.0 ms** | ≤ 15.0 ms |
| Texture VRAM resident | ≤ 96 MiB | ≤ 100 MiB | ≤ 110 MiB | **≤ 200 MiB** | ≤ 200 MiB |
| Art library over the wire | 0 | ≤ 1 MB | ≤ 1 MB | **≤ 18 MB** | **≤ 24 MB** |
| Draws | ≤ 265 | ≤ 240 | ≤ 240 | **≤ 450** | ≤ 450 |
| Triangles | (capture) | ≤ 2.32 M | ≤ 2.0 M | **≤ 2.6 M** | ≤ 2.6 M |
| Time-to-drive vs P0 baseline | (baseline) | +0.0 s | +0.0 s | **< +1.5 s** | < +1.5 s |
| `programs.length` delta after 3 min | 0 | 0 | 0 | **0** | 0 |
| Disposal assertions | pass | pass | pass | **pass** | pass |
| Page weight | −14 MB | −18.3 MB | −18.3 MB | −18.3 MB | −18.3 MB |
| Mid-air shopfronts | — | — | — | **0** | 0 |
| Building detail coverage | — | — | — | **≥ 95%** | ≥ 95% |
| Every shipped asset on the contact sheet | n/a | n/a | n/a | **100%** | 100% |


**P3 is the ship column.** Note the gates *tighten* through P0–P2 (GPU ≤12.3 ms, draws ≤240) and only
open up at P3 — that is deliberate: P0–P2 spend nothing on art and must **bank** headroom, so the art wave
has somewhere to put it. If you reach P3 without having tightened, the art will not fit.

**If a row fails:** that is a scope decision, not a bug to paper over. Log it in the decision log with the
measured number, then either cut scope (see the cut list) or fix the owner task.

Asset-level acceptance is a separate per-asset checklist — master plan §2.7 (contact sheet, licence,
normalize provenance, palette ΔE2000 ≤ 15). **Gate 1, the contact sheet, is the only one that catches a
kitbash, which is why it is first.**

---

## 📋 Session protocol

**At session start**
1. `git rev-parse --abbrev-ref HEAD` — confirm you are on a `v3*` branch, never `main`.
2. Read RESUME HERE. Read the standing hazards. Read the next task's full spec in the plan.
3. If the next task is in a phase whose predecessor's exit gate has not passed, **stop and run the
   gate first** — or say explicitly why you are proceeding anyway.

**During**
- One task per commit where possible. Commit message: `v3 <task-id>: <what>`.
- Mark `[~]` when you start, `[x]` when done, `[!]` if blocked (and write what blocks it).
- When a task lands a performance change, put the **measured** number in the ledger.

**At session end (or when context runs low)**
1. Update RESUME HERE: current phase, next task, done count.
2. Any task left `[~]` gets a one-line note of exactly where it stopped.
3. Commit the tracker. **An uncommitted tracker is a lost session.**

**Deviating from the plan**
Allowed and sometimes correct — the no-slacking rule cuts both ways. But write it down here under
the task, with the reason. A silent deviation is indistinguishable from a mistake three sessions later.

---

## 📓 Decision log — append, never rewrite

| Date | Task | Decision | Why |
|---|---|---|---|
| 2026-08-27 | **D-81 · the tile clipper silently ate every road that LEFT the tile — and that is probably why `noClipTileStrategy` exists** | Found while verifying R-J5: 9 tiles rendered no roads despite provably containing them. `clipRoadToTile` accumulates surviving segments into a `run` and pushes it in exactly TWO places — when a new run starts, and when the polyline ends. On a segment falling outside it did a bare `run = null`, **discarding everything gathered so far**. So the commonest case of all — a road that enters the tile, crosses it and exits — produced NOTHING. Measured: a 103-point path with **42 consecutive segments fully inside** tile 16_33153_24471 clipped to **zero** runs, while a 2-point road cut from the same polyline clipped correctly. That asymmetry is why it survived: reproducing it needs a polyline that both enters AND leaves. One line — flush the run before nulling. After the fix the bake's own `[RenderClip]` proof-of-work went **90.0% → 98.9%**, i.e. it had been dropping ~9% of road records. **The likely history: `noClipTileStrategy: true` is a workaround for this bug.** With the clipper eating roads, not clipping at all was the only setting that produced a complete city — so a latent bug in one module silently dictated a whole-pipeline strategy, and cost 37.8% duplicate road geometry (D-79) as the price. Pinned by `frontend/test/tileClip.test.js` (6 tests). |
| 2026-08-27 | **D-79 · R-J5 · 37.8% of all drawn road was a coplanar duplicate, and it explains THREE separate reports at once** | "Roads darker in places", "z-index issues on roads" and "sidewalks too wide" were one bug. `window._ddPick()` (added this session precisely because identifying a surface from a screenshot had already failed three times) returned **`sidewalk` twice and the road twice at identical world coordinates**. Cause: `noClipTileStrategy: true` writes each way IN FULL to every tile its bbox touches — correct for the DATA ("Guarantees continuous roads"), ruinous for the PICTURE. Measured: **5,308 ways (13.7%) in more than one tile; 4,146 km of centreline drawn against 2,578 km unique = 37.8% duplicate.** **And the copies are not identical, which is what makes them visible:** `createAoSampler` CLAMPS outside its own grid, and **24.6% of road vertices are drawn outside their tile's AO grid** (p90 43%), so they take the tile-EDGE AO while the neighbour computes the true value. Two coplanar surfaces, two AO values, fighting per-pixel. Fixed WITHOUT reverting the strategy: `payload.renderRoads` (clipped to the tile) feeds `bakeRoadSurfaces` + `bakeSidewalks`; `payload.roads` stays whole for physics and topology. **Rendering needs coverage, not duplication — the two goals were never actually in conflict.** |
| 2026-08-27 | **D-80 · `_ddPick` and `_ddGround`: stop identifying surfaces by eye** | Three wrong identifications in one session, each costing a round trip and one costing a re-bake: big beige shapes blamed on pavement width, then on plazas (both wrong — they were duplicated pavement); a dark region blamed on water (0% of road vertices fall inside a water polygon). `window._ddGround()` separates CULLED from BROKEN; `window._ddPick(x,y)` raycasts a screen pixel and names every surface under it with material, colour, texture and depth bias. The pick output solved R-J5 in ONE call after three failed guesses. ⚠ **`_ddPick`'s `map` field lied once already** — the road binds its asphalt plate to a custom uniform and deliberately sets no `material.map` (D-30), so it reported "NO TEXTURE" for a textured road and nearly produced a false bug report. It now reports shader patch tags too. **A diagnostic that misreports is worse than none; check its answer against the code before believing it.** |
| 2026-08-27 | **D-78 · the "big sidewalks" are PLAZAS, and they were the only paved surface with no texture** | User, after the LOD fixes: "I still see big sidewalks." Measured — they are not sidewalks. Pavement width is correct (residential 3 m, primary 4 m, all baked from the R-W1 model) and pavement self-overlap is **0.4%**, so neither width nor duplication explains it. They are `pedestrianAreas`: **six polygons, 6,648 m² in the Gran Via tile, the largest 3,143 m² in an 89x89 m footprint.** They had **never been seen before** — D-73's tree rule (`dist <= 170 m` on a distance including camera altitude) hid every plaza in the city at any height, and my fix revealed them. So this is new, not regressed. **The real defect is material, not size:** plazas rendered as a flat vertex-coloured `MeshLambertMaterial` while the pavement beside them carries the photographic panot plate + normal map, and at 89 m across, flat reads as a blob. Barcelona lays its pedestrianised plazas in the same panot, so they now share the plate. ⚠ **NOT the same material instance** — `applyGroundLayer` writes the depth bias onto the material, and `sidewalk` (-6) beats `road` (-4), so a plaza on the pavement's material would paint over any carriageway it touches (R-J4 again). `getPanotSurfaceMaterial(layer)` caches one instance per ground layer and shares the textures; plazas take `pedArea` (-3.4), UNDER the road. `?plazatex=0` reverts, in the house style of `?roadv2=0` / `?treecards=0`. |
| 2026-08-27 | **D-77 · you cannot measure this game's LOAD through browser automation — the tab is throttled** | Verifying in Chrome (user-authorised), the load reported `p1 physics 26,527 ms / 11 chunks` against a historical **752 ms**. That reads as a catastrophic regression and it is not one: with every frontend change **stashed** the same run reported **51,643 ms** — *worse* without the changes. Cause: **the load is YIELD-bound** (the whole point of D-65/D-66 — every build chunk ends in a yield and waits a frame), and Chrome throttles `requestAnimationFrame` to roughly **1 Hz in an unfocused tab**. So the automation harness stretches a 4 s load into minutes and the loader hits its own poll cap with 0-1 tiles resident. Machine load was also high (15-min average **8.23** after three full region bakes). **Rule: automation can verify GEOMETRY and visibility (`_ddGround()`, tile-data assertions), never TIMING.** A load or frame number taken this way is an artifact of the harness. Timing still needs a human with the window in front of them. **And the stash-test is the cheap way to tell a regression from an artifact — do it before reporting either.** |
| 2026-08-27 | **D-75 · R-J4 · a pavement was being drawn ON the carriageway, and winning the depth test** | User: "some roads got sidewalks which looks bad, it's covering the road almost." Every road emits a pavement ribbon to each side and **nothing checked whether it lands on a DIFFERENT road**. On a boulevard with lateral service roads (Gran Via) the lateral's pavement lands on the main carriageway — and `GROUND_LAYERS.sidewalk` (-6) deliberately beats `road` (-4), so the asphalt LOSES to a pavement that should not exist there. Measured: **14.3% of baked pavement vertices inside a live carriageway, 4.0% deeper than 0.5 m, worst 5.55 m.** The existing `clampSidewalkVerticesOutsideRoads` is the wrong tool — it moves VERTICES only (an edge still crosses) and where the pavement genuinely lies on an avenue it produces a squashed ribbon instead of removing it, which is itself the "z-index" artifact the user saw. Fixed by clipping the ribbon out of carriageway coverage, the same rule `pathCoverageClipper` already applies to footpaths one level down. Result on the probe tile: **>0.5 m overlap 4.0% → 1.65%, worst 5.55 → 1.19 m** (residual is miter overshoot at bends). **⚠ A clip must REMOVE, never densify:** the obvious resample-and-keep-uncovered-samples version took the baked pavement from **1,968 to 20,670 floats on one tile** — sampling finds the transitions, the run is rebuilt from source vertices. |
| 2026-08-27 | **D-76 · the terrain built a road-proximity grid for every tile and never read it** | `roadDistGrid` — a full uniform grid, one distance stamped per road segment into every cell within 15 m — plus `minDistSqToRoads` and `distSqToSegment`, computed on **every terrain build** and consumed by **nothing**. It is the producer left behind by 3635fa6 ("Remove dark road-edge outline — drop the Delhi roadside dirt strip"), which deleted the CONSUMER on purpose. What kept it alive through readings of the file was a stale comment 400 lines away still asserting "CPU vertex colors carry road-edge brown". Deleted, both comment and code, with a note saying why it must NOT be reinstated to fix bare ground near roads — that ground is covered by the pavement, and when it reads as a lawn the cause is LOD (D-72/D-74), not a missing tint. **A dead producer is invisible when a comment elsewhere still describes its output.** |
| 2026-08-27 | **D-74 · the kerb drew 2.5× further than the pavement it edges — the green strip down every street** | Found by the user's `_ddGround()` reading in PHOTO mode, where by definition everything should be drawn: markings **12/0**, crosswalk **12/0**, curb **11/1** — and sidewalk **5 visible / 7 HIDDEN**. Two faults on adjacent lines. (1) `bcnSidewalkMesh` was culled at `80 * altMult` while `bcnCurbMesh` got `200 * altMult`: **the pavement and the kerb that edges it are ONE surface**, so from 80 m out every street showed kerb lines with bare terrain between them and the buildings. That is the "green along the kerb" the user reported, and it is an LOD bug wearing a geometry bug's clothes — it survived the whole R-J3 investigation because the junction clip was ALSO eating pavement and the two symptoms are identical on screen. (2) None of the Phase-3 ground lines honoured `_photoMode`, unlike `showDetail` immediately above them, so the one mode whose entire purpose is "draw everything" still culled the pavement. Both now on `GROUND_COVER_CUT_M` with a photo-mode lift; `dressDist` given the same lift. **Cost, measured off the user's table:** pavement ≈515 tris/tile, kerb ≈1,006 → ~14k tris and +18 draws over the 9 resident tiles, against 2.6 M / 450. **Generalise: when two halves of one physical object have two different LOD numbers, the object is wrong at every distance between them.** |
| 2026-08-27 | **D-72 · the city was culled at 280 m while the ground it covers drew to 1500 m — the SAME fix, missed a third time** | User: "things look fucked" from a drone — roads and crosswalks floating on a grass-green lawn with whole blocks of buildings absent. Not a data problem: the tile measured **113.9% covered** (buildings 46.4%, roads 37.9%, pavement 15.6%). `window._ddGround()` (added this session, because inferring this from screenshots had already cost a round trip) named it in one reading: **greens 0 visible / 31 hidden, plazas 0 / 11**, pavement drawn on **4 of 11** resident tiles. Cause: `FOG_FULL_DIST = 280` hides everything on a far tile, but **terrain was lifted out of that cull to 1500 m by P4-02, and roads are explicitly "kept visible into fog for continuity"** — so the two things that make the groundread as ground survive, and everything that COVERS it dies at 280 m. P4-02 found this for terrain ("deleting ground still ~61% visible at 38.7% fog"); VEG-FIX-1 found the resulting seam for vegetation ("bare ground from 280 m out") and lifted impostors to 600 m. **Neither pass extended the built environment.** Fixed: `GROUND_COVER_CUT_M = 600` (where FogExp2 at the shipping 0.0025 reaches 89.5% — the same constant and the same reason as `VEG_IMPOSTOR_CUT_M`), carrying park/plaza polygons and `lodBuildingMesh` past the cull. Detail (full buildings, pavement, kerbs, lane paint) deliberately stays at 280 m — it is the expensive half and the frame budget binds. |
| 2026-08-27 | **D-73 · parks and plazas were being LOD'd as TREES, on a distance that includes the camera's altitude** | The near path's fall-through was `m.visible = dist <= treeMaxDist` — `TREE_MAX_DISTANCE` is **170 m**, and `dist` is the distance to the tile CENTRE, which includes camera Y. So from any altitude above ~170 m **every park and plaza in the city vanishes at once**, and at street level a park in your own tile pops out as soon as it is 170 m away. They are flat ground polygons of a few triangles each; they were inheriting a rule written for 12 m plane trees purely by falling off the end of an `else if` chain. Now on nearest-EDGE distance out to `GROUND_COVER_CUT_M`, like the terrain and roads they sit between. **Cost check before shipping it:** greens merge per TYPE (~3 meshes/tile) and plazas to one per tile, so this is ≈+42 draws against 246/450 — the reason it is affordable at all, and the reason the expensive half was left alone. |
| 2026-08-27 | **D-70 · R-J3 · the junction clip was eating the pavement, and the terrain showing through was the symptom** | User-reported from the driver's seat: bare green terrain along kerb lines and around corners, plus pavement "where it shouldn't" — one bug seen from two sides. **Two compounding geometry errors** in `buildSidewalks`/`buildCurbs` and their bake twin: (1) the crossroads branch of `junctionClipRadius` used the FULL paved width as the along-road clip depth, where the kerb to stop at is HALF a width away — R-J2 had already derived the correct rule and fixed only the tee branch; (2) `clipPolylineNearJunctions` measures distance to the node, so the clip is a CIRCLE, and a pavement offset `o` sideways is met at `√(R²−o²)` — both sites used `depth + offset`, cutting at `√(depth²+2·depth·offset)`. Eixample crossroads: **21.3 m of pavement cut per arm against a correct 8.6 m**. Measured over 10,713 roads: median cut **21.4 → 9.7 m**, pavement entirely absent on **15.6% → 5.4%**, **≈138 km of kerb line restored**. Fixed with `junctionApronDepth()` + `offsetClipRadius() = hypot()`. ⚠ **Supersedes the 2026-05-29 decision** "junction.radius = max road width = clip-zone depth": that was calibrated at a 4 m residential road, and R-W1 made it 10.4 m — the rule did not change, its cost in metres did. **A latent bug can be detonated by a change that is itself correct.** Lane paint deliberately keeps the old rule (over-clipped paint shortens a line; it does not expose terrain). |
| 2026-08-27 | **D-71 · a THIRD copy-pair, and this one had already silently diverged** | The pavement/kerb junction clip lives in `roadRenderer.js` (runtime, 173 of 433 tiles) and `sidewalkBaker.js` (bake, the other 260) — the same tile-chosen split as the width taper (D-69). **R-J2's tee fix landed only in the runtime copy**, so for a whole session the bake over-clipped every tee in the city while the runtime did not, and which behaviour you saw depended on which tile you were standing in. `sidewalkBaker.js`'s own header says "Any change to eligibility, widths, offsets, or junction clipping must be mirrored in both places" — **the comment was there and it did not work**, which is the same lesson R-W1 drew about the nine width tables. Pinned by `frontend/test/sidewalkClip.test.js`. **Three copy-pairs are now known; assume a fourth.** |
| 2026-08-27 | **D-69 · the width taper exists twice, and the split is by TILE** | `roadBaker.js` bakes the road surface for **260 of 433** tiles; `roadRenderer.js` builds the ribbon at runtime for the other **173**. Each carries its own copy of `buildJunctionWidthMap` + `computeTaperedWidths` — same constants, same `hashPoint`, same smoothstep. They agree today and nothing made them. **What makes this worse than an ordinary duplicate: the two paths are chosen per TILE**, so the same street tapers through one implementation or the other depending only on where the tile grid fell — a drift would appear as a seam that moves with the grid, which reads as a tile-streaming bug, not a width bug. Both are now exported and pinned by `frontend/test/widthTaper.test.js`, run against the real measured Barcelona steps (living_street 4 → residential 10.4 is 219 nodes). Following R-W1's precedent: the frontend keeps its copy, a test re-derives it. **Not merged into one module** — the frontend importing backend code at runtime is a bundling change, and the test buys the same guarantee for none of the risk. |
| 2026-08-27 | **D-68 · R-J1 was already built; the bug was a per-tile lookup answering a per-WAY question** | All three of R-J1's wanted items existed — gore geometry (492 of 486 distinct merge nodes; only **12 drivable nodes** city-wide lack one), the Eixample chamfer (2,233 eligible junctions, plus sidewalks and kerbs), and a 20 m width taper that resolves **every one** of the 2,956 in-tile width steps. **Measuring the premise is what found the real defect.** Junction enrichment built its `wayId → width` map from `subset` — the spatial query for the current tile — while a junction is kept within 30 m of the tile, so its arms routinely belong to ways that never intersect it. Result: **5,454 of 35,386 approach widths (15.4%) were a fabricated 6 m**, corrupting `radius` at **2,278 of 11,101 junctions (20.5%)**, 97.7% of them exactly the fallback, worst case a baked 6 m against a true 22 m. `radius` + `approaches` are the ONLY fields the baked junction record is read for, and all four consumers use both → **33 chamfers missing** (fell under the ≥ 8 m gate) and **327 misshapen**, median vertex error 2.2 m, worst 12.2 m. Fixed with one region-wide map built before the tile loop, plus a D-23 proof-of-work line so it cannot regress silently. **Fourth ticket in two days to die on re-measurement** (M1, R-P1, R-B2's framing, now R-J1) and the second — after R-B1 — to have a working implementation nobody had checked for. |
| 2026-08-27 | **D-67 · adaptive resolution was answering a steady-state question with transient data — the SECOND controller today to make that mistake** | Four consecutive drives, same script every time: probe, fail, probe, fail, `LOCKED OUT — the GPU is busy but not with FRAGMENTS`. Cost per drive: 4 reallocations, **210-519 ms and 15.3 MB**, enough to earn its own `adaptRes` line in the report. **The verdict was always correct; the mistake was WHEN it was reached.** It ticked from frame one, so every probe landed inside the first ~20 s, where the frame is long because the world is streaming — and resolution cannot reach a frame that is waiting on a tile build. That is **D-66's shape exactly** (the tile-build budget shrank itself during the load, because loading was what made frames long). Two independent adaptive controllers, one day, same error. It is now `arm()`ed at the time-to-drive instant, beside `cpuTimer.armLongFrames()` — the moment main.js already treats as "the measured thing has started" — plus a 180-frame settle. **The two-probe limit is deliberately KEPT**: transient readings were noisy (one drive measured +4.3% on the same step where the next measured −23.5%), and one noisy negative must not lock the controller out for a session on a machine where resolution IS the lever. **Not disabled by default** — on a weaker GPU it is a real safety net, and what was broken is when it measured, not that it exists. |
| 2026-08-27 | **D-66 · the load is 3.7× faster, and the adaptive budget had been fighting it** | Measured after the LOAD_BUDGET_MS change: **load 16,200 → 4,350 ms, time-to-drive 18,444 → 6,329 ms**, same 14 tiles, same ~3.4 s of work. Chunks **1,177 → 334**; average chunk **2.63 → 10.1 ms**. Predicted 4.3 s, measured 4.35 s. **It also restores and beats the ledger's 6.94 s** — so that number was real, and this is what had been silently lost. ⚠ **A second mechanism showed up only on reflection, and it is the nastier one:** the adaptive rule shrinks the budget by 0.6 ms whenever a frame exceeds 20 ms — and during a load frames ALWAYS exceed 20 ms, because loading is what is making them long. So it walked the build budget toward `BUDGET_MIN = 1.0` **precisely when the load needed it most**: a negative feedback loop where the symptom of loading throttled the loading. Gating it on `_initialLoadDone` was not just tidiness; without that, a bigger `LOAD_BUDGET_MS` would have been eroded within a second. **Generalise: an adaptive controller tuned for the steady state will read the transient as a fault and fight it.** |
| 2026-08-27 | **D-65 · the load is YIELD-BOUND — 3.1 s of work spread over 16 s, and no build phase is to blame** | The per-phase totals answered on their first boot and the answer inverted the question. `initial tile load COMPLETE after 108 polls (~16200 ms), 14 tiles resident` · `main-thread time by build phase (3095 ms total): p1 physics 752/132 · p4 clusters 589/124 · p2 buildings 465/163 · p4 urban 389/263 · p1 rg:markings 256/251 …`. **Three seconds of work, sixteen seconds of wall.** ~1,180 chunks averaging **2.63 ms — which is exactly `FRAME_BUDGET_MS = 3`** — and every chunk ends in a yield costing a full 16.7 ms frame: 1,180 frames ≈ 19.7 s. **The main thread is idle for ~84% of the load.** I had expected to find a phase worth optimising (buildings or vegetation were the guesses); there isn't one — `p1 physics` tops the list at 752 ms and fixing it entirely would save 0.75 s of a 16 s load. The 3 ms cap is CORRECT while driving (it exists so tile work never piles onto a frame already missing 60 fps — the measured high-speed stutter) and simply does not apply behind a loading overlay where nothing is being kept smooth. `LOAD_BUDGET_MS = 12`, one-way latch. **Generalise: before optimising the work, check whether the work is what is taking the time.** |
| 2026-08-27 | **D-63 · the instrument for the biggest cost in the game already existed and had never been called** | `tileManager.takeBuildOverruns()` labels thirteen build phases (`p1 roadgen`, `p2 buildings`, `p3 vegetation`, `p4 clusters`, …) and has been **exported and never read by anything.** So the load — ~3 s per tile, the thing behind both `other` and a time-to-drive that is really a timeout — has been unattributable the whole time, while the data to attribute it was being collected and thrown away. Two problems with it as written: it keeps only the WORST overrun per phase (good for "what stuttered", useless for "where does the load go"), and it clears on read. Added `getBuildPhaseTotals()` — total main-thread ms and chunk count per phase, accumulated where the chunk actually ENDS (after the budget early-return, because `_lastResume` only moves on a real yield). Printed at the end of the initial load and carried in the F9 report under `build.phases`. **Generalise: before building an instrument, grep for the one that is already there.** |
| 2026-08-27 | **D-64 · and wiring it revealed the same two-entry-point defect for the fourth time today** | The per-phase totals went into `window._ddReport` first. F9 calls `shipReport` **directly**, so the keypress — the documented way to take a report, the one every drive uses — would have produced a report missing the largest cost in the game, while the console call produced a complete one. That is D-56 (two disposal branches), D-46 (seven road-field copies) and D-50 (`getLoadedRoadSegments`) in a fourth costume, all in one session. Both routes now go through one wrapper and `test/driveReport.test.js` asserts `shipReport(` appears exactly once in `main.js`. **Four occurrences is not a run of bad luck; it is what this codebase looks like. Assume a second call site and go and find it.** |
| 2026-08-27 | **D-62 · time-to-drive has never been a load time, and the loader lifts on an unfinished world** | The instrumentation added in D-61 answered on the first boot: `[perf] initial tile load GAVE UP at the 131-poll cap (~19650 ms) — still 3 in flight, 5 queued, 6 resident.` So **the loading screen lifts on a TIMEOUT with six tiles built** — fewer than a 3×3 ring — and the rest streams in behind the title screen. time-to-drive then records ~21 s, which is the cap plus the fade, not the load. Every drive today and on 08-26 sat in the 19-23 s band, so this predates R-W1 and R-J2 and is not a regression from them; the ledger's **6.94 s cannot have been measuring the same thing**. **The real number is the one underneath: ~6 tiles in 19.65 s, about 3 s per tile.** And it explains `other` exactly — tile builds are ASYNC yielded chunks, so the `tiles` lap reads 0.9-2.5 ms while the work lands outside every section as 2,000-3,000 ms of `other`. **Generalise: a gate metric that can be satisfied by a timeout will eventually report the timeout, and it will look like a number the whole time.** |
| 2026-08-27 | **D-61 · `other` is a BOOT cost, and time-to-drive is landing on its own timeout** | `other` is the largest section in every report — 2,007–3,087 ms against `rend`'s 237–415 — and D-36 filed it as "GC/thermal". Attributed properly: **every top-`other` frame is in the first 12 s** (atS 0.14 … 11.88), the report's `async` field is `(none)` on all of them and `alloc` is `{}`, and `other` is 100 of a 105 ms frame. So it is not GC and it is not our allocation — it is boot work outside the profiled loop, and after ~30 s of driving there are no long frames at all. **`other` is not a driving cost; it is the load.** Which points at the load: three drives measured time-to-drive at **19.4 / 20.0 / 21.3 s** against **6.94 s** in the ledger after P4-01 — and main.js polls `isInitialLoadComplete()` every 150 ms and **gives up after 130 polls, a 19.5 s cap.** A number that lands on its own timeout is usually the timeout. `isInitialLoadComplete()` requires the queue to be COMPLETELY empty, which is stricter than "the world is ready". The boot now prints COMPLETE-after-N-polls or GAVE-UP-at-the-cap with what was still in flight — **ungated, because "loading takes 20 s" and "loading finished and nobody noticed" have nothing in common.** Next boot answers it. |
| 2026-08-27 | **D-59 · the authored facades have NEVER rendered, and a `.catch()` is why nobody knew** | A `?debug=leak` drive console carried `[facadeArray] authored body array FAILED to load (loader is not defined) — placeholder stands`, twice. `loadFacadeArray` used to build its own `new KTX2Loader()` and dispose it at the end; the refactor to the shared registry loader deleted the variable **and left `loader.dispose()` behind**. So every load threw `ReferenceError` AFTER the texture had downloaded and transcoded perfectly, the enclosing `.catch()` turned it into a warning, and **every building in the city rendered P3-04's PLACEHOLDER layers for as long as the shared-loader refactor has been in.** The console even printed the tell — `body 512x512x8`, placeholder dimensions, against P3-05's specced 1024². Disposing it would also be wrong now: `getKTX2Texture` returns a promise-cached texture from the one loader the whole app shares. **Generalise: a `.catch()` around a load turns a CODE error into a content warning. When a feature reports "failed to load, falling back", read the reason before believing the fallback is the story.** |
| 2026-08-27 | **D-60 · a third undefined-reference check, and the narrowing is the whole design** | Neither existing check could see `loader.dispose()`: it is lower-case (the constant check skips it) and a METHOD call on an identifier, not a call to a project export. The new rule is "an identifier that occurs EXACTLY ONCE in the file, is not in scope, and is used as a MEMBER ACCESS" — a genuinely local name is written as well as read, so a single occurrence is a leftover from a deleted declaration. The first attempt also accepted `name(`, `name,` and `name)` and produced **dozens** of false positives, all object-literal shorthand and method definitions (`return { master, carBus }`, `alloc() {…}`) — precisely the failure this file's own header warns about. Narrowed to member access it reports **one** hit across `src/`, which turned out to be `screen.orientation` — a real browser global missing from the list, not a defect. Verified it fails on the real bug. |
| 2026-08-27 | **D-56 · #39 · the two disposal branches, and the fix that only ever landed on one of them** | Tile unload branched: a Group was `traverse`d and its `child.isMesh` freed; everything else went down a flat path. The flat path had learned three things over time that the group path never did. **(1)** `isMesh` alone is not enough — a `LineSegments`/`Line`/`Points` holds a geometry and fails it. That is the `streetlightWireMesh` leak, found and fixed once, **and still live inside every Group** (`reflectorGroup`, `tunnelMeshGroup`, `canopyMeshGroup`). **(2)** The group path ignored `userData.sharedGeometry` and disposed unconditionally — the OPPOSITE defect, freeing a pooled geometry out from under every other tile using it. **(3)** It skipped instance buffers entirely. Now one routine, both entry points calling it. **Generalise: when a bug is fixed in one branch of a two-branch walk, the fix is not done until the other branch is read.** |
| 2026-08-27 | **D-57 · #39 · the line that freed the instance buffers had never freed anything** | Both paths carried `m.instanceMatrix?.dispose?.()` with a comment explaining that `geometry.dispose()` does not free those GPU buffers. Correct premise, dead call: **`dispose` does not exist on a `BufferAttribute` in three 0.183**, and the optional CALL (`?.()`, not just `?.`) swallowed the miss in silence. Verified against the installed three, in a test that fails loudly if an upgrade ever adds the method. What actually frees them is `InstancedMesh.dispose()` / `BatchedMesh.dispose()`, which dispatch the event the renderer releases them on — now called, gated on `sharedGeometry` so a pooled BatchedMesh can never be torn down by a tile unload. **Generalise: `?.()` on a method you believe exists converts a TypeError into silence. Reserve it for calls that are genuinely optional.** |
| 2026-08-27 | **D-58 · #39 · a regex over the source is not a test, and it proved it** | `test/tileDisposal.test.js` asserted that `tileManager.js` contained the literal string `m.isMesh \|\| m.isLine \|\| m.isLineSegments \|\| m.isPoints`. It passed for as long as the group branch was silently leaking — because the string was present, on the OTHER branch — and it failed the moment those branches were merged into one correct routine. It pinned the shape of the code and was blind to what it did. It was written that way because `tileManager.js` cannot be imported outside Vite (`./tileParserWorker.js?worker`). So the logic moved to `map/tileDisposal.js` — one function, one import — and the tests now run it against real three objects. **Generalise: if a thing can only be tested by grepping its source, that is an argument for extracting it, not for grepping.** |
| 2026-08-27 | **D-53 · R-P1 · the surface half of the invariant is the MIRROR of the tunnel half, not a wider whitelist** | R-P1 reads as "extend the tunnel validator from `layer < 0` to every drivable road". Doing that literally would have shipped a check that flags the wrong defect. The tunnel test is asymmetric — it flags the grid too HIGH, terrain rising into the roadway — because a tunnel's floor is carved BELOW the deck. For a surface road the terrain IS the floor and the physics heightfield is built from it, so the violation is the grid too **LOW**: the visual asphalt in the air with the collider metres beneath. Widening the whitelist without flipping the sign flags BURIED roads (a bump you drive over) and misses every FLOATING one (the hole you fall through). Two collectors, mirrored, sharing the sampler; elevated roads excluded on the same four booleans the guard-rail and street-parking gates use, so three systems cannot drift on what "carries its own surface" means. |
| 2026-08-27 | **D-54 · R-P1 · the first green light was a false one, and the proof-of-work line is what caught it** | The first run of the new check printed **"✅ no drivable surface road sits more than 0.5 m above the terrain"** — on the Eixample test area, which is flat. Believing it would have closed the ticket on a check that had barely been exercised. This is D-23's shape exactly (a cost measurement with no work to cost reported PASS), so the collector now counts **what it looked at and the extremes it saw**, and the report prints that line even on success — plus a hard **VOID** when the sample count is zero. The full-region run then read `357,178 samples · drop range −3.22 … 2.21 m`, which is what makes the 0-violations answer worth anything. **Generalise: a new check's first green light is evidence about the check, not about the city.** |
| 2026-08-27 | **D-55 · R-P1's premise died the same way M1's did, and both tickets said to check** | R-P1 was written on P-R1b's "4.9% of drivable road points above the shipped terrain, worst 24 m", and it carried its own warning: *"Fixing the heights may close most of this on its own, so measure before writing repair logic."* Measured: **worst 2.2 m in the entire city, on a road this validator's own header already lists as a known pre-existing native dip. 0 roads over 5 m.** The terrain rework closed it. That is now **two tickets in one day** (M1, R-P1) whose motivating aggregate did not survive being counted — and in both cases the ticket itself said to count first. **The pattern is worth naming: a number recorded months ago describes the codebase of months ago. Re-measure before building on it.** |
| 2026-08-27 | **D-52 · R-J2 · "turn the flag on for the others" would have shipped a second bug** | I filed R-J2 the day before as "the fix exists and is one argument (`includeTees`)". Reading the geometry before writing it, that was wrong twice. **(a)** The rail's clip radius is the WIDEST road at the node — right for a rail, where a generous gap beats a wall, but on a primary meeting residential side streets it cuts ~35 m out of the kerb and paint at each one, most of an Eixample block face. A tee gap must be sized to the SIDE street. **(b)** A T interrupts **one side** of the through road; a radial clip punches an equal hole in the pavement and kerb on the FAR side, where nothing is happening. Measured after fixing: of tee junctions actually in clip range of a road, **46.8% are one-sided** — every one of those would have been a spurious hole. Also: a CENTRE line does not break for a street joining from one kerb, so paint splits into `crossroadsOnly` (centre, lane dividers) and side-aware (edge line). **Generalise: a fix that is correct for one consumer is not thereby correct for the others — the rail could tolerate a crude gap because its failure mode was a wall; the pavement cannot, because its failure mode is a hole.** |
| 2026-08-27 | **D-51 · M1 is closed as NOT A DEFECT — the census said don't write the rule** | M1 was filed on a striking number: only ~63 bridge segments in all of Barcelona against ~1,044 tunnels, read as massive under-tagging and recorded as "the root cause of missing railings AND part of the floating roads". Re-measured on the v10 tiles it is starker still — **47 bridges to 864 tunnels out of 39,142 roads, 0.12%.** But `osm-repair-layer.md` §3 gates every repair rule behind a COUNT, so the count came first (`backend/tools/crossingCensus.mjs`): of 19,312 road pairs that cross in 2D, **19,032 are ordinary at-grade junctions, 278 of the remaining 280 are already explained by a bridge or tunnel tag, and 2 are unexplained.** Road×rail adds 35 more, and the examples are dominated by Diagonal/Consell de Cent crossing a TRAM — which is legitimately at street level in Barcelona. **So the 18:1 ratio is real, not a data defect: this city grade-separates by going UNDER.** A repair rule would have been written, bake time spent on it, and it would have fired ~37 times citywide, several of them wrongly. **The gate did exactly its job. Generalise: a ratio that looks impossible in one city can be that city's actual geography — count the defect, do not infer it from an aggregate.** Missing railings on flyovers has a different cause, and R-B1 (protection inferred from the road's own elevation, not from tags) already shipped for it. |
| 2026-08-27 | **D-49 · the guard-rail junction rule only ever saw CROSSROADS, and misses 38.5% of junctions** | User-reported after the R-W1 drive: "in some intersections a railing is there so I can't cross the road." `getJunctionPoints` calls a cell a junction when **two or more road ENDPOINTS** land in it. At a T-junction the side street ends but the through road passes straight through — one endpoint, not two — so nothing is clipped and the through road's rail runs across the side street's mouth. Rails carry COLLIDERS (geometry and collider builders share one mask), so it is a wall, not a cosmetic artefact. **Measured over the shipped v10 tiles: 11,934 of 31,015 junctions (38.5%) are invisible to that rule.** ⚠ **R-W1 did not cause this; it revealed it.** The rail used to sit at half of a 4 m width — INSIDE the carriageway — so it was wrong in a way you drove over rather than into. Now it sits correctly at the kerb, which is exactly where a side street opens. Fixed with an opt-in `includeTees`, used ONLY by the rail mask: lane paint, sidewalks and kerbs share the same blind spot, and opening 11,934 new gaps in all of them at once is a look change to make deliberately (filed **R-J2**), not a side effect of a bug fix. **Generalise: a rule phrased over ENDPOINTS silently excludes every topology where one participant passes through.** |
| 2026-08-27 | **D-50 · I wrote the warning on that function and then walked into it** | `getLoadedRoadSegments` is the SEVENTH field-by-field copy in the road pipeline, and the one D-42 is about. I added a comment to it that morning saying "this projection is a NEW object per road, so anything not copied here simply does not exist — silently, as undefined", and then shipped a width model whose fields it does not copy. Parked cars and pedestrians therefore ran on `roadWidths.js`' fallback table and lost every per-road OSM nuance (a `parking:left=no` kerb, a width-capped Gràcia street). It looked right, because the fallback is derived from the same model. **Writing the warning is not the same as reading it** — the copy site is now in `test/roadFieldPipeline.test.js` with the other six, which is the only form of this lesson that survives the next session. |
| 2026-08-27 | **D-45 · R-W1 — the field it was built on had never been read, and neither had its fallback** | R-W1 was filed as "OSM `width=*` is sparsely tagged and inconsistently means carriageway, kerb-to-kerb or the whole corridor". Measurement found something worse: **`width` is not in `pbfHighways.js` KEEP_TAGS**, so it was stripped before the bake could see it, and `getWidth()`'s first branch — documented as the primary width source — **had never once fired.** Its `WIDTH_BY_TYPE` fallback was unreachable too (it needs `lanes == null`; `getLanes()` always returns ≥ 1). So every width in the city was `clamp(lanes × 3.5, 4, 20)`, and read off the shipped tiles that put **73% of residential, 99% of living_street, 97% of service and 100% of footway/pedestrian/steps at exactly 4 m** — the MIN_WIDTH clamp, enforced on things that are not carriageways. The user's "the road seems short" was not a perception problem and not a length problem: **the streets were a third of their width.** **Generalise: when a ticket describes a data source as unreliable, check that the code reads it at all before designing around its unreliability.** |
| 2026-08-27 | **D-46 · R-W1 — the same whitelist defect as D-42, twice more, in one task** | A road is copied FIELD BY FIELD at six points between PBF and renderer. I added the width section to five of them, ran a 6-minute bake, and got **2,148 road records with the section entirely absent** — `deepCloneRoad` did not carry it. Fixed that, looked again, found `RoadGeometryBuilder` did not either. All 19 width-model unit tests were green throughout, which is D-29 exactly: a suite that only unit-tests the parts of a pipeline can be 100% green while the pipeline emits nothing. **Three occurrences now (D-42 killed a safety gate for its whole life; these two killed a re-bake each), so it stops being a lesson and becomes a test:** `test/roadFieldPipeline.test.js` reads the SOURCE of all six copy sites and fails if any drops a field. Verified it fails when a field is removed — a guard that cannot fail is D-23. **Generalise: a field-by-field copy is a whitelist, and a pipeline of whitelists needs a test that compares them to each other, because no unit test can see between them.** |
| 2026-08-27 | **D-47 · R-W1 — the drawn ribbon is kerb-to-kerb, NOT the carriageway** | The obvious reading of the new model is "draw `carriagewayW`, park cars beside it". That is wrong, and wrong in a way that would have looked like a bug in something else: **a parking bay is asphalt.** Drawing the running lanes leaves a 2.2 m strip of bare terrain down both sides of every street in the city, exactly where the parking lane belongs — and the cars would then appear to float on dirt. `width` is therefore kept as an ALIAS of `kerbToKerbW` so an unmigrated consumer reads the paved surface rather than silently changing meaning, and `carriagewayW` is used only for lane markings and traffic. Pinned by `test/roadWidths.test.js` ("the paved surface is always at least the carriageway"). |
| 2026-08-27 | **D-48 · R-W1 — the binary tile cache never checked its version, which is why `_clearTileCache()` is a manual step** | CLAUDE.md tells every player to run `window._clearTileCache()` after a re-bake or "the browser serves stale (pre-rebake) tiles". Cause found while bumping v9 → v10: `tileParserWorker`'s JSON path compares versions, but the **BINARY path parses whatever IndexedDB holds and serves it, forever**. The manual step existed because the code did not do it. `peekBinaryVersion()` now reads the header version off the cached buffer and evicts a mismatch, so a re-bake invalidates itself. A network-fetched older tile still parses (falling back to `roadWidths.js`' table) rather than failing hard, so a PARTIAL bake degrades instead of blanking. `test/roadFieldPipeline.test.js` asserts the baked version and the parser's constant move together. |
| 2026-08-27 | **D-42 · P4-15a — a projection function is a CONTRACT, and this one had been silently voiding a safety gate since the day it was written** | `tileManager.getLoadedRoadSegments()` does not hand out the tile's road objects; it builds a **new object per road** carrying six fields. Yesterday's R-V1 fix gated street parking on `seg.bridge \|\| seg.isRamp \|\| (seg.layer != null && seg.layer > 0) \|\| seg.crossesTrench === true` — and **not one of those four survives the copy.** Every term read `undefined`, the whole condition was permanently false, and the gate did nothing from the moment it shipped. Nothing throws, nothing warns, and the code reads correctly at both ends: `roadRenderer` and `streetlightRenderer` DO see those flags, because they read the tile entry directly rather than through this projection. Fixed by forwarding the four flags, with a comment at the projection saying it is a contract. **Generalise: when a system reads a property off an object it did not construct, find the constructor. A field-by-field copy is a whitelist, and a whitelist that silently answers `undefined` is indistinguishable from a correct read.** Same family as D-23/D-29 — the code ran, the tests were green, and the thing it was written to prevent was never once prevented. |
| 2026-08-27 | **D-43 · P4-15a — the split's "2 InstancedMeshes" was not reachable, and BatchedMesh was strictly better than the nearest thing that was** | P4-15a inherited "traffic 28 loose Meshes → 2 InstancedMeshes" from the art half, where a Blender kit would have collapsed nine models to a couple of geometries. With no art, nine models means nine geometries, and an InstancedMesh is one geometry — so the honest InstancedMesh answer was **nine** meshes for traffic and nine for parked, and sharing them between the two systems would have meant agreeing on a slice of each instance buffer whose offset moves every time parked cars rebuild, one frame out of step with traffic's per-frame write. `BatchedMesh` gives every instance its own geometry id, so a slot is just a slot: **1 draw for every car in the world, no blocks, no offsets, no ordering requirement between the two update calls** — and `vegPools.js` + `batchedMeshSafe.js` mean the pattern and its traps are already load-bearing here. Also: per-instance frustum culling is turned **ON** in this pool and OFF in vegPools, deliberately — vegPools pays it against 15k+ instances with its own distance LOD; this pool has ~640 instances of 2,189 triangles each and no LOD at all. **The scoped number was a proxy for the goal, not the goal. Beating it by picking a different primitive is not scope creep.** |
| 2026-08-27 | **D-44 · P4-15a — I did NOT re-measure the number the task was scheduled on** | P4-15a exists because a 145 s drive attributed **27.6 ms across 9 long frames and 22.6 MB** to `traffic`. That lap times `trafficSystem.update()`, which is CPU — and reading it, a large share is `buildPath`'s per-point `getGroundY` sampling and its `pts`/`order` array allocations, not the rendering this task replaced. Instancing removes the per-spawn `Mesh` + `scene.add`/`remove` (≈2 of each per frame) and takes 37 objects out of `projectObject`, which is real and lands partly in `rend` rather than `traffic`. **But nothing here proves the 27.6 ms falls.** Do not write a number into the ledger from this session's reasoning — take it from the drive report. Lesson 3 of 2026-08-27 applies to my own claims: a number from a bad baseline is worse than no number. |
| 2026-08-24 | — | Tracker created from the 17-agent master plan | State needed to survive session loss |
| 2026-08-24 | P0 order | Ran P0-07 before P0-13 (sky sweep), against tracker order | Hazard H1 — `patchRoadWash` must be split before anything touches lighting |
| 2026-08-24 | **D-02 · P0-03** | **The plan's premise is partly wrong and the budget is optimistic.** `carModel.js:169` sets `castShadow` on the hero car, so it IS a dynamic caster. At 80 km/h it moves 22 m/s, so the car trigger fires nearly every frame and **the budgeted −1.35 ms does not materialise at the 80 km/h benchmark.** Landed anyway — it is never slower, and it is a real saving when stationary, slow, or in fly mode. **P0-05 must MEASURE it; do not carry −1.35 ms in the budget as fact.** | Implementing it blind would have silently put a phantom saving into the ledger — the exact failure the ledger exists to prevent |
| 2026-08-24 | **D-03 · P0-02** | **Deviated from the plan.** It called for inverting the disposal default to an `ownedMaterial` opt-in, as a P0 blocker. A survey of all 169 material-construction sites found **103 that build a material PER CALL** (urbanFeatureRenderer ×16, roadInfraRenderer ×13), so inverting without a registry to enforce tagging would LEAK them — and long-session heap is a phase gate. Marked the MATERIAL instead (`sharedMaterial.js`): same protection, zero leak risk. **P1-03's materialRegistry should call `markShared()` on everything it owns; the inversion becomes safe then and this module folds into it.** Note both cited "live misses" sit behind disabled CONFIG flags — latent, not breaking. | Better end result within the constraints; not slack, and not a rewrite for its own sake |
| 2026-08-24 | **D-04 · P0-08/11** | Two plan tasks named assets as unreferenced that were NOT. `adventurer`/`punk` are listed in `carModels.js:172` PEOPLE — deleting the GLBs alone breaks ped loading (fixed in the same commit). `public/models/vegetation` is referenced by grass/bushRenderer — **that asset removal moved to P1** to land with its consumers rather than leave the repo naming missing files. | Verifying `file:line` claims before acting caught both |
| 2026-08-24 | **D-05 · scope** | **Multi-city constraint added by Anmol.** Environment styling must be configured so a future Delhi (or any city) bake can carry its own look. Added **P1-26** (region environment profile) and **P1-27** (archive Delhi art rather than delete it). Scheduled in P1, not later, because the art bible normalizes every asset toward "a Barcelona palette" — if that ships as a global constant, adding a region axis later means re-normalizing the whole library. **The asset manifest must carry a `region` field from asset #1.** Barcelona profile only; no Delhi work now. | Explicit user direction + the same irreversibility as the art-direction decision |
| 2026-08-24 | **D-06 · P0-13 CONFLICT — needs a ruling** | P0-13 calls the per-frame `scene.fog.density` write at `main.js:768-770` a bug hiding the DAY 0.0032 / NIGHT 0.0045 presets. But **gotcha G-44 documents it as intentional**: *"Fog is drive-mode only: main.js sets density 0 in drone/free-camera mode and 0.005 in car mode."* Golden rule 3 forbids violating a documented invariant without flagging. **NOT actioned — the rest of the P0-13 sweep can proceed without it.** | A documented invariant outranks a plan item; the plan's authors may not have seen G-44 |
| 2026-08-24 | **D-07 · P0-15 regression, caught by running it** | The speedometer visibility early-out used `canvas.offsetParent === null`. **`offsetParent` is ALWAYS null for a `position:fixed` element**, so the gauge never repainted. Fixed with a rect-based test. **Lesson: this was invisible to `node --check` and to a passing build — only launching the game found it.** |
| 2026-08-24 | **D-08 · measurement hazard** | `main.js:142` sets `renderer.info.autoReset = false` and `:1037` calls `info.reset()` immediately before `composer.render()`. **An async read of `renderer.info.render.calls` from the console lands anywhere and frequently returns 0 or a stale count.** Cost roughly an hour of wrong diagnosis. Only sample it from INSIDE the frame loop after `composer.render()` — which `benchRoute.tick()` does (order verified: reset → render → tick). |
| 2026-08-24 | **D-09 · empty-world scare — NOT a code fault** | Repeated automated navigations left one Chrome profile rendering an empty world. Proved it was not the code by stashing all changes back to `ab60bab` (the build that had rendered a full city) and reproducing the fault. User confirmed the city loads normally. **Do not clear IndexedDB + localStorage + sessionStorage as a diagnostic** — the game keeps mode and day/night state there, and it turned an empty world into a black screen. |
| 2026-08-24 | **D-10 · the capture is at pixelRatio 1.2, not 1.0** | `adaptiveRes` owns pixel ratio and re-applies its CAP from `setSize()`, which runs on init and every resize — so `setPixelRatio(1.0)` at init never held, and two captures were taken at 1.2 before I noticed. **Not re-run, deliberately: 1.2 IS the shipping cap**, so this measures what players actually get. The pin is now re-asserted per frame, so a future 1.0 run is available for a like-for-like gate reading. |
| 2026-08-24 | **D-11 · the frame is bimodal, and the two modes have DIFFERENT causes** | 2474 frames at 60 fps, 1442 at 30 fps, 10 anything else — **37% miss vsync**, and a missed 16.7 ms frame costs a full 33.3. At p95 the GPU is only 15.3 ms of a 33.4 ms frame, so **18.1 ms is NOT GPU** → worst frames are CPU/stream-bound (task #39). But at p50 the GPU is 13.3 ms of 16.7 ms → **the median frame IS GPU-bound with 3.4 ms spare.** Two distinct problems; fixing GPU alone will not move the 30 fps frames, and fixing streaming alone will not create art headroom. |
| 2026-08-25 | **D-12 · P1-01, BC7-vs-BC1 left OPEN deliberately** | The plan called the BC1-over-BC7 `FORMAT_OPTIONS` patch mandatory. It is **not patchable**: `FORMAT_OPTIONS` lives inside the KTX2Loader *worker body* and is not exported. The only main-thread lever is claiming BC7 is unsupported — which fixes ETC1S (8→4 bpp, ~300→~160 MiB on Windows) but also drops **UASTC** to BC1, a real quality loss on exactly the maps that justify UASTC. Exposed as `setPreferBC1ForETC1S()` and left **off**: no assets to measure, and no BC machine here to measure them on. |
| 2026-08-25 | **D-13 · deleting an "off" flag INVERTS it** | Retiring `ENABLE_BUSHES` and `MAX_GRASS_PER_TILE` as dead nearly switched both back ON: `meshMaterializer` tests `CONFIG.ENABLE_BUSHES !== false` (so `undefined` passes) and `vegetationWorker` reads `config.MAX_GRASS_PER_TILE ?? 50000`. Both restored with the trap documented in `config.js`. **Rule: before retiring a flag, read its GUARD, not just its name.** `if (CONFIG.X)` is safe to remove; `!== false` and `?? default` are not. |
| 2026-08-25 | **D-14 · corrected myself mid-commit (P1-16)** | I claimed vendor-cart exclusion zones were running unconditionally and corrupting vegetation placement. Re-checked: the call sits inside `if (CONFIG.ENABLE_VENDOR_CARTS)`, which is false, so it never ran. Vegetation placement is unchanged. Commit amended. **Reading a call site is not the same as reading its guard** — same lesson as D-13, one task later. |
| 2026-08-25 | **D-21 · two regressions I shipped, both caught by the user's console** | (1) P1-15 left a `disposeDecalMeshes` call behind a truthy-empty-array guard → ReferenceError on every tile unload, **aborting the rest of `update()` including the whole LOD/cull pass**, which silently invalidated a benchmark. (2) P1-04's warm list built a plain `Mesh` for the cloud material, whose patch reads `instanceMatrix` unguarded → `VALIDATE_STATUS false` every frame. Fixed architecturally via `requires:'instancing'` + `meshKindsFor()`. **Both were invisible to `node --check`, a passing build, and a short drive — they needed a real session with tile unloads.** The lesson for P2: a green build is not verification. |
| 2026-08-25 | **D-22 · programs at loader-hide fell to 79** (was 141 pre-P1, 186, then 218) | Expected — the warm list now skips invalid mesh/material combinations. **But fewer warmed programs is not automatically better: the gate is the DELTA during the drive, not the boot count.** Unverified until the next `?bench` run. If Δ rises above the 5 measured post-P1, the registry-sourced warm list is running before most materials exist (they are created lazily as tiles build) and needs a second pass after the first tiles land. |
| 2026-08-26 | **D-41 · ⭐ THE LOAD IS FIXED (167.5 s → 22.1 s) AND THE COMPILES HAVE ONE REMAINING CAUSE: THE SECOND compileAsync CALL SITE.** | **Load: `time-to-drive 22032 ms`, then `22136 ms` on a second run** — against 167547 ms and the ledger's 21.1 s baseline. The 8× regression WAS the logging: ~220 `console.warn` lines each carrying a ~50-frame stack trace, captured synchronously by Chrome with DevTools open. The instrument added in D-38 to diagnose the stutter was itself the biggest load cost in the project. **Banked.** **Compiles: not fixed, and the report says exactly why.** Every one of the 224 late compiles carries the same timestamp range — `1.89s→1.94s`. All of them, in one 50 ms burst. That is not streamed tiles introducing variants; it is a single call compiling the entire scene. D-40 fixed the colour space at the boot warm-up and **missed the second call site** — the debounced lightGrid recompile in the animate loop — which still bound no target. So the warm-up compiled 150 programs correctly as `srgb-linear` and 1.9 s later the other site recompiled all of them as `srgb`. Both now go through one `compileForComposer()` helper, and `test/compileTarget.test.js` asserts `renderer.compileAsync` has exactly ONE call site, because two sites drifting apart is precisely what happened. ⚠ **Frames improved even with the burst still present: 11 long frames, p50 74.2 ms, p95 126.8 ms, max 126.8 ms — against 40 long / p95 332.5 / max 974.7 on the previous build.** ⚠ **Still unexplained and NOT to be assumed fixed: `× 4  513` is a genuine novel token (a material flag bitmask) and belongs to no lightGrid group.** |
| 2026-08-26 | **D-40 · THE LOAD: THREE THINGS MADE IT 167 s, AND ALL THREE ARE THE SAME MISTAKE.** | Every one is the warm-up compiling against a state the session does not run in — the rule `armLightGrid()` already states at its call site, broken three more ways. **(1) LIGHT COUNTS** — fixed, see D-39 and G-53. Note the flip happened at program #50, **before** time-to-drive, so ~100 programs compiled TWICE during load. **(2) OUTPUT COLOUR SPACE** — `compileAsync` compiled with no render target bound, i.e. against the canvas (`srgb`), while every frame renders through `composer.render()` into the composer's LINEAR target (`srgb-linear`). The warm-up therefore built a parallel set of programs the session never draws, and the first real frame compiled them all again. The drive shows the pairs interleaved: vegTree/sceneMat/vegBillboard/terrain/roadAO each appear twice, identical but for that one token. Fixed by binding `composer.renderTarget1` around the compile (compile() is synchronous inside compileAsync; only the readiness poll is async, so no frame renders with it bound). **(3) A LEAKED WARM GROUP** — three's own readiness poll threw `Cannot read properties of undefined (reading 'isReady')` from inside `compileAsync`'s setTimeout. That is not a rejection anything can catch, so the promise never settled, `scene.remove(_warmGrp)` never ran, and several hundred hidden `frustumCulled=false` meshes stayed in the scene being drawn every frame for the rest of the session. Now removed on both settle paths plus a 20 s backstop. ⚠ **A FOURTH SUSPECT IS UNMEASURED AND MAY BE THE BIGGEST: the logging itself.** That drive printed ~220 `console.warn` lines, each with a ~50-frame stack trace, with DevTools open — which Chrome captures and renders synchronously. The previous drive on the same build loaded in a fraction of the time WITHOUT the `[variant]` watcher (added the same day in 8eb2b0d). The per-event lines are now deleted, so the next drive settles it. **DO NOT bank a load improvement until one drive reports it — three of these four are inferred from one capture.** |
| 2026-08-26 | **D-39 · ⭐⭐ THE 66 LATE COMPILES HAVE TWO NAMED CAUSES: the CAR'S LIGHTS, and OUTPUT COLOUR SPACE.** | The `[variant]` firehose from a real drive named them, and neither is "streamed tiles carry new variants" as D-38 assumed. **(1) LIGHT-COUNT CHURN.** Programs #1-#49 all carry the light-count tuple `1,0,0,0`; from **#50 onward — the program immediately after `[physics] Rapier enabled`** — every key carries `1,0,2,2`. Light counts are compiled INTO the shader, so the moment the car spawns with its lights, **every material already in the scene is invalidated and recompiles**. The boot warm-up compiles the whole city against a light set that ceases to exist the instant the car appears. **(2) OUTPUT COLOUR SPACE DOUBLES THE SET.** The same material appears twice, byte-identical except `srgb-linear` vs `srgb` — `sceneMat` (#8/#24), `vegBillboard` (#6/#32), `vegTree`, `terrain+lightGrid`, `roadAO+lightGrid`, plain `basic` (#29/#55) all exist in both. Two render paths write different encodings; every material pays for both. **The two MULTIPLY: 4 (lights × colourspace) programs per material.** ⚠ Also caught on the same drive, both unexplained: **the boot warm-up THROWS** — `Uncaught TypeError: Cannot read properties of undefined (reading 'isReady')` from inside three's `compileAsync` — and **time-to-drive read 167547 ms**, an 8× regression on the ledger's 21.1 s. `progs` 148 → 220 = **72 late compiles**, consistent with D-38's 66. **Fix direction, in order: put the car's lights in the scene BEFORE the warm-up runs (or fold headlights into the existing lightGrid uniform path so the count never changes), then settle on ONE output colour space or warm both. Do not chase per-tile variants — that is not what the keys say.** |
| 2026-08-26 | **D-38 · ⭐⭐ CONFIRMED: 66 SHADER PROGRAMS COMPILE *WHILE DRIVING*. That is the stutter.** | `renderer.info` settled it on one drive: `progs` was **153 at time-to-drive** and climbed **183 → 216 → 217 → 218 → 219** as the car moved. **66 new programs compiled after the boot warm-up**, and each one is a SYNCHRONOUS compile on the main thread. That is exactly the `[frame] 359ms — rend 351.0` and `[frame] 429ms — rend 421.6` frames, and it explains why `[perf] shader programs` was never stable run to run (153 / 211 / 212 / 216) — the count depends on how far you drove before it was read. **The boot warm-up covers 153 variants; the city then streams in tiles carrying variants it never saw.** ⚠ This is the FOURTH cause examined and the first one that survives its own test — GPU (D-36), fill rate (D-33) and geometry were each falsified by measurement first. **Fix direction: make the warm-up cover the later variants, or cut the variant count, or ensure materials are actually shared — pick after counting WHICH programs appear late.** Also recorded from the same drive: `geom` 293→453 and `tex` 97→313 climb as tiles stream, which is expected, **but they must come back DOWN on unload and these are long-frame snapshots only — a leak is NOT ruled out and wants its own check.** And allocation is spikier than D-37 implied: `rend` read 7.86 MB and 12.94 MB on some frames but **0.30 MB on others**, and one frame put **12.99 MB in `step`** — so allocation is bursty and not exclusively `rend`. |
| 2026-08-26 | **D-37 · ⭐ THE ALLOCATOR IS `rend` — 7-13 MB PER FRAME inside `renderer.render()`** | The per-section allocation row named it on the first drive: `↳ allocated: rend 12.94MB` … `10.88MB` … `13.17MB` … `12.92MB`. **`rend` wraps `renderer.render()`, which should allocate almost nothing steady-state.** That is the GC churn D-36 identified, and it now has an owner. Same drive also caught **`[frame] 429ms — rend 421.6`** with no section allocating — the signature of a synchronous shader compile. ⚠ **AND `[perf] shader programs` IS NOT STABLE BETWEEN RUNS — 153 here vs 211 / 212 / 216 earlier.** A program count that changes run to run is what recompilation looks like, and each compile builds large source strings, which would explain BOTH the megabytes and the 421 ms frame. **Prime suspect: a material whose `needsUpdate` is being set during the drive, re-running `onBeforeCompile`.** This session added three patch paths — `patchRoadAO`+asphalt, facade/roof arrays, lightGrid — so this is close to today's work and must be checked before anything else. Added `progs · calls · tris · geom · tex` from `renderer.info` to the `[frame] `line: **`progs` climbing while driving proves recompilation; flat `progs` with huge `calls` means per-draw-call churn instead; climbing `geom`/`tex` is a LEAK.** Also note this drive had `rend` DOMINATING many frames (66/68/65/57 ms) where earlier drives had `other` dominating — the picture is not stable, so read the counters before concluding. |
| 2026-08-26 | **D-36 · ⭐ THE FRAME IS NOT GPU-BOUND. It is GC. Every scene-optimisation theory is dead.** | The measurement finally landed, and it is unambiguous: across 20 long frames in dense Eixample, **`gpu` read 7.3-7.8 ms while the frame took 50-76 ms — 12% of the frame on average**, with `other` at **95%**. The GPU is IDLE while the frame burns 50+ ms. Combined with D-33 (49% fewer pixels changed nothing) the fill-rate and geometry theories are both **falsified by direct measurement**, not argument. **No scene optimisation — draw calls, vertices, shadow passes, materials, LOD, batching — can touch a bottleneck the GPU is not in.** The same drive shows what IS happening: the JS heap **sawtooths 405 ↔ 429 MB, over and over**, and LoAF labels the long frames `NO scripts ≥4ms (GC/clone/style)`. A 24 MB swing recovered repeatedly is allocation churn, and the pauses are the collector. **This retires the ledger's "non-GPU share" framing as too vague and replaces it with a named cause.** Next question is no longer WHERE the time goes but WHO ALLOCATES — cpuTimer already measures heap growth per section and simply never printed it; the `[frame]` line now emits `↳ allocated: <section> <n>MB`. ⚠ **Do not start any geometry, shadow, or draw-call work on the strength of the old theory.** Also seen: one frame at `hud 33.9 ms` and `step 10.8 ms`, so the HUD is a live suspect for both time and allocation. |
| 2026-08-26 | **D-35 · the long-frame instrument was BLIND, and it failed intermittently — which is worse than failing** | The drive commissioned to read D-34's new `gpu` number produced **not one `[frame]` line**. Cause: `longSeen++` increments inside `cpuTimer`, but `main.js` DISCARDS every report until the car is drivable (`if (_timeToDriveMs == null) return`) — deliberately, since loading is expected to be slow. So a **21 s load spent all 40 report slots on frames that were thrown away**, and no `[frame]` line could print for the rest of the session. The previous drive loaded in **12 s**, left slots over, and produced data — **the same build was blind on one run and fine on the next, decided by load time**. That is worse than an instrument that fails outright, because the empty output reads as "nothing to report". Fixed with `holdLongFrames()` / `armLongFrames()`: the budget is HELD during load and armed with a FRESH count at time-to-drive. 2 tests, both verified to fail without the fix. **Lesson: a budget consumed by work whose output is discarded is not a budget, and an instrument must be tested for the case where it produces nothing.** |
| 2026-08-26 | **D-34 · `other` at 94% of the frame is NOT an answer — the long-frame log now names the GPU share** | A dense-Eixample `?debug=loaf` drive produced the cleanest evidence yet, and it eliminates almost everything: **`other` averaged 94% of a 50-80 ms frame** (19 of 22 sampled), every named section — `traffic` `step` `hud` `phys` `tiles` `sky` `roadq` `ui` `lgrid` `adaptRes` — read **~0**, `rend` read **1.2-2.2 ms**, LoAF put the rAF callback at only **5-15 ms**, and **not one long frame carried an `⟨async:⟩` tag**, which rules out tile-build chunks. So ~50 ms per frame is spent with our JS doing nothing. `other` is defined as `wall − Σsections`, so it names GC, GPU wait, compositing and browser scheduling **all at once** — three different problems with three different fixes. Added `gpu <n>ms (<n>% of frame)` and `heap <n>MB` to the `[frame]` line, because that single number splits it: GPU near frame time ⇒ GPU-bound; GPU small ⇒ GC or scheduling, and no scene optimisation touches it. **Resolution is already falsified as the lever (D-33), so a GPU-bound reading means GEOMETRY — draw calls, vertices, shadow passes — not fill rate.** Prime suspect: the shadow map is a fixed 1024² that re-renders every caster and is therefore completely indifferent to pixel ratio, which fits D-33's negative result exactly. **Do not act on this until the number is read.** |
| 2026-08-26 | **D-33 · "GPU-bound" is NOT "fill-rate-bound", and adaptiveResolution was burning ~590 ms a drive on the difference** | A dense-Eixample `?debug=loaf` drive showed the controller stepping **1.12 → 1.04 → 0.96 → 0.88 → 0.80** — **49% fewer pixels shaded** — while the long frames stayed at **50-90 ms throughout**. Five reallocations cost **~590 ms of hitches**, and the cost per resize **GREW from 70 ms to 144 ms**. Its `GPU_BOUND_SHARE` gate was satisfied: the GPU genuinely was busy. But a frame limited by **draw calls and vertex processing** shows a busy GPU while being completely **indifferent to resolution** — so the gate proved the wrong thing. Halving the pixels is itself the experiment that distinguishes the two, and it came back negative. **The controller now VERIFIES its own lever**: after a drop it compares the new frame average against the one that triggered it; two ineffective drops (<5% gain) and resolution is **locked out and the whole streak restored** — not just the last step, which a test caught. Cooldown is now cost-aware (a 144 ms resize rests proportionally longer). `?adaptres=0` added as an attribution switch. **The wider lesson: a mitigation that is never asked whether it worked will happily pay unbounded cost forever.** 3 tests. |
| 2026-08-26 | **D-32 · an `onBeforeCompile` injection can only touch what is in scope AT ITS INJECTION POINT** | P3-07's asphalt patch wrote `roughnessFactor` right after `<color_fragment>`. three declares that in `<roughnessmap_fragment>`, which comes LATER in the fragment shader, so it was an undeclared identifier and the road shader failed to compile — **every road in the city vanished**, leaving lane paint and crosswalks (separate materials) drawn over bare terrain. The console named it exactly: `ERROR: 0:995: 'roughnessFactor' : undeclared identifier` / `'assign' : l-value required`. A second, independent reason it could never have worked: `patchRoadAO` is shared with `MeshLambertMaterial` surfaces, which have **no roughness at all**. **This is the third shader-injection failure in two days with the same shape** — D-30 (`vMapUv` exists only under `#ifdef USE_MAP`), the facade `mat.map = null` near-miss, and now this. **Generalise: before injecting, know (a) which identifiers exist at that chunk, and (b) EVERY material type the patch is applied to — a shared patch is only as portable as its least-featured material.** Guarded by a test that greps the injected GLSL for later-stage identifiers. Also: keep GLSL template literals free of BACKTICKS — one used to quote an identifier in a shader comment closed the template and broke the build, twice. |
| 2026-08-25 | **D-31 · the texture does not own building colour — the VERTEX COLOUR does** | P3-04's placeholder facade layers carried plaster tints (`#d8cfc0` … `#a88f7f`). Buildings went black — some of them, varying per building. Two wrong diagnoses were tried first (a `vMapUv` compile error, then an incomplete mip chain); the console then showed **no shader errors and both arrays complete**, killing both. **The user identified it: "we have some logic to give colours to these buildings".** `buildingWorker.js` bakes the palette pick into the VERTEX COLOUR and keeps every facade material deliberately WHITE ("DRAW-CALL COLLAPSE") — so the chain is `white(material) × vColor(palette) × facadeTexel`, and a tinted layer multiplies a tint that is already there. Measured: an industrial layer at linear 0.392 against a mid-dark palette entry at 0.25 gives **0.098 — black**; near-white 0.847 gives 0.212 and preserves the palette. Placeholders are now near-white so the layer MODULATES (window rows) and colour stays where it lives. **⚠ OPEN FOR P3-05:** its albedo is specced with "weathering baked in", i.e. the ART owning colour — which collides the same way. P3-05 must pick ONE owner: neutral layers keeping the palette, or coloured layers with `getFacadeTint` neutralised. It cannot have both. **Generalise: before replacing a texture in an existing shading chain, find out what ELSE multiplies into that colour.** |
| 2026-08-25 | **D-30 · a shader patch must not reference three's CONDITIONAL varyings** | The P3-04 facade patch sampled with `vMapUv`. three declares `varying vec2 vMapUv` **inside `#ifdef USE_MAP`** (`uv_pars_fragment`), so any material without a bound `map` has no such varying — and the glass facade path is a `MeshPhongMaterial` that does not bind one. Result was a COMPILE ERROR, not a fallback: `ERROR: 0:887: 'vMapUv' : undeclared identifier`. **Every wall in the city vanished**, leaving only the unpatched roof and detail materials (read on screen as "only shopfronts and terrace lines"), plus frame lag from three retrying the broken program per material key. Two wrong fixes were considered first — keeping `mat.map` bound would have rescued only the materials that HAD a map, which is the Lambert path and not the Phong one. **The patch now carries its own `vFacadeUv` varying filled from the stock `uv` attribute, so it is independent of which maps a material binds.** Four tests assert the generated GLSL references no map-conditional varying. **Generalise: `onBeforeCompile` runs against a shader whose varyings depend on the material's OWN texture set — only `position`, `normal` and `uv` are guaranteed. Anything else must be declared by the patch.** |
| 2026-08-25 | **D-29 · fifteen green unit tests while the city had no buildings** | The P3-01 pre-pass referenced `cx`/`cy` — the BUILDING's centroid, computed per-building INSIDE the main loop — from outside it. Every tile threw a ReferenceError; **not one building rendered anywhere**. It survived because the entire building test suite exercised `extrudePolygonWallBands`, `createFairBudget` and friends **directly, and never once called `processBuildingsInWorker`**. Every piece was correct; the pipeline was dead. It was found by driving, not by testing. Fixed, and `test/buildingWorker.smoke.test.js` now calls the real entry point across the height range, every painted category, a 200-building tile and degenerate input — verified to earn its place (7 failures without the fix, 0 with). **Generalise: a suite that only unit-tests the parts of a pipeline can be 100% green while the pipeline produces nothing. Every worker/entry point needs at least one test that runs it end to end on real-shaped input.** Related to D-23 (a measurement that measures nothing reports PASS) — same family: green means green only if something was actually exercised. |
| 2026-08-25 | **D-28 · the anti-confusion constant was itself measured from the wrong reference** | `BAKED_SURFACE_ABOVE_ROAD_Y` existed so paint could be checked against the DRAWN asphalt rather than the deck. Its value (0.079) was base-relative; its name and docstring said deck-relative. The gap is exactly `ROAD_VISUAL_ABOVE_TERRAIN` (0.05). It had no production call sites, and the one test that used it wrote `lift - CONST + ROAD_VISUAL_ABOVE_TERRAIN` — cancelling the error back out inline, which is precisely why nobody saw it. Corrected to 0.029 and the compensation removed; the arithmetic is identical, so no assertion changed meaning. **A constant whose whole job is to stop reference-frame mistakes is not exempt from reference-frame mistakes, and a test that silently compensates for one will hide it forever. Trust the docstring in a new test; if it fails, one of the two is lying.** |
| 2026-08-25 | **D-23 · the light-grid spike's first PASS was a false pass** | Two runs both reported PASS with **three of four deltas NEGATIVE** — the grid measuring *faster* switched on, which is impossible for added shader work. Cause: `setLights(stubSpikeLights(...))` ran once at arm time; the grid **window** follows the camera but the **lights do not**, so after ~200 m of driving every visible cell was empty, all 4 slots failed `id < 0.5`, and the loop cost one texture fetch. Most of a 25 s drive measured an empty shader. Fixed by re-placing the stub lamps on every cell crossing, **and** by adding a proof-of-work stat (`cells lit`, `lights per lit cell`) that makes the A/B report **VOID** instead of PASS when the grid was empty. **Generalise this: a cost measurement is only meaningful if there was work to cost, and the output must show that it was — otherwise a no-op reports green and nobody can tell.** |
| 2026-08-25 | **D-24 · the BatchedMesh trap is real, but both of the audits' claims about it were wrong** | Verified in three 0.183.1: `setGeometryIdAt` (`:1185`) is indeed the only instance mutator that skips `_visibilityChanged`, and `onBeforeRender:1507` early-returns without it in exactly our pool config. But **(1) vegPools is not currently broken** — `remove()` hides a slot before freeing it, so `allocSlot`'s `setVisibleAt(id, true)` is a real transition and does publish the swap. Safe by a coincidence between two functions, documented at both sites now. **(2) The audits' fix does not work.** `setVisibleAt` early-returns when the value is unchanged (`:1151`), and an LOD band swap keeps the instance VISIBLE — so "call setVisibleAt afterwards" is silent too, and the band never fires. **The failure the audits wanted to prevent was reachable through the fix they proposed.** Use `setGeometryIdSafe()` (`batchedMeshSafe.js`), which sets the flag explicitly and skips it on a no-op swap (publishing a non-swap forces a walk of every instance — 15k+ per pool). Found by writing the test, not by reading the code: the first version of the test FAILED, and the failure was the finding. |
| 2026-08-25 | **D-25 · the benchmark is structurally blind to the biggest hitch we have seen** | The new frame attributor caught `[frame] 51ms — post 46.5` on a real drive (normal frame: `traffic 2.3 · other 1.9 · rend 1.7`). `adaptiveResolution.apply()` reallocates every render target in the composer chain, bloom's mip pyramid included; its own comment at `:26` already said so and it had never been timed. **`main.js` runs `if (!_BENCH) adaptiveRes.tick()`, so `?bench` never triggers a resolution change — every v3 baseline is blind to this stall while a player meets one every ~4 s (COOLDOWN=240).** Pinning remains correct for comparability (an unpinned run measures "did the controller give up"), so the fix is NOT to unpin the bench but to measure this separately. **A clean bench run is not evidence that this does not happen.** Suspected feedback loop to check: the frame is bimodal (60/30), so a few missed vsyncs drag the 45-frame average past `SLOW_MS`, triggering a drop that itself costs ~46 ms and causes more misses. `apply()` now times itself and warns over 8 ms. |
| 2026-08-25 | **D-26 · road paint contrast is an ASPHALT problem, not a paint problem** | Measured: our paint (material `0xC4C4C4` x vertex `0xf5f5f5`) has luminance **0.738** — which is correct, real fresh road paint is ~0.75. Our asphalt `0x4A4A4A` is **0.290**, while real asphalt is **0.07–0.12**. So paint-to-asphalt contrast is **2.5x against a real 8.3x**, and markings read dull not because the paint is wrong but because there is nothing dark for them to stand against. **Do not "fix" this by brightening paint** — it is already at physical reflectance, and pushing it higher puts it back over the 0.72 night bloom threshold, which is the bug just removed from the lane arrows. The lever is `REGION.palette.asphalt`, and it is an art-direction change affecting DAY as much as night, so it needs sign-off rather than a unilateral edit. ETS2's asphalt is also much darker than ours. |
| 2026-08-25 | **D-27 · correcting my own P2-08 diagnosis: both paths DID normalise** | I wrote that road mesh and decals used two different elevation normalisations. Wrong — `interpolateAlongPolyline` calls `normRoadElev` (`roadInfraRenderer.js:177-179`), so both apply the same transform. The real defect was narrower and worse: **the decal path never applied `ROAD_VISUAL_ABOVE_TERRAIN`**, which was module-local to `roadRenderer.js` and therefore unreachable from `roadInfraRenderer.js`. So "0.06 above the road" was really **0.01** above it — no clearance for a triangulated ribbon with crown or junction blend. Worse, **drain covers used a bare `ROAD_Y_OFFSET` with no elevation term at all** (an absolute 0.11): correct at sea level near spawn, metres wrong on any sloped street. Also found and deleted `SIDEWALK_Y_OFFSET` — a SECOND sidewalk convention (terrain + 0.08) disagreeing with the live one (road surface + kerb = terrain + 0.17) by 9 cm, with zero call sites: dead, but a trap for whoever wired it up next. Fix: `groundLayers.js` now owns the physical stack beside the depth order it already owned, and a test asserts the two agree — **a class drawn on top must also BE on top**, or which one wins becomes a function of viewing angle. |
| 2026-08-25 | **D-19b · P2 ORDERING SHOULD CHANGE, on measured evidence** | The v3 plan's P2 spends 6 days on `staticPools` (per-instance LOD) to buy GPU headroom, then 5 on the light grid. The post-P1 baseline says the GPU is **not the constraint**: p50 **8.02 ms** against a 16.7 ms budget, and **19.9 ms of the 33.7 ms p95 frame is not GPU at all**. The frame is bimodal — 60 fps or 30 fps, nothing between — and the 30 fps half is CPU/stream-bound (`[loaf]` 100–380 ms spikes during tile stream-in). **Recommendation: bring task #39 / stream-in forward ahead of staticPools; keep the light grid, since night has no punctual lights and that is a LOOK problem, not a perf one.** Not yet actioned — it is a plan change and belongs to the user. |
| 2026-08-25 | **D-18 · post-P1 measurement, read carefully** | `docs/context/v3-baseline-post-p1.json`. **The pixel-ratio pin finally held (1.0), and the P0 baseline was 1.2 — so GPU figures are NOT comparable.** Dropping 1.2→1.0 removes ~31% of fragments on its own; do not claim the GPU p50 13.31→8.02 as a P1 win. Trustworthy because pixel-ratio-independent: **draws 261→246 ✅**, **programs Δ8→Δ5 ✅** (gate 0 — road/terrain materials still unwarmed), **triangles 1.88M→1.96M ⚠ UP**, which should have FALLEN given the culls added and is unexplained; the driver reported 2 collisions and a reverse, so tile residency differed. Heap −9.6%→+56.3% against a ≤+15% gate: probably GC timing rather than a leak, but unproven. **19.9 ms of the 33.7 ms p95 frame is not GPU — CPU/stream is now clearly the dominant cost.** THIS FILE IS THE NEW REFERENCE; future runs compare to it at pr 1.0. |
| 2026-08-25 | **D-16 · ⚠⚠ THE FLAG-GUARD TRAP, THIRD OCCURRENCE (P1-25)** | I read `createTramMeshes` being called with no CONFIG check and concluded the flag was ignored. **The guard was one layer down** — `railwayRenderer.js:119` tests it and returns null — so trams were OFF, and deleting the flag would have turned them ON as a silent visual change. Caught before shipping; flag restored. Preceded by `ENABLE_BUSHES` (`!== false`, D-13) and `MAX_GRASS_PER_TILE` (`?? 50000`, D-13). **RULE, now three times earned: before touching a CONFIG flag, grep it across the WHOLE codebase and read every guard — the name, the call site and even the immediate caller are not enough.** |
| 2026-08-25 | **D-17 · P1-11 deferred to P2, on evidence** | The task is a per-MESH bounding-sphere LOD fallback. But `perf-audit.md:24-25` records that buildings merge per-material into meshes whose **AABB spans the whole 500 m tile** — so per-mesh distance ≈ per-tile distance for the family holding the 3.0 ms. It would deliver ~nothing while editing the mirrored-coordinate boundary that CLAUDE.md's top-of-file DANGER note is about. Folded into P2's `staticPools`, where per-INSTANCE is the real fix. Not slack — the cheaper option was measured against its own premise and the premise failed. |
| 2026-08-25 | **D-15 · I committed a broken build (P1-21)** | My GLSL comment contained backticks around a variable name, which closed the enclosing JS template literal. `node --check` caught it — but my `git commit` ran as a SEPARATE shell command after the failed check, so it committed anyway. Amended. **Process fix adopted for the rest of P1: the commit is chained into the same `&&` as the build, so a failed check cannot be followed by a commit.** |
| 2026-08-24 | **OPEN QUESTION → P0-05** | At night the sun is a 0.7-intensity moon (`envToggle.js` NIGHT `dirIntensity: 0.7`). A full shadow depth pass runs every frame for shadows that may be near-invisible. **Dropping or halving shadow work at night could be worth far more than S1 at the exact regime that binds.** Needs a night A/B before proposing — it is a visual change and belongs to the user | Raised while implementing P0-03; not acted on |

---

## ✂ Cut list — do not silently re-add

These were cut in planning with a stated quality cost (master plan §3.7). Re-adding one is a
scope decision that belongs in the decision log, not a quiet commit.

Rain (all three implementations) · pedestrian art rebuild · `greensRenderer` as a surface ·
separate sea mesh · marina boats · second hero facade tier *(the cut the judge was least
comfortable with)* · second asphalt variant · direction boards + gantries → P4 · window recesses ·
scooters *(first restore if the vehicle kit lands under estimate)* · Milky Way / moon phase /
zona30 stencils / tactile paving

---

## ☠ Kill criteria — stop and re-scope if any measures true

Full text in master plan §11.2. Summary: per-object LOD returns <2.5 ms **and** the per-mesh
fallback also underperforms · the light-grid spike exceeds 3.0 ms for 32 lights · night GPU cannot
hold ≤15 ms after P2 · time-to-drive regresses >3 s · texture VRAM exceeds 300 MiB on the BC path ·
a blind screenshot A/B after P1 shows no perceived improvement.
