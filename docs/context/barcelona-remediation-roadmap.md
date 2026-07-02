# Barcelona Remediation Roadmap

**Status:** Active reference. Read this before any Phase A/B/C fix session.
**Created:** 2026-05-30
**Based on:** Three audits completed 2026-05-30: OSM Pipeline Audit, Scale Audit, Performance/Visual Quality Audit.
**Owner:** Anmol (creative direction) + Claude Code (implementation)
**Companion docs:** `barcelona-road-system.md`, `gotchas.md`, `architecture.md`

---

## Section 1: Executive Summary

### Flaw 1 — Mercator XZ-vs-Y Scale Mismatch (Severity: HIGH)

The game's coordinate system has two incompatible unit scales: the XZ plane uses Web Mercator world coordinates where **1.3321 world units = 1 real meter** at Barcelona's latitude (41.35°), while the Y axis uses raw DEM meters where **1 world unit = 1 real meter exactly**. Every manually-authored perpendicular dimension in the codebase — road widths, sidewalk widths, car physics box, BCN_DIMS constants, tree geometry — is written as if 1 world unit = 1 meter, but actually renders 25% too narrow in XZ. The car's physics box is 0.40m tall (Y, correct-ish) but only 1.05m wide and 2.33m long (XZ, catastrophically wrong). A 5m sidewalk constant renders as 3.75m. This is not noticed immediately because the entire world shares the same distortion, but it makes every close-up comparison (car in a lane, person next to a building) feel miniaturized. The root cause is that `latLonToMercator` correctly produces Mercator meters — the bug is that the codebase then treats those Mercator meters as equal to real meters in perpendicular calculations, which they are not at non-equatorial latitudes. A secondary symptom: `buildingRenderer.js:215` hardcodes `MERCATOR_SCALE = cos(28.5°)` (Delhi latitude, 0.879) instead of Barcelona's `cos(41.35°) = 0.751`, making building facade texture UV tiling wrong by 17%.

### Flaw 2 — Cross-Tile Blindness (Severity: MEDIUM)

The bake pipeline processes one tile at a time with no awareness of adjacent tiles. Features that physically span tile boundaries — long tunnels like Ronda Litoral (~500m), wide boulevards at tile edges, junction chamfers at tile corners — cannot be handled correctly by either the baker or the runtime renderer under the current architecture. This was the root cause of months of tunnel terrain-cut failures: the Ronda Litoral's portal endpoints sit at tile boundaries, so the approach corridor cut is generated 80m in the wrong direction (into the tile with no approach terrain, not the adjacent tile that contains the approach road). The fix requires a region-level pre-pass that identifies cross-tile features before per-tile baking begins, emitting cross-tile metadata that individual tile bakers can then consume. Until Phase B is implemented, tunnel terrain cuts will remain approximate.

### Flaw 3 — Visual Cohesion Missing (Severity: MEDIUM)

The sky, ambient light, fog, and car paint reflection are four completely independent systems with no connection to each other. The sky is a static GLSL gradient with fixed `#BFD7EE` horizon — it never changes with time of day. The ambient light is hardcoded to `0xffe8c8` warm amber regardless of sky state. The fog is disabled by default. The car's `PMREMGenerator` environment sphere is a solid grey hemisphere, not the actual sky. The result is a world that looks assembled rather than rendered — objects inhabit the same space but don't belong to the same light environment. Compounding this: 6 building fields (`b.colour`, `b.material`, `b.roofShape`, `b.roofColour`, `b.roofMaterial`, `b.roofHeight`) survive the entire 4-stage OSM→bake→tile→runtime pipeline and appear in every parsed building object but are **never read by `buildingRenderer.js`**. They are ghost fields: real data that produces zero visual effect. Activating them alone — routing OSM building colours and material names into the facade shader — would produce Barcelona's characteristic mix of ochre, white, and grey facades at zero additional pipeline cost.

---

## Section 2: Audit Findings — Consolidated

### 2.1 OSM Pipeline Audit

**Finding 1 — Dead building fields travel full pipeline but never render**
`convertToBinary.js:210-215` writes `b.colour`, `b.material`, `b.roofMaterial`, `b.roofColour`, `b.roofShape`, `b.minHeight`, `b.roofHeight` to tile binary. `tileParserWorker.js:284-289` reads them back. Every parsed building object has these fields. `buildingRenderer.js` reads none of them — only `b.height`, `b.type`, `b.footprint`, `b.name`. The building normalization (`buildingNormalize.js:120-125`) correctly extracts: `building:colour → colour`, `building:material → material`, `roof:shape → roofShape`, `roof:colour → roofColour`, `roof:material → roofMaterial`. **Severity: HIGH** for opportunity cost — OSM Barcelona has reasonable `building:colour` coverage, activating it costs zero pipeline changes.

**Finding 2 — Cross-tile blindness causes tunnel terrain cut failures**
`terrainBaker.js` runs per-tile with only that tile's tunnel roads. For long tunnels (Ronda Litoral: 11 segments across tile 33164/24480, all endpoints at tile boundaries), the synthetic portal corridors extend 80m outward from boundary points → entirely outside the tile's terrain grid → zero triangles cut. Confirmed: tile 33159/24472 cuts 470 triangles (portal endpoints inside grid); tile 33164/24480 cuts triangles from the underground section rather than the approach zone. **Root cause:** no mechanism for cross-tile feature coordination at bake time. **Severity: HIGH** for tunnel rendering specifically, MEDIUM for overall architecture.

**Finding 3 — Tile format version inconsistency and dead fields**
Backend emits tile version 7 (`convertToBinary.js:119`). Frontend sends `tileVersion: 5` (`mapLoader.js:18`). The JSON fallback path would reject every tile as `bad_version` — it silently works only because binary tiles skip the JSON version check. Additionally, `road.divider` (in binary schema) and `road.lit` (in KEEP_TAGS/schema but never emitted by buildRegion) are phantom fields. **Severity: LOW** operationally but indicates version tracking is not meaningful.

**Why it matters for players:** Players see a city with uniformly grey/beige buildings when real Barcelona has ochre facades (Eixample), white modernist towers (Diagonal), and coloured heritage buildings. The missed opportunity is large because the data already exists.

---

### 2.2 Scale Audit

**Finding 1 — Car is a skateboard (0.40m tall, all axes wrong)**
`carPhysics.js:83`: `CANNON.Box(0.70, 0.20, 1.55)` half-extents → full box 1.40m × 0.40m × 3.10m in world units. Y-axis (height) is 0.40m in real meters — 28% of BMW M3's 1.43m. XZ axes: 1.40wu wide = 1.05m real, 3.10wu long = 2.33m real (XZ uses the 1.3321 Mercator scale, so world units / 1.3321 = real meters). Real BMW M3: 1.90m wide, 4.76m long, 1.43m tall. **Wheel radius** (`carPhysics.js:35`): 0.30m (Y-axis, real meters) — close to 19" wheel's 0.37m (off 19%). **Wheelbase**: connection points at z=±1.2wu → 2.40wu / 1.3321 = 1.80m real vs M3's 2.86m. Every comparison in the game is distorted: streetlights (8m) tower over the car (0.40m) at a 20:1 ratio; real ratio is 5.6:1. **Severity: HIGH** — the car is the primary interactive object.

**Finding 2 — Default building height 9m vs real Eixample 21m**
`buildingNormalize.js:8`: `DEFAULT_HEIGHT_M = 9`. `buildingNormalize.js:112`: levels fallback = `levels × 3.0m` (real floor-to-floor: 3.5m, off 14%). For buildings without OSM tags (roughly half of all buildings in any tile), the game renders 3-story structures where Barcelona has 6-story buildings. The 9m default building next to a 7.51m-real-wide rendered road (10m OSM tag / 1.3321) gives a 1.2:1 building:road ratio — Eixample's famous near-1:1 canyon effect requires ~2:1 at real scale. **Severity: HIGH** for ambient streetscape character.

**Finding 3 — Terrain grid 14.8m/cell at runtime is coarse**
`config.js:105`: `TERRAIN_MAX_GRID: 32` caps runtime terrain to 32×32 samples over a ~459m tile → **14.8m per cell**. The bake generates 64×64 (7.3m/cell) but the frontend discards it. A road ramp spanning 20m fits in 1-2 terrain cells; sidewalk curbs (0.12m height, 0.30m width) are invisible to the terrain. This is why terrain cuts for tunnels are crude regardless of how well the baking logic works — the grid cannot represent fine approach geometry. **Severity: MEDIUM** — would require changing `TERRAIN_MAX_GRID` from 32 to 64 and verifying performance impact.

**Why it matters for players:** The Mercator XZ mismatch means every manually-specified measurement (BCN_DIMS sidewalk widths, car physics, road width fallbacks, tree geometry) renders 25% narrower than intended. The world feels slightly cramped and the car feels like a toy. Buildings are the most visible symptom: the majority of the city renders at the wrong height.

---

### 2.3 Performance / Visual Quality Audit

**Finding 1 — Triangle count at GPU ceiling, MeshStandardMaterial is the multiplier**
Observed 2.3M–3.7M triangles at 60fps. 3.7M is approaching the integrated GPU ceiling (5M) on a 2020 MacBook Air. The critical compound: most geometry uses `MeshStandardMaterial` (full PBR per-pixel shader), which is ~2× more expensive per fragment than `MeshLambertMaterial`. Files with MeshStandard where Lambert would be visually identical: `grassRenderer.js:66`, `streetlightRenderer.js:139/152/164/228`, `greensRenderer.js:24`, `dividerRenderer.js:46`, `parkingRenderer.js:16/21`, `barrierRenderer.js:92/122/269+`. The road overhaul (Phase 3) correctly moved panot sidewalks to Lambert — that pattern should be completed for all non-reflective static geometry. **Severity: MEDIUM** — game runs at 60fps currently but headroom is shrinking.

**Finding 2 — Sky, ambient, fog, and car reflection have zero cohesion**
`scene.js:484-512`: custom gradient sky shader with static `#BFD7EE` horizon. `scene.js:530`: ambient `0xffe8c8` fixed regardless of sky state. `scene.js:555-557`: `FogExp2(0x9dc2db, 0.007)` exists but `ENABLE_FOG: false`. `carModel.js:91`: `PMREMGenerator` creates a grey hemisphere env map for car paint — not the real sky. The four systems share no state. **Severity: MEDIUM** — this is the single highest-impact low-cost visual fix (see Section 3, Phase A).

**Finding 3 — 6 building OSM fields are pipeline-complete but renderer-dead**
Already documented in §2.1 Finding 1. Additional context from performance audit: the building renderer uses `b.type` (16 categories: residential, commercial, hotel, etc.) to select material palettes with hard-coded colors. OSM `building:colour` and `building:material` are richer and more location-correct. Activating them would also provide a free Barcelona-vs-Delhi visual distinction (Barcelona buildings tend toward ochre/cream/white; Delhi buildings toward the beige/sand palette currently hardcoded). **Severity: MEDIUM** for visual authenticity.

**Why it matters for players:** The game looks hand-assembled rather than rendered. Sky and terrain are mismatched in colour. Buildings are uniform grey-beige when OSM has colour data. Trees don't move when grass does. These are the differences between "tech demo" and "believable city."

---

## Section 3: Phased Remediation Plan

### Phase A — Visual Polish Wins

**Goal:** Achieve a substantially more believable city appearance with low-risk, contained changes. No re-bake required (except where noted). No architectural changes. Each sub-task is independently verifiable.

**Estimated total effort:** 4–7 sessions.

---

#### A1 — Activate Dead Building Fields

**Rationale:** Six fields (`b.colour`, `b.material`, `b.roofShape`, `b.roofColour`, `b.roofMaterial`, `b.roofHeight`) travel the full pipeline (OSM → bake → binary → parsed object) and are currently ignored by `buildingRenderer.js`. Activating them produces richer building visuals at zero pipeline cost.

**Target files:** `frontend/src/map/buildingRenderer.js` (material selection logic), `frontend/src/workers/meshMaterializer.js` (if building materials are there).

**Scope per sub-task:**
- Route `b.colour` into facade `MeshStandardMaterial.color` (parse as hex, fall back to category default)
- Route `b.roofColour` into roof mesh material color
- Route `b.material` → translate material name to roughness/metalness/color overrides (e.g., "glass" → high metalness, "brick" → warm color)
- Route `b.roofShape` → flag for alternative roof mesh selection (if present)
- `b.minHeight` → offset building base upward (podium buildings, arcades)

**Verification:** Drive through Eixample after hard-refresh. Buildings should show visible color variation — some ochre, some white, some grey — rather than uniform beige. Check that the existing type-based material system still functions as fallback when OSM has no colour tag.

**Effort:** 1 session. No re-bake.

**Dependencies:** None. Can be first sub-task.

---

#### A2 — Tree Wind Shader

**Rationale:** Grass has a beautiful multi-frequency wind shader (`grassRenderer.js:210-249`) using `sin(phase) × bladeH²` vertex displacement. Trees are completely static despite being in the same scene. The inconsistency (animated grass, static trees next to it) is jarring. The fix is a vertex shader extension to the procedural tree geometry using the same `uTime` uniform already available for grass.

**Target files:** `frontend/src/map/vegetationRenderer.js` (add `onBeforeCompile` or `ShaderMaterial` to tree material), `frontend/src/main.js` (extend `updateGrassWind` call to also update tree wind time uniform).

**Scope:** Add per-vertex trunk-height-weighted XZ displacement using the same multi-frequency pattern as grass. Tip displacement should be ~0.3–0.5m at full wind; trunk base stays fixed. Use `trunkHeight` as the vertex height reference.

**Verification:** Drive past a row of trees. They should sway gently in sync with nearby grass. Shadow on ground should also animate.

**Effort:** 1 session. No re-bake.

**Dependencies:** None. Can be done in any order relative to A1, A3, A4, A5, A6.

---

#### A3 — Sky → Ambient → Fog Color Sync

**Rationale:** The sky (`scene.js:484-512`), ambient light (`0xffe8c8`, `scene.js:530`), and fog (`0x9dc2db`, `scene.js:557`) are independent hardcoded values. A coherent atmosphere requires: fog color = sky horizon color, ambient light color = sky mid color with slight warmth, and the car's env sphere reflecting the actual sky gradient. Enabling fog (currently `ENABLE_FOG: false`) with matched colors is the single highest visual-impact change in the Phase A list.

**Target files:** `frontend/src/scene.js` (extract sky colors as shared constants, wire fog color), `frontend/src/main.js` (enable fog in default config or make it soft-on by default), `frontend/src/config.js` (`ENABLE_FOG: false` → `true`), `frontend/src/car/carModel.js` (replace grey PMREMGenerator sphere with sky gradient).

**Scope:**
- Extract `HORIZON_COLOR`, `MID_SKY_COLOR`, `ZENITH_COLOR` as shared constants from the sky shader
- Set `scene.fog = new THREE.FogExp2(HORIZON_COLOR, 0.004)` (slightly less dense than current 0.007)
- Set ambient light color to lerp between horizon and mid-sky
- Set `ENABLE_FOG: true` in config.js
- For car PMREMGenerator: generate env from the sky gradient instead of neutral grey

**Verification:** Drive at distance. Sky, terrain horizon, and fog should blend seamlessly. The car should reflect the blue-grey sky in paint highlights.

**Effort:** 1 session. No re-bake.

**Dependencies:** None. Can be done in any order.

---

#### A4 — Default Building Height Fix

**Rationale:** `buildingNormalize.js:8`: `DEFAULT_HEIGHT_M = 9` applies to buildings without OSM `height=` or `building:levels=` tags (roughly half of all buildings). Real Eixample buildings average 6 stories × 3.5m = 21m. The game renders 3-story buildings. Additionally, `buildingNormalize.js:112`: `levels × 3.0m` should be `levels × 3.5m` for Barcelona (Spanish floor-to-ceiling is 3.2–3.8m depending on era).

**Target files:** `backend/worldBuilder/buildingNormalize.js` (DEFAULT_HEIGHT_M and levels multiplier).

**Scope:**
- `DEFAULT_HEIGHT_M: 9` → `18` (flat, applies to all untagged buildings regardless of type)
- `levels * 3` → `levels * 3.5` (more accurate floor-to-ceiling for Barcelona)
- Per-type defaults (`commercial: 12`, `residential: 18`, `industrial: 8`) are deferred — see Section 5

**Re-bake required:** YES — buildingNormalize runs at bake time. Full Barcelona re-bake (~8 min).

**Verification:** After re-bake, drive through Eixample. Buildings should feel like a proper urban canyon — facades extending well above the road surface, not ending at second-floor level.

**Effort:** 1 session including re-bake.

**Dependencies:** Must be done before or alongside A1 (building colour), since re-bake is shared.

---

#### A5 (Optional) — Cascaded Shadow Maps — **DEFERRED**

> See Section 5 Deferred / Documented Known Issues for full reasoning. Section 4 Principle 2 triggered during investigation (risk profile changed from MEDIUM to HIGH). Do not re-attempt without first resolving the `onBeforeCompile` conflict on tree wind and terrain shaders.

**Rationale:** Current setup: single `PCFSoftShadowMap` at 2048×2048 covering 120m × 120m frustum (`scene.js:540-549`). At 120m coverage, each shadow texel covers 120/2048 ≈ 5.9cm. CSM with 3 cascades (5m, 30m, 120m) would give 0.25cm resolution near the car with the same total texture budget. Three.js has a `CSM` addon in examples.

**Risk:** ~~MEDIUM~~ **HIGH** — `csm.setupMaterial()` overwrites `onBeforeCompile`, conflicting with tree wind and terrain shaders. See Section 5 for full findings.

**Effort:** 1–2 sessions.

**Dependencies:** None. Can be deferred to after A1–A5.

---

#### A6 (Optional) — Color Grading LUT + Vignette

**Rationale:** `renderer.toneMapping = THREE.LinearToneMapping` with `exposure = 1.25`. A slight warm grade (Barcelona golden-afternoon look) and 15% screen-edge vignette would dramatically increase the perceived polish. One additional `ShaderPass` in the EffectComposer.

**Effort:** 0.5 sessions.

**Dependencies:** None. Can be done any time.

---

**Phase A Sub-task Order (recommended):**
1. A3 (sky/fog/ambient) — immediate visual impact, no risk
2. A4 (building height) — triggers the re-bake, do alongside A1
3. A1 (dead building fields) — shares the re-bake from A4
4. A2 (tree wind) — quick, no risk
5. A5, A6 — optional, whenever

*Note: Car height (formerly A4) moved to Phase C — see Section 6 Decisions Log and Section 7 Q-A4.*

---

### Phase B — Cross-Tile Architecture — **COMPLETE — cross-tile metadata pipeline architecturally correct and operational. Separate ramp-descent issue tracked in Section 5.**

**Goal:** Introduce a region-wide pre-pass in the bake pipeline before per-tile processing. This eliminates the cross-tile blindness that causes tunnel terrain cut failures and will enable future cross-tile features (long bridge consistent supports, boulevard-edge features at tile boundaries, chamfer plaza geometry at tile corners).

**Estimated total effort:** 2 sessions. Re-bake required.

**Risk:** MEDIUM — changes the bake pipeline architecture, not the runtime.

---

#### B1 — Design Cross-Tile Metadata Format

**Scope:** Define what the region pre-pass emits. Candidates:
- **Tunnel portal index:** for each drivable tunnel that spans more than one tile, record `{ tunnelId, portalA: {tileX, tileY, worldX, worldZ, direction}, portalB: {...} }`. The portal's ADJACENT tile can then read this metadata and cut a terrain corridor starting from its own edge.
- **Long-feature boundaries:** any OSM way whose bounding box spans >1 tile (bridges, tunnels, long boulevards) gets emitted with its cross-tile endpoint coordinates.

**Format:** A single `region_metadata.json` emitted alongside tiles (or a sidecar `.meta.bin` per tile containing cross-tile features that affect it).

**Decision required:** Option A (one region-wide file loaded at runtime) vs Option B (per-tile sidecar). See Section 7 open questions.

**Effort:** 0.5 sessions (design + spec).

---

#### B2 — Implement Region Pre-Pass in buildRegion.js

**Scope:** In `buildRegion.js`, before the per-tile loop, scan all classified tunnel roads. For each tunnel road with portal endpoints at tile boundaries, compute the adjacent tile and outward portal direction. Emit cross-tile metadata. This pre-pass uses the already-available `tunnelRoads` list from `classifyJunctions`.

**Target files:** `backend/worldBuilder/buildRegion.js` (new pre-pass loop before tile iteration).

**Effort:** 0.5 sessions.

---

#### B3 — Update terrainBaker.js to Consume Cross-Tile Metadata

**Scope:** The terrain baker for tile T reads any portal corridors that originate from adjacent tiles and are directed INTO tile T. These are concrete `{x, z, dirX, dirZ, halfW, length}` segments to add to `approachSegments`. This replaces the current heuristic of "extend inward from every portal endpoint in this tile's own tunnel roads."

**Target files:** `backend/worldBuilder/terrainBaker.js`, `backend/worldBuilder/buildRegion.js` (pass cross-tile metadata to bakeTerrainMesh).

**Effort:** 1 session including re-bake and verification.

---

#### B4 — Verify Cross-Tile Tunnel Terrain Cut

**Verification:** Load the tile adjacent to a Ronda Litoral portal. Terrain should have a clean rectangular cut in the approach zone (the flat terrain before the portal face). Previously this cut applied to the underground section in the wrong tile.

**Future-unlock this enables:**
- Junction chamfer geometry at tile corners (currently chamfers only work if the junction is fully inside one tile)
- Long bridge pillar consistency across tiles
- Boulevard median features at tile boundaries
- Any per-tile "what's nearby in adjacent tiles" queries

---

### Phase C — Mercator Scale Fix

**Goal:** 1 world unit = 1 real meter everywhere — in XZ (horizontal) and Y (vertical). Currently XZ is 1.3321 wu/meter at Barcelona latitude; Y is already 1.0 wu/meter.

**Estimated total effort:** 2–4 sessions. No re-bake required if Option B is chosen; small re-bake needed if Option A.

**Risk:** HIGH — affects every coordinate in the system. Must be done last. Requires careful subsystem-by-subsystem verification.

---

#### C0 — Decision: Projection-Layer Correction (Option A) vs Per-Subsystem Audit (Option B)

**Option A — Projection layer correction:**
Modify `latLonToMercator` and/or `mercatorToWorld` in `frontend/src/projection.js` (and `backend/worldBuilder/projection.js`) to divide x and z by `1/cos(lat)` at the origin, making world coordinates equal real meters. This is architecturally cleaner — the fix is in one place. Downside: all geometry computed from OSM coordinates (building footprints, road ribbons, terrain vertices) automatically gets the correction, but all manually-authored perpendicular dimensions (BCN_DIMS, car physics box, road width fallbacks, tree geometry) were already close to real-meter values (the bug is that they rendered at 75% of intended), so they would need to be REDUCED by cos(41.35°) = 0.751 to maintain their visual size. Requires small re-bake (footprints change size).

**Option B — Per-subsystem constant audit:**
Leave the projection layer unchanged. Instead, multiply every manually-authored world-unit constant by 1.3321 to achieve the intended real size. `BCN_DIMS.SIDEWALK_WIDTH_EIXAMPLE: 5.0` → `6.66`. Car chassis half-extents multiply by 1.3321 in XZ. Road width fallbacks multiply by 1.3321. No re-bake. Downside: the fix is spread across many files; future developers must remember to write constants in "Mercator world units" not "meters."

**Recommendation (to be decided):** Option A if architectural cleanliness is prioritized; Option B if minimal re-bake and minimal system disruption is prioritized. See Section 7.

---

#### C1 — Update Projection Layer (Option A only)

**Target files:** `frontend/src/projection.js:34` (`mercatorToWorld`), `backend/worldBuilder/projection.js` (same function).

**Scope:** After computing `{ x: mx - o.x, z: my - o.y }`, apply cos(ORIGIN_LAT) correction to make XZ units equal real meters.

---

#### C2 — Recalibrate All Hand-Written Constants (includes car dimensions)

**Target files:**
- `frontend/src/map/barcelona-constants.js` (BCN_DIMS — all linear dimensions)
- `frontend/src/car/carPhysics.js` (chassis half-extents all three axes, wheelbase, track width, suspension geometry, camera offsets)
- `frontend/src/car/carCamera.js` (`BASE_CAM_HEIGHT`, `MIN_CAM_ABOVE_CAR` — relative to corrected chassis)
- `frontend/src/map/roadRenderer.js` (WIDTH_BY_TYPE fallbacks)
- `frontend/src/map/vegetationRenderer.js` (trunk radius, foliage sphere positions)
- `frontend/src/map/streetlightRenderer.js` (POLE_HEIGHT stays — it's Y-axis; ARM_LENGTH needs correction)
- `frontend/src/map/buildingRenderer.js` (MERCATOR_SCALE: change from `cos(28.5°)` to `cos(41.35°)`, `buildingRenderer.js:215`)

**Scope:** Audit every file with a dimension constant. Determine whether it's an XZ constant (needs correction) or Y constant (already correct). The car is the highest-priority item in this sub-task — correct all three axes together so the BMW M3 is simultaneously the right height (Y: 0.40m → 1.43m), width (XZ: 1.05m → 1.90m real), and length (XZ: 2.33m → 4.76m real). Fixing all axes together avoids the visually worse intermediate state of a correct-height but disproportionately elongated car. Create a before/after values table in the decisions log.

---

#### C3 — Verification

**Protocol:** After applying corrections, drive through a known reference location (Carrer de la Diputació × Passeig de Gràcia). Verify:
- Car fills approximately 60–70% of a lane width (real car 1.9m, lane ~3.5m = 54%)
- Streetlight height is ~5× car height (8m / 1.43m = 5.6)
- Two-lane road with sidewalks appears appropriately proportioned for walking/driving
- Building facades do not appear squashed or stretched vs. their footprint plan

---

#### C4 — Document New Constants

Update `barcelona-road-system.md Section 4` with all recalibrated BCN_DIMS and WIDTH_BY_TYPE values. Update gotchas.md with the Mercator scale status (resolved or still partially in effect).

---

## Section 4: Cross-Phase Principles

These principles were learned during the road overhaul (Phases 1–4) and must be preserved in all subsequent fix sessions:

**1. One sub-task at a time.** The road overhaul succeeded because each sub-task was isolated, verified, and documented before the next began. "Phase B" and "Phase C all at once" have never worked in this codebase. Compound un-verified changes produce compounding un-debuggable bugs.

**2. Diagnose → propose → approve → implement → verify.** The approved loop from the road overhaul. Read-only investigations produce better fixes than "fix it now" prompts. Never skip the investigate step, especially for Phase B and C work.

**3. Reuse existing patterns before writing new code.** The Phase 4 tunnel overhaul repeatedly wrote new geometry iteration code that had bugs (chord walls, z-fighting, wrong coordinate systems) that existing patterns in `roadRenderer.js` had already solved. Before writing new geometry code: read `buildSidewalks`, `buildCurbs`, `buildRoadMarkings` to understand the established curve-following, junction-clipping, and UV-mapping patterns.

**4. Constraint-driven prompts, not open-ended briefs.** "Phase 4B — chamfered corners and polish" produced worse code than "write exactly this function at this location with these parameters." Open-ended creative prompts invite interpretation drift; the architecture has opinionated patterns and deviation causes bugs. Reference specific files and line numbers in implementation prompts.

**5. Verify in browser between sub-tasks.** Don't combine A1 + A2 + A3 into one session and verify at the end. Visual bugs compound. Each sub-task should be deployed, hard-refreshed, and visually checked before the next sub-task begins.

**6. Document decisions as they happen.** Section 6 of this document exists for this. If a decision is made mid-session (e.g., "we'll use Option B for Mercator fix"), log it immediately with reasoning. The session summary can be lost; the document persists.

---

## Section 5: Deferred / Documented Known Issues

These will NOT be addressed in Phases A/B/C. They are tracked here so they don't get proposed as scope creep during fix sessions.

| Issue | Why deferred | When to revisit |
|---|---|---|
| **Yellow no-parking stripe coverage** | OSM Barcelona uses `parking:both:restriction=no_stopping` schema; only 23+31 restriction roads found in current tile extent; coverage will improve organically as OSM improves | Phase A+1 (after visual polish lands) |
| **Ghost-wall filtering** (barrier=wall overlaps building footprints) | Requires spatial pre-pass with building polygon edges; ~50 lines of new spatial code; low priority vs. above issues | Phase B (cross-tile architecture provides the right infrastructure) |
| **Delhi-era asset leakage** | Tree species names in vegetationRenderer (Neem, Gulmohar, Ashoka, Banyan), old signage text — cosmetic, not structural | Phase A (low-cost fixes alongside A2 tree wind) |
| **Terrain grid resolution (32×32 runtime)** | `config.js:105 TERRAIN_MAX_GRID: 32` gives 14.8m/cell. Upgrade to 64 requires testing performance impact on 2020 MacBook Air. | Separate effort after Phase C |
| **KTX2 / Basis compressed textures** | Pipeline tooling investment; all current textures are Canvas2D (not large static images); GPU texture memory is not a bottleneck yet (estimated 50–100MB used vs 512MB+ budget) | Performance pass, post-Phase C |
| **Occlusion culling** | Complex WebGL2 implementation; draw calls (700–990) are already well below ceiling; would help for dense view corridors | Performance pass, post-Phase C |
| **Draco/MeshOpt for BMW M3 GLB** | One-time build step; minor impact (car is one GLB loaded once) | When convenient |
| **Pedestrian tunnel portal geometry** | Current dark charcoal frames are functional; real metro entrances have steel/glass canopies — requires new geometry type | Phase A+1 (polish pass) |
| **Baked vertex AO on buildings** | Would require terrainBaker/buildingRenderer cooperation; building bases meeting terrain with no shadow reads as floating | Standalone effort |
| **Cascaded Shadow Maps (A5)** | Investigation revealed `csm.setupMaterial()` overwrites `onBeforeCompile`, conflicting with tree wind + terrain shaders — the two most important `receiveShadow` surfaces. Manual shader-chain composition required for both; fragile and historically buggy in this codebase. Non-registered materials get 3× brightness or shadow artifacts; no clean middle ground. Visual gain (~5cm shadow texel improvement in 8m radius) is modest for 60km/h driving gameplay. 8 files affected. Section 4 Principle 2 triggered. | Revisit if/when day/night cycle is enabled (which would force similar `onBeforeCompile` shader work anyway), or if a future stationary/walking mode makes near-car shadow quality the visual bottleneck |
| **Color grading LUT** | Listed as A6 optional; 10 lines of GLSL | Phase A optional |
| **Per-type building height defaults** (`commercial: 12m`, `residential: 18m`, `industrial: 8m`, `shed: 4m`) | Phase A used flat 18m default — per-type accuracy adds classification complexity not worth the Phase A accuracy gain; flat 18m unblocks A1 verification | Future polish pass after Phase A |
| **Service-tunnel terrain cut resolution** | Service-road parking ramps (halfW=4.5m) cannot be reliably cut at current terrain grid spacing (9.7m/cell at GRID_SIZE=64). Worst-case triangle centroid misses corridor by 6.9m > 4.5m halfW. Visible as flat-terrain "tunnel entrances" where ramps should appear (e.g., Gran Via parking ramps). Fix requires GRID_SIZE 64→128: 4× terrain vertices, ~2× bake time, perf budget concern. | Defer to dedicated terrain resolution effort after Phase C Mercator fix, when overall vertex budget is reconsidered |
| **Tunnel ramp descent geometry — single-endpoint case** | **ADDRESSED** for 231 single-surface-endpoint tunnel roads. RampResolver now classifies these as `isRamp=true` with smoothstep vertex heights from surface (0) to underground (-6). **Dual-endpoint case still deferred:** 146 tunnel roads with surface connections at BOTH endpoints (short tunnels between two surface road sections) require a valley-shaped ramp (0→-6→0). Keeping flat at -6 for now. Primarily affects short service underpasses, not major motorway portals. | Implement valley-shaped ramp for Case C tunnels when tunnel-visual polish is prioritized. Requires modifying the interpolation in RampResolver for the `startIsSurface && endIsSurface` case. |

---

## Section 5.5: Discovered Issues — Full Diagnostic Record

### Tunnel ramp descent geometry — vertical slice trace (2026-05-30)

**Discovered during:** Phase B B4 verification at eastern Ronda Litoral portal (lat 41.3615, lon 2.1315).

**Root cause:** RampResolver (`buildRegion.js` → `resolveRamps`) does not identify surface approach roads connecting to tunnel mouths as requiring Y interpolation. Both the surface road and the tunnel road are written to the binary tile with flat Y values, producing a 6m vertical step at the portal XZ instead of a smooth descent.

**End-to-end trace for road 1175108563 ("Autovia de Castelldefels", Ronda Litoral):**

| Stage | Y values |
|---|---|
| Stage 1 (OSM) | No Y in OSM; `tunnel=yes, layer=-1` |
| Stage 2 (post-buildRoadGeometry) | All 3 pts: Y = **-6.000** (`-1 × LAYER_STEP = -6m`) |
| Stage 3 (post-simplify, pre-DEM) | Y = -6.000 (unchanged) |
| Stage 4 (post-DEM) | Y = -6.000 (DEM = 0 at sea level, no change) |
| Stage 5 binary (frontend receives) | Y = -6.000 all pts |
| Surface road 32511480 (`isRamp=false`) | Y = **0.000** all 5 pts |

**Connected roads at portal XZ (237221.547, 5065760.500):**
- Tunnel: road 1175108563, Y=-6.000 — `isRamp=false`
- Surface: road 32511480 (trunk, 14m wide), Y=0.000 — `isRamp=false`
- 6m vertical step, no interpolation

**Terrain cut status:** Correct and operational. 34 of 50 terrain triangles removed near portal (68%). `bakedTerrain` present in tile binary. The terrain hole exists but reveals a discontinuous step, not a ramp.

**Root cause (confirmed):** RampResolver excluded all tunnel roads from ramp classification. The SURFACE road (32511480) is correctly flat at Y=0 (both its endpoints connect to tunnels, startH=endH=-6, correctly not a ramp). The TUNNEL road (1175108563) needed to descend from Y=0 at its surface portal to Y=-6 at its interior — but the tunnel exclusion prevented this.

**Fix applied (2026-05-30):** RampResolver now applies smoothstep ramp heights to tunnel roads with exactly one surface-connecting endpoint (231 roads in Barcelona). Road 1175108563 now has `vertexHeights=[-6.00, -1.90, 0.00]` (interior→mid→portal). Awaiting bake to verify visual result. Dual-endpoint case (146 roads) remains deferred — see Section 5 table.

---

## Section 6: Decisions Log

**Format per entry:**
```
- **[DATE] [Phase X.Y] [Sub-task]:** Decision made. Reasoning.
```

---

- **2026-05-30 [Tunnel ramp fix]:** `RampResolver.js` updated to classify tunnel roads with a single surface-connecting endpoint as `isRamp=true`. Three-case logic: Case A (both endpoints → other tunnels, mid-segment, flat) unchanged; Case B (exactly one surface endpoint) → `isRamp=true`, vertex heights smoothstep from underground (-6) to surface (0), flat buffer at portal end so road arrives flush at surface; Case C (both endpoints → surface, short tunnel between two surface roads) → deferred, flat at -6. Affects 231 tunnel roads (Case B). 146 dual-endpoint tunnels (Case C) remain with vertical steps at both portals — primarily short service underpasses, acceptable deferral. Bake required — **awaiting approval before kick-off.** The surface road (32511480) is unchanged (correctly stays at Y=0). The terrain cut (Phase B) already creates the correct hole; this fix adds the descending road geometry that should be visible through it.

- **2026-05-30 [Phase B status]: REOPENED for the second time.** Visual verification at eastern Ronda Litoral portal (lat 41.3615, lon 2.1315) shows tunnel portal frames present but no descending road ramp, no visible terrain cut. The diagnostic chain across three rounds has produced incorrect root causes: (1) resolution mismatch hypothesis — disproved when trunk-width tunnels (halfW=9.5m) also fail; (2) endpoint-count classification (Hypothesis D) — disproved when the "western portals" turned out to be legitimate underground junctions with no non-tunnel road neighbors; (3) spawn position misunderstanding — user was already at the correct eastern portal. The cross-tile metadata pipeline (`_metadata.json` pre-pass, Phase B.2/B.3) is structurally correct and the approach segments are generated. The actual failure point — the gap between "approach segment exists" and "visible terrain cut in browser" — remains undiagnosed. **Phase B work paused.** Tomorrow: trace ONE specific tunnel road's geometry (point coordinates + Y values) end-to-end from OSM PBF → bake → tile binary → frontend rendering, identifying the exact failure point empirically rather than hypothetically. No further investigation tonight.

- **2026-05-30 [Phase B closure (SUPERSEDED — see REOPENED above)]:** Phase B core work (cross-tile tunnel approach cuts via `_metadata.json` pre-pass) confirmed correct for trunk/primary-width tunnels (halfW ≥ 9.5m). B4 verification revealed two orthogonal issues: (1) service-road tunnels (halfW=4.5m) cannot be reliably cut at `GRID_SIZE=64` terrain resolution — root cause is grid cell diagonal (6.9m) > halfW (4.5m), accepted as engine limitation and deferred; (2) `highway=corridor/platform/busway/track` types were leaking through the tunnel filter into `tunnelRoadsForBake` and the cross-tile pre-pass — fixed by adding `NON_DRIVABLE_TUNNEL_TYPES` filter at both sites. Re-bake applied.

- **2026-05-30 [Phase B verification]:** Gran Via screenshot failure traced to: (1) Gran Via has no `tunnel=yes` tagged drivable road in the OSM dataset — the visible ramp is a service-type parking entrance at halfW=4.5m; (2) OSM `corridor`-type tunnels were leaking into terrain cut pipeline. Phase B's cross-tile mechanism is correct and working. Endpoint counting (Hypothesis D) was NOT the root cause. Root cause was terrain grid resolution vs corridor halfW.

- **2026-05-30 [Phase B FINAL CLOSURE]:** Phase B closes as architecturally complete. Cross-tile metadata pipeline (`buildCrossTileMetadata` pre-pass + `bakeTerrainMesh` 5th parameter) verified correct end-to-end via binary tile analysis. Terrain cuts apply correctly at portal locations — verified at eastern Ronda Litoral (road 1175108563): 34 of 50 terrain triangles removed at portal (68%), `bakedTerrain` present in binary. The user-visible "no descending ramp" issue traces to a separate, pre-existing root cause in `RampResolver`: surface roads connecting to tunnel portals are not classified as ramps, producing 6m vertical step discontinuities instead of smooth descent geometry. This is NOT a Phase B regression — Phase B's scoped work (cross-tile terrain cuts) is correct. The ramp-descent bug is tracked in Section 5 and Section 5.5 as a standalone deferred item. **Phase B: COMPLETE.**

- **2026-05-30 [Phase A → C] [Car height]:** A4 (car height surgical fix) moved from Phase A to Phase C (C2). Fixing only Y while leaving XZ Mercator-stretched creates a visually worse intermediate state — correct height but elongated proportions on the primary interactive object. All three axes (X, Y, Z) corrected together in Phase C when the Mercator fix provides the XZ correction. Phase A proceeds without any car dimension changes.

- **2026-05-30 [Phase A] [A4 / building height]:** Flat `DEFAULT_HEIGHT_M = 18` chosen over per-type defaults. Per-type accuracy (`commercial: 12`, `residential: 18`, `industrial: 8`) adds classification complexity not worth the Phase A accuracy gain. Flat 18m doubles the current default, produces correct Eixample streetscape character, and unblocks A1 (dead building field) verification since color/material variation is easier to assess at consistent heights. Per-type defaults deferred to Section 5.

- **2026-05-30 [Phase B.2/B.3] [Cross-tile pre-pass verification]:** 146 entries / 76 affected tiles confirmed legitimate. Drivable filter NOT applied to pre-pass — consistent with per-tile bake which also uses tunnel flag only (`filter(r => r.tunnel)`). Pedestrian/footway/path/cycleway already filtered upstream at `buildRegion.js:406-410`. Service-road tunnels dominate (129 entries at halfW=4.5) — underground parking, delivery corridors. Multi-entry tunnels confirmed as short tunnels with both portals crossing tile boundaries (not split-segment false positives — endpoint counting correct). Ronda Litoral located: 1 trunk-width entry (halfW=9.5, way/1175108563) at portal (1780, 1655), Port Olímpic area. All direction vectors unit length ✓. Optional DRIVABLE filter cleanup deferred — apply only if browser verification reveals visible artifacts from corridor/platform/busway tunnel cuts. Awaiting B4 browser verification.

- **2026-05-30 [Phase B.2/B.3] [Cross-tile tunnel approach — implementation]:** Pre-pass function `buildCrossTileMetadata()` added to `buildRegion.js` before the per-tile loop. Scans region-wide tunnel roads, identifies true portal endpoints (endpoint count = 1), computes approach corridor direction and endpoint, emits `tunnel_approach` features only when `affectsTile ≠ ownerTile`. Builds in-memory `Map<"zoom_tx_ty", feature[]>` keyed by affectsTile. Writes audit file `backend/tiles/{region}/{zoom}/_metadata.json` (bake artifact only — frontend never fetches it). `bakeTerrainMesh` signature extended with `crossTileApproaches` 5th parameter; entries mapped directly into existing `approachSegments` mechanism — no parallel cut path (Section 4 Principle 3). Per-tile call at `buildRegion.js:1240` now passes `crossTileMap.get(tileId) || []`. Debug logging: total cross-tile entries, per-affected-tile count. **Pausing before re-bake for user confirmation.**

- **2026-05-30 [Phase B.1] [Cross-tile metadata format]:** Single region file `_metadata.json` chosen over per-tile sidecars — data is ~5–10KB total, no fragmentation benefit, simpler pipeline (one write, one in-memory Map). Flat feature array with `type` field for future extensibility — `bridge_approach` example shown as proof of format expressiveness (not implemented). Metadata consumed at BAKE time only — frontend never fetches this file. Bridge/chamfer handling deferred.

- **2026-05-30 [Phase A.5] [Cascaded Shadow Maps]: DEFERRED.** Investigation surfaced 3 critical findings: (1) `csm.setupMaterial()` overwrites `onBeforeCompile` — direct conflict with tree wind (`vegetationRenderer.js`) and terrain (`terrainRenderer.js`) shaders, both `receiveShadow = true`; manual shader-chain composition required and historically fragile in this codebase; (2) materials not registered with CSM sum all cascade lights, producing 3× brightness or shadow artifacts with no clean middle ground; (3) visual gain (~5cm shadow texel improvement in 8m near-car radius) is modest for 60km/h driving gameplay. `dayNight.js` creates its own `DirectionalLight` — a latent conflict if `ENABLE_DAY_NIGHT` is ever enabled. Minimum 8 files affected. Section 4 Principle 2 triggered: risk profile changed from MEDIUM (per roadmap) to HIGH (per investigation). Moved to Section 5 deferred list. **Phase A final status: A1 COMPLETE · A2 COMPLETE · A3 COMPLETE · A4 COMPLETE · A5 DEFERRED · A6 COMPLETE.**

- **2026-05-30 [Phase A.6] [Color grade + vignette]:** New `ColorGradePass` added between `RadialBlurPass` and `OutputPass` (`frontend/src/ui/colorGradePass.js`). Custom analytic `ShaderPass` — no LUT file required. Warm shift R+6%/G+2%/B-6% at `uGradeStrength=1.0`, shadow lift (lift 0.015, gain 0.97), vignette 18% max at corners (start 0.38, end 0.75 smoothstep). `uGradeStrength` uniform exposed for in-browser tuning via `window._colorGradePass.uniforms.uGradeStrength.value`. Three.js `LUTPass` deferred — would require `.cube` asset pipeline, overkill for analytic warm shift. `window._colorGradePass` reference should be removed before shipping. **VERIFIED.** `ColorGradePass` active in pipeline, warm grade and vignette confirmed in browser. `uGradeStrength` default 1.0, tunable live via `window._colorGradePass.uniforms.uGradeStrength.value`. All Phase A optional sub-tasks (A5 CSM excepted) now complete.

- **2026-05-30 [Phase A] [A3 / sky-ambient-fog cohesion]:** Sky constants `SKY_HORIZON=#BFD7EE`, `SKY_MID=#94C2E6`, `SKY_ZENITH=#6FAEDB` extracted as exported module-level constants from `scene.js`. Fog wired to `SKY_HORIZON`, density `0.005` (not proposed 0.004 — denser for readability as atmosphere). Ambient lerped 25% from warm amber `#FFE8C8` toward `SKY_HORIZON`, yielding `#EFE4D2` — still warm, slight sky-blue tinge. Car PMREMGenerator env sphere updated to use `SKY_HORIZON→SKY_ZENITH` gradient instead of hardcoded grey values. Fog disabled in drone/free-camera mode (`scene.fog.density = 0` when no carDriver) — aerial view stays clear. All four systems now derive from one palette.

- **2026-05-30 [Phase A.3] [Drone fog]:** Drone mode fog disabled (density 0) during development for visual debugging — flying up to survey the city needs unobstructed sightlines while iterating on Phase A/B/C. Implementation: per-frame density toggle in animate loop based on carDriver presence. **TO BE REVERTED before shipping** — fog should apply uniformly in both modes for final visual cohesion.

- **2026-05-30 [Phase A.2] [Tree wind shader]:** Reused grass shader pattern via `onBeforeCompile` on the shared `MeshLambertMaterial` (`getProceduralMaterial()`). Y-position-as-proxy for trunk/foliage distinction: `(transformed.y / 10.0)²` gives ~0 sway at trunk base, quadratic ramp to full sway at foliage tip. Same multi-frequency sin math as grass (`grassRenderer.js`) for spatial coherence — trees and grass sway in the same wind field. `uWindStrength=0.6` (tuned down from initial 1.5), billboard trees unaffected — `getTreeBillboardMaterial()` is a separate code path. Fragment shader patch removed (caused shader link failure on some drivers); wind phase uses mesh origin via `modelMatrix * vec4(0,0,0,1)` instead of per-instance world pos to avoid `instanceMatrix` access outside `USE_INSTANCING` guard. **VERIFIED.** Trees sway in sync with grass, billboards static (correct), no perf regression. Phase A required sub-tasks (A1, A2, A3, A4) now complete. A5 (CSM) and A6 (LUT) remain as optional polish.

- **2026-05-30 [Phase A.4 + A.1] [Building height + dead fields]: VERIFIED.** Building heights now feel 6-story canyon-correct in Eixample (mean 22.3m post-bake, was 18.9m). `b.colour`, `b.material`, `b.roofShape` activated as designed. No regressions. No "tall sheds" reported. Console clean.

- **2026-05-30 [Phase A.3] [Sky/ambient/fog cohesion]: VERIFIED.** Shipped values: `SKY_HORIZON=#BFD7EE`, fog density `0.005` (drive only, drone disabled per user request), ambient `#EFE4D2` (lerp 25% toward horizon), car env sphere now uses sky gradient. All five verification tests passed.

---

## Section 7: Open Questions

Questions that must be answered before or during the relevant phase. Don't proceed to a phase without answering its open questions.

### Phase A

**Q-A1: Which sub-task first?**
Recommended order is A3 → A4+A1 (shared re-bake) → A2 → A5 → A6. The user may have a different priority. Confirm at Phase A kickoff.

**Q-A4: Car height — RESOLVED.**
Car height fix (all axes) moved to Phase C (sub-task C2). Fixing Y-only in Phase A would create a visually worse intermediate state (correct height, wrong horizontal proportions). No car dimension changes in Phase A. See Section 6 Decisions Log entry dated 2026-05-30.

**Q-A5: Building height default — RESOLVED.**
Flat `DEFAULT_HEIGHT_M = 18` chosen for Phase A. Per-type defaults (`commercial: 12`, `residential: 18`, `industrial: 8`) deferred to a future polish pass (see Section 5). See Section 6 Decisions Log entry dated 2026-05-30.

**Q-A5b: Cascaded Shadow Maps — DEFERRED (not a question, a closure).**
A5 was investigated and deferred. Do not treat as an open question for Phase A. Full reasoning in Section 5 and Section 6 Decisions Log (2026-05-30 [Phase A.5] entry).

### Phase B

**Q-B1: Cross-tile metadata format — region file or per-tile sidecar?**
Option A: single `region_metadata.json` alongside tiles. Simpler to generate; frontend loads one extra file at startup.
Option B: per-tile sidecar `16_33164_24480.meta.json` containing cross-tile features that affect this tile. Self-contained; no extra startup load; more complex to generate.
Confirm before Phase B begins.

**Q-B2: Scope of cross-tile pre-pass.**
Phase B is motivated by tunnels. But the pre-pass infrastructure, once built, can serve: chamfer geometry at tile-boundary junctions, long bridge pillar consistency, boulevard-edge features. Should Phase B scope include all of these or just tunnels? The more ambitious scope produces more reusable infrastructure but takes longer. Confirm at Phase B kickoff.

### Phase C

**Q-C1: Option A (projection layer) vs Option B (per-subsystem constants) for Mercator fix.**
The audits favor Option A (architectural cleanliness, one change location). However, Option A requires a small re-bake (building footprints and road geometry change size), and all hand-written constants must be multiplied by cos(41.35°) to maintain visual size. Option B requires no re-bake but spreads the fix across many files. **This is the highest-stakes decision in the roadmap.** Discuss with user at Phase C kickoff — do NOT begin Phase C without this confirmed.

**Q-C2: Coordinate system documentation.**
Once Phase C is complete, the projection should be documented in `architecture.md` and `gotchas.md` with enough detail that any future developer understands: "1 world unit = 1 real meter, XZ and Y." Who writes this — a session dedicated to doc update, or inline with Phase C implementation? Confirm at Phase C kickoff.

---

## Appendix: Key File:Line References

Quick lookup for session prompts.

| Issue | File | Line/function |
|---|---|---|
| World unit derivation | `frontend/src/projection.js` | `latLonToMercator` (L19), `mercatorToWorld` (L34) |
| Car physics box | `frontend/src/car/carPhysics.js` | L83 `CANNON.Vec3(0.70, 0.20, 1.55)` |
| Car visual scale | `frontend/src/car/carModel.js` | L10 `CAR_VISUAL_SCALE = 0.75` |
| Camera height | `frontend/src/car/carCamera.js` | L14 `BASE_CAM_HEIGHT = 1.4` |
| Default building height | `backend/worldBuilder/buildingNormalize.js` | L8 `DEFAULT_HEIGHT_M = 9` |
| Building levels multiplier | `backend/worldBuilder/buildingNormalize.js` | L112 `levels * 3` |
| Dead building fields (read) | `frontend/src/map/tileParserWorker.js` | L284-289 |
| Dead building fields (never used) | `frontend/src/map/buildingRenderer.js` | (colour/material not referenced) |
| Terrain max grid | `frontend/src/config.js` | L105 `TERRAIN_MAX_GRID: 32` |
| Sky gradient colors | `frontend/src/scene.js` | L499-504 |
| Ambient light | `frontend/src/scene.js` | L530 `0xffe8c8` |
| Fog disabled | `frontend/src/config.js` | `ENABLE_FOG: false` |
| MERCATOR_SCALE wrong latitude | `frontend/src/map/buildingRenderer.js` | L215 `cos(28.5°)` should be `cos(41.35°)` |
| Grass wind shader | `frontend/src/map/grassRenderer.js` | L210-249 (extend to trees) |
| MeshStandardMaterial overuse | `frontend/src/map/grassRenderer.js:66`, `streetlightRenderer.js:139`, `greensRenderer.js:24`, `barrierRenderer.js:92` | — |
| Post-processing pipeline | `frontend/src/main.js` | L58-71 (RenderPass, Bloom, RadialBlur, OutputPass) |
| Shadow map setup | `frontend/src/scene.js` | L540-551 |
| Terrain baker Mercator bug (fixed) | `backend/worldBuilder/terrainBaker.js` | Fixed in tunnel overhaul — see G-43 |
| BCN_DIMS constants | `frontend/src/map/barcelona-constants.js` | All dimensions — Phase C target |
| Road width fallbacks | `frontend/src/map/roadRenderer.js` | L146-165 `WIDTH_BY_TYPE` |
