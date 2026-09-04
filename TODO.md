# TODO (parked — pick up later)

## Coordinate rotation / mirror conventions cleanup
The game has several coordinate transforms scattered across the renderer↔physics boundary that are
error-prone and worth consolidating into one clearly-documented layer:

- **X-mirror**: `worldGroup.scale.x = -1`; physics negates X → `px = -(worldX - originX)`. Every
  renderer↔physics boundary must apply this negation (see `docs/context/coordinate-systems.md`).
- **Terrain heightfield −90° rotation**: cannon `Heightfield` lives in the local XY plane with Z = height;
  a `-PI/2` X rotation maps local-Z → world-Y. Plus the height matrix columns are reversed (east→west) so
  the field extends in +local_X to match the negated-X car frame, and the body X is set to the east-side
  world X so it lands correctly after negation. (`map/terrainRenderer.js` buildTerrainHeightfield.)
- **Rapier vs cannon conventions**: Rapier heightfield is XZ-plane, Y-up (no −90° rotation needed) — the
  Phase 2b terrain port must translate cannon's layout+rotation to Rapier's directly rather than reusing
  the cannon rotation. (Relevant once the Rapier migration reaches terrain.)

**Goal:** one boundary module that owns all world↔physics↔render coordinate conversions (mirror + rotations),
so individual renderers/colliders don't each re-derive them. Reduces the class of "silently misplaced
geometry / broken collision" bugs the CLAUDE.md danger note warns about.

## Road / surface Z-layering — REMAINING work (research pass done 2026-09-04)
The research pass asked for here is done and the findings are in
[docs/context/ground-layering.md](docs/context/ground-layering.md). ⚠ **The premise of this item was
stale**: the "ONE layering scheme" it asked to design already existed as `map/groundLayers.js`, with a
depth-bias table, a height table, and a dev guard wired into every mesh. The audit found **zero**
hand-rolled `polygonOffset` violations — all 7 sites outside `applyGroundLayer()` are legitimately
exempt transparent decals. What it did find, and Z-1 fixed, was that the two tables encoded **opposite
orders for all four paint classes** (5 inverted pairs of 21), so which paint drew on top changed with
viewing angle. Still open:

- **Z-2 — surfaces outside the scheme entirely.** `parkingRenderer` (0.04 + 0.02, i.e. 0.06 against the
  road deck's 0.05 — a car park abutting a street stacks by luck), `busStopRenderer` (0.10 / 0.15),
  `railwayRenderer` tram rails (0.005), `tunnelRenderer` `APPROACH_Y_BIAS` (0.06, a hand-rolled
  tie-break of exactly the kind the bias table replaces), `roadRenderer` `BLEND_STRIP_Y_OFFSET` (0.10).
  Each needs a class and a lift, and each is a possible visible change — own pass, own drive test.
- **Z-3 — building-wall z-fighting on overlapping OSM footprints.** Does NOT belong in `groundLayers`,
  which is for flat co-planar ground; 3D geometry wins by having real height. Two OSM ways describing
  one block is a DATA problem — file it with `osm-repair-layer.md`, next to `rule5_duplicateRoadRemover`.
- **Z-4 — the `gore` / `drain` clearance exemption.** Both sit BELOW the top of the drawn asphalt
  (−2.4 cm, −0.9 cm) and are exempted from the clearance assertion as "embedded, not painted on".
  Plausible for a drain cover, doubtful for a gore fill, which is paint. Nobody has looked at one up close.

## Multiplayer mode (not started)
Drive the same Barcelona with other people. Parked here as a whole-programme item, not a task — it
touches almost every system the single-player build currently owns privately.

- **The hard part is not networking, it is that nothing in this game is authoritative.** Physics runs
  on the client (`carPhysicsRapier`), traffic and pedestrians are spawned per-client from the loaded
  tiles with `Math.random()`, and the spawn point is now randomised per load. Two players would see
  different cars, different crowds and different starting places in the same city.
- **What has to become deterministic or shared before any of it works:** a seed for traffic/pedestrian
  placement (they are currently seeded by nothing), an agreed clock, and an agreed spawn — the
  `SPAWN_POOL` random pick has to come from the session, not from each client's `Math.random()`.
- **Cheapest honest first slice:** ghost cars. Broadcast position/heading/speed at ~10 Hz, interpolate,
  draw with the existing traffic car models. No shared physics, no collisions between players, no
  authority. It proves the transport and the presence layer without touching the simulation.
- **Then, in order:** shared game modes (a race down one Checkpoint Dash route is the natural first —
  the route is already a deterministic list of world points), then contact between player cars, which
  is where client-side physics stops being tenable.
- Open questions nobody has answered: server or peer-to-peer; whether the tile server (a trivial
  Express static-file server today) grows a realtime role or a separate service does; and what
  happens to a player whose tiles have not streamed in yet.
