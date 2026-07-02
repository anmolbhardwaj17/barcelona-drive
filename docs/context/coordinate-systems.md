# Coordinate Systems

This is the most important reference in the codebase. The coordinate systems interact in ways that are silently wrong if you get them mixed up. Read this before touching anything that crosses the rendering/physics boundary.

---

## Overview of All Coordinate Spaces

| Space | Name | X axis | Z/Y axis | Used by |
|---|---|---|---|---|
| Geographic | Lat/Lon | longitude (°E) | latitude (°N) | OSM source data, user display |
| Web Mercator | Mercator (mx, my) | easting (meters) | northing (meters) | Tile math, projection |
| World | (wx, wz) | east (meters from origin) | north (meters from origin) | All game logic, road/building coords |
| Scene (Three.js) | scene-space | negative of world X (mirrored) | same as world Z | Three.js renderer |
| Physics (cannon-es) | physics-space | `-(wx - originX)` | `wz - originZ` | cannon-es bodies |
| Road point | `{x, y}` | `wx` (world X) | **`wz`** (world Z, misnamed "y") | Road and building coords in tile data |
| Local physics | local | relative to `originOffset` | relative to `originOffset` | carDriver.getLocalPosition() |

---

## The Mercator Projection

`projection.js` implements Web Mercator (EPSG:3857) centered on a fixed origin point.

> **UNIT INVARIANT (Unstretch-X, vertical-model-foundation-spec §3, ADR D-11):**
> **1 world unit = 1 real metre on the X, Y, and Z axes.** Web Mercator stretches horizontal
> distance by `1/cos(lat)` (≈1.3321 at 41.35°); the projection multiplies `(mercator − origin)`
> by `MERCATOR_UNSTRETCH = cos(ORIGIN_LAT)` so world XZ equals real metres, matching Y (already
> real metres). This factor is applied at the projection ONLY — there are **zero** downstream unit
> corrections. Do not reintroduce any `cos(lat)`/`1.3321`/`MERCATOR_SCALE` factor outside the
> projection; that is a double-correction bug. Slope/grade is now honest (real ΔY over real run).

```
Earth radius R = 6378137 m

Mercator origin (fixed — SW of Barcelona bbox):
  ORIGIN_LAT = 41.350°N
  ORIGIN_LON = 2.115°E

Old Delhi origin (for reference):
  ORIGIN_LAT = 28.4946°N, ORIGIN_LON = 77.0890°E

World X for Barcelona bbox: ~335 m to ~12,000 m → float32 precision ≈ 1.2 mm.
```

**CRITICAL — the rule, not a file list**: EVERY Mercator↔world conversion goes through the
projection functions — **forward `mercatorToWorld` ×`MERCATOR_UNSTRETCH`, inverse `worldToMercator`
÷`MERCATOR_UNSTRETCH`**. **No inline `mercator − origin` / `world + origin` anywhere** — an inline
conversion that skips the factor silently splits a whole feature class (trees/buildings ~33% off
their roads). The factor + origin are inlined (workers can't import) in: `frontend/src/projection.js`
(authoritative, exports both), `backend/projection.js`, `frontend/src/workers/vegetationWorker.js`,
`frontend/src/workers/buildingWorker.js` — all must match. `fastElevation.js` imports the factor.
Two subtleties learned the hard way (see ADR D-11):
- **Parse-time cos is gated on origin-subtraction.** `tileParserWorker` reads BOTH absolute-Mercator
  data (subtract origin + cos here) AND world-stored data (footprints, greens — already cos'd at
  bake; read raw). Applying cos to the world-stored data double-corrects it.
- **Bake-side feature storage + tile-assignment round-trips** must use `mercatorToWorld`/`worldToMercator`
  too (they were inline and were missed by the first inventory).
`latLonToMercator` and the `1/cos(lat)` in `latLonToTile` are NOT touched (textbook Web Mercator /
slippy-tile-y math, not stretch compensation).

**Lat/Lon → Mercator:**
```js
mx = R * (lon * Math.PI / 180)
my = R * Math.log(Math.tan(Math.PI/4 + lat * Math.PI / 360))
```

**Mercator → World:** (Unstretch-X — apply the unit factor)
```js
wx = (mx - originMercatorX) * MERCATOR_UNSTRETCH   // MERCATOR_UNSTRETCH = cos(ORIGIN_LAT) ≈ 0.7507
wz = (my - originMercatorY) * MERCATOR_UNSTRETCH    // → 1 world unit = 1 real metre
```

**World → Lat/Lon:**
```js
// via worldToMercator then mercatorToLatLon (see projection.js)
```

**Key property**: In Mercator, Y increases northward. So world `+Z` = north, world `+X` = east. This is consistent but counter-intuitive compared to Three.js conventions where Z is often depth.

---

## The Spawn Point and `originOffset`

The spawn point is defined in `frontend/src/spawnConfig.js` (not `projection.js`):
```
DEFAULT_SPAWN.lat = 41.3915°N  (Eixample, near Passeig de Gràcia / Carrer de Mallorca)
DEFAULT_SPAWN.lon = 2.1649°E

Old Delhi spawn (for reference): 28.5672°N, 77.2095°E (AIIMS Flyover)
```

At startup, the spawn tile's SW corner (south-west = lowest lat/lon corner) is computed and stored as `originOffset`:
```js
// main.js after spawnTileReady
const bbox = tileToBBox(spawnTx, spawnTy, TILE_ZOOM);
const { x: originOffsetX, z: originOffsetZ } = latLonToWorld(bbox.south, bbox.west);
setOriginOffset(originOffsetX, originOffsetZ);
worldGroup.position.set(originOffsetX, 0, -originOffsetZ);
```

**Why this exists**: World coords can be ~8.6 million meters in raw Mercator. Large floats lose precision after many decimal places. By anchoring `worldGroup` at the spawn-tile corner, all tile geometry is placed relative to a local origin near (0,0,0) in Three.js space, preserving float precision.

**Usage**: To convert between world and physics coords you always need `getOriginOffset()`.

---

## The X-Mirror: `worldGroup.scale.x = -1`

This is the most dangerous invariant in the codebase. **Read this twice.**

### What it does

`worldGroup.scale.x = -1` is applied to the Three.js Group that contains all tile geometry. This mirrors the entire rendered world on the X axis.

### Why it exists

The Mercator projection has `+X = east`. In Three.js, looking down the negative Z axis (standard camera orientation), `+X` should be to the right (east). However, slippy tile coordinates increase leftward (tile X increases eastward but the origin is at top-left). The mirror was added to reconcile this and make the rendered map align with real geography.

### The rule for physics coordinates

Everything in `CANNON.World` does NOT go through `worldGroup`. Physics bodies are in "physics space" which must manually apply the same transform:

```
physicsX = -(worldX - originOffset.x)
physicsZ =   worldZ - originOffset.z
```

Equivalently:
```
physicsX = -(wx - origin.x)   // negate X
physicsZ =   wz - origin.z    // Z unchanged
```

### Reverse conversion (physics → world):
```
worldX = -(physicsX) + origin.x
worldZ =   physicsZ  + origin.z
```

### What breaks if you forget the negation

- Physics body placed at the wrong X position (mirrored across the world center)
- Car spawns on the wrong side of the road
- Bridge deck colliders are in the wrong place → car falls through bridges
- Tree colliders misaligned → invisible walls or missed collisions

### The negation pattern in code

Every file that creates a CANNON.Body or computes a position for physics must apply this. Canonical examples:

```js
// tileManager.js — road deck collider position:
const x0 = -(p0.x - physicsOrigin.x);  // negate X
const z0 =   p0.y - physicsOrigin.z;   // Z unchanged (note: p0.y IS world Z — see below)

// tileManager.js — tree collider:
const px = -(p.x - physicsOrigin.x);
const pz =   p.y - physicsOrigin.z;

// main.js — car spawn position:
const spawnLocalPos = {
  x: -(spawnResult.wx - origin.x),   // negate X
  z:   spawnResult.wz - origin.z,
};
```

### Face culling side effect

`worldGroup.scale.x = -1` reverses face winding for everything inside. Two-sided materials (`DoubleSide`) must be used for any mesh where the back face matters (signs, decals viewed from behind).

---

## Road Point Coordinate Naming (The "y means Z" Trap)

Road points and building footprint points in tile data use this shape:
```js
{ x: worldX, y: worldZ, elevation: meters }
```

**The `y` field is world Z, not world Y (vertical).**

This comes from the tile parser where Mercator coords are mapped:
```js
// tileParserWorker.js readFloat32Triples:
{ x: f32[j] - ox, y: f32[j+2] - oy, elevation: f32[j+1] }
// f32[j]   = Mercator X → world X
// f32[j+1] = elevation (meters, vertical)
// f32[j+2] = Mercator Y → world Z  ← stored in .y field
```

When you see road physics code like `p0.y - physicsOrigin.z`, the `.y` on a road point is indeed world Z:
```js
const z0 = p0.y - physicsOrigin.z;  // correct — p0.y is world Z
```

When passing points to Three.js meshes, the same applies:
```js
vertex.x = roadPoint.x;      // world X (will be mirrored by worldGroup)
vertex.y = roadPoint.elevation;  // actual vertical height
vertex.z = roadPoint.y;      // world Z stored in .y
```

---

## Elevation in Coordinates

Elevation is vertical (Y in Three.js, Y in physics). Two offsets apply:

> **Stage 2 (DEM-on, 2026-06-05): `worldElevationOffset` is now the SINGLE region-wide elevation baseline.** The competing per-tile `tileMinElevation` rebasing fork has been retired (`tileParserWorker.js:327` forces `tileMinElevation: null`), so every terrain/road/heightfield site resolves to `getWorldElevationOffset()`. There is no per-tile divergence to tear a seam. See the `tileMinElevation` note below.

### 1. `worldElevationOffset` (`elevationOffset.js`)
The DEM elevation at the spawn point. Subtracted from all terrain and road elevations so the spawn area is at Y ≈ 0. **This is the single elevation baseline region-wide.** Set at startup:
```js
const spawnElev = getElevationFromGrid(data.elevation, START_LAT, START_LON);
setWorldElevationOffset(spawnElev);
```

### 2. `ELEVATION_VERTICAL_EXAGGERATION` (CONFIG)
A scalar multiplier applied after subtracting the offset. Currently `1` (real scale).

### The elevation formula
```js
// toNormalizedRoadY (roadElevation.js):
normalizedY = (rawElevationMeters - worldElevationOffset) * ELEVATION_VERTICAL_EXAGGERATION
```

### `BAKED_ROAD_ELEVATION_IS_RAW` (CONFIG)
When `true`: baked road point elevations are raw DEM meters; `worldElevationOffset` is subtracted at runtime.
When `false`: baked elevation is already normalized; do not subtract again.

Currently `true`. **If you change the bake pipeline's elevation convention, this flag must be updated.** Getting it wrong makes all roads float above or sink below terrain.

### `tileMinElevation` (per-tile) — RETIRED (Stage 2, 2026-06-05)
**Historically** a per-tile rebasing fork: when a tile carried `elevation.tileMinElevation`, the consumption sites set `offset = 0` (and `elevationIsRebased = true`), bypassing the global `worldElevationOffset`. Because every tile *always* baked the field, the spawn-anchored offset was effectively dead, and under DEM the per-tile minima would diverge between neighbours (vertical seam risk).

**Now neutralized at a single chokepoint** — `tileParserWorker.js:327` forces `tileMinElevation: null` — so the fork below always takes the `getWorldElevationOffset()` branch and `elevationIsRebased` is always false:
```js
entry.elevationIsRebased = elevation?.tileMinElevation != null;  // → always false now
const elevOffset = entry.elevationIsRebased ? 0 : (getWorldElevationOffset() ?? 0);  // → always the global offset
```
The ternary is left in place at all 6 sites (terrainRenderer ×2, tileManager ×3, the rebased flag) as a harmless no-op; the parser-null is the functional kill switch. Baked terrain/road Y stay raw-absolute (`BAKED_ROAD_ELEVATION_IS_RAW: true`) and the global offset is subtracted once. (The bake still emits the field at `convertToBinary.js:132`; it is ignored — optional future cleanup.)

---

## Tile Coordinate Math

Slippy tile coordinates at zoom 16:

```js
// projection.js
latLonToTile(lat, lon, zoom):
  x = floor(((lon + 180) / 360) * 2^zoom)
  y = floor(((1 - log(tan(lat*π/180) + 1/cos(lat*π/180)) / π) / 2) * 2^zoom)

tileToBBox(x, y, zoom) → { south, west, north, east }  // in degrees
tileCenterToWorld(x, y, zoom) → { x: wx, z: wz }        // world coords of tile center
worldToSlippyTile(wx, wz) → { x: tx, y: ty }            // which tile this world point is in
```

Tile key format used throughout: `"tx_ty"` (e.g. `"46754_27357"`).
Full tile ID used in API: `"z_x_y"` (e.g. `"16_46754_27357"`).

---

## Quick Conversion Cheat Sheet

```
Lat/Lon → World:      latLonToWorld(lat, lon)       → { x: wx, z: wz }
World → Lat/Lon:      worldToLatLon(wx, wz)          → { lat, lon }
World → Physics X:    -(wx - getOriginOffset().x)
World → Physics Z:     wz - getOriginOffset().z
Physics → World X:    -(px) + getOriginOffset().x
Physics → World Z:     pz  + getOriginOffset().z
Road point .y:        = world Z (not vertical!)
Road point .elevation: = vertical meters (raw DEM)
Vertical in scene:    (elevation - worldElevationOffset) * ELEVATION_VERTICAL_EXAGGERATION
```

---

## Common Mistakes

| Mistake | Symptom | Fix |
|---|---|---|
| Forget to negate X for physics | Physics body at mirrored position | `px = -(wx - origin.x)` |
| Use road `point.y` as Three.js Y | Geometry placed underground | `point.y` is world Z; `point.elevation` is height |
| Forget `worldElevationOffset` subtraction | Roads float in the air by ~200m | Subtract offset before rendering |
| Add `worldElevationOffset` twice | Roads sink underground | Check `tileMinElevation`; rebased tiles offset=0 |
| Hard-code world coords without `originOffset` | Precision loss at large values | Always use `getOriginOffset()` in physics code |
