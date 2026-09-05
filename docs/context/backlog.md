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
| Pedestrians | P-1, P-2, P-3, **P-6** | P-4, P-5 |
| Ground layering | Z-1, Z-1b, Z-2a, **Z-2b** | Z-2c (tram rails), Z-4 · **Z-3 dropped** |
| Game modes | M-1 … M-7, **M-9, M-10** | **M-8 reverted** |
| Parked | **K-1** | K-2 multiplayer, K-3 the hole |

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

### ~~P-6 · groups and destinations~~ ✅ **done 2026-09-05**
**The blocker was not real.** "Shops are not in the tiles" confused the census (what the RENDERER
dropped) with the bake (which has carried `shops`/`shopPositions`/`shopCategories` since v10).
`backend/tools/shopSnapAudit.mjs`: **14,541 shops**, **95.7% within 12 m of a pavement, p50 2.2 m**.
Shipped: `attachDestinations` + a `browse` state that turns to FACE the shop, and groups that walk
abreast at a shared pace. New `getLoadedShops()` accessor on tileManager.
⚠ The audit's first run reported 0% — it compared raw shop positions (WORLD) against raw road points
(MERCATOR), median gap 5,069,611 m. Same trap as N-25. Full write-up in `pedestrian-system.md` §3.
⚠ Needs the drive check in that file's §5 item 8.

---

### S-1 / S-2 · SYNTHESIS — stop trusting OSM for what it never said
User, 2026-09-05: *"we can't trust OSM position and numbers, we have to be smart and put some
ourselves as well"*. Right, and **we already do it in one place**: R-W1's `roadWidthModel` is why the
tiles show 100% road-width coverage when OSM tags almost none. That is the template — one model, one
source of truth, read through `roadWidths.js`, never a `?? 6` at a call site.

⚠ **BOTH TICKETS ARE NOW CLOSED, AND BOTH PREMISES WERE MINE AND WRONG.** Kept in full below,
because the pattern is the lesson: I wrote both from headline coverage numbers without breaking them
down or checking the live code, and both evaporated on contact.

- **S-1 · street-name synthesis** — ❌ **DROPPED 2026-09-05.** I quoted "76% name coverage, so 9,514
  unnamed roads" and turned that into a ticket. Broken down by TYPE, the unnamed roads are almost
  entirely things that should not carry a street name: footway 4,566 · service 1,678 · steps 1,294 ·
  corridor 494 · pedestrian 536 · path 262 · slip roads. Drivable streets genuinely missing a name:
  **≈161** (tertiary 51, living_street 31, unclassified 29, secondary 25, residential 19, trunk 5,
  primary 1). Not worth a generator, and generating names for driveways and pavements would be
  actively wrong. **Do not revive without re-running the per-type breakdown.**

  ✅ **What the investigation found and fixed instead:** `getGantrySignTexture` fell back to the
  literal string **`'Delhi'`** for the main line of an overhead board whenever the road it spans had
  no OSM name — live code, on real signs in Barcelona. Gantries now skip unnamed roads (6 of 681
  eligible region-wide, so almost nothing is lost but exactly those signs), and the fallback is an
  empty string rather than another placeholder: blank beats confidently wrong.

- **S-2 · placement from the drawn surface** — ✅ **ALREADY DONE, by T-2. Ticket withdrawn.**
  ⚠ **I specced this from a stale reading and should have checked the live code first.**
  `map/trafficSignalRenderer.js` already draws signals from the **4,225 baked OSM nodes**, places
  them against the drawn carriageway via `roadClearance.js` (`buildCarriagewaySegments` /
  `pushOffCarriageway`), derives the kerb offset from the road's own width, and faces each head back
  down its approach. `ENABLE_TRAFFIC_SIGNALS` is **true** by default. Its file header even quotes the
  `roadInfraRenderer.js:864` "India drives on the left" line as the defect it was written to replace.
  That line is in **dead code** — `generateTrafficLights` has no caller — which is what I misread.
- **S-2a · the outward-tangent fix** ✅ **done 2026-09-05, but its impact claim was WRONG and is
  corrected here.** `findIntersections` recorded each road's two endpoints with opposite tangent
  conventions (outward at the start, inward at the end). That is a real defect in shared data and the
  fix stands — `generateLaneArrows` had already worked around it locally instead of fixing the source.
  But I claimed it meant "traffic lights on the wrong kerb at half the junctions in Barcelona", and
  that is false: its only consumer is the dead builder, so the **live visible impact today is zero**.
  It is a latent-defect fix, not a visible one. 3 tests, verified failing with the old sign.

Both carry `provenance:` in the repair layer's patch file so an invented value stays distinguishable
from a surveyed one forever. Full design: `osm-repair-layer.md` §8. Independent of P4-11 — S-2
decides *where* signs go, P4-11 decides *how they are drawn*.

---

### P4-11 slice 5 · delete the three unbounded sign caches — ⏸ **GATED ON A BEFORE/AFTER MEASUREMENT**
User, 2026-09-05: *"if this slice 5 makes my system worse and there is no proper fix to keep game as
smooth as today just park it."* Standing instruction, recorded here rather than in a commit message.

Slices 1-4 built the replacement (a fixed 2 MB text page + one 2.67 MB sign atlas). Slice 5 is the
migration that actually deletes `_dirBoardTexCache` / `_gantryTexCache` / `_dirBoardMatCache`.

**It should be strictly better** — it replaces an unbounded cache (measured 50 MB at 12 tiles, 145 MB
at 40, 495 MB at 120, never freed) with a fixed 4.7 MB. But "should" is not a measurement, and the
one thing it could plausibly cost is per-frame work: the text page uploads a cell when a new street
name comes into range, where today that cost was paid once and then cached forever.

**Do not merge slice 5 without:** an F9 drive report before and after on the same route, comparing
`sameTileCountDrift.texDelta` (the leak, should go flat) AND the frame sections (must not regress).
If the upload cost shows up in the frame, park it — the leak is real but it is not worth a worse
frame today, and that is the user's explicit call.

---

### N-25b · 12 stale orphan tiles the region bake does not produce
The 2026-09-05 region bake wrote **432** tiles; **445** exist. These 12 (plus `citymap.bin`) date from
2026-08-29 and are not produced by the current pipeline — a different extent, presumably. They still
carry pre-N-25 mixed-space vegetation, and **every one of the 1,957 residual wrong-space positions
lives in them**; the 432 fresh tiles are 100% clean.

```
16/33149/24468  16/33149/24469  16/33151/24470  16/33151/24471
16/33152/24473  16/33154/24485  16/33157/24467  16/33157/24470
16/33157/24485  16/33158/24466  16/33159/24465  16/33166/24468   (+ citymap.bin)
```

⚠ **Not deleted, deliberately.** They are real map data at the fringe and deleting them could open
holes in the world — K-3 is an open ticket about exactly that, and muddying it would be expensive.

⚠ **N-25's fix does not reach production on a git push.** `backend/tiles/` is gitignored (≈12 GB), so
`main` carries the baker change and none of the 432 re-baked tiles. Prod is a static Pages deploy
that copies `backend/tiles/barcelona` into `frontend/dist/tiles/` — until someone runs that, the
parks stay empty on the live site. (`deploy-cloudflare.sh` in the repo root is the stale R2 variant
with placeholder config and is NOT how this ships; see the deploy memory for the three real commands
and the `--branch main` trap.)
**Done when** someone establishes whether the current region bbox is meant to cover them (re-bake
with the wider extent) or not (delete them and confirm no tile request 404s at the edge).

---

## Parked (no owner, no date)

### K-3 · REFRAMED 2026-09-05 — it is a HOLE IN THE GROUND, not a white surface

The user, looking at it live: *"what white, in front there is no tile so i'll fall man"*. They are
right and the screenshot reading was wrong — a fourth wrong guess from a screenshot on this ticket.
The white is sky seen through missing terrain.

**What is measured, and it is not the bake.** All nine tiles around the car (`16_33168_24474`,
Carrer de la Llacuna) are baked, v10, ~600 KB each, with 128×128 elevation grids and sane min/max.
The bake is solid 5 tiles deep in every direction. A re-bake is not the answer.

**`_ddNoGround()` localised it to ONE TILE EDGE.** 128 clusters; the nearest 15 are 10–442 m away
and **7 of the 15 report `NO TERRAIN`** — an empty column, which the probe's own docs separate from
"road floats above ground". The coordinates are the finding: several sit at exactly `2.20276`, which
is the `west` of tile `16_33169_24474` to five decimals, and `41.39744` ≈ its `south` (41.397415).
**The holes trace that tile's west and south edges** — one tile's ground missing, starting at its
boundary, not scattered damage.

**Ruled out:** LOD (`TERRAIN_CUT_M` is 1500 m; these are ≤442 m) · the bake (above) · an un-streamed
tile in the sense the old entry meant (the load logged `COMPLETE … 14 tiles resident`, not `GAVE UP`).
So `entry.terrainMesh` is either never built for that tile or is hidden by something other than LOD.

⚠ **UNRESOLVED AND IT MATTERS: the console was a SUSPENDED-TAB load.** `time-to-drive 486858 ms`
(8 min) with `phys:terrain 1454653 ms` of main-thread time inside a 13.6 s load — arithmetically
impossible, so the machine slept mid-load. The second paste was the SAME page load (byte-identical
log, probes appended), so **no clean-load measurement exists yet**. A load interrupted that way can
report COMPLETE with tiles that never finished building, which would produce exactly this. Get
`_ddNoGround()` from a fresh load before changing any streaming code.

**Fixed along the way:** `_ddGround()` could not name terrain or roads at all — they are tagged on
the MATERIAL (`material.userData._patchTags`), not `userData.type`, so both landed in the anonymous
`'Mesh'` bucket (129 visible / 3,555 hidden) and the one question the probe exists to answer came
back unanswerable. It now falls back to the patch tag.

**Superseded — the original entry, kept because its reasoning was sound and its premise was not:**
a large WHITE surface where a road/pavement should be — seen twice near Carrer de Badajoz,
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


### ~~K-1 · coordinate conventions~~ ✅ **done 2026-09-05 — and RESCOPED on the evidence**

⚠ **The ticket aimed at the wrong thing.** It proposed wrapping the X-mirror in a boundary module.
But the world→physics negation `px = -(wx - originX)` is written out at nine call sites and is
**correct at all nine** — it is well known and heavily commented. Wrapping it would have been churn.

Every coordinate bug this project has actually paid for is a **SPACE** bug: data arriving in a
different space from the one the reader assumed. Four this week alone (N-25's 316,063 misplaced
positions, the vegetation mask's dead road guard, the same file's water, and the P-6 audit's
5,069,611 m median). So K-1 shipped as two things that address that instead:

**K-1a · one projection, checked.** `ORIGIN_LAT`/`ORIGIN_LON`/`MERCATOR_UNSTRETCH` were declared in
FIVE places, each behind a comment saying *"MUST match frontend/src/projection.js"*. A comment is a
request, not a guarantee. The three frontend copies are deleted and now import — `projection.js` is a
leaf with no imports of its own, so there was never a technical reason for them; the workers already
import `roadWidths.js`. The bake is a separate package and cannot import, so a test pins it: same
origin, same Mercator→world result on real coordinates, sub-millimetre.

**K-1b · `checkSpace()`.** A magnitude check (the two spaces are three orders of magnitude apart) at
the boundaries where data changes space — the four `bakedVegetation` arrays and `readShops`. Warns
once, loudly, naming the array. ⚠ Warns rather than throws **on purpose**: this runs in the tile
parser and throwing would take out a chunk of the city over a diagnostic. The bake is the opposite
case and `assertVegSpace` throws there, because a bad bake must not reach disk.

**Still open, and deliberately not attempted:** the terrain heightfield's −90° rotation and the
Rapier-vs-cannon convention difference. Neither has caused a measured bug, and this session's lesson
is that the ticket's premise is worth checking before building to it.

**K-2 · multiplayer** — a programme, not a task. ⚠ The blocker is not networking: **nothing in this
game is authoritative.** Physics is client-side, traffic and pedestrians are seeded by nothing, and
the spawn is now randomised per client — two players would see different cars, crowds and starting
places in the same city. Cheapest honest first slice: ghost cars at ~10 Hz, no shared physics.

---

## Inherited from the v3 tracker — still open there, not duplicated here

~~`N-25` trees in carriageways~~ — ✅ **FIXED 2026-09-05, region re-baked.** It was far bigger than
the title: **316,063 baked vegetation positions were in the wrong coordinate space**, including ALL
zone trees and ALL zone bushes, so every park in Barcelona was empty and nobody had noticed. The
recorded cause was also wrong — 97.2% of trees already matched the grid, which is why the previous
attempt deleted 99,715 trees and changed nothing. See the tracker row ·
`N-31` sidewalk overhang (needs a sloped batter, not the reverted edge skirt) · `N-56` reverted ·
`N-57` in flight — re-measured 2026-09-05 at **116** steps; the next step is NOT another bake ·
`P4-17` ⛔ blocked on `P4-11` (`signAtlas.js` does not exist — 7 d, high risk, code not art).

~~`N-26` collision wireframes invisible~~ — ✅ **closed in the tracker, this line was stale.** Not a
bug: `initCollisionDebug()` is inside `if (import.meta.env.DEV)`. Port **4040 = dev = debug tools**,
**4044 = preview = production = no K key**.
