# Vertical-Model Foundation Spec (Barcelona Drive)

**Status:** DESIGN — review and lock before any implementation.
**Supersedes the relevant assumptions in:** tunnel-fix-playbook.md (the flat-world coordinate assumptions; the tunnel fall-through is resolved here as a consequence, not patched directly).
**Decision owner:** Anmol. **This doc is written to be reviewed on paper first** — a coordinate-system rebuild half-built is the hardest thing in the codebase to reason about, so it is designed and locked before code.

---

## 0. Why this exists

The tunnel work surfaced that tunnels are a *symptom*. The root is that the world has no honest vertical model:

1. **Unit-scale mismatch (the foundation crack).** Horizontal XZ is stretched Web Mercator — `1/cos(41.35°) = 1.3321` world units per real metre — while Y is real metres (1:1). Confirmed in code: `mercatorToWorld` applies no `cos(lat)`; Y is raw DEM/layer metres. They mix at `tileManager.js:485-486` (deck-box pitch `atan2(realΔY, stretchedΔXZ)`) and in terrain normals. Effect once terrain has relief: **every grade renders/drives ~25% too shallow** (a real 12% ramp drives as ~9%). Invisible today only because the flat world has no slopes.
2. **DEM is off by accident, not design.** `cleanRoadPipeline: true` silently forces `phase1Pure2D`, which gates out DEM. Config and docs both *intend* DEM on. The DEM bake path exists and ran (at sea level, where it had no visible effect). So DEM-on is enabling a dormant, intended feature — a **tradeoff, not a reopened wound.**
3. **Scattered unit compensation (the production-grade trap).** Exactly one place converts to real metres (`RampResolver` Case-C, via `cos(lat)`). One place uses the *wrong* latitude (`buildingRenderer.js:216`, `cos(28.5°)` — Delhi, left from the project's origin, texture-only). Everything else uses stretched units uncorrected. The game and the validator agree *with each other* because they share the same wrong assumption — so nothing looks broken.

**The earlier ramp grades were in the wrong unit.** The 43% / 55% stubs were *rendered* (stretched) grades; true grades are ~1.3321× higher (≈58% / 74%). Any steep-ramp policy must use real-metre grades.

---

## 1. The decision (LOCKED)

**Unit convention: UNSTRETCH-X.** Make horizontal real metres too, so **1 world unit = 1 real metre on every axis, everywhere.**

Why this and not the alternatives:
- **Stretch-Y** (scale Y to match stretched XZ): runtime-only, no re-bake — but height permanently stops meaning metres (1 Y unit = 0.751m), a cognitive tax forever, plus gravity must be de-tuned. Its only advantage was avoiding a re-bake. **Re-bakes are explicitly acceptable here, so that advantage is void.** Rejected.
- **Roadmap Option B** (leave projection, scale authored XZ constants only): fixes the "car too narrow" symptom but NOT the slope-mixing math. A partial fix that looks complete — the codebase's signature failure mode. Rejected.
- **Unstretch-X**: height stays honest real metres; the goal "1 unit = 1 metre everywhere" becomes literally true; the only cost is a re-bake (acceptable) and a bounded constant migration. **Chosen.**

### 1.1 The unit invariant (the law)

> **1 world unit = 1 real metre on the X, Y, and Z axes, enforced at exactly one point (the projection), with zero downstream unit corrections anywhere in the codebase.**

This is the spec's backbone. "Production-grade" here means: not a clever correction factor, but the *absence* of any correction factor, because the coordinate space is honest at the source. Every consumer reads world units that are already real metres.

### 1.2 Latitude caveat (must be designed for, not ignored)

Web Mercator scale varies with latitude: ~1.3321 at 41.358° to ~1.3339 at 41.413° across the bbox. A single-factor unstretch is itself an approximation. Decide explicitly in Stage 1: either (a) accept a single `cos(ORIGIN_LAT)` factor and document the residual sub-0.2% error as acceptable, or (b) apply per-latitude correction in projection. **Default: (a)** — the error is below perceptible and a single factor keeps the invariant simple. Document the choice as an ADR.

---

## 2. Sequencing (LOCKED) — staged, each stage proven before the next

The staging is not for speed. It is for **isolation of failure**: each layer is proven correct in isolation so a future bug is never ambiguous about which foundation it sits on. This is what "works long-term" means mechanically.

```
Stage 1  Unit-fix          (in the still-FLAT world — no slopes to corrupt)
   ↓     [GATE: coordinates provably honest]
Stage 2  DEM-on            (onto proven-honest coordinates — relief at true grade)
   ↓     [GATE: real terrain provably correct]
Stage 3  Runtime Y cleanup (absolute-Y → terrain-relative; normalization-fork unified)
   ↓     [GATE: tunnel fall-through dissolved as a consequence]
Done
```

---

## 3. Stage 1 — Unit-fix (flat world)

**Status: COMPLETE (2026-06-05).** Unstretch-X applied at all projection paths (forward ×cos / inverse ÷cos), authored car constants scaled by provenance, two+ unit-correction islands purged, `tunnelTerrainCarver.js` deleted, full region re-baked; validator reads real grades and the cross-path verifier shows all feature classes (terrain/roads/buildings/trees) aligned at real-metre scale. Note: the inventory's "six paths" undercounted — bake-side inline conversions (point features, tile-assignment round-trips) were also fixed (see ADR D-11 and changelog). FEEL GATE (car drive feel) remains for the owner.

**Goal:** establish the unit invariant. Fix the projection, scale authored XZ constants to preserve real-world size, and **purge every downstream unit compensation** so the invariant holds with no exceptions.

**Why the flat world is the right place:** with no relief, you can prove the coordinate space is honest *without slopes confusing the picture*. When this stage is green, units are never again a suspect.

### Tasks

1. **Projection — apply `cos(ORIGIN_LAT)` at ALL SIX conversion points (atomic; partial = split world).**
   World XZ becomes real metres only if *every* Mercator→world conversion gets the same factor. The inventory found six independent paths; missing one displaces a whole feature class (e.g. trees 33% off the roads they line). All six, together:
   1. `frontend/src/projection.js:34-37` `mercatorToWorld` (the canonical fix point).
   2. `backend/projection.js:29` `mercatorToWorld` (the entire bake side — terrainBaker, buildingNormalize, pbfHighways, pbfPointFeatures).
   3. `frontend/src/map/tileParserWorker.js:646` `mercatorToWorld` (runtime road-triple parse).
   4. `frontend/src/workers/vegetationWorker.js:15-46` (full inlined projection copy).
   5. `frontend/src/workers/buildingWorker.js:48-55` (inlined origin/Mercator).
   6. `frontend/src/map/fastElevation.js:19,39-40` (partial inline).
   Confirm `latLonToMercator` is left untouched (textbook Web Mercator). Leave the `1/cos(lat)` in `projection.js:57` / `backend/projection.js:68` — that is legitimate slippy-tile-y math, NOT a stretch compensation.

2. **Scale authored XZ constants BY PROVENANCE — not blanket.** *(This corrects the original blanket-×0.751 error: a real-metre-authored constant applied as a world-unit offset self-corrects for free under unstretch; scaling it would re-break it. Only eye-tuned-against-stretched constants need scaling.)*
   - **Real-metre-authored → DO NOT scale (self-correct):** `BCN_DIMS` (Norma 8.2-IC documented metres — all of `barcelona-constants.js`), road width (`buildRegion.js:92,100` lanes×3.5 + MIN/MAX clamps), `terrainBaker.js` margins (mouth/trench/cut, all real-metre struct), tunnel struct widths authored in metres. These become correct automatically — touching them breaks them.
   - **Eye-tuned-against-stretched → SCALE ×0.751 (or re-author to real metres):** the **car as one rigid object** — chassis box H dims (`carPhysics.js:83` 0.70/1.55), wheel track/wheelbase (`:120-123` ±0.68/±1.2), AND `WHEEL_RADIUS` (`:35` 0.3) — scale ALL of the car's horizontal/size dims together so it stays internally proportioned and lands at correct real size. (Decision: the car is one eye-tuned unit; scaling it piecemeal would deform it.) Also check `roadRenderer.js:70` `DEFAULT_SIDEWALK_WIDTH=1.2` for eye-tuning provenance.
   - **Y/height constants → never scale** (vertical unaffected by the XZ unstretch): chassis height, `DECK_THICKNESS`, `TUNNEL_CLEARANCE`, curb height, etc.
   - For any ambiguous constant not listed, default to **real-metre (no scale)** and flag it — but the car is decided: scale it whole.

3. **PURGE the two compensation islands — the production-grade core.** The inventory confirmed exactly two; no third exists.
   - Delete `RampResolver.js:31-37` `cumulativeGroundDist` `cos(lat)` conversion — after unstretch, world distance *is* ground distance.
   - Remove/fix `buildingRenderer.js:216` `MERCATOR_SCALE = cos(28.5°)` (Delhi leftover, facade UV `:890,:1064`) — UV now derives from honest units.
   - All other `cos(`/`sec(` hits are rotations/sun-vectors/tile-math → leave.

4. **Delete dead code carrying stretched-unit constants.** `frontend/src/map/tunnelTerrainCarver.js` is imported-but-never-called (confirmed Phase 0) and full of stretched-unit literals. **Delete it** — a dead file with wrong-unit constants is a latent landmine the day it's revived. (Decision: production-grade = no dormant wrong-unit code.)

5. **Fix the validator so it stops agreeing with the bug.** `tunnel-inspect` ramp-grade diagnostic (5) computes rise/run on world coords with no cos — after unstretch it reads honest units automatically. Confirm it now reports real grades (the steep stubs read ~58%/74%, not the old rendered 43%/55%).

6. **Full region re-bake (mandatory, part of the atomic fix).** Road points are stored as absolute Mercator (cos applies at parse-time), but baked terrain positions and building footprints are stored pre-converted to stretched world — they come out real-metre ONLY after a re-bake. Applying the parse-time factor without re-baking, or vice-versa, produces the mixed world. Both, or neither.

7. **Adopt single-factor latitude; write the ADR.** Bbox scale variance is 0.085% (sec 41.358°=1.33228 → 41.413°=1.33340); single `cos(ORIGIN_LAT)` residual <0.1%, under the 0.2% threshold. Use one factor. ADR records: Unstretch-X chosen, single-factor approximation accepted, the two islands purged, the carver deleted.

### Acceptance (Stage 1 GATE — all must pass)
- **Size correct:** car, road widths, building footprints, sidewalks render at true real-world size (the 25%-narrow symptom gone). Spot-check a known-width street.
- **No split world:** trees/vegetation, buildings, roads, terrain all register to each other — drive and confirm trees line their roads, buildings sit on their footprints, no feature class is offset. (This is the all-six-paths proof.)
- **THE PURGE TEST (production-grade criterion):** `grep -rn "cos(\|MERCATOR_SCALE\|1\.33\|0\.751\|0\.75066\|/cos\|sec("` returns **only** `projection.js`/`backend/projection.js` tile-math + legitimate rotation/sun-vector matrices. Zero unit-correction islands. Any surviving compensation = stage NOT done (double-correction bug in disguise).
- **Validator honest:** ramp-grade reports real-metre grades (~58%/74% stubs).
- **`tunnelTerrainCarver.js` gone** from the tree and from imports.
- **ADR written.**
- **FEEL GATE (Anmol-only — cannot be verified by code):** the car now scales to correct real size, but its drive feel was tuned against the stretched world and will shift. Drive it. If speed sensation / weight / cornering feels off, report it — a feel-tuning pass on the car's physics (non-XZ-size params: forces, suspension, grip) follows. This gate is explicitly human; "production-grade" for a driving game means it feels right, which only the driver can confirm.

> When Stage 1 is green you have a **proven-honest coordinate space.** Every later bug is definitionally not a units bug. The feel-tuning pass, if needed, happens here — before DEM adds complexity.

---

## 4. Stage 2 — DEM-on (onto honest coordinates)

**Goal:** enable real terrain elevation so grade separation (tunnels below, bridges above) falls out of a genuine height field — rendered at *true* grade because the units beneath are already correct.

### Tasks
1. **Un-gate DEM.** Decouple `cleanRoadPipeline` from `phase1Pure2D` (the silent coupling at `buildRegion.js:383`), or set flags so the DEM sampler loads (`:933-945`). Config already intends `phase1Pure2D: false`.
2. **Confirm road+terrain share one frame.** The bake adds DEM to both terrain (`:~1051`) and roads (`:1149-1162`, `p[1] += groundElev`) through the same sampler guard — so tunnel Y becomes `DEM + layer·(−6)` (correct relative depth) and they stay co-framed. Verify this fires; the playbook's "DEM + N·−6" is already coded, just gated.
3. **Unify the normalization fork (seam-critical).** Two competing schemes exist: per-tile `tileMinElevation` (`terrainRenderer.js:134`, `roadElevation.js`) vs global `worldElevationOffset` (spawn-anchored). Under DEM, per-tile minima differ between neighbours → **vertical seam tear at every tile boundary.** Pick the global `worldElevationOffset` as the single baseline region-wide; remove/neutralize the `tileMinElevation` rebasing path. (Today both are ~0 so the conflict is invisible — DEM activates it.)
4. **groundMesh.** The infinite flat ground plane at Y=0 (`scene.js:606-615`, `main.js:297`) pokes through hills / floats under valleys. Make it follow terrain or remove it.
5. **RampResolver grade-awareness.** Ramps currently run purely topological (index/length), unaware of real grade. Under DEM, long ramps over varying terrain need a DEM-shaped profile, and endpoints must land on real surface Y at both ends. (Endpoint continuity already holds because DEM is added uniformly at the shared node; the *profile* is the new work.)
6. **Re-bake** with DEM on.

### Acceptance (Stage 2 GATE)
- **Real grade is real:** drive Montjuïc (the "first real DEM test" the docs anticipated). A road the map says is 6% drives and measures 6% — confirmed via the now-honest validator.
- **Roads conform to terrain;** no floating/buried surface roads on slopes.
- **No seam tear:** drive several tile boundaries on a gradient (e.g. Montjuïc flank) — terrain is continuous across seams (proves the normalization-fork unification).
- **Cross-tile tunnel depth agrees** across the owner/affected seam under real grade (same lat/lon → same DEM; verify, since previously untested on a slope).
- If anything is wrong here it is **definitionally a DEM/elevation problem, not units** — because units were proven in Stage 1.

---

## 5. Stage 3 — Runtime absolute-Y → terrain-relative cleanup

**Goal:** convert the scattered runtime constants that assume `surface ≈ Y=0` (masked by the flat coincidence) to terrain-relative, calibrated **once** against correct geometry. The tunnel fall-through dissolves here.

### The absolute-Y constants to convert (from the audit — all currently break off-spawn)
| Constant / site | Today | Fix |
|---|---|---|
| Deck-box gate absolute clause `max>0.3 \|\| min<−0.3` (`tileManager.js:384,444`) | absolute | terrain-relative (road-Y vs local terrain) — the `Δ>0.5` clause already survives |
| Tunnel wall top "Y≈0" (`tileManager.js:634`) | absolute | local surface terrain Y |
| Approach wall top `RETAINING_SURF_Y=0.05` (`tileManager.js:689`) | absolute | local terrain Y |
| Visual retaining wall top `0.05` (`tunnelRenderer.js`) | absolute | local terrain Y |
| Portal trench `botY=−5.95 / surfY=0.05` (`tileManager.js:1260`) | absolute | road-Y relative + real depth (fixes deep tunnels too) |
| `PORTAL_HEIGHT=0` (`tunnelRenderer.js:25`) | absolute | local surface Y |
| Default tunnel fallback `?? −6` (`tunnelRenderer.js:144`) | absolute | `DEM−6` |
| `SEA_LEVEL=0` (`terrainRenderer.js:12`) | absolute, semantically real | make offset-aware (sea is real 0, but compare in normalized frame) |
| Fallback floor `−50` (`scene.js:597`) | absolute | survives, or make spawn-relative for tall terrain |

**Already-relative (survive, no change):** `LAYER_STEP=6`, `TUNNEL_CLEARANCE=4.5` (road-relative), deck `Δ>0.5`, `DECK_THICKNESS`, all XZ radii/dilation (horizontal), `worldElevationOffset` (the anchor mechanism itself).

### The tunnel fall-through, dissolved (not patched)
The Shape-1 finding: flat surface roads (Gran Via / Plaça Cerdà) drawn at Y≈0 over a descending tunnel, with no physics floor (flat roads get no deck box; terrain cut beneath). Under the real model: the surface roads sit at *real surface elevation* genuinely above the tunnel, and the terrain floor exists under them because the ground is really there. The grade-separated junction becomes real geometry. **If a residual floorless-surface case remains, the fix is the new invariant below — not a special-case deck.**

### New permanent validator assert (the check that was conceptually missing all along)
> **Drivable-surface-implies-floor:** for every cell where a *drivable* road (any class, including flat L0) is rendered, there must be physics floor under it (deck box OR uncut terrain). Commit-blocking.

We previously asserted only `physics ⊇ visual` (no invisible walls). We never asserted the inverse — *visible drivable ground with no floor* — which is the exact class that dropped the car. Had this existed, the region re-bake would have failed instead of shipping fall cells. This assert closes the chain: **`visual_cut ⊆ physics_cut ⊆ deck/floor`** in 3D.

### Acceptance (Stage 3 GATE)
- Drive Gran Via / Plaça Cerdà: no fall-through; surface crossing sits above the tunnel as real grade-separated geometry.
- The drivable-surface-implies-floor assert passes region-wide (commit-blocking).
- Tunnel walls/portals/trenches render at correct heights on sloped terrain (off-spawn), not pinned to 0.
- No deck boxes spuriously generated on ordinary sloped surface streets (the deck-gate absolute-clause fix).
- Full batched drive of all tunnel tiles: no fall-through, no launch-to-infinity, no NaN-guard warnings, mouths open.

---

## 6. Guardrails (apply to every stage)

- **One convention, zero exceptions.** After Stage 1, no unit correction may exist downstream of the projection. New code that reintroduces a `cos(lat)`/`1.3321` factor fails review.
- **Prove each gate before the next stage.** Do not begin Stage 2 until Stage 1's purge test and size checks pass. Do not begin Stage 3 until Stage 2's real-grade and seam checks pass.
- **Re-bakes are region-wide** (cross-tile metadata is a region pre-pass). Per-tile re-bake is insufficient.
- **Keep backups per stage** so any gate failure can revert to the last proven-good state.
- **The validator must never agree with the bug.** After Stage 1 it reads honest units; keep it honest — a tool that shares the game's wrong assumption hides exactly the bugs it exists to catch.
- **Preserve the bake-once / dumb-runtime split**, the X-negation convention (now operating on smaller magnitudes), and `NaiveBroadphase` (the Trimesh-AABB constraint, D-01/G-12 — unaffected by Y).
- **Every physics body position keeps the `Number.isFinite` guard** (skip+warn, never insert NaN).
- **Unit/coordinate/elevation changes are ATOMIC ACROSS THREE STEPS — code change, full region re-bake, AND browser tile-cache flush (`window._clearTileCache()` + hard reload).** World-stored feature classes (buildings, greens, trees) only pick up the change after re-bake; the browser cache may still serve pre-rebake tiles after that. Until all three complete the world is in a split/lying state — do NOT judge a drive until code+rebake+flush are all done. (Roads are Mercator-stored and convert at parse, so they shift on reload alone — which is exactly what creates the misleading mid-transition split.)

---

## 7. What this fixes, end to end

When all three gates are green:
- 1 world unit = 1 real metre everywhere; grades are true; the validator tells the truth.
- Real terrain; tunnels below, surface roads above, as genuine grade separation.
- No absolute-Y assumptions; everything terrain-relative; correct off-spawn (Montjuïc as well as the seafront).
- The tunnel fall-through is gone — not patched, dissolved by the right foundation.
- A permanent invariant chain (`visual_cut ⊆ physics_cut ⊆ floor`) enforced by a commit-blocking validator, so the bug class cannot silently return.

The design is paper-first and reviewable so the foundation is deliberate, not discovered through commits — which is the precondition for it working long-term.
