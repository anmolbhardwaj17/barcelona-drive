# CONFIG Reference

All flags live in `frontend/src/config.js` and are exported as the `CONFIG` object. Every subsystem imports CONFIG directly.

**Status key:**
- `LIVE` — wired end-to-end and works
- `LIVE-PARTIAL` — the flag is read but only some effects are wired
- `DEAD` — in CONFIG but the consuming code is disabled, removed, or never reads it
- `BROKEN` — flag exists but the feature it guards has a known bug

---

## Feature Toggles

| Flag | Default | Status | Effect |
|---|---|---|---|
| `ROAD_ONLY_DEBUG` | `false` | LIVE | When true, renders only roads. Skips buildings, trees, grass, greens, water. All `skipNonRoad` checks in tileManager read this. |
| `ENABLE_CAR` | `true` (currently `false` — drone/dev mode) | LIVE | `true` = driving mode with RaycastVehicle + chase camera. `false` = free orbit camera only. |
| `ENABLE_BUILDINGS` | `true` | LIVE | Guards all building mesh creation in Phase 2. |
| `ENABLE_SIDEWALKS` | `false` | DEAD | Referenced in road-renderer logic but the sidewalk geometry path is disabled. Setting `true` has no visible effect. |
| `ENABLE_TRAFFIC_LIGHTS` | `false` | LIVE | Guards `renderTrafficLights()` in Phase 4 and `updateTrafficLights()` in the game loop. |
| `ENABLE_TREES` | `true` | LIVE | Guards `preloadTreeModels()` and `workerProcessVegetation()` in Phase 3. |
| `ENABLE_ROAD_EDGE_DETAIL` | `true` | LIVE-PARTIAL | Read by `roadRenderer.js` to add edge strip geometry. |
| `ENABLE_PROCEDURAL_INFILL` | `false` | DEAD | Flag is read in tileManager but the procedural infill module is not called anywhere in the current codebase. Setting `true` has no effect. |
| `ENABLE_DAY_NIGHT` | `false` | LIVE | Enables full 24h cycle (sun movement, sky colors, streetlamp emissive switching). Requires `createDayNight()` and `timeSystem.update()`. Off by default — expensive and visually distracting during development. |
| `ENABLE_FOG` | `true` (currently `false` — disabled for development) | LIVE | `scene.fog = new THREE.FogExp2(...)`. When false, no fog is created. Re-enable before shipping — fog masks LOD transitions and tunnel/ocean edge artifacts. |
| `ENABLE_SHADOWS` | `true` | LIVE | Passes to `renderer.shadowMap.enabled` and `dirLight.castShadow`. |
| `ENABLE_RAILWAYS` | `false` | LIVE | Guards `createRailwayMeshes()` in Phase 2. |
| `ENABLE_TERRAIN` | `true` | LIVE | Guards `buildTerrainMesh()` and `createTerrainTrimesh()` in Phase 1. Without terrain, there is no physics ground — the car falls through. |
| `ENABLE_PARKING` | `false` | LIVE | Guards `buildParkingMeshes()` in Phase 4. |
| `ENABLE_DECALS` | `true` | LIVE | Guards `buildDecalMeshes()` in Phase 4. |
| `ENABLE_BARRIERS` | `true` | LIVE | Guards barrier mesh + collider creation in Phase 4. |
| `ENABLE_CRASH_BARRIERS` | `true` | LIVE | Guards crash barrier (jersey barrier) mesh + colliders in Phase 4. |
| `ENABLE_BUS_STOPS` | `true` | LIVE | Guards `buildBusStopMeshes()` in Phase 4. |
| `ENABLE_DIVIDERS` | `true` | LIVE-PARTIAL | Flag exists and is checked, but the `buildDividers` import is commented out in `tileManager.js`. Divider meshes are not built. |
| `ENABLE_STREETLIGHTS` | `true` | LIVE | Guards `buildStreetlights()` in Phase 4. |
| `ENABLE_ROAD_SHOULDERS` | `false` | LIVE | Guards `buildShoulderMesh()` in Phase 4. |
| `ENABLE_ZONE_VEGETATION` | `false` | DEAD | Zone vegetation is now always included inside the vegetation worker result (not separately gated by this flag at runtime). Setting true/false has no effect. |
| `ENABLE_WATER` | `true` | LIVE | Guards `renderWater()` in Phase 4 and water polygon filtering for terrain. |
| `RENDER_COASTLINE_AS_POLYGONS` | `false` | LIVE | When `false`: `type=coastline` water features are skipped in `waterRenderer.js` — they are open polylines in OSM; `THREE.Shape.closePath()` would create inland-extending filled triangles that cover tunnel approaches. Set `true` only when proper coastline assembly (OSM right-hand rule) is implemented. See gotchas.md G-13. |
| `RENDER_OPEN_WATER_AS_POLYGONS` | `false` | LIVE | When `false`: any `tileData.water[]` feature whose polygon has first ≠ last point (gap ≥ 1m) is skipped. Catches streams, canals, rivers whose `bufferPolyline()` ribbons produce self-intersecting polygons with spurious triangle lobes at bends. Closed `natural=water` polygons (gap < 1m) are unaffected. Marina/dock features in `tileData.marinas[]` bypass this filter entirely. Set `true` only after `bufferPolyline` is replaced with a proper offset-polygon algorithm + re-bake. See gotchas.md G-14. |
| `ENABLE_URBAN_FEATURES` | `true` | LIVE | Guards `buildUrbanFeatureMeshes()` in Phase 4. |
| `ENABLE_VENDOR_CARTS` | `true` | LIVE | Guards `buildVendorCartMeshes()` in Phase 4. |
| `ENABLE_ROAD_INFRA` | `true` | LIVE | Guards `buildRoadInfrastructure()` (signs, gantries) and `buildReflectors()` in Phase 4. Also gates `updateTrafficLights()` and `updateTowerBeacons()` in the game loop. |
| `ENABLE_TUNNELS` | `true` | LIVE | Guards tunnel terrain carving, tunnel enclosure meshes, tunnel wall colliders, and `registerTunnelZones()` in Phase 1. Disabling this will cause cars to drive into solid terrain where tunnels should be. |
| `ENABLE_CAR_LIGHTS` | `true` | LIVE | Guards SpotLight headlights and brake emissive material on car. |
| `ENABLE_SKID_MARKS` | `true` | LIVE | Guards skid mark decal InstancedMesh in `carEffects.js`. |
| `ENABLE_TIRE_SMOKE` | `false` | LIVE | Guards tire smoke sprite InstancedMesh in `carEffects.js`. Off for performance. |
| `ENABLE_PERFORMANCE_PANEL` | `true` | LIVE | Creates and updates the debug performance overlay. |

---

## Car Physics Constants (Config Values — DEAD for actual physics)

**These are in CONFIG but are NOT read by `carPhysics.js`.** The physics file defines its own internal constants. These CONFIG values are effectively documentation / future refactor targets.

| Flag | Config Value | Actual Physics Value |
|---|---|---|
| `CAR_CHASSIS_MASS` | 1200 kg | **1600 kg** (in carPhysics.js) |
| `SUSPENSION_STIFFNESS` | 35 N/m | **60 N/m** |
| `SUSPENSION_DAMPING` | 4.4 | **3.2** (rebound) + **4.0** (compression) |
| `SUSPENSION_COMPRESSION` | 2.3 | **4.0** |
| `SUSPENSION_REST_LENGTH` | 0.35 m | **0.30 m** |
| `SUSPENSION_MAX_TRAVEL` | 0.4 m | **0.25 m** |
| `MAX_ENGINE_FORCE` | 4000 N | **4800 N** (BASE_ENGINE_FORCE) |
| `MAX_BRAKE_FORCE` | 80 N | **250 N** |
| `MAX_STEER_ANGLE` | 0.5 rad | **0.38 rad** (MAX_STEER) |

To change physics: edit constants directly in `frontend/src/car/carPhysics.js`.

---

## Terrain and Elevation

| Flag | Default | Status | Effect |
|---|---|---|---|
| `ENABLE_TERRAIN` | `true` | LIVE | See above |
| `terrainSamplingMode` | `'bilinear'` | LIVE | Passed to terrain renderer. `'bilinear'` or `'bicubic'`. Should match backend terrain sampling if re-baking. |
| `TERRAIN_GRID_SIZE` | `32` | LIVE | Visual terrain mesh resolution (quads per axis). Higher = smoother hills, more triangles. |
| `TERRAIN_MAX_GRID` | `32` | LIVE | Cap on terrain grid (same as TERRAIN_GRID_SIZE currently). |
| `ELEVATION_VERTICAL_EXAGGERATION` | `1` | LIVE | Multiplier on terrain height after subtracting offset. `1` = real scale. Changing to `2` doubles hill heights. Must match physics and road rendering. |
| `BAKED_ROAD_ELEVATION_IS_RAW` | `true` | LIVE — **critical** | When `true`, road point elevations are raw DEM meters; frontend subtracts worldElevationOffset. When `false`, already normalized. Must match bake pipeline output. Getting this wrong makes all roads float or sink. |

---

## LOD and Performance

| Flag | Default | Status | Effect |
|---|---|---|---|
| `MAX_TREES_PER_TILE` | 3000 | LIVE | Upper limit on tree instances generated per tile. |
| `TREE_FULL_DISTANCE` | 100m | LIVE | Full instance count shown within this distance of tile edge. |
| `TREE_MAX_DISTANCE` | 160m | LIVE | 3D trees fully hidden beyond this. Billboards take over. |
| `BUILDING_MAX_DISTANCE` | 180m | LIVE | Full building meshes hidden beyond this. |
| `BUILDING_LOD_START` | 110m | LIVE | LOD simplified boxes start appearing at this distance. |
| `BUILDING_LOD_END` | 230m | LIVE | LOD simplified boxes hidden beyond this. |
| `MAX_GRASS_PER_TILE` | 15000 | LIVE | Max grass blade instances per tile. |
| `GRASS_MAX_DISTANCE` | 60m | LIVE | Grass hidden beyond this from tile nearest edge. |
| `MAX_DYNAMIC_STREETLIGHTS` | 8 | DEAD | Was used for dynamic PointLights per streetlamp. Those were removed; emissive material is used instead. |
| `PERF_WARN_TRIANGLES` | 400000 | LIVE | Performance panel highlights triangle count in red when exceeded. |
| `PERF_WARN_FPS` | 40 | LIVE | Performance panel highlights FPS in red when below this. |

---

## Debug Flags

| Flag | Default | Status | Effect |
|---|---|---|---|
| `DEBUG_PHYSICS_DECKS` | `false` | LIVE | Wire-frame boxes for road deck colliders and heightfield bounds. |
| `DEBUG_COLLIDERS` | `false` | LIVE | Wire-frame for ALL physics bodies in world. |
| `DEBUG_TREE_SOURCES` | `false` | LIVE | Lines from each tree to its source road segment. |
| `DEBUG_ROAD_WIREFRAMES` | `false` | LIVE | Colored wire-frame overlaid on road meshes (color = layer classification). |
| `SHADOW_MAP_SIZE` | 1024 | LIVE | Shadow map resolution. Actual size is `max(2048, CONFIG.SHADOW_MAP_SIZE)` — the min clamp in scene.js means values below 2048 are ignored. |

---

## Shadow Map Size Note

In `scene.js`:
```js
const shadowSize = Math.max(2048, CONFIG.SHADOW_MAP_SIZE ?? 2048);
```
The `max(2048, ...)` clamp means `SHADOW_MAP_SIZE: 1024` in CONFIG is **ignored** and 2048 is always used. This is a bug or intentional floor. If you want a smaller shadow map for performance, you need to change the `max(2048, ...)` clamp in `scene.js` as well.
