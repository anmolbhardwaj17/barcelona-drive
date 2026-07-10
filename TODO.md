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
