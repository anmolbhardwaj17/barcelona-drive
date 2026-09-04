# Game modes — identity, objective markers, and navigation

Status: **M-1 shipped 2026-09-04.** Code: `frontend/src/game/`.
Tests: `frontend/test/router.test.js` (12).

| key | name | icon | colour | logo |
|---|---|---|---|---|
| `dash` | Checkpoint Dash | 🏁 | `#35e0ff` cyan | `/modes/logo-dash.webp` |
| `taxi` | City Cab | 🚕 | `#2ee06a` green → `#ffc233` gold | `/modes/logo-taxi.webp` |
| `delivery` | Rush Hour | 📦 | `#35b0ff` blue → `#ff8a33` orange | `/modes/logo-delivery.webp` |
| `police` | Heat | 🚨 | red/blue | `/modes/logo-police.webp` |
| `free` | Free Roam | 🗺️ | — | `/modes/logo-free.webp` |

Modes live in the hub (`ui/mainMenu.js`) and nowhere else. `drive()` is the single launch path.

---

## 1. The title card (`game/modeIntro.js`)

**Order is the design: hub closes → card over the city → mode starts.** `playModeIntro()` returns a
promise and `drive()` awaits it, so the mode is not running while a logo is on screen. Getting this
wrong puts the card on top of Checkpoint Dash's own 3-2-1, and the two fight for the same 40% of the
screen in different type.

- ~2 s total: 460 ms in (scale + blur resolving to sharp), 1 s hold, 520 ms out. It scales **up** on
  the way out — shrinking away reads as *cancelled*; drifting past the camera reads as getting out of
  the way, which is what is happening.
- The scrim is a radial dim, **not a black-out**. The city stays readable behind the card; this is a
  title over a shot, not a loading screen.
- Honours `prefers-reduced-motion` (shorter, no scale, no blur).
- **Falls back to the mode's icon + name** if no logo file resolves — laid out properly, because that
  is what ships if art never arrives.

### Art
`public/modes/logo-<key>.webp` (`.png` also tried). Transparent, ~3.5:1 to 1.5:1, ≥1200 px wide.
Drawn at `min(58vw, 780px)`.

⚠ **These are not the `mode-<key>.webp` files** — those are the photographic backgrounds behind the
hub's rows, and stretching one across the middle of the screen is a picture, not a title.

⚠ **Budget.** The supplied PNGs were 1.4–2.1 MB *each*, ~9 MB for five — three times what v3 P0-11
deleted two pedestrian variants to save. Shipped as alpha-trimmed 1200 px WebP: **633 KB for all
five.** Trim to the ink (`Image.getchannel('A').getbbox()`) before resizing or the card is mostly
empty margin.

---

## 2. The objective halo (`game/objectiveMarker.js`)

One implementation. `dashMode`, `taxiMode` and `deliveryMode` each built their own out of the same
four primitives, drifting: dash had a bloom torus and a 48-segment ground ring, the other two had
neither, and the beam sat at a different opacity in each.

### Why they looked wrong — measured, not guessed
Every part was a flat `MeshBasicMaterial` at fixed opacity with `fog:false`, and the beam was
`AdditiveBlending` at 0.16. **That is a night-only recipe, shipped into a day/night game:**

- **Additive adds to what is there.** Against night asphalt (luminance ~0.05) an additive beam is the
  whole signal. Against a sunlit Barcelona street (~0.55) it adds 0.16 to something already near
  white — mathematically invisible, and where it did register it blew the sky out.
- **A hard-edged column.** An open-ended cylinder at uniform alpha ends in a straight line 90 m up.
  Nothing else in this game has a straight edge in the air.
- **A ring with no falloff.** `RingGeometry` at constant alpha is a decal *of* a ring, not light
  pooling on a road.
- **No distance behaviour.** The beam is a LOCATOR — it earns its cost at 200 m and hides the thing
  you are trying to reach at 15 m. It was drawn at full strength at both.

### What replaced it
Gradient `CanvasTexture`s throughout (soft falloff everywhere), and a **day/night profile that
changes BLENDING, not just opacity** — alpha + a deepened hue in daylight, additive + a brighter core
at night. The beam smoothsteps in between 55 m and 150 m and is off under the bumper; the ground pool
does the opposite and strengthens as you arrive, so you are never left without a mark on the ground.

Two traps worth knowing:
- **`onNightModeChange` only fires on a TOGGLE.** A marker built when a mode starts — minutes after
  boot — got no callback and came up in the day profile. `envToggle.isNightMode()` was added for
  exactly this; read it at construction, subscribe for the changes after.
- **`onNightModeChange` has no unsubscribe**, and dash builds a marker per gate on every run. A
  per-marker subscription is a leak that grows with how much the player plays, so `objectiveMarker`
  keeps **one** module-level subscription and a registry that `dispose()` actually removes from.

---

## 3. Navigation (`game/router.js`, `objectiveNav.js`, `objectiveHud.js`)

### The problem with a bearing
Every mode pointed at its objective with a triangle and a crow-flies distance. On an Eixample grid
that is *actively misleading*: the marker reads 180 m north-west while the only way there is 400 m
round two blocks, and **the number on screen goes UP as you drive the correct route**.

### `router.js` — A* over the loaded road network
- **World coords in road-point form** (`{x: easting, y: northing}`) — the same objects
  `getRoadSegments()[].points` hands out. Never touches the scene, so no X-mirror, no physics origin.
- **Routes on TIME, not distance**, with a per-class speed table — so it prefers Gran Via over a
  service lane that is shorter in metres. The heuristic uses the table's *fastest* speed; an average
  would overestimate the remaining cost and silently return non-optimal routes, which looks like "the
  nav sends me the long way round" and is never traced back to the heuristic.
- **The graph is clipped to the TRIP, not the resident city.** Walking every point of 9–18 resident
  tiles is ~10⁵ nodes and tens of milliseconds on the main thread — a visible hitch, to plan a 300 m
  fare. Bounded to the (start, goal) box + 260 m margin.
- ⚠ **An edge is kept when its own AABB overlaps the box** — *not* "either endpoint is inside", which
  was the first cut and is wrong in the case that matters: an arterial crossing a 700 m trip box with
  its next node a kilometre away has neither end inside and vanishes, so the route detours around the
  one street that goes there. A test pins this.
- ⚠ **1 m node snap, or every route dies at a tile boundary.** Tile clipping leaves the same junction
  as two points centimetres apart; without the snap the graph is a set of disconnected per-tile
  islands. Also pinned.
- ⚠ **The graph is UNDIRECTED, oneway tags ignored — deliberately.** This routes a player, who can and
  will turn around, and a one-way graph over tile-clipped OSM strands the goal behind an unreachable
  kerb often enough to be worse than the occasional wrong-way leg. Revisit when the network is proven
  connected, not before.
- Emits **turns with street names** — "Turn left onto Carrer d'Aragó". Names are already in the
  tiles; CLAUDE.md's census notes 42,876 named roads parsed and otherwise discarded.

### `objectiveNav.js` — one route, replanned when it stops being true
Plan on a new target; replan when >38 m off the line; retry on a 3 s clock while there is *no* route
(a null is often "the far end has not streamed in yet", not "never"). Never two searches inside 1.1 s
— A* is not free, and the line only changes when the player leaves it.

### `objectiveHud.js` — one card, three modes
Replaces three hand-built pills (~15 lines of inline `cssText` each, three different `top:` values,
three CSS triangles made of `border-left:8px solid transparent`). Shows the next **maneuver** over
the distance remaining **along the roads**, and keeps a bearing-free "Direct / No road route yet"
state for when routing has nothing yet — it never invents a turn. `textContent` per frame, never
`innerHTML`, which is what made the old HUD re-parse and reflow 60×/s while a mode ran.

### On the map (`ui/customMap.js` `drawRoute`, `ui/minimap.js` `setRoute`)
Drawn **into the map canvas, after `drawTile`, with the same projection** — which is why it lives in
`customMap`. The minimap's map div is CSS-rotated to heading-up, so a route in that canvas turns with
the city for free; an overlay layer would have to re-derive the rotation and would drift against the
streets under it.

Google-Maps shaped, and for the usual reasons: a dark **casing** under a bright line so it survives
both the pale day ground and the navy night one without changing colour; a route **blue** that is
nothing else on this map (mode colour goes on the destination pin — a green route on a green park is
a route nobody can see); the driven portion dimmed, which is the cue that says the line is tracking
you; and direction **chevrons**, because a line says where the route runs and not which way it goes.

⚠ `_route` is declared **above** `redrawMap` in `minimap.js`. The constructor calls `redrawMap()`
while it is still running, so a `let` further down is a temporal-dead-zone throw on boot.

---

## 3b. The HUD (`game/hudTheme.js`) — M-3

One panel look for every card: `createStatCard` (corner readout), `createResultCard` (end-of-run,
**fades**), `createCountdown` (ring), and `fxEvent` (kicker / title / amount / sub banner).

⚠ **The defect it fixes is not a style preference.** City Cab put two cards on screen at once that
shared nothing — a green-bordered money panel and the dark objective card — and each mode carried its
own copy of the CSS. A 2px saturated outline all round a panel is the browser's *warning-dialog*
idiom, so a readout read as an alert; and green-on-green over a park made the card invisible against
what it was drawn over. Neutral panel, accent as a 3px bar, **white** value.

**No emoji on any HUD surface.** They render as a different picture per platform and bring the OS
palette into a screen with its own. Same reasoning killed Rush Hour's `▮▯` parcel meter, which was a
bar drawn out of text glyphs at five steps.

**Copy rules:** the corner card is about the MONEY/TIME, the centre card is about WHERE TO GO — they
must not print the same word at the same moment (they did: "Fare 1 · Pick up" beside "PICK UP").
Banner text goes through `textContent`; it carries OSM street names.

⚠ **A result panel must fade.** `display:none` on a timer vanishes between two frames and reads as a
bug rather than an ending.

## 4. Not done

- **Heat (`police`)** gets the title card but no objective halo or routing — it has no fixed
  objective to route to. Its pursuit blips already ride the minimap's `setBlips`.
- **ETA.** The router computes travel time internally (it routes on it) but nothing surfaces it. One
  line in `objectiveHud`.
- **Voice / chime on a turn.** The instruction changes silently.
- **Lane guidance, roundabout exits.** `maneuvers()` classifies by angle only.
- **A worker.** Planning is on the main thread. It is bounded and throttled, and no hitch has been
  measured — but it has also not been measured on a 500 m trip through the densest tiles.

## 5. Verification — what a drive should show

1. Pick a mode in the hub → the logo lands over the city, holds, drifts away — **and only then** does
   Checkpoint Dash start counting 3-2-1.
2. The minimap draws a blue line down the actual streets to the pin, chevrons pointing the way, and
   the part behind you goes grey as you drive it.
3. The card reads "Turn left onto <street>, in 120 m", and the big number **counts down** as you
   drive the correct route — it used to climb.
4. Drive deliberately the wrong way: within a couple of seconds the line reroutes from where you are.
5. Toggle night (and day) with a marker on screen: the halo changes character, not just brightness —
   and it is readable in both.
6. Approach an objective: the light column fades out as you arrive while the ground pool strengthens.
