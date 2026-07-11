# Map System

## Overview

The map is divided into zoom-16 slippy tiles (~500 m × 500 m each). All data is pre-baked offline into binary files. At runtime the server is a dumb static file server; zero processing happens on the backend during gameplay. The frontend streams a 3×3 grid of tiles around the viewer, building geometry progressively over multiple frames.

---

## Binary Tile Format (v9)

Tiles are stored at `backend/tiles/barcelona/16/{x}/{y}.bin`.
Old Delhi tiles at `backend/tiles/delhi/` use v6 — the parser handles all versions (newer sections absent → empty/fallback).

Version deltas since v7 (the base format documented below):
- **v8** — `bakedSidewalks` (pre-baked sidewalk/curbTop/curbFace geometry blobs; absent → runtime
  sidewalk generator) + `crossing:true` on path-family roads clipped out of carriageway coverage.
  See [bake-surface-clipping.md](bake-surface-clipping.md).
- **v9** — `aoGrid`: baked hemispheric sky-visibility AO (backend/worldBuilder/aoBaker.js). Uint8
  sky-view factors (255 = open sky), same 128×128 resolution/orientation as the elevation grid,
  packed 4-per-u32 LSB-first (read back as a byte view). Header: `{resolution, byteLength,
  dataOffset, dataCount}`. Absent → frontend treats sky as fully open (no AO). Consumed by
  frontend/src/map/aoSampler.js (terrain + road/sidewalk vertices) and buildingWorker (facades).

### Wire layout
```
[4 bytes]   uint32 LE — byte length of the JSON header (padded to 4-byte boundary)
[N bytes]   UTF-8 JSON header — metadata, feature counts, byte-offset references
[rest]      Packed binary sections — Float32 and Uint32 arrays
```

### What the JSON header contains

The header describes every feature type. All coordinate arrays are replaced with `{ offset: bytesFromBinaryStart, count: numElements }` references. No coordinates live in the JSON — only scalars and metadata.

```jsonc
{
  "roads":      [ { "id", "width", "highwayType", "bridge", "tunnel", "layer", "name",
                    "isRamp", "isRoundabout", "serviceSubtype",
                    "pointsOffset": <bytes>, "pointCount": <n>,
                    // Phase 2 fields (optional — present only after Phase 2 re-bake):
                    "oneway": "forward"|"backward"|"no"|null,
                    "lanes": integer|null,        // clamped [1,12]
                    "sidewalk": string|null,      // 'both'|'left'|'right'|'no'|'none'|'separate'
                    "cycleway": string|null,      // 'lane'|'track'|'opposite_lane'|'shared_lane'|'no'
                    "surface": string|null,       // 'asphalt'|'concrete'|'paving_stones'|'sett'|etc.
                    "maxspeed": integer|null      // km/h (units stripped; mph not yet normalized)
                  } ],
  "buildings":  [ { "id", "height", "levels", "type", "colour", "material", "roofShape",
                    "roofHeight", "name", "minHeight",
                    "footprintOffset": <bytes>, "footprintCount": <n>,
                    "innerRingsOffset": <bytes>, "innerRingCounts": [n, ...] } ],
  "elevation":  { "resolution", "min", "max", "south", "west", "north", "east",
                  "tileMinElevation", "tileMaxElevation", "gridRows", "gridCols",
                  "elevationsOffset": <bytes> },
  "water":      [ { "id", "polygonOffset": <bytes>, "polygonCount": <n> } ],
  "greens":     [ { "id", "type", "polygonOffset": <bytes>, "polygonCount": <n> } ],
  "barriers":   [ { "id", "type", "isArea", "height", "gates",
                    "pointsOffset": <bytes>, "pointCount": <n> } ],
  "junctions":  [ { "nodeId", "x", "z", "type", "layer", "roads", "gore": {
                    "verticesOffset": <bytes>, "verticesCount": <n>,
                    "indicesOffset": <bytes>, "indicesCount": <n> } } ],
  "busStops":   [ { "id", "name", "pointOffset": <bytes> } ],
  "parking":    [ { "id", "parkingType", "capacity", "polygonOffset": <bytes>, "polygonCount": <n> } ],
  "urbanFeatures": [ { "id", "type", "tags", "pointOffset": <bytes> } ],
  // ── v7 additions ─────────────────────────────────────────────────────────
  // Polygon features (Float32 pairs [wx, wz] in world coords, same encoding as greens)
  "beaches":         [ { "id", "type": "beach"|"sand", "polygonOffset", "polygonCount" } ],
  "pedestrianAreas": [ { "id", "type": "pedestrian"|"footway", "polygonOffset", "polygonCount" } ],
  "marinas":         [ { "id", "type": "marina"|"dock"|"pier", "isLine"?, "polygonOffset", "polygonCount" } ],
  // Point features (Float32 pair [wx, wz] per entry, via pointOffset)
  "trafficSignals":  [ { "id", "direction"?, "pointOffset" } ],
  "streetLamps":     [ { "id", "height"?, "pointOffset" } ],
  "tourismPois":     [ { "id", "type": "tourism_*"|"historic_*", "name"?, "pointOffset" } ],
  "metroStations":   [ { "id", "name"?, "network"?, "lines"?, "pointOffset" } ],
  "healthcare":      [ { "id", "type": "hospital"|"clinic"|etc, "name"?, "pointOffset" } ],
  // Trees — positions compact: flat Float32 array, metadata per-entry
  "trees":           [ { "id", "species"?, "height"? } ],  // parallel to treePositions index
  "treePositions":   { "offset": <bytes>, "count": <n> },  // Float32 pairs [wx, wz]
  // Shops — positions + categories compact; names per-entry in header
  "shops":           [ { "id", "name"? } ],                // parallel to shopPositions index
  "shopPositions":   { "offset": <bytes>, "count": <n> },  // Float32 pairs [wx, wz]
  "shopCategories":  { "offset": <bytes>, "count": <n> },  // Uint8 packed as Uint32 (4 per word)
  "railways":   [ { "id", "railwayType", "layer", "bridge", "tunnel",
                    "pointsOffset": <bytes>, "pointCount": <n> } ],
  "bakedTerrain": { "gridSize", "vertExag",
                    "positionsOffset": <bytes>, "positionsCount",
                    "normalsOffset": <bytes>, "normalsCount",
                    "uvsOffset": <bytes>, "uvsCount",
                    "indicesOffset": <bytes>, "indicesCount" },
  "bakedPhysicsTerrain": { "gridSize", "vertExag",
                           "vertsOffset": <bytes>, "vertsCount",
                           "indicesOffset": <bytes>, "indicesCount" },
  "bakedVegetation": { "treeCount", "bushCount", "zoneTreeCount", "zoneBushCount",
                       "treePositionsOffset": ..., "treeVariantsOffset": ...,
                       "bushPositionsOffset": ..., "zoneTreePositionsOffset": ...,
                       "zoneTreeVariantsOffset": ..., "zoneTreeScalesOffset": ...,
                       "zoneBushPositionsOffset": ... },
  "bakedRoads": { "layers": [ { "layer": <n>, "positionsOffset", "normalsOffset",
                                "uvsOffset", "halfWidthsOffset", "indicesOffset", ... } ] },
  "roadOnlyMode": true  // optional — omits non-road geometry in this tile
}
```

### Binary section encoding
- Road points: Float32 triples `[mercatorX, elevationMeters, mercatorY]` (note middle = elevation)
- Building footprints: Float32 pairs `[x, z]` in raw world coords (no origin subtraction yet)
- Elevation grid: Float32 array, row-major, `gridRows × gridCols`
- All coordinates in binary are **absolute Mercator meters**. Origin subtraction happens in `tileParserWorker.js` after reading.

### JSON v5 fallback
If a `.bin` file does not exist, the server falls back to a `.json` file (v5 format) with the same structure but uncompressed JSON. The parser worker handles both automatically via the `Content-Type` header.

---

## Tile Loading Flow

```
tileManager.update()
    │
    ├─ Determine wanted tiles (3×3 grid + 1-tile lookahead in camera direction)
    ├─ Sort needed tiles by frustum priority (dot product: tile-direction vs camera-forward)
    └─ startOneTileLoad(key, tx, ty)   [max 2 concurrent]
            │
            └─ mapLoader.loadTile(tx, ty)
                    │
                    ├─ Check in-flight dedup Map
                    └─ workerFetchTile(url, originX, originY)
                            │
                            └─ tileParserWorker (single Web Worker)
                                    │
                                    ├─ Check IndexedDB cache (key = URL minus vx/vz params)
                                    │   hit → parseBinaryTile() or parseJsonTile() → postMessage
                                    │
                                    └─ miss → fetch(url)
                                              ├─ octet-stream → parseBinaryTile() → idbPut(binary)
                                              └─ json        → parseJsonTile()    → idbPut(json)
                                              → postMessage result

    Main thread receives parsed data
            │
            └─ processTileData(key, tx, ty, data)   [4-phase async build]
```

---

## 4-Phase Progressive Tile Build

`processTileData()` in `tileManager.js` builds a tile over multiple frames. An `aborted()` check between phases discards work if the player drove away.

### Phase 1 — Terrain + Roads + Physics (immediate, same frame as tile arrival)
- Terrain mesh (`buildTerrainMesh`) — 32×32 height-displaced quad grid
- Tunnel terrain carving (`carveTunnelTerrain`) — punches verts down at approach ramps
- Terrain physics body (`createTerrainTrimesh`) — CANNON.Trimesh from 32×32 physics grid
- Road ribbon meshes (`createRoadMeshes`) + gore geometry at junctions
- Road deck physics (`createRoadTrimeshColliders`) — per-segment CANNON.Box shapes
- Tunnel wall physics (`createTunnelWallColliders`)
- Spatial index for road queries
- Green area meshes (lightweight; built here so parks appear with terrain)
- **Result stored in `tileCache` immediately** — roads and spatial index are usable

### Phase 2 — Buildings + Railways (next available rAF frame)
- Vegetation mask computed (road + building exclusion polygons)
- Railway meshes
- Building geometry (`workerProcessBuildings`) — sent to geometry worker pool, awaited
- Meshes materialized on main thread (`materializeBuildingMeshes`)
- LOD building simplified boxes (`renderLODBuildings`)

### Phase 3 — Trees + Zone Vegetation (next frame)
- Tree placement (`workerProcessVegetation`) — sent to worker pool, awaited
- InstancedMesh and BatchedMesh trees materialized on main thread
- Billboard tree sprites for far distances
- Tree shadow planes
- Zone vegetation (parks, green zones)

### Phase 4 — Grass + Water + Props + Infra + Details (background)
- Grass (`workerProcessGrass`) — sent to worker pool, awaited
- Water polygons
- Props, environment clusters
- Traffic lights (if ENABLE_TRAFFIC_LIGHTS)
- Road shoulders, streetlights, barriers, crash barriers, reflectors, guard rails
- Bus stops, parking, road infrastructure (signs, gantries)
- Urban features, vendor carts, decals

**Frame budget**: `yieldToMain()` checks elapsed time each yield point. If < 6ms since last yield, continues without a frame gap. If > 6ms, waits one rAF. This keeps build work within ~6ms/frame.

---

## LOD and Streaming

### Tile grid
- `GRID_RADIUS = 1` → 3×3 = 9 tiles always wanted
- `LOOKAHEAD_RADIUS = 2` → 1 extra tile in camera-forward direction
- `UNLOAD_DISTANCE = 3` → tiles kept cached until Chebyshev distance > 3 (avoids reload churn after the player pauses)
- `MAX_CONCURRENT_TILE_LOADS = 2` — concurrent limit to avoid server overload

### Fog culling and `CONFIG.ENABLE_FOG`

The LOD update loop applies a hard cull at `FOG_FULL_DIST` from tile nearest edge. Since 2026-05-29 this is `CONFIG.ENABLE_FOG ? 280 : Infinity`. When fog is off (development mode), all features render at their configured distances. When fog is on, everything beyond 280m is force-hidden regardless of per-feature limits — the fog renders them invisible anyway, so the GPU cost is not justified.

### LOD thresholds (distances from tile nearest edge)

| Feature | Full | Fade / LOD | Hidden |
|---|---|---|---|
| Trees (3D InstancedMesh) | 0–100m | 100–160m (instance count fade) | >160m |
| Trees (Billboard) | — | 160–460m | >460m |
| Grass | 0–100m | 100–60m (count fade) | >60m |
| Buildings (detail) | 0–180m | — | >180m |
| Buildings (LOD boxes) | 110–230m (only) | — | outside range |
| Terrain + Water | always | — | >280m fog cull |
| Streetlights | 0–140m | — | >140m |
| Road infrastructure | 0–140m | — | >140m |
| Fine details (barriers, bus stops, decals) | 0–80m | — | >80m |
| Everything except roads | >280m from edge | — | fog-culled (all hidden) |

LOD updates throttled: only recalculated when viewer moves > 15m (`LOD_THRESHOLD_SQ = 225`).

### Physics body distance management
Physics bodies are added/removed from `CANNON.World` based on distance:
- `physActive = nearEdgeDist <= 200m`
- Bodies managed: terrain trimesh, road deck boxes, tunnel walls, barriers, crash barriers, guard rails
- Uses `body._ddInWorld` flag to avoid O(n) `world.bodies.includes()` check

---

## Collision Stack (per tile)

Each tile contributes these CANNON bodies to the physics world:

### 1. Terrain Trimesh (`terrainTrimeshBody`)
- `CANNON.Trimesh` from 32×32 downsampled physics grid
- Winding order reversed vs visual mesh (X negation flips handedness; un-flipped normals would point down, blocking wheel raycasts)
- Tunnel mouth triangles removed (radius = road halfWidth + 1m + 1m margin)
- `collisionFilterGroup = GROUND (1)`, `collisionFilterMask = VEHICLE (2)`

### 2. Elevated Road Deck Colliders (`trimeshBody`)
- One `CANNON.Body` per tile containing per-segment `CANNON.Box` shapes
- Applied to: bridges, tunnels, ramps, and any road with elevation change > 0.5m and top or bottom outside ±0.3m
- Box thickness = 20 cm (thin deck)
- Box oriented with yaw (road heading) + pitch (road slope) quaternion
- Box width clipped at merge zones to avoid overlap with adjacent roads
- Pre-pass detects overlap with neighboring road corridors; clips `effectiveHalfW` to avoid z-fighting physics

### 3. Tunnel Wall Colliders (`tunnelWallBody`)
- Thin vertical box shapes (0.3m thick) along tunnel walls
- Left + right wall per road segment
- Height = from road elevation Y to ceiling (Y ≈ 0)
- Walls inside another tunnel road's corridor are skipped

### 4. Barrier Body (`barrierBody`)
- CANNON.Box shapes for OSM barrier features (walls, fences)

### 5. Crash Barrier Body (`crashBarrierBody`)
- Jersey barriers along bridge/road edges

### 6. Guard Rail Body (`guardRailBody`)
- Low rail colliders on elevated road edges

### 7. Tree / Pillar Bodies (`sceneryBodies[]`)
- Trees: `CANNON.Box` cylinders (0.3m radius, 6m tall), batched 200 per body
- Pillars (bridge support columns): `CANNON.Cylinder` (0.5m radius), one body for all

### Collision groups
```
GROUND  = 1   // terrain + road decks + tunnel walls
VEHICLE = 2   // car chassis
WORLD   = 4   // buildings, barriers, trees
FLOOR   = 8   // fallback plane at Y=-50
```
Car chassis: `group=VEHICLE, mask=WORLD` — chassis collides only with world objects, not ground. Wheel raycasts handle ground contact. Mixing chassis+ground collision fights with suspension.

---

## Terrain System

### Mesh
- Grid: `TERRAIN_GRID_SIZE = 32` (32×32 = 1024 quads)
- Vertices displaced by elevation grid via `getElevationAt(lat, lon)`
- Two interpolation modes: bilinear (default) or bicubic
- Elevation normalized: `y = (rawElev - worldElevationOffset) * ELEVATION_VERTICAL_EXAGGERATION`
- Water polygon areas sink vertices to `SEA_LEVEL = 0` so water sits flush with terrain
- Terrain darkened procedurally around tree positions (`darkenTerrainAroundTrees`)
- Texture: `/textures/terrain/grass.15f2422c.jpg` with 40×40 repeat per tile, anisotropy=4

### Fast elevation lookup (`fastElevation.js`)
For vegetation/grass placement (18k+ queries per tile), a precomputed world→grid mapping is used:
```js
createFastElevation(elevation, elevationOffset)
// Returns: getWorldElevation(wx, wz) → normalized elevation
// No lat/lon conversion — maps directly from world coords to grid index
```

---

## Road Geometry

Road ribbons are built in `roadRenderer.js` as flat quad strips:
- One quad per road segment (consecutive point pairs)
- Width from OSM `width` tag, or `lanes × 3.5m`, or type lookup table
- Shared materials per highway type (reduces draw calls)
- Z-fighting at intersections resolved by `ROAD_PRIORITY_Y_BUMP` (0.001–0.009m per type)

### Road markings (IRC 35 standard)
- Center line: double-solid (motorway), solid (trunk), dashed (primary–tertiary), none (residential)
- Edge lines: present on all classified roads
- Lane dividers: motorway and trunk only
- Dash: 2.0m long, 2.0m gap
- All markings rendered as separate geometry at `MARKING_Y_ABOVE_ROAD = 0.03m`

### Bridges and flyovers
- `layer = +N` → visual Y = `N × 6m` above terrain
- `bridge = true` always implies elevated
- Bridge pillars: box geometry every ~20m along span, touching ground
- Guard rail colliders along bridge edges

### Tunnels
- `layer = -N` → visual Y = `N × -6m` (below terrain)
- Tunnel enclosure meshes: side walls + ceiling, open-ended at both mouths
- Approach canopy: partial cover near tunnel entrance
- Terrain carved at approaches so road descends into the ground naturally
- Tunnel terrain holes punched only at mouth points (not along full length)
- `tunnelZones.js` registers extents so camera adjusts height inside tunnels

### Ramps
- Detected by `RampResolver.js` during baking: road segments connecting ground-level to a bridge/tunnel
- `isRamp = true` in tile data
- Elevation smoothly interpolated from ground to bridge height over ramp length
- Road deck physics boxes built for ramps (they are "elevated" by height change)

### Junction gore geometry
- `JunctionClassifier.js` detects merge/split points
- `MergeGeometryBuilder.js` builds triangular gore (nose) fills
- Gore vertices pre-computed in binary tile under `junctions[].gore.{vertices, indices}`
- Rendered by `buildGoreMeshes(junctions)` in `roadRenderer.js`
