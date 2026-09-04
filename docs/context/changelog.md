# Changelog

Running log of changes. Append an entry at the top for every session. For structural/architectural changes, also update the relevant `/docs/context/` file. For trivial fixes, a one-line entry here is sufficient.

## 2026-09-05 — M-8 REVERTED: Heat's centre card removed the day it shipped

User, on seeing it: *"i dont think i need this gaining and losing card at all"*. Agreed, and the
reasoning is worth keeping so nobody rebuilds it: **the siren, the flashing lights in your mirror and
the red minimap blips already say "they are close and getting closer"**. The card was a fourth cue
for the same fact and the only one that required looking away from the road. The nearest-unit
distance went back to the corner card. `objectiveHud.setInstruction()` was deleted with it — dead API
that looks live is how the next person concludes a thing is supported.

⚠ **Two defects it shipped with first, both the same root cause — a live value recomputed from the
raw current frame:**
- The bust countdown was positioned at `top:96px`, which is the objective card's own top, so it drew
  **straight through** the card. Two elements, one coordinate, no layout relationship between them.
- The Closing/Gaining word, the compass word and the metre digit **all churned ~10 times a second**.
  Nothing in a pursuit changes that fast; the jitter was in the measurement. `nearest < prev - 0.05`
  compares two consecutive frames, so at a steady gap the sign is decided by noise; an 8-sector
  compass alternates whenever a bearing sits on a boundary; and the last digit of "46 m" changes
  every frame.

The lesson outlives the card, so it is recorded in the backlog: **a live HUD value needs a dead band
and a committed state, not the current frame's answer.** The 5 m rounding survives on the corner card
for exactly that reason. 520 tests pass.


## 2026-09-05 — M-8 Heat's objective card · M-9 the ETA

**M-8.** Heat was the only mode without the centre card, because it has no destination and
`update(nav)` therefore has nothing to say — it would print its honest "No road route yet" fallback
forever. New `objectiveHud.setInstruction()` lets a mode fill the card in directly.
- The cue is **two directions on purpose**: the ARROW is camera-relative (it must match what is on
  screen, and the visual world is X-mirrored — a world bearing comes out reversed left/right, which
  is the bug `dashMode`'s comment records), while the WORDS are a world compass point, because "head
  north-east" survives you swinging the camera and "bear left" does not.
- ⚠ The corner card's sub-line lost "· nearest 20 m" in the same change. The centre card owns that
  number now; printing the same fact twice, ten inches apart, is exactly what City Cab shipped with
  "Fare 1 · Pick up" beside a card already reading PICK UP.
- Kicker reads the TREND — Closing / Gaining ground / Almost clear — and the accent goes green when
  the gap is opening, so the colour says how it is going before the number does.
- **No world halo, deliberately:** a glowing ring over a police car is noise when it already has
  flashing lights. `policeMode` now takes `camera`, which it never did.

**M-9.** `planRoute` returns `timeS` — `gScore[t]`, **the number A\* was already minimising**. It was
computed on every plan and dropped on the floor. An ETA derived afterwards from length ÷ some average
speed would be a second, worse estimate that disagrees with the route the player was actually given.
`objectiveNav` scales it by the fraction of route remaining rather than re-planning to refine it.
Shown beside the distance ("420 m · 3 min"); under 45 s it reads "under a min", because "0:38" on a
walk-up is spurious precision, not information.

3 new tests — including the one that justifies the whole ticket: **the same 300 m takes >2× longer on
a service lane than on a primary**, so the ETA follows the class and not the distance. **520 pass.**


## 2026-09-05 — P-2: pedestrians cross the road (one line had blocked 11,325 crossings)

- **THE BLOCKER WAS A WHITELIST, NOT A DESIGN.** The bake has flagged `footway=crossing` since
  bake-surface-clipping Phase 1 and `tileParserWorker` has read it since v8 — but
  `getLoadedRoadSegments()` is a projection whitelist and `crossing` was not in it, so for that whole
  time the flag did not exist downstream, silently, as `undefined`. The file's own comment warns
  about this and calls itself the seventh copy-site. This is the eighth.
- **Measured the population before wiring anything to it** — new `backend/tools/crossingCount.mjs`:
  **11,325 crossings in 217 of 444 tiles**, footway 10,011 · cycleway 1,302, median **14.5 m** and
  p90 26.5 m. A road's width, which is the right shape for the thing.
- **Runtime proof, per D-23:** `window._ddCrossings()` reports what the ENTITY SYSTEMS can see, not
  what the parser produced, and flags any segment whose `crossing` is `undefined` — so it fails loudly
  if the whitelist drops it again.
- **Behaviour:** each crossing end within 7 m of a pavement becomes a **hook** at an arc-length
  position on it, so "is there a crossing near me" is answered once per pavement rather than per
  pedestrian per frame. 35% of walkers reaching a hook commit; they **wait at the kerb** 0.5-2.2 s,
  cross, re-join the nearest pavement on the far side, then ignore crossings for 12 s. The wait is
  what makes it read as a decision instead of a teleport.
- ⚠ Fallbacks: a crossing whose far side has not streamed in finds no pavement to re-join, so the
  walker turns round rather than standing in the road forever; and `newLeg()` is gated off the
  crossing states, or the walk/stand timer would pull someone out of the road halfway across.
- ⚠ **They do not look for traffic.** The kerb wait is a fixed random interval, not gap acceptance —
  a pedestrian will step out in front of you. Named in the docs as the next increment.
- 7 new tests (**517 pass**), including the two that would have made this pointless if wrong: both
  pavements hook **opposite ends** of the same crossing, and stepping off one end re-joins the pavement
  on the **far** side — otherwise crossing is an animation that returns you where you started.


## 2026-09-05 — One board (`backlog.md`), and three of my own status claims corrected

The open tickets were spread across `TODO.md`, three subsystem docs and the v3 tracker. Consolidated
into **[backlog.md](backlog.md)**; `TODO.md` is now a pointer to it, because two lists is how a ticket
gets worked on twice or not at all.

⚠ **Three things I had reported were wrong, and checking beat recalling every time:**
- **"`main` and `v3` have diverged."** They have not. `git merge-base --is-ancestor v3 main` passes —
  **v3 is fully contained in `main`**, which is 16 commits ahead at 510 tests. The v3 tracker's RESUME
  block still says "Branch `v3`, 395 tests"; that block is stale, and backlog.md now says so at the top.
- **"parkingRenderer lands at 0.06 against the road deck's 0.05."** Half right. The parking *surface*
  is terrain+0.04, which is **below** the deck; it is the parking *markings* at +0.06 that sit above.
  A car park abutting a street has its surface buried and its paint proud — a different defect from
  the one I described.
- **"P-4 is 39 draw calls → 3."** Stale. P-1's `visible = count > 0` gate already means only the
  ~10-14 non-empty cells of 42 are submitted. P-4's remaining case is smooth animation, not draw
  calls, and the ticket says to re-argue it before starting.

Also settled: **Z-3 (building z-fighting) is DROPPED** — it came from a stale TODO line, nobody has
reported seeing it, and it does not belong to `groundLayers` (flat co-planar ground only; 3D geometry
wins by having real height). If it ever appears it is an OSM-repair data ticket. **P-5 (pedestrian
art) is not work, it is a decision** the user has to make, because it contradicts the v3 ruling.

⚠ **Numbering collision fixed:** the changelog had used "Z-2" for the paint-ladder *correction* while
`ground-layering.md` used it for *surfaces outside the scheme*. The correction is **Z-1b** now.

Verified while writing it: `crossing` really is absent from the segment whitelist (0 occurrences);
only 3 of 11 people clips are baked; gore sits 2.4 cm and drain 0.9 cm BELOW the drawn asphalt; the
router computes travel time and throws it away; Heat references neither the nav nor the marker.


## 2026-09-05 — C-2: the sea was still over Diagonal Mar — the HAND TRACE was 310-500 m inland

C-1 fixed a bad OSM chain being adopted. The user re-checked at Passeig Marítim de la Mar Bella and
the street grid was still under water. C-1 was a real fix for a real bug; it was not THIS bug.

- **⚠ THE GUARD HAD A HOLE THE SHAPE OF ITS OWN FALLBACK.** C-1's land anchors were applied only to
  a CANDIDATE OSM chain. The hand trace — the fallback, the thing that runs whenever a candidate is
  rejected, i.e. the thing that was running — was never checked against anything at all.
- **MEASURED, NOT NUDGED.** `coastline.js` says "nudge points when a screenshot shows the waterline
  off", and that instruction is how it got wrong. New `backend/tools/coastlineProbe.mjs` reads
  `natural=coastline` straight out of the baked tiles — **34.65 km across 32 ways in 48 tiles, the
  data was there all along** — and prints the distance from each hand point to the real shore:
  Besòs 1204 m · Llevant 503 m · Mar Bella 386 m · Bogatell 432 m · Nova Icària 310 m, then ≤150 m
  everywhere south of Port Olímpic. **The 310-500 m run is exactly the stretch that flooded.**
  The NE points are now the probe's measured vertices; the southern ones are untouched.
- ⚠ **OSM's coastline ENDS at 41.3382,2.1695.** The four Zona Franca points are unverified hand
  guesses with nothing to correct them against — the probe finds nothing within 0.9-3.9 km. Labelled
  in the file: do not "fix" them by eye.
- **The length gate went 12 km → 5 km**, and is now explicitly only a sanity floor. The tiles'
  longest single coastline way is **6.19 km** (probe), so C-1's 12 km threshold would have refused
  every chain that failed to stitch — a guard that can never pass is not a guard. `seaIsSane()` is
  the real test, exactly as C-1's own comment argued.
- ⚠ **The probe itself was wrong first, in this codebase's signature way.** It read the water
  polygons as world coordinates and reported the Barcelona coastline at **14°S**. They are stored as
  ABSOLUTE MERCATOR — `readFloat32Pairs` subtracts the tile origin only because the worker passes it
  ox/oy. Same class as N-7 and N-25. It now inverts Mercator directly, so there is no origin left to
  get wrong. (It also first reported "NO COASTLINE IN THE TILES" from a flat `readdir` that found one
  file — the tiles are nested z/x/y.)
- Land anchors added for the reported area (Diagonal Mar, Mar Bella blocks, Rambla de Prim) and the
  baseline test renamed to say what it is now guarding: **the fallback is checked too.** 510 pass.

Verified after the fix: Mar Bella blocks, Diagonal Mar, Rambla de Prim, Passeig Marítim, Bogatell
and Carrer del Gas all read LAND; the water off Mar Bella, off Bogatell and the open Mediterranean
all read SEA.


## 2026-09-04 — C-1: the sea was drawn over Poblenou (a runtime bug, not a bake bug)

User: *"there is some baking issue as why is sea coming where the buildings are"* — screenshot at
Carrer del Gas, buildings and streets standing in blue water behind a dead-straight diagonal
waterline. ⚠ **Not the bake.** No re-bake, frontend only.

- **CAUSE: `ingestCoastline` was first-tile-wins.** It stitched whatever `natural=coastline` ways
  were in the FIRST tile that carried any — and `noClipTileStrategy` hands a tile the full geometry
  of every way touching it, so one tile cleared the 3 km sanity check with a chain covering a
  fraction of the coast. The sea polygon closes 30 km offshore **from that chain's two ends**, so a
  chain stopping mid-city closes with a straight line *through* the city, sea on one side. The
  straight diagonal in the screenshot was that closure edge.
- **Segments now ACCUMULATE across tiles** (deduped by endpoint pair, because the no-clip strategy
  hands the same way to every tile it touches) and a longer chain is adopted as the player drives.
- **⚠ A LENGTH GATE CANNOT DECIDE THIS, and that is the point.** The threshold went 3 km → 12 km,
  but a wrong 15 km chain still floods the city. The candidate is now tested against the thing that
  actually matters: **known inland landmarks must not come out as sea** (Plaça Catalunya, Sagrada
  Família, Camp Nou, Plaça d'Espanya, Park Güell, Glòries), and known offshore points must. A
  polygon that floods Sagrada Família is rejected however many kilometres it is, and the hand trace
  is kept — a slightly wrong waterline and the city under water are not comparable failures.
- `closeSea()` is now shared between the ingest-time validation and `build()`, so **the polygon that
  is tested is the polygon that is used**. Two implementations of "which side is the water on" would
  be two chances to get it backwards.
- New: `frontend/test/coastline.test.js` — 5 tests. The bug itself is one assertion: feed a ~1 km
  Poblenou fragment and every land anchor must still be land. A second test feeds a *long* (15 km)
  but inland-running chain, which is the case a length threshold passes and the anchors catch.
  **510 tests pass.**

⚠ Still true, and worth knowing before anyone reaches for this again: the underlying weakness is that
the bake ships **no open-sea signal at all** — no OSM water polygons for the sea, and Copernicus
GLO-30 puts the sea at 2–5.8 m here, overlapping real street elevations. The proper fix stays
bake-side (stitch `natural=coastline` and sink sea cells in the elevation grid), as coastline.js has
said since it was written.


## 2026-09-04 — Z-2: the paint ladder came back down (Z-1 over-corrected)

User, on a Carrer de Sants crossing: *"these big horizontal line groups … they are pretty high in z
axis and looks floating"*. Correct, and it was mine.

- **Z-1 fixed an ORDERING bug by raising everything.** The depth-bias table and the height table
  encoded opposite orders; the fix only needed the order. Instead the ladder was rebuilt at a 5 mm
  step held one step off the floor "for margin", which took **zebra crossings from 1.6 cm proud of
  the asphalt to 3.1 cm** and stencils from 1.6 to 3.6. At the grazing angle a road is driven at,
  3 cm of lift on a wide white band reads as a decal hovering over the street.
- **Fixing an ordering bug by changing heights is fixing the wrong quantity.** Paint does not need
  clearance to be *ordered* — the depth bias does that — it needs clearance not to be *buried*. Now a
  **2 mm step at the lowest base that clears `MIN_PAINT_CLEARANCE`**: parkingZone 1.6 cm, marking
  1.8, crossing 2.0, stencil 2.2. Every class is within 6 mm of what shipped for months without
  complaint, and **inverted pairs stay at 0** — the Z-1 invariant is untouched.
- **New guard: clearance now has a CEILING as well as a floor.** `groundStack.test.js` asserts no
  paint class stands more than 2.5 cm proud. The floor stops burial; without the ceiling nothing
  stopped the opposite mistake, which is the one that actually shipped. A couple of centimetres proud
  is a marking; four is a kerb. **505 tests pass.**

⚠ Still open, reported but NOT changed: in the same screenshot the zebra banding covers a very long
stretch of Carrer de Sants rather than a junction's width. That is a data/extent question, not a
height one, and diagnosing it from one screenshot is how three earlier guesses this session went
wrong. It needs `_ddPick` on a stripe, or a count of crossing ways and their lengths in that tile.


## 2026-09-04 — M-7: an invisible wall at the world boundary

User: *"in boundry of our bake add a invisble wall so they cant go past that … on hit it should say
gaem boundry please move back or roate car as well to opposite direction"*.

- **What was there before, described honestly:** haze curtains that say "edge", and a breadcrumb
  teleport 45 m past them. Nothing in between actually STOPPED you — so the behaviour was "drive
  into the void for 45 m, then get yanked somewhere else". A teleport is a punishment for something
  the game never prevented.
- **`boundaryPush(wx, wz)`** returns the world-axis displacement back inside, and
  `carDriver.holdInBounds(px, pz)` applies it. Three things in order, because any one alone feels
  wrong: **clamp** the chassis to the plane (or you creep out under throttle); **kill the OUTWARD
  velocity component only** (zeroing all of it makes the wall a brick — keeping the tangential part
  lets you slide along the edge, which is what a wall does); and **turn the car to face back inside**,
  or you are left nose-first against nothing with no cue which way the world is.
- **Not a collider, deliberately.** Four static Rapier boxes would have to be re-placed as the physics
  origin moves and be tall enough that nothing jumps them. A position constraint gives the same felt
  result — you cannot pass — for no colliders and no streaming. **The teleport stays as the backstop**
  for a physics fling or a fall; it should now essentially never fire.
- The notice uses the shared `fxEvent` banner ("Edge of the map / Game boundary / Turning you
  around"), throttled to once per 4 s.
- ⚠ **A test caught a real error in the first cut.** It converted degrees to metres by hand
  (`111320 · cos(lat)`) and the push landed **0.69 m short every time** — that formula describes the
  GROUND, while the projection describes world units, and the two differ by the Mercator scale at
  this latitude. The wall is now a world-space box projected from the same corners the haze curtains
  use: exact by construction, and it drops a `worldToLatLon()` from the per-frame path.
- New: `frontend/test/worldBoundaryWall.test.js` — 6 tests. The one that matters most asserts the
  push points **back into** the world on every edge: world +x is east and physics X is mirrored, so a
  sign error here builds a wall that **ejects** you, which is exactly the class of bug the CLAUDE.md
  danger note is about. Also pinned: one application clears the boundary exactly (a push that only
  gets halfway is a wall you can lean through), corners push on both axes, and **the wall engages
  before the teleport arms** — otherwise it would be decorative and the player would still get yanked.
  ⚠ Two of my own test premises were wrong first (a 0.5 m tolerance hiding the 0.69 m bug, and a walk
  too short to reach the edge, which concluded "the wall never engaged"). **504 pass.**


## 2026-09-04 — M-6: Heat on the shared HUD, a rail that closes its own gaps, random spawn, one economy

- **Heat (`policeMode`) was the last mode on the old style.** A `rgba(0,0,0,.5)` box reading
  `🚨 WANTED ★★★☆☆` over `⏱️ 12s  🚓 3  20m` — four emoji standing in for labels and a star rating
  spelled out in ★/☆ code points at five steps. The label IS the rating now (`WANTED 3/5`) and the
  heat bar is a real meter that goes yellow → amber → red. Its bust/escape countdown keeps a centre
  slot because it is a LIVE timer, not an event, so it cannot go through `fxEvent` (which plays once
  and leaves) — but it now wears the same panel as everything else.
- **⚠ THE RAIL, and the bug that forced it.** Rush Hour has two top-right cards and only shows the
  countdown during a drop-off, so with hard-coded offsets the cargo card kept its `top:106px` and hung
  in mid-air with the timer's empty slot above it. Magic offsets cannot express "stack, and close the
  gap when one hides". `hudRail()` is a flex column; `display:none` leaves the layout instead of
  leaving a hole, and CSS `order` sets the sequence so a card's position does not depend on when it
  was constructed. All five cards across four modes are railed.
- ⚠ **A backtick in a CSS comment closed the template literal it lived in** and broke `hudTheme.js`
  on the first attempt. The note in that comment now says so.
- **RANDOM SPAWN — asked for three times before it got done.** Every fresh load starts somewhere in
  `SPAWN_POOL` (12 districts). `?spawn=lat,lon` still wins, so the hub's place picker holds; new
  `?spawn=fixed` pins Gran Via, which **perf work must use** — the v3 benchmark and `bench/benchRoute`
  both start there, and a randomised start makes every drive report incomparable to the last one. Only
  `_activeSpawn` moves: `START_LAT`/`START_LON` stay pinned because the projection origin must not,
  which is the same reason `?spawn=` has always been safe. The hub's `PLACES` is now `SPAWN_POOL`
  itself rather than a second copy of the same coordinates — the picker cannot offer somewhere the
  game will not start.
- **ONE ECONOMY (`game/economy.js`).** Three payout formulas were inlined at three points of payment,
  paying into the same wallet — so "money comes in too fast" was a statement about a SUM that no single
  file could answer, and retuning meant finding three literals and hoping they were the only ones.
  `RATE = 0.45` is the single dial. Roughly a 55% cut, weighted toward **distance**: the old rates paid
  a flat opening fee big enough that chaining short hops beat driving anywhere, which is the mechanism
  that made the balance climb. A 350 m fare was $10 before tip; it is $5. Rush Hour's streak cap goes
  ×2.5 → ×1.8, because a multiplier on a base that already scales with distance compounds.
- New: `frontend/test/spawnAndEconomy.test.js` — 8 tests. Every pool entry is inside the baked extent
  (outside it the player boots into a blank world, which looks like a broken game and logs nothing);
  no duplicate coordinates; payouts scale with distance faster than with the flat part; the retune is
  pinned **against the old formulas**, so raising `RATE` back fails the suite; and no payout can be
  zero, because a completed job that pays nothing reads as a bug. **498 pass.**
- `TODO.md`: multiplayer added as a programme, with the part that actually blocks it written down —
  nothing in this game is authoritative. Physics is client-side, traffic and pedestrians are seeded by
  nothing, and the spawn is now randomised per client, so two players would see different cars, crowds
  and starting places in the same city. Cheapest honest first slice: ghost cars.


## 2026-09-04 — M-5: the accent bar is gone, and every readout moves to one corner

- **No accent bar on any card.** The 3px coloured rule down the left edge was M-3's replacement for
  the old warning-style outline, and it was furniture in its own right: a hard vertical line against
  a rounded panel fights the corner radius it sits inside. The cards already carry the mode's colour
  where it means something — the turn glyph, the label, the distance — so the bar was an accent doing
  no work. Removed from `statCard` and `objectiveHud`; `setAccent()` now only re-tints the label,
  which is all any caller needed.
- **One column for mode readouts: TOP-RIGHT.** City Cab's earnings and Rush Hour's cargo card moved
  off the left; Checkpoint Dash's clock and Rush Hour's countdown were already there. The minimap
  owns bottom-left and the objective card owns top-centre, so a card in each corner was three places
  to look while driving. Rush Hour stacks its cargo card under its clock rather than opening a fourth
  position.


## 2026-09-04 — M-4: speed blur off, timers to the top-right, day/night is keyboard-only

- **The green mush behind every card was the RADIAL SPEED BLUR** (`ui/radialBlurPass.js` +
  `ui/speedLines.js`), not anything new — it ramps from 30 km/h and smears the whole frame, and it
  sat behind exactly the result panels the player is meant to be reading. **Off by default**;
  `?speedblur=1` restores it. Off, the pass is skipped and the streak canvas is never created, so it
  is a free frame rather than a shader computing nothing.
- **Checkpoint Dash printed its finish twice.** `fxEvent` fired a FINISHED banner at `top:32%` while
  the result card showed FINISHED, the time, the checkpoint count and the best at `top:34%` — the
  same three facts, on top of each other. The banner is gone; the card is the celebration and the
  confetti is the punctuation.
- **Timers moved to the TOP-RIGHT** (Dash's clock and Rush Hour's countdown). Top-centre is where the
  result card lands, which is how a timer ended up drawn under a summary panel; the corner was free
  because —
- **The day/night button is gone.** `N` was already bound and already listed in the on-screen controls
  strip, so the frosted icon button was a second way to do a thing the player is already told about,
  occupying the one corner the HUD wants. The element is still constructed (it owns the icon and the
  click handler) but never appended, and `envToggle.toggle()` is the API now — `element.click()` on a
  detached node still works, but nothing should depend on that.

⚠ Documented for the next person: **the "what is that behind the card" question took three exchanges
to answer** — the speed blur, the timer card and the duplicate banner were three separate things
stacked in the same place, and each looked like the others from a screenshot.


## 2026-09-04 — M-3: one HUD, and a per-frame throw that froze the game

### ⚠ FIRST: the crash I introduced, and why it was worse than a typo
User: *"game feels stuck not able to move the car after these chnages"*. `gates[i]` used to be a
`THREE.Group`; M-1's shared marker made it an API object whose transform lives on `.group`. So
`g.position.y` in `dashMode.updateArrow` read `undefined.y` and **threw on every frame from inside
`animate`** — everything after that line stopped running: car input, camera, the lot. The game read
as completely frozen and the cause was a HUD arrow.
- Fixed (`g.group.position.y`), **and fenced**: the four `xxxMode.update()` calls sat bare in the
  loop, so a typo in a side quest could take the car down. `_tickMode()` now catches per mode —
  first throw prints with its stack, then that mode is disabled for the session and the drive
  continues. Loud once, then quiet: 60 exceptions a second is what buried this one.
- ⚠ I put the guard INSIDE `animate` on the first pass, where `_modeFailed` is a fresh `Set` every
  frame — a mode would be "disabled" for exactly one frame and throw again forever. Hoisted to
  module scope.

### M-3: `hudTheme.js` — one panel for every card
User, on the City Cab money card: *"this can be improed"*, then the shift-over panel (*"should fade
away smoothly"*), the banners, and the 3-2-1.
- **THE DEFECT WAS TWO DESIGN LANGUAGES ON SCREEN AT ONCE**: a green-bordered money panel in the
  corner and the dark objective card in the middle, at the same moment, in the same game. Each mode
  also had its own copy of the CSS, so it could only diverge further.
- **What the green border was actually doing:** a 2px saturated outline all round a panel is the
  browser's WARNING-dialog idiom, so a readout read as an alert. Worse — green panel, green border,
  mint number, and City Cab's objectives sit in parks: over foliage the card vanished into what it
  was drawn over. Now a neutral dark panel with the mode colour as a 3px **bar** down one edge, and
  a **white** value, which is the only thing that reads over both night asphalt and a sunlit hedge.
- **Emoji removed from every HUD surface** — 💵 in front of a number that already starts with `$`,
  🧍 in front of "Picking up", 📦/🔥/⏱️/✨ through Rush Hour, and the 🥇🥈🥉 medals. They render as a
  different picture on every platform and drag the OS palette into a screen with its own. The medal
  is a colour and a word now; `medalFor`'s `emoji` field is deleted, not orphaned.
- **Copy that says something.** "Fare 1 · Pick up" repeated the objective card two inches away, in
  the same 10px caps, at the same moment — the corner card is about MONEY, the centre card is about
  where to go. "PASSENGER ABOARD" now carries the trip length and base fare; "DELIVERED" carries the
  fare and the tip. `fxEvent()` gives every banner the same three slots (kicker / title / sub) so
  copy stays in the caller and type does not; `fxBanner`'s HTML-string API is gone from all callers.
- **`1 fares`** — a plural that was wrong exactly when the player had done the least, i.e. the one
  they were most likely to see.
- **The result panel FADES.** It was `display:none` on a `setTimeout`, so after nine seconds it
  vanished between one frame and the next, which reads as a bug rather than an ending. `hide()`
  returns a promise that settles when it has actually gone, with a timeout so a cancelled animation
  can never leave a panel stuck on screen.
- **The countdown has a ring.** The old digit ended its keyframe at `scale(.85); opacity:.85` — each
  number finished *shrunk and dimmed* and sat there until the next replaced it, so the tension leaked
  out of exactly the moment it should build into. Now a ring sweeps once per second around the digit,
  which is the affordance a countdown actually has: you can see the second running out.
- **Meters instead of glyph art.** Rush Hour drew parcel condition as `'▮'.repeat(f) + '▯'.repeat(5-f)`
  — a five-step bar made of text in whatever font the OS picked for those code points. It is a real
  meter now, and it colours green → amber → red. The timer card turns red *whole* under five seconds,
  not just its digits: you read the colour long before the number. Checkpoint Dash gained a progress
  bar, because "3 / 9" is a fraction you have to work out at 90 km/h.
- Caller strings go through `textContent`, never `innerHTML` — these carry OSM street names, and the
  apostrophe in *Carrer d'Aragó* has no business being parsed as markup.
- 490 tests pass; production build clean.


## 2026-09-04 — M-1: mode title cards, one objective halo, and real road directions

User brief: a logo card when a mode starts; better pick-up/drop-off UI; halos that "match the current
game vibe and look good in day and night properly"; and directions on the map "proper like google
maps" for Checkpoint Dash, City Cab and Rush Hour. Full write-up: **[game-modes.md](game-modes.md)**.
Frontend only, no re-bake. 490 tests pass; production build clean.

### Title cards (`game/modeIntro.js`)
- Five logos supplied and installed. **ORDER IS THE DESIGN: hub closes → card over the city → mode
  starts.** `playModeIntro()` returns a promise and `mainMenu.drive()` awaits it, because Checkpoint
  Dash counts 3-2-1 from its first update and the two would fight for the same 40% of the screen in
  different type. Free Roam gets a card too; it just has no mode to start afterwards.
- The scrim is a radial dim, not a black-out — a title over a shot, not a loading screen. The card
  scales UP on the way out: shrinking away reads as cancelled, drifting past reads as getting out of
  the way. Honours `prefers-reduced-motion`. Falls back to icon + name, laid out properly, if a logo
  is missing — that is what ships if art never arrives.
- ⚠ **Budget.** The supplied PNGs were 1.4-2.1 MB **each, ~9 MB for five** — three times what v3
  P0-11 deleted two pedestrian variants to save. Shipped as alpha-trimmed 1200 px WebP: **633 KB for
  all five**, trimmed to the ink first or the card is mostly empty margin.
- `drive()` now captures the pick before the await. `selected` is live, so reading it on the other
  side would start whatever the player last hovered rather than what they pressed.

### One objective halo (`game/objectiveMarker.js`)
- Three modes each built their own from the same four primitives and had drifted: dash had a bloom
  torus and a 48-segment ground ring, taxi and delivery had neither, and the beam sat at a different
  opacity in each. One implementation now.
- **Why they looked wrong, measured rather than guessed: every part was a flat `MeshBasicMaterial` at
  fixed opacity and the beam was `AdditiveBlending` at 0.16 — a NIGHT-ONLY recipe shipped into a
  day/night game.** Additive adds to what is there: against night asphalt (~0.05 luminance) the beam
  is the whole signal; against a sunlit street (~0.55) it adds 0.16 to something already near white,
  which is mathematically invisible and blew the sky out where it did register. Plus a hard-edged
  column ending in a straight line 90 m up, a `RingGeometry` annulus at constant alpha (a decal *of*
  a ring, not light on a road), and no distance behaviour at all on a part whose entire job is
  long-range locating.
- Now: gradient `CanvasTexture`s throughout, and a day/night profile that **changes BLENDING, not
  just opacity** — alpha + a deepened hue by day, additive + a brighter core at night. The beam
  smoothsteps in over 55→150 m and is off under the bumper; the ground pool strengthens as you
  arrive, so there is never a moment without a mark on the ground.
- ⚠ **Two traps found on the way.** (1) `onNightModeChange` fires only on a TOGGLE, so a marker built
  when a mode starts — minutes after boot — came up in the day profile; added `isNightMode()` to
  `envToggle` and read it at construction. (2) That API has **no unsubscribe** and dash builds a
  marker per gate per run, so a per-marker subscription is a leak that grows with play time — one
  module-level subscription and a registry `dispose()` actually removes from.

### Road directions (`game/router.js` + `objectiveNav.js` + `objectiveHud.js` + map)
- **The defect: every mode pointed with a BEARING.** On an Eixample grid the marker reads 180 m
  north-west while the only way there is 400 m round two blocks — and the number on screen goes UP as
  you drive the correct route. Replaced with A* over the loaded road network.
- **Routes on TIME, not distance** (per-class speed table), so it prefers Gran Via to a shorter
  service lane. The heuristic uses the table's FASTEST speed — an average overestimates the remaining
  cost and silently returns non-optimal routes, which looks like "the nav sends me the long way" and
  is never traced back to the heuristic.
- **The graph is clipped to the TRIP, not the resident city**: 9-18 tiles is ~10⁵ nodes and tens of ms
  on the main thread, to plan a 300 m fare.
- ⚠ **A test caught a real hole in the first cut.** Clipping on "either endpoint inside the box" drops
  an arterial that CROSSES a 700 m trip box with its next node a kilometre away — so the route would
  detour around the one street that goes there. Now an AABB-overlap test. Also pinned: a **1 m node
  snap**, without which tile-clipping leaves each tile a disconnected island and every route dies at
  a boundary.
- ⚠ **The graph is UNDIRECTED and ignores oneway, deliberately** — this routes a player, who turns
  around, and a one-way graph over tile-clipped OSM strands the goal behind an unreachable kerb often
  enough to be worse than an occasional wrong-way leg. Revisit when the network is proven connected.
- Turns carry **street names** ("Turn left onto Carrer d'Aragó") — already in the tiles, and per
  CLAUDE.md's census otherwise discarded. A <28° kink is a bend, not an instruction.
- `objectiveHud` replaces **three** hand-built pills (three inline `cssText` blocks, three `top:`
  values, three CSS triangles made of `border-left:8px solid transparent`). Shows the next maneuver
  over distance-remaining-along-the-roads, and has an honest "Direct / No road route yet" state
  instead of inventing a turn while the far end is still streaming.
- Map: `customMap.drawRoute` + `minimap.setRoute`. Drawn **into the map canvas after `drawTile` with
  the same projection**, so the heading-up CSS rotation carries it — an overlay layer would drift
  against the streets under it. Dark casing under a bright line (survives the pale day ground and the
  navy night one without changing colour), route BLUE with the mode colour on the pin (a green route
  on a green park is invisible), the driven part dimmed, and direction chevrons.
- ⚠ `_route` is declared ABOVE `redrawMap` in `minimap.js`: the constructor calls `redrawMap()` while
  still running, so a `let` further down is a temporal-dead-zone throw on boot, not an undefined read.

### Not done
Heat has a title card but no halo or routing (no fixed objective). No ETA surfaced (the router
computes travel time internally). No chime on a turn. No lane guidance or roundabout exits. Planning
is on the main thread — bounded and throttled, no hitch measured, but not yet measured on a 500 m
trip through the densest tiles.


## 2026-09-04 — Z-1: the two ground-layer tables encoded OPPOSITE orders

Road/surface Z-layering, from `TODO.md`. Full audit: **[ground-layering.md](ground-layering.md)**.
Frontend only, no re-bake. 478 tests pass.

⚠ **The TODO's premise was stale.** It asked to design "ONE layering scheme" to replace ad-hoc
Y-offsets — that scheme already existed as `map/groundLayers.js`, and the audit found **zero**
violations: all 7 `polygonOffset` sites outside `applyGroundLayer()` are transparent `depthWrite:false`
decals, which the module's own RULES exempt, and the `assertGroundLayers` dev guard is wired into every
mesh via `tileManager.js:150`. The depth-bias half is done. Everything below is the other half.

- **THE FINDING: the bias table and the height table encoded opposite orders for every paint class.**
  The module flagged ONE disagreement (parking stripes above lane lines geometrically, under them by
  bias) and reproduced it as "a candidate for the next paint pass". Measured across all 21 pairs it is
  **5 inverted pairs, and every one is paint** — the three non-paint classes agreed.
  `bias: parkingZone < marking < crossing < stencil` vs `height: crossing < stencil < marking < parkingZone`.
- **Why it never got chased:** both tables are internally consistent and each is right in a different
  regime, so the order **swaps as the camera moves**. `polygonOffset = factor × m + units × r`, and road
  is seen at a grazing angle from a chase cam, so `m` is large and the BIAS order wins down the street;
  under the bumper the surface is face-on, `m` collapses, and the 5 mm of real separation wins. With
  `near = 1, far = 50000` depth resolution is `≈ z²/16.8e6` — 0.6 mm at 100 m, 5.4 mm at 300 m — so even
  the constant term crosses the geometric gap inside the drawn road distance. **No camera position sees
  a consistent street.**
- **Resolved toward the BIAS**, on three agreeing grounds: it encodes the art intent the table was
  written with; it is physically right for the pair that actually overlaps (a zebra is painted ACROSS
  the lane lines, so `crossing` belongs over `marking` — the height table had that backwards); and it is
  what is visible at the angles road is mostly viewed at, so matching geometry to it moves least on
  screen. New ladder, 5 mm steps in bias order: parkingZone base+0.100 · marking base+0.105 · crossing
  base+0.110 · stencil base+0.115. Nothing moves more than 2 cm. **Inverted pairs 5 → 0.** Held one step
  above the old floor so the lowest paint class keeps **2.1 cm** over the drawn asphalt instead of 1.6 cm
  — `MIN_PAINT_CLEARANCE` is 1.5 cm and burial is this module's documented failure mode, so 1 mm of
  margin is not margin.
- **Z-1b: four `roadRenderer` paint constants duplicated the table** (`MARKING_Y_ABOVE_ROAD`,
  `STRIPE_Y_ABOVE`, `BIKE_Y_ABOVE`, `ARROW_Y_ABOVE`), with the arithmetic spelled out in comments. All
  four AGREED with the table — which is exactly what makes it the "two references for one height, kept in
  sync by hand until it isn't" failure the module exists to end, inside its biggest client. Four other
  classes already derived, so the file was half-converted. Now all derive. The real subtlety is kept:
  `buildFlatRibbonGeometry` adds a **hidden +0.02** to every vertex, so ribbon paint is handed
  `groundLift(cls) − ROAD_ZFIGHT_OFFSET` and custom-quad paint (arrows) takes the full lift — **verified
  at each call site, not read off the comments.**
- **Z-1c: `GREEN_OFFSET_Y = 0.01` was declared twice**, identically, in `greensRenderer.js` and
  `vegetationRenderer.js`, while `areaFeaturesRenderer` carried `AREA_OFFSET_Y = 0.02 // "above greens'
  0.01"` — a numeric dependency on a constant it cannot see change. Three copies of one ladder. Now
  `TERRAIN_LIFT`, values unchanged. (`vegetationRenderer`'s copy is the N-12 dead twin; unified anyway.)
- **New invariant, and it is the actual deliverable:** `groundStack.test.js` asserts that depth-bias
  order and physical order agree for every pair sharing a base. `ROAD_BASED_LIFTS` names the comparable
  set — `tactile` is excluded because its 0.005 is measured from the SIDEWALK, and ranking it against a
  paint lift compares two numbers that are not in the same coordinate.
- ⚠ **The suite had the same duplication it was testing for:** three tests each carried their own copy
  of the shipped absolute stack, so re-ordering broke two of them for reasons unrelated to what they
  test. One test owns the absolutes now; the other two assert relationships.
- **Still open, `TODO.md` narrowed rather than closed:** Z-2 (parking lots, bus stops, tram rails,
  tunnel approaches and blend strips are outside the scheme entirely — `parkingRenderer` lands at 0.06
  against the road deck's 0.05), Z-3 (building-wall z-fighting — a DATA problem for the OSM repair
  layer, not a ground-layer one), Z-4 (`gore`/`drain` sit BELOW the drawn asphalt and are exempted from
  the clearance assertion; plausible for a drain cover, doubtful for a gore fill, never checked on screen).


## 2026-09-04 — V-16: C blends between camera modes instead of cutting

User: *"i want smooth camera transition in all"* (camera modes). All three view changes now arc.

- **The blend runs in the car's yaw-only LOCAL frame.** In world space a car at 90 km/h leaves its own
  camera path behind mid-transition; in the local frame the arc rides with the car.
- **The path is lifted over the roof**, `TRANSITION_LIFT × sin(πt)`, scaled by how close the straight
  path passes to the car centre in plan. The old code cut deliberately, with a comment saying a straight
  lerp from 6.6 m behind to a point on the bonnet goes **through the bodywork** — right diagnosis, wrong
  remedy: a cut avoids that rather than solving it. Measured, the straight path crosses the car centre
  **24 cm** over a 1.2 m roofline (a coin toss against mirrors and aerials); the arc makes it **~0.6 m**.
- **The lift is scaled, not blanket.** wide → close keeps both rigs behind the car (closest approach
  4.5 m) and gets **zero** lift — a fixed one would hop the camera for nothing on every press. Measured
  apex: wide→close 2.50 m (= its own start height, no bob), close→bumper 2.38 m, bumper→wide 2.68 m.
- **Starts from the live camera position, not the outgoing rig's ideal** — the chase cam lags its ideal
  by design (`LERP_POSITION = 0.16`), so starting at the ideal pops on frame one. **`ap = 1` while
  transitioning**: the eased arc *is* the smoothing, and lerping toward a moving blend point would drag
  the camera off its clearance — the two rigs disagree on the rate anyway (0.85 bumper vs 0.16 chase),
  which is what would put a pop at the far end of an otherwise smooth move.
- **0.6 s, not 0.5.** Smoothstep peaks at 1.5× its mean rate, so the ~9.7 m wide↔bumper move at 0.5 s
  puts 0.38 m between consecutive frames — 23 m/s of camera. It reads, but it whips. At 0.6 s the worst
  measured step is 0.408 m across all three transitions.
- Look-ahead blends across the transition too (leaving it to `_smoothLookAt` eases at 0.22 — its own
  rate, not the transition's, so the frame would arrive before the aim did). Pressing C mid-transition
  re-captures the arc start from the live position. New `getViewBlend()` reports 0…1.
- Tests: 6 more in `cameraViews.test.js`, **475 pass.** The continuity test asserts a **ratio**
  (worst step ÷ mean step < 2.0) rather than a distance — smoothstep peaks at exactly 1.5× its own mean
  while a cut is of order N, so the test holds whatever `TRANSITION_TIME` becomes. The one that matters:
  **no frame of any transition, including C spammed mid-arc, puts the camera inside the shell.**
  ⚠ One test threshold was wrong on the first run and the code was right — "clears the roofline" measured
  over the whole 4.4 m box, but past the windscreen the bodywork drops to the bonnet and the bumper cam's
  whole job is to end up down there. Narrowed to the cabin (|z| < 1.2 m).


## 2026-09-04 — V-15: a third camera mode, and the camera doc was stale in every row

**C now cycles three views, progressively inward: wide chase → close chase → bumper.** `VIEW_CHASE = 0`,
new `VIEW_CHASE_CLOSE = 1`, `VIEW_HOOD` moves 1 → 2, `VIEW_COUNT = 3`. Nothing outside `carCamera.js`
refers to these by value (checked: `carDriver` and `main.js` only forward `cycleView`/`getView`), and the
`sessionStorage['dd_view']` restore is range-checked — so a stored `1` from an older build now selects
CLOSE instead of HOOD, a one-time surprise on one reload rather than a broken state.

- **The two chase rigs are a PARAMETER SET, not a second camera.** `CHASE_RIGS` replaces the single
  `BASE_CAM_*` / `TUNNEL_CAM_*` constants; both views run the identical update path (orbit, reverse flip,
  shake, soft clamp, look-ahead, FOV). A forked update is how two chase cams drift apart — a fix lands in
  one and the other quietly keeps the bug.
- **CLOSE was derived by holding the ANGLES, not by scaling the numbers**, because the flat-angle comment
  on `BASE_CAM_HEIGHT` is the whole reason WIDE is tuned as it is. Rear roof edge ~1.2 m up / ~2.2 m back
  → wide depresses it 16.5°; at 4.5 m back with 2.05 m of height, close depresses it **20.3°**, a shade
  steeper on purpose so pulling in shows MORE road over the roof. Look-ahead 4.0 → **3.2 m** to match: at
  a 2.05 m eye, 4.0 m is what would have flattened the view into the roofline — the trap the TODO named.
  Measured, settled: wide 6.60 m / 2.50 m / 16.5°, close 4.50 m / 2.05 m / 20.3°.
- **Deleted dead code the change would otherwise have enshrined:** the bumper view computed a `_hoodLook`
  target from an orbit-rotated forward and `HOOD_LOOK = 14 m` that **nothing ever read** — it has always
  fallen through to the shared chase look target, which is what it is actually tuned against. Removed the
  vector, the constant and the two locals, with a comment saying so. Zero behaviour change. Dead code that
  looks live is how the next person "fixes" the wrong number.
- New: `frontend/test/cameraViews.test.js` — 6 tests that DRIVE the real `update()` against a stub chassis
  rather than pinning constants, so a rig wired but never read still fails. Notably: close must settle
  >1 m nearer than wide, must not fall below `MIN_CAM_ABOVE_CAR`, must not flatten the roofline angle, and
  every mode must produce a finite position (a missing rig-table entry is otherwise silent). **469 pass.**
- ⚠ **`vehicle-system.md` §Camera was stale in essentially every row** and is rewritten: it claimed base
  distance 4.8 m (is 6.6), height 1.4 m (2.5), look-ahead 2.5 m (4.0), max FOV +14° at 120 km/h (+21° at
  80), max horizontal 5.2 m (9.3), a `chassis.position.y < -1` tunnel test (that is the G-47 bug, long
  replaced by `isInTunnelZone` XZ zones), and **"Mouse orbit is disabled"** when it has been live on the
  canvas for some time. Now documents the rig table, the derivation, the bumper-cam bounds measurement and
  the shake.


## 2026-09-04 — Pedestrians P-1: they walk streets, they turn, and they are not flat-shaded

User report: *"they are again too low poly and they dont have much to do also they move randomly not
smooth"*. All three measured before touching anything; see **[pedestrian-system.md](pedestrian-system.md)**
for the full diagnosis. Frontend only — no tile format change, no re-bake.

- **"Too low poly" is mostly a SHADING bug.** `bakePosedMesh` ended in `toNonIndexed()` +
  `computeVertexNormals()`, i.e. every triangle got its own normal: the whole crowd was lit **flat**.
  At 1,852 / 2,776 / 1,786 triangles these models are not thin for a background figure — they were
  faceted on purpose. Now `toCreasedNormals(geo, 55°)`. Same triangles, same draw calls, same memory.
  What *is* genuinely thin and is NOT fixed: all three GLBs ship **zero textures** (`images = 0`).
- **"Nothing to do" — 8 of the 11 clips in every GLB are unused.** `Sitting`, `Standing`, `Clapping`
  and `Run` ship in the page weight and never appear; the game uses `Walk`, `Idle`, `Death`. Logged as
  P-3. What did land: standing is now a **state** with a 2.5–11 s duration, not a life sentence —
  `IDLE_FRAC = 0.25` had been freezing a quarter of every crowd as permanent statues.
- **"Moves randomly" was three defects.** (1) A person's whole world was one road **sub-segment**,
  commonly 10–30 m, paced back and forth — nobody was going anywhere. They now walk a **path**: the
  full mitred offset polyline of one side of a road, parameterised by arc length, so they traverse
  whole streets and round the bends. (2) Yaw was **assigned**, so an end-of-segment flip or the sight
  of the car snapped a person through 180° in one frame; it is now smoothed (7/s walking, 20/s
  panicking). (3) The flipbook ran at **~7 fps** (`FRAMES = 8` against a ~1.15 s cycle); `FRAMES` is
  now 12 and the cadence comes from ground speed (`speed / STRIDE`), so the feet stop skating.
- **The longer flipbook is free, and net draw calls go DOWN.** A zero-count `InstancedMesh` was still
  being submitted every frame; `im.visible = im.count > 0` skips them. 39 meshes exist, ~10–14 hold
  anyone on any given frame.
- **Crowd size is now a DENSITY** — in-range pavement length ÷ 22 m. The old `candidates × 0.5` counted
  *geometry vertices*, so a finely-noded street got a mob and a straight one got nobody.
- Also: ground is sampled at the **offset** point (centreline sampling buries the uphill pavement on a
  cross-slope), ±0.16 m per-person lateral wobble, `userData.type = 'pedestrian'` on every mesh (N-18),
  and the frame bake yields a macrotask every 2 frames so 36 re-skins don't land in one load frame.
- New: `frontend/test/pedestrianPaths.test.js` — 7 tests, notably **the corner case**: a 90° bend walked
  in 0.5 m steps must never jump more than 0.6 m (per-sub-segment offsetting left a 5 m lateral step
  there). 463 tests pass.
- ⚠ **P-2 is blocked on a whitelist, not on design.** The bake already flags marked crossings and the
  parser reads them, but `tileManager.getLoadedRoadSegments()` is a **projection whitelist** and
  `crossing` is not in it — so it does not exist downstream, silently, as `undefined`. Add the field and
  prove it arrives before building crossing behaviour on it.
- ⚠ **P-3/P-5 contradict the v3 ruling** that cuts the pedestrian art pass and drops `PED_CAP` 168→60.
  P-1 spends none of that budget (no assets, fewer draw calls); the art phases need the user to overturn
  it first.

**TODO added (not implemented):** a third camera mode — `C` should cycle bumper → **close chase** → wide
chase. `carCamera.js` has `VIEW_COUNT = 2` today. See `TODO.md`.


Format: `YYYY-MM-DD — description`

## 2026-08-27 — P4-17a: 206 Indian toilet complexes removed from Barcelona

**P4-17 turned out to be blocked, and the premise check is what found it.** Its stated dependency
`signAtlas.js` does not exist — nor `map/signage/`, nor `scripts/build-sign-atlas.mjs`. The producer
is **P4-11, 7 days, risk high, not started**. A 2-day task on an unbuilt 7-day foundation.

The check also showed the task text does not match the code: it promises "fountains, kiosks,
monuments and glazed bus shelters", but `BUILDERS` has **no kiosks and no monuments**. Censused over
433 tiles, "urban features" is six types and 905 objects — **fire_hydrant 527 · public_toilet 206 ·
fountain 114 · fuel_station 39 · communication_tower 17 · water_tower 2** — plus 1,295 bus stops.

**P4-17a is the half that needs no atlas: the Delhi content still standing in Barcelona.**

- **Public toilet (206) rebuilt.** It was a *Sulabh complex* — 6 × 5 × 3.8 m brown-stone building,
  entrance canopy, three steps, steel railings, an emissive **"SULABH TOILET COMPLEX"** board and
  **14 scattered bushes and boulders** landscaped around it, on 3–4 m Eixample pavements. Now a
  1.6 × 1.5 × 2.5 m graphite street cabin. **30 m² → 2.4 m².**
- **Fuel forecourt (39) neutralised.** "Bharat Petroleum inspired", carrying BP's blue-and-yellow
  livery and named for it in the identifiers. Now neutral red/bone. Canopy 14×10×7 m → 11×7.5×5.4.
- **Fountains (114)** — brown north-Indian sandstone → pale grey Montjuïc stone.
- **`EXCLUSION_RADIUS` re-sized with the footprints.** It feeds `vegetationRenderer:613` at RUNTIME,
  so a 1.6 m cabin had been clearing a **10 m** circle of street trees. No re-bake needed.
- **Four orphaned materials deleted**, verified 0 callers first.

**Left alone deliberately:** the fire hydrant (527, the most numerous). Its form is a defensible
European *hidrante de columna*. A pillar/underground split is impossible today — **the bake ships
`tags: {}` on every urban feature**, so `fire_hydrant:type` never survives. Filed as **N-5**;
`amenity=drinking_water` (Barcelona's cast-iron *fonts*) isn't imported at all — **N-6**.

354 tests green, build clean. A material-map validator caught one dangling reference before ship.
⚠ Not yet seen on screen.

## 2026-08-27 — 37.8% of every road was drawn twice, and the clipper that should have prevented it was broken

Three user reports — "roads darker in places", "z-index issues on roads", "sidewalks too wide" —
turned out to be **one bug**. `window._ddPick()` (added this session because identifying a surface
from a screenshot had already failed three times) returned **`sidewalk` twice and the road twice at
identical world coordinates**.

**Cause.** `noClipTileStrategy: true` writes each way IN FULL to every tile its bbox touches
("Guarantees continuous roads") — right for the DATA, ruinous for the PICTURE:

| | |
|---|---|
| ways in more than one tile | **5,308 of 38,813 (13.7%)** |
| road centreline drawn | **4,146 km** |
| unique | **2,578 km** |
| **duplicate** | **37.8%** |

**Why the copies were VISIBLE and not merely wasteful:** `createAoSampler` clamps outside its own
grid, and **24.6% of road vertices are drawn outside their tile's AO grid** (p90 43%). They take the
tile-EDGE AO while the neighbour computes the true value — two coplanar surfaces with different AO,
fighting per-pixel.

**Fix (R-J5):** `payload.renderRoads`, the tile's roads clipped to its own bounds, feeds
`bakeRoadSurfaces` + `bakeSidewalks`; `payload.roads` stays whole for physics and topology. The
strategy did not need reverting — rendering needs COVERAGE, not duplication. Cross-tile geometry
**24.6% → 2.92%** (the residual is ribbon half-width overhanging the edge, which is required).

**And underneath it, a second bug (D-81).** Verifying R-J5, 9 tiles rendered no roads despite
containing them. `clipRoadToTile` discarded the whole accumulated run whenever a road LEFT the tile
— so a road that enters, crosses and exits produced nothing. A 103-point path with 42 segments fully
inside clipped to ZERO runs, while a 2-point road from the same polyline clipped fine. One line to
fix; the bake's `[RenderClip]` figure went **90.0% → 98.9%**.

**This is very likely why `noClipTileStrategy` was ever set.** With the clipper eating roads, not
clipping was the only setting that gave a complete city — a latent bug in one module silently
dictated a pipeline-wide strategy, at a cost of 37.8% duplicate geometry.

Also added: `window._ddPick()` (raycast and name every surface under a pixel) and `?pedareas=0`.
**354 tests green**, incl. `test/tileClip.test.js` (6) — 0 real coverage holes, verified.

See `barcelona-road-system.md` §4 R-J5 and tracker D-79 / D-80 / D-81.

## 2026-08-27 — R-J4: the pavement was being drawn ON the carriageway, and winning

**Reported:** "some roads got sidewalks which looks bad — it's covering the road almost."

Every road with a pavement emits a ribbon to each side and **nothing checked whether it lands on a
different road**. On a boulevard with lateral service roads (Gran Via) the lateral's pavement lands
on the main carriageway — and `GROUND_LAYERS.sidewalk` (-6) deliberately beats `road` (-4), so the
asphalt loses the depth test to a pavement that should not be there at all.

| | before | after |
|---|---|---|
| pavement vertices inside a live carriageway | **14.34%** | **5.73%** |
| ↳ deeper than 0.5 m | 3.97% | **2.07%** |
| ↳ deeper than 2 m | 0.74% | **0.19%** |
| worst penetration | 5.55 m | 1.19 m (probe tile) |

The existing `clampSidewalkVerticesOutsideRoads` could not do this: it moves VERTICES only (an edge
still crosses), and where a pavement genuinely lies on an avenue, shoving its vertices to the kerb
yields a squashed ribbon rather than removing something that does not exist in the real street —
which is itself the "z-index" artifact reported. Fixed by clipping the ribbon out of carriageway
coverage, the rule `pathCoverageClipper` already applies to footpaths one level down.

⚠ **A clip must REMOVE, never densify.** The obvious resample-and-keep-uncovered version took the
baked pavement from **1,968 to 20,670 floats on one tile**. Sampling finds the transitions; the run
is rebuilt from source vertices.

**Also this session:** the terrain's `roadDistGrid` — a full spatial grid stamped per road segment,
built on **every** tile and **read by nothing** — deleted (D-76), along with the stale comment 400
lines away that kept it looking alive.

**And a measurement trap worth knowing (D-77/H15):** verifying in Chrome, the load reported
`p1 physics 26,527 ms` against a historical 752 ms. It is not a regression — with every frontend
change stashed the same run reported **51,643 ms**, worse. Chrome throttles rAF to ~1 Hz in an
unfocused tab and this load is yield-bound by design. **Automation can verify geometry and
visibility; never timing.**

See `barcelona-road-system.md` §4 R-J4 and tracker D-75 / D-76 / D-77 / H15.

## 2026-08-27 — The kerb drew 2.5x further than the pavement it edges

Found from a `_ddGround()` reading in PHOTO mode, where everything should be drawn: markings 12/0,
crosswalk 12/0, curb 11/1 — and **sidewalk 5 visible / 7 hidden**.

`bcnSidewalkMesh` was culled at `80 * altMult`; `bcnCurbMesh` at `200 * altMult`. **The pavement and
its kerb are one surface.** From 80 m out, every street rendered kerb lines with bare terrain between
them and the buildings — the green strip along the kerb. It is an LOD bug that looks exactly like a
geometry bug, which is why it survived the whole R-J3 junction-clip investigation: both faults strip
pavement, and on screen they are indistinguishable.

Also: none of the Phase-3 ground lines honoured `_photoMode`, unlike `showDetail` directly above
them — so the one mode meant to draw everything still culled the pavement. Fixed, along with
`dressDist`. Pavement and kerb now share `GROUND_COVER_CUT_M`.

Cost, measured off the reading: ~515 tris/tile pavement + ~1,006 kerb → **~14k tris, +18 draws**
over 9 resident tiles, against 2.6 M / 450.

**When two halves of one physical object carry two different LOD numbers, the object is wrong at
every distance between them.**

See tracker D-74.

## 2026-08-27 — The city was culled at 280 m while the ground under it drew to 1500 m

**Reported from the air:** roads and crosswalks floating on a grass-green lawn, whole blocks of
buildings absent. It was **not** missing data — the tile measured **113.9% covered** (buildings
46.4%, roads 37.9%, pavement 15.6%). It was geometry that exists and was not being drawn.

Diagnosing it from screenshots had already cost a round trip, so `window._ddGround()` went in first:
a table of every ground mesh class split visible/hidden. One reading named it —
**greens 0 visible / 31 hidden · plazas 0 / 11 · pavement drawn on 4 of 11 resident tiles.**

**Two causes, and both are the same fix applied to everything except the city.**

1. `FOG_FULL_DIST = 280` hides everything on a far tile. But **terrain** was lifted out of that cull
   to 1500 m by P4-02, and **roads** are explicitly "kept visible into fog for continuity". So the
   two things that read as *ground* survive to 1500 m and everything that **covers** them dies at
   280 m. P4-02 diagnosed this exact miscalibration for terrain ("deleting ground that was still
   ~61% visible"); VEG-FIX-1 hit the resulting seam for vegetation ("bare ground from 280 m out")
   and lifted impostors to 600 m. Neither pass extended the built environment.
   → `GROUND_COVER_CUT_M = 600`, the same constant and the same reason as `VEG_IMPOSTOR_CUT_M`
   (FogExp2 at the shipping 0.0025 reaches 89.5% there), now carries park/plaza polygons and
   `lodBuildingMesh` past the cull.

2. Parks and plazas were being LOD'd **as trees**: the near path's fall-through was
   `m.visible = dist <= treeMaxDist`, where `TREE_MAX_DISTANCE` is **170 m** and `dist` is distance
   to the tile *centre* — which includes camera altitude. Above ~170 m every park and plaza in the
   city vanishes at once; at street level a park in your own tile pops out at 170 m. They are flat
   polygons of a few triangles that inherited a rule written for 12 m plane trees by falling off the
   end of an `else if` chain. Now on nearest-edge distance out to `GROUND_COVER_CUT_M`.

**Deliberately NOT extended:** full building detail, pavement, kerbs and lane paint stay culled at
280 m. They are the expensive half and the frame budget binds. Greens merge per type (~3 meshes per
tile) and plazas to one per tile, so the change is ≈**+42 draws** against 246/450 — checked before
shipping, and the reason only the cheap half moved.

See tracker D-72 / D-73.

## 2026-08-27 — R-J3: the junction clip was eating the pavement (138 km of it)

**User-reported, from the driver's seat:** bare green terrain along kerb lines and around corners,
plus pavement "appearing where it shouldn't". One bug, seen from two sides — the pavement was
clipped so far back from every junction that the survivors read as stranded fragments, and the strip
between the asphalt and the buildings had nothing drawn in it.

**Two compounding geometry errors** in `buildSidewalks`/`buildCurbs` and their bake twin:

1. **A full width where a half was meant.** The crossroads branch of `junctionClipRadius` used the
   widest paved width at the node as the along-road clip depth. The kerb the pavement must stop at
   is *half* a width away. R-J2 had already derived the right rule (`teeWidth / 2 + 1.5`) and fixed
   only the tee branch.
2. **A sum where a hypotenuse was meant.** The clip is a *circle* about the node, and the pavement
   runs `offset` to the side, so the circle meets it at `√(R² − offset²)` — not at `R`. Both sites
   used `depth + offset`, cutting at `√(depth² + 2·depth·offset)`.

Eixample crossroads: **21.3 m** cut per arm where **8.6 m** is correct.

| over 10,713 roads that should carry a pavement | before | after |
|---|---|---|
| pavement cut per road, median | **21.4 m** | **9.7 m** |
| pavement clipped away **entirely** | **1,669 (15.6%)** | **578 (5.4%)** |
| kerb line restored | — | **≈138 km** |

Fixed with `junctionApronDepth()` and `offsetClipRadius() = hypot(depth, offset)`. Re-baked and
verified on the output: **+21.1% baked pavement/kerb geometry** (1,036,386 → 1,255,524 position
floats) and the median junction now has pavement within **8.2 m** of it, against the 8.6 m target.

**A latent bug detonated by a correct change.** The 2026-05-29 decision "`junction.radius` = max
road width = clip-zone depth" was fine when a residential road was 4 m; R-W1 made it 10.4 m and the
unchanged rule started costing 21 m. Lane paint deliberately keeps the old rule — over-clipped paint
shortens a line, it does not expose terrain.

**A third copy-pair, already diverged.** The clip lives in `roadRenderer.js` (runtime, 173 tiles)
and `sidewalkBaker.js` (bake, 260) — and the bake half had **never received R-J2's tee fix**, so it
over-clipped every tee in the city while the runtime did not. The baker's header already demanded a
mirror in prose; it did not work. `frontend/test/sidewalkClip.test.js` (7 tests) now enforces it.

**Also corrected:** R-J1's chamfer work cannot be seen — `ENABLE_CHAMFER_FILLS/SIDEWALKS/CURBS` are
all `false`. The data fix stands but is not observable; **H13** records what must be re-derived
before the chamfer is ever switched on, since R-J3 moved the pavement's stopping point.

**Still open:** roads reading darker in places, from the same screenshots. Not diagnosed — the AO
sampler is properly bilinear, so it is not blocky by construction.

See `barcelona-road-system.md` §4 R-J3 and tracker D-70 / D-71 / H12 / H13.

## 2026-08-27 — R-J1: the ticket was already built, and proving that found the real bug

R-J1 asked for merge tapers, a correct Eixample chamfer, and no step where two carriageways of
different width meet. **All three already existed.** Measured on the shipped v10 tiles before
writing anything:

- **gore geometry** runs end to end — bake → binary → parser → `buildGoreMeshes`. Of 486 distinct
  merge nodes, only **12 drivable ones** city-wide have no gore.
- **the chamfer** exists with sidewalks and kerbs; 2,233 junctions are eligible.
- **the width taper** exists — and *twice*. Every one of the 2,956 in-tile width steps tapers.

**The actual defect was underneath the premise.** Junction enrichment in `buildRegion.js` built its
`wayId → width` lookup from `subset`, the spatial query for the current tile. But a junction is kept
if it lands within 30 m of the tile, so its arms routinely belong to ways whose bbox never intersects
that tile — and each hit a `?? 6` fallback:

| | before | after |
|---|---|---|
| approach widths fabricated at 6 m | **5,454 / 35,386 (15.4%)** | region-wide lookup |
| junctions with a wrong `radius` | **2,278 / 11,101 (20.5%)** | — |
| ↳ exactly the 6 m fallback | 2,226 (97.7%) | — |
| worst case | baked r=6 against a true 22 m | — |

`radius` and `approaches` are the only fields the baked junction record is read for, and all four
consumers take both. On screen: **33 chamfers missing entirely** (radius fell under the ≥ 8 m gate)
and **327 drawn with the wrong polygon** — median vertex error 2.2 m, worst 12.2 m. The same lookup
also explains 48 of the 83 missing gores.

**Fix:** one region-wide `wayWidthById` built before the tile loop. A width is a property of the WAY,
not of the tile looking at it. The bake now prints `[Junctions] approach widths: N/M resolved …`
(D-23 proof-of-work). Verified on an Eixample test bake: **20.5% → 9.2% wrong**, residual entirely
the `--area` clip boundary; full re-bake follows.

**Also found: the taper is duplicated**, `roadBaker.js` (260 of 433 tiles) against `roadRenderer.js`
(the other 173). They agree today and nothing made them — and because the two paths are chosen per
TILE, a drift would read as a seam moving with the tile grid. Both exported and pinned by
`frontend/test/widthTaper.test.js` (4 tests, run against the real measured Barcelona steps).

**Left open deliberately:** the taper flares a narrow arm to its widest neighbour over 20 m, and
R-W1's residential 4 → 10.4 m made that a 2.6× flare at **219 `living_street` mouths**. A real kerb
flare is ~5 m. Not a defect, not yet looked at on screen; the fix would be a per-class taper length.

⚠ The re-bake did **not** bump the tile version — the next drive needs `window._clearTileCache()`.

See `barcelona-road-system.md` §4 R-J1 and tracker D-68 / D-69.

## 2026-08-27 — The load was never work-bound: 16.2 s → 4.35 s

**`other` had been the largest number in every drive report** — 2,007–3,087 ms against `rend`'s
237–415 — and was filed as "GC/thermal". It is neither. Every top-`other` frame is in the first
12 seconds, with no async attribution and no allocation; after ~30 s of driving there are no long
frames at all. **`other` was the load.**

**And time-to-drive was never a load time.** The boot polls `isInitialLoadComplete()` every 150 ms
and gives up after 130 polls — a 19.5 s cap. Measured boots sat at 19.4 / 20.0 / 21.3 / 21.6 s. A
number that lands on its own timeout is usually the timeout, and instrumenting it confirmed:
`GAVE UP at the 131-poll cap — still 3 in flight, 5 queued, 6 resident`. The loading screen was
lifting on a timeout with six tiles built.

**Then the per-phase totals, from an instrument that already existed and had never been called.**
`takeBuildOverruns()` labels thirteen build phases and nothing has ever read it, so the load has been
unattributable while the data to attribute it was collected and thrown away. Given a total-per-phase
sibling and printed at the end of the load, it said:

```
initial tile load COMPLETE after 108 polls (~16200 ms), 14 tiles resident
main-thread time by build phase (3095 ms total): p1 physics 752ms/132 ·
  p4 clusters 589ms/124 · p2 buildings 465ms/163 · p4 urban 389ms/263 · ...
```

**Three seconds of work. Sixteen seconds of wall time.** ~1,180 chunks averaging 2.63 ms — exactly
`FRAME_BUDGET_MS = 3` — each ending in a yield costing a full 16.7 ms frame. The main thread was idle
for ~84% of the load. **No build phase was worth optimising:** `p1 physics` tops the list at 752 ms,
and eliminating it entirely would have saved 0.75 s of a 16 s load.

The 3 ms cap is right while DRIVING — it exists so tile work never piles onto a frame already missing
60 fps. It is simply wrong behind a loading overlay, where there is no car and nothing to keep
smooth. `LOAD_BUDGET_MS = 12`, on a one-way latch that drops back to 3 ms the instant the first ring
completes.

**A second mechanism turned up only on reflection, and it is worse than the first.** The adaptive
rule shrinks the budget by 0.6 ms whenever a frame exceeds 20 ms — and during a load frames always
exceed 20 ms, *because loading is what is making them long*. So it walked the build budget toward
`BUDGET_MIN = 1.0` precisely when the load needed it most: the symptom of loading was throttling the
loading. Gating it behind the latch was not tidiness; without it a bigger budget would have been
eroded within a second.

| | before | after |
|---|---|---|
| initial load | 16,200 ms | **4,350 ms** (3.7×) |
| time-to-drive | 18,444 ms | **6,329 ms** (2.9×) |
| build chunks | 1,177 | **334** |
| average chunk | 2.63 ms | **10.1 ms** |
| tiles resident | 14 | 14 |
| build work done | 3,095 ms | 3,362 ms |

Predicted 4.3 s from the arithmetic, measured 4.35 s. It also **restores and beats the ledger's
6.94 s**, unexplained since P4-01 — so that figure was real, and this is what had been lost.

`test/loadBudget.test.js` pins the direction that matters: the latch is one-way, the adaptive drive
budget is gated behind it, and completing the load restores the 3 ms budget in the same statement. If
the load budget ever leaked into a drive, every tile streaming in at 80 km/h would get 12 ms of build
time and the stutter the 3 ms cap exists to prevent would return in the regime the benchmark measures.

328 tests green.

## 2026-08-27 — Task #39: two more disposal leaks, and a call that never did anything

**Two disposal branches, and the fix only ever landed on one.** Tile unload branched: a Group was
`traverse`d and its `child.isMesh` freed; everything else went down a flat path. The flat path had
learned three things the group path never did:

1. **`isMesh` alone is not enough.** A `LineSegments`/`Line`/`Points` holds a geometry and fails it.
   That is the `streetlightWireMesh` leak — found and fixed once already — **still live inside every
   Group**: `reflectorGroup`, `tunnelMeshGroup`, `canopyMeshGroup`.
2. **`sharedGeometry` was ignored** on the group path, which disposed unconditionally. The opposite
   defect: a pooled geometry freed out from under every other tile using it.
3. **Instance buffers were skipped entirely.**

Now one routine, both entry points calling it.

**And the instance-buffer call had never freed anything.** Both paths carried
`m.instanceMatrix?.dispose?.()` under a comment correctly explaining that `geometry.dispose()` does
not free those GPU buffers. Correct premise, dead call: **`dispose` does not exist on a
`BufferAttribute` in three 0.183**, and the optional CALL — `?.()`, not just `?.` — swallowed the
miss in silence. What actually frees them is `InstancedMesh.dispose()` / `BatchedMesh.dispose()`,
which dispatch the event the renderer releases them on. Now called, gated on `sharedGeometry` so a
pooled BatchedMesh can never be torn down by a tile unload, and pinned by a test that fails loudly if
a three upgrade ever adds the missing method.

**The old test was a regex over the source, and it proved why that is not a test.** It asserted
`tileManager.js` contained the literal branch condition — so it passed for as long as the group
branch was silently leaking (the string was present, on the *other* branch) and failed the moment
the two were merged into one correct routine. It was written that way because `tileManager.js`
cannot be imported outside Vite. So the logic moved to `map/tileDisposal.js` — one function, one
import — and its 14 tests now run it against real three objects.

**New probe: `?debug=leak`.** The drive report can see the leak but not attribute it, and the two
possible causes need opposite fixes. So per tile unload it prints what the walk HELD, FREED and
skipped as shared, next to what `renderer.info.memory.geometries` actually did over the same unload.
`held` above `freed + shared` means the walk holds geometry it will not free; an `UNACCOUNTED` total
means geometry exists the tile entry never tracked.

319 tests green. **Whether any residual leak remains needs one drive with `?debug=leak`.**

## 2026-08-27 — R-W1: one road width model, and the streets were a third of their width

**The ticket said OSM's `width=*` tag is unreliable. The measurement found the code never read it.**
`getWidth()` checked `tags.width` first, but `pbfHighways.js` KEEP_TAGS never included `width`, so it
was stripped before the bake could see it — that branch had **never once fired** in the project's
life. Its `WIDTH_BY_TYPE` fallback was unreachable too (it needs `lanes == null`; `getLanes()` always
returns ≥ 1). So every width in Barcelona was `clamp(lanes × 3.5, 4, 20)`, and read straight off the
shipped tiles that put **73% of residential streets, 99% of living_street, 97% of service and 100% of
footway/pedestrian/steps at exactly 4 m** — the MIN_WIDTH clamp, enforced on things that are not
carriageways. The user's report that the road "seems short" was neither perception nor length: the
streets were a third of their width, and every pavement in the city was baked as a 4 m ribbon.

**New `backend/worldBuilder/roads/roadWidthModel.js`** — one model, lane count × class per Norma
8.2-IC, with the OSM tag as a **bound** rather than a source (a tagged 5.5 m Gràcia street caps the
section and loses its parking bays before its lane; a tagged 25 m one is inert). It emits a named
SECTION, baked into the v10 tile, so nothing downstream re-derives anything:

    |<------------------------- corridorW ------------------------->|
    |         |<------------- kerbToKerbW ------------->|           |
    |         |      |<----- carriagewayW ----->|       |           |
    | sidewalk | park |  lane  |  lane  |  lane | park  | sidewalk  |

**Ten width tables deleted.** Nine were known; a tenth turned up inside `vegetationWorker.js`. Three
of them carried the comment "mirror of roadRenderer WIDTH_BY_TYPE" and none of them matched it — and
two were a half-width scale with different numbers again. The frontend now reads
`map/roadWidths.js`, whose fallback table `test/roadWidths.test.js` re-derives from the bake model
and fails on drift. That guard caught a hand-typed error on its very first run.

**Measured, baked (Eixample, 1,512 roads, 0 missing the section):** residential paved **4 m → 10.4 m**
(16.4 m corridor, 67% with parking bays) · tertiary 7 → 10.4 · secondary 10.5 → 14.15 · footway
4 → 2 · steps 4 → 1.5 · living_street stays 4 (correct: shared surface). Motorways stay ~14 m, which
is the one case the old code got right — OSM splits dual carriageways per direction, so `lanes=3`
means three lanes one way, and adding a median would have doubled the network's footprint.

⚠ **The drawn ribbon is `kerbToKerbW`, not `carriagewayW`** — a parking bay is asphalt. Drawing the
running lanes would leave a 2.2 m strip of bare terrain down both sides of every street, exactly
where its parking lane belongs.

**The whitelist defect, twice more.** A road is copied field by field at six points between PBF and
renderer. The section was added to five, a six-minute bake ran, and **all 2,148 road records came out
with the section absent** — `deepCloneRoad` did not carry it. Fixed, looked again, found
`RoadGeometryBuilder` did not either. All 19 width-model unit tests were green throughout. This is
the third occurrence (D-42 killed a safety gate for its entire life), so it is now a test:
`test/roadFieldPipeline.test.js` reads the source of all six copy sites and fails if any drops a
field — verified by removing one and watching it fail.

**Also fixed: the binary tile cache never checked its version.** CLAUDE.md tells players to run
`window._clearTileCache()` after a re-bake because the browser serves stale tiles. Cause: the JSON
path compared versions, the BINARY path parsed whatever IndexedDB held and served it forever. The
manual step existed because the code did not do it. `peekBinaryVersion()` now evicts a mismatch, so a
re-bake invalidates itself; a network-fetched older tile still parses via the fallback rather than
blanking, so a partial bake degrades instead of breaking.

281 tests green. Full region re-bake run. **Unverified in-game — this is the largest visual change
in weeks, and every kerb, sidewalk, tree line and parked car in the city moves with it.**

## 2026-08-27 — v3 P4-15a: every city car in the world is now one draw call

**The shape of the problem.** Traffic and parked cars drew the SAME nine Kenney models out of the
SAME texture atlas, through two entirely separate stacks: 28 loose `THREE.Mesh`es (added to and
removed from `scene` as cars spawned and despawned — about two of each per frame at cruise), nine
per-variant `InstancedMesh`es, and a pair of head/tail light meshes each. 41 draws, 37 scene
children. Tire smoke added 90 `Sprite`s with 90 `SpriteMaterial`s, permanently in the scene graph
and walked by `projectObject` every frame whether or not a single puff was alive.

**New `car/carFleet.js`** — one `BatchedMesh` holding all nine geometries and every car in the
world, plus one light `InstancedMesh` per system (head and tail told apart by instance colour rather
than by being two meshes). **41 draws → 3.**

`BatchedMesh` rather than nine `InstancedMesh`es because an InstancedMesh is one geometry: sharing
nine of them between two systems means agreeing on a slice of each instance buffer whose offset
moves every time parked cars rebuild, one frame out of step with traffic's per-frame write. A
BatchedMesh instance carries its own geometry id, so a slot is just a slot — no blocks, no offsets,
no ordering requirement between the two `update()` calls. It follows `vegPools.js`' rules exactly
(never `setInstanceCount`, never `deleteInstance`, geometry swaps through `setGeometryIdSafe`), with
one deliberate difference: **per-instance frustum culling is ON here.** vegPools turns it off because
it pays a matrix multiply and sphere test against 15k+ instances that already have a distance LOD;
this pool holds ~640 instances of ~2,189 triangles each and has no LOD, and the parked cars it
replaced were nine `frustumCulled = false` meshes drawing **~0.55 M triangles every frame regardless
of where the camera pointed**.

**`carModels.js` — one parse, one material, one atlas.** Three consumers (traffic 3.9 m, parked
3.8 m, police 4.4 m) each loaded the whole kit from scratch: **27 GLB fetches, 27 merges, 27
`MeshStandardMaterial`s and 27 uploads of the same 3,110-byte colormap** — verified identical, every
GLB embeds one material and one image with md5 `609899c94d3c`. Now the parse is cached per URL, the
merged geometry is cached per URL at a canonical length, and all nine templates share ONE material;
a consumer wanting a different length gets a view with a `scale` it folds into its instance matrix.
That sharing is not a nicety — a BatchedMesh has exactly one material, so it is the enabling
condition. Also **stopped calling `toNonIndexed()`**: measured across the nine GLBs that takes the
kit from 31,887 vertices to 59,106 (**+46% vertex-shader work**) and buys nothing, because the wheel
/ body vertex colour is per-PART and survives shared vertices intact.

**Tire smoke: 90 Sprites → 1 InstancedMesh.** A Sprite is a screen-aligned quad, so the billboard is
just the camera's world quaternion, read once a frame and shared by every puff. Per-puff opacity is
the one thing an InstancedMesh has no slot for, so it rides a custom instanced attribute injected
through `patchMaterial` (never a bare `onBeforeCompile` assignment — H9). The 90-slot walk is gated
on activity, so it costs nothing on the frames you are neither drifting nor above ~43 km/h.

**A real bug found on the way — and it had never worked.** `parkedCars.computeSegMeta` gates street
parking on `seg.bridge / isRamp / layer / crossesTrench` ("no parking against a guard rail", R-V1,
shipped 2026-08-27). But `tileManager.getLoadedRoadSegments()` does not hand out the tile's road
objects — it builds a **new object per road with six fields**, and not one of those four is among
them. Every term read `undefined`; the condition was permanently false; the gate did nothing from
the moment it shipped. Nothing throws and both ends read correctly, which is why it survived: other
consumers (`roadRenderer`, `streetlightRenderer`) see those flags because they read the tile entry
directly. The four flags are forwarded now, with a comment at the projection saying it is a
contract — **so the parking-vs-railing gate is live for the first time, and the next drive will show
a difference this change is responsible for.**

`test/carFleet.test.js` (13 tests) pins the things that fail SILENTLY: a recycled slot switched to a
new variant actually reaching the multi-draw buffers, `hide()` really removing an instance, released
slots never reaching BatchedMesh's freed list, light offsets being in target units, and — the one
most likely to bite later — that the three anchor strings the tire-smoke patch replaces still exist
in three's `MeshBasic` source. If a three upgrade renames them the patch becomes a no-op and every
dust puff renders fully opaque, with nothing in the console.

⚠ **Not measured in-game.** P4-15a was scheduled on a drive that attributed 27.6 ms across 9 long
frames and 22.6 MB to `traffic`; that lap times `trafficSystem.update()`, and a large share of it is
`buildPath`'s ground sampling and array allocation rather than the rendering this replaced. 245 tests
green and the production build is clean, but the frame numbers need one F9 drive before anything goes
in the ledger.

## 2026-08-26 — Console cleanup: three real bugs, not just suppression
- **AudioContext spam was a real bug.** `ctx()` called `resume()` on every access, and the engine
  sound asks for the context every frame — so before any user gesture Chrome refused and logged
  **30 times** in one load. Now waits for the first `pointerdown`/`keydown`/`touchstart` (one-shot
  listeners), then resumes. No behaviour change after the gesture.
- **Analytics was firing on localhost**, defeating its own stated intent. The guard was
  `import.meta.env.PROD`, but `npm run preview` serves a PRODUCTION build — so every verification
  drive pinged Cloudflare and printed `net::ERR_BLOCKED_BY_CLIENT` for anyone with a blocker. Added
  the hostname check the comment always meant.
- **`apple-mobile-web-app-capable` deprecation** — added the modern `mobile-web-app-capable`
  alongside it (the legacy name is still required by older iOS Safari, so both ship).
- **Boot chatter gated behind `?debug=init`** (`[assets]`, `[census]`, `[lightgrid] armed`). Left
  ungated on purpose: `[perf] time-to-drive` (a v3 gate metric), `[quality] tier`, and any failure.
- Earlier the same day: `[loaf]` → `?debug=loaf`, `[buildingWorker] winding` → `?debug=winding`.

## 2026-08-25 — v3 P3-01/02/03: building geometry rebuild (fair-share detail, storey bands, winding)
- **P3-01 fair-share detail budgets.** The per-tile detail caps were first-come counters raced in
  tile order — median tile delivered detail to 26.6% of eligible buildings. `createFairBudget` does
  water-filling (`remaining/eligibleLeft` at each building's turn). Simulated on a dense tile:
  67/120 served → 120/120, same vertex spend. Spec correction: `BOUNDARY_VERT_CAP`, `MALL_` and
  `RELIGIOUS_` are dead in Barcelona (`ENABLE_DELHI_DETAILS = false`), so only balcony + commercial
  were converted.
- **P3-02 modular storey bands.** 3 UV-independent bands per wall face (ground/body/crown) replacing
  the single quad; worst-tile wall verts 33,320 → ~99,960 against a 220,000 budget. `FACADE_GROUND_H_M`
  / `STOREY_H` / `CROWN_H` moved into `buildingConstants.js` and `meshMaterializer` now reads them —
  a fourth mirror killed. **Mid-air shopfronts are NOT zero yet:** measured that a body band spanning
  >1 repeat crosses v=1.0 and repaints the shopfront, and that the geometry-only fix (one quad per
  storey) costs ~266k verts against a 220k budget. The claim moves to P3-04's window-only layer;
  `opts.windowOnlyTile` is already wired for it.
- **P3-03 winding normalised at source** → `BUILDING_SIDE = FrontSide` shipped. Settles the
  2026-07-06 revert: that note inferred "exterior = BackSide" from the X-mirror, but was written
  against inconsistently-wound geometry, so it described a broken state rather than the mirror's real
  effect. Resolved by driving `?buildingside=back|front|double`, which survives as an escape hatch.
- **Regression, caught by driving not testing (D-29):** the P3-01 pre-pass referenced `cx`/`cy` from
  outside the loop that defines them — every tile threw and NOT ONE BUILDING RENDERED, while fifteen
  unit tests stayed green because none called `processBuildingsInWorker`. Added
  `test/buildingWorker.smoke.test.js` (7 failures without the fix, 0 with).
- 80 tests total.

## 2026-08-25 — Light grid SHIPPED on by default; A/B harness moved behind ?lightgrid=ab
- **The reported "lights come and go every 3-4 s" was the MEASUREMENT HARNESS, not a bug.**
  `lightGridABTick` flips `uLGEnabled` every `AB_INTERVAL_MS` (2500 ms) for `AB_CYCLES * 2` = 16
  phases (~40 s), then pins it on — which is exactly "every 3-4 seconds, then fine after a while",
  and it strobes the WHOLE scene because it toggles the whole grid. It ran on every `?lightgrid`
  load. **An earlier diagnosis in this session blamed shader recompiles from arm-after-warm-up; that
  was wrong for the flicker.** (The reorder was still correct and still landed: the arm frame went
  864 ms → 85 ms and programs-at-drive 151 → 216, i.e. warmed up front instead of mid-drive.)
- A/B now runs ONLY under `?lightgrid=ab`. Default play never strobes.
- **Grid is ON by default.** `_LIGHTGRID` was `has('lightgrid')`; it is now `!has('nolightgrid')`.
  P2-06 deleted the fake-night stack in exchange for the grid, so grid-off is the broken state, not
  the safe one. Gate K-N passed on 172 real lamps: +0.45 ms mean / +1.51 ms p95 vs a 3.0 ms budget.
- **Generalises D-23's lesson:** a measurement harness that mutates what the player sees must be
  opt-in and must say so on screen, or its own instrumentation gets filed as a rendering bug.
- 41/41 tests pass.

## 2026-08-25 — Light grid: arm BEFORE the shader warm-up (kills the load-time lamp flicker) + brighter road paint
- **Lamp flicker at load, fixed at the cause.** The grid armed from the animate loop (`main.js`), i.e.
  AFTER the boot shader warm-up. Arming patches every registered material, which invalidates its
  compiled program — so the warm-up's entire output was discarded and recompiled (**measured 864 ms
  `rend` arm frame**, against the 340 ms the code predicted), and every subsequent tile burst
  registered more materials and re-triggered the debounced `compileAsync`. Visible symptom was not a
  stall but **lamps popping off and on every 3-4 s for the whole load**, settling when tile streaming
  stopped. Extracted the arm into an idempotent `armLightGrid()` and call it before the warm-up; the
  animate-loop call is now a fallback for other entry paths. **The `?lightgrid` flag guard moved
  INSIDE the function** — the boot call site runs before the loop's gate, so without it the grid
  would have armed for every player. Should also close the ledger's "shader programs Δ, gate 0" row.
- **Road markings brighter.** `MARK_ALBEDO` 0xC4C4C4 → 0xE6E6E6 (`roadRenderer.js`). With the
  PAINT_WHITE vertex colour the effective albedo was 0.74, so away from a lamp paint read as dim
  blue-grey instead of retroreflective marking; now 0.90. Still pure albedo — unlit paint continues
  to fall back with the asphalt, no emissive, no self-lit glow (the thing the P2-05 note guards).
- Markings were already LIT (Lambert, P2-05) — the `[lightgrid] "MeshBasicMaterial"` warning is guard
  rails / railings / slabs / bus-stop markings, which are unlit by design.
- 41/41 tests pass.

## 2026-08-25 — Backend CORS allowlist now includes the preview port 4044
The v3 verification drives run against the **production build** (`npm run preview`, port 4044), but
`ALLOWED_ORIGINS` in `backend/server.js` defaulted to `http://localhost:4040` only — so every tile,
manifest and citymap fetch from the preview build was blocked, and the world loaded empty. It does not
read as a CORS fault in the console: it shows up as `[TileLoader] Fetch failed: Failed to fetch` and
`net::ERR_FAILED 200 (OK)`. Default list is now `http://localhost:4040,http://localhost:4044` (dev +
preview); `ALLOWED_ORIGINS` still overrides for deploys. Updated CLAUDE.md port note, gotcha **G-08**
(which still described a hardcoded header that no longer existed), and bake-pipeline.md.

## 2026-07-02 — Pedestrians (real low-poly, walk-cycle flipbook, knockdown) + car width
- **Pedestrians = real low-poly people** (Poly Pizza rigged GLBs: man/woman-casual/woman-dress/punk/adventurer, in `public/models/people/`). Rigged models can't be instanced, so `carModels.loadWalkFramesTemplate` BAKES each character into N=8 static walk-frames + 1 idle pose (evaluate an animation frame via AnimationMixer.setTime + SkinnedMesh.applyBoneTransform, bake material colours → vertex colours, merge). `pedestrians.js` runs a **flipbook**: one InstancedMesh per (character × frame) + idle; each ped cycles frames by a speed-scaled phase → legs move while staying instanced/light. Crowd ~110, sidewalk-assigned, ground sampled on centerline.
- **Pedestrian knockdown** (GTA-style, no physics bodies): distance check vs the car centre (HIT_RADIUS 2.6 m, > 6 km/h) flips a ped to a `thrown` projectile — launched away+up (∝ speed), tumbling under gravity, lands, lies LIE_TIME then clears. ~30 lines in pedestrians.js; main.js passes `speedKmh` to `pedestrians.update`.
- **Prior pedestrian attempts REMOVED** (Kenney Blocky = style clash; Kenney animated FBX = too heavy). Added dep **`fflate`** (FBXLoader needs it) — still installed even though FBX path was dropped.
- **Kenney car width** 0.85 → **0.95×** (were too thin); height stays 0.82×. Both merged (parked) + scene (traffic) loaders.
- Dead code note: `carModels.js` still has the unused Blocky loaders (loadCharacterTemplate/loadPeopleTemplates/loadStaticPersonTemplate) — harmless, safe to prune later.

## 2026-07-01 — Kenney cars: fixed the white/no-detail (missing external texture)
The Kenney GLBs reference an EXTERNAL `Textures/colormap.png` (image has no bufferView/mimeType — uri only). Only the .glb files had been copied, so every car 404'd its texture → rendered flat white. Fix: copied `colormap.png` to `frontend/public/models/cars/Textures/`. Now windows/head+tail lights/body colours render. Traffic uses full-detail scene clones (carModels.loadCarSceneTemplate); parked cars use the merged InstancedMesh path (carModels.loadCarTemplate) with baked vertex colours (wheels forced black) + per-instance tint for body variety. `car/carModels.js` is the shared loader. Also: non-uniform squash (W×0.85, H×0.82) + ~3.8 m length so the chunky Kenney proportions read as cars; MAX_CARS 16 (5-mesh detail clones).

## 2026-07-01 — Real low-poly cars (Kenney Car Kit) for traffic + parked (frontend)
Added `car/carModels.js` — loads a Kenney Car Kit GLB (public/models/cars/*.glb, CC0), merges body+wheels into one geometry (shared atlas material), scales to 4.4 m, orients length→+Z, recentres wheels-at-0. `loadCityCarTemplates` loads the city set (sedan/suv/van/taxi/police/delivery/…). Parked cars (`parkedCars.js`) now use one InstancedMesh PER variant (deterministic distribution → variety, ~9 draw calls). Traffic (`trafficSystem.js`) clones a random variant per car (shared geo+material → cheap; MAX_CARS 18→24). Player keeps the BMW. Also this round: parked-car density cut (SPACING 6.6→14, ~45% empty slots, deterministic/stable), building colliders → oriented boxes (fix invisible walls on angled Diagonal buildings), no parking in junctions, traffic brakes when the lane ahead is blocked (player/other car), pedestrians cache ground-Y (fixes the 40 FPS drop), parked-car height sampled on-centerline (fixes cars sunk under the road).

## 2026-07-01 — "Make it a game" Phases 1–3 + city life (all frontend)
- **Phase 1 Sound:** engine RPM/exhaust/crackle/screech already existed + wired (carDriver→carSound). Added to carSound.js: city-ambience bed, speed-driven wind, collision thud (sharp single-frame speed drop).
- **Phase 2 Car feel & camera:** carCamera.js camera shake (impact punch on speed drop + high-speed rumble; shake offset added/removed each frame so it doesn't accumulate). **Collision fix (the big one):** tree/pillar colliders were created with NO collision group → defaulted to GROUND, which the chassis mask (WORLD|TERRAIN) filters out → drive-through. Set them to WORLD/VEHICLE. **Buildings had no colliders at all** → added `buildBuildingColliders` (footprint-AABB box per building, batched, WORLD group, streamed in/out with the tile). Car now collides with trees + buildings.
- **Phase 3 AI traffic** (`car/trafficSystem.js`): kinematic NPC cars following loaded road centerlines (right lane), static box collider (WORLD/VEHICLE) so the player hits them, pool of 18, spawn 32–185 m, despawn 240 m. Uses the SAME BMW GLB as the player (loaded once, cloned + recoloured per car, recentred wheels-at-0). Wired in main.js (physics-frame, player pos = lp.lx/lz). getLoadedRoadSegments now also returns width+oneway.
- **City life:** `car/parkedCars.js` (InstancedMesh, 900 cap, both curbs, rebuilt on >35 m player move, visual-only v1), `car/pedestrians.js` (InstancedMesh, 140 cap, walk sidewalks back-and-forth with bob). Config: ENABLE_TRAFFIC / ENABLE_PARKED_CARS / ENABLE_PEDESTRIANS (all true).
- **Atmosphere:** vegetationWorker foliage greens lightened (0x4F7D42→0x6E9A4C + palette) — airier street trees, not a dark forest. Day fog eased (0.007→0.0052, lighter warmer colour) so the city stays crisp.
- **Spawn → Avinguda Diagonal** (41.3948, 2.1602) — wide central avenue.
- Silenced the per-tile `[Tile] Phase1` console spam (behind `window._ddTilePerf`).

## 2026-07-01 — Church detail, city-polish flags, building cornice/brick (all frontend)
- **Church massing (buildingWorker.js religious block):** bell tower built from `makeBoxGeom` (the `createCylinderFull` tower rendered dark — box primitive lights correctly); cornice bands + tall window slots per tower face; tapered slate spire + 4 corner pinnacles + cross; buttresses along long walls; rose window (`createOrientedDisc`) + arched portal on the longest facade edge; small CAPPED central fléche. Tower placed 55% from centroid→bbox-corner (a raw bbox corner can fall outside an irregular footprint → floating tower+cross) and tower height capped (`towerExtra` 7–14 m) so tall parts don't spawn a 50 m floating-cross spike. Religious FACADE+ROOF palettes → sandstone/grey-stone + dark slate (was bright red). **Gabled-roof attempt REVERTED** — a bbox gable becomes a giant tent over a huge complex footprint (Sagrada Família). `meshMaterializer` shikhara material → warm sandstone (0xCAB695).
- **Spawn → Sagrada Família** (`spawnConfig.js` 41.4036, 2.1744).
- **City-polish flags (config.js):** ENABLE_TRAFFIC_LIGHTS, ENABLE_SIDEWALKS, ENABLE_ROAD_EDGE_DETAIL, **ENABLE_STREETLIGHTS** → true. ENABLE_DAY_NIGHT left **false** (the fixed warm lighting reads better; the auto-cycle's day went grey). Procedural-infill stays off (Delhi-era).
- **Night de-faded (`ui/envToggle.js` NIGHT preset):** ambientIntensity 1.6 → 0.75 (the 1.6 flat flood — added to compensate for streetlights being OFF — washed the city grey), exposure 1.1 → 1.0, moonlight 0.25 → 0.30, lampEmissive → 5.0. Streetlights now light the streets so the night reads dark+moody.
- **Building detail (buildingWorker.js):** industrial FACADE_PALETTE → Poblenou red brick; uniform cornice lip (projecting roofline) on all masonry edges via balconySlabGeoms.
- **Phase 3 (terrain/tunnel rework) marked DONE** in the rework tracker.
- **Slice ③ floor validator → COMMIT-BLOCKING (locked in).** The 5 layer-1 floor-gap roads (terrain rising 3.6–8.3 m through the roadway — mis-tagged tunnels) identified via `DISTINCT_FLOOR_GAP_ROADS` report dump: `18524460, 1394468622, 18520976, 1394468619, 123268593`. Added `KNOWN_FLOOR_GAP_ROADS` set in buildRegion.js → dropped at the payload.roads chokepoint (accept-the-gap) + passed as the validator `whitelist`. Default flipped to **block** (`TRENCH_VALIDATOR=report` to bypass). Confirm bake: `[FloorGap] dropped 5` + `[FloorValidator] ✅ 0 violations`, exit 0. Future carve regressions now hard-fail the bake. **Tiles regenerated** — run `window._clearTileCache()` + hard reload to drop the 5 broken roads.

## 2026-06-30 — Barcelona building redesign: PORTED to the worker (the real generator) — ⏳ verifying
CRITICAL: buildings are generated in the Web Worker `frontend/src/workers/buildingWorker.js` (geometry) + `meshMaterializer.js` (materials/window textures). `map/buildingRenderer.js` is DEAD reference code — editing it had zero effect (the audit agent missed the worker path; CLAUDE.md notes buildings are offloaded to workers). All the Barcelona changes below were re-applied in the worker + materializer: warm FACADE_PALETTES, generic→residential default + no height→glass, ENABLE_DELHI_DETAILS=false (water tanks/shikhara/AC/billboards/boundary-walls/setback), BALCONY_CATEGORIES (residential/commercial/office), WINDOW_STYLES Eixample rhythm, shopfront ground floors, lightened sky-glass windows (drawRecessedWindow + curtain-wall), church block (shikharaGeoms tower + flagPoleGeoms slate spire + templeBandGeoms cross via createCylinderFull/makeBoxGeom), shikhara material → warm sandstone. Vite-verified serving the new worker. (buildingRenderer.js carries the same edits for parity but is unused.)

## 2026-06-30 — Barcelona building redesign (frontend, no re-bake) — superseded: edits were in dead code
Systematic per-type rework of `buildingRenderer.js` from Delhi-flavoured generic blocks → Barcelona Eixample masonry. Classification (OSM type → category) preserved; only the LOOK changed.
- **Palettes** warmed for all categories (cream/ochre/sandstone/pale-yellow/rose/warm-stone); cold blue-greys + dark glass gone. `commercial_glass` lightened and gated to explicit glass tags only.
- **Killed the glass-office default:** generic/untagged buildings → warm `residential` masonry (was `commercial`→glass); removed the `height≥18→commercial_glass` auto-conversion (the root cause of dark-tower city).
- **Delhi ornament removed** via `ENABLE_DELHI_DETAILS=false`: perimeter boundary walls+gates, driveway SETBACK, Hindu shikhara/kalasha/flag, rooftop ad-billboards, upper-floor AC clutter, garage-shutter ground floors.
- **Ground floors → Barcelona shopfronts** (glazed bays + fascia sign band).
- **Wrought-iron balconies + floor bands** extended from residential-only to `BALCONY_CATEGORIES` (residential/commercial/office).
- **Window rhythm → Eixample:** WINDOW_STYLES retuned to tall ~2 m French-window openings at ~3 m floor period (aligns painted rows with the 3 m 3D balconies) + taller ~3.5–4 m ground floor for shops.
- REMAINING (next passes): uniform 3D cornice on all masonry (parapet currently commercial-only); industrial→Poblenou brick; religious→church massing; chamfered corners (`xamfrans`, bake-side).

## 2026-06-30 — Lane lines on trench roads + floating-vegetation cull (both frontend, no re-bake)
- **Missing lane markings on Ronda de Dalt / trench roads:** `roadRenderer.js:1038` skipped markings for ANY `road.tunnel` (Delhi-era guard). With Option-L daylighted trenches the corridor is a normal asphalt deck → its paint was suppressed. Now only skips fully-COVERED tunnels (`tunnel && layer >= 0`); `layer<0` daylighted corridors get proper center/lane/edge lines (heights already in the baked frame +0.03 m, no z-fight).
- **Floating trees/stones (images 11/12):** the vegetation WORKER's `fastElevationAt` CLAMPED out-of-tile samples to the high edge elevation, so baked roadside trees + clusters scattered onto neighbour-tile overhangs (long Ronda de Dalt ramps; Tibidabo slopes) hung in mid-air. Fixed at the sampler: returns NaN beyond OOB=3 cells outside the tile DEM footprint; all 7 veg builders (tree/shadow/bush/zone-tree/zone-bush/grass) cull non-finite Y to a zero-scale (invisible) instance. Covers every veg path (the earlier cluster-renderer guard only covered the main-thread cluster path).

## 2026-06-30 — City restore + skip broken-ramp roads (vibe > survey accuracy) — ⏳ verifying
- **City un-stripped:** `ENABLE_BUILDINGS`/`ENABLE_TREES` → true (config.js). Buildings + trees render on the finished terrain (no re-bake — tile data already carried them). Scale audited & correct: car 4.79 m (real M3), residential road 10 m, trunk 26 m, trees ~9 m tall — proportions right; the "trees feel big" is density + canopy overhang + trees-on-road (placement, NOT scale). Trees-on-road follow-up open (mask doesn't exclude multi-level/elevated road footprints).
- **Broken-ramp road skip (user-approved direction):** mangled half-ramp roads are DROPPED at the bake rather than rendered. FIRST tried a PROFILE-grade>0.20 heuristic → dropped **608 region-wide** (over-aggressive: caught legit steep ramps/short bridges; no clean grade cutoff exists). SWITCHED to RampResolver's PRECISE flag: `flattenedShortTunnel && !flat` (the exact Case-C case it gave up fitting a dip for — a steep monotonic connector between surface roads at different layers). Plumbed as `road.brokenRamp` through RampResolver→RoadGeometryBuilder→deepCloneRoad→tileSplit×2 (the four-whitelist pattern). `isBrokenRampRoad`: drop if `brokenRamp` OR profile grade > 0.60 (backstop for one-sided near-vertical cracks only); EXCLUDES drivable below-grade tunnel corridors (trench-carved). Filtered at the `payload.roads` chokepoint. Focused bake: **10 dropped** (vs 29 grade / 608 region) — surgical. Knob: `BROKEN_RAMP_GRADE` env (backstop only).
- **Trees-on-road fixed at source:** `vegetationBaker.js` AND frontend `vegetationMask.js` were SKIPPING tunnel/layer<0 roads when stamping the no-veg mask → trees/bushes landed on daylighted trench corridors and multi-level roads ("trees on the road where one is above"). Both now block EVERY road footprint (minor cost: thin no-tree strip over deep sealed tunnels). Also fixes bushes-in-trench.
- **Floor validator (slice ③) now CLEAN in the focused area** (0 violations) after the min-cell + asymmetric + layer-scope fixes — full-region confirm pending to flip to hard-block.
- All three (broken-ramp skip, tree mask, floor confirm) bundled into one full re-bake.

## 2026-06-30 — Phase 3 slice ③: commit-blocking floor validator in the bake — ⏳ confirming
New `backend/worldBuilder/terrain/validateTunnelFloors.js` + wired into buildRegion.js (collect per tile right after `carveTrenchesIntoGrid` with the DRAPED roads; report+throw after the tile loop). Enforces the keystone invariant **drivable-surface-implies-floor**: each drivable tunnel road (layer<0 whitelist) sampled @2m must have the carved grid within tolerance of `roadY − FLOOR_BELOW_ROAD(0.15)`. Default **commit-blocking** (throws, non-zero exit); `TRENCH_VALIDATOR=report` downgrades to a warning for diagnosis.
- **Check is ASYMMETRIC** (key correction): only flags grid TOO HIGH (`gridY − expectedFloor > 0.3` = terrain intruding above the roadway). A grid BELOW the floor is still a floor (carved deeper, e.g. overlapping deeper corridors cut shared cells) — safe, not flagged. Symmetric `abs()` falsely flagged 2346 deeper-carve samples → asymmetric drops to ~1 borderline.
- Tolerance 0.30 m LOCKED (design §5). Forward check only; the inverse clause (surface roads floating over a trench footprint; 2 native-dip roads 23792470/34099200) is a recorded follow-up, out of this check's scope.
- Focused-area report: 1 violation @0.49m (layer-1, near the bbox clip edge). Running a FULL-region report to get the true count before flipping the committed default to blocking.

## 2026-06-30 — Trench dressing RESOLVED at the source: wide smoothstep batter, walls off ✅ (user: "i like it")
The frontend wall iterations (overlap → sawtooth → giant slab → median fins → jutting block) were whack-a-mole on a noisy carved surface. User chose the bake-side fix. Done:
- **`trenchAuthor.js`**: `BATTER_WIDTH` 8→14 m + new `smoothstep()` easing in the carve AND the matching `flagFloatersOverCarve` prediction (kept consistent so floater flags still mirror the actual surface). The trench wall is now a wide S-curve graded slope (~4 grid cells, real-cutting look) joining floor and natural terrain with zero slope at both ends → the 3.6 m sawtooth is gone at the source. AABB prefilter margin in `buildTrenchCorridors` widened to reach `halfW+BATTER` (else wide-batter cells fall outside the candidate window and never cut). Min-only and floor (`FLOOR_BELOW_ROAD`) unchanged → drivable floor + deck colliders intact.
- **Frontend trench walls DISABLED** (`tileManager.js`): the graded terrain IS the clean trench, so `buildTrenchRetainingWalls` is no longer called (kept in source). Removes every wall artifact in one move.
- Focused re-bake of the spawn trench area (75 tiles, 269 s) verified on screen by the user. **Full-region re-bake running** to make the whole city consistent and remove the focused-area seam.
- Knob: `BATTER_WIDTH` (gentler/steeper vs how much terrain it eats). `buildTrenchCliffWalls`/`buildTrenchRetainingWalls`/`buildTrenchPortals` all remain in source, uncalled.

## 2026-06-30 — Trench walls → SMOOTH median-aware + floating-vegetation fix (superseded by the bake-side fix above)
On screen: smooth walls + grounded bushes both confirmed working; the wall over-grew into a giant slab on a hillside cut (probed bank top = hilltop 20 m+). Added TRENCH_WALL_MAX_RISE=7 m cap (tunnelRenderer.js) → bounded realistic retaining wall, natural slope above. Knob to tune.
Two fixes, both frontend-only, no re-bake:
- **GRID CLIFF WALLS REJECTED (sawtooth).** The grid-edge approach put a panel on every grid step, so it traced the carved sawtooth instead of hiding it — on screen it was two jagged zigzag walls. Replaced with a SMOOTH, MEDIAN-AWARE `buildTrenchRetainingWalls` (tunnelRenderer.js): walls follow the road edge (smooth, not the grid) from deck to probed bank-top (+0.4 m cap), and a new `facesMedian()`/`buildTrenchSegList()` test SKIPS any side within MEDIAN_LOOK (22 m) of a parallel carriageway — so the inner walls that used to overlap into a grey mass are never built. Outer banks only. `buildTrenchCliffWalls` left in source, uncalled. Rewired in tileManager.js.
- **Floating bushes FIXED.** Root cause (agent-confirmed against disk tiles): cluster centers are scattered across a bbox built from road/building points that include CLIPPED roads overhanging the tile by 200-460 m (long Ronda de Dalt ramps); `getElevationAt` then CLAMPS those out-of-tile samples to the edge elevation, so on the hillside the bushes hang at a constant high edge value while the neighbour tile draws the terrain lower downhill = a horizontal line of bushes in the sky. Fix (environmentClusterRenderer.js): skip any cluster item whose worldToLatLon falls outside the tile's own `elevation.{south,north,west,east}` footprint (that ground belongs to the neighbour tile, which plants its own veg). NOT grid-vs-baked divergence (refuted: baked visual ≡ elevations grid byte-for-byte; trench carve is in both).
- Secondary veg bug NOTED (not yet fixed): vegetationMask skips tunnel/layer<0 roads, so daylighted trench corridors aren't stamped blocked → some bushes grow IN the trench. Separate from the floaters.

## 2026-06-30 — Trench dressing redesign: GRID CLIFF WALLS (the polished one-time fix) — superseded same day (sawtooth)
Replaced the per-road both-sides retaining walls (which overlapped into a grey mess on stacked carriageways and never matched the jagged carve) with `buildTrenchCliffWalls(elevation)` in `tunnelRenderer.js`, wired in `tileManager.js` (gated ENABLE_RETAINING_WALLS, tracked on `entry.trenchWallMesh`). Mechanism: scan the carved terrain grid (`elevation.elevations`, the same source as the heightfield/getGroundY); wherever two adjacent grid cells differ by ≥ CLIFF_MIN_STEP (2.0 m, ≤ CLIFF_MAX_STEP 40 m) stand a vertical concrete panel on that grid edge using the exact buildTerrainMesh world mapping (x linear in lon, z per-row via latLonToWorld; y=(raw−offset)·vertExag). Why this is the right fix:
- **Median-aware by construction** — a flat median between parallel carriageways has no step → no wall, so the grey-overlap mess is impossible (each grid edge dressed exactly once).
- **Occludes the sawtooth** — the jagged earth step is replaced by a clean vertical panel sitting on the grid edge.
- **Caps the exposed cliff** under crossing streets so the daylighted trench reads as a walled cut (the "road ends over a cliff" complaint).
- Co-framed with physics (≤0.01 m per D-16), visual-only under worldGroup (auto X-mirror, latLonToWorld coords — no manual negation), no re-bake.
- Knobs: CLIFF_MIN_STEP (raise to dress fewer/only-major cliffs), CLIFF_MAX_STEP. Could not self-verify on screen (automated tab is `visibilityState:hidden` → rAF-throttled, load stalls); awaiting user drive-test in a foreground tab. `node --check` clean.
NOTE: `buildTrenchRetainingWalls`/`buildTrenchPortals` remain in source but UNCALLED (kept for reference); the cliff-wall pass supersedes them.

## 2026-06-30 — Trench retaining walls DISABLED (confirmed on screen) — grey-plane mess gone
After reverting the coping/portals the grey-plane mess REMAINED → root cause was the pre-existing `buildTrenchRetainingWalls` itself: per-road both-sides vertical walls on the stacked Ronda de Dalt carriageways overlap into a chaotic grey mass. Commented out the `buildTrenchRetainingWalls` call in `tileManager.js` (function kept for a median-aware redesign). Verified on the rendered screen (own tab, FPS 118 after interaction un-throttled it): trench at lat 41.4088 Ronda de Dalt now shows clean carved terrain + descending carriageways, NO grey planes. Remaining: terrain sawtooth on the cut edges (3.6m grid aliasing — separate Phase-4 item) and the inherent multi-ribbon look of the trunk. Note: the trench is now visually undressed (raw earth banks); a future median-aware wall pass should dress only the OUTER bank of a carriageway group.

## 2026-06-30 — Slice-② feedback round 2 follow-up: REVERTED the two visual additions (#3 coping/cap, #4 portals)
User drive showed the outward coping ledge + portal frames overlapping in the MEDIAN between Ronda de Dalt's parallel carriageways → dark triangular "tent" mass down the middle. Both were unverifiable on my end (backgrounded-tab rAF throttle) and clearly backfired. Reverted:
- `buildTrenchRetainingWalls` (`tunnelRenderer.js`) restored to the prior vertical-wall-only form (PROBES [6,10,14,18], MIN_RISE 0.4, no cap, no coping). The sawtooth returns but no median mess.
- `buildTrenchPortals` call disabled in `tileManager.js` (function + import left in place for a future median-aware redesign).
- KEPT: #1 black-pillar fix (trench-corridor pillar skip + emissive) and #2 streaming-jump fix (heightfield-first). Those are the solid wins.
- Lesson: trench dressing must be median-aware (only dress the OUTER bank of a carriageway group, not every road's both sides). Revisit when an on-screen-verifiable path exists.

## 2026-06-30 — Slice-② drive-feedback round 2: black-pillar mass, streaming jump, trench-wall sawtooth, undefined portal (⏳ pending on-screen gate)
User drive of the Ronda de Dalt ramps surfaced 4 defects; diagnosed read-only (3 parallel agents) then fixed. ALL frontend-only, no re-bake. **Not yet confirmed on screen** — my verification tab was rAF-throttled in the background (spawn tile Phase1 logged 203 289 ms wall / 140 ms work = the cooperative loader starving while the tab is hidden), so the scene never finished loading for me to screenshot. Code verified via `node --check` + runtime tile log (spawn tile completed Phase1 `tunnels+setup:11.7ms` with no exception). Awaiting user drive-test.
- **Black floating slab (Image #2) = bridge PILLARS, not a deck.** Real `bridge=yes` crossing streets build pillars whose bottom samples `getElevationAt` — now the deep trenched grid → 10–15 m Lambert columns sunk in the trench, near-black when occluded. The changelog's earlier "pillars got crossesTrench" claim was wrong; the slice-② carve resurrected pillars that used to be ~0 m. Fix (`roadRenderer.js`): new `buildTrenchCorridorSegments` + skip in `buildBridgePillarMeshes` for any pillar landing inside a tunnel-road corridor (roadHalf + 12 m, covers TRENCH_MARGIN 4 + BATTER 8); pillar material gets `emissive 0x35322f` so it can never render pure black.
- **Streaming "jump where roads emerge" = late ground collider.** Heightfield was built AFTER the slow visual `buildTerrainMesh` + its `_perfYield` chain, so a car reaching a still-loading tile free-falls onto the −50 m plane → collider added under the penetrating chassis → impulse shove. Fix (`tileManager.js`): moved the Heightfield build+`addBody` to run FIRST in the terrain block (depends only on `elevation`+`key`), shrinking the groundless window.
- **Sawtooth trench walls (Image #1).** `buildTrenchRetainingWalls` (`tunnelRenderer.js`): MIN_RISE 0.4→0.12 (continuous, no gaps), denser probes [4,7,10,13,16,19], top raised TRENCH_WALL_CAP 0.5 m proud of the bank so grid-stepped earth can't poke over the straight top, + new horizontal coping ledge (TRENCH_WALL_COPING_OUT 2.5 m) burying the jagged cut edge behind a flat shelf.
- **Undefined tunnel entrance.** New `buildTrenchPortals` (`tunnelRenderer.js`, wired in `tileManager.js` next to the trench walls, gated by ENABLE_RETAINING_WALLS, tracked on the tile entry for cleanup): concrete headwall + portal lintel framing the carriageway where the road first drops PORTAL_ENTER_DEPTH (3 m) below the probed natural bank — terrain-relative (no absolute-Y, G-47 clean), the cut-and-cover mouth look for the Option-L open trench. Most experimental of the four; easy to disable if it reads wrong.

---

## 2026-06-10 — Production terrain pipeline: BILINEAR DEM sampling + 128-grid mesh (kill the terraced "boxes")

User reported the terrain looked fake — a regular grid-aligned stair-step / quilted pattern, and roads sinking
into it. Root cause: `demLoader.sampleElevation` used **nearest-pixel** sampling (`Math.floor`), so the fine
mesh snapped many vertices to the same coarse ~30 m DEM pixel → flat patches + hard steps (terraces). Fixes:
- **Bilinear DEM interpolation** (`demLoader.sampleElevation`) — interpolate the 4 surrounding DEM pixels
  (NoData-aware) → continuous natural surface, no terraces; roads (sampled the same way) conform.
- **Terrain mesh 64 → 128** (`terrainBaker GRID_SIZE=128`, `CONFIG.TERRAIN_MAX_GRID=128`) — full DEM grid, no
  downsample; mesh = getElevationAt = baked roads, all one surface. Budget freed by stripping non-essentials.
- Kept the global DEM box blur (`smoothRaster`, env `DEM_SMOOTH_RADIUS/ITERS`) for gentle relief.
Also (debugging aid): CONFIG stripped to terrain + road surface + bridges/tunnels/ramps only (buildings,
vegetation, urban features, carts, barriers, road infra, water, markings, etc. OFF). Re-bake required.

## 2026-06-10 — Terrain-as-truth: smoothing + bake-draped roads SHIPPED; heightfield-only physics REVERTED (D-16)

Net result after iteration: **smoothing (Stage A) shipped**, **roads drape via the bake** (baked at the smoothed
DEM → conform to the smoothed terrain), **physics simplification reverted**.
- Kept: `demLoader.smoothRaster` (global DEM box blur, env-tunable). Roads use the baked fast path (now baked at
  smoothed DEM, so they drape).
- Reverted (regressed): the runtime road drape (`getRoadPointHeights` surface branch + disabling the baked
  fast path) caused spiking ribbons (forced-runtime bridges/tunnels dove underground); and the heightfield-only
  physics + dropping surface-road colliders trapped the car BELOW the terrain (heightfield orientation). Physics
  back to visual-aligned Trimesh + chassis mask WORLD + original road-collider gate. See D-16 status note.

## 2026-06-10 — (superseded by the line above) Terrain-as-truth pivot attempt: drape + heightfield-only physics

Architectural pivot (user-driven) that resolves the road-vs-terrain / fall-through tangle at the root.
- **Stage A (bake):** `demLoader.smoothRaster` — separable NoData-aware box blur over the global DEM at load
  (env `DEM_SMOOTH_RADIUS`/`DEM_SMOOTH_ITERS`, default 2/2). Global pre-smooth → gentle + seamless hills
  (both visual mesh and physics heightfield read the smoothed grid). Re-bake required.
- **Stage B (render):** `roadRenderer.getRoadPointHeights` — surface roads (layer 0, not bridge/tunnel/ramp)
  now drape on the terrain (sample `getElevationAt`, ignore baked `p.elevation`); all road features cascade.
  Baked road fast path disabled (`USE_BAKED_ROAD_FASTPATH=false`) so surface ribbons build at runtime + drape.
- **Stage C (physics):** `tileManager.createRoadTrimeshColliders` gate → `if (!isBridge && !isTunnel &&
  !isRamp) continue;` — surface roads get NO collider; they ride the terrain heightfield. Only
  ramps/tunnels/bridges keep structural colliders.
Net: roads conform exactly to terrain (no float/z-fight, junctions meet at one height); one heightfield is the
drivable surface (wheels grip, no fall-through); surface-road collider class eliminated. See D-16, G-49.

## 2026-06-10 — Off-road fall-through, part 3 (FIX): chassis body-collision backstop on terrain (G-49)

The heightfield attempt (part 2) still fell — its untested world→physics transform misplaced the collider. Reverted.
Final fix uses what's PROVEN: the visual-aligned terrain Trimesh (runtime gap = 0.00 m) in group TERRAIN(16), and
the car chassis now collides with it (`chassis.mask = WORLD | TERRAIN`). Ray-vs-trimesh misses (D-10), but
BOX-vs-trimesh narrowphase is reliable, so the chassis box catches the car instead of free-falling. Own group keeps
the chassis off the road-deck GROUND boxes (no edge-seam stutter); box bottom rides ~0.1 m above the surface so it
only engages once wheels lose contact. Limitation: wheel rays still miss the trimesh → no off-road wheel
suspension/traction (car rests on chassis, can't drive far onto terrain); roads remain the gameplay surface. See G-49.

## 2026-06-10 — Off-road fall-through, part 2: terrain physics switched Trimesh → Heightfield (G-49)

After the alignment fix (below) the collider was provably correct (gap 0.00 m) yet the car STILL free-fell
off-road. Live probes (window._debugVehicle/_debugWorld) showed wheels over terrain `inContact=false` and manual
`world.rayTest` over terrain returning MISS while rays over road boxes HIT — i.e. cannon-es `rayTest` can't hit
our `CANNON.Trimesh` (fragile octree rayQuery; same reason roads are boxes, D-10), and the chassis doesn't
collide with ground by design (ground = wheel rays only). Fix: terrain physics now uses the pre-existing-but-
unused `buildTerrainHeightfield` (`CANNON.Heightfield`, group TERRAIN=16) instead of `createTerrainTrimesh`.
Heightfields raycast via direct grid lookup → wheel rays hit reliably → car drives on terrain, no fall-through.
Same 64-grid + `(y-offset)*vertExag` as the visual mesh (co-framed); caller applies the world→physics X-negation.
Trimesh kept as fallback only. Heightfield can't carve tunnel pits (Stage 3; spawn tunnel-free). See G-49.

## 2026-06-10 — Fix off-road fall-through: physics terrain now uses the VISUAL baked mesh (G-49)

User report: driving off-road = falling through terrain. Live probe (window._debugWorld): terrain collider
present, up-normals, GROUND group — but the trimesh surface under the car was ~8.7 m ABOVE the car. Root:
physics terrain was baked at PHYSICS_GRID 32 while the visual mesh is GRID_SIZE 64; on Montjuïc's steep slopes
the two sampled different DEM cells, so the collider sat metres off the drawn surface. The chassis doesn't
collide with ground (by design) — only the short (~1 m) RaycastVehicle wheel rays do — so the wheels missed the
displaced collider and the car fell. Fix: `createTerrainTrimesh` now prefers `bakedTerrain.positions/indices`
(the visual 64-grid mesh) over `bakedPhysicsTerrain`, with the same `(wy−offset)·vertExag` transform → collider
byte-identical to the visual surface. Render-side, **no re-bake** (reuses existing baked visual verts). See G-49.

## 2026-06-09 — Consolidation: documented the Stage-2 elevation-pipeline fixes (ADRs D-13/14/15, gotchas G-46/47/48)

Doc-only pass (no game code changed) capturing this session's elevation fixes before Stage 3, with verified
current state:
- **D-12** extended: single offset enforced at every consumer (no `tileMinElevation` branch anywhere),
  gated by `whenElevationOffsetReady()` + fail-fast `assertElevationOffsetResolved()`; consumer sites listed.
- **D-13**: `useBaked` is the live terrain path — `TERRAIN_MAX_GRID=64` must equal bake `gridSize=64`, else
  the buggy runtime fallback (water cones) silently renders while fixes target the baked mesh.
- **D-14**: road DEM-drape writes `p[3]` (serialized elevation field), not `p[1]`; road height is now
  terrain-inclusive → CRITICAL coupling: height thresholds must use above-terrain / structural, never absolute.
- **D-15**: bridge detection gates on structural flags (bridge/layer/isRamp) + above-terrain, not normalized height.
- **G-46**: parser `{x,y}` object data-shape contract (greens/parking fixed; flagged residual at parkingRenderer:82).
- **G-47**: the "fine at terrain≈0, wrong with real DEM" failure class — catalogue of instances.
- **G-48**: required verification checklist (identify rendered object → log runtime value → verify on screen →
  full reload/fresh bundle → never trust a report over the screen).

## 2026-06-09 — Standardize ground anchoring across ALL world-placed renderers (G-45)

Deep sweep after the user reported walls/barriers, washrooms, vendor carts and tunnel gates still
floating. Root: these were the only placed-mesh renderers tileManager called WITHOUT an elevation
function — they hardcoded `makeTranslation(wx, 0, wz)` (Y=0: floats below-spawn, buries above-spawn) or
read raw absolute `road.points[].elevation` (floats +offset). Fix: tileManager now defines a canonical
`getGroundY(wx,wz)` (normalized terrain render-Y) and passes it to barrier, tunnel (all 4 builders),
urbanFeature and vendorCart renderers.
- urbanFeature / vendorCart: `makeTranslation(wx, getGroundY(wx,wz), wz)`.
- barrier: per-vertex `drapeToGround` post-pass (geometry is world-X/Z + local-Y) — matches the
  per-segment ground Y the colliders already used.
- tunnel: `_normTunnelElev` (offset-normalize) for road-anchored Y; `getGroundY` for surface constants
  (`topY/surfY/botY`); skip/threshold tests made terrain-relative (`elev > groundY−k`, was absolute
  `−0.5`/`0`). Deep tunnel-enclosure depth/skip correctness remains Stage 3.
Render-side, no re-bake. See gotchas G-45 (umbrella), siblings G-43/G-44.

## 2026-06-09 — Fix floating BAKED road surface (v7 fast path stored absolute DEM, never offset-normalized)

The actual "roads in the sky" web: `renderTileRoads`' pre-baked fast path (`options.bakedRoads.layers`)
loads `bakedLayer.positions` verbatim — baked offline at absolute DEM Y — with no offset shift. So the
road SURFACE floated exactly +offset (~80 m on Montjuïc) while runtime-built markings draped (they use
`toNormalizedRoadY`). Live probe: overhead meshes were `MeshStandardMaterial`+`vertexColors` with attrs
`position,normal,uv,halfWidth,color` (= shared road material + flat ribbon), vertexY−terrainY ≈ +80
everywhere. Fix: normalize the baked geometry into the spawn frame — `geom.scale(1,vertExag,1)` +
`geom.translate(0,-offset*vertExag,0)` — baked into the GEOMETRY (not mesh.position) so it survives
`mergeMeshesByMaterial`, which merges raw geos and drops per-mesh transforms. Render-side, no re-bake.
See gotchas G-44. (The earlier "road surface confirmed draped" reading came from the runtime path /
range-aggregate; the baked path was the real consumer.)

## 2026-06-09 — Fix floating road-infrastructure "web" (offset not subtracted; downstream of road-drape)

`roadInfraRenderer` anchors signs/boards/poles/gantries to `road.points[i].elevation`, which is raw
absolute DEM after the road-drape fix. It receives no `getElevationAt`/`elevationOffset` from tileManager,
so it placed infra at absolute DEM — ~80 m above the draped road on Montjuïc — a dark `#bbbbbb` web
overhead (live probe: 462 overhead meshes at Y 87–192 vs terrain −15 under the camera). Road surface +
markings were always correct (they use `toNormalizedRoadY`); only these road-anchored decorations bypassed
the offset. Fix: added `normRoadElev()` (`(rawDEM − worldElevationOffset) × vertExag`) and routed all
elevation→baseY seams (interpolate/walkPolyline readers + junction `connectedRoads` entries) through it;
junction entries now also carry a normalized elevation so traffic lights terrain-follow. Render-side, no
re-bake. Note: `urbanFeatureRenderer`/`vendorCartRenderer` still place at `Y=0` (sink on slopes, not float)
— separate latent issue. See gotchas G-43.

## 2026-06-09 — Fix spurious bridge structures (render-side; downstream of the road-drape fix)

Bridge slab/guard-rail/shadow/collider builders in `roadRenderer.js` decided "is this elevated" from
terrain-INCLUSIVE road height (`hMax > 4.0`, `Δh > 2.5`, `rawElevMax/Range` off absolute `p.elevation`).
Correct in flat-world (height = layer profile); broken after the road-drape fix made height = `DEM − offset`,
so terrain elevation/slope fired on ~60% of surface roads → slabs+rails fabricated over Montjuïc as a dark
"overhead canopy" (draped correctly, but should not exist). Bridge Y itself was always correct (offset
subtracted) — this was a detection bug, not a positioning bug.

Fix: gate all four builders on **structural flags** (`road.bridge || road.layer > 0 || road.isRamp`); `_link`
roads only when they have a real **above-terrain** rise. Added `getAboveTerrainHeights()` (subtracts
`getElevationAt`, cancels DEM, leaves layer/ramp component); `MIN_BRIDGE_STRUCTURE_HEIGHT` taper and shadow
`heightAlpha` now key off it. No re-bake (render-side). Counts on bridge-free tiles: slab 165→3 / 184→2
(remaining are genuine ramps); real bridges/ramps still get structures. See gotchas G-42.

## 2026-06-09 — Road DEM-drape fix: DEM-add wrote the wrong field (p[1], not the serialized p[3])

The last elevation bug: 238/240 surface roads baked at elevation 0 → render flat at −80 while terrain rises. Root: the bake's road DEM-add wrote `p[1] += groundElev`, but road points are `[mercX, yUp, mercZ, elev]` (`RoadGeometryBuilder:44`, p[1]=p[3]=yUp initially) and **convertToBinary serializes elevation from p[3]** (`flattenRoadPoints` prefers the `elevation` array = p[3] whenever finite; p[3]=0 is finite). So the DEM landed in the ignored fallback field; serialized elevation (p[3]) stayed at yUp=0 → flat. The 2 "draped" roads only survived because RampResolver had modified their p[3] (a DEM-free *relative* layer profile — not real terrain).

- **Fix (`buildRegion.js:~1200`):** add `groundElev` to **p[3]** (the serialized elevation), keeping `p[1] +=` as the 3-element fallback. p[3] holds the layer-relative profile (0 surface / ramp descent), and RampResolver is explicitly DEM-free, so adding groundDEM drapes every road with no double-count: surface → DEM, ramp/bridge → DEM + relative profile.
- **Predicted before→after (Poble Sec, terrain raw ~30, offset 80):** surface road serialized elev 0 → **30**; rendered Y −80 (flat, buried) → **−50 (= terrain, draped)**. Ramps (Miramar) go from relative-profile-over-0 to profile + real DEM (now actually on terrain).
- **Re-bake REQUIRED** (road elevation is baked data) + full reload. Acceptance: road traverse rows should span the terrain relief (not pinned ~−80), roads follow slopes / sit between buildings.

## 2026-06-09 — Fix greens/parking polygon data-shape mismatch (the "floating gray planes")

The flat gray features floating over the city were **collapsed greens & parking polygons**, not roads. Root cause: the tile parser (`readFloat32Pairs` via `readGreens`/`readPolygonFeatures`) delivers polygon points as **`{x, y}` objects**, but `greensRenderer` and `parkingRenderer` indexed them as **arrays `point[0]/point[1]`** → every coord read `undefined` → `shape.moveTo(undefined,undefined)` → `ShapeGeometry` collapsed to the origin → rendered flat at worldGroup-local (0,0) = world ~(3661,−2067), far from terrain, at y=0. Dormant in the flat world (origin-collapsed at y=0 looked like terrain at y=0); DEM exposed it when terrain went negative. `waterRenderer` reads `.x/.y` — that's why water was always correct.

- **Fix:** switched both renderers to `.x/.y` (matching the parser + waterRenderer convention). `greensRenderer.js` polygonCentroid (`:40,43-44`) + shape build (`:85-86`); `parkingRenderer.js` pointInPoly (`:31-32`), centroid (`:55-56`), shape (`:66-67`), uniqueNodes (`:77`). Stale `[[x,z]]` docstrings updated to `{x,y}`.
- **Scoped — no other victims:** grep of all renderers for `[i][0]/[1]` point access: barrier consumers (vegetation/cluster) read `barrier.points` which `readBarriers` returns as arrays (correct); `vegetationMask` is defensive (`.x ?? [0]`); `crashBarrier` uses local arrays; beaches/pedAreas have no array-index renderer. Only greens + parking were broken.
- **Symptom chain explained:** the earlier `getElevationAt→0` was downstream — a collapsed polygon at origin queries `worldToLatLon(0,0)` ≈ origin lat/lon, misses the tile → 0. The offset/gate/sky/worker investigations were red herrings; the offset path stays exonerated.
- No re-bake (baked coords were correct). Render-side only; full reload.

## 2026-06-09 — Stage 2: remove the tileMinElevation offset gate everywhere (finish D-12 → fixes road float)

The `useBaked` terrain co-frame shift used `getWorldElevationOffset()` **ungated** (=80), while roads / `getElevationAt` / fallback terrain / physics-trimesh used the **gated** `tileMinElevation != null ? 0 : getWorldElevationOffset()`. At runtime `tileMinElevation` was non-null (baked tiles carry it, e.g. 28; the parser's `null` override wasn't reliably live in the worker), so the gated sites resolved to **0** → terrain shifted 80, everything else shifted 0 → **~80 m road float** (roads on flat planes cutting through buildings). The `useBaked` switch exposed it (old fallback terrain shared the gated offset with roads, so they matched).

- **Fix (Option 1b, completes ADR D-12):** removed the `tileMinElevation`/`elevationIsRebased` gate at **every** consumer — all now unconditionally use `getWorldElevationOffset()`. Sites: `terrainRenderer.js:136` (mesh) & `:736` (heightfield), `tileManager.js:355` (road trimesh), `:821` (terrain trimesh), `:1036` (entry flag → false), `:1332` (vegetation/road options), `:1400`+`:1410` (road collider — removed the local flag & param), `:2625` (road-height query). `useBaked` (`:699`) already ungated — now matches everyone.
- **Worker-staleness now irrelevant:** no consumer reads `tileMinElevation`, so whether the worker reports `28` or `null` cannot split the frame. Grep-confirmed: only the parser-null (`tileParserWorker.js:330`, now moot) + convertToBinary write (harmless, unused) remain — zero branching.
- **Result (computed, Montjuïc tile 16_33161_24481):** terrain `raw−80` = [−52..+26]; roads `toNormalizedRoadY(0,80)` = −80 — **same offset, no systematic float** (was +52..−26 floating). Fail-fast: all consumers share one source, covered by the `processTileData` gate (`whenElevationOffsetReady` + assert) which runs before any build.
- **NOT fixed (separate, next):** roads baked at elevation 0 (no DEM drape, `buildRegion.js:1200`). So roads are now co-framed but FLAT at −80 → **flush with terrain at sea level, BURIED 28–106 m under Montjuïc**. Expect on screen: float gone, but roads sink into hillsides until the drape fix. No re-bake (render-side); hard reload.

## 2026-06-06 — Stage 2: RENDER THE BAKED TERRAIN MESH (useBaked was silently false → fallback cones)

Root finding: the frontend was rendering the runtime FALLBACK terrain mesh, never the pre-baked one — the gate `useBaked = bakedTerrain.gridSize === CONFIG.TERRAIN_MAX_GRID` was `64 === 32` = false. So every Stage-2 terrain fix + validation targeted the UNUSED baked mesh, while the screen showed the fallback, whose water-depression (`terrainRenderer.js:246`) set water vertices to an **absolute** `~-2` (not offset-corrected) → ~72 m up-cones at El Raval's dense water polygons. This is why "data clean" disagreed with "screen shows cones."

- **Fix (Option 2):** `CONFIG.TERRAIN_MAX_GRID 32 → 64` to match the bake's `gridSize` (terrainBaker `GRID_SIZE=64`) → `useBaked = true`, so the pre-baked mesh (carrying the co-frame shift + closed-only water-sink, all verified) renders and the buggy fallback is bypassed. One-time `[Terrain] useBaked=TRUE` log added.
- **Baked mesh verified good** (never been rendered): 4096 verts/tile, 4096 valid normals (0 zero/bad), ~7800 tris, **0 degenerate**, clean Y (El Raval 8–32, Montjuïc 28–106). Hole-punching for tunnels is baked into its indices.
- **No physics impact:** `buildTerrainHeightfield` (the other `TERRAIN_MAX_GRID` consumer) is imported but never called; physics uses `createTerrainTrimesh` with its own `PHYSICS_GRID=32`. Only visual mesh res rises 32→64 (4×, modest).
- **Defense-in-depth:** also fixed the fallback's `terrainRenderer.js:246` to `y = seaLevelNorm + depthTarget` (offset-relative) so the now-bypassed path isn't a latent cone landmine. Stale "useBaked is always true" comment corrected.
- **Co-frame after fix:** baked land renders `(grid−offset)` = −72…−48 (El Raval); closed water at `(surfaceElev−2.5−offset)` ≈ −82 (flush with sea); NO cones (baked grid has no open-polyline streams). Buildings drape via `getElevationAt` (same normalized frame) → sit correctly. **Roads remain flat at elevation 0 (separate known bug — road DEM-add not landing); they will NOT drape until that is fixed.**
- No re-bake (baked data exists/clean). Hard reload + cache clear. Acceptance is on the RENDERED screen (cones gone, FPS) — pending user confirm.

## 2026-06-06 — Stage 2: water-sink #2 — exclude OPEN polylines (streams/canals/coastlines)

The relative-flat sink (#1) fixed small closed ponds but left large artifacts: the terrain sink ran point-in-polygon on OPEN polylines too — `stream`/`canal`/`coastline`/`wetland` features are buffered LINE geometry (3–5 km, `closed=false`, spanning up to 244 m elevation). PiP on a non-closed ring flattens arbitrary terrain patches to one garbage median → raised mesas/sheets (coastal end of a stream lifted to ~100 m), cones (islanded high points), region-wide (streams are unclipped, present in every tile). The renderer already excludes these (`waterRenderer.js:164 isOpenPolyline`); the bake didn't — they disagreed.

- **Fix (`buildRegion.js` water-sink):** only flatten terrain for CLOSED AREA water. New `isClosedAreaWater(poly,type,closed)` mirrors the renderer — skips `closed===false`, linear types (`stream`/`canal`/`coastline`/`wetland`/…), and open polylines (first≠last by ≥1.5 Mercator ≈ 1 m world). The build keeps `type`/`closed` metadata (was discarding it). **Safety net:** any kept body whose shoreline DEM spans >18 m returns `null` → not flattened (catches mis-tagged multi-elevation polys). `type`/`closed` come from `waterNormalize.js:119-123`.
- **Result (re-baked, verified):** spike/pit tiles **8 → 0**; worst spike 83.5 m → 7.5 m, worst pit 90.5 m → 4.5 m (both now normal terrain steepness). The worst-pit point (`33154_24472`, was flattened to 61.5 by stream `1351520321` span 186 m) restored to **154 m** real terrain. Per port tile: **69 open polylines skipped, 183 closed bodies still sunk** — closed sea/harbour/ponds still dip to ~−2.5 (regression-safe). Mesas/cones/raised sheet gone region-wide. Streams get no flat sink (no valid 'inside'); a visible sloped channel, if ever wanted, is future per-segment carving.

## 2026-06-06 — Stage 2: relative (flat) water-sink — fixes DEM spikes/pits

`WATER_BAKE_DEPTH = -2.5` (absolute) was slamming every water-polygon grid point to sea level regardless of the body's real elevation. Dormant in the flat world; DEM-on exposed it: inland/high water (e.g. a 154 m pond) → −2.5 = deep pits; real terrain islanded by sunk neighbours → spikes; both bilinear-smeared into cones, concentrated at water/coast. (DEM itself is clean — nodata −32768 is read+filtered, zero void pixels.)

- **Fix (`buildRegion.js` water-sink ~:1067-1122):** sink RELATIVE to each polygon's real surface. `WATER_SINK_DELTA = 2.5` m below a per-polygon **flat** `surfaceElev` = median DEM at the polygon's shoreline vertices (`mercatorToLatLon` + `demSampler`; fallback 0 → −2.5, preserving flat-world/sea behaviour). `data[idx] = surfaceElev[pi] - WATER_SINK_DELTA`. Removed the now-meaningless `<= WATER_BAKE_DEPTH` skip.
- **Marina framing checked — OK:** `worldToMercator` (`projection.js:45`) is the exact inverse of `mercatorToWorld`, same raw-Mercator frame as the grid's `latLonToMercator`. Not contributing. No change.
- **Result (re-baked, verified):** sea/coast unchanged (−2.5); spike/pit tiles **29 → 8**; worst pit 156 m → 90 m, worst spike 132 m → 83 m; no more −2.5 values. **Residual 8 tiles** (e.g. 16_33154_24472 pit 90 m): a flat-median surface applied to a point amid much-higher terrain → likely sloped/linear water (median wrong) or an over-broad/unclipped polygon catching stray grid points. Follow-up: skip sinking grid points whose raw DEM is ≫ the polygon surface, or handle sloped water with a gradient. Did NOT touch tunnel trench geometry (Stage-3; port trench is compounded by 5 tunnel-road portals).

## 2026-06-06 — Stage 2 co-frame: elevation-offset BUILD GATE (Path B, root fix)

The earlier per-layer offset fix only re-applied to the terrain *visual* (an `onSpawnElevationReady` self-heal); the other 5 consumers (terrain physics, road visual/physics, vegetation, terrainMinY/maxY) froze the build-time offset, so any tile built before `worldElevationOffset` resolved baked the absolute frame → mixed state (ground correct, roads/trees/physics floating +offset). Replaced with a **single happens-before gate** instead of per-layer re-apply (which re-creates the every-layer-must-resync fragility).

- **Gate:** `processTileData` (`tileManager.js`) now `await whenElevationOffsetReady()` as its first statement — no elevation layer builds until the offset is resolved. The offset comes from the spawn tile's *parse* (`main.js:106`), independent of geometry builds, so it cannot deadlock; resolves immediately in normal flow. New `elevationOffset.js: whenElevationOffsetReady()`.
- **Fail-fast:** `elevationOffset.js: assertElevationOffsetResolved(where)` throws loudly if any consumer is reached with the offset null (gate bypassed) — called in `processTileData` and `terrainRenderer.buildTerrainMesh`. Production-grade: fail loud, never silently bake the absolute frame.
- **Removed** the `onSpawnElevationReady` self-heal (`terrainRenderer.js`) and the `onSpawnElevationReady` export entirely (grep-clean). Terrain visual now sets `position.y = -offset·vertExag` once, gated.
- Verified: spawn tile `16_33161_24481`, `worldElevationOffset = 80.00 m`, spawn → Y 0; all layers co-framed `(rawDEM − 80)·vertExag` at startup. Build green. Runtime only — no re-bake; hard reload.

## 2026-06-05 — Vertical-model Stage 2: DEM-on (real terrain elevation)

Per [vertical-model-foundation-spec.md](vertical-model-foundation-spec.md) §4, onto the Stage-1 honest coordinate space. Turns on the dormant DEM bake path, unifies the elevation baseline, removes the flat ground plane. **Structural — atomic three-step: code → full region re-bake → `window._clearTileCache()` + hard reload. The world is split/lying until all three are done.** Stage-3 absolute-Y items (wall/portal/trench heights, deck-gate clause, tunnel fall-through, SEA_LEVEL) deliberately NOT touched — expected to look wrong on the drive.

- **Un-gated DEM (1 line):** `buildRegion.js:383` — removed `cleanRoadPipeline ||` from `phase1Pure2D`. `cleanRoadPipeline` (road-fidelity: raw/all-highways/skip-simplify) no longer forces flat-world; the DEM loader (`:928`) now fires because `cfg.phase1Pure2D:false`. `:384` untouched. DEM on/off is now controlled solely by `cfg.phase1Pure2D`. Co-frame confirmed: terrain (`:1046`) and roads (`p[1]+=groundElev`, `:1155`) share one sampler guard → tunnel Y = `DEM + layer·−6`.
- **Unified elevation baseline (the chokepoint):** `tileParserWorker.js:327` `tileMinElevation: elev.tileMinElevation` → `null`. Flips all 6 consumption sites to the spawn-anchored `getWorldElevationOffset()` and all `elevationIsRebased` flags to false. The per-tile `tileMinElevation` fork is dead; `worldElevationOffset` is the single region-wide baseline. Every Y = `rawAbsoluteDEM − spawnElev` → spawn (Sagrada Família, DEM +45m) normalizes to ~0; Montjuïc ≈ +144m, seafront ≈ −45m. (`convertToBinary.js:132` still emits the now-ignored field — optional cleanup, not done.)
- **Removed the flat ground plane:** `scene.js` — the 2000×2000 `groundMesh` pinned to Y=0 is gone (`groundMesh = null`; `worldGroup` kept). A single flat plane can't conform to a height field (slices up-slopes / hides down-slopes) and had no physics role (per-tile Trimesh colliders + Y=−50 fallback floor handle ground). `main.js:314` / `carDriver.js:83` guard on null. Real DEM relief now reads cleanly.
- **Known-deferred to Stage 3** (will look wrong, NOT regressions): floating/buried tunnel walls & portals, portal trench depth, spurious deck boxes on slopes, tunnel fall-through (Gran Via/Plaça Cerdà), SEA_LEVEL frame. Stage-2 follow-up: RampResolver profiles run topologically (endpoints land correct; profile doesn't hug terrain yet).
- Frontend build green. **Re-bake not yet run (handed to user).**

## 2026-06-05 — Vertical-model Stage 1: Unstretch-X (1 unit = 1 real metre)

Per [vertical-model-foundation-spec.md](vertical-model-foundation-spec.md) §3 (corrected). Makes horizontal world coords real metres so XZ matches Y; foundation for DEM-on (Stage 2). See ADR **D-11** and [coordinate-systems.md](coordinate-systems.md) unit invariant. **Structural — requires a full region re-bake (not yet run; handed to user).**

- **Projection factor at 6 paths:** `MERCATOR_UNSTRETCH = cos(ORIGIN_LAT)≈0.7507` applied after origin subtraction. `frontend/src/projection.js` (exports it; fwd `mercatorToWorld` ×, inverse `worldToMercator` ÷), `backend/projection.js`, `tileParserWorker.js` (4 sites: triples/pairs/baked-veg/JSON), `vegetationWorker.js` (latLonToWorld + worldToLatLon + its createFastElevation bounds), `buildingWorker.js` (elev-grid bounds), `fastElevation.js` (imports the factor). `latLonToMercator` + slippy `latLonToTile` 1/cos(lat) untouched. X-negation downstream, unaffected. `bboxToTile`/`worldToTile` are dead/uncalled — left.
- **Car scaled by provenance (eye-tuned):** `carPhysics.js` imports the factor; chassis box XZ (0.70/1.55), track/wheelbase (±0.68/±1.2), `WHEEL_RADIUS` (0.3) ×factor as one rigid unit; chassis height + connection-Y + suspension untouched. Real-metre-authored constants (BCN_DIMS, road `lanes×3.5`, terrainBaker margins, `DEFAULT_SIDEWALK_WIDTH=1.2`) left — they self-correct. True car real-size + drive feel deferred to the **FEEL GATE**.
- **Two islands purged:** `RampResolver.cumulativeGroundDist` now measures in honest world coords (no `cos(lat)`); `buildingRenderer MERCATOR_SCALE=cos(28.5°)` deleted (UV uses real-metre wall length).
- **Deleted dead `tunnelTerrainCarver.js`** + its tileManager import.
- **Validator** inherited honesty (no code change): ramp-grade now reports real grades (stubs 43%/56% → **57.7%/74.4%**).
- Frontend build green; backend syntax green.

**CORRECTION / scope expansion (same session, post first re-bake):** the Stage-1 inventory ("six paths") audited only the named `mercatorToWorld`/`latLonToWorld` functions and **missed two whole classes** of conversion, caught by the static cross-path verifier (`tools/_stage1_verify.mjs`) when buildings/trees came out misplaced:
  1. **Frontend parse double-cos.** `readFloat32Pairs` (building footprints, greens, parking) and the baked-veg reader are called for BOTH absolute-Mercator data (subtract origin) and world-stored data. World-stored data is already cos'd at bake, so the blanket parse `×cos` double-corrected it. Fix: gate the parse `×cos` on origin-subtraction (`ox/oy` present) — cos belongs exactly where origin-subtraction happens.
  2. **Bake-side inline conversions.** ~10 sites bypassed `mercatorToWorld`: forward feature-storage (`buildRegion` bus stops, parking, urban features, point features→trees/lamps/signals/shops via `pointToTile`) stored *stretched* world; and inverse `world+origin` tile-assignment round-trips (`buildingNormalize`/`greenNormalize`/`waterNormalize`/`pbfAreaFeatures` centroid→tile, marina water-sink test) computed the *wrong tile* once world is real-metre. Fix: route every forward site through `mercatorToWorld` and every inverse through a new `worldToMercator` (÷cos) added to `backend/projection.js`. **Principle: ALL Mercator↔world conversions go through the projection functions; no inline subtraction.** Required a second full re-bake.
- **Also (unrelated, user request): `ENABLE_CAR: false`** (fly / free-camera mode).

---

## 2026-06-05 — Tunnel fix Phase 2 Option A: retaining-wall containment

Confirmed root cause (portal diagnostic + Phase-2 measurement): the physics terrain cut is far wider than the deck (measured max lateral gap 31–87 m), leaving undecked physics strips beside drivable deck edges that the car drops into. Fix = physics walls at drivable deck edges so the over-cut width is irrelevant (NOT widen-deck — gaps are 30–90 m; NOT narrow the cut — reopens the Phase-1 in-mouth raycast fix). **Runtime-only; no re-bake.**

- **Doc correction:** changelog (2026-05-30) + `gotchas.md` G-39 claimed approach-road physics was "handled by existing wall colliders" — FALSE. `buildRetainingWalls` is visual-only and `createTunnelWallColliders` runs only for layer<0 tunnelRoads; L0 `wallApproachRoads` had a deck and no wall physics. Corrected both.
- **Flag:** `config.js ENABLE_RETAINING_WALLS: false → true` (gates both visual walls and the new approach colliders).
- **New `createApproachWallColliders` (`tileManager.js`):** thin vertical CANNON.Box walls along both deck edges (road/2) of each L0 `wallApproachRoad` descent segment, spanning road floor → surface (Y≈0.05), X-negated. Wired into Phase-1 build, entry storage, distance-management, removal, count. Three guarded failure modes: (1) **overlap-skip across BOTH road sets** (approach + tunnel-ramp corridors) so coincident walls don't double up → solver NaN; (2) **open at mouth** — side walls only, gated by elevation, no face cap; (3) **finite guard** on every addShape (skip+warn).
- **Lip extension (`tunnelRenderer.js` + collider):** wall descent threshold lowered −0.2 → −0.05 so walls reach the surface lip with no top step. `RETAINING_MIN_WALL_H = 0.5` keeps the shallow lip wall a robust box.
- **Validator (`tunnel-inspect --validate`):** added residual-unwalled-≤3m-cell report (static guide; walls are runtime so it can only estimate via nearest-deck-gets-a-wall). Residuals are non-drivable descents (service/footway/steps — not DRIVABLE so not wallApproachRoads), flat roads grazing a tunnel-mouth cut, and a bridge misattribution — all follow-ups, not the primary drivable-approach fall (now walled).

Acceptance (a) static guide done; (b)/(c)/(d) require a drive — handed to user.

## 2026-06-05 — Tunnel fix Phase 1: bake-data correctness + physics finite guards

Per `docs/context/tunnel-fix-playbook.md` Phase 1 (bake-data correctness only; no Phase-2 geometry).

**Baseline correction (important):** the Phase-0 report assumed "terrain carries DEM." It does not — `cleanRoadPipeline:true` forces `phase1Pure2D:true` (`buildRegion.js:383`), which skips DEM loading (`:933`). The on-disk bake is **flat-world**: terrain grid ≈ 0 (only the −2.5 m water-sink), all surface roads at Y=0, tunnels at exact layer multiples (−6/−12/…). Re-baking reproduces this flat baseline (no DEM shift).

**TASK 0 — physics finite guards (C4):** `assertFiniteShape()` helper in `tileManager.js`; guards on every `addShape` (deck box, both tunnel walls, ramp trimesh). Non-finite x/y/z/extent → `console.warn` (road id + seg + field) and skip the shape instead of poisoning the cannon-es solver. Behaviourally inert except in the NaN case.

**TASK A — Case C ramp surface-anchoring (`RampResolver.js`):** Case B already anchored to the connected surface road's real `baseHeight` (left unchanged). Case C (short tunnel, both ends connect to a different layer) was previously left flat at depth (abrupt walls). Now length-aware: builds a valley (surface-anchored both ends → layer-space interior depth, gentle ≤12% ramps); if too short to descend+ascend at ≤15%, connects the two ends with a monotonic linear profile (flat when ends match = covered road; short ramp when they differ — endpoints always match, no vertical crack). Interior depth of normal tunnels untouched. Result on the 4 tiles' region scan: 250 Case-B, 47 Case-C valley, 107 Case-C flattened/linear.

**TASK B — physics terrain consumes corridors (C5/C4b, `terrainBaker.js`):** `bakePhysicsTerrain` previously ignored `approachRoads` and `crossTileApproaches` (cut inward-only for ramp-fixed portals) → "visual hole over solid physics" + sealed cross-tile seams. Now cuts the SAME corridor set as the visual baker (cross-tile + Source A bidirectional all-portals + Source B), with each cut region dilated by the physics half-cell-diagonal so the coarse 32×32 opening is a guaranteed SUPERSET of the 64×64 visual opening. Tradeoff: bounded over-cut (~1 physics-cell ring beyond the visual hole); physics-only, tunable later.

**TASK C — physics mouth margin (C3, `terrainBaker.js`):** physics mouth radius = visual + 1 m (`PHYS_MOUTH_MARGIN`) so wheel raycasts can't catch terrain just inside the visible mouth.

**Validator (`tools/tunnel-inspect.mjs --validate`):** commit-blocking asserts (1) physics⊇visual opening post-quantization, (2) physics mouth ≥ visual+1m, (3) cross-tile corridor cut in both bakes; diagnostics (4) poke-through, (5) ramp grade >15%, (6) wall-top vs terrain. Verified to FAIL on pre-rebake tiles and PASS after. Re-baked the 4 diagnostic tiles (33171_24473, 33166_24472, 33163_24481, 33163_24482); asserts 1–3 PASS; diagnostics surface the expected steep Case-B links (Glòries-area 43%, link 55.9%) — deferred to Phase 2.

Not done (Phase 2): trench depth tracking layer (still hard-coded −6 in `buildPortalApproaches`/`tunnelRenderer.js`), wall-top vs ceiling height, steep Case-B link grades. `tunnelTerrainCarver.js` left as dead code (delete/keep decided separately).

---

## 2026-05-30 — Tunnel terrain cut: bake-side portal corridor strips (Option X)

**Root cause investigation:** All tunnel road points in `payload.roads` at bake time are in **Mercator coordinates** (~237,000), not world coords (~1,600). The terrain grid uses world coords. Original circular portal holes (`tunnelMouths`) were placed at Mercator positions, comparing against world-coord terrain vertices → holes NEVER fired. Terrain above tunnels was never actually cut by the baker (only by old `carveTunnelTerrain` which we disabled).

**Coordinate fix:** `terrainBaker.js` now converts all tunnel road points via `mercatorToWorld(pts[i][0], pts[i][2])` before any position comparisons. Same fix applied to circular tunnel mouth holes. Road elevation data correctly read from `road.elevation[]` array (not `pts[i][1]` which is bridge yUp height).

**Portal corridor algorithm:** For each true portal endpoint (count=1 in within-tile junction map), generate bidirectional corridor spanning ±TRENCH_LEN (80m). Outward: approach zone (may be in adjacent tile for boundary portals). Inward: tunnel entry zone (always within this tile). `inApproachCorridor` uses perpendicular distance-to-segment test. `BCN_DIMS.APPROACH_RAMP_CUT_MARGIN = 2.5m` defines corridor halfwidth beyond road edge.

**Result:** Average 271 terrain triangles removed per tunnel tile. Verified across 5 tunnel tiles: 36–470 triangles cut per tile. Re-bake: 399s. Frontend dead-code comment added to terrainRenderer.js. See G-42, G-43.

---

## 2026-05-30 — Tunnel bug fixes: whitelist classification + portal hole radius

**Fix 1 — DRIVABLE_TUNNEL_TYPES whitelist (tileManager.js):** Replaced `PEDESTRIAN_TYPES` blacklist with `DRIVABLE_TUNNEL_TYPES` whitelist for tunnel classification. Root cause: Moll d'Espanya marina/mall passages are `highway=service tunnel=yes layer=-1` — not in PEDESTRIAN_TYPES, so they got full tunnel treatment (enclosure + terrain holes). 5 service roads × 2 endpoints = 10 terrain holes scattered across the Port Vell area. With whitelist approach, service/track/cycleway/path/etc. tunnels all go to pedestrianPortalRoads → portal frame only, no terrain holes. Approach roads also filtered to DRIVABLE_TUNNEL_TYPES (non-drivable approaches no longer get retaining walls either). See G-40.

**Fix 2 — Terrain hole radius (terrainRenderer.js):** Removed `MOUTH_RADIUS = 1` constant. New formula: `hw + PORTAL_WING + HOLE_OVERLAP = (road.width/2 + 1) + 3 + 0.5`. Hole now matches portal frame total half-width plus 0.5m overlap, preventing the portal frame from overhanging the terrain edge and creating seam gaps. Constants commented to link with tunnelRenderer.js. See G-41.

---

## 2026-05-30 — Tunnel system overhaul (Option B: retaining walls)

**Architecture:** Replaced terrain-carving-for-all with a three-way classification: (1) drivable tunnels with layer<0 get full interior enclosure (unchanged), (2) non-pedestrian approach roads split into `carveApproachRoads` (motorway/trunk >60m horizontal) which get terrain carving, and `wallApproachRoads` (everything else, including all urban approaches) which get vertical retaining walls, (3) pedestrian/footway tunnels get portal-frame-only, no interior.

**Task 1 — Retaining walls:** `buildRetainingWalls(wallApproachRoads)` in tunnelRenderer.js generates vertical concrete wall quads on each side of descent segments (eA<-0.1m). Material: light grey concrete (0x8a8a85, MeshLambertMaterial). Physics pit no longer applied to wall approaches. `isHillsideApproach()` filter: must be motorway/trunk/link AND ≥60m horizontal span from surface to deepest point.

> **CORRECTION (2026-06-05):** the original wording here — "wall colliders already handle physics" for wall approaches — was FALSE. `buildRetainingWalls` is VISUAL-ONLY, and `createTunnelWallColliders` runs only for `tunnelRoads` (layer<0). The L0 `wallApproachRoads` had a deck but no wall physics, so the car dropped off the deck edge into the over-cut terrain strip. Fixed in Phase-2 Option A by adding `createApproachWallColliders` (own CANNON boxes along approach deck edges) and gating both the visual walls and the colliders behind `ENABLE_RETAINING_WALLS`.

**Task 2 — Pedestrian portals:** `buildPedestrianPortals(pedestrianPortalRoads)` generates small rectangular portal frames (3m wide, 2.8m tall, 0.4m frame thickness) at each endpoint of pedestrian/footway/path/steps tunnel ways. Dark charcoal (0x3a3a3a). Includes dark inner face quad to suggest depth. No interior, no terrain carving, no terrain holes.

**Task 3 — Canopy disabled:** `buildApproachCanopy` now returns empty group. Delhi-era arched shed over tunnel ramps removed. All calls preserved for interface compatibility.

**Task 4 — Barcelona tunnel interior:** Rewrote buildTunnelMeshes completely. Removed: chevron curbs, guardrails, discrete ceiling spotlights. Added: cream ceramic tile walls (0xEFE8DB, MeshLambertMaterial), LED ceiling strips at wall-ceiling junction (0xFFF8E8, MeshBasicMaterial — self-lit), yellow safety stripes at road edge (0xF5D000). Ceiling height: relative (road_elev + TUNNEL_CLEARANCE=4.5m), not fixed at Y=-1.5m. Sign: per-road-name "TÚNEL DE [NAME]" on dark blue background, Canvas2D texture cached per name. All materials switched to MeshLambertMaterial (removed MeshStandardMaterial from tunnel).

**Config flags added:** ENABLE_RETAINING_WALLS, ENABLE_PEDESTRIAN_PORTALS.

---

## 2026-05-30 — Phases 4B-2, 4C-A, 4C-B, 4D — Barcelona road system final sweep

**4B-2 — Chamfer corner sidewalk + diagonal curbs:**
`buildChamferSidewalks` + `buildChamferCurbs` exported from roadRenderer. For each adjacent approach pair of a chamfer-eligible junction: (a) triangular panot sidewalk fill at outer corner using world-space UV, fan-triangulated; (b) L-profile diagonal granite curb (top face + outer vertical face) matching Phase 3 curb geometry. Both tracked in tileManager. LOD 80m (sw) / 200m (curb) × altMult.

**4C-A — ZONA 30 stencils + tactile paving:**
`buildZona30Stencils`: InstancedMesh with Canvas2D "30" texture, one per 100m on residential/tertiary roads with maxspeed=30 (1,396 qualified roads). `buildTactilePaving`: beige dotted strip at each crosswalk-sidewalk interface, Canvas2D dot pattern, 0.6m deep × full sidewalk width. Both tracked, LOD 50m / 60m × altMult.

**4C-B — Blue Zona Blava stripes + yellow parking fix:**
OUTCOME A confirmed (Barcelona uses parking:both:restriction, parking:left/right:restriction, parking:condition:*, parking:*:fee). Added 12 new tag keys to pbfHighways.js KEEP_TAGS. buildRegion.js normalizes all schemas into parkingLeft/Right (restriction values) and parkingPaidLeft/Right (paid/free). Re-bake completed (439s). Result: 54 roads with restriction data, 40 roads with paid parking. `buildBlueZoneStripes` implemented (paid → blue stripe). `buildNoParkingStripes` now produces output (23+31 restriction roads). LOD 80m × altMult for both.

**4D — Loose ends:**
(1) Direction board signs: removed Hindi transliteration and "Pin Code 110001" (Delhi postal code). Now shows Catalan road name in white on green background, consistent with real Spanish road signs. (2) Tunnel sign: replaced "सुरंग / TUNNEL" with "TÚNEL" (Barcelona-correct). (3) Ghost-wall filter (4D.2): `buildBarrierMeshes` now accepts `buildings` parameter; barrier=wall polylines with midpoint within 5m of any building centroid are skipped (prevents double-rendered OSM boundary walls). `ENABLE_GHOST_WALL_FILTER: true`. (4) Terrain restored (`ENABLE_TERRAIN: true`). Spawn reset to Eixample core (Carrer de la Diputació).

---

## 2026-05-30 — Phase 4B-1: chamfered intersection asphalt fill

**Bake enrichment:** `buildRegion.js` junction payload now includes `radius` (full max road width in metres) and `approaches: [{angle, width}]` sorted ascending by angle. `convertToBinary.js` and `tileParserWorker.js` updated with conditional read/write. Re-bake completed (437.7s). Verified: 100% of junctions now carry radius + approaches fields.

**Chamfer renderer (`roadRenderer.js`):** New exports `buildChamferFills(junctions, options)` and helper `isChamferEligibleJunction`. Eligibility: `type=crossing`, ≥3 approaches, `radius ≥ 8m`, adjacent approaches within 20° of orthogonal. Geometry: octagonal (4-way) or hexagonal (T-junction) polygon computed from approach angles + widths; fan-triangulated from vertex 0 (convex polygon, always valid). Y height = `(baseY + ROAD_OFFSET) * scale + ROAD_VISUAL_ABOVE_TERRAIN + ROAD_ZFIGHT_OFFSET + 0.01` (matches road surface). Material: `MeshLambertMaterial`, ASPHALT_BASE color.

**Wiring:** `tileManager.js` calls `buildChamferFills(junctions, options)` after `buildGoreMeshes`. Chamfer mesh pushed into `roadMeshes` (inherits road mesh lifecycle/cleanup). `CONFIG.ENABLE_CHAMFER_FILLS: true` added.

**Stats:** 263 of 3284 total junctions eligible (8%). Densest tile 33163/24476: 17 eligible × 8 verts = 136 verts total — negligible vertex budget impact.

**Decisions:** Option 2 (bake-side enrichment) over Option 1 (spatial matching) — single source of truth. `radius = max(approach.width)` full road width to match frontend `getJunctionPoints()` convention. Fan triangulation over ShapeUtils (avoids winding order dependency for convex polygon). 20° orthogonality tolerance covers slightly skewed Eixample-like grids.

**Phase 4B-2 (deferred):** Triangular panot sidewalk corner fills, diagonal granite curb segments along chamfer edges.

---

## 2026-05-30 — Phase 4A patch: tram rail height + curb merge fix

**Tram rail height (Issue 1):** `createTramMeshes` was calling `getRailwayPointHeights` which returns `(baseY + RAILWAY_OFFSET) * scale = baseY + 0.07`. This placed rails 25mm below the road surface (`baseY + 0.075` vs road `baseY + 0.10`), occluded by the asphalt. Added `getTramSurfaceHeights(pts, getElevationAt)` in `railwayRenderer.js` using the road-surface formula: `(baseY + _ROAD_OFFSET) * scale + _ROAD_VISUAL`. `buildTramRailGeometry` adds `TRAM_RAIL_Y_ABOVE = 0.005` on top → final `baseY + 0.105` (5mm proud of asphalt). See G-32.

**Curb mergeGeometries warning (Issue 2):** `buildCurbs` was merging `gTop` (from `buildFlatRibbonGeometry`, which has `halfWidth`) with `gFace` (custom vertical face geometry, which lacked `halfWidth`). Added dummy `halfWidth = CURB_W / 2` attribute to `gFace` before merge. Warning was at `roadRenderer.js:1689` (end of buildCurbs), not in `buildNoParkingStripes` as initially suspected.

---

## 2026-05-29 — Phase 4A: tram tracks + yellow no-parking stripes

**Feature 1 — Tram tracks (`railwayRenderer.js`):**
- New export `createTramMeshes(railways, options)` — filters to `railway=tram` and `light_rail` only; skips tunnels/underground segments.
- Two parallel rail ribbons per segment at `±TRAM_GAUGE/2` (±0.7175m) from centerline, each `TRAM_RAIL_WIDTH` (0.06m) wide.
- `getTramMaterial()` — `MeshLambertMaterial`, `BCN_COLORS.TRAM_RAIL_STEEL` (0x8a8a8a).
- `buildTramRailGeometry()` — custom buffer geometry (position, normal, uv) with Y = road surface + 0.005m.
- Imported `BCN_COLORS` and `BCN_DIMS` into `railwayRenderer.js`.
- `tileManager.js` — `createTramMeshes` called after `createRailwayMeshes`. Entry slot `tramRailMesh`. LOD: 200m × altMult. Fog-cull + cleanup wired.
- Heavy rail (`railway=rail`, `subway`) unchanged — still uses existing ballasted ribbon path.
- `CONFIG.ENABLE_TRAM_TRACKS: true` added to config.js.

**Feature 2 — Yellow no-parking stripes (`roadRenderer.js`):**
- OSM fields added: `parking:lane:left`, `parking:lane:right`, `parking:lane:both` → KEEP_TAGS in `pbfHighways.js`.
- `buildRegion.js` — `phase2ById` and road payload emit `parkingLeft`/`parkingRight` (with `:both` as fallback for both sides).
- `convertToBinary.js` — conditional writes for `parkingLeft`/`parkingRight`.
- `tileParserWorker.js` — conditional reads for same.
- New `buildNoParkingStripes(roads, options)` in roadRenderer: continuous ribbon for `no_stopping`, dashed (2m/2m) for `no_parking`. Y = road surface + 0.04m. `getNoParkingMaterial()` — `MeshLambertMaterial`, `BCN_COLORS.PAINT_YELLOW`. Stripe width 0.10m, positioned at `half - stripe_half_width` (just inside road edge).
- Wired into `renderTileRoads` return and `createRoadMeshes`.
- `tileManager.js` — entry slot `noParkingMesh`, LOD: 80m × altMult. Fog-cull + cleanup wired.
- `CONFIG.ENABLE_NO_PARKING_STRIPES: true` added.

**Re-bake result:** Full Barcelona re-bake completed (483.4s). No parking restriction stripes appear in current tile coverage — the 355 OSM ways with `no_parking`/`no_stopping` values are located in neighborhoods (Gràcia, Nou Barris, Sant Andreu) outside the current tile extent. The pipeline is correctly wired and will render stripes when coverage expands. Tram data confirmed in 8 tiles (37 segments, Trambesòs route).

**Vertex budget (densest tile 33166/24479, 583 roads):** Road ~46k + sidewalk+curb ~37k + tram ~200 = ~84k total. Well under 250k soft / 300k hard budget.

---

## 2026-05-29 — Phase 3 polish: material heap fix + wall toning

**Problem 2 — Heap:** `getPanotMaterial()` in `roadRenderer.js`: `MeshStandardMaterial` → `MeshLambertMaterial`. Removed `roughness: 0.85` and `metalness: 0.0` (Lambert ignores these). Sidewalk tile is a flat-lit diffuse surface; Lambert renders identically at play distance. Saves ~30–60MB of compiled shader program memory.

**Problem 3a/b/c — Wall toning:** `barrierRenderer.js`: `BARRIER_CONFIGS.wall.minHeight` 3.5→1.0m (Barcelona property walls are 1–2m, not 3.5m Indian compound walls). `compound_wall.minHeight` 3.5→1.5m. Removed `'wall'` from `PRECAST_WALL_TYPES` — Barcelona walls no longer get Indian pillar+panel+wire geometry. Added `'wall'` to `TEXTURED_WALL_TYPES` — UV-mapped stone texture instead.

**3d/3e investigation — no re-bake needed:** Default tile height for walls is 2.0m (`BARRIER_DEFAULT_HEIGHTS.wall`). After minHeight reduction: `Math.max(2.0, 1.0) = 2.0m` — default unchanged. Explicit OSM heights respected for all values ≥ 1m. `retaining_wall` has no `minHeight` in BARRIER_CONFIGS — always uses full OSM height (or 2.5m default). Sound barriers (explicit `height=4m+`) floor at 1.0m and pass through unchanged. `retaining=yes` property tag not in PBF but not needed: `barrier=retaining_wall` already routes to a separate config with no minHeight floor.

**3f — Ghost-wall filtering deferred.** Documented in barcelona-road-system.md Section 7.

---

## 2026-05-29 — Phase 3 fixes: panot texture, sidewalk inference + scoping

**Fix 1 — Panot texture invisible (color × texture contrast collapse):** `getPanotMaterial()` had `color: BCN_COLORS.SIDEWALK_PANOT`. In `MeshStandardMaterial`, `.color` multiplies texture RGB per channel. Setting both material color and texture to the same beige value (~0.78) squared the value (~0.61) and collapsed the petal/background contrast to ~7 RGB units. Fix: `color: 0xffffff` — texture supplies all color, no tinting.

**Fix 2 — Sidewalk inference (OSM coverage was 1.4% of all roads, 6.3% of drivable roads):** Replaced strict `road.sidewalk in ['both','left','right']` filter with `inferSidewalkSide()` — 3-priority helper: (1) OSM explicit tag wins, (2) `sidewalk=no` respected, (3) road-type fallback: infer `'both'` for all drivable types not in the skip set. Skip set: `motorway`, `trunk`, `motorway_link`, `trunk_link`, `service`, `track`, `path`, `cycleway`, `footway`, `steps`, `pedestrian`, `living_street`.

**Fix 3 — Building proximity gate:** Inference was too broad — sidewalks appeared on rural roads, through parks, along open coastline. Gate: skip any road with no building centroid within 30m of any road point. 30m calibrated from road half-width + curb + sidewalk + building half-depth for Eixample (typical: ~23m). Threshold eliminates open-terrain roads while preserving urban streets. `buildings` threaded into `options` via `tileManager.js:1052`; no race condition — buildings decoded before `createRoadMeshes` is called.

**Fix 4 — Junction clip radius:** Previous radius `INTERSECTION_RADIUS=3m` was applied to the already-offset sidewalk polyline (offset 6–17m from center). Since `dist(offset_polyline, junction_center) ≥ offsetFromCenter`, clip at 3m never reached the sidewalk — all corners overlapped. Fix: `swJunctionRadius = base_radius + offsetFromCenter` per-road; `curbJunctionRadius = base_radius + curbOffset`. Corners now trim cleanly.

**Vertex budget impact:** Max inferred sidewalk roads per tile: 153 (tile 33159/24480). Estimated sidewalk+curb vertex contribution: 9,792 — well under 250k soft / 300k hard budget.

---

## 2026-05-29 — Phase 3: Sidewalks (panot), curbs (granite), bike lanes + pictograms

New file: `frontend/src/map/generate-road-atlas.js` — procedural Canvas2D textures for panot Flor de Barcelona (256×256, seamless) and bike pictogram (128×128 white icon).

`roadRenderer.js`: 4 new material functions (getPanotMaterial, getCurbMaterial, getBikeLaneMaterial, getBikePictogramMaterial) + setRendererAnisotropy upgraded to apply to panot texture. Old sidewalk path in buildSidewalkAndEdgeMeshes disabled (superseded). New functions: buildSidewalks (world-space UV, OSM-strict), buildCurbs (L-profile: top face + outer vertical face), buildBikeLanes (green ribbon at road edge), buildBikePictograms (InstancedMesh, 30m spacing).

`tileManager.js`: 4 new phase 3 mesh types (bcnSidewalkMesh/bcnCurbMesh/bcnBikeLaneMesh/bcnBikePictoMesh) with altitude-aware LOD thresholds (80/200/120/50m × altMult). Vertex budget: 150k→250k soft, 300k hard.

`config.js`: ENABLE_SIDEWALKS true, ENABLE_CURBS true, ENABLE_BIKE_LANES true.

No re-bake. OSM sidewalk/cycleway data from Phase 2 bake drives rendering.

---

## 2026-05-29 — Phase 2: OSM road data + one-way arrows (re-bake required)

**Gate 1 fix** (`pbfHighways.js:17`): added `oneway`, `sidewalk`, `cycleway`, `maxspeed` to KEEP_TAGS (4 tags were silently dropped at PBF parse time).

**Gate 2 fix** (`buildRegion.js:1025-1052`): emit 6 new fields in road payload — `oneway` (tri-state: forward/backward/no/null), `lanes` (int [1,12] or null), `sidewalk`, `cycleway`, `surface`, `maxspeed`. Gates 3 (convertToBinary) and 4 (tileParserWorker) pre-built, no changes needed.

**Renderer** (`roadRenderer.js:982`): `road.lanes ?? LANES_BY_TYPE[type] ?? 2` — use OSM lane count when available.

**New feature** (`roadRenderer.js`): `buildOnewayArrows()` — white triangle arrows on road surface every 30m for `road.oneway === 'forward'|'backward'`. Skips motorway/trunk/bridge/tunnel. Tagged `noMerge+onewayArrows` for 80m LOD. `ENABLE_ONEWAY_ARROWS: true` in config.

**tileManager.js**: `entry.onewayArrowMesh` tracked alongside `crosswalkMesh` — init, find, fog-cull, LOD-cull at 80m, cleanup.

**Docs**: bake-pipeline.md (Phase 2 OSM fields section), map-system.md (road tile format updated), gotchas.md G-21 (5-gate pipeline), barcelona-road-system.md §6 + §7.

**Re-bake pending.** Existing tiles have all 6 fields as null until re-bake.

---

## 2026-05-29 — LOD altitude multiplier tuning

`tileManager.js:1850`: `Math.max(1, Math.min(4, 1 + (y-5)/50))` → `Math.max(1.25, Math.min(5, 1.25 + (y-5)/35))`

Ground (Y≤5m): 1.0× → 1.25×. Y=100m: 2.9× → ~3.96×. Cap: 4× → 5×.

---

## 2026-05-29 — Phase 1: Barcelona road paint + crosswalks (Norma 8.2-IC)

New file: `frontend/src/map/barcelona-constants.js` — BCN_COLORS and BCN_DIMS, single source of truth for all road visual constants.

Changes to `frontend/src/map/roadRenderer.js`:
- Import BCN_COLORS, BCN_DIMS from barcelona-constants.js
- File docstring + constants comment: "IRC 35" → "Norma 8.2-IC"
- `CENTER_LINE_WIDTH`, `MARKING_EDGE_LINE_WIDTH`, `LANE_DIVIDER_WIDTH`: 0.15m/0.12m → `BCN_DIMS.LINE_WIDTH_LONGITUDINAL` (0.10m)
- Active vertex-color path (lines ~1025-1026): `0xe8e4dc` → `BCN_COLORS.PAINT_WHITE` (0xf5f5f5)
- Legacy material singletons (~778, ~787): same update for consistency
- New `buildCrosswalks()` function: zebra crosswalks at all eligible junctions, setback = max(junction.radius, INTERSECTION_RADIUS) + 1.5m, LOD via userData.noMerge+type tags
- Wired into `renderTileRoads` return and `createRoadMeshes`

Changes to `frontend/src/config.js`: `ENABLE_CROSSWALKS: true`

Changes to `frontend/src/map/tileManager.js`:
- `entry.crosswalkMesh: null` in entry init
- Track crosswalk mesh reference after road mesh population
- Hide at fog-cull (>FOG_FULL_DIST) and at detailDist=80m LOD threshold
- Remove from scene on tile unload

No re-bake. All frontend-only.

---

## 2026-05-29 — Camera-altitude-aware building LOD thresholds

`tileManager.js` lines 1843–1844 (multiplier) and 1974–1977 (application):
- Added `altMult = clamp(1, 4, 1 + (cameraY - 5) / 50)` computed once before the per-tile loop
- All four building thresholds (`bldgMaxDist`, `bldgDetailDist`, `lodStart`, `lodEnd`) scaled by `altMult`
- At ground (cameraY ≤ 5m): multiplier = 1, existing behaviour preserved exactly
- At 100m altitude: multiplier ≈ 2.9×, detail visible to ~522m instead of 180m
- Capped at 4× to prevent runaway at extreme altitude
- `camera?.position.y ?? 0` guard handles null camera

No re-bake. No change to Phase 2 dispatch (there is no distance gate on worker dispatch — it runs for all tiles in the 3×3 grid unconditionally).

See gotchas.md G-19 for the dead-zone that results from partial threshold scaling. See rendering.md for fog interaction note.

---

## 2026-05-29 — Three LOD/streaming fixes

**Fix 1 — Early-exit tautology (tileManager.js lines 1686–1715):**
`currentTx = tx` was assigned before `if (tx === currentTx)` — always true. Effective check was `if (allLoaded) return`, freezing LOD updates and streaming every frame once tiles loaded. Fixed: cache `prevTx/prevTy` before mutation, compare against cached values. See gotchas.md G-18.

**Fix 2 — Fog culling ignores CONFIG.ENABLE_FOG (tileManager.js line 1854):**
`FOG_FULL_DIST = 280` was hardcoded. With fog disabled for development, vegetation was still force-hidden at 280m, making tree billboards and distant meshes invisible. Fixed: `CONFIG.ENABLE_FOG ? 280 : Infinity`.

**Fix 3 — LOD/detail mutual exclusion (tileManager.js line 1983–1984):**
LOD simplified box (`lodBuildingMesh`) could show simultaneously with detail buildings (`buildingMeshes`) in the 110–180m overlap band. The LOD update loop is now the single source of truth: `lodBuildingMesh.visible = !detailLoaded && nearEdgeDist > lodStart && nearEdgeDist <= lodEnd`. Detail loaded → LOD box always hidden.

No re-bake required.

---

## 2026-05-29 — Phase 3: NaN source fix + systematic safeSceneAdd

Root cause confirmed by diagnostic probes: `greenMeshP1` was firing `[NaN SOURCE]` at position index 1 (Y coordinate). Vegetation, grass, streetlights, and embankment all silent.

**STEP 1 — Root cause fix (`greensRenderer.js:80-81`):**
- `(getElevationAt ? getElevationAt(lat, lon) : 0) ?? 0` → `Number.isFinite(rawY) ? rawY : 0`
- `?? 0` passes NaN through (NaN is neither null nor undefined); `Number.isFinite` does not

**STEP 2 — Systematic replacement (tileManager.js):**
- All 30 bare `scene.add()` calls in `processTileData` replaced with `safeSceneAdd(scene, m)`
- Covers: terrainMesh, tunnelMeshGroup, canopyMeshGroup, goreMesh, debugPhysicsHelpers, greenMeshesP1, railwayMeshes, vegMeshBatch, grassMesh, embankmentMesh, propMesh, clusterMeshes, trafficLightMesh, shoulderMesh, all streetlight meshes, barrierMeshes, crashBarrierMesh, reflectorGroup, busStopMeshes, parkingMeshes, roadInfraMeshes, decalMeshes, urbanFeatureMeshes, vendorCartMeshes

**STEP 3 — Removed diagnostic probes (`_checkNaN` helper + 5 call sites)**

**STEP 4 — docs:** G-16 in gotchas.md updated with pattern note; changelog.md updated.

No re-bake required.

---

## 2026-05-29 — Four-fix batch: NaN geometry + water type field

**Issue 2 (cosmetic) — water type field missing from tileParserWorker:**
- `tileParserWorker.js:321`: added `type: item.type` to `readPolygonFeatures` return object
- Effect: water filter logs now show real type breakdown (`stream:X canal:Y`) instead of `undefined:N`; coastline filter now works independently of open-polyline filter

**Issue 1 — NaN BufferGeometry flooding console every frame:**
Root cause: NaN values in baked elevation grids (G-06) propagate through `fastElevation` → `renderLODBuildings` (no `isFinite` guard) → LOD box vertex positions → merged `lodBuildingMesh` → `scene.add()` without NaN check.

Three-layer fix applied:

- `buildingRenderer.js:2417-2418` (Option A): `Number.isFinite(rawBaseY) ? rawBaseY : 0` — guards elevation NaN at source; buildings on NaN-elevation cells placed at Y=0 instead of NaN
- `tileManager.js:1248,1258` (Option B): `scene.add(buildingMeshes[i])` and `scene.add(lodMesh)` → `safeSceneAdd(...)` — NaN meshes never enter scene graph
- `tileManager.js:meshHasNaN` (Option C): replaced 90+30 sampler with full array scan; added one-time `console.warn('[meshHasNaN] caught NaN...')` so we can verify if Option B is actually firing

- `docs/context/gotchas.md`: G-15 (readPolygonFeatures missing type), G-16 (NaN elevation chain), G-17 (meshHasNaN full scan invariant)

No re-bake required for any of these fixes.

---

## 2026-05-29 — Open-polyline water filter (stream/canal wedge fix)

- `frontend/src/config.js`: added `RENDER_OPEN_WATER_AS_POLYGONS: false`
- `frontend/src/map/waterRenderer.js`: `isOpenPolyline()` helper (gap ≥ 1m = open); open-polyline filter applied to `rawAreas` before rendering; per-tile log shows `open-polylines:N (stream:N canal:N)` breakdown; marina/dock path (`marinaWaterPolys`) unaffected
- `docs/context/gotchas.md`: G-14 — `bufferPolyline` self-intersections documented
- `docs/context/rendering.md`: open-polyline filter section added
- `docs/context/config-reference.md`: new flag entry
- `docs/context/roadmap.md`: "Fix bufferPolyline self-intersections" and "OSM coastline assembly" added as re-bake work items

Root cause: `waterNormalize.js:bufferPolyline()` uses per-vertex normal averaging; sharp centerline bends produce self-intersecting ribbon polygons; `THREE.ShapeGeometry` fills crossings as spurious triangle lobes. 21 streams + 9 canals affected across Barcelona coastal tiles. No re-bake.

---

## 2026-05-29 — B-renderer: skip coastline water polygons (tunnel water fix)

- `frontend/src/config.js`: added `RENDER_COASTLINE_AS_POLYGONS: false`
- `frontend/src/map/waterRenderer.js`: filter out `type=coastline` water features when flag is false; logs `[Water tileId] skipped N coastline polygon(s)` per tile
- `frontend/src/map/tileManager.js`: pass `tileKey: key` to `renderWater` opts for log context
- `docs/context/gotchas.md`: documented G-13 (closePath + open coastline = inland water triangle)
- `docs/context/rendering.md`: coastline handling section added
- `docs/context/config-reference.md`: new flag entry

Root cause confirmed by tile inspection: `natural=coastline` way `id=500581857` in tile `16_33167_24479` has a 620m open gap; `closePath()` closure fills a 25,000m² inland triangle covering the Ronda Litoral tunnel approach. No re-bake required.

---

## 2026-05-29 — Ocean plane + water rendering fixes

- `scene.js`: groundMesh shrunk back to 3000m (was 60000m), ocean blue color
- `main.js`: groundMesh Y pinned to normalized seaLevelY−1.0 in animate loop (was Y=0 = spawn elev above sea → showed through coastal terrain)
- `buildRegion.js`: bake-side auto water/marina elevation fix — grid points inside water/marina polygons baked to −2.5m so terrain naturally dips at water bodies; eliminates need for runtime hole-cutting per tile
- `waterRenderer.js`: marina water uses consistent global seaLevelY (no per-tile variation → no z-fighting); depthWrite=false on water material; pier polygons rendered as gray elevated slabs +0.35m
- `tileManager.js`: marina polygons passed to buildTerrainMesh waterPolys for smooth terrain transition
- `pbfWater.js`: added leisure=marina, waterway=dock|basin to water feature capture

DEM depth note: SRTM/Copernicus DEMs have no bathymetric data (sea = 0m or nodata). The −12m in the DEM range is below-sea-level excavated port land (not actual sea floor). The bake fix sets water grid points to −2.5m artificially to create the correct visual dip.

---

## 2026-05-29 — v7 tile format: 10 new OSM feature types extracted + serialized (bake only, no renderers)

New parser files:
- `backend/worldBuilder/pbfAreaFeatures.js` — beaches, pedestrian areas, marinas (single 2-pass scan)
- `backend/worldBuilder/pbfPointFeatures.js` — traffic signals, street lamps, trees, tourism POIs, metro stations, healthcare, shops (single 2-phase scan)

Modified files:
- `pbfHighways.js` — added 'junction' to KEEP_TAGS for isRoundabout detection
- `buildRegion.js` — isRoundabout in enrichment+cloneRoad+payload; all new parsers wired; per-tile v7 count logging
- `convertToBinary.js` — v7 (was v6); new binary sections for all 10 feature types + isRoundabout on roads
- `tileParserWorker.js` — readAreaFeatures, readPointList, readTrees, readShops; all v7 fields in result; isRoundabout on roads; backward compatible with v6 (absent = [])
- `backend/worldBuilder/config.js` — 10 bake kill-switch flags (all default true)
- `docs/context/map-system.md` — tile format updated to v7
- `docs/context/roadmap.md` — NEW: deferred features backlog
- `CLAUDE.md` — roadmap.md added to TOC

Binary encoding summary:
- Area polygons: Float32 pairs [wx, wz] (same as greens)
- Simple points: Float32 pair [wx, wz] per entry via pointOffset
- Trees: flat Float32 array via treePositions + per-entry metadata in header
- Shops: flat Float32 array via shopPositions + Uint8 categories packed as Uint32 + per-entry names

NOT changed: no frontend renderers, no physics, no scene-graph additions.

---

## 2026-05-29 — Barcelona source data verified; DEM path fix

- DEM: `N41E002_DEM.tif` (SRTM GL1, OpenTopography) moved to `data/regions/barcelona/` (flat layout, matching Delhi convention)
- `backend/worldBuilder/config.js` `demPaths` corrected — removed incorrect `dem/` subfolder (it never existed)
- `docs/context/bake-pipeline.md` DEM path reference corrected to match
- OSM PBF confirmed valid (251 MB binary protobuf, not HTML)
- DEM confirmed covers bbox (lon 2.083–2.269, lat 41.330–41.467); elevation range −12 to 515 m; NoData −32768
- Delhi tiles confirmed preserved at `backend/tiles/delhi/`
- Osmium not installed — full Catalonia PBF will be used unclipped (acceptable; bake pipeline already clips to bbox internally)
- Feature gap documented: beaches (`natural=beach`), marina, metro stations, individual trees, traffic signals, shops, tourism POIs, Montjuïc cable car — all ignored, available for future enrichment
- **Ready to bake**: `cd backend && node worldBuilder/buildRegion.js --area eixample`

---

## 2026-05-28 — Barcelona migration scaffold + spawn refactor

**Region migrated: Delhi → Barcelona.** No re-bake yet — Delhi tiles preserved as fallback.

Files changed:
- `frontend/src/spawnConfig.js` — NEW: single source of truth for spawn (41.3915°N, 2.1649°E)
- `frontend/src/projection.js` — ORIGIN updated (28.49/77.08 → 41.350/2.115); START_LAT/LON re-exported from spawnConfig
- `frontend/src/main.js` — imports START_LAT/LON from spawnConfig; uses getActiveSpawn() for spawn tile
- `frontend/src/scene.js` — imports START_LAT/LON from spawnConfig
- `frontend/src/workers/vegetationWorker.js` — ORIGIN_LAT/LON updated
- `frontend/src/workers/buildingWorker.js` — ORIGIN_LAT/LON + MERCATOR_SCALE updated (28.5°→41.4°)
- `frontend/src/map/mapLoader.js` — REGION default 'delhi'→'barcelona'
- `backend/projection.js` — ORIGIN_LAT/LON updated
- `backend/worldBuilder/config.js` — complete rewrite for Barcelona bbox + DEM paths
- `backend/worldBuilder/demLoader.js` — test point: India Gate → Sagrada Família
- `backend/worldBuilder/buildRegion.js` — DEM loading + terrain grid sampling + road DEM elevation
- `backend/worldBuilder/convertToBinary.js` — hardcoded 'delhi' → CLI arg (default 'barcelona')
- `docs/context/spawn-system.md` — NEW: spawn system documentation
- `docs/context/coordinate-systems.md` — updated origin values + 5-file sync warning
- `docs/context/bake-pipeline.md` — DEM sourcing steps + Barcelona-specific risks
- `CLAUDE.md` — updated description + quick-start commands + spawn-system TOC entry

**Needs external data before bake:**
1. `data/regions/barcelona/region.osm.pbf` (Geofabrik Catalonia)
2. `data/regions/barcelona/dem/N41E002_DEM.tif` (Copernicus GLO-30)

**IMPORTANT — do not delete** `backend/tiles/delhi/` until Barcelona bake verified.

---

## 2026-05-28 — Context system created

Initial creation of the full `/docs/context/` persistent context system from deep technical analysis of the codebase. Documents created:
- `CLAUDE.md` — root index + golden rules + quick-start
- `docs/context/architecture.md` — full stack, scene graph, game loop, ASCII diagram
- `docs/context/coordinate-systems.md` — all coordinate spaces, X-mirror, elevation
- `docs/context/map-system.md` — tile format, loading flow, LOD, collision stack
- `docs/context/vehicle-system.md` — physics model, transmission, input, camera
- `docs/context/rendering.md` — materials, post-processing, shadows, geometry merging
- `docs/context/bake-pipeline.md` — OSM→binary pipeline, re-bake guide
- `docs/context/config-reference.md` — all CONFIG flags, live/dead status
- `docs/context/gotchas.md` — 12 documented invariants and landmines
- `docs/context/decisions.md` — 10 ADR-style decision records
- `docs/context/glossary.md` — confusing terms and naming pitfalls
- `docs/context/changelog.md` — this file

State at time of analysis:
- `CONFIG.ENABLE_CAR: true` (car mode active)
- `CONFIG.ENABLE_DAY_NIGHT: false`
- Binary tile format v6 in use; NaN water fix pending re-bake
- Worker pool: 2–4 geometry workers; 1 tile parser worker
- Physics: NaiveBroadphase (SAP blocked by Trimesh AABB issue)

## 2026-06-10 — Simple-tunnel deck now renders (fix: carved pit with no ramp)
- Root cause: simple-tunnel mode carved the ramp opening but drew no road in it — `buildTunnelMeshes` (the only descending-deck renderer) is gated behind `ENABLE_TUNNEL_VISUALS:false`, and `roadRenderer` skips `road.tunnel`. Result: a disconnected pit ("weird position, no ramp going in").
- Verified baked data is correct: tunnel decks descend to ~−6 m, portals ramp 0→−6 m (depth profiles measured per-tile). The depth-window carve (−0.3…−5 m) was opening the right band.
- Added `buildTunnelFloor()` (tunnelRenderer.js): lean deck-only mesh (no walls/ceiling/LED/portal/sign), wired into the simple-tunnel `else` branch in tileManager.js. Renders the descending deck wherever it's below local terrain → road is continuous down the opening and under the terrain roof.
- Frontend-only; no re-bake. See G-50.

## 2026-06-10 — Terrain & tunnel rework: plan saved, Phase 0 surveys done
- Added `docs/context/terrain-tunnel-rework-plan.md` (working tracker, 5 phases, drive-test-gated) + TOC entry in CLAUDE.md.
- Phase 0 surveys complete (read-only): smoothing chokepoint = the global raster pass in `demLoader.js` (`smoothRaster` :93; all sampling funnels through `sampleElevation` :174 — Phase 1 extends this, not a new subsystem); full emergent-tunnel inventory (bake carve constants, remaining absolute-Y constants, fall-through mechanism) recorded in the plan's Phase 0 Findings.
- `parkingRenderer.js` `[0]/[1]` residual: already fixed (G-46), full-file grep clean — no change.
- G-49 collider fix code-verified (`createTerrainTrimesh` prefers 64-grid visual bakedTerrain, exact rendered transform). Awaiting user Montjuïc drive test = Phase 0 gate.
- Spawn moved to Montjuïc approach (41.3700, 2.1600, tile 16_33161_24481) for the Phase 0 slope drive-test gate; previous Gran Via tunnel spawn (41.40606, 2.12031) noted in spawnConfig.js for Phase 3 restore. CLAUDE.md spawn line was stale (said Sagrada Família) — corrected.

## 2026-06-11 — Phase 0 gate fixes: off-road fall-through + spawn-drop tunneling
- Headless runtime diagnosis (Playwright probes of _debugWorld/_debugVehicle): terrain trimeshes are correct (128-grid visual-baked path, 16384 verts/tile, AABBs tile correctly, road-vs-terrain co-framed to 0.23 m) but collided with NOTHING — chassis mask was WORLD only (D-16 revert under-restored it; G-49 backstop needs WORLD|TERRAIN), and cannon-es rays can't hit Trimesh (reconfirmed: interior down-rays MISS).
- Fix 1: carPhysics.js chassis collisionFilterMask → WORLD | TERRAIN. D-16 status annotated (revert correction).
- Fix 2: main.js spawn Y — was hardcoded y:2 in the spawn-lat/lon frame while the snapped road sat ~18 m downhill (Montjuïc) → ~20 m free-fall tunneled wheels through the deck on impact. findRoadSpawn now returns interpolated elevRaw; spawn y = toNormalizedRoadY(elevRaw)+0.5 (~2.5 m drop with carDriver's +2).
- Both runtime-verified headless (mask=20, pair-check=true, chassis settles at road level). Awaiting user on-screen Phase 0 gate re-test.
- G-51 hygiene (same fix, follow-up): added `assertTerrainVehicleHandshake()` in collisionGroups.js, called from BOTH creation sites (createTerrainTrimesh + chassis setup) — a future one-sided mask revert now throws at startup instead of silent fall-through. New gotcha G-51 (two-sided filter contract, cites the D-16 revert incident). Corrected stale "64-grid" labels to 128-grid (gotchas G-49, tracker, tileManager comment). Build green; startup assert verified passing headless (5 trimeshes created after chassis → assert exercised non-vacuously, pairCheck=true, mask=20).

## 2026-06-11 — Terrain physics rebuilt on Heightfield (gate attempt 2 root cause)
- User still fell off-road after the mask fix. Engine source + runtime: cannon-es has NO box-vs-trimesh narrowphase (only sphere/plane); manual-stepped drop test fell through the trimesh with zero contacts → the G-49 chassis-backstop-on-trimesh premise was always false. G-49 gotcha corrected.
- Found the original heightfield bug (why D-16 reverted it): buildTerrainHeightfield downsampled to TERRAIN_MAX_GRID=64 but indexed the 128-wide source grid with 64-range indices → SW quadrant stretched over the tile ("car trapped below terrain"). Fixed by using the full source grid.
- tileManager Phase 1 now builds a per-tile CANNON.Heightfield (group TERRAIN, mask VEHICLE, physics-frame conversion, G-51 assert); inert trimesh build removed (−88 ms/tile). Runtime-verified: placement ≤0.01 m vs trimesh (33 samples), slope drop-tests settle with wheel contact, wheel rays hit heightfields → genuine off-road driving. D-16 physics half now effectively shipped.
- Accepted consequences: no carved tunnel-mouth physics holes until Phase 3; ground plane at y=−50 vs coastal terrain below −57 is a Phase 2 item.

## 2026-06-11 — Phase 0 ✅ (gate passed on screen) · Phase 1 selective terrain smoothing implemented
- Phase 0 gate confirmed by user: car holds off-road on Montjuïc, FPS holds. Tracker updated with full gate history (attempt 1: chassis-mask handshake → attempt 2: no box-trimesh narrowphase → heightfield rebuild → attempt 3 PASS).
- Phase 1: added `selectiveSmoothRaster` in demLoader.js after the uniform box blur — two-scale frequency split + soft shrinkage (`out = bigBase + shrink(base−bigBase, FLATTEN) + shrink(src−base, FLOOR)`). Knobs: TERRAIN_RELIEF_FLOOR=2.5m, TERRAIN_FLATTEN_THRESHOLD=3m, split radii 10px(~300m)/30px(~900m); both=0 disables. Docs: bake-pipeline.md.
- Orphan terrain/terrainSmoothing.js reviewed: 3×3 per-tile primitives + uniform blend — wrong scale/place, not reused.
- A/B through real sampleElevation: Montjuïc climb 143.3→133.7m (93% kept), coast descent 16.9→16.8m (kept), Eixample wiggle RMS 0.398→0.017m (96% gone). Chokepoint verified: no consumer bypasses the raster.
- Full-region re-bake launched with default knobs (tune by driving).

## 2026-06-11 — Phase 2: audit + approved deletions (foundation simpler on smooth terrain)
- Audit numbers: false bridges 163/277 & 172/338 → **0/277 & 0/338** (tiles 16_33160_24481 / 16_33161_24481; region-wide 47 bridge roads, all OSM-structural). Terrain-physics build 65–91 ms → **0.5–3 ms/tile** (heightfield vs trimesh). G-51 assert clean on every tile. Water-sink machinery audited: all KEEP (guards OSM data quality, terrain-relative — not noise-cope).
- D1 DELETED: `isElevatedByHeight` deck-collider gate + its mirror in the overlap pre-pass (tileManager.js) — phantom-deck factory + live G-47 absolute-Y bug. Deck colliders are now structural-flags-only; surface roads ride the heightfield. Dependency on Phase-0 heightfield recorded in D-16.
- D2 DELETED: `smoothElevation` per-road moving average (elevationProcessor.js) — never enabled (window=0 everywhere), purpose handled at source. No re-bake needed (dead code, baked output unchanged).
- D3 KEPT with rationale comment at roadRenderer.js guardrail gate: above-terrain-frame test, not noise-cope — do not re-flag.
- Smoke after deletions: build green, 4-wheel off-road hold on slope drop, surface roads deckless, no page errors. Awaiting Phase 2 sanity drive.
- Phase 2 follow-ups from sanity drive: ROAD_VISUAL_ABOVE_TERRAIN 0.22→0.06 (was sized for bumpy DEM; with wheels on the heightfield post-D1 the slab floated ~30cm above wheel contact → tires sank into the road visual). Camera follow distance 6.5→8.2 (+height 1.7→2.1, clamp 7.5→9.3) per user feedback. Frontend-only, no re-bake.
- Camera "too close at spawn" root cause: tunnel-cam mode gated by absolute `p.y < -1` (G-47) — permanently active on Montjuïc (car Y≈−16). Now gated by isInTunnelZone(x,z) corridor registry; TUNNEL_Y_THRESHOLD removed. Verified on rendered screen. (The 8.2m follow distance applies now.)

## 2026-06-11 — Phase 3 slice ①: floor-validator baseline (report-only, no code touched)
- Design approved (authored-tunnels-design.md) with distribution-report adjustment + Phase-4 carve hand-off note.
- Validator walked all 376 drivable tunnel road-copies on the current bake: 53,026 samples @2m — every gap ≤0.05m, zero holes, zero NaN/degenerate. Triage: 376 CLEAN / 0 GAPPED / 0 HOLES. Centerline floors are own-deck-guaranteed; real risks are lateral shrink + joint wedges (gate-drive items). Proposed blocking tolerance for ③: 0.3m. Entry (sealed grid) confirmed as the only blocker → slice ② trench authoring is the critical path.

## 2026-06-11 — Phase 3 slice ②: open-cut trenches authored into the elevation grid
- New worldBuilder/terrain/trenchAuthor.js + buildRegion wiring (global corridors pre-loop, per-tile carve as last grid mutation, water-cell guard). 218 drivable tunnel roads → 685 corridor segments; 53 tiles cut in the full re-bake (372s, clean).
- FORBIDDEN-BAND rule replaced profile classification: cell = open-to-floor OR roof ≥5m (=CARVE_COVER); between → cut to roadY−0.15. Portal cliff self-places where real cover hits 5m (past the lip).
- Measured: adjacent drivable-road depression 0.000m; floor validator still 376/376 clean (≤0.05m, zero holes); 2.8% forbidden-band residue at portal-lip transition cells → slice ④ blend. Screenshot: car below grade inside the trench, holding.
- Trench knobs: TRENCH_MARGIN=1.5m, FLOOR_BELOW_ROAD=0.15m, ROOF_CLEARANCE=5m, MIN_CUT=0.05m.
- Spawn moved to the Sant Gervasi/Ronda de Dalt trench portal (41.4098, 2.1257, tile 16_33154_24471) for the slice-② trench drive check. Previous spawns noted in spawnConfig.js.
- Tunnel-zone camera pulled back: distance 4.0→5.5 (new TUNNEL_CAM_DISTANCE const), height 1.0→1.2, per user feedback.

## 2026-06-11 — Phase 3 slice ② Option L: daylighted corridors + crossesTrench decks
- Geometric impossibility recorded (design §2): heightfield y(x,z) can't open its own cliff face → sealed-roof tunnels are un-enterable, definitionally. Option L approved: corridors carved open end-to-end; crossing streets flagged crossesTrench at bake → deck colliders via the structural-flags gate; Phase 4 adds physics-free visual roof.
- En-route fixes: TRENCH_MARGIN 1.5→4.0 (car-blocking sawtooth wedges in roadway), legacy visual mouth/corridor culling DISABLED (punched holes in the trenched mesh), crossesTrench plumbed through 4 whitelist layers + parser + deck gate, flag skirt pad 5.5m (bilinear trench skirt).
- Full bake clean (589s): corridor continuity 52,083 open samples, portal-face band GONE (was the wall); floors 376/376 ≤0.05m zero holes; 434 crossing roads flagged; inverse clause finds 32 deckless floating samples on 2 roads — pre-existing native-dip class, not trench-caused (slice ③ scoping note).

## 2026-06-11 — Slice ② drive-feedback round: R-key recovery, shoulder cuts, closure pass
- R = recover (carDriver.js): breadcrumb of last upright ≥3-wheel pose every 2s; R teleports back (+0.8m, velocities zeroed, 1s cooldown) — escape from trench-wedge/flip/stuck (user got pinned at a trench wall with no recourse).
- Half-buried parallel roads (trench wall slicing through road width): SHOULDER CUTS — near-trench spans of drivable surface roads carve the grid to their own roadY−0.15 (min-only; deeper trench under bridges untouched) → roads sit on benches, sawtooth wall pushed off road edges. 1,533 shoulder segments.
- Shoulder cascade closed analytically: flagFloatersOverCarve flags roads floating >2m over the FINAL carved surface (corridors+shoulders, computable pre-tile-loop) → +109 roads flagged (685 total tile-copies). Inverse-clause violations 170→32 — all remaining are the 2 pre-existing native-dip roads (not trench-caused).
- Floors remain 376/376 CLEAN ≤0.05m, zero holes. Bake 641s clean.
- Known visual remainders for Phase 4: flagged crossing streets float without bridge structure (physics correct via decks); trench wall sawtooth silhouette (3.6m cell aliasing) to be dressed by retaining-wall/portal visuals; visual roof for covered sections.
- Floating crossings → full bridge dressing: added `crossesTrench` to all four isElevated visual gates in roadRenderer (bridge slab + pillars + guard rails + metal railing). The existing production bridge renderers now dress flagged crossing streets; pillars reach the trench floor via getElevationAt (trenched grid). Frontend-only, no re-bake. The at-grade spans of flagged roads stay undressed automatically (min-structure-height gate).
- 2026-07-02: Building colliders — chamfered/angled (non-rectangular convex) footprints now get an exact CANNON.ConvexPolyhedron prism collider instead of an over-covering OBB box. Fixes car getting stuck on the corner sidewalk at Eixample chamfered corners (invisible wall from the box over-covering the 45deg cut). Rectangles keep the cheap OBB; concave footprints fall back to OBB. Face windings auto-corrected outward so a winding mistake can't silently break building collision. (tileManager.js buildConvexPrism + buildBuildingColliders)
- 2026-07-02: Car handling — tamed tail-happy oversteer on normal turns. (1) turnDrift (non-handbrake rear grip loss) cap 0.4->0.1 & ramp /80->/130 so steering alone no longer breaks the rear loose. (2) Added quadratic anti-spin stability: torque.y -= yawRate*|yawRate|*YAW_SPIN_DAMP(2600) when NOT handbraking & speed>3 — negligible in normal turns, firm on a fishtail/spin. Handbrake drift path untouched (DRIFT_YAW_ASSIST + rearSlip only when _handbraking). carPhysics.js
- 2026-07-02: Perf — TREE_MAX_DISTANCE 220->170, TREE_FULL_DISTANCE 90->80. Diagnosis from live metrics (53 FPS, 5.1M tris, 129k trees): tree GEOMETRY already minimal (TRUNK_RADIAL_SEGMENTS=3, FOLIAGE_DETAIL=0, ~117 tris/tree), so the only lever is 3D-tree COUNT. Pulling the 3D radius 220->170 cuts ~40% of full-3D trees (area r^2: 170^2/220^2~0.6); rest become 2-tri billboards, fog+billboard-look mask the swap. Scene is GPU-vertex-bound (686 draw calls fine). config.js
- 2026-07-02: Tile-load car jitter — time-sliced the per-tile collider finalize (buildSceneryColliders/buildBuildingColliders + world.addBody now yield between steps) so a dense tile's collider burst spreads across frames instead of freezing one (the freeze jolts the car at speed). tileManager.js
- 2026-07-02: Night road markings/crosswalks too bright — added setRoadMarkingNightMode() (dims shared unlit _mergedMarkingMaterial 0xB0B0B0->0x3d4247 at night); wired into envToggle night toggle. roadRenderer.js, envToggle.js
- 2026-07-02: Skid marks regressed (only handbrake). Root causes: ENABLE_SKID_MARKS was false + skid gated on handbrake-only _driftFactor. Fix: added physics.getSkidLevel() (max of steering/handbrake drift, real sideways slide |lateralSpeed|/4, and hard-braking lockup >22kmh); carEffects uses it; ENABLE_SKID_MARKS->true. carPhysics.js, carEffects.js, config.js
- 2026-07-02: Direction boards restyled Delhi green -> Barcelona/Spanish white urban directional: white retroreflective panel, charcoal border+keyline, solid charcoal arrow, single street name in Catalan Title Case (toCatalanTitleCase, particles lowercase) shrink-to-fit — replaces duplicated ALL-CAPS. Removed dead HINDI_MAP/transliterateToHindi. roadInfraRenderer.js
- 2026-07-02: Skid marks invisible — were placed at wheel-contact hit.y+0.02, but hit.y is the TERRAIN heightfield and the visual asphalt floats ~0.11m above it (ROAD_OFFSET+ROAD_VISUAL_ABOVE_TERRAIN) → buried under the road. Lifted to hit.y+0.15 (on asphalt, under paint at +0.19). Also eased getSkidLevel triggers (slide /4->/3, brake floor 22->18kmh) so hard turns/braking actually leave marks. carEffects.js, carPhysics.js
- 2026-07-02: Direction board — long street names now wrap to two balanced lines (splitTwoLines) when a single shrunk-to-40px line won't fit, else single line. roadInfraRenderer.js
- 2026-07-02: New-area stutter — reworked the tile-build frame budget into a SHARED per-frame budget: _frameBudgetStart now resets once per frame in tileManager.update() (not per-yield), and yieldToMain no longer resets it, so all tiles finalizing concurrently share one cap. FRAME_BUDGET_MS 6->4. Made materializeVegetationMeshes async + yield every 600 instances (was the biggest un-yielded block: double loop over every tree instance). Net: total tile build work per frame is bounded no matter how many tiles enter range → area loads spread across frames instead of freezing. tileManager.js, meshMaterializer.js
- 2026-07-02: Removed roadside/tree-base bush tufts (scattered grass clumps on streets/crosswalks) — new CONFIG.ENABLE_BUSHES:false gates bushMesh creation in materializeVegetationMeshes (main + zone). Also trims per-tile load cost. config.js, meshMaterializer.js
- 2026-07-02: Pedestrians vanishing on approach — reassign() wiped the whole crowd (peds.length=0) and respawned a random set every REBUILD_DIST(40m), so anyone you drove toward got deleted+replaced at the boundary. Rewrote reassign to be INCREMENTAL: keep in-range peds (thrown ones finish first), cull only those who left RANGE, top up to target with newcomers spawned >30m away (no pop-in nearby). pedestrians.js
- 2026-07-02: Traffic cars vanishing on approach — cars followed a SINGLE road segment and were deleted at its end (v1 no-chain), so they popped out of existence at every segment end in view. Added road CHAINING: buildPath now returns start/end world coords + takes a direction; extendPath() appends the best forward-continuation connected road (CONNECT_DIST 9m) as a car nears its path end; dead-end fallback U-turns near the player / despawns only if far (>45m). trafficSystem.js
- 2026-07-02: City life pass 1 — tree variety + density. FOLIAGE_COLORS reworked Delhi 'dusty greens' -> fresh varied Mediterranean palettes (plane/elm/cypress/mixed); DUST_BLEND_MAX 0.35->0.12 (Barcelona isn't dusty); variant labels updated. PED_CAP 110->150 (instanced, cheap), MAX_CARS 22->28 (modest). vegetationRenderer.js, pedestrians.js, trafficSystem.js
- 2026-07-02: Color grade — rewrote the near-neutral warm-tint pass into a proper filmic grade: saturation (x1.18), gentle contrast S-curve (pivot 0.18, x1.10), warm-highlight/cool-shadow split-tone, black lift, stronger vignette (0.24). Scalable via uGradeStrength (window._colorGradePass). colorGradePass.js
- 2026-07-02: Grass REALLY removed — root cause was 'config.MAX_GRASS_PER_TILE || 50000' in vegetationWorker: 0||50000 = 50000 (falsy-zero), so MAX_GRASS_PER_TILE:0 produced MAX grass. Fixed to ?? + early-return when <=0; also gate the whole grass phase in tileManager when <=0 (skips the worker). vegetationWorker.js, tileManager.js
- 2026-07-02: LOD tree billboards matched to 3D trees — atlas colours updated Delhi-olive+dust -> fresh Mediterranean greens (per FOLIAGE_COLORS), removed dust gradient. Added setTreeBillboardNightMode (unlit billboards now darken at night like the lit 3D trees; 4 shared mats so all tiles update). Wired into envToggle. vegetationRenderer.js, envToggle.js
- 2026-07-02: Night streetlights — added setStreetlightNightMode (lamp emissive 0.25->2.8, ground pool opacity 0->0.95 at night; day defaults now dark), LIGHT_SPACING 30->22 (denser), wired into envToggle. streetlightRenderer.js, envToggle.js
- 2026-07-02: Traffic cars now have glowing head/tail lights — addCarLights() attaches 4 emissive quads (white +Z front, red -Z rear) to the unscaled outer template group so every clone inherits them (shared geo+2 mats). carModels.js
- 2026-07-02: Night too dark — NIGHT preset lifted: ambient 0.75->1.15, hemi 0.08->0.20, moonlight dir 0.30->0.45, exposure 1.0->1.05, bg slightly lifted. envToggle.js
- 2026-07-02: Shop name boards — new shopSignRenderer.js: atlas of 24 Spanish/Catalan+English shop names, one InstancedMesh per tile (per-instance aUvOffset picks the cell; text U flipped for worldGroup mirror), placed on each building's longest street-facing edge at fascia height. Wired into tileManager Phase 4 + unload sweep; CONFIG.ENABLE_SHOP_SIGNS. shopSignRenderer.js, tileManager.js, config.js
- 2026-07-02: Crosswalk/markings still bright at night — timing bug: the shared marking material could be created AFTER the night toggle fired (fresh = bright). Persisted _markingNight state + getMarkingMaterial() applies it at creation; darkened night value 0x3d4247->0x2a2f36. roadRenderer.js
- 2026-07-02: Parked cars too dark at night — added glowing head(white)/tail(red) lights: two shared InstancedMeshes populated per parked car from per-variant local light-quad matrices (dims-based), transformed by the car matrix. parkedCars.js
- 2026-07-02: Marking brightness re-tuned (unlit, hand-set per time of day): MARK_DAY 0xB0B0B0->0x8a8a8a (too bright by day), MARK_NIGHT ->0x565b62 (soft moonlit grey; 0x2a2f36 was too dark). roadRenderer.js
- 2026-07-02: ESC menu (ui/escMenu.js) — gamified pause overlay opened by ESC (+ ☰ button top-left). Global place SEARCH via Nominatim geocoding: valid Barcelona-area place -> reload with ?spawn=lat,lon (spawnConfig applies it at init); out-of-bbox place -> error. 8 quick-spawn landmark chips. Re-parents the car-colour panel (#dd-car-color-panel) + day/night toggle into the menu. HUD-metrics toggle (hides metricsPanel+performancePanel, persisted). spawnConfig.js parses ?spawn; carControls ignores keys while typing in an input; carDriver sound-toggle lookup now by id. escMenu.js, spawnConfig.js, main.js, carModel.js, carDriver.js, carControls.js
- 2026-07-02: ESC menu redesigned to FULL-SCREEN dashboard — two-column: left = spawn search + landmark button-grid + car colour + day/night + HUD-metrics toggle; right = LIVE STATS cards (speed, fps, road, lat, lon, heading, draw calls, triangles) updated each frame while open via escMenu.update() (reads renderer.info; rolling fps). escMenu.js, main.js
- 2026-07-02: ESC menu -> Firewatch-style settings screen: gold-on-dusk, top logo + tabs (GENERAL/GRAPHICS/CONTROLS/STATS), centered section headers, sliders + checkboxes, ESCAPE·BACK. GENERAL=spawn search+landmarks+car colour; GRAPHICS=Brightness+Colour sliders (wired to colorGradePass uBrightness/uGradeStrength, persisted) + Night mode + HUD metrics checkboxes; CONTROLS=key map; STATS=live cards. escMenu.js, main.js
- 2026-07-02: colorGradePass — added uBrightness uniform (overall exposure multiplier) for the Graphics brightness slider. colorGradePass.js
- 2026-07-02: ESC settings restyled to game UI — Rajdhani display font, angular clip-path notched panels/buttons/toggles, gold glow + hover, section header bars, scanline/sheen overlay, chunky ON/OFF toggle switches, keycap control rows. escMenu.js
- 2026-07-02: Bus stops floating/sunk (also the 'black object with a light' embedded in the road) — busStopRenderer calls its elevation fn with WORLD coords, but tileManager passed getElevationAt (lat/lon) → garbage heights. Now passes getGroundY (world-coord). tileManager.js
- 2026-07-02: Car looks sunk at crossings — root: wheels ride the terrain heightfield (D-16) while road slab+paint float above. Shaved ROAD_VISUAL_ABOVE_TERRAIN 0.06->0.05, CROSSWALK_Y_ABOVE 0.08->0.055, MARKING_Y_ABOVE_ROAD 0.08->0.06, ARROW_Y_ABOVE 0.04->0.035 (all still clear the ±3.5cm road noise) so paint no longer floats ~0.14m over the wheels. No re-bake; the residual ~0.05m is by-design (D-16, not reopening the physics-instability tradeoff). roadRenderer.js
- 2026-07-02: Settings menu -> Brawl-Stars style: Lilita One font, chunky 3D press-buttons (bottom drop-shadow), bright colours, uses the supplied BARCELONA DRIVE logo image (public/logo-barcelona-drive.png, mix-blend-mode:screen drops its black bg). escMenu.js
- 2026-07-02: Loading screen — branded game loader in index.html (logo + bobbing animation + red/gold indeterminate bar + 'Loading Barcelona'), shown instantly before the JS bundle; main.js fades it out after the first frames render (+20s safety net). Title -> Barcelona Drive. index.html, main.js
- 2026-07-02: UI sounds — new ui/uiSound.js (synthesized WebAudio blips, no assets; respects the shared dd_soundMuted mute). Wired into the settings menu: click on buttons/swatches, toggle chirp, open/back whooshes, GO confirm chirp. escMenu.js
- 2026-07-02: Loading screen now holds until the spawn-area tiles are actually built — added tileManager.isInitialLoadComplete() (no tiles in-flight/queued after loading started); main.js polls it (150ms, ~20s cap) before fading the loader, so the world isn't visibly popping in. tileManager.js, main.js
- 2026-07-02: Loading screen shows rotating Barcelona facts — 32 facts/stats, random every 3s, via an inline script in index.html (runs before the JS bundle so they appear instantly). index.html
- 2026-07-03: Sound system rework (sample-based, graceful fallback). New audio/audioManager.js — single shared AudioContext + master gain (volume+mute, persisted), buffer loader tolerating missing files. carSound.js: routes through the shared master; adds sample engine (idle/mid/high crossfade+pitch by RPM), sample skid + ambience; SYNTH kept as fallback when files absent. uiSound.js routed through the same master. Settings: Sound section (Volume slider + Sound on) wired to audioManager; hid the old speaker btn. Horn (H) plays horn sample. Drop files into public/audio/ (see README). audioManager.js, carSound.js, uiSound.js, escMenu.js, carDriver.js
- 2026-07-03: Traffic pass-by whoosh (audio.whoosh — car_pass sample or synth doppler sweep, panned by side, fired once per pass in trafficSystem) + day/night ambience swap (carSound.setNight crossfades ambience/ambience_night samples, or nudges the synth bed; wired via onNightModeChange). audioManager.js, trafficSystem.js, carSound.js, carDriver.js, main.js
- 2026-07-03: Engine sound reworked — was too bassy + not tracking gears. Fixed carSound RPM constants to match physics (850/6500, was 800/5500 → saturated early). Switched from muddy 3-pitch-variant crossfade to a SINGLE engine loop pitched 0.7x→2.0x by RPM (clear rev sweep per gear + drop on shift), routed through a high-pass (160Hz+, opens with revs) + 1.6kHz presence peak to cut boom. audio.loop gained a dest param. carSound.js, audioManager.js
- 2026-07-03: Removed the synth wind (it masked the engine) + boosted engine sample gain (idle 0.5->0.9, full boost too). carSound.js
- 2026-07-03: (1) Speed camera shake — rumble now starts ~30km/h (was 95) and ~3.4x stronger (carCamera.js). (2) Engine louder — high-pass 160->85Hz (was cutting the body/loudness) + car submix MASTER_VOLUME 0.55->0.78. (3) City ambience audible — setNight was capping the single bed at 0.16; raised to 0.6 day / 0.45 night. carSound.js
- 2026-07-03: Speed shake was shaking at slow speed — raised threshold 30->85 km/h, amplitude 0.12->0.05 (subtle, high-speed only). carCamera.js
- 2026-07-03: Sidewalk 'collision' was actually the STREET TREE colliders (boxes at the curb, WORLD group) — car stopped dead on touching a sidewalk. Added CONFIG.ENABLE_TREE_COLLISION (false) to gate them off; trees now decorative/drive-through, buildings still block. (Barriers/crash-barriers already off; normal streets have no road trimesh collider.) config.js, tileManager.js
- 2026-07-03: Title/start screen — index.html #dd-title (shared sky background + centered logo + gamified PLAY button, z above the loader). Shows on first load; PLAY fades it out and drops into the game (which loads in the background meanwhile). Added public/title-bg.png. index.html
- 2026-07-03: Title screen background — grayscale->colour reveal on load (ddColorIn 2.2s) + slow breathing zoom in/out (ddBreathe 20s) + stronger vignette. Background moved to its own .bg layer so the effect doesn't touch the logo/text. index.html
- 2026-07-03: Title screen — grayscale->colour reveal now via an expanding radial MASK from centre (two stacked bg layers: grayscale base + colour revealed by animated mask-size). Tagline restyled: solid black parallelogram (clip-path), bold (Poppins 700), tighter letter-spacing. index.html
- 2026-07-03: Title-screen routing — title now shows ONLY on fresh entry to '/'. PLAY does history.replaceState to '/game' + sets sessionStorage dd_played; on load the title is skipped if pathname is /game OR ?spawn present OR dd_played set. Fixes the PLAY screen reappearing after a Settings spawn-location change (which reloads with ?spawn). index.html
- 2026-07-03: Default mode = CAR (CONFIG.ENABLE_CAR true). Fly mode now opt-in via Settings toggle (persists dd_flyMode, reloads to switch) or ?mode=fly. main.js reads dd_flyMode after URL params. Loading screen: removed 'Loading Barcelona' text, pushed 'Did you know?' lower. config.js, main.js, escMenu.js, index.html
- 2026-07-03: Day/night toggle (top-right) restyled to gamified chunky 3D pill (gold/sun day, blue/moon night, press-down) to match settings toggles. envToggle.js
- 2026-07-03: City-life pass. NEW awningRenderer.js — projecting fabric "toldo" awnings over ground-floor shopfronts, laid as short segments along each building's longest street-facing edge (same edge as the shop signs), sloped canopy + vertical front valance, 8-colour Barcelona palette, all merged into ONE vertex-coloured MeshLambert per tile (1 draw call, dims with day/night lights). New flag CONFIG.ENABLE_AWNINGS (default true); wired in tileManager Phase 4 next to shop signs + added to the unload sweep. Denser crowds: pedestrians PED_CAP 150->210, CAP_PER_CELL 40->55, density target 0.5->0.62 of candidates (instanced flipbook, cheap). Fixed stale "Indian roadside trees" comment in vegetationRenderer (variants are already Barcelona plane/elm/cypress/mixed). awningRenderer.js, tileManager.js, config.js, pedestrians.js, vegetationRenderer.js
- 2026-07-03: City-life pass #2. NEW cafeTerraceRenderer.js — café terraces (parasol + round table + 2 chairs) on the sidewalk in front of a deterministic ~34% of buildings with a wide (>=12 m) street-facing frontage. Tables sit ~1.95 m out from the façade (past the awning line), 1-4 per frontage, random yaw. Two InstancedMeshes per tile sharing one set of per-table transforms: furniture (merged table+poles+chairs, baked vertex colours) + canopies (parasol cone, per-instance setColorAt from a 7-colour palette) → 2 draw calls/tile, dims with day/night. Shared singleton geo/mat flagged sharedGeometry+sharedMaterial so tile unload doesn't dispose them. Decorative only (no colliders, drive-through like trees). New flag CONFIG.ENABLE_CAFE_TERRACES (default true); wired in tileManager Phase 4 + unload sweep. cafeTerraceRenderer.js, tileManager.js, config.js
- 2026-07-03: NEW collisionDebug.js — ?debug=collision (alias ?debug=walls) draws EVERY collidable physics shape within 50 m of the car as tracking wireframes: box (green), ConvexPolyhedron/building corner-prisms (magenta), trimesh (orange), Cylinder (cyan), Sphere (yellow). Skips Plane + Heightfield so only hittable things show. Bottom-left HUD counts each type. Fills the gap in debugColliders.js (which only draws Box/Plane/Heightfield) — invisible convex/cylinder colliders that stop the car are now visible. Wired in main.js (init + per-frame update). collisionDebug.js, main.js
- 2026-07-03: Loading bar fill flat orange (#ff7a1a) instead of red→yellow gradient. index.html
- 2026-07-03: collisionDebug.js reworked — range filter now anchored on the CAMERA (rides with the car) instead of a guessed "first dynamic body" (which could be a wrong/absent body and filter everything out). Added runtime K-key toggle (works without the URL param) + a diagnostics HUD (total bodies / static / shown counts by type). main.js passes camera. collisionDebug.js, main.js
- 2026-07-03: Bus stop placement fix — shelters were landing mid-road when a stop snapped to a narrow service lane beside a wide avenue (offset used only the snapped road's half-width). busStopRenderer now searches outward on the preferred side, then the other side, for a spot that clears EVERY nearby road's carriageway (intrudesOnRoad + distToRoad helpers, clearance = shelter half-depth); if none clears (e.g. stranded between dual carriageways) the stop is skipped instead of planted in a lane. Render-time fix, no re-bake. busStopRenderer.js
- 2026-07-03: Building collider over-cover fix. Concave footprints (L/U-shaped Eixample blocks) previously fell back to a single oriented bounding box, which fills the notch and juts out over the sidewalk/road as an invisible wall — the cause of "car stops in the middle of nowhere". Now concave (>4-vertex) footprints are traced with thin per-edge perimeter wall colliders (addPerimeterWalls) that hug the real wall line. Walls are 2 m thick, offset fully INWARD so the outer face sits exactly on the footprint edge (zero outward intrusion) and they resist fast-car tunneling. Rectangles keep the cheap OBB, convex >4 keep the exact convex prism. Runtime fix, no re-bake. tileManager.js. Also added a Collision-wireframes toggle in ESC → Display (escMenu.js) wired to collisionDebug.
- 2026-07-03: Intensive QA pass — fixes across subsystems. CRITICAL: Phase-4 tile build now re-checks aborted() after every yield + before collider add-loops (was adding phantom colliders/meshes to unloaded tiles → invisible walls + unbounded leak). Night materials re-applied after spawn tiles build + persisted night flags (loading into night no longer half-day); shoulder day-opacity default fixed; shop signs dim at night. Input: new inputGate.js — ESC menu blocks car/recover/horn input while open; free-camera WASD bails while typing (search box usable); Escape closes menu from search; minimap Escape no longer opens settings; collision-wireframes checkbox live-syncs. Fly-mode toggle strips URL ?mode on reload + reflects resolved mode. Tile leaks: tunnel ramp bodies tracked/removed, unregisterTunnelZones(key) fix, grass+bus-stop shared-material flags, InstancedMesh instance-buffer disposal, neighborRoads key fix. Also: synth horn fallback, ?spawn bounds check, anti-flip righting at full inversion, café-terrace road clearance, single mute source of truth, whoosh rate/voice cap, volume-0==mute, recover-teleport camera-shake suppression. Files: tileManager.js, envToggle.js, shoulderRenderer.js, shopSignRenderer.js, vegetationRenderer.js, busStopRenderer.js, cafeTerraceRenderer.js, inputGate.js(new), carControls.js, carDriver.js, carPhysics.js, carCamera.js, carModel.js, carSound.js, audioManager.js, escMenu.js, minimap.js, freeCameraController.js, spawnConfig.js, main.js
- 2026-07-03: High-speed streaming stutter — two fixes. (1) Speed-scaled look-ahead: the driving-direction tile look-ahead now extends further the faster you go (LOOKAHEAD_RADIUS + min(3, speedKmh/55)), so the next tile row is fetched+built with lead time instead of bursting right as you cross the boundary. main.js passes speedKmh to update(); MAX_CONCURRENT_TILE_LOADS 2->3 so fetch keeps up. (2) One-time GPU shader warmup: renderer.compileAsync(scene,camera) after the spawn tiles build — materials are shared singletons so this compiles nearly every program the session uses, killing the first-render shader-compile stall as new tiles stream in. tileManager.js, main.js. Also: NEW shopfrontRenderer.js (ground-floor storefronts under awnings); floating peds/parked cars fixed (ground on terrain not road height).
- 2026-07-04: ROOT-CAUSE fix for floating buildings + pedestrians in hilly/port areas. The world is shifted down by the spawn elevation offset (Y = rawDEM - worldElevationOffset), so real ground at the port/hills sits at Y ≈ -offset (negative). Multiple placement paths fell back to ABSOLUTE Y=0 when the terrain sample failed — but Y=0 is the spawn-height plane, ~offset metres ABOVE the real ground, so anything hitting the fallback floated. (Car + terrain mesh never hit it → stayed grounded; per-prop fixes swapped sources but never removed the ->0 sentinel.) Fixes: getTerrainHeightAt now borrows the nearest loaded neighbour tile's terrain sampler when the exact tile has none (partial/road-only tiles); getSurfaceHeightAt + main.js terrainGroundY + buildingRenderer LOD (`:0` guard) + buildingWorker createFastElevation stub now fall back to the spawn-normalized ground floor (-offset*vertExag) instead of absolute 0. New tileManager.normalizedGroundFloor() helper. tileManager.js, main.js, buildingRenderer.js, buildingWorker.js
- 2026-07-04: Visual polish. Car paint: upgraded to MeshPhysicalMaterial w/ subtle clearcoat (metalness 0.35, clearcoat 0.4, envMapIntensity 0.5) — glossy but keeps its colour (first pass at 0.6/1.0/1.15 washed it white). Night glow pass: bloom is now day/night-aware via envToggle — DAY strength 0.5/threshold 1.1 (unchanged, daytime doesn't bloom), NIGHT strength 0.95/threshold 0.62 so streetlamps, lit windows, signs, shopfront glass and vehicle head/tail lights all bloom. main.js passes setBloom into createEnvToggle; envToggle lerps bloomStrength/bloomThreshold in the day/night transition. carModel.js, main.js, ui/envToggle.js
- 2026-07-04: More night polish. Lit night-window density 12%->16% (skyline reads as more alive, especially with the new night bloom). Player headlights now day/night-aware — soft DRL (intensity 3) by day, blazing beam (16) at night — via carModel.setNight, routed through carDriver.setNight (already fired by onNightModeChange + envToggle.reapply). buildingRenderer.js, carModel.js, carDriver.js
- 2026-07-04: Richer daylight. Warmer, firmer sun (DAY dirColor 0xffeedd->0xffe6c2, dirIntensity 3.1->3.35, ambient 0.36->0.32 for deeper shadows), and a modest grade bump (saturation 1.18->1.24, contrast 1.10->1.15, warmer golden highlights) so the default daytime view looks less flat. Grounding reviewed: entities already get pooled blob contact shadows, trees darken terrain (darkenTerrainAroundTrees), poles have shadow decals, everything casts directional shadows — SSAO skipped (perf) as grounding is already covered. envToggle.js, colorGradePass.js
- 2026-07-04: NEW game/dashMode.js — "Checkpoint Dash" time-trial. START button (top-centre, car mode only) lays a chain of ~6 glowing gates along the loaded road network (greedy forward-biased route from the car, 90-210 m apart), each with a pillar of light so the next is findable from afar. Drive through in order against a running clock; clear the last to finish; best time saved to localStorage dd_dashBest. Only the next two gates show (cyan next, gold after). Gate meshes live in the scene/physics frame like traffic (px=-(wx-ox), pz=wz-oz); hit radius 15 m; synth ding per gate. Wired in main.js (created in the car-mode block, updated each frame with the car physics pos). main.js, game/dashMode.js(new)
- 2026-07-04: Dash polish — countdown, medals, minimap marker. (1) 3·2·1·GO countdown after Start (big centre pop animation + beeps); the clock + hit-testing only begin at GO. (2) Finish medals by avg time/gate: gold <6.5s, silver <9s, bronze <13s, else finished; finish screen shows medal emoji+label+time and ★ NEW BEST when beaten. (3) Minimap objective dot — minimap.setObjectiveMarker(wx,wz) places a cyan heading-up dot to the next checkpoint clamped to the rim (m/px from zoom 17); dashMode drives it on each gate change (via lazy getMinimap since minimap is assigned after dashMode in init) and clears on stop/finish. game/dashMode.js, ui/minimap.js, main.js. Also earlier: 10 gates 45-120m apart; slimmer pointier direction arrow; labelled NEXT-CHECKPOINT compass + on-gate NEXT tag.
- 2026-07-04: Game-styled map + M key. Minimap base switched from raw OSM tiles to CARTO Positron (light_nolabels) — a clean, minimal roads+water base — tinted to the game palette (warm parchment by day, deep navy by night) via new FILTER_DAY/NIGHT; the tint now persists in the expanded map too. Expanded map frame restyled with a gold game border + darker backdrop. New key M toggles the big map (guarded against firing while typing). ui/minimap.js. README credits updated for CARTO.
- 2026-07-04: NEW game/taxiMode.js — "City Cab" delivery mode (second game mode). Green Start Shift button (top-left, below the dash button). A green PICK-UP marker spawns on a nearby road (120-340m); reach it → a gold DROP-OFF marker (180-520m) appears with a decaying tip meter; deliver for payout = round(base(3+dist*0.02) * (1+tip)), tip 0.6→0 over ~expected drive time. Fares chain endlessly; running total $ + fare count; +$X float popup on delivery; End Shift saves best payday (dd_taxiBest). Reuses dash's marker/arrow/on-tag/minimap patterns; single reusable marker recoloured per objective. Wired in main.js car-mode loop. Idle HUD hidden so it doesn't overlap the dash HUD (run one mode at a time). game/taxiMode.js, main.js
- 2026-07-04: UX pass — one Play launcher for game modes + surfaced controls. NEW game/gameLauncher.js replaces the per-mode Start buttons (gold Dash + green Taxi were competing CTAs that wouldn't scale). Single gold "🎮 Play" pill (top-left below the ☰ menu) opens a mode menu (Checkpoint Dash / City Cab / Free Roam) with one-line descriptions + a CONTROLS cheatsheet (WASD/Space/H/R/M/Esc) so new players know how to drive. Enforces one-mode-at-a-time (starting a mode stops the others). While a mode runs the pill turns red "✕ Quit"; polls isRunning so it flips back when a mode ends itself. dashMode/taxiMode refactored to drop their own buttons and expose {name, icon, start, stop, isRunning}. main.js wires createGameLauncher([dashMode, taxiMode]). game/gameLauncher.js(new), game/dashMode.js, game/taxiMode.js, main.js
- 2026-07-04: UX batch — recover hint + taxi confirmation. carPhysics exposes getUpDot() (chassis-up · world-up); carDriver forwards it. main.js shows a "🔄 Flipped over — press R to recover" banner when upDot<-0.05 for >0.6s (the recover key was otherwise undiscoverable when stuck upside-down). Taxi shows a "🧍 Passenger aboard — drop off!" toast on pickup so the state change is unmistakable. carPhysics.js, carDriver.js, main.js, game/taxiMode.js
- 2026-07-04: Juice + map + signs. NEW game/gameFx.js — fxFlash / fxConfetti / fxBanner (WAAPI, self-cleaning). Wired: taxi pickup (PASSENGER ABOARD banner + green confetti), taxi delivery (DELIVERED/⭐FARE COMPLETE banner + gold confetti + payout, bigger for fast/high-tip), dash checkpoint (small cyan confetti+flash each gate), dash finish (medal banner + big confetti). Minimap base switched CARTO Positron→Voyager (no-labels) — coloured roads/parks/water instead of near-white; lighter filter (saturate/contrast, no heavy sepia) so it keeps colour + detail. Direction/gantry sign faces now THREE.DoubleSide (were FrontSide → invisible from behind); dropped the unreliable gray back plane on the roadside board. game/gameFx.js(new), game/dashMode.js, game/taxiMode.js, ui/minimap.js, map/roadInfraRenderer.js
- 2026-07-05: Fix floating buildings (+ floating peds/cars/scenery) — the big one. Root cause: the rendered/physics ground uses the BAKED terrain mesh (tunnel carving + water dips applied at bake), but `terrain.getElevationAt(lat,lon)` read the RAW `elevation` grid (no carving/dips). Every consumer of getElevationAt — building base-Y, building/scenery colliders, `getTerrainHeightAt` (peds, parked cars, game gates) — therefore floated over any carved/dipped area. Fix: getElevationAt now bilinear-samples the baked mesh POSITIONS directly (reconstructing the grid: vi=r*cols+c, x linear per column, z per row) and returns sampledY−offset, falling back to the raw grid only when unbaked. No re-bake needed (the carving is already in the baked positions). One change cascades to all consumers → everything now sits on the exact ground the car drives on. frontend/src/map/terrainRenderer.js. Also: no parked cars on living_street / roads <6.5m wide (car/parkedCars.js); urban-feature road clearance 2.0→3.0m (map/urbanFeatureRenderer.js).

- 2026-07-06 — Added GTAOPass ambient occlusion (rally-only, after RenderPass): soft contact AO grounding cars/buildings/curbs/trees for the art-of-rally diorama look. world radius 2.2 m, scale 1.35, 8 samples + poisson denoise (perf-safe). Tunable via window._gtaoPass / window._gtaoTune. Also traffic cars now use the merged tint-ready template with per-car body tint (dark glass/wheels), matching parked cars; liveried taxi/police/delivery keep their livery.

- 2026-07-06 — Rally sky: added a warm sun-scatter glow to the gradient sky shader (tight sun disc + broad horizon wash toward the sun azimuth, fades above horizon so the zenith stays clean blue). Additive + rally-gated (uRally), does not touch the shared SKY_/fog/ambient palette; auto-hidden at night (sky dome invisible). Fed by sunDir via skyMat.uniforms.uSunDir.

- 2026-07-06 — Rally player-car paint pop: saturate the body base colour (HSL s*1.25+0.06) and use a cleaner, stronger clear-coat (metalness 0.28, roughness 0.30, clearcoat 0.6) so the hero car stands out against the flat-shaded world. Rally-gated; non-rally paint unchanged.

- 2026-07-06 — Rally tire dust: enable the tyre-smoke pool in rally (even when CONFIG.ENABLE_TIRE_SMOKE is off), warm tan puff colour + soft radial-gradient texture, and a new speed-dust emitter — light low-opacity dust flung backward behind the rear wheels above ~43 km/h (no drift needed), opacity scaling with speed and capped subtle. Pool 50→ 90 so drift smoke + dust do not starve. Default (non-rally) smoke path unchanged.

- 2026-07-06 — PERF/ARTIFACT FIX: removed GTAO (AO) and Bokeh (DOF) post passes. Each re-renders the full scene into depth/normal buffers (GTAO: depth+normals; Bokeh: depth), tripling triangle throughput on the ~4M-tri city (user saw ~10M tris, ~33 FPS). GTAO also produced the dark blob behind the near hero car and black rectangles on cloud/dust sprite quads (alpha cutout ignored in the normal prepass). Grounding reverts to shadow map + contact shadows. Also removes the DOF background blur the user asked to drop. rendering.md post-chain updated + a do-not-re-add note.

- 2026-07-06 — Skid sound now plays on handbrake/drift: threaded physics.getSkidLevel() into carSound.update; skid voice gain is driven by max(skidLevel, hardBraking) instead of hardBraking only (needs >7 km/h). Also dust darker at night: carEffects.setNight() swaps puff colour to a dark warm tone (rally 0x4A4235), wired via carDriver.setNight → onNightModeChange.

- 2026-07-06 — PERF Phase 0 (zero-quality-risk): tree BatchedMesh castShadow=false (blob shadows already ground them — biggest single GPU win); flagged building detail meshes isBuildingDetail so the 120m detail cull actually fires (was rendering balconies/rails to 180m); ground LOD altMult floor 1.25→1.0; terrain DoubleSide→FrontSide; parked-car InstancedMesh castShadow=false; renderer antialias:false (composer targets are non-MSAA); moon/glow/stars toggle .visible (skip daylight draws); sky dome Icosahedron detail 4→2; physActive collider radius 200→120m. Deferred rank-28 uv-attribute removal. See perf-audit.md.

- 2026-07-06 — PERF Phase 1a (geometry decimation): tree foliage lobes DodecahedronGeometry (36 tris) → IcosahedronGeometry detail-0 (20 tris) — ~44% fewer tris across ~50k trees x 2-3 lobes; env-cluster rocks Icosahedron detail 1→0 (80→20 tris). Both non-indexed so trunk/merge compatibility holds; near-identical flat-shaded look. Did NOT re-enable cluster frustumCulled (audit rank 22) — conflicts with the earlier fix that set it false to stop clusters vanishing up close.

- 2026-07-06 — PERF Phase 1b (NEEDS VISUAL VERIFY): building facade + roof materials DoubleSide → single-sided via new BUILDING_SIDE const (default THREE.BackSide) in meshMaterializer — closed extruded prisms never show interior back faces, ~halves building fragment shading. worldGroup.scale.x=-1 flips winding so exterior = BackSide; if buildings render hollow/see-through, flip BUILDING_SIDE to THREE.FrontSide (one word). Thin details (rails/awnings) kept DoubleSide. Could not self-verify (GPU-starved 2nd tab never streamed buildings).

- 2026-07-06 — PERF Phase 1b REVERTED to DoubleSide: building geometry has inconsistent triangle winding, so no single side renders every building right (FrontSide left some inside-out as a giant flat plane; BackSide made others hollow). Building backface culling deferred — needs the worker to emit consistent winding first. Other Phase 0/1a wins stand (FPS ~61, tris ~2.31M).

- 2026-07-06 — PERF: fixed adaptive-resolution one-way lock. FAST_MS was 12.5ms (needs >80fps, impossible under 60fps vsync) so render scale could only drop, never recover — it sat stuck at the 0.70 floor with tons of GPU headroom. Now: drop when missing 60 (>17.6ms), probe UP when comfortably holding 60 (<16.9ms), with a learned probeCeiling (lowered below any scale that fails, slowly forgiven back toward CAP) so it settles just under the sustainable resolution instead of oscillating/black-flashing. Sharper image for free given the headroom from Phase 0/1a.

- 2026-07-06 — PERF/FEEL: (1) reverted the aggressive adaptive-res up-probe (it overshot under vsync → 45-55fps oscillation) back to decisive-drop + gentle-trickle-up, and LOWERED the render-scale FLOOR 0.70→0.55 so dense areas hold 60 by softening slightly instead of dropping frames. SLOW_MS 17.2, FAST_MS 15.5. (2) Collision stuck feel: lowered default contact friction 0.3→0.12 so the chassis slides along walls/buildings instead of gripping and stopping dead (wheels use RaycastVehicle frictionSlip, unaffected).

- 2026-07-06 — PERF PANEL: added a "Capable" row showing true uncapped FPS via a WebGL2 GPU timer (EXT_disjoint_timer_query_webgl2, new ui/gpuTimer.js). On a 60Hz monitor vsync pins the FPS row at 60 and hides headroom; Capable = 1000/(real GPU frame time) reveals how much room the game actually has (e.g. 60 shown but ~140 capable = lots of headroom). Falls back to n/a where the extension is unsupported.

- 2026-07-06 — PERF Phase 2a: balcony balusters now flat quads (2 tris) instead of solid boxes (12 tris) via new makeQuadGeom in workerGeometry.js — 6x fewer tris on a major building sink (up to ~60k tris/tile of sub-pixel bars). Thin bars read identically face-on; detail materials are DoubleSide so quads show both sides. Runtime worker change, no re-bake.

- 2026-07-06 — PERF Phase 2b: tree trunk cylinder heightSegments 2→1 (halves trunk side tris; straight taper needs no mid ring). SKIPPED audit rank-9 facade/roof palette-key merge — the audit assumption was wrong: getFacadeTint bakes only a grey BRIGHTNESS into vertex colors (r=g=b=0.85-1.05), the actual colour is material.color from the palette hex, so dropping the hex would flatten all buildings to one colour. Doing it safely needs the palette folded into vertex colours (riskier, draw-count-only win) — deferred.

- 2026-07-07 — PERF Phase 4a (terrain fragment shader, rally-only, biggest GPU-fragment lever): terrainFBM single-octave in rally (halves the per-pixel noise ALU across ALL ground; all 5 biome layers + patch structure preserved, just smoother within each patch) and skip the per-pixel fiber texture fetch in rally (replaced ±6% detail with a constant 0.98 dim). Rally ground is flat-shaded/clean so the fine detail isnt visible; non-rally/Delhi path unchanged. Direct fragment-cost saving on the largest on-screen surface.

- 2026-07-07 — DIAGNOSIS PIVOT: metrics showed Capable ~120fps (8.3ms GPU) but only 41 FPS → the game is CPU/main-thread-bound, NOT GPU-bound (GPU has huge headroom; render scale climbed to 1.04x sharp). Added a per-section CPU profiler (ui/cpuTimer.js) + a "CPU ms" panel row showing avg ms/frame per section (phys/ent/tiles/ui/rend) to locate the main-thread bottleneck before optimizing. GPU-side perf work is done for now; next work targets whichever CPU section dominates.

- 2026-07-07 — PERF STUTTER FIX: CPU worst-frame profiler pinned the ~5/sec 18ms hitch to ent (parked-car rebuild every 35m + pedestrian reassign every 40m). Both walked ALL ~4400 road segments before the per-car RANGE test inside the walk. Added a whole-segment bbox cull (physics frame) so far roads are skipped before the inner walk + getGroundY lookups — only near segments are processed. Should crush the ent worst-frame spike → smoother 60.

- 2026-07-07 — PERF TOOLING: added a record-to-file perf logger (ui/perfLogger.js) with a floating "● REC PERF" button (bottom-left). Records one sample/frame (frame ms, GPU ms, CPU section breakdown phys/ent/tiles/ui/rend, draws, tris, heap, x/z, speed, heading); click again to stop → downloads perf-log-<t>.json (meta + cpuAvg + top-30 worstFrames + all samples). Lets us capture the exact stutter frames + player context offline instead of reading the panel mid-drive. cpuTimer.snapshot() exposes the current frames per-section times.

- 2026-07-07 — STUTTER ROOT CAUSE (from perf log analysis): the stutter is GC pauses from tile-geometry churn — ~15MB of LIVE vertex buffers materialized per streamed tile, freed on unload → 112 MB/s garbage, heap sawtooth 397-1048MB, 493MB major-GC pauses = the 50ms frames. Rate scales with tile-cross rate: ~8% spike frames at city speed (<30km/h), ~19% at 70-110km/h. The 15MB is quality-load-bearing (buildings/terrain) so cannot shrink without visible change; the quality-neutral fix is buffer POOLING (reuse tile buffers). First safe increment shipped: tree materialization uses parallel typed arrays instead of ~4300 short-lived {id,x,z} objects/tile (less GC pressure, zero visual change). Verify further increments via the REC PERF logger.

- 2026-07-07 — CAR FEEL: city-car speed retune. Speed NUMBER was correctly calibrated (fwd·vel*3.6, 1 unit=1m) but the car was tuned as a 280km/h M3, so 50 got skipped in ~1s and 120 was trivial. Now: GEAR_TOP_SPEEDS [0,40,70,100,125,140,150] (top ~150, mid-range 40-90 in the torquey gears 2-3), BASE_ENGINE_FORCE 6000→4800 (~5.5s 0-100, dwell in city range), FOV speed-cue peaks at 85km/h not 120 (MAX_FOV_BOOST 14→17), radial edge-blur starts at 37 not 42. Net: 50 feels substantial/fast, 100-150 is a genuine high-end.

- 2026-07-07 — STUTTER (real cause + fix): perf log with per-section heap proved the stutter is GC pauses (worst frames = 50ms with 0 alloc + only ~12ms CPU = frozen by GC) from ~1MB/frame of DISTRIBUTED engine churn (Three.js render + cannon-es physics + entities) — NOT a single deletable hotspot (the per-section heap attribution just tracks CPU time via V8 page-commits). Game runs ~80fps on a 120Hz display. Added an FPS cap (default 60, ?fpscap=N override, 0=uncapped): fewer frames/sec → ~25% less garbage/sec → fewer GC pauses, plus even frame pacing (big perceived-smoothness win). Skipped refreshes do zero work.

- 2026-07-07 — GC GRIND (safe, quality-neutral): (1) shadow-map re-render threshold 5m→12m (fewer full shadow passes = less Three.js churn + GPU). (2) Traffic lights: 4 loose child meshes/car (~112 draws) → 2 shared InstancedMeshes rebuilt each frame from car poses (~2 draws). (3) Traffic materials: per-car material.clone()+dispose() churn → shared per-(template,tint) material cache (created once, reused, never disposed). Net: ~110 fewer draws → less per-frame render allocation, and no spawn/despawn material GC. Look unchanged.

- 2026-07-07 — STUTTER ROOT CAUSE FOUND + FIXED (Chrome allocation profiler): ~79% of ALL runtime garbage was building COLLIDER creation — addPerimeterWalls (tileManager) emits one CANNON.Box per footprint edge, and every cannon-es Box recomputes its ConvexPolyhedron edges/normals (updateConvexPolyhedronRepresentation 34% + computeEdges 19% + computeNormals 16%). OSM footprints have many near-collinear points → dozens of boxes per building. Fix: mergeCollinearRing() collapses collinear consecutive edges (>9° turn = corner) before emitting wall boxes → far fewer boxes → far less allocation. Colliders geometrically ~identical, invisible. Directly attacks the GC-pause source.

- 2026-07-07 — STUTTER fix cont.: profile after collinear-merge showed collider allocation down ~37% (updateConvexPolyhedronRepresentation 24.4→15.2MB) but addPerimeterWalls still 60%. Now merge the clean footprint UP FRONT (in buildBuildingColliders) so BOTH paths benefit: convex-prism buildings build a lower-vertex cannon-es ConvexPolyhedron, and concave buildings emit fewer perimeter-wall boxes. Was only merged inside addPerimeterWalls before.

- 2026-07-07 — Collider GC: reverted an attempted shared-box-shape cache — UNSAFE in cannon-es (shapes cache worldVertices per-shape and only recompute on local change, not transform change, so a box reused at different positions collides at the wrong place = cars through walls). Kept the safe collinear-merge (both paths). Verified: providing normals to ConvexPolyhedron skips computeNormals but computeEdges always runs, and hand-building a Box-equivalent risks collision bugs untestable here. Remaining cannon-es garbage (both collider creation + per-frame findSeparatingAxis/clipAgainstHull Vec3 allocation) is inherent to the library — the definitive fix is Rapier (WASM, ~0 JS garbage), a big rewrite.

- 2026-07-07 — Collider GC: skip building colliders for buildings whose footprint is entirely >20m from ANY road (deep-interior buildings the car can never reach). Cuts cannon-es Box garbage (the #1 GC source) at BOTH creation and per-frame collision, for the skipped buildings. Conservative: all roads (incl footways) count as reachable + 20m margin → only clearly-unreachable buildings are skipped (near-zero drive-through risk). Passes filteredTileData.roads into buildBuildingColliders.

- 2026-07-07 — Collider GC (big dense-area win, NEEDS COLLISION VERIFY): building wall/box colliders now built via makeCheapBox() — a ConvexPolyhedron with per-box vertices but SHARED size-independent face/normal/axis templates + PROVIDED normals. Skips cannon-es Box.updateConvexPolyhedronRepresentation (27% of GC) + computeNormals (14%). Geometry copied EXACTLY from cannon-es Box (dist:3085): faces [[3,2,1,0],[4,5,6,7],[5,4,0,1],[2,3,7,6],[0,4,7,3],[1,2,6,5]], outward normals, axes. SAFE from the shared-shape bug (each box owns its vertices→own worldVertices cache). computeEdges still runs. Only risk = a wrong normal → drive-through one face; user must verify buildings solid from all sides.

- 2026-07-07 — Stutter (tile-load hitch): buildBuildingColliders is now async and yields between building batches, so a dense tile's collider creation spreads over a few frames instead of one synchronous burst (the "stutter when driving into a dense area"). Tile loads ahead of the car → colliders exist before arrival, no drive-through risk. Also confirmed trees do NOT affect stutter (no colliders + GPU-idle). Remaining garbage is now balanced (colliders ~35%, streaming ~17%, terrain heightfield ~10%, tail); safe collider levers largely exhausted, next big lever is Rapier.

- 2026-07-07 — ESC MENU redesign (art-of-rally showroom): split the pause menu into two columns — LEFT = the existing info/settings (left-aligned, scrollable), RIGHT = a live 3D turntable of the player car (BMW M3) that auto-rotates 360°, drag-to-spin. New ui/carShowcase.js: own tiny alpha WebGLRenderer + warm-key/cool-fill lighting + soft contact shadow, created lazily on first ESC open, render loop runs ONLY while the menu is open (zero in-game cost). Showroom-gradient panel bg. Collapses to stacked layout under 900px.

- 2026-07-07 — ESC menu showcase tweaks: reverted to the DARK menu background (kept the two-column layout, car has NO box — rests directly on the dark bg with its contact shadow). Car showcase: smaller (fit 2.7 units), near-flat eye-level camera (was angled from above), light silver-white body paint (Body_CarPaint_0 → 0xEDF0F4, showroom look; separate GLB instance so the in-game car is unaffected).

- 2026-07-07 — ESC showcase polish: camera pulled closer (radius 6.4) + slight downward tilt so the car looks GROUNDED (was floating with the dead-flat cam). Contact shadow changed from dark→LIGHT glow-platform (dark shadow was invisible on the dark menu bg) — soft blue-white radial oval under the car as a clean showroom base.

- 2026-07-09 — MINIMAP data-load rebuilt (critical): the custom minimap's whole-city background load was fetching ALL ~426 full tiles (~525 MB) just to draw the 2D vector map — brutal on weak connections. Replaced with ONE pre-generated citymap file: new backend/tools/buildCityMap.js reads the already-baked tiles (no re-bake), extracts roads/water/parks, Douglas–Peucker–simplifies (a minimap needs no fine detail), drops tiny fragments, Int16-quantizes coords at 0.5 m, groups BY SOURCE TILE, and writes backend/tiles/<region>/citymap.bin (3.68 MB raw, **0.57 MB gzipped — 948× smaller**). New server route GET /api/citymap?region= serves it gzipped with immutable cache. cityMapLoader.js now fetches that single file, parses (DataView), and idle-paced-ingests each tile under `${tx}_${ty}` (so near-car full tiles still upgrade to buildings). customMap.ingestTile gained a `quiet` flag + `refresh()` so 311 tiles ingest with ONE redraw. Regenerate citymap.bin after any re-bake. citymap.bin is gitignored (generated artifact) — deploy must run the tool.

- 2026-07-09 — PRODUCTION-READINESS + security audit. Audit: no secrets/PII in repo or client bundle; path traversal blocked (safeTileId regex + sanitized getTilePath); no XSS (OSM display_name rendered via textContent, not innerHTML); no source maps shipped; frontend 0 vulns; backend `npm audit fix` → 0 vulns (patched Express chain: qs, path-to-regexp). Fixes: server.js CORS now env-driven (ALLOWED_ORIGINS allowlist, no wildcard default, disallowed origins get no CORS header) + security headers (X-Content-Type-Options nosniff, Referrer-Policy no-referrer, x-powered-by off); tiles/citymap Cache-Control immutable in NODE_ENV=production else no-cache; region default delhi→barcelona. Frontend: VITE_STATIC_TILES flag → fetch tiles as plain static files (/tiles/<region>/<z>/<x>/<y>.bin) for a zero-server CDN deploy. Added frontend/.env.example, backend/.env.example, DEPLOY.md (static-CDN vs Node-server options, Cloudflare zero-egress note, checklist). Favicon/metadata: new favicon.svg (steering wheel), apple-touch-icon.png (360² from logo), site.webmanifest, full SEO + Open Graph + Twitter + theme-color + PWA tags in index.html; removed default vite.svg. (og:image/canonical use barcelona-drive.example placeholder — set real domain before deploy.)

- 2026-07-09 (v2, Phase 1) — GLB compression. Compressed all 15 in-use models with WebP textures (q90, near-lossless; native in three, no decoder needed): 14.7 MB → 6.8 MB (2.2×). Geometry left UNCOMPRESSED on purpose — meshopt/Draco KHR_mesh_quantization shattered the car meshes (they are merged + matrix-transformed in loadCarTemplate, which is incompatible with quantized int attributes; people were fine but cars exploded). Textures were ~90% of the size anyway. Deleted the unused 7.6 MB car.glb (in-game car is bmw_m3.glb). New src/loaders.js makeGLTFLoader() (plain GLTFLoader; WebP is native) wired into all 5 loader sites. -transform/cli added as devDep. Next: KTX2 (GPU texture compression) + vegetation.

- 2026-07-09 (v2, Phase 2) — Deleted ~12 MB of UNUSED textures. Audit found the code loads only a handful of textures (decals, railway, terrain grass, vegetation, wall); buildings/roads/sidewalks are rendered PROCEDURALLY (colour arrays), and the tree PNGs / "new textures" craftpix+TCom packs / stylized_low_poly_tree asset were never referenced (vegetation GLBs embed their own textures). Removed public/textures/{roads,buildings,sidewalks}, "new textures", terrain/ground_01.jpg, models/tree1-3.png, stylized_low_poly_tree asset. public/ 40 MB → 22 MB (with Phase 1). Zero render impact (nothing loaded them).

- 2026-07-09 (v2, Phase A — audio) — Audio 6.4 MB → ~2.9 MB. Re-encoded to Opus-in-Ogg via ffmpeg: ambience.ogg + ambience_night (264s loops) → 48k mono (gapless Opus loop, was 3.3MB ogg + 1.2MB mp3); horn.wav + skid.wav (1.8 MB uncompressed) → 96k Opus (0.07 MB). Engine loops kept as WAV (seamless-loop critical, already tiny). audioManager's V() manifest already prefers .ogg, so the new files are picked automatically; dropped the replaced .wav/.mp3.

- 2026-07-09 (v2, build) — Bundle code-splitting. vite.config manualChunks splits the single 1.53 MB (454 KB gzip) bundle into: three (714 KB / 183 KB gz), physics/cannon-es (106 KB), vendor (150 KB), and app/index (558 KB / 195 KB gz). Total unchanged, but Three.js is now a long-cached hashed chunk — returning players skip re-downloading it (~183 KB gz) on every app deploy, and chunks fetch in parallel. Zero gameplay risk.

- 2026-07-09 (v2, V2 lighting) — Filmic tone mapping. Swapped LinearToneMapping → ACESFilmicToneMapping (cinematic highlight rolloff + richer contrast across the whole frame). Exposure retuned: scene.js 1.5→1.9 (rally), envToggle DAY preset 1.0→1.9 to match. Night rebalanced for ACES (which crushes darks + saturates harder than Linear): NIGHT toneMappingExposure 1.18→1.75 (was too dark), ambientColor 0x6a7398→0x8c8f97 (desaturated cool-grey — the old saturated blue was tinting the road blue under ACES), ambientIntensity 1.25→1.15. Day and night both verified by screenshot.

- 2026-07-09 (v2, V4 materials pt.1) — Baked building AO + grade un-fade. buildingRenderer applyVertexColor now darkens WALL vertices toward each building's base (BUILDING_AO_MIN 0.66, 6m band, smoothstep) — perf-safe baked AO (multiplied into the existing vertex-colour attr, no depth prepass), grounds the blocks. Roofs unchanged. Grade retuned for ACES: high-key brighten 1.14→1.06 (was washing the frame flat/faded) + saturation 1.42→1.52 (counters ACES desaturating highlights). Screenshot-approved.

- 2026-07-10 (v2, V4 materials pt.2) — Per-building facade tint variation. buildingRenderer getFacadeTint now applies a deterministic per-building brightness (0.82–1.06) plus a warm/cool bias (±0.041) so neighbouring facades differ in temperature — breaks up the uniform block look on top of the base-AO. Screenshot-approved.

- 2026-07-10 (v2, V5 cohesion) — Warmed vegetation toward Mediterranean olive. vegetationRenderer FOLIAGE_COLORS (all 4 tree variants) and the park/green-area ground mesh (0x4a6e38→0x54703e) nudged R+/B+/G-eased so foliage sits in the same warm palette family as the buildings under ACES (pure vivid greens were clashing). Grass palette already warm — untouched. Completes the V1–V5 visual refinement pass. Screenshot-approved.

- 2026-07-10 (perf, big session) — Smoothness overhaul, measured end-to-end via the new STATS breakdown (per-section cpu ms + per-section MB/frame alloc + worst-frame attribution): killed the entity-rebuild stutters (parkedCars/pedestrians per-segment metadata cached on the segment; traffic buildPath allocation-free + budgeted per frame), replaced the Leaflet minimap with our own canvas renderer (Leaflet dependency deleted), GPU-warmup pre-uploads tile vertex buffers before reveal, freefall auto-recovery made spike-proof, fps cap default 60→120. Worst frames: 25–34ms with recurring spikes → ~12–16ms clean; min FPS 30 → 56.

- 2026-07-10 (physics, opt-in) — Rapier (WASM) physics behind ?physics=rapier: cannon-compatible car on DynamicRayCastVehicleController (fixed-step + interpolation), rapierWorldAdapter with per-shape streaming working set (220m), runtime-probed native heightfield terrain, pose-synced movers. Measured vs cannon: step ~1.0ms vs ~2.3, alloc ~0.12MB/frame vs ~0.32. Cannon stays default; see docs/context/rapier-physics.md.

- 2026-07-11 (title cinematic) — Title-screen orbit decoupled from the car spawn: the intro always flies over the classic city view (TITLE_ORBIT_LATLON, old Diagonal spawn) even when the car spawns elsewhere (current beach spawn). While the title is up, tile streaming follows the cinematic centre and the car's physics is fully frozen (carDriver.update gained a `freeze` param that skips the world step); after PLAY the stream snaps back to the car and physics stays frozen until getSurfaceHeightAt reports ground under it (12s cap). Orbit height re-samples loaded terrain per frame. Also: world-not-rendering regression after the worker edits was stale Vite cache/workers — fixed by server restart + cache clear, no code fault found.

- 2026-07-11 (draw calls, engine) — Global vegetation pools: solid trees, blob shadows and bushes now live in 3 shared cross-tile BatchedMeshes (new frontend/src/map/vegPools.js; getVegPools in meshMaterializer; tileManager adds per-tile instances via handles in Phase 3, releases on unload/abort, and drives per-tile LOD count-fades through handle.setVisibleCount with nearest-first id order). Replaces ~3 scene objects per resident tile (×2 with zone veg) — ~75–100 objects → 3. Billboard impostors remain per-tile (next candidate). Street display: removed uppercase transform, footway/path/cycleway fallback labels added.

- 2026-07-11 (title UI) — Mode picker redesigned as full-height character-select panels: portrait art cards (background-image /modes/mode-<key>.jpg layered over themed gradient placeholders), label + sub-line below the art, no emoji; logo shrinks via .choose class on PLAY. Tagline pill + dark PLAY button (coral moved to hover) for readability over the live city.

- 2026-07-11 (perf hotfix, veg pools) — Two BatchedMesh landmines defused in vegPools.js: (1) perObjectFrustumCulled/sortObjects OFF (three defaults do a per-INSTANCE matrix+sphere test and depth sort on the CPU every frame — ~40k instances across the 3 pools tanked FPS); (2) slot allocation is now pool-owned: NEVER bm.deleteInstance() — once BatchedMesh's internal freed list is non-empty, EVERY addInstance() sorts it (O(n log n) per instance → multi-second streaming stalls that worsen the longer you drive). Freed slots go to our own LIFO, hidden via setVisibleAt(false), recycled via setGeometryIdAt(). Symptom fixed: 18-23 fps dropping to 1-2 on fast turns after long sessions, with tiny measured frame costs (stall was in unprofiled streaming code).

- 2026-07-11 (title flow) — Mode-select loader: picking a mode now shows the boot-style % loader (#dd-modeload) until the world around the CAR is genuinely ready (car unfrozen + tile queue drained; 25s safety), fixing the empty-world/car-drop on first entry (the intro streams the CITY view, not the spawn area). Game-mode auto-start moved to this moment for the title flow (the old gate fired before the player picked). Title cinematic photo radius 5×5 → 3×3 (~1 GB → ~1/3 the resident world while idling on the title; framing unchanged — orbit looks at the centre).

- 2026-07-11 (draw calls, billboards) — Tree billboard impostors folded into the global pool system: 4 cross-tile BatchedMesh pools (one per variant material) replace up to 4 InstancedMeshes per resident tile. Billboard shader made batching-aware (USE_BATCHING → batchingMatrix, else instanceMatrix). Pool handles now carry their pool (h.pool); billboards add HIDDEN and are driven by the inverse LOD band (visible 500–800 m nearEdge) in the tileManager LOD pass. Vegetation now contributes a fixed 7 draw calls total (1 tree + 1 shadow + 1 bush + 4 billboard pools) regardless of tile count.

- 2026-07-11 (night look) — Night scene rebuilt toward the low-poly cinematic reference (rich navy + warm amber, not day-with-dark-sky and not grey): NIGHT rig in envToggle.js retuned (blue ambient 0x6b7a9e @1.0, dark blue hemi, soft moon 0.7 @0x8fa6d8, deep navy fog/bg, exposure 1.75→1.5, bloom 1.0/0.5); colorGradePass gained night branches — NO desaturation (rich saturated darks), blue hue-shift on shadows/mids, hard-amber warm highlights at night (1.14/1.02/0.85), stronger night vignette; streetlight ground pools widened 9→14 m with ~2× warmer sodium falloff. Iterated live with user: v1 too dark (pitch black), v2 still crushed, v3 grey — final keeps brightness from the rig and night-ness from the blue tint + warm/cool split. User-approved.

- 2026-07-11 (night polish) — Building window night-glow FIXED + hero towers: the live building path (worker → meshMaterializer.getFacadeMaterial) never had the emissive baked in — only buildingRenderer's legacy cache did — so windows NEVER lit at night. Emissive now baked into the materializer's facade materials (new setFacadeNightMode wired into envToggle's callbacks). Window mix warmed (70% warm yellow, cool white rare), lit share 16→20%, intensity 1.4→2.0. HERO buildings: buildingWorker tags ~1-in-7 buildings ≥28 m with a '#hero' facade variant — 62% all-warm windows at intensity 3.2 (the reference render's glowing tower); identical by day. Streetlight pools widened 9→14 m with ~2× warmer falloff (prev commit block).

- 2026-07-11 (night polish 2 + diagnostics) — (a) Billboard tree impostor colours now DERIVED from the live FOLIAGE_COLORS palette (albedo × warm-sun lift) instead of a stale hand-painted set, and the night tint retuned blue (0.24/0.28/0.44) to match the Lambert trees under the blue rig. (b) Hero warm ground-spill decals: buildingWorker emits heroSpills (centroid+radius per hero building); materializer renders them as one InstancedMesh/tile of soft amber radial decals, night-only (setHeroSpillNight in envToggle). (c) Bloom shaped: radius 0.4→0.15 (tight cores, no fuzzy orbs); night strength/threshold 0.55/0.72. (d) Shopfront/awning rows fixed: ground height quantized to 0.75 m steps (shared shopGroundY — kills up/down jitter across adjacent narrow buildings), max 4 segments per facade, deterministic ~35% skip (shared shopSegSkipped — storefront and awning skip together). (e) Build-overrun attribution: tileManager labels build phases; yieldToMain records budget overruns per phase; STATS panel shows a "build" line naming the phase behind "other" stalls.

- 2026-07-11 (night facade wash) — Replaced the every-building ground-spill discs (clipped on slopes, read as pale ghost circles — user-rejected) with the effect actually wanted: a warm ground-glow WASH on the lower floors of every facade at night. buildingWorker bakes per-vertex aWash (1 at base → 0 by 7 m) through mergeBufferSets (new optional 1-float 'wash' channel) → materializeGroup sets the attribute → facade materials add totalEmissiveRadiance += warm × vWash × uNightWash (0 by day, 0.22 night via setFacadeNightMode). Hero towers keep their (rare) ground-spill decal, now warm-tinted + lifted +0.42 above the sidewalk deck. Hero window density 62%→(kept), bloom radius 0.4→0.15, night bloom 0.55/0.72. Shopfront glass: single uniform band (no lower "entrance" pane).

- 2026-07-11 (night wash v2) — Facade wash toned down (0.22→0.09, height 7→4.5 m; whole facades were going gold) and EXTENDED TO ROADS: bakeRoadWash (roadRenderer) hashes building footprint outline points into a grid and bakes per-vertex aWash (1 − d/18 m) into road+sidewalk geometry at tile build (Phase 1, budgeted); shared road/sidewalk/panot materials patched with the same warm-emissive shader term behind one uniform (setRoadNightWash, wired in envToggle). Streets flanked by buildings glow with the facades at night; empty stretches fade smoothly to dark — exactly the user's "no building → no light" rule.

- 2026-07-11 (urban glow system) — The night wash is now one coherent building-proximity system: buildWashGrid/washAt (roadRenderer) shared by roads (per-vertex aWash; ALL shared road materials patched incl. the type-keyed footway/pedestrian set — the previously dark sidewalk strips), facades (0.05), and NEW: vegetation — per-instance wash stored in the BatchedMesh colour texture's unused ALPHA channel (vegPools.setWashAt; handles now carry sorted xs/zs), read in the tree/bush shaders via getBatchingColor().a behind setVegNightWash (0.12 night). Street trees glow softly with their street; park trees stay dark. Road wash 0.16→0.10. KNOWN/PARKED: overlapping co-planar road ribbons (footpaths crossing roads, promenade patches) are the road Z-layering debt in TODO.md — pre-existing, more visible at night.

- 2026-07-11 (bake Phase 1 — path clipping) — pathCoverageClipper.js (backend/worldBuilder/roads/): region-wide pass after simplify clips footway/path/cycleway/pedestrian/steps/track polylines out of same-layer carriageway coverage (per-point + mid-segment sampling, bisected boundaries, runs re-emitted with SAME id like tile splitting). Marked crossings (footway/cycleway/path=crossing, KEEP_TAGS extended) exempt + flagged `crossing:true` through all 5 gates; roadRenderer.createRoadMesh skips their ribbon (zebra decals unaffected, polyline preserved). No format bump (still v7). Eixample test bake: 2434 paths → 1113 clipped, 318 fully-covered dropped, 1154 runs; 101 tiles written, FloorValidator clean. Design: docs/context/bake-surface-clipping.md. Full region re-bake launched.

- 2026-07-11 (full re-bake, phase 1 live) — Full Barcelona region re-baked with the path-coverage clipper: 408 tiles / 669 s, FloorValidator clean. User-verified: path-over-road overlaps gone at street level; crossings render as zebra decals only. Remaining known: pedestrian AREA polygons (plazas) still overlap roads — polygon clipping folds into bake Phase 2 with the sidewalks. Hero window emissive 2.4→1.7 (heroes should read denser-lit, not brighter-per-window — 2.4 bloomed into yellow diamonds at night).

- 2026-07-11 (bake Phase 2 — v8 baked sidewalks) — Tile format v7→v8: sidewalkBaker.js (backend) pre-bakes the Phase-3 panot sidewalk + granite curb geometry per tile (faithful port of roadRenderer's buildSidewalks/buildCurbs incl. junction clipping, building-proximity gate, road-clamp pass; constants copied verbatim from barcelona-constants.js; skips road.crossing). Blobs (sidewalk/curbTop/curbFace, raw-DEM Y) ride a new bakedSidewalks binary section; tileParserWorker reads it; roadRenderer materializes via buildBakedSidewalkMeshes (same Y-normalization as bakedRoads) and falls back to the runtime generators for v7 tiles. Also: balcony rails/gates/AC fans/signboards lift to moonlit blue-grey at night (DETAIL_NIGHT_LIFT in setFacadeNightMode); hero window emissive → 1.7. Eixample test bake verified (v8 headers, blob counts sane, FloorValidator clean). NOTE: the sidewalk-port subagent was cut off by the account's monthly spend limit — file was delivered and independently verified.

- 2026-07-11 (night polish 3) — (a) Streetlight pools rebuilt: 256px computed inverse-square falloff with alpha dither (no banding rings), ADDITIVE blending (light adds onto the road instead of alpha-mixing grey), POOL_SIZE 14→18 m, POOL_Y_OFFSET 0.34→0.52 (pools were sliced by the sidewalk deck on lifted streets). (b) "Black patches" identified: PAINT_BLUE blue-zone stripes (zero red channel → pure black under the blue night rig) + dark bike-lane green; new setRoadDecalNightMode lifts both to moonlit variants at night (wired in envToggle). (c) baked v8 sidewalks verified in-game by user ("all ok").

- 2026-07-11 (day-look tuning) — (a) Roof palettes reworked twice with user against real Eixample aerials: TERRACE_ROOFS cool greys → warm sun-bleached sands (0xC9B18F family); clay tiles shifted from orange-yellow-brown to RED/PINK terracotta (0xA84E38/0xB25844/0x8A3A2A family + salmon 0xAE5F4C). (b) Overall facade warmth eased: DAY dirColor 0xffdcae→0xffe3c2, hemiGroundColor 0xd08a4e→0xc4966a (walls read too golden). (c) Streetlight pool placement compromise: POOL_Y_OFFSET 0.38, POOL_SIZE 16 (0.52 floated at tyre height at street level; flat plane vs slopes is inherent — smaller pool minimizes it).

- 2026-07-11 (peach palette, final round) — Roofs converged with user: mid-dark dusty PEACH terracotta (0xAD6B5C family, blue channel raised; day-approved). Night pink-cast countered by a night-only tint on the shared roof materials (_ROOF_NIGHT_TINT 0.9/0.97/0.78 in setFacadeNightMode; per-material _dayHex preserved). Facade walls: yellowest ochre entries eased toward neutral cream (both palettes). DAY rig also less golden (dirColor 0xffe3c2, hemiGround 0xc4966a). Spawn moved to central Eixample (41.3925, 2.1650) for the iteration.

- 2026-07-11 (day-look convergence, cont.) — Terrain shader palette rebalanced for RICH saturated green (G-dominant, R/B suppressed — uniform darkening had read as dimming); roof palette spread tightened around the approved mid-peach (deep entries were hitting maroon after per-building variation); FOLIAGE_COLORS ~×0.85 (day trees too bright; billboards derive automatically); facade ochres eased toward cream; roof night counter-tint via _ROOF_NIGHT_TINT.

- 2026-07-11 (stall fix: pool realloc) — Longtask forensics (new STATS build line: longtask count/max + GC heap-drop detection) identified the 60-130ms stalls: veg pools GROWING past their 16384 capacity in dense Eixample — BatchedMesh.setInstanceCount reallocates + fully re-uploads all data textures (60ms build chunk + 59ms rend spike, no GC signature). Pool capacities pre-sized above the working set (trees/shadows/bushes 28672, billboards 8192/variant). bakeRoadWash now async + frame-budgeted (was a 10-27ms single chunk per dense tile → 'p1 roads/terrain' overruns).

- 2026-07-11 (stall fix round 2) — Forensics named 'p3 veg-wash 55.2': the building-proximity wash itself. buildWashGrid outline points thinned to ≥5 m spacing (dense cells held 100+ points → ~900 distance checks per instance/vertex); wash loops now yield INSIDE big sets (veg per 512 instances, road meshes per 8192 verts). p3 vegetation 56.2 persisting likely = pre-reload pools still at 16384 — capacities now 28672 need a fresh session to apply.

- 2026-07-11 (stall fix round 3 — shader warm-up) — The 100ms+ spikes were REND frames (the veg-wash build tag was contaminated: overrun timer counts from frame start, so a chunk yielding after a 103ms render inherits the blame). Diagnosis: synchronous shader compile when a tile introduces a material variant unseen at boot (hero facades of late categories etc.). Fix: warmAllBuildingMaterials() pre-creates every facade category × hero + roof + detail material on tiny hidden triangles included in the boot compileAsync warm-up. Forensics line now also shows `prog +N` (shader program count delta) to catch any variant that still slips through.

- 2026-07-11 (stall fix round 4 — overflow pool sets) — Round-3 capture showed the capacity raise BACKFIRED: 28672 instances pushed the BatchedMesh matrices texture 256²(1MB)→512²(4MB), and streaming-frame uploads made cpu rend avg 37ms / alloc rend 4MB. vegPools now uses createVegPoolSet: FIXED 16384-cap pools; when full, a sibling pool spawns (one-time ~1ms) instead of in-place growth. Textures stay 1MB; handles route via h.pool so LOD/removal/wash unchanged. Draw cost: +1 per overflow pool (rare).

- 2026-07-11 (stall hunt CLOSED) — Final capture: cpu rend 37.4→3.4 avg, alloc rend 4.02→0.93, longtasks ×8 max 115ms → ×1 max 56ms (a single prog +1 first-appearance shader compile — once per session, low priority). The forensics chain that got here: cpuTimer 'other' bucket → build-phase overrun tags → longtask observer + GC heap-drop detector + shader program counter (all live in the STATS build line). Root causes fixed along the way: BatchedMesh per-instance culling, deleteInstance freed-list sort, pool growth realloc, 4MB texture threshold, wash-pass density, material variant warm-up.

- 2026-07-11 (runtime ground-layering table) — New frontend/src/map/groundLayers.js: ONE authoritative polygonOffset table for co-planar ground surfaces (terrain 0 → green −2 → road −4 → gore/chamfer −5 → sidewalk −6 → bikeLane −8 → tactile −10 → parkingZone −12 → marking −14 → crossing −16 → stencil −18; spaced by 2 for future insertions). Applied to ALL roadRenderer flat-decal materials (asphalt, panot, gores, chamfer fills, bike lanes, tactile, blue-zone/no-parking, merged markings + white/yellow lines, zona30 + bike pictograms now properly biased) and greensRenderer. Previously bikeLane/markings/tactile/bluezone/zona30 ALL collided at −2 → stacking was GPU luck. Rule: new flat surface ⇒ add a class, never hand-roll polygonOffset. Crosswalks currently share the marking material/layer. TODO.md layering research item satisfied at runtime level (bake v8 handles true overlaps).

- 2026-07-11 (draw audit, post-pools) — _drawAudit: 579 visible objects / 84 signatures. Top families: streetlights ~76 (6 IMs/tile — pole/arm/lamp/pool/shadow/wire), traffic lights ~42 (3 mats × tiles), per-tile Lambert+vc merges ~57 (awnings/shopfronts), facades ~35 (optimal per-tile floor), shopfront glass 14, pool sets fixed at 15. NEXT (task #33): pool streetlight + traffic-light families via createVegPoolSet → ~460 expected. Session ended here; branch ui-artofrally pushed (3 commits).

- 2026-07-11 (task #33 — light pooling) — Streetlight family (pole/arm/lamp/poolDecal/poleShadow/mirrorDisc/mirrorRim/mirrorBack) + traffic lights pooled via a tileManager adapter (poolLightIM): builders keep making per-tile IMs, adapter strips instance data into lazy createVegPoolSet pools (geometry/material taken from the first IM) and discards the meshes. Handles kind:'light' ride entry.vegPoolHandles (LOD/fog/unload free). vegPools: handles gained rawIds (addition order) + pool.setColorAt for the bridge tricolor cycler (re-registered in tileManager, self-unregisters via handle.dead). Fixed: junction mirror meshes leaked on unload (never entry-tracked). Wire mesh stays per-tile. Expected ~579→~460 draws.

- 2026-07-11 (billboard night tint) — LOD/billboard trees read pale mint at night (0.37/0.43/0.68 sprite tint over the brightened atlas). _applyBbNight now tints 0.22/0.28/0.40 — matches the 3D trees' night depth.

- 2026-07-11 (building wall anti-z-fight inset) — Adjacent OSM buildings share exactly coplanar lot-line walls → shimmer. buildingWorker now pulls every footprint inward by a deterministic per-building 1–4.5cm (deterministicIndex(b.id) % 8), each vertex moved toward the footprint centroid, clamped to 20% of its centroid distance so slivers never collapse. Applied once at loop start (b._insetApplied) so walls/roof/details stay consistent. Worker-side only — no re-bake needed.

- 2026-07-11 (RAPIER IS THE DEFAULT ENGINE) — Flip complete: main.js enables Rapier unless ?physics=cannon (escape hatch for one release; automatic cannon fallback if WASM init fails). Collision sound wired: chassis collider gets ActiveEvents.CONTACT_FORCE_EVENTS + solver-side threshold (~1.5 m/s), step() drains an EventQueue and dispatches cannon-shaped collide events (Δv = maxForce·dt/m) so carDriver's crash listener runs unchanged on both engines. eventQueue.free() in dispose. Remaining: delete the cannon step path after a release of soak. Docs: rapier-physics.md + CLAUDE.md TOC updated.

- 2026-07-11 (BAKED SKY-VISIBILITY AO — tile v9, the L3 unlock) — backend/worldBuilder/aoBaker.js bakes a per-tile 128×128 uint8 sky-view-factor grid (same indices as the elevation grid): 2.5D horizon sampling, 16 azimuths × 2m march to 60m, against a 2m building-height raster (occluders from tile + 8 neighbours → seamless canyons) + terrain self-shading. Verified: ASCII map of a core Eixample tile shows dark blocks / bright diagonal avenue / mid street canyons. Stored packed 4-per-u32 LSB-first (v9 header aoGrid). Runtime: aoSampler.js (bilinear world-XZ sampler + strength/gamma dials — pure svf in tiles, art curves at runtime so tuning needs NO re-bake). Consumers: terrain (aAO multiplier attribute in the palette shader), roads/sidewalks/curbs (bakeRoadWash extended — aAO darkening attribute, patchRoadWash multiplies; darkening semantics so missing attribute = no-op, never black), building facades (worker samples 2.5m outside the wall along its normal, 16m vertical fade; AO constants mirrored in buildingWorker.js — MUST MATCH aoSampler.js). NOT yet AO'd: greens/parks, road markings, building details. Full region re-baked.

- 2026-07-11 (AO round 2) — Round-1 screenshots: AO invisible in Eixample because green POLYGONS (verges/parks, most visible ground there) rendered bright over the darkened terrain. Greens materials now consume aAO (patchAoDarkening in aoSampler.js, filled via bakeRoadWash with AO_GREEN_STRENGTH); dials raised terrain/road/facade/green ≈ 0.5-0.55, gamma 1.35→1.2 (canyon ≈ 22% darker, plaza ≈ 3%). Runtime-only, no re-bake. Added ?ao=off perf escape hatch. FPS-drop report under investigation: GPU had 6.3ms headroom at 35fps → main-thread "other" (suspect thermal throttle post-bake / Rapier-default first session) — user A/B pending (cool-down, ?physics=cannon, ?ao=off). NIGHT mode is now the perf benchmark (user directive, see memory).

- 2026-07-11 (AO round 3 + frame-cap detector) — FPS mystery CLOSED by A/B: plain / ?physics=cannon / ?ao=off ALL pinned at 30fps with GPU ~60fps capable + tracked CPU ~7ms → external 30Hz frame-scheduling cap (Chrome Energy Saver / macOS Low Power Mode), NOT game code. STATS now detects it (FPS pinned 24-38 + gpu<12ms + cpu<12ms for 3 consecutive windows → "⚠ 30Hz cap? (browser/OS)" on the FPS line). AO night dial: ONE shared uAoScale uniform in all four AO shader sites (roads patchRoadWash, facades getFacadeMaterial, greens patchAoDarkening, terrain) — setAoNightScale wired into envToggle fireMaterialCallbacks, AO_NIGHT_SCALE=0.55 initial (night rig is dark already; full AO would crush canyon floors). Attributes stay baked — night tuning is one constant. Wash/AO build loop yields every 4095 verts (was 8191; 17-22ms chunks overrun a 60fps budget).

- 2026-07-11 (beaches + pedestrian plazas RENDER — L4 content) — New frontend/src/map/areaFeaturesRenderer.js consumes the two v7 area features that were parsed-but-dropped since May: beaches (53 polys / 23 coastal tiles — sand with grain mottle) and pedestrianAreas (807 polys / 169 tiles — plaza paving). Terrain-following flat polygons mirroring greensRenderer's lifecycle exactly (appended to entry.greenMeshes → streaming/unload/disposal shared; per-tile materials, shared programs). Both take baked AO (patchAoDarkening + the greens aAO fill). New ground-layer classes: beach −3 (beats greens at the coast), pedArea −3.4 (over greens/beach, UNDER roads — conservative until plaza/road overlaps are reviewed on-screen). Marinas already rendered as water (no change). Palette tuned mid-dark for the ×1.52 grade. Awaiting user screenshots: Barceloneta coast + a Gothic plaza.

- 2026-07-11 (night title fog fix) — Title cinematic hardcoded DAY sky-blues (sky dome stops + fog 0x9fd0f2, landing sweep 0x62b4f0) regardless of mode → at night the aerial read as a frosted pale band cutting the dark skyline. Both sites now branch on envToggle.isNight(): night gets deep-navy sky stops (0x16263f/0x0e1a30/0x070f1f) + navy fog 0x131f36, and the landing sweep lerps to the captured pre-title night fog (_titleSky.f) so the descent stays nocturnal.

- 2026-07-11 (coast = terrain-painted beach + sea) — Barceloneta showed neither sand nor water: the open sea has NO OSM water polygon (only enclosed basins; the global ocean plane was reverted earlier), and flat beach meshes get buried under sloping terrain. Coast is now painted INTO the terrain colour pass (user's suggestion): sand inside natural=beach polygons (wet blend toward the waterline), deep Mediterranean blue where raw DEM ≤ 0.15m (SRTM bakes open sea at 0), partial wet-grey on non-beach waterlines. New aCoast vertex attribute masks the procedural green shader + dirt-amplify off coast vertices. Gated on tile min elevation ≤ sea level or beach polys present, so inland lowland never triggers. Beach flat meshes removed from tileManager (areaFeaturesRenderer still used for plazas). Note: DEM box-blur mixes shore heights, so expect a gradual wet band before deep blue — screenshot check pending.

- 2026-07-11 (auto-beach band + map coast v2) — 3D: OSM beach polys are too sparse (user report: whole coastal strips green), so the terrain coast pass now ALSO paints sand on any land < 2.2m raw within ~16m of open sea (5-pass sea-distance dilation over the elevation grid) — beach polys remain the strong signal, the band fills the gaps. MAP: the fullscreen/mini map's hand-traced 8-point sea polygon cut ACROSS the Barceloneta peninsula (sea over streets) — replaced with a 19-point trace that follows the beaches, wraps the W-hotel spit, and hugs the outer port breakwater. Beaches now DRAW on the map (sand fill under parks/water): citymap.bin bumped to v2 (+beaches channel, regenerated — 50 polys), lite parser packs bCoords, full ingest reads tileData.beaches (threaded through tileManager). Older v1 citymap files still parse.

- 2026-07-11 (tall towers = glass) — ≥55m buildings (or building:material=glass/mirror) now categorize as commercial_glass in BOTH buildingWorker and buildingRenderer (must match — LOD boundary would flip materials otherwise); churches/cathedrals exempt (Sagrada Família stays stone). The glass pipeline already existed end-to-end (Phong curtain-wall material, big-pane window texture, cool blue-grey palettes, warm-up list) — towers just never classified into it. Torre Mapfre / Hotel Arts / Agbar go glass. Also: coastline.js is now the single sea source for map + 3D terrain (DEM bakes open sea at 2-5.8m — measured, unusable); sand band ~20m along the trace; wet blend by shore distance.

- 2026-07-11 (coast v3: REAL OSM coastline + tower/night polish batch) — The hand trace flooded Vila Olímpica (300m off). Discovery: baked tiles already carry natural=coastline polylines in the water section — coastline.js now stitches them into the mainland chain on first tile ingest (endpoint matching, seaward-side closure verified by offshore-point test, 64m segment hash grid) and REPLACES the hand trace for both 3D and map (coastVersion invalidates caches). coastSample(wx,wz) = one grid query → {sea, dist}: near shore the nearest-segment SIDE decides exactly, far field a coarse polygon. Waterline now BLENDS wet-sand→sea over the first 10m of water (was a per-vertex sawtooth — user report). Night/tower batch: hero windows 0.5→0.32 lit + intensity 1.7→1.45 (blazing yellow wall report); commercial_glass texture → full-glass Agbar mosaic (dense panes, cool blues + rare warm accents, near-white tints so the texture carries colour); water towers (type water_tower via man_made/building tag — NEEDS RE-BAKE) get bespoke Torre-de-les-Aigües geometry (brick shaft, cream drum, terracotta spire → roof bucket); motorway/trunk edge strips REMOVED (read as broad black lines on Ronda Litoral). Tower curvature follows OSM footprints naturally (round Agbar, square Mapfre).

- 2026-07-11 (railways OFF + water-tower shape heuristic + soft sand edges) — The persistent "black border lines" along the Rondas were the MAINLINE RAILWAY ballast ribbons (coastal rail corridor), not road edge strips: CONFIG.ENABLE_RAILWAYS existed (false) but the tileManager call site never checked it — now gated (trams unaffected). Water towers: the bake's water_tower type only catches 2 citywide (Barceloneta's beach towers are untagged `generic` — measured), so the bespoke silhouette also triggers by SHAPE: generic/industrial, footprint radius ≤5.5m, height ≥16m, aspect ≥2:1. Sand→grass edge softened (5-point coverage on beach polys, noise-jittered 8m fade on the shore band). Billboards → Spanish/Catalan parody brands. Full re-bake done (FloorValidator ✅).

- 2026-07-11 (water tower v2 + Agbar bullet crowns) — The white stilt tank the user spotted was a SECOND water-tower system: urbanFeatureRenderer.buildWaterTower (Delhi-era American prop at man_made=water_tower POINTS) — rewritten to the same Torre de les Aigües silhouette as the building path. Spire de-pointed both places (0.26H sharp cone → 0.17H truncated + blunt finial). NEW: bullet towers — a deterministic third of ≥60m glass towers (and all round-footprint ones) get an Agbar-style revolve (near-cylindrical to 55% height → rounded converging crown, proper facade UVs so the mosaic wraps; flat roof skipped — the crown closes itself). Rest stay rectangular slabs per user's "some curved, some rectangles".

- 2026-07-11 (world boundary + slab colour + pulsing beacons) — NEW worldBoundary.js: (1) four noise-wobbled haze CURTAINS just inside the region bbox (vertical fade, colour tracks scene fog for day/night; in the mirrored worldGroup with absolute world coords like tile meshes); (2) out-of-bounds return: main.js fires carDriver.recoverToCrumb() when the car pushes >45m past the curtains — the breadcrumb is now gated in-bounds (carDriver opts.isCrumbSafe), so you land back on the last road ("typical game thing" — user). The "black border lines" mystery FINALLY closed: it was the bridge/elevated SLAB side faces (0x706b66 unlit) — now concrete grey 0xa9a49d (edge strips and railways were ruled out first). Tower beacons: updateTowerBeacons now BREATHES (smooth ~2.6s glow-dim, never fully off — was hard 1s blink) and both water-tower systems carry a finial beacon (urbanFeature prop directly; worker towers emit beaconPoints → materializer spawns shared-material spheres).

- 2026-07-11 (black lines SOLVED + bullet parapets) — The persistent "black border lines" (user ×4) were buildBridgeShadowMesh: FAKE 45%-black shadow ribbons painted at ground level under every elevated road, drifting off-target on slopes. Disabled (mesh = null; builder kept for a future sun-projected version). Full culprit hunt for the record: highway edge strips (removed), railway ballast (gated off), slab side faces (lightened to concrete), bridge fake shadows (the actual one). Bullet towers: commercial parapet/bar detail pass skipped (frames traced the rectangular footprint at full height → floated around the converged crown).

- 2026-07-11 (boundary respawn-loop fix + _identify) — The "keep respawning in car mode" report was the v1 boundary check: physics→lat/lon conversion skipped the ORIGIN OFFSET (HUD convention is worldWx = −lx + originOffset.x, main.js:872) so the whole city measured out-of-bounds and the teleport looped on its 2.5s cooldown. worldBoundary now takes ABSOLUTE world coords; main.js + isCrumbSafe convert with the offset. NEW dev tool window._identify(): click any surface → console logs mesh type/userData/material/renderOrder — added after FOUR look-alike "dark band" systems proved that naming beats guessing; the remaining dark road-edge rectangles (user report #5) get identified with one click next session.

- 2026-07-12 (trench-wall bands + wedge recovery + throttle re-diagnosis) — The "dark border lines" (user ×5): NOT a mesh at all — the Rondas run in CARVED TRENCHES (Option L daylighted corridors) and their steep terrain walls flank the carriageways; baked AO (terrain self-shading) + side-on Lambert made them read as chocolate bands with square portal ends. Terrain AO is now SLOPE-SCALED (vertical faces get ~35% of the AO; flat ground unchanged). Wedge auto-recovery: ≤1 wheel down + <2km/h sustained 3s → breadcrumb teleport (nose-dives into flyover-merge collider seams — user report). Frame throttle: user ruled out Energy Saver/LPM/battery → remaining suspect is thermal compositor throttling (55-60fps after cooldown vs 22-35 hot, machine otherwise idle); STATS label corrected, decisive blank-tab rAF test given to user. Veg-pool capacity race fixed earlier same day.

- 2026-07-12 (boundary curtain proximity fade) — The "whitish flashing blur near water" was the world-edge haze curtain: at the Barceloneta coast the SOUTH boundary curtain (110m tall, map-wide, noise-animated) sat 2.4km ahead and read as a giant flashing white horizon wall through day fog. New uNear uniform: curtains fade in only within ~400m of the boundary (full at 60m), smoothed at ~250ms. FPS forensics converged meanwhile: blank-tab rAF 60 vs game-tab rAF 37-49 while driving + [Violation] rAF-handler ×26 + build chunks over budget (p2 buildings 28ms, p1 road-wash 23.9ms) → the cap is OUR between-frame/oversized chunk work missing vsync, NOT browser settings/thermals. Night-first chunk-splitting pass is the queued fix (task #39); STATS label to be re-worded once that lands.

- 2026-07-12 (collision debug excludes buildings) — K key / ?debug=collision toggle (already existed) now skips building collider bodies (tagged body._ddKind='building' in buildBuildingColliders) — shows walls/guardrails/poles/decks/trees only, per user. HUD prism/box counts drop accordingly.

- 2026-07-12 (frame-pipeline fix, round 1 — task #39) — Attacking the measured vsync-missers (fps-diagnosis): (1) NEW mergeGeometriesChunked in tileManager — mergeMeshesByMaterial's per-bucket sync mergeGeometries (20-36ms on the road family) now copies geometry-by-geometry with budget yields AND pre-computes boundingBox/Sphere (kills three's lazy sync computeBoundingSphere on first render of 100k-vert merges); sync merge kept as fallback for exotic layouts. (2) Physics adds yield after EVERY body (was every 4-8) — one multi-shape building body's AABB recompute can alone eat several ms; yieldToMain is a no-op under budget. (3) Glass-tower Phong specular softened 0x8899AA/60 → 0x2e3a44/22 (giant sun streak on curved bullet towers at grazing angles — user). NEXT if p1 roads/terrain still spikes: CANNON.Trimesh ctor builds its AABB tree synchronously (~30k tris) and Rapier mode never steps cannon — candidate for bypass.

- 2026-07-12 (haze curtains disabled + round-2 perf prep) — Boundary curtains OFF (suspected cause of the fly-mode "giant white circle", day+night: curtains carry ABSOLUTE world coords inside worldGroup which ALSO applies the floating-origin offset → likely displaced into the map; the moon's 900m glow sprite at a fixed near-spawn position is the night-only suspect if the blur survives). Out-of-bounds teleport unaffected. Round-1 pipeline results measured: p1 roads/terrain 36.3→23.7, p2 buildings 28→13.8, road-wash 24→17, streaming FPS 37-40→47. Round 2 queued: road-wash yields 4095→2047 (done), CANNON.Trimesh BVH stub under Rapier (cannon never steps; no cannon raycasts anywhere — verified), traffic alloc hunt (~1MB/frame — ask user for a 20s DevTools allocation sample).

- 2026-07-12 (the white blob = THE MOON) — The fly/photo-mode "giant white circle" (day report was fog/curtains, both since fixed/removed): the moon disc + 900m glow sprite sat at a near-FIXED world position 8km SE of spawn with only a 2% parallax follow (and fed world-frame coords while the sprites live in the scene frame) — photo mode's multi-km travel let the camera fly right up to the glow texture = screen-filling white blob, occludable by towers (user shot). updateMoon now anchors both sprites a full 8km from the CAMERA every frame (camera scene-frame coords, not viewerWx — X-mirror mismatch), so the moon is properly celestial and unreachable.

- 2026-07-12 (white blob FINAL: it was the CLOUDS) — Survived hard refresh → not curtains (disabled), not moon (anchored), not fog (alt-faded). The cloud rings re-center on the viewer (updateClouds parallax) starting at ~1.1km / y 300-1000m — photo/fly mode climbs INTO the ring and a 230-380m billboard quad at point-blank fills the screen (explains every capture: straight quad edge in day shot, tower occlusion, day+night, worst over the open sea). Cloud shader now fades instances by view distance: gone ≤350m, untouched ≥850m. Normal ground gameplay unchanged (nearest ring ~1.1km).

- 2026-07-12 (white blob TRULY solved: NaN normals × slope-AO) — _findWhiteTiles() named it: 4 sea tiles (33168-33171_24479) each with aAO NaN×~128 = ONE grid edge row. Baked sea tiles carry one seam row of NaN NORMALS (degenerate flat triangles); the slope-scaled AO read normAttr.getY without a finite guard → Math.max(0,NaN)=NaN → poisoned aAO → NaN renders WHITE → a 2km glowing wall over the sea (the "white blob" at every ocean-facing angle; cloud proximity fade from earlier round was a real but separate improvement). Fix: finite-guard the normal read, sanitize the NaN normal to (0,1,0) in-place (NaN normals also corrupt Lambert), and a final finite check on the attribute write. Verification: reload → _findWhiteTiles() should print "none suspicious".

- 2026-07-12 (frame-pipeline round 2a: cannon BVH stub) — Under Rapier (the default), CANNON.Trimesh.prototype.updateTree is stubbed at init: cannon never steps or raycasts (verified: zero cannon raycast call sites), so the octree built synchronously in every Trimesh ctor (terrain physics trimesh ~32k tris + every road-deck trimesh, per streaming tile) was pure main-thread waste — a chunk of the residual p1 roads/terrain 23.7ms. AABB/boundingSphere are vertex-scan-based (tree-independent) → addBody + Rapier mirror unaffected; ?physics=cannon keeps real trees. Road-wash yields also at 2047 now. NEXT MEASURE: fresh STATS build tags while streaming; remaining suspects if p1 still >10ms: CANNON.Trimesh updateEdges/updateNormals (also O(n) ctor work), traffic ~1MB/frame alloc (user to run a 20s DevTools allocation sample).

- 2026-07-12 (round 2b: cannon narrowphase churn killed under Rapier) — User's 20s allocation sample: traffic EXONERATED; real allocators = mapLoader tile receive 11.9MB (parked — needs typed-array parser output, big surgery) and cannon BUILDING-COLLIDER construction ~17MB (makeCheapBox 11.7 + addShape 3.5 + ConvexPolyhedron churn) — also the likely body of the stubborn p2-buildings ~28ms chunk. Fixes: under Rapier, Trimesh.updateEdges/updateNormals stubbed (with updateTree) and Box.updateConvexPolyhedronRepresentation stubbed; makeCheapBox returns a native CANNON.Box (halfExtents only — adapter's cheapest cuboid path) instead of the 8-Vec3 CheapBox, which remains the ?physics=cannon path. window._ddRapierActive gates it. Next measure: p2 buildings tag + parked-idle FPS (GC pressure should drop hard).

- 2026-07-12 (round 2c: sliced merges + finer wash yields) — Sub-attribution named the residuals: p1 merge 41.8 (one 60k-vert source copied+bbox-scanned in one span — now sliced ≤16k verts with yields, index remap yields every 32k), p1 road-wash 29.9 (dense-area washAt ≈900 checks/vert — yields now every 1023 verts), p1 physics 28.3 (heightfield/trimesh construction — NEXT: chunk buildTerrainHeightfield's 16k nested-array build; needs async plumbing through createTerrainTrimesh), p1 roadgen 18.1 (internal road builders — next tier). Also observed: worst rend 39.4 spike = first-render VBO upload of giant merged mesh (warmup timing); GPU 24.2ms at speed (motion blur — GPU-bound, night-pass scope). Gran Via tunnel is pitch black inside — interior lighting queued as polish.

- 2026-07-12 (round 2d: adaptive GPU warmup + attribution correction) — The "p1 physics 103.9" tag was CONTAMINATED by the same frame's rend 102.6 (the overrun timer counts from frame start — second time this note mattered): the real monster is a 100ms first-render VBO/texture UPLOAD burst when a fresh tile's meshes hit the frustum before the 3/frame warmup drain finishes. gpuWarmup now drains adaptively (backlog >12 → 5/frame, >24 → 8/frame). Also learned: createTerrainTrimesh is DORMANT (terrain physics = heightfield; the 'p1 physics' window is deck colliders + heightfield only). Round 2c verified in captures: p1 merge + p1 road-wash GONE from tags. Remaining named tier: p1 roadgen 38.2 (roadRenderer INTERNAL sync merges — route through a shared chunked merge next), p2 buildings ~26, p3 veg-wash 14.9 / p4 grass 21.9.

- 2026-07-12 (round 2e: minimap + veg-wash) — Post-2d captures: rend-100ms monsters GONE (adaptive warmup confirmed). New finding: worst ui 10.1ms / alloc ui 1.21MB at 99km/h = the circular minimap's retina vector redraw (~5×/s at speed, drawing building footprints invisible at 180px). Fixes: redraw min-interval 180ms + drawTile noBuilds flag (small map skips footprints; expanded map full detail). Veg-wash yields 511→255. Remaining tier (fps-diagnosis memory updated): p4 grass/detail 22-38 (now largest), p1 roadgen 26.5 (internal merges → shared chunked util), p2 buildings 25 (double NaN scan), p1 physics 17-19 (heightfield nested arrays), stray 167ms longtask (GC suspect), GPU 24.8ms at speed in tree areas (night-pass scope).

- 2026-07-12 (round 3 — the full remaining list in one batch) — (1) p1 roadgen: mergeGeometriesChunked extracted to shared chunkedMerge.js; SEVEN roadRenderer internal family merges (markings, crosswalks, oneway arrows, sidewalks, curbs, bike lanes, no-parking, blue-zone) now async + frame-budgeted via mergeBudgeted(). (2) p2 buildings: materializer marks meshes _nanChecked → safeSceneAdd skips its duplicate full-position NaN re-scan; materializer yields every group (budget-gated). (3) p1 physics: buildTerrainHeightfield async — yields every 16 columns, stats pass folded into the build loop (was a 2nd full 16k scan). (4) p4: SUB-ATTRIBUTED (p4 barriers/infra/urban/vendor/decals/grass) — grass materialization proven zero-copy-cheap, so next capture names which sync generator owns the 22-38ms. (5) Round 2e minimap/veg-wash included. VERIFY: one dense drive → expect p1 roadgen/physics + p2 buildings to shrink/vanish; whatever p4 sub-tag surfaces is the next (and likely last) CPU target before the night GPU pass.

- 2026-07-12 (round 4) — p4 attribution paid off: 'p4 urban 39.6' named buildUrbanFeatureMeshes → now async, yields per feature (nearest-road scan + placement adjust were the per-feature cost) and between material merges. p4 water/props/clusters sub-labelled with yields between (covers the residual 'p4 grass/detail 15.5' span). p1 roadgen residual (~12): per-layer ribbon merge budgeted + yields threaded between the remaining sync builders (sidewalk/edge, pictograms, zona30, tactile, pillars, slabs, guard rails, blend strip). STATS throttle label reworded: "frames missing vsync (streaming?)" (was "browser throttled (thermal?)" — misattributed).

- 2026-07-12 (round 5 — the untagged 'other' spike) — worst frames showed other 20-32ms with no matching build tag: it was the tile-parser worker's gameplay result arriving as ONE structured-clone message (the parked mapLoader 11.9MB finding) — deserialize runs in the message task, invisible to build tags. Fix: tileParserWorker postResult now splits heavy top-level sections (roads/buildings/water/greens/baked*/elevation/aoGrid/…) into separate messages, chunking roads+buildings into 150-item slices; mapLoader reassembles parts and resolves on the final message. Each part deserializes in its own task so rAF interleaves. Packed/lite path unchanged. Also: roadgen ribbon-loop ROAD_BATCH 25→8 (the stubborn 'p1 roadgen ~11' tag).

- 2026-07-15 (dark outer-road bands — both culprits named via _identify) — User sign-offs: coast ✅, towers ✅, AO day+night (#38) ✅; #40 deferred. The remaining "dark patch on the outer edge of roads" was TWO systems: (1) tunnelFloorSimple — buildTunnelFloor rendered its dark Lambert deck (road halfW + WALL_EXTRA_WIDTH 1m) under daylighted corridors that ALREADY get the full painted ribbon from roadRenderer, so only the 1m-proud edges showed → deck now skipped for layer<0 roads (mirrors roadRenderer's tunnel-paint guard; covered tunnels keep it; physics colliders in tileManager untouched). (2) bridgeSlab REGRESSION — setGuardRailNightMode's day branch reset sharedSlabMaterial to the old 0x706b66 "black border line" grey on the first day/night toggle, undoing the documented 0xa9a49d fix → day branch now 0xa9a49d.

- 2026-07-15 (streetlights on daylighted expressways) — User asked why trench highways (Rondas) have no streetlights: streetlightRenderer had the same Delhi-era `if (road.tunnel) continue;` guard already fixed for road paint — daylighted corridors (tunnel && layer<0) were skipped as "inside tunnels". Guard now matches roadRenderer's tunnel-paint condition (covered tunnels still excluded). Two supporting fixes: under-bridge pole skip widened from layer===0 to layer<=0 (trench roads run under crossesTrench overpasses), and buildBridgeSegments now counts crossesTrench streets as overhead bridges (they're bridge-dressed but not road.bridge and sit at layer 0).

- 2026-07-15 (round 6 — verification drive read + two targeted fixes) — User's night Eixample STATS drive shows round 5 NOT fully landed: worst 'other' still 20-25ms (no tag), 'p1 roadgen' still ~13, GPU healthy 11.6-11.8ms. Diagnosis: (a) PART_CHUNK 150 was still a fat clone — each road carries hundreds of {x,y,elevation} POINT OBJECTS, so a 150-road slice deserializes 10-20ms; now 30 (same total cost, ~1-4ms per task so rAF interleaves). (b) 'p1 roadgen' 13ms is NOT the round-5 ROAD_BATCH loop — v9 tiles take the BAKED-ribbons path; sub-attribution added: options.buildPhase threaded into renderTileRoads, 16 'p1 rg:*' sub-tags (baked-ribbons/markings/sidewalk-edge/crosswalks/oneway/bcn-sidewalk/bikelanes/bike-picto/noparking/zona30/tactile/bluezone/pillars/slab/guardrail/blend-strip/billboards) so the next capture names the sync culprit; plus a per-layer yield in the baked loop (applyRoadVertexColors is a full sync vertex pass). NEXT: one more STATS drive → expect 'other' gone; whichever 'p1 rg:*' tag surfaces gets the targeted fix.

- 2026-07-16 (round 7 — sub-attribution paid, LoAF observer added) — Round-6 captures: 'p1 rg:crosswalks 12.3' NAMED (sub-tags worked); worst 'other' STILL 28-35ms even at PART_CHUNK 30 → clone theory now suspect, stop guessing: performancePanel gained a Long-Animation-Frame observer (Chrome 123+) — any frame >25ms is console.warn'd with per-script attribution (file:invoker + ms, plus 'unattr' = GC/clone/style residue) and the window's worst lands in the STATS build line as `loaf`. Fixes shipped with it: buildCrosswalks now yields every 16 roads (its road loop was one sync span — height interpolation + ribbon per stripe, both junction ends, nearly every Eixample road); urbanFeatureRenderer per-material merge routed through mergeGeometriesChunked ('p4 urban 15.4' residual = the raw sync mergeGeometries, per-feature yields were already there). p1 physics 13.3 left pending LoAF naming. NEXT drive: read the `loaf` line / [loaf] console lines — they name the 'other' definitively.

- 2026-07-16 (round 8 — LoAF named it: our own build chunks, and markings was the monster) — LoAF capture: `loaf 89ms main.js:FrameRequestCallback 72` = the 'other' time is build-chunk continuations resuming as microtasks INSIDE the rAF task (never was worker-clone); same window tagged `p1 rg:markings 70.9` (densest tile) / 11.9 steady. Cause: buildRoadMarkings' GENERATION loop was fully sync (round 3 only budgeted its merge) — per road: clip vs all junctions, per-lane offset polylines, geometry per dash. Fix: yield every 8 roads + every 256 geoms in the vertex-color loops. Also seen: `p2 buildings 17.9` resurfaced (watch next capture), stationary ped-area stalls other 25-28 with NO tag/loaf in-window (GPU 14.5ms there — night-pass scope). Levers if 'other' persists: max-one-defer resume in yieldToMain (all waiting chunks currently resume on the SAME rAF and stack), then GC.

- 2026-07-16 (round 9 — the stacking guard) — Round-8 verified: markings 70.9 → 12.7. But ALL tags now sit in one 13-17ms band (physics 16.9 / urban 13.2 / markings 12.7 / crosswalks 15.6) = the stacking signature: every yielded chunk resumed on the SAME next rAF; microtasks drain between rAF callbacks so each chunk's span ran back-to-back in one frame, and the last to yield got blamed with the cumulative elapsed. Fix: yieldToMain's resume now re-checks the shared frame budget on wake — if already spent (an earlier chunk ran), it sleeps ONE more frame (max one defer, so builds can't starve). getJunctionPoints checked and exonerated (endpoints-only, cheap). Also seen: a 46ms worst frame where LoAF's top script was only 13ms (unattr ~40ms — GC suspect; watch [loaf] console lines' unattr number). GPU 13-13.6ms at speed at night with motion blur — night-pass scope.

- 2026-07-16 (Y-layering audit — the double-lift, buried paint, floating pools, merge falls) — Full audit of the road Y stack after user reports (floating lane marks, invisible oneway arrows, floating light pools, cars falling at flyover merges). ROOT CAUSE: roadBaker bakes +ROAD_VISUAL_ABOVE_TERRAIN(0.05)+ROAD_ZFIGHT_OFFSET(0.02)+priority bump into ribbon vertices, but the frontend baked-path translate ALSO added +RVAT (it believed the bake skipped it — sidewalkBaker's convention, not roadBaker's) → road surface at base+0.12+bump. Consequences, all fixed frontend-only (NO re-bake): (1) translate now adds only −bakedOffset → surface base+0.07+bump; car looks less sunk (~5cm), road-over-terrain edge gap halves, curbs read full height. (2) ALL paint retuned to the real surface (was: arrows/pictos/zona30 3.5-4.5cm BURIED, lane lines/crosswalks in z-fight): MARKING 0.06→0.03, CROSSWALK 0.055→0.025, ARROW 0.035→0.045, PICTO 0.03→0.045, ZONA30 0.04→0.045, STRIPE 0.04→0.035 (buildFlatRibbonGeometry adds a hidden +0.02 — documented at MARKING_Y_ABOVE_ROAD). (3) POOL_Y_OFFSET 0.38→0.22 (was ~26cm over the road; still clears sidewalk tops at base+0.19). (4) Deck-collider merge clip (max(1.5, dist−otherHalfW)) now only applies within 1.5m of ground +0.5m overlap margin — clipping a HIGH deck was the fall-through (visual deck full-width + ramp-divergence shifts ~2.4m laterally; collider followed neither). Bake-side cleanup (remove RVAT+RZO from roadBaker for one uniform convention) optional later — requires re-bake + paint retune to base+0.05+bump.

- 2026-07-16 (mobile polish + cannon car deleted) — Phone-landscape feedback pass: (1) index.html compact media query (max-height 560px) for the loading + title screens (logo height-capped 38vh, tighter gaps/fonts/boot counter). (2) Minimap + speedometer COMPACT mode on touch devices: scale 0.62/0.6 anchored to their corners and RAISED above the touch clusters (metrics mirror touchControls' clamp(56px,12vmin,92px) buttons); minimap's expand/collapse restores the compact inline styles. (3) Touch clusters inset to max(safe-area-inset, 24px)+20px so iPhone notch/Dynamic Island can't overlap; keyboard hint strip hidden on touch. (4) CANNON CAR DELETED after Rapier release soak: createCarPhysics (360-line RaycastVehicle) removed, carPhysics.js is now just getCarContactMaterials (tileManager brands bodies with it), carDriver requires opts.rapier, main.js ?physics=cannon escape hatch removed (Rapier init failure → outer catch → free camera). cannon-es STAYS as the collider descriptor layer (tileManager CANNON bodies → rapierWorldAdapter mirror); Trimesh/Box ctor stubs unchanged. physicsBench kept (dev-only, not in build).

- 2026-08-24 (v2 target audit — ETS2 aesthetic feasibility, browser-only) — User question: treat current build as v1; can v2 reach a Euro Truck Simulator 2 look (their trees not our polygon blobs, their building treatment, cleaner/refined) in a browser on desktop with proper optimisation? Full audit written to docs/context/ets2-target-audit.md (TOC + domain pointer added to CLAUDE.md). HEADLINE FINDING: **the gap is an ASSET gap, not a tech gap.** Measured: ZERO normal/roughness/metalness maps anywhere in the environment (only the car GLB has one); 172 of 218 materials are diffuse-only (94 Lambert + 78 Basic); trees are Cylinder(3 seg) + Icosahedron(detail 0) = 20-tri solid blobs ×128k; buildings are extruded OSM footprints with CANVAS-DRAWN window textures; entire env texture library = grass.png + a grass/bush GLB set; loaders.js is a bare GLTFLoader (no KTX2/Draco/Meshopt). Our lighting/atmosphere (aerial-perspective fog, baked sky AO, ACES, warm-key rig) is already the sophisticated part — you cannot grade or light your way to ETS2 from here. Effort split ≈70% art sourcing / 30% engineering. VERDICT: ~65-75% of the ETS2 vibe is reachable on desktop browser; what isn't is texel density + prop variety across a 1:1 city (ETS2's world is ~1:19 HAND-CURATED — that's why they can afford 8k-tri buildings in frame). So v2 = ETS2 fidelity in a ~150m bubble degrading hard past it, which is what the existing LOD+fog architecture already does. Also corrected the record on SSAO: the GTAO failure was structural (depth+normal prepass bolted onto a FORWARD pipeline at 4M tris), not fundamental — a depth prepass with early-Z largely pays for itself, so AO is re-attemptable as a pipeline redesign (the rendering.md warning still stands for the naive approach). Texture-budget maths says the download wall is further than feared: KTX2/Basis + ORM packing puts a full art library at ~25-30MB / ~15-20MB VRAM, so the binding constraint returns to draw calls (~790 of a ~1000-2000 ceiling) and 1:1 city scale. USER DECISIONS THIS SESSION: (a) **it stays a web browser game** — recorded as §0 binding constraints (no proposal may trade zero-install delivery for fidelity; ~30MB art budget; atlas+instance everything; never 4K; desktop-first but must scale down not exclude mobile); (b) **assets must be FREE**, AI-generation of our own is acceptable → §6 hybrid strategy: CC0 photoscans (Poly Haven / ambientCG / Kenney / Quaternius) for all tiling surfaces because they ship TRUE normal/rough maps, AI (Draw Things on Mac, tiling mode ON) only for the Barcelona-specific things no free library has (Eixample facade sheets, panot tile, signage) — with the caveat that AI generates albedo only and derived-from-luminance normals are physically fake (fine for asphalt/plaster/brick, wrong for painted lines/signage). Trees get their own free Blender pipeline (Sapling Tree Gen → ortho-render a high-detail leaf cluster → BAKE its normal from the high-poly → cross-plane cards → existing billboard LOD), targeting the pollarded London plane (Platanus × acerifolia) silhouette that defines Barcelona streets. Roadmap = Tier 0 prerequisites (KTX2/Meshopt in loaders.js, shared PBR material library, migrate env off Lambert/Basic) → Tier 1 big jumps (trees, normal-mapped asphalt, facade sets) → Tier 2 catch-up (CSM — the single 1024/±85m map is what most reads "web demo", depth-prepass+SSAO, scene-wide IBL, SMAA+sharpen) → Tier 3 density (street furniture, roof forms, wet-road/weather). GATE: a one-block Eixample vertical slice (wire KTX2, ~6 assets, convert to PBR, measure FPS day+NIGHT / draws / tris / heap / MB downloaded / shader stalls) before committing to the full library — one week replaces every estimate with real numbers. NOTE for v2 facade work: buildings are WORKER-generated (buildingWorker.js + meshMaterializer.js); map/buildingRenderer.js is NOT the geometry path.

- 2026-08-24 (v2 audit HARDENED by 12-agent adversarial cross-examination — 12 claims refuted, 38 cross-domain contradictions) — Ran 5 independent domain investigations (render pipeline / perf budget / vegetation / buildings / asset pipeline) → 5 hostile cross-examinations where each domain was challenged by an examiner who owned a DIFFERENT domain and held all five reports → completeness critique → synthesis. Output: docs/context/v2-plan-hardened.md (WINS over ets2-target-audit.md wherever they disagree; audit got a correction banner). WHAT WAS REFUTED IN MY AUDIT: (C4) "790 draw calls of a ~1000-2000 ceiling" — REFUTED, real is 261-289; the 790 came from a perf-audit.md that is 261 commits stale (before GRID_RADIUS became 1 and MAX_TREES_PER_TILE 1500). Also renderer.info.render.calls counts a WEBGL_multi_draw batch as ONE call, so 13,963 trees register as 2. (C3) "15-20MB VRAM" — REFUTED by 8-15×: real resident cost is 153 MiB (ETC2) / 299 MiB (BC7); .ktx2 file size is a variable-rate TRANSMISSION format, VRAM is fixed at block rate × 1.333 for mips. VRAM is a third binding constraint the audit omitted entirely. Download figure (~23-25MB) CONFIRMED, but the overrun is entirely the facade line (14.7 vs 8 MB budgeted) — cut facade sheets 8→5, foliage was costed correctly. (C6) "~150m near-field bubble" — REFUTED as-implemented: the bubble does not exist, buildings render to ~700m because the gate is per-tile nearEdgeDist (tileManager.js:2909-2910, 3068-3071) with BUILDING_MAX_DISTANCE 250 against 500m tiles. Per-instance LOD is worth ~3.0ms of night GPU and is the prerequisite the entire budget rests on. (C1) "70% art / 30% engineering" — CORRECTED to ~50/50 with engineering FIRST. (C2) "65-75%" — CORRECTED to 65% day / 50% NIGHT: night is structurally capped because there are ZERO punctual street lights (main.js:192 removed dynamic PointLights) and MeshStandard's whole advantage is specular response to them. (C5) SSAO — CORRECTED to "don't": rejected outright in favour of extending the baked v9 sky-AO (zero per-frame cost); a foliage-only alpha-tested prepass is worth it once cards land, a whole-scene prepass stays dead. (C7) tree pipeline — CORRECTED: **the assets already exist unused in frontend/public/textures/trees/** (8 card-tree .obj 115-183 tris + summer_trees_0.webp alpha atlas + summer_trees_0_n.webp AUTHORED foliage normal map, ~2.9MB, referenced from zero source files since March) — measure before opening Blender. BIGGEST ARCHITECTURAL CHANGE: **MeshStandard is dropped from v2 entirely** — scene-wide IBL works on the existing 92 MeshLambert materials with no migration (irradiance += iblIrradiance is guarded by #if defined(LAMBERT)||defined(PHONG)), and MeshLambertMaterial supports normalMap+aoMap in r183; that one decision takes download 33.7→23.3MB, VRAM 299→153MiB, and night GPU from over-budget-by-3ms to under-by-2ms. BUGS FOUND AND HAND-VERIFIED: renderer.shadowMap.autoUpdate is NEVER assigned anywhere in frontend/src — the comment at main.js:969 describes a state the code never establishes, so the shadow map re-renders EVERY FRAME and the throttled needsUpdate is a no-op (~1.2-1.5ms free, and three separate agent reports each tried to spend that same saving); shared-material disposal at tileManager.js:2856-2872 defaults to disposing unless userData.sharedMaterial is set, with two live misses (roadRenderer.js:2096 bikepictogram, :2202 zona30Stencil) — catastrophic under a shared KTX2 library, invert to an explicit ownedMaterial opt-in; trees sway in GLOBAL UNISON because getVegPools makes pools direct Scene children so modelMatrix is identity and windOrigin is (0,0,0); billboard band designed for 170-470m is truncated to 170-280m by the fog cull; 11.5MB of shipped waste in public/ (modes/*.png 7.53MB unoptimised). PLAN: Tier 0 instrument+unblock (6d, zero art) → Tier 1 perceptual unblockers (11d, still zero art — per-instance LOD, SMAA, materialRegistry, Lambert IBL, close task #39) → Tier 2 art corridor-scoped (14d) → Tier 3 gated, with a STREET-LIGHTING pass promoted above MeshStandard as the real prerequisite for a night ETS2 look. GATE CHANGED from a one-block slice to a 1.5km 6-8 tile CORRIDOR drive — a static block structurally cannot catch streaming (never unloads → misses the disposal bug and long-session heap), motion (stationary disables RadialBlurPass in every reading taken so far, and hides foliage shimmer), night, or time-to-drive; 11 numeric thresholds incl. a binary human SEAM TEST (converted corridor → unconverted city) that neither the audit nor any report had asked for. K1-K7 kill criteria defined. NEXT: an afternoon production-build measurement pass (npm run build && npm run preview) over 4 regimes, incl. a 1-hour A/B pointing the veg pool at the already-on-disk tree_04.obj — that is the go/no-go on the whole foliage pipeline. DECISION OWED BEFORE ASSET #1: art direction is stylized-PBR NOT photoscan (the 9 Kenney city cars are 2,032-2,476 tris with a 3KB palette atlas; photoscan asphalt would make them read as toys) — free today, unrecoverable after 100 assets.

- 2026-08-24 (v3 MASTER PLAN — 17-agent debate: 12 subsystem audits → hostile no-slacking cross-examination → rebuild/budget/art judges → master plan) — Branch `v3`. User brief: ETS2 as the reference ("those are not too good but definitely better than what we have" — captured in v3-brief.md as BOTH a ceiling and a floor), hard no-slacking rule (rebuild from scratch where that gives the better end result; sunk cost is not an argument, and neither is rewriting for its own sake), full named scope (boards/buildings/road/railings/bushes/grass/trees/cars/water/beach/hills/clouds/atmosphere/HUD/progression). Output: docs/context/v3-master-plan.md (1410 lines) + v3-art-bible.md + v3-rebuild-budget-ruling.md + v3-audits/ (12 raw audits). VERDICTS: 7 REBUILD / 5 REFACTOR at audit stage → judge-reconciled to a mix incl. 5 SPLIT verdicts; 103 rebuild days, ~205 total, MINIMUM SHIPPABLE = end of P3 = 74 days. THREE FRAME-CHANGING RULINGS: (R-A) the "26.3 vs 15.0 ms" overrun was an artefact of treating the frame as starting at ZERO — measured night Eixample at 80km/h is 13.3ms, and several audits' gross asks re-declared spend already inside it; restated as baseline + Σ(NET marginal) it FITS at 13.75/15.0 with 4.55ms of PHANTOM savings struck (3 domains each banking the same shadow autoUpdate saving, 3 each banking the same per-object LOD win). (R-B) resident-tile denominator is 9-18, not 25 — GRID_RADIUS=1 builds 9, dynLookahead adds a directional FAN not a ring, UNLOAD_DISTANCE=2 is the eviction radius; six different denominators across the audits struck. (R-C) five census figures corrected by re-parsing all 426 tiles instead of the audit's 110-tile sample: 14,542 shops (13,551 named) not 2,923; 4,225 traffic signals not 807; 42,876 named road records not 8,966 — all parsed and DISCARDED today, so wiring data.shops + data.trafficSignals is "the best 0.5 days in the programme"; night emissive atlas is 55.9 MiB measured not 85.3 structural (so GRID 4→2 reclaims -41.9 not -64). BUDGET NOW FITS BOTH CAPS: GPU 13.3 baseline + 8.55 allocated − 8.10 savings = 13.75 ms (cap 15.0); VRAM 129.7 baseline (95.7 texture + 34.0 EffectComposer render targets, omitted from every prior table) − 79.5 retirements + 109.2 allocations = 159.4 MiB (cap 200). BIGGEST INDIVIDUAL FINDINGS: FLOOR_HEIGHT=10 vs a 3.008m texture row period paints a MID-AIR SHOPFRONT on 88.5% of buildings (36,122 of 40,828 ≥10m; 30.8% get two) — facades are 21.3×25.6 texels/m against an 85-150 bar, produced by ~250 lines of canvas painting onto a 4-VERTEX WALL QUAD, which is why it is REBUILD not REFACTOR; only SEVEN guard_rail features exist city-wide (of 2,890 barriers) so road railings must be DERIVED from road class + geometry, not read from OSM; the only ground texture fetch in the shipped path is COMPILED OUT (terrainRenderer.js:892-895 ternary on isRallyStyle) so the finest ground detail in the game is a 5-10m noise blob; getRoofMaterialKey() is a literal `return 'roof_FFFFFF'` so ONE texture dresses every roof in Barcelona = 1.5 days for the city's aerial signature; signage has three independent arithmetic walls (one MeshBasicMaterial per board = ~300 draws; one 0.750 MiB texture per unique street name with ZERO eviction against 42,876 names; tile unload disposes the module-cached texture) so "a texture per string" has no patch; bmw_m3.glb has uniqUV=1 at (0,0) on all 17 nodes and people/man.glb has NO TEXCOORD_0 at all (verified by binary GLB parse with correct byteStride) so you cannot patch a UV unwrap onto shipped vertex data; tileManager.getStreetlightPositions() is exported with ZERO callers — the night-lighting data plumbing is already built and unused. LIVE LEGAL/CORRECTNESS EXPOSURES (all P0): CraftPix-licensed vegetation + commercial Monotype Futura .otf are being SERVED from drive.anmolbhardwaj.com right now (Vite copies public/ verbatim); Indian tricolour bridge poles still render at night in Barcelona (streetlightRenderer.js:96,124,626-628) and Indian cat's-eye studs sit every 6m on Barcelona tertiary streets (reflectorRenderer.js, ~42k tris + 18 draws); main.js:768-770 clobbers scene.fog.density with a hardcoded 0.005 EVERY FRAME so the DAY 0.0032 / NIGHT 0.0045 presets never ship; GLOBAL_VERTEX_BUDGET drops ENTIRE BUILDINGS via `continue` in exactly the dense tiles the gate measures. NIGHT gets its own section: zero punctual lights (decisions.md D-08, whose stated revisit condition is literally clustered lighting) structurally caps night at ~50%; the answer is lightGrid.js — world-space 2.5D clustered lighting, 64×64 RGBA8 index over 8m cells, 2.0ms — replacing SIX fakes incl. 16m ground-pool decals at 22m lamp spacing (>100% road coverage). ⚠ Alpha-tested foliage at zero punctual lights is a BLACK CUTOUT — arguably worse than the current blob — so card trees MUST NOT ship before the light grid. CUTS (52 days recovered): rain in all three duplicated implementations, the pedestrian art rebuild (the domain wrote its own kill criterion then scheduled the work anyway; ETS2 has essentially no interactive crowd), greensRenderer as a surface (parks become a splat weight channel — negative cost), the separate sea mesh (identical pixels), marina boats, second hero facade tier (the cut the judge was least comfortable with). DO THIS FIRST: branch v3-p0-foundation, ~2 hours — pin three to exact 0.183.1, shadowMap.autoUpdate=false + needsUpdate on tile-reveal AND car movement, SPLIT patchRoadWash into patchRoadAO (permanent) + patchRoadNightWash (deletable) BEFORE anyone touches lighting or the P2 deletion silently removes baked AO from every road, git rm the CC-violating assets, then write scripts/route.js and commit docs/context/v3-baseline.json — one capture that replaces all five domains' triangle estimates.

- 2026-08-24 (v3 execution tracker — the plan made resumable) — The master plan had phases but no STATE: a fresh session could read what to build but not what was already built. New docs/context/v3-execution-tracker.md (926 lines) generated from the plan's work-item tables: 79 tasks across P0(18)/P1(25)/P2(7)/P3(11)/P4(18), each with a stable ID, status checkbox, days, risk, files, depends, subsystem, a pointer to its full spec, and a "done when" line to be filled with a MEASURED number on completion. Separation of concerns is deliberate and stated at the top of both files: the master plan is the SPEC, the tracker is the STATE, neither duplicates the other (duplication is how the two drift apart). Tracker carries: a RESUME HERE block (branch, current phase, next task, done count, whether the baseline exists, blockers) + explicit "if you are a fresh session do exactly this" steps; a PERFORMANCE LEDGER with baseline/now/cap/owner per metric and the rule that no task may claim a saving another already banked (three domains each tried to bank the same shadow saving during planning); 9 STANDING HAZARDS (patchRoadWash carrying baked AO, the worker building path, vegPools invariants, GLOBAL_VERTEX_BUDGET deleting buildings, triple-mirrored constants, dispose-by-default materials, re-bake cost, card foliage before the light grid, CSM hard-assigning onBeforeCompile); the PHASE GATE MATRIX lifted from the plan (note the gates TIGHTEN through P0-P2 — GPU ≤12.3ms, draws ≤240 — and only open at P3, because P0-P2 spend nothing on art and must BANK headroom for the art wave); a SESSION PROTOCOL (start: confirm branch is v3*, read hazards, check the predecessor gate passed; during: one task per commit, mark [~]/[x]/[!], write measured numbers into the ledger; end: update RESUME HERE, note where any [~] stopped, COMMIT — an uncommitted tracker is a lost session); a DECISION LOG (append-only, deviations from plan must be written down — a silent deviation is indistinguishable from a mistake three sessions later); the CUT LIST so cut scope is not silently re-added; and the kill criteria. CLAUDE.md now routes all v3 work to the tracker first.

## 2026-08-26 — v3 P3-10: photographic tree cards

- **Tree cards shipped** (`?treecards=0` reverts). 6 Barcelona species from one 3072×2048 atlas;
  crossed quads, 4 tris/tree vs ~80 for the blobs. New: `map/treeCards.js`, `map/treeWind.js`,
  `map/treeAtlas.js` (generated), `CONFIG.TREE_CARDS` / `CONFIG.NUM_TREE_VARIANTS`.
- **`tools/artNormalize.py`** — first implementation of art-bible §4.4 (de-light, Lab L*/C* rescale,
  normal calibration, palette snap, pre-grade compensation, ΔE2000 gate). Shared module, not a
  per-domain copy — see BLK-2. Fixed a real bug in step 5: single-anchor hue snapping rotated the
  jacaranda's violet through red into pink; it now snaps to the nearest allowed anchor per pixel.
- **Normal maps were ~2× out of band** (|N.xy| 0.53 vs the 0.20–0.35 foliage band) → 0.275, and
  `normalScale` returned to 1.0 per AD-5.
- **Species-by-context classifier** (tier 3 only; tiers 1–2 blocked on the P1 species pipe) —
  avenue/street/coast/park/plaza sets replace `bakedVariantIndices[i] % N`.
- **Roadside stride 2–5 m → 6–8 m** (~35–40% fewer tree instances).
- **Billboard collapse**: 4 materials + 4 pool sets → 1 + 1, cells baked into geometry UVs,
  per-species impostor sizing, `transparent:true` dropped, `bbEnd` clamped to `FOG_FULL_DIST`.
- Tests 151 → 164. New docs: `docs/context/tree-cards.md`. New gotchas G-54, G-55.

## 2026-08-26 — P3-10 follow-ups (spacing, night, hillsides)

- **Roadside stride is now per context** — avenue 11–15 m, street 9–13 m, coast 10–14 m (was one
  global 2–5 m, then 6–8 m). ~70% fewer roadside tree instances vs the original baseline. Table in
  the new shared `map/treeSpeciesSets.js`.
- **Night lift for cards.** Canopies read near-black at night (normalize puts foliage at L* 45, and
  the night lighting at canopy height is ~0 because street lamps sit below the crowns). Fixed with
  `emissive`, not `color` — colour multiplies incoming light and multiplying zero stays zero.
  Impostor night tint re-derived for the normalized atlas (0.22/0.28/0.40 → 0.42/0.48/0.50).
- **Hillside/background clusters now classify.** `environmentClusterRenderer` was wired to the card
  geometry but not the classifier and picked species uniformly at random — palms and bitter-orange
  on Collserola. New `hill` set (celtis/tipuana/plane). Species table shared between the worker and
  the cluster renderer so the two cannot drift.
- Tests 164 → 168.

## 2026-08-26 — P3-10 fixes: faceDirection patch, night lift modulated

- **The double-sided flip was never actually cancelled.** `onBeforeCompile` hands you the shader
  with `#include <...>` UNRESOLVED — three expands chunks later, inside WebGLProgram — so searching
  `shader.fragmentShader` for the chunk's text could never match and the replace silently no-opped.
  Every card darkened from behind while build, tests and shader compile all stayed green. Now
  expands `THREE.ShaderChunk.normal_fragment_begin` by hand and substitutes it for the directive.
  The test was asserting against `node_modules/three/src/...`, a file the bundle does not load; it
  now drives `patchCardFaceDirection()` against a realistic pre-include shader and checks the output.
- **Night lift was flat and overshot** — a constant emissive lifts every texel equally, so the
  canopy's own light and shade cancelled and the trees went pale, flat and mint, brighter than the
  facades. Now modulated by the albedo (`emissiveMap = map`, declared in the constructor so the
  define is baked before the boot warm-up). `window._ddTreeNight(scale)` tunes it live at night.
- Tests 168 → 169.

## 2026-08-26 — spawn moved to Collserola (temporary)

DEFAULT_SPAWN → `{lat:41.4180, lon:2.1150}` (Carretera de les Aigües) to check P3-10 hillside
vegetation: the `hill` species set lives in environmentClusterRenderer's terrain scatter, which only
has anything to show on non-urban ground with real elevation. **Move back to Gran Via
`{41.3866, 2.1640}` before any perf work** — that is the P0-05 benchmark and `bench/benchRoute.js`
start, and p95 lives there. Reports taken on Collserola are not comparable to earlier ones.

## 2026-08-26 — hillsides were bare: two independent causes

- **FIXED (frontend).** `environmentClusterRenderer.getTileBbox()` bounded the background cluster
  scatter by the extent of the tile's ROADS AND BUILDINGS. A Collserola tile has 0 of each, so the
  bbox came back null and the tile got ZERO clusters; a tile with one road got a thin sliver, which
  is why trees hugged the carriageway and stopped at its edge. Now bounded by the tile's ELEVATION
  footprint — the ground that actually exists, present on every tile, and already the authority the
  per-item loop uses to reject out-of-footprint placements. Density raised with it (spacing 25→18,
  cap 120→340); before the bbox fix most of those clusters had nowhere to go.
- **NOT FIXED (needs a re-bake).** `backend/worldBuilder/pbfGreens.js` parses WAYS ONLY — it has no
  handling for multipolygon relations. Barcelona's woodland is mapped predominantly as relations, so
  the entire baked region contains **10 `forest` and 12 `scrub` polygons** (vs 409 grass / 380
  garden / 78 park). Collserola — a natural park wrapping the whole city — has none. `ZONE_RULES`
  already has a dense `forest` rule (treeDensity 1/25, cap 600) waiting for data that never arrives.

## 2026-08-26 — wild terrain: the renderer stops waiting for OSM

Open ground now generates its own woodland instead of rendering as a bare green dome.

`environmentClusterRenderer` classifies a tile as WILD when the map says nothing about it — no
buildings, no greens, ≤8 roads — and wild ground gets: 620 clusters (vs 340), four new tree-DOMINANT
`WOODLAND` templates (the original eight are rock-and-rubble roadside dressing, and only three carry
a tree at all), and two octaves of value noise gating acceptance so the slope grows dense stands with
clearings between them rather than an even carpet. **~1,682 trees per wild tile, one per ~149 m².**

This is generated, not surveyed, and deliberately so: the baked region has 10 `forest` polygons for a
city wrapped in a natural park, and fixing the relation parser would still leave open ground at the
mercy of OSM's coverage. The alternative on offer was an empty hillside.

Degrades safely — anything with buildings or a street network stays town and keeps the old dressing.

**Perf note:** cards are 4 tris but each is an alpha-tested fragment, and a hillside puts many on
screen at once. `WILD_MAX_CLUSTERS` is the one number to turn if the hill costs frames.

## 2026-08-26 — openness per spot, greens relations, LOD night match

- **Wild detection was per TILE and disqualified on one building.** A zoom-16 tile is 500×500 m, and
  on the city edge where Vallvidrera housing runs into Collserola every tile holds a few blocks — so
  half a square kilometre of hillside stayed bare. Openness is now a property of a PLACE:
  `isOpenGround()` ring-samples the vegetation mask at 32 m. One tile can now carry forest on the
  open slope and roadside dressing near the houses. (Ring of 8, not a true margin test — the mask is
  0.5 m/cell, so a 32 m margin is ~20,000 reads per candidate.)
- **`pbfGreens.js` now parses multipolygon relations** (3-pass, mirroring `pbfBuildings`; its
  `assembleRings`/`refsToMercator` are now exported and shared rather than copied). Measured on
  Collserola: **forest 10 → 57, scrub 12 → 52** — and those were whole-city counts before.
  **Needs a re-bake to take effect.**
- **LOD impostor night tint is now DERIVED from the card tint** (`× NIGHT_LIGHT_FRACTION`), not
  hand-picked. Impostors are unlit (albedo × tint), near cards are lit (albedo × tint × night light
  + emissive floor) — two different equations, so two independent tints could never agree, and the
  impostor was ~2× too bright. `_ddTreeNight` now moves both together.
- Tests 169 → 170.

## 2026-08-26 — bush cards and stone rocks wired

- **Bushes are cards now.** 6 Barcelona species; the 3-lobe dodecahedron blob is gone behind the
  same `TREE_CARDS` switch (deliberately no separate flag — photographic canopy over blob
  undergrowth is a worse scene than either done consistently).
- **Bush species by context.** Worker bushes (roads, barriers, buildings) draw the `urban` set
  (pittosporum / box / lentisc); cluster bushes (hillside scatter) draw `wild` (lentisc / kermes oak
  / rosemary / dwarf fan palm). Position-seeded, so a bush keeps its species whatever order
  instances materialise in. The pool takes one flat instance list, so the split happens in
  `meshMaterializer.splitBushesBySpecies` — no worker or tile-format change.
- **Rocks are textured stone.** Three Barcelona stones in ONE 1024 page, cell chosen per instance
  via an `aRockCell` instanced attribute — one material, one draw call. Three materials would have
  tripled rock draw calls across 9–18 resident tiles, the opposite of what P3-10(c) just did.
- **Rock atlas 2048 → 1024.** VRAM is uncompressed RGBA + mips: 2048 costs **42.7 MiB** across
  albedo and normal, 1024 costs **10.7 MiB**, and 512-px cells still give ~256 texels per real metre
  on a 2 m boulder. (For reference the tree atlas is 64 MiB — worth revisiting separately.)
- **`cardMesh.js`** now holds the crossed-quad geometry, dome normals and atlas loading, shared by
  trees and bushes; `treeCards` was rewritten onto it with tests green throughout.
- Tests 170 → 172.
- **Generated scatter no longer double-plants mapped forest.** Now that greens relations reach the
  tiles, `collectZoneVegetation` plants them at their own per-type density (forest = 1/25 m², cap
  600). The wild scatter exists to fill ground OSM says nothing about, so it now skips anything
  inside a greens polygon — otherwise a mapped wood carried ~2,200 trees where it should carry 600.

## 2026-08-26 — floating clusters, and forests planted as parks

- **Clusters could float.** `renderEnvironmentClusters` recomputed ground as
  `getElevationAt * vertExag` instead of using `options.getWorldElevation` — the one function
  tileManager builds from the terrain mesh for everything that must sit on the ground — and silently
  fell back to `y = 0` when no sampler was present. **`y = 0` is not the ground**: it is the
  elevation-offset datum, i.e. spawn-tile height. Near a road on flat ground that is invisibly close
  to right, which is why it survived; scattered across a hillside that moves 190 m it puts whole
  clusters in mid-air. Now uses `getWorldElevation`, and places nothing rather than floating when
  there is no reading.
- **Forest polygons were planted from the `park` set** (20% jacaranda), so Collserola came out dotted
  with flowering ornamentals. Greens now carry their OSM type into the classifier via
  `ZONE_TREE_CTX`: forest/scrub/grass plant the wild set, park/garden the ornamental one.
- **Spawn back to Gran Via** `{41.3866, 2.1640}`. Use `?spawn=41.4180,2.1150` for Collserola instead
  of moving the default — the URL override does the same job without making every later drive report
  incomparable to the earlier ones.
- **`ENABLE_BUSHES` back ON.** It was off with the note "they scattered clumps over streets and
  crosswalks" — a PLACEMENT fault, not a look fault. Bush push sites were guarded by the vegetation
  mask (a road-EDGE test) but never got `isOnGroundRoad`, the road-SURFACE check trees have, so a
  bush could land on a crosswalk where a tree could not. That guard is now in `collectBushPositions`,
  which is what makes re-enabling defensible rather than hopeful.

## 2026-08-26 — bush cards: size, colour and the lag they caused

- **Bushes were sized and tinted for the BLOB.** `buildBushInstances` applies scale 0.6–1.5 × 0.7–1.2
  and multiplies by flat `BUSH_TINTS` green — correct for a 0.76 × 0.5 m untextured dodecahedron,
  wrong twice over for a card that is already real-size and already carries its own photographic,
  normalized colour. Hedges came out ~2 m tall and dragged six species onto one dark hue that no
  longer matched the trees beside them. Cards now jitter around 1.0 and take a BRIGHTNESS-only tint.
  Same fix, same reasoning, as the cluster bushes.
- **Bushes now fade at 45–90 m**, not on the tree band (`TREE_FULL_DISTANCE` → `TREE_MAX_DISTANCE`).
  There are ~3,000 bushes per tile against ~600 trees, and a 1 m shrub at 100 m is a couple of
  pixels — as alpha-tested cards that is thousands of fragment-shaded quads contributing nothing.
  This is what made the street go heavy the moment bushes came on.
- **`MAX_BUSHES_PER_TILE: 1200`**, decimated from the baked 3,000 by a stride on the frontend.
  `_ddVegCount()` on Gran Via showed **30,303 bush instances against 24,866 trees** — five times as
  many bushes as trees per tile, affordable as untextured blobs and not as textured cards each
  carrying a matrix and a colour in a BatchedMesh data texture. A stride, not a head-slice: the baked
  list is generated in order along roads, so slicing would strip whole streets bare.
- **NOTE for the frame investigation:** adaptRes reported *"dropping to 1.12 changed the frame by
  −3.6% — resolution is NOT the constraint"*. The frame is **not fill-bound**, so the earlier
  reasoning that alpha-tested bush cards were costing fill was wrong. The bush LOD band (45–90 m) is
  still correct, but it was not the cause. Next step is an F9 drive report for section attribution.

## 2026-08-26 — the frame was texture uploads, not vegetation

F9 on Gran Via, worst frames: **`rend` 116–228 ms of CPU while the GPU sat at 6–7 ms**, with only
170–410 draw calls and 0.5–1.1M triangles, and 6–13 MB allocated in the same frame. Draw calls and
triangles that low with the GPU that idle cannot be a rendering cost — it is the CPU stalling inside
`renderer.render()`.

- **Atlases now upload during boot** (`preloadCardAtlases` → `renderer.initTexture`). They load
  asynchronously, so three was uploading each page AND generating its mip chain on whatever frame
  first drew it — mid-drive, and for a 3072×2048 page, enormous.
- **The boot warm-up was warming the wrong materials.** It warmed `getBushMaterial()` — the BLOB —
  while the live path had switched to bush cards, so the material that actually renders was never
  warmed. It also called `getTreeBillboardMaterial(v)` per variant, a signature that stopped
  existing when P3-10(c) collapsed the impostors to one material. **Warm what the seams return,
  never a specific implementation.**
- Corrected earlier in this session: the lag was blamed on alpha-tested bush fill. `adaptRes`
  ("resolution is NOT the constraint") and now the GPU timings both say otherwise.

## 2026-08-26 — v3 P3-09: granite kerb

- **Tiling granite albedo + normal, 512²**, generated PROCEDURALLY (`tools/build-kerb-texture.py`).
  Granite is millimetre-scale speckle with no large features — what band-limited noise does well and
  image models do badly (they invent cracks and mortar a 0.30 m kerb face has no room for). Periodic
  sin/cos octaves also make STEP 1 exact rather than repaired. Gates: tile **1.00**, ΔE2000 **5.48**
  vs P7 Bordillo Granite, |N.xy| **0.470 → 0.250**.
- **UVs derived from world position in the vertex shader.** The baked v8/v9 curb blobs carry no `uv`
  attribute (`withUv=false`), so there is nothing to sample; world-metric UV needs no attribute and
  ships without a re-bake. Top face reads world XZ, vertical face reads (horizontal run, height),
  picked by vertex normal so the grain stays upright.
- **`ENABLE_CURBS` lie resolved.** Only `buildCurbs()` checked the flag; `buildBakedSidewalkMeshes()`
  rendered kerbs on all 409 v9 tiles regardless — the switch did nothing and reading it misled.
  Both paths gate on it now, and it reads `true`.
- **Tile-verify metric finally calibrated** — see `artNormalize.step1_tile_verify`. Five attempts,
  each wrong differently; what survives is signed-mean coherence, max over both axes, with an
  absolute floor below one 8-bit level. Anchored at both ends: procedurally periodic noise scores
  **0.00**, the three seamed AI rock plates score **2.7–4.2**. Enforced on raw input, reported after
  repair (the threshold is not calibrated for blended output).
- Tests 172 → 174.
- **Kerb granite is now the AI plate, not the procedural one.** Measured side by side on the same
  gates: **ΔE2000 1.67 vs 5.48**, and it tiles at **1.28 raw — a pass, no repair**. Real mineral
  variation beats statistically uniform speckle on a surface that runs the length of every street,
  where uniformity reads as plastic. The procedural generator stays in the tool as the fallback
  (`SOURCE = None`).
- **Repair only runs when the tile check FAILS.** `make_tileable` blends, and blending a texture that
  already wraps cleanly makes it worse — this plate went 1.28 → 2.82 under an unconditional repair.
  "Fix or reject" means fix what is broken, not everything that arrives. Applied to the rock tool too.

## 2026-08-26 — road textures built (not yet wired), and a lossless tiling repair

- **`artNormalize.make_tiling()` — a repair LADDER**, cheapest and least destructive first:
  already tiles → ship untouched · framed off-grid → **roll into alignment (lossless)** · genuinely
  discontinuous → blend (lossy, and only then). The middle rung is new and it is the important one:
  a structured texture usually tiles perfectly and is simply FRAMED wrong. The panot plate scored
  **31.93 as delivered and 0.02 after a roll of (496, 536)** — nothing was wrong with the pixels.
  Blending would have smeared the grout joints, the one thing a grid cannot survive. Both asphalt
  plates also cleared losslessly (2.46 → 0.05, 1.76 → 0.02).
- **Three road surfaces built and gated** (`tools/build-road-textures.py`): `asphalt_worn`,
  `asphalt_fresh` (1024², span 4.0 m, P8 Carriageway Grey, ΔE 4.44 / 4.78) and `panot` (1024²,
  span **0.40 m** — a 2×2 of 20 cm tiles, P6 Panot Grey, ΔE 7.98). **Not yet wired into
  roadRenderer.**
- **Kerb texture span 1.0 m → 0.35 m.** The plate's speckle is ~1 cm across, so at a 1 m span it WAS
  1 cm of stone when granite grain is 1–3 mm — five times too coarse reads as gravel, and on a
  0.12 m kerb face seen edge-on it aliases into noise. Span is a physical statement about what a
  surface IS, not an art preference.
- Normals here are **luminance-derived**, which AD-1a names as a compromise: only a photoscan ships
  a true normal, and a derived one reads a dark aggregate stone as a pit. Still far better than none
  (asphalt with no normal turns to grey mush at bumper distance); the upgrade is an ambientCG CC0
  scan, which is what P3-08 actually specifies.

## 2026-08-26 — P3-07b / P3-08 (part): authored road surfaces wired

- **Asphalt**: `asphalt_worn` replaces `createAsphaltTexture`'s LCG grain field. **The shader needed
  no change** — asphalt v2 already samples world-metric at `uAsphaltRepeatM`, and the plate was built
  to that exact 4 m span, so the swap is a texture rather than a rewrite. The generator stays as the
  fallback.
- **Panot**: the photographic Flor de Barcelona plate replaces `makePanotCanvas`, with **world-metric
  UV**. The baked v8/v9 sidewalk blobs *do* carry a `uv` attribute but it is not in real metres, so a
  20 cm tile would render at whatever size the bake picked — on the one surface in the city whose
  size anyone can check by eye. World XZ pins the flower to 20 cm everywhere and makes it continuous
  across tile seams for free. Generator kept as fallback and as the authoring tool.
- **Road textures preload at boot** (`preloadRoadTextures`), same reasoning as the vegetation
  atlases — road is drawn on frame 1 of every drive, so its upload would land squarely in it.
- Tests 174 → 176, including a guard that every surface declares a physically sane span (panot
  exactly 0.40 m = two 20 cm tiles; asphalt 4.0 m matching the shader).

## 2026-08-26 — the authored asphalt plate is a MULTIPLIER, not a base albedo

Two visible faults, one root. `ROAD_V2_APPLY` ends in `diffuseColor.rgb *= grain`, and the generator
it replaced produced a modulation field centred near 1.0 — so multiplying was free and nobody had to
think about it. An authored albedo sits at its class L* instead (**0.108 linear** for asphalt).

- **The carriageway went brown and dark.** Multiplying by the plate darkened it **~9.3×** and
  multiplied the plate's warm cast in as well. Fixed with `uAsphaltGain = 1 / meanLuma` (emitted by
  the bake), so the plate modulates around 1.0: base palette colour, vertex colours and baked AO all
  survive and the photograph contributes only its RELATIVE grain, which is all that was ever wanted.
- **The sidewalk went brown too** — `patchRoadAO()` applies asphalt v2 to EVERY material it wraps,
  and both sidewalk materials use it. A pavement was sampling the road texture, invisible while the
  grain was near-1.0 and obvious the moment it carried the asphalt's own hue. `patchRoadAO` now takes
  `{ roadV2: false }` for non-carriageway surfaces; they keep the baked AO and drop the grain and
  wheel ruts they should never have had.
- **The gain must be PER CHANNEL.** Dividing by luminance mean left `asphalt_worn` at
  (1.11, 0.985, 0.81) — red 37% above blue — and multiplying that into every carriageway and
  pavement turned the city beige. Each channel is now divided by its own mean, so the grain averages
  to neutral (1,1,1) and modulates texture without touching hue. `meanRGB` is emitted by the bake.
- **Noted, not fixed:** the bible's own numbers disagree for panot — surface class `sidewalk` targets
  **L\* 62** while its P6 Panot Grey anchor sits at **L\* 71.9**, so the asset lands 10 L\* darker
  than the anchor it is named for and still passes gate 4 (ΔE 8.28). Worth resolving before more
  sidewalk-class assets are authored against it.

## 2026-08-26 — street lamps were lighting the ground at noon

- **`uLGEnabled` was never gated on night.** `armLightGrid()` set it to 1 for the session and nothing
  ever turned it off, so every sodium lamp in Barcelona cast a warm pool on the pavement in full
  daylight — visible as unexplained orange patches on the ground during the day.
  `setLightGridNightMode()` now rides envToggle's material callbacks, which fire on the instant/init
  path too, so the first frame is already right. It is a uniform: no cost, no recompile (G-53).
  Defaults `_isNight = true` so a build that somehow never fires the callbacks keeps its night
  lighting — `?nolightgrid` off is already the broken state, so lamps-on is the safe failure.
- **Panot tile size verified, not changed.** The plate's grout lines measure at 0 / ~625 / ~1250 px
  of 1254, i.e. exactly two tiles across, so the 0.40 m span renders 20 cm tiles — the real size of
  Barcelona panot. (An autocorrelation peak at ~211 px suggested six repeats; that is the flower's
  petal structure, not the tile.) `window._ddPanotSpan(m)` exposes it live, because "physically
  correct" and "reads well from a camera three metres up" are different questions.

## 2026-08-26 — span is a measured property, and now it is gated

The same mistake shipped twice: kerb granite at a 1 m span (grain ~8 mm where granite is 1–3) and
asphalt at 4 m (23 mm where aggregate is 5–15). Both times the plate was fine and the SPAN was a
guess, and both times a human looking at a screenshot caught what is a one-line measurement.

- **`artNormalize.measure_grain_mm()` / `check_grain()`** — isolates grain from large-scale mottling
  with a high-pass (the asphalt plate measures 164 px unfiltered, obviously not a stone, and 6 px
  once the low frequencies are out), converts to real millimetres at the declared span, and checks it
  against a physical band per surface class. The bake **warns and records** `grainMM` /
  `grainBandPass`; a test asserts every shipped surface passes.
- **Asphalt span 4.0 m → 2.0 m** — measured, not chosen. Aggregate 23.4 mm → **11.7 mm**, mid-band.
  Costs a repeat every 2 m instead of 4, which the macro wear and wheel ruts already break up and
  P3-07c's detail normal will break up further. The renderer now takes the span from the plate rather
  than the `uAsphaltRepeatM` constant.
- **Sidewalk grain band widened (1,4) → (1,6) on evidence, not to silence the warning.** The panot
  measures 4.7 mm and its span is independently confirmed twice: grout lines at 0/625/1250 px of
  1254 (exactly two 20 cm tiles), and signed off by eye in game. Concrete fines at ~5 mm are real.
- `window._ddAsphaltSpan(m)` and `window._ddPanotSpan(m)` tune both live.
- **`window._ddNightRig(ambientIntensity, ambientHex, hemiIntensity)`** — live night-rig knob, added
  rather than a quiet retune. The carriageway reads lavender at night because `NIGHT.ambientColor`
  is a blue-VIOLET `0x6b7a9e` at intensity **1.0** with no falloff. Those values are deliberate and
  annotated ("the blue TINT (not darkness) is what sells night"; "readable floor: geometry must
  survive as blue-charcoal masses, not voids"), so the trade gets exposed for judgement instead of
  overwritten. The road ALBEDO is not the problem — base `#4a4a4a` (L\* 31.5) against the P8
  Carriageway Grey anchor `#4F4E4C` (L\* 33.2) is within 1.7 L\*.

## 2026-08-26 — v3 P3-07c: road detail normal (the 8× term)

Two normal samples — base repeat plus 8× — whiteout-blended, with the 8× term faded out between 8
and 25 m (a detail frequency that survives to the horizon only aliases, and no mip chain saves a
term whose job is to be under-sampled). `window._ddRoadDetail(0)` gives the "before" picture.

All three blockers the tracker listed resolved differently than expected:
- **Tangents were not needed.** A frame built per fragment from screen-space derivatives of view
  position against the road's own metric UV is exactly what three falls back to without
  `USE_TANGENT`. Built against the road UV, not the screen, so the detail stays locked to the
  carriageway instead of swimming as the camera turns.
- **The separate injection point was the real crux.** three orders `<normal_fragment_begin>` AFTER
  `<color_fragment>`, so at the tone block's injection point the identifier `normal` does not exist —
  writing it there is the same undeclared-identifier failure that once made the whole road vanish.
- **D-32 does not apply.** Every lit material declares a normal, unlike roughness, so this term is
  safe in the shared `patchRoadAO` where the roughness term was not.

Self-disables when no authored normal exists, so the procedural fallback never samples a null map.
Tests 176 → 177.

## 2026-08-26 — v3 P3-11: sky dome, 2 keys

2048×1024 equirect **cloud layers** (day + night, **1.51 MiB** against a 2.67 MiB budget), cross-faded
by the env transition lerp so the sky crosses over with the lights instead of snapping.

- **Procedural, and here that is the stronger tool.** An equirect sky must wrap exactly and converge
  at the poles; an image model has no notion of either and a wrong projection is not a hue you can
  grade. Measured seam **0.00018** (0 = exact).
- **Clouds live on a flat deck at 1200 m** and each texel's view ray is intersected with it, so
  horizon compression comes out right for free. Sampling noise in equirect UV is the classic mistake.
- **Coverage is set from the noise's own distribution**, not a guessed threshold — the first attempt
  asked for 42% and drew 0.1%, because fBm concentrates around its mean and both the threshold and
  the ramp width were absolute numbers against an unknown spread.
- **Clouds composite OVER the analytic gradient**, never replacing it, so the gradient stays the
  authority on the colour of the air and dawn/dusk keeps working.
- **Night sky un-hidden** — `skyVisible:false` + flat `bgColor 0x0a1224` → `true` + `null`. That
  needed a night key for the gradient (`NIGHT_SKY_*`): the dome carried day colours only, which is
  precisely why it was hidden. `sky.renderOrder = -2` is the line that makes it possible — stars are
  renderOrder −1 with `depthWrite:false`, so an opaque dome at the default 0 paints over them.
- Tests 177 → 178.

## 2026-08-26 — v3 P3-05 (part): the 8 facade BODY layers

8 × 1024² at exactly **128 texels/m** over 8.0 m × 8.0 m (2 storeys of 4.0 m), authored to
`facadeArray.js`'s UV spec. Window mask derived and shipped in the albedo's **alpha channel** — one
upload, not two.

- **All eight tile at 0.00 in both axes.** They arrived framed off-grid (worst: `commercial` at
  **46.04**) and `align_tiling` fixed every one losslessly, because the wrap point where a facade
  changes least IS the blank render between storeys — which is exactly the seam the spec names as
  "the single most visible authoring error". **The blend rung is disabled for facades**: a blended
  facade ghosts every window, so a plate that will not roll into alignment is rejected, not smeared.
- **`align_tiling` is now SEPARABLE.** The u-seam depends only on the column roll and the v-seam only
  on the row roll, so the axes are independent 1-D searches. The old 2-D brute force did not finish
  in two minutes on a 1254 px facade and only ever found a coarse-grid answer.
- **Normalize the plaster, NOT the windows.** A facade is render *plus* glazing *plus* ironwork, and
  the `facade` class (L\* 74 / C\* 14) describes only the first. Grading the whole image turned the
  office glazing **mint green** — the rescale lifted it toward plaster lightness and the palette snap
  rotated its near-neutral hue onto an anchor. Statistics are now gathered over plaster only and the
  graded result composited back over plaster only. Measured effect: office plaster reads L\* 75.3
  instead of 54.9, because the glass was dragging it down 20 points.

**Open on this task:** the 8 GROUND-array shopfront layers, KTX2 encode (PNG for now), and wiring
`?facadearray=1` off placeholder layers onto these.
- **Window mask reworked, and honestly it is 6/8.** The first heuristic ("dark and desaturated")
  returned 0.7% and 0.2% on two plates whose glazing sits behind pale curtains. It now measures
  distance from the plaster's own modal colour — taking the **lightest** significant cluster, not the
  largest, because on a curtain-wall office the glazing IS the biggest cluster and the mode picked
  the glass (source L\* read 24.3 and the mask came back 0.0%). Three signals: dark with a real
  margin (bare "darker" flagged the old-town facade's exposed STONE), not warmer than the render
  (separates glass from masonry when both are dark), and filled rather than linear (mortar joints lit
  up the whole brick warehouse).
  **Still poor on `residential_grey` (4.4%) and `residential_oldtown` (1.9%)** — both have bright
  glazing, and no luminance-based test can find a window lighter than the wall around it. The robust
  fix is structural: windows sit in a regular grid detectable from row/column profiles. Not attempted.

## 2026-08-26 — KTX2 encoding: the library was over budget, now it has 145 MiB spare

`basisu` installed (Homebrew has no `ktx` formula; `basis_universal` provides the encoder).
`tools/encodeKtx2.py` is shared by every art tool.

| | RGBA8 | compressed |
|---|---|---|
| trees / bushes / rocks / road / kerb / sky | 146.7 MiB | 33.8 MiB |
| facades | 85.3 MiB | 21.3 MiB |
| **total** | **231.9 MiB** | **55.2 MiB** |

**The library was 32 MiB OVER the 200 MiB budget uncompressed** — an earlier estimate of 196 MiB
under-counted. It now has **145 MiB spare**.

- **Codec choice is not a preference.** UASTC for anything whose ALPHA CARRIES DATA (the facade
  window mask, the tree/bush cutouts, sky cloud coverage) and for every NORMAL map — ETC1S quantises
  to a small palette, which bands a mask's edges and turns a normal map into facets. ETC1S for opaque
  photographic colour, where its ~6:1 beats UASTC's ~4:1 and its artefacts hide in the detail.
- **Facades ship as ONE layered KTX2 array, not 8 files.** Eight files loaded into a
  `DataArrayTexture` would decompress to RGBA8 on upload and cost 85 MiB where the layered compressed
  array costs 21 — the file has to arrive already layered *and* already compressed.
- **`FACADE_ARRAY` now defaults ON** (`?facadearray=0` reverts). It was opt-in because P3-04 shipped
  the shader path against placeholder layers that looked worse than what they replaced.
- The placeholder's "no mipmaps or the texture samples BLACK" warning does **not** apply to the real
  path and explicitly asked to be re-checked here: a KTX2 ships its mip chain in the file, so the
  chain is complete on arrival and `LinearMipmapLinearFilter` is required, not merely safe.
- **Facade array load: wait for the renderer, and REPORT failure.** First version returned `null`
  immediately if the renderer was absent and swallowed every error in a bare `catch` — so a failed
  load looked exactly like a working placeholder (flat tint, black window rectangles) with no clue
  why. `createFacadeArrays` runs lazily on the first tile build, which can precede the boot warm-up,
  so the renderer genuinely was absent. The renderer is now handed over the moment it is constructed
  in `scene.js`, the loader awaits it rather than giving up, and both success and failure log.
- **Facade windows were stretched: the facade UV is NOT the wall UV.** The wall attribute is the
  legacy convention — u repeats every `WALL_REPEAT_HORIZONTAL_M` (**12 m**) and v every
  `FLOOR_HEIGHT` (**10 m**), both chosen for the old painted-canvas facades. The authored layers are
  **8 m × 8 m**. Sampling the array with the raw attribute stretched every layer 12/8 across and 10/8
  up — **different factors**, so windows rendered landscape where the plate drew them portrait.
  The vertex patch now converts into layer space. Done in the shader rather than by changing
  `FLOOR_HEIGHT`, because the vertex-colour path still depends on those constants and
  `?facadearray=0` has to keep working. (`buildingConstants.js` already warned "⚠ P3 WILL CHANGE
  THESE".) Note `bandUV()` computes exactly these repeats and **has no callers** — dead since P3-04.
- **Facades were upside down: KTX2 is bottom-up and three cannot flip compressed data.** PNG is
  top-down; `flipY` is ignored for block-compressed textures because there is no way to flip the
  blocks on upload. Balconies and sills rendered ABOVE their windows. The plates are now flipped
  **before encoding**, so the shipped artefact is correct by construction — a shader flip would work
  and leave a trap, with the `.ktx2` and `.png` disagreeing.
- **`BODY_LAYER_H_M` is derived from `STOREY_H`, not hardcoded.** The plan said "2 storeys of 4.0 m"
  and the constant read 8.0, while the bake's actual storey is **3.5 m** — so every window row
  drifted against the floor it belongs to and the layer sampled ~14% too small. Now `2 * STOREY_H`
  = 7.0, and it follows automatically if the modular-storey rebuild moves `STOREY_H`.
- **`window._ddFacadeSpan(widthM, heightM)`** — window size on screen is entirely a function of how
  many real metres a layer claims to span. The defaults are derived; "reads like a Barcelona street"
  is a separate question.

## 2026-08-26 — dev-knob cleanup

Tuning knobs are scaffolding: once a value is settled they are dead weight that still ships. Removed
the ones whose values are now fixed in code — `_ddTreeNight`, `_ddNightRig`, `_ddPanotSpan`,
`_ddAsphaltSpan`, `_ddFacadeSpan`.

⚠ Removing `_ddTreeNight` also took `setTreeCardNightMode` with it — it sat between the knob and the
test seam, and `envToggle` imports it. The suite caught it. Deleting a block by line range is exactly
how a working function leaves with its scaffolding.

**Deliberately kept**, each with a reason:
- `_ddReport` (F9) and `_ddRoadFit` — measurement instruments, not tuning knobs.
- `_ddVegCount` / `_ddVegPools` — the census that separated "not generated" from "not visible".
- `_ddRoadDetail`, `_ddWindowGlow`, `_ddFacadeTint` — their values are **not yet judged on screen**.
  They go when they are.
- `_ddBootDone` / `_ddGate` / `_ddModeLoadDone` / `_ddRapierActive` / `_ddRenderer` / `_ddTilePerf` /
  `_ddBenchResult` / `_ddLightGridAB` — pre-existing harness, not mine.

**URL switches stay.** `?treecards=0`, `?roadv2=0`, `?facadearray=0`, `?adaptres=0` are ATTRIBUTION
switches, a documented house convention: they exist so a frame-cost question can be answered rather
than argued. `?debug=*` are opt-in diagnostics that cost nothing when absent.

## 2026-08-26 — the facade stretch was a UNIT error, 2.86×

The wall UV has **two** vertical conventions and the array path uses the non-obvious one:

| | | |
|---|---|---|
| `u` | always | `wallLen / WALL_REPEAT_HORIZONTAL_M` — 12 m per repeat |
| `v` | legacy | `gFrac + bodyRepeats * bodyVPerTile` — **FLOOR_HEIGHT**, 10 m |
| `v` | **array** | `bodyH / STOREY_H` — **3.5 m** per repeat (`windowOnlyTile`) |

`windowOnlyTile` is set from the array flag, so whenever the facade shader runs v is **already
per-storey**. Dividing it by `FLOOR_HEIGHT` made a layer span **4.2 m vertically against 12 m
horizontally** — every window **2.86× too wide**.

Three `BODY_LAYER_H_M` values were tried against this (8.0 → 7.0 → 12.0) and none could work:
**rescaling an axis cannot fix a wrong unit.** 12×12 "looked best" only because it was
*compensating* for the stretch. With `v` divided by `STOREY_H`, the layer is `2 × STOREY_H` square
and maps a **7 m × 7 m** patch of wall at aspect **1.00**.

A test now asserts the layer maps a square patch, and that the v scale uses `STOREY_H`.

**Also fixed:** the dev-knob cleanup deleted `let _bikeLaneMaterial` / `_curbMaterial` /
`_bikePictogramMaterial` along with a knob block — a runtime `ReferenceError` that `node --check`
cannot see. Restored, and every cleanup-touched file scanned for the same class of loss.

## 2026-08-26 — the window mask is gone; night windows are a generated grid

**The mask was the wrong tool for emission and I shipped it anyway.** It is derived from COLOUR —
distance from the plaster's modal hue — and I had measured it good on **six of eight** plates. Six of
eight is fine for deciding which pixels to GRADE; it is useless for deciding which pixels EMIT,
because every dirty patch becomes a glowing blob. On screen: whole balconies, mouldings and wall
sections lit blinding white. Knowing the number and shipping it anyway is the error, not the mask.

- **Night windows are now a generated grid** drawn in the SAME UV space as the facade, so it aligns
  with the painted windows by construction — which was the original reason for abandoning the old
  `emissiveMap`, and it holds here without depending on mask quality. Per-cell hashes give lit/unlit
  (42%), colour temperature (amber → warm white, inside N3) and brightness, so a street reads as
  occupied rather than switched on. Body band only: the ground band is a shopfront, not flats.
- **The albedo ships OPAQUE.** Alpha carried the mask and the shader multiplied it into
  `diffuseColor.a`, which punches holes at the windows in daylight on any material with transparency
  or an alphaTest. With no consumer left, the channel goes.
- **Facade albedo array 8.60 MB → 1.36 MB.** Opaque means ETC1S is now the right codec (~6:1 against
  UASTC's ~4:1); the normal stays UASTC, which ETC1S would band into facets.
- `not_plaster` is still computed and still used — for normalize statistics, which is the job a
  colour-derived mask is genuinely good at.
- **The lit boxes glowed in daylight.** Writing `totalEmissiveRadiance` directly **bypasses**
  `emissiveIntensity`, which is exactly the mechanism the day path uses to switch window glow off
  (`meshMaterializer` sets it to 0 by day). Now gated on an explicit `uFacadeNight` — a **float**, so
  it rides envToggle's transition lerp and crosses over with the rest of the rig instead of popping.
- **Window glow 0.55 → 1.35, and warmer at both ends.** Bloom keys off values **above 1**, so at 0.55
  nothing ever reached the threshold: the windows were lit but inert and the city read grey. The tone
  carries the colour and the glow carries the ENERGY — the two were being confused. Tone shifted
  warmer at both ends (its cool end is now warmer than the old warm end), since a city lit by neutral
  windows reads grey however bright it is.

## 2026-08-26 — a static check for the bug that shipped three times

`setFacadeArrayNightMode` was called without being imported — the third runtime break in one session
from an edit that removed or skipped a declaration (`_bikeLaneMaterial`, `setTreeCardNightMode` were
the others). **All three passed `node --check`, passed the whole suite, and built cleanly**, because a
reference inside a function body is only resolved when that function RUNS. The game died on the first
tile build. `node --check` parses; it does not resolve, and there is no linter in this project.

`test/undefinedRefs.test.js` asks one precise question: **is a name another module exports being
CALLED here without being imported here?** That is the exact shape of all three breaks, and a global
or a property access can never look like it.

**Deliberately narrow.** The first version flagged `this._sfxBus`, `setTimeout` and object-literal
keys — dozens of false positives, and a check that cries wolf gets switched off, at which point it
catches nothing. The second still flagged four working call sites: function parameters (dependency
injection like `createTileManager(scene, createRoadMeshes, …)`) and destructured bindings
(`const { latLonToWorld } = deps`, `const { createRapierWorldAdapter } = await import(…)`). Both are
now understood.

**Verified by reintroducing the bugs**: deleting the import of `setFacadeArrayNightMode` or
`setTreeCardNightMode` is detected; restoring it passes.
- **Bloom blew the city white — the fault was window AREA, not level.** The first grid used
  cell-relative fractions that came out nearly square and roughly panel-sized. Bloom responds to area
  as much as to level, so an over-large window cannot be fixed by dimming it: 1.35 was already BELOW
  the old path's `NIGHT_EMISSIVE_INTENSITY = 1.5` and still blew out far worse. Window dimensions are
  now taken from the system this replaced — `buildingRenderer`'s residential style, **1.1 m × 2.0 m
  on 1.4/1.0 m gaps**, real portrait openings — and derived from the layer span, so they stay 1.1×2.0
  whatever the span becomes. With the geometry right the level lands at **0.85** against the old
  path's 1.5, i.e. ~43% dimmer than before rather than brighter.
- **Window colour is now THREE DISCRETE BULBS, not a blend.** A continuous mix between two warm
  colours reads as one hue however wide the range — every window came out the same warm cream.
  Picking between separate stops is what makes a street look like different households with
  different lamps. All three are from the art bible's §4.2 closed set: **N1 Sodium Amber** for the
  orange end, a yellow between it and N3, and **N2 Warm LED** for the coolest.
- `_ddWindowGlow` removed — bloom signed off at 0.85.

## 2026-08-26 — v3 P3-05 COMPLETE: the 8 ground-array shopfronts

8 × 896×512 at **128 texels/m on both axes** over 7.0 m × 4.0 m. The plan allowed 64 across on a
512 square; a 1.75:1 page hits the body layers' density in *both* directions for the same memory,
and a square page would have stretched every shopfront 1.75× horizontally.

**The ground layer is not the body layer, and three things follow from it:**
- **Tile check and repair are u-ONLY.** A shopfront tiles along a street and never vertically —
  bottom edge is pavement, top meets the body band. Judging the v seam would fail a correct texture,
  and rolling v would slide the pavement plinth off the bottom and wrap it to the top. All 8 pass at
  **0.00** horizontally after alignment (worst raw: 8.54).
- **The ground band's `v` now maps 0 → 1**, not `0 → groundH/FLOOR_HEIGHT`. That `gFrac` is the
  LEGACY fraction telling the canvas painter which slice of a *shared* tile held the shopfront;
  against a dedicated ground layer it squashed the whole shopfront into the bottom third of itself.
- **The shader picks a scale per band.** Body `v` arrives per-STOREY and needs dividing into layer
  space; ground `v` is already 0→1. `u` stays shared — the suite asserts it, so the vertical seam
  lines up horizontally.

**No L\* or C\* rescale on shopfronts.** A shopfront's VALUE is its identity — dark green joinery,
dark glass, a pale stone plinth — and the `facade` class describes a WALL at L\* 74. Applying it
lifted the green bar **22.8 → 73.8** (51 points) and rendered it pale mint; every plate came out
bleached. Chroma is left alone for the same reason: a greengrocer's produce is real object colour,
not a material sample. De-light, palette snap and the pre-grade divide all still run — those are what
normalize is actually for here. `rescale_L` / `rescale_C` are now options on `normalize_albedo`.

All 8 pass gate 4 (ΔE 3.24–10.25). Arrays: albedo **0.39 MB** (ETC1S), normal 4.20 MB (UASTC).
**P3-05 and P3-08 both closed — 63 done, 1 partial, 20 open. P3 is complete.**

## 2026-08-27 — Awnings: remove the competing legacy slab, normalize the toldo palette, unshare the row layout

- **Two awning systems were live.** `map/awningRenderer.js` builds the real Barcelona toldos (sloped
  canopy + front valance, 2.9 m back, 1.35 m projection). `map/buildingRenderer.js` also emitted a
  Delhi-era flat slate slab (`0x3A5060`) at `floorH-0.3` (~2.7 m) projecting 1.2 m, spanning the
  WHOLE edge rather than segmented per shop. On every `commercial` building the two occupied almost
  the same volume and the dark full-length slab won, which is why toldos "weren't there". The legacy
  slab and its `awningGeoms` group are deleted; awnings are `awningRenderer`'s alone.
- **Toldo palette normalized** to the art bible `fabric` class (L\* 60±15, C\* 30) + step-6 pre-grade.
  The old list was eyeballed hex at **L\* 21–32 — a full band below the class floor of 45**, so it
  read as near-black slabs, not fabric. Teal dropped: nearest anchor `mediterrani_blue` at ΔE 16.98,
  over the gate-4 threshold of 15 (no cyan-green anchor exists in the palette); sage replaces it at
  ΔE 6.67. All eight entries now pass gate 4.
- **Row layout is now shared, not copied.** `SHOP_ROW` is exported from `shopfrontRenderer.js` and
  imported by `awningRenderer.js`. Two files previously held hand-synced copies under a "MUST stay
  IDENTICAL" comment; drift there produces canopies floating on blank wall and throws nothing.
- **Density raised.** `MAX_SEGS_PER_BUILDING` 4 → 8 (a 4-bay row is 14.8 m, so a 25 m parcel got one
  short island of shops mid-frontage with blank wall either side) and `SEG_CAP` 260 → 650. The old
  cap was binding: on a dense tile it ran out around parcel 100, so the last third of the tile got
  no shops at all, biased purely by array order. Measured on a synthetic 150-parcel tile: 626 toldos
  (was capped at 260), 3,756 verts / 2,504 tris, and shopfronts 12,520 verts — **draw-call count
  unchanged**, since the caps only enlarge the three already-merged meshes.
- New `frontend/test/awnings.test.js` pins bay alignment, outward projection, the palette band, the
  per-building cap, and the absence of the legacy slab.

## 2026-08-27 — 3D shopfront becomes night-only (P3-05's texture owns daylight)

- The 3D `shopfrontRenderer` predates P3-05, which bakes a complete shopfront (joinery, glazing bars,
  produce, signage) into the facade GROUND array layer. Both were drawing. In daylight the 3D one
  wins and looks worse: its glass is an unlit `MeshBasic` at `0x16242c`, so it reads as a flat
  dark-navy slab parked in front of the artwork. User-reported from a drive.
- At night the roles invert — the texture has no interior light, and the amber glass (`GLASS_NIGHT`)
  is what makes a shop read as open. So: **texture owns the day, geometry owns the night.**
- **The switch is on `material.visible`, not `mesh.visible`.** `tileManager` (~:3041) already owns
  `mesh.visible` for the per-tile distance LOD and rewrites it whenever the viewer moves, so a
  mesh-level toggle would survive roughly one frame.
- The frame material is now a shared singleton like the glass (it has no per-tile state — the
  frame/kick split rides on vertex colours). Saves a material allocation per tile, and gives the
  night toggle something to switch. Tagged `sharedMaterial: true` so tile unload doesn't dispose it.
- `frontend/test/awnings.test.js` gains a test pinning day-hidden / night-visible, the
  material-not-mesh rule, and the shared-material tagging.

## 2026-08-27 — Shop-name boards: lit material, normalized palette, painted plate

User-reported from a drive ("too fake"). Three independent causes, all in `shopSignRenderer.js`:

- **`MeshBasicMaterial` — unlit.** The board was the same brightness at noon, at dusk and under an
  awning, which is precisely what "pasted on" looks like. The night handling made it worse: it
  swapped `color` to a flat grey (`0x6a6a78`), a hand-drawn substitute for the lighting the material
  was opting out of. Now `MeshLambertMaterial` — same single InstancedMesh, no extra draw call — so
  a sign under a street lamp is genuinely brighter than one between two. Night adds a warm emissive
  **through the atlas as an `emissiveMap`**, so each board glows in its own colour rather than every
  sign lifting to the same grey. `emissiveMap` is bound at construction (adding a map slot later
  forces a mid-drive recompile, G-53).
  - ⚠ **`vEmissiveMapUv` had to be set alongside `vMapUv`** in the instancing patch. three declares
    one varying per map slot, so binding `emissiveMap` without it leaves every sign glowing cell 0
    of the atlas while its albedo shows the right name.
- **Palette never normalized.** Raw eyeballed hex; **six of eight failed gate 4**. The maroon in the
  screenshot measured **C\* 53.1 at L\* 32** — nearly double the highest material class. Re-derived
  with a chroma ceiling of 42 (above `fabric`'s 30, since signage is deliberately an accent; far
  below the raw 53–60) and an L\* floor off black, every entry ≤ ΔE 15. **Not** snapped to a surface
  class: there is no signage class, and a sign's colour is its identity — the same reasoning that
  stopped the shopfront plates being bleached to `facade` L\* 74. Green and burgundy sit in palette
  hue gaps and needed a ±6° nudge to reach an anchor; both keep full chroma.
- **A flat `fillRect` plus a 2 px stroke is a vector rectangle.** New `paintBoard()` adds a vertical
  shade ramp (a fascia hangs under an awning: occluded top, bounce-lit bottom — the biggest single
  cue), a bevel so the plate has thickness, seeded grain and corner grime, and a drop shadow so the
  letters sit on the board. Cell resolution 256×64 → 384×96 (128 texels/m on a 3 m fascia), and the
  atlas is mipmapped + anisotropic — unmipped text on a 3 m board seen from a moving car crawls.

`frontend/test/shopSigns.test.js` pins all six.

## 2026-08-27 — Both open art gates closed (jacaranda ΔE, washingtonia clip)

- **Gate 4 — added P11 jacaranda violet `#8E7FAB` to §4.1, restricted to `foliage_leaf`.** The ten
  existing anchors sit at hues 38–121° plus one at 251°, because §4.1 was derived from Barcelona's
  *built* environment; that leaves a 147° gap where violet lives. A jacaranda in flower (hue ~305°)
  had **P7 bordillo granite, a neutral grey, as its nearest anchor at ΔE 21** — so 17.01 was already
  the best achievable and the gate was reporting a hole in the PALETTE as a defect in the ASSET.
  Now **11.49**. `gate4_delta_e` takes a `surface_class` and defaults to the unrestricted ten, so a
  violet facade still can't pass on P11. **The P10-for-foliage amendment is withdrawn** — P10 was
  only admitted as the sole cool anchor, and §4.1 assigns it to water/haze.
- **Gate 6 — fixed in the grade, not the asset.** `gl_FragColor` floored at 0 but never ceilinged, so
  channels over 1.0 were clamped *independently*, changing the ratio between them — and the ratio is
  the hue. A sunlit washingtonia frond lost its green channel while red and blue survived, flattening
  to lime. `colorGradePass.js` now scales the whole triplet by one factor above a 0.85 knee, so hue
  survives exactly and highlights desaturate toward white like film. General fix, every asset gains.
- `tools/build-ktx2-library.py` is now **self-cleaning** — it deletes the PNG it just encoded and any
  contact sheet beside it. Leaving intermediates behind after every atlas rebuild is exactly how
  `public/` grew to 183 MB. It also resolves the two `art-src/legacy/` masters that have no build tool.
- New `frontend/test/colorGrade.test.js` proves the rolloff is hue-preserving by reimplementing the
  shader maths and asserting channel ratios survive, versus a 48% R:G skew under per-channel clamping.

## 2026-08-27 — P4-01 step 1–2: the terrain-bake proof passed (read-only, nothing deleted yet)

Two harnesses under `backend/tools/`, both read-only:

- `terrainBakeCensus.mjs` — **bakedTerrain is 384.6 MB, 68.4% of the 562.2 MB tile store.** Planning
  estimated 369 MB; confirmed and beaten. The elevation grid that would remain is 55.5 MB.
- `terrainRegenProof.mjs` — re-runs the real `bakeTerrainMesh` against each tile's own stored grid
  and compares every float and index. **442 of 444 tiles are bit-equal.**

**The cross-tile dependency the spec feared does not exist.** `bakeTerrainMesh` takes
`crossTileApproaches`, which a per-tile parser worker could never supply — but `buildRegion.js:1571`
passes `(payload.elevation, [], null, [], null)`. Every tunnel/water/approach input is empty, because
the legacy tunnel carve was disabled when the authored trench moved into the elevation grid. The
baker is a pure function of the grid in current practice.

**The 2 divergent tiles are stale, not unreproducible** — `gridSize 64` against `gridRows 128`, from
before GRID_SIZE moved to 128. They already fail the `useBaked` gate and take the runtime fallback in
production today, so the regeneration path is already live and correct; regenerating FIXES them.

**Uint16 indices are feasible**: max vertex index across all 444 tiles is 16 383 (max 16 384
verts/tile), so the 163.4 MB of Uint32 indices would halve if kept at all.

⚠ The spec's "4 known NaN-normal sea tiles" no longer exist — 0 of 444 tiles carry a NaN normal.

P4-01 risk drops from **high to low-medium**. The "delete" half is unchanged and still needs care:
the second runtime water dip (`terrainRenderer.js:225-260`) must go in the SAME commit or it
double-applies.

## 2026-08-27 — P4-01 complete (code): terrain is generated at load, both baked sections dropped

- `frontend/src/map/terrainGrid.js` generates the mesh from the elevation grid; `tileParserWorker`
  calls it per tile and hands the renderer the same shape `readBakedTerrain` used to, so the
  renderer's consuming path is unchanged. Indices are **Uint16** (max vertex index across all 444
  tiles is 16 383, measured). A tile with an unreadable grid still falls back to its bake.
- **The runtime fallback mesh (169 lines) and its water dip are deleted together.** That path pushed
  water vertices to `seaLevelNorm + depthTarget` while the baker does not dip at all. Two mesh
  generators disagreeing about water depth is exactly the double-apply landmine P4-03 warns about:
  once P4-03 bakes the sea sink into the grid, a surviving runtime dip would subtract a second time.
  The sea sink is P4-03's job, in the grid, once.
- `buildRegion.js` no longer bakes **either** terrain section:
  - `bakedTerrain` **384.6 MB** (68.4% of a 565.9 MB store) — proven redundant, 442/444 bit-equal.
  - `bakedPhysicsTerrain` **15.0 MB** — zero consumers since v3 P0-12 deleted its parse; terrain
    physics is a Heightfield from the grid, never a Trimesh. Pure freight.
  - Together **399.6 MB, ~71% of the tile store.**
- `terrainBaker.js` is deliberately kept: the proof harness runs the real function, so it stays the
  reference the frontend generator is tested against.
- ⚠ **The re-bake has NOT been run.** The saving only lands when tiles are rewritten; the runtime
  ignores the sections either way, so nothing is broken by waiting. Deferred so the terrain render
  is confirmed on one drive first — otherwise a fault means two 10–30 min bakes instead of one.

## 2026-08-27 — P4-01 re-bake: tile store 567 MB → 177 MB (−69%)

Full region re-bake in 489.7 s, exit 0. `bakedTerrain` and `bakedPhysicsTerrain` are no longer
emitted; the elevation grid (55.5 MB) is untouched and every in-bbox tile still carries it.

⚠ **12 ORPHAN TILES remain, and they are pre-existing, not a bake failure.** All 12 sit OUTSIDE the
current region bbox (lon 2.1198–2.2230, lat 41.3580–41.4130) and are dated **June/July** — leftovers
from earlier bakes with a wider bbox that `build:region` no longer regenerates. They still carry the
old baked sections (9.1 MB total). They are harmless: the parser generates a mesh from their grid
and the stale bake is ignored. But note the tension — **CLAUDE.md recommends `?spawn=41.4180,2.1150`
(Collserola) for hillside checks, and that is outside the bbox**, so those tiles can never be
refreshed by a re-bake. Either the bbox should grow to cover Collserola or that recommendation
should change; it is a decision, not a bug, so nothing was deleted.

`frontend/test/terrainGrid.test.js` had to change with the re-bake: its reference data WAS every
tile's baked mesh, and now only ~12 of 445 have one. A blind stride sample found exactly **one**
comparable tile, so the bit-equality test was on the verge of passing while asserting almost nothing.
It now SELECTS tiles that carry a bake, and asserts a floor of 3 — failing loudly rather than
vacuously if the orphans are ever tidied away.

## 2026-08-27 — P4-02: terrain LOD rings, and terrain leaves the fog cull

- **The real defect was the cull, not the LOD.** Terrain was hidden with buildings and vegetation at
  `FOG_FULL_DIST` = 280 m. At the shipping FogExp2 density of **0.0025, 280 m is only 38.7% fogged** —
  so the ground was being deleted while still ~61% visible, and that is precisely why Barcelona has
  no distant landform: Montjuïc and the Collserola ridge stop existing 280 m out. Buildings and
  vegetation are detail and stay culled; the ground is not detail.
- **Three index rings over ONE vertex buffer** — 32,258 / 7,938 / 1,922 triangles, exactly the
  planned counts, verified against a real tile. Switching ring is a `setIndex`: no vertex re-upload,
  no second mesh, no extra draw call.
- Distances are measured, not chosen by eye. **FULL below 500 m is a hard floor** — roads drape on
  the full grid, so a coarser ring moves the ground out from under them. 1:2 to 900 m (fog is 89.5%
  at 600 m, 98.2% at 800 m). 1:4 out to the 1500 m cut, where fog is ~100% and the surface is pure
  fog colour — it still earns its place because a fog-coloured mass **occludes the sky**, and the sky
  dome is not the horizon colour higher up. That difference is the silhouette. Expect a soft haze
  ridge, not visible detail.
- 60 m **asymmetric** hysteresis band: the flip point differs by direction, so a tile sitting on a
  boundary cannot oscillate. The test walks a viewer back and forth across it 200 times and asserts
  zero flips.

## 2026-08-27 — VEG-FIX-1: the tree LOD handover had a hole and a cliff

User-reported: *"I see trees on the far, but when I move closer they just disappear and I see a
random hilly plane"* — and the reverse, *"I don't see any trees at all, but they immediately come."*

**Measured total tree presence driving toward a hill, before the fix:**

| 400 m | 250 m | 171 m | **169 m** | 120 m | 80 m |
|---|---|---|---|---|---|
| 0.47 | 0.81 | 1.00 | **0.01** | 0.56 | 1.00 |

The 3D trees fade their COUNT out across 80–170 m, but impostors did not begin until 170 m. So that
band was a **hole**, and 170 m was a **100% → 1% cliff** the instant you crossed it going inward.
Pre-existing — P4-02 only made it visible, by finally showing the distance it happens at.

- `impostorFrac` now **complements** the 3D fade instead of following it: it rises 0→1 across 80–170
  as the 3D count falls 1→0 (summing to 1), holds at 1 to 300 m, then fades to 0 by 600 m.
  Total presence is flat 1.00 from 0–300 m and the largest step over a 1 m move is < 0.02.
- Impostors also now **survive the 280 m fog cull** out to 600 m. P4-02 took terrain to 1500 m while
  vegetation still died at 280, leaving ~1200 m of bare ground. 600 m is where FogExp2 at 0.0025
  reaches 89.5% — past that vegetation cannot be seen, so going further would be cost with no image.
  Only `billboard` handles survive; 3D trees and bushes stay culled (a bush is a couple of pixels at
  that range and there are thousands per tile).

⚠ **SEPARATE, STILL OPEN — Collserola has no vegetation at all.** Median baked tree count on hilly
tiles (relief > 80 m) is **0**, against **217.5** on flat ones. The zero-tree hill tiles are exactly
the 12 **orphans outside the region bbox** (lat 41.416–41.424): June-era, never re-baked, carrying a
single `greens` polygon and no baked trees. So the ridge renders as green-tinted bare ground. This is
the bbox decision already flagged in the P4-01 re-bake note — the fix is to widen the bbox and
re-bake, not to touch the LOD.

## 2026-08-27 — VEG-FIX-2: hills were bare because OSM tags a wooded hill and a plaza garden the same

User-reported: *"the hill still is empty… nothing much coming on the hill, makes it very bare and plain."*

Measured before: **Montjuïc 332 trees vs a flat Eixample tile's 3,812** — the hill was 11× sparser
than the city. Cause: Montjuïc's greens are **236,238 m² of `park`** against only 16,372 m² of
`forest`, and the `park` rule is **1 tree / 500 m²** (22 m spacing) — a description of a formal city
square. OSM uses `leisure=park` for both a 20×20 m plaza garden and an entire wooded hill.

- **Woodedness by area.** No new data needed: below 1 ha the authored density stands; at or above
  10 ha it reaches a wooded target (park 1/60, grass 1/120, scrub 1/90); between, it interpolates on
  **log(area)**, because the step from 1 to 10 ha is not perceptually linear. Applied to park/grass/
  scrub only — `garden` is formal by definition, `forest` was already dense.
- `MAX_ZONE_TREES_PER_TILE` **800 → 3000**. Never a performance limit: a flat tile already baked and
  rendered 3,812 trees, so 800 for a whole hillside was arbitrary. `park.treeCap` 250 → 1800.
- **Result:** hilly tiles (relief > 80 m) go from a median of **0** to **1,077** trees; flat tiles
  sit at 230. Hills now carry 4.7× the vegetation of flat city, which is the right way round.
  Tile store 177 → 178 MB.

⚠ Diagnostic note for future work: `bakedVegetation` carries **`treeCount` AND `zoneTreeCount` as
separate sets**. Reading `treeCount` alone shows no change from a zone-density edit and looks like a
failed fix — it was misread exactly that way during this task.

## 2026-08-27 — P-R1a: persist the defect census the bake already computes

`buildRegion.js` now writes `data/regions/<region>/defect-census.json`. Detection only, zero repairs.

The bake already knew which roads it deleted — `droppedRampIds` holds **332** — and printed a count
while discarding the list. Those are not parse failures: they parse fine, are judged unusable by
`isBrokenRampRoad`, and are deleted. The census persists **every OSM way id**, so each is checkable
at `openstreetmap.org/way/<id>`. P-R1 budgeted 1.5 d for detectors; this half needed none.

Also records `unmeasured: [H1, H2, H3, M1, M2, M3]` — **way stitching is switched off**
(`[3/8] Skipping way stitching`), so reporting `H3: 0` would be a lie. Unknown is the honest value.
V5 is labelled a floor, not the class: 5 hand-listed roads against a measured 8.8% of buried points.

## 2026-08-27 — The tree pop was an LOD *timing* bug, not an LOD *distance* bug

User-reported: *"trees came there after I cross the place… when I came near them they disappear"*,
and decisively: *"when I drive fast I don't see, but if I slow down and move around I see them."*

`_ddVegLod()` showed the fade maths was already correct at every distance —
`tree 955/3332 + billboard 2375/3332` at 144 m, summing to the total everywhere. So the distances
were never the problem.

**The cause:** `_lastLodX = -Infinity` (the LOD invalidation) fires when the tile ENTRY is created —
the *start* of the build. Vegetation is materialized at the *end*, many awaits later, by which time
that forced pass has run and moved on. Tree handles are added `startVisible = true`, so until an LOD
pass touches them **every tree in the tile draws at full density regardless of distance** — and the
pass only runs once the viewer has moved 15 m (`LOD_THRESHOLD_SQ`).

That produces a pop in both directions, which is why it read as a distance problem:
- cross into a tile → it finishes building → the whole canopy appears at once
- move 15 m → the LOD finally runs → it thins to the correct fraction

And it explains the speed dependence exactly: **driving fast keeps the LOD running constantly, so
you only ever saw the correct density. The lush version was the bug.**

Fix: re-invalidate after the vegetation handles are pushed. Both invalidation points are needed —
one covers meshes built early, the other vegetation built late. `frontend/test/vegLodTiming.test.js`
pins it, including that trees keep `startVisible = true`: "fixing" it by adding them hidden would
leave a tile built between passes showing *nothing* for 15 m, which is worse.

Two probes were added getting here and both are worth keeping: `_ddVegCount()` now separates
**allocated from DRAWN** (`BatchedMesh.instanceCount` is allocation, not visibility), and
`_ddVegLod()` reports per-tile band, both fractions, and visible/total per handle kind — the total
alone could never say *which* tile was bare.

## 2026-08-27 — P-R1 acted on: keep drivable Case-C ramps, and what the census actually proved

**The census overturned my own hypothesis, which is what it was for.** I had suggested the 332
deleted roads might be recoverable by simply not deleting them. Measured, that is wrong for the bulk:

```
by rule:  profile-backstop 358  ·  caseC-flag 4
backstop PROFILE grade %:  min 60 · p10 65.9 · p50 94.2 · p90 196.7 · max 3181
                           at or below 25%: 0 of 358      at or below 50%: 0 of 358
```

And the type breakdown is the real result — **most "missing roads" are staircases**:

| service | steps | corridor | footway | residential | tertiary+ / links |
|---|---|---|---|---|---|
| 124 | 114 | 43 | 24 | 26 | ~28 |

`steps` at 650–750% grade *is* a staircase. Deleting 305 stairs/footways/corridors/service passages
is correct, not a defect. That leaves ~54 drivable ways, not 332.

**What changed:** the Case-C path. `brokenRamp` was `flattenedShortTunnel && !flat` — "delete if the
ends differ at all". RampResolver had already given those ways a **monotonic profile matching both
endpoint heights**: valid, connected geometry, its own comment calling it "a short ramp, which may be
steep". The census measured exactly four such ways, at **16.2 / 22 / 26.5 / 27.3 %**. Barcelona has
public streets steeper than that, and a steep ramp beats a hole where a connector belongs.

Now gated on grade (`CASE_C_KEEP_GRADE_PCT`, default 30 — above the measured worst, far below the
cliff backstop). The >60% backstop is untouched.

**Still open, and now correctly scoped:** ~50 drivable roads dropped at >60%, including a `primary`
at **3181%**. A primary road cannot be that steep — the road is not the defect, its height data is.
That is V3 layer-conflict or V5 terrain-conflict upstream, and the backstop is correctly catching a
symptom whose cause is elsewhere. It needs the P-R1b detector, which is also what the user's
"floating roads" complaint needs.

## 2026-08-27 — R-B2 barrier styles + FrontSide, both verified in a headless sandbox

The user could not check these by driving (movement required, four styles, subtle differences), so
both were built against measured geometry rather than by eye.

**FrontSide — and the winding bug it exposed.** Both rail materials were `DoubleSide`. Flipping
naively would have shipped holes: `test/guardRailWinding.test.js` builds a real rail and checks
per-face normals, and found the **inner wall pointing AWAY from the carriageway** (nz = +1.00 where
−1 was required). The wall is an OPEN shell — inner face, outer face, top, no bottom, no end caps —
so a back-facing quad is not a shading artefact, it is a hole you see the road through from certain
angles. That is *why* it was DoubleSide: the setting was hiding an inversion.

It cannot be fixed with a constant index order, because `inner → outer` points one way on the left
rail and the opposite way on the right — whichever order faces outward on one side faces inward on
the other. **The winding is now derived per run** from `sign(t.z·w.x − t.x·w.z)`. Verified on the
left rail, the right rail, a reversed run and a 90° curve, then FrontSide enabled on both materials.

**R-B2 · four styles, chosen from fields the tile already carries** (no re-bake, deterministic per
R-0). Colours art-bible normalized and pre-graded, worst ΔE **6.55**:

| style | when | top | tris / 40 m |
|---|---|---|---|
| `parapet` | bridge deck | 1.05 m | 60 |
| `jersey` | motorway/trunk + links | **0.81 m** (real New Jersey spec) | 60 |
| `guardrail` | ramps, elevated, primary/secondary | 0.75 m (W-beam) | 346 |
| `pedestrian` | urban street / median | 1.05 m | 494 |

**Performance: 46% fewer barrier triangles**, because parapet and jersey are solid to the top and
skip the post/beam pass entirely — and those are the styles on the longest continuous runs. Across
1,232 guarded segments: ~2.03 M → ~1.10 M triangles. All four styles still share **one material and
one merged mesh per tile**, because the per-style colour rides the vertex buffer.

**The sandbox earned itself immediately:** it built the pedestrian railing at **0.42 m** — a trip
hazard, not a railing — and the first "too low" threshold (0.4 m) was lax enough to pass it. Now
1.05 m, with a 0.7 m floor asserted. `test/barrierStyles.test.js` also pins that no two styles are
geometrically identical, that solid styles carry no posts, that posts sit ON their wall rather than
floating, and that nothing exceeds 1.25 m and walls the driver in.

## 2026-08-28 — vegetation: the missing street trees, and the rocks on the crossing

- **N-13 · a way ENDING is not a junction.** `getRoadsideTreePositions` booked a 10–18 m no-tree
  disc wherever a way endpoint fell within 8 m of a road segment. Under `noClipTileStrategy` one
  street is several way records, so every record's endpoint sits on its own continuation. Spawn
  tile: 501 discs, **353 of them phantoms**, the 500 cap HIT, **45.0% of roadside tree slots
  rejected**. Now requires a different way AND a non-collinear meeting (`isWayContinuation`), disc
  cut to 5–9 m (`junctionTreeClearance`), cap 500 → 4000. Same tile: 31.0%.
- **N-13b** roadside building margin 2 m → 0.6 m; measured 12.3% of surviving trees lost to it.
- **N-11 · the road guard was a point test at paved width.** Widened `isOnAnyRoad` to
  `corridorWidth` (safe only because trees are exempt at every call site) and gave it a `clearance`
  argument for the item's own footprint — a 2.5-scale flat stone could sit its centre outside the
  kerb and overhang the asphalt. Wired through `propRenderer` and `environmentClusterRenderer`.
  Baker gained `buildCorridorGrid` for baked bushes (small: 2.1% citywide).
- **N-12** noted, not fixed: `vegetationWorker` uses baked positions and skips runtime placement, so
  `vegetationRenderer`'s twin does not run in the shipped game. Sixth known copy-pair.
- **N-14** measurement method: density must be measured per tile against IN-BOUNDS road length —
  summing per-tile records double-counts every road. Corrected 27.2 m → **14.8 m** mean spacing.
- Docs: `CLAUDE.md` single-tile example pointed at `16_33143_24488`, which does not exist. Now the
  real spawn tile `16_33161_24477`.
- Tests: `frontend/test/vegetationJunctions.test.js` (6) pins the continuation rule and the disc
  radius; `clusterRoadGuard.test.js` re-pinned to the corridor contract + footprint clearance.
- **Measured after the full re-bake:** trees 95,575 → **145,904 (+53%)**; mean street-tree spacing
  per side **14.8 m → 9.7 m** (real Barcelona ~8 m); tree:bush **1.24 → 1.82 : 1**; sparsest tile
  97 → 55 m/side. No regression: trees in a carriageway held at 4.0%, the 0–3 m kerb band rose to
  67.9%, baked bushes inside a road corridor fell 2.1% → **0.2%**. Bake 7:44 vs an 8:20–8:44
  baseline. 370 tests green.

## 2026-08-28 (later) — vegetation, the two-rule split

- **N-16** cluster trees were exempt from the road guard: **848 stood in the carriageway**. The
  exemption rested on blaming the guard for damage actually done by the H16 ReferenceError.
  Verified `vegetationWorker.js` (the baked street-tree path) never references `isOnAnyRoad`.
  `_ddOnRoad()`: clusterTree on road **848 → 70** of 15,428.
- **N-17** guarding trees at CORRIDOR width then deleted the roadside greenery — the corridor
  includes the pavement, where a street tree stands. Split: **trees clear the ASPHALT**, **rocks and
  bushes must be in a GREEN REGION**. Non-green spots draw `URBAN_TREE_TEMPLATES` so the street gets
  a tree rather than nothing. `MAX_CLUSTERS_PER_TILE` 110 → 300. Confirmed on screen.
- `MAX_BUSHES_PER_TILE` cut to 450 then **restored to 1200** — `_ddVegCount()` showed only 896 baked
  bushes drawn against 12,882 cluster bushes, so the cut was aimed at the wrong layer.
- New probes: `_ddOnRoad()` (every instance vs the shared guard, grouped by renderer), `_ddVegY()`
  (raycast gap between tree base and ground). `_ddVegCount()` **already existed** and answers
  allocated-vs-drawn — check for a probe before writing one.
- Tagged `userData.type` on the four prop meshes and the veg pools (`veg:<name>`). See **H19**:
  three probes reported "nothing found" purely because untagged meshes report as minified names.

## 2026-08-28 (final) — the street trees, closed

- **N-19** green polygons were drawn FLAT at their centroid's elevation, so plants inside them
  floated (uphill) or sank (downhill). Signature: near-zero median, p95 of metres, even
  float/buried split. Every green vertex now samples its own elevation.
- **N-20** two stacked baker faults: placement measured from a width table wider than the bake's own
  output (residential 10 vs 5), pushing trees into buildings where they were deleted (18.2%); and
  the road guard insets 3–5 m, so it policed only the middle of the road. Plus my own 0.10 m
  clearance inside a 0.5 m grid's quantisation, which cost 19% of trees before it was reconciled.
- **FINAL, measured:** trees **95,575 → 174,712 (+83%)**, spacing **14.8 → 8.1 m/side** against
  Barcelona's real ~8, carriageway **4.0% → 0.0%**, correct kerb band **65.9% → 93.6%**, tree:bush
  **1.24 → 3.01 : 1**.

## 2026-08-28 — the environment scatter is DELETED

`frontend/src/map/propRenderer.js` and `frontend/src/map/environmentClusterRenderer.js` are gone,
with all their wiring in `tileManager` (imports, the `p4 props` and `p4 clusters` build phases, the
`propMesh` / `clusterMeshes` entry fields, unload/dispose, and the LOD visibility block).

**Why deletion and not a placement fix.** Three placement rules were tried in one day — a mask
margin, a corridor road guard, then green-regions-only — and the objects were still unwanted where
they landed LEGITIMATELY, on verges and pavements. User's ruling: *"lets remove logic of these
environment scatter itself man, or have logic for them to scatter only in green places where there
is no road and all, this can happen at bake only."* A rule that only ever admits "green space with
no road" is a question about MAP DATA, and it belongs in the bake, not in a renderer competing for
the frame budget.

**Unaffected:** street trees (baked, `vegetationWorker`), baked bushes (still road-guarded by
`isOnAnyRoad`, added df77328), zone trees, and every road change.

**Lost with it — read before assuming the hills are broken:** this renderer generated the Collserola
woodland (`WILD_MAX_CLUSTERS`) on ground OSM says nothing about. The region has TEN `forest`
polygons total, so the hillsides now carry only baked vegetation and may read bare.

**If it is ever wanted back, do it at the bake** (the user's own framing):
1. In `vegetationBaker`, scatter rock/bush positions ONLY inside `greens` polygons, tested against
   the polygon directly — not against a mask, and not against a runtime road guard.
2. ⚠ Roads are in MERCATOR at bake time while baked vegetation is in WORLD. Mixing them yields a
   mask that silently blocks nothing — this project has already shipped that bug once (N-7).
3. Ship the positions in the tile like `bushPositions`, and render them through the existing
   `vegPools` BatchedMesh path. No new per-tile renderer.

Frontend only, no re-bake. 364 tests green. Also removes the largest single build phase measured,
`p4 clusters` at 700-930 ms per load.

## 2026-08-28 — N-2: water was replicated 280x into every tile

`splitWatersByTile` passed `tileToBBox`'s `{south,west,north,east}` into a `bboxIntersects` that
reads `minLon/maxLon/minLat/maxLat`. Every field was `undefined`, every comparison false, so the
guard returned TRUE for every pair and every water polygon went into every tile.

Invisible because the result is CORRECT, just enormous — the frontend dedupes water by id.

**Measured on real tiles after re-bake:** records **71,120 → 1,012** (−98.6%), replication
**280x → 4.0x**, max polys in one tile **254 → 23**, tile set **167 MB → 149 MB** (−18 MB, −10.8%).

⚠ **The diagnostic that cracked it:** tiles-per-polygon was `min = median = max = 280`. A coarse
test gives a spread; a CONSTANT means the test never rejects. Look at the distribution, not the total.

Asserts added in both directions (a wrong-shaped box now throws; an empty result would too), and
`waterTileSplit.test.js` pins the rejection as well as the acceptance. 369 tests green.

## 2026-08-28 — N-1: partly fixed, and re-scoped

`rule5_duplicateRoadRemover` was never broken (~8,748 ways removed per bake). N-1 was its tail.
Relaxed to 5 m / 0.7 **only when two same-class ways also share a NAME** — 44 of 57 flagged pairs
did, and only 5 had differing names. rule5 8,748 → `{removed: 9576, strict: 3729, sameName: 5847}`,
**+828 duplicates**, no leak possible (strict thresholds untouched). Tests pin the contract.

⚠ **It did not move the overlap metric** (57 pairs, 7.9%, unchanged). My error: `n1d` flags pairs
whose RIBBONS overlap (up to 16 m apart) while rule5 removes pairs whose CENTRELINES are within
5 m. Built against one number, validated against another — the same premature-action trap as the
vegetation work earlier today.

Re-measured, the 57 split cleanly: **29 within 5 m (true duplicates, still surviving)** and
**28 at 5–14.8 m (NOT duplicates — two real ways each drawn at full street width)**. The latter is
now **N-21**, a width-model ticket, gated on first PROVING the darker-roads link with `_ddPick`.

## 2026-08-28 — collision wireframes were drawn in the wrong space; five tickets filed

- **N-26 FIXED.** `K` toggled, the HUD updated, the geometry was built — and every wireframe was
  placed in another part of the city. Collider positions are PHYSICS space, which **is
  `worldGroup`-local** ("ABSOLUTE world = -lx + originOffset"), and the group was added to `scene`,
  so all of it was mirrored across X and offset. The range filter shared the fault, comparing
  `camera.position` (scene space) with collider positions (physics space). Now parents to
  `worldGroup` and converts the camera into that space. ⚠ `debugColliders.js` (`?debug=tunnel`) adds
  to `scene` the same way — likely the same bug, unverified.
- **P4-18 regression fixed:** the portal falloff was applied to the tunnel FLOOR, dimming open
  daylighted trenches to 0.30 and turning stretches of Ronda de Dalt into dark navy slabs. Lining
  and ceiling keep the falloff; the drivable surface does not.
- **N-22 diagnosed, not fixed:** the "beige broad patches" are **sidewalk slabs floating ~7.8 m
  above the terrain** (pick: sidewalk y −4.36, road y −10.29, terrain y −12.15). A HEIGHT bug, not a
  tint — three earlier sessions chased it as a colour/plaza/water/mip problem and all were wrong.
- **N-23/N-24/N-25 filed:** roads ending in mid-air with no ramp and a missing tunnel mouth; no
  railings on ramps; trees on carriageways (the known, accepted cost of the vegetation revert).

⚠ **The X-mirror caught two probes in one day** — `_ddVegY` read instance matrices in local space,
and `collisionDebug` drew into scene space. Both times the symptom was "the tool reports nothing".
It is the first thing CLAUDE.md warns about, and it is still the most expensive trap here.

## 2026-08-28 — N-25 attempted, measured, reverted

Tried the narrow bake-side fix for trees in carriageways: a kerb-to-kerb `buildPavedGrid` replacing
the inset `buildGroundRoadGrid`, applied to BOTH tree paths (the building-perimeter path had never
had a road guard at all). Full region bake, then measured:

    trees                       561,280 -> 461,565
    inside a drawn carriageway    4,029 ->   4,029     ← IDENTICAL

99,715 trees deleted, zero offenders fixed. **Cause, confirmed in the shipped tile:** baked tree
positions are WORLD (`3942.5, 4082.8`); `road.points` at bake time are MERCATOR
(`240798.8, 5069865.5`). A grid built from road points sits ~240 km away, every lookup falls outside
it, and the guard is a silent no-op — the N-7 defect again, whose fix was in the reverted set.

**N-25 is therefore blocked on the coordinate space, not on the guard.** Reverted; tiles re-baked.

Lesson, and it is the session's standing one: the guard was added and the bake run WITHOUT a
rejection counter. A counter (D-23) would have shown `rejected 0` in seconds instead of after a
9-minute bake and a wrong 100k-tree deletion. **Never ship a guard without proof it fires.**

## 2026-08-28 — N-5 + N-6: urban feature tags, and Barcelona's fonts

Both live in `pbfUrbanFeatures.js` and were sized together in the tracker. Chosen for unattended
work because both are verifiable by COUNTING, not by eye.

- **N-5** `extractTags` kept only name/operator/brand, so every tile shipped `tags: {}` for
  subtypes. Replaced with a bounded whitelist of keys that change what is drawn — a whitelist and
  not `tags` wholesale, because OSM nodes carry survey dates and source URLs that would otherwise
  ride into every tile forever. **Tag coverage 11.1% → 87.9%, tile size unchanged at 149 MB.**
- **N-6** `amenity=drinking_water` was never imported. **1,041** now exist, against 115 fountains.

**The finding that matters more than either ticket:** `fire_hydrant:type` now lands on 490 of 537
hydrants and reads **underground 473 · pillar 15 · wall 2 · untagged 47**. `BUILDERS.fire_hydrant`
draws a pillar for all of them, so ~88% of Barcelona's hydrants are currently the wrong object — a
standing red post where the street has a flush cover plate. Filed as **N-27**; the font builder is
**N-28**.

Safe to bake unattended because `urbanFeatureRenderer` does `if (!builder) continue` — an unknown
type is skipped silently, so the drinking-water data lands with zero visual change.

## 2026-08-28 — N-22 retracted: the pick was misread

The "sidewalk floats 7.8 m" diagnosis was mine and it does not hold. `_ddPick` lists surfaces
**nearest-first along the ray**, and the two hits it was built on are **4.36 m apart horizontally**
— a ray descending a trench bank meets the pavement early and high, the carriageway later and low.
The 7.53 m gap is mostly the slope between two different places (implied grade 173%, which is a
sign the comparison is meaningless rather than that the world is broken).

Baked evidence points the other way and is far stronger: sidewalk minus nearest road, **1,759
samples, median +0.14 m** (a kerb is 0.15). Ruled out too: the sidewalk translate omits `× vertExag`
versus the road formula, but vertExag is **1**; and terrain uses the same frame.

**If revisited, sample sidewalk and road at the SAME XZ** — the `_ddVegY` shape. A pick cannot
answer it. Fourth time "beige pavement" has been diagnosed as something it was not (N-4).

## 2026-08-29 — guard rails where they belong, and a fixer that was talking to itself

- **N-35** guard rails are per-point on probe-only roads. A drop anywhere along a way used to rail
  its whole length, including through a merge. Structural roads (bridge/ramp/layer/trench) keep the
  end-to-end rail; everything else keeps a rail only beside an actual fall.
- **N-36** roundabout rail-exclusion zones became height-aware. 107 elevated roads (worst: a 24.1 m
  fall) were losing their barrier to a 2D circle that could not tell a flyover from an entry, and an
  elevated ring — the case that most needs a barrier — was excluded outright. Probe:
  `backend/tools/roundaboutRailAudit.mjs`. Runtime counter: `window._ddRailStats()`.
- **N-37** the OSM fixer's way-level output was never read. `buildRoadGeometry` consumed the
  pre-fixer array while `fixOsmData` edited a deep copy, so rule 7's synthesised links and rule 5's
  duplicate removals had no effect on the shipped tiles. `applyFixerToWays` reconciles them back.
  Rule 5's removals remain gated behind `FIXER_APPLY_REMOVALS=1` pending a look at what 20% fewer
  ways does to the city.
- **N-39** the synthesised links (N-32) had to survive the commit-blocking floor validator. Two of
  them did not: a two-point way up to 224 m long gives the trench carve a straight-line floor under
  a DEM-draped road. Links are now densified to 5 m, `ceil` with a minimum of two steps. Bake green,
  0 violations, 47 links shipped (9 tunnel / 38 at-grade).
- **N-41 / N-42** the floating-road investigation. `_ddNoGround` located it, the baked tiles proved
  it was a BAKE defect not a runtime one, and it split in three: correct-by-design trench decks
  (534), pavements over trenches with no deck at all (1,135 → fixed by N-42), and ramp profiles
  (N-41 — which turned out to fix little float but rescue 120 roads from deletion). Remaining real
  defect after both: **35 ramps (10.2%) and 45 non-ramps (0.1%)**, from 84/1,669.
- **N-45 / N-47** tunnel portals. Drivable height-steps at shared nodes 462 → 142, surface-meets-
  tunnel 366 → 71, and `BrokenRamp` 171 → 29 (≈142 roads no longer deleted for impossible grades).
  Cause: street and tunnel both ramped at the portal node in opposite directions, each targeting the
  other's base height rather than its actual profile. New: `junctionContinuity.js` runs every bake.
  Still failing on one road — the documented tunnel-under-water case, out of scope in v1.
- **N-49 rule 9** — a named street resuming across a gap is one street with its middle missing.
  Triage-first (`deadEndTriage.mjs`): 1,176 unjoined drivable ends scored by class, same-name-ahead,
  width and length. Rule 9 connected 199; the five worst dead ends in the city are gone, score ≥ 10
  went 29 → 19, and the 542-strong cul-de-sac tail moved by 2.
- **N-51 pillars** — now support every deck that is genuinely in the air, not only OSM `bridge=yes`.
  46 km of deck was unsupported against 2.5 km supported. Four bugs on the way, three of them the
  same shape (a set built for one question reused to answer another): position filters running
  before the height test, rigid 30 m spacing in a dense grid, and the deck matching its own
  footprint in the ground-road set. Confirmed on screen.
- **N-54 approach embankments** — the ~80 "floating roads" were re-measured before anything was
  built, and the measurement overturned the plan. The standing theory was the LAYER MODEL
  (`layer × LAYER_STEP` hoisting streets that cross nothing), which would have meant amending the
  LOCKED vertical-model spec. `floatJustifyAudit.mjs` then `floatClassify.mjs` split the population:
  of 34 drivable surface roads floating > 2 m, 13 have something passing beneath and have earned
  their height; of the remaining 21 — **APPROACH 18, ORPHAN 3, TAG 0**. The layer model causes
  ZERO of them. **The spec needs no change and the conversation it was going to require is moot.**
  The 18 are bridge APPROACHES: the high end meets a real deck at exactly its own top height, so
  the height is CORRECT and clamping them down would have torn 18 roads off the bridges they join.
  What is missing is underneath them — the embankment — and this project has no fill geometry.
  New `buildEmbankmentSkirtMeshes` (roadRenderer) + pure helpers in `map/embankment.js` (9 tests).
  The split rule is physical and free: **something beneath → viaduct (pillars); clear ground →
  embankment (retained skirt)**, both reading the identical beneath-test, capped at 9 m because
  above that a city builds a viaduct rather than filling. Because a pillar was only ever BUILT on
  clear ground, this adds no structure anywhere new — it changes what stands where columns already
  stood. Reuses the trench retaining plate rather than a new asset. ⚠ NOT YET SEEN ON SCREEN.
- **N-55 dead-end metric correction — and a decision NOT to build.** The 49 → 56 regression from
  the N-52 overlap gates was going to be paid back with an endpoint-WELD rule (where a connector is
  refused because a road already lies along its path, join the topology instead of drawing a second
  ribbon). Counting first killed it twice over:
  1. **The metric counts correct endings as defects.** `deadEndTriage` scores wrongness from class,
     name-ahead, width and length, and never asks whether the road should continue AS A ROAD. Of
     1,180 unjoined drivable ends: **30 are tunnel portals** (the road continues underground) and
     **249 become pedestrian** (Barcelona pedestrianises street-ends; the top-scored defect in the
     city, `Carrer d'Esteve Terradas` at 12, continues as a *footway* of the same name). The old
     top-of-list was mostly these, so "score ≥ 8 = 56" was never 56 defects.
  2. **The weld population is 14**, nearly all unnamed service roads dying into pedestrian plazas —
     several of which are correct refusals. Building for that is N-48 again.
  Corrected number: **258** ends have a drivable road ahead past the hairline gate, but 250 of those
  rest on "same class, other name" — two unnamed service roads in adjacent car parks are both
  `service`, which is not evidence. **Name-backed, the safely actionable set is 8**, refused mostly
  by rule 9's 53° cone, and relaxing that gate risks reintroducing the z-fighting the gates fixed.
  **Dead-end work is closed**; new tool `deadEndCause.mjs`, and the fixer's `rejectedOverlap`
  counter is split into `rejectedHairline` / `rejectedOnExistingRoad` so a refusal names its cause.
- **N-56 junction height-steps — hypothesis MEASURED AND REVERTED.** Chasing "3 orphan ramps" found
  no orphans. Two were an artefact of `floatClassify` anchoring on the point of greatest ABSOLUTE Y,
  which on a hillside is the uphill end sitting flat on the ground — `Viaducte de Vallcarca` was
  reported as meeting NOTHING while its floating end joins `Viaducte de Vallcarca [BRIDGE] L1` at
  exactly its own height. Anchored on max FLOAT instead: **ORPHAN 3 → 1, APPROACH 18 → 20**.
  The survivor was not an orphan either: it shares a node with `Moll Adossat` (bridge, L1) at zero
  distance and the two disagree about that node by exactly 6.0 m. So it is one of the 133 junction
  steps left after N-45/47, and new `junctionStepAudit.mjs` shows those have an unambiguous
  fingerprint — **every one is an exact integer multiple of LAYER_STEP** (124 at 6 m, 8 at 12 m,
  1 at 24 m; nothing at 3 or 7). A profile error cannot land on multiples of a constant; reading a
  base height instead of a profile does exactly that.
  The FIX was wrong, and the bake said so: an at-grade road was stopped from climbing to a bridge's
  base height (the mirror of N-47's tunnel rule). Steps went **133 → 177** and ramps 52 → 42.
  `otherElevatedAtNode` only inspects the shared node, so it cannot tell a bridge that is LANDING
  there from a long bridge genuinely elevated there — and refusing the climb onto the second kind
  creates more steps than it removes. **Reverted and re-baked; tiles verified back at 133/124/8/1.**
  The real fix needs the neighbour's ACTUAL height at the node, which does not exist when the
  resolver runs — a two-pass RampResolver, not a guard. Left as a decision, not started.
- **N-57 shared-node reconciliation (KEPT) + N-58 the instrument that explained it.** Pass two of
  `RampResolver`: every ramp decision is taken from neighbours' BASE heights because that is all
  that exists while profiles are being computed, so a reconciliation pass now runs last (after
  `smoothBridgeTransitions`) and bends only the last metres of a profile until both sides of a node
  agree. It changes NO decision — which is the lesson from N-56, where changing which neighbour a
  way aims at took steps 133 → 177. Guards: tunnels are never moved (floor slabs + commit-blocking
  validator), the far end never moves (`reach < L`, or fixing one node relocates the step), and the
  anchor is the least-free way present. Result **133 → 121**, `floatClassify` **ORPHAN 1 → 0** (the
  Moll Adossat ramp now meets the deck it shares a node with), FloorValidator unchanged.
  ⚠ **I predicted 45–60 and was wrong, and the counters are why it matters**: the bake found only
  **36 disagreeing nodes of 130,308** against the audit's 121. The bake matches by shared NODE ID;
  `junctionStepAudit` matches endpoints by POSITION within 1 m — different questions. Tiles carry no
  node ids, so the offline tool *cannot* tell "the same road at a join" from "two unconnected ways
  ending at the same spot". N-58 (`collectCoincidentUnjoined`, in-bake) measures the difference
  directly, because it decides which subsystem owns the defect: a shared node that disagrees is a
  ramp-profile problem, two coincident unjoined ends are a TOPOLOGY problem and belong to the
  dead-end family. Also new: `backend/tools/defects.mjs`, one command for the whole dashboard.
  **N-58's answer came back and killed my hypothesis too**: coincident-but-unjoined is only **8
  pairs, 6 of them disagreeing** — nothing like the ~90 the theory needed. The in-bake continuity
  census says **130 genuine drivable shared-node steps**, so they ARE joins, and the reason N-57
  saw only 36 was my own design: it required the node to be an ENDPOINT OF BOTH ways, which throws
  away every T-junction where one road ends on another road's middle. That is ~94 of the 130.
- **N-59 T-junction reconciliation.** A way passing THROUGH a node still must not bend — the
  original reasoning was right — but it can ANCHOR, and the way that ends there comes to meet it.
  Same asymmetry as N-47's tunnel rule, one level down. Anchor priority is now: passes-through
  first (no freedom at all), then a tunnel, then a way pass one left flat, then a ramp.
- **N-65 — the junction-step chain STOPS here, and the counter says why.** 130 → 102 across
  N-57/59/60/61. Of the 59 remaining "too short to blend" skips: **a way passes through 58**, more
  than two ways meet 0, tunnel meets surface 0, genuinely too short even across both sides 1. So
  the residue is one shape — a short road ending on a long road's middle, unable to absorb a 6 m
  step alone at ≤25% grade. The only fix left is letting the THROUGH-way bend symmetrically around
  the node, which is the same "move the thing that should not move" shape that misfired three times
  in one day (N-56 133→177, N-61's split lifting streets, N-62 costing 6 steps for nothing).
  **Not attempted.** The remaining 102 are a 6 m step at a T-junction, visible only if you drive
  onto one. If it is ever revisited, the population is already counted and `junctionStepAudit.mjs`
  plus the in-bake `[Continuity]` census are the instruments — and note the offline audit
  OVER-COUNTS, because tiles carry no node ids (see N-58).

## 2026-09-01 — cameras, fountain water, street furniture off the carriageway

- **Chase camera angle, not distance.** At 1.9 m the eye sat 0.7 m over a 1.2 m roofline, so the car
  was seen edge-on and covered 79% of the lower half-frame. Height 1.9 → 2.5, distance 6.2 → 6.6,
  look target 0.5 → 0.9 at 4.0 m. Tunnel cam had the same defect (1.2 → 1.95).
- **Hood cam → nose cam, placed against measured geometry.** It landed inside the bodywork twice
  because the offsets were reasoned from `CHASSIS_BOX_OFFSET_Y` and half of `M3_TARGET_LENGTH`;
  the load path recentres the body on Y only, so the nose is not at half the car length. `carModel`
  now exports `getBodyBounds()` and the eye sits 0.38 m ahead of the measured `max.z`.
- **Fountain water.** The 8 falling strands were 4-sided cylinders — no silhouette, so they aliased
  to hard lines. Replaced by one open-ended cone veil (cheaper than what it replaces). Falling water
  got its own near-white low-opacity material; the pool material went 0.75 → 0.88 opacity so the
  basin reads as a sheet.
- **`roadClearance.js` (new).** Both streetlights and traffic signals offset from ONE road, so at
  junctions/merges/roundabouts they stood in the crossing carriageway. New shared test against every
  drivable segment on the same layer, with a push-to-clear search. Lamps that cannot escape are
  dropped; signals are only nudged (a missing signal is worse than an imperfect one).
  `window._ddLampStats()` / `window._ddSignalStats()`, cumulative across tiles.
- **Night sky "bloom" was a sun that never set (2026-09-02).** The sky dome's warm sun-scatter term
  (`uSunGlow` #ffcf9e) was added to `color` unconditionally while the gradient and the cloud layer
  both cross-faded on `uNight`. At night the glow kept being added at full strength, and its broad
  `pow(sun, 2.5)` lobe washed most of the dome. Now `color += glow * (1.0 - uNight)`, which also
  keeps dusk/dawn working. `frontend/src/scene.js`, sky fragment shader.
- **Road corners are filleted at parse time (2026-09-02).** `frontend/src/map/roadSmoothing.js`,
  applied inside `roadToWorld` in `tileParserWorker.js` — the ONE point every consumer (ribbon,
  kerbs, markings, physics colliders, guard-rail mask) reads `road.points` from, so the player and
  the car get the same geometry. Measured, not estimated: drivable mean sharpest turn per way
  **11.0° → 5.1°**; drivable vertices **+26.8%** (2,360 → 2,992 collider segments at 18 resident
  tiles, i.e. +632 boxes — colliders are per-segment, so this is the number that costs); all road
  classes **+53.8%**, the rest being render-only footways. **Zero extra fragments** — same asphalt
  area, rounder edge — which matters because roads are fill-bound (`?roadv2=0`). Endpoint drift is
  exactly 0 across all 39,627 ways: junction continuity (N-57..N-61, 130 → 102 steps) depends on
  ways agreeing about shared node positions, so only interior vertices are touched. **No re-bake
  needed.**
- **Tree canopies became AO occluders, then were softened (2026-09-02).** `aoBaker.js` never received
  trees — `bakeAoGrid(elevation, buildings)` — which is why an avenue of plane trees left the road
  perfectly evenly lit. Canopies now rasterise as round crowns (radius `0.38 × height`, jittered
  0.72–1.22× off a hash of the tree id) and march their **own** horizon, mixed at `CANOPY_OPACITY`.
  Baked, so zero frame cost — the four AO shader sites already consume the attribute.
  - ⚠ **First run rasterised 419 cells city-wide, ~1 per tile, and shaded nothing.** Cause: **0 of
    391 trees in the benchmark tile carry a `height` tag** — OSM essentially never tags
    `natural=tree` height, so every tree failed `h < CANOPY_MIN_H`. Defaulted to the card atlas's
    own `plane_pollarded` (12 m / 9 m crown), the same tree the renderer draws → **752,604 cells**.
    The counter is the only reason this was caught instead of shipping as "no visible change".
  - ⚠ **Opacity 0.6 read as a painted slab**, not shade, with a hard edge at the crown line. AO is
    *ambient* — it darkens by sky visibility and has no direction in it, so under a continuous row
    of trees it cannot dapple, only flatten. Dialled to **0.34**, crown radius jittered → **724,304
    cells**. Genuine dapple needs a baked **directional** pass at a fixed sun angle; the runtime
    shadow path is blocked because the vegetation pools set `frustumCulled` and
    `perObjectFrustumCulled` both false (the latter measured as a frame-killer).
  - ⚠ Housekeeping: the softening landed inside commit `9ab2c11` ("Direction signage…") via a
    `git add -A`, not under its own message. Recorded here so it is findable.
- **Road/terrain conform: tried, measured, REVERTED (2026-09-02).** Conforming terrain to at-grade
  roads fired on 543,143 cells but made the fit **worse** — flush points 90.7% → 83.0%, and the
  5–15 cm band 1.0% → 7.9%. The easing (`w = 1 − (dist/halfW)²` out to 6 m, skipping only gaps under
  5 cm) dragged already-flush cells toward roads, and at junctions two crossing roads pulled the same
  cells to a compromise matching neither. A correct version must touch only cells already visibly
  off (>15 cm) and apply full correction inside the carriageway. `backend/tools/atGradeRoadFit.mjs`
  measures the population; the wheel-sink report is still OPEN.

## 2026-09-02 — direction signs, and a commit that hid P-D3

- **P-D3 (baked junction destinations → boards + gantries) is NOT described by its commit
  message.** A `git add -A` swept it into `c7b96d7`, the tree-night-gradient commit. Recorded here
  because the commit log will not lead anyone to it — same failure mode as the canopy-softening
  slip. Grep `junctionSigns` to find the work.
- **Direction signs — three defects, one drive-by** (`roadInfraRenderer.js`):
  - The face was `MeshBasicMaterial`, i.e. UNLIT, so it kept full daylight brightness after dark
    while the city darkened around it, and bloom turned it into a blank white rectangle. Now
    Lambert (the house material) with a small emissive floor: it dims with everything else and the
    headlights light it on approach. The panel vignette also ran to `rgba(255,255,255,0.5)` over
    `#f2f2ee` — near pure white, which is what bloom grabbed. Now 0.22.
  - `DoubleSide` CANNOT be right on a sign here: the face texture carries `repeat.x = -1` to undo
    `worldGroup.scale.x = -1`, so the back showed that texture mirrored — reversed lettering, arrow
    pointing the wrong way. Now `FrontSide` + a blank back plate, all of a tile's plates merged
    into ONE mesh so it costs no draw call.
  - The arrow was sized on its own instead of against the text column: 234 px of a 512 px panel on
    a glyph carrying one bit, which forced long names to wrap at 24 px. Arrow down to ~a fifth,
    text column 248 → 314 px, font floors raised (single 40 → 46, wrapped 24 → 34).
- **Deploy**: the frontend's `VITE_STATIC_TILES=1` path makes the Express backend unnecessary in
  production — tiles are fetched as plain files, so the whole game is ONE static Cloudflare Pages
  project (no Worker, no R2, no CORS). 568 files / 202 MB, inside both Pages limits.
  ⚠ The project already existed and is live on `drive.anmolbhardwaj.com`; its production branch is
  `main`, so `--branch v3` lands as a PREVIEW, not production.
- **Production deploy is now static Cloudflare Pages from `main`** (`drive.anmolbhardwaj.com`).
  Build with `VITE_MAP_API= VITE_STATIC_TILES=1 VITE_TILE_REGION=barcelona npx vite build`, then
  copy `backend/tiles/barcelona` into `frontend/dist/tiles/` and
  `wrangler pages deploy frontend/dist --project-name barcelona-drive --branch main`.
  ⚠ **`--branch` decides production vs preview.** The project's production branch is `main`; any
  other branch name silently deploys a PREVIEW with its own alias URL and leaves the custom domain
  serving the old build. A deploy that says "Success" tells you nothing about which one you got —
  check `wrangler pages deployment list` for the `Production` row.
- **A missing tile on Pages returns 200 `text/html`, not 404.** Pages serves index.html for any
  unmatched path, which is what makes the client-routed `/game` work — there is no `/game` file — so
  it must not be disabled globally. The consequence is that a tile beyond the baked region sailed
  past the tile worker's `if (!res.ok)` and got parsed as a binary tile. `tileParserWorker` now
  treats a `text/html` response as `not_found`.
  ⚠ A `_redirects` rule scoping a real 404 to `/tiles/*` was tried FIRST and **measured as inert** —
  the asset fallback still won, still 200 text/html. It was deleted rather than left in the repo
  looking like protection. The content-type guard is the whole fix.
