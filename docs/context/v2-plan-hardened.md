<!-- Provenance: produced by a 12-agent adversarial workflow (5 independent domain
     investigations -> 5 cross-domain hostile cross-examinations -> completeness critique ->
     synthesis). 12 claims refuted, 38 cross-domain contradictions resolved.
     Supersedes the numbers in ets2-target-audit.md wherever the two disagree. -->

> **THIS DOC WINS.** Where this and [ets2-target-audit.md](ets2-target-audit.md) disagree, this one
> is correct — the audit's §0 constraints and free-asset strategy still stand, but several of its
> load-bearing numbers were refuted under cross-examination (see §2 below).
>
> **Spot-verified by hand after synthesis** (2026-08-24):
> - `frontend/public/textures/trees/` — 8 card-tree `.obj` + `summer_trees_0.webp` alpha atlas +
>   `summer_trees_0_n.webp` authored normal map, ~2.9 MB, **referenced from zero source files.** ✅
> - `renderer.shadowMap.autoUpdate` is **never assigned anywhere in `frontend/src`** — the comment at
>   `main.js:969` describes a state the code never establishes, so the shadow map re-renders every
>   frame and the throttled `needsUpdate = true` is a no-op. ✅
> - `adaptiveResolution.js:23` `FAST_MS = 15.5` (below the 16.67 ms vsync floor) ✅ — but note the
>   surrounding comment shows this was a **deliberate** "drop decisive, climb a trickle" choice under
>   vsync, not an unnoticed bug. Re-gating on `gpuMs` (item 0.4) is still the right fix.

# v2 Plan (hardened) — Conditional YES, but the audit's order is inverted: ship the engineering first, drop MeshStandard, and the budget closes at ~65% day / 50% night.

---

## 1. Verdict

**Conditional yes. The number moves from 65-75% to 65% by day and 50% at night, and the condition is that ~17 days of engineering land before asset #1.**

Three things moved the number:

**Down — night is structurally capped.** `main.js:192`: *"Dynamic PointLights removed — emissive lamp material + ground pool decals."* The live light set is 1 Ambient (`scene.js:623`), 1 Hemisphere (`:629`), 1 Directional (`:634`, and `CONFIG.ENABLE_DAY_NIGHT: false` at `config.js:55` means it is always in the scene), plus 2 car headlight SpotLights (`carModel.js:279`). At night the directional is dim and the street has **zero punctual lights**. MeshStandard's entire advantage over Lambert is specular response to punctual lights plus IBL. ETS2's night look *is* wet asphalt under sodium lamps. As scoped, PBR at night buys a slightly different ambient term for +3.0 ms. Night cannot exceed ~50% without a street-lighting pass that appears in no version of the audit.

**Down — the near-field bubble (C6) does not exist.** Buildings are gated on `nearEdgeDist = max(0, centerDist - 250)` (`tileManager.js:2909-2910`) applied per-tile at `tileManager.js:3068-3071`. With `BUILDING_MAX_DISTANCE: 250` (`config.js:75`) a 500 m tile is fully shown whenever its centre is within 500 m — so full-detail buildings render to ~700 m, worst case ~850 m at the far corner. Trees are the same mechanism: 13,963 concurrently visible under a nominal 170 m cutoff. Fidelity you pay for at 150 m, you currently pay for at 700 m.

**Up — the headroom is better than either the audit or the perf report believed.** 261-289 state-bearing draws, not 790. GPU 6.1-6.4 ms stationary day. Scene-wide IBL works on the existing 92 MeshLambert materials with no migration (`three.module.js:18067`; the load-bearing line is `lights_fragment_end.glsl.js:3-9`, `irradiance += iblIrradiance` under `#if defined(LAMBERT) || defined(PHONG)`). MeshLambertMaterial supports `normalMap` and `aoMap` in r183 (`MeshLambertMaterial.js:91,160`). And a cross-plane card-tree asset set with an authored foliage normal map has been sitting unused in the repo since March.

**The single biggest change to the plan: v2 does not migrate to MeshStandardMaterial.** v2 is Lambert + scene IBL + authored albedo/normal/AO. That decision alone takes the download from 33.7 MB to 23.3 MB, VRAM from 299 MiB to 153 MiB, and the night GPU budget from over-by-3ms to under-by-2ms. Everything below follows from it.

---

## 2. What the cross-examination CHANGED

| # | Audit claim | Verdict | Corrected statement |
|---|---|---|---|
| **C1** | Gap is an ASSET gap, ~70% art / 30% engineering | **CORRECTED** | ~50/50 by days, and the engineering must go **first**. Three domains independently found the split inverted in their lane. The perceptual blockers — per-tile LOD granularity, task #39 (24-25 ms of untagged `other` on worst frames), the adaptive-resolution ratchet, zero AA, the shadow `autoUpdate` bug — are all engineering, all cheap, and all gate whether any art investment is *visible*. Art on top of them is a prettier web demo. |
| **C2** | ~65-75% of the ETS2 vibe on desktop browser | **CORRECTED** | **65% day, 50% night as currently lit**, on a named machine (M-series laptop iGPU), at pixel ratio ≥ 1.0, production build. Night reaches ~65% only if a street-lighting pass is added to scope. "Desktop browser" without a named machine and a render-scale floor is not a target — `adaptiveResolution.js:13-14` caps at 1.2 and floors at 0.55, and it was caught live at 0.88 in Eixample. |
| **C3** | ~25-30 MB download / ~15-20 MB VRAM; download is not the binding constraint | **SPLIT: download CONFIRMED, VRAM REFUTED by 8-15×** | Download: the audit's per-material figure is right (measured 446,685 B for a 1K albedo+normal+ORM ETC1S q128 set). The library as specified lands at **33.7 MB**, 12% over the §0 cap — and the entire overrun is the facade line (14.7 MB actual vs 8 MB budgeted); the foliage line (~4.1 MB) and props line (~5 MB) were correct as written. VRAM: real resident cost of the §6d library is **160 MiB on the ETC2 path, 299 MiB on BC7**, not 15-20 MB. `.ktx2` file size is a variable-rate transmission format; VRAM is fixed at the transcode target's block rate × 1.333 for mips. **VRAM is a third binding constraint the audit omits entirely.** |
| **C4** | Binding constraints are draw calls (790 of a ~1000-2000 ceiling) and 1:1 city scale | **REFUTED on draws; scale CONFIRMED** | 261-289 measured state-bearing draws (the 790 was copied from a `perf-audit.md` committed 2026-07-06, 261 commits stale, before `GRID_RADIUS` became 1 and `MAX_TREES_PER_TILE` became 1500). Note `renderer.info.render.calls` counts a `WEBGL_multi_draw` batch as **one** call (`WebGLBufferRenderer.js:29-45` returns before `info.update()` when `drawCount === 0`), so 13,963 trees register as 2 calls. The real binding constraints are: **VRAM residency, fragment/overdraw at speed and at night, CPU stream-in, and per-tile LOD granularity.** §0 rule 3 ("variety is never bought with draws") should read "variety is bought in shader programs and VRAM." |
| **C5** | SSAO is re-attemptable; a depth prepass largely pays for itself | **CORRECTED, and the answer is "don't"** | The mechanism in C5's favour is real and stronger than stated — `painterSortStable` sorts by `material.id` *before* z (`three.module.js:8146` vs `:8154`), and geometry is merged into 500 m tile-sized meshes so object sorting has 500 m of resolution. But the economics fail today: shading is cheap Lambert, foliage is opaque and Z-rejects, so the recoverable fragment work is a few tenths of a millisecond against a full extra vertex pass. **A whole-scene prepass stays dead.** A *foliage-only* alpha-tested prepass is a different animal (2-4 pooled draws, not +600) and pays once cards land. Correct order: cards → foliage-only prepass → *nothing*. **SSAO is rejected outright** in favour of extending the existing baked sky-visibility AO (tile v9, `aoSampler.js`) — same grounding cue, zero per-frame cost. |
| **C6** | v2 = ETS2 fidelity in a ~150 m near-field bubble, degrading past it | **REFUTED as-implemented; CORRECT as a target** | The bubble is not implemented. Buildings render to ~700 m and trees show 100% of a tile whose *nearest edge* is inside 80 m (`tileManager.js:2907-2910, 2964-2977, 3068-3071`). The LOD-box band is 200-380 m (`config.js:77-79`), not the 110/230 dead-fallback branch. **Per-instance / per-building distance gating is the load-bearing prerequisite for the entire plan, not an optimisation** — it is worth ~3.0 ms of night GPU on its own and is what makes the budget close. |
| **C7** | Blender Sapling → ortho leaf cluster → bake normal → cross-plane cards → existing billboard LOD | **CORRECTED — the asset already exists, the LOD does not** | `frontend/public/textures/trees/` contains 8 Blender card-tree `.obj` models (115-183 tris, quads+tris, with UVs and normals), `summer_trees_0.webp` 2048×512 RGBA (alpha atlas) and **`summer_trees_0_n.webp` 2048×512 — an authored foliage normal map** — in the shared 4-species-in-a-row layout the plan independently recommends building. Unreferenced from any source file. Separately: current trees are 46-66 tris (avg 61), not "20-tri blobs" nor `config.js:70`'s "~117". And the "existing billboard LOD" is designed for 170-470 m but truncated to 170-280 m by the fog cull at `tileManager.js:2916` — 37% of the fade — with species selected by four *separate materials*. **Measure the on-disk set before opening Blender.** |

---

## 3. Cross-domain contradictions and how they were resolved

**1. Is the frame GPU-bound or CPU-bound? — Both, split by regime. The perf report's "not GPU-bound" is a stationary artifact.**
Every GPU reading in every report was taken at 0 km/h, and `main.js:1002` reads `radialBlurPass.enabled = blurSpd > 30`. The most expensive post pass in a driving game was **disabled in every measurement**. The project's own `fps-diagnosis.md` records GPU 13-19 ms at speed in day, 14.5-19 ms night ped/tree-dense, 24.8 ms tree-dense at speed. Ruling: **CPU/stream-bound during tile stream-in (worst-frame `other` 23.9-25.4 ms), GPU/fragment-bound at speed and at night.** Note `cpuTimer.js:24-28` explicitly documents `other` as containing vsync idle and GPU wait, so it is not by itself evidence of CPU-boundness. **All budgets are built from the at-speed night number.**

**2. The shadow budget was claimed once and spent three times.**
`grep -rn autoUpdate frontend/src` returns exactly one line — `main.js:969`, the comment asserting the opposite of the truth. `three.module.js:9140` defaults it true, `:9149` early-outs only when `=== false`. Two reports found it, both quoted ~1.2-1.5 ms, **nobody measured it**, and then render-9 spent it on a two-light split, perf-15 spent it on CSM, and veg-13 spent it on tree shadows. Ruling: **one saving, banked once.** render-9's two-light split is **refuted at three's source level** — `WebGLShadowMap` tests `object.layers` against the *main* camera (`three.module.js:9405`, `:9565`) and lights are gathered per-camera (`:17172`, `:17598`), so neither casters nor receivers can be partitioned by layer, and two co-directional lights either double the key or halve every shadow. The saving goes to: `autoUpdate = false` + explicit `needsUpdate` on tile reveal + on car movement. CSM stays behind the materialRegistry refactor.

**3. VRAM: is authored art a win or a loss? — A per-texture win, a library-scale loss.**
The buildings report measured one 1024² canvas at 5.6 MB RGBA8+mips vs ~0.5-0.7 MB compressed (8× per-texture win) and concluded "authored art is a VRAM WIN" — then never multiplied by ~100 maps. Against the measured 95.7 MB of scene texture VRAM today, of which only 55.9 MB (night-window atlases) is reclaimable, the audit's library is **+65 to +200 MiB net**. Ruling: budget-3, corrected upward — the foliage line must be charged at 8bpp because ETC1S-with-alpha maps to `RGBA_ETC2_EAC` (`KTX2Loader.js:807-814`).

**4. Which line breaks the download budget? — Facades, not foliage.**
The asset report charged 4 foliage species at 6.62 MB and called the audit "1.7× low" — while its own `alpha.log` measured a 1K foliage RGBA atlas at 68,888 B (2.3× cheaper than asphalt diffuse, because a leaf cutout is mostly transparent). Correctly scaled: ~4.1 MB. The audit was right. Facades are the whole overrun. Ruling: cut facade sheets 8 → 5, don't touch foliage.

**5. AO under IBL — both right, split by material.**
`ao-2` warns IBL leaves indirect specular unattenuated; `render-12` proposes scene-wide IBL. Verified: neither `lights_lambert_pars_fragment.glsl.js` nor `lights_phong_pars_fragment.glsl.js` defines `RE_IndirectSpecular`, and `envmap_fragment.glsl.js` only fires for `ENVMAP_TYPE_CUBE`/`EQUIREC`, never the `CUBE_UV` that `scene.environment` PMREM produces. On Lambert/Phong, IBL contributes only `iblIrradiance`, which flows through `BRDF_Lambert(diffuseColor)` — and `<color_fragment>` (where `AO_FRAG_APPLY` is injected, `meshMaterializer.js:667`) precedes `<lights_fragment_maps>` (`meshlambert.glsl.js:96` vs `:107`), so baked AO **correctly attenuates it**. Ruling: **IBL on Lambert is safe today and free of AO rework.** The `<aomap_fragment>` port is required only if MeshStandard ever lands — which, per §1, it does not in v2.

**6. Post-chain savings were spent four times** (radial blur, OutputPass, bloom-by-day, SMAA, raising the DPR cap). Sized honestly: radial blur ~0.3-1.1 ms *at speed only*; OutputPass folds one full-res blit, well under 0.2 ms, and frees **zero** VRAM (`EffectComposer.js:66-79` allocates both ping-pong targets in the constructor regardless of pass count); bloom-off-by-day ~0.6 ms *in day only*, and it is a **look change** requiring screenshot approval, not a freebie. Ruling: the cuts fund **SMAA and nothing else**. The DPR cap stays at 1.2.

**7. The triangle envelope was spent three times.** Ruling: `makeBoxGeom` 8→24 verts costs **zero triangles** (12 tris/box either way), so tripling `BALCONY_VERT_CAP`/`BOUNDARY_VERT_CAP` in the same change is nearly free and must be done or cornice density silently drops to ⅓. Vegetation's per-instance LOD is a real 274 k **reduction**. Roof geometry is the only real spend and must be gated against `GLOBAL_VERTEX_BUDGET = 100000` (`buildingWorker.js:1096-1101`), which currently drops **entire buildings** rather than degrading, in the p90=306 / max=745-building tiles.

**8. `adaptiveResolution` is a one-way ratchet on 60 Hz and inert on 120 Hz.** `FAST_MS = 15.5` (`adaptiveResolution.js:23`) is *below* the 16.67 ms vsync floor, so `avg < FAST_MS` is unreachable on a 60 Hz display and scale can only step down, never back up. On 120 Hz (`main.js:729` defaults the cap to 120, despite its comment claiming 60) frameDt is ~8.3 ms and it pins at CAP forever. It works as designed on neither common configuration, and it keys on frame delta, so CPU stalls blur the screen without recovering a frame. **This is why v2 fidelity would be invisible: the controller will trade it away silently and never trade it back.**

---

## 4. The real budget

Measured on M-series laptop, Chrome/macOS, dev server, Barcelona. v2 targets are hard caps for the corridor gate (§6).

| Metric | v1 measured | v2 target | Defence |
|---|---|---|---|
| **Draws** (state-bearing) | 261-264 seafront / **289** dense Eixample | **≤ 450** | `renderer.info.render.calls`, includes shadow + post passes (`main.js:1003` resets immediately before `composer.render()`). Not binding: `rend` = 1.2 ms covers sort + 289 draws + 5 full-screen passes. 5 facade variants × 4-6 tiles ≈ +30 draws; 3 foliage LOD tiers in one pool ≈ +2. |
| **Driver sub-draws** | ~14,000 | ~5,000 | `_multiDrawCount` 3326 + 10637 on the two tree pools. Per-instance LOD cuts concurrent LOD0 trees from 13,963 to ~1,100. |
| **Triangles** | 1.43 M seafront / **2.32 M** Eixample | **≤ 2.6 M** | Trees 851,743 (36.3%) → ~580 k under the LOD ladder; buildings gain roof parapets and 3× detail *vertices* at 0 triangle cost. |
| **GPU ms** (p95, 80 km/h, **night**, dense Eixample, pr 1.0) | **17.0** | **≤ 15.0** | Baseline from `fps-diagnosis.md` (14.5-19 night ped/tree-dense, 24.8 tree-dense at speed). Ledger: −1.2 shadow `autoUpdate`, −0.7 radial blur delete, −0.15 OutputPass fold, **−3.0 per-instance building/tree distance gating**, +0.7 SMAA, +0.8 Lambert IBL, +1.2 foliage cards net of the prepass and the LOD cut, **+0.0 PBR / CSM / SSAO (all out of scope)** = **14.6 ms**. |
| **GPU ms** (stationary, day) | 6.1-6.4 | ≤ 7.5 | gpuTimer, `main.js:150`. Note this is a sparse EMA (`ema*0.85 + ms*0.15`, one sample per 2-4 frames) and under-weights spikes. |
| **CPU ms** — `rend` | 1.2 | ≤ 2.0 | cpuTimer section, `main.js:1008`. ≤ 4.6 µs/draw upper bound. |
| **CPU ms** — worst-frame `other` | **23.9-25.4** (stream-in) | **≤ 8.0** | Requires task #39 to close. This is the single largest number in the whole table and it is not a fidelity problem. |
| **Texture VRAM** | **95.7 MiB** (55.9 = night-window canvas atlases) | **≤ 200 MiB, both platforms** | v2: tiling 40 × 1K albedo+normal = 26.7 + facades 5 sheets = 30.0 + foliage (2K RGBA albedo at 8bpp + 2K normal) = 32.0 + props 8 × 1K × 2 = 10.7 + residual canvas after the GRID 4→2 fix = 53.7 → **153 MiB**. Requires the BC1 override (below). |
| **Download** — art library | 0 | **≤ 24 MB** | Measured ETC1S q128 + mips: tiling 20 × (159 + 179 KB) = 6.76; facades 5 × (632 + 784 + 400 KB) = 9.08; foliage 4 × ~1.02 MB = 4.15; props 8 × 338 KB = 2.70; Basis transcoder 0.58 = **23.3 MB**. No ORM maps — Lambert has no roughness/metalness slot. |
| **Download** — total non-tile | ~30 MB disk / ~25 MB wire | ≤ 42 MB disk | 30 − 11.5 reclaimed + 23.3 art. Tiles (547 MB) stream from R2 and are not page load. |
| **Time-to-drive** | *unmeasured* | **≤ baseline + 1.5 s** | `main.js:631-635` holds the loader until `isInitialLoadComplete()`, capped at 130 polls, with a 20 s safety net at `:723`. Only the ~6 MB hero set may block; the rest streams behind the title. **§0 rule 1 lives or dies here and nobody was watching it.** |
| **Shader programs** | 125 | delta = 0 after loader lifts | `warmAllBuildingMaterials` (`meshMaterializer.js:965-984`) exists because first-appearance compiles were measured at ~100 ms frames. Live HUD showed `prog +7` mid-session. Mechanism found: the warm meshes are plain `new THREE.Mesh` (`main.js:695`), so **no `USE_BATCHING` or `USE_INSTANCING` variant is ever warmed**. |

**Mandatory format override.** three r183 ranks BC7 above BC1 for ETC1S content (`KTX2Loader.js:787-794` `priorityETC1S: 3` vs `:797-804` `: 4`), so on Windows/NVIDIA an all-ETC1S library transcodes to **8 bpp** — UASTC-tier VRAM for ETC1S-tier quality — while this Mac gets 4 bpp ETC2. Patching `FORMAT_OPTIONS` to prefer `dxt`/BC1 for ETC1S halves Windows VRAM. Also note the ASTC entry is `basisFormat: [UASTC]` with `priorityETC1S: Infinity`, so all-ETC1S **can never reach ASTC** on mobile.

---

## 5. The plan

Reordered against the audit: **engineering first.** Nothing in Tier 0 or Tier 1 makes the game look better on its own — they make the art *visible* and the measurements *honest*.

### Tier 0 — Instrument, unblock, stop the bleeding (6 days, zero art)

| # | What | Files | Days | Depends | Risk |
|---|---|---|---|---|---|
| 0.1 | Pin `three` to exact `0.183.1` (drop the caret). Four plan items depend on r183 private internals: `bm._visibilityChanged`, `bm._colorsTexture` (`vegPools.js:170`), `KTX2Loader` FORMAT_OPTIONS priority, `painterSortStable` field order, the `DOUBLE_SIDED` tangent flip. | `frontend/package.json:22` | 0.1 | — | none |
| 0.2 | Fix shared-material disposal. `tileManager.js:2856-2872` disposes `material.map` and `material` unless `userData.sharedMaterial` is set. Two live misses: `roadRenderer.js:2096` (bikepictogram) and `:2202` (zona30Stencil), both backed by module-level singletons. **Invert the default** to an explicit `ownedMaterial` opt-in and assert nothing in the art-library registry is ever disposed. | `tileManager.js:2856-2872`, `roadRenderer.js:2096,2202` | 0.5 | — | **High if skipped** — under a shared KTX2 library each miss disposes a city-wide texture and kills a compiled program per tile unload |
| 0.3 | `renderer.shadowMap.autoUpdate = false` **plus** explicit `needsUpdate` on tile reveal and on car movement. Do not ship the flag alone: the player car is the only remaining dynamic caster (traffic `trafficSystem.js:222`, peds `pedestrians.js:56`, parked `parkedCars.js:71` are all already `castShadow: false`), and tiles streaming in while stationary would get no shadow at all. | `scene.js:~535`, `main.js:955-970`, tile-reveal hook | 0.5 | 0.1 | medium |
| 0.4 | Re-gate `adaptiveResolution` on `gpuMs` (fall back to frame delta with no `EXT_disjoint_timer_query_webgl2`). Fixes both the mis-attribution and the 60 Hz one-way ratchet. Add a declared render-scale floor as an acceptance criterion. | `adaptiveResolution.js:22-70`, `main.js:1034-1035` | 0.5 | — | low — **without this v2 fidelity is invisible** |
| 0.5 | Post-chain: delete `RadialBlurPass` (ETS2 has no radial blur); fold ACES + sRGB into `colorGradePass` reading `renderer.toneMappingExposure` as a **live uniform** (`envToggle.js:138` animates it); delete `OutputPass`; gate bloom off in the DAY preset off the **target** preset, not the lerped value (`envToggle.js:141` calls `setBloom` every frame during transition). | `main.js:161-174,189,1000-1003`, `colorGradePass.js`, `envToggle.js` | 1.0 | — | low; bloom-off is a **look change**, needs screenshot approval |
| 0.6 | **Measurement harness.** Scripted route, `perfLogger` (`main.js:1016-1032`), run in **dev AND `npm run build && npm run preview`**, day AND night, stationary AND 80 km/h. Bracket `renderer.shadowMap` with the gpuTimer. RadialBlurPass A/B at 90 km/h. Record time-to-drive from navigation start to loader hide. Commit 6 screenshot poses (3 day, 3 night). | `perfLogger.js`, new `scripts/route.js` | 1.5 | 0.5 | none — **this is the highest-value item in the plan** |
| 0.7 | Read the OS/browser split from Cloudflare Web Analytics. The beacon is live in production (`analytics.js:14`, token `b8d2aab7...`, PROD-gated at `:19`). The asset report claimed "nothing in the repo records analytics" — false. Decides ETC2 vs BC7 as the VRAM target. | — | 0.1 | — | none |
| 0.8 | Reclaim 11.5 MB of shipped waste: `modes/*.png` 7.53 → 0.35 MB WebP q82, logo 0.92 → 0.10, delete `title-bg.png` (1.57 MB, referenced only by og:image at `index.html:30,38` pointing at `barcelona-drive.example`). **ARCHIVE, do not delete**, `public/textures/trees/` and `public/models/vegetation/trees/` — they are the Tier-2 measurement instrument. | `public/modes/`, `index.html`, `scripts/optimize-textures.js` | 0.5 | — | low |
| 0.9 | **Write down the art direction: stylized-PBR, not photoscan.** §6a lists Poly Haven photoscans and Kenney/Quaternius stylized assets in the same approved-sources table with no note. The 9 Kenney city cars are 2,032-2,476 tris with one 3,110-byte WebP palette atlas and `metallicFactor: 0`; they read fine because the whole world is flat-shaded. Photoscan asphalt makes them toys. Free today, unrecoverable after 100 assets. | `docs/context/ets2-target-audit.md §6a` | 0.25 | — | **decision, not work** |

### Tier 1 — The perceptual unblockers (11 days, still zero art)

| # | What | Files | Days | Depends | Risk |
|---|---|---|---|---|---|
| 1.1 | **Per-instance / per-building distance LOD**, replacing the per-tile `nearEdgeDist` gate. Trees: banded `setLodAt(handle, camX, camZ)` with hysteresis calling `setGeometryIdAt` — which is a pure array write (`BatchedMesh.js:1185-1194`) but **does not set `_visibilityChanged`**, and the pools set `perObjectFrustumCulled = false` + `sortObjects = false` (`vegPools.js:45-46`), so `onBeforeRender` early-outs at `BatchedMesh.js:1507` and the swap silently no-ops. Must write `bm._visibilityChanged = true`. Buildings: per-mesh true distance instead of `nearEdgeDist`. | `tileManager.js:2903-2977,3058-3075`, `vegPools.js:70-79,177-186` | 5.0 | 0.1, 0.6 | **highest** — this is the item the budget rests on (−3.0 ms). Coarse bands only; a continuous function re-walks 16,384 instances per pool per frame |
| 1.2 | Un-truncate the billboard band: clamp `bbEnd` to `FOG_FULL_DIST` (designed 170-470 m, effective 170-280 m). Billboard material → `transparent: false` (it already has `alphaTest: 0.05`). **Mipmap the atlas** — `vegetationRenderer.js:875-877` sets `minFilter = LinearFilter`, no mips, so distant billboards already alias today. | `tileManager.js:2916,2969-2973`, `vegetationRenderer.js:875-877,900-908` | 0.5 | — | low |
| 1.3 | Collapse 4 billboard materials + 4 pool sets → 1. All four already share one `CanvasTexture` singleton and differ only in the `bbUvOff` uniform (`vegetationRenderer.js:813-815,906,921-923`), so this is 4 baked UV sets + `setGeometryIdAt`. Available today against the procedural atlas. | `vegetationRenderer.js:899-957`, `meshMaterializer.js:1068-1073` | 0.5 | 1.1 | low |
| 1.4 | **SMAA pass.** There is no AA anywhere: `antialias: false` (`scene.js:526`), `EffectComposer.js:67` allocates HalfFloat targets with no `samples`, no AA pass in the chain. Alpha-tested foliage in a zero-AA forward pipeline shimmers worse than the current solid blobs. Prerequisite, not polish. | `main.js:145-174` | 1.0 | 0.5 | low |
| 1.5 | **`materialRegistry` chokepoint** that *chains* `onBeforeCompile` instead of assigning it, routing all 68 `getXMaterial()` factories through it. Ten sites currently own `onBeforeCompile` outright. This gates CSM (three's `CSM.js:443` hard-assigns it), every scene-wide shader feature, and a managed variant warm list. | new `materialRegistry.js`, ~20 renderer modules | 3.0 | 0.1 | medium — touches everything |
| 1.6 | **Scene-wide IBL on Lambert.** One PMREM from the live sky palette (the plumbing already exists at `carModel.js:124-161`), `scene.environment` + `environmentIntensity` per preset, HemisphereLight dialled back. **Pre-bake day and night PMREMs and cross-fade intensity** — do not call `fromScene()` per lerp frame. Ship **with** the extended warm list: adding `USE_ENVMAP` + `ENVMAP_TYPE_CUBE_UV` invalidates every compiled program at once. | new `skyEnv.js`, `scene.js`, `envToggle.js`, `meshMaterializer.js:971-984` | 1.5 | 1.5 | medium — compile storm if warm list is not extended in the same commit |
| 1.7 | Wind fix: trees sway in **global unison** — `getVegPools(scene)` (`tileManager.js:1336`) makes pools direct children of the Scene, so `modelMatrix` is identity and `windOrigin` evaluates to exactly `(0,0,0)`. Fix must branch on **both** defines, because `environmentClusterRenderer.js:465-470` uses the same material on `InstancedMesh`. | `vegetationRenderer.js:203-215` | 0.25 | — | low |
| 1.8 | **Resume and close task #39** (frame pipeline, ON HOLD since 2026-07-16). Worst frames are 24-25 ms of untagged `other` with the GPU at 6 ms; a 193.5 ms `p1 physics` build chunk and a 780 ms worst frame were seen during stream-in. Runs parallel to 1.1-1.7. | `tileManager.js`, `workers/*` | 3.0 | 0.6 | **it corrupts every measurement the gate takes** |

### Tier 2 — Art, corridor-scoped (14 days)

| # | What | Files | Days | Depends | Risk |
|---|---|---|---|---|---|
| 2.1 | `loaders.js` → singleton registry: **one** module-level `KTX2Loader` (`setTranscoderPath('/basis/')`, `detectSupport(renderer)` once after renderer creation), one `MeshoptDecoder`, injected into each `GLTFLoader`; `getKTX2Texture(url)` promise-cache. `makeGLTFLoader()` currently returns a new loader per call (`loaders.js:11-13`, 3 live consumers) — naive wiring creates 3 transcoder fetches and up to 12 workers. **Meshopt, not Draco** (32,392 B bundled ESM vs `/draco/` served + its own pool; Meshopt compresses animation bufferViews, which are 21-31% of the people GLBs). Compress with `gltfpack -cc` **without** `-vp/-vt` quantization — the recorded car regression was quantization, not codec. **Plus the BC1-over-BC7 FORMAT_OPTIONS override.** | `loaders.js`, `main.js`, `public/basis/` (vendor 584,862 B, unhashed path) | 1.5 | 0.1 | low |
| 2.2 | `frontend/public/_headers` with `immutable` on `/basis/*`, `/models/*`, `/art/*`; versioned `/art/v1/` path (public/ filenames carry no content hash; no `_headers` or `wrangler.toml` exists anywhere). Add a `DEPLOY.md` note that `vite build` (`deploy-cloudflare.sh:33`) empties `frontend/dist` — destroying the 547 MB `dist/tiles` leftover — and **must** precede the wrangler deploy at `:48`. | `public/_headers`, `DEPLOY.md` | 0.25 | — | low |
| 2.3 | **Encode + normalize pipeline** (committed artefact, never run on Pages — ~10 min for a full library). Order: delight (subtract low-frequency baked AO, or every surface fights the game's own v9 AO grid) → Lab mean-L*/C* rescale per surface class → roughness/normal-strength calibration → palette snap to 8-10 Barcelona hues → ETC1S q128 + mips. **Must specify: sRGB transfer for albedo, linear for normal/AO** (three reads it straight off the DFD at `KTX2Loader.js:1232` and `verifyColorSpace` early-returns for compressed textures — no warning if wrong), and **the v-flip decision** (WebGL ignores `UNPACK_FLIP_Y_WEBGL` for compressed uploads, so every `.ktx2` renders un-flipped against UVs authored for flipY canvas textures). Hard per-class and total byte ceilings that **exit non-zero**. | new `scripts/build-art.mjs`, `scripts/normalize-art.mjs` | 3.0 | 2.1 | medium — v-flip and transfer flags fail silently |
| 2.4 | Facade UV vertical period: set the wall v-repeat divisor to **9** (three 3.0 m floors). The texture row period is already 3.008 m and *matches* the geometry's 3.0 m floor bands — the defect is that `FLOOR_HEIGHT = 10` is not an integer multiple, so exactly two rows fit per tile (sills at 3.79 m and 6.80 m) leaving a ~7 m blank band at every wrap. Single-source the triple-mirrored `FLOOR_HEIGHT`/`WALL_REPEAT_HORIZONTAL_M` (`buildingWorker.js:38-39`, `meshMaterializer.js:25-26`, `buildingRenderer.js:576-577`) in the same pass. | as listed | 1.0 | — | low |
| 2.5 | `makeBoxGeom` 8 → 24 vertices with per-face UVs and flat normals, **and triple `BALCONY_VERT_CAP`/`BOUNDARY_VERT_CAP` in the same commit** — triangle count is unchanged at 12/box, so the cap increase is free and without it cornice/balcony density drops to ⅓. `makeQuadGeom` already emits correct flat normals and needs no change. | `workerGeometry.js:864-916`, `buildingWorker.js:43-47` | 1.0 | — | low |
| 2.6 | Building winding → `FrontSide`. Signed-area normalise footprints, inner rings and bespoke paths; verify with a debug pass; flip `BUILDING_SIDE` (`meshMaterializer.js:562`). **Not** a correctness prerequisite for normal maps — `normal_fragment_begin.glsl.js:41-47` flips the derivative TBN under `DOUBLE_SIDED` — but it halves primitive setup and raster on the largest triangle population and cleans the shadow pass. | `buildingWorker.js`, `workerGeometry.js`, `meshMaterializer.js:558-562` | 2.0 | 2.5 | medium |
| 2.7 | **Tree cards.** Step 1 (half a day): measure the on-disk `.obj` set. `OBJLoader` never calls `setIndex`, so it emits **non-indexed** `{position, normal, uv}` — matching the pool on indexed-ness and 3 of 4 attributes; the only gap is `color` (`BatchedMesh._validateGeometry`, `BatchedMesh.js:419-445`). Step 2: author only what the measurement says is missing. 3 LOD tiers × 4 species, one shared 2K ETC1S atlas with the cell offset baked into card UVs, all 12 geometries in **one** pool. Plus a foliage-only alpha-tested depth prepass. **Keep the `color` attribute neutralised to white** — `patchVegWash` reads the colours-texture alpha via `getBatchingColor` (`vegetationRenderer.js:239-256`) and stripping it kills the night urban-glow wash. Pools must be **constructed after** the geometry resolves: `createVegPool` sizes the vertex/index buffers once (`vegPools.js:31-38`) and there is no grow path. | `vegetationRenderer.js`, `vegPools.js`, `meshMaterializer.js:1052-1074` | 4.0 | 1.1, 2.3 | medium |
| 2.8 | Night emissive atlas `GRID` 4 → 2 (1024 → 512, −42 MiB VRAM, identical texel density) **or** rebuild as R8 + a warm-tint uniform (−4×, identical resolution). Do **not** drop `BASE` — at `BASE 64` each lit window becomes a 2 px × 9 px rect. All 16 variants build their atlas unconditionally at boot (`meshMaterializer.js:971-984`, `:610-613`) even in a day-only session: ~67 MB of canvas backing store and 16 main-thread 2D draw loops. | `buildingRenderer.js:564-637` | 0.5 | — | low |
| 2.9 | **Roof pass — parapets, tiled edge bands, rooftop terrace furniture.** Not pitched/hipped/mansard: Barcelona's Eixample roofscape is flat *terrats*, and hipped forms over RDP-simplified non-convex footprints with inner rings need a straight skeleton, which is far more than 3 days. Roofs are one earcut cap into one constant material bucket (`buildingWorker.js:392-394,592-609`) with **no AO attribute**, so this avoids the entire facade prerequisite chain. Must be gated against `GLOBAL_VERTEX_BUDGET = 100000`. | `buildingWorker.js:592-624,1123-1150` | 3.0 | 2.5 | medium — silently drops whole buildings if ungated |
| 2.10 | Re-skin the 9 Kenney city cars onto the v2 library (single-material each, cheap) and the 28 full-detail traffic clones (`trafficSystem.js:44`). | `public/models/cars/*.glb`, `carModels.js` | 1.5 | 0.9, 2.3 | low |

### Tier 3 — Only if the gate shows headroom

| # | What | Verdict |
|---|---|---|
| 3.1 | **Street lighting pass** — return a small clustered set of punctual lights to the night street. | **This, not PBR, is the actual prerequisite for a night ETS2 look.** Promote it above 3.2. |
| 3.2 | MeshStandard migration | **Deferred out of v2.** +3.0 ms for a slightly different ambient term while there are no punctual lights. Revisit only after 3.1. |
| 3.3 | CSM | Deferred behind 1.5. Note the near cascade must hold ≥ 0.166 m/texel (today's 1024² over ±85 m) or canopy shadows degrade at the moment they start to matter. |
| 3.4 | SSAO | **Rejected.** Extend the baked v9 sky-visibility AO instead — finer grid, AO on facades not just ground, cheap analytic contact darkening under vehicles. Zero per-frame cost. ⚠️ **REQUIRES A TILE RE-BAKE.** 17 of 426 tiles are still v7 with **no AO grid** — any AO-dependent material needs a null path (`buildingWorker.js:1071` never allocates the `ao` array when `aoSvfAt` is null). |
| 3.5 | >4 tree species / species-by-context placement | ⚠️ **REQUIRES A TILE RE-BAKE.** `NUM_TREE_VARIANTS = 4` is baked as Uint8 (`vegetationBaker.js:28,705-709`) and the runtime mods by its own count (`vegetationWorker.js:1947`), so raising the runtime number alone leaves new species unreachable. Placement is species-blind `seeded(i, seed) % 4`. Arguably a bigger ETS2-vibe delta than mesh quality — but it costs a full re-bake (10-30 min, 547 MB re-committed, `TILE_VERSION` bumps in `mapLoader.js` + `tileParserWorker.js`, and every existing player needs `window._clearTileCache()`). |
| 3.6 | Baked vertex tangents (v10) | ⚠️ **REQUIRES A TILE RE-BAKE. Rejected for v2.** There are zero tangent attributes anywhere in `frontend/src`; three's derivative TBN path (~30-40 ALU/fragment) is acceptable at browser resolution and on Lambert's diffuse-only normal response. |
| 3.7 | **Mobile quality tier** | `grep -i quality frontend/src/config.js` returns nothing. The only device branching in the entire frontend is three copies of `(pointer: coarse)` for HUD layout (`minimap.js:20`, `speedDisplay.js:36`, `touchControls.js:30`). §0 rule 5 ("must not hard-break mobile") assumes a scale-down mechanism that **does not exist**. At 153 MiB texture VRAM on top of a 700 MB heap, on unified-memory mobile with Safari killing tabs around 1-1.5 GB, this is mandatory before any mobile release — half-res library + a manifest flag that skips normal maps on coarse-pointer devices. |

---

## 6. The gate

**Not a single static block.** A one-block slice structurally cannot catch streaming (it never unloads — so it cannot surface the disposal bug, sibling-pool growth, or long-session heap, and every measured worst frame in this codebase is a stream-in frame), motion (stationary hides RadialBlurPass, LOD band crossings, per-tile popping, and foliage shimmer — which only exists in motion), night, time-to-drive, or the seam.

### The corridor gate

**Scope:** one continuous ~1.5 km drive corridor — Gran Via or Diagonal — spanning **6-8 contiguous tiles**, driven end to end. Fewer assets, more world.

**Exact assets (5 total, ~6 MB):**
1. Asphalt: albedo + normal, 1K tiling, ETC1S q128
2. Panot sidewalk: albedo + normal, 1K tiling
3. One Eixample facade sheet: 2K albedo + 2K normal + 1K single-channel window-lights emissive mask **on the same UV layout** (`getWindowTexture` and `getNightEmissiveTexture` are both driven by `WINDOW_STYLES`, `meshMaterializer.js:37-46` / `buildingRenderer.js:568-586` — the mask is a 3rd map, not optional). Do **not** channel-pack the mask into an ORM slot: ETC1S shares chroma endpoints per 4×4 block.
4. One tree species: LOD0 cards + LOD1 + billboard, sharing one 2K RGBA atlas + normal
5. Roof: parapet band + tiled edge (geometry, zero download)

**Instrument before converting** (0.5 days, before any art): Tier 0.1, 0.2, 0.6 must be done. Baseline captured on the same scripted route, dev **and** production build.

### Numeric go/no-go thresholds

| # | Metric | Threshold | Condition |
|---|---|---|---|
| 1 | **p95 frame time** | **≤ 16.7 ms** | 80 km/h, **night**, dense end of corridor, `npm run preview` build, `?fpscap=60`, adaptive floor pinned to **1.0** |
| 2 | **p95 GPU time** | **≤ 15.0 ms** | same conditions, gpuTimer bracketing `composer.render()` |
| 3 | **Draw calls** | **≤ 450** | `renderer.info.render.calls`, p95 over the drive |
| 4 | **Triangles** | **≤ 2.6 M** | p95 over the drive |
| 5 | **Texture VRAM** | **≤ 200 MiB** | measured on a **BC-path** machine (Windows/NVIDIA) with the BC1 override in, **and** on the Mac |
| 6 | **Added download** | **≤ 8 MB** for the corridor set; linear extrapolation to full library **≤ 28 MB** | measured over the wire, not on disk |
| 7 | **Time-to-drive** | **≤ baseline + 1.5 s** | navigation start → `dd-loading` hide (`main.js:631-635`), median of 5 cold loads, cache disabled |
| 8 | **Shader programs** | **delta = 0** | `renderer.info.programs.length` sampled at loader-hide and after a 3-minute drive |
| 9 | **Heap growth** | **≤ +15%** | `usedJSHeapSize` at 10-minute loop vs 3-minute mark — the leak test a static block cannot run |
| 10 | **Screenshot poses** | 6 committed poses (3 day, 3 night) reproduced before/after | build the harness *before* the art, or the "before" is gone |
| 11 | **SEAM TEST** | drive from converted corridor into unconverted city, screenshot the boundary — binary human verdict | **the highest-information question in the plan and neither the audit nor any report asks it** |

**GO** = all 11 pass.
**CONDITIONAL** = 1-2 numeric misses, each with a named fix costing ≤ 2 days.
**NO-GO** = the seam test fails, **or** ≥ 3 numeric misses, **or** #1 misses by more than 20% (> 20 ms).

---

## 7. Kill criteria

Abandon browser-v2 and reconsider Unity if **any** of these measure true:

| K | Measurement | Why it kills |
|---|---|---|
| **K1** | After Tier 0 + Tier 1 land, corridor **GPU p95 > 20 ms** at 80 km/h night at pr 1.0, with GPU (not CPU `other`) as the dominant term | The fragment budget is structurally short. Per-instance LOD is the last big lever; if it lands and this still fails, no art-side trim recovers 4 ms. |
| **K2** | The **seam test** (gate #11) returns unacceptable | v2 is not a tiered rollout — it is all-or-nothing across 426 tiles. Re-cost as a full-city art job (≈4-6× the corridor) and compare that number directly against the Unity port's remaining work. |
| **K3** | **Time-to-drive regression > +3 s** with only the ~6 MB hero set blocking the loader | §0 rule 1 is broken. The zero-install advantage is the product's best feature and this trades it in a dimension nobody was watching. `main.js:723`'s 20 s safety net means the failure is invisible until it is severe. |
| **K4** | Texture VRAM **> 300 MiB** on the BC path with the override in, **or** any tab OOM on a 4 GB-VRAM machine | VRAM is the constraint the audit omitted; if it does not fit, the library must shrink below the point where it reads as ETS2-adjacent. |
| **K5** | After Tier 1 (engineering only, zero art), blind screenshot comparison against the v1 baseline shows **no perceived improvement** | The model is wrong in both directions — it is neither the art nor these fixes — and no amount of texture work will land. |
| **K6** | **Task #39 does not close in ≤ 5 days** and worst-frame `other` stays above 15 ms | No fidelity work is worth doing on a pipeline that drops 25 ms during stream-in, and `adaptiveResolution` will read those stalls as GPU load and blur away exactly what was paid for. |
| **K7** | Any device in the **top 3 of the Cloudflare analytics OS/browser split** cannot hold 30 fps on the corridor with the mobile tier enabled | §0 rule 5 is broken and there is no quality-tier system to fall back to. |

**The steelman does not win overall** — the audit's core empirical claim survived cross-examination (this really is an asset gap; the lighting and atmosphere work really is the good part), the measured headroom is *better* than either the audit or the perf report believed, and the art library is engine-portable, so the expensive half is not at risk under any outcome. **But it wins on sequencing**, and that is what this plan implements.

---

## 8. Do this first

**Tomorrow morning, before sourcing a single asset: run the production-build measurement pass. One afternoon.**

```bash
# 1. Pin three exactly (0.1 days, do it first — four plan items depend on r183 internals)
#    frontend/package.json:22  "three": "^0.183.1"  →  "three": "0.183.1"

cd /Users/apple/Desktop/delhi-drive/frontend
npm run build && npm run preview
```

Then drive the Gran Via corridor with `● REC PERF` recording and capture, in one session:

1. **Four regimes** — day/night × stationary/80 km/h — logging `gpuMs`, `renderer.info.render.calls`, `triangles`, `programs.length`, `usedJSHeapSize`, and the cpuTimer sections.
2. **The shadow pass**, bracketed with the existing gpuTimer around `renderer.shadowMap` — the ~1.2-1.5 ms that three separate reports spent and none measured.
3. **RadialBlurPass A/B at 90 km/h** — the pass nominated "biggest single post-chain cut" that appears in zero measurements because `main.js:1002` disabled it in every reading.
4. **The tree A/B** — point the pool at `frontend/public/textures/trees/tree_04.obj` (115 tris, cards, with `summer_trees_0.webp` alpha atlas and `summer_trees_0_n.webp` normal, all already on disk) and read the GPU delta day **and** night. This is the go/no-go on the entire foliage pipeline and it costs an hour.
5. **Time-to-drive**, median of 5 cold loads with cache disabled.
6. **The Cloudflare analytics OS split** — log in, read it, write down ETC2 or BC7 as the VRAM target.

That converts the six most consequential unmeasured numbers in this synthesis — the shadow pass, radial blur, canopy overdraw, night at speed, production-vs-dev CPU, and time-to-drive — into measurements, using instruments already wired into the app (`main.js:150` gpuTimer, `main.js:1016-1032` perfLogger).

**Do not source asset #1 until §5 item 0.9 is written down: stylized-PBR, not photoscan.** That choice is free today and unrecoverable after 100 assets.