/**
 * Global feature toggles. All systems check these before generating geometry.
 * Change here to enable/disable features; no geometry is created when disabled.
 */
// The tree-card manifest, imported for its species COUNT alone (see NUM_TREE_VARIANTS below).
// Importing it here cannot create a cycle: JSON is inert data with no imports of its own.
import TREE_ATLAS from './map/treeAtlas.js';

// Variant count of the legacy blob path (TREE_VARIANTS in map/vegetationRenderer.js). Duplicated
// here because config must not import the renderer — treeCards.test.js asserts the two agree.
const LEGACY_TREE_VARIANT_COUNT = 4;

// Read once at load, like every other URL switch. Hoisted out of the CONFIG literal because
// NUM_TREE_VARIANTS below is derived from it and CONFIG cannot reference itself while being built.
const TREE_CARDS_ON = (() => {
  try { return new URLSearchParams(location.search).get('treecards') !== '0'; } catch { return true; }
})();
/** URL flag test that is safe in Node (tests import this module with no `location`). */
function _urlHas(name) {
  try { return typeof location !== 'undefined' && new URLSearchParams(location.search).has(name); }
  catch { return false; }
}

// export const CONFIG = {

//   ENABLE_BUILDINGS: true,
//   ENABLE_SIDEWALKS: true,
//   ENABLE_TREES: true,
// //   ENABLE_PROCEDURAL_INFILL: true,
//   /** Enable shadow mapping (sun only); use PCFSoftShadowMap. */
//   ENABLE_SHADOWS: true,
//   /** Shadow map resolution (max 1024 for performance). */
//   SHADOW_MAP_SIZE: 1024,
// };

export const CONFIG = {
  /**
   * v3 P3-04 — facade array-texture path. OPT-IN via `?facadearray=1`.
   *
   * Lives on CONFIG rather than being read from `location` in each module because the BUILDING
   * WORKER needs it too, and a Web Worker's `location` is its own script URL — reading the flag
   * there returns nothing and the switch does half its job: the material samples the arrays while
   * the geometry still carries legacy UVs, painting windows where the shopfront belongs. CONFIG is
   * already sent to the worker with every tile, so it is the channel that exists.
   *
   * Default OFF: the placeholder layers are plainer than today's canvas facade by design. Flip when
   * P3-05's authored layers land, not before.
   */
  /** v3 P3-03 — per-tile winding-normalisation report. Opt-in via `?debug=winding`; fires per tile. */
  /**
   * v3 P3-07 — asphalt v2 (world-metric UV, macro wear, wheel ruts). ON by default.
   *
   * `?roadv2=0` turns it off. It exists so a frame-cost question can be ANSWERED rather than argued:
   * roads have the largest screen coverage in the game and sit on a MeshStandardMaterial, so any
   * per-fragment work added here is felt. Drive the same street with and without.
   */
  ROAD_V2: (() => {
    try { return new URLSearchParams(location.search).get('roadv2') !== '0'; } catch { return true; }
  })(),

  /**
   * v3 P3-10 — photographic crossed-quad tree cards. ON by default.
   *
   * `?treecards=0` falls back to the legacy icosahedron blobs. Like ROAD_V2 this is an ATTRIBUTION
   * switch, not a preference: cards trade ~80 triangles per tree for 4 plus an alpha-tested
   * fragment, which moves cost from vertex to fill. Whether that is a win at Eixample tree density
   * is a question to be MEASURED on the same street both ways.
   */
  TREE_CARDS: TREE_CARDS_ON,

  /**
   * How many tree variants exist — 6 card species, or 4 legacy blob variants.
   *
   * This is CONFIG rather than a worker constant because the vegetation worker buckets trees by
   * variant index and meshMaterializer DROPS any bucket whose index is past the end of the geometry
   * array. An over-count therefore does not warn, it silently deletes part of the city's trees.
   * treeCards.test.js asserts this equals the live geometry count in both switch positions.
   */
  NUM_TREE_VARIANTS: TREE_CARDS_ON ? TREE_ATLAS.species.length : LEGACY_TREE_VARIANT_COUNT,

  /**
   * How many tree variants exist — 6 card species, or 4 legacy blob variants.
   *
   * This is CONFIG rather than a worker constant because the vegetation worker buckets trees by
   * variant index and meshMaterializer DROPS any bucket whose index is past the end of the geometry
   * array. An over-count therefore does not warn, it silently deletes a third of the city's trees.
   * treeCards.test.js asserts this equals the live geometry count for both switch positions.
   */

  DEBUG_WINDING: (() => {
    try { return new URLSearchParams(location.search).get('debug') === 'winding'; } catch { return false; }
  })(),

  /**
   * `?debug=init` — boot chatter: what the asset registry, light grid, physics and adaptive
   * resolution did on the way up.
   *
   * ⚠ This flag was DOCUMENTED and REFERENCED but never defined. `CONFIG.DEBUG_INIT` read as
   * undefined in loaders.js and tileManager.js, so `?debug=init` silently did nothing and the
   * lines it was meant to gate printed on every boot instead. Two failures in one: the opt-in
   * output was unreachable and the opt-out output was mandatory.
   *
   * NOT gated, deliberately: `[quality] tier` and `[perf] time-to-drive` are gate metrics that
   * must show up unasked, and anything reporting a FAILURE is never chatter.
   */
  DEBUG_INIT: (() => {
    try { return new URLSearchParams(location.search).get('debug') === 'init'; } catch { return false; }
  })(),

  /**
   * `?debug=leak` — task #39. Per-tile-unload geometry accounting.
   *
   * The drive report already SEES the leak — geometry count rises at constant tile count — but a
   * drift number cannot say which of two very different things is happening:
   *
   *   · the unload walk holds a geometry and fails to free it  → `held` and `freed` disagree
   *   · geometry exists that the tile entry never tracked      → both agree, and the renderer's
   *     own count still climbs
   *
   * Those need opposite fixes, so the probe reports both sides: what the walk held and freed, and
   * what `renderer.info.memory.geometries` actually did across the same unload. Off by default and
   * free when absent.
   */
  DEBUG_LEAK: (() => {
    try { return new URLSearchParams(location.search).get('debug') === 'leak'; } catch { return false; }
  })(),

  /**
   * v3 P3-04/P3-05 — array-texture facade path. ON by default as of 2026-08-26.
   *
   * It was opt-in (`?facadearray=1`) because P3-04 shipped the SHADER PATH against PLACEHOLDER
   * layers — flat tinted rectangles that proved the plumbing and looked worse than the vertex-colour
   * facades they replaced. P3-05 supplies the real art: 8 authored 1024² body layers at 128
   * texels/m, shipped as one KTX2 array so they stay GPU-compressed (21 MiB rather than 85).
   *
   * `?facadearray=0` reverts to the vertex-colour path — an ATTRIBUTION switch like ROAD_V2, since
   * facades are the largest vertical surface in the game and this adds an array sample per fragment.
   */
  FACADE_ARRAY: (() => {
    try { return new URLSearchParams(location.search).get('facadearray') !== '0'; } catch { return true; }
  })(),

  /** Road-only debug: when true, render only roads (no buildings, trees, grass, greens). Set false when tiles include buildings and greens. */
  ROAD_ONLY_DEBUG: false,

  /** When true, driving mode with car physics + chase camera. When false, free orbit camera. */
  ENABLE_CAR: true,   // default = drive (car). Fly mode is opt-in via Settings (dd_flyMode) or ?mode=fly.

  // ── Car physics tuning ─────────────────────────────────────────────────────
  CAR_CHASSIS_MASS:       1200,   // kg
  SUSPENSION_STIFFNESS:   35,     // N/m (slightly stiffer for ramp transitions)
  SUSPENSION_DAMPING:     4.4,    // rebound damping
  SUSPENSION_COMPRESSION: 2.3,    // compression damping
  SUSPENSION_REST_LENGTH: 0.35,   // metres
  SUSPENSION_MAX_TRAVEL:  0.4,    // metres (handles ramps, sidewalk bumps)
  MAX_ENGINE_FORCE:       4000,   // N  (RWD rear wheels; needs ≥3400 N to climb a 17° flyover ramp at 1200 kg)
  MAX_BRAKE_FORCE:        80,     // N  (front)
  MAX_STEER_ANGLE:        0.5,    // radians (~28°)

  // ── CITY RESTORE (2026-06-30): terrain/tunnel rework landed → un-stripping the city.
  // Buildings + trees back on first (biggest visual impact); sidewalks/traffic-lights/infill
  // remain off pending their own verification pass on the new terrain.
  ENABLE_BUILDINGS: true,
  ENABLE_SIDEWALKS: true,     // OSM-driven panot sidewalks (Phase 2 bake provides road.sidewalk)
  // `?notrees` / `?norails` — LOOK-AT-THE-ROAD switches, not preferences.
  //
  // Diagnosing road geometry means seeing the carriageway, and trees and barriers are the two
  // things standing directly in front of it. Read once at load like every other URL toggle here
  // (CLAUDE.md), so a reload is the whole workflow. Neither touches road DATA — they hide what is
  // drawn on top of it, so a merge fixed with `?norails` on is still fixed with rails back on.
  ENABLE_TREES: !_urlHas('notrees'),
  ENABLE_GUARD_RAILS: !_urlHas('norails'),
  ENABLE_PROCEDURAL_INFILL: false, // Delhi-era procedural building infill — keep off
  ENABLE_TRAFFIC: true, // AI traffic cars driving the loaded road network (car mode only)
  ENABLE_PARKED_CARS: true, // instanced parked cars lining both curbs (the Barcelona look)
  ENABLE_PEDESTRIANS: true, // real low-poly people baked to static instanced meshes (light crowd)


  /** When true, scene fog (FogExp2) is applied; when false, no fog. */
  ENABLE_FOG: true,
  ENABLE_SHADOWS: true,
  SHADOW_MAP_SIZE: 1024,

  /** Roadside/tree-base bush tufts. ON as of 2026-08-26 (v3 P3-10 follow-on).
   *
   *  It was OFF with the note "they scattered clumps over streets and crosswalks". That was a
   *  PLACEMENT fault, not a look fault: every bush push site was guarded by the vegetation mask,
   *  which is a road-EDGE test, but bushes never got `isOnGroundRoad` — the road-SURFACE check
   *  trees have. So a bush could land on a crosswalk where a tree could not. That guard is now in
   *  (`collectBushPositions`), which is what makes turning this back on defensible rather than
   *  hopeful. If tufts reappear on crosswalks, this is the flag and that is the function.
   *
   *  ⚠ v3 P1-17: gates the LIVE path (vegetationRenderer's bush seam + meshMaterializer's bush
   *  branch), NOT the deleted GLB bushRenderer.js. meshMaterializer tests `!== false`. */
  ENABLE_BUSHES: true,


  /**
   * Bushes kept per tile, decimated from the baked 3,000.
   *
   * Measured with `_ddVegCount()` on Gran Via: 30,303 bush instances resident against 24,866 trees.
   * A tile carries FIVE times as many bushes as trees, which was affordable when a bush was an
   * untextured 100-tri blob and is not once each one is a textured card with its own instance
   * matrix and colour in a BatchedMesh data texture.
   *
   * Decimated on the FRONTEND (a stride over the baked list) rather than at the bake, so this is a
   * reload to change instead of a 10-minute re-bake. The bake keeps all 3,000 — raise this and they
   * come straight back.
   */
  MAX_BUSHES_PER_TILE: 1200,
  /** Grass instances per tile. 0 = off. ⚠ v3 P1-17: the RENDER path is deleted, but
   *  vegetationWorker reads `config.MAX_GRASS_PER_TILE ?? 50000` — so deleting this flag would
   *  make the worker collect 50k grass points per tile. Keep it pinned at 0. */
  MAX_GRASS_PER_TILE: 0,

  /** Max tree instances per tile. Halved (was 3000) — 128k trees / 4M tris was a big FPS drain. */
  MAX_TREES_PER_TILE: 1500,
  /** Distance (m) within which all tree instances are shown at full density. */
  TREE_FULL_DISTANCE: 80,
  /** Distance (m) beyond which 3D trees fade to billboards — fog (~190m vis) masks the transition.
   *  300→220→170: geometry is already minimal (3-side trunk, detail-0 foliage ~117 tris/tree), so the
   *  only tree lever is how many stay 3D. Area ∝ r²: 170²/220² ≈ 0.6 → ~40% fewer 3D trees vs 220. */
  TREE_MAX_DISTANCE: 170,
  /** Distance (m) beyond which full-detail building meshes are hidden. 280→250: buildings are the
   *  bulk of the triangle count and always render full geometry (LOD boxes are only a load placeholder,
   *  not a distance LOD). 250m is far enough that pop-in stays subtle at driving speed. */
  BUILDING_MAX_DISTANCE: 250,
  /** Distance (m) at which simplified LOD buildings start appearing. */
  BUILDING_LOD_START: 200,
  /** Distance (m) beyond which even LOD buildings are hidden. */
  BUILDING_LOD_END: 380,
  /** Shop name boards on building fronts (random Spanish/English names, atlas-instanced). */
  ENABLE_SHOP_SIGNS: true,
  /** Projecting fabric awnings (toldos) over ground-floor shopfronts — one merged mesh per tile. */
  ENABLE_AWNINGS: true,
  /** Café terraces (parasol + table + chairs) on sidewalks in front of some shops — 2 instanced meshes/tile. */
  ENABLE_CAFE_TERRACES: true,
  /** Ground-floor shopfronts (glass windows + door + frame) under the awnings — 2 merged meshes/tile. */
  ENABLE_SHOPFRONTS: true,

  /** ⚠ v3 P1-08: device quality is owned by src/quality.js, NOT by a CONFIG flag — it has to be
   *  decided before the renderer exists and is read by the asset registry, the shadow setup and the
   *  adaptive-resolution cap. Override with ?quality=low|high. SHADOW_MAP_SIZE below is the
   *  DESKTOP value; the low tier halves it. */

  /** Show top-right performance debug panel (FPS, draw calls, scene counts, tiles, memory). */
  ENABLE_PERFORMANCE_PANEL: true,

  /** Optional: warn when triangles > 400k or FPS < 40. */
  PERF_WARN_TRIANGLES: 400000,
  PERF_WARN_FPS: 40,

  /** DEM terrain: when true, fetch elevation per tile and layer roads/buildings/vegetation on it. */
  /** Render railway lines from OSM (rail, light_rail, subway, tram). */
  /** Tram rails (railway=tram) embedded flush in the road surface, separate from heavy rail.
   *  ⚠ v3 P1-25: this IS honoured — but inside railwayRenderer.js:119, not at the tileManager call
   *  site, whose comment claims trams are "always rendered when present". The comment is wrong and
   *  the flag is right: with this false, createTramMeshes() returns null and NO trams render.
   *  Deleting this flag TURNS TRAMS ON (`!undefined` is true), which is a visual change, not a
   *  cleanup. Barcelona does have a real tram network, so switching this on is a legitimate scope
   *  decision — but it is a decision, and it belongs to P4 signage/infra, not to a P1 tidy-up. */
  ENABLE_TRAM_TRACKS: false,
  ENABLE_RAILWAYS: false,
  /** Phase 4B-1: octagonal asphalt fill at Eixample-scale crossing junctions (chamfered plazas). */
  ENABLE_CHAMFER_FILLS: false,
  /** Phase 4B-2: triangular panot sidewalk corners at chamfer junction edges. */
  ENABLE_CHAMFER_SIDEWALKS: false,
  /** Phase 4B-2: diagonal L-profile granite curb along chamfer edges. */
  ENABLE_CHAMFER_CURBS: false,
  /** Phase 4C-A: "30" speed stencils on ZONA 30 residential/tertiary roads. */
  ENABLE_ZONA_30: false,
  /** Phase 4C-A: tactile paving dots at crosswalk-sidewalk transitions. */
  ENABLE_TACTILE_PAVING: false,
  /** Phase 4C-B: blue continuous stripe for Zona Blava paid parking (parking:*:fee=yes). */
  ENABLE_BLUE_PARKING_ZONES: false,
  /** Phase 4D-2: skip barrier=wall polygons whose midpoint is within 5m of a building centroid (ghost-wall filter). */
  ENABLE_GHOST_WALL_FILTER: true,
  /** Phase 4A: yellow no-parking/no-stopping curb stripes from parking:lane:* OSM tags. Re-bake required. */
  ENABLE_NO_PARKING_STRIPES: false,

  ENABLE_TERRAIN: true,
  /** Hide terrain visual mesh but keep physics collision — lets you see what's underneath. */
  TERRAIN_INVISIBLE: false,
  /** Terrain sampling: 'bilinear' or 'bicubic'. Should match backend terrainSamplingMode. */
  terrainSamplingMode: 'bilinear',
  /** Terrain grid points per axis for visual mesh. Lower = fewer triangles, fog hides detail. */
  TERRAIN_GRID_SIZE: 32,
  /** Max terrain grid points per axis (triangle cap). MUST equal the bake's bakedTerrain.gridSize
   *  (terrainBaker.js GRID_SIZE) — the useBaked gate is `bakedTerrain.gridSize === maxGrid`, so a mismatch
   *  silently forces the runtime FALLBACK mesh. 128 = full DEM grid (no downsample) so the terrain mesh
   *  matches the roads' DEM sampling → roads conform (no "road inside terrain"). (TERRAIN_GRID_SIZE above is dead.) */
  TERRAIN_MAX_GRID: 128,
  /** Vertical exaggeration for elevation (terrain and roads). 1 = real scale; 2–3 = more visible hills. */
  ELEVATION_VERTICAL_EXAGGERATION: 1,

  /** Elevation convention: backend bakes road point Y in absolute DEM meters (terrain + bridge/tunnel). When true, frontend treats road.points[].elevation as raw and subtracts worldElevationOffset once, then × ELEVATION_VERTICAL_EXAGGERATION. When false, baked Y is already normalized (do not subtract). */
  BAKED_ROAD_ELEVATION_IS_RAW: true,

  /** When true, render wireframe boxes for deck/ramp colliders and heightfield bounds (debug). */
  DEBUG_PHYSICS_DECKS: false,
  /** When true, render colored wireframes for ALL physics colliders (ground, heightfield, boxes, walls). */
  DEBUG_COLLIDERS: false,
  /** When true, draw colored lines from each tree to its source road (debug tree placement). */
  DEBUG_TREE_SOURCES: false,
  /** When true, overlay colored wireframes on road meshes (color = layer/ramp/bridge type). */
  DEBUG_ROAD_WIREFRAMES: false,

  ENABLE_PARKING: false,
  ENABLE_BARRIERS: false,
  /** Physics collision on street trees. OFF — trees line the curb, so collision made the car stop dead
   *  the moment it touched a sidewalk. Trees are now decorative (drive-through); buildings still block. */
  ENABLE_TREE_COLLISION: false,
  ENABLE_BUS_STOPS: true, // bus shelters on the sidewalks
  ENABLE_STREETLIGHTS: true, // procedural poles + lamp heads along road edges; glow at night (bloom)
  MAX_DYNAMIC_STREETLIGHTS: 8,
  ENABLE_WATER: false,
  /**
   * When false (default), natural=coastline water features are NOT rendered as
   * filled polygons. Coastline ways in OSM are open polylines; THREE.Shape.closePath()
   * draws a straight-line closure that fills inland land area, causing blue water to
   * appear inside tunnel approaches near the coast. Set true only if/when proper
   * coastline-polygon assembly (OSM right-hand rule) is implemented.
   */
  RENDER_COASTLINE_AS_POLYGONS: false,
  /**
   * When false (default), open-polyline water features (stream, canal, river, etc.)
   * are NOT rendered as filled polygons. These come from OSM linear waterway ways;
   * waterNormalize.js buffers them into ribbons via bufferPolyline(), but sharp bends
   * in the centerline produce self-intersecting polygons whose interior fills as
   * unexpected triangular lobes. Set true only after bufferPolyline is replaced with
   * a proper offset-polygon algorithm that handles round/miter joins (see roadmap.md).
   */
  RENDER_OPEN_WATER_AS_POLYGONS: false,
  ENABLE_URBAN_FEATURES: true, // fountains, fire hydrants, public toilets, etc. from OSM
  ENABLE_ROAD_INFRA: true,     // traffic lights, speed/direction signs, lane arrows, road-name boards, drain covers
  /** Zebra crosswalks (paso de cebra) at every eligible junction. Norma 8.2-IC: 0.50m stripe / 0.50m gap.
   *  Phase 1 Barcelona road overhaul. LOD-culled at 80m to control vertex budget. */
  ENABLE_CROSSWALKS: true, // zebra crossings at junctions — stripe height now interpolated along the road + unshaded bright paint
  /** Granite kerb L-profile (top + road-facing vertical face), textured — v3 P3-09.
   *
   *  ON as of 2026-08-26. It read `false` while kerbs rendered on all 409 v9 tiles regardless,
   *  because only the procedural path (`buildCurbs`) checked it and the baked path
   *  (`buildBakedSidewalkMeshes`) did not. The flag now gates both, so it is finally an honest A/B
   *  switch — and honest means it has to say what is actually happening, which is that kerbs are on. */
  ENABLE_CURBS: true,
  ENABLE_BIKE_LANES: false,   // Phase 3: green bike lane surface + bike pictograms (InstancedMesh)
  /** One-way direction arrows (→) painted on road surface every 30m. Norma 8.2-IC.
   *  Requires road.oneway data from Phase 2 re-bake. LOD-culled at 80m. */
  ENABLE_ONEWAY_ARROWS: false,
  ENABLE_TUNNELS: true,
  /** Simple-tunnel mode: when false, tunnel VISUALS (enclosure walls, ceiling, LED, portal trench, retaining
   *  walls, gates) are NOT rendered — just the road descending into the carved terrain hole + ramp. Physics
   *  colliders (tunnel walls, ramp, approach walls) stay ON regardless, so the car drives through contained. */
  ENABLE_TUNNEL_VISUALS: false,
  /** Retaining walls along tunnel approach ramps — visual walls AND the L0 approach-road
   *  physics colliders (createApproachWallColliders) that contain the car on the deck.
   *  Required: the physics terrain cut is far wider than the deck, so without these the car
   *  drops off the deck edge into the over-cut strip (Phase-2 Option A). */
  ENABLE_RETAINING_WALLS: true,
  /** Portal frames at pedestrian/footway tunnel endpoints (no interior geometry). */
  ENABLE_PEDESTRIAN_PORTALS: false,

  ENABLE_CAR_LIGHTS: true,       // headlight SpotLights + brake/tail emissive
  ENABLE_SKID_MARKS: true,       // tyre skid decals on hard turns, braking & handbrake drift (driven by physics.getSkidLevel)
  ENABLE_TIRE_SMOKE: false,      // billboard smoke sprites (off by default for perf)
};
