<!-- REBUILD + BUDGET JUDGE output, v3 multi-agent run 2026-08-24. Binding verdicts + the
     reconciled budget. Summarised in v3-master-plan.md §1 and §3 — this is the unabridged source. -->

# v3 REBUILD + BUDGET JUDGMENT — BINDING

Verified independently before ruling: `roadRenderer.js:301-311` is `patchRoadWash(new THREE.MeshStandardMaterial({roughness:0.9, metalness:0}))`; `grep -rn autoUpdate frontend/src` returns exactly one line (`main.js:969`, the lying comment) with no assignment anywhere; 33 live `MeshStandardMaterial(` sites; `tileManager.js:57` `GRID_RADIUS=1`, `:58` `LOOKAHEAD_RADIUS=2`, `:59` `UNLOAD_DISTANCE=2` (eviction, not draws); `scene.js:526` `antialias:false`.

---

## 0. THREE RULINGS THAT RE-FRAME EVERYTHING BELOW

**R-A — THE BUDGET FRAME IS WRONG IN BOTH DIRECTIONS.** The "26.3 vs 15.0" table treats the frame as starting at zero. It does not. Measured night Eixample at 80 km/h is **13.0–13.6 ms** (changelog round 9). Every audit costed itself gross against 15.0, and several gross figures re-declare spend already inside that 13.3. **The plan is hereby restated as: measured baseline + Σ(NET marginal deltas) ≤ 15.0 ms, with each shared saving allocated to exactly one owner.** Under that frame the plan fits at 14.05 ms with 0.95 ms margin — but only after the cuts in §4.

**R-B — RESIDENT-TILE DENOMINATOR IS 9–18, NOT 25.** `GRID_RADIUS=1` → 9 built; `dynLookahead = 2 + min(2, floor(kmh/75))` (`tileManager.js:2718`) adds a directional fan of ~6–9 at 80 km/h. `UNLOAD_DISTANCE=2` is the *eviction* radius (≤25 **cached**). The fog block at `:2916` hides everything past 280 m nearEdgeDist — with one exception, the road family, exempted at `:2954`. Roads reach ~25 drawing tiles *only because of that exemption*, which road-surface W7 deletes. **Every per-tile draw and triangle figure in all 12 audits is re-derived at 9–18. Six different denominators (4 / 5 / 9 / 12 / 15 / 25) are struck.**

**R-C — THREE CENSUS FIGURES ARE CORRECTED AND ARE LOAD-BEARING.**
| Figure | Audit said | Corrected (all 426 tiles) | Consequence |
|---|---|---|---|
| Shops parsed & discarded | 2,923 | **14,542** (13,551 named) | DATA case 5× stronger; wiring `data.shops` is now the best 0.5 d in the programme |
| OSM traffic signals discarded | 807 | **4,225** | same |
| Named road records | 8,966 | **42,876** of 53,895 | signage text-atlas sizing is **unvalidated**; re-run before committing 128 cells |
| Night emissive atlas | 85.3 MiB (structural) | **55.9 MiB (measured)** | GRID 4→2 reclaims **-41.9**, not -64 |
| `road.surface` coverage | 82.3% | 67.1% of all records / 82.3% of the 12,912 drivable subset | ~41,000 non-drivable records make W4's DELETE *larger* than claimed |

---

## 1. FINAL BINDING VERDICTS — ALL 12

| # | Subsystem | Auditor | Challenger | **BINDING VERDICT** | Ruling |
|---|---|---|---|---|---|
| 1 | Road surface / markings / curbs | REFACTOR | REFACTOR (resequence) | **REFACTOR** (module) + **REBUILD** (material/shader) + **DELETE** ×4 Delhi subsystems | Verdict stands. Challenger's resequencing ACCEPTED: analytic paint lands **before** the Y-lift deletion. |
| 2 | Road furniture / guardrails / bollards | REBUILD | REBUILD (invert phases) | **REBUILD** | C1 reproduces to the feature (7 `guard_rail`, 3 `jersey_barrier` of 2,890 barriers city-wide). Data source is empty; no patch reaches the bar. Phase inversion ACCEPTED. |
| 3 | Building geometry + facades | REBUILD | stands | **REBUILD** | 21–25 texels/m vs an 85–150 bar; a 4-vertex wall quad has no storey structure to texture. Keep worker transport + per-material-key merge + vertex-colour tint collapse. |
| 4 | Roofs / shopfronts / awnings / terraces | REFACTOR | **SPLIT: ground-floor kit = REBUILD** | **SPLIT — roofs/parapets/clutter = REFACTOR; ground-floor kit = REBUILD** | Challenger WINS. Verified: `shopfrontRenderer.js:74-88`, `awningRenderer.js:60-90` push position/color/index and **no uv**; all three renderers dress the **longest edge only**; `MAX_SEGS_PER_BUILDING=4 × SEG_LEN 3.4` = 14.8 m of a 60–70 m Eixample frontage, and `shopSegSkipped` drops 35% of that. There is no bay model, no edge model, no UV model to texture. |
| 5 | Signage | REBUILD | stands-but-incomplete | **REBUILD** | Three independent arithmetic walls confirmed. Text-atlas sizing **re-derived against 42,876 named records before commit**. |
| 6 | Vegetation | REBUILD | REBUILD; greens = **DELETE** | **REBUILD** (art path) + **DELETE greensRenderer.js** | 20-face convex solid has no alpha edge to cut. greens DELETED as a surface — parks become a weight channel in the terrain splat terrain is building anyway. Recovers 2.5 d, ~17 draws, one polygonOffset class, and the `patchAoDarkening` glow-hack. |
| 7 | Terrain / hills / coast | REBUILD | REBUILD, minus sea mesh | **REBUILD** (surfacing + delivery); **sea mesh DELETED** | Verified: the *only* ground texture fetch is compiled out in the shipped rally path — `diffuseColor.rgb *= 0.98` (`terrainRenderer.js:892-895`). Splat case unanswerable. Sea mesh loses to water W8. |
| 8 | Water | REBUILD | REFACTOR | **DELETE `waterRenderer.js` + REFACTOR the terrain sea branch + NEW wet-roads** | Challenger WINS on the word. Deleting 322 lines that have never executed (`ENABLE_WATER:false` since 809bd94) is not rebuilding. `coastline.js` KEEP unchanged. |
| 9 | Sky / clouds / fog / TOD / lighting | REFACTOR | dome = REBUILD | **SPLIT — atmosphere/fog = KEEP on merit; night lighting = REBUILD; dayNight.js+timeSystem.js = DELETE; sky dome = REFACTOR with a texture layer** | Challenger is right that a 3-stop analytic gradient + a hidden night sky is below the domain's own stated bar. Granted at **1/3 the cost**: 2 keys (day/night) not 3, 2048×1024 ETC1S = **2.67 MiB**, analytic gradient retained underneath and cross-fading dawn/dusk. 1.5 d, not 2. |
| 10 | Vehicles | REBUILD | REBUILD assets; peds = DELETE | **REBUILD** (player car + traffic/parked kit); **DELETE** (pedestrian art pass) | V-1/V-2 reproduce exactly by binary GLB parse with correct `byteStride` (32 / 48). Peds: the audit wrote its own kill criterion and then scheduled the 5-day art pass anyway. Kill criterion applied FIRST. |
| 11 | Asset pipeline / materials / LOD | REFACTOR | canvas library = REBUILD | **KEEP** (tile stream/merge) + **REBUILD** (LOD layer) + **BUILD** (asset layer, greenfield) + **canvas-retirement register ACCEPTED** | See §6(a). Challenger's register+lint (1 d) is granted: without it 34 known-wrong RGBA8 canvas textures survive by default because every domain assumes foundation owns them and foundation budgeted 0 days. |
| 12 | HUD / progression | REFACTOR | minimap scheduler = REBUILD | **REFACTOR** + **REBUILD the minimap redraw scheduler** | "It would take a week to re-derive" is sunk cost, which the brief names as not an argument. `minimap.js:390-391` records 10.1 ms ui-thread worst-case *at 99 km/h* — inside the p95 window. Scope: keep the canvas renderer and `citymap.bin` verbatim; rebuild only the scheduler as a pre-rasterised district bitmap panned per frame. 1.5 d, returns ~0.9 ms CPU/frame. |

---

## 2. EVERY REBUILD — THROWN AWAY / REPLACED BY / CARRIED OVER / DAYS

| Rebuild | THROWN AWAY | REPLACED BY | CARRIES OVER (do not re-derive) | Days |
|---|---|---|---|---|
| **Facade generation** | `getWindowTexture` (`meshMaterializer.js:118-365`, ~250 lines of canvas); 1-quad wall faces (`workerGeometry.js:36-125`); 16 boot-time night atlases; `renderLODBuildings` (`buildingRenderer.js:2541-2650`, unreachable after phase 2); first-come `BALCONY_VERT_CAP` race | 3-band modular storey geometry (ground/body/crown, 12–16 verts/face) + 8-layer `CompressedArrayTexture` (albedo/normal/window-mask) + per-building proportional triangle budgets | Worker transport; per-material-key merge; **the vertex-colour tint collapse** (`buildingWorker.js:381-392` — the expensive structural change is already done and is exactly ETS2's bounded-effect-set model) | **17.5** |
| **Ground-floor kit** (new owner) | The four-renderer "co-registration by convention" (`shopfrontRenderer` / `awningRenderer` / `shopSignRenderer` / `cafeTerraceRenderer` each independently re-deriving the longest edge); `SEG_CAP` first-come clipping; the UV-less `quad()` and `pushSegment()` | ONE `map/groundFloorKit.js` owning the bay grid (edge selection, SEG_LEN/stride, skip hash, quantised ground Y), emitting shopfront + awning + fascia anchors as one co-registered result | Placement heuristics; the scattered height constants — `KICK_TOP 0.42 / GLASS_TOP 2.55 / LINTEL_TOP 2.80` (`shopfrontRenderer.js:17-19`), `AWN_TOP_Y 2.9`, `SIGN_Y 3.15 / SIGN_H 0.72` — move together into one module | **5** (replaces ~4.5 d scattered across three domains' P2s) |
| **Road material layer** | `patchRoadWash`'s night half (split out first); marking geometry + dash extraction + junction clipping (70.9 ms `p1 rg:markings` build spike); 7 paint Y-lifts + hidden `+ROAD_ZFIGHT_OFFSET`; edge strips; 5 dead factories | `roadMaterial.js` — world-metric UV from the **already-baked** `halfWidth` attribute, tiling albedo+normal, 8× detail normal, per-fragment macro wear, analytic wheel ruts, analytic lane paint | **`buildFlatRibbonGeometry` strip topology + `roadBaker.js:400-401`'s `uvs.push(u,0,u,1)` / `halfWidths.push(half,half)`** — world-metric V in the vertex shader with **no re-bake**. A rewrite would re-derive strip topology it already has. | **12.5** |
| **Road furniture** | `crashBarrierRenderer.js` (451 L Indian yellow-black); `dividerRenderer.js` (142 L); `reflectorRenderer.js` cat's-eye studs (~42k tris, 18 draws, placed every 6 m on Barcelona tertiary streets today); `MeshBasicMaterial` on all railings (`:2766`, `:2773` — unlit metal cannot catch a headlight) | Derived placement (road class + geometry + terrain) → W-beam ribbon emitter + global `BatchedMesh` pools for posts/bollards/delineators/jersey; Lambert + map + normalMap | `computeGuardRailMask` (`roadRenderer.js:3246`) and `isElevatedGuardRailRoad` (`:3206`) placement logic, extracted verbatim | **11** (was 18.5) |
| **Vegetation art path** | `TREE_VARIANTS` procedural blobs; `ctx.ellipse` billboard atlas; 4 billboard materials/pools; 13,963-instance transparent blob-shadow pool; `greensRenderer.js`; 1,679 lines of dead code | Card trees (3 LOD tiers × N species in ONE pool by `geometryId`); offline-rendered impostors; parks folded into the terrain splat | **`vegPools.js` verbatim** — LIFO free list, never-`deleteInstance` invariant (`:56-61`, O(n log n) blowup), add-reservation accounting, sibling-pool overflow. Rewriting it reintroduces four documented streaming stalls for zero visual gain. | **12** (was 27) |
| **Signage** | 300 per-board `MeshBasicMaterial`s; three unbounded `Map` texture caches with no `.delete`/`.clear` (`:260`, `:456`, `:579`); a 0.750 MiB texture per unique street name; `trafficLightRenderer.js` | `signAtlas.js` + `signPool.js` — one shared atlas material, per-instance `aUvOffset`/`aTint`/`aEmissive`; bounded LRU R8 text page | **~450 lines of placement logic verbatim** (`generateDirectionBoards :977`, `generateGantries :1131`, `generateSpeedSigns :724`) | **9** (was 23) |
| **Night lighting** | Six fakes: lamp emissive×bloom, 16 m ground-pool decals (`POOL_SIZE 16`, `PlaneGeometry(16,16)`, one per lamp at 22 m spacing = >100% road coverage), hero-building spill decals, road night wash, veg night wash, decal colour lift | `lightGrid.js` — world-space 2.5D clustered lighting, 64×64 RGBA8 index over 8 m cells + RGBA32F lamp data, rebuilt only on cell crossing | **`tileManager.getStreetlightPositions()` (`:3482`, exported `:3523`) — ZERO callers today.** The data plumbing is already built. | **9.5** |
| **Vehicle assets** | `bmw_m3.glb` UVs (uniqUV=1 at (0,0) on all 17 car nodes); 9 Kenney GLBs (59 palette UVs on a 1/32 grid); `adventurer.glb` (10,198 tris, fantasy RPG w/ 1,748-tri backpack); `punk.glb`; 18× duplicated 512² colormap | Blender modular kit (6 bodies, 1,800–2,800 tris LOD0) + 2K greyscale-paint atlas with paintjob mask; re-UV'd hero car | Placement (`getLoadedRoadSegments()`), traffic behaviour paths, contact-shadow pool | **19.5** (was 40.75) |
| **LOD layer** | Per-tile `nearEdgeDist` (`:2908-2909`) — one distance value for a 500 m tile in a world where the interesting range is 0–150 m; `BUILDING_LOD_START/END` (a loading placeholder, not a tier) | `staticPools.js` — global `BatchedMesh` pools, `perObjectFrustumCulled=true`, discrete 3-tier bands with hysteresis; worker emits per-building ranges+centroids+radii (postMessage change, **not** a tile format change, **no re-bake**) | `vegPools.js` machinery (generalised, not replaced); `chunkedMerge.js`; `gpuWarmup.js`; the 4-phase tile build | **6** |
| **Minimap redraw scheduler** | The per-move vector re-rasterise (10.1 ms ui-thread, 5.5×/s at speed) | Offscreen district bitmap at 2–3× visible extent, panned/rotated per frame, re-rasterised on district exit (~1 per 30–60 s) | **The canvas renderer and the `citymap.bin` pipeline, verbatim** | **1.5** |

**Total rebuild days: 103.** (Down from the ~200 the same items carried across 12 audits, entirely from de-duplication — not from optimism.)

---

## 3. THE RECONCILED BUDGET

### 3.1 The savings pool — banked ONCE, named owner, phantoms struck

| # | Saving | Value | **OWNER** | Struck from | Phantom removed |
|---|---|---|---|---|---|
| S1 | `renderer.shadowMap.autoUpdate = false` + explicit `needsUpdate` on tile reveal **and** car movement | **-1.35 ms** | **pipeline-materials** (P0, 0.5 d) | sky-atmosphere (-1.2), buildings-facade (-0.6) | **+1.65 ms** |
| S2 | Per-object / per-instance LOD (`staticPools.js`) | **-3.00 ms** | **pipeline-materials** (P2, 6 d) | buildings-facade (-1.4), vegetation (-1.5) | **+2.90 ms** |
| S3 | `RadialBlurPass` delete | -0.70 ms | sky-atmosphere | — | — |
| S4 | `OutputPass` fold into colorGradePass | -0.15 ms | sky-atmosphere | — | — |
| S5 | Fake-night stack deletion (pool + hero-spill decals) | -0.90 ms ⚠ est | sky-atmosphere | — | conditional on light grid |
| S6 | Road-family fog-cull fix (W7) | -0.30 ms, **-25 draws** | road-surface | — | — |
| S7 | Blob-shadow pool deletion (13,963 × 7 m transparent quads, 3–5× lower-screen overdraw) | -1.00 ms ⚠ est | vegetation | — | *distinct from S2 — a blend-pass deletion, not an LOD gate* |
| S8 | Edge-strip subsystem delete (`if(false)` sidewalk branch; 8,588–9,496 tris/tile, `frustumCulled=false`) | -0.20 ms | road-surface | — | — |
| S9 | Street-dressing fog-cull (4 meshes absent from the `hideAll` list at `:2919-2952`) | -0.40 ms | buildings-detail | — | — |
| S10 | `sky.renderOrder` (40 km dome, `depthWrite:false`, no renderOrder) | -0.20 ms ⚠ est | sky-atmosphere | — | — |
| | **TOTAL POOL** | **-8.20 ms** | | | **+4.55 ms of phantom removed** |
| | **After 5% haircut on the three ⚠ estimates** | **-8.10 ms** | | | |

**Vehicles' -0.8 ms (triangle+draw cut) is NOT in the pool** — it is netted inside their own allocation to avoid a fourth double-count.

### 3.2 GPU ms — allocation (NET MARGINAL against the measured 13.3 ms baseline)

| Domain | Gross ask | **ALLOCATED (net new)** | What was removed and why |
|---|---|---|---|
| pipeline-materials | 0.5 | **0.50** | registry chained injection + detail-map fetch |
| road-surface | 5.0 | **1.20** | 5.0 was a **gross frame share** re-declaring ~3.0–3.5 ms of existing road spend; self-flagged LOW confidence (R-17). W1 measurement gates it. |
| buildings-facade | 3.6 | **0.80** | normalMap +0.8, bands +0.15, roofs +0.1, railing card -0.2; **-1.4 LOD credit struck**, -0.6 shadow credit struck |
| buildings-detail | 1.2 | **0.60** | S9 (-0.4) banked separately, not inside |
| ground-floor kit | — | **0.15** | new line |
| signage | 0.6 | **0.45** | |
| vegetation | 3.2 | **0.90** | alpha-test fill + 2-draw depth prepass; **-1.5 LOD credit struck**, S7 banked separately |
| terrain-coast | 2.2 | **0.20** | Self-declared LOW confidence; its own reasoning concedes 5 fetches + ~40 ALU is plausibly **cheaper** than the shipped 5-layer single-octave FBM (250–300 ALU, zero fetches). Ceiling, not spend. |
| water | 1.5 | **0.30** | wet-road shading moved to road-surface; rain CUT; boats CUT; sea contributes 0.0 at the Eixample benchmark by its own admission |
| sky-atmosphere | 4.6 | **2.30** | 2.0 of the 4.6 was already-existing spend (bloom 1.4, grade 0.25, sky/clouds/moon/stars 0.35). Real new = light grid 2.0 + cookie 0.05 + sky texture 0.05 + wet uniform 0.0. Rain CUT (0 at a clear-night benchmark anyway). |
| vehicles | 2.5 | **0.50** | Their own ledger is roughly flat (-0.8 / +0.6 / +0.4 / +0.3). 2.5 was headroom padding. |
| road-furniture | 0.8 | **0.30** | net after deleting reflector studs and dropping `DoubleSide` from 141 km of parapet |
| hud-progression | 0.6 | **0.10** | **no game mode runs at the benchmark** — its real contribution is 0.0 ms |
| **SMAA (NEW — unowned in all 12)** | — | **0.50** | assigned to sky-atmosphere as post-chain owner |
| | **26.3** | **Σ = 8.55 ms** | |

### 3.3 GPU — the sum

```
measured night baseline (Eixample, 80 km/h)        13.30 ms
+ allocated new spend                              + 8.55 ms
- savings pool (banked once, haircut applied)      - 8.10 ms
────────────────────────────────────────────────────────────
PROJECTED p95 NIGHT GPU                             13.75 ms
CAP                                                 15.00 ms
MARGIN                                             + 1.25 ms   ✅ FITS
```
Against the raw asks (26.3) the same sum would be 13.3 + 26.3 − 12.6 (all savings as banked, incl. phantoms) = **27.0 ms**. The 13.25 ms of difference is: **4.55 ms of phantom savings removed** + **13.2 ms of gross-vs-net restatement and cuts**. No arithmetic is fudged; every ms is attributed.

### 3.4 Texture VRAM — allocation

**Baseline today: 95.7 MiB texture + 34.0 MiB EffectComposer/bloom render targets (SKY-11, omitted from every prior table) = 129.7 MiB already spent.**

| # | Retirement | Value | OWNER |
|---|---|---|---|
| V1a | Night emissive atlas GRID 4→2 (identical texel density) | **-41.9** (measured 55.9, **not** the 85.3 structural bound) | pipeline-materials P1, 0.5 d |
| V1b | Night atlas fully replaced by the authored 8-layer window-mask array | **-14.0** (remainder of the same object) | buildings-facade P3 |
| V2 | Vehicle shared-template cache: 512² colormap 18 resident → 1 | **-22.7** | vehicles P0, 1.5 d |
| V3 | Car paint PMREM 256 → 128 | **-4.5** | vehicles P0, 0.25 d |
| V4 | `grass.jpg` 1024 RGBA8+mips — bound, decoded, **never sampled** in the shipped rally path | **-5.6** | terrain-coast P0 |
| V5 | Facade day canvases (8 × 256²) | **-2.7** | buildings-facade P2 |
| V6 | Vegetation unmipped billboard canvas | **-0.5** | vegetation P1 |
| V7 | Signage unbounded per-string texture Maps | **-1.7** | signage P1 |
| | **Total** | **-93.6**, **haircut 15% → -79.5** | |

*(V-geometry: pedestrian vertex buffers 22.8 → 4.5 MiB. Real and worth having, but it is **geometry** VRAM and may NOT be spent against a texture cap. Recorded separately.)*

| Domain | Ask | **ALLOCATED** | Cut |
|---|---|---|---|
| pipeline-materials | 12 | **8** | 4.8 MiB of "ask once" slack |
| buildings-facade | 28 | **20** | the 10 MiB second-hero-facade tier |
| buildings-detail | 10 | **8** | shopfront pair moves to the ground-floor kit |
| ground-floor kit | — | **2** | new |
| signage | 9 | **8** | 1 MiB headroom; text page **stays 2048×1024 R8** (42,876 named records argues for more cells, not fewer) |
| vegetation | 14 | **12** | palm/conifer second sheet |
| terrain-coast | 14 | **7** | the pessimistic 13.4 Windows figure is **not budgeted** — the FORMAT_OPTIONS override is now mandatory |
| water | 6 | **2** | rain/droplet/boat lines cut or moved |
| sky-atmosphere | 42 | **8** | 34 is already-resident RTs (in baseline). New: sky dome 2 keys 2.67 + cloud 1K 1.33 + cookie 0.35 + corona 256² 0.09 + grid 0.04 + **TOD PMREM 2 keys × 1.5 = 3.0** — the last previously booked as "zero bytes" |
| vehicles | 30 | **17** | 9 MiB is geometry (not texture); people atlas 2.8 cut with the ped art pass |
| road-furniture | 5 | **5** | fourth stone pair |
| road-surface | 14 | **8** | second asphalt variant deferred |
| hud-progression | 6 | **2** | the 4.45 MiB expanded-map transient is not concurrent with driving |
| **SMAA (NEW)** | — | **2.2** | edge + blend RTs, area + search LUTs |
| | **191** | **Σ = 109.2** | |

```
baseline (95.7 texture + 34.0 render targets)      129.7 MiB
- retirements (haircut applied)                    - 79.5 MiB
+ new allocations                                  +109.2 MiB
────────────────────────────────────────────────────────────
PROJECTED RESIDENT                                  159.4 MiB
CAP                                                 200.0 MiB
MARGIN                                             + 40.6 MiB   ✅ FITS
```

⚠ **THE OVERRIDE IS LOAD-BEARING, NOT AN OPTIMISATION.** three r183 `KTX2Loader.js:786-805` ranks bptc `priorityETC1S:3` above dxt `priorityETC1S:4`, so Windows/NVIDIA transcodes an all-ETC1S library to **BC7 at 8bpp**. Without the FORMAT_OPTIONS BC1 patch, ~85 MiB of the 109.2 doubles → **~244 MiB, 44 over cap.** One line in `loaders.js`. It is a **P0 blocker on the entire VRAM budget**.

⚠ **The 95.7 measurement must be re-derived from the registry manifest before any domain spends the difference.** My itemised retirements (93.6) nearly exhaust it, leaving only ~2 MiB for ~34 other canvas textures — not credible. The margin above survives a 40% error in the retirement figure; do not plan past that.

### 3.5 Download

**RULING ON THE 11.5 MB RECLAIM — THE MOST CONSEQUENTIAL DOUBLE-COUNT IN THE PROGRAMME.** pipeline-materials P0 and hud-progression P0 bank the *same six files* (`public/modes/*.png` 7.90 MB, `title-bg.png` 1.53 MB — og:image for the placeholder domain `barcelona-drive.example`, real site is drive.anmolbhardwaj.com — `logo-barcelona-drive.png` 0.92 MB). Banked twice, synthesis believes it has 11 MB of phantom headroom.

**Ruling: hud-progression owns it (it owns `index.html` and `escMenu.js:16`); pipeline-materials strikes its line. AND — the cap reads "art library download ≤ 24 MB". Menu PNGs are not the art library. The reclaim is credited as PAGE WEIGHT and may NOT be spent as art-library headroom.** The 24 MB must be met by cuts.

| Domain | Ask | **ALLOCATED** |
|---|---|---|
| pipeline-materials | 0.3 | **0.30** (Basis transcoder 0.217 brotli-measured — not the 0.584 raw figure v2 used) |
| buildings-facade | 5.0 | **4.30** |
| buildings-detail | 2.6 | **2.00** |
| ground-floor kit | — | **0.40** |
| signage | 1.2 | **1.00** |
| vegetation | 3.0 | **2.20** |
| terrain-coast | 1.8 | **1.50** |
| water | 2.0 | **0.40** (boats + rain cut) |
| sky-atmosphere | 1.5 | **1.30** |
| vehicles | 6.5 | **4.50** (people atlas cut) |
| road-furniture | 2.2 | **1.70** |
| road-surface | 3.5 | **2.20** |
| hud-progression | 1.2 | **0.50** (the 1.0 MB of WebP menu panels is page weight) |
| SMAA LUTs | — | **0.10** |
| | **30.8** | **Σ = 22.40 MB — cap 24.0 — margin 1.60** ✅ |

**Page weight, banked once, separately:** −11.5 MB (hud) − 3.09 MB deleted `adventurer.glb`/`punk.glb` (vehicles) − 2.9 MB CraftPix tree set (vegetation, mandatory) = **−17.5 MB**. **Net first-load change: +22.4 − 17.5 = +4.9 MB.**
**Plus, off-budget and larger than everything above:** terrain hands back **383.4 MB** of tile payload (`bakedTerrain` 369.0 + `bakedPhysicsTerrain` 14.4 — `createTerrainTrimesh` at `tileManager.js:1179` has **zero call sites**). Corpus 542.6 → ~175 MB; per-tile fetch 1.27 → 0.41 MB. This touches **none** of the four binding caps — it is a streaming-latency win. It must not be sold as "the item that buys the art", or it gets scheduled ahead of items that do.

### 3.6 Draws and triangles

All figures re-derived at the 9–18 denominator (R-B).

| Domain | Draws ask → alloc | Tris ask → alloc |
|---|---|---|
| road-surface | 110 → **45** (110 was ~2× its own post-W7 steady state of 9–15 tiles × ~4 meshes; the 125–150 baseline is an artefact of the fog exemption W7 deletes) | 180k → **120k** |
| pipeline-materials | 24 → **24** (global pools, does not scale with GRID_RADIUS) | 0 → **0** (creates ~-350k) |
| buildings-facade | 60 → **30** (pipeline owns the pooling delta; facade owns only the 16→2 material-key collapse) | 550k → **550k** |
| buildings-detail | 40 → **25** | 180k → **150k** |
| ground-floor kit | — → **8** | — → **40k** |
| signage | 10 → **10** | 8k → **8k** |
| vegetation | 24 → **20** | 340k → **340k** (a **handback** of ~540k) |
| terrain-coast | 12 → **8** | 120k → **100k** |
| water | 8 → **4** | 30k → **10k** |
| sky-atmosphere | 34 → **26** | 2k → **2k** |
| vehicles | 55 → **45** | 420k → **300k** (PED_CAP 168→60) |
| road-furniture | 24 → **20** | 95k → **95k** |
| hud-progression | 12 → **12** (0 at the benchmark) | 20k → **20k** |
| SMAA | — → **1** | — → 0 |
| | **Σ = 278 / 450 — margin 172** ✅ | **Σ = 1,735,000 / 2,600,000 — margin 865,000** ✅ |

Today's measured 261–289 draws → ~278. Flat. This is a **replacement** of the draw composition, not an addition.

⚠ **The current triangle total does not reconcile and is a P0 gate.** vegetation (851,743, arithmetic-verified: 66/66/46/66, mean 61.0 × 13,963) + vehicles (~1.08 M) + terrain (161,290) + roads (~175k) = 2.27 M of a stated 2.32 M total, leaving ~50k for **all buildings across 9–18 tiles** — while one dense tile alone carries 16.6k walls + ~7k roofs + up to 154k detail. **One capture of `renderer.info.render.triangles` at the benchmark replaces all five estimates before the triangle budget is signed off.** Until then the "1,945,000 fits" conclusion was not supported; the 1,735,000 above is supported only by the same estimates and carries the same caveat — but with 865k of margin instead of 655k.

### 3.7 Every double-count removed, and who lost it

| Double-count | Claimed | Real | Kept by | **Lost by** |
|---|---|---|---|---|
| `shadowMap.autoUpdate` | 3.00 ms (×3) | 1.35 ms | pipeline-materials | sky-atmosphere (-1.2), buildings-facade (-0.6). Also 1.1 d of work items for a 0.1 d fix → 0.5 d. |
| Per-object LOD | ~5.9 ms (×3) | 3.00 ms | pipeline-materials | buildings-facade (-1.4), vegetation (-1.5). **Also double-BUILT: 11 d across two domains for one pool system, with overlapping file ranges in `meshMaterializer.js` (839-900 vs 862-880) and `tileManager.js` (3058-3078 vs 3060-3078) — a guaranteed merge conflict. → 6 d, one owner. Saves 5 d.** |
| Menu-imagery reclaim | 17.8 MB (×2) | 11.5 MB, **page weight only** | hud-progression | pipeline-materials. And **neither** may bank it as art-library headroom. |
| Wet roads + rain + windshield | ~2.7 ms, ~2.1 MiB, 9 d across 3 domains | 0.3 ms wet shading, rain CUT | road-surface (material + uniform), water (puddle mask chunk), sky (weather-state driver) | water loses rain (2 d) and windshield; sky loses its rain pass in v3 |
| Sea normal + shore foam | 0.74 MiB, 2 d, 1 draw (×2) | once | water (`waterChunk.glsl.js`) | terrain-coast |
| Sea sink bake | 4 d, two incompatible depth profiles (-3.0 vs -1.0→-8.0) on `buildRegion.js:1178-1249` | 2 d | **terrain owns the file** (it owns the elevation grid and the `getElevationAt` contract) and **implements water's profile + water's commit-blocking validator** | water loses the file |
| Facade draw collapse | ~-15 draws (×2) | once | pipeline (pooling delta), buildings-facade (material-key collapse 16→1-2 only) | — |
| Triangle headback | ~890k offered (×2) | ~540k (both come from the same LOD change on the same far geometry) | vegetation books its own; pipeline books 0 | pipeline-materials' separate -350k |
| Night atlas reclaim | -64 MiB | -41.9 MiB (measured object is 55.9, not 85.3) | pipeline-materials | -22 MiB of pipeline's headline "-52 MiB net", which becomes **-30 MiB** |
| Vehicles VRAM return | -28.6 MiB against a **texture** cap | -10 MiB texture (the rest is geometry) | vehicles (geometry, recorded separately) | ~19 MiB may not be spent by others as texture headroom |
| Ground light pools | deleted and built simultaneously | extract the decal geometry/material into a shared module first (0.25 d); sky deletes the **streetlamp instances**, not the mechanism; vehicles reuses it | both, at a cost of 0.25 d | neither loses budget |
| Sky TOD PMREM | booked "zero bytes" | **+3.0 MiB VRAM** (2 keys × size 128) — true for download, false for VRAM | sky-atmosphere, now line-itemised | — |

---

## 4. WHAT GOT CUT — AND THE QUALITY COST, STATED PLAINLY

| # | Cut | Recovers | **Quality cost** |
|---|---|---|---|
| 1 | **Rain, in all three implementations** (water's InstancedMesh streaks + windshield quad; sky's screen-space ShaderPass) | 9 d, ~1.0 ms, ~2.1 MiB, ~0.5 MB | **No rain in v3.** Real. But the p95 benchmark is a clear night, so it costs 0 ms there, and it is the single largest duplicated line in the programme. **Wet-road SHADING stays** (0.3 ms) — it is the ETS2 night money shot and is ~70% pre-wired (`roadRenderer.js:304` is already MeshStandard roughness 0.9 and `patchRoadWash` already injects + binds a shared night uniform). |
| 2 | **Pedestrian art rebuild** — apply the domain's own kill criterion FIRST | 5 d, 2.8 MiB, 0.9 MB, ~110k tris | Peds stay untextured palette-GLB figures at ~1/3 the count (PED_CAP 168→60). **This lands *closer* to the ETS2 reference, not further:** V-15 states ETS2 has essentially no interactive crowd, and the P0 per-instance LOD (needed anyway for parked cars) delivers the entire triangle and VRAM benefit the 5-day art pass claimed. |
| 3 | **greensRenderer.js as a surface** | 2.5 d, ~17 draws, one polygonOffset class, one `patchAoDarkening` glow-hack, and the "greens start following terrain" risk | **Negative cost — parks get better.** ETS2 paints the ground; it does not float a co-planar plate above it. A park is a weight channel in a splat terrain is building anyway. Keep only the ~20 lines of polygon-to-weight rasterisation. |
| 4 | **Separate sea surface mesh** (terrain P2) | 3 d, 1 draw, 8k tris | **Zero.** Identical pixels. The sea already rides resident terrain geometry (`aCoast` at `terrainRenderer.js:766`/`:887`, `GRID_RADIUS=1`, FogExp2 0.005 fully attenuating by ~400 m). |
| 5 | **Marina boats** | 2 d, 1.37 MiB, 0.6 MB | The harbour reads empty. Pure content nice-to-have with no ETS2-bar justification. |
| 6 | **Second hero facade tier** (10 MiB slack) | 10 MiB | 8 layers must carry all variety over 40,828 buildings. **Repetition risk is real** — mitigated by keeping the block-aware layer selection + per-building dirt-tint (P4, 2 d, KEEP IT). This is the cut I am least comfortable with. |
| 7 | **Second asphalt variant** (`asphalt_patched_1k`) | 1.5 MiB, 0.5 MB | Less macro carriageway variation. The per-fragment world-XZ macro noise at ~40 m scale covers ~70% of it for 0 VRAM. |
| 8 | **Direction boards + gantries** (signage P3) | 2.5 d | **No motorway signage on the Ronda.** Deferred, not killed — the text-atlas sizing is unvalidated against 42,876 named records (5× the audit's 110-tile figure). Re-run the census first. |
| 9 | **W-beam at-grade extension moved P1 → P3** | risk, not days | Guardrails only on the 183 tiles with elevated road until late. **Correct trade:** the item is HIGH risk, depends on a terrain drop-off query that has already false-triggered once (`gotchas.md:814`), and the audit itself says "if placement scatters W-beam through the Eixample grid it will look actively wrong and the user will reject it." Bollards (pilones) take P1: LOW risk, zero new draws, on every Eixample chamfer, i.e. in frame constantly on the benchmark route. |
| 10 | **3-key TOD sky → 2-key** | 1.5 MiB, 0.35 MB, 0.5 d | Dawn/dusk keep the analytic gradient under a cross-fade. Day and night both get real photographic cloud structure (cropped CC0 Poly Haven sky HDRIs). **This is the challenger's diagnosis granted at 1/3 the cost.** |
| 11 | **Window recesses** (12 cm geometric inset) | 2 d | The normal map carries it at the ETS2 bar. Restore first if days free up and the light grid landed. |
| 12 | **Scooters** | 2.5 d | Loses the single most Barcelona-specific street detail (highest two-wheeler density in Europe). **Flag: first item restored if the vehicle kit comes in under its 8-day estimate.** |
| 13 | **All HUD progression** (garage, districts, landmarks, ownership, fast travel, audio stings) | ~14 d | Deferred by the brief's own sequencing note. **AND the economy's primary money sink is REFUTED, not merely unverified:** hud's P4 car ownership depends on the Kenney city-car GLBs, which the vehicles asset list schedules for DELETION (`*.glb`, 1.72 MB, palette UVs, unfixable). That leaves €1,400 of paint and a €3,000 garage — hud's own words, "roughly 90 minutes of play before the currency becomes meaningless." **Ruling: re-design the sink against the NEW vehicle kit, or find a sink that is not a car. Recorded as a NO, not an open question.** |
| 14 | **Milky Way, moon phase, star size, zona30 stencils, tactile paving, rooftop clutter, terrace props** | ~7 d | Zero cost at the benchmark. |

**Days recovered by cuts: ~52. Days recovered by de-duplication: ~19 (LOD pool 5, ground floor 4.5, sea sink 2, foam 2, rain 4, shadow 0.6, menu 0.5). Days added: SMAA 1.0, quality tier moved to P1 (no new days), rallyStyle ADR + migration 1.0, canvas register 1.0, triangle capture 0.25, patchRoadWash split 0.25, ground-pool decal extraction 0.25, vehicle source survey 0.5.**

**294.65 → ~205 days.** Still ~10 months solo. §7 rules on that.

---

## 5. DAY / NIGHT SPLIT — NIGHT IS THE BINDING REGIME

**The structural fact:** `main.js:192` removed the dynamic PointLights. Lighting is 1 Ambient + 1 Hemisphere + 1 Directional + 2 car headlight SpotLights. `decisions.md` D-08 is the ADR, and its **stated revisit condition is literally clustered lighting**.

| | **DAY** | **NIGHT (binding)** |
|---|---|---|
| Baseline | ~11.5 ms (bloom effectively off: threshold 1.1 vs ACES exposure 1.6 — almost nothing passes the high-pass) | **13.3 ms measured** |
| Projected | ~12.2 ms | **13.75 ms** |
| Normal-map payoff | **Full.** At the scene's 35° sun a normal map on a horizontal road gives ~3.16× N·L modulation; ~1.68× on a sun-facing facade; ~0 on the other three orientations. | **≈0 on facades and foliage without punctual lights.** A normal map's entire night payoff is specular + shadowing response to point lights. |
| Exception | — | **Roads.** The two headlight SpotLights are the only directional light on the road at night, and wet asphalt under them is the one ETS2 night image reachable today. Asphalt is already MeshStandard — the roughness term is free. |
| Foliage | card trees read correctly | **alpha-tested foliage at zero punctual lights is a black cutout — arguably a downgrade from the solid blob, which at least catches the ambient term.** |

### The night gate — binding sequencing rules

1. **`lightGrid.js` is the single highest-value item in v3.** Every facade and vegetation normal map is *economically contingent* on it. Its data feed already exists and is unused (`tileManager.getStreetlightPositions()`, `:3482`, exported `:3523`, zero callers, left over from the deleted PointLight pool).
2. **THE SPIKE IS MANDATORY AND GATES 8 DAYS.** 1 day, 32 stub lights on the road material in one Eixample block, measured at 80 km/h at night. SKY-21's 1.2–2.0 ms is an estimate and is "the single number in this report most in need of a spike." **>3.0 ms → re-scope to a 256 m window and 2 lights/cell before a line of production code.**
3. **NO DOMAIN SHIPS A NORMAL MAP BEFORE THE SPIKE RETURNS.** If the light grid dies (kill criterion K-N below): buildings-facade ships **albedo-only** at P2 (their own stated fallback); vegetation ships **species classifier + wind + park textures only, no cards** (their own stated fallback); roads ship anyway (headlights); **signage becomes MORE important, not less** — at zero punctual lights, emissive plates are the only affordable street-level light source in the game.
4. **ALL-OR-NOTHING COMMIT.** The fake-night stack (pool decals, hero-building spill, road wash, veg wash) dies **in the same commit** as the light-grid opt-in. Half-landed, night double-lights and looks measurably worse than today. Capture 3 committed night poses **before** any of it starts.
5. **⚠ P0 BLOCKER — SPLIT `patchRoadWash` FIRST.** `roadRenderer.js:283-301` carries **both** the deletable night wash **and the v9 baked sky-visibility AO**. Deleting it wholesale silently removes baked AO from every road in the city with **no error**. Split into `patchRoadAO` (permanent) + `patchRoadNightWash` (deletable) **before the lighting work starts**. Assigned: **road-surface P0, 0.25 d.**
6. **Vegetation's night wash is a straight either/or**, owned by the lighting domain: if the light grid lands, `patchVegWash` is redundant and must go; if it slips, vegetation keeps it. Give the material a **compile-time define**, not a hard dependency either way.
7. **The benchmark is night.** Any A/B measured in daylight is inadmissible. Vegetation's own risk note: "a stationary screenshot comparison will look great and the drive test will look terrible."
8. **`renderer.shadowMap.autoUpdate = false` must NOT ship as the flag alone.** The player car is the only remaining dynamic caster — tiles streaming in while stationary would get no shadow at all. It ships with explicit `needsUpdate` on tile reveal **and** on car movement.

---

## 6. THE TWO ARCHITECTURAL QUESTIONS

### (a) Does the tile build / stream / merge / LOD pipeline need a genuine REBUILD for a textured world?

**NO for build / stream / merge — KEEP, on end-result grounds. YES for LOD — and it is genuinely torn out, not tuned.**

Four reasons the tile pipeline stays, none of which is sunk cost:

1. **Texture residency is city-wide, not per-tile.** A shared KTX2 library is loaded once and referenced by every tile. Textures impose **zero** new requirement on tile granularity, tile format, or the streaming schedule. There is no version of "the tiles are wrong for textures" that survives contact with the data.
2. **500 m sectors streamed in a radius around the camera IS the ETS2 architecture** (their `.base`/`.aux` sector grid). We would rebuild toward what we already have.
3. **The expensive structural change a rebuild is usually justified by has already landed.** `buildingWorker.js:381-392`: `getFacadeMaterialKey()` returns `facade_<category>[#hero]_FFFFFF`, `getRoofMaterialKey()` returns the constant `roof_FFFFFF`; colour ships as vertex colours. Facade materials are bounded at **16**, roofs at **1**, regardless of building count. That is *exactly* ETS2's bounded-effect-set model, and it means a textured facade sheet is a drop-in `map`+`normalMap` on 16 existing materials — not an atlasing project.
4. **A rebuild costs ~20 days that buy nothing.** Under the ETS2 calibration the bar is reached by **coverage** — enough surfaces normal-mapped that there is no seam. Twenty days re-arriving at the current architecture is twenty days of coverage not shipped, and coverage is precisely what "better than what we have" means. This is slacking in the direction the brief warns about *second*.

The LOD layer **is** a rebuild: `nearEdgeDist = max(0, centerDist - 250)` (`tileManager.js:2908-2909`) is **one distance value for a 500 m × 500 m tile**, against `BUILDING_MAX_DISTANCE: 250` — so every loaded tile except the diagonal corners renders full-detail buildings at all times. LOD granularity is 500 m in a world where the interesting range is 0–150 m. Per-tile merging additionally destroys per-object frustum culling: one bounding sphere per 500 m mesh means everything behind and beside the camera draws.

**Binding rulings on the LOD rebuild:**
- **ONE owner: pipeline-materials.** `createStaticPool` generalises `vegPools.js`. buildings-facade's `buildingDetailPool.js` becomes a **second geometry source inside it**, not a second module. vegetation's `setLodAt` lands **inside** it, not beside it. As scheduled, all three edit overlapping ranges in `meshMaterializer.js` and `tileManager.js` and are a guaranteed merge conflict. **Saves 5 of 12.5 days and removes a duplicated HIGH-risk item.**
- **ONE implementation of the `bm._visibilityChanged = true` fix.** `BatchedMesh.js:1185-1193` — `setGeometryIdAt` is the only mutator in the file that does not set it, and `:1507-1511` early-returns when `!_visibilityChanged && !perObjectFrustumCulled && !sortObjects`, which is exactly `vegPools.js:45-46`. All three audits independently rediscovered this trap. An implementation that forgets it **appears to work, costs nothing, and changes nothing** — a whole sprint could be spent tuning bands that never fire. Assert it in a test.
- **The 1-day per-MESH bounding-sphere fallback is UNCONDITIONAL P0, not a contingency.** 1 day for ~1.0 of the 3.0 ms at low risk. The BatchedMesh geometry-fragmentation risk pipeline itself flags as highest — buildings have **unique geometry per instance**, so pools must `addGeometry`/`deleteGeometry` on every tile stream, and `_reserveRange` reuses freed ranges only when the new geometry fits — is a real possibility of the 6-day item returning nothing.
- **`GLOBAL_VERTEX_BUDGET` must degrade before it deletes.** `buildingWorker.js:1098-1101` drops **entire buildings** via `continue`. Every geometry the art pass adds silently deletes buildings in exactly the dense Eixample tiles the gate measures, and it will be misattributed as an art bug. Sequence buildings-facade's 100,000 → 220,000 raise **ahead of** buildings-detail's universal parapets, and land the "fix the silent roof drop" item (currently P4) **with** the parapet, not two phases later — a hollow open-topped building under `BUILDING_SIDE = DoubleSide` is a worse artefact than a missing parapet.

### (b) Does MeshStandard come BACK for v3?

**The question is malformed, and all three positions in the corpus argue past a factual error.**

Verified: `roadRenderer.js:301-311` is **already** `patchRoadWash(new THREE.MeshStandardMaterial({ color:0xffffff, vertexColors:true, roughness:0.9, metalness:0, depthWrite:true, side:DoubleSide }))`. Repo grep returns **33 live `MeshStandardMaterial(`** sites. **The "the city is Lambert" premise underneath v2's blanket ruling and underneath SKY-22's entire rationale is false.**

**RULING: there is no city-wide material decision to make. There is an INVENTORY, and it already exists in pipeline-materials' own census.**

| Surface | Ruling | Cost |
|---|---|---|
| **Roads / asphalt / sidewalk / panot** | **MeshStandard — already there. KEEP.** Wet-asphalt specular rides the existing roughness term. | **0 ms, 0 days.** Needs an ADR only to *record* it, since it contradicts v2 §5 Tier 3.2 and gotcha G-28. |
| **Vehicles** | **MeshStandard/MeshPhysical via GLTFLoader — already there. KEEP.** V-16's carve-out is granted as a formality, not a concession. | +0.4 ms (allocated) |
| **Facades / terrain / vegetation / props / signage** | **STAY Lambert.** `MeshLambertMaterial` in r183 takes `normalMap` + `aoMap` with **no tangent attribute required** (`MeshLambertMaterial.js:91,101,160,176`; `normalmap_pars_fragment.glsl.js:15-20` supplies derivative TBN via `getTangentFrame()`). That is the whole ETS2 material model. | 0 |
| **SKY-22's Blinn lobe** | **SCOPED to the Lambert set only**, where it buys punctual-light response. Its stated rationale — "we do not need MeshStandard to get the ETS2 night specular" — is **REFUTED**: asphalt is already Standard. Writing a second, divergent specular model onto Lambert to buy a highlight on a Standard material is net-negative work and puts two specular models in one frame. | ~8 ALU/light |
| **DELETE** | `greensRenderer.js`'s per-tile uncached `MeshStandardMaterial` (dies with the module). `roadRenderer.js:372` `getSharedMaterials` — **17 dead MeshStandard materials, zero call sites.** | −17 materials |

**Net effect of this ruling: kills the v2 blanket ruling, kills SKY-22's stated rationale, grants V-16 for free, removes a spurious blocking dependency from three domains simultaneously, and costs 0 ms and 0 days.** Record as ADR D-19.

---

## 7. MINIMUM SHIPPABLE v3

294 days is ~14 months solo. After de-duplication and cuts it is ~205 days — still ~10 months. **It will not land in one go, so every phase must be independently shippable.**

**The test for v3.0: does ONE drive through Eixample, day AND night, read as "definitely better than what we have"?** Not "is it ETS2." The user's calibration is a comparative, not an absolute.

### v3.0 — THE SHIPPABLE MINIMUM: **74 days ≈ 15 weeks**

**Tier A — Foundation: make it measurable, safe, compressible, AA'd (29.5 d)**

Nothing art-side is honest before these four gates: measurement → KTX2+disposal → AA → LOD.

- P0 (8.3 d): pin three exact 0.183.1 · **invert the shared-material disposal default** (13 untagged sites, not 2 — without it the first shared KTX2 texture is destroyed on the first tile unload) · `shadowMap.autoUpdate=false` with explicit `needsUpdate` · measurement harness (programs delta, VRAM from manifest, disposal assertions, **time-to-drive from navigation-start to `dd-loading` hide** — binding constraint 1 has no metric today) · **one triangle/draw/VRAM capture at the benchmark** · road + terrain gpuTimer brackets · **split `patchRoadWash` into AO + night-wash** · **DELETE the CraftPix set from the served build** (P0, not P4 — `git ls-files frontend/public/models/vegetation` returns 20 tracked files, Vite copies `public/` verbatim into `dist`, it is live on drive.anmolbhardwaj.com **today**, and the free licence forbids redistribution) · delete `adventurer.glb`+`punk.glb` · menu WebP + delete `title-bg.png` · delete `bakedPhysicsTerrain` + `createTerrainTrimesh` · road disposal + polygonOffset assert · sky P0 sweep (fog clobber, sun single-source, cloud/star X-mirror, renderOrder, delete `dayNight.js`+`timeSystem.js`) · speedometer rAF dirty check.
- P1 (21.2 d): `loaders.js` → asset registry **with the FORMAT_OPTIONS BC1 override** · cache/deploy hygiene + `/art/v1/` + `_headers` · **`materialRegistry.js` chaining `onBeforeCompile`** (10 sites own it outright today; gates IBL, light grid, detail map, wet road) · extended warm list incl. BatchedMesh/InstancedMesh variants + the missing `aAO` · encode+normalize pipeline with non-zero exits on colour-space, v-flip and byte ceilings · **canvas-retirement register + CI lint** · **SMAA** · per-mesh LOD fallback · vertex-budget degradation · **quality tier moved P2→P1** (the pipeline must *emit* the variants; retrofitting across ~100 assets is unrecoverable) · **rallyStyle ADR + 7-consumer migration** · all six DELETE items (edge strips, Delhi road subsystems, 1,679 lines of dead vegetation, crash barriers + reflector studs, `trafficLightRenderer`, Delhi commercial detail) · **wire the OSM species pipe** (0.5 d — 35,580 positioned Barcelona trees with 4,919 species tags discarded at `tileManager.js:1469` on every tile load) · **wire `data.shops` + `data.trafficSignals`** (0.5 d — 14,542 named shops and 4,225 signal nodes discarded).

**Tier B — LOD + Night: 15.5 d**
`staticPools.js` (6) · **light-grid SPIKE (1) — GATES THE NEXT 8** · `lightGrid.js` (5) · material opt-in + warm list, same commit (2) · fake-night stack deletion, same commit (1) · headlight cookie (0.5 — one 512² Blender-authored beam pattern, cheapest ETS2-identifiable win in the domain).

**Tier C — First art wave, ordered by pixels-covered per day: 29 d**
- **Buildings (17.5):** proportional triangle budgets (1.5 — takes detail coverage from a median 26.6% to ~100%) · modular storey bands (4 — kills the mid-air shopfront on **88.5% of buildings**, fixes the inert AO fade, creates the array-texture seam) · winding normalisation → FrontSide (2) · facade array material (4) · author the 8 layers (6).
- **Roofs (1.5):** real roof UVs + roof material. **The best ratio in the entire programme** — `getRoofMaterialKey()` is a literal constant, so 1.5 days dresses every roof in Barcelona from one 2K atlas.
- **Roads (6.25):** asphalt shader v2 (3) + asset set (2.5) + kerb (0.75). ~40% of screen pixels, already MeshStandard, highest normal-map return at the existing 35° sun, and works at night on headlights alone.
- **Vegetation (3.5):** species classifier (2) + roadside decimation 2–5 m → 7 m (0.5) + billboard collapse and mip fix (0.75) + global-unison wind fix (0.25). **No re-bake, no art, no KTX2** — real Barcelona species distribution and correct planting density purely from data already on disk.
- **Sky dome texture (1.5):** 2-key day/night equirect from cropped CC0 Poly Haven HDRIs, cross-faded over the retained analytic gradient. Un-hides the night sky.

**v3.0 ships:** normal-mapped asphalt and kerbs; correctly-storeyed, array-textured, weathered facades with working AO and no mid-air shopfronts; a textured roofscape; real street lighting with wet-asphalt response; a textured sky day and night; real Barcelona tree species at correct spacing; SMAA; per-object LOD; −17.5 MB page weight; −79 MiB VRAM; ~13.75 ms night.

### v3.1 — DEFERRED, ~51 days
Terrain splat (6.5 — largely occluded at the Eixample benchmark, which is why it defers, not because it is unimportant) · card trees + atlas (6) · **ground-floor kit rebuild (5)** · signage atlas + pool + text page + fascias (9) · road furniture: bollards → delineators → W-beam (8) · vehicle kit (8) + atlas (3) + rewire (2.5) · hero car re-UV (5, gated behind a **0.5-day documented source survey** — "there is no CC0 library of textured European city cars" is the **only claim in the corpus with no file:line, no enumeration and no search log**, and 13 days ride on it) · minimap scheduler rebuild (1.5).

### v3.2 / post — ~55 days
HUD + progression (re-designed money sink) · billboards + direction boards + gantries · scooters · terraces + rooftop clutter · marina + shore foam · weather presets · window recesses · v10 re-bake items (surface-class byte, analytic paint, splat weights) — **batched into ONE re-bake window with every other domain's need, or the city gets re-baked four times.**

### CUT PERMANENTLY
Rain (×3) · marina boats · pedestrian art pass · separate sea mesh · `greensRenderer` as a surface · Milky Way · zona30 stencils · tactile paving · car-ownership-via-Kenney-GLBs.

### Kill criteria
- **K-N (night):** light-grid spike >3.0 ms → re-scope to 256 m / 2 lights per cell. If the re-scope also fails, **cut the light grid**, keep the fakes, and slip every facade and foliage normal map. Roads and signage ship regardless.
- **K-L (LOD):** BatchedMesh geometry fragmentation throws "Maximum item count reached" or drops buildings in the 10-minute heap-growth loop → fall back to the per-mesh bounding-sphere item, bank 1.0 ms instead of 3.0, and **cut ~1.0 ms from vegetation and buildings-facade in the same commit** (they are then over).
- **K-V (VRAM):** the re-measured baseline exceeds 110 MiB texture, or the FORMAT_OPTIONS override slips → **cut buildings-facade to 6 authored layers (−5 MiB) and drop all normal maps on the mobile tier.**
- **K-A (AA):** if SMAA is not landed before the first normal-mapped asphalt ships, **ship the deletes alone.** Three domains independently state that high-frequency normal maps, alpha-cut foliage and discrete LOD tiers in a zero-AA forward pipeline shimmer worse in motion than what they replace — and it only shows at speed, so a screenshot review will pass it.
- **K-T (time-to-drive):** navigation-start → `dd-loading` hide regresses >1.5 s over today → the hero asset set becomes lazy and the manifest splits. Binding constraint 1 is the product's best feature and there is a 20 s safety net at `main.js:723` hiding the regression until it is severe.

### Six things nobody owned — now assigned
| Gap | Assigned to | Days |
|---|---|---|
| **SMAA / anti-aliasing** — a hard prerequisite in 3 audits, absent from all 21 items of the domain that owns the post chain | sky-atmosphere, P1 | 1.0 |
| **Tunnel + trench interiors** — 944 live lines in `tunnelRenderer.js`, the project's signature corridors, the spawn is at a trench portal, and MEMORY records the walls "read dark" | terrain-coast (surfacing) + sky (portal lighting) | 3.0, v3.2 |
| **`urbanFeatureRenderer.js`** (1,022 L, live, `ENABLE_URBAN_FEATURES:true`) + **`busStopRenderer.js`** (529 L, live, glazed panels + a glowMesh that is one of very few street-level emissive night sources) | signage (they are atlas clients) | 2.0, v3.1 |
| **Trams** — `createTramMeshes` (`tileManager.js:2073`) is called with **no CONFIG gate**, renders untextured today, embedded in the carriageway the road domain is rebuilding | road-surface, as a contract | 0.5 |
| **`rallyStyle` retirement** — 7 consumers, gates ~26 days of vehicle art, owned by nobody, allocated 0.25 d as "not my call" | art-direction judge, P1 ADR + migration | 1.0 |
| **Audio / UI sting API** — 4 duplicated `ding()` synths pointed at a domain that was never commissioned | deferred with HUD; recorded so it does not silently not happen | — |

---

### THE ONE-LINE SUMMARY FOR SYNTHESIS

12 verdicts: **5 REBUILD, 4 REFACTOR, 2 SPLIT, 1 DELETE-plus-REFACTOR.** The tile pipeline **stays**; its LOD layer is **rebuilt** by one owner. MeshStandard is **not a decision** — it is an inventory, and roads and vehicles already have it. The budget fits at **13.75 / 15.0 ms night, 159 / 200 MiB VRAM, 22.4 / 24 MB art download, 278 / 450 draws, 1.74 / 2.6 M triangles** — after removing **4.55 ms of phantom savings, 11.5 MB of double-banked reclaim, 22 MiB of over-credited atlas return, and ~19 days of duplicated implementation**. Minimum shippable v3 is **74 days**, gated on four measurements and one 1-day lighting spike.