# Performance Optimization Audit — Barcelona Drive

> Read-only multi-agent audit (8 subsystem readers → 8 adversarial verifiers → synthesis).
> Baseline at time of audit: **~790 draws, ~4M triangles, 25 tiles, ~128k trees, ~1.14 GB heap, GPU-bound.**
> (This is AFTER removing GTAO+Bokeh, which had tripled triangles to ~10M.)
> Goal: raise FPS / cut triangles·draws·memory **without visibly hurting** the flat-shaded low-poly look.

## Executive summary

The frame is GPU-bound. The two dominant triangle populations are **trees** (~128k trees, 36-tri
dodecahedron foliage) and **terrain** (128×128 DEM ≈ 32k tris/tile × 25). The single biggest lever is
that the live tree BatchedMesh **casts real shadow-map shadows** — a one-line disable that pulls the whole
near-field tree population out of the directional shadow depth pass (blob shadows already ground them).
After that, a cluster of trivial zero-risk one-liners (dead balcony-detail LOD that never culls, a ground
LOD multiplier floored at 1.25 instead of 1.0, DoubleSide defeating backface culling), then low-poly
geometry swaps and building draw-call consolidation. Terrain grid reduction and an outer-ring memory tier
are the largest wins but need a re-bake and/or carry quality risk, so they're gated last.

## Verdict on "render only the viewport-visible part of each building"

**Reject the literal idea — it can't work and would backfire. Pursue the alternatives instead.**

- **Per-building frustum culling doesn't exist today**, but not for lack of a flag: the worker merges all
  buildings in a tile into a few per-material meshes (`buildingWorker.js:1691`), each `frustumCulled=true`
  but with a merged AABB spanning the whole 500 m tile — so it almost never culls.
- **"Render only the visible PART of a building" is not possible cheaply in vanilla Three.js / WebGL2.**
  There's no CPU-controlled per-primitive culling short of a custom `discard` shader — which still runs the
  vertex stage and pays fragment cost. The fixed-function pipeline already does whole-draw frustum reject +
  per-triangle backface/clip.
- **Un-merging to one mesh per building** (so each can frustum-cull) would explode draws from ~790 toward
  thousands — exactly wrong for a GPU-bound, low-draw scene.

**What actually helps** (and is the real answer to your instinct): (a) restore the already-coded-but-dead
per-building *detail* distance cull; (b) real per-tile distance LOD swapping full facades for the cheap AABB
LOD boxes already built but never shown; (c) decimate the true triangle sinks (12-tri balcony bars → 2-tri
quads, 36→20-tri foliage); (d) BackSide instead of DoubleSide to halve building fragment shading.

## Phased fix plan (each phase gated on re-measuring FPS/tris/draws/heap)

### Phase 0 — Zero-quality-risk one-liners  *(do first)*
- Tree BatchedMesh `castShadow=false` — `meshMaterializer.js:927` **[biggest single win]**
- Restore balcony/detail 120 m cull: set `isBuildingDetail=true` on detail meshes in the worker path (`meshMaterializer.js` materializeGroup ~744) so the existing `tileManager.js:2692` cull fires
- Ground LOD multiplier floor `1.25→1.0` — `tileManager.js:2543`
- Terrain `DoubleSide→FrontSide` — `terrainRenderer.js:562`
- Parked-car InstancedMesh `castShadow=false` — `parkedCars.js:71`
- `antialias:false` (composer targets are non-MSAA) — `scene.js:475`
- Night sky objects (moon/glow/stars) toggle `.visible` not opacity — `scene.js:307,375`
- Sky dome detail `4→2` — `scene.js:495`; drop dead terrain `uv` attribute — `terrainRenderer.js:183,350`
- `physActive` radius `200→~120` — `tileManager.js:2761`

### Phase 1 — Low-poly geometry decimation
- Foliage `DodecahedronGeometry`(36 tris) → `IcosahedronGeometry(r,0)`(20 tris); trunk heightSegments 2→1 — `vegetationRenderer.js:110`
- Env-cluster rocks Icosahedron detail 1→0 (80→20 tris) + `frustumCulled=true` — `environmentClusterRenderer.js`
- Building materials `DoubleSide→BackSide` (⚠ verify not inside-out — `worldGroup.scale.x=-1` flips winding) — `meshMaterializer.js:589..648`

### Phase 2 — Building draw-call + triangle consolidation
- Balcony railings: 12-tri box per bar → 2-tri quad/striped panel (up to ~60k tris/tile) — `buildingWorker.js:1018`
- Facade/roof: drop hex from material key, rely on existing vertex-color tint (~10-20 fewer draws/tile) — `buildingWorker.js:285,291`
- Bucket ~14 detail materials into ~3

### Phase 3 — Traffic, pedestrians, post
- Traffic head/tail lights → 2 shared InstancedMeshes (parkedCars pattern) — `carModels.js:112`
- Traffic bodies → InstancedMesh + setColorAt instead of per-car Mesh + `material.clone()` — `trafficSystem.js:165`
- Pedestrian FRAMES 8→4 — `pedestrians.js:23`
- UnrealBloom disabled in daylight and/or nMips 5→3 — `main.js` setBloom

### Phase 4 — Terrain shader + memory tiering (no re-bake)
- Terrain fragment shader 5 noise layers → 2-3 (or bake to detail texture) — `terrainRenderer.js:572`
- Terrain per-tile CPU vertex-color pass → 1 layer or bake offline (keep road/tree/water cues) — `terrainRenderer.js:443`
- Per-distance detail tier: fogged outer-ring tiles skip detail meshes + colliders — `tileManager.js` processTileData
- Spatially batch building colliders; finite heightfield AABBs and/or SAPBroadphase — `tileManager.js:348`, `scene.js:607`

### Phase 5 — Re-bake-gated terrain grid reduction (last, highest risk)
- Re-bake terrain GRID_SIZE 64 + `TERRAIN_MAX_GRID` 64 (~quarters terrain tris ≈ -600k) — ⚠ road-conformance risk, per CLAUDE.md golden rule 5. Consider a runtime coarse-grid swap for far tiles instead.

## Full ranked findings (35)

| # | Finding | Subsystem | Impact | Effort | Qual risk |
|---|---------|-----------|--------|--------|-----------|
| 1 | Tree BatchedMesh casts real shadows (redundant w/ blob) | Trees | high | trivial | none |
| 2 | Balcony/detail LOD dead — details render to 180 m | Buildings | high | trivial | none |
| 3 | Ground LOD multiplier floored 1.25 not 1.0 | Tiles | medium | trivial | none |
| 4 | Terrain DoubleSide disables backface cull | Terrain | low | trivial | low |
| 5 | Foliage 36-tri dodecahedra (comment claims 20) | Trees | high | small | low |
| 6 | Building materials DoubleSide on closed prisms | Buildings | high | small | medium |
| 7 | Parked-car InstancedMeshes cast shadows | Entities | medium | trivial | low |
| 8 | Balcony railing = 12-tri box per 4 cm bar | Buildings | high | medium | low |
| 9 | Facade/roof split per palette hex (redundant, vertex-colored) | Buildings | high | medium | none |
| 10 | Traffic lights = 4 child Meshes/car (~112 draws) | Entities | high | medium | none |
| 11 | UnrealBloom full 12-subpass in daylight | Rendering | medium | small | low |
| 12 | Streetlights 6-9 InstancedMeshes/tile; road markings unmerged | Tiles | medium | medium | medium |
| 13 | Terrain shader 5 fractal-noise layers/fragment | Terrain | high | medium | medium |
| 14 | Traffic bodies = 28 non-instanced Mesh clones | Entities | medium | large | low |
| 15 | All 25 tiles keep full geometry+colliders (no outer tier) | Tiles | high | large | medium |
| 16 | Terrain full 128×128 grid, no LOD (re-bake) | Terrain | high | large | high |
| 17 | CPU vertex-color noise pass on every tile, ~75% overwritten | Terrain | medium | medium | low |
| 18 | Building colliders batched in array order → huge AABBs | Physics | medium | medium | low |
| 19 | NaiveBroadphase O(n²) + infinite heightfield AABBs | Physics | medium | medium | low |
| 20 | Redundant tree blob-shadow overdraw (pairs with #1) | Trees | medium | small | low |
| 21 | Pedestrian flipbook ~50 InstancedMeshes (FRAMES=8) | Entities | low | small | low |
| 22 | Env clusters 80-tri rocks, frustumCulled=false | Trees | low | small | low |
| 23 | antialias:true wasted (non-MSAA composer targets) | Rendering | low | trivial | none |
| 24 | Night sky objects drawn at opacity 0 in daylight | Rendering | low | trivial | none |
| 25 | Sky dome detail 4 (~5,120 tris) for per-fragment gradient | Rendering | low | trivial | none |
| 26 | physActive body radius 200 m larger than needed | Physics | low | trivial | low |
| 27 | LOD building boxes retained though full detail loads | Tiles | low | small | none |
| 28 | Dead 'uv' attribute uploaded per tile (keep normals!) | Terrain | low | small | none |
| 29 | Billboard impostors built eagerly per tile | Trees | low | medium | none |
| 30 | Tree billboard matrices decomposed on main thread | Workers | medium | medium | none |
| 31 | ColorGrade + Output = 2 passes, foldable into 1 | Rendering | low | medium | none |
| 32 | Concave-building walls: many thin boxes, no collinear merge | Physics | low | medium | low |
| 33 | Full 128×128 physics heightfields + pillar cache/tile | Physics | low | medium | medium |
| 34 | mallBillboard material recreated uncached per group | Workers | low | trivial | none |
| 35 | Tree wind per-frame full-vertex shader, no distance falloff | Trees | low | small | low |

*Findings dropped by adversarial verification (already implemented / not real) are not listed — e.g. some
frustumCulled flags and instancing were already in place.*
