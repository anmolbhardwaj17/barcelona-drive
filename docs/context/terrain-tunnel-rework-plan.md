# Barcelona Drive — Terrain & Tunnel Rework: Phased Game Plan

> **This is the working tracker for the terrain & tunnel rework.**
> Update it as phases complete: mark each phase's checkboxes, record what was done,
> and DO NOT advance to the next phase until its drive-test gate is confirmed
> ON SCREEN by the user. Treat this file as the source of truth for the rework's
> scope and status.

---

## Guiding Principle (the reframe)

OSM + DEM are **sources, not specs**. The pipeline decides fidelity per-feature:
- **Honor** big structural relief faithfully — Montjuïc, the coast descent, real tunnels.
- **Aggressively smooth / flatten** everything below the threshold that matters for driving.

Most of the previous stage's bug *classes* (spurious bridges, road-drape cutouts,
collider micro-mismatches, spikes/pits) were the system straining to honor sub-meter
relief the game doesn't need. Smoothing at source removes the *cause*, not just the symptom.

Goal: the **vibe** of Barcelona (hills feel like hills, flat is flat, tunnels are clean),
NOT 99% survey-accurate reproduction.

## What We KEEP (do not rebuild)
- Coordinate foundation (1 unit = 1 metre, single projection).
- Offset unification — D-12 (single `getWorldElevationOffset()`, gated by `whenElevationOffsetReady()`).
- Co-framing, `useBaked` live terrain path (D-13).
- Road drape via `p[3]` (D-14) and bridge structural detection (D-15).
- Collider-built-from-visual-mesh fix (G-49).
- **The G-48 verification discipline** (identify the object, log runtime value, verify on
  RENDERED screen, full reload + fresh bundle, never trust a report over the screen).

We are changing what we **feed** the system, not the frame it lives in.

---

## RULES FOR EVERY PHASE (non-negotiable)
1. Each phase ends with a **DRIVE-TEST GATE** — a concrete thing the user sees/drives.
2. **Do NOT advance** to the next phase until the user confirms the gate ON SCREEN.
   Not "the validator passed." Not "the baked data is clean." The user drives it.
3. Diagnose read-only BEFORE changing code. Report findings, get review, then fix.
4. Verify fixes on the RENDERED screen + runtime values (per G-48), not reports.
5. Full reload + fresh bundle when testing (HMR keeps stale meshes/worker chunks).
6. Expect Phases 2–4 to SHRINK as Phase 1 lands — fewer moving parts is the goal.
   If smoothing makes machinery (bridge-detection special cases, water-sink edge
   handling, road-drape special cases) deletable, DELETE it.

---

## PHASE 0 — Survey + Close Residuals ✅ (gate confirmed on screen 2026-06-11)

**Goal:** Know exactly where a terrain-smoothing pass slots in (single upstream
chokepoint), how tunnels are generated today, and close the two open residuals.

**Tasks:**
- [x] READ-ONLY: Map the bake pipeline. Identify the SINGLE point where a terrain
      smoothing/flatten pass belongs so that EVERY downstream consumer (terrain visual,
      terrain physics, roads, vegetation, water, bridges) inherits smoothed terrain.
      Report the file:line chokepoint and the consumers downstream of it. → see Findings §A.
- [x] READ-ONLY: Map how tunnels are generated TODAY (the emergent path: OSM layer tags
      + DEM relief + absolute-Y constants + any boolean/cut). List every file/function
      and every absolute-Y constant involved. This is what Phase 3 replaces. → see Findings §B.
- [x] FIX: `parkingRenderer.js:82` — ALREADY FIXED in a prior session. File reads `.x/.y`
      everywhere (G-46 comment at line 83 marks the fix site). Full-file re-grep clean:
      no `[0]/[1]` array-indexing on point vars anywhere in the file. No change needed.
- [x] VERIFY (code side): the terrain collider fix (G-49) is in place —
      `tileManager.js:826-855` `createTerrainTrimesh` PREFERS the 128-grid visual
      `bakedTerrain.positions` (16,384 verts/tile, runtime-verified; earlier "64-grid"
      label was wrong) over the old 32-grid physics bake, applying the exact
      rendered transform (`pY = (wy − offset) · vertExag`, X-negated) → collider is
      byte-identical to the drawn surface. Runtime gap probe + FPS check = the drive gate below.

### Phase 0 Findings

**§A — Smoothing chokepoint (for Phase 1):**
- ALL bake-time elevation reads funnel through ONE function:
  `backend/worldBuilder/demLoader.js:174` `sampleElevation(lat, lon)` — no consumer
  samples the DEM independently. Three call sites in `buildRegion.js`:
  terrain grid 128×128 (`:1061`), water surface median (`:1136`), road drape (`:1205`,
  added into `p[3]` at `:1212`).
- A global smoothing pass ALREADY EXISTS (D-16 Stage A, shipped): `demLoader.js:93`
  applies `smoothRaster()` (`:30`, separable NoData-aware box blur) to the whole raster
  at load, BEFORE any sampling. Tunable via env `DEM_SMOOTH_RADIUS` (default 2 px) /
  `DEM_SMOOTH_ITERS` (default 2). Global pre-smooth keeps tile edges seamless.
- **Phase 1 is therefore an EXTENSION of `smoothRaster`/the raster-level pass**, not a
  new subsystem: add the relief-floor + flatten-threshold knobs at the same raster
  level (before sampling), so seams stay matched. Per-sample smoothing inside
  `sampleElevation` would be too late (bilinear already interpolates) and risks seams.
- Frontend never re-samples the DEM (D-13): runtime consumers (vegetation, buildings,
  grass, props) all read the baked grid via one `getElevationAt` closure
  (`fastElevation.js:28`, wired at `tileManager.js:1234`). Bake-side smoothing is
  sufficient; no bypass path exists.
- Unused helpers exist at `backend/worldBuilder/terrain/terrainSmoothing.js`
  (boxBlur3x3, removeMicroNoise, clampExtremeSlopes, lowHighFrequencyBlend — exported,
  imported nowhere). Candidate raw material for the Phase 1 knobs.

**§B — Emergent tunnel path today (for Phase 3 to replace):**
- Bake: `tunnel`/`layer` tags kept (`pbfHighways.js:17`); drivable-tunnel whitelist
  applied at `buildRegion.js:188-194` (cross-tile pre-pass) and `:1426` (per-tile).
- Layer→Y: `roads/LayerResolver.js:8` `LAYER_STEP = 6` → tunnel layer −1 = −6 m
  (the "−6 trench" constant). Descent profile: `roads/RampResolver.js:105-201` —
  Case B single-surface portals get smoothstep ramp, `FLAT_FRACTION = 0.20`;
  Case C (both-surface) DEFERRED → flattened. Node harmonization:
  `roads/elevationHarmonizer.js:20-61` (per-layer Y averaging).
- DEM drape: `buildRegion.js:1190-1217` adds sampled ground elev into `p[3]`
  (`:1212`) → tunnel absolute Y = DEM + layer profile.
- Terrain carving (the "boolean/cut"): `terrainBaker.js` — visual mesh 128-grid mouth
  punching + approach-corridor carving via triangle-index culling
  (`CARVE_MARGIN = 0.3`, `CARVE_COVER = 5.0` at `:170-171`); physics mirror at
  `:415` (+1 m `PHYS_MOUTH_MARGIN`, grid dilation). Cross-tile approach corridors:
  `buildRegion.js:177-288` `buildCrossTileMetadata` (80 m corridor, known diagonal-
  crossing limitation = G-47 note; this is the "cross-tile corridor cut" item).
- Frontend: classification `tileManager.js:1154-1215`; build order (C6 contract)
  `:1217-1290`; runtime terrain-trimesh carving `:814-946`; tunnel wall colliders
  `:573-686` (`TUNNEL_CLEARANCE = 4.5` from `tunnelRenderer.js:32`); approach walls
  `:709-811`; deck ramp boxes `:1295-1337` (gate: Δelev > 0.5 m — a known
  fall-through contributor: flat-drawn surface roads above a carved trench get NO
  deck box and NO terrain). Visuals: `tunnelRenderer.js` enclosure `:126-311`,
  portal frame `:222-288`, approaches/trench `:435-534` (`botY = gP − 5.95`),
  retaining walls `:557-597`. Zones: `tunnelZones.js:23-54`.
- Remaining ABSOLUTE-Y constants (Stage-3/Phase-3 targets): `PORTAL_HEIGHT = 0`
  (`tunnelRenderer.js:42`), `RETAINING_LIP_THRESHOLD = −0.05` (`tileManager.js:688`),
  deck-box gate clause `max > 0.3 || min < −0.3` (`tileManager.js:384, 444`).
  Most others already converted to `getGroundY(...)`-relative.
- Fall-through mechanism (documented, vertical-model-spec §Shape-1): flat surface road
  drawn over a carved corridor → no deck box (Δelev gate) + terrain triangles culled
  → drivable surface with NOTHING under it. This is exactly what the
  drivable-surface-implies-floor assert (Phase 3) kills.

**DRIVE-TEST GATE (user confirms):**
- Drive off-road onto a Montjuïc slope → car HOLDS on the terrain (doesn't sink/fall).
- (Parking + survey are non-visual; the collider hold is the on-screen gate.)

### Gate attempt 1 — FAILED (2026-06-10): runtime diagnosis (headless probe, G-48 style)

On-road holds, off-road falls. Headless-browser probes against the live app
(`window._debugWorld` / `window._debugVehicle`) established, with runtime values:

- **Trimesh IS created and IS correct.** One per tile (10–15 streamed), 16384 verts
  = full 128-grid visual `bakedTerrain` path (NOT the 32-grid fallback — that would
  be 1024). AABBs tile space exactly per `physX = −(wx − swCorner)` (spawn tile
  `[−459,0]×[0,459]`, neighbors adjacent on the correct mirrored sides) → placement
  ✓, X-negation ✓. Co-framing ✓: ray-hit road-box top −16.19 vs nearest trimesh
  vertex −15.96 at the same XZ (0.23 m).
- **But NOTHING can interact with it.** Two independent dead paths:
  1. **Wheel rays cannot hit Trimesh** — isolated down-rays through the trimesh
     interior (vertices 1.4 m away) MISS. cannon-es `rayTest` vs `Trimesh` octree
     returns no hits (G-49's engine fact, runtime-reconfirmed).
  2. **The chassis backstop is filter-blocked** — terrain body group=16 mask=2;
     chassis group=2 **mask=4** (`carPhysics.js:108` = `COLLISION_GROUP_WORLD`
     only). Pair rule `(16 & 4) = 0` → no collision. Runtime pair-check: false.
- **Root cause:** the D-16 physics revert restored the PRE-G-49 chassis mask
  (`WORLD`) while restoring the trimesh-terrain model that REQUIRES the G-49
  backstop mask (`WORLD | TERRAIN`). The terrain trimesh currently collides with
  nothing. Road boxes hold because wheel rays DO hit Box shapes (runtime: down-ray
  at car XZ hit g1 Box at −16.19).
- Fix direction (Phase 0 closeout, pending approval): restore
  `chassisBody.collisionFilterMask = COLLISION_GROUP_WORLD | COLLISION_GROUP_TERRAIN`.

### Fixes applied (2026-06-11, approved "continue")

1. **Chassis mask restored** — `carPhysics.js` mask = `WORLD | TERRAIN` (the G-49 backstop).
   Runtime-verified headless: mask=20, chassis-vs-terrain pair-check=true. D-16 status
   annotated with the revert correction.
2. **Spawn height fixed** — `main.js` no longer hardcodes spawn `y: 2` (spawn-lat/lon-relative;
   the snapped road sat ~18 m downhill on Montjuïc → ~20 m free-fall → impact tunneling through
   the deck collider, the user-reported "passes through collision on landing").
   `findRoadSpawn` now returns the snapped segment's interpolated raw elevation (`elevRaw`);
   spawn y = `toNormalizedRoadY(elevRaw, offset) + 0.5` (+2 in carDriver → ~2.5 m gentle drop).
   Runtime-verified headless: chassis settles at y≈−15.7 against road top −16.19 (was falling
   through indefinitely).

**DRIVE-TEST GATE re-test:** full reload + fresh bundle, `?mode=car`, drive onto the
Montjuïc slope off-road → car holds; spawn no longer slams/tunnels on landing.

### Gate attempt 2 — FAILED (2026-06-11): mask fix necessary but NOT sufficient

User still fell. Engine-source + runtime checks found the deeper truth:
**cannon-es has NO box-vs-trimesh narrowphase** (only sphere/plane-vs-trimesh;
`narrowphase[BOX|TRIMESH]` undefined at runtime; manual-stepped drop test: chassis fell
through the verified-perfect trimesh with ZERO contacts). G-49's "box-vs-trimesh body
collision IS reliable" was never true — the trimesh terrain was unholdable by design.

### Fix 3 (2026-06-11): terrain physics → Heightfield (the D-16-target shape)

- Root cause of the ORIGINAL heightfield failure found: quadrant-indexing bug in
  `buildTerrainHeightfield` (64-range indices into the 128-wide source grid → SW quadrant
  stretched over the whole tile = "car trapped below terrain"). Fixed: full source grid.
- Wired per-tile in tileManager Phase 1 (world-frame → physics-frame conversion, group
  TERRAIN / mask VEHICLE, G-51 assert at creation). Inert trimesh build REMOVED
  (−88 ms/tile); `createTerrainTrimesh` kept dormant.
- Runtime-verified (headless, manual stepping — immune to rAF throttle):
  placement gap vs trimesh ≤ 0.01 m over 33 samples; two slope drop-tests settle with
  wheels in contact (4/4, 3/4); wheel RAYS hit heightfields → real off-road driving,
  not just a backstop hold. Build green, no page errors, G-51 assert passes.
- Known consequences (accepted, Phase 2/3 scope): heightfields can't be carved →
  tunnel-mouth physics holes gone until Phase 3 authored tunnels; global ground plane
  at y=−50 still exists (sits ABOVE coastal terrain that dips below −57 — Phase 2 item).

### Gate attempt 3 — PASSED ✅ (2026-06-11, user confirmed ON SCREEN)

Car holds off-road on the Montjuïc slope, FPS holds. Full gate history:
1. **Attempt 1 FAILED** → runtime diagnosis: trimesh perfect but chassis mask excluded
   TERRAIN (one-sided filter handshake, D-16 revert artifact) → mask fix (`WORLD | TERRAIN`)
   + spawn-height fix (snapped-road elevation instead of hardcoded y:2).
2. **Attempt 2 FAILED** → deeper engine truth: cannon-es has NO box-vs-trimesh narrowphase;
   the trimesh backstop was physically impossible → terrain physics rebuilt on
   **Heightfield** (quadrant-indexing bug in `buildTerrainHeightfield` found & fixed;
   placement runtime-verified ≤ 0.01 m; wheels genuinely drive off-road).
3. **Attempt 3 PASSED** on screen.

Hardening recorded: fail-fast `assertTerrainVehicleHandshake` (collisionGroups.js, called
from BOTH creation sites) + gotcha **G-51** (collision filters are a two-sided contract,
cites this incident) + G-49 corrected (no box-trimesh narrowphase; 128-grid not 64).

**Status:** ✅ done — drive-test gate confirmed on screen (2026-06-11)

---

## PHASE 1 — Terrain Smoothing at Source (THE BIG WIN) — ✅ (gate confirmed on screen 2026-06-11)

**GATE PASSED at the DEFAULT knob values — recorded as final for this phase:**
`TERRAIN_RELIEF_FLOOR=2.5` m · `TERRAIN_FLATTEN_THRESHOLD=3` m ·
`TERRAIN_BASE_RADIUS_PX=10` (~300 m) · `TERRAIN_FLATTEN_RADIUS_PX=30` (~900 m).
User confirmed: Montjuïc still climbs, coast still descends, Eixample flat/smooth,
small breaking transitions gone. (Knobs remain env-tunable per bake-pipeline.md.)

**Goal:** Add a low-pass smoothing pass to the DEM, upstream of every consumer
(at the Phase 0 chokepoint), with tunable knobs. Honor big relief, kill small wiggles.

**Tasks:**
- [x] Implement a terrain-smoothing pass at the single upstream chokepoint, with TWO knobs:
      - **Relief floor** — wavelength/amplitude below which relief is smoothed away
        (kills sub-meter street-to-street wiggle; KEEPS Montjuïc, which is ~170m over km).
      - **Flatten threshold** — low-relief regions (e.g. Eixample) snap flat / near-flat.
      → `demLoader.selectiveSmoothRaster` (after the existing box blur, before any sampling).
      Two-scale frequency split + soft shrinkage:
      `out = bigBase + shrink(base−bigBase, FLATTEN_THR) + shrink(src−base, RELIEF_FLOOR)`.
      Orphan `terrain/terrainSmoothing.js` reviewed: 3×3/per-tile primitives + UNIFORM blend —
      right idea (freq separation), wrong scale & place; not reused, left orphaned.
- [x] Defaults: `TERRAIN_RELIEF_FLOOR=2.5` m, `TERRAIN_FLATTEN_THRESHOLD=3` m, split radii
      10 px (~300 m) / 30 px (~900 m). A/B through the real `sampleElevation`:
      Montjuïc climb 143.3→133.7 m (93% kept) · coast descent 16.9→16.8 m (kept) ·
      Eixample wiggle RMS 0.398→0.017 m (96% gone). Tune by driving from here.
- [x] Ensure every consumer reads the SMOOTHED terrain — verified: all bake-time elevation
      flows through `sampleElevation` off the one raster (grep: only buildRegion.js ×3 +
      terrain/sampleGrid.js which reads BAKED grids downstream); frontend never re-samples
      (D-13). `mergeDemTiles.js` reads rasters but is an offline merge utility, not in the bake.
- [x] Re-bake. Full reload + cache clear. — Full-region bake completed clean 2026-06-11
      (620 s, exit 0, 408 tile binaries). Smoothing log: `floor=2.5m thr=3m radii=10/30px |
      removed-relief RMS=3.31m max=5.5m cells>0.5m=65.2%`. Headless smoke on fresh tiles:
      heightfields build, car settles 4-wheel, no errors. AWAITING USER TUNING DRIVE.

**DRIVE-TEST GATE (user confirms ON SCREEN):**
- Montjuïc → still a real climb (hill preserved).
- Coast → still descends to the sea (big relief preserved).
- Eixample → now flat/smooth, NO street-to-street wiggle (small relief gone).
- Overall: **feels like Barcelona**, small breaking transitions gone.
- Tune the two knobs by driving until the above is true.

**Expected side benefit:** spurious bridges, road-drape cutouts, collider micro-mismatches
get quieter or vanish (their cause — sub-meter relief — is gone).

**Status:** ⬜ not started

---

## PHASE 2 — Re-validate Foundation on Smooth Terrain ✅ (gate confirmed on screen 2026-06-11)

**GATE PASSED:** full sanity drive — Montjuïc climb + off-road hold, coast, Eixample,
tile boundaries. No floaters, no cutouts, no spurious decks/bridges, car holds
everywhere, FPS holds. Drive-found fixes landed during the gate: ROAD_VISUAL_ABOVE_TERRAIN
0.22→0.06 (tire-in-slab), tunnel-cam absolute-Y → zone-based (G-47), camera pull-back 8.2 m.

**Goal:** Confirm smoothing didn't break anything and DID simplify things. Delete now-
unnecessary machinery.

**Tasks:**
- [x] READ-ONLY: with smooth terrain, re-check bridge detection — are false bridges gone?
      → **0/277 and 0/338 bridge-flagged** on tiles 16_33160_24481 / 16_33161_24481
      (pre-fix: 163/277, 172/338). Region-wide: 47 bridge roads, all OSM-structural.
      Slab/guardrail gates already structural-flag-only since D-15 — no further
      simplification there; the remaining height heuristic is the PHYSICS deck gate (D1 below).
- [x] READ-ONLY: re-check road drape — roads are baked AT the smoothed DEM (D-16), so
      drape is co-framed by construction. Per-road moving-average smoother found DEAD
      (D2 below). Screenshot on Montjuïc: clean, no cutouts/floaters in view.
- [x] READ-ONLY: water-sink, greens/parking, collider — water-sink machinery all KEEP
      (guards OSM data quality, terrain-relative since the G-47 fix — not terrain-noise
      cope). Collider co-frame: G-51 assert clean; terrain-physics build per tile
      **65–91 ms (trimesh) → 0.5–3 ms (heightfield)**. Headless render clean.
- [x] DELETE deadweight — D1 & D2 APPROVED and DELETED 2026-06-11; D3 declined (KEEP,
      rationale comment added at the gate so future cleanups don't re-flag it).
      Post-deletion smoke: build green, off-road slope drop settles 4-wheel, surface
      roads deckless (structural-flags-only colliders), no page errors. Candidates were:
      - **D1** `isElevatedByHeight` deck-collider gate — `tileManager.js:432-450` + the
        `!isElevatedByHeight` term at `:453` (+ `elevatedCount` bookkeeping). The phantom-
        deck factory: also a G-47 absolute-Y bug (`maxPhysY > 0.3 || minPhysY < -0.3` is
        spawn-frame absolute → off-spawn EVERY sloped road gets a deck box). Safe to delete
        NOW because the heightfield (Phase 0) is the drivable surface for unflagged roads;
        bridges/tunnels/ramps keep decks via structural flags. Effect: fewer duplicate
        bodies, fewer box-edge seams.
      - **D2** `smoothElevation` per-road moving average — `elevationProcessor.js:36-50`
        + call at `:122` + `elevationSmoothWindow` param `:112`. ALREADY DEAD: the config
        key is set nowhere → window=0 → never executes; purpose obsoleted at source.
      - **D3 (KEEP, declined)** link-road guardrail fallback `roadRenderer.js:~2938` —
        relative above-terrain test, legitimately catches untagged elevated link roads.
- [x] Update ADRs/gotchas to reflect the simplified pipeline — D-16 records the
      structural-flags-only collider model + its Phase-0 heightfield dependency;
      changelog carries the audit numbers. Pipeline now: heightfield everywhere,
      colliders only for bridge/tunnel/ramp, no height heuristics in physics.

**DRIVE-TEST GATE (user confirms ON SCREEN):**
- Full sanity drive: Montjuïc, coast, Eixample, several tile boundaries.
- No floaters, no cutouts, no spurious bridges, car holds everywhere, FPS holds.
- Foundation is clean AND simpler than before.

**Status:** ⬜ not started

---

## PHASE 3 — Author Tunnels as Deliberate Structures (the cutout fix + ORIGINAL bug) — 🟡 re-diagnosis done

**Goal:** Stop generating tunnels emergently (which causes cutouts + fall-through).
PLACE clean authored tunnels into the now-smooth terrain.

### STEP 1 — Re-diagnosis on CURRENT reality (2026-06-11, read-only; supersedes the
### pre-rework fall-through analysis)

1. **The original fall-through is DEAD; the defect inverted to SEALED tunnels.**
   The bake's carve only culls mesh TRIANGLES (visual + the old physics-trimesh bake);
   it never writes the `elevation.elevations` GRID (only the water-sink does). The
   heightfield (Phase 0) is built from that grid → **physics terrain is solid across
   every tunnel mouth, trench, and corridor**. Runtime-proven at Ronda de Dalt
   (~phys 2980/4820): car dropped above the tunnel settles ON the invisible roof at
   surface Y 121.0 with 4-wheel contact (deck 29 m below it); heightfield-only rays hit
   everywhere (no holes). Net drive behavior today: at a visually-open portal/trench the
   car floats across on unseen ground; it can never descend; "flat road over carved
   corridor with nothing underneath" can no longer occur.
2. **The buried structures are intact and correctly placed.** Near the probe point:
   9 flat deck slabs (he.y=0.1, e.g. 6.3×28.5 m) at 3.3–6 m below the smoothed surface
   (= layer −1 · LAYER_STEP 6, DEM-draped) + 23 wall boxes. Car placed INSIDE at a buried
   structure falls (placed at a deep wall top, no floor beside it) — interior floor
   continuity is NOT guaranteed, the drivable-surface-implies-floor invariant still unmet.
3. **Absolute-Y constants surviving post-D1:** `PORTAL_HEIGHT = 0`
   (tunnelRenderer.js:42, used :240) and `RETAINING_LIP_THRESHOLD = −0.05`
   (tileManager.js:663, used :736). The deck-box gate clause is GONE (deleted with D1).
   Also relevant: tunnel-cam now zone-based (fixed in Phase 2).
4. **OSM tunnel inventory (new bake):** 1105 tunnel roads region-wide; 376 drivable.
   Layers: −1×900, −2×117, −3×32, −4×14, −5×1, 0×41 (tunnel-tagged at layer 0 — edge
   case). Types: corridor 505 + service 221 dominate the non-drivable; drivable majors:
   trunk 174 (Ronda de Dalt), primary 69, motorway 21, residential 42. Ramp
   classification (bake log): 250 single-surface Case B portals; Case C (both-surface,
   ~146 short underpasses) still DEFERRED → flattened at base depth.
5. **Mode flags today:** ENABLE_TUNNELS=true, ENABLE_TUNNEL_VISUALS=false (simple mode:
   deck-only floor mesh, wall colliders, no enclosure), ENABLE_RETAINING_WALLS=true.

**Design implication for the authored rebuild:** the heightfield is a regular grid — it
can represent open TRENCHES (depress grid cells along approach corridors at bake) but
never a hole-with-roof. So: open-cut approaches = author the trench INTO the grid;
covered sections = keep the grid at surface (the roof IS drivable street above — correct)
and guarantee the interior floor with authored deck slabs the car enters UNDER the grid.
The portal face becomes a one-cell heightfield cliff — design must place it just past the
portal and blend it so wheels don't ride up it on entry.

### STEP 2 — Design written (2026-06-11): [authored-tunnels-design.md](authored-tunnels-design.md)
Open/covered split by cover depth; trench authored into the grid at the buildRegion
chokepoint slot (post-drape :1217, pre-payload :1238); slab continuity + joint overlap;
commit-blocking drivable-surface-implies-floor validator (report-mode first);
portal cliff placed one cell past the lip with floor blend; PORTAL_HEIGHT=0 and
RETAINING_LIP_THRESHOLD retired to terrain-relative. Proving set: 174 trunk (Ronda de
Dalt) → primary/motorway. OUT of v1: 41 layer-0 oddities, ~146 Case-C underpasses,
underwater tunnels, enclosure visuals. Proposed slices: ① validator (report-only) →
② trench authoring → ③ slab continuity + flip validator blocking → ④ portal blend +
constants → ⑤ carve deletion post-gate. DESIGN APPROVED 2026-06-11 (validator-first,
with distribution-report adjustment; Phase-4 inherits the carve's covered-section
visual role explicitly).

### Slice ① — DONE (2026-06-11): validator baseline, report-only
376/376 drivable tunnel road-copies CLEAN: 53,026 samples @2 m, every floor gap ≤ 0.05 m,
zero no-floor samples, zero NaN elevations/degenerate roads. Floor model mirrors runtime
deck rules (MIN_SEG_LENGTH drops only 4 segments region-wide). Honest read: centerline
floors are guaranteed by construction (own-segment decks) — the baseline's value is
data-integrity proof + an EMPTY centerline worklist for ③; residual risks are lateral
(width-shrunk decks at crowded corridors) + joint wedges, deferred to the gate drive.
Proposed ③ blocking tolerance from data: 0.3 m. Full per-road table: /tmp/floor_baseline.json
(validator script: /tmp/floorValidator.mjs — moves into worldBuilder at slice ③).
**→ Critical path confirmed: slice ② trench authoring (entry is the only blocker).**

### Slice ② — DONE (2026-06-11): trenches authored into the elevation grid
- New `worldBuilder/terrain/trenchAuthor.js`: global corridors (218 drivable tunnel roads
  → 685 segments) built once pre-tile-loop; carved per tile as the LAST grid mutation
  (post-drape, pre-payload). Water-sunk cells guarded (loud skip).
- **FORBIDDEN-BAND rule** (design refinement): per corridor cell — open to trench floor
  OR real roof ≥ ROOF_CLEARANCE 5 m (= CARVE_COVER, visual cull and physics agree);
  in-between cut to roadY − 0.15. Portal cliff forms where ACTUAL cover reaches 5 m —
  intrinsically past the lip (replaces fixed PORTAL_EXT + fragile profile classification).
- Fast-bake proof (16_33154_24471, Ronda de Dalt/Sant Gervasi): 29 cells cut (max 5.1 m),
  **adjacent drivable surface roads depression = 0.000 m** (worst non-drivable: a footway
  over the mouth, 0.34 m, visual-only); rendered screenshot: car IN the trench below
  grade, terrain walls both sides, holding on the descent.
- Full re-bake: clean, 372 s, 53 tiles cut. Region validator: **376/376 still CLEAN, all
  53,026 floor gaps ≤ 0.05 m, zero holes.** Cover bands: 16,077 open / 35,439 roofed /
  1,510 forbidden-band samples (2.8%, short transition stretches at portal lips —
  bilinear wall-slope cells; trunk ≈ 6 car-blocking samples region-wide). → slice ④
  portal blend is the designated fix; judge feel at the gate drive first.

**Slice ③ next (reduced scope):** validator into the bake (commit-blocking @0.3 m,
+ forbidden-band check), slab joint-overlap. Then ④ portal blend + constants kill.

### Slice ② addendum — OPTION L pivot (approved + implemented 2026-06-11)
Gate attempt on the sealed-roof design hit the GEOMETRIC IMPOSSIBILITY: a heightfield
(single-valued y(x,z)) cannot open its own cliff face — the portal-face band WAS that
wall; no car can enter a covered section. Option L approved: corridors carved open
END-TO-END; crossing streets flagged `crossesTrench` → deck colliders (bridge mechanism);
Phase 4 adds the physics-free visual roof. Also fixed en route: TRENCH_MARGIN 1.5→4.0 m
(sub-cell margin caused car-blocking sawtooth wedges INSIDE the roadway) and the legacy
visual carve DISABLED (mouth/corridor culling punched see-through holes in the already-
trenched mesh — slice ⑤ item pulled forward).
**Full-bake numbers:** corridors open end-to-end (52,083 open / 668 residual band /
275 roof samples — residuals = out-of-scope layer-0 oddities + skirt bilinear);
floors 376/376 CLEAN ≤0.05 m zero holes; 434 crossing roads flagged (565 tile-copies);
inverse clause: 14,037 floating samples, 32 deckless — all on 2 roads over NATIVE
terrain/water dips (pre-existing class, NOT trench-caused; slice ③'s blocking inverse
clause must scope to trench-footprint depressions). Flag survives 4 whitelist layers
(deepCloneRoad, tileSplit ×2, payload map, convertToBinary) — all patched.
**AWAITING: the slice-② drive — descend, drive the FULL corridor under crossing
streets, exit the far ramp.**

**Tasks:**
- [ ] READ-ONLY: confirm (from Phase 0 map) the current emergent tunnel path and every
      absolute-Y constant (wall tops, ceiling, floor, portal heights, −6 trench,
      deck-gate clause, retaining/approach walls).
- [ ] Replace emergent generation: where OSM says "tunnel," BUILD a clean tunnel as a
      deliberate structure placed into smooth terrain:
      - Proper portal (clean entry/exit, no cutout boolean seams).
      - Smooth descent profile.
      - **Guaranteed-continuous FLOOR** — the `drivable-surface-implies-floor` invariant.
        A drivable surface MUST have a floor under it. This is what stops the car falling.
- [ ] Convert remaining absolute-Y tunnel constants to terrain-relative (same absolute→
      relative move used throughout, now on smooth ground so it's clean).
- [ ] Add a commit-blocking assert for the drivable-surface-implies-floor invariant
      (fail-fast, per the codebase's "loud not silent-wrong" discipline).
- [ ] Address the cross-tile corridor cut the validator previously flagged.

**DRIVE-TEST GATE (user confirms ON SCREEN):**
- Drive INTO a tunnel and OUT the other side WITHOUT falling.
- Portals look clean — NO cutouts.
- It reads as a real tunnel.
- **This is the thing you came here for, ~20 rounds ago.**

**Status:** ✅ DONE (2026-06-30). Trench resolved at the source — bake-side wide smoothstep batter
(trenchAuthor BATTER_WIDTH 14 + smoothstep) gives a clean graded cutting; frontend retaining-wall
dressing removed (the terrain IS the trench). User confirmed on screen ("i like it"). Broken/mangled
ramp roads now dropped at the bake (precise `flattenedShortTunnel && !flat` flag). Lane lines now
render on daylighted trench roads. Slice ③ floor validator is wired as a REPORT-mode sentinel; the
flip to commit-blocking is gated on fixing 5 layer-1 trench-corridor roads with small floor gaps
(72 samples region-wide) — a recorded follow-up.

---

## PHASE 4 — Polish Pass (only what's left, only what's visible)

**Goal:** Finish cosmetic items remaining after smooth terrain + authored tunnels.
Small, scoped, visible. NOT a rewrite.

**Tasks:**
- [ ] Portal aesthetics + the visual transition into/out of tunnels.
- [ ] Real-bridge appearance (the genuine bridges, now correctly detected).
- [ ] Any remaining seams / cosmetic relief artifacts.
- [ ] Whatever else is visibly off after Phases 1–3 — list and triage.

**DRIVE-TEST GATE (user confirms ON SCREEN):**
- Looks and drives like the "vibe of Barcelona": hills feel like hills, flat where flat,
  clean tunnels, no breaking transitions.

**Status:** ⬜ not started

---

## Open Tuning Decisions (resolve by DRIVING, not upfront)
- **Eixample/flat city:** dead-flat plane vs gently-rolling-but-smooth? (lean: near-flat)
- **Montjuïc/hills:** real ~170m height vs stylized-readable? (lean: real height, smoothed)
- Set Phase 1 knob defaults to sane values, then tune on the road.

## Status Legend
⬜ not started · 🟡 in progress · ✅ done (drive-test gate confirmed on screen)

---

## ⚠ FINDINGS REPORT — surface roads buried in terrain (2026-08-25, OPEN)

**Symptom (user, night drive on Gran Via):** "road lines like crosswalks or side edge lines are
coming above base DEM terrain, same goes for the road in some places."

**This is NOT the P2-08 decal bug.** That one was decal-relative-to-road and is fixed. This is
road-relative-to-TERRAIN, one level down the stack.

**The two paths disagree, and one of them already documents the disagreement:**

| path | where the road surface is |
|---|---|
| query / placement (`tileManager.js:3379`) | `Math.max(roadResult.height, terrainVal)` — **clamped up to terrain** |
| rendered ribbon (`roadRenderer.js`) | the baked road elevation, **no terrain term anywhere** |

`getSurfaceHeightAt` carries the comment *"Non-tunnel road: never below terrain (aligns visually, no
sinking, slopes still work)"* — an explicit admission that baked road elevation CAN fall below
terrain. The clamp makes gameplay placement safe and leaves the visuals alone, so where terrain wins,
the asphalt is swallowed and only the paint — which sits `groundLift` (4.5-5 cm) above the road deck
— still pokes out. That is exactly "lines above the terrain, and the road itself in some places".

**Ruled out during diagnosis:**
- Per-tile vs global elevation baseline — retired by D-12; both use `getWorldElevationOffset()`.
- Terrain downsample breaking the conform guarantee — `CONFIG.TERRAIN_MAX_GRID` (128) matches
  `terrainBaker.js` `GRID_SIZE` (128), so `useBaked` holds and the mesh equals the DEM grid.
- DEM sampling being nearest-pixel — `demLoader.sampleElevation` is bilinear and noData-aware.

**Not yet established:** WHY the baked road elevation falls below the terrain grid at the same (x,z)
when both derive from the same sampler. Candidates, in order of suspicion: the selective terrain
smoothing pass running after road elevations were sampled; road-point elevations coming from
simplified//junction-snapped polylines rather than the drawn vertex positions; triangulated terrain
vs bilinear DEM between grid points (smallest effect — the 128 grid is ~3.9 m against ~30 m DEM
pixels, so this is likely sub-centimetre).

**Fix directions (NOT chosen — this needs a decision, and 1 needs a re-bake):**
1. **Bake-side conform** — carve terrain down to the carriageway where it exceeds road height, the
   same shape as the existing tunnel-corridor carve (`terrainBaker.js:163`). Matches the spec's
   "Roads conform to terrain; no floating/buried surface roads on slopes". **Requires a full re-bake.**
2. **Render-side clamp** — build the ribbon at `max(roadY, terrainY)`, mirroring the query. No
   re-bake, but the road would ride terrain noise and stop being a smooth ribbon.
3. **Root fix** — make baked road elevation equal the terrain grid value at the same point, which is
   what the baker already claims it does.

**Do not "fix" this with depth bias.** Same trap as P2-08 — see that task's warning.

**Instrument (2026-08-25):** `?debug=roadfit` (`frontend/src/ui/roadFitProbe.js`) walks every resident
SURFACE road (bridges/tunnels excluded — they are meant to be off the ground), compares
`roadDeckY + BAKED_SURFACE_ABOVE_ROAD_Y` against `getTerrainHeightAt` at the same point, and reports
the buried fraction, p50/p95/worst burial depth, the worst points with coordinates and way ids, and
**mean terrain slope of the buried set vs the clean set** — which is the discriminator between the
candidate causes. If burial tracks slope, suspicion falls on the smoothing pass and the road-drape
ordering; if it does not, the cause is upstream of terrain steepness (simplified/junction-snapped
polylines being the next suspect). Measurement only.

### Measured, 2026-08-25 — `?debug=roadfit`, 12,928 surface-road points over 11 tiles

```
BURIED  1133 of 12928 (8.8%)
spread  p50 -0.079m   p95 +3.241m   worst +9.615m   best -5.088m
worst   9.615m slope 2.438 · 9.598m slope 0.000 · 9.545m slope 0.000 · 9.512m slope 0.000 ...
```

**The systematic co-planarity theory is DEAD.** p50 is **-0.079 m** — the typical surface road sits
8 cm above terrain, exactly as designed. There is no global elevation-model error; there is a TAIL.

**The tail is metres, not centimetres, and it clusters.** Worst +9.6 m buried, best -5.1 m floating,
p95 +3.2 m. The worst points fall on a handful of ways (`20353556`, `62126122`, `902208621/2`) at two
locations. A road 9.6 m inside a hill is not paint poking through a bump — it is a road that should
not be at the surface at all. **Leading hypothesis: untagged tunnels.** The probe excludes only roads
OSM has TAGGED `tunnel`/`bridge`/`layer`; an untagged one is indistinguishable from a buried surface
road, and would present exactly like this.

⚠ **The first run's "BURIAL TRACKS SLOPE (hills)" headline was an instrument artifact and must not be
quoted.** Seven of its eight worst points reported slope exactly 0.000 — flat ground — contradicting
its own aggregate. Cause: the slope probe sampled ±2 m against a ~3.9 m terrain grid, so the cross
often landed inside one cell and every corner returned the same height. Radius is now 6 m. **The
aggregate slope comparison from that run is void; re-measure before drawing any hills conclusion.**

**Two bugs, one number** — the probe now bands them, because a fix aimed at the wrong one is wasted:
- **shallow (≤0.5 m)** — co-planarity; this is the visible paint-through-asphalt report
- **deep (>2 m)** — a data defect; belongs to the OSM repair layer as class **V1/V5**, not to a
  render-side clamp or a terrain carve

**This is also the repair layer's first census data**, arriving before P-R1 — evidence that the
defect classes in `osm-repair-layer.md` are real and countable rather than hypothetical.

### Hotspot A checked on the ground, 2026-08-25 — NEGATIVE

world (4578, 3262) / 41.37930, 2.16979 / way 902208621, buried 9.615 m. **No tunnel, no underpass,
and a street with no plausible need for either.** So "untagged tunnel" does NOT explain that case,
and hand-picking further hotspots is guessing.

**Instrument extended instead:** `?debug=roadfit` now breaks the DEEP (>2 m) band down **by road
class** (`highwayType`), as a RATE per class rather than a raw count — 4 deep points out of 40
matters more than 40 out of 4000 — with the worst instance, way id and street name per class.

**The discriminator:** grade separation only exists on motorway / trunk / primary. So —
- deep burial concentrated on those classes → **missing structure** is still live (repair V1/M1)
- deep burial spread across residential → **bad elevation data** instead (repair V5), and the
  untagged-tunnel story is dead for the whole tail, not just for hotspot A

Spawn moved to **Ronda de Dalt (B-20)**, a real expressway with trenches and portals, so the probe
samples motorway/trunk tiles and the table has something to say.

### Tunnel sites, from the baked data (2026-08-25)

Hand-picking spots was failing, so all 427 baked tiles were scanned for roads with `tunnel=true` on
motorway/trunk/primary. The real tunnel systems, by tile span:

| class | tiles | centre | name |
|---|---|---|---|
| trunk | 25 | 41.39123, 2.20001 | **Ronda Litoral** — largest system in the bake |
| trunk | 14 | 41.41184, 2.20001 | Gran Via de les Corts Catalanes |
| primary | 13 | 41.37063, 2.12860 | Ronda del Mig |
| trunk | 8 | 41.40772, 2.12311 | Ronda de Dalt |
| primary | 6 | 41.40360, 2.18903 | **Túnel Glòries** — named AND tagged, least ambiguous |
| motorway | 2 | 41.35826, 2.12860 | Autovia de Castelldefels |

**Spawn set to Túnel Glòries**, to be inspected in drone mode (`?mode=fly`). The question is whether
the tunnel mouth reads as a mouth, or whether the road vanishes into untouched terrain with no portal
geometry — which is the `V1 tunnel-discontinuity` defect the repair layer is designed to catch.

**Note this list is TAGGED tunnels only.** It says nothing about untagged ones, which is the separate
hypothesis the roadfit deep band is testing.
