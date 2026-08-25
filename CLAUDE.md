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

# Frontend dev server (port 4040 — in the backend CORS allowlist)
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
- **Spawn**: **Gran Via at Plaça Universitat — dense Eixample** — `spawnConfig.js` DEFAULT_SPAWN `{lat:41.3866, lon:2.1640}`. Deliberately the same place as the v3 performance benchmark (P0-05) and the start of `bench/benchRoute.js`: the densest thing the renderer has to survive. **Frame lag is a p95 problem and p95 lives here** — measuring stream-in anywhere quieter measures the wrong thing.
- **Mode**: default `ENABLE_CAR: false` (fly/free camera). **Override per-load via URL** — see toggles below.
- **Fog**: ON — `ENABLE_FOG: true` (the pre-ship re-enable already happened)
- **Tile format**: v9 — v7 (10 feature types) + v8 (baked sidewalks, path clipping) + v9 (baked sky-visibility AO grid; strength dials in `frontend/src/map/aoSampler.js`)
- **Ocean**: No global plane — water renders via per-polygon OSM water meshes only (ocean plane reverted)
- **Unit model**: Unstretch-X COMPLETE (Stage 1) — 1 world unit = 1 real metre on all axes (ADR D-11). Any elevation/coord/scale change is atomic: code + full re-bake + browser cache flush (see vertical-model-foundation-spec §6).

### URL toggles (read once at page load; change URL + reload to switch)
- **Mode**: `?mode=car` (drive) / `?mode=fly` (free camera). Shorthand: `?car` / `?fly`. No param → `CONFIG.ENABLE_CAR`. Wired in `main.js` (resolves `ENABLE_CAR` from URL).
- **Street lighting**: ON by default (v3 P2-04, shipped 2026-08-25). `?nolightgrid` kills it — but P2-06 deleted the fake-night stack in exchange, so with it off the city has NO street lighting; "off" is the broken state, not the safe one. `?lightgrid=ab` runs the 40 s A/B harness, which flips the grid every 2.5 s and visibly strobes the whole scene (do not leave it on).
- **Asphalt v2 (v3 P3-07)**: ON by default. `?roadv2=0` disables it — an ATTRIBUTION switch, not a preference: roads have the largest screen coverage in the game and sit on a MeshStandardMaterial, so per-fragment work here is felt. Drive the same street both ways to answer a frame-cost question instead of arguing it.
- **Facade array (v3 P3-04)**: `?facadearray=1` — array-texture facade path with PLACEHOLDER layers (plain by design; they prove the shader path before P3-05's art). Default off.
- **Adaptive resolution**: ON by default. `?adaptres=0` pins resolution and disables the controller — an ATTRIBUTION switch, since its own resizes cost **70-144 ms each** and it is therefore a suspect in any stutter report.
- **Boot chatter**: `?debug=init` — `[assets] registry`, `[census]`, `[lightgrid] armed`. Off by default. NOT gated (deliberately): `[perf] time-to-drive … shader programs` (a v3 gate metric), `[quality] tier`, and anything reporting a failure.
- **Console noise, both opt-in**: `?debug=loaf` (per-frame Long-Animation-Frame attribution; the STATS `loaf …` aggregate works without it) · `?debug=winding` (per-tile ring-reversal report).
- **Road-vs-terrain fit probe**: `?debug=roadfit` — measures drawn road against drawn terrain, prints a burial distribution + slope correlation + worst points with coordinates. Measurement only (renders nothing). Fires 6 s after drive start; re-run from the console with `window._ddRoadFit()`, results on `window._ddRoadFitResult`.
- **Tunnel debug overlay**: `?debug=tunnel` — physics-collider wireframes, tile-seam markers, per-body Y labels (`tunnelDebugOverlay.js`). Off by default, zero cost when absent.
- Combine freely, e.g. `http://localhost:4040/?mode=car&debug=tunnel`.
- **Re-bake cache note**: after any re-bake, run `window._clearTileCache()` in the console + hard-reload, or the browser serves stale (pre-rebake) tiles.

> **Port note:** The backend answers CORS from an allowlist — `ALLOWED_ORIGINS` in `backend/server.js`,
> defaulting to `http://localhost:4040` (`npm run dev`) **and** `http://localhost:4044` (`npm run preview`,
> the production build used for perf drives). Serve the frontend on any other port and every tile fetch is
> blocked by CORS — which surfaces as `Failed to fetch` / `net::ERR_FAILED`, not as an obvious CORS error.
> To add a port, extend the default list or set `ALLOWED_ORIGINS=` (comma-separated) when starting the backend.

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
| [v3-brief.md](docs/context/v3-brief.md) | **v3 INTENT** — the ETS2 calibration ("not too good but definitely better than what we have" = both ceiling and floor), the no-slacking rule, full named scope, binding constraints |
| [v3-master-plan.md](docs/context/v3-master-plan.md) | **★ THE v3 PLAN — READ FIRST FOR ANY v3 WORK.** 17-agent output. 12 verdicts (103 rebuild days), art bible, a budget that FITS (13.75/15.0 ms night, 159/200 MiB), phases P0-P4, 12 subsystem playbooks, night light-grid design, progression map, HUD plan, gates + kill criteria. **MINIMUM SHIPPABLE = end of P3, 74 days** |
| [v3-execution-tracker.md](docs/context/v3-execution-tracker.md) | **★ THE STATE — open this FIRST in any v3 session.** 79 tasks across P0-P4 with status, files, deps and per-task done-when; RESUME HERE block; performance ledger; 9 standing hazards; phase gate matrix; session protocol; decision log; cut list. The plan is the SPEC, this is the STATE |
| [v3-art-bible.md](docs/context/v3-art-bible.md) | Unabridged art-direction ruling — Barcelona palette, texel-density table, 6 bans, normalize procedure, acceptance checklist (reproduced in master plan §2) |
| [v3-rebuild-budget-ruling.md](docs/context/v3-rebuild-budget-ruling.md) | Unabridged rebuild + budget judge output — binding verdicts, savings ledger, double-count strikes (summarised in master plan §1 and §3) |
| [osm-repair-layer.md](docs/context/osm-repair-layer.md) | **DESIGN (not started)** — the OSM/DEM defect-repair layer: why the capability already half-exists and is DROP-biased and terrain-blind, the patch-file-as-data decision that keeps bakes reproducible, the defect taxonomy, and phases P-R1..P-R6. Read before touching OsmDataFixer / wayStitcher / RampResolver |
| [v3-audits/](docs/context/v3-audits/) | The 12 raw subsystem audits, one file each, with the budget-ask index |

---

## Domain-Specific Docs

**v3 IS THE ACTIVE PLAN.** For ANY visual / asset / subsystem work: open [docs/context/v3-execution-tracker.md](docs/context/v3-execution-tracker.md) FIRST — it says what is done and what is next — then [v3-master-plan.md](docs/context/v3-master-plan.md) for the full spec of that task, and [v3-brief.md](docs/context/v3-brief.md) for intent. **Tracker = state. Plan = spec. Never duplicate one into the other.** v3 supersedes v2 wherever they differ — notably: the frame is measured at **13.3 ms night**, not zero, so budget in NET MARGINAL deltas; resident tiles are **9-18**, not 25; and five census figures were corrected (14,542 shops / 4,225 signals / 42,876 named roads are parsed and DISCARDED today).

For historical v2 context, read [docs/context/v2-plan-hardened.md](docs/context/v2-plan-hardened.md) — it is the executable plan and supersedes the audit's numbers. Then [ets2-target-audit.md](docs/context/ets2-target-audit.md) for the §0 binding constraints (browser-only, ≤24 MB art budget, ≤200 MiB texture VRAM, no 4K, atlas+instance everything) and the free CC0+AI asset strategy. **Engineering lands before art** — Tier 0/1 make the art visible and the measurements honest; art on top of the current per-tile LOD is invisible.

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
