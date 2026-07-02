# Delhi Drive — Technical Documentation

**Version:** 1.0
**Last Updated:** April 2026

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Coordinate System & Map Projection](#3-coordinate-system--map-projection)
4. [Backend: World Builder Pipeline](#4-backend-world-builder-pipeline)
5. [Binary Tile Format (v6)](#5-binary-tile-format-v6)
6. [Backend: Tile Server](#6-backend-tile-server)
7. [Frontend: Initialization & Game Loop](#7-frontend-initialization--game-loop)
8. [Frontend: Scene & Rendering Setup](#8-frontend-scene--rendering-setup)
9. [Frontend: Tile Streaming & Progressive Loading](#9-frontend-tile-streaming--progressive-loading)
10. [Frontend: Road Rendering](#10-frontend-road-rendering)
11. [Frontend: Building Rendering](#11-frontend-building-rendering)
12. [Frontend: Terrain System](#12-frontend-terrain-system)
13. [Frontend: Vegetation System](#13-frontend-vegetation-system)
14. [Frontend: Water, Greens & Environment](#14-frontend-water-greens--environment)
15. [Frontend: Street Infrastructure](#15-frontend-street-infrastructure)
16. [Frontend: Tunnel & Bridge Rendering](#16-frontend-tunnel--bridge-rendering)
17. [Car Physics & Driving Model](#17-car-physics--driving-model)
18. [Car Visual Model](#18-car-visual-model)
19. [Camera System](#19-camera-system)
20. [User Interface](#20-user-interface)
21. [Web Worker Architecture](#21-web-worker-architecture)
22. [Performance Optimization Techniques](#22-performance-optimization-techniques)
23. [Day/Night Cycle](#23-daynight-cycle)
24. [Configuration Reference](#24-configuration-reference)
25. [Data Flow Summary](#25-data-flow-summary)
26. [Running the Project](#26-running-the-project)

---

## 1. Project Overview

Delhi Drive is a browser-based 3D driving simulator set in a detailed reconstruction of Delhi, India. The game uses real OpenStreetMap (OSM) data to generate an explorable city with accurate road networks, buildings, parks, water bodies, and street infrastructure. Players drive a BMW M3 through Delhi's streets in a stylized low-poly visual style.

**Key characteristics:**

- **Real-world geography**: Every road, building footprint, park boundary, and water body comes from OpenStreetMap data for the Delhi region (76.83°E–77.35°E, 28.40°N–28.88°N).
- **No runtime map fetching**: The entire map is pre-computed ("baked") into binary tile files at build time. The game loads these tiles on demand — no network calls to external map services during gameplay.
- **Browser-native**: Runs entirely in the browser using WebGL (Three.js) for rendering and Cannon-es for physics simulation. No plugins, no native code.
- **Tile-based streaming**: The world is divided into a grid of 500-meter tiles at zoom level 16. As the player drives, tiles load and unload seamlessly around the vehicle.

**Technology stack:**

| Component | Technology |
|-----------|-----------|
| 3D Rendering | Three.js (r183+) |
| Physics | Cannon-es |
| Build Tool | Vite |
| Map Data | OpenStreetMap PBF format |
| Elevation | GeoTIFF DEM (optional, currently flat) |
| Server | Express.js (static tile serving) |
| Map Widget | Leaflet (minimap overlay) |

---

## 2. Architecture

The project is a monorepo with three top-level directories:

```
delhi-drive/
├── frontend/          # Browser game (Three.js + Cannon-es + Vite)
├── backend/           # Tile server (Express) + world builder pipeline
└── data/              # Raw OSM PBF files and DEM GeoTIFFs
    └── regions/
        └── delhi/
            └── region.osm.pbf
```

**Data flows in two distinct phases:**

### Build Phase (offline, minutes to hours)

```
OSM PBF file
    ↓
[World Builder Pipeline]
    ├── Parse highways (2-pass PBF streaming)
    ├── Parse buildings, greens, water, barriers, railways
    ├── Build road graph (topology, junctions, ramps)
    ├── Resolve bridge/tunnel heights (layer interpolation)
    ├── Assign features to tiles (zoom-16 grid)
    ├── Pre-bake terrain mesh, physics colliders
    ├── Pre-bake vegetation positions (trees, bushes)
    ├── Pre-bake road ribbon geometry
    └── Pack each tile into binary v6 format (.bin)
          ↓
    backend/tiles/delhi/16/{x}/{y}.bin
```

### Runtime Phase (real-time, 60+ FPS)

```
Browser loads page
    ↓
[Frontend Initialization]
    ├── Create Three.js scene, camera, renderer, physics world
    ├── Initialize Web Worker pool (2-4 threads)
    ├── Fetch spawn tile from server
    ├── Build spawn tile (terrain + roads + physics)
    ├── Spawn car on nearest major road
    └── Begin game loop (requestAnimationFrame)
          ↓
[Per Frame]
    ├── Physics step (Cannon-es, fixed 60Hz, 3 substeps)
    ├── Read keyboard input → apply to vehicle
    ├── Stream tiles: load 3×3 grid + lookahead around player
    ├── Progressive tile building (4 phases, frame-budgeted)
    ├── LOD culling (distance-based visibility)
    ├── Update UI (speed, minimap, compass, street name)
    └── Render (Three.js EffectComposer with bloom + motion blur)
```

---

## 3. Coordinate System & Map Projection

The project uses three coordinate systems. Understanding their relationships is essential.

### Web Mercator (EPSG:3857)

Raw OSM data and internal computations use Web Mercator projection. Mercator coordinates are in meters, measuring east/north from the intersection of the equator and prime meridian.

```
Mercator X = R × longitude_radians
Mercator Y = R × ln(tan(π/4 + latitude_radians/2))
```

Where `R = 6,378,137` meters (WGS84 equatorial radius).

### World Coordinates

To avoid floating-point precision issues (Mercator values near Delhi are in the millions), all runtime coordinates are relative to a fixed **projection origin**:

- **Origin latitude**: 28.4946°N
- **Origin longitude**: 77.0890°E (central Delhi)

```
World X = Mercator X − Origin Mercator X
World Z = Mercator Y − Origin Mercator Y
World Y = elevation (up)
```

World coordinates are typically in the range of ±50,000 meters from the origin, well within Float32 precision.

### Tile Grid (Zoom 16)

The world is divided into a standard Web Mercator tile grid at zoom level 16:

- **Total tiles worldwide**: 2^16 × 2^16 = 65,536 × 65,536
- **Tile size at Delhi's latitude**: approximately 500 × 500 meters
- **Tile naming**: `z_x_y` (e.g., `16_46823_27337`)
- **Conversion**: latitude/longitude → tile indices via standard Slippy Map math

### Scene Mirroring

The Three.js scene uses a `worldGroup` container with `scale.x = -1`. This mirrors the entire visual scene along the X axis. The reason: Three.js and the physics engine have different handedness conventions. All visual content (roads, buildings, trees) is added to `worldGroup`, so they appear correctly mirrored. Physics bodies use the un-mirrored coordinate system.

```
Visual X = −(Physics X)
Visual Z = Physics Z
```

---

## 4. Backend: World Builder Pipeline

The world builder (`backend/worldBuilder/buildRegion.js`) transforms raw OSM data into game-ready binary tiles. It runs as a Node.js script with 8GB+ heap allocation recommended for Delhi-scale regions.

### 4.1 PBF Parsing

OpenStreetMap data is stored in Protocol Buffer Binary (PBF) format. The parser makes multiple streaming passes through the file:

**Pass 1 — Highway nodes**: Scans all OSM nodes and collects those within the bounding box plus a 0.02° margin (~2 km buffer). This margin ensures roads that extend slightly beyond the region boundary are fully captured.

**Pass 2 — Highway ways**: Collects all ways tagged with `highway=*` whose nodes overlap the collected set. Each way becomes a road with:
- Geometry: array of `[Mercator X, elevation Y, Mercator Z]` points
- Metadata: highway type, bridge/tunnel flags, layer, width, lanes, surface, name, speed limit, oneway, divider type, sidewalk presence

**Pass 3-7 — Other features**: Separate passes collect:
- Buildings (with multipolygon relation support for complex footprints and courtyards)
- Green areas (parks, gardens, forests, meadows, playgrounds)
- Water bodies (lakes, rivers, ponds, streams)
- Barriers (walls, fences, hedges, retaining walls)
- Railways, bus stops, parking areas, urban features (towers, fountains, fuel stations)

### 4.2 Road Graph & Height Resolution

After parsing, the road system undergoes topological analysis:

**Road Graph Construction**: All roads are organized into a graph structure (`nodeMap`, `wayMap`, `nodeToWays`) that tracks how roads connect at intersections.

**Junction Classification**: The system detects junction types (crossing, merge, roundabout) by analyzing how many roads meet at each node and their angular relationships.

**Ramp Resolver — Bridge/Tunnel Height Interpolation**: This is the most sophisticated part of the pipeline. Delhi has numerous flyovers, overpasses, and underpasses. The system must assign correct 3D heights to every road vertex:

- **Layer system**: Each bridge or tunnel has an OSM `layer` tag. Heights are computed as `layer × 6 meters` (6m per level).
- **Ground roads**: layer 0, height = 0 meters.
- **Bridge approach ramps**: When a ground-level road connects to an elevated bridge, the system creates a smooth transition ramp over 25 meters using a smoothstep interpolation curve. A 20% flat buffer at the ground end prevents abrupt slope changes.
- **Tunnel approaches**: Similar to bridge ramps but descending, with a 35-meter transition distance for a gentler slope.
- **Bridge-to-bridge transitions**: When bridges at different layers connect (e.g., a cloverleaf interchange), the system detects the height difference and interpolates the last few points of the lower bridge upward.
- **Isolated structures**: A bridge with no ground connection on one end still ramps smoothly to ground level.

### 4.3 Tile Assignment & Feature Distribution

Each feature is assigned to tiles based on its geographic location:

**Roads** use a "no-clip" strategy: the full geometry of every road is written to every tile its bounding box intersects. This means a road crossing a tile boundary appears in full in both tiles. The frontend handles deduplication. This approach avoids visual artifacts at tile seams.

**Buildings, greens, water, barriers** are assigned to the tile containing their centroid. Each feature appears in exactly one tile.

### 4.4 Pre-Baking

Before writing each tile, several expensive computations are pre-baked:

**Terrain Mesh**: A 128×128 grid of elevation samples (currently flat in phase1 mode, ready for DEM integration).

**Physics Terrain**: A simplified collision mesh for the physics engine's heightfield.

**Vegetation Positions**: Tree and bush placement is computed using the same algorithms the frontend would use, but at build time. This eliminates ~50ms of per-tile computation at runtime. The baker places:
- Roadside trees along all urban roads (primary through residential), spaced 2–5m apart on both sides
- Building perimeter trees for coverage near structures
- Zone vegetation in parks, forests, and gardens with species-appropriate density
- Bushes clustered around tree bases, along road edges, and near barriers

**Road Surfaces**: Pre-computed road ribbon geometry (positions, normals, UVs, indices) per layer, ready for direct GPU upload.

### 4.5 Vegetation Placement Algorithm

The vegetation system deserves special attention due to its complexity:

**Vegetation Mask**: A 0.5-meter resolution grid marks every cell as plantable or blocked. Roads (with 3m buffer), bridges (with 18m buffer to prevent canopy clipping), buildings, and water bodies are blocked.

**Ground Road Grid**: A separate 0.5m grid tracks only ground-level roads (not bridges/tunnels), used to prevent bushes from spawning on road surfaces.

**Junction Clearance**: Road endpoints within 5m of each other are clustered into junctions. A clearance radius of 10–18m (depending on road width) prevents trees from blocking intersection sight lines.

**Zone Rules** (density per square meter):

| Zone Type | Tree Density | Bush Density | Clearings | Scale Range |
|-----------|-------------|-------------|-----------|-------------|
| Forest | 1/25 m² | none | yes (10–15% area) | 0.7–1.3× |
| Park | 1/500 m² | 1/200 m² | no | 0.8–1.2× |
| Garden | 1/500 m² | 1/200 m² | no | 0.6–1.0× |
| Grass | 1/800 m² | 1/150 m² | no | 0.7–1.1× |
| Scrub | 1/400 m² | 1/50 m² | no | 0.5–0.9× |

**Tree Variants**: Each tree is assigned one of 4 species (Neem, Gulmohar, Ashoka, Banyan) via a deterministic seeded PRNG. The seed ensures identical placement between build-time baking and any runtime fallback computation.

---

## 5. Binary Tile Format (v6)

Each tile is stored as a single `.bin` file with the following layout:

```
Offset  Size     Content
──────  ────     ───────
0       4 bytes  Header length (uint32, little-endian, padded to 4-byte boundary)
4       N bytes  JSON header (UTF-8, zero-padded to 4-byte boundary)
4+N     rest     Binary data sections (Float32 and Uint32 arrays)
```

### JSON Header

The header is a JSON object describing every data section with byte offsets into the binary payload:

```json
{
  "version": 6,
  "tileId": "16_46823_27337",
  "elevation": {
    "resolution": 128, "min": 0, "max": 0,
    "south": 28.556, "west": 77.200, "north": 28.561, "east": 77.205,
    "gridRows": 128, "gridCols": 128,
    "elevationsOffset": 0, "elevationsCount": 16384
  },
  "roads": [
    { "id": "w12345", "width": 12, "highwayType": "primary", "bridge": false,
      "pointsOffset": 65536, "pointCount": 42, "name": "Aurobindo Marg", ... }
  ],
  "buildings": [
    { "id": "w67890", "height": 12, "levels": 4, "type": "residential",
      "footprintOffset": 131072, "footprintCount": 6, ... }
  ],
  "bakedVegetation": {
    "treeCount": 1823, "bushCount": 3000,
    "treePositionsOffset": 395152, "treeVariantsOffset": 409736, ...
  },
  ...
}
```

### Binary Data Sections

Data is packed as typed arrays for zero-copy GPU upload:

- **Elevation grid**: `Float32[gridRows × gridCols]` — height values in meters
- **Road points**: `Float32[pointCount × 3]` — `[x, elevation, z]` per point (Mercator coordinates)
- **Building footprints**: `Float32[footprintCount × 2]` — `[x, z]` per vertex (Mercator)
- **Vegetation positions**: `Float32[treeCount × 2]` — `[x, z]` pairs (Mercator)
- **Vegetation variants**: `Uint32[ceil(treeCount/4)]` — 4 variant indices packed per uint32 (1 byte each)
- **Baked mesh data**: `Float32` for positions/normals/UVs, `Uint32` for indices

All coordinates in the binary payload are stored in **Mercator absolute coordinates**. The frontend parser subtracts the projection origin when reading, converting to world coordinates.

---

## 6. Backend: Tile Server

The server (`backend/server.js`) is a minimal Express.js application:

- **Port**: 4041 (configurable via `PORT` environment variable)
- **CORS**: Allows requests from `http://localhost:4040` (the frontend dev server)
- **Single endpoint**: `GET /api/tiles/:tileId?region=delhi`
- **Tile lookup**: Parses tileId (`z_x_y` format), reads from `tiles/{region}/{z}/{x}/{y}.bin`
- **Binary preferred**: Serves `.bin` files with `Content-Type: application/octet-stream`. Falls back to `.json` for legacy v5 tiles.
- **No caching headers**: `Cache-Control: no-cache` (the frontend has its own IndexedDB cache)
- **Security**: TileId validated against `[a-zA-Z0-9_-]` pattern, max 64 characters

---

## 7. Frontend: Initialization & Game Loop

### Startup Sequence

1. Create Three.js scene, camera (60° FOV), WebGL renderer (antialiased, SRGB output)
2. Set up post-processing pipeline: RenderPass → UnrealBloomPass → RadialBlurPass → OutputPass
3. Initialize Web Worker pool (2–4 threads based on `navigator.hardwareConcurrency`)
4. Fetch the spawn tile (AIIMS area: 28.5672°N, 77.2095°E)
5. Build the spawn tile synchronously (terrain + roads + physics colliders)
6. Find the nearest major road in the spawn tile for on-road car placement
7. Create the car (physics body + visual model + chase camera)
8. Create all UI elements (speedometer, minimap, compass, performance panel)
9. Begin the animation loop

### Game Loop (60 FPS target)

Every frame, in order:

1. **Physics step**: `world.step(1/60, dt, 3)` — fixed 60Hz timestep with up to 3 substeps for frame-rate independence. Delta time capped at 35ms to prevent physics catch-up stutter.
2. **Input processing**: Read keyboard state, apply throttle/brake/steering to vehicle with smooth ramping.
3. **Tile streaming**: Based on the player's world position, determine which 3×3 tile grid (plus one lookahead tile in the driving direction) should be loaded. Enqueue missing tiles, start unloading distant tiles.
4. **Progressive tile building**: Active tile processing runs within a 6ms per-frame budget. Work is chunked across frames so tile loading never blocks rendering.
5. **LOD updates**: Per-tile distance-based visibility for trees, buildings, grass, and all props.
6. **UI updates**: Street name, speed/gear/RPM display, minimap position, compass heading.
7. **Shadow camera**: Follows the player, updated every 5m of movement.
8. **Render**: EffectComposer renders the scene with bloom (for car lights and streetlamps) and radial motion blur (scales with speed from 40–120 km/h).

---

## 8. Frontend: Scene & Rendering Setup

### Camera

- **Type**: PerspectiveCamera
- **FOV**: 60°
- **Near/Far planes**: 1m / 50,000m
- **Position**: Controlled by chase camera system (see Section 19)

### Lighting

| Light | Type | Color | Intensity | Purpose |
|-------|------|-------|-----------|---------|
| Ambient | AmbientLight | Warm amber (0xFFE8C8) | 0.55 | Base illumination, prevents pure-black shadows |
| Hemisphere | HemisphereLight | Sky blue / ground brown | 0.5 | Natural sky-ground bounce fill |
| Directional (Sun) | DirectionalLight | Warm gold (0xFFD9A0) | 1.2 | Primary shadow-casting light, SW late-afternoon angle |

The directional light follows the player (updated every 5m) to keep shadows centered. Shadow map resolution is 1024×1024 with PCFShadowMap filtering.

### Fog

Exponential fog (`FogExp2`) with density 0.007 creates natural atmospheric haze. This serves dual purposes: visual atmosphere and LOD masking — objects beyond ~150m are heavily fogged, hiding the transition where geometry is culled.

- **Day fog color**: 0x9DC2DB (pale blue haze)
- **Night fog color**: 0x0A1020 (deep navy)

### Sky

A large icosahedron dome (40,000m radius) with a custom gradient shader creates the sky. Three color bands blend smoothly:
- Horizon: matches fog color (seamless blend)
- Mid-sky: deeper blue
- Zenith: rich blue

Clouds are rendered as 12 billboard sprites in three orbital rings at different heights (5000m, 7000m, 10,000m). They follow the camera with parallax (lower clouds track faster). A procedural cloud texture is generated at startup from overlapping circles with underside darkening.

### Post-Processing

The render pipeline uses Three.js EffectComposer:
1. **RenderPass**: Standard scene render
2. **UnrealBloomPass**: Bloom at half resolution (strength 0.5, radius 0.4, threshold 1.1) — makes headlights, streetlamp pools, and emissive materials glow
3. **RadialBlurPass**: Custom shader creating speed-dependent edge blur. Strength interpolates from 0 at 40 km/h to maximum at 120+ km/h
4. **OutputPass**: Final gamma/color space conversion

---

## 9. Frontend: Tile Streaming & Progressive Loading

### Streaming Grid

The tile manager maintains a set of loaded tiles around the player:

- **Grid radius**: 1 → 3×3 = 9 tiles always loaded
- **Lookahead**: 1 additional tile in the driving direction (based on car heading)
- **Unload distance**: 3 tiles away (keeps recently visited tiles cached to avoid reload on U-turns)
- **Max concurrent loads**: 2 tiles processing simultaneously

### Progressive 4-Phase Building

When a new tile arrives from the server, its content is built in 4 phases spread across multiple frames:

**Phase 1 — Terrain + Roads + Physics** (immediate, ~50–100ms work):
- Build terrain visual mesh (32×32 grid) and physics heightfield
- Build road ribbon meshes with lane markings
- Create physics colliders (Trimesh bodies for terrain, box colliders for elevated roads)
- Build green area flat meshes
- **Tile is usable after this phase** — car can drive on it

**Phase 2 — Buildings + Railways** (~20–60ms work):
- Process building footprints through the building worker (off-thread extrusion)
- Materialize building meshes with architectural details
- Add to scene in batches of 4 meshes per yield

**Phase 3 — Vegetation** (~10–30ms work):
- Send baked tree/bush positions to vegetation worker (off-thread matrix computation)
- Materialize tree instances as BatchedMesh (single draw call per tile)
- Shadow discs and bush instances

**Phase 4 — Details** (background, spread over many frames):
- Grass instances (up to 15,000 per tile)
- Water body meshes
- Streetlights, barriers, crash barriers, bus stops
- Vendor carts, urban features, road infrastructure
- Decals, reflectors, environment clusters

### Frame Budget System

The yield function enforces a 6ms budget per frame for tile work:

```
If elapsed work time < 6ms → continue working (no yield)
If elapsed work time ≥ 6ms → yield to browser for rendering, reset timer
```

This means cheap operations chain instantly without wasting a full frame on each yield, while heavy operations (building extrusion, vegetation materialization) pause at natural breakpoints. The remaining ~10ms per frame (at 60 FPS) is available for physics, rendering, and UI updates.

---

## 10. Frontend: Road Rendering

### Geometry

Roads are rendered as flat ribbon meshes — two vertices (left edge, right edge) per road point, forming a continuous triangle strip. This is far more efficient than extruded 3D geometry.

**Width by road type** (meters):

| Highway Type | Width | Description |
|-------------|-------|-------------|
| Motorway | 30 | National highway, divided |
| Trunk | 26 | Major arterial |
| Primary | 20 | City primary road |
| Secondary | 16 | District road |
| Tertiary | 13 | Neighborhood collector |
| Residential | 10 | Local street |
| Service | 7 | Access road, parking |
| Living Street | 8 | Pedestrian-priority |

### Lane Markings

Road markings follow Indian Road Congress (IRC) Standard 35:

- **Center line**: Solid for motorways/trunk roads, dashed for others
- **Edge lines**: White, always present on roads wider than 6m
- **Lane dividers**: Dashed (2m dash, 2m gap) on multi-lane roads
- **Double solid lines**: Two parallel lines with 0.2m gap for no-overtaking zones
- **Marking width**: 0.15m for center lines, 0.12m for lane dividers

### Elevation & Layering

Roads follow terrain elevation when available. On bridges, roads are elevated by `layer × 6 meters`. The ramp resolver ensures smooth transitions between ground and elevated sections.

Visual layering prevents z-fighting between overlapping flat surfaces:
- Terrain: 0m
- Green areas: +0.01m
- Road surface: +0.05m
- Sidewalks: +0.08m
- Edge strips: road + 0.02m
- Lane markings: road + 0.03m

### Materials

All road surfaces share a single `MeshStandardMaterial` with vertex colors for asphalt variation. Properties: roughness 0.9, metalness 0, double-sided. Polygon offset is applied to prevent z-fighting with terrain beneath.

---

## 11. Frontend: Building Rendering

### Extrusion

Buildings are created by extruding their OSM footprint polygon upward to the building height. The extrusion is single-step (no vertical subdivisions), producing one quad per footprint edge for the walls plus a flat roof cap.

Complex footprints (more than 16 vertices) are simplified using the Ramer-Douglas-Peucker algorithm at 0.3m tolerance, progressively increasing if needed.

### Facade Categories

Buildings are classified into 7 categories based on OSM tags, each with distinct visual treatment:

1. **Residential**: Terracotta/cream walls, balcony slabs every 3m of height, AC unit boxes
2. **Commercial**: Glass/metal facades, storefront awnings at ground level, signboard panels
3. **Office**: Grid-pattern windows, modern metallic tones
4. **Hospital**: Clean white walls, red cross signage
5. **School**: Colorful facades, playground markings
6. **Industrial**: Corrugated metal texture, utilitarian grey
7. **Religious**: Ornate shikhara (temple spire) cones, stepped plinths, saffron flags on poles

### Architectural Details

Each category adds 3D details:
- **Balcony slabs**: 0.5m-deep flat boxes protruding from facade
- **Railing bars**: Thin vertical cylinders along balcony edges
- **AC units**: Small brown boxes on walls with dark fan disc
- **Water tanks**: Cylinders on rooftops (1–2m diameter)
- **Parapets**: Low walls around roof edges
- **Awnings**: Angled canopies over ground-floor shops

All details have per-category vertex caps (20,000 for balconies, 20,000 for commercial, 12,000 for religious, 15,000 for boundary walls) to prevent any single tile from becoming too heavy.

### LOD System

Buildings use a two-tier Level of Detail system:

- **0–110m**: Full detail — walls, roof, all architectural details
- **110–120m**: Details (balconies, AC units) fade out; walls and roof remain
- **120–180m**: Only wall and roof geometry visible
- **110–230m**: Simplified LOD boxes appear — colored bounding boxes matching the building's approximate shape and color, rendered as 5 quads (4 walls + top)
- **230m+**: Nothing visible (fog masks the transition)

---

## 12. Frontend: Terrain System

### Visual Mesh

Each tile's terrain is a planar grid mesh:
- **Resolution**: 32×32 grid points (configurable, max 32)
- **Geometry**: `(32-1) × (32-1) × 2 = 1,922 triangles` per tile
- **Elevation**: Sampled from the tile's 128×128 DEM grid using bilinear interpolation
- **UV coordinates**: Tile-local 0–1 range for potential texture mapping

Currently, the project runs in "Phase 1 Pure 2D" mode where all elevation values are 0 (flat terrain). The DEM integration infrastructure is complete and ready for activation.

### Physics Collider

Each tile creates a `CANNON.Trimesh` body matching the visual terrain mesh. This allows the car's raycast wheels to detect ground height anywhere on the tile.

- **Collision group**: `COLLISION_GROUP_GROUND`
- **Material**: Road friction (0.6 coefficient, zero restitution)
- **Static**: mass = 0, does not move

### Elevation Sampling

A fast elevation function is created per tile that maps world coordinates (X, Z) to terrain height (Y):

1. Convert world XZ to grid row/column using pre-computed scale factors (avoids trig)
2. Bilinear interpolate between 4 nearest grid points
3. Subtract the world elevation offset

This function is called thousands of times per tile for vegetation placement, grass scattering, and road elevation queries.

---

## 13. Frontend: Vegetation System

### Tree Species

Four tree variants represent common Delhi roadside species:

| Variant | Species | Trunk | Foliage | Character |
|---------|---------|-------|---------|-----------|
| 0 | Neem / Peepal | 0.3m × 5m | 3 clusters, dome shape | Round canopy, most common |
| 1 | Gulmohar | 0.35m × 4.5m | 3 clusters, wide spread | Horizontal spread |
| 2 | Ashoka | 0.25m × 5.5m | 2 clusters, tall narrow | Columnar, vertically stretched |
| 3 | Banyan | 0.4m × 4m | 3 clusters, asymmetric | Organic, irregular canopy |

### Geometry

Each tree is a merged geometry of:
- **Trunk**: Tapered cylinder (3 radial segments × 2 height segments, open-ended)
- **Foliage**: 2–3 dodecahedrons (detail level 0 = 20 triangles each) at different positions, sizes, and rotations

Total per tree: approximately 60–80 triangles.

### Visual Treatment

- **Vertex colors**: Each foliage piece has a unique green from the variant's palette, with brightness variation for depth
- **Dust gradient**: Lower portions of foliage blend toward a dusty brown (0x9B8B6E), simulating Delhi's characteristic road dust
- **White lime band**: Trunk base (below 1.2m) is painted off-white, replicating the real-world practice of whitewashing tree trunks in India
- **Per-instance variation**: Random scale (0.55–1.45×), rotation, and slight lean (up to 4°)

### Rendering

Trees use `THREE.BatchedMesh` — a single draw call renders all trees of all 4 variants per tile. Instance matrices and per-instance colors are computed in a Web Worker and transferred to the main thread as typed arrays.

**LOD**:
- 0–100m: Full density
- 100–160m: Linear fade (fewer instances visible)
- 160m+: Hidden (fog masks the cutoff)

### Shadows

Each tree casts a circular shadow disc on the ground — a flat plane with a procedural radial gradient texture. Shadow size scales with the tree's foliage radius. These are rendered as an `InstancedMesh` with one instance per tree.

### Bushes

Bush clusters (low dodecahedrons with green vertex colors) appear:
- Around tree bases (2–4 bushes per tree)
- Along road edges at 4–8m intervals
- Near barriers at 4m intervals

Up to 3,000 bushes per tile, rendered as a single `InstancedMesh`.

---

## 14. Frontend: Water, Greens & Environment

### Water Bodies

Lakes, ponds, and river sections from OSM are rendered as flat polygon meshes:

- **Material**: Translucent blue (0x1A7A9B), 85% opacity, with specular highlights (shininess 90)
- **Depth**: Placed 0.8m below surrounding terrain
- **Minimum area**: 800 m² (smaller features skipped)
- **Simplification**: Douglas-Peucker at 2m tolerance

### Green Areas

Parks, gardens, forests, meadows, and playgrounds are rendered as flat green polygons:

- **Material**: Lambert material, soft green (0x7A9A4A)
- **Layering**: 0.01m above terrain to prevent z-fighting
- **Types**: park, garden, forest, grass, scrub, playground, meadow, village_green, recreation_ground

### Grass

Grass blades are scattered as instanced crossed-plane pairs:

- **Geometry**: Two intersecting planes forming an X shape (4 triangles total)
- **Placement**: Along roads, near trees, and within green areas
- **Density**: Up to 15,000 instances per tile
- **Visibility**: Within 60m of the camera only
- **Animation**: Vertex shader applies gentle wind sway based on world position and time

---

## 15. Frontend: Street Infrastructure

### Streetlights

Placed every 30m along motorways through residential roads:

- **Components**: Concrete pole (8m tall), horizontal arm (1.8m), lamp head, ground light pool
- **Pool decal**: 9m-diameter circular gradient on the ground simulating light cone
- **Day/night**: Lamp emissive intensity transitions from 0.25 (day) to 4.5 (night); pool opacity from 0.04 to 1.0
- **Convex mirrors**: On residential/service road poles, small reflective discs at 3.5m height

### Barriers & Walls

Compound walls, fences, and hedges from OSM barrier tags:

- **Compound walls**: Precast concrete panels with pillars at 3m intervals
- **Fences**: Metal post-and-rail (lower height)
- **Hedges**: Green bush-like geometry
- **Gate pillars**: Taller columns with decorative finials where gates are tagged

### Crash Barriers

Yellow-and-black striped concrete barriers on sharp curves of major roads:

- **Placement**: Computed from road curvature (tight bends on motorway/trunk/primary/secondary)
- **Units**: 3.5m-long individual barrier segments
- **Material**: Yellow base with black diagonal stripes

### Bus Stops

Placed at tagged OSM bus stop locations:

- **Shelter**: Metal frame with translucent roof panels
- **Bench**: Simple wooden bench geometry
- **Road marking**: Dashed bay marking on road surface

### Vendor Carts

Colorful street food carts placed in clusters along commercial roads:

- **Composition**: Cart body + colorful canopy + figures
- **Placement**: Near intersections and commercial areas, respecting exclusion zones around road surfaces and buildings

### Urban Features

Point features from OSM:
- **Communication towers**: Tapered cylinders with red blinking beacon light (1-second cycle)
- **Water towers**: Large elevated cylinders
- **Fuel stations**: Pump islands + canopy structure
- **Fire hydrants**: Small red cylinders at road edges

---

## 16. Frontend: Tunnel & Bridge Rendering

### Tunnels

When roads have `tunnel=yes` and descend below terrain:

- **Ceiling**: Flat panel above the road at tunnel height
- **Walls**: Vertical panels on both sides
- **Floor**: Road surface continues inside
- **Approach canopy**: Gradual overhead structure at tunnel mouth, transitioning from open air to enclosed tunnel
- **Terrain carving**: The terrain mesh has vertices inside the tunnel zone punched to negative elevation, creating the visual tunnel mouth opening

### Bridges

Elevated road sections with:

- **Deck colliders**: Box-shaped physics bodies matching the road width and 0.2m thickness
- **Pillars**: Cylindrical columns at 30m intervals (0.5m radius)
- **Guard rails**: Concrete walls (0.8m high, 0.25m thick) along edges
- **Metal railings**: Posts and top rail above the concrete walls

---

## 17. Car Physics & Driving Model

### Vehicle Setup

The car uses Cannon-es `RaycastVehicle`, which simulates wheels via raycasts rather than rigid body contacts. This is far more stable for game-style driving.

**Chassis**:
- **Shape**: Box (1.5m wide × 0.52m tall × 3.3m long)
- **Mass**: 1,600 kg
- **Linear damping**: 0.05 (minimal air resistance feel)
- **Angular damping**: 0.4 (prevents spinning)

**Wheels** (4, connected via suspension springs):

| Parameter | Value | Notes |
|-----------|-------|-------|
| Radius | 0.30m | Visual match to BMW M3 |
| Suspension rest length | 0.30m | Moderate ride height |
| Suspension stiffness | 60 N/m | Firm but forgiving |
| Compression damping | 4.0 | Absorbs bumps firmly |
| Rebound damping | 3.2 | Allows terrain following |
| Max travel | 0.25m | Handles terrain bumps |
| Friction slip | 5.0 | High grip |
| Roll influence | 0.08 | Prevents flip in turns |

### Transmission

6-speed automatic transmission modeled after a BMW M3 DCT:

| Gear | Ratio | Top Speed (km/h) |
|------|-------|-------------------|
| 1 | 3.20 | 55 |
| 2 | 2.20 | 95 |
| 3 | 1.55 | 145 |
| 4 | 1.18 | 195 |
| 5 | 0.94 | 245 |
| 6 | 0.78 | 280 |

**Auto-shift logic**:
- Shift up: when speed exceeds 82% of current gear's top speed (with throttle applied)
- Shift down: when speed drops below 70% of previous gear's top speed
- Shift cooldown: 0.3 seconds (DCT-quick)

### Engine Model

- **Base force**: 4,800 N
- **Torque curve**: `1.0 − 0.3 × (rpmNorm − 0.5)²` — peaks at mid-RPM, falls off at extremes
- **RPM range**: 850 (idle) to 7,000 (limiter)
- **Rev limiter**: Smooth power fade starting at 92% of max RPM (no hard cut)
- **Gear shift**: Torque reduces to 15% during shift, then ramps back smoothly (no hard cut)
- **Launch ramp**: Force starts at 40% from standstill, ramps to 100% by 8 km/h

### Driving Dynamics

- **RWD**: Engine force applied to rear wheels only
- **Speed-dependent steering**: 22° at low speed, 6° at high speed (linear interpolation)
- **Steering smoothing**: 3.5 rad/s lerp rate prevents snappy direction changes
- **Downforce**: Proportional to speed² (coefficient 0.50), prevents high-speed flipping
- **Lateral stabilization**: Damping force opposes sideways velocity, reduced during drift
- **Handbrake drift**: Progressive rear grip reduction, smooth sliding rather than instant lockup
- **Engine braking**: Gentle deceleration when coasting (8N + 0.08N per km/h)
- **Pitch/roll damping**: Frame-rate-independent exponential decay prevents oscillation

### Contact Materials

The physics world uses a custom contact material between car wheels and road surfaces:
- **Friction**: 0.6
- **Restitution**: 0.0 (no bounce)
- **Contact stiffness**: 10^8 (very firm)
- **Relaxation**: 3 (moderate)

---

## 18. Car Visual Model

The car uses a BMW M3 GLB (glTF Binary) model loaded via Three.js GLTFLoader:

- **Scale**: 0.75× (matches physics chassis dimensions)
- **Paint material**: MeshStandardMaterial with procedural environment map, metalness 0.4, roughness 0.3
- **Environment map**: Generated at startup from a gradient sky sphere using PMREM (Pre-filtered Mipmapped Radiance Environment Map)
- **Wheels**: Extracted from the GLB hierarchy, rotated per-frame to match physics wheel angular velocity
- **Headlights**: SpotLights attached to the front (when enabled)
- **Tail lights**: Emissive red material on rear mesh, intensity scales with braking
- **Shadow**: The car casts shadows onto the road via the directional light

---

## 19. Camera System

The chase camera follows the car with smooth interpolation:

- **Default offset**: 6m behind, 2m above the car
- **Look-at target**: 8m ahead of the car (creates a cinematic forward view)
- **Position smoothing**: Exponential lerp (16% per frame at 60fps)
- **Look-at smoothing**: Exponential lerp (12% per frame)
- **Speed zoom**: Camera pulls slightly closer at high speed
- **Reverse**: When reversing below −3 km/h, the camera smoothly swings to face forward (showing the front of the car)
- **Yaw-only tracking**: Camera follows the car's horizontal heading only — pitch and roll from bumps do not affect the camera, preventing motion sickness

---

## 20. User Interface

### Performance Panel (top-right)

A real-time debug overlay showing:
- FPS, draw calls, triangle count, geometry/texture count
- Active tiles, road/building/tree counts
- Physics body count, heap memory usage
- Camera Y position

### Speedometer (bottom-right)

- Large numeric speed display (km/h)
- Current gear number with color coding (yellow at 80 km/h, orange at 120, red at 160+)
- RPM bar visualization

### Minimap (bottom-left)

A circular Leaflet map widget (170×170 pixels):
- OpenStreetMap tiles as base layer
- Red heading indicator dot on a compass ring
- Rotates with the car's heading (north-up becomes heading-up)
- Day/night tinting (desaturated + dimmed at night)
- Click to expand to fullscreen modal

### Street Name Display (top-left)

Shows the name and type of the nearest road segment, updated every 10m of movement via spatial index query.

### Compass Bar (top-center)

Horizontal compass strip showing cardinal directions and current heading in degrees.

### Speed Lines

Radial line effect emanating from screen edges at high speed (onset at 40 km/h, maximum at 120+ km/h). Purely visual — enhances the sense of speed.

---

## 21. Web Worker Architecture

Heavy computation is offloaded to Web Workers to keep the main thread responsive:

### Worker Pool

- **Pool size**: `min(max(2, hardwareConcurrency - 2), 4)` — adapts to CPU cores
- **Dispatch**: Round-robin assignment to workers
- **Protocol**: Typed messages with unique request IDs. Supports cancellation per tile.
- **Data transfer**: Uses `Transferable` ArrayBuffers for zero-copy data movement between threads

### Tile Parser Worker

A dedicated worker fetches tiles from the server, parses the binary format, and converts Mercator coordinates to world coordinates. Results are cached in IndexedDB for offline re-use (7-day TTL).

### Building Worker

Receives building footprints and metadata, performs wall extrusion, architectural detail generation, roof capping, and vertex color computation. Returns typed arrays of positions, normals, colors, and indices.

### Vegetation Worker

Receives baked tree/bush positions, computes per-instance transformation matrices (position, rotation, scale, lean) and per-instance colors. Returns Float32Arrays for direct upload to InstancedMesh/BatchedMesh.

### Grass Worker

Similar to vegetation but for grass blade instances. Computes positions avoiding roads and buildings, samples terrain height, and returns instance matrices.

---

## 22. Performance Optimization Techniques

### Rendering

| Technique | Impact | Description |
|-----------|--------|-------------|
| BatchedMesh for trees | ~90% fewer draw calls | All 4 tree variants per tile in 1 draw call |
| InstancedMesh for grass/bushes | ~95% fewer draw calls | Thousands of instances, 1 draw call each |
| Mesh merging by material | ~60% fewer draw calls | Buildings/roads merged into tile-level meshes |
| Frustum culling | ~30% fewer triangles | Objects behind camera not rendered |
| Distance-based LOD | ~50% fewer triangles | Far objects simplified or hidden |
| Fog masking | Zero visual cost | Hides LOD transitions at 150m+ |
| Vertex colors (no textures) | ~80% less GPU memory | Stylized look, no texture sampling cost |
| Half-resolution bloom | ~75% less post-process cost | Bloom at 50% resolution, imperceptible quality difference |

### Memory

| Technique | Savings | Description |
|-----------|---------|-------------|
| Pre-baked vegetation | ~50ms/tile saved | Tree positions computed at build time |
| Binary tile format | ~40% smaller | Packed Float32 vs verbose JSON |
| IndexedDB caching | Eliminates re-fetch | 7-day TTL for parsed tiles |
| Geometry disposal on unload | Prevents leaks | All buffers freed when tiles leave cache |
| Shared materials | ~90% less material objects | One material per system, not per mesh |
| Worker Transferables | Zero-copy | ArrayBuffers moved, not copied, between threads |

### Physics

| Technique | Impact | Description |
|-----------|--------|-------------|
| RaycastVehicle | 10× cheaper than rigid wheels | Wheel contact via raycasts, not collision detection |
| Per-tile colliders | Bounded complexity | Only loaded tiles have physics bodies |
| Batched tree colliders | ~200× fewer bodies | 200 trees per physics body |
| NaiveBroadphase | Required for heightfields | Heightfield bodies incompatible with SAPBroadphase |
| Static body sleep | Zero update cost | Terrain/building bodies never simulate |

### Loading

| Technique | Impact | Description |
|-----------|--------|-------------|
| 4-phase progressive loading | No frame drops | Terrain/roads first, details spread across frames |
| Frame budget (6ms) | Smooth 60 FPS | Tile work pauses to let rendering breathe |
| Max 2 concurrent loads | Prevents thread starvation | Only 2 tiles process simultaneously |
| Driving-direction lookahead | Seamless experience | Next tile loads before player reaches it |
| Priority by camera direction | Most important first | Tiles the player is looking toward load first |

---

## 23. Day/Night Cycle

When `ENABLE_DAY_NIGHT` is active, the game smoothly transitions between day and night states:

### Day State

- Ambient: warm amber (0xC8DCE8, 0.45)
- Sun: gold (0xFFEEDD, 2.5 intensity)
- Fog: pale blue (0x9DC2DB, density 0.007)
- Sky visible, clouds white
- Streetlamps dim (emissive 0.25), light pools barely visible (opacity 0.04)

### Night State

- Ambient: cool blue (0x7799CC, 1.6) — increased to keep geometry visible
- Moonlight: blue-white (0xC8D8FF, 0.25 intensity)
- Fog: deep navy (0x0A1020, density 0.009)
- Sky hidden, background deep blue (0x0E1321)
- Stars (1,500 points) and moon visible
- Streetlamps bright (emissive 4.5), light pools full (opacity 1.0)
- Car headlights activated

### Transition

All values smoothly interpolate between day and night states using linear blending. The transition can be triggered by a UI toggle button or automated on a configurable timer (default: 15-minute full cycle when enabled).

---

## 24. Configuration Reference

All gameplay parameters are centralized in `frontend/src/config.js`:

### Feature Toggles (boolean)

| Key | Default | Controls |
|-----|---------|----------|
| `ENABLE_CAR` | true | Car physics + chase camera vs free orbit |
| `ENABLE_BUILDINGS` | true | Building geometry |
| `ENABLE_TREES` | true | Tree vegetation |
| `ENABLE_TERRAIN` | true | DEM heightfield mesh |
| `ENABLE_FOG` | true | Atmospheric fog |
| `ENABLE_SHADOWS` | true | Shadow mapping |
| `ENABLE_DAY_NIGHT` | false | Day/night cycle |
| `ENABLE_WATER` | true | Water body rendering |
| `ENABLE_STREETLIGHTS` | true | Streetlamp poles + pools |
| `ENABLE_BARRIERS` | true | Walls, fences, hedges |
| `ENABLE_CRASH_BARRIERS` | true | Yellow curve barriers |
| `ENABLE_BUS_STOPS` | true | Bus shelter meshes |
| `ENABLE_VENDOR_CARTS` | true | Street food carts |
| `ENABLE_URBAN_FEATURES` | true | Towers, fuel stations |
| `ENABLE_ROAD_INFRA` | true | Traffic lights, infra |
| `ENABLE_TUNNELS` | true | Tunnel enclosures |
| `ENABLE_DECALS` | true | Road decals |
| `ENABLE_RAILWAYS` | false | Railway tracks |
| `ENABLE_ZONE_VEGETATION` | false | Dense park/forest trees |
| `ENABLE_PARKING` | false | Parking lot meshes |

### Numeric Parameters

| Key | Default | Controls |
|-----|---------|----------|
| `MAX_TREES_PER_TILE` | 3,000 | Tree instance cap |
| `TREE_FULL_DISTANCE` | 100m | Full tree density range |
| `TREE_MAX_DISTANCE` | 160m | Tree visibility cutoff |
| `BUILDING_MAX_DISTANCE` | 180m | Full building cutoff |
| `BUILDING_LOD_START` | 110m | LOD box appearance |
| `BUILDING_LOD_END` | 230m | LOD box cutoff |
| `MAX_GRASS_PER_TILE` | 15,000 | Grass instance cap |
| `GRASS_MAX_DISTANCE` | 60m | Grass visibility |
| `SHADOW_MAP_SIZE` | 1,024 | Shadow texture resolution |
| `TERRAIN_GRID_SIZE` | 32 | Terrain mesh detail |
| `MAX_DYNAMIC_STREETLIGHTS` | 8 | Nearby streetlight cap |

---

## 25. Data Flow Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                        BUILD TIME                                │
│                                                                  │
│  region.osm.pbf ──→ [PBF Parser] ──→ roads, buildings, greens  │
│                          │               water, barriers, etc.   │
│                          ▼                                       │
│                    [Road Graph]                                   │
│                    [Ramp Resolver]                                │
│                    [Height Interpolation]                         │
│                          │                                       │
│                          ▼                                       │
│                    [Tile Splitter]                                │
│                          │                                       │
│         ┌────────────────┼────────────────┐                     │
│         ▼                ▼                ▼                      │
│    [Terrain Baker]  [Veg Baker]    [Road Baker]                 │
│         │                │                │                      │
│         └────────────────┼────────────────┘                     │
│                          ▼                                       │
│                   [Binary Packer]                                │
│                          │                                       │
│                          ▼                                       │
│                   tiles/delhi/16/x/y.bin                         │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        RUNTIME                                   │
│                                                                  │
│  Browser ──→ GET /api/tiles/16_x_y ──→ [Express Server]        │
│                                              │                   │
│                                              ▼                   │
│              [Tile Parser Worker] ←── binary .bin file           │
│                      │                                           │
│     ┌────────────────┼──────────────────┐                       │
│     ▼                ▼                  ▼                        │
│  [Building      [Vegetation       [Grass                        │
│   Worker]        Worker]           Worker]                      │
│     │                │                  │                        │
│     └────────────────┼──────────────────┘                       │
│                      ▼                                           │
│              [Tile Manager]                                      │
│              (4-phase progressive build)                         │
│                      │                                           │
│     ┌────────────────┼──────────────────┐                       │
│     ▼                ▼                  ▼                        │
│  [Three.js       [Cannon-es        [UI Panels]                  │
│   Scene]          World]                                         │
│     │                │                                           │
│     ▼                ▼                                           │
│  [EffectComposer] [RaycastVehicle]                              │
│     │                │                                           │
│     ▼                ▼                                           │
│  Screen           Car Movement                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 26. Running the Project

### Prerequisites

- Node.js 18+
- npm
- A Delhi OSM PBF file at `data/regions/delhi/region.osm.pbf`

### Build Tiles

```bash
cd backend
npm install
node --max-old-space-size=8192 worldBuilder/buildRegion.js
```

This processes the full Delhi region and writes ~9,700 binary tiles to `backend/tiles/delhi/16/`. Takes approximately 90–120 minutes on an M-series Mac.

For a quick test with a smaller area (AIIMS neighborhood):

```bash
npm run build:test
```

### Start Backend

```bash
cd backend
npm start          # Port 4041, with nodemon auto-reload
```

### Start Frontend

```bash
cd frontend
npm install
npm run dev        # Port 4040, Vite dev server with HMR
```

### Play

Open `http://localhost:4040` in a modern browser (Chrome/Edge/Firefox with WebGL2 support).

**Controls:**
- **W / Arrow Up**: Accelerate
- **S / Arrow Down**: Brake / Reverse
- **A / Arrow Left**: Steer left
- **D / Arrow Right**: Steer right
- **Space**: Handbrake (for drifting)

---

*This document describes the Delhi Drive project as of April 2026. The project is under active development; specific parameters and features may evolve.*
