# Tunnel Subsystem — Fix Playbook (Barcelona Drive)

**Audience:** Claude Code, working inside the Barcelona Drive repo.
**Goal:** Make tunnels correct, continuous, and stable — visually and physically — without destabilising the subsystems that already work.

> **Read this first.** The tunnel system is not one feature; it is a *contract spanning 8 subsystems* (OSM tags → bake elevation → bake terrain cuts → cross-tile metadata → runtime classification → runtime geometry → runtime carving → runtime physics → camera). Tunnel bugs are almost always a **contract violation between two of these subsystems** that throws no error — the car silently falls through, walls land in the mirror position, or terrain seals a portal. Your job is to find *which contract is broken*, not to rewrite the renderer.

---

## 0. The Cardinal Rule: diagnose before you change

Do **not** edit geometry or physics code until you have produced a written **Findings Report** (format at the bottom). The most expensive mistake here is rewriting a subsystem that was already correct and shifting the bug somewhere observable-but-different.

### 0.1 Files to read and summarise (in this order)

| Subsystem | File(s) | What to confirm |
|---|---|---|
| Tag retention | `pbfHighways.js` (`KEEP_TAGS`) | `tunnel`, `layer`, `lanes`, `highway` are all kept. A dropped tag here makes a tunnel invisible to the entire pipeline. |
| Road graph / ramps | `RampResolver.js`, `resolveRamps()` | Portal endpoints are detected and marked `isRamp=true`; smoothstep length is sane. |
| Elevation merge | `elevationHarmonizer.js` | Conflicts at portal nodes are resolved; ramp endpoints inherit neighbour elevation. |
| Terrain cuts (bake) | `terrainBaker.js` | Point-circle holes + 80m approach corridors are generated per portal. |
| Cross-tile | `buildCrossTileMetadata()` | Corridors are *injected into adjacent tiles* and tagged so the neighbour's runtime recognises them. |
| Classification | `tileManager.js` (Phase 1) | `tunnelRoads` vs `pedestrianPortalRoads` vs `wallApproachRoads` vs `carveApproachRoads` split; **and the Phase 1 build order**. |
| Geometry | `tunnelRenderer.js` | Walls, ceiling, portal frame, LED, stripe. |
| Carving | `tunnelTerrainCarver.js` | Pushes terrain vertices down; records triangles to remove from physics trimesh. |
| Physics | `tunnelWallBody` builder + terrain trimesh builder | Box placement, X-negation, overlap-skip, trimesh hole. |
| Camera | `tunnelZones.js` | Registry of tunnel extents for the camera. |

### 0.2 Build a diagnostic overlay (behind a flag, e.g. `?debug=tunnel`)

This is the single highest-leverage thing you can do. Add a debug mode that renders:

1. **Physics body wireframes** projected back through the world transform, so you can *see* whether each `CANNON.Box` wall and the terrain trimesh sit on top of the visual geometry or at the mirrored/offset position.
2. **Per-portal labels** logging: `road_Y`, `ceiling_Y`, `carve_floor_Y`, visual hole radius, physics hole radius, `halfWidth`, `layer`.
3. **Tile-seam markers** at the 3×3 grid boundaries.

Drive to a known-buggy tunnel and capture the exact divergence. Attach the numbers to the Findings Report. **Everything after this is hypothesis-driven by what the overlay shows.**

---

## 1. The Contracts (the spec's backbone)

These are invariants that must hold. Most of the fix work is making a violated invariant hold again, then adding an assertion so it can't silently break later.

### C1 — Coordinate contract

- Visual world lives **inside** `worldGroup` (`scale.x = -1`, `position = originOffset`). World coords are `(wx, wz)`.
- Physics bodies live **outside** the scene graph and must manually apply:
  ```
  physicsX = -(worldX - originOffset.x)   // negate X
  physicsZ =   worldZ - originOffset.z    // Z unchanged
  ```
- Road point shape is `{ x: worldX, y: worldZ, elevation: meters }`. **`.y` is horizontal Z (north), not vertical height.** Binary triples are `[mercX, elevationMeters, mercZ]`; the parser maps `mercZ → .y`.
- **Invariant C1:** every tunnel physics element (wall box, trimesh) must map to the *same world point* as its visual counterpart under the negation above. The debug overlay (0.2) is the test for this. **Do not "fix" a mirror bug by flipping `worldGroup.scale.x`** — fix it at the offending call site that forgot to negate.

### C2 — Elevation continuity contract

- Surface road: `normalizedY = (rawDEM - worldElevationOffset) * ELEVATION_VERTICAL_EXAGGERATION`.
- Tunnel road at `layer = -N`: base `= rawDEM + N·(-6m)`, then normalised the same way.
- Ramp: smoothstep from surface elevation → tunnel elevation over ramp length. Must be **C0-continuous** (no vertical gap) at both the portal mouth and the underground junction, and ideally **C1** (no visible kink).
- Ceiling Y `= road_Y + TUNNEL_CLEARANCE (4.5m)`, **road-relative** — it descends with the road.
- **Invariant C2:** at every portal endpoint, `|carve_floor_Y − road_Y| ≤ tol`, and ramp endpoints match their neighbour segment's elevation within epsilon (this is what `elevationHarmonizer` is for — verify it actually runs on tunnel/ramp nodes). Violations produce the classic "road floating above the trench" or "road buried in terrain" bugs.

### C3 — Portal continuity contract

Each tunnel road has 0, 1, or 2 portal endpoints. A *complete* portal requires all five of:
1. Visual terrain hole, 2. **Physics** trimesh hole, 3. Portal frame geometry, 4. Ramp elevation, 5. Wall + ceiling termination.

- **Physics hole must be ≥ visual hole.** Spec says visual radius `= halfWidth + 1m`, physics radius `= halfWidth + 1m + 1m margin`. If physics ≤ visual, wheel raycasts catch terrain just inside the visible mouth → car judders/bounces at the portal. Verify the larger radius is the physics one.
- Portal frame width `= halfWidth·2 + wing`. `halfWidth` is derived from lane count / road class — confirm it equals the actual road-ribbon width, or the frame floats off the road edges.

### C4 — Physics/visual parity contract

- Walls: thin `CANNON.Box` per segment edge, spanning `road_Y → ceiling_Y`. After X-negation they must sit on the **same physical side** as the visual wall (mirror-flip is the most common error here).
- **Overlap-skip:** a wall inside another tunnel road's corridor is skipped to avoid double geometry. Two failure modes: (a) skip too aggressive → gaps the car drives through; (b) skip too lax → overlapping boxes → the SAT solver explodes → `NaN` body position → car launched to infinity. **Add a finite-check on every body position: if non-finite, log the road id + segment index and skip insertion rather than poisoning the world.**
- Trimesh winding is reversed vs the visual mesh (X-negation flips handedness). The carved triangle set removed from the physics trimesh must be **identical** to the set removed from the visual mesh — same indices, computed once and shared, not recomputed per side.

### C5 — Cross-tile contract

- `buildCrossTileMetadata()` scans region-wide tunnel roads, finds true portal endpoints, and injects 80m approach-corridor features into adjacent tiles.
- **Failure mode:** the corridor is injected into the neighbour tile's feature list but the neighbour's runtime carve/wall builder doesn't treat injected corridors the same as native ones → terrain wall at the seam, or walls stop at the tile edge while the ceiling continues.
- **Invariant C5:** a tunnel crossing a tile boundary yields continuous floor `road_Y`, continuous `ceiling_Y`, continuous walls, and continuous physics across the seam. Sample both quantities at the boundary from *both* tiles; they must match within epsilon.

### C6 — Phase-order contract (runtime)

Phase 1 order **must** be: build terrain mesh → **carve it** (`tunnelTerrainCarver`) → build the physics trimesh **from the carved data**. If the trimesh is built from pre-carve terrain you get a visual hole over solid physics (car can't enter) — a very common symptom. Verify this exact ordering in `tileManager` Phase 1.

---

## 2. Symptom → likely cause map

Use the overlay numbers to match the symptom, then go to the contract.

| Symptom | First suspect | Contract |
|---|---|---|
| Car falls through tunnel deck | Road deck box not built (elevation Δ < 0.5m threshold), or trimesh hole too large at portal | C2 / C3 |
| Car can't enter — invisible wall at mouth | Physics trimesh built before carve, or physics hole < visual hole | C6 / C3 |
| Car judders/bounces right at portal lip | Physics hole radius too small (margin missing) | C3 |
| Walls / colliders on the wrong side | Missing/incorrect X-negation at the wall body call site | C1 |
| Car randomly launched to infinity | Overlapping wall boxes → solver `NaN` | C4 |
| Road floats above trench floor, or buried | Carve floor vs road_Y mismatch; harmonizer skipped portal node | C2 |
| Ceiling clips the car on a descent | Ceiling computed from absolute Y instead of `road_Y + clearance` | C2 |
| Terrain seals the tunnel at a tile edge | Cross-tile corridor not injected/recognised | C5 |
| Walls or ceiling stop dead at a tile seam | Neighbour tile doesn't render injected corridor | C5 |
| Portal frame floats off the road edges | `halfWidth` mismatch vs ribbon width | C3 |
| Tunnel renders but stays bright / bloomed | `tunnelZones` extent not registered or camera check wrong | C7 below |

---

## 3. Fix order (dependency-ordered — do not reorder)

You cannot fix runtime if the baked data is wrong. Work outward from the data.

### Phase 0 — Diagnostic & instrumentation *(no behaviour change)*
- Produce the Findings Report.
- Land the `?debug=tunnel` overlay behind a flag. Keep it permanently (off by default).
- **Acceptance:** report identifies the violated contract(s) with line refs and overlay numbers.

### Phase 1 — Bake data correctness
Fix, in order: tag retention → ramp detection → elevation assignment → harmonizer at portal nodes → terrain cuts → cross-tile metadata injection.
- **Acceptance:** add an offline validator that loads a baked `.bin` tile and asserts C2/C3/C5 over its tunnel roads (elevation continuity, hole presence, injected-corridor flags). Run it on the tiles covering 2–3 known tunnels. Re-bake and confirm the validator passes *before* touching runtime.

### Phase 2 — Runtime geometry (`tunnelRenderer.js`)
Wall span, ceiling road-relative clearance, portal frame width, continuity along the road.
- **Acceptance:** visually, deck/walls/ceiling/portal form a continuous enclosure with no gaps at mouths; ceiling tracks descending roads.

### Phase 3 — Carving order + physics trimesh parity
Enforce C6 ordering. Make the removed-triangle set shared between visual and physics. Verify physics hole ≥ visual hole + margin. Confirm winding.
- **Acceptance:** wheel raycasts never hit terrain inside the mouth; no judder at the lip; car enters cleanly.

### Phase 4 — Physics walls (`tunnelWallBody`)
X-negation at the call site; overlap-skip correctness; finite-checks + skip on `NaN`.
- **Acceptance:** overlay shows wall wireframes coincident with visual walls; no launch-to-infinity over a 5-minute drive through every tunnel in coverage.

### Phase 5 — Cross-tile seams
Make injected corridors first-class in the neighbour runtime; add the seam-continuity sampler (C5) as a runtime assertion in debug builds.
- **Acceptance:** drive across every tile boundary that a tunnel crosses; floor/ceiling/walls/physics continuous, sampler within epsilon.

### Phase 6 — Camera & polish (`tunnelZones.js`, LEDs, stripe)
Register extents correctly; confirm bloom suppression / ambient lift triggers on entry and clears on exit.
- **Acceptance:** entering any tunnel suppresses bloom and lifts ambient; exiting restores.

### Phase 7 — Validation harness *(make the bug class impossible)*
Promote the Phase-1 offline validator and the Phase-5 seam sampler into permanent checks (offline assert in the bake; debug-only runtime assert). Keep the overlay.
- **Acceptance:** intentionally corrupting one input (e.g. drop the physics hole margin) trips an assertion rather than producing a silent in-game bug.

---

## 4. Guardrails (hard constraints)

- **Never** change `worldGroup.scale.x = -1` or the negation convention. Fix mirror bugs at the call site that forgot to negate.
- **Do not** rewrite a subsystem the diagnosis shows is correct. Minimal, targeted changes only.
- Keep the **bake-once / dumb-runtime** split. Do not move bake logic into the runtime; the backend stays a static file server.
- Stay on **binary v7** unless a genuinely missing data field forces a bump. If you must bump, document the new field + offset, version-guard the parser, and re-bake — never read a v7 tile with a v8 parser.
- Every physics body position gets a `Number.isFinite` guard before insertion; log + skip on failure.
- All new diagnostics are flag-gated and **off by default**; no perf cost in the normal path.
- Don't break the 4-phase progressive build budget (`yieldToMain`, 6ms). Carving and physics stay in Phase 1 but must not blow the frame.

---

## 5. Required output format (Findings Report)

Before any code change, return:

```
## Findings Report

### Subsystem audit
For each of the 8 subsystems: current behaviour | suspected defect | evidence (file:line) | confidence

### Overlay capture
Tunnel(s) tested, with per-portal numbers:
road_Y / ceiling_Y / carve_floor_Y / visual hole r / physics hole r / halfWidth / layer
+ note whether physics wireframes coincide with visual geometry.

### Violated contracts
C1..C6, each: holds / violated, with the evidence that proves it.

### Proposed fix plan
Ordered by the Phase plan above. For each: files touched, the change, the acceptance test you'll run.
```

Then implement **one phase at a time**, run that phase's acceptance test, and report results before starting the next phase.
