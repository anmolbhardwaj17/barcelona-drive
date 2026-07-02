# Authored Tunnels — Phase 3 Design (Step 2)

> Status: **DESIGN FOR REVIEW** — no implementation yet. Written against the Phase-3
> Step-1 re-diagnosis (tracker), NOT the pre-rework fall-through analysis.
> Companion docs: [terrain-tunnel-rework-plan.md](terrain-tunnel-rework-plan.md) (tracker),
> [tunnel-fix-playbook.md](tunnel-fix-playbook.md) (contract model — symptom history),
> [vertical-model-foundation-spec.md](vertical-model-foundation-spec.md) (invariants).

## The reality this designs against (Step-1 facts)

- The heightfield is **sealed everywhere**: the old carve culled mesh triangles but never
  wrote the elevation grid. Car floats over visually-open trenches on invisible ground;
  it can never descend. The original fall-through is dead.
- Buried tunnel decks/walls exist and are **correctly placed** (layer·6 m below the
  smoothed DEM, draped via `p[3]`). Interior floor **continuity** is unproven.
- A heightfield can represent an open **trench** (depressed cells) but never a
  hole-with-roof. This is a feature: the street above a covered tunnel keeps real ground.
- Surviving absolute-Y constants: `PORTAL_HEIGHT = 0` (tunnelRenderer.js:42),
  `RETAINING_LIP_THRESHOLD = −0.05` (tileManager.js:663).

## Architecture: the open/covered split

Every drivable tunnel road decomposes, per point, by **cover depth**
`cover(i) = gridY(x_i, z_i) − roadY(i)` (both in raw bake elevation space):

| Segment class | Test | Ground truth for the car |
|---|---|---|
| **OPEN-CUT** (approach ramp / trench) | `cover < COVER_MIN` (default **4.5 m** = TUNNEL_CLEARANCE) | the **grid itself** — trench authored into the elevation grid |
| **COVERED** (true tunnel) | `cover ≥ COVER_MIN` | **authored deck slabs** under the unchanged grid (roof = drivable street above) |

The classification is computed at bake from final road profiles — no new tags, no
heuristics on terrain shape (the profile is already layer + RampResolver + DEM drape).

---

## 1. Open-cut trenches — author INTO the elevation grid

**Where it lives:** `buildRegion.js`, a new per-tile pass `authorTrenches(data, tileRoadsFinal,
crossTileTrenches)` running AFTER the road drape finalizes (`:1217`) and BEFORE payload
assembly (`:1238`). This is the Phase-1 chokepoint discipline at the tile-grid level: the
mutated grid feeds the visual terrain mesh, the physics heightfield, runtime
`getElevationAt` (vegetation/greens/buildings), and the baked terrain mesh — every
consumer inherits the trench with zero new plumbing.

**Implementation refinement (slice ②, 2026-06-11) — the FORBIDDEN-BAND rule:** the
original profile-threshold classification (open-cut = profile in (−4.5, −0.05)) left
transition cells sealed ~2 m over the road on slopes (point-DEM vs bilinear-grid
divergence). Replaced with a per-cell rule that needs no classification: a corridor cell
must be either OPEN to the trench floor or a REAL ROOF ≥ `ROOF_CLEARANCE` above the road —
anything in between is cut to the floor. `ROOF_CLEARANCE = 5.0` = terrainBaker
`CARVE_COVER`, so the legacy visual cull and the physics trench agree exactly (and the
cull becomes a no-op over trenched cells). The portal cliff therefore forms exactly where
ACTUAL grid cover reaches 5 m — intrinsically past the lip, inside the covered section
(§4's placement requirement satisfied by construction; the fixed PORTAL_EXT is gone).

**Cross-section profile** (per grid cell within the corridor):
- Corridor half-width `halfW = roadWidth/2 + TRENCH_MARGIN` (default **1.5 m**, matching
  the old APPROACH_RAMP_CUT_MARGIN).
- Floor: cells whose center is within `halfW` of the road centerline →
  `gridY = min(gridY, roadFloorY)` where `roadFloorY = roadY(arc-projected) − TRENCH_FLOOR_BELOW_ROAD`
  (default **0.15 m**: the deck slab sits proud of the grid so wheels ride the slab where
  both exist, and the grid can never poke through the deck).
- Walls: **one-cell transition** (cell size ≈ 3.6 m) from floor to natural grid — i.e.
  near-vertical at heightfield resolution. No sloped batter in v1; the existing
  retaining-wall visuals dress the faces. `min()` ensures we only ever cut down, never
  raise terrain.
- Along-track: floor Y tracks the road's final `p[3]` profile by projecting each cell
  center onto the road polyline (arc-length interpolation between points). The descent
  shape itself is **unchanged: RampResolver Case-B smoothstep stays** (Phase-0/2 verdict:
  architectural, KEEP). We are not redesigning the profile, only making the ground obey it.
- Extent: trench applies where the point class is OPEN-CUT, **plus one extra cell
  (~4 m) past the open→covered transition** (see §4, portal face).

**Cross-tile:** reuse the existing Phase-B.2 pre-pass shape: extend
`buildCrossTileMetadata` to emit `trench` features (corridor polyline + widths + the
already-final road profile) for corridors crossing tile edges, keyed by `affectsTile` —
both tiles depress the same cells from the same geometry, so edges stay seamless (same
argument as the global DEM pre-smooth). The known diagonal-crossing limitation (G-47 note)
carries over unchanged — recorded, not solved here.

**Water guard:** trench authoring runs after the water-sink; assert no trench cell
overlaps a sunk water cell (loud bake error) — tunnels under water bodies are out of
scope v1.

## 2. Covered sections — OPTION L: daylight the physics, roof the visuals (APPROVED 2026-06-11)

> **SUPERSEDES the original §2 ("slabs under untouched grid") and §4's entry mechanics.**
> **The geometric impossibility finding:** a heightfield is a single-valued surface
> y(x,z) — it cannot have an opening in its own cliff face. Any "sealed roof" chain ends
> in a terrain wall ACROSS the roadway at the portal; the car can never drive under it.
> This is definitional, not tunable (measured: the portal-face forbidden band was exactly
> this wall). Option I (sub-heightfield decomposition with real holes) was considered and
> rejected: its sub-edge seams re-import the ray-leak failure class to preserve a roof
> whose PHYSICAL existence buys nothing deck colliders don't already provide.

- **The corridor is carved open END-TO-END** (covered sections included) — the grid is
  the floor everywhere; the floor invariant becomes STRUCTURAL (continuous real ground).
- **Streets crossing above** a corridor are flagged at bake (`crossesTrench`,
  trenchAuthor.flagTrenchCrossings: within corridor halfW + 5.5 m skirt pad, ≥ 2 m above
  the corridor road) and ride **deck colliders** via the existing structural-flags gate —
  they are, structurally, bridges over a trench. Their visuals already float correctly:
  road drape samples the DEM, NOT the trenched grid (verified).
- **Phase 4 adds the visual roof**: a physics-free enclosure mesh (wheel rays point down;
  the chassis never reaches a ceiling). Until then covered tunnels read as open trenches.
- Flag plumbing (hard-won): the flag must survive FOUR whitelists — deepCloneRoad,
  tileSplit (clip + noClip), payload.roads map, convertToBinary header — plus the parser.

### (superseded original §2 below, kept for the record)
## 2-old. Covered sections — slabs under untouched grid

- Grid: **untouched**. The street above keeps real, drivable ground (previously
  impossible; now automatic).
- Floor: the existing per-segment deck boxes (tileManager, structural-flag gate) remain
  the physics floor; their Y already derives from `p[3]` via `toNormalizedRoadY` — same
  frame as everything else. **Continuity rules added at creation:**
  - each segment's box extends `SLAB_JOINT_OVERLAP = 0.5 m` past both segment endpoints
    along the road direction (joints overlap instead of butting);
  - bake-time validation (§3) enforces max floor gap; no runtime self-healing.
- Walls: keep current per-segment wall colliders (they exist and are placed correctly per
  Step 1). Simple mode (`ENABLE_TUNNEL_VISUALS=false`, today's mode) renders deck floor
  only — **design target v1 is simple mode**; the full enclosure (walls/ceiling/LED
  visuals) stays behind the existing flag as the later cosmetic pass (Phase 4).
- Ceiling: none in v1 physics (nothing needs it: the car is under the grid; the grid is
  the street's floor, not the tunnel's ceiling collider — chassis can't reach it).

## 3. THE INVARIANT — drivable-surface-implies-floor (commit-blocking)

New bake-time validator `validateTunnelFloors(tilePayloads)` run before serialization:

- Walk every **drivable** tunnel road (the DRIVABLE_TUNNEL_TYPES whitelist), sampling the
  polyline every **2 m** of arc length.
- At each sample, the floor must exist within tolerance:
  - OPEN-CUT sample → trench grid floor: `|gridY(sample) − (roadY − TRENCH_FLOOR_BELOW_ROAD)| ≤ 0.3 m`;
  - COVERED sample → a deck slab whose XY footprint contains the sample and whose top is
    within `[roadY − 0.3, roadY + 0.1]`.
- Inverse check at covered sections: the grid over every covered sample is **unchanged**
  by trench authoring (`gridY == pre-trench gridY`) — the street above keeps its ground.
- ANY violation → **fail the bake loudly** (throw; non-zero exit; report
  `tile / roadId / arc-position / class / expected-vs-found Y` for every violation).
  No warning mode in the final state — fail-fast per the codebase discipline
  (G-48/G-51 lineage). During bring-up the validator runs in REPORT mode (see sequencing)
  to establish the baseline, then flips to blocking and stays.

This is the keystone: after it flips, a tunnel floor cannot silently regress — a bad bake
never ships.

## 4. The portal face — the one-cell cliff

The open→covered transition creates a grid cliff (floor-depth cell → surface cell within
one ~3.6 m cell). Design:

- **Placement:** the trench extends ONE cell past the transition, under the roof, so the
  cliff face sits INSIDE the covered section. Wheels are on the deck slab (proud of the
  trench floor by 0.15 m) before the surface cells rise — the rising face is behind/above
  the car's ray contact, never under it.
- **Floor blend:** across the last 2 trench cells before the cliff, trench floor eases to
  `slabTopY − 0.15` exactly (no step between grid floor and first slab).
- **Entry test:** wheels approaching the portal ride: grid trench floor → (overlap zone:
  slab proud by 0.15, rays pick the higher slab — a 15 cm step DOWN onto… no: slab is
  HIGHER; rays hit slab first — smooth) → slab under roof. No ride-up surface exists.
- **Portal visual:** portal frame + face placed **terrain-relatively**:
  `portalTop = getGroundY(portalX, portalZ)` (the frame covers the visible cliff face).
  **`PORTAL_HEIGHT = 0` dies here.** Likewise `RETAINING_LIP_THRESHOLD` becomes
  terrain-relative: `(roadY − getGroundY(x, z)) < −0.05` — same comparison, honest frame.
- The old visual mouth/corridor triangle-culling in `terrainBaker.js` becomes redundant
  for trenches (the grid now SHOWS the trench natively in the visual mesh, built from the
  same grid). Kill-list, not day-1: keep the cull initially, drive-compare, then delete
  (Phase-2 discipline: cope machinery dies only after the gate proves it dead).

## 5. Scope & sequence

**Proving set (v1):** the **174 trunk** drivable tunnel roads (Ronda de Dalt corridor) —
long, connected, the user-visible case. Then **primary (69) + motorway (23)**, then the
remaining drivables (residential etc.). The authoring pass itself is generic (it runs on
whatever matches the whitelist); "proving set" means validation + drive-testing focus
order, not special-cased code.

**Explicitly OUT of v1 (recorded follow-ups):**
- the **41 layer-0 tunnel-tagged** oddities → treated as surface roads (current
  behavior), follow-up: data triage;
- the **~146 Case-C both-surface underpasses** (currently flattened by RampResolver) →
  unchanged in v1; follow-up: valley profile (0→−6→0) + the same authoring;
- tunnels under water bodies (asserted absent in v1);
- full enclosure visuals (Phase 4); cross-tile diagonal portal corridors (pre-existing
  G-47 note).

**Old carve:** keep triangle-culling during bring-up (visual parity reference), delete
after the v1 gate passes — trench-in-grid replaces the corridor cull; mouth-hole punching
is replaced by the authored portal face. `createTerrainTrimesh` stays dormant (already).
**Explicit hand-off:** the carve's COVERED-SECTION visual role (what the player sees of
the tunnel interior/void under the roof) transfers to **Phase 4 (enclosure)** — Phase 4
inherits that question deliberately; it is not solved nor accidentally dropped here.

**Absolute-Y kill-list retired by this design:** `PORTAL_HEIGHT = 0`,
`RETAINING_LIP_THRESHOLD = −0.05` (→ terrain-relative). After these, grep-level audit for
any remaining tunnel-path absolute-Y (tunnelRenderer `eM < −0.5` checks are already
normalized-frame — verify, don't assume).

**Implementation slices (sequencing APPROVED 2026-06-11, with one adjustment to ①):**
1. **VALIDATOR FIRST, report-only** — walk the CURRENT bake, print the floor-gap
   baseline for all 376 drivables. Cheap, read-only, and it measures the problem before
   we operate (G-48: instrument before fixing). It also tells us whether "decks mostly
   correct" holds across all 376, not just the probed tile.
   **ADJUSTMENT (approved):** report-only mode emits the measured floor-gap DISTRIBUTION
   (per-sample distance to nearest floor beneath, histogrammed per tunnel + region-wide),
   NOT pass/fail against a preset tolerance — the blocking tolerance is picked FROM this
   data before slice ③ flips it on. The report triages: FULL-HOLES (no floor at any
   sample), SOME-HOLES, GAPPED (floored but gaps), CLEAN — that triage is ③'s worklist.

   **① BASELINE RESULT (2026-06-11, current bake):** 376/376 road-copies CLEAN.
   53,026 samples @2 m: every gap ≤ 0.05 m, zero NO-FLOOR samples, zero NaN elevations,
   zero degenerate roads; grid was the best floor at 1,292 samples (the at-grade ramp
   portions). Floor model mirrors the runtime deck rules (finite guard, MIN_SEG_LENGTH
   0.2 — drops only 4 segments region-wide, all covered by neighbors; width-shrink near
   crowding can't expose the CENTERLINE). Honest caveat: centerline samples are floored
   by their own road's deck **by construction** — the baseline's real findings are
   (a) elevation/geometry data integrity is perfect across all 376, (b) slice ③'s
   continuity worklist is EMPTY for centerlines, (c) residual risks are LATERAL
   (width-shrunk decks near crowded corridors, min halfW 1.5 m) and joint wedges at
   sharp angles — both deferred to the gate drive, not pre-fixed.
   **Proposed blocking tolerance for ③ (from data): 0.3 m** (6× headroom over the
   measured 0.05 m worst case; tight enough to catch any real regression).
2. **Trench authoring** (+ cross-tile pre-pass extension) — the big behavioral change;
   immediately drive-testable: descend into an open cut on real ground.
3. **Slab continuity** (joint overlap + fixes for whatever slice-1 found) → flip
   validator to **commit-blocking**.
4. **Portal face blend + terrain-relative portal/retaining constants.**
5. **Carve deletion + doc updates** (after the gate).

Rationale: slice 1 builds the measuring instrument the other slices are judged by, and
de-risks the "decks are mostly correct" assumption before we depend on it. Slices 2–4
each end in a drivable state; the gate is run after 4, deletion after the gate.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Trench cells under ADJACENT surface roads (parallel street beside a ramp) get depressed | corridor test is distance-to-THIS-road's centerline only; validator inverse-check fails loudly if any non-tunnel road's drape point loses ground |
| Heightfield bilinear slope at one-cell walls lets wheels clip the wall face | walls are climbable at low speed in v1 (accepted); retaining-wall colliders already line major trenches |
| Cross-tile trench seam mismatch | same-geometry-both-sides rule (pre-pass features), validator samples across edges |
| Case-C flattened underpasses now sit in authored-looking world but stay sealed | unchanged from today; recorded follow-up; whitelist excludes them from the validator so the bake isn't blocked by known-deferred cases |
| 128-grid (~3.6 m) too coarse for narrow residential tunnel trenches | v1 proves on trunk (wide); if narrow trenches alias badly, options recorded: per-corridor grid snap or accept visual roughness (physics floor is the slab anyway) |
| Validator slows the bake | 376 roads × ~2 m sampling ≈ trivial vs the 620 s bake |

## 7. DRIVE-TEST GATE (implementation acceptance — user confirms ON SCREEN)

Drive INTO a Ronda de Dalt tunnel and OUT the other side:
- descend the open-cut trench on real ground (no floating over the trench),
- pass under the portal with no ride-up on the cliff and no bump at the slab handoff,
- ride the slabs through the covered section (no falling, ever),
- exit up the far ramp,
- then drive the SURFACE STREET ABOVE the covered section — real ground, no holes,
- FPS holds; bake validator green (commit-blocking by then).
