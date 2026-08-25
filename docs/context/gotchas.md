# Gotchas — Invariants and Landmines

Every item here describes something that has no compile-time or runtime error to warn you, will silently produce wrong behavior, and will cost significant debugging time if violated.

---

## G-01: The X-Mirror — Every Physics Coordinate Negates X

**What it is:**
`worldGroup.scale.x = -1` mirrors the rendered world. Physics bodies in `CANNON.World` do not go through `worldGroup`, so every physics position must manually apply the negation:
```js
physicsX = -(worldX - originOffset.x)
physicsZ =   worldZ - originOffset.z
```

**Why it exists:**
Reconciles the Mercator coordinate system (where +X = east maps to "left" on screen with standard camera orientation) with Three.js space. The mirror was chosen over a coordinate remap to avoid touching all renderer code.

**What breaks if ignored:**
- Physics bodies placed at the mirrored position (symmetrically wrong across world center)
- Car spawns on opposite side of road
- Bridge deck colliders misplaced → car drives through bridges
- Tree colliders in wrong location → invisible walls or missed collisions
- Any `CANNON.Box` shape you add without negating X will be silently in the wrong place

**How to check:**
Always grep for `physicsOrigin` usage when creating bodies. The pattern must be:
```js
const px = -(p.x - physicsOrigin.x);
const pz =   p.y - physicsOrigin.z;   // p.y IS world Z — see G-02
```

**Side effect on rendering:**
Face winding is reversed inside `worldGroup`. Any mesh needing visible back faces must use `THREE.DoubleSide`.

---

## G-02: Road Point `.y` Is World Z, Not Vertical

**What it is:**
Road and building points in tile data have the shape `{ x: worldX, y: worldZ, elevation: meters }`. The `.y` field is the horizontal Z coordinate (north), not the vertical Y.

**Why it exists:**
The binary format stores triples as `[mercatorX, elevationMeters, mercatorZ]`. The parser maps them as:
```js
{ x: f32[j] - ox, y: f32[j+2] - oy, elevation: f32[j+1] }
```
`f32[j+2]` (Mercator Z/northing) goes into `.y`. This is historical and would be a large refactor to change.

**What breaks if ignored:**
- Passing `point.y` as a Three.js Y (vertical) → geometry underground or floating
- Passing `point.elevation` as horizontal Z → geometry at wrong map location

**The correct mapping to Three.js:**
```js
vertex.x = roadPoint.x;          // world X  (mirrored by worldGroup)
vertex.y = roadPoint.elevation;  // actual height in meters
vertex.z = roadPoint.y;          // world Z stored in .y field
```

---

## G-03: `carPhysics.js` Ignores CONFIG Vehicle Parameters

**What it is:**
`config.js` contains `CAR_CHASSIS_MASS`, `MAX_ENGINE_FORCE`, `SUSPENSION_STIFFNESS`, etc. These are not read by `carPhysics.js`. The physics file defines its own constants (`CHASSIS_MASS = 1600`, `BASE_ENGINE_FORCE = 4800`, `SUSP_STIFFNESS = 60`, etc.) that override CONFIG.

**Why it exists:**
The physics was tuned independently of CONFIG, and the CONFIG constants were not updated to match. Both sets exist in parallel and can diverge.

**What breaks if ignored:**
- You change `CAR_CHASSIS_MASS: 1200` in CONFIG expecting the car to feel lighter — nothing changes
- You expect CONFIG to be the single source of truth for vehicle tuning — it is not

**Fix protocol:**
To tune the vehicle, edit constants in `carPhysics.js` directly. Consider also updating CONFIG to match if you want CONFIG to serve as documentation (though currently it does not drive behavior).

---

## G-04: NaiveBroadphase Cannot Be Changed to SAPBroadphase

**What it is:**
`CANNON.World` uses `NaiveBroadphase` (O(n²) collision detection). `SAPBroadphase` (O(n log n)) would be faster but cannot be used.

**Why it exists:**
`CANNON.Trimesh` bodies (used for terrain heightfields) produce infinite AABBs in cannon-es. `SAPBroadphase` sorts bodies on an axis — infinite AABBs corrupt the sorted order, causing collisions to be missed or phantom collisions to trigger.

**What breaks if you switch:**
- Random collisions between objects that aren't touching
- Car passes through terrain in some tiles
- Non-deterministic physics behavior

**Current mitigation:**
Physics bodies are removed from the world when their tile is > 200m away (`physActive` check in LOD loop). This keeps the active body count manageable for O(n²).

**Do not "fix" this without resolving the Trimesh AABB issue first.**

---

## G-05: `BAKED_ROAD_ELEVATION_IS_RAW` Must Match Bake Pipeline Output

**What it is:**
`CONFIG.BAKED_ROAD_ELEVATION_IS_RAW: true` tells the frontend that road point elevations are raw DEM meters (absolute altitude). The frontend subtracts `worldElevationOffset` at runtime:
```js
normalizedY = (rawElevation - worldElevationOffset) * vertExag
```

**What breaks if the pipeline changes:**
If `buildRegion.js` is changed to pre-subtract the offset during baking (storing `rawElev - spawnElev`), the frontend will subtract it again and all roads will be underground.

If the pipeline stores normalized values and `BAKED_ROAD_ELEVATION_IS_RAW` stays `true`, roads float above terrain by the spawn elevation (typically 200–240m for Delhi).

**Warning sign:**
Roads visually floating or sinking by a large constant amount (tens of meters) usually means this flag is wrong.

**Before re-baking:**
Verify whether the new pipeline outputs raw or normalized elevations, then set the flag accordingly.

---

## G-06: Binary Tiles Have NaN Water — Need Re-Bake

**What it is:**
The current baked binary tiles contain some water polygon vertices that evaluate to `NaN`. The frontend's `meshHasNaN()` guard detects these and skips adding the mesh to the scene, so water appears missing in some tiles rather than crashing.

**Why it exists:**
A bug in the water polygon normalization (`waterNormalize.js` or `pbfWater.js`) introduced NaN coordinates. The tiles have not been re-baked since the bug was identified.

**What breaks:**
- Some rivers/lakes appear completely absent
- `safeSceneAdd()` silently discards the water mesh; no console error visible unless `DEBUG_COLLIDERS` catches it

**Fix:**
1. Identify and fix the NaN source in `waterNormalize.js` or `pbfWater.js`
2. Re-bake tiles with `npm run build:region`
3. Verify water appears in affected tiles

---

## G-07: Single Tile Parser Worker Is a Serial Bottleneck

**What it is:**
`tileParserWorker.js` is a single Web Worker. All tile network fetches and parsing are serialized through this one worker. If a fetch takes 200ms (large tile, slow server), the next tile in the queue cannot start until this one finishes.

**Why it exists:**
Simplicity. The tile parsing worker was not pooled when the binary format was introduced.

**What breaks if load order matters:**
- Tiles stream in slower than they could if fetching were parallelized
- Tiles in the priority queue cannot be re-ordered mid-flight for the parsing stage

**Mitigation:**
The geometry worker pool (2–4 workers) handles the CPU-heavy phase after parsing, so the parser worker's serial nature only affects network-fetch latency, not geometry computation.

**Do not "fix" this by creating multiple parser worker instances without verifying IndexedDB handles concurrent access correctly** (it uses transactions; should be safe, but test it).

---

## G-08: Backend CORS Is An Allowlist — An Unlisted Frontend Port Gets Nothing

**What it is:**
`backend/server.js` answers CORS from `ALLOWED_ORIGINS`, not a wildcard:
```js
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:4040,http://localhost:4044')
  .split(',').map((s) => s.trim()).filter(Boolean);
```
An origin that is not on the list gets **no** `Access-Control-Allow-Origin` header at all.

**What breaks if ignored:**
- Serve the frontend on an unlisted port → every tile fetch blocked; the game loads but the world stays empty
- Deploy to a non-localhost URL without setting `ALLOWED_ORIGINS` → same
- **It does not look like a CORS problem.** The console shows `[TileLoader] Fetch failed: Failed to fetch`
  and `net::ERR_FAILED 200 (OK)` — a 200 the browser then refuses to hand to JS

**The two local ports both matter:** 4040 is `npm run dev`; **4044 is `npm run preview`**, the production
build the v3 verification drives run against. Both are in the default list — keep it that way.

**Fix:**
Add the origin to the default list in `server.js`, or start the backend with
`ALLOWED_ORIGINS=https://your.app npm start` (comma-separated for several).

---

## G-09: `worldElevationOffset` Must Be Set Before Tile Geometry Builds

**What it is:**
`worldElevationOffset` (from `elevationOffset.js`) is a global singleton. It is read by `toNormalizedRoadY()`, `terrainRenderer.js`, and the physics trimesh builder. It is set asynchronously from the spawn tile elevation fetch.

**What breaks if geometry builds before offset is set:**
- All road and terrain geometry placed at raw DEM elevation (200–240m above the origin)
- The car spawns 200m in the air
- Physics colliders are at the wrong Y

**How it's guarded:**
`main.js` uses `spawnTileReady.finally(...)` — `createTileManager()` and all geometry building only start after `setWorldElevationOffset()` has been called. Do not short-circuit this await or move geometry creation before `spawnTileReady`.

---

## G-10: `worldGroup.position` Must Be Set Before Tiles Are Added

**What it is:**
`worldGroup.position.set(originOffsetX, 0, -originOffsetZ)` anchors the tile coordinate system near the floating-point origin. All tile mesh positions are in world-space relative to `originOffset`. If `worldGroup` is not positioned first, meshes will be placed at raw world Mercator coordinates (~8.6M meters), causing float precision loss.

**What breaks:**
- Geometry jitter at scale (vertex positions lose sub-meter precision at large distances)
- All tile meshes appear in completely the wrong place

**How it's guarded:**
`main.js` calls `setOriginOffset()` and `worldGroup.position.set()` inside `spawnTileReady.finally()` before calling `createTileManager()`. Do not reorder these.

---

## G-11: `dirLight.target` Must Be in the Scene

**What it is:**
Three.js requires `dirLight.target` to be explicitly added to the scene for the directional light's shadow camera to follow the target's position. Without this, `dirLight.target.updateMatrixWorld()` has no effect.

**What breaks:**
- Shadow camera stays at the origin; shadows appear only near world center
- Moving the player has no effect on shadow coverage

**Fix in scene.js:**
```js
scene.add(dirLight.target);   // already done — do not remove this line
```

---

## G-12: Terrain Winding Order Is Reversed Vs Visual Mesh

**What it is:**
The physics terrain trimesh (`createTerrainTrimesh`) reverses triangle winding compared to the visual terrain mesh:
```js
// visual:  indices.push(a, b, c1);  indices.push(b, d, c1);
// physics: indices.push(a, b, c1);  (same) BUT X negation = reversed handedness
```
The X negation applied to physics vertices flips the handedness of the coordinate system, which reverses face normals. `RaycastVehicle` wheel rays use `skipBackfaces: true`, so if normals point downward, the rays pass straight through the terrain.

**What breaks if winding is "corrected" to match visual:**
- Wheel rays point downward → hit back face → miss → car falls through terrain

**Do not "fix" the winding mismatch** without understanding that the X negation already accounts for it.

---

## G-13: `THREE.Shape.closePath()` Creates Inland Water Triangles from Coastline Polylines

**What it is:**
`natural=coastline` ways in OSM are **open polylines** — they define the land/sea boundary but are not closed polygons. `waterRenderer.js` builds water meshes by calling `THREE.Shape.closePath()` after tracing the polygon points. For a closed ring (lake, marina basin) this is harmless. For an open coastline way, `closePath()` draws a straight line from the last coastal point back to the first, cutting across inland territory and creating a filled triangle that covers land.

**Why it matters:**
This triangle covers road surfaces, building footprints, and crucially tunnel approaches near the coast. Confirmed on tile `16_33167_24479` (Barceloneta): coastline polygon `500581857` extends 961m inland, covering the Ronda Litoral / Port Olímpic tunnel approach ramps.

**Current fix:**
`CONFIG.RENDER_COASTLINE_AS_POLYGONS: false` (default) — `waterRenderer.js` filters out `type=coastline` features before rendering. Set to `true` only when proper OSM coastline assembly is implemented.

**What breaks if you re-enable it without fixing assembly:**
- Blue water visible inside all coastal tunnel approaches (Ronda Litoral, Port Vell, etc.)
- Water appearing over land areas up to 1km from the actual shoreline

**The right fix (not yet implemented):**
Use the OSM right-hand rule: `natural=coastline` ways have **water on the RIGHT side of travel direction**. Proper rendering assembles all coastline ways in a tile into a closed sea polygon by tracing the coastline and closing via the tile boundary on the seaward side. See `docs/context/roadmap.md` for the deferred coastline work item.

---

## G-14: `bufferPolyline` Self-Intersections Produce Spurious Filled Triangles

**What it is:**
`waterNormalize.js:bufferPolyline()` converts linear waterways (stream, canal, river) into ribbon polygons using simple per-vertex normal averaging. At sharp bends in the centerline, the left and right offset paths cross each other, creating a self-intersecting polygon. `THREE.ShapeGeometry` fills the enclosed area of each crossing as an additional triangle lobe.

**Visual symptom:**
Wedge or triangular blue patches at the coast where streams converge before meeting the sea. Barcelona's drainage channels flow from hills to port; each sharp bend produces 1–3 triangle lobes. Multiple converging streams create a fan/wedge cluster.

**Confirmed from tile inspection:**
- 21 stream features (all open-polyline, bboxes 5–6 km, area ≈ 0.04 km²)
- 9 canal features (all open-polyline, bboxes 200–280 m)
- Closure gap = buffer width (stream: 5m, canal: 10m) — `bufferPolyline` runs but self-intersects at bends

**Current workaround:**
`CONFIG.RENDER_OPEN_WATER_AS_POLYGONS: false` — `waterRenderer.js` skips any `tileData.water[]` feature whose first and last polygon points are ≥ 1m apart. Streams and canals are hidden. Closed `natural=water` polygons (gap < 1m) render normally. Marina/dock polygons in `tileData.marinas[]` bypass this filter entirely (separate code path).

**Correct fix (deferred to next re-bake):**
Replace `bufferPolyline()` in `waterNormalize.js` with a proper offset-polygon algorithm using round joins or miter-limit joins at bends. See `roadmap.md` — "Fix bufferPolyline self-intersections."

---

## G-19: Altitude-Aware LOD — Scale ALL Thresholds or Introduce Invisible Bands

**What it is:**
`tileManager.js` has four building-visibility thresholds: `bldgMaxDist` (detail buildings), `bldgDetailDist` (sub-detail), `lodStart` (LOD box starts), `lodEnd` (LOD box ends). All four are used in the same LOD update block. Scaling only some of them creates invisible bands where neither detail nor LOD shows.

**The dead-zone failure mode:**
If only `lodStart` and `lodEnd` are scaled by an altitude multiplier (as might seem intuitive — "scale the LOD range"):
- `bldgMaxDist` stays at 180m — detail hidden beyond 180m
- `effectiveLodStart` at multiplier 2.9 = 319m — LOD box only shows beyond 319m when detail isn't loaded

Result: from 180m to 319m, **both detail and LOD are hidden** — buildings are completely invisible in this band. The fix makes things worse than doing nothing.

**The rule:** Scale ALL four thresholds with the same multiplier, or scale none:
```js
const bldgMaxDist    = CONFIG.BUILDING_MAX_DISTANCE    * altMult;  // must scale
const bldgDetailDist = 120                             * altMult;  // must scale
const lodStart       = CONFIG.BUILDING_LOD_START       * altMult;  // must scale
const lodEnd         = CONFIG.BUILDING_LOD_END         * altMult;  // must scale
```

**Current implementation (tileManager.js lines 1843–1844, 1974–1977):**
```js
const _cameraY = camera?.position.y ?? 0;
const altMult  = Math.max(1, Math.min(4, 1 + (_cameraY - 5) / 50));
// ground driving (cameraY ≤ 5m): altMult = 1 — existing behaviour preserved exactly
// cameraY = 55m:  altMult ≈ 2.0
// cameraY = 100m: altMult ≈ 2.9
// cameraY ≥ 205m: altMult = 4.0 (cap)
```

---

## G-20: IRC 35 → Norma 8.2-IC Migration — Two Separate Color Systems in roadRenderer.js

**What it is:**
Road marking colors exist in two places in `roadRenderer.js` and only one actually controls what renders.

**Active path** (vertex colors baked per geometry — this is what you see):
- `roadRenderer.js:~1025` — `const whiteColor = new THREE.Color(BCN_COLORS.PAINT_WHITE)` — used for white markings
- `roadRenderer.js:~1026` — `const yellowColor` — used for "yellow" (all white in Norma 8.2-IC)
- These are set as vertex color attributes on each geometry, merged into `_mergedMarkingMaterial` (vertex colors = true)

**Legacy/inert path** (singleton materials, currently not called by `buildRoadMarkings`):
- `roadRenderer.js:~780` — `whiteLineMaterial` singleton — `getWhiteLineMaterial()` is defined but not called in the active merge path
- `roadRenderer.js:~789` — `yellowLineMaterial` singleton — same

If you change the color in the legacy path but not the active path, nothing visually changes. Always verify you're editing lines ~1025-1026 for road marking color.

**Also:** `yellowMarkingsMesh` in the `renderTileRoads` return is always null — all markings (white and "yellow") are merged into `whiteMarkingsMesh` with vertex colors. The yellow slot is dead.

**Why it happened:** The renderer was refactored from per-material to vertex-color-merged approach. The legacy material singletons were not removed. Both were updated to `BCN_COLORS.PAINT_WHITE` in Phase 1 for consistency, but only the active path matters.

**Don't re-add `getWhiteLineMaterial` calls** in new marking code — use the vertex color approach and `_mergedMarkingMaterial`.

---

---

## G-21: Phase 2 Road Data — 5-Gate Pipeline, Any Broken Gate = Always Null

**What it is:**
Phase 2 emits six OSM tags into the tile road payload (oneway, lanes, sidewalk, cycleway, surface, maxspeed). Each field must pass five sequential gates before reaching the renderer. If any gate is broken, the field is silently null everywhere downstream.

**The 5 gates (check in order when a field is missing):**
1. `pbfHighways.js:17` KEEP_TAGS — tag must be listed, or the OSM value is silently dropped during PBF parsing
2. `buildRegion.js:1025` road payload map — field must be explicitly emitted in `tileRoadsFinal.map()`
3. `convertToBinary.js:177-186` — field must be conditionally written to the binary header JSON
4. `tileParserWorker.js:readRoads` — field must be conditionally read back from the binary header
5. `roadRenderer.js` / consumers — field must be used where needed

**In Phase 2:** Gates 3 and 4 were pre-built. Gates 1 and 2 had missing fields (4 tags absent from KEEP_TAGS, all 6 absent from the payload map) — this was the root cause of all six fields being null in pre-Phase-2 tiles.

**Diagnostic:** After a re-bake, spot-check a tile with the verification script. If `oneway` is null on roads that should be one-way, start at Gate 1. Work downstream.

**Re-bake required:** Gates 1 and 2 are bake-time. Fixing them in code has NO effect on tiles already on disk. Must re-bake before the renderer sees real data.

---

---

## G-22: Y Stacking for Sidewalk / Curb / Bike Lane — Polygon Offset Rules

**Layer order above terrain (Phase 3):**
```
Terrain         Y = ground elevation (base)
Road asphalt    Y = ground + ROAD_OFFSET + ROAD_VISUAL_ABOVE_TERRAIN (~0.07m total)
Bike lane       Y = road + 0.02m   (slight raise; green paint above asphalt)
Crosswalk       Y = road + 0.04m   (above lane lines at 0.03m; at road level)
One-way arrow   Y = road + 0.04m   (same as crosswalk)
Curb top face   Y = road + CURB_HEIGHT (0.12m)
Sidewalk        Y = road + CURB_HEIGHT (0.12m — same level as curb top)
```

**Z-fighting prevention:**
- Bike lane material: `polygonOffsetFactor: -2, polygonOffsetUnits: -2` (above asphalt)
- Sidewalk material: `polygonOffsetFactor: -1, polygonOffsetUnits: -1` (above terrain at distance)
- Curb: no polygon offset needed (sits at correct Y, not coplanar with anything)

**Do not change Y values without updating all three systems together** (roadRenderer physics coordinates are separate, but visual geometry must stay consistent).

---

## G-23: Vertex Budget — 250k Soft / 300k Hard (Phase 3 update)

Soft warning threshold bumped from 150k to 250k. Hard warning added at 300k.

**Why:** Phase 3 adds ~16-20k verts per tile (sidewalks ~9.6k, curbs ~9.6k, bike lanes ~1.8k, pictograms ~0.3k). Dense Eixample tiles were already at 170-230k. With Phase 3, expected range is 185-250k — under the new 250k soft limit.

**Why this is fine:** LOD culling (80m sidewalks, 200m curbs, 120m bike lanes, 50m pictograms) means these vertices are hidden at distance. The combined cost of ALL visible tile vertices at any moment is a small fraction of the total per-tile vertex count. GPU render cost is dominated by visible triangles after LOD, not by total tile vertex count.

**If 300k hard warning fires:** investigate the specific tile. Likely cause: extremely dense road network (service alleys, complex junction geometry) + full sidewalk coverage. Options: reduce sidewalk width (fewer ribbon segments), skip service roads for sidewalk generation.

---

**Do not re-enable `RENDER_OPEN_WATER_AS_POLYGONS`** without first fixing `bufferPolyline` in `waterNormalize.js` and running a full re-bake.

---

## G-18: Assign-Then-Compare-Self in Cached-State Guards (Tautological Early Exit)

**What it is:**
A guard of the form "if state hasn't changed AND precondition, skip expensive work" becomes tautologically true when the cached state is updated to the new value BEFORE the comparison:

```js
currentTx = tx;   // ← assigned here
currentTy = ty;
// ... 26 lines ...
if (tx === currentTx && ty === currentTy && allLoaded) return;  // always true
```

`tx === currentTx` is always true because `currentTx` was just set to `tx`. The tile-position guard is dead code; the effective condition is `if (allLoaded) return`. After initial tile load, every call to `update()` returns immediately, freezing LOD updates, streaming, and visibility decisions.

**Why it's insidious:**
The code reads plausibly — "early exit if we're in the same tile and everything is loaded." The mutation happens 26 lines earlier and is easy to miss in a long function.

**The fix (tileManager.js lines 1686–1715):**
Cache prevTx/prevTy BEFORE the mutation, then compare against the cached values:
```js
const prevTx = currentTx;
const prevTy = currentTy;
currentTx = tx;
currentTy = ty;
// ...
if (tx === prevTx && ty === prevTy && allLoaded) return;  // compares against previous frame
```

**Class of bug:** "Assign-then-compare-self." Any pattern that updates a state variable and immediately compares the new value against the updated variable will be a tautology. Grep for `foo = x; ... if (x === foo)` when reviewing early-exit / cache-invalidation logic.

**Symptoms when present (G-18 tautology):**
- LOD updates freeze after initial tile load — buildings stay at placeholder distance forever
- Tile streaming stops after initial load — no new tiles queue when heading changes
- Vegetation distances don't update — trees stay at whatever count they had on the frame that allLoaded first became true

---

## G-15: `readPolygonFeatures` in tileParserWorker.js Drops the `type` Field

**What it is:**
`tileParserWorker.js:readPolygonFeatures()` is used to parse `tileData.water[]` from the binary tile. It returns `{ id, polygon }` — no `type` field. Compare with `readGreens()` which correctly returns `{ id, polygon, type }`.

**Effect:** Every water feature reaches `waterRenderer.js` with `a.type === undefined`.

- `a.type === 'coastline'` → always false → coastline filter was dead code until fixed
- `a.type !== 'coastline'` → always true → open-polyline filter catches ALL open features (including coastlines) regardless of type
- Per-type log shows `(undefined:N)` instead of `(stream:X canal:Y coastline:Z)`

**Fixed:** Added `type: item.type` to `readPolygonFeatures` return object (one character).

**If you add a new feature type to `tileData.water[]`:** Always check that all fields from the binary header JSON that the renderer needs are preserved in the read function. `readPolygonFeatures` is generic and will not automatically propagate new header fields.

---

## G-16: NaN Elevation Propagates from Baked Grid Through `renderLODBuildings` Into Scene

**What it is:**
When the baked tile elevation grid contains NaN values (G-06 water NaN bug), `fastElevation.js:fastElevationAt()` returns NaN without any guard. `renderLODBuildings` in `buildingRenderer.js` calls `getWorldElevation(cx, cz)` for each building centroid without a `Number.isFinite` check. NaN elevation produces NaN Y positions in every vertex of that building's LOD box. All LOD boxes in a tile share one merged mesh — one NaN centroid poisons the entire mesh's position array.

**Symptoms:**
- `THREE.BufferGeometry.computeBoundingSphere(): Computed radius is NaN` warning
- Fires once per NaN mesh on its first render frame
- Appears as "different UUIDs each frame" because async tile Phase 2 builds complete across many frames, adding new NaN meshes each frame

**Fixed — same pattern applied to all elevation consumers:**
- `buildingRenderer.js:2418` — `Number.isFinite(rawBaseY) ? rawBaseY : 0` for LOD buildings (original Fix A)
- `greensRenderer.js:80-81` — `Number.isFinite(rawY) ? rawY : 0` for green area polygons (confirmed NaN source via diagnostic probes: index 1 = Y coordinate of first vertex)
- `tileManager.js` — all 30 `scene.add()` calls in `processTileData` replaced with `safeSceneAdd(scene, m)`; `meshHasNaN` does full array scan (G-17)

**Pattern to follow for any future renderer that uses elevation:**
```js
const rawY = getElevationAt ? getElevationAt(lat, lon) : 0;
const y = Number.isFinite(rawY) ? rawY : 0;  // guard: NaN propagates from G-06 grid cells
```
The `?? 0` nullish coalescing guard is NOT sufficient — `NaN ?? 0 === NaN`.

---

## G-51: Collision filter masks are a TWO-SIDED contract — change/revert BOTH sides

**What it is:** cannon-es bodies collide only if the handshake passes BOTH ways:
`(A.group & B.mask) !== 0 && (B.group & A.mask) !== 0`. Setting one side's mask is a
*request*; the other side must reciprocate or the pair silently never collides — no error,
no warning, the body just doesn't exist as far as the other is concerned.

**The incident (2026-06-10):** the [[D-16]] physics revert restored the pre-[[G-49]]
chassis mask (`WORLD`) while keeping the trimesh-terrain model whose backstop REQUIRES
`WORLD | TERRAIN`. Runtime state: terrain `group=16, mask=2` (asks for VEHICLE); chassis
`group=2, mask=4` (refuses TERRAIN); `16 & 4 = 0` → every terrain trimesh in the world
collided with NOTHING → off-road free-fall on Montjuïc, while on-road held (road boxes are
hit by wheel rays, a different mechanism). The trimesh itself was verified perfect
(128-grid visual-baked path, correctly placed, correctly X-negated, road-vs-terrain
co-frame gap 0.23 m) — a flawless collider nothing was allowed to touch.

**The rule:** any change or revert that touches a `collisionFilterGroup`/`collisionFilterMask`
must audit BOTH sides of every handshake that group participates in. A fail-fast guard now
enforces the terrain↔vehicle handshake (`assertTerrainVehicleHandshake` in
`collisionGroups.js`, called from `createTerrainTrimesh` and chassis creation) — a future
one-sided revert THROWS at startup instead of silently producing fall-through.

---

## G-50: Tunnel Ramp Classification — Three Cases, One Deferred

`RampResolver.js resolveRamps()` now handles tunnel roads in three cases:

- **Case A (mid-tunnel):** Both endpoints connect only to other tunnels → `isRamp=false`, flat at `baseHeight`. Unchanged from previous behaviour.
- **Case B (single surface portal):** Exactly one endpoint connects to a non-tunnel road at different height → `isRamp=true`, vertex heights interpolated from underground (-6) to surface (0) via smoothstep. The flat-buffer (20%) is at the surface/portal end so the road arrives flush with the surface road before connecting.
- **Case C (dual surface — deferred):** Both endpoints connect to surface roads (short tunnel between two surface sections). Would require a valley-shaped (0→-6→0) ramp. Keeping flat at baseHeight for now — 146 such tunnels in Barcelona, primarily short service underpasses.

**The surface road connecting to the tunnel stays unchanged** (flat at Y=0). The ramp is on the tunnel road itself.

The bake log line `Tunnel portals reclassified as ramps: N` reports Case B count.

---

## G-49: Service-Tunnel Terrain Cut — Grid Resolution Limitation

Service-road tunnels (underground parking ramps, minor access roads) have `road.width = 4m` → `halfW = 4/2 + 2.5 = 4.5m`. The terrain grid at `GRID_SIZE=64` gives ~9.7m per cell; worst-case triangle centroid distance from corridor edge = √(4.85² + 4.85²) = 6.9m. Since 6.9m > 4.5m, corridor centroids can miss the cut zone entirely. **Terrain cuts for service-road tunnels are unreliable at current grid resolution.**

Trunk/primary tunnels (halfW ≥ 9.5m) are not affected: 9.5m > 6.9m diagonal.

Accepted as engine limitation. Fix requires increasing `GRID_SIZE` from 64 to 128 (4× terrain vertices, ~2× bake time, perf budget concern). Defer to dedicated terrain resolution upgrade after Phase C Mercator fix.

---

## G-48: Non-Drivable Tunnel Types Excluded from Terrain Cuts

`highway=corridor`, `platform`, `busway`, `track`, `construction`, `proposed` tunnels are excluded from `tunnelRoadsForBake` and the cross-tile pre-pass (`buildCrossTileMetadata`). These OSM types refer to pedestrian passages inside buildings, transit platforms, bus-only corridors, and agricultural tracks — not drivable roads. They previously leaked through and contaminated the terrain cut pipeline.

Filter applied in `buildRegion.js` at two points: (1) `buildCrossTileMetadata` pre-pass, (2) per-tile `tunnelRoadsForBake`. Uses the `NON_DRIVABLE_TUNNEL_TYPES` set at each site. Any new non-drivable type that causes spurious cuts should be added to both sets.

---

## G-47: Cross-tile Tunnel Approach Cuts — `_metadata.json` is Bake-Time Only

`buildRegion.js` runs `buildCrossTileMetadata()` before the per-tile loop. It scans ALL region-wide tunnel roads, identifies true portal endpoints (endpoint appearing in exactly one tunnel segment), and emits `tunnel_approach` features when the portal's 80m outward approach corridor crosses into an adjacent tile (`affectsTile ≠ ownerTile`).

Output: `backend/tiles/{region}/{zoom}/_metadata.json` (audit artifact) + in-memory `Map<"zoom_tx_ty", feature[]>` used during per-tile bake.

`bakeTerrainMesh()` 5th parameter `crossTileApproaches` receives the filtered list for each tile. Each entry is mapped directly into `approachSegments` — the same mechanism as Source A (portal corridors from the tile's own tunnel roads). No parallel cut code path.

**Diagonal portals** (corridor crossing 2 tile boundaries simultaneously) are deferred — the current implementation emits one entry for the approach endpoint tile only. If verification surfaces a diagonal case, add an AABB intersection check against all 4 adjacent tiles.

**Constants must stay in sync:** `TRENCH_LEN = 80` and `APPROACH_RAMP_CUT_MARGIN = 2.5` are duplicated in both `buildRegion.js` (`buildCrossTileMetadata`) and `terrainBaker.js`. If either constant changes, update both.

---

## G-46: ColorGradePass — Analytic Warm Shift, Tunable via Window Reference

`frontend/src/ui/colorGradePass.js` adds a full-screen analytic color grade (warm shift + shadow lift + vignette) between `RadialBlurPass` and `OutputPass`. It runs in linear-light space — must stay before `OutputPass` which applies sRGB gamma.

Tune live in DevTools: `window._colorGradePass.uniforms.uGradeStrength.value` — `0` = pass-through, `1` = default (R+6%/G+2%/B-6%), `2` = double warm shift.

**Remove `window._colorGradePass` reference in `main.js` before shipping** — it's a dev tuning handle, not production API.

The vignette (18% max at corners, `smoothstep(0.38, 0.75, dist)`) is hardcoded and not affected by `uGradeStrength`.

---

## G-45: Tree Wind Uses Y-Position as Trunk/Foliage Proxy

`vegetationRenderer.js getProceduralMaterial()` uses `onBeforeCompile` to inject wind displacement. The sway weight is `(transformed.y / 10.0)²` — Y=0 at trunk base, Y≈10m at foliage tips. No separate trunk/foliage meshes exist in the geometry; Y position is the only available proxy.

Behaviour: vertices below ~3m sway < 9% of max; vertices above ~7m sway > 49% of max. Trunk effectively static; foliage tips sway ~0.3–0.5m at `uWindStrength=1.5`.

**If tree geometry height changes significantly** (e.g., taller canopy variants added), adjust the `10.0` divisor in the shader accordingly. This is the `TREE_HEIGHT` denominator — not a named constant, just the inline `10.0` in `getProceduralMaterial()`.

Billboard trees (`getTreeBillboardMaterial()`) are a separate code path — unaffected by this shader patch. Billboard trees always stay static.

---

## G-44: Sky/Ambient/Fog/Car Env Are Now Linked — Change One, Change All

`scene.js` exports three `THREE.Color` constants: `SKY_HORIZON` (#BFD7EE), `SKY_MID` (#94C2E6), `SKY_ZENITH` (#6FAEDB). These drive four systems simultaneously:

1. **Sky dome shader** (`scene.js`) — passed as uniforms `uHorizon`, `uMid`, `uZenith`
2. **Fog color** (`scene.js`) — `FogExp2(SKY_HORIZON.getHex(), 0.005)`
3. **Ambient light** (`scene.js`) — `lerp(0xffe8c8, SKY_HORIZON, 0.25)` → `#EFE4D2`
4. **Car paint env sphere** (`carModel.js`) — imports `SKY_HORIZON`/`SKY_ZENITH`, uses in PMREMGenerator

If you change the sky palette, update **only** the three constants in `scene.js`. All four systems update automatically. Do NOT hardcode sky colors in `carModel.js`, `dayNight.js`, or anywhere else.

**Fog is drive-mode only** — still true, but the number changed (v3 D-06, 2026-08-24):

`main.js` **modulates the active day/night preset**, it no longer writes a constant:
```js
const _fogBase = getPresetFogDensity();            // envToggle: DAY 0.0032 / NIGHT 0.0045
scene.fog.density = carDriver ? (_titleLive ? _fogBase * 0.12 : _fogBase * _fogAltFade) : 0;
```
Until v3 this line wrote a hardcoded `0.005` **every frame**, silently overwriting `envToggle`'s
tuned presets — so DAY 0.0032 and NIGHT 0.0045 had never once been seen on screen. The
drone-mode-zero, title-cinematic and altitude-fade behaviours are unchanged.

**The invariant now:** `envToggle` owns *what density this time of day wants*; `main.js` owns *what
the camera situation allows*, as a MULTIPLIER. Never write `scene.fog.density` to a literal — change
the preset in `envToggle.js` instead, or you re-introduce the same silent clobber.

---

## G-49: Off-road terrain hold = CHASSIS backstop on a visual-aligned Trimesh (RaycastVehicle rays miss trimeshes)

> **CORRECTED 2026-06-11 — the backstop premise below was FALSE.** cannon-es has **no box-vs-trimesh
> narrowphase at all** (its COLLISION_TYPES list only `sphereTrimesh` and `planeTrimesh`; runtime check:
> `narrowphase[BOX|TRIMESH]` is undefined; drop-test: chassis fell through a verified-perfect trimesh with
> ZERO contacts). "Box-vs-trimesh body collision IS reliable" was never true — the backstop never engaged,
> masks or no masks. A Trimesh terrain is therefore DOUBLY dead to a RaycastVehicle: rays miss it AND the
> chassis box can't collide with it. Terrain physics is now the **Heightfield** (boxHeightfield narrowphase
> + ray intersection both exist → wheels genuinely drive off-road); the old heightfield misplacement was a
> quadrant-indexing bug in `buildTerrainHeightfield` (64-range indices into the 128-wide grid → SW quadrant
> stretched over the tile), fixed by using the full source grid — placement runtime-verified ≤ 0.01 m
> against the trimesh before the trimesh was removed. The record below is kept as a diagnosis trail.

**What it is:** Two facts force this design. (1) cannon-es `world.rayTest` reliably hits **boxes** but **misses
`CANNON.Trimesh`** (its octree `tree.rayQuery` returns no candidates for our terrain — the same fragility that
moved roads to per-segment boxes, [[D-10]]). So `RaycastVehicle` wheel rays cannot hold the car on terrain. (2)
But **box-vs-trimesh body collision IS reliable** (narrowphase, not raycast). So terrain physics is a
visual-aligned `CANNON.Trimesh` (built from `bakedTerrain` so it co-frames with the drawn surface — runtime
gap = 0.00 m), in its own group `COLLISION_GROUP_TERRAIN` (16), and the **car chassis collides with it**
(`chassis.collisionFilterMask = WORLD | TERRAIN`) as a backstop. The own-group is essential: the chassis must
NOT collide with the road-deck GROUND boxes (their edge seams make the chassis stutter — the reason ground was
originally excluded), only with the smooth terrain trimesh. The chassis box bottom rides ~0.1 m above the
surface, so the backstop only engages once the car sinks below wheel ride height.

**What breaks if violated:** Without the chassis backstop the car **free-falls straight through terrain off-road
even with the collider provably correct** — runtime probes confirmed gap = 0.00 m, up-normals, correct
filter/`collisionResponse`, yet wheels over terrain reported `inContact=false` and manual long rays over terrain
returned MISS (rays over road boxes hit). Layers that also had to be right first: the physics surface must be
**aligned** to the visual (the old 32-grid physics bake diverged ~8.7 m on Montjuïc slopes → built `createTerrainTrimesh`
from the 128-grid `bakedTerrain` instead — runtime-verified 16,384 verts/tile; earlier "64-grid" label was wrong). NOTE the limitation: because wheel rays still miss the trimesh, the car
has **no wheel suspension/traction off-road** — it rests on the chassis box and can't be driven far onto terrain
(roads are the gameplay surface). Proper drivable off-road needs a raycast-reliable terrain shape;
`buildTerrainHeightfield` exists for this but its untested world→physics transform misplaced the collider when
tried — revisit with a runtime placement check before relying on it. Diagnosis followed [[G-48]] (probe live
bodies, never assume).

---

## G-48: Verification discipline for any elevation / render fix (REQUIRED checklist)

This session repeatedly "fixed" things that weren't what rendered. The checklist that actually worked —
run it for every elevation/render change before claiming a fix:
1. **Identify the actual rendered object.** Traverse the live scene by material / `userData.type` /
   geometry attributes / world-space extent — do NOT assume which mesh is the floater. (Terrain has no
   name/userData; key on `material.customProgramCacheKey() === 'terrainDelhiProcedural'`.)
2. **Log the RUNTIME value at the call site** (the actual offset, the actual Y, the actual gap to
   terrain), not the value you think the code uses.
3. **Verify on the RENDERED screen**, not a validator or a baked-data report. A "baked data looks right"
   report repeatedly disagreed with the screen.
4. **FULL reload + fresh bundle.** HMR keeps stale built meshes and stale worker chunks; the source you
   edited may not be the source running. Confirm the served file in DevTools → Sources. Also run
   `window._clearTileCache()` — the tile-data cache survives reloads.
5. **Never trust a report over the screen.**

**Specific traps hit this session (so they're recognized next time):** stale tile-data cache; a dead code
path (`useBaked=false` → the fallback mesh rendered while every fix targeted the baked mesh); stale
main-bundle + worker chunk after edits; a **range-aggregate** ("surface spans −69..+112, looks draped")
that hid per-point errors — only a per-point co-located delta exposed the truth; and a **sky-dome ±40 km
red herring** (`IcosahedronGeometry(40000)` in scene.js) that looked like a giant floating mesh but was benign.

---

## G-47: The recurring failure class — "fine at terrain≈0 (flat world), wrong once terrain carries real DEM"

**What it is:** A whole family of bugs share one shape: a constant, threshold, or default that was correct
when all terrain was ≈0 (the pre-DEM flat world) and silently wrong once the DEM gives terrain real
elevation. When you see an **absolute Y constant or an elevation threshold**, assume it is this bug until
proven terrain-relative.

**Confirmed instances (this session):**
- **Offset frame** — terrain shifted by `offset` while roads/physics shifted 0 (the gated/ungated split). [[D-12]]
- **Water-sink depth** — fallback terrain used an absolute water depth → El Raval "water cones." [[D-13]]
- **Water-sink scope** — sinking open polylines (not just closed water polygons) carved spurious trenches.
- **`getElevationAt → 0` fallback** — a null/NaN DEM cell returning 0 puts a feature at spawn level, not local terrain.
- **Bridge-detection threshold** — `hMax > 4 / Δh > 2.5` on terrain-inclusive height fabricated bridges. [[D-15]]
- **Ground placement** — `makeTranslation(wx, 0, wz)` and raw absolute `p.elevation` placement (barriers, urban features, vendor carts, road infra, tunnel portals). [[G-45]]
- **Tunnel constants** — `topY=0.05`, `botY=−5.95`, skip `elev > −0.5` all assume terrain at Y=0 (Stage-3 rework).

**Rule:** any new absolute-Y constant or elevation threshold must be expressed terrain-relative
(`+ getGroundY(x,z)`, or `elev − terrainDEM`, or a structural flag) and reviewed against this list.

---

## G-46: Parser delivers polygon points as `{x,y}` OBJECTS — renderers MUST read `.x`/`.y`, never `[0]`/`[1]`

**What it is:** `tileParserWorker`'s `readFloat32Pairs` (and `readFloat32Triples`) return point **objects**
`{x, y}` (y = world Z), NOT arrays. Area renderers consuming polygon points must read `.x` / `.y`.
Array-indexing an object (`poly[i][0]`) returns `undefined` → `THREE.Shape` collapses every vertex to the
origin → the merged mesh's geometry degenerates and the "feature" floats/streaks from world origin.
(Exception by design: `readBarriers` returns `[x,z]` ARRAYS — barrier code uses `[0]`/`[1]` correctly.)

**Reference & status:** `waterRenderer` is the correct reference (`.x`/`.y`). Fully fixed:
`greensRenderer` (centroid + shape build) and `parkingRenderer` (pointInPoly, centroid, shape, uniqueNodes,
and the stall-marking bbox loop — `parkingRenderer.js:82`, previously `for (const [px, pz] of poly)` which
array-destructured the objects → NaN bbox → silently-skipped stall lines; now `for (const p of poly) { const
px = p.x, pz = p.y; … }`). Grep-clean: no `[0]`/`[1]`/`[px,pz]` indexing of point vars remains in either file.

**Rule:** any new renderer reading `readFloat32Pairs`/`readFloat32Triples` output uses `.x`/`.y`; grep new
area-renderers for `[0]`/`[1]` indexing of polygon points.

---

## G-45: Every Ground-Placed Renderer Must Anchor To `getGroundY` (or Normalized Road Elevation)

**What it is:**
The spawn-anchored vertical frame means terrain renders at `(DEM − worldElevationOffset) × vertExag`.
ANY renderer that puts geometry "on the ground" must place its base Y at that same normalized terrain
height — never at a hardcoded `Y=0`, a flat constant, or a raw absolute `road.points[].elevation`.
`tileManager.processTileData` defines the canonical `getGroundY(wx, wz)` (normalized terrain render-Y)
and passes it to every world-placed renderer. Two correct patterns:
- **Point / polyline features** (urban features, vendor carts, barriers, tunnel portals & retaining
  walls): anchor base Y to `getGroundY(wx, wz)`. For barriers the geometry is built in world X/Z with
  local Y, so a per-vertex post-pass (`drapeToGround`) adds `getGroundY` to every vertex.
- **Road-anchored structures** (roads, road infra, tunnel floors/ceilings): the road point already
  carries absolute DEM, so normalize it: `(elevation − offset) × vertExag` (`normRoadElev` /
  `_normTunnelElev`). Skip/threshold tests on elevation must be **terrain-relative** (`elev > groundY − k`),
  never against absolute `0` / `−0.5` (that assumed tunnels live near Y=0 — a flat-world relic).

**What breaks if violated:**
`Y=0` placement floats where terrain is below spawn (most of the lower city) and buries where above
(Montjuïc); raw-elevation placement floats `+offset` everywhere. Confirmed floaters fixed under this
rule: barriers/walls, washrooms & other urban features, vendor carts, tunnel gates/portals/retaining
walls (all were `Y=0` or absolute). NOTE: the deep tunnel-enclosure depth/skip rework is Stage 3
(vertical-model-foundation-spec) — `buildTunnelMeshes` is now offset-normalized and terrain-relative,
but full tunnel correctness still belongs to that stage. Siblings: [[G-43]] (road infra), [[G-44]]
(baked road surface) — all three are the road-drape fix exposing consumers that bypassed the normalized frame.

---

## G-44: Pre-Baked Road Geometry Stores ABSOLUTE DEM — Normalize It Into the Geometry at Load

**What it is:**
`renderTileRoads` has two paths. The **runtime** path (`createRoadMesh → getRoadPointHeights →
toNormalizedRoadY`) subtracts `worldElevationOffset`, so it drapes. The **fast path**
(`options.bakedRoads.layers`, the v7 pre-baked road surface) loads `bakedLayer.positions` verbatim —
and those positions are baked offline at **absolute DEM Y** (no runtime offset). That mesh must be
normalized to `(DEM − offset) × vertExag`, exactly like the terrain mesh. Crucially, bake the shift
into the **geometry** (`geom.scale(1,vertExag,1)` + `geom.translate(0, -offset*vertExag, 0)`), NOT into
`mesh.position`/`mesh.scale`: `mergeMeshesByMaterial` (tileManager) merges raw geometries and builds a
new mesh at the origin, silently dropping any per-mesh transform.

**What breaks if violated:**
The baked road **surface** floats exactly `+offset` (≈80 m on the Montjuïc spawn) — a dark web of road
ribbons overhead — while the runtime-built **markings/crosswalks drape correctly**, because only the
surface uses the baked path. Live probe signature: meshes with `MeshStandardMaterial`, `vertexColors`,
geometry attrs `position,normal,uv,halfWidth,color` (= `getSharedRoadMaterial` + `buildFlatRibbonGeometry`),
vertexY − terrainY ≈ +80 on every sample. If you "fix" it with `mesh.position.y` it will appear to work
for single-layer tiles and regress on multi-layer tiles (their layers share `roadMaterial` and get merged).
Sibling of [[G-43]] (road infra) — both are the road-drape fix surfacing absolute-DEM consumers that
bypassed `toNormalizedRoadY`.

---

## G-43: Road-Anchored Decorations Must Normalize the Road-Point Elevation (Subtract the Offset)

**What it is:**
`roadInfraRenderer` (and any renderer that anchors meshes to `road.points[i].elevation`) gets the
**raw absolute DEM** in that field after the road-drape fix. The rendered world is spawn-anchored —
`renderY = (rawDEM − worldElevationOffset) × vertExag` — and roads/terrain already live in that frame.
Road infra does NOT receive `getElevationAt` or `elevationOffset` from `tileManager` (it's called as
`buildRoadInfrastructure(roads, key)`), so it must normalize the elevation itself via `normRoadElev()`
before using it as a `baseY`. Every elevation→Y seam (the `interpolate*`/`walkPolyline` readers at the
top of the file, and the junction `connectedRoads` entries) goes through `normRoadElev`.

**What breaks if violated:**
Using the raw elevation places signs, direction boards, name boards, gantries and poles at the
**absolute DEM** — on Montjuïc that is +90…+190, i.e. ~80 m above the draped road — producing a dark
`#bbbbbb` "web" of infrastructure floating overhead (confirmed live: 462 overhead meshes at Y 87–192
while terrain under the camera was at −15). The road **surface and markings were correct** because
they use `getRoadPointHeights → toNormalizedRoadY` (which subtracts the offset); only the road-anchored
decorations that bypass that path floated. Related: `urbanFeatureRenderer` / `vendorCartRenderer` place
at world `Y = 0` (not terrain-following) — they sink on slopes rather than float; if you make them
terrain-follow, normalize the same way. See [[G-42]] (the sibling bridge-detection fallout of the drape fix).

---

## G-42: Bridge-Structure Detection Must Use ABOVE-TERRAIN Height, Never Terrain-Inclusive Road Height

**What it is:**
`getRoadPointHeights()` returns terrain-inclusive road Y (`DEM − offset`, after the road-drape fix).
Its magnitude reflects **terrain elevation** (positive on hills like Montjuïc) and its range reflects
**terrain slope** — not whether a road is a structural bridge. The bridge-structure builders in
`roadRenderer.js` (`buildBridgeSlabGeometry`, `buildBridgeGuardRailGeometry`,
`buildBridgeShadowMesh`, `buildBridgeGuardRailColliders`) must therefore decide "is this elevated"
from **structural flags only** — `road.bridge || road.layer > 0 || road.isRamp` — plus, for `_link`
roads, an **above-terrain** rise via `getAboveTerrainHeights()` (which subtracts `getElevationAt` so
DEM cancels and only the layer/ramp component remains). The `MIN_BRIDGE_STRUCTURE_HEIGHT` taper and
the shadow `heightAlpha` fade must key off the same above-terrain value.

**What breaks if violated:**
The pre-fix code used absolute/relief thresholds (`hMax > 4.0`, `Δh > 2.5`, plus `rawElevMax`/
`rawElevRange` read straight off absolute `p.elevation`). Post-drape these fired on ~60% of ordinary
surface roads (165/277, 184/338 on bridge-free tiles 16_33160_24481 / 16_33161_24481), fabricating
slabs + guard rails + metal railings that draped correctly but should not exist — a dark "canopy"
over Montjuïc/Poble Sec, worst on high terrain because the taper went full-thickness there. The fix
dropped those to 3 and 2 (the genuine ramps). Do NOT reintroduce any height test that reads the
terrain-inclusive height; if you need a height signal, it is `road − terrain`, never `road`.

---

## G-41: Terrain Hole Radius Must Match Portal Frame Width

`terrainRenderer.js` hole radius = `halfW + PORTAL_WING + HOLE_OVERLAP = (road.width/2 + WALL_EXTRA) + 3 + 0.5`. All three constants must stay in sync with `tunnelRenderer.js` (`WALL_EXTRA_WIDTH = 1`, `PORTAL_WING = 3`). The `+0.5` overlap ensures the portal frame sits *inside* the terrain hole rather than overhanging the edge.

If you change `PORTAL_WING` in tunnelRenderer.js, update the constant in terrainRenderer.js too. They're not imported — just comments linking them.

## G-40: Tunnel Classification Uses DRIVABLE_TUNNEL_TYPES Whitelist

`tileManager.js` classifies underground tunnels with a **whitelist** (`DRIVABLE_TUNNEL_TYPES`), not a blacklist. Only these 13 types get full enclosure + terrain holes:
`motorway, motorway_link, trunk, trunk_link, primary, primary_link, secondary, secondary_link, tertiary, tertiary_link, residential, unclassified, living_street`

Everything else (`service`, `track`, `cycleway`, `footway`, `path`, `steps`, `corridor`, etc.) goes to `pedestrianPortalRoads` → portal frame only, no terrain holes, no interior.

**Why whitelist:** Barcelona has `highway=service tunnel=yes layer=-1` ways for marina passages and mall corridors (e.g., Moll d'Espanya). These would get full tunnel treatment (interior enclosure + terrain holes) under a blacklist approach since `service` is not in any pedestrian set. The whitelist correctly routes them to portal-only mode.

---

## G-43: terrainBaker Road Points Are Mercator, Not World Coordinates

`payload.roads[i].points[j]` at bake time is `[mercX, yUp, mercZ]` — **absolute Mercator coordinates** (values ~235,000–245,000 for Barcelona). The terrain grid vertices are in **world coordinates** (Mercator - origin, values ~1,000–7,000). Any computation in `terrainBaker.js` that compares road point positions with terrain vertex positions MUST convert road points via `mercatorToWorld(pts[i][0], pts[i][2])` first.

The original `tunnelMouths` code used `pts[0][0]` and `pts[0][2]` directly, meaning circular portal holes were placed at Mercator coordinates far outside the tile's world-space terrain grid — **the holes never fired**. Fixed in the same batch as the approach corridor work.

Road `elevation` data is in `road.elevation[]` (separate per-point array), NOT in `pts[i][1]` which is `yUp` (bridge height, usually 0).

## G-42: Terrain Corridor Cuts for Tunnel Portals — Bidirectional Required

Portal endpoints of tunnel roads are at tile boundaries (where adjacent tiles connect). An outward-only 80m corridor extends OUTSIDE the tile terrain grid → zero triangles cut. Fix: generate corridor spanning TRENCH_LEN in BOTH directions from each portal endpoint:
- Outward (toward surface): covers approach zone in adjacent tile if portal is at boundary
- Inward (into tunnel): always within this tile, cuts terrain at the tunnel entry zone

The inward corridor removes terrain from the first 80m of the underground section, creating the visual opening at the portal face. The outward corridor handles cases where the portal is in the middle of a tile (approach zone within this tile).

## G-41: Terrain Hole Radius Must Match Portal Frame Width

---

## G-39: Tunnel Approach Classification — Three-Way Split

`tileManager.js` now classifies approaches into three buckets before any geometry is built:

1. **`tunnelRoads`** — non-pedestrian roads with `tunnel=true` AND `layer < 0`. Get full interior enclosure (ceiling, walls, LED strips, yellow safety stripe, portal frame, per-name sign).
2. **`carveApproachRoads`** — `approachRoads` that pass `isHillsideApproach()`: must be motorway/trunk/link AND have ≥60m horizontal span from surface to deepest point. Get terrain carving + physics pit. Barcelona currently has zero of these in tile coverage; reserved for future hillside coverage expansion.
3. **`wallApproachRoads`** — everything else (all urban descents, residential approaches). Get vertical concrete retaining walls (`buildRetainingWalls`). No terrain mutation. **Physics: these L0 approach roads need their OWN wall colliders (`createApproachWallColliders`, added 2026-06-05).** `createTunnelWallColliders` runs only for `tunnelRoads` (layer<0), so a previous note claiming "physics handled by existing wall colliders" was FALSE — L0 approaches had a deck but no wall physics, and the car dropped off the deck edge into the over-cut terrain strip (Phase-2 Option A fix). Both visual walls and approach wall colliders are gated by `ENABLE_RETAINING_WALLS`.
4. **`pedestrianPortalRoads`** — footway/pedestrian/path/steps with `tunnel=true` AND `layer < 0`. Get portal frame only (`buildPedestrianPortals`). No terrain carving, no interior, no terrain holes.

**Do NOT add pedestrian types to tunnelRoads or approachRoads.** 80% of Barcelona's tunnel ways are pedestrian; the old system applied full 25m terrain ramps to all of them.

## G-38: Tunnel Ceiling Height — Road-Relative, Not Fixed

Old: `CEILING_Y = -1.5` (fixed world Y). This caused ceiling to be only 0.5m above road when tunnel is at -2m elevation, and 4.5m above at -6m.

New: `ceilY = road_elevation + TUNNEL_CLEARANCE` where `TUNNEL_CLEARANCE = 4.5m`. Ceiling tracks the road floor with constant clearance. Portal frame top beam now also uses `ceilM = eM + TUNNEL_CLEARANCE` at each mouth.

## G-37: No Terrain Carving for Urban Barcelona Tunnels

Terrain carving (`carveTunnelTerrain`) is restricted to motorway/trunk approaches ≥60m horizontal. All other approaches (including the Ronda Litoral, residential passages, pedestrian underpasses) get retaining walls instead. Rationale: Barcelona tunnels are concrete box-cuts, not earthen hillside slopes. The old system applied 25m ramps and 8m blend zones to building passages and metro entrances, creating false terrain depressions throughout the city.

If coverage expands to include true hillside tunnels (e.g., Tunnel de la Rovira from the north), `isHillsideApproach()` will correctly classify them for terrain carving.

---

## G-36: Barcelona Parking Schema — Three-Layer Priority Chain

Barcelona OSM does NOT primarily use `parking:lane:*` for restrictions. The actual schema (confirmed from PBF scan, 937k highway ways):
1. `parking:both:restriction` / `parking:left:restriction` / `parking:right:restriction` → values: `no_stopping`, `no_parking` (dominant — 642+130 restriction ways)
2. `parking:condition:both/left/right` → values: `no_stopping`, `no_parking`, `free`, `ticket`
3. `parking:lane:*` → least common in Barcelona (primarily used in other cities)

Blue zones: `parking:*:fee=yes` → paid. `parking:left/right/both = yes/lane/street_side` → free (allowed parking).

In buildRegion.js, all three schemas are collapsed into `parkingLeft`/`parkingRight` (restriction) and `parkingPaidLeft`/`parkingPaidRight` (fee status). Priority order matters: `:restriction` wins over `:condition`, wins over `:lane`.

---

## G-35: Ghost Wall Filter — Centroid Proximity, Not Edge Distance

`buildBarrierMeshes(barriers, roads, buildings)` now accepts `buildings` (from `tileData.buildings`). When `ENABLE_GHOST_WALL_FILTER=true`, barrier=wall polylines with midpoint within **5m** of any building centroid are skipped visually (physics bodies preserved). Uses centroid approximation (not polygon edge), fast O(walls×buildings). 5m threshold calibrated to catch typical OSM double-tagging where barrier=wall follows building perimeter exactly. Set to 3m if too aggressive, 8m if ghost walls still appear.

---

## G-34: ZONA 30 Detection — maxspeed Field Required

`buildZona30Stencils` requires `road.maxspeed === 30` (integer, not string). This field comes from Phase 2 bake (`buildRegion.js` emits `maxspeed: parseInt(t.maxspeed)`). If `maxspeed` is null (OSM tag absent), the road is skipped — no stencil. Barcelona has 1,396 roads with maxspeed=30 in the current tile extent. Stencils are an InstancedMesh placed every 100m; LOD 50m × altMult.

---

## G-33: Chamfer Junction Data — Two Sources, One Authoritative

Before Phase 4B-1: junction radius was computed twice — `getJunctionPoints()` in the frontend (radius = maxWidth, full road width) and nowhere in the tile. Phase 4B-1 adds `radius` (full max road width) and `approaches: [{angle, width}]` (sorted CCW) to the tile junction JSON via buildRegion.js. Frontend no longer needs to derive these.

The bake-side `radius = max(approach.width)` INTENTIONALLY matches the frontend's `getJunctionPoints()` `radius: v.maxWidth` (full width, not half). Both use the same convention. Do not change one without changing the other.

Eligibility for chamfer fill: `type === 'crossing'`, `approaches.length >= 3`, `radius >= 8`, approaches roughly orthogonal (±20°). 8% of Barcelona junctions qualify (263 of 3284). Densest Eixample tile: 17 eligible junctions × 8 vertices = 136 verts — negligible.

---

## G-32: Tram Rails Use Road Surface Height, Not Railway Height

`getRailwayPointHeights()` returns `(baseY + RAILWAY_OFFSET) * scale = baseY + 0.07`. This is correct for heavy rail on a ballasted bed above terrain, but **wrong for trams** which are embedded flush in the road surface.

Road surface height: `(baseY + ROAD_OFFSET) * scale + ROAD_VISUAL_ABOVE_TERRAIN = baseY + 0.10`.

If trams use `RAILWAY_OFFSET` (0.07), the rail sits `baseY + 0.07 + TRAM_RAIL_Y_ABOVE = baseY + 0.075` — 25mm below the road surface, occluded by the asphalt mesh.

**Fix:** `getTramSurfaceHeights()` in `railwayRenderer.js` returns `baseY + 0.10` (road surface). `buildTramRailGeometry` then adds `TRAM_RAIL_Y_ABOVE = 0.005` → final `baseY + 0.105` (5mm proud of asphalt). Do NOT call `getRailwayPointHeights` from `createTramMeshes`.

The local constants `_ROAD_OFFSET = 0.05` and `_ROAD_VISUAL = 0.05` in `railwayRenderer.js` mirror `roadRenderer.js` ROAD_OFFSET + ROAD_VISUAL_ABOVE_TERRAIN. If those values ever change in roadRenderer, update both files.

---

## G-30: Tram Rails — Separate Renderer from Heavy Rail

`createTramMeshes()` in `railwayRenderer.js` is the ONLY entry point for `railway=tram` and `railway=light_rail`. The existing `createRailwayMeshes()` still handles `railway=rail`, `subway`, etc. with the ballasted ribbon + texture approach. **Do not merge them.** Tram rails are flush-embedded (no sleepers, no ballast), 0.06m wide, at road surface + 0.005m. Heavy rail uses a 2m-wide ribbon with UV-mapped sleeper texture.

Tram tunnel segments (`tunnel=true` or `layer < 0`) are skipped — they're underground, invisible at road surface. `CONFIG.ENABLE_RAILWAYS` controls heavy rail; `CONFIG.ENABLE_TRAM_TRACKS` controls tram independently.

Tram data in Barcelona tiles: 37 segments across 8 tiles (Trambesòs route, tiles 33166–33173). Diagonal tram not in current OSM extent.

---

## G-31: `parking:lane:*` OSM Tags — Sparse in Current Tile Extent

`parking:lane:left`, `parking:lane:right`, `parking:lane:both` added to `pbfHighways.js` KEEP_TAGS (Phase 4A). Pipeline: `buildRegion.js` → `convertToBinary.js` → `tileParserWorker.js` → `roadRenderer.js:buildNoParkingStripes`. All gates wired.

**OSM coverage in Barcelona:** 355 ways with `no_parking`/`no_stopping` values exist in the PBF, but **all are in neighborhoods outside the current tile extent** (Gràcia, Nou Barris, Sant Andreu). The Eixample area tends to use metered parking or parking lanes, not restriction zones. Yellow stripes will appear automatically when tile coverage expands.

**Do not re-bake to fix this** — it's a geographic coverage limitation, not a pipeline bug. The pipeline is correct.

---

## G-28: MeshLambertMaterial for Flat-Lit Textured Surfaces

Use `MeshLambertMaterial` (not `MeshStandardMaterial`) for any ground-plane mesh that uses a texture but needs no PBR reflections — panot sidewalk tile, road decals, painted markings. `MeshStandardMaterial` compiles a much larger shader program and holds more GPU/CPU state; one variant can add 30–60MB to heap. Lambert renders identically at this scale for diffuse-only surfaces.

**Rule:** If the material has `map:` set and `roughness`/`metalness` are either 0/1 defaults or not visually meaningful, switch to Lambert. Curb and bike-lane materials are `MeshLambertMaterial` by design.

---

## G-29: `barrier=wall` minHeight Was Delhi Default 3.5m — Now 1.0m for Barcelona

`BARRIER_CONFIGS.wall.minHeight` was 3.5m (Indian compound wall perimeter height). Barcelona property walls are 1–2m. After Phase 3 polish, reduced to 1.0m. `compound_wall.minHeight` reduced from 3.5m to 1.5m.

`PRECAST_WALL_TYPES` previously included `'wall'`, applying Indian pillar+panel+wire geometry to every `barrier=wall` in the city. Removed — `wall` now uses `TEXTURED_WALL_TYPES` (UV-mapped stone geometry). Only `compound_wall` (campus perimeters) keeps the precast treatment.

**No re-bake required:** `BARRIER_DEFAULT_HEIGHTS.wall = 2.0m` in buildRegion.js. After minHeight reduction to 1.0m, `Math.max(defaultHeight=2.0, minHeight=1.0) = 2.0m`. Explicit OSM `height=` tags < 1m get floored to 1.0m — acceptable (sub-1m walls are degenerate). Sound barriers with `height=4m+` preserve their full height untouched.

---

## G-27: Sidewalk Inference — 3-Layer Priority System + Junction Clip Radius

**What it is:** `inferSidewalkSide(road)` in `roadRenderer.js` resolves which sides of a road get a sidewalk:
1. OSM explicit: `sidewalk=both/left/right` → use as-is. `sidewalk=no` → skip.
2. Road-type skip set (`_NO_SIDEWALK_TYPES`): motorway/trunk/link, service, track, path, cycleway, footway, steps, **pedestrian, living_street** → skip. `pedestrian`/`living_street` are themselves the walkable surface — never add a ribbon.
3. Fallback: infer `'both'` for all other road types.

**Building proximity gate:** Even after inference, no sidewalk if no building centroid is within **30m** of any road point. Prevents sidewalks in parks, open fields, coastline approaches. `options.buildings` set at `tileManager.js:1052` — synchronously before `createRoadMeshes` at line 1061, no race condition.

**Junction clip radius:** Sidewalk polylines sit `offsetFromCenter` (6–17m) from the road centerline. `INTERSECTION_RADIUS=3m` never reaches them. The clip function for sidewalks uses `base_radius + offsetFromCenter`; for curbs `base_radius + curbOffset`. Without this, all intersection corners overlap.

**OSM coverage context:** Only 1.4% of all roads / 6.3% of drivable roads have explicit `sidewalk=` tags in Barcelona OSM. The 98.6% untagged figure counts footways and cycleways in the denominator. For drivable roads only: 91.7% untagged — inference handles the majority.

**Why:** Changing `_NO_SIDEWALK_TYPES`, the 30m threshold, or the junction radius formula affects large visual classes of roads. Always verify all three visually: (1) pedestrianized streets have no ribbon, (2) park/coastal roads have no ribbon, (3) intersection corners are clean.

---

## G-17: `meshHasNaN` Full-Array Scan Must Not Be Reverted to a Sampler

**What it is:**
`meshHasNaN()` in `tileManager.js` previously sampled only the first 90 and last 30 float values in the position array. For large merged geometries (LOD building mesh from 50 buildings = 900+ floats), NaN from building #3 lands at offset ~60 — within the check range. But for a 170,000-vertex merged geometry (510k floats), NaN from one bad building could land at any offset: 100, 50,000, 250,000 — completely missed by the sampler.

**Current behavior:** Full array scan (`for (let i = 0; i < arr.length; i++)`). Cost: ~0.5ms for 510k floats, amortized across infrequent tile builds. Not in the render loop.

**Do NOT revert to a partial sampler.** NaN from elevation data falls at unpredictable offsets inside merged geometry — it is not biased toward the start or end of the array. The one-time console.warn (`[meshHasNaN] caught NaN...`) fires if `safeSceneAdd` actually blocks a mesh; if you see that warning, the root NaN source is still alive and should be fixed at its origin.

---

## G-50: Simple-tunnel mode must RENDER the descending deck, not just carve the hole

**What it is:** With `ENABLE_TUNNEL_VISUALS:false` (simple-tunnel mode), the only renderer that drew the descending tunnel road surface was `buildTunnelMeshes` (full enclosure: floor+walls+ceiling+LED+portal), and it was gated off. `roadRenderer.js:1038` separately skips `road.tunnel`. So the terrain was carved (the ramp opening) but **no road was drawn inside it** → a pit with no ramp going in, in a "weird position" disconnected from the surface carriageways. The carve itself was correct: baked tunnel decks descend to ~−6 m (verified: depth profiles like `[-22,-13,-6,-2,-0.4,0]` at portals), and the depth-window carve (−0.3 … −5 m) opens exactly the ramp transition while leaving the deep (−6 m) run covered as a roof.

**Fix:** `buildTunnelFloor(tunnelRoads, getGroundY)` in `tunnelRenderer.js` — a lean floor-only builder (deck quads only, no walls/ceiling/LED/portal/sign), called in the `else` branch of the `ENABLE_TUNNEL_VISUALS` gate in `tileManager.js`. It renders the deck wherever the road is below local terrain (`e < gy − 0.05`), so the road is visibly continuous: down the carved opening, then under the uncarved terrain roof for the deep section. Lifts +0.05 m to match the physics ramp body's `botY`.

**Invariant:** the visual carve (`terrainBaker.js` `CARVE_COVER`), the rendered deck (`buildTunnelFloor` below-terrain test), and the physics ramp/wall colliders must stay mutually consistent. `CARVE_COVER=5` < steady tunnel depth (~6 m) on purpose: shallower = ramp opening, deeper = covered tunnel roof. Raising `CARVE_COVER` past the steady depth turns tunnels into open trenches (no roof). Physics colliders (`createTunnelWallColliders`, ramp bodies, `createApproachWallColliders`) stay ON regardless of `ENABLE_TUNNEL_VISUALS`.

## G-52: Road Y stack — roadBaker and sidewalkBaker use OPPOSITE lift conventions

**What it is:** `sidewalkBaker` bakes raw elevations and documents that the frontend translate adds `ROAD_VISUAL_ABOVE_TERRAIN`. `roadBaker` instead bakes `+ROAD_VISUAL_ABOVE_TERRAIN(0.05) +ROAD_ZFIGHT_OFFSET(0.02) +ROAD_PRIORITY_Y_BUMP(0.001–0.009)` into every ribbon vertex itself. Until 2026-07-16 the frontend baked-roads translate re-added the lift → road surface at `base+0.12+bump`, which buried every paint family (oneway arrows −4cm invisible, lane lines/crosswalks co-planar z-fight), floated roads ~12cm over terrain, and made the car (wheels ride the terrain heightfield) look sunk by the same.

**Invariant:** the baked road surface is `base + 0.07 + bump` (`base = elevation − offset`, vertExag 1). The baked-roads translate in `renderTileRoads` adds ONLY `−bakedOffset`; the baked-SIDEWALK translate (`buildBakedSidewalkMeshes`) DOES add `+ROAD_VISUAL_ABOVE_TERRAIN` — they are different on purpose, do not "unify" them without changing the bakers. Every paint `*_Y_ABOVE` constant in `roadRenderer.js` is tuned against `base+0.07+bump`, AND families built via `buildFlatRibbonGeometry` receive a hidden `+ROAD_ZFIGHT_OFFSET(0.02)` (custom-quad families — arrows, pictograms, zona30 — do not). The full table lives in the comment at `MARKING_Y_ABOVE_ROAD`. Changing ANY of: the bakers' lifts, the translate, `ROAD_VISUAL_ABOVE_TERRAIN`, or `ROAD_ZFIGHT_OFFSET` requires retuning ALL paint constants together (and a re-bake if bake-side).
