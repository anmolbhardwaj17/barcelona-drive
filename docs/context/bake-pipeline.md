# Bake Pipeline

## What "Baking" Means

The bake pipeline converts raw OSM data (PBF format) and DEM elevation raster (GeoTIFF) into pre-computed binary tile files. At runtime, the backend does zero processing — it just serves `.bin` files from disk. All the complex topology, elevation, ramp detection, junction geometry, and coordinate conversion happens offline during baking.

**Any change to road layout, building data, or elevation convention requires a re-bake.** The baked tiles are committed to the repo under `backend/tiles/`.

**DEM smoothing (D-16):** `demLoader.smoothRaster` runs a separable NoData-aware box blur over the **global** DEM raster at load (env-tunable `DEM_SMOOTH_RADIUS`/`DEM_SMOOTH_ITERS`, default 2/2; set either to 0 to disable). It is global/pre-tile so adjacent slippy-tile edges stay matched (seamless). Both the visual terrain mesh and the physics heightfield read this smoothed grid (they stay co-framed), and surface roads drape onto it at runtime. Tuning the strength requires a re-bake; iterate fast with `--area montjuic` (real relief).

**SELECTIVE terrain smoothing (Phase 1, terrain-tunnel rework):** `demLoader.selectiveSmoothRaster` runs AFTER the box blur, on the same global raster — honor big relief, kill small relief. Two-scale frequency split: `out = bigBase + shrink(base−bigBase, FLATTEN) + shrink(src−base, FLOOR)` where `base`/`bigBase` are NoData-aware blurs at two wavelengths and `shrink` is soft shrinkage (continuous, no terraces). Knobs (env, re-bake to apply, **tuned by driving**):
- `TERRAIN_RELIEF_FLOOR` (default **2.5** m) — short-wavelength relief below this amplitude is removed (street wiggle).
- `TERRAIN_FLATTEN_THRESHOLD` (default **3** m) — mid-wavelength relief below this is removed (Eixample → near-flat).
- `TERRAIN_BASE_RADIUS_PX` (default 10 ≈ 300 m) / `TERRAIN_FLATTEN_RADIUS_PX` (default 30 ≈ 900 m) — the wavelength split points.
- Set both metre-knobs to 0 to disable. Long wavelengths (Montjuïc, coast descent) pass through untouched.
- Measured at defaults (through `sampleElevation`): Montjuïc climb 143→134 m (93% kept), coast descent 16.9→16.8 m (kept), Eixample wiggle RMS 0.40→0.02 m (96% gone).

**Baked sky-visibility AO (v9, aoBaker.js):** per tile, a 128×128 uint8 grid of hemispheric
sky-view factors matching the elevation grid's indices — 2.5D horizon sampling (16 azimuth rays,
2 m march to 60 m) against a 2 m building-height raster (occluders from the tile + its 8
neighbours, so canyons darken seamlessly across tile edges) plus the terrain itself (slopes and
trench walls self-shade). The grid stores PURE sky visibility; all art strength/gamma curves live
in `frontend/src/map/aoSampler.js` (+ mirrored constants in buildingWorker.js), so look tuning
never needs a re-bake — only geometry/height changes do. This is the L3 unlock from
[visual-target-analysis.md](visual-target-analysis.md) §4.

---

## Running the Bake

```bash
# Full Delhi region (slow — 10–30 minutes depending on machine)
cd backend && npm run build:region

# AIIMS test area only (fast — seconds)
cd backend && npm run build:test
```

The `--area aiims` flag selects a small bounding box around AIIMS for rapid iteration. The full `build:region` command processes the entire configured region bbox.

---

## Source Data Location

Source files are **not committed to git**. Place them before baking:

- **OSM PBF**: `data/regions/barcelona/region.osm.pbf`
  Geofabrik Catalonia: https://download.geofabrik.de/europe/spain/catalonia-latest.osm.pbf
  
- **DEM GeoTIFF**: `data/regions/barcelona/N41E002_DEM.tif` (flat layout, no subfolder — matches Delhi)
  SRTM GL1 (1 arc-second, ~23 m × 31 m at Barcelona latitude) from OpenTopography.
  Coverage: lon 2.083–2.269, lat 41.330–41.467 — fully wraps the bbox with margin.
  Elevation range in file: −12 m to 515 m. NoData: −32768 (handled by demLoader.js).

`backend/worldBuilder/config.js` contains (Barcelona):
```js
REGION_CONFIG = {
  name: 'barcelona',
  bbox: { minLon: 2.1198, minLat: 41.3580, maxLon: 2.2230, maxLat: 41.4130 },
  zoom: 16,
  pbfPath: 'data/regions/barcelona/region.osm.pbf',
  demPaths: ['data/regions/barcelona/dem/N41E002_DEM.tif'],
  phase1Pure2D: false,  // real DEM terrain enabled
}
```

### DEM Sourcing — Step by Step

**Option A: Copernicus GLO-30 via AWS (free, no registration)**
```bash
# Install AWS CLI (brew install awscli) then:
aws s3 cp \
  s3://copernicus-dem-30m/Copernicus_DSM_COG_10_N41_00_E002_00_DEM/Copernicus_DSM_COG_10_N41_00_E002_00_DEM.tif \
  data/regions/barcelona/dem/N41E002_DEM.tif \
  --no-sign-request
```

**Option B: OpenTopography (registration required)**
Visit https://opentopography.org/ → Raster Download → SRTM GL1 (1 arc-second) → bbox 2.1,41.3,2.3,41.5 → download GeoTIFF.
Place as `data/regions/barcelona/dem/N41E002_DEM.tif`.

**Verify the DEM loaded correctly:**
After `npm run build:region`, look for the log line:
```
Test elevation at Sagrada Família (41.4036, 2.1744): <N> m
```
Expected: ~10–15 m above sea level. If `null`, the DEM file is missing or the bbox doesn't cover that point.

---

## Pipeline Steps (`buildRegion.js`)

### 1. Parse OSM PBF
```
parsePbfHighways()    → raw ways with nodes and tags
parsePbfBuildings()   → building footprints
parsePbfGreens()      → parks, grass, meadows, gardens
parsePbfWater()       → rivers, lakes, reservoirs
parsePbfBarriers()    → walls, fences, hedges
parsePbfBusStops()    → public_transport=stop_position
parsePbfRailways()    → rail, light_rail, subway, tram
parsePbfParking()     → amenity=parking
parsePbfUrbanFeatures() → towers, large structures
```

### 2. Road Graph Construction
```
buildFromWays(rawHighways)   → RoadGraph (nodes + edges)
fixOsmData()                 → patch known OSM errors (duplicate nodes, self-intersections)
resolveRamps()               → detect approach segments for bridges/tunnels; mark isRamp=true
resolveBridgeToBridge()      → handle back-to-back bridge segments
```

### 3. Road Elevation Assignment
```
elevationProcessor.js:
  - Normal road: elevation = 0 (flat ground)
  - Bridge (layer=+N): elevation = N × 6m
  - Tunnel (layer=-N): elevation = N × -6m
  - Ramp: smoothly interpolated from 0 to bridge/tunnel elevation over ramp length

elevationHarmonizer.js:
  - Resolve conflicting elevation assignments at junctions
  - Ensure connected segments agree on elevation at shared nodes

LayerResolver.js:
  - Determine final layer for each road from OSM layer, bridge, tunnel tags
```

### 4. Topology and Geometry
```
normalizeRoadTopology()  → split roads at intersections, deduplicate nodes
resampleRoads()          → resample points at regular intervals (smoother physics decks)
buildRoadIndex(rbush)    → spatial R-tree for per-tile queries
douglasPeucker()         → simplify long road ways (reduce point count)
classifyJunctions()      → detect merge/split/crossing types
buildMergeGeometry()     → compute gore triangles at lane splits
```

### 5. Per-Tile Processing

For each tile in the region bbox:
```
clipRoadsForTile(roadIndex, tileBbox)    → roads crossing this tile
roadsForTileNoClip(...)                  → roads fully within tile (buildings use this)
normalizeBuilding()                      → validate, orient, split multipolygons
normalizeGreen() / normalizeWater()      → polygon normalization
splitBuildingsByTile() / splitGreensByTile() / splitWatersByTile()

bakeTerrainMesh(elevation, ...)    → visual 32×32 grid (positions, normals, UVs, indices)
bakePhysicsTerrain(elevation, ...) → physics 32×32 grid (flat verts + indices)
bakeRoadSurfaces(roads, ...)       → pre-computed road ribbon geometry per layer
bakeVegetation(roads, buildings, greens, ...) → pre-computed tree positions
```

### 6. Write Tile

```
JSON v5 tile assembled in memory
convertTile(jsonTile) → binary v6 Buffer
fs.writeFileSync('tiles/delhi/16/{x}/{y}.bin', buffer)
```

---

## Binary Format Details (v6)

See [map-system.md](map-system.md) for the full binary layout specification.

The `convertToBinary.js` converter:
1. Collects all coordinate arrays into a binary "collector" (growing Float32/Uint32 lists)
2. Replaces each array in the JSON with `{ offset: bytesFromBinaryStart, count: n }`
3. Serializes the JSON header to UTF-8
4. Pads header to 4-byte boundary
5. Writes: `[uint32 headerLen] [header bytes] [binary sections]`

Road point triples are stored as `[mercatorX, elevationMeters, mercatorZ]`. The parser reads them back as:
```js
{ x: f32[j] - originX, y: f32[j+2] - originY, elevation: f32[j+1] }
// x = world X, y = world Z (misnamed!), elevation = height in meters
```

---

## Elevation Convention (Critical)

**This determines whether `BAKED_ROAD_ELEVATION_IS_RAW` in CONFIG is correct.**

### Current convention (`BAKED_ROAD_ELEVATION_IS_RAW: true`)
Road point elevations in the binary tile are **raw DEM meters** (absolute elevation above sea level). The frontend subtracts `worldElevationOffset` (spawn elevation) and multiplies by `ELEVATION_VERTICAL_EXAGGERATION` at runtime:
```js
normalizedY = (rawElevation - worldElevationOffset) * vertExag
```

### If you change the bake pipeline to pre-normalize
If `buildRegion.js` is changed to subtract the world elevation offset during baking (storing `rawElev - spawnElev` instead of `rawElev`), then `BAKED_ROAD_ELEVATION_IS_RAW` must be set to `false`. Otherwise the frontend will subtract the offset a second time and all roads will sink underground.

### How to identify which convention a tile uses
- `elevation.tileMinElevation` present → tile was re-based to its own minimum (offset=0 on the frontend)
- No `tileMinElevation` → uses `worldElevationOffset` from spawn elevation

---

## What a Re-Bake Invalidates

When you re-bake tiles, be aware of these downstream effects:

| Changed | Invalidates |
|---|---|
| Road topology or geometry | Road collider positions, junction gore geometry, all road meshes |
| Elevation values | Terrain trimesh physics, road deck box Y positions, spawn elevation offset |
| Bridge/tunnel layer detection | Deck collider heights, tunnel wall colliders, visual Y of roads |
| Ramp detection algorithm | Smooth elevation transitions on flyovers |
| Building footprints | All building meshes |
| Vegetation baking | Tree positions (may cause layout changes in visible veg) |
| Terrain baking (bakedTerrain) | Visual terrain mesh (re-generated from pre-computed arrays) |
| Binary format changes | All tiles must be re-baked; format version bump needed in `mapLoader.js` (`TILE_VERSION`) and `tileParserWorker.js` |

---

## Phase 2 OSM Fields — Road Data Pipeline

Six OSM tags are now emitted from the bake pipeline into the tile road payload (Phase 2 Barcelona road overhaul, 2026-05-29).

### 5-gate data flow

Every field must pass all five gates. If a field is null after baking, check gates in order:

```
Gate 1: pbfHighways.js KEEP_TAGS           — tag must be listed or it's silently dropped
Gate 2: buildRegion.js road payload map    — field must be emitted in tileRoadsFinal.map()
Gate 3: convertToBinary.js roads block     — field must be conditionally written to binary header
Gate 4: tileParserWorker.js readRoads      — field must be conditionally read from binary
Gate 5: roadRenderer.js / consumers        — field must be used where needed
```

Gates 3 and 4 were pre-built for all six fields (binary header is JSON, optional fields are backward compatible). Only gates 1 and 2 required changes in Phase 2.

### Normalization rules (gate 2, buildRegion.js)

| OSM tag | Tile field | Normalization |
|---|---|---|
| `oneway=yes/true/1` | `oneway: 'forward'` | Tri-state: forward / backward (-1) / no / null (absent) |
| `oneway=-1` | `oneway: 'backward'` | |
| `lanes=N` | `lanes: integer` | Clamped [1,12]; null if absent or non-numeric |
| `sidewalk=*` | `sidewalk: string \| null` | Raw string; 'both', 'left', 'right', 'no', 'none', 'separate' |
| `cycleway=*` | `cycleway: string \| null` | Raw string; 'lane', 'track', 'opposite_lane', 'shared_lane', 'no' |
| `surface=*` | `surface: string \| null` | Raw string; 'asphalt', 'concrete', 'paving_stones', 'sett', etc. |
| `maxspeed=N` | `maxspeed: integer \| null` | parseInt only; units stripped (30 mph → 30; km/h normalization future work) |

### Expected coverage in Barcelona (dense Eixample tile)

| Field | Expected % non-null |
|---|---|
| `lanes` | ~94% |
| `oneway` | ~80% |
| `surface` | ~80-95% |
| `sidewalk` | ~60-70% |
| `maxspeed` | variable |
| `cycleway` | ~15-25% |

Values WAY below these expectations indicate a gate failure upstream.

---

## Auto Water/Marina Elevation (bake-side, buildRegion.js)

After DEM grid sampling, every terrain grid cell that falls inside a water polygon (natural=water, marina, dock) is overridden to `−2.5m`. This eliminates the need for runtime terrain hole-cutting and bakes proper water depth into the tile.

```
DEM sample → terrain grid [128×128]
                ↓
Point-in-polygon test vs watersByTile + marinasByTile polygons
                ↓
Override matching cells to −2.5m
                ↓
Edge stitching + elev min/max computed from corrected grid
```

Water polygons are tested in Mercator coords. Marina polygons (world coords) are converted back to Mercator for the test. Bounding-box pre-rejection is applied per polygon for performance.

**Re-bake required** for this to take effect.

---

## Known Issues and Barcelona-Specific Risks

**NaN water vertices (existing bug):** Some tiles contain water polygon vertices that evaluate to NaN. The frontend's `meshHasNaN()` guard silently discards these meshes. Barcelona has far more coastline/water than Delhi — this bug will surface much more visibly. Fix `waterNormalize.js` / `pbfWater.js` before or during the Barcelona bake.

**Coastline (Barcelona-specific):** OSM models the sea as a large `natural=coastline` relation. `pbfWater.js` must handle:
1. Very large open polygons clipped to tile bbox
2. Open rings (coastline doesn't form a closed loop within a single tile)
3. Watch for duplicate vertices at clipping points — these produce zero-length edges → degenerate triangles → NaN in earcut
The tiles along the seafront (Barceloneta through Forum, tile row y≈24478–24488 at x≈33157–33162) are highest risk.

**Montjuïc elevation:** First real DEM terrain test. Elevation range ~0–173m within bbox. Spawn elevation (worldElevationOffset) ≈ 10–15m. Road elevations on Montjuïc will appear at ~158–160m in scene — physics deck boxes must reach those heights. If bridges on hills look sunken, check that DEM base addition in buildRegion.js fired correctly.

**BAKED_ROAD_ELEVATION_IS_RAW: true must remain true.** The new DEM integration adds raw DEM meters to road point Y values. Frontend subtracts spawnElevation at runtime. If this flag is ever set to false, all roads will appear underground by ~10–15m (the spawn elevation amount).

**Re-bake required for**: Any change to `convertToBinary.js`, `terrainBaker.js`, `roadBaker.js`, `vegetationBaker.js`, `buildRegion.js`, or the DEM files.

---

## Backend Server (No Processing)

`backend/server.js` is a 57-line file:
- Single endpoint: `GET /api/tiles/:tileId`
- tileId format: `z_x_y` (e.g. `16_46754_27357`)
- Reads binary file first; falls back to JSON if no `.bin` found
- CORS restricted to the `ALLOWED_ORIGINS` allowlist (default: `http://localhost:4040` dev + `http://localhost:4044` preview)
- Port: `process.env.PORT || 4041`
- No rate limiting, no authentication, no caching headers (served with `no-cache`)
