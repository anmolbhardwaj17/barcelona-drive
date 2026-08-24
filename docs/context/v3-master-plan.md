# Barcelona Drive v3 — Master Plan

**Branch:** `v3` · **Date:** 2026-08-24 · **Status:** BINDING. This document supersedes `v2-plan-hardened.md` and the 12 subsystem audits in `docs/context/v3-audits/` wherever they disagree. The audits remain the detail reference; this document owns the verdicts, the budget, the ordering, and the cuts.

**Reading order for anyone starting work:** §0 (the target) → §1 (your subsystem's verdict) → §2 (the art bible — binding on every asset you touch) → §4 (which phase you are in) → §5 (your playbook) → §11 (the gate you must pass).

---

## 0. The target

### 0.1 The user's calibration, verbatim

> *"I want the feel like Euro Truck Simulator as reference, those kind of textures and all. THOSE ARE NOT TOO GOOD BUT DEFINITELY BETTER THAN WHAT WE HAVE."*

> *"if we have something 60% done but best way to do is something we have to start from scratch, we'll start from scratch."*

These two sentences are the whole brief. The first sets the bar and — critically — sets a **ceiling**. The second removes sunk cost as an argument in either direction: we do not patch a dead end because it exists, and we do not rewrite something working because it is ugly.

### 0.2 The look statement

> **Barcelona at 35° golden hour and under sodium light, built as honest 2015-era simulation art: one tiling albedo + one tiling normal on every surface, a warm-masonry palette that never goes vivid, texel density measured in real metres, and wear painted into the albedo rather than simulated.**

Concretely, ETS2 pre-2019 (Prism3D) is: **specular-gloss, with a greyscale spec mask packed into albedo alpha, no roughness map, no AO map, no parallax**, 512–1024 tiling diffuse+normal per surface class, one shared low-frequency grunge texture multiplied over everything at a much larger UV scale, and a bounded set of materials rather than per-object materials. That is a *real, named, reachable* midpoint — not a compromise between photoreal and stylized.

### 0.3 What v3 is NOT — six bans, each with the failure it prevents

| # | NOT | Failure it prevents | Hard test |
|---|---|---|---|
| **N-1** | **NOT photoreal / photoscan-fidelity.** No world surface above 1024². No parallax/POM, no SSR, no GI, no screen-space AO, no virtual texturing. 2048² exists for exactly six pages: sign atlas, foliage atlas, vehicle atlas, cloud atlas, roof atlas, dynamic text page. | Chasing fidelity the user explicitly rejected, stealing budget from *coverage* — and coverage is what "better than what we have" actually means. | Any map >1024² needs a named exemption from that list of six. |
| **N-2** | **NOT flat-shaded low-poly / palette-UV "Kenney" art.** No untextured primitive geometry in the shipped world. No 59-unique-UV palette atlases. | The toy-vs-world clash. `vehicles.md:34-81`. | Zero shipped meshes whose UV set collapses to <32 distinct texels. |
| **N-3** | **NOT vivid or saturated.** `colorGradePass.js:49` is `satAmt = mix(1.15, 1.52, uRally)`. **Rally is a MODE, not the art target.** Author for ×1.15; survive ×1.52 without clipping. | Three recorded overshoots already: `buildingWorker.js:363-366` ("saturated bases go fire-red"), `vegetationRenderer.js:62-70` (three re-grades), `vegetationWorker.js:1616-1623`. | Normalize Step 6 (§2.4). |
| **N-4** | **NOT stylized-illustrative.** No cel shading, no gradient maps, no painted outlines, no hand-painted fake AO in corners, no toon ramps. | Fake AO in an albedo fights the **v9 baked sky-visibility grid**, which is real and directional. | The de-light step (§2.4 Step 2) is mandatory, not optional. |
| **N-5** | **NOT a kitbash of visibly different source fidelities.** No asset ships at its source's native grade. Every asset passes normalize — including "it already looked fine." | The exact failure this plan exists to prevent: invisible until ~100 assets, unrecoverable after. | The contact sheet, §2.7 gate 1. |
| **N-6** | **NOT a Delhi holdover.** | `streetlightRenderer.js:96,124,626-628` still renders **Indian tricolour bridge poles at night in Barcelona**. `reflectorRenderer.js` places Indian cat's-eye studs every 6 m on Barcelona tertiary streets. `ENABLE_DELHI_DETAILS` stays false forever. | `grep -rn "tricolor\|BRIDGE_NIGHT_COLORS\|shikhara" frontend/src` returns zero hits in shipped paths. |

### 0.4 The binding constraints

1. **It stays a browser game.** Zero-install click-a-link-and-drive is the product's best feature. Desktop-first, scales *down* to mobile, never excludes it. This gets a **measured metric** in v3 (§4 P0) because today nobody watches it and `main.js:723` has a 20 s safety net that hides regressions until they are severe.
2. **Assets must be free.** CC0 (Poly Haven, ambientCG, Kenney, Quaternius, Poly Pizza) + AI-generated (Draw Things, tiling mode) + Blender-authored. Never NC. **The build fails on a missing or non-CC0 licence field.** There are two live violations in the repo today (§2.6) — both are P0.
3. **City-wide budgets:** texture VRAM ≤ 200 MiB resident · art library ≤ 24 MB over the wire · p95 GPU ≤ 15.0 ms at 80 km/h **at night in dense Eixample** · draws ≤ 450 · triangles ≤ 2.6 M.

### 0.5 Three rulings that re-frame everything

**R-A — THE BUDGET FRAME WAS WRONG IN BOTH DIRECTIONS.** The "26.3 ms vs 15.0 ms" table treated the frame as starting at zero. It does not. Measured night Eixample at 80 km/h is **13.0–13.6 ms** (`changelog.md` round 9). Several audits' "gross" asks re-declared spend already inside that 13.3. **The plan is restated as: measured baseline + Σ(NET marginal deltas) ≤ 15.0 ms, with every shared saving allocated to exactly ONE owner.** Under that frame it fits at **13.75 ms**, with **4.55 ms of phantom savings removed**.

**R-B — THE RESIDENT-TILE DENOMINATOR IS 9–18, NOT 25.** `tileManager.js:57` `GRID_RADIUS=1` → 9 tiles built. `tileManager.js:2718` `dynLookahead = LOOKAHEAD_RADIUS(2) + min(2, floor(kmh/75))` adds a **directional fan**, not a ring → ~6–9 more at 80 km/h. `tileManager.js:59` `UNLOAD_DISTANCE=2` is the **eviction** radius (≤25 *cached*), not a draw count. The fog block at `:2916` hides everything past 280 m `nearEdgeDist` — with one exception, the road family, exempted at `:2954`. Roads reach ~25 drawing tiles *only because of that exemption*, which road-surface W7 deletes. **Six different denominators (4/5/9/12/15/25) across the audits are struck. Every per-tile draw and triangle figure is re-derived at 9–18.**

**R-C — FIVE CENSUS FIGURES ARE CORRECTED AND ARE LOAD-BEARING.**

| Figure | Audit said | Corrected (all 426 tiles, independently re-parsed) | Consequence |
|---|---|---|---|
| Shops parsed & discarded | 2,923 | **14,542** (13,551 named) | Wiring `data.shops` is the best 0.5 days in the programme |
| OSM traffic signals discarded | 807 | **4,225** | Same |
| Named road records | 8,966 | **42,876** of 53,895 | Signage text-atlas sizing is **unvalidated**; re-run the census before committing 128 cells |
| Night emissive atlas | 85.3 MiB (structural bound) | **55.9 MiB (measured)** | GRID 4→2 reclaims **-41.9 MiB**, not -64 |
| `road.surface` coverage | 82.3% | 67.1% of all 53,895 records / 82.3% of the 12,912 **drivable** subset | ~41,000 non-drivable footway records make the edge-strip DELETE *larger* than claimed |

Barrier census (reproduced exactly): **2,890 barriers city-wide = wall 1,120 / fence 895 / compound_wall 390 / retaining_wall 246 / hedge 148 / kerb 53 / city_wall 28 / guard_rail 7 / jersey_barrier 3.** Tile versions: `{7: 17, 9: 409}`.

---

## 1. Verdict table — all twelve

| # | Subsystem | **FINAL VERDICT** | One-line justification | Days |
|---|---|---|---|---|
| 1 | **Road surface, markings, kerbs, sidewalks** | **REFACTOR** the module + **REBUILD** the material/shader layer + **DELETE** four Delhi subsystems | `roadBaker.js:400-401` already bakes world-metric arclength U *and* per-vertex `halfWidth` — correct world-metric asphalt UVs at any carriageway width are recoverable in the vertex shader with **no re-bake and no geometry change**. A rewrite would re-derive strip topology it already has. | 12.5 |
| 2 | **Road furniture — guardrails, barriers, railings, bollards, reflectors** | **REBUILD** | **Seven `guard_rail` features exist city-wide.** No patch to `barrierRenderer.js` produces road railings from an empty data source. Furniture must be *derived* from road class + geometry + terrain, which is a different program. Plus `roadRenderer.js:2766,:2773` are `MeshBasicMaterial` — unlit metal cannot catch a headlight. | 11 |
| 3 | **Building geometry + facades** | **REBUILD** | 21.3 × 25.6 texels/m against an 85–150 bar, produced by ~250 lines of canvas painting a 256² tile onto a **4-vertex wall quad**. `FLOOR_HEIGHT=10` paints a mid-air shopfront on **88.5% of buildings** (36,122 of 40,828 ≥10 m); 30.8% get two. A quad has no storey structure to texture. Keep the worker transport, the per-material-key merge, and the vertex-colour tint collapse. | 17.5 |
| 4 | **Roofs / shopfronts / awnings / terraces / rooftop clutter** | **SPLIT — roofs, parapets, clutter = REFACTOR; ground-floor kit = REBUILD** | Roof half is genuinely REFACTOR: `getRoofMaterialKey()` is a literal `return 'roof_FFFFFF'` (`buildingWorker.js:392-394`) so ONE texture dresses the whole city, and `ensureUvs` (`:657-661`) is a one-function zero-fill. Ground-floor half has **no UV channel, one face of three on a chamfered block, ~10 m dressed of a ~65 m frontage** (`MAX_SEGS_PER_BUILDING=4 × SEG_LEN 3.4` = 14.8 m, minus a 35% skip) — nothing to texture. | 1.5 + 5 |
| 5 | **Signage — boards, fascias, street names, traffic signs, lane arrows, lights** | **REBUILD** | Three independent arithmetic walls: one `MeshBasicMaterial` per board → ~300 draws for direction boards alone against a 450 city budget; one 0.750 MiB texture per unique street name with **zero eviction** → 42,876 named records unsignable at any VRAM budget; tile unload disposes the module-cached texture. "A texture per string" has no patch. | 9 |
| 6 | **Vegetation — trees, bushes, grass, parks** | **REBUILD** the art path + **DELETE `greensRenderer.js`** as a surface | An untextured `IcosahedronGeometry(detail 0)` has 20 faces. ETS2's tree look is *silhouette* — alpha-cut leaf edges against sky — and a convex blob has no alpha edge to cut. Three palette re-grades are already recorded in comments. Greens die because ETS2 **paints** the ground; a park is a weight channel in the splat terrain is building anyway. | 12 |
| 7 | **Terrain, hills, beach, coastline** | **REBUILD** surfacing + delivery; **sea mesh DELETED** | The only ground texture fetch in the shipped path is compiled out: `terrainRenderer.js:892-895` is `isRallyStyle() ? 'diffuseColor.rgb *= 0.98' : <fetch>`. The finest ground detail in the entire game is a 5–10 m noise blob. `createTerrainTrimesh` (`tileManager.js:1179`) has **zero call sites** while 383 MB of terrain rides in every tile. | 6.5 |
| 8 | **Water — sea, harbours, wet roads, rain** | **DELETE `waterRenderer.js` + REFACTOR the terrain sea branch + NEW wet roads** | Deleting 322 lines that have **never executed once** (`ENABLE_WATER:false` since 809bd94) is not a rebuild — there is no behaviour being replaced. `coastline.js` is KEEP, unchanged, on merit. Wet roads are ~70% pre-wired: `roadRenderer.js:304` is already `MeshStandardMaterial({roughness:0.9})` and `patchRoadWash` already injects + binds a shared uniform. | 5 |
| 9 | **Sky, clouds, fog, weather, TOD, lighting rig** | **SPLIT — atmosphere/fog = KEEP on merit; night lighting = REBUILD; `dayNight.js` + `timeSystem.js` = DELETE; sky dome = REFACTOR + texture layer** | The aerial-perspective fog (`scene.js:666-711`) does altitude thinning, distance desaturation, blue-shift and a sun in-scatter wedge — **above** the ETS2 target, so rewriting makes the result worse. Night is six independent fakes with nothing to refactor. The dome is a 3-stop analytic gradient that is **hidden entirely at night** (`envToggle.js:63-64`) — below the domain's own stated bar. | 9.5 + 1.5 |
| 10 | **Player car, traffic, parked cars, pedestrians** | **REBUILD** (hero car + kit); **DELETE** the pedestrian art pass | Verified by binary GLB parse with correct `byteStride` (32 / 48): `bmw_m3.glb` `uniqUV=1` at (0.000, 0.000) on all 17 car nodes; `cars/sedan.glb` body `uniqUV=59`; `people/man.glb` has **no `TEXCOORD_0` attribute at all** on any of 6 primitives. You cannot patch a UV unwrap onto shipped vertex data. Peds: the audit wrote its own kill criterion and then scheduled the 5-day art pass anyway. | 19.5 |
| 11 | **Asset pipeline, material system, LOD** | **KEEP** (tile stream/merge) + **REBUILD** (LOD layer) + **BUILD** (asset layer — greenfield) + **canvas-retirement register** | Texture residency is **city-wide, not per-tile** — a shared KTX2 library imposes zero new requirement on tile granularity. 500 m sectors streamed in a radius **is** the ETS2 architecture. But `nearEdgeDist = max(0, centerDist - 250)` is **one distance value for a 500 m tile** against `BUILDING_MAX_DISTANCE: 250` — LOD granularity is 500 m in a world where the interesting range is 0–150 m. | 6 + register 1 |
| 12 | **HUD / GUI + progression** | **REFACTOR** + **REBUILD the minimap redraw scheduler** + **BUILD progression** | theme.js, speedDisplay.js, the citymap.bin renderer and wallet.js are good and stay. The four mode HUDs are four implementations of the same three widgets in six palettes with seventeen hardcoded hexes — the defect *is* that there are four. Minimap scheduler: `minimap.js:390-391` records **10.1 ms ui-thread worst case at 99 km/h** — inside the p95 window; "a week to re-derive" is sunk cost. | 1.5 + 14 (deferred) |

**TOTAL REBUILD DAYS: 103.** (Down from ~200 across the 12 audits, entirely from de-duplication.)
**TOTAL PROGRAMME: ~205 days** (from a 294.65-day sum of asks): **-52 days from cuts, -19 days from de-duplication, +8.25 days of newly-assigned unowned work.**
**MINIMUM SHIPPABLE v3: 74 days ≈ 15 weeks** (end of P3, §4).

### 1.1 Every REBUILD — what is thrown away, what replaces it, what carries over

| Rebuild | THROWN AWAY | REPLACED BY | CARRIES OVER (do not re-derive) | Days |
|---|---|---|---|---|
| **Facade generation** | `getWindowTexture` (`meshMaterializer.js:118-365`, ~250 lines of canvas); 1-quad wall faces (`workerGeometry.js:36-125`); 16 boot-time night atlases; `renderLODBuildings` (`buildingRenderer.js:2541-2650`, unreachable after phase 2); the first-come `BALCONY_VERT_CAP` race | 3-band modular storey geometry (ground/body/crown, 12–16 verts/face) + 8-layer `CompressedArrayTexture` (albedo/normal/window-mask) + per-building proportional triangle budgets | Worker transport; per-material-key merge; **the vertex-colour tint collapse** (`buildingWorker.js:381-392`) — facade materials bounded at 16, roofs at 1, regardless of building count. That is exactly ETS2's bounded-effect-set model and it is already done. | 17.5 |
| **Ground-floor kit** (new owner) | The four-renderer "co-registration by convention" (`shopfrontRenderer` / `awningRenderer` / `shopSignRenderer` / `cafeTerraceRenderer` each independently re-deriving the longest edge); `SEG_CAP` first-come clipping; the UV-less `quad()` and `pushSegment()` | ONE `map/groundFloorKit.js` owning the bay grid (edge selection, SEG_LEN/stride, skip hash, quantised ground Y), emitting shopfront + awning + fascia anchors as one co-registered result | Placement heuristics; the scattered height constants move together: `KICK_TOP 0.42 / GLASS_TOP 2.55 / LINTEL_TOP 2.80` (`shopfrontRenderer.js:17-19`), `AWN_TOP_Y 2.9`, `SIGN_Y 3.15 / SIGN_H 0.72` | 5 |
| **Road material layer** | `patchRoadWash`'s night half (split out first — §7); marking geometry + dash extraction + junction clipping (a measured **70.9 ms `p1 rg:markings` build spike**); 7 paint Y-lifts + the hidden `+ROAD_ZFIGHT_OFFSET`; edge strips; 5 dead material factories | `roadMaterial.js` — world-metric UV from the already-baked `halfWidth`, tiling albedo+normal, 8× detail normal, per-fragment macro wear, analytic wheel ruts, analytic lane paint | **`buildFlatRibbonGeometry` strip topology + `roadBaker.js:400-401`** (`uvs.push(u,0,u,1)`, `halfWidths.push(half,half)`), the runtime twin at `roadRenderer.js:592-593,:609`, the baked consumer at `:4625-4627`, and the merge key `${matId}|${geoAttrKey(geo)}` (`tileManager.js:154-165`) that lets it survive the merge | 12.5 |
| **Road furniture** | `crashBarrierRenderer.js` (451 L, Indian yellow-black); `dividerRenderer.js` (142 L); `reflectorRenderer.js` (329 L — ~42k tris, 18 draws of cat's-eye studs every 6 m on Barcelona tertiary streets **today**); `MeshBasicMaterial` on all railings | Derived placement (road class + geometry + terrain) → W-beam ribbon emitter + global `BatchedMesh` pools for posts/bollards/delineators/jersey; Lambert + map + normalMap | `computeGuardRailMask` (`roadRenderer.js:3246`), `isElevatedGuardRailRoad` (`:3206`), `guardRailKeepRuns` (`:3361`), `detectRoundaboutZonesForRails` (`:3221`) — moved verbatim | 11 |
| **Vegetation art path** | `TREE_VARIANTS` procedural blobs; the `ctx.ellipse` billboard atlas; 4 billboard materials/pools; the 13,963-instance transparent blob-shadow pool; `greensRenderer.js`; 1,679 lines of dead code (`bushRenderer.js` 344 L zero importers, `zoneVegetationRenderer.js` 587 L never called, `grassRenderer.js` 748 L gated to zero) | Card trees (3 LOD tiers × 8 species in ONE pool selected by `geometryId`); offline-rendered impostors; parks folded into the terrain splat | **`vegPools.js` verbatim** — LIFO free list, the never-`deleteInstance` invariant (`:56-61`, O(n log n) blowup), add-reservation accounting, sibling-pool overflow. Rewriting it reintroduces four documented streaming stalls for zero visual gain. | 12 |
| **Signage** | ~300 per-board `MeshBasicMaterial`s (`roadInfraRenderer.js:1099`, inside the loop); three unbounded `Map` caches with no `.delete`/`.clear` (`:260`, `:456`, `:579`); a 0.750 MiB texture per unique street name; `trafficLightRenderer.js` | `signAtlas.js` + `signPool.js` — one shared atlas material with per-instance `aUvOffset`/`aTint`/`aEmissive`; a bounded LRU R8 text page | **~450 lines of placement logic verbatim**: `generateDirectionBoards` (`:977`), `generateGantries` (`:1131`), `generateSpeedSigns` (`:724`), `toCatalanTitleCase` (`:584`), `splitTwoLines` (`:596`) | 9 |
| **Night lighting** | Six fakes: lamp emissive×bloom, 16 m ground-pool decals (`streetlightRenderer.js:24` `POOL_SIZE 16`, `:214` `PlaneGeometry(16,16)`, one per lamp at 22 m spacing = **>100% road coverage**), hero-building spill decals, road night wash, veg night wash, decal colour lift | `lightGrid.js` — world-space 2.5D clustered lighting, 64×64 RGBA8 index over 8 m cells (512 m window, 4 nearest slots/cell) + RGBA32F lamp data, rebuilt only on cell crossing | **`tileManager.getStreetlightPositions()` (`:3482`, exported `:3523`) — ZERO callers today.** The data plumbing is already built and unused. | 9.5 |
| **Vehicle assets** | `bmw_m3.glb` UVs; 9 Kenney GLBs (1.72 MB); `adventurer.glb` (10,198 tris, fantasy RPG with a 1,748-tri backpack, 1.84 MB); `punk.glb` (1.24 MB); the 18× duplicated 512² colormap; the `carModels.js:75` non-uniform squash | Blender modular kit (6 bodies, 1,800–2,800 tris LOD0 + 500–700 LOD1) + 2048² greyscale-paint atlas with a **paintjob mask**; re-UV'd hero car | Placement (`getLoadedRoadSegments()`), traffic behaviour, contact-shadow pool, `setCarColor()` | 19.5 |
| **LOD layer** | Per-tile `nearEdgeDist` (`tileManager.js:2908-2909`); `BUILDING_LOD_START/END` (a loading placeholder, not a tier) | `staticPools.js` — global `BatchedMesh` pools, `perObjectFrustumCulled=true`, discrete 3-tier bands with hysteresis; worker emits per-building ranges + centroids + radii (**postMessage change, not a tile-format change, no re-bake**) | `vegPools.js` machinery (generalised, not replaced); `chunkedMerge.js`; `gpuWarmup.js`; the 4-phase tile build | 6 |
| **Minimap redraw scheduler** | The per-move vector re-rasterise (10.1 ms ui-thread, ~5.5×/s at speed) | Offscreen district bitmap at 2–3× visible extent, panned/rotated per frame, re-rasterised on district exit (~1 per 30–60 s) | **The canvas renderer and the `citymap.bin` pipeline, verbatim** | 1.5 |

---

## 2. The art bible

**Binding on all twelve domains. Where a domain audit's ART choice conflicts with this, this wins. Where it conflicts on ENGINEERING, the domain audit wins.**

### 2.1 The photoscan-vs-stylized fault line — ruled

> **RULE AD-1: TEXTURED-REALIST, NORMALIZED, SPECULAR-GLOSS ERA. Photoscan is a permitted SOURCE and a forbidden SHIPMENT. Flat-palette-UV geometry is banned from the shipped world entirely.**

The tempting reading of the Kenney fleet (2,032–2,476 tris, 59 unique UVs snapped to a 1/32 palette grid on a 3,110-byte 512² WebP, `metallicFactor 0`) is "keep the world stylized so the cars fit." Wrong, for three measured reasons: (1) the cars are already ruled REBUILD and DELETED; the mismatch is a temporary window, not a standing constraint. (2) A palette-UV world has no normal map *by construction*, so lowering the world to meet the cars puts us below the ETS2 floor to preserve 1.72 MB of assets we are deleting — textbook sunk cost. (3) ETS2 is neither pole: it is hand-graded 512–1024 tiling diffuse+normal, which is exactly the midpoint we are aiming at.

- **AD-1a — SOURCE vs SHIPMENT.** ambientCG / Poly Haven photoscans are the *preferred* base for asphalt, concrete, gravel, rock, metal, tyre rubber — they are the only free sources shipping **true normal maps** rather than luminance-derived fakes. But no photoscan ships at native grade; it enters through §2.4 Steps 2→6. A photoscan that survives normalize is a stylized-PBR texture with correct micro-detail. One that does not is rejected, not shipped "because it looked good in isolation."
- **AD-1b — PALETTE-UV BAN.** Any mesh whose UV set collapses to fewer than 32 distinct texels is banned. This kills the Kenney fleet and pre-empts the same trap in Quaternius/Poly Pizza props (both ship palette-atlas variants — check before use).
- **AD-1c — SEQ-1, THE MISMATCH WINDOW.** The window between "normalized asphalt ships" and "vehicle kit Tier 0 ships" is the single most likely place we ship something that looks *worse* than today. Three options: **(A)** vehicle kit Tier 0 lands in the same phase as the first normalized ground material — front-loads ~8–10 vehicle days; **(B)** `ENABLE_TRAFFIC=false` and parked cars off from the first textured ground until the kit lands — 0 days, costs a populated street for one phase; **(C)** cull Kenney past 60 m — **REJECTED**, they are still the nearest moving objects and palette flatness reads at any distance under headlights. **This plan picks B** (P3 ships textured ground, P4 ships the kit; traffic is flag-off for the P3 window and restored in P4). If schedule permits, A is strictly better.

### 2.2 Texture specification

**The map set — closed list. A seventh type requires amending this document.**

| Map | Channels | Transfer | Compression | Who gets it |
|---|---|---|---|---|
| **ALBEDO** | RGB (+A where cutout) | **sRGB** | ETC1S q128 (opaque) / q192 (alpha or high-contrast) | Everything |
| **NORMAL** | RGB tangent-space | **LINEAR** | ETC1S q192 (grain) / **UASTC** (shape) — AD-2 | Surfaces where N·L reads. **NOT** flat printed surfaces |
| **MASK (R8)** | single channel | **LINEAR** | ETC1S q192, **never channel-packed** | Paint wear, puddle mask, macro grunge, emissive mask, window light mask, headlight cookie |
| **ORM** | R=AO G=rough B=metal | **LINEAR** | ETC1S q128 | **Vehicles only.** The world gets Lambert + a per-material roughness *uniform* |
| **EMISSIVE MASK** | R8, one shared page | **LINEAR** | ETC1S q192 | ONE city-wide 1024² R8 page. Per-instance scalar × mask. Never a per-asset emissive texture |
| **IMPOSTOR** | RGBA | **sRGB** | ETC1S q192 | Tree LOD2 only, **rendered offline from LOD0** |

**Explicitly absent, deliberately:** no roughness *map* on world surfaces; no per-texture AO map (the v9 baked sky-AO grid **is** the AO); no height map; no parallax; no metalness outside vehicles; no separate specular map (spec is a greyscale mask in albedo alpha where needed — ETS2's own trick).

**Resolution ceilings by surface class**

| Class | Ceiling |
|---|---|
| Road / sidewalk / cobble / kerb tiling | **1024²** albedo+normal; **512²** detail normal |
| Facade array layers (8) | **1024²** albedo + **1024²** normal + **512²** window mask |
| Roof atlas | **2048²** (3 × 1024 cells) |
| Terrain ground array (4 layers) | **1024²** per layer, albedo+normal |
| Foliage atlas | **2048×1024** albedo(RGBA)+normal, cells 512² |
| Sign atlas | **2048²** albedo+alpha, **NO NORMAL** (a 0.7 m flat printed disc gains nothing) |
| Dynamic text page | **2048×1024 R8** |
| Vehicle shared atlas | **2048²** albedo, **1024²** normal, **1024²** ORM |
| Hero car | albedo 1024², normal **2048²** (the one 2K normal in the project), ORM 1024² |
| Furniture / props / rooftop / terrace | **1024²** albedo+normal per material family |
| Water | **2 × 512²** normal only |
| Sky / clouds | **2048×1024** RGBA |
| Fabric, foam, kerb, grate, cookie, corona | **512²** or below |

**Nothing is 4096. Six 2048² pages exist total: roof, foliage, signs, text, vehicle, cloud.**

**VRAM arithmetic — the formula everyone prices with**

```
resident MiB = W × H × (bpp / 8) × 1.333 / 1048576      // ×1.333 is the mip chain
```

| Format path | bpp | 512² | 1024² | 2048² | 2048×1024 |
|---|---|---|---|---|---|
| ETC1S opaque → BC1 / ETC1 | 4 | 0.171 | **0.683** | 2.73 | 1.37 |
| ETC1S+alpha → RGBA_ETC2_EAC / BC7 | 8 | 0.341 | **1.365** | 5.46 | 2.73 |
| UASTC → BC7 / ASTC | 8 | 0.341 | **1.365** | 5.46 | 2.73 |
| **Uncompressed RGBA8 (BANNED)** | 32 | 1.365 | 5.46 | 21.8 | 10.9 |

⚠ **BLOCKER for every number above.** three r183 `KTX2Loader.js:786-805` ranks bptc `priorityETC1S:3` **above** dxt `priorityETC1S:4`, so Windows/NVIDIA transcodes an all-ETC1S library to **BC7 at 8bpp**. Without the FORMAT_OPTIONS BC1 patch, road-surface 8.19→16.4 MiB, terrain 6.72→13.4, buildings 28→46, and ~85 MiB of the 109.2 allocation doubles → **~244 MiB, 44 over cap.** One line in `loaders.js`. **It is a P0 blocker on the entire VRAM budget, not an optimisation.** Cited independently by 7 of 12 audits.

⚠ **HARD BAN — no exceptions, no waivers:** `new THREE.CanvasTexture` for any world-render surface. Today: **48 sites across 22 files**, all RGBA8+mips, all generated on the **main thread at boot**. The night-window atlas alone is **55.9 MiB measured resident** (16 variants × 1024², built unconditionally at boot by `meshMaterializer.js:971-984`, attached eagerly at `:613` so all 16 exist in a day-only session). **Its death is what funds every other domain's textures.** Canvas is permitted **only** for: the dynamic street-name text page (LRU, sub-region upload), the sky TOD LUT (256×8, generated at boot), the procedural moon/stars (`scene.js:140-387` — these read fine at 8 km and must not be re-authored), and HUD DOM. That is the whole exemption list. A **canvas-retirement register + CI lint** (P1) enumerates all 48 sites with owner domain, target KTX2 asset and target phase, and the allowlist shrinks monotonically.

### 2.3 Compression, colour space, orientation, normal strength

> **RULE AD-2 — grain vs shape.** ETC1S shares chroma endpoints per 4×4 block, and on a normal map the chroma *is* the XY of the normal. Where the map is high-frequency isotropic noise the block error reads as more grain and is invisible. Where it carries a coherent directional feature the error reads as a *wrong shape* and is fatal.

| GRAIN → **ETC1S q192** | SHAPE → **UASTC** |
|---|---|
| asphalt, plaster, terrain grass/dirt/gravel/sand, roof surface, foliage leaf cards, fabric weave, tyre rubber, rock | guardrail W-profile corrugation, kerb chamfer, roof coping band, drain grate, brick mortar courses, panot flower relief, windshield droplets, vehicle panel shutlines, hero car |

**AD-2a budget guard.** UASTC is ~3.3× ETC1S transmission (measured: 2048×512 albedo — ETC1S q192 **252.3 KB**, UASTC-RDO **836.0 KB**). **Total UASTC across the library ≤ 4.0 MB of the 24 MB.** The hero car's 2048² UASTC normal alone is ~3.2 MB at default RDO — it ships at **RDO λ≥1.0 targeting ≤1.6 MB, or drops to 1024².** This is the single line most likely to blow the download cap.

**Measured transmission rates — use these, do not re-estimate:** 1K albedo ETC1S q128 **159 KB**; 1K normal ETC1S q128 **179 KB**; 2048×512 RGBA albedo q192 **252.3 KB**; 2048×512 normal q192 **282.8 KB**; conifer albedo q128 95.5 KB. Basis transcoder over the wire: **217 KB brotli**, not the 584 KB raw figure v2 used.

> **RULE AD-3 — sRGB vs LINEAR.** Albedo, emissive and impostor pages carry the **sRGB** transfer function in the KTX2 DFD. Normal, ORM, mask and every single-channel map carry **LINEAR**. The encode script ASSERTS this per asset and **exits non-zero** on mismatch.

This is the #1 silent-failure mode in the whole pipeline. three reads the transfer function straight off the KTX2 DFD (`KTX2Loader.js:1232`) and **`verifyColorSpace` early-returns for compressed textures** — no warning, no console error. An sRGB-flagged normal map on the largest surface in the scene (asphalt) is "subtly, unfixably wrong" forever. Three independent audits flagged the same trap. Enforcement: the manifest carries `transfer`, the encoder sets it from the manifest and **re-reads the written DFD to verify**, CI fails on mismatch. Never let the author set it at the call site.

> **RULE AD-4 — v-flip.** ONE convention, library-wide: **glTF convention. `flipY = false`, first image row = TOP of the surface.** Every consumer is patched to it. Textures are NEVER pre-flipped at encode time to accommodate an old UV set.

WebGL ignores `UNPACK_FLIP_Y_WEBGL` for compressed uploads, so `KTX2Loader` yields `flipY = false`. Every UV authored against a `flipY = true` CanvasTexture renders **upside down** the moment it is fed a `.ktx2` — silently, because a 4-fold-symmetric pattern like panot looks fine while a kerb chamfer, coping band, brick course or sign is wrong forever. A split rule ("world bottom-up, models top-down") guarantees someone gets it backwards, and glTF-embedded KTX2 *must* be top-down — hence one rule. **Known offenders to fix at the UV, one line each:** `roadRenderer.js:1690-1694` (panot), the v8 baked sidewalk UVs, and any of the 48 canvas sites converted.
**Enforcement — the orientation test card:** every 2048² page carries an asymmetric glyph (`⌐`) in its top-left 32×32 texel block, and a debug key renders every library page as a flat quad. A flipped page becomes a one-glance catch instead of a six-week-later discovery.

> **RULE AD-5 — normal strength.** The map is authored so `normalScale = 1.0` is correct. The runtime knob is reserved for LOD fade, **never for taste.**

Calibrate at encode by measuring mean `|N.xy|` and rescaling XY (renormalising Z) into the class band:

| Class | mean \|N.xy\| | ≈ mean slope |
|---|---|---|
| asphalt, plaster, terrain grass/dirt, roof surface | **0.10 – 0.22** | 6°–13° |
| kerb, coping, panot, brick, cobble, concrete barrier | **0.18 – 0.32** | 10°–19° |
| metal (guardrail, posts), fabric, props, vehicle panels | **0.15 – 0.30** | 9°–17° |
| foliage cards, windshield droplets | **0.20 – 0.35** | 12°–20° |

Out of band = fail, rescale, re-encode. This rule is what prevents "every domain dials its own normal until its surface pops," which is the classic route to a scene where nothing recedes.

### 2.3.1 Two shared assets that are mandatory library-wide

**AD-6 — THE ONE GRUNGE TEXTURE.** ETS2's highest-leverage single trick: one low-frequency grunge texture multiplied over every tiling surface at a second, much larger UV scale, breaking the repeat city-wide for **one 512² single-channel texture**.
> **Every tiling world material with a base repeat ≥ 2 m MUST sample the shared `grunge_macro_512` R8 at ≥ 16× its base repeat, multiplied into albedo.** Cost: **0.35 MiB VRAM, ~45 KB download, one texture fetch.** Best MiB-per-quality line in the library. No domain authors its own.

**AD-7 — ANISOTROPY IS CENTRAL POLICY, NOT A CALL SITE.** Today anisotropy is set on **3 textures of ~48** (`terrainRenderer.js:31`=4, `roadInfraRenderer.js:700`=4, `roadRenderer.js:196,209`=max), and `setRendererAnisotropy` reaches **exactly one texture** (panot). The other ~45 sample at 1 — that is why tilted tiling surfaces read mushy at speed.
> **The material registry sets anisotropy for every texture it hands out. No renderer sets it at a call site.** Tiling world surfaces `min(8, maxAnisotropy)`; foliage/sign/prop atlases `4`; UI/sky `1`. **Mips mandatory on every texture** except the dynamic text page's sub-regions. Unmipped foliage is the classic shimmer failure.

### 2.4 The Barcelona palette

**The ten world anchors.** These were arrived at over three grading passes against real Barcelona aerials and are *correct*; the failure is that they are colours on untextured geometry, not that they are wrong colours.

| # | Name | Hex | Governs | Provenance |
|---|---|---|---|---|
| **P1** | **Eixample Cream** | `#E7DECB` | Residential / office / school / hospital plaster. **The dominant value of the city.** | `buildingWorker.js:68` |
| **P2** | **Ochre Sand** | `#D3C5A8` | Facade mid-tone, commercial plaster, sandstone church, stucco | `buildingWorker.js:69,79,86` |
| **P3** | **Modernisme Rose** | `#C89A78` | Warm facade accent, terracotta render — **sparse, ~1 in 8 buildings** | `buildingWorker.js:71,86` |
| **P4** | **Teula Clay** | `#A76A5C` | Roof tile. **The aerial signature of Barcelona.** | `buildingWorker.js:367` |
| **P5** | **Poblenou Brick** | `#9E5A3E` | Industrial brick, chimney stacks, warehouse | `buildingWorker.js:81` |
| **P6** | **Panot Grey** | `#B4B0A6` | Sidewalk paving, precast concrete, parapet coping, roof terrat | *new* |
| **P7** | **Bordillo Granite** | `#7C7A76` | Kerb face, bollards, stone plinths, sea walls, post concrete | *new — replaces flat `0x5a5a5a` at `roadRenderer.js:219-228`* |
| **P8** | **Carriageway Grey** | `#4F4E4C` | Asphalt, tarmac, sett grout, tyre rubber | *new — replaces the per-vertex sine `roadNoise` at `roadRenderer.js:317`* |
| **P9** | **Platanus Green** | `#6E7A55` | Foliage, verge grass, park ground. **Dusty olive — never emerald, never lime.** | *new — replaces `vegetationRenderer.js:62-70`* |
| **P10** | **Mediterrani Blue** | `#2F5C77` | Deep sea, water base, distant haze anchor | *new — sits between day fog `0xc4dcea` and night bg `0x0a1224`* |

**The six night emissives — a CLOSED set.** Night is a warm-vs-cool contrast problem (`colorGradePass.js:60`) and emissive hue variety destroys it faster than anything else.

| # | Name | Hex | Use |
|---|---|---|---|
| **N1** | Sodium Amber | `#F0B95A` | Street lamps |
| **N2** | Warm LED | `#FFE9C4` | Modern lamps, headlights, DRL |
| **N3** | Window Warm | `#FFDFA8` | Lit residential/office windows |
| **N4** | Farmàcia Green | `#35C878` | The pharmacy cross — the single most recognisable Barcelona night sign |
| **N5** | Signal Red | `#E2413A` | Tail lights, traffic signals, metro roundel |
| **N6** | Cool Sign | `#6FB4E8` | Backlit commercial boxes, parking blue, hospital |

**Nothing else in the world emits.** A seventh requires amending this document.

**AD-8 — THE UI RESERVATION.** `coral #d76a4f`, `sky #7ea6b0`, `sage #8fa77e` (`theme.js:39,41,42`) are **UI-only** and must never appear as a world albedo anchor. This reservation is what keeps the HUD legible over the world without a scrim. World greens go to P9 Platanus (olive), not sage. World warm accents go to P3/P4, not coral.

### 2.4.1 THE NORMALIZATION PROCEDURE — mandatory, eight steps, scripted

Implemented once as `scripts/build-art.mjs` (committed artefact, **never run on Cloudflare Pages** — ~10 min for a full library rebuild). No domain runs its own version.

- **STEP 0 — INGEST.** Record `{name, surfaceClass, source, license, url, sha256, srcRes, shipsTrueNormals, normalSource, aiModel, aiModelLicense}`. Build **fails hard** on a missing or non-CC0 licence field.
- **STEP 1 — TILE VERIFY** *(tiling maps only)*. Offset 50% in both axes; max local gradient at the seam ≤ 1.5× the image median gradient. AI output fails this constantly when tiling mode was off. Fail = fix or reject, never ship.
- **STEP 2 — DE-LIGHT.** In Lab: `L' = L − k·(GaussianBlur(L, σ=W/8) − mean)`, clamp [0,100]. `k` = **0.85** photoscan · **0.35** AI · **1.00** Blender-baked-with-AO · **0.00** flat-authored.
  *This is the step most likely to be skipped and the one that matters most.* The game supplies its own occlusion from the **v9 baked sky-visibility AO grid**. A photoscan's baked AO is a different occlusion from a different geometry: ship it and every surface double-darkens in crevices that do not correspond to our geometry, fighting a grid that is correct. `terrain-coast.md:114` records that the existing slope-scaled AO hack was itself a workaround for exactly this class of mismatch.
- **STEP 3 — Lab L*/C* RESCALE.** `L'' = μ_t + (L' − μ_s)·(σ_t/σ_s)`, same for C*.

| Surface class | L* mean | L* σ | C* mean |
|---|---|---|---|
| Asphalt / carriageway | 38 | 8 | 4 |
| Sidewalk panot / concrete | 62 | 9 | 6 |
| Kerb / granite / stone | 51 | 10 | 5 |
| Facade plaster / render | 74 | 10 | 14 |
| Brick | 45 | 11 | 26 |
| Roof clay | 48 | 10 | 28 |
| Roof terrat / gravel | 58 | 9 | 8 |
| Terrain grass / verge | 47 | 12 | 20 |
| Terrain dirt / sand | 63 | 10 | 18 |
| Rock / cliff | 55 | 13 | 8 |
| Metal (guardrail, posts) | 58 | 14 | 3 |
| Foliage leaf | 45 | 13 | 24 |
| Bark | 42 | 12 | 12 |
| Fabric (toldo) | 60 | 15 | 30 |
| Water base | 36 | 7 | 16 |
| **Signage, regulatory plates, emissive, vehicle paint** | **EXEMPT** | | *legal/product colours stay exact* |

- **STEP 4 — NORMAL CALIBRATION.** §2.3 AD-5 bands. Rescale XY, renormalise Z, assert.
- **STEP 5 — PALETTE SNAP.** In Lab, rotate hue toward the nearest allowed anchor(s) for the class by α: **0.60** large continuous surfaces (road, sidewalk, facade, terrain, roof) · **0.35** props, furniture, foliage, fabric · **0.00** signage, regulatory, emissive, vehicle paint. Then assert **mean colour within ΔE2000 ≤ 15** of at least one anchor. *Tunable after the first 10 assets — raise to 18 if variety collapses, drop to 12 if a kitbash appears. Set it once on evidence, then freeze.*
- **STEP 6 — PRE-GRADE COMPENSATION.** Divide final C* by **1.15** (the shipping `colorGradePass` saturation at `uRally=0`). Then re-render at ×1.52 + the S-curve (`colorGradePass.js:53`) and assert no channel clips. **Never author against the rally path.** This step's absence caused every recorded overshoot.
- **STEP 7 — ENCODE.** Format per AD-2. Mips always. Transfer per AD-3, **written then re-read and verified**. `flipY=false` per AD-4. Orientation glyph on every 2048² page.
- **STEP 8 — MANIFEST + CONTACT SHEET.** Append to `art-manifest.json`; regenerate `art-contact-sheet.png` — every library asset rendered at identical fixed lighting on identical geometry, labelled. **This sheet is the kitbash detector and no automated check substitutes for it.**

### 2.5 Scale discipline — real metres per repeat

> **RULE AD-10: Every world texture UV is WORLD-METRIC. A 20 m carriageway gets 5 repeats across; a 6 m street gets 1.5. A normalised 0..1 stretch on a world surface is a build failure.**

| Surface | Map | Covers (real m) | **texels/m** | Repeat visible at |
|---|---|---|---|---|
| Asphalt base | 1024² | 4.0 × 4.0 | 256 | 4 m |
| Asphalt **detail normal** | 512² | 0.5 × 0.5 | 1024 | 0.5 m (8× base — kills the near repeat) |
| Panot sidewalk | 1024² | 4.0 × 4.0 (20×20 units of 0.20 m) | 256 | 4 m |
| Cobble / sett | 1024² | 2.0 × 2.0 | 512 | 2 m |
| Kerb strip | 512×128 | 2.0 along × 0.5 tall | 256 | 2 m |
| **Facade array layer** | 1024² | **8.0 × 8.0 = 2 storeys of 4.0 m** | **128** | 8 m |
| Shopfront strip | 1024×512 | 8.0 × 4.0 | 128 | 8 m |
| Crown / cornice strip | 1024×256 | 8.0 × 2.0 | 128 | 8 m |
| Roof surface (atlas cell) | 1024 cell | 8.0 × 8.0 | 128 | 8 m |
| Roof coping band | 1024×256 | 8.0 × 2.0 | 128 | 8 m |
| Terrain grass/dirt/gravel/sand | 1024² | 6.0 × 6.0 | 171 | 6 m |
| Terrain rock | 1024² | 8.0 × 8.0 | 128 | 8 m |
| **Shared grunge macro (AD-6)** | 512² R8 | **64 × 64** roads/props / **128 × 128** terrain | 8 / 4 | 64 / 128 m |
| Water swell normal | 512² | 24 × 24 | 21 | 24 m |
| Water chop normal | 512² | 6.0 × 6.0 | 85 | 6 m |
| Shore foam strip | 512×128 | 8.0 along × 2.0 | 64 | 8 m |
| Guardrail / metal kit | 1024² | unwrapped kit | 256 | n/a |
| Jersey barrier | 1024² | 4.0 × 4.0 module | 256 | 4 m |
| Foliage atlas cell | 512² cell | ~2.4 m leaf cluster | 213 | n/a |
| Bark strip (bottom band of cell) | 512×128 | 0.5 × 2.0 | ~1024 / 256 | n/a |
| Verge grass card | 512² / 4 cells | 0.6 × 0.5 | 426 | n/a |
| Toldo fabric | 512² | 2.0 × 2.0 | 256 | 2 m |
| Sign — regulatory disc cell | 128² | 0.70 m disc | 183 | n/a |
| Sign — direction plate cell | 256×128 | 2.4 × 1.2 | 107 | n/a |
| Dynamic street-name cell | 256×64 | 2.4 × 0.6 | 107 | n/a |
| Shop fascia backplate cell | 256×64 | 3.2 × 0.8 | 80 | n/a |
| Rooftop / terrace prop atlas | 1024² / 512² | unwrapped kit | 128 target | n/a |
| Vehicle body region | of 2048² | body ~4.2 m long | ~350 | n/a |
| Pedestrian | 1024² | 1.75 m figure | ~340 | n/a |

**Scale rulings that resolve open questions:**

- **AD-11 — Facade texel density is fixed at 128 texels/m.** Today it is **21.3 × 25.6** (256² canvas over `WALL_REPEAT_HORIZONTAL_M=12` / `FLOOR_HEIGHT=10`) — **4–7× below** the ETS2 band of 85–150. Fix: `1024² over 8.0 m × 8.0 m` containing **2 storeys at 4.0 m** (Eixample principal floors genuinely run 4.0–4.5 m). Power-of-two ratio, mid-band, and it makes `FLOOR_HEIGHT=10` obsolete — a wrong number that has been quietly setting the density.
- **AD-12 — Panot ships as a 20×20 grid over 4.0 m, not as a single 0.20 m tile.** A 1024² over a 0.20 m repeat is 5,120 texels/m — absurd, and it produces a visible 0.2 m checkerboard. A 20×20 grid in one map at 256 texels/m carries per-unit value jitter, grout wear and chip variation, which is what actually reads. Requires the UV at `roadRenderer.js:1690-1694` to become `1/4.0 m` — **and that same line is an AD-4 v-flip offender, so both changes land together.**
- **AD-13 — Sign lettering is authored at ~2× regulation cap-height.** Spanish motorway lettering is 200–350 mm, which at 100 m subtends **1.9–3.3 px at 1080p/60° FOV** — unreadable. ETS2 runs ~2× so signs read at 80–150 m. **Scale discipline has exactly this one deliberate exception, named here so nobody "fixes" it later.**
- **AD-14 — Vehicle proportions are measured, never squashed.** `carModels.js:75`'s non-uniform squash "to make it read as a car" is banned and deleted, not compensated for.
- **AD-15 — Tree LOD2 impostors are RENDERS of LOD0, never hand-drawn.** That is why ETS2's distance treeline reads correctly instead of as coloured lozenges.

### 2.6 Licensing — the manifest is a gate, not documentation

**BANLIST — build fails on any hit:** CraftPix (all tiers — "free" forbids redistribution, and a public web build redistributes verbatim); any NC licence; "free for personal use"; Sketchfab non-CC0; TurboSquid free; Unity/Unreal marketplace free tiers; any real trademark, logo, brand livery, or real vehicle registration format that identifies a real plate.

**LIVE VIOLATIONS — present-tense, on `drive.anmolbhardwaj.com` today. Both P0.**
1. **CraftPix vegetation.** `git ls-files frontend/public/models/vegetation` returns **20 tracked files** (8 tree GLBs, 4 bush, 4 grass, `T_Trees_temp_climate.png` / `T_Bush_temp_climate.png` / `T_Grass.png`, and `convert.py` which names the sources at `:18-19`: `craftpix-781618-free-tree-3d-low-poly-pack`, `craftpix-561109-free-bush-3d-low-poly-models`). Plus `frontend/public/textures/trees/` holds 8 `.obj` (115/147/130/117/171/182/166/183 tris) and 4 `.webp`. **Vite copies `public/` verbatim into `dist`.** They are served today. The vegetation audit scheduled remediation at P4 "before anything reaches a deploy" — it already has. This is a **P0 takedown-and-replace**, split from the art work: delete/serve-block now, replacement art later. They may be kept in a **git-ignored local `art-src/` directory** as the measurement instrument for the card-tree A/B spike, but never in `public/`.
   They are also the **wrong biome**: `01_ash, 03_birch, 04_beech, 07_larch` — northern temperate, zero palms — against a real OSM census of **Tipuana tipu 691, Platanus × hispanica 624, Arecaceae 316, Celtis australis 311.**
2. **Futura PT.** `frontend/public/fonts/*.otf` — five commercial Monotype OTFs, 148,950–156,958 B each, **764 KB**, referenced only by `frontend/src/style.css`, which is **never imported** (grep returns nothing). Not loaded, but **served**: anyone can fetch them. Delete the directory and the file, and remove the stale comment at `main.js:566`.

**AI-generation clause.** The manifest records `aiModel` + `aiModelLicense`. Only models whose licence permits commercial use **and imposes no downstream restriction on outputs**. Draw Things running SD1.5 (CreativeML OpenRAIL-M) or SDXL qualifies; record which.

**AD-9 — AI normal clause.** AI produces **albedo only**; a luminance-derived normal is physically fake. Derivation is permitted **only** where albedo and height genuinely correlate — plaster stipple, grime, gravel, grain, fabric weave, asphalt aggregate. **Forbidden** where they decorrelate: printed lettering, painted signage, flat coloured tile, droplets, corrugated metal, mortar joints on painted render. Those come from **Blender bakes** or **ambientCG** (which ships true normals). Enforced by `normalSource: "baked"|"ambientcg"|"derived"`, with `derived` whitelisted per surface class.

### 2.7 The acceptance checklist — 14 gates

**An asset enters the library only after passing all 14. `M` = machine-checked in `build-art.mjs`, build fails. `H` = human, recorded in the manifest with a reviewer initial. No waivers — an asset that cannot pass is rejected, not exempted.**

| # | Gate | Type | Fail condition |
|---|---|---|---|
| **1** | **CONTACT SHEET.** Asset appears on `art-contact-sheet.png` at fixed lighting on standard geometry; a human confirms it does not read as a different fidelity tier from its neighbours. | **H** | Reads as from another game. *This is the only gate that catches a kitbash. It is #1 for that reason.* |
| **2** | **LICENCE.** `source`, `license`, `url`, `sha256` present; licence ∈ {CC0, public-domain, OFL, AI-with-recorded-model-licence, Blender-original}. No banlist hit. No trademark, real logo, livery or plate. | **M** | Missing field, non-CC0, banlist match. |
| **3** | **NORMALIZE PROVENANCE.** `normalizeVersion` current; all 8 steps ran; `k` matches the declared source type. | **M** | Step skipped, or a photoscan shipped at `k=0`. |
| **4** | **PALETTE.** Post-normalize mean within **ΔE2000 ≤ 15** of a §2.4 anchor; exempt classes declared. | **M** | Out of range and not exempt. |
| **5** | **Lab TARGETS.** L* mean ±4, L* σ ±3, C* mean ±5 of the class row. | **M** | Out of band. |
| **6** | **PRE-GRADE.** Correct at `uRally=0` (×1.15); no channel clips at `uRally=1` (×1.52) + S-curve. | **M** | Any clip in rally. |
| **7** | **NORMAL STRENGTH.** mean \|N.xy\| in the class band; Z renormalised; `normalScale=1.0` at the call site. | **M** | Out of band, or a runtime `normalScale ≠ 1.0` used for taste. |
| **8** | **NORMAL PROVENANCE.** `normalSource ∈ {baked, ambientcg, derived}`; `derived` only on a whitelisted class. | **M** | Derived normal on lettering, tile, droplets, corrugation, mortar. |
| **9** | **TRANSFER FUNCTION.** sRGB on albedo/emissive/impostor, LINEAR on normal/ORM/mask, **written and re-read from the DFD**. | **M** | Any mismatch. *Fails silently at runtime.* |
| **10** | **ORIENTATION.** `flipY=false`; `⌐` glyph in the top-left 32×32 of every 2048² page; consumer UVs on glTF convention. | **M**+**H** | Glyph absent, or renders flipped in the library debug view. |
| **11** | **SCALE.** World-metric UV; declared metres-per-repeat within ±10% of its §2.5 row; no 0..1 stretch on a world surface. | **M** | Any normalised world UV, or off-table density. |
| **12** | **TILING** *(tiling maps)*. 50%-offset seam test ≤1.5× median gradient. Base repeat ≥2 m samples `grunge_macro_512` at ≥16× base scale. | **M** | Visible seam, or macro breakup absent. |
| **13** | **COMPRESSION + SAMPLER.** Format per AD-2. Mips present. Anisotropy from the central registry, never 1. At or under the §2.2 ceiling. VRAM + download logged against the domain's declared share. | **M** | Wrong format class, no mips, anisotropy 1, over ceiling, over the domain budget line. |
| **14** | **NIGHT.** Screenshot under the NIGHT preset (`envToggle.js:53-66`) with **headlights off**, asset legible. Emissive only from the §2.4 six and the shared mask page. Ground albedo survives ×0.72 wet without falling below L* 25. No reliance on bloom. | **H**+**M** | Invisible at night, off-palette emissive, own emissive texture, or crushes when wet. |

**Two standing rejections, so nobody re-litigates them:** an asset that "looks great in isolation" and fails gate 1 is **rejected** — isolation is not the shipping condition; a street with eleven other domains' assets in it is. An asset that fails only gate 4 or 5 is **re-graded, not exempted** — grading is cheap and scripted, and exemptions compound: the first makes the second arguable, and by asset ~100 the palette is advisory.

### 2.8 Night art rules

The governing fact: `main.js:192` removed the dynamic PointLights. The rig is **1 Ambient + 1 Hemisphere + 1 Directional + 2 car headlight SpotLights** (`scene.js:623,629,634,652`; `carModel.js:279`). **Zero punctual lights in the world.** `decisions.md` D-08 is the ADR, and its stated revisit condition is literally clustered lighting.

| Rule | Statement |
|---|---|
| **NIGHT-1** | **Every asset must READ at night with no punctual light on it.** Acceptance = a NIGHT-preset screenshot with **headlights off**. An asset that only works under the headlight cone fails. |
| **NIGHT-2** *(load-bearing)* | **Night value separation comes from ALBEDO VALUE SPREAD, not from lights.** Under ambient `0x6b7a9e @1.0` + hemi `0x46567e @0.6` the fill is nearly directionless, so two materials at the same L* are indistinguishable. **Maintain ΔL* ≥ 12 between adjacent large surface classes.** The §2.4 targets already satisfy this (asphalt 38 → panot 62 → facade 74) — **do not let a domain "harmonise" them.** |
| **NIGHT-3** | **NORMAL MAPS DO ALMOST NOTHING AT NIGHT.** No domain may justify a normal map on night grounds. Normal maps are a DAY investment and must be priced as one. *Stated loudly because otherwise 12 domains each budget normals "for the night look" and buy nothing.* |
| **NIGHT-4** | **Emissive = a per-instance SCALAR × a MASK CHANNEL in ONE shared city-wide 1024² R8 page** (1.365 MiB). Never a per-asset emissive texture, never a per-material emissive colour. Colours restricted to the six. |
| **NIGHT-5** | **No asset may rely on bloom to be visible.** Bloom is `threshold 1.1 @ exposure 1.6`, and the post plan skips the pass entirely below strength 0.05 and drops 5 mips to 4. Anything visible only through bloom vanishes there and on mobile. |
| **NIGHT-6** | **The four things that actually buy night quality, in order:** (a) albedo value spread; (b) the **v9 baked sky-visibility AO grid** — free, already baked, and the only real occlusion at night, so **de-lighting matters MORE at night than in day**; (c) emissive masks; (d) the headlight cookie. Budget night effort against this list, not against normal maps. |
| **NIGHT-7** | **Wet road is the cheapest night win available:** albedo ×0.72, one Blinn lobe, one low-frequency puddle mask weighted to the camber gutters. **Therefore every ground albedo ships authored DRY with L* high enough that ×0.72 does not crush below L* 25.** Asphalt L* 38 → 27 wet: holds with 2 to spare. Do not let asphalt drift below L* 36. |
| **NIGHT-8** | **HARD BAN: no boot-time canvas atlas, ever again.** The night-window atlases are 55.9 MiB measured resident — the largest single VRAM object in the project. **Their death funds every other domain's textures.** Night windows become a 512² mask layer inside the facade array. |
| **NIGHT-9** | **Warm-vs-cool IS the night look.** Emissives are warm (N1–N3), the ambient rig is cool. **No domain adds a cool emissive to a residential/street context** — N6 is for commercial backlit boxes and institutional blue only. Break this and night collapses to monochrome. |
| **NIGHT-10** | **The night sky is currently one flat navy field** (`envToggle.js:63` `skyVisible:false`, `:64` `bgColor 0x0a1224`). Any asset silhouetted against sky at night — parapets, treelines, guardrail posts, gantries — is being judged against a flat field and will read as a cutout. **Silhouette assets must be evaluated only after the night dome + horizon light-pollution band lands.** |
| **NIGHT-11** | **Delete the fake-light stack as real lights arrive; do not accumulate both.** Real lights make five of six fakes redundant — clustered lighting is closer to a SWAP than an addition. Any domain adding a new night fake must name which existing fake it replaces. |

---

## 3. The unified budget

### 3.1 The savings ledger — banked ONCE, named owner, phantoms struck

| # | Saving | Value | **OWNER** | Struck from | Phantom removed |
|---|---|---|---|---|---|
| S1 | `renderer.shadowMap.autoUpdate = false` + explicit `needsUpdate` on tile reveal **and** car movement | **-1.35 ms** | **pipeline-materials** (P0, 0.5 d) | sky (-1.2), buildings-facade (-0.6) | **+1.65 ms** |
| S2 | Per-object / per-instance LOD (`staticPools.js`) | **-3.00 ms** | **pipeline-materials** (P2, 6 d) | buildings-facade (-1.4), vegetation (-1.5) | **+2.90 ms** |
| S3 | `RadialBlurPass` delete | -0.70 ms | sky-atmosphere | — | — |
| S4 | `OutputPass` folded into `colorGradePass` | -0.15 ms | sky-atmosphere | — | — |
| S5 | Fake-night stack deletion (pool + hero-spill decals) | -0.90 ms ⚠est | sky-atmosphere | — | conditional on the light grid landing |
| S6 | Road-family fog-cull fix (W7) | -0.30 ms, **-25 draws** | road-surface | — | — |
| S7 | Blob-shadow pool deletion (13,963 × 7 m transparent quads, 3–5× lower-screen overdraw) | -1.00 ms ⚠est | vegetation | — | *distinct from S2 — a blend-pass deletion, not an LOD gate* |
| S8 | Edge-strip subsystem delete (`if(false)` sidewalk branch; 8,588–9,496 tris/tile; `frustumCulled=false`) | -0.20 ms | road-surface | — | — |
| S9 | Street-dressing fog-cull (4 meshes absent from the `hideAll` list at `:2919-2952`) | -0.40 ms | buildings-detail | — | — |
| S10 | `sky.renderOrder` (40 km dome, `depthWrite:false`, no renderOrder at `scene.js:594-598`) | -0.20 ms ⚠est | sky-atmosphere | — | — |
| | **TOTAL POOL** | **-8.20 ms** | | | **+4.55 ms of phantom removed** |
| | **After a 5% haircut on the three ⚠ estimates** | **-8.10 ms** | | | |

Vehicles' -0.8 ms (triangle + draw cut) is **not** in the pool — it is netted inside their own allocation to avoid a fourth double-count.

### 3.2 GPU — allocation (NET MARGINAL against the measured 13.3 ms baseline)

| Domain | Gross ask | **ALLOCATED** | What was removed and why |
|---|---|---|---|
| pipeline-materials | 0.5 | **0.50** | registry chained injection + detail-map fetch |
| road-surface | 5.0 | **1.20** | 5.0 was a **gross frame share** re-declaring ~3.0–3.5 ms of existing road spend; self-flagged LOW confidence (R-17). The P0 measurement gates it. |
| buildings-facade | 3.6 | **0.80** | normalMap +0.8, bands +0.15, roofs +0.1, railing card -0.2; **-1.4 LOD and -0.6 shadow credits struck** |
| buildings-detail | 1.2 | **0.60** | S9 (-0.4) banked separately, not inside |
| ground-floor kit | — | **0.15** | new line |
| signage | 0.6 | **0.45** | |
| vegetation | 3.2 | **0.90** | alpha-test fill + 2-draw depth prepass; **-1.5 LOD credit struck**, S7 banked separately |
| terrain-coast | 2.2 | **0.20** | Self-declared LOW confidence; its own reasoning concedes 5 fetches + ~40 ALU is plausibly **cheaper** than the shipped 5-layer FBM (250–300 ALU, zero fetches). Ceiling, not spend. |
| water | 1.5 | **0.30** | wet-road shading moved to road-surface; rain CUT; boats CUT; sea contributes 0.0 at the Eixample benchmark by its own admission |
| sky-atmosphere | 4.6 | **2.30** | 2.0 of the 4.6 was existing spend (bloom 1.4, grade 0.25, sky/clouds/moon/stars 0.35). Real new = light grid 2.0 + cookie 0.05 + sky texture 0.05. Rain CUT. |
| vehicles | 2.5 | **0.50** | Their own ledger is roughly flat (-0.8 / +0.6 / +0.4 / +0.3). 2.5 was headroom padding. |
| road-furniture | 0.8 | **0.30** | net after deleting reflector studs and dropping `DoubleSide` from 141 km of parapet |
| hud-progression | 0.6 | **0.10** | **no game mode runs at the benchmark** — its real contribution is 0.0 |
| **SMAA (NEW — unowned in all 12)** | — | **0.50** | assigned to sky-atmosphere as post-chain owner |
| | **26.3** | **Σ = 8.55 ms** | |

```
measured night baseline (Eixample, 80 km/h)        13.30 ms
+ allocated new spend                              + 8.55 ms
− savings pool (banked once, haircut applied)      − 8.10 ms
────────────────────────────────────────────────────────────
PROJECTED p95 NIGHT GPU                             13.75 ms
CAP                                                 15.00 ms
MARGIN                                             + 1.25 ms   ✅ FITS
```

Against the raw asks the same sum is 13.3 + 26.3 − 12.6 = **27.0 ms**. The 13.25 ms difference is **4.55 ms of phantom savings removed** + **8.7 ms of gross-vs-net restatement** + **~4 ms of cuts**. Nothing is fudged; every millisecond is attributed.

### 3.3 Texture VRAM

**Baseline today: 95.7 MiB texture + 34.0 MiB EffectComposer/bloom render targets (correctly identified by SKY-11 and omitted from every prior budget table) = 129.7 MiB already spent.** Note the composer allocates both HalfFloat ping-pongs in its constructor regardless of pass count, so neither the OutputPass fold nor the RadialBlurPass delete frees any of it.

**Retirements**

| # | Retirement | Value | OWNER |
|---|---|---|---|
| V1a | Night emissive atlas GRID 4→2 (identical texel density; **do not** drop BASE — at BASE 64 each lit window is a 2×9 px rect) | **-41.9** (measured 55.9, **not** the 85.3 structural bound) | pipeline-materials P1, 0.5 d |
| V1b | Night atlas fully replaced by the authored 8-layer window-mask array | **-14.0** | buildings-facade P3/P4 |
| V2 | Vehicle shared-template cache: 512² colormap 18 resident → 1 | **-22.7** | vehicles P0, 1.5 d |
| V3 | Car paint PMREM 256 → 128 | **-4.5** | vehicles P0, 0.25 d |
| V4 | `grass.jpg` 1024 RGBA8+mips — bound, decoded, **never sampled** in the shipped rally path | **-5.6** | terrain-coast P0 |
| V5 | Facade day canvases (8 × 256²) | **-2.7** | buildings-facade P3 |
| V6 | Vegetation unmipped billboard canvas | **-0.5** | vegetation P3 |
| V7 | Signage unbounded per-string texture Maps | **-1.7** | signage P4 |
| | **Total** | **-93.6, haircut 15% → -79.5** | |

*(Geometry VRAM, recorded separately and NOT spendable against a texture cap: pedestrian vertex buffers 22.8 → 4.5 MiB, duplicated car geometry -5.0 MiB.)*

**Allocations**

| Domain | Ask | **ALLOCATED** | Cut |
|---|---|---|---|
| pipeline-materials | 12 | **8** | 4.8 MiB of "ask once" slack |
| buildings-facade | 28 | **20** | the 10 MiB second-hero-facade tier |
| buildings-detail | 10 | **8** | shopfront pair moves to the ground-floor kit |
| ground-floor kit | — | **2** | new |
| signage | 9 | **8** | text page **stays 2048×1024 R8** — 42,876 named records argues for more cells, not fewer |
| vegetation | 14 | **12** | palm/conifer second sheet |
| terrain-coast | 14 | **7** | the pessimistic 13.4 Windows figure is **not budgeted** — the FORMAT_OPTIONS override is mandatory |
| water | 6 | **2** | rain/droplet/boat lines cut or moved |
| sky-atmosphere | 42 | **8** | 34 was already-resident RTs (now in the baseline). New: sky dome 2 keys 2.67 + cloud 1K 1.33 + cookie 0.35 + corona 0.09 + grid 0.04 + **TOD PMREM 2 keys × 1.5 = 3.0** (previously booked as "zero bytes") |
| vehicles | 30 | **17** | 9 MiB was geometry; people atlas 2.8 cut with the ped art pass |
| road-furniture | 5 | **5** | fourth stone pair |
| road-surface | 14 | **8** | second asphalt variant deferred |
| hud-progression | 6 | **2** | the 4.45 MiB expanded-map transient is not concurrent with driving |
| **SMAA (NEW)** | — | **2.2** | edge + blend RTs, area + search LUTs |
| | **191** | **Σ = 109.2** | |

```
baseline (95.7 texture + 34.0 render targets)      129.7 MiB
− retirements (haircut applied)                    − 79.5 MiB
+ new allocations                                  +109.2 MiB
────────────────────────────────────────────────────────────
PROJECTED RESIDENT                                  159.4 MiB
CAP                                                 200.0 MiB
MARGIN                                             + 40.6 MiB   ✅ FITS
```

⚠ **The 95.7 measurement must be re-derived from the registry manifest before any domain spends the difference.** The itemised retirements (93.6) nearly exhaust it, leaving ~2 MiB for ~34 other canvas textures — not credible. The margin survives a 40% error in the retirement figure; do not plan past that.

### 3.4 Download

**RULING on the 11.5 MB menu-imagery reclaim — the most consequential double-count in the programme.** `pipeline-materials` P0 and `hud-progression` P0 bank the *same six files*: `public/modes/*.png` (5 × 941×1672 8-bit RGB PNG = 7,895,573 B), `title-bg.png` (1,605,337 B — superseded in-page by `title-bg.webp` at `index.html:172` but still shipped and still referenced by `og:image` at `:31` and `twitter:image` at `:38`, both pointing at the **placeholder domain `barcelona-drive.example`**), and `logo-barcelona-drive.png` (945,134 B).

> **Ruling: hud-progression owns it (it owns `index.html` and `escMenu.js:16`); pipeline-materials strikes its line. AND — the cap reads "ART LIBRARY download ≤ 24 MB". Menu PNGs are not the art library. The reclaim is credited as PAGE WEIGHT and may NOT be spent as art-library headroom.** The 24 MB is met by cuts.

| Domain | Ask | **ALLOCATED** |
|---|---|---|
| pipeline-materials | 0.3 | **0.30** (Basis transcoder, 0.217 brotli-measured) |
| buildings-facade | 5.0 | **4.30** |
| buildings-detail | 2.6 | **2.00** |
| ground-floor kit | — | **0.40** |
| signage | 1.2 | **1.00** |
| vegetation | 3.0 | **2.20** |
| terrain-coast | 1.8 | **1.50** |
| water | 2.0 | **0.40** |
| sky-atmosphere | 1.5 | **1.30** |
| vehicles | 6.5 | **4.50** |
| road-furniture | 2.2 | **1.70** |
| road-surface | 3.5 | **2.20** |
| hud-progression | 1.2 | **0.50** |
| SMAA LUTs | — | **0.10** |
| | **30.8** | **Σ = 22.40 MB — cap 24.0 — margin 1.60** ✅ |

**Page weight, banked once, separately:** −11.5 MB (hud menu imagery) − 3.09 MB (`adventurer.glb` + `punk.glb`) − 2.9 MB (CraftPix tree set, mandatory) − 0.764 MB (Futura OTFs) = **−18.3 MB**. **Net first-load change: +22.4 − 18.3 = +4.1 MB.**

**Off-budget and larger than everything above:** terrain hands back **383.4 MB** of tile payload (`bakedTerrain` 369.0 + `bakedPhysicsTerrain` 14.4 — `createTerrainTrimesh` at `tileManager.js:1179` has zero call sites; the only other greps are two comments at `:1660` and `:1692`, and `:1660` is a *stale comment describing physics behaviour that no longer happens*). Corpus 542.6 → ~175 MB; per-tile fetch 1.27 → 0.41 MB. **This touches none of the four binding caps — it is a streaming-latency win. It must not be sold as "the item that buys the art," or it gets scheduled ahead of items that do.**

### 3.5 Draws and triangles

All figures re-derived at the 9–18 denominator (R-B).

| Domain | Draws ask → alloc | Tris ask → alloc |
|---|---|---|
| road-surface | 110 → **45** (110 was ~2× its own post-W7 steady state of 9–15 tiles × ~4 meshes) | 180k → **120k** |
| pipeline-materials | 24 → **24** (global pools; does not scale with GRID_RADIUS) | 0 → **0** (creates ~-350k) |
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

Today's measured 261–289 draws → ~278. **Flat.** This is a *replacement* of draw composition, not an addition.

⚠ **The current triangle total does not reconcile and is a P0 gate.** Vegetation's 851,743 (arithmetic-verified: `CylinderGeometry(r, r*1.4, h, 3, 1, open)` = 6 tris + `IcosahedronGeometry(r, 0)` = 20 tris/lobe, variants 66/66/46/66, mean 61.0 × 13,963) + vehicles ~1.08 M + terrain 161,290 + roads ~175k = 2.27 M of a stated 2.32 M total, leaving ~50k for **all buildings across 9–18 tiles** — while one dense tile alone carries 16.6k walls + ~7k roofs + up to 154k detail. **One capture of `renderer.info.render.triangles` at the benchmark replaces all five estimates before the triangle budget is signed off.**

### 3.6 Every double-count removed, and who lost it

| Double-count | Claimed | Real | Kept by | **Lost by** |
|---|---|---|---|---|
| `shadowMap.autoUpdate` | 3.00 ms (×3) | 1.35 ms | pipeline-materials | sky (-1.2), buildings-facade (-0.6). Also 1.1 d of work items for a 0.1 d fix → 0.5 d. |
| Per-object LOD | ~5.9 ms (×3) | 3.00 ms | pipeline-materials | buildings-facade (-1.4), vegetation (-1.5). **Also double-BUILT: 11 d across two domains for one pool system, with overlapping ranges in `meshMaterializer.js` (839-900 vs 862-880) and `tileManager.js` (3058-3078 vs 3060-3078) — a guaranteed merge conflict. → 6 d, one owner. Saves 5 d.** |
| Menu-imagery reclaim | 17.8–23 MB (×2) | 11.5 MB, **page weight only** | hud-progression | pipeline-materials. And **neither** may bank it as art-library headroom. |
| Wet roads + rain + windshield | ~2.7 ms, ~2.1 MiB, 9 d across 3 domains | 0.3 ms wet shading; rain CUT | road-surface (material + uniform), water (puddle mask chunk), sky (weather-state driver) | water loses rain (2 d) + windshield; sky loses its rain pass in v3 |
| Sea normal + shore foam | 0.74 MiB, 2 d, 1 draw (×2) | once | water (`waterChunk.glsl.js`) | terrain-coast |
| Sea sink bake | 4 d, two incompatible depth profiles (-3.0 vs -1.0→-8.0) on the same lines | 2 d | **terrain owns the file** (it owns the elevation grid and the `getElevationAt` contract) and **implements water's profile + water's commit-blocking validator** | water loses the file |
| Facade draw collapse | ~-15 draws (×2) | once | pipeline (pooling delta); buildings-facade (material-key collapse 16→1-2 only) | — |
| Triangle handback | ~890k offered (×2) | ~540k (both come from the same LOD change on the same far geometry) | vegetation books its own; pipeline books 0 | pipeline-materials' separate -350k |
| Night atlas reclaim | -64 MiB | -41.9 MiB | pipeline-materials | -22 MiB of pipeline's headline "-52 MiB net", which becomes **-30 MiB** |
| Vehicles VRAM return | -28.6 MiB against a **texture** cap | -10 MiB texture | vehicles (geometry recorded separately) | ~19 MiB may not be spent by others as texture headroom |
| Ground light pools | deleted and built simultaneously | extract the decal geometry/material into a shared module first (0.25 d); sky deletes the **streetlamp instances**, not the mechanism; vehicles reuses it | both, at 0.25 d | neither loses budget |
| Sky TOD PMREM | "zero bytes" | **+3.0 MiB VRAM** (2 keys × size 128) | sky-atmosphere, now line-itemised | — |

### 3.7 What was cut — and the quality cost, stated plainly

| # | Cut | Recovers | **Quality cost** |
|---|---|---|---|
| 1 | **Rain, in all three implementations** (water's InstancedMesh streaks + windshield quad; sky's screen-space ShaderPass) | 9 d, ~1.0 ms, ~2.1 MiB, ~0.5 MB | **No rain in v3.** Real. But the p95 benchmark is a clear night so it costs 0 ms there, and it is the largest duplicated line in the programme. **Wet-road SHADING stays** (0.3 ms) — the ETS2 night money shot, ~70% pre-wired. |
| 2 | **Pedestrian art rebuild** — the domain's own kill criterion applied FIRST | 5 d, 2.8 MiB, 0.9 MB, ~110k tris | Peds stay untextured palette figures at ~1/3 the count (PED_CAP 168→60). **This lands CLOSER to the ETS2 reference, not further** — V-15 states ETS2 has essentially no interactive crowd, and the P2 per-instance LOD (needed anyway for parked cars) delivers the entire triangle and VRAM benefit the 5-day pass claimed (743k → ~170k tris, 22.8 → ~6 MiB). |
| 3 | **`greensRenderer.js` as a surface** | 2.5 d, ~17 draws, one polygonOffset class, one `patchAoDarkening` glow-hack, and the "greens follow terrain" risk | **Negative cost — parks get better.** 4,117 green polygons become a weight channel in a splat terrain is building anyway. Keep only the ~20 lines of polygon-to-weight rasterisation. |
| 4 | **Separate sea surface mesh** (terrain P2) | 3 d, 1 draw, 8k tris | **Zero.** Identical pixels. The sea already rides resident terrain geometry (`aCoast` at `terrainRenderer.js:766`/`:887`, `GRID_RADIUS=1`, FogExp2 0.005 fully attenuating by ~400 m). |
| 5 | **Marina boats** | 2 d, 1.37 MiB, 0.6 MB | The harbour reads empty. Content nice-to-have with no ETS2-bar justification. |
| 6 | **Second hero facade tier** (10 MiB) | 10 MiB | 8 layers carry all variety over 40,828 buildings. **Repetition risk is real** — mitigated by keeping block-aware layer selection + per-building dirt-tint. *This is the cut I am least comfortable with.* |
| 7 | **Second asphalt variant** (`asphalt_patched_1k`) | 1.5 MiB, 0.5 MB | Less macro carriageway variation. Per-fragment world-XZ macro noise at ~40 m covers ~70% of it for 0 VRAM. |
| 8 | **Direction boards + gantries → P4** | (deferred, not killed) | No motorway signage on the Ronda until P4. Text-atlas sizing is unvalidated against 42,876 named records; re-run the census first. |
| 9 | **W-beam at-grade extension moved P1 → P4** | risk, not days | Guardrails only on the 183 tiles with elevated road until late. **Correct trade:** HIGH risk, depends on a terrain drop-off query that has already false-triggered once (`gotchas.md:814`, D3), and the audit itself says "if placement scatters W-beam through the Eixample grid it will look actively wrong and the user will reject it." Bollards (pilones) take its slot: LOW risk, zero new draws, on every Eixample chamfer. |
| 10 | **3-key TOD sky → 2-key** | 1.5 MiB, 0.35 MB, 0.5 d | Dawn/dusk keep the analytic gradient under a cross-fade. Day and night both get real photographic cloud structure. **The challenger's diagnosis granted at 1/3 the cost.** |
| 11 | **Window recesses** (12 cm geometric inset) | 2 d | The normal map carries it at the ETS2 bar. First restore if days free up and the light grid landed. |
| 12 | **Scooters** | 2.5 d | Loses the most Barcelona-specific street detail (highest two-wheeler density in Europe). **Flag: first item restored if the vehicle kit comes in under its 8-day estimate.** |
| 13 | **All HUD progression → P4** | (deferred) | See §8. **AND the economy's primary money sink is REFUTED, not merely unverified:** hud's car ownership depends on the Kenney city-car GLBs, which the vehicles asset list schedules for **DELETION**. Recorded as a NO, redesigned in §8. |
| 14 | **Milky Way, moon phase, star size, zona30 stencils, tactile paving, rooftop clutter (→P4), terrace props (→P4)** | ~7 d | Zero cost at the benchmark. |

**Days recovered by cuts: ~52. By de-duplication: ~19** (LOD pool 5, ground floor 4.5, sea sink 2, foam 2, rain 4, shadow 0.6, menu 0.5). **Days added: 8.25** — SMAA 1.0, rallyStyle ADR + 7-consumer migration 1.0, canvas register + lint 1.0, triangle/VRAM capture 0.25, `patchRoadWash` split 0.25, ground-pool decal extraction 0.25, vehicle source survey 0.5, quality tier moved to P1 (0 new days), tram contract 0.5, urbanFeatures + busStops 2.0, tunnel interiors 1.5 (partial, rest in backlog).

---

## 4. Phases

Each phase is **independently shippable** and **visibly better than the last**. Nothing art-side is honest before P0–P1's four gates: measurement → KTX2 + disposal → AA → LOD.

---

### P0 — TRUTH, SAFETY, DELETION · 8.3 days

**Goal.** Make the project measurable, make shared resources safe to introduce, remove the two live licence exposures, and delete everything that is provably dead. **Not one texture is authored in this phase.**

**Numeric exit criteria**
- `renderer.info.render.{calls, triangles}` and texture VRAM captured at the benchmark (80 km/h, night, dense Eixample, production build, pr 1.0) and committed. This single capture **replaces all five domains' triangle estimates**.
- Night GPU improves by **≥1.0 ms** from `shadowMap.autoUpdate` alone.
- Page weight down **≥14 MB**; `git ls-files frontend/public` returns **zero** CraftPix files and **zero** `.otf`.
- Time-to-drive (navigation-start → `dd-loading` hide) recorded as a committed baseline number.
- Tile payload down **383.4 MB**; per-tile fetch 1.27 → 0.41 MB.
- Zero regressions in a 3-minute drive: `renderer.info.programs.length` delta = 0.

| What | Subsystem | Files | Days | Depends | Risk | Re-bake |
|---|---|---|---|---|---|---|
| Pin three to exact **0.183.1** (drop the caret) — 5 foundation items depend on r183 private internals (`FORMAT_OPTIONS` ordering, `bm._visibilityChanged`, `painterSortStable` field order, `BatchedMesh._reserveRange`, the DOUBLE_SIDED derivative-TBN flip) | pipeline | `frontend/package.json:22` | 0.1 | — | low | no |
| **Invert the shared-material disposal default** to an explicit `userData.ownedMaterial` opt-in, and tag the **13** untagged sites. Add a dev assert that no material reachable from the art registry is ever disposed. **P0 BLOCKER: without this, the first shared KTX2 texture is destroyed on the first tile unload.** | pipeline | `tileManager.js:2856-2874`; `roadRenderer.js:2088,2198,2744,2963,4325,4879`; `crashBarrierRenderer.js:401,406`; `reflectorRenderer.js:312,321`; `waterRenderer.js:236,309`; `vegetationRenderer.js:1124` | 0.75 | pin three | medium | no |
| `renderer.shadowMap.autoUpdate = false` **plus explicit `needsUpdate` on tile reveal AND on car movement.** Do not ship the flag alone — the player car is the only remaining dynamic caster, so tiles streaming in while stationary would get no shadow. Fix the lying comment at `main.js:969`. **Banked ONCE.** | pipeline | `scene.js` (renderer ctor), `main.js:955-970`, tile-reveal hook in `tileManager.js` | 0.5 | pin three | medium | no |
| **Measurement harness.** `programs.length` at loader-hide and after 3 min (target delta 0); VRAM computed from the registry manifest, not guessed; per-tile-unload disposal assertions; **time-to-drive** from navigation-start to `dd-loading` hide (`main.js:631-635`, 20 s safety net at `:723` hides regressions until severe). | pipeline | `perfLogger.js`, `scripts/route.js` (new) | 1.0 | — | low | no |
| **One capture** of draws / triangles / VRAM at the benchmark. Replaces all estimates. | pipeline | `perfLogger.js` | 0.25 | harness | low | no |
| gpuTimer brackets for the **road** family and the **terrain** family separately, at 3 poses, day and night, 0 and 80 km/h | road, terrain | `main.js:150`, `tileManager.js:1709` | 1.0 | harness | low | no |
| ⚠ **Split `patchRoadWash` into `patchRoadAO` (permanent) + `patchRoadNightWash` (deletable)** — it currently carries BOTH the night wash AND the v9 baked sky-visibility AO. Deleting it wholesale silently removes baked AO from every road in the city with **no error**. | road | `roadRenderer.js:283-301` | 0.25 | — | medium | no |
| **DELETE the CraftPix set from the served build** (move to a git-ignored `art-src/`). `frontend/public/models/vegetation/*` (20 tracked files) + `frontend/public/textures/trees/*` (8 `.obj`, 4 `.webp`). Also delete `frontend/public/textures/new textures/craftpix-*`. | vegetation | `frontend/public/models/vegetation/`, `frontend/public/textures/trees/`, `.gitignore` | 0.25 | — | low | no |
| **DELETE `frontend/src/style.css` + `frontend/public/fonts/*.otf`** (5 commercial Monotype Futura PT, 764 KB, served on a custom domain) + `ui/directionDisplay.js` (58 L, zero importers) + the stale Futura comment at `main.js:566` | hud | as listed | 0.25 | — | low | no |
| **Menu imagery → WebP.** 5 panels 941×1672 → 800×1422 q80; logo → WebP; delete `title-bg.png`; repoint `og:image`/`twitter:image` to one 1200×630 WebP card on the real domain. 10,446,044 B → ~1.0 MiB. Add PLAY-hover preload so the picker does not stall on mobile. | hud | `public/modes/*`, `public/logo-*`, `public/title-bg.png`, `index.html:31,38,262-266,288,315`, `escMenu.js:16` | 0.5 | — | low | no |
| Delete `adventurer.glb` (1.84 MB) + `punk.glb` (1.24 MB) + `cars/Textures/colormap.png` (unreferenced) + `CAR_TINTS`/`LIVERIED`/`TINT` dead code + the permanently-null map/normalMap reads | vehicles | `car/trafficSystem.js:22-29,68-70`, `car/parkedCars.js:35-49,97-106,187-190`, `car/carModel.js:113-114` | 0.5 | — | low | no |
| **Delete `bakedPhysicsTerrain` parsing/transfer + `createTerrainTrimesh`** (zero call sites) + `getTerrainDetailTexture` + the `grass.jpg` fetch + the no-op stubs + the unreachable `beach` KIND. −416 KB download, −4 MB image decode, −14.4 MB of tile payload from the parse path. | terrain | `tileParserWorker.js:192-194,226,938`, `tileManager.js:1179`, `terrainRenderer.js:18-32,768,783`, `areaFeaturesRenderer.js:22-28` | 0.5 | — | low | no |
| **Sky P0 sweep:** fog-density clobber (`main.js:768-770` overwrites `scene.fog.density` with a hardcoded 0.005 every frame, so DAY 0.0032 / NIGHT 0.0045 never ship) · single-source the sun (`sunState.js`) · cloud + star X-mirror (`main.js:923,925` pass `viewerWx/Wz` while `:924` correctly passes `camera.position` for the moon) · `sky.renderOrder` · **DELETE `dayNight.js` (144 L) + `timeSystem.js` (42 L)** + their CONFIG flags · dead-code sweep (unread star size attr, no-op bloom resolution write, 3 rally constants envToggle overwrites at boot) | sky | `main.js:761-770,923-925,81-82,196-198,931-933,975`; `scene.js:353-363,594-598,600-605,690-711,658`; `envToggle.js:126-131`; `dayNight.js`, `timeSystem.js`, `config.js:13-15,55`; new `sunState.js` | 1.6 | — | low | no |
| **polygonOffset chokepoint assert** — dev-mode throw if any material sets polygonOffset outside `applyGroundLayer()`. Fix the 3 violations: lane arrows -3 → `'stencil'`(-18) (a live depth-test bug), drain covers -2 → new `'drain'` class, delete the dead bridge-shadow -1. | road | `groundLayers.js`, `roadInfraRenderer.js:374,526,553`, `roadRenderer.js:3717` | 0.5 | — | low | no |
| Ground the parked cars (re-add the blob list inside the existing `contactShadows.begin/commit` window; pool has 700 capacity vs ~196 used) + speedometer rAF dirty check (`speedDisplay.js:75-96` re-arms unconditionally and `_draw()`s a 436² retina canvas every frame on the title screen, in fly mode, and behind the ESC menu) | vehicles, hud | `parkedCars.js:51,97-114,134-205`, `main.js:514-520,878-884`; `speedDisplay.js:75-96,194-196` | 0.75 | — | low | no |
| **DELETE the colliding Delhi-era commercial detail blocks** — `pillarGeoms`, `awningGeoms`, `signboardGeoms` and their `mergeAndPush` calls; they intersect the Barcelona shopfront/awning/sign renderers on exactly the arterial buildings the player drives past | buildings-detail | `buildingWorker.js:1341-1390,2031,2035,2036`; `meshMaterializer.js:55,61,62` | 0.25 | — | low | no |
| **LOD-gate and fog-cull the street dressing** — add `shopSignMesh`, `shopfrontMeshes`, `awningMesh`, `cafeTerraceMeshes` to BOTH the `hideAll` block and the per-mesh LOD loop at ~140 m; remove `frustumCulled=false` from the terrace IMs. **Returns ~25 draws and ~150k always-submitted triangles** (S9). | buildings-detail | `tileManager.js:2919-2946,2952-3131`; `cafeTerraceRenderer.js:196` | 0.5 | — | low | no |
| **Shrink the car paint PMREM 256 → 128** (6.0 → 1.5 MiB for a two-colour smoothstep gradient). Verify against G-44. | vehicles | `carModel.js:124-162` | 0.25 | — | low | no |

**WHAT THE GAME LOOKS LIKE AT THE END OF P0.** Visually almost identical, with three real wins the player feels: it **loads noticeably faster** (−14 MB of page weight; −383 MB of tile payload means per-tile fetch drops from 1.27 MB to 0.41 MB), it **runs ~1.5 ms faster at night**, and the top-centre HUD band stops overlapping. Parked cars are grounded. The Indian tricolour bridge poles and the Delhi commercial pillars/awnings/signboards that intersect the Barcelona shopfronts are gone. The project is now **legally clean and measurable** — which is the only thing that makes every number in §3 honest.

---

### P1 — THE ASSET PIPELINE AND THE FRAME · 21.2 days

**Goal.** Build the thing that does not exist: an asset layer. Nothing textured can ship before it, and every asset authored before the quality tier exists has to be re-emitted, so the tier lands here too.

**Numeric exit criteria**
- `scripts/build-art.mjs` runs end-to-end on **three** pilot assets (asphalt, panot, roof) and **exits non-zero** on a deliberately-broken transfer function, a deliberately-broken tiling seam, and a deliberate byte-ceiling overrun.
- A `.ktx2` texture loads, survives **20 tile unloads** without disposal, and transcodes to **BC1 (4bpp)** on a Windows/NVIDIA check — not BC7.
- SMAA lands: measured cost **≤0.6 ms**, and a 80 km/h night pass shows no new shimmer on the existing flat road.
- `renderer.info.programs.length` delta after a 3-minute drive = **0** with the extended warm list.
- Draws down **≥25** from the road fog-cull fix; **≥8,588 tris/tile** removed from edge strips.
- `art-manifest.json` exists with per-asset half-res variant paths, and `art-contact-sheet.png` renders.

| What | Subsystem | Files | Days | Depends | Risk | Re-bake |
|---|---|---|---|---|---|---|
| **`loaders.js` → asset registry.** ONE module-level `KTX2Loader` with `setTranscoderPath('/basis/')` + `detectSupport(renderer)` called once; ONE `MeshoptDecoder`; both injected into every `GLTFLoader`; `getKTX2Texture(url)` promise-cache; central sampler policy (anisotropy, wrap, colorSpace, flipY) applied at load, not at 48 call sites. **Includes the mandatory FORMAT_OPTIONS BC1-over-BC7 patch.** | pipeline | `loaders.js` (rewrite), `main.js` (detectSupport wiring), `frontend/public/basis/` | 1.5 | P0 pin | low | no |
| Cache + deploy hygiene: `public/_headers` with `Cache-Control: immutable` on `/basis/*`, `/models/*`, `/art/*`; a **versioned `/art/v1/`** path (public/ filenames are unhashed); DEPLOY.md note that `vite build` empties `frontend/dist` and MUST precede the wrangler deploy at `deploy-cloudflare.sh:48` | pipeline | `public/_headers` (new), `DEPLOY.md`, `deploy-cloudflare.sh` | 0.5 | — | low | no |
| **`materialRegistry.js` — the chokepoint that does not exist.** **CHAINS** `onBeforeCompile` instead of assigning it (three's `CSM.js:443` hard-assigns and would silently delete both the road night wash and the baked v9 AO from every road in the city). Routes all 68 `get*Material()` factories and the 10 current `onBeforeCompile` owners; owns sampler + colour-space policy, the night-mode hooks currently scattered across `setFacadeNightMode`/`setRoadDecalNightMode`/`setRoadNightWash`, the `aWash`+`aAO` injection, and the warm-variant list. **GATES: IBL, the light grid, the detail map, wet road.** | pipeline | new `map/materialRegistry.js`; `scene.js:430`, `terrainRenderer.js:781`, `shopSignRenderer.js:88`, `aoSampler.js:107`, `vegetationRenderer.js:183,914,1188`, `roadRenderer.js:284`, `meshMaterializer.js:656`; ~20 modules | 3.0 | asset registry | medium | no |
| **Extend the shader warm list through the registry** — cover road/terrain/vegetation/infra (not just buildings), add the `aAO` attribute the facade shader declares but `main.js:688-693` omits, and warm through the **real mesh types** (a `BatchedMesh` and an `InstancedMesh`, not a plain `Mesh`) so `USE_BATCHING`/`USE_INSTANCING` variants exist. **Must land in the same commit as the first textured material** — adding `map`/`normalMap` invalidates the entire 125-program cache at once and the recorded symptom is one-off ~100 ms frames. | pipeline | `meshMaterializer.js:965-984`, `main.js:686-699`, `materialRegistry.js` | 1.0 | registry | medium | no |
| **`scripts/build-art.mjs` — the 8-step normalize + encode + manifest + contact sheet.** Committed artefact, **never run on Pages**. Hard per-class and total byte ceilings that **exit non-zero**. Emits half-res variant paths. | pipeline | new `scripts/build-art.mjs`, `scripts/normalize-art.mjs`; fold in `scripts/optimize-textures.js` | 3.0 | asset registry | medium | no |
| **Canvas-retirement register + CI lint.** Enumerate all 48 `new THREE.CanvasTexture` sites with owner domain, target KTX2 asset and target phase; lint exits non-zero on any new site outside a **monotonically shrinking** allowlist. Without it the ~34 unowned sites survive by default, because every domain assumes foundation owns them and foundation budgeted 0 days. | pipeline | new `scripts/lint-canvas.mjs`, `docs/context/canvas-register.md` | 1.0 | — | low | no |
| **SMAA** — the largest hole in the corpus. Three audits call it a hard prerequisite and none owns it; there is no post-processing domain among the 12 and no AA work item anywhere. `scene.js:526` is `antialias:false` and the chain (`main.js:143-175`) is RenderPass → UnrealBloom → RadialBlur → colorGrade → OutputPass. | sky (post owner) | `main.js:143-175`, new `ui/smaaPass.js` | 1.0 | — | medium | no |
| **Quality / mobile tier — MOVED P2 → P1.** Coarse-pointer + device-memory detection selecting a manifest variant: half-res textures, normal maps skipped, one LOD tier removed, shadow map halved. **The pipeline must EMIT the variants** — retrofitting variant emission across ~100 authored assets is the exact "free today, unrecoverable after 100 assets" failure. `grep -i quality frontend/src/config.js` returns nothing today. | pipeline | `config.js` (new QUALITY block), `materialRegistry.js`, `loaders.js`, `build-art.mjs` | 2.0 | build-art | medium | no |
| **`rallyStyle` ADR + 7-consumer migration.** Flip the default, make `?style=rally` the escape hatch, audit all 7 consumers. Currently owned by nobody, allocated 0.25 d as "not my call", and it **gates ~26 days of vehicle art plus terrain's flatShading item**. | art direction | `rallyStyle.js:8`; `scene.js`, `main.js`, `ui/colorGradePass.js`, `car/carModel.js`, `car/carEffects.js`, `map/buildingRenderer.js`, `map/terrainRenderer.js`; `decisions.md` (new ADR D-18) | 1.0 | — | high | no |
| **ADR D-19 — the MeshStandard inventory** (§5.11). No city-wide ruling; record the per-surface inventory. Costs 0 ms and 0 days beyond writing it. Also delete `roadRenderer.js:372` `getSharedMaterials` — **17 dead MeshStandard materials, zero call sites.** | art direction | `decisions.md`, `roadRenderer.js:372-401` | 0.25 | — | low | no |
| **Per-MESH bounding-sphere LOD fallback — UNCONDITIONAL P1, not a contingency.** Replace per-tile `nearEdgeDist` with true per-mesh distance from each merged mesh's own `boundingSphere` centre (`chunkedMerge.js` already computes it). 1 day for ~1.0 of the 3.0 ms at low risk, and it is the insurance policy if the BatchedMesh path returns nothing. | pipeline | `tileManager.js:2903-2977,3058-3078`, `config.js:75-79` | 1.0 | — | low | no |
| **Make `GLOBAL_VERTEX_BUDGET` degrade instead of delete.** `buildingWorker.js:1098-1101` drops **entire buildings** via `continue`. Every geometry the art pass adds silently deletes buildings in exactly the dense Eixample tiles the gate measures, and it will be misattributed as an art bug. Change to a detail-tier downgrade (skip balconies → skip cornices → box fallback) with a counter in the metrics panel. Also raise 100,000 → 220,000 (measured max today 46,570). | pipeline / buildings | `buildingWorker.js:873,980,1098-1101,1148` | 1.0 | — | medium | no |
| **`buildingConstants.js`** — single source for `STOREY_H` (3.5, from the bake), `MODULE_W`, and the AO dials. Replaces the **triple-mirrored** `FLOOR_HEIGHT`/`WALL_REPEAT_HORIZONTAL_M` and the duplicated AO constants across `buildingWorker.js`, `meshMaterializer.js`, `buildingRenderer.js`, `aoSampler.js`. | buildings | new `frontend/src/buildingConstants.js`; `buildingWorker.js:38-39,217-219`; `meshMaterializer.js:25-26`; `buildingRenderer.js:221-222`; `aoSampler.js:29-35` | 1.0 | — | low | no |
| **DELETE the edge-strip subsystem** — `buildSidewalkAndEdgeMeshes` including the literal `if (false && CONFIG.ENABLE_SIDEWALKS …)` at `roadRenderer.js:2499`, `CONFIG.ENABLE_ROAD_EDGE_DETAIL`, `_mergedPedestrianMaterial` (which has no `applyGroundLayer` call and sets `frustumCulled=false`), `EDGE_STRIP_*`, and the 5 dead material factories + `COLOR_BY_TYPE`. −8,588–9,496 tris and 1 always-on draw per dense tile — **and the figure is larger than claimed**, because the surviving branch emits a 0.10 m strip down both sides of every non-motorway/trunk road, which includes all ~41,000 footway/path records. | road | `roadRenderer.js:155-168,372-401,482-495,1031-1050,2481-2601,5230`; `config.js:49`; `tileManager.js` | 1.0 | — | low | no |
| **DELETE the Delhi road subsystems** — `shoulderRenderer.js` (234 L, dirt shoulders; Barcelona has kerbs), `buildRoadsideBlendStrip` + its hardcoded dust palette, `buildBridgeShadowMesh` + textures (already force-nulled at `:4777`), `decalRenderer.js` (280 L of Delhi wall posters) | road | `shoulderRenderer.js`, `decalRenderer.js`, `roadRenderer.js:3677-3990,4777`, `config.js:151,161` | 0.75 | — | low | no |
| **DELETE the Delhi road furniture** — `crashBarrierRenderer.js` (451 L), `dividerRenderer.js` (142 L), `reflectorRenderer.js` (329 L, **~42k tris + 18 draws of Indian cat's-eye studs on Barcelona tertiary streets today**), and the precast-compound-wall + arched-gate blocks of `barrierRenderer.js`. Net **−1,243 lines**. | furniture | `crashBarrierRenderer.js`, `dividerRenderer.js`, `reflectorRenderer.js`, `barrierRenderer.js:62-79,312-680,995-1183`, `tileManager.js:20,2403-2415`, `config.js:152-158`, `envToggle.js:7,155` | 1.0 | — | low | no |
| **DELETE 1,679 lines of dead vegetation** — `bushRenderer.js` (344 L, zero importers), `zoneVegetationRenderer.js` (587 L, imported but `renderZoneVegetation` never called), `grassRenderer.js` (748 L, gated to zero since 2026-07-02) | vegetation | as listed + `tileManager.js:40,49,2253-2290`, `main.js:55,993` | 0.5 | — | low | no |
| **DELETE `trafficLightRenderer.js`** and its wiring — a disabled, duplicated, hard-coded-Y=0 version of code that already exists better in `roadInfraRenderer.js:326-435` | signage | `trafficLightRenderer.js`, `tileManager.js:15,2329`, `config.js:8,45-47` | 0.25 | — | low | no |
| **WIRE THE OSM SPECIES PIPE** — add `trees` to the `tileManager` destructure at `:1469` and pass into `tileData`. **35,580 real positioned Barcelona trees with 4,919 species tags** currently parsed (`tileParserWorker.js:935-940` includes `'trees'` in `PART_KEYS`) and dropped on the floor. No format change, no re-bake, no visual change yet. | vegetation | `tileManager.js:1469,1863`, `vegetationWorker.js:1827` | 0.5 | — | low | no |
| **WIRE `data.shops` + `data.trafficSignals`** — **14,542 shops (13,551 with real OSM names)** and **4,225 traffic-signal nodes** parsed and discarded. New `map/signage/signData.js` normalises nearest-shop-per-bay, signal-to-junction association, road-name resolution. **The best 0.5 days in the programme.** | signage | `tileManager.js:2452-2497`, new `map/signage/signData.js` | 0.5 | — | low | no |
| **Fix the global-unison wind** — derive phase from the per-instance transform, branching on BOTH `#ifdef USE_BATCHING` and `#ifdef USE_INSTANCING` (`environmentClusterRenderer.js:412-413` shares this material on an InstancedMesh). Update `gotchas.md` G-45. | vegetation | `vegetationRenderer.js:203-215`, `gotchas.md:558-566` | 0.25 | — | low | no |
| **Fix road-family culling (S6).** Give the markings mesh a `userData.type` so it joins the fog-cull list; compute real bounding spheres and re-enable `frustumCulled` on road/marking/sidewalk/kerb meshes. **−25 always-on draws.** | road | `roadRenderer.js:1316,1452,1579,1709,1748,1764,4647,4701`; `tileManager.js:2933-2955` | 0.5 | — | medium | no |
| Fix the live per-frame-`innerHTML` FPS regression in the two modes that never got the dashMode treatment (`policeMode.js:87` called from `:230`; `deliveryMode.js:111` from `:263`) + extend `theme.js` with `gold #c9a227`, `alert #c0553d` and a `MODE_ACCENT` map | hud | `policeMode.js:65-99,230`, `deliveryMode.js:58-125,263`, `theme.js:41-49` | 1.0 | — | low | no |
| **Extract the ground-pool decal geometry/material into a shared module** so sky can delete the streetlamp *instances* without deleting the *mechanism* vehicles reuses | sky / vehicles | new `map/groundPoolDecal.js`; `streetlightRenderer.js:214,526` | 0.25 | — | low | no |
| **Tram contract.** `createTramMeshes` (`tileManager.js:2073`) is called with **no CONFIG gate** and renders untextured tram tracks embedded in the carriageway the road domain is rebuilding. Define the contract (Y class, material ownership, atlas cell) before the asphalt shader lands. | road | `railwayRenderer.js`, `tileManager.js:2073`, `groundLayers.js` | 0.5 | — | low | no |

**WHAT THE GAME LOOKS LIKE AT THE END OF P1.** Still no new art — but this is the first phase where the game **looks measurably cleaner**: Indian cat's-eye studs and Delhi crash barriers are gone from Barcelona streets, the broad black edge-strip bands flanking the Ronda Litoral carriageways are gone, the lane-arrow depth bug is fixed, and **SMAA removes the crawling edges on every roofline and lamp post in the game** — which on its own is the single most visible change of P0–P1. Trees stop swaying in global unison. ~25 draws and ~9k tris/tile of always-on geometry are gone. And, invisibly but decisively, **a `.ktx2` can now be loaded, shared city-wide, and survive a tile unload** — which is the precondition for everything after this.

---

### P2 — LOD AND NIGHT · 15.5 days

**Goal.** Buy the GPU headroom the art wave spends, and answer the project's #1 unsolved problem. **The 1-day spike gates the 8 days behind it.**

**Numeric exit criteria**
- Per-object LOD delivers **≥2.5 ms** of the budgeted 3.0 at the benchmark, **or** K-L fires and the per-mesh fallback's 1.0 ms is banked instead.
- Light-grid spike returns **≤3.0 ms** for 32 lights, or K-N fires.
- The fake-night stack is deleted **in the same commit** as the light-grid opt-in; a 3-pose night A/B shows no double-lighting.
- Night GPU at or below **14.0 ms** with the grid on.
- A `setGeometryIdAt` unit test asserts `bm._visibilityChanged === true` afterwards.

| What | Subsystem | Files | Days | Depends | Risk | Re-bake |
|---|---|---|---|---|---|---|
| **`staticPools.js` — ONE owner, ONE pool system.** Generalise `vegPools.js` `createVegPool` into `createStaticPool`: global `BatchedMesh` pools keyed by facade category (16) instead of per-tile merged meshes, one geometry per building, `perObjectFrustumCulled = true` (recovering the culling the 500 m merge destroyed), discrete 3-tier bands via `setVisibleAt`/`setGeometryIdAt` with hysteresis. Worker emits per-building index ranges + centroids + radii — **postMessage change only, NOT a tile format change, NO re-bake.** buildings-facade's `buildingDetailPool.js` is a **second geometry source inside this**, not a second module; vegetation's `setLodAt` lands **inside** it, not beside it. As originally scheduled all three edited overlapping ranges in `meshMaterializer.js` and `tileManager.js` and were a guaranteed merge conflict. | pipeline | `vegPools.js` (generalise), new `map/staticPools.js`, `tileManager.js:2903-2977,3058-3078,141-215`, `buildingWorker.js:1976-1990,1104-1108`, `meshMaterializer.js:839-900` | 6.0 | P1 registry + warm list | high | no |
| ⚠ **ONE implementation of the `bm._visibilityChanged = true` fix, asserted in a test.** `BatchedMesh.js:1185-1193` — `setGeometryIdAt` is the only mutator in the file that does not set it, and `:1507-1511` early-returns when `!_visibilityChanged && !perObjectFrustumCulled && !sortObjects`, which is exactly `vegPools.js:45-46`. **All three audits independently rediscovered this trap.** An implementation that forgets it appears to work, costs nothing, and changes nothing — a whole sprint could be spent tuning bands that never fire. | pipeline | `staticPools.js`, new test | (inside 6.0) | — | high | no |
| **LIGHT-GRID SPIKE — 1 day, GATES THE NEXT 8.** Stub 32 hand-placed lights into a light-grid chunk on the road material only, one Eixample block, measure night GPU at 80 km/h. Converts a 1.2–2.0 ms estimate into a number. **>3.0 ms → re-scope to a 256 m window and 2 lights/cell before a line of production code.** | sky | throwaway `lightGrid.js` branch, `roadRenderer.js` | 1.0 | staticPools | medium | no |
| **`lightGrid.js`** — world-space 2.5D clustered street lighting. 64×64 RGBA8 index texture over 8 m cells (512 m window, 4 nearest-first slots/cell) + an RGBA32F lamp-data texture, sourced from the **already-existing and unused** `tileManager.getStreetlightPositions()` (`:3482`, exported `:3523`, zero callers). Rebuilt only on cell crossing. One shared GLSL chunk: distance falloff + N·L + downward cone + one Blinn lobe with a per-material roughness uniform. | sky | new `lightGrid.js`, `tileManager.js:3482-3490,3523`, `streetlightRenderer.js:2348-2378` | 5.0 | spike PASS; registry | high | no |
| **Material opt-in + warm-list extension, SAME COMMIT.** Road, sidewalk, terrain, facade, vegetation, props, traffic/parked cars, pedestrians. Adding a define invalidates all 125 compiled programs at once. | sky | `roadRenderer.js`, `terrainRenderer.js`, `vegetationRenderer.js`, `meshMaterializer.js:965-984`, ~15 modules via the registry | 2.0 | lightGrid | high | no |
| **DELETE the fake-night stack, SAME COMMIT as the opt-in** — ground-pool decals (`streetlightRenderer.js:24,113-121,214,526-531,596-599`), hero-building spill decals (`meshMaterializer.js:917-946,1023`), road night wash (`roadRenderer.js:273` — **the AO half was already split out in P0**), vegetation night wash (`vegetationRenderer.js:235`). KEEP the lamp emissive (it becomes the corona source). Half-landed, night double-lights and looks **worse than today**. Capture 3 committed night poses **before** any of it starts. | sky | as listed + `envToggle.js:147-172` | 1.0 | material opt-in | high | no |
| **Headlight cookie** — a 512² single-channel Blender-authored beam pattern on the two existing SpotLights, with a flat low-beam cut-off, pulling the cone in from 56° to a real low-beam spread. **Cheapest ETS2-identifiable win in the whole domain.** | sky | `carModel.js:269-293` | 0.5 | — | low | no |

**WHAT THE GAME LOOKS LIKE AT THE END OF P2.** This is the phase where **night stops being a fake**. Street lamps cast real pools of light that fall off correctly, rake across kerbs and parked cars, and catch the still-untextured asphalt with a genuine specular response. The headlights get a real low-beam cut-off instead of a 56° cone. Six overlapping fakes — including a 16 m ground decal per lamp at 22 m spacing, i.e. >100% road coverage — are gone, so night stops being uniformly, flatly washed. And the world gains **~700 m of correct distance falloff**: buildings tier down instead of popping at a 500 m tile edge, and everything behind the camera stops being submitted. **~3.0 ms is on the table for the art wave to spend.**

---

### P3 — THE FIRST ART WAVE · 29 days · **★ MINIMUM SHIPPABLE v3 BOUNDARY ★**

**Goal.** Spend the headroom on the surfaces that cover the most pixels per day of work: ground, facades, roofs, sky, and Barcelona's real tree species.

**Numeric exit criteria**
- p95 night GPU at the benchmark **≤ 15.0 ms** (target 13.75).
- Texture VRAM **≤ 200 MiB** resident, measured from the registry manifest.
- Art library over the wire **≤ 24.0 MB**; first-load page weight **not worse** than P0's.
- Draws **≤ 450**, triangles **≤ 2.6 M**.
- Time-to-drive regression **< 1.5 s** over the P0 baseline.
- **Every** shipped asset passes all 14 gates of §2.7 and appears on the contact sheet.
- Mid-air shopfronts: **0** (from 88.5% of buildings).
- Building detail coverage: **≥95%** of eligible buildings (from a median 26.6%).

| What | Subsystem | Files | Days | Depends | Risk | Re-bake |
|---|---|---|---|---|---|---|
| **Per-building proportional TRIANGLE budgets** — replace first-come `BALCONY_VERT_CAP`/`COMMERCIAL_VERT_CAP`/`BOUNDARY_VERT_CAP` racing in tile order. Measured: median tile delivers detail to **26.6%** of eligible buildings, p10 14.6%, worst tiles 8.5–12.4%, **127 of 158 dense tiles below 50%**. Compute a per-tile allowance, divide by eligible count, redistribute unspent slices. | buildings | `buildingWorker.js:43-47,873,1098,1148,1207-1310` | 1.5 | P1 vertex-budget degradation | medium | no |
| **MODULAR STOREY BANDS — the geometry rebuild.** Split each wall face from 1 quad (4 verts) into 3 UV-independent bands: ground (0→`STOREY_H`), body (`STOREY_H`→height−crownH, v-repeat = floors), crown. 12–16 verts/face. Simultaneously kills the 10 m wrap defect (mid-air shopfronts on 88.5% of buildings), gives the ground floor its own UV rect, **puts real vertices at 3.5/8/16 m so the baked AO fade finally works**, and creates the seam the array-texture layer index attaches to. Worst-tile wall verts 33,320 → ~100,000. | buildings | new `extrudePolygonWallBands` in `workerGeometry.js:36-125`; `buildingWorker.js:494-520,1040-1092` | 4.0 | buildingConstants; triangle budgets | medium | no |
| **Normalise building winding at source** → flip `BUILDING_SIDE` to `FrontSide`. Signed-area check per outer and inner ring, reverse when needed. Halves raster and shadow cost on the largest triangle population. **NOTE: flipping the flag alone was tried 2026-07-06 and reverted (`changelog.md:930`) — the fix must be in the worker,** with a debug pass colouring back-facing walls. | buildings | `buildingWorker.js:494-520,592-609`; `workerGeometry.js:36-125`; `meshMaterializer.js:558-562` | 2.0 | — | medium | no |
| **FACADE ARRAY-TEXTURE MATERIAL.** Delete `getWindowTexture` (`meshMaterializer.js:118-365`). `CompressedArrayTexture`: 8 × 1024² albedo + 8 × 1024² normal + 8 × 512² window mask. Per-vertex uint8 `aLayer`. Requires an `onBeforeCompile` chunk swap (`sampler2D` → `sampler2DArray`). **Array textures wrap per-layer natively, which our band UVs need — an atlas + `fract()` + `textureGrad` would seam.** Anisotropy from the registry (currently unset, default 1). | buildings | `meshMaterializer.js:118-365 (delete),596-670`; `buildingWorker.js`; new `map/facadeArray.js` | 4.0 | modular bands; P1 pipeline | medium | no |
| **Author the 8 facade layers** to the band UV spec at **128 texels/m** (`1024² over 8.0 m × 8.0 m = 2 storeys of 4.0 m`): 5 residential variants + 1 commercial + 1 office/institutional + 1 industrial-brick. Albedo (weathering baked in), normal, window mask. Ground-floor module rect and body module rect on the same layer. | buildings | new `frontend/public/art/v1/facades/*.ktx2` | 6.0 | array material UV spec | medium | no |
| **Real roof UVs + roof material — the best ratio in the entire programme.** Replace the zero-fill in `ensureUvs` (`buildingWorker.js:657-661`) with `planarRoofUvs`: `uv = (worldX / TILE_M, worldZ / TILE_M)`. World-space projection tiles continuously across the merged per-tile roof mesh with no seam, no unwrap. Then add `map` + `normalMap` to `getRoofMaterial` — because `getRoofMaterialKey()` is a literal constant, **1.5 days dresses every roof in Barcelona from one 2K 3-cell atlas** (Catalan clay pantile / gravel-bitumen terrat / poured concrete), with the peach/terracotta palette staying in the vertex-colour attribute so one texture tints to the whole roofscape at **zero new material variants and zero new draws**. | buildings-detail | `buildingWorker.js:657-661,592-624,365-378,1137-1152`; `meshMaterializer.js:678-690,585-587` | 1.5 | P1 pipeline | low | no |
| **ASPHALT SHADER v2 — the core road rebuild.** Extend `patchRoadAO` into a proper road material: (a) world-metric UV from the already-baked `halfWidth` — `vAcross = (uv.y-0.5)*2.0*halfWidth`, `vAlong = uv.x*4.0`, **no re-bake**; (b) tiling albedo + normal at 4 m; (c) a second detail-normal sample at 8× frequency killing the close-range repeat; (d) macro wear from world-XZ noise **per-fragment** at ~40 m (replaces the per-vertex `roadNoise`, zero VRAM, strictly better); (e) **analytic wheel ruts** — two subtly polished bands per lane derived from `halfWidth`, ~10 ALU, zero VRAM, the single most recognisable "real road" cue; (f) wire into the registry's anisotropy policy. **KEEP MeshStandard on asphalt — it is already there.** | road | `roadRenderer.js:283-315,4593-4660`; new `map/roadMaterial.js` | 3.0 | P1 pipeline; **SMAA** | medium | no |
| **Road asset set** — `asphalt_worn_1k` (ambientCG CC0, normalized), `asphalt_detail_512` (normal only, AI tiling or high-pass), `panot_1k` (baked offline from the existing `makePanotCanvas` generator upgraded 256→1024 under node-canvas, Sobel normal, **AD-12 20×20 grid over 4.0 m**, and the AD-4 v-flip fix at `roadRenderer.js:1690-1694` lands with it), `concrete_kerb_512`. Ship `.ktx2`, keep the generator as the authoring tool. | road | `frontend/public/art/v1/road/*`, `map/generate-road-atlas.js:14-71` | 2.5 | build-art.mjs | medium | no |
| **Kerb material** — tiling granite/concrete albedo + normal at 512² with a chamfer highlight baked into the top edge. **The kerb is the silhouette element that reads at 200 m and is currently flat `0x5a5a5a`.** Also resolve the `ENABLE_CURBS` lie: the baked path bypasses the flag on all 409 v9 tiles. | road | `roadRenderer.js:219-228,1758-1774,1777`; `config.js:187` | 0.75 | road asset set | low | no |
| **Vegetation, data-only wave — no re-bake, no art, no KTX2.** (a) **Species-by-context classifier** replacing the species-blind `bakedVariantIndices[i] % 4`: three-tier — OSM tagged tree within 4 m → its species; else per-tile species histogram from that tile's own tagged trees; else context (inside a greens polygon → park set, adjacent to coast/beach → palm, road class primary/secondary → avenue set). **Species coverage is 13.8%, so graceful degradation is the whole design.** (b) **Roadside decimation** 2–5 m baked stride → ~7 m (fixes density realism and ~35–40% of the tree count). (c) **Billboard collapse**: 4 materials + 4 pool sets → ONE pool with the atlas cell in card UV sets selected by `setGeometryIdAt`; clamp `bbEnd` to `FOG_FULL_DIST` (kills the 170–280 m dead band); **generate mips + LinearMipmapLinear**; drop `transparent:true` (alphaTest 0.05 covers it) so impostors Z-reject. | vegetation | `vegetationWorker.js:1940-1975,1348-1400,679-720,128-129`; `vegetationRenderer.js:875-877,899-957`; `meshMaterializer.js:1068-1073`; `tileManager.js:2971-2975`; `config.js` | 3.5 | P1 species pipe; staticPools | medium | no |
| **Sky dome texture — 2 keys.** 2048×1024 equirect ETC1S per key (day/night), **2.67 MiB total**, cross-faded by the normalized sun-elevation scalar, with the existing analytic gradient retained underneath as the fallback tint and carrying dawn/dusk. Sourced by cropping **CC0 Poly Haven sky HDRIs** — real photographic cloud structure, and the same source the cloud atlas already prefers. **Un-hides the night sky** (`envToggle.js:63-64` `skyVisible:false` + flat `bgColor 0x0a1224`) and unblocks NIGHT-10 / BLK-9. | sky | `scene.js:552-598`; `envToggle.js:63-64,134-144` | 1.5 | P1 pipeline | medium | no |

**★ WHAT THE GAME LOOKS LIKE AT THE END OF P3 — THIS IS THE MINIMUM SHIPPABLE v3 ★**

You drive down Gran Via at dusk. **The road under you is asphalt** — 4 m tiling albedo with an 8× detail normal so it does not turn to grey mush at bumper distance, macro wear varying at ~40 m, and two faintly polished wheel ruts per lane that your headlights catch. The kerb has a chamfer that reads at 200 m instead of being a flat grey band. The sidewalk is **panot** — the Flor de Barcelona flower tile, 20 units across a 4 m repeat with grout wear and per-unit value jitter.

The buildings beside you have **storeys**. Every one of the 36,122 buildings that used to have a shopfront painted across its third floor now has a ground band, a body of correctly-repeating floors at 4.0 m, and a crown — at **128 texels/m** instead of 21, with a normal map, over eight authored Eixample facade layers that vary block to block. The baked sky-visibility AO actually fades correctly down the wall, because there are finally vertices for it to fade between. Above them, **every roof in Barcelona is a Catalan clay pantile roofscape** instead of a flat peach polygon — the aerial signature of the city, delivered by 1.5 days of work because `getRoofMaterialKey()` returns a constant.

The trees are **real Barcelona species** at real spacing — plane trees on the avenues, palms on the seafront, park species inside the greens — instead of `variantIndex % 4` blobs every 2 m. The sky above has photographic cloud structure, and **it is still there after dark**, with a warm light-pollution band on the horizon instead of a flat navy field.

At night the streetlamps are **real lights**. And the edges of all of it hold still at 80 km/h, because SMAA landed first.

**It is not ETS2. It is unmistakably, comparatively, definitively better than what we have — which is exactly the bar the user set.**

**74 days. ~15 weeks. This is the ship.**

---

### P4 — THE COMPLETION WAVE · 51 days (v3.1)

**Goal.** The domains that P3 deferred: the street furniture and signage that make a city read as inhabited, the vehicles that stop it reading as a toy, the ground under the whole thing, and progression.

**Numeric exit criteria**
- Same four caps as P3, re-measured, plus: draws ≤ 450 with all furniture, signage, vehicles and terrain live.
- Vehicle triangle population 1.08 M → ≤ 300k.
- Zero remaining palette-UV meshes in the shipped world (AD-1b).
- The dynamic text page holds ≥128 cells and **never grows**; a 10-minute drive shows zero texture-cache growth.
- The v10 re-bake happens **exactly once**.

| What | Subsystem | Files | Days | Depends | Risk | Re-bake |
|---|---|---|---|---|---|---|
| **TERRAIN: prove-then-delete the terrain bake.** Harness regenerating positions/uvs/indices from the elevation grid, bit-equal against `bakedTerrain` on 20 sampled tiles **including the 4 known NaN-normal sea tiles and 2 trench-carved tiles**. Only then move generation into the parser worker (Uint16 indices, computed smooth normals) and repoint `getElevationAt` at the grid. **Delete the second runtime water dip (`terrainRenderer.js:225-260`) in the SAME commit or it double-applies.** −369 MB of tile payload. | terrain | `tileParserWorker.js`, `terrainRenderer.js:140-330,905-985`, `terrainBaker.js`, `buildRegion.js:1571-1574` | 3.0 | P0 measure | **high** | ⚠ YES |
| **TERRAIN: LOD index rings** — from one vertex buffer emit three index sets (full 32,258 / 1:2 7,938 / 1:4 1,922), swap by distance with hysteresis, and **raise the terrain visibility cut from 280 m to ~1500 m at the coarse ring so the game finally has a distant landform silhouette.** LOD must never engage inside 500 m where roads drape on the full grid. | terrain | `tileParserWorker.js`, `tileManager.js:2908-2932`, `terrainRenderer.js` | 2.0 | bake deletion | medium | no |
| **BAKE (v10) — ONE window, all domains.** (a) **Sea sink**, owned by terrain, implementing **water's profile** (−1.0 m at the waterline ramping to −8.0 m over ~200 m offshore) **and water's commit-blocking validator** (no sea cell above −0.5 m, no road-bearing cell below 0). Fixes the measured 2.05–5.78 m bumpy blue plateau. (b) **Clip `water[]` to the tile** — 280 of 426 tiles carry a byte-identical 254-feature set, 13.08 MB wasted. (c) **Per-vertex splat weights** (Uint8 ×4 = 4 B/vertex) from OSM landuse + slope + elevation + distance-to-coast, replacing the Float32 colour (192 KB) + `aCoast` (64 KB) — **the attribute set gets 192 KB/tile smaller.** (d) **Road surface-class byte** (surface / lanes / oneway / centre rule). ⚠ **Physics consequence neither domain fully owns:** `buildTerrainHeightfield` (`tileManager.js:1693`) reads the FULL source grid, so sinking sea cells turns the Passeig Marítim seafront into a drop rather than a 3.57 m plateau — needs a deliberate drive test at the current spawn. | terrain (owner), water, road | `buildRegion.js:1178-1249,1194`, `demLoader.js`, new `terrain/seaMask.js`, new `splatBaker.js`, `roadBaker.js:400-504,555-608`, `convertToBinary.js:642-676`, `waterNormalize.js`, `mapLoader.js` + `tileParserWorker.js` TILE_VERSION | 6.5 | — | **high** | ⚠ **YES — the only one** |
| **THE SPLAT SHADER — the core terrain move.** 4-layer 1K albedo + 4-layer 1K normal as `DataArrayTexture`s; height-blend the two dominant weights (**4 fetches, not 8**); one 512 R8 macro-breakup layer; keep the existing `aAO` multiply and `uAoScale` **verbatim**. **DELETE the CPU colour pass (`terrainRenderer.js:557-763`) and the 5-layer procedural FBM (`:836-897`)** — the FBM overrides the CPU vertex colours at 75% and is tuned as one closed system; a splat bolted on top loses to it by construction. **Parks fold in as a weight channel** (greensRenderer deleted). Register in a shared registry and set `userData.sharedMaterial` or `tileManager.js:2868` disposes them city-wide on first unload. | terrain | `terrainRenderer.js:557-902`, new `map/terrainMaterials.js`, `tileManager.js:2868-2872` | 4.0 | splat bake; P1 pipeline | high | no |
| **WATER.** Extract `map/waterMath.js` (`polygonArea`, `pointInWaterPolygon`, `WATER_DEPTH`, `SEA_LEVEL`) so `terrainRenderer.js:11`, `railwayRenderer.js:9`, `roadRenderer.js:23` keep compiling; **DELETE `waterRenderer.js`**; new `map/waterSurface.js` reading closed water bodies from `tileData.water[]` (**not** `tileData.marinas` — populated in only 8/426 tiles) at a single global sea-level Y; new `shaders/waterChunk.glsl.js` — two scrolling normal layers (swell ~40 m, chop ~6 m, opposite drift), world-space perturbation (no TBN on a flat surface), Schlick fresnel into the existing sky palette, Blinn glint against the exported `sunDir`, shore depth ramp from `shoreD` packed into `aCoast.y`. **Injected into BOTH the terrain material (gated on `vCoast > 0.5`) and waterSurface meshes, so harbour water and open sea are identical.** No separate ocean mesh. | water | new `waterMath.js`, `waterSurface.js`, `shaders/waterChunk.glsl.js`; delete `waterRenderer.js`; `terrainRenderer.js:766,791-800,805-900`; `config.js:163` | 5.0 | sea sink | medium | no |
| **WET ROADS — one owner, joint item.** `uWet` uniform in the road material: roughness 0.9 → 0.25, albedo ×0.72, procedural world-space FBM puddle mask **biased toward the camber gutters using the existing `uv.y` + `halfWidth`**, ripple normal fetch inside the mask only. Promote the `carModel` PMREM to `scene.environment` (sky owns the object, size 128 per TOD key). Route through the boot warm-up. | road (material+uniform), water (mask chunk), sky (weather driver) | `roadRenderer.js:283-300,304,376,389`; `carModel.js:124-161`; `main.js:686` | 3.0 | asphalt shader v2 | medium | no |
| **SHORE FOAM — one owner.** Foam band in `waterChunk.glsl.js` driven by `shoreD` with animated noise advance; quieter static ring around marina/breakwater edges. **Sells the beach at Barceloneta, which is the seafront spawn.** | water | `waterChunk.glsl.js`, `waterSurface.js`, `terrainRenderer.js:713-745` | 1.0 | waterChunk | low | no |
| **VEGETATION: card trees.** 2048×1024 (4×2 grid of 512 cells) albedo+opacity RGBA + tangent-space normal, bark strip in the bottom band of each cell, **3 LOD tiers × 8 species = 24 geometries in ONE pool.** Species: Platanus × hispanica, Tipuana tipu, Celtis australis, Washingtonia (palm), Phoenix (palm), Jacaranda, Citrus/ornamental, Pinus pinea. Plus the alpha-tested normal-mapped Lambert material (**MUST preserve the `patchVegWash` injection reading batching-colour alpha, or give it a compile-time define per §7 rule 6**) and **LOD2 impostors rendered OFFLINE from the finished LOD0 cards** (8 species × 4 yaw), replacing the hand-drawn `ctx.ellipse` canvas. ⚠ **`createVegPool` sizes vertex/index buffers ONCE with NO grow path** — pools must be constructed AFTER the card geometries resolve from the network, which changes init ordering in `main.js`. | vegetation | new `public/art/v1/vegetation/*`, `public/models/vegetation/bcn_trees_lod{0,1,2}.glb`; `vegetationRenderer.js:81-260,814-957`; `meshMaterializer.js:1053-1058`; new `backend/tools/bakeImpostors.mjs` | 9.0 | staticPools; P1 pipeline | medium | no |
| **VEGETATION: LOD0-only tree shadow casting**, deleting the 13,963-instance transparent blob-shadow pool (S7). **Dappled tree shadow on asphalt is THE ETS2 road cue.** With the LOD ladder in place only ~1,100 trees × ~130 tris = ~143k enter the depth pass, vs the ~850k that originally tanked it. Blob shadows survive for the LOD1/LOD2 bands. | vegetation | `meshMaterializer.js:453-491,1053-1058,1188-1205`; `vegPools.js` | 1.5 | card trees; P0 shadow fix | high | no |
| **GROUND-FLOOR KIT REBUILD.** ONE `map/groundFloorKit.js` owning the bay grid — edge selection (**all street-facing edges**, not longest-edge-only), SEG_LEN/stride, skip hash, quantised ground Y — emitting shopfront + awning + fascia anchors as one co-registered result. Replaces `SEG_CAP` first-come clipping with per-building-fair allocation. Adds the UV channel `quad()` and `pushSegment()` never had. ~30% deterministic **closed roller shutters** off the existing hash (the most Barcelona thing in the frame at night and on Sundays, and cheaper than open shopfronts). Awning fabric with closed ends and 4 cm sag, merged into the shopfront-frame buffer for −1 draw/tile. buildings-facade's ground band and signage's fascia CONTENT plug in as consumers. | ground-floor kit (new owner) | new `map/groundFloorKit.js`; `shopfrontRenderer.js:17-34,74-88,97-166`; `awningRenderer.js:60-90,96-153`; `shopSignRenderer.js:121-160`; `cafeTerraceRenderer.js` | 5.0 | modular bands; P1 pipeline | medium | no |
| **SIGNAGE: atlas + pool + text page.** Offline `scripts/build-sign-atlas.mjs` → `signs.ktx2` (2048², ETC1S+alpha) + `signs.cells.json`. `signAtlas.js` + `signPool.js` — ONE shared atlas material with per-instance `aUvOffset`/`aTint`/`aEmissive`, riding the existing city-wide pool, standardising on the **shader U-flip** and forbidding `tex.repeat.x = -1` forever. **Bounded 2048×1024 R8 text page**, 128 cells of 256×64, LRU-evicted by player distance, sub-region uploads via `renderer.copyTextureToTexture`, colour from `aTint` — 4× cheaper than the RGBA canvases it replaces, and it **deletes all three unbounded caches** (`:260`, `:456`, `:579`). ⚠ **Re-run the census on all 426 tiles before sizing the cell count** — the audit sized against 110 tiles and the real figure is 42,876 named records. | signage | new `scripts/build-sign-atlas.mjs`, `map/signage/{signAtlas,signPool,textAtlas}.js`; `roadInfraRenderer.js:260,456,579` | 7.0 | P1 pipeline + signData | high | no |
| **SIGNAGE: shop fascias + regulatory + lane arrows + traffic lights.** Fascias on the ground-floor kit's bay grid with **real OSM shop names from the 13,551 available**; delete the 24 fake `NAMES`. Restore `generateSpeedSigns` and route plates through the atlas pool. Replace the untextured 5-tri `ShapeGeometry` lane arrow with a 2-tri atlas quad carrying 6 real arrow types. Restore traffic lights seeded from the **4,225 unused OSM signal nodes**, fix the right-hand-drive placement (`:864` currently places left, citing India), assert every instance clears `isOnAnyRoad` (`:956` — that assert is the structural fix for the original "ugly box in the driving path" complaint). | signage | `shopSignRenderer.js` (rebuilt); `roadInfraRenderer.js:265-308,534-560,724-849,852-910,864,1380-1451` | 5.0 | signAtlas, textAtlas, groundFloorKit | medium | no |
| **SIGNAGE: the Barcelona night set — highest night-look-per-MiB in the project.** Illuminated pharmacy green cross (from `data.shops` cat 16), metro M roundel (from the also-unused `metroStations`), tobacconist T, ONCE kiosk, hotel and parking P totems. Emissive from cells already budgeted. **This is how the night street gets believable light sources at zero additional punctual lights** — and it is the fallback that matters most if K-N fires. | signage | new `map/signage/nightSigns.js`; `envToggle.js:149` | 2.0 | signAtlas | low | no |
| **ROAD FURNITURE (re-ordered).** P4a: **Barcelona bollards (pilones)** from the v8 baked sidewalk polygons — crosswalk mouths, chamfer corners, sidewalk-parking edges. Zero new draws (rides the pool), on every Eixample chamfer, i.e. in frame constantly on the benchmark route. P4b: extract the placement engine verbatim into `roadFurniture/placement.js`, widening the output from a boolean keep-mask to `{kind, side, s, e}`. P4c: post/bollard/delineator `BatchedMesh` pool on `createVegPool`, replacing `emitGuardRailRun`'s ~1,030 merges/tile. P4d: **kill `MeshBasic` on all railings** → Lambert + map + normalMap, `FrontSide` (DoubleSide on 141 km of parapet pays double fragment cost for nothing). P4e: texture set. P4f: **headlight-catching delineators** — white post + reflective band with an intensity driven by distance+angle to the car, so it **flares as the headlights sweep past** instead of glowing constantly (one per-frame uniform on ONE pooled material). P4g: Jersey barrier emitter. P4h: **W-beam at-grade extension LAST** (HIGH risk; a terrain drop-off query that has already false-triggered once). | furniture | `map/roadFurniture/*` (new), `roadRenderer.js:2763-2797,3176-3517`, `barrierRenderer.js` | 11.0 | P1 deletes; P1 pipeline | high (P4h only) | no |
| **VEHICLES.** Shared template cache + single loader registry (kills 9 duplicate GLB parses, colormap 18 → 1 resident). Tire smoke 90 Sprites+90 SpriteMaterials → one InstancedMesh. **Blender modular Barcelona kit** — 6 bodies at 1,800–2,800 tris LOD0 + 500–700 LOD1, TRUE dimensions (the `carModels.js:75` squash deleted), one shared UV layout, modelled shutlines/bevels for the normal bake. 2048² albedo with a **paintjob mask** + 1024² normal (UASTC) + 1024² ORM. Rewire traffic 28 loose Meshes → 2 InstancedMeshes (30 → ~7 draws), parked 11 → ~8. **Hero car re-UV** on the existing 9,792-tri geometry, 11 materials → 4, 21 draws → ~8. **Night vehicle lighting** — additive beam card + ground pool decal via the P1 shared decal module; **this does NOT depend on the light grid.** ⚠ **The 8-day kit is gated behind a 0.5-day documented source survey** — "there is no CC0 library of textured, correctly-proportioned European city cars" is the ONLY claim in the corpus with no file:line, no enumeration and no search log, and 13 days ride on it. | vehicles | `car/carModels.js`, `carModel.js`, `trafficSystem.js`, `parkedCars.js`, `carEffects.js`; new `public/models/vehicles/*`, `public/art/v1/vehicles/*` | 19.5 | rallyStyle ADR; P1 pipeline | high | no |
| **HUD + PROGRESSION** (§8, §9) — `routeAdvisor.js`, delete `compassBar.js`, minimap repalette + **scheduler rebuild**, `game/progress.js`, dual-currency payouts, licence gating, `ui/garage.js`, district map, landmarks, gameFx restraint, marker restraint | hud | see §8/§9 | 14.0 | P1 theme tokens; vehicle kit (for the money sink) | medium | no |
| **urbanFeatureRenderer.js (1,022 L, live) + busStopRenderer.js (529 L, live)** — Barcelona's fountains, kiosks, monuments and glazed bus shelters with backlit ad panels, all flat-colour untextured today, all in frame constantly on any Eixample drive. **They become atlas clients of the signage pool.** Note `busStopRenderer`'s `glowMesh` is one of very few existing street-level emissive night sources. | signage | `urbanFeatureRenderer.js`, `busStopRenderer.js`, `signAtlas.js` | 2.0 | signAtlas | low | no |
| **Tunnel + trench interiors** — `tunnelRenderer.js` is **944 live lines** exporting 9 builders, all called from `tileManager.js:46`. This is the visual surface of the **Ronda de Dalt trench and the Gran Via tunnels — the project's own documented signature corridors, and the spawn is at a trench portal.** Nobody owned tunnel lining, portal faces, portal-mouth lighting, in-tunnel road surfacing, bridge decks, undersides, piers, or trench retaining-wall material. Scope for P4: tiled lining + a lamp strip + a lit portal mouth (the one place where interior punctual lighting is both expected and cheap), plus the rock splat layer on the trench walls with the slope-scaled AO hack **reverted to full strength** once the cuts are actually rock. | terrain (surfacing) + sky (portal lighting) | `tunnelRenderer.js`, `terrainMaterials.js`, `lightGrid.js` | 3.0 | splat shader; lightGrid | medium | no |

**WHAT THE GAME LOOKS LIKE AT THE END OF P4.** The ground under the whole city is a real 4-layer splat — grass, dirt, gravel, rock — blended by baked weights from OSM landuse and slope, with parks painted into it instead of floating above it, and **Montjuïc and the Ronda trench read as rock cuts instead of green-painted cliffs.** The sea is flat, sunk, normal-mapped and fresnel-lit, with foam breathing at the Barceloneta waterline. The trees are alpha-cut cards with real silhouettes casting dappled shadow on the asphalt. Shop fronts have shutters, awnings have striped toldo fabric with sag, and **fascias carry real Barcelona shop names.** Speed discs, lane arrows and traffic signals exist and are on the correct side of the road. Pilones stand on every Eixample chamfer. Guardrails and delineators flare as your headlights sweep them. Traffic and parked cars are correctly-proportioned textured European city cars instead of palette-UV toys. Pharmacy crosses glow green. And you have a reason to drive somewhere.

### Beyond P4 — the backlog (~30 days)

Billboards + medianera panels + direction boards + gantries · scooters (**first restored if the kit comes in under 8 days**) · rooftop clutter + terrace props · window recesses · marina boats · weather presets + rain · Milky Way, moon phase · bike-lane green tint band as a shader tint (908 cycleway records — one of Barcelona's most recognisable street cues) · drain covers with a real cast-iron grate · blue-zone and no-parking stripes folded into analytic paint · terrain-to-road blend skirt · audio / UI sting API · mobile light-grid tier · carShowcase render-target rework.

**PERMANENTLY CUT:** rain in all three implementations · marina boats · the pedestrian art pass · a separate sea mesh · `greensRenderer` as a surface · Milky Way · zona30 stencils · tactile paving · car-ownership-via-Kenney-GLBs.

---

## 5. Subsystem playbooks

### 5.1 Road surface, markings, kerbs, sidewalks

**ETS2 reference.** A tiling asphalt diffuse+normal at ~4 m repeat with a high-frequency detail normal on top, world-metric UVs, analytic-feeling lane paint, polished wheel ruts, and one macro grunge breaking the repeat. Nothing photoscanned; nothing above 1024.

**Current state.** `buildFlatRibbonGeometry` (`roadRenderer.js:499`) emits exactly the strip topology SCS uses. `roadBaker.js:400-401` already bakes `uvs.push(u,0,u,1)` (world-metric arclength U) **and** `halfWidths.push(half,half)`; the runtime twin is at `:592-593` + `setAttribute('halfWidth', …)` at `:609`; the baked consumer reads it at `:4625-4627`; and `mergeMeshesByMaterial` buckets on `${matId}|${geoAttrKey(geo)}` (`tileManager.js:154-165`) so it survives the merge. Kerb/sidewalk paths at `:1924,:5122,:5148,:5163` dummy-fill `halfWidth` purely for merge consistency. The material is **already** `MeshStandardMaterial({roughness:0.9, metalness:0})` at `:304`. `road.surface` is parsed at `tileParserWorker.js:301` with **zero consumers**.

**Verdict and why.** REFACTOR the module; REBUILD the material/shader layer; DELETE four Delhi subsystems. **World-metric V in the vertex shader with no re-bake is real** — a rewrite would re-derive strip topology it already has.

**Approach.** §4 P3 asphalt shader v2. Then in the backlog, **analytic lane paint replacing the marking geometry entirely** — this is the resequencing ruling: the original plan deleted seven paint Y-lifts and the hidden `+ROAD_ZFIGHT_OFFSET` (W6, P1, medium risk, and `changelog.md:1134` is a full session on exactly this failure class) on paint that was *still a separate merged mesh*, then spent a day of art on that geometry, then deleted the geometry. **Correct order: land analytic paint FIRST — co-planarity is not a question when there is one surface — then delete the Y-lift constants as dead code, risk-free.** Keep exactly two Y offsets and document them as load-bearing: `ROAD_VISUAL_ABOVE_TERRAIN` (road-vs-terrain conformance on curved 128-grid cells) and `ROAD_PRIORITY_Y_BUMP` (intra-material carriageway tie-break that polygonOffset structurally cannot express when all roads share one merged geometry).

**Assets.** `asphalt_worn_1k` (ambientCG CC0 Asphalt0xx, normalized) · `asphalt_detail_512` normal-only at 8× frequency (AI tiling or a high-pass of the base — **the cheapest single quality win in the set**) · `panot_1k` (Blender/node-canvas from the existing `makePanotCanvas` generator upgraded to 1024², Sobel normal from a height canvas with petals raised ~2 mm and grout recessed ~3 mm — **no CC0 source exists for this pattern; it is the one genuinely Barcelona-specific asset**) · `cobble_sett_1k` (ambientCG PavingStones — drives 779 `paving_stones` / 54 `sett` / 14 `cobblestone` records, i.e. the Gothic Quarter and the Rambla) · `concrete_kerb_512` · `paint_wear_strip_512` R8 (**never channel-packed** — ETC1S shares chroma endpoints per 4×4 block and would smear it) · `drain_grate_256`.

**Gotchas.**
- ⚠ `patchRoadWash` carries **both** the night wash **and the v9 baked AO**. Split in P0 or you silently delete baked AO from every road in the city.
- ⚠ **Anisotropy:** `setRendererAnisotropy` (`:192`) reaches exactly one texture. Miss the wiring and the road turns to grey mush at grazing angles — invisible in a screenshot, fatal at speed.
- ⚠ **v-flip:** panot UVs at `:1690-1694` were authored against a flipY canvas. Panot is 4-fold symmetric so the flip is invisible on it — but the asphalt wear ruts and the paint strip are not.
- ⚠ **`groundLayers.js` is the sole ordering authority.** The P0 assert throws on any polygonOffset set outside `applyGroundLayer()`.
- ⚠ **Trams.** `createTramMeshes` at `tileManager.js:2073` has **no CONFIG gate** and renders embedded in the carriageway. Contract before shader.
- ⚠ **Re-bake trigger:** the surface-class byte and analytic paint both need v10. **Batch into the single P4 window.**

---

### 5.2 Road furniture — guardrails, barriers, railings, bollards, reflectors

**ETS2 reference.** W-beam corrugated steel on a swept profile with proper UVs, IPN posts, delineator posts whose reflective bands flare as headlights sweep past, jersey barriers in visible 4 m modules, and stone walls with a real normal.

**Current state.** The OSM barrier layer contains **7 `guard_rail` and 3 `jersey_barrier`** against 1,120 walls / 895 fences / 390 compound_walls. 243 of 426 tiles have **zero elevated road**, and the only railing gate is `isElevatedGuardRailRoad` (`roadRenderer.js:3206`). `getGuardRailMaterial` (`:2766`) and `getRailingMaterial` (`:2773`) are `MeshBasicMaterial` with the comment "MeshBasicMaterial ignores scene lighting" — **unlit metal cannot catch a headlight.** `reflectorRenderer.js` places Indian cat's-eye studs every 6 m on Barcelona tertiary streets today, costing ~42k tris and 18 draws.

**Verdict and why.** REBUILD. Turning `ENABLE_BARRIERS` back on delivers garden walls and hedges, not road railings. No patch reaches the bar because **the data source is empty.** Furniture must be *derived* from road class + geometry + terrain, which is a different program from what `barrierRenderer.js` is.

**Approach and ordering (inverted from the audit).** The audit put "extend placement to at-grade roads" at P1 — 1.5 days at HIGH risk, depending on a terrain drop-off query the audit's own risk section says has already false-triggered once (`gotchas.md:814`, D3), with the payoff corridor limited to Ronda de Dalt / Ronda Litoral / B-23, and the audit's own words: *"if placement scatters W-beam through the Eixample grid it will look actively wrong and the user will reject it."* Meanwhile bollards are 1.5 days at LOW risk, zero new draws, and on every Eixample chamfer. **Swap them.** Order: delete → bollards → placement extraction → pool → materials → textures → delineators → jersey → W-beam at-grade last.

**Assets.** Metal atlas 1024² (galvanised W-beam, IPN post, painted rail) · concrete atlas 1024² (jersey, plinth, parapet) · plastic/reflective atlas 1024² (delineator, reflective band) · Barcelona stone wall 1024² albedo+normal replacing the single 512×512 8 KB `wall_01.jpg` · Blender kit: IPN post 24 tris, pilona bollard 40, delineator 12, W-beam end terminal 60.

**Gotchas.**
- ⚠ **Physics contract — this is what killed the subsystem last time.** Colliders are box shapes strictly OUTBOARD of the drivable ribbon edge + 0.25 m gap, height 0.85 m, every family behind its own CONFIG flag so it dies in one line the way `ENABLE_TREE_COLLISION` did. **Bollards get NO collider.** Verify with a Ronda de Dalt drive that the car scrapes and deflects rather than stopping dead.
- ⚠ **The keep-only-1,394-of-2,890 rule:** keep `wall` / `retaining_wall` / `city_wall`; drop fence/hedge/kerb/compound_wall entirely; keep the ghost-wall filter (`barrierRenderer.js:1268-1292`, `gotchas.md:862`).
- ⚠ **DoubleSide on 141 km of parapet** pays double fragment cost for nothing. FrontSide. But **keep the slab's manual night-colour path** — it has a documented black-band regression at `changelog.md:1122`.
- ⚠ W-beam is resampled at **2 m**, not at the 13.7 m baked point spacing.

---

### 5.3 Building geometry and facades

**ETS2 reference.** 85–150 texels/m on a modular storey band system, a bounded set of facade materials, normal-mapped plaster and brick, ground floor visually distinct from upper floors, and a crown that reads against the sky.

**Current state.** ~250 lines of canvas (`meshMaterializer.js:118-365`) paint a 256² tile onto a **4-vertex wall quad** at **21.3 × 25.6 texels/m**. `FLOOR_HEIGHT = 10` (`buildingWorker.js:38`) wraps the shopfront band into mid-air on **36,122 of 40,828 buildings (88.5%)**; 12,584 (30.8%) get two. Detail geometry races first-come caps in tile order, delivering to a **median 26.6%** of eligible buildings. `makeBoxGeom` (`workerGeometry.js:903-910`) is 8 shared vertices with UVs on **front and back faces only** and `_computeVertexNormals` averaging across all six — any texture or normal on a box's side returns is garbage. `GLOBAL_VERTEX_BUDGET` drops **entire buildings** via `continue`.

**What is already right and must not be re-derived:** `getFacadeMaterialKey()` returns `facade_<category>[#hero]_FFFFFF` and `getRoofMaterialKey()` returns the constant `roof_FFFFFF` (`buildingWorker.js:381-394`), with colour shipped as vertex colours. **Facade materials are bounded at 16, roofs at 1, regardless of building count.** That is exactly ETS2's bounded-effect-set model, and it means a textured facade sheet is a drop-in `map`+`normalMap` on 16 existing materials — not an atlasing project. It is the expensive structural change a rebuild is usually justified by, and it has already landed.

**Verdict and why.** REBUILD the facade generation and the detail-budget model; KEEP the worker transport, the per-material-key merge, and the tint collapse.

**Approach.** §4 P3: proportional triangle budgets → modular storey bands → winding normalisation → array material → author 8 layers. Then in P4/backlog: balcony railing 58 tris → one 2-tri alpha card (**29× cheaper; this is what turns 26.6% median coverage into ~100%** — measure the alpha-test early-Z cost before and after, it is the one thing that could make it a net loss), night atlas replacement, per-building variation.

**Assets.** 8 facade layers at 1024² albedo + 1024² normal + 512² window mask: 5 residential variants + 1 commercial + 1 office/institutional + 1 industrial-brick. Sources: ambientCG Plaster/Concrete/Bricks (CC0, true normals) as bases; window bays and shutters Blender-authored orthographic renders; weathering AI-generated (Draw Things, tiling on) and multiplied in. All through normalize at `k=0.85`.

**Gotchas.**
- ⚠ **`map/buildingRenderer.js` is NOT the geometry path.** Buildings are worker-generated: `workers/buildingWorker.js` + `workers/meshMaterializer.js`. This has cost a full session before.
- ⚠ **Triple-mirrored constants.** `FLOOR_HEIGHT` / `WALL_REPEAT_HORIZONTAL_M` exist in three files, AO dials in four. `buildingConstants.js` (P1) is the fix; workers already use ES module imports so a shared module is safe.
- ⚠ **`GLOBAL_VERTEX_BUDGET` deletes buildings, silently, in exactly the dense tiles the gate measures.** Sequence the P1 degradation fix ahead of any geometry-adding item, and land the "fix the silent roof drop" item **with** the parapet, not two phases later — a hollow open-topped building under `BUILDING_SIDE = DoubleSide` is a worse artefact than a missing parapet.
- ⚠ **Flipping `BUILDING_SIDE` to FrontSide alone was tried 2026-07-06 and reverted** (`changelog.md:930`). The fix is in the worker, with a debug pass colouring back-facing walls.
- ⚠ Array textures wrap per-layer natively — an atlas + `fract()` + `textureGrad` **would seam**.

---

### 5.4 Roofs, shopfronts, awnings, terraces, rooftop clutter

**ETS2 reference.** A tiling roof surface with a coping band that reads against the sky; ground-floor kit with shutters, fabric awnings and fascias on a shared bay grid; restrained rooftop clutter visible only from elevation.

**Verdict — SPLIT.** Roofs/parapets/clutter = REFACTOR. Ground-floor kit = REBUILD.

**Why the roof half is genuinely REFACTOR** (both load-bearing reasons verified): `getRoofMaterialKey()` is a literal `return 'roof_FFFFFF'`, so **one texture dresses the whole city**; `ensureUvs` is a one-function zero-fill, so real roof UVs are one function. Nothing there needs rebuilding, and 1.5 days delivers the entire Barcelona roofscape.

**Why the ground-floor half is REBUILD.** `shopfrontRenderer.js` `quad()` (`:74-88`) and its assembly (`:144-157`) push position/color/index and **no uv**; `awningRenderer.js` `pushSegment` (`:60-90`) likewise; all three of `shopfrontRenderer.js:97-110`, `awningRenderer.js:96-108` and `shopSignRenderer.js:127-137` dress the **longest edge only**; `MAX_SEGS_PER_BUILDING=4 × SEG_LEN 3.4` covers **14.8 m of a 60–70 m Eixample frontage** and `shopSegSkipped` drops 35% of that. Shipped state: no UV channel, one face of three on a chamfered corner block, ~10 m dressed of ~65 m. **There is no bay model, no edge model and no UV model to texture.** The audit budgeted 1.5 days for a six-part change while the signage audit budgeted 3.0 days for a strictly *smaller* change to the same family — the 1.5 figure is ~2× under, and it is under precisely because REFACTOR framing makes each piece look like an addition.

**And nobody owns the ground floor.** buildings-facade inserts a geometric ground band and says it "must land as a joint commit"; buildings-detail extends the bay grid; signage keys fascias to bay indices. Three domains, three phases, one 3-metre strip of wall, each treating the other two as a co-registration contract — and the four renderers are co-registered **only by convention**, with `shopSignRenderer` and `cafeTerraceRenderer` each re-deriving the longest edge independently and `shopSignRenderer` not even quantising ground Y (`:150`). `changelog.md:1018` records a full session of row-jitter bugs from the last time these desynchronised.

**Ruling: DELETE the four-renderer convention. ONE `map/groundFloorKit.js` owns the bay grid; buildings-facade's ground band and signage's fascia CONTENT plug in as consumers.** 5 days, replacing ~4.5 days currently scattered across three domains' P2s.

**Height constants that must move together into the one module:** `KICK_TOP 0.42` / `GLASS_TOP 2.55` / `LINTEL_TOP 2.80` (`shopfrontRenderer.js:17-19`), `AWN_TOP_Y 2.9` (`awningRenderer.js:14`), `SIGN_Y 3.15` / `SIGN_H 0.72` (`shopSignRenderer.js:15-16`), `WINDOW_STYLES marginB 3.8-4.0` (`meshMaterializer.js:37-46`). The painted band must end at `LINTEL_TOP 2.80`, not 3.789, or it double-draws against the 3D shopfront.

**Approach.** P3: real roof UVs (`planarRoofUvs`, world-XZ projection so the shared texture tiles continuously across the merged per-tile roof mesh with no seam and no unwrap) + roof material from a 2048² 3-cell atlas via `fract(uv)*0.5 + cellOffset` in a ~6-line `onBeforeCompile`. P4: the ground-floor kit rebuild. Backlog: universal parapet + coping, rooftop clutter, terrace props, night shopfront interior card.

**The parapet dependency is HARD, not soft.** `parapetGeoms.push(...)` sits inside `if (isCommercial && … && commercialVerts < COMMERCIAL_VERT_CAP)` (`buildingWorker.js:1318-1319`) and increments `commercialVerts += 8` at `:1442`, against a first-come `COMMERCIAL_VERT_CAP` of 40000. Extending the parapet from isCommercial-only to every `BALCONY_CATEGORIES` building multiplies the claimants on that same pot by ~4×. **Without buildings-facade's proportional triangle budgets landing first, universal parapets reach ~27% of buildings and starve the balconies competing for the same caps** — a skyline where a quarter of blocks have a crown and three quarters are extruded boxes is *visibly worse than uniform*. The coping also needs per-face UVs, which `makeBoxGeom` cannot give — hence the bespoke 3-quad emitter (6 tris/edge, deliberately not `makeBoxGeom`'s 12).

**Assets.** Roof surface atlas 2048² 3 cells (Catalan clay pantile `teula àrab` — AI-generated with tiling ON, since no CC0 photoscan carries it at the right pitch; terrat gravel-bitumen and poured concrete from ambientCG which ship true normals) · roof coping/parapet band 1024×256 tiling (glazed terracotta coping over rendered plaster with water-staining runs — **its own strip, because it is what reads at 80 km/h against the sky**) · shopfront atlas 1024² 4 quadrants (corrugated closed roller shutter with light graffiti and rust runs, stone stallriser, painted frame metal, open-shutter head box) · toldo fabric 512² tiling (classic Barcelona stripes + solids in the existing 8-colour palette; **normal carries the weave and the valance scallop — legitimate derived-normal territory**) · shop interior card 1024×512 4 cells (bar with bottle shelving, bakery counter, pharmacy green cross, generic retail; **albedo only** — seen through glass at a glancing angle) · rooftop prop atlas 1024² for 7 Blender props at 60–200 tris each · terrace prop meshes (bistro table + 2 chairs ~180 tris, parasol open ~120 / closed ~40, planter ~60, glass wind barrier ~24), Meshopt-compressed with **`gltfpack -cc -noq`** — no `-vp/-vt` quantization, per the recorded car regression.

**Gotchas.**
- ⚠ Rooftop clutter hard-gates at ~180 m off `altMult` so it culls entirely at street level and appears in drone mode and from Montjuïc / Ronda de Dalt. **That is the ETS2 clutter-LOD trick and it is what makes the cost affordable.**
- ⚠ Keep `tooCloseToRoad` (`cafeTerraceRenderer.js:106-127`) and the entire placement loop (`:130-181`) **verbatim** — that is the part that works.
- ⚠ Verify `_ROOF_NIGHT_TINT` (`meshMaterializer.js:680`) still lands correctly once it multiplies a sampled texture rather than a flat colour.

---

### 5.5 Signage — boards, shop fascias, street names, traffic signs, lane arrows, traffic lights

**ETS2 reference.** One atlas page of flat printed plates with no normal map, lettering at ~2× regulation cap-height so it reads at 80–150 m, per-instance emissive at night, and shop fascias that carry real names.

**Current state.** Five subsystems are disabled by **hard-coded empty array literals**, not CONFIG flags — `roadInfraRenderer.js:1376` `const signInstances = []`, `:1382` `const tlInstances = []`, `:1477` `const boardInstances = []; // direction boards REMOVED`, `:1482` gantries, `:1550` drain covers — so `CONFIG.ENABLE_ROAD_INFRA: true` genuinely produces only lane arrows. Boards get `new THREE.MeshBasicMaterial({map: tex, …})` **inside the loop** (`:1099`). Three caches at `:260`, `:456`, `:579` are `new Map()` with `.has/.get/.set` and **no `.delete` or `.clear` anywhere in the file**.

**Verdict and why.** REBUILD the rendering/resource layer; KEEP ~450 lines of placement verbatim; DELETE `trafficLightRenderer.js`. Three independent arithmetic walls: ~300 draws for direction boards alone against a 450-draw city budget; **a 0.750 MiB texture per unique street name against 42,876 named records** — 6.7 GiB worst case at the audit's own 8,966 figure, and the real figure is 4.8× that; and tile unload disposes the module-cached texture because the per-board materials lack `userData.sharedMaterial`. **"A texture per string" has no patch. The only fix IS the atlas + the bounded page.**

**⚠ The single most important correction in this domain.** The audit measured **110 of 426 tiles (26% of the city)** and presented the result as the city total without scaling. Corrected: **14,542 shops (13,551 named)**, **4,225 traffic-signal nodes**, **42,876 named road records of 53,895**. This cuts both ways: the DATA case gets 5× stronger (wiring `data.shops` + `data.trafficSignals` is now the best 0.5 days in the programme by an even larger margin), and the RESOURCE case gets 5× worse — **the 2048×1024 / 128-cell text atlas sizing is not validated against the real distribution, and the LRU-thrash estimate ("~1,164 candidate strings compete for 128 cells") derives from the same 110-tile p90. Re-run the census on all 426 tiles before committing the cell count.**

**Approach.** P1: wire the data + delete `trafficLightRenderer.js`. P4: atlas build script → `signAtlas.js` + `signPool.js` → bounded text page → fascias on the ground-floor kit's bay grid → regulatory + lane arrows + traffic lights → the Barcelona night set. Backlog: direction boards, gantries, billboards, retroreflection, LOD.

**Assets.** Sign atlas 2048² albedo+alpha, **no normal, deliberate** — a 0.7 m flat printed disc gains nothing. Contents: 24 regulatory cells at 128² (speed discs 20–120, STOP, CEDA EL PASO, no-entry, no-parking, one-way, priority, give-way, crossing — Inkscape-authored from **public-domain Spanish Reglamento General de Circulación shapes**, which are legal specifications, not copyrighted artwork); 16 direction/gantry plates at 256×128 (white urban, blue autopista, green autovía, brown tourist, 8 arrow orientations, exit tab, AP/B/C/N shields); 6 lane arrows at 128×256 in Norma 8.2-IC proportions; **30 shop fascia backplates at 256×64, one per `SHOP_CATEGORY` code 0-30** (`pbfPointFeatures.js:53-69` — forn, cafè, bar, farmàcia, carnisseria, fruiteria, perruqueria, òptica, llibreria, ferreteria, banc…), each a period-correct Barcelona fascia with a blank text well, AI-generated ortho then hand-cleaned; **8 night-signature cells at 128²** (pharmacy green cross, metro M, tobacconist T, ONCE, hotel star, parking P, Bicing) as Inkscape-authored **generic equivalents with no real trademarks**. Blender: Spanish 3-aspect signal head with backboard and visors ~90 tris, mast-arm variant, sign post kit 8–40 tris each, billboard unipole ~120 tris. Typeface: **one OFL condensed grotesque** (Barlow Condensed or Archivo Narrow), subset to Latin-1 + Catalan (à è é í ï ò ó ú ü ç and the punt volat `·`) + digits + punctuation, ~22 KB WOFF2. **Must not be a restrictively-licensed DIN clone.**

**Gotchas.**
- ⚠ **AD-13 — lettering ships at ~2× regulation cap-height.** Spanish motorway lettering at 200–350 mm subtends 1.9–3.3 px at 100 m / 1080p / 60° FOV. Game-feel beats regulation. **Named here so nobody "fixes" it later.**
- ⚠ Standardise on the **shader U-flip** (`shopSignRenderer.js:90-95`) and forbid `tex.repeat.x = -1` forever.
- ⚠ Fix `formatRoadType` (`:1190-1206`) Indian → Spanish classification and the `'Delhi'` fallback at `:491`. Keep `toCatalanTitleCase` (`:584`) and `splitTwoLines` (`:596`).
- ⚠ `:864` places traffic lights on the **left**, citing India. Right-hand-drive.
- ⚠ **Assert every signal instance clears `isOnAnyRoad` (`:956`)** — that assert is the structural fix for the original "ugly box in the driving path" complaint that got the subsystem disabled.
- ⚠ Shop signs are `frustumCulled = false` (`shopSignRenderer.js:169`) **and** missing from the `hideAll` list — 12–20 permanent draws behind the camera today.
- ⚠ **If K-N fires and the light grid dies, this domain becomes MORE important, not less.** At zero punctual lights, emissive plates are the only affordable street-level light source in the game.

---

### 5.6 Vegetation — trees, bushes, grass, parks

**ETS2 reference.** Alpha-cut leaf cards on a shared atlas, 3 LOD tiers, LOD2 impostors **rendered from LOD0**, per-species wind, and ground vegetation painted into the terrain rather than instanced.

**Current state.** `CylinderGeometry(r, r*1.4, h, 3, 1, open)` = 6 tris + `IcosahedronGeometry(r, 0)` = 20 tris/lobe, variants 66/66/46/66, **mean 61.0 tris × 13,963 instances = 851,743 triangles — 36.3% of the entire scene**. Billboards are `ctx.ellipse` on an unmipped canvas. `bakedVariantIndices[i] % 4` is species-blind while **35,580 real positioned Barcelona trees with 4,919 species tags** are parsed (`tileParserWorker.js:935-940` includes `'trees'`) and dropped at `tileManager.js:1469`. A 13,963-instance transparent blob-shadow pool costs 3–5× overdraw across the lower screen. 1,679 lines of the domain are dead. `greensRenderer.js` allocates a fresh uncached `MeshStandardMaterial` per call, one `ShapeGeometry` per polygon with **zero interior tessellation**, translated to a single Y from the polygon **centroid** — so every sloped park is a flat plate.

**Verdict and why.** REBUILD the art path; **DELETE `greensRenderer.js`** as a surface; explicitly KEEP `vegPools.js` and the worker instancing plumbing. An untextured 20-face convex solid has no alpha edge to cut, and ETS2's entire tree look *is* the alpha edge. Every knob on the current material has already been turned — three palette re-grades, a night ×1.55 restore, and a billboard tint annotated as having overshot twice.

**Why greens DELETE rather than REFACTOR.** 4,117 green polygons. ETS2 does not render a park as a co-planar plate above the ground; it **paints** the ground. Terrain's rebuild is already producing a 4-layer splat, and a park is a weight channel in it. Keeping greens as a separate mesh means a second material system for the same surface, a permanent `applyGroundLayer(…, 'green')` reservation, a `patchAoDarkening` path that exists only because the plate floats above AO-darkened terrain and glowed, and a guaranteed new bug class the domain's own risk note names ("greens start following terrain that other systems assume is flat under them") — **a risk that exists only because greens are a separate mesh.** 2.5 days spent making an architecturally wrong subsystem look better, versus 0 days and one extra weight channel. Keep the ~20 lines of polygon-to-weight rasterisation.

**Approach.** P1: wire the species pipe (0.5 d, highest-value plumbing in the domain), delete 1,679 dead lines, fix global-unison wind. P3: species-by-context classifier, roadside decimation 2–5 m → 7 m, billboard collapse + mip fix. P4: the 8-species card atlas, the alpha-tested normal-mapped Lambert, offline impostors, LOD0-only shadow casting. Backlog: bushes as 4-tri crossed cards (**only inside greens polygons, along `barrier=hedge` lines, and in Eixample chamfer planters — NEVER the old "clusters around every tree base + road edges" rule that got them disabled**), roadside grass verges capped at 800/tile and hard-culled at 40 m and gated to road segments with no baked sidewalk ribbon that touch a greens polygon (**which yields ~zero in Eixample — correct, kerb-to-facade hard surface — and a real verge on the Ronda, the Diagonal medians and Montjuïc**), per-species wind, palm placement polish.

**Assets.** `bcn_trees_albedo` 2048×1024 RGBA (4×2 grid of 512 cells) + `bcn_trees_normal`, bark strip in the bottom band of each cell, matching the layout of the existing `summer_trees_0` so the pipeline carries over. **8 species from the real OSM census: Tipuana tipu (691), Platanus × hispanica (624), Arecaceae/Washingtonia (316), Celtis australis (311), Phoenix, Jacaranda, ornamental Citrus, Pinus pinea.** 3 LOD tiers × 8 = 24 geometries in ONE pool. LOD2 impostors rendered offline (8 species × 4 yaw, 1024×512 + hemispherical normal) by a new `backend/tools/bakeImpostors.mjs`. Bush atlas 1024×512 of 4 Mediterranean shrubs. Verge grass card 512² / 4 cells. Sources: Blender-authored leaf clusters photographed/AI-generated then alpha-matted; **explicitly NOT the CraftPix set**, which is unlicensable and the wrong biome (`T_Trees_temp_climate.png`; `01_ash, 03_birch, 04_beech, 07_larch` — northern temperate, zero palms).

**Gotchas.**
- ⚠ **`vegPools.js` rules, verbatim.** Never call `deleteInstance` (`:56-61` — O(n log n) blowup). The LIFO free list, add-reservation accounting and sibling-pool overflow are load-bearing. Rewriting this reintroduces four documented streaming stalls for zero visual gain.
- ⚠ **`createVegPool` sizes vertex/index buffers ONCE (`:20-24,31-38`) with NO grow path.** Sibling-pool overflow adds *instance* capacity, not *vertex* capacity. **Pools must be constructed after the card geometries resolve from the network**, which changes init ordering in `main.js`. Getting it wrong throws "Maximum item count reached" or silently drops a tile's vegetation.
- ⚠ **Attribute mismatch.** `BatchedMesh._validateGeometry` (`:419-445`) requires matching attributes. OBJLoader never calls `setIndex`, so it emits non-indexed `{position, normal, uv}` — matching the pool on 3 of 4. **The `color` attribute must be ADDED and neutralised to white, NOT stripped:** `patchVegWash` reads `getBatchingColor().a` for the night urban glow (`vegetationRenderer.js:239-256`), and dropping it kills that effect **silently, at night**, which is exactly where nobody looks during a daytime smoke test.
- ⚠ **`bm._visibilityChanged = true` after `setGeometryIdAt`** — see §5.11.
- ⚠ **Species coverage is 13.8%, not 100%.** A naive "use the OSM species" implementation gives 86% fallback and looks identical to today. The per-tile histogram tier is not optional.
- ⚠ **Re-enabling bushes and grass re-opens a decision the user already made.** They were switched off in July because they read as junk on the streets. Ship behind CONFIG flags defaulting OFF; turn on only after an Eixample drive test.
- ⚠ Alpha-tested foliage in a zero-AA pipeline shimmers **worse** than solid blobs, and **it only shows in motion** — a stationary screenshot will look great and the drive test will look terrible. **SMAA is a prerequisite (P1), not polish.**

---

### 5.7 Terrain, hills, beach, coastline

**ETS2 reference.** Per-vertex weight blending of tiling albedo+normal materials, smooth-shaded, with LOD index rings giving a distant landform silhouette.

**Current state.** The only ground texture fetch in the shipped path is compiled out: `terrainRenderer.js:891-895` is `${isRallyStyle() ? 'diffuseColor.rgb *= 0.98;' : <fiber fetch>}` and `rallyStyle` defaults true — `grass.jpg` is loaded, decoded, bound at `:783`, and **never sampled**. A 5-layer procedural FBM **overrides the CPU vertex colours at 75%** (`:886`) and is tuned as one closed system, so a splat bolted on top loses to it by construction. The material is allocated **per tile** (`:769`) with **no `userData.sharedMaterial`** — the disposal trap. The finest ground detail in the entire game is a 5–10 m noise blob. `createTerrainTrimesh` has **zero call sites**, and the comment at `tileManager.js:1660` ("Physics carving still runs via createTerrainTrimesh so car can descend underground") is **actively lying** about the physics path.

**Verdict and why.** REBUILD the SURFACING and the DELIVERY; explicit KEEP of the data model. The two halves fail for different, independently sufficient reasons. **The separate sea mesh is DELETED** — the sea already rides resident terrain geometry (`aCoast` declared at `:766`, consumed at `:887`, `GRID_RADIUS=1` guarantees ±750 m always resident, FogExp2 0.005 fully attenuates by ~400 m), so a separate mesh renders identical pixels for +1 draw and +8k tris. Water's W8 wins.

**Also re-scope the framing.** "Prove-then-delete the terrain bake" is sold as "the item that buys the rest of the plan." It is not: **383 MB of tile payload touches none of the four binding caps.** It is a real streaming-latency win and worth doing — but mis-selling it gets it scheduled ahead of items that actually pay for the art.

**Approach.** §4 P0 deletes → P4 prove-then-delete + LOD rings + the v10 splat bake + the splat shader. Backlog: terrain-to-road blend skirt (an alpha-fading strip creeping ~0.4 m over the asphalt edge, replacing today's hard geometric meeting — note the roadside dark strip was already deleted at `:663-666` for reading as an outline), Montjuïc rock, smooth normals, mobile tier, night wetness.

**Assets.** 4 splat layers at 1024² albedo + normal: grass (6 m), dirt (6 m), gravel (6 m), rock (8 m). Sources: ambientCG CC0 Ground/Rock sets, which ship true normals, all through normalize at `k=0.85`. Plus `terrain_macro_512` R8 breakup at 128 m (the AD-6 shared grunge at terrain scale). Rock outcrop props for cells above 35°: Poly Haven / Quaternius CC0, retopologised.

**Gotchas.**
- ⚠ **`getElevationAt`'s tunnel-carving dependency is the highest-risk line in the plan.** Repointing it at the grid must preserve tunnel carve behaviour, and the harness must include the 2 trench-carved tiles and the 4 known NaN-normal sea tiles.
- ⚠ **Delete the second runtime water dip (`:225-260`) in the SAME commit as the bake deletion, or it double-applies.**
- ⚠ **`buildTerrainHeightfield` (`tileManager.js:1693`) reads the FULL source grid.** Sinking sea cells turns the Passeig Marítim seafront into a drop rather than a 3.57 m plateau, which interacts with the out-of-bounds teleport and the wedge auto-recovery breadcrumb. **Deliberate drive test at the current spawn.**
- ⚠ **`userData.sharedMaterial` on the array textures**, or `tileManager.js:2868` disposes them city-wide on the first unload.
- ⚠ **The splat bake MUST share its land-cover source with the vegetation domain**, or the ground reads rock where trees are planted.
- ⚠ **LOD must never engage inside 500 m**, where roads drape on the full grid (D-16-target).
- ⚠ **Reverting the slope-scaled AO hack** (`:570-575`) is correct *only after* the cuts are actually rock — it was a workaround for grass-painted rock cuts.
- ⚠ Dropping `flatShading` is a **deliberate look change** contradicting the shipped art-of-rally direction. Explicit before/after screenshot sign-off on Montjuïc. Do not land it silently.
- ⚠ **Re-bake trigger: the splat weights and the sea sink are the two biggest reasons the v10 window exists. Batch everything into it.**

---

### 5.8 Water — sea, harbours, wet roads

**ETS2 reference.** A normal-mapped fresnel surface with two scrolling layers, a shore depth ramp, a foam band, and wet roads that darken and raise their specular lobe. No planar reflection at this calibration.

**Current state.** `coastline.js` is **correct, measured-good work** that already solves the hard geometric problem (real OSM shore, verified seaward closure, one-query sea/distance sampling). `waterRenderer.js` is a lakes-and-ponds `ShapeGeometry` filler written for Delhi that has **never executed once in Barcelona** (`ENABLE_WATER: false` since 809bd94, two gated consumers at `tileManager.js:1668` and `:2295`); two of its three feature paths are provably unreachable against the real data (0/426 tiles have piers; 8/426 have a populated marina array). Wet roads are ~70% pre-wired: `roadRenderer.js:304` is already `patchRoadWash(new THREE.MeshStandardMaterial({roughness:0.9, metalness:0}))` and `patchRoadWash` (`:283-300`) already injects vertex+fragment and binds a shared night uniform.

**Verdict and why.** **DELETE `waterRenderer.js` + REFACTOR the terrain sea branch + NEW wet roads.** Deleting 322 lines that have never run is not rebuilding them — there is no existing behaviour being replaced, and the verdict word was doing no work while licensing 18 days. `coastline.js` is KEEP, unchanged, on merit.

**Approach.** P4: extract `waterMath.js` so `terrainRenderer.js:11`, `railwayRenderer.js:9` and `roadRenderer.js:23` keep compiling → delete `waterRenderer.js` → `waterSurface.js` → `waterChunk.glsl.js` injected into BOTH the terrain material and the water meshes → wet roads (joint with roads) → shore foam. **Rain and marina boats are cut.**

**Assets.** `sea_swell_512` normal (24 m), `sea_chop_512` normal (6 m), `shore_foam_512x128` alpha strip. Sources: Blender-authored or ambientCG Water CC0. **~0.4 MB download, 2 MiB VRAM total.**

**Gotchas.**
- ⚠ `ingestCoastline` (`coastline.js:38`) currently relies on any single tile carrying the whole shore. Once `water[]` is clipped to the tile, it must **accumulate across tiles**.
- ⚠ Read closed water bodies from `tileData.water[]`, **not** `tileData.marinas` (populated in 8/426 tiles).
- ⚠ Harbour/marina/dock go at a **single global sea-level Y** — that kills the tile-seam z-fighting the old `isMarina` branch was written for and never reached.
- ⚠ Register a `groundLayers` class rather than hand-rolling `depthWrite:false`.
- ⚠ **Wet-road ownership is settled:** roads own the material and the `uWet` uniform (it owns `roadRenderer.js` and `patchRoadWash`); water contributes the puddle mask + ripple normal as a shader chunk; sky contributes only the weather-state driver. **Costed once at 3 days, 0.3 ms.** Three implementations of one shader feature on the same 35–40% of frame coverage was the largest duplicated line in the programme.
- ⚠ **Ground albedo ships DRY with L* high enough that ×0.72 does not crush below L* 25** (NIGHT-7). Asphalt 38 → 27. Do not let it drift below 36.
- ⚠ **Re-bake trigger: the sea sink and the `water[]` clip. Both in the single v10 window, terrain owns the file.**

---

### 5.9 Sky, clouds, fog, weather, time-of-day, lighting rig

**ETS2 reference.** A per-climate **cubemap** cross-faded across ~8 TOD slots — *not* an analytic gradient, which is why their dawn/dusk skies have cloud structure a 3-stop gradient cannot produce. Keyframed fog colour + linear start/end + a horizon blend. Weather as discrete presets with cross-fades, not a simulation.

**Current state.** The aerial-perspective fog (`scene.js:666-711`) does altitude thinning, distance desaturation, distance blue-shift and a sun in-scatter wedge — **above the ETS2 target.** The dome is a 3-stop analytic gradient with a rally sun-glow (`scene.js:551-598`), no `renderOrder` at `:594-598`, and it is **hidden entirely at night** (`envToggle.js:63` `skyVisible:false`, `:64` flat `bgColor 0x0a1224`). `main.js:768-770` unconditionally clobbers `scene.fog.density` with a hardcoded `0.005 * altitude fade`, so the DAY 0.0032 / NIGHT 0.0045 presets **never ship**. `main.js:923,925` pass `viewerWx/viewerWz` to `updateClouds`/`updateStars` while `:924` correctly passes `camera.position` for the moon — **the X-mirror bug fixed for exactly 1 of 3 celestial systems, with the fix documented inline one line above the two that still have it.** Night is six independent fakes.

**Verdict — SPLIT.** Atmosphere/fog = **KEEP on merit, not sunk cost** — rewriting it makes the result worse, which is the only test that matters. Night lighting = **REBUILD** (there is nothing there to refactor). `dayNight.js` + `timeSystem.js` = **DELETE** (144 + 42 lines, with a latent double-ambient/double-hemi bug recorded in `decisions.md` as the reason it is a delete rather than a revive). Sky dome = **REFACTOR with a texture layer.**

**On the dome.** The challenger is right that a 3-stop analytic gradient plus a hidden night sky is below the domain's own written standard, and that sky is the single largest continuous screen area in every open-vista frame and the one surface where our fidelity is a pure texture problem with no geometry, no LOD and no re-bake attached. **Granted at 1/3 the cost: 2 keys (day/night), not 3.** 2048×1024 ETC1S = **2.67 MiB**, the analytic gradient retained underneath and carrying dawn/dusk through the cross-fade, cropped from **CC0 Poly Haven sky HDRIs** — real photographic cloud structure, free, and the same source the cloud atlas already prefers. The counter-argument the audit did not make — "a texture locks the sky" — is answered by the cross-fade, which is precisely what ETS2 does.

**Approach.** P0 sweep (fog clobber, sun single-source, X-mirror, renderOrder, deletes, dead-code). P1 SMAA. P2 spike → `lightGrid.js` → opt-in → fake deletion → headlight cookie. P3 sky dome texture. P4/backlog: cloud atlas swap, TOD as a 5-key curve over normalized sun elevation, lamp corona billboards, weather presets, post-chain consolidation, mobile tier, sky polish.

**Assets.** Sky dome 2048×1024 × 2 keys (Poly Haven crop) · cumulus cutout atlas 2048×1024 RGBA, 8–12 cells (**prefer Poly Haven crop over AI — do not AI-generate what exists as a real photo**) · stratus sheet 1024² tiling in U for the OVERCAST preset (AI with **tiling mode ON** — untiled AI output is unusable as a scrolling sheet) · **headlight beam cookie 512² R8, BLENDER-AUTHORED from a real low-beam reflector rendered orthographically — hot centre, flat asymmetric top cut-off, spread wings. The ETS2 signature.** · lamp corona/flare sheet 512² RGBA 4 cells · TOD LUT 256×8 generated at boot, zero download · **scene IBL PMREM GENERATED, not sourced** — render the dome through `PMREMGenerator` (plumbing exists at `carModel.js:124-161`), one per TOD key at **size 128 = 1.5 MiB each**; do not ship an HDRI, it locks the sky and duplicates data the dome produces analytically for free.

**Explicitly NOT re-authored:** the moon disc + crater texture (`scene.js:140-239`), the moon glow (`:241-261`) and the procedural star points. They read fine at 8 km. Recorded so nobody spends a day on them.

**Gotchas.**
- ⚠ **PMREM ownership ruling:** sky owns the object (TOD is what changes it); it becomes `scene.environment` (per water); size **128** per key (per vehicles); **sky's VRAM ask grows by N_keys × 1.5 MiB — currently unbudgeted spend hiding inside a "zero bytes" asset line.** Vehicles keeps `envMapIntensity 0.5` and loses nothing.
- ⚠ **SKY-22's stated rationale is REFUTED.** "We do not need MeshStandard to get the ETS2 night specular" exists to serve the wet-asphalt highlight — and asphalt is **already MeshStandard**. Writing a bespoke Blinn lobe onto Lambert to buy a highlight on a Standard material is net-negative work and puts two divergent specular models in one frame. **Scope the Blinn lobe to the genuinely-Lambert set only** (facades, terrain, vegetation, props), where it buys punctual-light response.
- ⚠ **DAY and NIGHT must stay exactly reproducible as two clamped values** of the TOD curve, so a second revert is a one-line clamp rather than a rollback of 3 days.
- ⚠ Post-chain consolidation frees **ZERO render-target VRAM** — both composer ping-pongs are constructor-allocated.
- ⚠ **NIGHT-10 / BLK-9:** no silhouette asset (parapets, treelines, guardrail posts, gantries) may be art-judged before the night dome + horizon band lands.

---

### 5.10 Player car, traffic, parked cars, pedestrians

**ETS2 reference.** Normal-mapped body panels, a paintjob mask driving colour variety at zero extra VRAM, correct proportions, and — critically — **essentially no interactive pedestrian crowd.** ETS2's answer to city life is parked cars, signage, street furniture and traffic density.

**Current state, verified by binary GLB parse with correct `byteStride` handling** (stride 32 on bmw_m3, 48 on sedan — a naive tightly-packed read gives a false negative, so this is easy to mis-refute):
- `bmw_m3.glb`: `images: []`; `Body_CarPaint_0` n=2290 **uniqUV=1 at (0.000, 0.000)**; `Body_Plastic_0` n=3786 uniqUV=1; all 4 `Wheel_*_Rims_0` n=1780 uniqUV=1; all 4 `Wheel_*_Tires_0` n=800 uniqUV=1. Only the 2 removed `Cylinder_Rims_0` nodes carry 44 real UVs.
- `cars/sedan.glb`: 1 image; body n=1072 **uniqUV=59**, u[0.094,0.844] v[0.275,0.975]; wheels n=528 uniqUV=68.
- `people/man.glb`: 6 primitives, **no `TEXCOORD_0` attribute at all**. `adventurer.glb` is 10,198 tris with zero images and a 1,748-tri backpack.
- Zero image data across all 15 GLBs except one 3,110-byte 512² palette, resident **18 times**.

**Verdict and why.** REBUILD the assets. **You cannot patch a UV unwrap onto shipped vertex data.** The ETS2 bar here — normal-mapped panels, a paintjob mask, correct proportions — requires an unwrap for every one of those.

**Pedestrians: DELETE the art pass, apply the domain's own kill criterion FIRST.** The audit wrote it explicitly — *"if the corridor seam test says peds hurt the ETS2 read, cut PED_CAP from 168 to ~60, confine them to the near sidewalk, and bank the triangles. Do not spend a second art pass on them"* — and then scheduled that second art pass anyway at 5 days, the most expensive art item in the domain after the kit. **Delete `adventurer.glb` + `punk.glb` (3.09 MB) for 0.5 days; cut PED_CAP 168 → ~60; let the already-scheduled per-instance LOD (needed anyway for parked cars) do the rest — that alone takes 743k tris to ~170k and 22.8 MiB of vertex buffers to ~6 MiB, which is the ENTIRE benefit the 5-day pass claimed.** Recovers 5 days, 2.8 MiB VRAM, 0.9 MB download, and lands closer to the reference.

**⚠ The 8-day kit is gated behind a 0.5-day documented source survey.** *"There is no CC0 library of textured, correctly-proportioned European city cars — verified gap"* is the **only claim in the entire corpus with no file:line, no enumeration and no search log**, in a report where every other number is read out of vertex data and reproduces exactly. It may well be true — it matches prior — but "probably true" is not an evidentiary basis for the single largest schedule risk in the programme, which the audit itself says has "no fallback." The survey must name Sketchfab CC0, ambientCG's model set, BlenderKit's CC0 tier, Quaternius, Poly Pizza and Kenney explicitly, with search parameters and results, before the 8 days are committed.

**Approach.** P0: shared template cache (colormap 18 → 1 resident, −22.7 MiB), dead code, ground the parked cars, tire smoke 90 Sprites → 1 InstancedMesh, PMREM 256 → 128. P1: rallyStyle ADR, vehicle material tier prototype, kill rally speed-dust on paved surfaces. P4: source survey → modular kit → atlas → rewire → hero car → night lighting → selective shadow casting (player + nearest 3 only; **28 casters is what tanked the shadow pass before, 4 will not**). Backlog: scooters, traffic signal wiring, carShowcase render target.

**Assets.** 6 bodies — supermini hatchback (SEAT Ibiza silhouette), sedan, estate, small SUV, panel van, taxi shell (black+yellow Barcelona livery) — 1,800–2,800 tris LOD0, 500–700 LOD1, **one shared UV layout across all six**, modelled shutlines and bevels on the high-poly for the normal bake. Shared atlas 2048² albedo with the **paint region authored greyscale + a paintjob mask in the spare channel** (ETS2's variety trick, drives `setColorAt`), 1024² normal **UASTC** (ETC1S destroys normals), 1024² packed ORM. Tyre tread + rubber sidewall from ambientCG CC0 cropped into the atlas region. Plates (Spanish EU format, **fictional**), badges, tail-lens fresnel and glass grime AI-generated then hand-cleaned — **plate normals authored flat**, per AD-9. Hero car: re-UV the existing 9,792-tri geometry, 1024² albedo, **2048² UASTC normal at RDO λ≥1.0 targeting ≤1.6 MB**, 1024² ORM, plus a simple interior shell and tinted glass so the cabin is not empty. Headlight beam card 256×512 additive. Ground light-pool decal 512² additive.

**Gotchas.**
- ⚠ **AD-14: the `carModels.js:75` non-uniform squash is DELETED, not compensated for.**
- ⚠ **Merge 11 materials → 4** (paint / glass / trim+chrome / wheels): 21 draws → ~8. Must keep `setCarColor` and the `CAR_PRESETS` wallet garage working **through the paint mask**.
- ⚠ `carModels.js:174-224` (`bakePosedMesh`) **discards UVs** — that is why the ped flipbook could never be textured. Not fixed in v3; it is why the ped art pass is cut.
- ⚠ Unify `parkedCars.js:65` (3.8) and `trafficSystem.js:79` (3.9) onto one target length or the shared cache keys twice.
- ⚠ **Vehicle night lighting has NO dependency on the light grid.** That independence is genuinely valuable — sky's grid is gated on a spike that may fail, and this item makes traffic read as ETS2 night traffic on its own. Preserve it in the phase plan.
- ⚠ **SEQ-1 (§2.1):** traffic and parked cars go flag-off for the P3 window and return in P4 with the kit.

---

### 5.11 Asset pipeline, material system, LOD architecture

**ETS2 reference.** Everything block-compressed at rest **and in VRAM** — there is no uncompressed RGBA8 anywhere in the world render. A bounded material set. Discrete per-object LOD tiers with fog masking the pops.

**Current state.** `loaders.js` is **13 lines** with zero KTX2, zero Meshopt, zero DRACO. `makeGLTFLoader` returns a new loader per call, 3 live consumers. **48 `new THREE.CanvasTexture` sites across 22 files, all RGBA8+mips, all main-thread at boot — that IS the texture library.** Anisotropy is set on 3 of ~48. `renderer.shadowMap.autoUpdate` is never assigned anywhere (`grep -rn autoUpdate frontend/src` returns exactly one line, `main.js:969`, and it is the *comment* describing a state the code never establishes). The shared-material disposal default at `tileManager.js:2856-2872` **disposes unless `userData.sharedMaterial` is set**, with 13 untagged sites. `nearEdgeDist = max(0, centerDist - 250)` is one distance value for a 500 m tile, and per-tile merging destroys per-object frustum culling — one bounding sphere per 500 m mesh means everything behind and beside the camera draws.

**Verdict — the direct answer to the rule-hard question.** **The per-tile streaming + worker + merge pipeline is FIT for a textured world and rebuilding it would make the end result WORSE. The LOD layer inside it is not fit and gets torn out. The asset/material layer is not a rebuild because it does not exist — it is greenfield.**

Four reasons the tile pipeline stays, **none of which is sunk cost:**
1. **Texture residency is city-wide, not per-tile.** A shared KTX2 library is loaded once and referenced by every tile. Textures impose **zero** new requirement on tile granularity, tile format, or the streaming schedule. There is no version of "the tiles are wrong for textures" that survives contact with the data.
2. **500 m sectors streamed in a radius around the camera IS the ETS2 architecture** (their `.base`/`.aux` sector grid). We would rebuild toward what we already have.
3. **The expensive structural change a rebuild is usually justified by has already landed** — the bounded material-key model at `buildingWorker.js:381-392`.
4. **A rebuild costs ~20 days that buy nothing.** Under the ETS2 calibration the bar is reached by **coverage** — enough surfaces normal-mapped that there is no seam. Twenty days re-arriving at the current architecture is twenty days of coverage not shipped. **This is slacking in the direction the brief warns about second.**

**And the canvas-generation layer is a DELETE target, not a refactor target.** The audit retires exactly two groups (14 `DETAIL_MATERIAL_DEFS`, plus shrinking the night atlas) and leaves ~34 canvas textures with no retirement item, no owner and no target format — surviving by default because every domain assumes foundation owns them and foundation budgeted 0 days. **The register + CI lint (P1, 1 day) is granted.**

**Binding rulings on the LOD rebuild.**
- **ONE owner: pipeline-materials.** `createStaticPool` generalises `vegPools.js`. buildings-facade's `buildingDetailPool.js` becomes a **second geometry source inside it**; vegetation's `setLodAt` lands **inside** it. As scheduled, all three edited overlapping ranges in `meshMaterializer.js` (839-900 vs 862-880) and `tileManager.js` (3058-3078 vs 3060-3078) and were a guaranteed merge conflict. **Saves 5 of 12.5 days and removes a duplicated HIGH-risk item.**
- **ONE implementation of `bm._visibilityChanged = true`, asserted in a test.** All three audits independently rediscovered this trap. An implementation that forgets it **appears to work, costs nothing, and changes nothing.**
- **The per-MESH bounding-sphere fallback is UNCONDITIONAL P1, not a contingency.** 1 day for ~1.0 of the 3.0 ms at low risk. **The BatchedMesh geometry-fragmentation risk the audit itself flags as highest is real** — buildings have unique geometry per instance, so pools must `addGeometry`/`deleteGeometry` on every tile stream, and `_reserveRange` reuses freed ranges only when the new geometry fits. The 6-day item genuinely might return nothing.
- **`GLOBAL_VERTEX_BUDGET` must degrade before it deletes** (P1).

**Does MeshStandard come back for v3? — ADR D-19.** **The question is malformed, and all three positions in the corpus argue past a factual error.** `roadRenderer.js:301-311` is **already** `patchRoadWash(new THREE.MeshStandardMaterial({color:0xffffff, vertexColors:true, roughness:0.9, metalness:0, depthWrite:true, side:DoubleSide}))`, and a repo grep returns **33 live `MeshStandardMaterial(` sites.** The "the city is Lambert" premise underneath v2's blanket ruling and underneath SKY-22's entire rationale is **false.**

> **RULING: there is no city-wide material decision to make. There is an INVENTORY, and it already exists in pipeline-materials' own census.**

| Surface | Ruling | Cost |
|---|---|---|
| **Roads / asphalt / sidewalk / panot** | **MeshStandard — already there. KEEP.** Wet-asphalt specular rides the existing roughness term. | **0 ms, 0 days.** ADR only to *record* it, since it contradicts v2 §5 Tier 3.2 and gotcha G-28. |
| **Vehicles** | **MeshStandard/MeshPhysical via GLTFLoader — already there. KEEP.** The V-16 carve-out is granted as a formality, not a concession. | +0.4 ms (allocated) |
| **Facades / terrain / vegetation / props / signage** | **STAY Lambert.** `MeshLambertMaterial` in r183 takes `normalMap` + `aoMap` with **no tangent attribute required** (`MeshLambertMaterial.js:91,101,160,176`; `normalmap_pars_fragment.glsl.js:15-20` supplies a derivative TBN via `getTangentFrame()`). That is the whole ETS2 material model. | 0 |
| **The Blinn lobe** | **SCOPED to the Lambert set only**, where it buys punctual-light response rather than a duplicate wet highlight. | ~8 ALU/light |
| **DELETE** | `greensRenderer.js`'s per-tile uncached MeshStandard (dies with the module); `roadRenderer.js:372` `getSharedMaterials` — **17 dead MeshStandard materials, zero call sites.** | −17 materials |

**Net effect: kills the v2 blanket ruling, kills SKY-22's stated rationale, grants V-16 for free, removes a spurious blocking dependency from three domains simultaneously, and costs 0 ms and 0 days.**

**Gotchas.**
- ⚠ **BLK-6:** pin three to `0.183.1` exactly. Five items depend on r183 private internals.
- ⚠ **BLK-3:** invert the disposal default. **Under a shared library each untagged site disposes a city-wide compressed texture on every tile unload.** 13 sites, not 2.
- ⚠ **BLK-4:** the warm-list extension lands **before or with** the first textured material. Adding `map`/`normalMap` changes the define set and invalidates all 125 programs in one commit; first-appearance compiles were measured at ~100 ms frames.
- ⚠ **The registry CHAINS `onBeforeCompile`.** three's `CSM.js:443` hard-assigns and would silently delete both the road night wash and the baked v9 AO from every road in the city.
- ⚠ **Meshopt over Draco:** 32,392 B bundled ESM vs a served `/draco/` directory plus its own worker pool, and Meshopt compresses animation bufferViews (21–31% of the people GLBs). Use `gltfpack -cc -noq` — **the recorded 2026-07-09 regression was `KHR_mesh_quantization` interacting with `loadCarTemplate`'s post-load merge + matrix transform, NOT the meshopt codec.** `-noq` keeps float attributes and does not hit that path. Verify against the car meshes specifically.

---

### 5.12 HUD / GUI and progression

Covered in full in §8 and §9. Summary of the verdict: **REFACTOR**, plus **REBUILD the minimap redraw scheduler**, plus **BUILD progression** (there is no design to refactor). Four things DELETED outright: `compassBar.js` (174 L — draws heading a second time, off-theme, squats on the exact band the mode HUDs collide in, and ETS2 has no analogue), `directionDisplay.js` (58 L, zero importers), `style.css` + the Futura OTFs, and the world-space car-colour panel (`carModel.js:506-600`, which exists only to be re-parented into the ESC menu and hidden with four `!important` overrides at `escMenu.js:37-43`).

---

## 6. Asset production pipeline

### 6.1 The flow

```
  SOURCE                NORMALIZE                 ENCODE            MANIFEST          LOAD
  ──────                ─────────                 ──────            ────────          ────
  ambientCG CC0    ┐                          ┐                 ┐              ┐
  Poly Haven CC0   │   scripts/build-art.mjs  │  basisu /       │ art-manifest │  loaders.js
  Kenney CC0       ├─▶  Steps 0-6 (§2.4.1)   ├─▶ toktx         ├─▶ .json      ├─▶ asset registry
  Quaternius CC0   │   + gates 2-8, 11, 12    │  ETC1S q128/192 │ + contact    │  ONE KTX2Loader
  Poly Pizza CC0   │   of §2.7                │  or UASTC-RDO   │   sheet.png  │  ONE Meshopt
  Draw Things AI   │                          │  + mips         │ + half-res   │  central sampler
  Blender-authored ┘                          ┘  + DFD transfer ┘   variants   ┘  policy (AD-7)
                                                 + flipY=false
                                                 gates 9, 10, 13
```

**Nothing runs on Cloudflare Pages.** `scripts/build-art.mjs` is a committed artefact producing committed output under `frontend/public/art/v1/`. A full library rebuild is ~10 minutes locally.

### 6.2 Scripts to write

| Script | Purpose | Phase |
|---|---|---|
| `scripts/build-art.mjs` | The 8-step normalize + encode + manifest + contact sheet. Hard byte ceilings that **exit non-zero**. Emits half-res variants for the mobile tier. | P1 |
| `scripts/normalize-art.mjs` | Steps 1–6 as a standalone so a single asset can be iterated without a full rebuild. | P1 |
| `scripts/lint-canvas.mjs` | CI lint: exits non-zero on any `new THREE.CanvasTexture` outside the monotonically-shrinking allowlist. | P1 |
| `scripts/route.js` | Scripted benchmark drive: fixed path through dense Eixample at 80 km/h, night, production build, pr 1.0, capturing draws / triangles / VRAM / p95 GPU / time-to-drive. **Every gate in §11 reads from this.** | P0 |
| `scripts/build-sign-atlas.mjs` | Node + sharp/canvas → `signs.ktx2` 2048² + `signs.cells.json`. Emits a PNG fallback. Fails non-zero on byte overrun. | P4 |
| `backend/tools/bakeImpostors.mjs` | Renders tree LOD2 impostors from the finished LOD0 cards (8 species × 4 yaw) — headless Blender or a three offscreen render. **AD-15.** | P4 |
| `scripts/optimize-textures.js` | Existing — **folded into `build-art.mjs`**, not kept alongside it. | P1 |

### 6.3 Per-class byte ceilings that FAIL the build

Enforced in `build-art.mjs`, checked per asset **and** as a running total against the domain's §3.4 allocation.

| Class | Per-asset ceiling (transmission) | Domain total |
|---|---|---|
| 1K albedo ETC1S q128 | 200 KB | — |
| 1K normal ETC1S q192 | 240 KB | — |
| 2048² albedo+alpha ETC1S q192 | 1.10 MB | — |
| 2048×1024 RGBA ETC1S q192 | 560 KB | — |
| **Any UASTC map** | 1.60 MB | **4.0 MB across the ENTIRE library** |
| 512² R8 mask | 60 KB | — |
| GLB (Meshopt `-cc -noq`) | 400 KB | — |
| **Total art library** | — | **24.0 MB — build fails at 24.0** |

Additional hard failures: any map above its §2.2 class ceiling · any world texture without mips · any texture whose anisotropy was set at a call site rather than by the registry · any asset whose declared metres-per-repeat is >10% off its §2.5 row · any missing or non-CC0 licence field · any banlist match · any transfer-function mismatch on DFD re-read · any 2048² page missing the `⌐` orientation glyph.

### 6.4 Licence hygiene

The manifest **is the gate**. `art-manifest.json` carries per asset: `{name, surfaceClass, source, license, url, sha256, srcRes, shipsTrueNormals, normalSource, aiModel, aiModelLicense, normalizeVersion, delightK, metresPerRepeat, transfer, format, bytes, vramMiB, domain, reviewer}`. Missing fields fail the build. `ASSETS.md` is generated from it, never hand-maintained.

**Banlist (§2.6)** plus the two live remediations, both P0: the CraftPix vegetation set and the Futura PT OTFs. **AD-9** governs derived normals. Fonts: OFL only (Inter self-hosted at two latin-subset weights, ~60 KB, replacing the render-blocking `fonts.googleapis.com` link at `index.html:46`; Barlow Condensed or Archivo Narrow for signage).

---

## 7. Night — the unsolved problem

### 7.1 The structural fact

`main.js:192` removed the dynamic PointLights. The entire night rig is **1 AmbientLight + 1 HemisphereLight + 1 DirectionalLight + 2 car headlight SpotLights** (`scene.js:623,629,634,652`; `carModel.js:279`). **There are zero punctual lights in the world.** `decisions.md` D-08 is the ADR, and its **stated revisit condition is literally clustered lighting.** This structurally caps night at ~50% of ETS2 and is the #1 unsolved problem in the project.

### 7.2 Why it dominates the plan

| | **DAY** | **NIGHT (binding)** |
|---|---|---|
| Baseline | ~11.5 ms (bloom effectively off: threshold 1.1 vs ACES exposure 1.6 — almost nothing passes the high-pass) | **13.3 ms measured** |
| Projected end of P3 | ~12.2 ms | **13.75 ms** |
| Normal-map payoff | **Full.** At the scene's 35° sun a normal map on a horizontal road gives ~3.16× N·L modulation; ~1.68× on a sun-facing facade; ~0 on the other three orientations. | **≈0 on facades and foliage.** A normal map's night payoff is specular + shadowing response to point lights. |
| Exception | — | **Roads.** The two headlight SpotLights are the only directional light on the road at night, and wet asphalt under them is the one ETS2 night image reachable *today*. Asphalt is already MeshStandard — the roughness term is free. |
| Foliage | Card trees read correctly | **Alpha-tested foliage at zero punctual lights is a black cutout — arguably a downgrade from the solid blob, which at least catches the ambient term.** |

**Consequence: every facade and vegetation normal map in the plan is ECONOMICALLY CONTINGENT on the light grid.** That is why the spike is mandatory and why it sits at P2, before the art wave.

### 7.3 Architectural options with ms costs

| Option | Mechanism | Cost | Verdict |
|---|---|---|---|
| **A — Status quo (six fakes)** | Lamp emissive × bloom; 16 m ground-pool decals (one per lamp at 22 m spacing = **>100% road coverage**, est. 0.6–1.1 ms); hero-building spill decals; road night wash; veg night wash; decal colour lift | ~0 new; ~0.9 ms already spent on the pool decals alone | **REJECTED.** Six independent approximations of one phenomenon. Night reads uniformly washed with no falloff, no rake, no contrast. |
| **B — Restore `THREE.PointLight`s** | N real lights in the WebGL forward renderer | Each additional light **recompiles every material** and adds a full lighting loop iteration to every fragment. At 20+ lights this is catastrophic in a forward pipeline and was already removed once. | **REJECTED.** This is what `main.js:192` deleted, for cause. |
| **C — Deferred / light pre-pass** | G-buffer + a lighting pass | Requires MRT, a full renderer rewrite, breaks every existing `onBeforeCompile` injection, and doubles bandwidth on mobile. ~25+ days. | **REJECTED.** Trades away binding constraint 1 (mobile) and costs more than the entire art wave. |
| **D — CLUSTERED 2.5D LIGHT GRID ★** | 64×64 RGBA8 index texture over 8 m cells (512 m window, 4 nearest-first slots per cell) + an RGBA32F lamp-data texture. One shared GLSL chunk: distance falloff + N·L + downward cone + one Blinn lobe with a per-material roughness uniform. Rebuilt **only on a cell crossing**, not per frame. Materials opt in via the registry's chained injection. | **estimated 1.2–2.0 ms, allocated 2.0 ms.** The estimate is the single number in the corpus most in need of a spike. **5 days build + 2 days opt-in + 1 day deletion.** | **RECOMMENDED.** |
| **E — Emissive-only night** (the K-N fallback) | No punctual lights. Night quality comes entirely from albedo value spread (NIGHT-2), the v9 baked AO, the shared emissive mask page, the headlight cookie, wet-road specular under headlights, and the Barcelona night-signature signage set. | ~0.2 ms | **THE FALLBACK, and it is not nothing.** Pharmacy crosses, metro roundels, shop fascias and bus-shelter glow become the only street-level light sources — which is a real, coherent, achievable look. |

**Recommendation: D, gated on the spike, with E as a fully-specified fallback that ships regardless.**

The decisive argument for D beyond the visual one: **its data feed already exists and is unused.** `tileManager.getStreetlightPositions()` (`:3482`, exported `:3523`) has **zero callers** — left over from the deleted PointLight pool. The plumbing is built. And real lights make **five of the six fakes redundant**, so clustered lighting is closer to a **swap** than an addition, which is what makes 2.0 ms affordable inside a 1.25 ms margin.

### 7.4 The night gate — binding sequencing rules

1. **`lightGrid.js` is the single highest-value item in v3.**
2. **THE SPIKE IS MANDATORY AND GATES 8 DAYS.** 1 day, 32 stub lights on the road material in one Eixample block, measured at 80 km/h at night. **>3.0 ms → re-scope to a 256 m window and 2 lights/cell before a line of production code.**
3. **NO DOMAIN SHIPS A NORMAL MAP BEFORE THE SPIKE RETURNS.** If the grid dies (K-N): buildings-facade ships **albedo-only** at P3 (their own stated fallback); vegetation ships **species classifier + wind + park textures only, no cards**; roads ship anyway (headlights); **signage becomes MORE important, not less.**
4. **ALL-OR-NOTHING COMMIT.** The fake-night stack dies **in the same commit** as the opt-in. Half-landed, night double-lights and looks measurably worse than today. **Capture 3 committed night poses before any of it starts.**
5. ⚠ **P0 BLOCKER — SPLIT `patchRoadWash` FIRST.** `roadRenderer.js:283-301` carries **both** the deletable night wash **and the v9 baked sky-visibility AO**. Deleting it wholesale silently removes baked AO from every road in the city with **no error**. Split into `patchRoadAO` (permanent) + `patchRoadNightWash` (deletable). **Assigned: road-surface P0, 0.25 d.**
6. **Vegetation's night wash is a straight either/or**, owned by the lighting domain: grid lands → `patchVegWash` is redundant and must go; grid slips → vegetation keeps it. **Give the material a compile-time define, not a hard dependency either way.**
7. **Distinguish STATIC lamp pools from DYNAMIC vehicle pools.** Sky deletes the static street-lamp ground decals, which real lights genuinely replace. Vehicles adds *moving* headlight pools for traffic cars, which clustered lights do **not** replace unless traffic cars are themselves fed into the grid. **Ruling: they stay as additive decals; sky's -0.9 ms is only partly recoverable, and that is already priced. Extract the decal geometry/material into a shared module first (P1, 0.25 d) so sky deletes the INSTANCES, not the MECHANISM.**
8. **The benchmark is night. Any A/B measured in daylight is inadmissible.**
9. **`renderer.shadowMap.autoUpdate = false` must NOT ship as the flag alone.** The player car is the only remaining dynamic caster — tiles streaming in while stationary would get no shadow at all. Ships with explicit `needsUpdate` on tile reveal **and** on car movement.

---

## 8. Game progression map

### 8.1 The ETS2 reference for progression

Dual currency: **€ and XP**. XP per job scaled by distance × cargo difficulty; levels grant skill points across 5 trees, each tree gating access to better-paying job classes. The € ladder: Quick Job (drive someone else's truck, fixed fee, no risk) → bank loan → own truck → Freight Market (you now pay fuel/tolls/damage) → buy a garage in a city → expand it 3→5 slots → hire AI drivers who generate passive income while you drive. Map regions are DLC-gated, not progression-gated; the in-game "progression map" is a world map with visited cities marked and a discovery percentage.

### 8.2 The current state — essentially absent

`game/wallet.js` is 30 clean lines: balance/add/spend (`:21-24`), an owned-colour set (`:26-28`), `onChange` (`:31`), backed by `dd_wallet` / `dd_ownedColors`. Imported by `escMenu.js:22`, `carModel.js:13`, `policeMode.js:13`, `deliveryMode.js:13`, `taxiMode.js:15` — **and NOT by `dashMode.js`, so Checkpoint Dash pays literally nothing** (`dashMode.js:268-282` writes only `dd_dashBest`).

**The only money sink in the entire game is eight paint colours totalling €1,400** (`carModel.js:520-527`: 40/70/110/150/200/260/320/450; `:516-519` are free). There is no XP, no level, no rank, no unlock other than paint, no district or region structure, no discovery, no persistent stats, no cross-mode meta. Each mode independently persists one best-score key that nothing ever reads back except its own results card. **All five modes are available from minute one** (`index.html:291-316`, `escMenu.js:167-168`). A player has nothing to work toward after roughly twenty minutes.

### 8.3 ⚠ THE MONEY-SINK RULING — the audit's open question, answered NO

hud-progression's P4 "Car ownership: three purchasable vehicles drawn from the city-car GLBs already on disk" is named as its **load-bearing economy risk**, with the dependency "VEHICLES DOMAIN must confirm the city-car GLBs are drivable-quality… If they are not, this item is cut." **The answer already exists in the vehicles audit and it is not "unverified", it is "deleted":** `vehicles.md:175` — `DELETE: frontend/public/models/cars/*.glb (9 Kenney GLBs, 1.72 MB — palette UVs, unfixable)`. Confirmed independently: sedan body `uniqUV=59` on a 1/32 palette grid.

So the load-bearing money sink of the entire progression design is scheduled for deletion by another domain in the same plan, leaving — hud's own words — *"€1,400 of paint and a €3,000 garage, roughly 90 minutes of play before the currency becomes meaningless."*

> **RULING: recorded as a NO, not an open question. The economy is re-designed around the NEW vehicle kit, and progression is therefore scheduled in P4, AFTER the kit. AND the design gains a second, cheaper sink that does not depend on it: the paintjob mask.**

**Why the paintjob mask changes the economics.** The new vehicle atlas authors the paint region **greyscale with a paintjob mask in a spare channel** — ETS2's own variety trick, driving `setColorAt`. That means **colour variety is nearly free art**: 20+ paints, 6 two-tone liveries and 4 wheel sets cost *one authored mask each*, not one model each. A sink that was €1,400 of hand-authored hex values becomes a several-thousand-euro ladder for a day of mask authoring. **This is the substitute sink the audit said did not exist, and it exists because the vehicles rebuild creates it.**

### 8.4 The design — dual currency, five modes, one spine

**`game/progress.js`** mirrors `wallet.js`'s shape exactly (`_readNum`/`_readArr`/`_write`/`_emit`/`onChange` at `wallet.js:8-18`). State: `dd_xp`, `dd_level` (derived, cached), `dd_landmarks` (string[] of visited POI ids), `dd_districts` (id → {fares, dashes, landmarks}), `dd_ownedCars`, `dd_ownedPaints`, `dd_garage` (district id | null), `dd_stats` (km driven, jobs completed, best per mode).

**Level curve:** `xpForLevel(n) = round(500 * n^1.6)` → L2 = 1,514 · L5 = 6,000 · L10 = 19,905 · L15 = 41,000 · L20 = 60,285. Exports `level()`, `xpInLevel()`, `addXp(n)` returning `{leveledUp, newLevel}` so the HUD can fire a banner.

⚠ **Grandfather clause — mandatory, not optional, and in the SAME COMMIT as the gating.** On the first run of the new build, if `dd_wallet` or any `dd_*Best` key exists, seed XP from lifetime earnings. `index.html:291-316` offers all five modes from minute one today; anyone who reloads and finds Heat locked will read it as a bug.

**Payouts — dual currency across all five modes**

| Mode | € | XP | Notes |
|---|---|---|---|
| **Free Roam** | none | **1 XP per km driven** | The only always-available earner. Rewards exactly what the game is best at: driving. |
| **Checkpoint Dash** | **€40 + 8 × checkpoints**, ×2.0 gold / ×1.5 silver / ×1.2 bronze reusing the existing `medalFor()` (`dashMode.js:113-119`) | € / 2 | **This is the mode that currently pays nothing at all** — it has no wallet import. |
| **City Cab** | existing `round(fareBase * (1 + tip))` (`taxiMode.js:138`), unchanged | = € | The tip meter already exists and is good. |
| **Rush Hour** | existing streak-multiplied pay (`deliveryMode.js:35`, `streakMult` up to ×2.5), unchanged | **€ × 1.2** | Highest XP/min — it is the highest-skill mode. |
| **Heat** | existing `25 + elapsed*1.6 + peakWanted*0.8` (`policeMode.js:157`), unchanged | **€ × 1.5, but ZERO on bust** | Risk premium. |
| **Night bonus** | **×1.25 on all money once unlocked at L3**, read from `envToggle.isNight()` | — | Directly incentivises the regime the whole art plan is optimised for. |

**The licence ladder (unlocks)**

| Level | Unlock |
|---|---|
| **L1** | Free Roam + City Cab + 4 free paints |
| **L2** | Checkpoint Dash |
| **L3** | Night driving pays ×1.25 |
| **L4** | Rush Hour |
| **L6** | Heat |
| **L8** | Garage slot 2 · vehicle kit body #2 purchasable |
| **L10** | Two-tone liveries unlocked (paintjob mask) |
| **L12** | Garage slot 3 · vehicle kit body #3 purchasable |
| **L15** | **Hill routes** — dash routes that only spawn on graded Ronda de Dalt / Montjuïc roads. *If the road segment data does not expose a grade or elevation-delta field, this degrades gracefully to a district filter.* |
| **L20** | Gold licence — cosmetic plate + all paints half price |

Locked title panels render dimmed with a padlock and `LICENCE L4` instead of the sub-line; locked ESC chips are non-clickable with the same label.

**The money sinks — the ladder, re-costed against the new kit**

| Sink | Price | Gated | Art cost |
|---|---|---|---|
| Paints (expanded 8 → 20 via the paintjob mask) | €40 – €600 each, ~€4,200 total | L1 / L20 half price | **One mask channel. Effectively free.** |
| Two-tone liveries (6) | €800 – €2,000, ~€8,400 total | L10 | **One mask each, ~1 day for all six.** |
| Wheel sets (4) | €600 – €1,800, ~€4,800 | L8 | Kit geometry, already authored |
| **Vehicle kit bodies (3 of the 6)** | €2,500 / €6,000 / €12,000 | L8 / L12 / L15 | **From the P4 kit — this is why progression follows the kit** |
| Garage in a district (sets default spawn) | €3,000 | L8 | Zero art — reuses `escMenu.js:271` `spawnAt()` + `?spawn` parsing |
| Fast travel to a discovered landmark | €200, free to your garage district | L1 | Zero art |
| Gold plate | €5,000 | L20 | One atlas cell |

**Total sink ≈ €40,000+**, against payouts in the €40–€400 per job range. That is a genuine long-term ladder, and **only the €20,500 of car bodies depends on the vehicle kit** — the other ~€20,000 is mask-and-UI work.

**Discovery and the map — "the literal game progression map the user asked for."**
- **34 hand-authored POIs**: the 8 ESC presets plus 26 more — Sagrada Família, Park Güell, Casa Batlló, La Pedrera, Torre Glòries, Arc de Triomf, W Hotel, Columbus Monument, Palau de la Música, Hospital de Sant Pau, Tibidabo, Camp Nou, Barceloneta, Port Vell, Plaça Catalunya, Plaça Espanya, Magic Fountain, Poble Espanyol, Ciutadella, Mercat de Sant Antoni, La Boqueria, Bogatell, Nova Icària, Fòrum, Plaça Reial, Casa Vicens. First entry within 60 m awards **250 XP + €50**, once, persisted. Fires a small routeAdvisor toast, **not** a confetti burst.
- **8 district polygons** hand-authored around the existing `escMenu.js:11-14` presets, tinted by completion percentage, with landmark pins (filled = discovered), your garage marker, and fast-travel targets — **rendered on the EXISTING expanded minimap** (`minimap.js:428+`). No new renderer, no new WebGL, no re-bake.
- ⚠ **These are deliberately hand-authored JSON rather than derived from OSM tags, precisely so they cannot block on a re-bake — which also means they cannot be generated and will simply not exist unless someone sits down and writes them.** Highest slip risk in the domain, zero technical risk. If world/POI later supplies a generated list it is a drop-in replacement.

### 8.5 Session loop vs long-term loop

**Session loop (5–20 minutes).** Spawn at your garage → the route advisor shows one objective → drive it → payout lands in the advisor footer as € and an XP bar tick → a new objective is offered from the same panel without a menu round-trip → occasionally a landmark toast fires en route because you took a different street. **The loop never leaves the driving frame.** That is the ETS2 discipline: the screen centre is permanently reserved for driving, and nothing transient sits above the horizon.

**Long-term loop (5–30 hours).** XP accumulates across every mode including free roam → levels unlock modes, then economic multipliers, then garage slots, then vehicles → money buys liveries, wheels, bodies, a garage, and fast travel → the garage changes your default spawn, which changes which district's jobs are convenient → district completion percentages and the landmark map give a reason to drive somewhere you have not been. **Discovery is the spine that ties free roam to the economy**, and it is the only part of the design that rewards the thing the art plan is actually building: a city worth looking at.

### 8.6 How progression surfaces in the HUD

Everything lands in **one** place — the route advisor (§9). Its footer is a permanent `balance + XP bar` line. Level-ups fire a restrained banner, not confetti. District completion, the unlock ladder, the shop and the map live in `ui/garage.js` inside the ESC menu, behind one keypress, never on the driving screen.

---

## 9. HUD / GUI plan

**The user said HUD comes later. Respected — all of it is P4. This section plans it so it does not get designed ad hoc when it arrives.**

### 9.1 The ETS2 calibration for UI — we get closer to the bar by DELETING

ETS2's UI is one coherent system, not a set of widgets: the screen centre is permanently reserved for driving; all persistent UI is the bottom strip (~8% of screen height) plus **ONE top-right Route Advisor box** the player cycles through pages. Palette: near-black translucent panel (~`rgba(20,18,16,0.75)`), one amber accent (~`#e8a022`), white/warm-grey text, 1px hairline borders, **zero gradients, zero bevels, zero particle celebration.** Type: one condensed grotesque, ~11–13px caps labels with wide tracking for units, **tabular numerals** for speed/distance/money, two weights total. Navigation: no giant world-space floating arrow, **no 90 m light pillars over objectives** — a line on the minimap plus a text instruction.

**Calibration note: against this bar our HUD is MORE decorated and LESS coherent.** The target is a **reduction in decoration** and an **increase in system coherence**. That makes this the one domain in v3 that is unusually cheap.

### 9.2 The theme.js drift list — measured

`ui/theme.js` (87 lines) is a genuine, well-scoped token set — palette at `:19-49` (cream `#f3ede1`, ink `#2a2521`, panel `rgba(28,25,22,0.44)`, coral `#d76a4f` hero + sky `#7ea6b0` + sage `#8fa77e`), `label()` `:52-55`, `glassPanel()` `:60-66`, `iconButton()` `:69-77`, `injectUITheme()` `:80-87`. It is followed by `escMenu.js`, `envToggle.js:236`, `speedDisplay.js:99-100`, `streetDisplay.js:37-53`, `main.js:559-573`, `index.html:112-284`.

**It is ignored by:**

| Offender | Drift |
|---|---|
| `compassBar.js` | Pure white `rgba(255,255,255,*)` throughout (`:100,:122-123,:136,:139,:151,:162,:171`) and `#ff4444` north. **Zero theme tokens.** → **DELETED** |
| `minimap.js` | A Google-Maps palette: `#2a7fff` car marker (`:225,:227,:228,:322-324`), `#f5c842` view cone (`:251-252`), `#35e0ff` objective dot (`:313-314`), white compass cardinals (`:100,:106-108`) |
| `dashMode.js` | `#35e0ff`/`#ffc233`/`#ffd23f`/`#9fe9ff`/`#d7dee8`/`#e0955a` (`:21-22,:78,:90,:115-118`) |
| `taxiMode.js` | `#2ee06a`/`#ffc233`/`#8ef0b0`/`#bff5d1`/`#ffe6a8` (`:23-24,:170,:206,:302`) |
| `deliveryMode.js` | `#35b0ff`/`#ff8a33`/`#bfe4ff`/`#ffd9b0`/`#ff5a5a` (`:19-20,:73,:84,:119`); panel chrome `rgba(0,0,0,0.5)` (`:59`) — the exact style theme.js's header says it replaced |
| `policeMode.js` | `#ff5a5a`/`#ffb347`/`#ff3b3b`/`#8ef0b0`/`#ff4444` (`:88-90,:93-97,:237`); `rgba(0,0,0,0.5)` panel (`:66`) |
| `gameFx.js:24` | A sixth palette: `#ffd23f,#35e0ff,#ff6b6b,#2ee06a,#ffffff,#f5a623` |
| **`carModel.js:508-600`** | **The worst offender, and it is the CAR SHOP.** Fixed top-left `rgba(0,0,0,0.5)` panel (`:508`), `12px sans-serif` label (`:511`), `#ffd23f 700 12px system-ui` balance chip (`:536`), buy popup `linear-gradient(#26314a,#161d2b)` (`:559`) with a 3D-bevel button `box-shadow:0 5px 0 #1c8f47` (`:575`). Pure pre-theme Brawl-Stars. `escMenu.js:37-43` then re-parents it and hides half of it with four `!important` overrides. |

**Six palettes. Seventeen hardcoded hexes across four game modes. None of the four `game/*.js` files imports `ui/theme.js`.**

**Duplication:** heading rendered **twice every frame** (`compassBar.js:90-172`, a 1200×140 canvas redrawn from the main loop, **plus** `minimap.js:85-118`, a full SVG tick ring). The objective nav pill implemented **three times** at three different top offsets (`dashMode.js:71-92` top:150, `taxiMode.js:199-213` top:132, `deliveryMode.js:66-76` top:150). Camera-frame bearing maths copy-pasted four times. `ding()` written four times. `sceneX/sceneZ/worldFromScene` — **the X-mirror negation the CLAUDE.md danger banner warns about** — copy-pasted four times.

**Collision:** compassBar occupies y=12..82; `deliveryMode.js:62` puts a 44px/weight-800 timer at top:76 (**a 6px overlap**); `policeMode.js:69` a 26px banner at top:86; `dashMode.js:52` a timer at top:88. **The top-centre band is contested by four systems.**

### 9.3 The direction

**One `ui/routeAdvisor.js` (~260 lines) replacing ~400 lines across four files.** ONE consolidated top-right `glassPanel()`, top to bottom: objective label + distance + a small rotating direction arrow; one mode-specific line (dash timer / fare + tip meter / delivery countdown + streak + parcel integrity / wanted meter); **balance + XP bar footer**. Single `update(data)` entry point taking a plain object, **all writes via `textContent` on cached nodes**. Reserves the screen centre entirely. Respects `env(safe-area-inset-right)` — on a notched iPhone in landscape that is exactly where the system status cluster sits, and `touchControls.js` / `speedDisplay.js:35-40` / `minimap.js:20-26` already branch on `(pointer: coarse)`.

**Two new theme tokens + a MODE_ACCENT map** (P1, so world art can lock against it): `gold #c9a227`, `alert #c0553d` beside coral/sky/sage. Map: Free Roam → sage, Checkpoint Dash → coral, City Cab → gold, Rush Hour → sky, Heat → alert. Export a `worldAccent()` helper for the higher-value in-world variant — **world markers must punch through fog, so they are the SAME hue at higher value, not a sixth palette.** ⚠ **AD-8 still binds: these are UI tokens and must never become world albedo anchors.**

**Deletions:** `compassBar.js` (frees ~0.64 MiB of compositor backing store and one full-canvas redraw per frame) · the minimap's SVG tick ring + cardinals (`:77-118,:125`) · the world-space car-colour panel · `directionDisplay.js` · `style.css` + Futura.

**Restraint pass:** `gameFx.js` confetti from a six-colour array at counts 46/40/34 → **the active mode's accent plus cream at count 18, fired only on genuine milestones** (level-up, district 100%, personal best) rather than every checkpoint and every fare. `fxFlash` opacity halved. **The 90 m objective light pillars (`dashMode.js:39`, `taxiMode.js:40`, `deliveryMode.js:40`) cut to 22 m** with beam and halo opacity halved — the loudest "web demo" tell in the game, removed for half a day and no measurable draw change.

**The minimap scheduler rebuild** (the one REBUILD here): keep the canvas renderer and `citymap.bin` **verbatim**; rasterise the surrounding district ONCE into an offscreen canvas at 2–3× the visible extent, then pan and rotate that bitmap per frame, re-rasterising only on district exit (~1 per 30–60 s at 80 km/h instead of 5.5/s). **Returns ~0.9 ms of CPU per frame and removes a 10.1 ms spike that fires while driving, i.e. inside the p95 window.**

### 9.4 Sequencing — the one hard rule

⚠ **The routeAdvisor consolidation touches all four game-mode files simultaneously and deletes ~400 lines. It is the single highest-regression item in the HUD plan. Mitigation is sequencing, not testing: land the panel wired to `dashMode` ONLY, verify, then port exactly ONE mode per commit. Do not do all four at once.**

⚠ **Deleting `compassBar` and the minimap compass ring in the same phase removes BOTH heading indicators at once if the sequencing slips.** The minimap's fixed forward-pointing marker plus a north pip must be verified on screen **before** `compassBar.js` is deleted, not after.

⚠ **Extracting the car-shop UI without extracting the side effects will silently break paint persistence.** `carModel.js:506-600` owns `selectColor`, the `sel` class, and the `dd_carColor` write at `:501`. **carModel retains `setCarColor()` and nothing else.**

---

## 10. Risk register — ranked

| # | Risk | Impact | Mitigation | Owner phase |
|---|---|---|---|---|
| **1** | **The KTX2 FORMAT_OPTIONS BC1-over-BC7 patch slips.** three r183 ranks bptc above dxt for ETC1S, so Windows/NVIDIA transcodes the whole library at 8bpp. | **~85 MiB doubles → ~244 MiB, 44 over cap.** The entire VRAM budget fails. | One line in `loaders.js`, landed as a **P1 blocker with a Windows verification check in the exit criteria**, not as an optimisation. | **P1** |
| **2** | **The light-grid spike returns >3.0 ms, or the grid dies entirely.** | Every facade and vegetation normal map loses its night payoff; the plan's night half caps at ~50% of ETS2 permanently. | **1-day spike gating 8 days.** Re-scope to 256 m / 2 lights per cell. If that also fails, **K-N fires**: keep the fakes, ship albedo-only facades, ship no card trees, and **escalate signage** — emissive plates become the only street-level light source. | **P2** |
| **3** | **BatchedMesh geometry fragmentation makes `staticPools.js` return nothing.** Buildings have unique geometry per instance, so pools `addGeometry`/`deleteGeometry` on every tile stream and `_reserveRange` reuses freed ranges only when the new geometry fits. | The 3.0 ms the whole city budget rests on evaporates; buildings and vegetation are then ~1.0 ms over. | **The per-MESH bounding-sphere fallback is UNCONDITIONAL P1**, not a contingency — 1 day, ~1.0 ms, low risk. **K-L** fires and cuts ~1.0 ms from vegetation and buildings-facade in the same commit. | **P1 + P2** |
| **4** | **SMAA does not land before the first normal-mapped asphalt.** | Three domains' highest-value items — normal-mapped asphalt, alpha-cut foliage, discrete LOD tier switching — each ship into a zero-AA forward pipeline and **look worse in motion than what they replace.** And **it only shows at speed**, so a screenshot review passes it. | **K-A: if SMAA is not landed, ship the deletes alone.** SMAA is a P1 exit criterion with a measured ≤0.6 ms budget. | **P1** |
| **5** | **The vehicle kit's 8-day Blender estimate is wrong**, resting on the corpus's only unevidenced claim. | 13 days of the schedule's largest art item, with the audit's own words: "no fallback." | **0.5-day documented source survey gating the 8 days**, naming Sketchfab CC0, ambientCG models, BlenderKit CC0, Quaternius, Poly Pizza, Kenney with search parameters and results. If a usable base exists, retopo+re-UV is 3 days, not 8. | **P4** |
| **6** | **The v10 re-bake happens more than once.** ~10–30 min, re-commits 547 MB, bumps `TILE_VERSION` in **both** `mapLoader.js` and `tileParserWorker.js`, and **every player needs `window._clearTileCache()`**. | Multi-day loss per extra window, plus a stale-tile support burden. | **ONE window, P4, terrain owns the file.** Everything batched: sea sink + water clip + splat weights + road surface-class byte (+ optionally the facade variant seed and a 256 AO grid, only because we are already there). ⚠ **17 of 426 tiles are still v7 with NO AO grid and will have no surface-class byte — every new material MUST have a null path for both, or those tiles render wrong.** | **P4** |
| **7** | **`GLOBAL_VERTEX_BUDGET` silently deletes buildings** in exactly the dense Eixample tiles the corridor gate measures, and it is misattributed as an art bug. | Weeks of chasing an art defect that is a budget defect. | **P1 degradation fix lands ahead of every geometry-adding item**, with a counter surfaced in the metrics panel. | **P1** |
| **8** | **Shared-material disposal destroys a city-wide compressed texture on the first tile unload.** The default at `tileManager.js:2856-2872` is dispose-unless-tagged, with **13 untagged sites**. | The first KTX2 texture dies invisibly; the symptom is "textures randomly disappear after driving a while." | **P0: invert to an explicit `ownedMaterial` opt-in + a dev assert that no material reachable from the art registry is ever disposed.** | **P0** |
| **9** | **Deleting `patchRoadWash` wholesale removes the v9 baked AO from every road in the city, with no error.** | Silent, city-wide, and diagnosed as "the roads look flat now" weeks later. | **P0: split into `patchRoadAO` (permanent) + `patchRoadNightWash` (deletable) BEFORE the lighting work starts.** | **P0** |
| **10** | **The Y-layering regression.** `changelog.md:1134` is a full session on exactly this class, and the failure mode is subtle — paint that looks fine parked and wrong at 80 km/h over a crest. | A shipped visual defect the user will see immediately and we will not. | **Resequenced: analytic lane paint lands FIRST** (co-planarity is not a question with one surface), then the Y-lift constants are deleted as dead code, risk-free. Plus a committed grazing-angle + bump pose set captured **before** the change, and a `?debug=ylayers` overlay. | backlog |
| **11** | **Time-to-drive regresses and nobody notices.** `main.js:723`'s 20 s safety net hides it until severe, while we add a 24 MB art library, a 217 KB transcoder, a transcode step, and 48 canvas generators on the main thread at boot. | **Binding constraint 1 — the product's best feature — traded away by accident.** | **P0: an explicit measured metric (navigation-start → `dd-loading` hide) with a hard ceiling in every phase gate. K-T fires at >1.5 s regression: the hero asset set goes lazy and the manifest splits.** | **P0** |
| **12** | **The kitbash.** Assets ship at their source's native grade because one exemption is granted, then a second, and by asset ~100 the palette is advisory. | **Invisible until ~100 assets, unrecoverable after.** The exact failure §2 exists to prevent. | **The contact sheet is gate #1 for that reason.** No waivers. An asset failing gate 4 or 5 is re-graded, not exempted. | **P1 onward** |
| **13** | **The mobile tier arrives after the assets.** | Every asset authored before it has no half-res variant path and no normal-map-skip path; retrofitting variant emission across ~100 assets is unrecoverable. | **MOVED P2 → P1.** The pipeline must EMIT the variants. | **P1** |
| **14** | **Content authoring simply does not happen.** The 34 landmarks and 8 district polygons have zero technical risk and high slip risk, because nobody's day job is writing them. | The progression map — the thing the user asked for by name — has no content in it. | Deliberately hand-authored JSON so it cannot block on a re-bake; scheduled as its own P4 item with a named day count, not folded into a code item. | **P4** |
| **15** | **Level-gating removes content existing players already have.** | Anyone with a `dd_wallet` key who reloads and finds Heat locked reads it as a bug. | **The grandfather clause is mandatory and lands in the SAME COMMIT as the gating.** | **P4** |
| **16** | **`createVegPool` has no grow path** and sizes buffers once. | "Maximum item count reached", or a tile's vegetation silently vanishes. | **Pools constructed AFTER card geometries resolve from the network** — changes init ordering in `main.js`. Documented in the playbook; asserted in the pool constructor. | **P4** |
| **17** | **Re-enabling bushes and grass re-opens a decision the user already made.** They were switched off in July because they read as junk on the streets. | A user-visible regression on a complaint already lodged once. | **Ship behind CONFIG flags defaulting OFF; turn on only after an Eixample drive test.** Placement verifiably gated on greens polygons and sidewalk absence. | backlog |
| **18** | **The sea sink changes physics at the seafront spawn.** `buildTerrainHeightfield` reads the FULL source grid, so sinking sea cells turns Passeig Marítim into a drop rather than a 3.57 m plateau — interacting with the out-of-bounds teleport and the wedge auto-recovery breadcrumb. | The car falls through the world at the default spawn. | **A deliberate drive test at the current spawn is part of the v10 re-bake exit criteria**, plus water's commit-blocking validator (no sea cell above −0.5 m, no road-bearing cell below 0). | **P4** |
| **19** | **The routeAdvisor consolidation regresses all four modes at once.** | ~400 lines deleted across four files simultaneously. | **Land wired to dashMode ONLY, verify, then port exactly one mode per commit.** | **P4** |
| **20** | **The current triangle count does not reconcile** — four domains' "today" figures sum to 2.27 M of a stated 2.32 M, leaving ~50k for all buildings. | The "1,735,000 fits" conclusion rests on estimates that provably cannot all be concurrent. | **One capture of `renderer.info.render.triangles` at the benchmark, P0, replaces all five estimates before the triangle budget is signed off.** | **P0** |

---

## 11. Gates and kill criteria

### 11.1 Per-phase numeric gates

Every gate is measured by `scripts/route.js`: a **fixed path through dense Eixample at 80 km/h, at NIGHT, production build (`npm run preview`), pixel ratio 1.0**. **Any A/B measured in daylight is inadmissible.**

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

**Eleven-threshold corridor gate for P3 (the ship gate), all measured on the same run:** p95 GPU, VRAM, download, draws, triangles, time-to-drive, program-cache delta, disposal assertions, mid-air shopfronts, detail coverage, and a **committed 3-pose night A/B screenshot set** (before and after, headlights off) reviewed by a human. **All eleven must pass. Nine of eleven is not a ship.**

### 11.2 Kill criteria — what forces a scope cut

- **K-N (NIGHT).** Light-grid spike returns **>3.0 ms** for 32 lights → re-scope to a 256 m window and 2 lights/cell. If the re-scope also fails → **cut the light grid**, keep the fakes, and slip every facade and foliage normal map. **Roads and signage ship regardless** — roads because headlights are directional light, signage because emissive plates become the only street-level light source in the game.
- **K-L (LOD).** BatchedMesh geometry fragmentation throws "Maximum item count reached", or buildings drop in the 10-minute heap-growth loop → fall back to the per-mesh bounding-sphere item, **bank 1.0 ms instead of 3.0, and cut ~1.0 ms from vegetation and buildings-facade in the same commit** (they are then over).
- **K-V (VRAM).** The re-measured baseline exceeds **110 MiB texture**, or the FORMAT_OPTIONS override slips → **cut buildings-facade to 6 authored layers (−5 MiB) and drop all normal maps on the mobile tier.**
- **K-A (ANTI-ALIASING).** SMAA is not landed before the first normal-mapped asphalt ships → **ship the deletes alone.** Three domains independently state that high-frequency normal maps, alpha-cut foliage and discrete LOD tiers in a zero-AA forward pipeline shimmer worse in motion than what they replace — and it only shows at speed, so a screenshot review will pass it.
- **K-T (TIME-TO-DRIVE).** Navigation-start → `dd-loading` hide regresses **>1.5 s** over the P0 baseline → the hero asset set becomes lazy and the manifest splits. **Binding constraint 1 is the product's best feature, and there is a 20 s safety net at `main.js:723` hiding the regression until it is severe.**
- **K-C (CONTACT SHEET).** Any asset reaching the contact sheet that reads as a different fidelity tier is **rejected, not exempted.** A second exemption request on the same class triggers a re-grade of that entire class before any new asset in it is accepted.
- **K-B (RE-BAKE).** If a second v10 re-bake is proposed after the P4 window closes, it is **deferred to v4** unless it is fixing a correctness bug. The city is re-baked once.
- **K-S (SCHEDULE).** If P3 is not complete by day 90 (74 planned + 16 slack), **cut in this order**: the second asphalt variant → 8 facade layers to 6 → the sky dome to 1 key (day only, night keeps the flat field and NIGHT-10 stays open) → the vegetation species classifier's tier-3 context fallback. **Do not cut SMAA, the modular storey bands, or the roof UVs — they are what make P3 "definitely better than what we have."**

---

## 12. Do this first

**The single next action, concrete enough to start immediately:**

```bash
cd /Users/apple/Desktop/delhi-drive
git checkout -b v3-p0-foundation
```

**Then, in this exact order, in one sitting (~2 hours):**

1. **`frontend/package.json:22`** — change the three dependency from `^0.183.1` to `0.183.1`. Delete `node_modules/three`, `npm install`, verify `node -e "console.log(require('three/package.json').version)"` prints `0.183.1`.

2. **`frontend/src/scene.js`**, in the renderer construction block near `:526-538`, add:
   ```js
   renderer.shadowMap.autoUpdate = false;
   ```
   Then in `frontend/src/main.js` near `:969`, keep the existing `renderer.shadowMap.needsUpdate = true` on light movement **and add the same line on two more triggers**: the tile-reveal hook in `tileManager.js`, and any frame where the car has moved more than 0.5 m since the last shadow refresh. Fix the lying comment at `:969` to describe what the code now actually does. **This is ~1.35 ms, it is banked exactly once, and three prior reports each tried to spend it.**

3. **`frontend/src/map/roadRenderer.js:283-301`** — split `patchRoadWash` into `patchRoadAO(mat)` (the v9 baked sky-visibility AO injection — **permanent**) and `patchRoadNightWash(mat)` (the night wash — **deletable in P2**). Have the current call sites call both, in that order. **Do this before anyone touches the lighting code, or the P2 night-stack deletion silently removes baked AO from every road in the city with no error.**

4. **`git rm -r --cached frontend/public/models/vegetation frontend/public/textures/trees frontend/public/fonts`**, move the vegetation and tree files to a new git-ignored `art-src/measurement-instruments/` (they remain usable for the card-tree A/B spike, they just stop being served), delete `frontend/public/fonts` outright, delete `frontend/src/style.css`, delete `frontend/src/ui/directionDisplay.js`, remove the stale Futura comment at `main.js:566`, and add `frontend/public/models/vegetation/`, `frontend/public/textures/trees/`, `frontend/public/fonts/`, `art-src/` to `.gitignore`. **These are live CC-violating and commercial-font assets being served from `drive.anmolbhardwaj.com` right now, and Vite copies `public/` verbatim into `dist`.**

5. **Write `scripts/route.js`** — a fixed benchmark drive: spawn at a committed Eixample coordinate, drive a fixed 90-second path at 80 km/h with `?mode=car`, NIGHT preset, production build, pixel ratio 1.0, logging every frame's `renderer.info.render.{calls, triangles}`, the p95 GPU from the existing `gpuTimer` at `main.js:150`, `renderer.info.programs.length` at loader-hide and at the end, and `performance.now()` from navigation start to `dd-loading` hide.

6. **Run it once and commit the output as `docs/context/v3-baseline.json`.** That single file **replaces all five domains' triangle estimates, settles whether the 95.7 MiB texture figure is real, converts road-surface's self-declared-low-confidence 5.0 ms ask into a number, and establishes the time-to-drive baseline that binding constraint 1 has never had.**

**Everything in §3 is arithmetic until step 6 exists. Do step 6 before authoring a single texel.**