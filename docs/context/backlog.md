# Backlog — the one board

**This is the single list of open work on `main`.** `TODO.md` points here. Add a ticket here, not in
a subsystem doc — the subsystem docs hold the *design*, this holds the *state*.

Relationship to the other two trackers, so nobody has to guess:

| doc | what it is | still live? |
|---|---|---|
| **this file** | open work on `main`, all streams | ✅ **yes — start here** |
| [v3-execution-tracker.md](v3-execution-tracker.md) | the v3 programme's own board (P0-P4 + N-tickets) | ✅ yes, for v3 tasks. Its RESUME block says branch `v3` — **stale, see below** |
| [roadmap.md](roadmap.md) | features absent from the tile FORMAT and why | ✅ yes, but it is a wishlist, not a queue |

⚠ **`v3-execution-tracker.md`'s RESUME block is out of date and it matters.** It says "Branch **`v3`**,
395 tests". Measured: `git merge-base --is-ancestor v3 main` passes — **v3 is fully contained in
`main`**, which is 16 commits ahead at 510 tests. Work on `main`. (An earlier status report of mine
claimed the two had *diverged*; that was wrong — the check above is the one to trust.)

---

## Status at a glance

| stream | done | open |
|---|---|---|
| Pedestrians | P-1, P-2, **P-3** | P-4, P-5, P-6 |
| Ground layering | Z-1, Z-1b, Z-2a, **Z-2b** | Z-2c (tram rails), Z-4 · **Z-3 dropped** |
| Game modes | M-1 … M-7, **M-9, M-10** | **M-8 reverted** |
| Parked | — | K-1 coordinate cleanup, K-2 multiplayer |

⚠ **Numbering fix:** the changelog used "Z-2" for the paint-ladder *correction* while
`ground-layering.md` used "Z-2" for *surfaces outside the scheme*. Two things, one number. The
correction is **Z-1b** from here on; **Z-2** is only the un-enrolled surfaces.

---

## Do NOT work on these

| | why |
|---|---|
| **Z-3** building-wall z-fighting | **Dropped from this board.** It came from a stale TODO line, **nobody has reported seeing it**, and it does not belong to `groundLayers` anyway (that module is for flat co-planar ground; 3D geometry wins by having real height). Two overlapping OSM footprints is a DATA problem — if it ever shows up, it is a ticket in [osm-repair-layer.md](osm-repair-layer.md), next to `rule5_duplicateRoadRemover`. |
| **P-5** pedestrian art | **Not a work item — a decision.** It contradicts the v3 ruling that cut the pedestrian art pass and dropped `PED_CAP` 168→60. Nothing should start until that ruling is overturned by the user. |

---

## Open tickets, in the order they should be done

### ~~P-2 · crossings~~ ✅ **done 2026-09-05**
One missing line in the `getLoadedRoadSegments()` whitelist, unblocking 11,325 baked crossings.
Pedestrians now wait at the kerb, cross, and re-join the far pavement. `window._ddCrossings()` is the
runtime proof; `backend/tools/crossingCount.mjs` is the offline population. ⚠ **They do not yet look
for traffic** — the kerb wait is a fixed interval, not gap acceptance. Follow-up folded into P-6.

### M-8 · Heat's objective card — ❌ **BUILT AND REMOVED THE SAME DAY. Do not rebuild it.**
Shipped an arrow pointing away from the nearest unit over a Closing/Gaining kicker. User: *"i dont
think i need this gaining and losing card at all"* — and on reflection that is right: **the siren, the
lights in your mirror and the minimap blips already say "they are close and getting closer"**, three
cues for one fact, and the card was the only one that made you look away from the road to use it.
The nearest-unit distance went back to the corner card where it started. `setInstruction()` was
deleted with it rather than left as dead API.

⚠ It also shipped two defects worth remembering if anyone builds a live readout again — **both were
recomputed from raw per-frame values**: the banner sat at the card's exact `top:96px` and drew
straight through it, and the Closing/Gaining word plus the compass word plus the metre digit all
churned ~10×/s. Nothing about a pursuit changes that fast; the jitter was in the measurement. A live
HUD value needs a dead band and a committed state, not the current frame's answer.

### ~~M-9 · the ETA~~ ✅ **done 2026-09-05**
`planRoute` returns `timeS` — `gScore[t]`, the number A* was already minimising. It had been computed
on every plan and dropped. An ETA derived afterwards from length ÷ average speed would be a second,
worse estimate that disagrees with the route the player was actually given. Shown beside the distance
("420 m · 3 min"), and under 45 s it reads "under a min" rather than a spuriously precise "0:38".

### ~~Z-2a · parking~~ ✅ **done 2026-09-05** · ~~Z-2b · the rest~~ ✅ **done 2026-09-05**
Parking had **no depth class at all** and its stall markings sat above the road deck while their
absent bias put them below it. Now `parkingLot` / `parkingPaint`, under `road` by both bias and
height. It also had never been registered, so it was lit by ambient alone at night. The
bias/height agreement test now covers terrain-based classes too — the gap that let this hide.

**Z-2b turned out to be one fix, one judgement call and two deletions**, not four enrolments — the
list was written from a grep for hand-rolled Y constants without checking whether anything drew them.

1. **Bus stop bay marking — FIXED.** The one real defect, and the interesting one: the material had
   been enrolled in the *depth* table since v3 P1 (`applyGroundLayer(mat, 'marking')`) and never in
   the *height* table. It kept `MARKING_Y_OFFSET = 0.15` measured from **raw terrain**, while lane
   paint sits at `roadDeckY(y) + groundLift('marking')` ≈ terrain + 9.7 cm — so a bay outline floated
   ~5 cm above the lane lines it is coplanar with. Same bias/height disagreement Z-1 found, surviving
   in a renderer that looked done because the loud half of the fix had been applied.
   ⚠ Known limit, written into the code: the base is the terrain sample under the bay, not the road's
   own baked deck array (a bus stop only ever resolves a *nearest road*, never its elevation). Bus
   stops are not placed on bridges or tunnel approaches, so this is a limit, not a live defect.
2. **Bus stop light pool (0.10) — not in scope, and the board was wrong to list it.** Transparent,
   `depthWrite: false`; the scheme's own rules order those by `renderOrder`, and
   `assertGroundLayers()` skips them for exactly that reason. The file already said so.
3. **`tunnelRenderer` `APPROACH_Y_BIAS` (0.06) — DELETED, dead code.** `_buildApproachAtPortal()` and
   its ramp/cut-wall materials were never called; `buildPortalApproaches()` builds trench walls
   instead. It was also worse than "hand-rolled": `const sY = APPROACH_Y_BIAS` was an **absolute Y**,
   not terrain + 0.06, so despite a comment reading "just above terrain" the quad would have sat at
   sea level on any real DEM. 56 lines gone.
4. **`roadRenderer` `BLEND_STRIP_Y_OFFSET` (0.10) — DELETED, dead code.** v3 P1-15 deleted
   `buildRoadsideBlendStrip()` (the Delhi roadside dust gradient) and left the constants and
   `getBlendStripMaterial()` behind. Nothing read them. 26 lines gone.
5. **Tram rails (`TRAM_RAIL_Y_ABOVE = 0.005`) — deliberately left alone, see Z-2c.**

Three tests pin it: the derivation, the resulting height matching lane paint, and the two deleted
constants staying deleted.
⚠ **Drive check owed:** find a bus stop and look at the dashed bay outline where it meets the lane
lines — it should be paint on the same plane, not a rectangle hovering over the road.

### Z-2c · tram rails — a judgement call, not a bug
`railwayRenderer` places tram rails at road surface + `TRAM_RAIL_Y_ABOVE = 0.005` on a plain
`MeshLambertMaterial` with no `polygonOffset`. The scheme's own rules say **3D geometry doesn't
belong in the table — it wins by having real height**, and a rail does have height. But 5 mm is
thin enough that the rail's own top face can z-fight the asphalt at distance, which is the symptom
the table exists to remove.
**Done when** someone has driven a tram street (Diagonal, Glòries) and either raised the rail to a
height that cannot fight, or written down that 5 mm holds and why. Not worth guessing at from here.

### Z-4 · gore and drain sit BELOW the drawn asphalt
Measured: gore **−2.4 cm**, drain **−0.9 cm** relative to the asphalt top, and both are exempted from
the clearance assertion as "embedded, not painted on". Plausible for a drain cover. **A junction gore
fill is paint** — buried 2.4 cm it can only be visible because `polygonOffset` is dragging it forward,
which is the arrangement that makes visibility depend on viewing angle.
**Done when** someone has actually looked at a gore fill up close and either raised it above the
asphalt or written down why it belongs underneath.

### ~~M-10 · routing cost on the main thread~~ ✅ **measured 2026-09-05 — no work needed**
`backend/tools/routeBench.mjs`, 18 tiles around the Gran Via spawn (4,812 road segments — the
resident set at its densest, which is where the v3 benchmark measures):

| trip | graph nodes | plan ms (p50 / worst of 15) |
|---|---|---|
| 200 m | 271 | 0.9 / 1.4 |
| 500 m | 428 | 0.4 / 0.7 |
| 1 km | 1,010 | 0.9 / 1.2 |
| 2 km | 1,315 | 1.1 / 1.5 |

**Worst case 1.5 ms, on a 2 km trip — four times the length the modes ever ask for.** Against a
13.3 ms night frame, once every ≥1.1 s at most, and only on a replan. **A worker would be work with
nothing to show for it.** The board said a worker is the fix only if a number says so; the number
says no. ⚠ Keep the bench: if the trip cap or the graph margin ever grows, this is the check.

### ~~P-3 · use the animation clips already on disk~~ ✅ **done 2026-09-05**
`Run` baked as an 8-frame second flipbook, `Standing` as a second stationary pose. Panic now drives
the run cycle from **measured ground displacement** — `p.speed` is the wrong number, it barely moves
when someone bolts because a dodge is almost entirely the lateral shove. Clip choice moved to
`frontend/src/car/pedClips.js` (no three.js import → testable); `Sitting` stays unused on purpose,
there is no bench builder to sit on. Full write-up in `pedestrian-system.md` §3.
⚠ Needs the drive check in that file's §5 item 7.

### P-4 · vertex-animation texture
⚠ **Its headline justification is now stale and the ticket should be re-argued before anyone starts.**
"39 draw calls → 3" was true before P-1; P-1's `visible = count > 0` gate already means only the
~10-14 non-empty cells of 42 are ever submitted. What remains is genuinely *smooth* animation
(currently a 12-frame flipbook, ~10 fps) and making P-3's extra clips cheap — though P-3 has now
landed at 69 meshes with no measured cost, so "makes the clips cheap" is a weaker argument than it
was when this was written. Decide whether the shader work is worth it.

### P-6 · groups and destinations
Needs P-2, **and needs bake work**: shops are not in `pbfUrbanFeatures` at all — per CLAUDE.md's census
14,542 are parsed and discarded, so there are no destinations to walk to yet.

---

## Parked (no owner, no date)

**K-3 · a large WHITE surface where a road/pavement should be** — seen twice near Carrer de Badajoz,
not reproducible on demand; the user will re-probe when it next appears. ⚠ **Do not guess at this
from a screenshot** — three guesses from screenshots were wrong in one session. The code narrows it
to exactly two candidates and one probe call separates them: both the road and the panot pavement
use `color: 0xffffff`, the road taking its real shade from **vertex colours** and the pavement from a
**texture**. Point at the white and run `window._ddPick()`:
- `map: "NO TEXTURE"` on a sidewalk/panot mesh → the texture failed to load at runtime (the KTX2
  files exist and serve 200, so it is not a missing asset).
- `vertexTint: "#ffffff"` or `null` → missing vertex colours against a `vertexColors` material. This
  codebase has been bitten by that contract twice.

`window._ddGround()` alongside says whether something is CULLED rather than BROKEN. One console
screenshot also showed `[perf] initial tile load GAVE UP at the cap … 6 queued`, so an un-streamed
tile is a third possibility that the probes would rule in or out immediately.


**K-1 · coordinate/mirror conventions cleanup** — consolidate the X-mirror, the terrain heightfield's
−90° rotation and the Rapier-vs-cannon convention difference into one boundary module, so renderers
stop re-deriving them. Reduces the class of silent misplacement the CLAUDE.md danger note describes.

**K-2 · multiplayer** — a programme, not a task. ⚠ The blocker is not networking: **nothing in this
game is authoritative.** Physics is client-side, traffic and pedestrians are seeded by nothing, and
the spawn is now randomised per client — two players would see different cars, crowds and starting
places in the same city. Cheapest honest first slice: ghost cars at ~10 Hz, no shared physics.

---

## Inherited from the v3 tracker — still open there, not duplicated here

`N-25` trees in carriageways (⚠ **the obvious fix is proven not to work** — read it before retrying) ·
`N-26` collision wireframes invisible (two speculative fixes already reverted — **get the HUD line
first**) · `N-31` sidewalk overhang (needs a sloped batter, not the reverted edge skirt) · `N-56`
reverted · `N-57` in flight · `P4-17` ⛔ blocked on `P4-11` (`signAtlas.js` does not exist).
