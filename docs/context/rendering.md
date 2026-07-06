# Rendering

## Phase 3 LOD Tiers — Sidewalks / Curbs / Bike Lanes

Phase 3 mesh types use altitude-aware LOD (`nearEdgeDist ≤ threshold × altMult`):

| Mesh | Threshold | `altMult` applied? | Notes |
|---|---|---|---|
| `bcnSidewalkMesh` | 80m | Yes | Panot detail visible; culled at moderate altitude |
| `bcnCurbMesh` | 200m | Yes | Silhouette element; visible further than sidewalk |
| `bcnBikeLaneMesh` | 120m | Yes | Green paint; visible from low drone altitude |
| `bcnBikePictoMesh` | 50m | Yes | Small icons; only visible at near-ground level |

At ground driving (altMult ≈ 1.25): thresholds are 100m, 250m, 150m, 62m effectively.
At altitude 100m (altMult ≈ 2.9): 232m, 580m, 348m, 145m.

**World-space UV for panot:** sidewalk UV uses `posAttr.getX(i) / 0.2` and `posAttr.getZ(i) / 0.2` so the 0.2m panot tile stays constant physical size regardless of sidewalk width or road shape. Set after `mergeGeometries()` using final world positions.

**Materials:** All four mesh types use cached global materials (lazy-initialized, one instance per session). Never created per-tile.

**OSM sidewalk accuracy:** Phase 3 trusts `road.sidewalk` 100%. No fallbacks. Known issue: ~10% of roads may show sidewalk on wrong side due to OSM digitization direction. Collect problem streets during verification; fix in Phase 4 polish.

---

## Camera-Altitude-Aware Building LOD

Building LOD and detail-mesh visibility thresholds scale with camera altitude so that drone/fly mode loads detail at greater XZ distances. The multiplier is computed once per LOD update from `camera.position.y`:

```js
// tileManager.js ~line 1843
const _cameraY = camera?.position.y ?? 0;
const altMult = Math.max(1, Math.min(4, 1 + (_cameraY - 5) / 50));
```

| Camera Y | altMult | bldgMaxDist | lodStart | lodEnd |
|---|---|---|---|---|
| ≤5m (ground) | 1.0× | 180m | 110m | 230m |
| 30m | 1.5× | 270m | 165m | 345m |
| 55m | 2.0× | 360m | 220m | 460m |
| 100m | 2.9× | 522m | 319m | 667m |
| ≥205m | 4.0× (cap) | 720m | 440m | 920m |

**Interaction with fog:** When `CONFIG.ENABLE_FOG: true`, the fog culling at `FOG_FULL_DIST = 280m` force-hides all vegetation and buildings beyond that edge distance, regardless of `bldgMaxDist`. At altitude with fog on, fog clips before the altitude-scaled `bldgMaxDist` becomes the limit — buildings beyond 280m from tile edge are fog-culled first. For drone mode, set `CONFIG.ENABLE_FOG: false` to fully benefit from the altitude multiplier.

**All four thresholds must be scaled together** — see gotchas.md G-19 for the dead-zone that results from partial scaling.

## LOD Building Visibility Invariant

The simplified LOD box (`lodBuildingMesh`) and detail building meshes (`buildingMeshes`) are mutually exclusive — they are **never both visible simultaneously**.

**The single source of truth is the LOD update loop** (`tileManager.js` around line 1980):
```js
const detailLoaded = entry.buildingMeshes && entry.buildingMeshes.length > 0;
entry.lodBuildingMesh.visible = !detailLoaded && nearEdgeDist > lodStart && nearEdgeDist <= lodEnd;
```

LOD box is visible **iff** (detail not yet loaded from worker) AND (tile edge distance in 110–230m band).
Detail buildings are visible **iff** tile edge distance ≤ 180m (plus a detail-only threshold of 120m).

**Do not add a second source of truth** (e.g., a worker-arrival callback that also sets `lodBuildingMesh.visible`). Having two places that set LOD visibility creates split-brain: whichever runs last wins, and the order depends on async timing. The LOD update loop runs every frame and is the correct place.

## Fog Culling Distance

The fog culling in the LOD update loop (`tileManager.js` around line 1854) hard-hides all vegetation, buildings, and details beyond a threshold distance:

```js
const FOG_FULL_DIST = CONFIG.ENABLE_FOG ? 280 : Infinity;
if (nearEdgeDist > FOG_FULL_DIST) { /* hide everything except roads */ }
```

When `ENABLE_FOG: false` (development mode), the threshold is `Infinity` — no forced culling. Vegetation, billboards, and buildings render at their configured distances (`TREE_MAX_DISTANCE`, `BUILDING_MAX_DISTANCE`, etc.).

When `ENABLE_FOG: true`, vegetation beyond 280m from tile edge is force-hidden regardless of per-feature distance configs. This is intentional: fog density 0.007 makes geometry at 280m ~90% transparent, so the GPU cost of rendering it is not justified.

---

## Road Markings — Norma 8.2-IC (Phase 1 Barcelona)

Road markings follow the Spanish national road standard **Norma 8.2-IC** (Instrucción de Carreteras 8.2-IC, Marcas Viales). The single source of truth for all road colors and dimensions is `frontend/src/map/barcelona-constants.js` — import `BCN_COLORS` and `BCN_DIMS` in any renderer that touches road visuals. Do not inline magic numbers.

Key values:
- All longitudinal lines: `BCN_COLORS.PAINT_WHITE` (0xf5f5f5) — Spain uses white only, no yellow center lines
- All longitudinal line width: `BCN_DIMS.LINE_WIDTH_LONGITUDINAL` (0.10m)
- Urban dash: 2.0m / 2.0m
- Crosswalk stripe: 0.50m wide / 0.50m gap

Crosswalks (`buildCrosswalks()` in `roadRenderer.js`) are placed at every eligible junction (primary/secondary/tertiary/residential) using `getJunctionPoints()`. LOD-culled at 80m via `entry.crosswalkMesh` in `tileManager.js`. The vertex cost is ~40 verts per approach; crosswalk geometry is tagged `userData.noMerge = true` and `type: 'crosswalk'` to survive `mergeMeshesByMaterial` as a distinct object.

**Important:** There are two marking color systems in `roadRenderer.js` — see gotchas.md G-20. Only the vertex-color path at lines ~1025-1026 actually drives what renders.

---

## Coastline Water Handling

`natural=coastline` ways in OSM are **open polylines** (the land/sea boundary), not closed area polygons. `waterRenderer.js` uses `THREE.Shape.closePath()` which draws a straight line from the last point back to the first. For an open coastline segment this closure crosses inland land, creating a filled triangle that covers road surfaces and tunnel approaches.

**Current behavior** (`RENDER_COASTLINE_AS_POLYGONS: false`, the default): coastline-typed water features are filtered out before rendering. No coastline polygon is rendered as a filled mesh. `waterRenderer.js` logs `[Water tileId] skipped N coastline polygon(s)` when any are filtered.

**Trade-off**: The open Mediterranean has no `natural=water` OSM polygon — it is defined only by the coastline boundary. Filtering coastline polygons means the open sea renders as bare terrain (green groundMesh). Only marina/dock/basin polygons and explicit `natural=water` polygons (lakes, reservoirs) show as blue.

**To fix properly**: Implement OSM coastline assembly using the right-hand rule (water is on the right side of travel direction). This would generate a correct closed sea polygon per tile, clamped to the tile boundary. Until then, `RENDER_COASTLINE_AS_POLYGONS` stays false.

### Open-polyline water filter (stream, canal, river)

Linear waterways (OSM `waterway=stream|canal|river`) come through as open polylines. `waterNormalize.js:bufferPolyline()` converts them to ribbon polygons, but sharp bends produce self-intersecting geometry that `THREE.ShapeGeometry` fills as spurious triangle lobes — visible as wedge-shaped blue patches where streams converge at the coast.

**Current behavior** (`RENDER_OPEN_WATER_AS_POLYGONS: false`, default): any water feature in `tileData.water[]` with first ≠ last point (gap ≥ 1m) is skipped before rendering. The per-tile log shows `open-polylines:N (stream:N canal:N)` for each tile that skips features.

**What is NOT affected**: Closed `natural=water` polygons (ponds, basins, fountains — gap < 1m) pass through. Marina/dock/basin polygons in `tileData.marinas[]` use a completely separate code path and bypass this filter regardless of their closure state (they are always closed rings by construction in `pbfAreaFeatures.js`).

**To fix properly**: Replace `bufferPolyline()` in `waterNormalize.js` with a proper offset-polygon algorithm (round joins at bends, miter-limit at near-parallel segments). Requires re-bake. See `roadmap.md`.

---

## Ocean Plane

A single 80 km × 80 km `PlaneGeometry` added to `scene` (not `worldGroup`) at normalized sea level:
```js
// main.js, inside spawnTileReady.finally()
const seaY = (0 - getWorldElevationOffset()) * vertExag - 0.15;
oceanPlane.position.y = seaY;  // just below sea-level terrain
oceanPlane.renderOrder = -1;   // renders before terrain; depth buffer covers it on land
scene.add(oceanPlane);         // NOT worldGroup — no X-mirror applied
```
The `groundMesh` (3000m, ocean blue) in `worldGroup` follows the camera at `seaY - 1.0m` (1m below ocean plane) as a near-camera fallback. Land terrain tiles render on top via depth buffer.

**Tunnel caveat:** Tunnel approach carvings go below sea level. The ocean plane is visible in the carved area before the tunnel enclosure starts. Fog masks this at distance; the tunnel enclosure mesh covers it up close.

---

## Renderer Setup

```js
// scene.js
renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.outputColorSpace  = THREE.SRGBColorSpace;
renderer.toneMapping       = THREE.LinearToneMapping;
renderer.toneMappingExposure = 1.25;
renderer.shadowMap.enabled = CONFIG.ENABLE_SHADOWS;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));  // cap at 2× for perf
renderer.info.autoReset    = false;  // so stats accumulate across EffectComposer passes
```

No HDR environment map is used for IBL — lighting is entirely from the two direct lights (ambient + directional). The car model may generate its own env map via `window._ddRenderer` in `carModel.js`.

---

## Post-Processing Chain

`EffectComposer` runs instead of a bare `renderer.render()`:

```
RenderPass (scene, camera)
    ↓
UnrealBloomPass (half-resolution)
    ↓
RadialBlurPass (custom ShaderPass — speed-gated)
    ↓
ColorGradePass (custom ShaderPass — sat/contrast/split-tone/vignette; uRally + uNight uniforms)
    ↓
OutputPass (gamma/color space conversion)
```

**Removed — GTAO (AO) and Bokeh (DOF):** both were tried for the art-of-rally look but each re-renders the
ENTIRE scene into depth/normal buffers (GTAO: depth + normals = 2 extra full passes; Bokeh: depth = 1).
On the ~4M-tri streamed city that tripled effective triangle throughput (→ ~10M tris, ~33 FPS). GTAO also
smeared a dark blob behind the near-camera hero car and turned distant cloud/sprite quads into black
rectangles (their alpha cutout is ignored in the normal prepass, so the full quad reads as an occluder).
Grounding comes from the dir-light shadow map + fake contact shadows instead. **Do not re-add a
full-screen depth-prepass effect without a triangle budget** — screen-space AO in particular fights the
near-camera chase framing.

### UnrealBloom
```js
new UnrealBloomPass(
  new THREE.Vector2(Math.floor(w/2), Math.floor(h/2)),  // half-res for performance
  0.5,   // strength
  0.4,   // radius — soft spread
  1.1,   // threshold — above sky (~1.0 max) but reachable by emissive lights
)
```
Purpose: makes car headlights, tail lights, and streetlamp emissive materials glow. Threshold set above sky brightness so the sky dome never blooms.

On resize:
```js
bloomPass.resolution.set(Math.floor(w/2), Math.floor(h/2));
```

### RadialBlurPass (`ui/radialBlurPass.js`)
Custom `ShaderPass` that blurs screen edges radially from the center. Intensity scales with speed:
```js
radialBlurPass.uniforms.strength.value = Math.max(0, Math.min(1, (speed - 40) / 80));
// 0 at ≤40 km/h, 1 at ≥120 km/h
```
Creates a motion-blur tunnel vision effect at highway speeds.

### OutputPass
Handles color space conversion and any tone-mapping output transform.

---

## Lighting

### Ambient Light
```
color: 0xffe8c8 (warm amber)
intensity: 0.55
```
Fills shadowed areas; prevents completely dark undersides.

### Directional Light (Sun)
```
color: 0xffd9a0 (warm late-afternoon gold)
intensity: 1.2
position: sunDir × 1000  (elevation 35°, azimuth 200° SW)
castShadow: CONFIG.ENABLE_SHADOWS
shadow.mapSize: max(2048, CONFIG.SHADOW_MAP_SIZE)
shadow.radius: 3 (soft edges — PCFSoft)
shadow.camera: orthographic ±120m, near=1, far=3000
shadow.bias: -0.0002
shadow.normalBias: 0.03
```

The shadow camera follows the player's camera position, updated **throttled** (only when camera moves > 5m):
```js
dirLight.position.set(camera.position.x + sunDir.x * 200, ...)
dirLight.target.position.set(camera.position.x, ...)
dirLight.target.updateMatrixWorld()
```

`dirLight.target` must be added to `scene` separately — Three.js requires this for the shadow camera to track the target.

### Streetlights
No dynamic `PointLight` per streetlamp. Instead:
- Lamp mesh uses an emissive material above the bloom threshold
- Ground pool: a decal mesh with a circular additive-blended glow texture
- This gives the visual appearance of lit streetlights without per-light shadow maps or per-frame light updates

---

## Sky and Atmosphere

### Sky Dome
`IcosahedronGeometry(40000, 4)` with a custom `ShaderMaterial`:
- `BackSide` rendering (camera is inside the sphere)
- `depthWrite: false`
- Gradient: horizon (`#BFD7EE`) → mid-sky blue (`0.58, 0.76, 0.90`) → top (`#6FAEDB`)
- Uses `smoothstep` for natural blending; horizon band extends below eye level so ground+sky seam is hidden

### Fog
```js
scene.fog = new THREE.FogExp2(0x9dc2db, 0.007)
```
- Matches the horizon sky color
- At density 0.007: objects at ~180m are 70% fogged, at ~280m are >90% fogged
- Also acts as LOD — objects at 280m are fog-culled in software (hidden by `tileManager` LOD, not GPU clipping)

### Clouds
12 billboarded `THREE.Sprite` objects procedurally textured on a `<canvas>` (deterministic RNG per seed). Three rings at different altitudes (350m, 600m, 1000m). Parallax follow at 0.05–0.15 of camera movement (high clouds move slower than low clouds).

### Moon
Two overlapping `Sprite`s (moon disc + glow halo), visible only at night. Canvas-generated texture with maria and craters. Parallax follow at 0.02 (barely moves — correct for distant object).

### Stars
`THREE.Points` with 1500 vertices on a sphere of R=20,000m (upper hemisphere only). Follows camera position exactly (always overhead). Visible only at night.

---

## Materials and Geometry

### Road Materials
Shared `MeshLambertMaterial` instances per highway type (created once, reused across all tiles). Road ribbon geometry is `THREE.BufferGeometry` with position, normal, UV, and (optionally) halfWidth attributes. Markings (center line, edge, lane dividers) are separate geometry with `MeshBasicMaterial` (unlit — markings should be flat color regardless of light direction).

### Building Materials
`MeshLambertMaterial` with color derived from OSM `colour` tag or building type lookup. Roof uses a slightly lighter/different material. Large buildings may get a glass-effect material (semi-transparent + emissive).

### Terrain Material
`MeshLambertMaterial` with vertex colors (vertex color set by elevation band — greener at lower elevation, browner at higher). A detail texture (`grass.15f2422c.jpg`) is blended via shader or UV map. Receives shadows.

### Tree Materials
- 3D trees: `BatchedMesh` or `InstancedMesh` using pre-built geometry (cylinder trunk + cone crown, or loaded GLB variants). `MeshLambertMaterial` with vertex color tinting for variety.
- Billboard trees: `InstancedMesh` of quads with `AlphaTest` tree sprite texture. `DoubleSide` (since `worldGroup.scale.x=-1` can flip winding toward camera).

### Grass Material
`ShaderMaterial` with wind animation:
```glsl
// Uniform updated every frame: updateGrassWind(time/1000)
// Blades sway sinusoidally based on position + time
```

### Water Material
Semi-transparent `MeshLambertMaterial`, flat at `SEA_LEVEL = 0`, polygon-based (no height-displaced mesh).

---

## Geometry Merging

After rendering, `mergeMeshesByMaterial()` (`tileManager.js:95`) is called on road meshes and optionally other arrays. This reduces draw calls by merging all meshes that share the same material reference AND the same attribute layout into a single geometry.

```js
// Groups by: material identity + attribute signature (names + itemSizes)
// Excluded from merging:
//   - InstancedMesh
//   - Groups (THREE.Group)
//   - Meshes with array materials
//   - mesh.userData.noMerge = true
// Yields every 2 merges to stay within frame budget
```

Source geometries are disposed after merging. The result mesh copies `castShadow`, `receiveShadow`, `frustumCulled`, `renderOrder` from the first source mesh.

---

## Performance Budget and Yielding

### Frame budget (`yieldToMain`)
```js
const FRAME_BUDGET_MS = 6;   // max ms of tile work per frame
```
Called between each major tile-build step. If elapsed time since last yield < 6ms, returns immediately (no frame gap). If > 6ms, waits one `requestAnimationFrame` (gives browser time to render). This keeps tile geometry work within ~6ms of each frame, leaving ~10ms for rendering at 60fps.

### Performance panel metrics
`performancePanel.js` displays (when `ENABLE_PERFORMANCE_PANEL: true`):
- FPS (rolling average)
- Draw calls (`renderer.info.render.calls`)
- Triangles (`renderer.info.render.triangles`)
- Active tiles, buildings, trees, road meshes
- Physics body count
- Camera Y (for elevation debugging)

Warning thresholds: triangles > 400k or FPS < 40 (`PERF_WARN_TRIANGLES`, `PERF_WARN_FPS`).

### NaN guard
`safeSceneAdd()` checks the first 90 + last 30 positions in a mesh's position buffer for NaN before adding to the scene. NaN geometry causes the renderer to emit nothing (or error) for that draw call.

---

## Shadow Camera Update

The directional light's shadow camera must track the player. Updating it every frame wastes CPU (shadow map re-render). Instead, it's throttled:

```js
const SHADOW_UPDATE_THRESHOLD_SQ = 5 * 5;  // 5m movement threshold
if (camera moved > 5m since last update):
    dirLight.position.set(camera.position + sunDir * 200)
    dirLight.target.position.set(camera.position)
    dirLight.target.updateMatrixWorld()
```

Without `dirLight.target.updateMatrixWorld()`, Three.js won't move the shadow camera even if target.position changed.

---

## Resize Handling

```js
window.addEventListener('resize', () => {
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h)
    composer.setSize(w, h)
    bloomPass.resolution.set(Math.floor(w/2), Math.floor(h/2))
})
```

The bloom pass must be explicitly resized — it does not automatically respond to composer size changes.

---

## Debug Rendering

- `CONFIG.DEBUG_COLLIDERS = true`: Renders wire-frame meshes for all CANNON bodies via `updateDebugColliders(scene, world)`
- `CONFIG.DEBUG_PHYSICS_DECKS = true`: Renders wire-frame boxes for road deck colliders and heightfield bounds only
- `CONFIG.DEBUG_ROAD_WIREFRAMES = true`: Overlays colored wire-frame on road meshes (color = layer/ramp/bridge classification)
- `CONFIG.DEBUG_TREE_SOURCES = true`: Draws colored lines from each tree to its source road
