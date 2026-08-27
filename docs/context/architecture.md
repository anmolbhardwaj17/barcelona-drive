# Architecture

## Stack

| Layer | Technology | Version |
|---|---|---|
| Rendering | Three.js | ^0.183.1 |
| Physics | cannon-es | ^0.20.0 |
| Build / Dev server | Vite | ^7.3.1 |
| Binary asset import | vite-plugin-arraybuffer | ^0.1.4 |
| Texture optimization | sharp (devDep) | ^0.34.5 |
| Frontend framework | **None** — vanilla ES modules | — |
| Map overlay (minimap) | Leaflet | ^1.9.4 |
| Backend server | Express | ^4.21.0 |
| DEM raster reading | geotiff | ^2.1.0 |
| OSM data parsing | osm-pbf-parser | ^2.3.0 |
| Spatial indexing (backend) | rbush | ^4.0.1 |
| Backend hot reload | nodemon (devDep) | ^3.1.0 |

No React, Vue, or other UI framework. Everything is vanilla ES module JS.

---

## Directory Layout

```
delhi-drive/
├── CLAUDE.md                     ← Auto-loaded context index (this system)
├── docs/context/                 ← Persistent Claude context docs
├── frontend/
│   ├── src/
│   │   ├── main.js               ← Entry point + rAF game loop
│   │   ├── scene.js              ← THREE scene, camera, renderer, sky, physics world
│   │   ├── config.js             ← All feature flags and tuning constants
│   │   ├── projection.js         ← Mercator ↔ world coords, tile math, spawn coords
│   │   ├── collisionGroups.js    ← Bit-flag constants for cannon-es collision masks
│   │   ├── elevationOffset.js    ← Global spawn-elevation normalization value (singleton)
│   │   ├── originOffset.js       ← Spawn-tile SW corner world offset (precision fix)
│   │   ├── roadElevation.js      ← toNormalizedRoadY() shared utility
│   │   ├── tunnelZones.js        ← Registry of tunnel extents (for camera + effects)
│   │   ├── dayNight.js           ← Full 24h sky/sun cycle (disabled by default)
│   │   ├── timeSystem.js         ← In-game time (1 real sec = configurable ratio)
│   │   ├── debugColliders.js     ← Wire-frame overlay for all physics bodies (debug)
│   │   ├── car/
│   │   │   ├── carDriver.js      ← Façade: orchestrates all car sub-systems
│   │   │   ├── carPhysics.js     ← RaycastVehicle, transmission, all forces
│   │   │   ├── carControls.js    ← Keyboard input with progressive ramping
│   │   │   ├── carCamera.js      ← Speed-responsive chase camera with lerp
│   │   │   ├── carModel.js       ← GLB loader, body lean, color panel UI
│   │   │   ├── carModels.js      ← Kenney city-car kit: cached GLB parse, ONE canonical geometry
│   │   │   │                        per model at CANON_LENGTH, ONE shared material for all nine
│   │   │   ├── carFleet.js       ← THE car pool: one BatchedMesh holds EVERY city car in the world
│   │   │   │                        (traffic + parked), + a light InstancedMesh factory. 41 draws → 3
│   │   │   ├── trafficSystem.js  ← AI traffic — pool slots, kinematic paths, static box colliders
│   │   │   ├── parkedCars.js     ← Curb parking — pool slots, rebuilt every REBUILD_DIST metres
│   │   │   ├── carEffects.js     ← Skid marks, tire smoke (both one InstancedMesh; per-puff alpha
│   │   │   │                        rides an instanced attribute patched in via patchMaterial)
│   │   │   ├── carSound.js       ← Web Audio engine sound (RPM-based)
│   │   │   └── carMouseControls.js ← Stub (mouse orbit disabled, kept for reference)
│   │   ├── camera/
│   │   │   └── freeCameraController.js ← Orbit camera for ENABLE_CAR=false mode
│   │   ├── map/
│   │   │   ├── roadWidths.js     ← R-W1: THE width accessor. Reads the v10 baked SECTION
│   │   │   │                        (carriageway / parking bays / kerb-to-kerb / sidewalk /
│   │   │   │                        corridor). NEVER re-derive a road width anywhere else
│   │   │   ├── tileManager.js    ← Tile streaming core (2346 lines — the engine heart)
│   │   │   ├── mapLoader.js      ← Fetches tiles via tileParserWorker + in-flight dedup
│   │   │   ├── tileParserWorker.js ← Web Worker: binary v6 + JSON v5 + IndexedDB cache
│   │   │   ├── fastElevation.js  ← O(1) world→elevation lookup (precomputed, no trig)
│   │   │   ├── spatialIndex.js   ← R-tree nearest-road queries (street name lookup)
│   │   │   ├── roadOccupancyGrid.js ← Grid for vegetation placement exclusion
│   │   │   ├── vegetationMask.js ← Polygon mask excluding roads/buildings from veg
│   │   │   ├── roadRenderer.js   ← Road ribbon geometry, markings, bridge pillars
│   │   │   ├── buildingRenderer.js ← Extruded footprints + LOD simplified boxes
│   │   │   ├── terrainRenderer.js  ← DEM elevation mesh, bilinear/bicubic interp
│   │   │   ├── grassRenderer.js    ← InstancedMesh grass blades with wind shader
│   │   │   ├── vegetationRenderer.js ← Tree InstancedMesh / BatchedMesh + billboards
│   │   │   ├── zoneVegetationRenderer.js ← Dense veg in park/green zones
│   │   │   ├── tunnelRenderer.js   ← Tunnel enclosure meshes
│   │   │   ├── tunnelTerrainCarver.js ← Punches terrain verts at tunnel approaches
│   │   │   ├── waterRenderer.js    ← Water plane polygons
│   │   │   ├── greensRenderer.js   ← Flat green area polygons (parks, grass zones)
│   │   │   ├── barrierRenderer.js  ← OSM barrier walls + physics
│   │   │   ├── crashBarrierRenderer.js ← Jersey barriers on bridge edges
│   │   │   ├── streetlightRenderer.js  ← Pole/arm/lamp/pool meshes + night emissive
│   │   │   ├── railwayRenderer.js  ← Rail line geometry
│   │   │   ├── busStopRenderer.js  ← Shelter + marking + glow meshes
│   │   │   ├── parkingRenderer.js  ← Parking surface + markings
│   │   │   ├── decalRenderer.js    ← Road decals (road markings overlays)
│   │   │   ├── dividerRenderer.js  ← Road divider strips (disabled)
│   │   │   ├── shoulderRenderer.js ← Road shoulder strips (disabled by default)
│   │   │   ├── reflectorRenderer.js ← Cat's-eye road reflectors
│   │   │   ├── roadInfraRenderer.js ← Traffic lights, signs, gantries
│   │   │   ├── propRenderer.js     ← Misc props (dustbins, benches, etc.)
│   │   │   ├── urbanFeatureRenderer.js ← Towers, large urban structures
│   │   │   ├── vendorCartRenderer.js   ← Street vendor carts
│   │   │   └── environmentClusterRenderer.js ← Dense prop clusters
│   │   ├── workers/
│   │   │   ├── workerPool.js       ← Round-robin pool manager (2–4 workers)
│   │   │   ├── tileWorker.js       ← Worker entry: handles PROCESS_BUILDINGS/VEGETATION/GRASS
│   │   │   ├── buildingWorker.js   ← Off-thread building geometry computation
│   │   │   ├── vegetationWorker.js ← Off-thread tree/bush placement
│   │   │   ├── workerGeometry.js   ← Shared geometry helpers (usable in workers)
│   │   │   ├── earcut.js           ← Polygon triangulation (inlined for worker use)
│   │   │   └── meshMaterializer.js ← Reconstructs THREE meshes from worker typed arrays
│   │   └── ui/
│   │       ├── metricsPanel.js     ← Dev overlay: coords, road type, speed, heading
│   │       ├── performancePanel.js ← FPS, draw calls, triangles, tile count, memory
│   │       ├── minimap.js          ← Leaflet 2D minimap with car marker
│   │       ├── speedDisplay.js     ← KM/H + gear + RPM gauge
│   │       ├── streetDisplay.js    ← Current road name banner
│   │       ├── compassBar.js       ← Cardinal direction compass
│   │       ├── speedLines.js       ← Radial speed-line effect on canvas
│   │       ├── radialBlurPass.js   ← Custom THREE.ShaderPass for edge blur at speed
│   │       ├── directionDisplay.js ← Debug heading display
│   │       └── envToggle.js        ← Day/night toggle button + preset applier
│   └── src/assets/car.glb          ← The only 3D model file; all other geometry is procedural
├── backend/
│   ├── server.js                   ← Express: single GET /api/tiles/:tileId endpoint
│   ├── tileBake.js                 ← readTile / readBinaryTile from disk
│   ├── projection.js               ← Same math as frontend projection.js (must stay in sync)
│   ├── worldBuilder/
│   │   ├── buildRegion.js          ← Main pipeline orchestrator
│   │   ├── config.js               ← Region bbox, zoom level, DEM file paths
│   │   ├── convertToBinary.js      ← JSON v5 → binary v6 converter
│   │   ├── terrainBaker.js         ← Pre-computes visual + physics terrain meshes
│   │   ├── roadBaker.js            ← Pre-computes road ribbon geometry
│   │   ├── vegetationBaker.js      ← Pre-computes tree positions
│   │   ├── roads/                  ← Road topology, elevation, graph, ramp resolution
│   │   ├── junctions/              ← Junction classification + gore geometry
│   │   └── terrain/                ← DEM sampling, smoothing, modification
│   └── tiles/delhi/16/{x}/{y}.bin  ← Pre-baked binary tiles (the actual map data)
└── data/                           ← OSM PBF + DEM GeoTIFF sources (not committed to git)
```

---

## Initialization Sequence

(`main.js`, executed once at page load)

```
1. createScene()
   ├── THREE.WebGLRenderer (antialias, SRGBColorSpace, LinearToneMapping 1.25, PCFSoft shadows)
   ├── IcosahedronGeometry sky dome (custom gradient ShaderMaterial, BackSide)
   ├── Procedural clouds (12 Sprite billboards), moon (2 Sprites), stars (1500 Points)
   ├── AmbientLight (0xffe8c8, 0.55) + DirectionalLight sun (0xffd9a0, 1.2)
   ├── FogExp2 (0x9dc2db, 0.007)
   ├── CANNON.World (gravity -9.82, NaiveBroadphase, friction 0.3)
   ├── Fallback floor CANNON.Plane at Y = -50
   ├── worldGroup (THREE.Group, scale.x = -1) added to scene
   └── returns { scene, camera, renderer, world, worldGroup, groundMesh, ... }

2. setRendererAnisotropy() — reads GPU max anisotropy, passes to road/terrain materials

3. initWorkerPool()
   └── Spawns 2–4 tileWorker.js instances (round-robin geometry workers)

4. EffectComposer setup
   └── RenderPass → UnrealBloomPass (half-res) → RadialBlurPass → OutputPass

5. createEnvToggle() — day/night toggle button; applies day preset immediately

6. createDayNight() — only if CONFIG.ENABLE_DAY_NIGHT (off by default)

7. preloadTreeModels() — async GLB load of tree variants (if ENABLE_TREES)

8. loadTile(spawnTx, spawnTy) — fetch spawn tile, extract spawn elevation
   └── setWorldElevationOffset(spawnElev) — normalizes Y so spawn is near 0

9. setOriginOffset(originX, originZ) — SW corner of spawn tile in world coords
   └── worldGroup.position.set(originX, 0, -originZ) — precision anchor

10. createTileManager(...) — the streaming engine

11. tileManager.injectSpawnTile() — first tile built immediately (Phase 1 synchronous)

12. findRoadSpawn() — nearest major road segment at spawn, computes heading

13. createCarDriver() or createFreeCameraController()

14. UI subsystems: streetDisplay, speedDisplay, speedLines, minimap, compassBar, performancePanel

15. animate() — rAF loop starts
```

---

## Game Loop (every frame)

(`main.js:250`, `requestAnimationFrame`)

```
deltaTime = min(50ms, rawDeltaMs / 1000)     // cap prevents catch-up stutter

if carDriver:
    carDriver.update(dt)
        world.step(1/60, min(dt,0.035), 3)   // physics: fixed 60 Hz, max 3 substeps
        controls.getState()                  // progressive keyboard ramp
        physics.applyInputs(state, dt)       // forces, transmission, drift
        model.update(chassisBody, ...)       // sync GLB to physics body
        effects.update(dt, state)            // skid marks, smoke
        sound.update(rpm, throttle, dt, ...) // Web Audio
        carCamera.update(chassisBody, dt, speed)
else:
    freeCameraControls.update(dt)

tileManager.update(viewerWx, viewerWz, { headingDeg })
    ├── LOD visibility updates (throttled >15m movement)
    ├── Physics body add/remove by distance (200m radius)
    └── Enqueue / start missing tile loads (frustum-priority sorted)

updateClouds / updateMoon / updateStars    // parallax follow
timeSystem.update(dt)                      // in-game clock (if ENABLE_DAY_NIGHT)
dayNight.update(dt)                        // (if ENABLE_DAY_NIGHT)

Road query (throttled >10m): queryNearestRoadSegment() → street name
Shadow camera reposition (throttled >5m movement)
updateTrafficLights / updateTowerBeacons / updateGrassWind
radialBlurPass.uniforms.strength = clamp((speed-40)/80, 0, 1)
renderer.info.reset()
composer.render()                          // EffectComposer renders everything
performancePanel.tick()
```

---

## Scene Graph

```
THREE.Scene
├── sky (Mesh — IcosahedronGeometry, custom gradient shader, BackSide, no fog)
├── _cloudSprites[] (Sprite × 12, frustumCulled=false, parallax follow)
├── _moonSprite + _moonGlowSprite (Sprite, frustumCulled=false)
├── _starsMesh (Points — 1500 verts on R=20000 upper hemisphere sphere)
├── ambientLight (AmbientLight)
├── dirLight (DirectionalLight — sun, castShadow)
│   └── dirLight.target (must be in scene; camera follows it each frame)
└── worldGroup (THREE.Group)
    │   scale.x = -1  ← THE MIRROR (see coordinate-systems.md)
    │   position = (originOffsetX, 0, -originOffsetZ)  ← precision anchor
    ├── groundMesh (PlaneGeometry 2000×2000 green plane; follows car for infinite-ground illusion)
    └── [per-tile meshes, added and removed dynamically by tileManager]:
        ├── terrainMesh (PlaneGeometry 32×32 with height-displaced verts per tile)
        ├── roadMeshes[] (merged ribbon geometry per tile)
        ├── buildingMeshes[] (extruded footprints + roofs)
        ├── lodBuildingMesh (simplified boxes, visible 110–230m)
        ├── vegetationMeshes[] (InstancedMesh trees + BatchedMesh + billboards + grass)
        ├── waterMesh, greenMeshes[], railwayMeshes[]
        ├── tunnelMeshGroup, canopyMeshGroup
        ├── streetlight{Pole,Arm,Lamp,Pool,Shadow,Wire}Mesh
        ├── barrierMeshes[], crashBarrierMesh, reflectorGroup
        ├── busStopMeshes[], urbanFeatureMeshes[], vendorCartMeshes[]
        ├── roadInfraMeshes[], trafficLightMesh, propMesh, clusterMeshes[]
        └── decalMeshes[]
```

---

## Worker Architecture

Two separate worker systems with different purposes:

### 1. Tile Parser Worker (`mapLoader.js` → `tileParserWorker.js`)
- **Single worker** (not pooled)
- Handles: network fetch, binary v6 / JSON v5 parsing, IndexedDB cache (7-day TTL)
- One tile at a time (serial); slow network stalls the queue
- Message protocol: `{ url, originX, originY, tileVersion, id }` → `{ id, result }` or `{ id, error }`
- IndexedDB key = URL with `vx`/`vz` direction params stripped

### 2. Geometry Worker Pool (`workerPool.js` → `tileWorker.js`)
- **2–4 workers** (`min(4, max(2, hardwareConcurrency - 1))`)
- Round-robin load balancing; per-tile cancellation via CANCEL broadcast
- Handles: building geometry, vegetation placement, grass instance computation
- Uses Transferable ArrayBuffers for elevation data to avoid copying
- Message types: `PROCESS_BUILDINGS`, `PROCESS_VEGETATION`, `PROCESS_GRASS`, `CANCEL`
- Returns typed arrays (Float32Array positions, normals, UVs, Uint32 indices)
- `meshMaterializer.js` reconstructs THREE objects from the typed arrays on the main thread

### Worker limitations
Workers cannot use ES module imports in all browsers — geometry code is either copied/inlined or uses `importScripts`. Workers cannot create CANNON or THREE objects; those are always constructed on the main thread after receiving typed arrays from workers.

---

## ASCII Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         BROWSER (main thread)                       │
│                                                                      │
│  main.js (rAF 60fps)                                                │
│  ┌──────────────────┐   ┌────────────────────┐   ┌───────────────┐ │
│  │   carDriver      │   │   tileManager      │   │ EffectComposer│ │
│  │ ├─carPhysics     │   │ ├─tileCache (Map)  │   │ ├─RenderPass  │ │
│  │ │  RaycastVehicle│   │ ├─LOD system       │   │ ├─BloomPass   │ │
│  │ │  NaiveBP world │   │ ├─4-phase builder  │   │ ├─RadialBlur  │ │
│  │ ├─carControls    │   │ │  Phase1: terrain  │   │ └─OutputPass  │ │
│  │ ├─carCamera      │   │ │  Phase2: bldgs    │   └───────────────┘ │
│  │ ├─carModel (GLB) │   │ │  Phase3: trees    │                     │
│  │ └─carEffects     │   │ │  Phase4: grass+   │                     │
│  └──────────────────┘   │ ├─physics setup     │                     │
│                          │ └─body add/remove   │                     │
│                          └────────────────────┘                     │
│                                    │ needs tile                      │
│                                    ▼                                 │
│                          mapLoader.js                                │
│                                    │ postMessage                     │
│                         ┌──────────┴──────────┐                     │
│                         │  tileParserWorker   │ ← single worker     │
│                         │  (fetch + parse +   │                     │
│                         │   IndexedDB cache)  │                     │
│                         └─────────────────────┘                     │
│                                                                      │
│  workerPool.js (2–4 workers, round-robin)                           │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐                    │
│  │ tileWorker │  │ tileWorker │  │ tileWorker │ ← bldgs/veg/grass  │
│  └────────────┘  └────────────┘  └────────────┘                    │
│                                                                      │
│  THREE.Scene (worldGroup.scale.x = -1)    CANNON.World              │
│  ├─terrain meshes (32×32 grid/tile)       ├─Trimesh (terrain)       │
│  ├─road ribbons (merged by material)      ├─Box shapes (decks)      │
│  ├─buildings (extruded footprints)        ├─Box shapes (tunnel walls)│
│  ├─InstancedMesh trees / grass            ├─RaycastVehicle chassis  │
│  └─[20+ renderer outputs]                 └─fallback floor Y=-50    │
└─────────────────────────────────────────────────────────────────────┘
                                │ GET /api/tiles/:tileId
┌─────────────────────────────────────────────────────────────────────┐
│  backend (Express :4041)                                            │
│  server.js → tileBake.js → tiles/delhi/16/{x}/{y}.bin              │
│  (dumb static file server — zero runtime processing)               │
└─────────────────────────────────────────────────────────────────────┘
```
