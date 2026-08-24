# Delhi Drive — Claude Context Index

> **DANGER — READ FIRST:**
> `worldGroup.scale.x = -1` mirrors the entire scene on the X axis.
> Physics coordinates negate X: `px = -(worldX - originX)`.
> Every renderer↔physics boundary must apply this negation. Getting it wrong silently
> misplaces geometry or breaks collisions with no error. See [coordinate-systems.md](docs/context/coordinate-systems.md).

---

## Project Description

Barcelona Drive is a browser-based open-world 3D driving simulator built on real OpenStreetMap data for the city of Barcelona (migrated from Delhi, May 2026). The frontend is a vanilla-JS Three.js application (no framework) with cannon-es physics, streamed across 500 m × 500 m slippy tiles at zoom 16. All map data is pre-baked offline from an OSM PBF file + Copernicus GLO-30 DEM GeoTIFF into a compact binary format (v7) and served by a trivial Express static-file server. The physics runs `CANNON.RaycastVehicle` on the main thread alongside the render loop; heavy geometry work (buildings, vegetation, grass) is offloaded to a pool of 2–4 Web Workers. Old Delhi tiles remain in `backend/tiles/delhi/` as a fallback.

---

## Golden Rules

Follow these in every session, every task.

1. **Read before touching.** At the start of any task, read this file and the relevant `/docs/context/` file(s) before writing or changing any code.
2. **Auto-update policy (pragmatic).** When a change is structural or architectural — new subsystem, changed data flow, new CONFIG flag, changed invariant, new dependency — update the relevant doc(s) **in the same turn** as the code change. For trivial changes (small bug fixes, tuning constants, copy tweaks that don't change architecture), append a one-line entry to `changelog.md` instead. Never leave docs stale on a structural change.
3. **Never violate a documented invariant in `gotchas.md`.** If a task genuinely requires it, stop and flag it before proceeding.
4. **Never silently "fix" anything in `decisions.md`.** Those are intentional tradeoffs. Flag the conflict and ask.
5. **Warn before re-baking tiles.** It is expensive, takes minutes per region, and changing the bake pipeline can invalidate `BAKED_ROAD_ELEVATION_IS_RAW` and break the running game.
6. **Keep docs focused.** If a doc grows too large, split it and update the TOC entry here.
7. **When adding a doc, add it to the TOC below** with a one-line description.

---

## Quick-Start Commands

```bash
# Backend tile server (port 4041) — already running in background
cd backend && npm start

# Frontend dev server (port 4040 — CORS hardcoded to this port in server.js)
cd frontend && npm run dev

# Re-bake the full Barcelona region (slow, ~10-30 min)
cd backend && npm run build:region

# Fast test bakes (need PBF + DEM in data/regions/barcelona/)
cd backend && node worldBuilder/buildRegion.js --area eixample    # ~20 tiles, Eixample
cd backend && node worldBuilder/buildRegion.js --area montjuic    # port + Montjuïc elevation

# Single-tile dry-run (prints v7 feature counts, writes one tile)
BAKE_SINGLE_TILE=16_33143_24488 node worldBuilder/buildRegion.js --area eixample
```

## Current Dev State (as of 2026-05-29)
- **Region**: Barcelona (Delhi tiles preserved as fallback)
- **Spawn**: Sant Gervasi / Ronda de Dalt trench portal — `spawnConfig.js` DEFAULT_SPAWN `{lat:41.4098, lon:2.1257}` (tile 16_33154_24471). Set for the Phase 3 slice-② authored-trench drive check. Previous spawns (Montjuïc slope, Gran Via tunnel) noted in spawnConfig.js.
- **Mode**: default `ENABLE_CAR: false` (fly/free camera). **Override per-load via URL** — see toggles below.
- **Fog**: ON — `ENABLE_FOG: true` (the pre-ship re-enable already happened)
- **Tile format**: v9 — v7 (10 feature types) + v8 (baked sidewalks, path clipping) + v9 (baked sky-visibility AO grid; strength dials in `frontend/src/map/aoSampler.js`)
- **Ocean**: No global plane — water renders via per-polygon OSM water meshes only (ocean plane reverted)
- **Unit model**: Unstretch-X COMPLETE (Stage 1) — 1 world unit = 1 real metre on all axes (ADR D-11). Any elevation/coord/scale change is atomic: code + full re-bake + browser cache flush (see vertical-model-foundation-spec §6).

### URL toggles (read once at page load; change URL + reload to switch)
- **Mode**: `?mode=car` (drive) / `?mode=fly` (free camera). Shorthand: `?car` / `?fly`. No param → `CONFIG.ENABLE_CAR`. Wired in `main.js` (resolves `ENABLE_CAR` from URL).
- **Tunnel debug overlay**: `?debug=tunnel` — physics-collider wireframes, tile-seam markers, per-body Y labels (`tunnelDebugOverlay.js`). Off by default, zero cost when absent.
- Combine freely, e.g. `http://localhost:4040/?mode=car&debug=tunnel`.
- **Re-bake cache note**: after any re-bake, run `window._clearTileCache()` in the console + hard-reload, or the browser serves stale (pre-rebake) tiles.

> **Port note:** The backend hardcodes `Access-Control-Allow-Origin: http://localhost:4040`.
> The frontend Vite config must serve on 4040 or CORS will block all tile fetches.
> If you need to change the port, update both `backend/server.js` and the Vite config.

---

## Table of Contents

| File | What it covers |
|---|---|
| [architecture.md](docs/context/architecture.md) | Full stack, dependencies, scene graph, game loop, init sequence, worker model, ASCII diagram |
| [coordinate-systems.md](docs/context/coordinate-systems.md) | Mercator ↔ world ↔ physics conversions, X-mirror, origin offset, elevation offset, naming pitfalls |
| [map-system.md](docs/context/map-system.md) | Tile format (binary v7), loading flow, 4-phase build, LOD, streaming, collision stack |
| [vehicle-system.md](docs/context/vehicle-system.md) | Physics model, all parameters, transmission, forces, input, camera, CONFIG shadowing bug |
| [rendering.md](docs/context/rendering.md) | Materials, post-processing chain, shadows, geometry merging, frame-budget yielding |
| [bake-pipeline.md](docs/context/bake-pipeline.md) | OSM PBF → binary v7 pipeline, re-bake steps, what a re-bake invalidates, elevation convention |
| [config-reference.md](docs/context/config-reference.md) | Every CONFIG flag: default, wired/dead, what breaks if wrong |
| [gotchas.md](docs/context/gotchas.md) | All invariants and landmines; what breaks if ignored |
| [decisions.md](docs/context/decisions.md) | ADR-style decision log — WHY intentional tradeoffs were made |
| [glossary.md](docs/context/glossary.md) | Confusing terms, naming pitfalls, what identifiers actually mean |
| [spawn-system.md](docs/context/spawn-system.md) | Spawn config refactor, how to change spawn, future UI integration point |
| [roadmap.md](docs/context/roadmap.md) | Deferred features backlog — what's NOT in v7 tiles yet and why |
| [perf-audit.md](docs/context/perf-audit.md) | Multi-agent performance optimization audit — 35 ranked findings, 6-phase fix plan, verdict on per-building viewport culling. Read before perf work |
| [changelog.md](docs/context/changelog.md) | Running log of changes; append here for every session |
| [barcelona-road-system.md](docs/context/barcelona-road-system.md) | Barcelona road overhaul design — phased roadmap, Norma 8.2-IC target, current baseline |
| [tunnel-fix-playbook.md](docs/context/tunnel-fix-playbook.md) | Tunnel subsystem fix playbook — 8-subsystem contract model (C1–C7), symptom→cause map, dependency-ordered fix phases, Findings Report format |
| [rapier-physics.md](docs/context/rapier-physics.md) | Rapier (WASM) physics — the DEFAULT engine (`?physics=cannon` escape hatch); cannon-compatible car, per-shape streaming collider mirror, runtime-probed heightfield terrain, collision-sound EventQueue |
| [visual-target-analysis.md](docs/context/visual-target-analysis.md) | Why the game doesn't look like offline cinematic renders — gap decomposition (GI/atmosphere/content/materials), honest browser limits, and the prioritized L1–L5 roadmap (bake-side AO is the key unlock) |
| [vertical-model-foundation-spec.md](docs/context/vertical-model-foundation-spec.md) | LOCKED design for the vertical-model rebuild — Unstretch-X unit invariant (1 unit = 1 real metre on all axes), 3 staged gates (unit-fix → DEM-on → runtime Y cleanup), the purge test, and the drivable-surface-implies-floor assert. Governs all elevation/scale work; tunnel fall-through dissolves here |
| [terrain-tunnel-rework-plan.md](docs/context/terrain-tunnel-rework-plan.md) | ACTIVE working tracker for the terrain & tunnel rework — 5 phases (survey → smoothing at source → re-validate → authored tunnels → polish), each gated by an on-screen drive test. Source of truth for rework scope/status |
| [authored-tunnels-design.md](docs/context/authored-tunnels-design.md) | Phase 3 authored-tunnel design — open-cut trenches authored INTO the elevation grid vs covered sections with slab floors under untouched grid, the commit-blocking drivable-surface-implies-floor validator, portal-face cliff handling, 5 implementation slices |
| [bake-surface-clipping.md](docs/context/bake-surface-clipping.md) | Bake-level ground-surface de-overlap — Phase 1 clips path-family polylines out of carriageway coverage (no format bump, crossing exception); Phase 2 bakes sidewalk polygons (v8). Fixes co-planar road/footpath stacking at the source |
| [ets2-target-audit.md](docs/context/ets2-target-audit.md) | **v2 target audit** — can a browser build reach an ETS2-adjacent look? Verdict: yes to ~65-75%, and the gap is an ASSET gap not a tech gap (zero env normal maps, 172/218 materials diffuse-only, 20-tri tree blobs). Binding browser-only constraints, free+AI asset strategy, texture budget maths, 4-tier roadmap, one-block go/no-go slice. Read before any v2 visual work |
| [v2-plan-hardened.md](docs/context/v2-plan-hardened.md) | **THE v2 PLAN — read before ets2-target-audit.md, it wins where they disagree.** 12-agent adversarial output: verdict 65% day / 50% night, engineering-first ordering, MeshStandard dropped (Lambert+IBL instead), SSAO rejected for baked-AO extension, real budget table, Tier 0-3 with per-item files/days/risk, an 11-threshold corridor gate, K1-K7 kill criteria |

---

## Domain-Specific Docs

For any **v2 / visual-upgrade / asset-pipeline** work, read [docs/context/v2-plan-hardened.md](docs/context/v2-plan-hardened.md) FIRST — it is the executable plan and supersedes the audit's numbers. Then [ets2-target-audit.md](docs/context/ets2-target-audit.md) for the §0 binding constraints (browser-only, ≤24 MB art budget, ≤200 MiB texture VRAM, no 4K, atlas+instance everything) and the free CC0+AI asset strategy. **Engineering lands before art** — Tier 0/1 make the art visible and the measurements honest; art on top of the current per-tile LOD is invisible.

For road system work, read [docs/context/barcelona-road-system.md](docs/context/barcelona-road-system.md) before starting.

For tunnel work, read [docs/context/tunnel-fix-playbook.md](docs/context/tunnel-fix-playbook.md) before starting. Diagnose before changing — produce the Findings Report first.

For any elevation, terrain, DEM, unit-scale, or grade work, read [docs/context/vertical-model-foundation-spec.md](docs/context/vertical-model-foundation-spec.md) FIRST — it is the LOCKED foundation design (Unstretch-X; staged unit-fix → DEM-on → runtime Y cleanup). It supersedes the flat-world coordinate assumptions in the tunnel playbook. Do not start a later stage before the prior stage's gate passes.

---

## Key File Locations (the 5 you touch most)

| File | Role |
|---|---|
| `frontend/src/main.js` | Game loop, init sequence, spawn logic, all subsystem wiring |
| `frontend/src/map/tileManager.js` | Tile streaming, 4-phase build, physics colliders, LOD (2346 lines) |
| `frontend/src/car/carPhysics.js` | All vehicle physics — forces, transmission, drift, stability |
| `frontend/src/config.js` | Feature toggles and tuning constants (read before changing anything) |
| `backend/worldBuilder/buildRegion.js` | Tile baking pipeline — any map change requires a re-bake |
