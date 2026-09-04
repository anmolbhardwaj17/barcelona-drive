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
| Pedestrians | P-1, **P-2** | P-3, P-4, P-5, P-6 |
| Ground layering | Z-1, Z-1b (the correction) | Z-2, Z-4 · **Z-3 dropped** |
| Game modes | M-1 … M-7, **M-8, M-9** | M-10 |
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

### ~~M-8 · Heat's objective card~~ ✅ **done 2026-09-05**
Heat has no destination, so `update(nav)` had nothing to say — the card is driven by a new
`setInstruction()` override instead: an arrow that rotates to point AWAY from the nearest unit
(camera-relative, because the world is X-mirrored) over a WORLD compass word ("Head north-east",
which survives you swinging the camera). ⚠ The corner card's "· nearest 20 m" was removed in the same
change — the centre card owns that number now, and printing it twice was the City Cab mistake.
No world halo: a glowing ring over a police car is noise when it already has flashing lights.

### ~~M-9 · the ETA~~ ✅ **done 2026-09-05**
`planRoute` returns `timeS` — `gScore[t]`, the number A* was already minimising. It had been computed
on every plan and dropped. An ETA derived afterwards from length ÷ average speed would be a second,
worse estimate that disagrees with the route the player was actually given. Shown beside the distance
("420 m · 3 min"), and under 45 s it reads "under a min" rather than a spuriously precise "0:38".

### Z-2 · surfaces outside the ground-layer scheme — **next**
Measured, and my earlier one-line summary was **wrong in a way worth recording**: the parking
*surface* sits at terrain+0.04, which is **below** the road deck at +0.05 — it is the parking
*markings* at +0.06 that land above it. So a car park abutting a street has its surface buried and
its paint proud. Also outside the scheme: `busStopRenderer` (0.10 / 0.15), `railwayRenderer` tram
rails (0.005), `tunnelRenderer` `APPROACH_Y_BIAS` (0.06 — a hand-rolled tie-break of exactly the kind
the bias table replaces), `roadRenderer` `BLEND_STRIP_Y_OFFSET` (0.10).
**Each is a possible visible change** → own pass, own drive test, one class at a time.

### Z-4 · gore and drain sit BELOW the drawn asphalt
Measured: gore **−2.4 cm**, drain **−0.9 cm** relative to the asphalt top, and both are exempted from
the clearance assertion as "embedded, not painted on". Plausible for a drain cover. **A junction gore
fill is paint** — buried 2.4 cm it can only be visible because `polygonOffset` is dragging it forward,
which is the arrangement that makes visibility depend on viewing angle.
**Done when** someone has actually looked at a gore fill up close and either raised it above the
asphalt or written down why it belongs underneath.

### M-10 · routing cost on the main thread is unmeasured
A* is bounded (graph clipped to the trip) and throttled (≥1.1 s between searches), and no hitch has
been reported — **but it has never been measured on a 500 m trip through the densest tiles**, which is
the case that would hurt. Measure before optimising; a worker is the fix only if a number says so.
**Done when** there is a millisecond figure for `planRoute` at Gran Via (`?spawn=fixed`).

### P-3 · use the animation clips already on disk
Every people GLB ships **11 clips**; verified only three are baked (`walk`, `idle`, a death/fall pose).
`Sitting`, `Standing`, `Clapping`, `Run` are paid for in page weight and never appear. Panic currently
plays the *walk* flipbook at 2.6× rate instead of the run cycle that exists.

### P-4 · vertex-animation texture
⚠ **Its headline justification is now stale and the ticket should be re-argued before anyone starts.**
"39 draw calls → 3" was true before P-1; P-1's `visible = count > 0` gate already means only the
~10-14 non-empty cells of 42 are ever submitted. What remains is genuinely *smooth* animation
(currently a 12-frame flipbook, ~10 fps) and making P-3's extra clips cheap. Decide whether that is
worth the shader work.

### P-6 · groups and destinations
Needs P-2, **and needs bake work**: shops are not in `pbfUrbanFeatures` at all — per CLAUDE.md's census
14,542 are parsed and discarded, so there are no destinations to walk to yet.

---

## Parked (no owner, no date)

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
