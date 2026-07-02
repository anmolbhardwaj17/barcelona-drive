# Glossary

Terms and naming conventions that are confusing, overloaded, or counter-intuitive in this codebase.

---

## Road Point `.y` ≠ vertical Y

**In tile data**, road and building points use the shape `{ x, y, elevation }`.
- `.x` = world X (horizontal east-west)
- `.y` = world Z (horizontal north-south) — **NOT vertical**
- `.elevation` = vertical height in meters (raw DEM)

This comes from the binary parser mapping Mercator northing into `.y`. See [coordinate-systems.md](coordinate-systems.md) for details and the correct Three.js mapping.

---

## "World coords" vs "physics coords"

**World coords** `(wx, wz)`: Mercator meters minus origin, used by all game logic, road data, projection math.

**Physics coords**: World coords with X negated: `px = -(wx - originX)`. Used only inside `CANNON.World`. The negation mirrors the X-axis to match the `worldGroup.scale.x = -1` transform applied to rendered geometry.

---

## "Tile" (two meanings)

1. **Slippy tile**: A geographic grid cell at zoom level 16 (~500m × 500m). Identified by `(zoom, tx, ty)` e.g. `(16, 46754, 27357)`. The unit of streaming and data storage.

2. **Tile data** / **tile entry**: The in-memory object in `tileCache` that holds all meshes, physics bodies, spatial index, etc. for one slippy tile. Created by `processTileData()`.

Context usually makes it clear which meaning is intended.

---

## Tile Key vs Tile ID

**Tile key**: `"tx_ty"` (e.g. `"46754_27357"`) — used as the key in `tileCache` and `loadingKeys` Maps. Does not include zoom.

**Tile ID**: `"z_x_y"` (e.g. `"16_46754_27357"`) — used in the API URL `/api/tiles/:tileId` and in the tile file path `tiles/delhi/16/46754/27357.bin`.

---

## "Ramp"

A road segment transitioning between ground level (Y=0) and a bridge/tunnel elevation. `isRamp: true` is set in the baked tile. Ramps receive box physics colliders (same as bridges) because they have significant elevation change. The term is specific to this codebase's road topology classification — it does not necessarily correspond to a formally marked ramp in OSM.

---

## "Layer" (in road context)

The OSM `layer` tag value, used to determine vertical stacking order:
- `layer = 0` (or absent): ground level
- `layer = +N`: N × 6m above ground (bridge/flyover)
- `layer = -N`: N × 6m below ground (tunnel/underpass)

"Layer" in this context is entirely different from Three.js `Object3D.layers` (render layer bitmask).

---

## "Origin" / `originOffset`

The world-coordinate position of the spawn tile's SW corner. Stored as `{ x: originX, z: originZ }`. Used to:
1. Position `worldGroup` so all geometry is near (0,0,0) in Three.js space (float precision)
2. Convert between world and physics coordinates in every body position calculation

Accessed via `getOriginOffset()` from `originOffset.js`.

---

## `worldElevationOffset`

The DEM elevation at the spawn point (AIIMS Flyover, ~228m above sea level for Delhi). Subtracted from all terrain/road elevations so the spawn area is at Y ≈ 0. Stored as a singleton in `elevationOffset.js`. Without this, the entire world would be 200+ meters in the air.

---

## "Phase 1–4" (tile building)

The four async stages of tile geometry creation in `processTileData()`:
- Phase 1: Terrain + Roads + Physics (appears immediately)
- Phase 2: Buildings + Railways (next frame)
- Phase 3: Trees + Zone vegetation (next frame)
- Phase 4: Grass + Water + Props + All details (background)

Not to be confused with "phase" in any other context.

---

## "Gore" (junction geometry)

The triangular fill area at a road merge/split (where two lanes diverge or join). Named after the real-world road term "gore area" (the triangular region between diverging lanes, often marked with diagonal stripes). In this codebase, gore geometry is pre-computed by `MergeGeometryBuilder.js` and stored as `junctions[].gore.{vertices, indices}` in the tile.

---

## `tileKey` (function, multiple definitions)

There are multiple local functions named `tileKey(tx, ty)` in different files (e.g. in `tileManager.js`, `mapLoader.js`, `main.js`). They all return `"${tx}_${ty}"`. This is a naming collision but is harmless since they're all local to their module.

---

## `worldGroup` vs `scene`

**`scene`**: The root Three.js Scene. Contains lights, sky, clouds, moon, stars, and `worldGroup`. Direct children of `scene` are in "scene space" with no scaling.

**`worldGroup`**: A `THREE.Group` added to `scene` with `scale.x = -1`. All tile geometry (terrain, roads, buildings, trees, water, everything map-related) is added to `worldGroup`. Physics bodies are NOT in `worldGroup` — they're in the separate `CANNON.World`.

---

## "Rebased" elevation (tile)

When `elevation.tileMinElevation` is present in a tile, the elevation values have been shifted so the tile's lowest point is 0. The frontend checks for this:
```js
entry.elevationIsRebased = elevation?.tileMinElevation != null;
const elevOffset = entry.elevationIsRebased ? 0 : getWorldElevationOffset();
```
A rebased tile does not need `worldElevationOffset` applied — its own local minimum is the reference. Non-rebased tiles need the global offset subtracted.

---

## `fastElevation` vs `getElevationAt`

**`getElevationAt(lat, lon)`**: Returns elevation by converting world coords → lat/lon → grid index. Uses trigonometry (`worldToLatLon`). Accurate everywhere; expensive for bulk queries (18k+ per tile).

**`getWorldElevation(wx, wz)`** (from `createFastElevation()`): Returns elevation by precomputing linear world→grid mapping constants, skipping trig. Used for vegetation and grass placement. Slightly less accurate near tile edges (linear approximation of the Mercator projection) but 10-20× faster.

---

## "Deck" collider

A physics term in this codebase for the box-shaped colliders that represent the surface of elevated roads (bridges, flyovers, ramp tops). "Deck" comes from bridge engineering terminology (the road surface of a bridge). Created by `createRoadTrimeshColliders()` (misleadingly named — it creates boxes, not trimeshes).

---

## "Canopy" (tunnel context)

The partial roof structure over a tunnel approach ramp. Rendered by `buildApproachCanopy()`. Visually covers the transition zone where the road starts going underground. Not a full tunnel enclosure.

---

## `_ddInWorld` flag

A custom property added to CANNON.Body instances (`body._ddInWorld = true/false`). Tracks whether the body is currently in the physics world to avoid calling `world.bodies.includes(b)` (O(n)) every frame. "DD" = Delhi Drive.

---

## `spawnCenter`

The Three.js world-space position `{x: spawnX, z: spawnZ}` of the spawn lat/lon (AIIMS). Used to position the initial camera before the car is created. Not the same as `originOffset` (which is the tile SW corner).

---

## `vx` / `vz` query params

Optional query parameters on tile requests that indicate camera direction. Parsed by the tile loader to pass context to the server. Currently the server ignores these — they are stripped from the IndexedDB cache key. Intended for future server-side priority hints (serve road-forward tiles before side tiles).
