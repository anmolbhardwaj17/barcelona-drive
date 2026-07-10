/**
 * Barcelona driving simulator: scene, tile streaming, UI, day/night cycle.
 */
import { initAnalytics } from './analytics.js';
initAnalytics();   // Cloudflare Web Analytics — no-op unless VITE_CF_BEACON is set at build time.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { createRadialBlurPass } from './ui/radialBlurPass.js';
import { warmupBegin, warmupEnd } from './map/gpuWarmup.js';

// DEV-only physics benchmark: cannon-es vs Rapier on a tile-world-like load. Dynamic import + DEV gate ⇒
// never in the production bundle. Trigger with ?bench=physics, or window._benchPhysics() from the console.
if (import.meta.env.DEV && new URLSearchParams(location.search).get('bench') === 'physics') {
  import('./bench/physicsBench.js').then((m) => m.benchPhysics()).catch((e) => console.warn('[bench] failed', e));
}
import { createColorGradePass } from './ui/colorGradePass.js';
import { createAdaptiveResolution } from './ui/adaptiveResolution.js';
import { createScene, updateClouds, updateMoon, updateStars } from './scene.js';
import { createTileManager, setMapTileCallbacks } from './map/tileManager.js';
import { updateTrafficLights } from './map/roadInfraRenderer.js';
import { createRoadMeshes, setRendererAnisotropy } from './map/roadRenderer.js';
import { setLampEmissiveIntensity, setPoolOpacity } from './map/streetlightRenderer.js';
import { updateTowerBeacons } from './map/urbanFeatureRenderer.js';
import { createEnvToggle, onNightModeChange } from './ui/envToggle.js';
import { createBuildingMeshes } from './map/buildingRenderer.js';
import { renderVegetation, preloadTreeModels, updateTreeWind } from './map/vegetationRenderer.js';
import { updateGrassWind } from './map/grassRenderer.js';
import { createSpatialIndex, queryNearestRoadSegment } from './map/spatialIndex.js';
import { createStreetDisplay } from './ui/streetDisplay.js';
import { createSpeedDisplay } from './ui/speedDisplay.js';
import { createSpeedLines } from './ui/speedLines.js';
import { createMetricsPanel } from './ui/metricsPanel.js';
import { isInputBlocked, isTypingTarget } from './inputGate.js';
import { isRallyStyle } from './rallyStyle.js';
import { createMinimap } from './ui/minimap.js';
import { createCustomMap } from './ui/customMap.js';
import { loadCityMap } from './ui/cityMapLoader.js';
import { createCompassBar } from './ui/compassBar.js';
import { createPerformancePanel } from './ui/performancePanel.js';
import { createGpuTimer } from './ui/gpuTimer.js';
import { createCpuTimer } from './ui/cpuTimer.js';
import { createPerfLogger } from './ui/perfLogger.js';
import { createEscMenu } from './ui/escMenu.js';
import { worldToLatLon, latLonToWorld, latLonToTile, tileToBBox, TILE_ZOOM } from './projection.js';
import { getActiveSpawn, START_LAT, START_LON } from './spawnConfig.js';
import { loadTile, clearTileCache } from './map/mapLoader.js';
import { getElevationFromGrid } from './map/terrainRenderer.js';
import { setWorldElevationOffset, getWorldElevationOffset } from './elevationOffset.js';
import { toNormalizedRoadY } from './roadElevation.js';
import { setOriginOffset, getOriginOffset } from './originOffset.js';
import { CONFIG } from './config.js';
import * as timeSystem from './timeSystem.js';
import { createDayNight } from './dayNight.js';
import { createFreeCameraController, getStreamPositionFromCamera } from './camera/freeCameraController.js';
import { createCarDriver } from './car/carDriver.js';
import { createTrafficSystem } from './car/trafficSystem.js';
import { createParkedCars } from './car/parkedCars.js';
import { createPedestrians } from './car/pedestrians.js';
import { createDashMode } from './game/dashMode.js';
import { createTaxiMode } from './game/taxiMode.js';
import { createDeliveryMode } from './game/deliveryMode.js';
import { createPoliceMode } from './game/policeMode.js';
import { audio } from './audio/audioManager.js';
import { createContactShadows } from './car/contactShadows.js';
import { updateDebugColliders } from './debugColliders.js';
import { initTunnelDebug, updateTunnelDebug } from './tunnelDebugOverlay.js';
import { initCollisionDebug, updateCollisionDebug } from './collisionDebug.js';
import { initWorkerPool } from './workers/workerPool.js';

const container = document.getElementById('app');
container.tabIndex = 0;
container.addEventListener('click', () => container.focus(), { once: false });
const { scene, camera, renderer, world, groundBody, groundMesh, worldGroup, spawnCenter,
        ambientLight, hemiLight, dirLight, sky, sunDir } = createScene(container);

setRendererAnisotropy(renderer.capabilities.getMaxAnisotropy());
window._ddRenderer = renderer; // expose for env map generation in carModel
window._clearTileCache = clearTileCache; // dev: call after re-bake to flush IndexedDB cache

// Initialize Web Worker pool for off-thread tile geometry computation
initWorkerPool();

// Disable auto-reset so EffectComposer passes don't clear render stats
renderer.info.autoReset = false;

// ── Post-processing — radial blur on screen edges at speed ────────────────
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// True GPU frame-time meter — powers the panel's "capable FPS" so a 60 Hz vsync cap doesn't hide headroom.
const gpuTimer = createGpuTimer(renderer);
// Main-thread section timer — splits the JS frame (phys/ent/tiles/ui/rend) to find the CPU bottleneck.
const cpuTimer = createCpuTimer();
// Perf logger — "● REC PERF" button (bottom-left) records per-frame samples → downloads a JSON to analyze.
const perfLogger = createPerfLogger();
// NOTE: GTAO (ambient occlusion) and Bokeh (depth-of-field) were removed — each re-renders the ENTIRE
// scene for its depth/normal buffers (GTAO: depth + normals = 2 extra full passes; Bokeh: depth = 1),
// which tripled effective triangle throughput on the 4M-tri streamed city (→ ~10M tris, ~33 FPS) and
// GTAO's screen-space AO smeared a dark blob behind the near-camera hero car. Grounding now comes from
// the dir-light shadow map + fake contact shadows instead. Do NOT re-add a full-screen depth-prepass
// effect here without a triangle-budget plan.
// Bloom — makes lights, tail lights, headlights, streetlights glow
// Bloom at half resolution for performance — still looks great
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2)),
  isRallyStyle() ? 0.28 : 0.5, // strength — rally keeps bloom restrained/clean
  0.4,    // radius — soft spread
  1.1,    // threshold — above sky/clouds (~1.0 max) but reachable by car light emissives
);
composer.addPass(bloomPass);
const radialBlurPass = createRadialBlurPass();
composer.addPass(radialBlurPass);
const colorGradePass = createColorGradePass();
composer.addPass(colorGradePass);
window._colorGradePass = colorGradePass; // DevTools tuning: .uniforms.uGradeStrength.value
composer.addPass(new OutputPass());

// Adaptive resolution — auto-drops pixel ratio when the GPU is behind, restores it when there's
// headroom. Owns renderer/composer pixel-ratio + sizing from here on (keeps framerate smooth).
const adaptiveRes = createAdaptiveResolution(renderer, composer, bloomPass, {
  width: container.clientWidth || window.innerWidth,
  height: container.clientHeight || window.innerHeight,
});


// Day / Night toggle — created immediately so the day preset is applied before tile loads.
const envToggle = createEnvToggle({
  scene, renderer, ambientLight, hemiLight, dirLight, sky,
  setLampEmissiveIntensity, setPoolOpacity,
  // Day/night-aware bloom: lower threshold + more strength at night so lamps/windows/signs actually glow.
  setBloom: (strength, threshold) => { bloomPass.strength = strength; bloomPass.threshold = threshold; },
});

// Dynamic PointLights removed — emissive lamp material + ground pool decals
// provide the night streetlight look without per-frame multi-light overhead.

let dayNight = null;
if (CONFIG.ENABLE_DAY_NIGHT && spawnCenter) {
  dayNight = createDayNight(scene, spawnCenter);
}

if (CONFIG.ENABLE_TREES) {
  preloadTreeModels().catch((err) => console.warn('Tree models load failed:', err?.message || err));
}

const { lat: _spawnLat, lon: _spawnLon } = getActiveSpawn();
const { x: spawnTx, y: spawnTy } = latLonToTile(_spawnLat, _spawnLon, TILE_ZOOM);
let spawnTileData = null;
const spawnTileReady = loadTile(spawnTx, spawnTy)
  .then((data) => {
    spawnTileData = data;
    if (data?.elevation?.elevations?.length) {
      const spawnElev = getElevationFromGrid(data.elevation, _spawnLat, _spawnLon);
      setWorldElevationOffset(spawnElev);
    } else {
      setWorldElevationOffset(0);
    }
  })
  .catch(() => setWorldElevationOffset(0));

// URL mode override (mirrors ?debug=tunnel): ?mode=car / ?mode=fly toggles car vs free-camera
// without editing CONFIG.ENABLE_CAR. Also accepts ?car / ?fly shorthand. Falls back to CONFIG.
const ENABLE_CAR = (() => {
  try {
    const p = new URLSearchParams(window.location.search);
    const m = (p.get('mode') || '').toLowerCase();
    if (m === 'car' || m === 'drive') return true;
    if (m === 'fly' || m === 'free' || m === 'drone') return false;
    if (p.has('car')) return p.get('car') !== '0' && p.get('car') !== 'false';
    if (p.has('fly') || p.has('drone')) return false;
    // Persisted Settings preference (Fly-mode toggle) — used when no URL override.
    const fly = localStorage.getItem('dd_flyMode');
    if (fly === 'true') return false;
    if (fly === 'false') return true;
  } catch { /* no URL/storage access */ }
  return CONFIG.ENABLE_CAR;
})();
if (ENABLE_CAR !== CONFIG.ENABLE_CAR) {
  console.log(`[main] mode override via URL: ${ENABLE_CAR ? 'CAR (drive)' : 'FLY (free camera)'} (CONFIG.ENABLE_CAR=${CONFIG.ENABLE_CAR})`);
}

let tileManager;
let freeCameraControls;
let carDriver = null;
let rapierAdapter = null;   // set when ?physics=rapier — streams the collider working set around the car
let dashMode = null;
let taxiMode = null;
let deliveryMode = null;
let policeMode = null;
let recoverHint = null;
let _flipT = 0;
let _captureRequested = false;   // Photo Mode capture: read the canvas next render (declared early — animate() may run before the Photo Mode block)
let trafficSystem = null;
let parkedCars = null;
let pedestrians = null;
let contactShadows = null;
let streetDisplay;
let speedDisplay;
let speedLines;
let metricsPanel;
let minimap;
let customMap;
let compassBar;
let performancePanel;
let escMenu = null;

function tileKey(tx, ty) {
  return `${tx}_${ty}`;
}

// ── Road-snap spawn: find nearest suitable road and compute heading ──────────
const PREFERRED_ROAD_TYPES = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]);
const ACCEPTABLE_ROAD_TYPES = new Set([
  'residential', 'unclassified', 'living_street', 'service',
]);

function findRoadSpawn(tileData, fallback) {
  if (!tileData?.roads?.length) return { wx: fallback.x, wz: fallback.z, heading: Math.PI, elevRaw: null };

  const sx = fallback.x, sz = fallback.z;
  let bestRoad = null, bestDistSq = Infinity, bestSegIdx = 0, bestT = 0;
  let acceptRoad = null, acceptDistSq = Infinity, acceptSegIdx = 0, acceptT = 0;

  for (const road of tileData.roads) {
    if (road.bridge || road.tunnel) continue;
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const ht = road.highwayType || '';
    const preferred = PREFERRED_ROAD_TYPES.has(ht);
    const acceptable = ACCEPTABLE_ROAD_TYPES.has(ht);
    if (!preferred && !acceptable) continue;

    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i].x, az = pts[i].y;
      const bx = pts[i + 1].x, bz = pts[i + 1].y;
      const dx = bx - ax, dz = bz - az;
      const lenSq = dx * dx + dz * dz;
      if (lenSq < 0.01) continue;
      let t = ((sx - ax) * dx + (sz - az) * dz) / lenSq;
      t = Math.max(0, Math.min(1, t));
      const qx = ax + t * dx, qz = az + t * dz;
      const dSq = (sx - qx) ** 2 + (sz - qz) ** 2;

      if (preferred && dSq < bestDistSq) {
        bestDistSq = dSq; bestRoad = road; bestSegIdx = i; bestT = t;
      } else if (acceptable && dSq < acceptDistSq) {
        acceptDistSq = dSq; acceptRoad = road; acceptSegIdx = i; acceptT = t;
      }
    }
  }

  const road = bestRoad || acceptRoad;
  if (!road) return { wx: fallback.x, wz: fallback.z, heading: Math.PI, elevRaw: null };
  const segIdx = bestRoad ? bestSegIdx : acceptSegIdx;
  const t = bestRoad ? bestT : acceptT;
  const pts = road.points;
  const ax = pts[segIdx].x, az = pts[segIdx].y;
  const bx = pts[segIdx + 1].x, bz = pts[segIdx + 1].y;

  // Snap position on road
  const wx = ax + t * (bx - ax);
  const wz = az + t * (bz - az);

  // Road direction → heading angle for physics (car forward = +Z in physics)
  const dx = bx - ax, dz = bz - az;
  const heading = Math.atan2(-dx, dz); // negated X because physics X is mirrored

  // Raw baked elevation at the snapped point, interpolated along the segment.
  // The snapped road can be well below the spawn lat/lon's terrain (y=0 frame) on a slope.
  const eA = pts[segIdx].elevation, eB = pts[segIdx + 1].elevation;
  const elevRaw = Number.isFinite(eA) && Number.isFinite(eB) ? eA + t * (eB - eA)
    : Number.isFinite(eA) ? eA : null;

  return { wx, wz, heading, elevRaw };
}

spawnTileReady.finally(() => {
  const bbox = tileToBBox(spawnTx, spawnTy, TILE_ZOOM);
  const { x: originOffsetX, z: originOffsetZ } = latLonToWorld(bbox.south, bbox.west);
  setOriginOffset(originOffsetX, originOffsetZ);
  worldGroup.position.set(originOffsetX, 0, -originOffsetZ);

  tileManager = createTileManager(
    worldGroup,
    createRoadMeshes,
    createBuildingMeshes,
    createSpatialIndex,
    renderVegetation,
    camera,
    world,
    groundBody
  );

  // Custom minimap data store — wired to tile load/unload BEFORE the spawn tile is injected so it
  // captures every tile (incl. spawn). Drawn by the minimap's custom GridLayer; no OSM/network.
  customMap = createCustomMap();
  setMapTileCallbacks(customMap.ingestTile, customMap.removeTile);

  const injectPromise = spawnTileData && tileManager.injectSpawnTile
    ? tileManager.injectSpawnTile(tileKey(spawnTx, spawnTy), spawnTx, spawnTy, spawnTileData)
    : Promise.resolve();

  // Start the render loop NOW — not after the async car/UI setup below. Otherwise a slow spawn-tile
  // build (workers under contention can take 20 s+) keeps animate() from ever starting, and when the
  // loading screen's safety-net lifts it reveals a BLACK canvas (nothing has rendered) instead of the
  // sky. animate() null-guards every object created later, so it's safe to run before they exist.
  animate();

  // Don't let a hung spawn-tile build block car/UI creation. processTileData awaits worker geometry,
  // and a dropped worker message under load can leave it pending FOREVER — which used to strand init
  // with no car and (before animate() moved up) a black screen. Cap the wait; the tile still finishes
  // in the background and neighbours stream in via the normal update loop. On a healthy machine the
  // inject completes in well under this cap, so the timeout is purely a safety net.
  const injectGated = Promise.race([
    injectPromise,
    new Promise((resolve) => setTimeout(resolve, 8000)),
  ]);

  injectGated.then(async () => {
    const origin = getOriginOffset();

    if (ENABLE_CAR) {
      // Find nearest major road for proper on-road spawn
      const spawnResult = findRoadSpawn(spawnTileData, spawnCenter);
      // Spawn at the snapped road's actual height, not a fixed y: on a slope the snapped road
      // can sit ~20 m below the spawn lat/lon's terrain (y=0 frame) and the impact speed of
      // that fall tunnels the wheels through the deck collider.
      const spawnRoadY = spawnResult.elevRaw != null
        ? toNormalizedRoadY(spawnResult.elevRaw, getWorldElevationOffset() ?? 0, CONFIG.ELEVATION_VERTICAL_EXAGGERATION)
        : 0;
      const spawnLocalPos = {
        x: -(spawnResult.wx - origin.x),
        y: spawnRoadY + 0.5, // carDriver adds +2 → gentle drop from ~2.5 m above the deck
        z: spawnResult.wz - origin.z,
      };
      try {
        // ── Rapier (WASM) physics — opt in with ?physics=rapier. The car runs on Rapier; the cannon world
        //    is never stepped (inert). tileManager keeps adding CANNON collider bodies to `world`, and we
        //    MIRROR each into Rapier via the adapter — boxes/meshes 1:1, terrain as a NATIVE Rapier
        //    heightfield (convention probed at runtime, trimesh fallback). Zero tileManager changes.
        let _rapier = null, _physicsWorld = world;
        if (new URLSearchParams(location.search).get('physics') === 'rapier') {
          try {
            _rapier = (await import('@dimforge/rapier3d-compat')).default;
            await _rapier.init();
            const rw = new _rapier.World({ x: 0, y: -9.82, z: 0 });
            rw.timestep = 1 / 60;
            // Deep safety backstop only — terrain + road colliders are the real surface now. Placed far
            // below (−60 m) so it never lifts the car off a road/terrain that dips below spawn height; it
            // just catches a catastrophic fall (freefall-recovery is the primary backstop).
            const gb = rw.createRigidBody(_rapier.RigidBodyDesc.fixed().setTranslation(spawnLocalPos.x, spawnLocalPos.y - 60, spawnLocalPos.z));
            rw.createCollider(_rapier.ColliderDesc.cuboid(4000, 1, 4000).setFriction(1.0), gb);
            _physicsWorld = rw;
            const { createRapierWorldAdapter } = await import('./physics/rapierWorldAdapter.js');
            const _adapter = createRapierWorldAdapter(rw, _rapier);
            for (const b of [...world.bodies]) { try { _adapter.addBody(b); } catch {} }   // register already-loaded tiles
            const _oAdd = world.addBody.bind(world), _oRem = world.removeBody.bind(world);  // register future tiles
            world.addBody = (b) => { _oAdd(b); try { _adapter.addBody(b); } catch {} };
            world.removeBody = (b) => { _oRem(b); try { _adapter.removeBody(b); } catch {} };
            rapierAdapter = _adapter;   // animate() streams the working set around the car each frame
            window._rapierWorld = rw;   // dev: _rapierWorld.colliders.len() shows the live working set
            console.warn(`[physics] Rapier enabled — streaming mirror over ${world.bodies.length} registered bodies.`);
          } catch (e) { console.warn('[physics] Rapier init failed — falling back to cannon:', e); _rapier = null; _physicsWorld = world; }
        }
        carDriver = await createCarDriver(scene, _physicsWorld, groundMesh, camera, spawnLocalPos, renderer.domElement, groundBody, spawnResult.heading, { rapier: _rapier, cpuTimer });
        contactShadows = createContactShadows({ scene });
        if (CONFIG.ENABLE_TRAFFIC && world) {
          trafficSystem = createTrafficSystem({
            scene, world, contactShadows,
            getGroundY: (wx, wz) => {
              const s = tileManager.getSurfaceHeightAt?.(wx, wz);
              if (s && Number.isFinite(s.surfaceY)) return s.surfaceY;
              const t = tileManager.getTerrainHeightAt?.(wx, wz);
              return Number.isFinite(t) ? t : 0;
            },
            getRoadSegments: () => tileManager.getLoadedRoadSegments(),
            getOrigin: getOriginOffset,
          });
        }
        // Pedestrians (sidewalks) and parked cars (curb) belong on the TERRAIN, not the road. Using the
        // road-biased getSurfaceHeightAt (which returns max(roadHeight, terrain) within 10 m of any road)
        // floated them wherever the road is baked above the terrain (e.g. Passeig Olímpic / Montjuïc).
        const terrainGroundY = (wx, wz) => {
          const t = tileManager.getTerrainHeightAt?.(wx, wz);
          if (Number.isFinite(t)) return t;
          const s = tileManager.getSurfaceHeightAt?.(wx, wz);
          if (s && Number.isFinite(s.surfaceY)) return s.surfaceY;
          // never snap to absolute 0 (floats entities where terrain is below spawn) — use the normalized floor
          return tileManager.normalizedGroundFloor?.() ?? 0;
        };
        if (CONFIG.ENABLE_PARKED_CARS) {
          parkedCars = createParkedCars({
            scene,
            getRoadSegments: () => tileManager.getLoadedRoadSegments(),
            getGroundY: terrainGroundY,
            getOrigin: getOriginOffset,
          });
        }
        if (CONFIG.ENABLE_PEDESTRIANS) {
          pedestrians = createPedestrians({
            scene, contactShadows,
            getRoadSegments: () => tileManager.getLoadedRoadSegments(),
            getGroundY: terrainGroundY,
            getOrigin: getOriginOffset,
          });
        }
        // Checkpoint Dash game mode (Start button top-centre). Roads/gates use the traffic frame.
        dashMode = createDashMode({
          scene, camera, getMinimap: () => minimap,   // minimap is assigned later in init — resolve lazily
          getRoadSegments: () => tileManager.getLoadedRoadSegments(),
          getGroundY: (wx, wz) => { const s = tileManager.getSurfaceHeightAt?.(wx, wz); return (s && Number.isFinite(s.surfaceY)) ? s.surfaceY : (tileManager.getTerrainHeightAt?.(wx, wz) ?? 0); },
          getOrigin: getOriginOffset,
          audio,
        });
        taxiMode = createTaxiMode({
          scene, camera, getMinimap: () => minimap,
          getRoadSegments: () => tileManager.getLoadedRoadSegments(),
          getGroundY: (wx, wz) => { const s = tileManager.getSurfaceHeightAt?.(wx, wz); return (s && Number.isFinite(s.surfaceY)) ? s.surfaceY : (tileManager.getTerrainHeightAt?.(wx, wz) ?? 0); },
          getOrigin: getOriginOffset,
          audio,
        });
        deliveryMode = createDeliveryMode({
          scene, camera, getMinimap: () => minimap,
          getRoadSegments: () => tileManager.getLoadedRoadSegments(),
          getGroundY: (wx, wz) => { const s = tileManager.getSurfaceHeightAt?.(wx, wz); return (s && Number.isFinite(s.surfaceY)) ? s.surfaceY : (tileManager.getTerrainHeightAt?.(wx, wz) ?? 0); },
          getOrigin: getOriginOffset,
          audio,
        });
        policeMode = createPoliceMode({
          scene, getMinimap: () => minimap,
          getGroundY: (wx, wz) => { const s = tileManager.getSurfaceHeightAt?.(wx, wz); return (s && Number.isFinite(s.surfaceY)) ? s.surfaceY : (tileManager.getTerrainHeightAt?.(wx, wz) ?? 0); },
          getOrigin: getOriginOffset,
          audio,
        });
        // Mode is chosen on the title screen (dd_mode) and switchable from the ESC menu — no on-screen column.
        // "Press R" hint that appears when the car flips over (recover key is otherwise undiscoverable).
        recoverHint = document.createElement('div');
        recoverHint.style.cssText = 'position:fixed;bottom:118px;left:50%;transform:translateX(-50%);z-index:1200;display:none;' +
          "font-family:'Inter',system-ui,sans-serif;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;" +
          'color:#f3ede1;background:rgba(215,106,79,0.92);backdrop-filter:blur(15px);-webkit-backdrop-filter:blur(15px);padding:9px 16px;border-radius:11px;' +
          'box-shadow:0 4px 16px rgba(0,0,0,.28);pointer-events:none;white-space:nowrap;';
        recoverHint.innerHTML = 'Flipped over — press <b style="font-family:monospace;background:rgba(255,255,255,.22);padding:1px 7px;border-radius:5px;letter-spacing:0">R</b> to recover';
        document.body.appendChild(recoverHint);
        // Subtle controls hint, bottom-centre — thin uppercase Futura, wide tracking (art-of-rally caption).
        const controlsStrip = document.createElement('div');
        controlsStrip.id = 'controls-strip';
        controlsStrip.style.cssText = 'position:fixed;bottom:14px;left:50%;transform:translateX(-50%);z-index:900;' +
          "font-family:'Inter',system-ui,sans-serif;font-size:11.5px;font-weight:500;text-transform:uppercase;letter-spacing:.06em;" +
          'color:rgba(243,237,225,.68);text-shadow:0 1px 4px rgba(0,0,0,.4);' +
          'pointer-events:none;user-select:none;white-space:nowrap;';
        controlsStrip.innerHTML = 'WASD Drive &nbsp;·&nbsp; Space Drift &nbsp;·&nbsp; H Horn &nbsp;·&nbsp; L Lights &nbsp;·&nbsp; R Recover &nbsp;·&nbsp; M Map &nbsp;·&nbsp; Esc Menu';
        document.body.appendChild(controlsStrip);
      } catch (err) {
        console.error('[main] createCarDriver failed:', err);
        freeCameraControls = createFreeCameraController(camera, renderer.domElement, spawnCenter, origin);
      }
    } else {
      // World-explore mode — free orbit camera
      freeCameraControls = createFreeCameraController(camera, renderer.domElement, spawnCenter, origin);
    }

    streetDisplay    = createStreetDisplay();
    speedDisplay     = createSpeedDisplay();
    speedLines       = createSpeedLines();
    metricsPanel     = createMetricsPanel();
    minimap          = createMinimap(spawnCenter, customMap);
    // Background-load the whole city's 2D map data (roads/water/parks) a few seconds after spawn, so the
    // zoomed-out minimap shows all of Barcelona — not just tiles driven through. Low-priority, yields.
    setTimeout(() => { loadCityMap(customMap).catch(() => {}); }, 5000);
    if (minimap?.setNightMode) onNightModeChange((isNight) => minimap.setNightMode(isNight));
    onNightModeChange((isNight) => carDriver?.setNight?.(isNight)); // day/night ambience swap
    // Grade: at night, disable the black-lift + high-key brighten (they wash the dark to a grey veil).
    onNightModeChange((isNight) => { colorGradePass.uniforms.uNight.value = isNight ? 1.0 : 0.0; });
    minimap?.setMarkerMode(!!carDriver);
    compassBar       = createCompassBar();
    performancePanel = createPerformancePanel(scene, renderer, tileManager, CONFIG.ENABLE_PERFORMANCE_PANEL);
    // Stack the STATS panel just below the location panel (both are fixed top-right) so they never overlap,
    // regardless of viewport. Re-measure on resize.
    if (metricsPanel?.element && performancePanel?.element) {
      const stackPanels = () => {
        const b = metricsPanel.element.getBoundingClientRect();
        if (b.height > 0) performancePanel.element.style.top = `${Math.round(b.bottom + 14)}px`;
      };
      requestAnimationFrame(stackPanels);
      window.addEventListener('resize', stackPanels);
    }
    // ESC menu — re-parents the car-colour panel + day/night toggle into a gamified overlay, adds
    // global place search (spawn anywhere in the baked area) and a HUD-metrics toggle.
    escMenu = createEscMenu({
      colorPanelElement: document.getElementById('dd-car-color-panel'),
      metricsElements: [metricsPanel?.element, performancePanel?.element],
      carMode: ENABLE_CAR,   // resolved mode (URL ?mode outranks dd_flyMode) — for an honest Fly-mode toggle
      gameModes: carDriver ? [dashMode, taxiMode, deliveryMode, policeMode] : [],   // in-game mode switcher (empty in fly mode)
    });
    // Debug overlays are DEV-ONLY: never wire the ?debug= query params or the K-key toggle in a production
    // build (no debug entry points / info exposure in the shipped game).
    if (import.meta.env.DEV) {
      initTunnelDebug();    // reads ?debug=tunnel
      initCollisionDebug(); // reads ?debug=collision + registers the K-key toggle
    }
    // (animate() already started earlier, before this async block — see the render-loop note above.)
    // Hold the loading screen until the spawn-area tiles are actually built (not just the first frame),
    // so the world isn't visibly popping in when the loader lifts. Poll the tile manager; cap the wait.
    const _hideLoader = () => { const l = document.getElementById('dd-loading'); if (l && !l.classList.contains('hide')) { l.classList.add('hide'); setTimeout(() => l.remove(), 700); } };
    let _polls = 0;
    const _pollLoad = setInterval(() => {
      _polls++;
      if ((tileManager?.isInitialLoadComplete?.()) || _polls > 130) {
        clearInterval(_pollLoad); _hideLoader();
        // Spawn-area material singletons now exist — re-apply night state so a night reload isn't half-day.
        try { envToggle?.reapply?.(); } catch {}
        // Warm the GPU shader programs once now (materials are shared singletons, so this compiles almost
        // every program the session will ever use). Kills the first-render compile stall as new tiles
        // stream in at speed. compileAsync runs off the render path (KHR_parallel_shader_compile).
        try { renderer.compileAsync?.(scene, camera); } catch {}
        // Auto-start the mode chosen on the title screen (roads are loaded now, so gates/fares can place).
        try {
          const chosen = sessionStorage.getItem('dd_mode');
          if (chosen === 'dash') dashMode?.start?.();
          else if (chosen === 'taxi') taxiMode?.start?.();
          else if (chosen === 'delivery') deliveryMode?.start?.();
          else if (chosen === 'police') policeMode?.start?.();
        } catch {}
      }
    }, 150);
  }).catch((err) => {
    // Never let an init failure leave a silent black screen — log it and lift the loader.
    console.error('[main] init failed after tile inject:', err);
    const l = document.getElementById('dd-loading');
    if (l && !l.classList.contains('hide')) { l.classList.add('hide'); setTimeout(() => l.remove(), 700); }
  });
});
// Safety net: never let the loader get stuck if init throws before animate().
setTimeout(() => { const l = document.getElementById('dd-loading'); if (l && !l.classList.contains('hide')) { l.classList.add('hide'); setTimeout(() => l.remove(), 700); } }, 20000);

let lastTime = 0;
// FPS cap (default 120 — lets high-refresh displays breathe past 60; was 60 to cut GC, but the big
// per-frame allocators are being killed off so we can afford more frames). Override with ?fpscap=N
// (e.g. ?fpscap=0 uncapped, ?fpscap=60). Small 0.5ms slack so we don't miss the cap.
const _fpsCapVal = (() => { const p = new URLSearchParams(location.search).get('fpscap'); return p == null ? 120 : Math.max(0, parseInt(p, 10) || 0); })();
const _fpsCapMs = _fpsCapVal > 0 ? (1000 / _fpsCapVal) - 0.5 : 0;
let _lastRenderT = 0;
const _camDir = new THREE.Vector3();

// ── Throttle caches for per-frame lookups ────────────────────────────────
let _lastRoadQueryX = -Infinity, _lastRoadQueryZ = -Infinity;
let _cachedNearestRoad = null;
const ROAD_QUERY_THRESHOLD_SQ = 10 * 10; // re-query every 10m of movement

let _lastShadowX = -Infinity, _lastShadowZ = -Infinity;
const SHADOW_UPDATE_THRESHOLD_SQ = 12 * 12; // update shadow camera every 12m (was 5) — fewer full shadow re-renders (less per-frame Three.js churn + GPU); imperceptible for a 200m-radius directional shadow

function animate(time = 0) {
  requestAnimationFrame(animate);
  // FPS cap: on a high-refresh display (120 Hz) the game ran ~80 fps, and the per-frame engine allocation
  // (Three.js + cannon-es, ~1 MB/frame) is what feeds the GC pauses that cause stutter. Capping to a steady
  // 60 both cuts garbage/sec (~25% fewer frames → fewer GC pauses) AND gives even frame pacing (a big
  // perceived-smoothness win). Skipped refreshes do zero work → zero allocation. ?fpscap=0 disables it.
  if (_fpsCapMs > 0 && time - _lastRenderT < _fpsCapMs) return;
  _lastRenderT = time;
  const deltaTimeRaw = lastTime === 0 ? 16 : time - lastTime;
  const deltaTimeSeconds = Math.min(0.05, deltaTimeRaw / 1000);
  const frameDt = lastTime === 0 ? 0.016 : deltaTimeSeconds;
  lastTime = time;
  if (tileManager == null) return;

  cpuTimer.start();
  let viewerWx, viewerWz, headingDeg, speedKmh;

  // Fog is atmospheric — only meaningful at ground level in drive mode.
  // In drone/free-camera mode, disable fog so the aerial view stays clear.
  if (CONFIG.ENABLE_FOG && scene.fog) {
    scene.fog.density = carDriver ? 0.005 : 0;
  }

  if (carDriver) {
    // ── Car driving mode ──────────────────────────────────────────────────────
    // Skip the chase camera while the taxi mode is playing a pickup/drop-off cinematic (it drives the
    // camera itself, in taxiMode.update below).
    carDriver.update(frameDt, !!(taxiMode?.isCinematic?.() || deliveryMode?.isCinematic?.()));
    cpuTimer.lap('phys');

    const lp = carDriver.getLocalPosition();
    rapierAdapter?.tick(lp.lx, lp.lz);   // stream the Rapier collider working set around the car
    // Physics / scene X is mirrored relative to world/map X (worldGroup.scale.x = -1),
    // so convert back to world coordinates by negating X (same convention as free camera).
    viewerWx = -lp.lx;
    viewerWz = lp.lz;
    speedKmh = carDriver.getSpeedKmh();

    // AI traffic + parked cars + pedestrians — player position is in the physics frame (lp.lx, lp.lz).
    if (contactShadows) contactShadows.begin();
    if (trafficSystem) trafficSystem.update(lp.lx, lp.lz, frameDt, speedKmh);
    cpuTimer.lap('traffic');
    if (parkedCars) parkedCars.update(lp.lx, lp.lz);
    cpuTimer.lap('parked');
    if (pedestrians) pedestrians.update(lp.lx, lp.lz, frameDt, speedKmh);
    if (contactShadows) contactShadows.commit();
    cpuTimer.lap('peds');
    if (dashMode) dashMode.update(lp.lx, lp.lz, frameDt);
    if (taxiMode) taxiMode.update(lp.lx, lp.lz, frameDt, speedKmh, carDriver.getHeadingDeg());
    if (deliveryMode) deliveryMode.update(lp.lx, lp.lz, frameDt, speedKmh, carDriver.getHeadingDeg());
    if (policeMode) policeMode.update(lp.lx, lp.lz, frameDt, speedKmh, carDriver.getHeadingDeg());
    // Flipped-over hint (press R)
    if (recoverHint) {
      const upDot = carDriver.getUpDot?.() ?? 1;
      _flipT = upDot < -0.05 ? _flipT + frameDt : 0;
      recoverHint.style.display = _flipT > 0.6 ? 'block' : 'none';
    }
    headingDeg = carDriver.getHeadingDeg();
  } else {
    // ── Free camera mode ──────────────────────────────────────────────────────
    if (freeCameraControls) freeCameraControls.update(frameDt);

    const pos = getStreamPositionFromCamera(camera);
    viewerWx = pos.wx;
    viewerWz = pos.wz;
    speedKmh = 0;
    camera.getWorldDirection(_camDir);
    headingDeg = (Math.atan2(_camDir.x, _camDir.z) * 180) / Math.PI;

    if (groundMesh) groundMesh.position.set(viewerWx, 0, viewerWz);
  }

  tileManager.update(viewerWx, viewerWz, { headingDeg, speedKmh: Math.abs(speedKmh || 0) });
  cpuTimer.lap('tiles');
  updateClouds(viewerWx, viewerWz);
  updateMoon(viewerWx, viewerWz);
  updateStars(viewerWx, viewerWz);

  const origin = getOriginOffset();
  const worldWx = viewerWx + origin.x;
  const worldWz = viewerWz + origin.z;

  if (CONFIG.ENABLE_DAY_NIGHT) {
    timeSystem.update(frameDt);
    if (dayNight) dayNight.update(frameDt);
  }

  // Throttle road segment lookup — only re-query when moved >10m
  const rdDx = worldWx - _lastRoadQueryX, rdDz = worldWz - _lastRoadQueryZ;
  if (rdDx * rdDx + rdDz * rdDz > ROAD_QUERY_THRESHOLD_SQ) {
    const segments = tileManager.getLoadedRoadSegments();
    _cachedNearestRoad = queryNearestRoadSegment(segments, worldWx, worldWz);
    _lastRoadQueryX = worldWx;
    _lastRoadQueryZ = worldWz;
  }
  const nearest = _cachedNearestRoad;
  streetDisplay?.setStreet(nearest ? nearest.name : null, nearest ? nearest.highwayType : null);
  if (carDriver) {
    speedDisplay?.setSpeed(Math.abs(Math.round(speedKmh)), carDriver.getCurrentGear(), carDriver.getCurrentRpm());
  } else {
    speedDisplay?.setSpeed(0, 1, 900);
  }
  speedLines?.update(speedKmh);
  const { lat, lon } = worldToLatLon(worldWx, worldWz);
  minimap?.update(worldWx, worldWz, -headingDeg); // negate: physics X mirrored
  compassBar?.update(headingDeg);
  metricsPanel?.update({ x: viewerWx, z: viewerWz, lat, lon, roadType: nearest ? nearest.highwayType : null, headingDeg, speedKmh: Math.abs(speedKmh) });
  // Shadow camera follows the viewer — throttled to update only when moved >5m
  if (dirLight && dirLight.castShadow) {
    const shDx = camera.position.x - _lastShadowX, shDz = camera.position.z - _lastShadowZ;
    if (shDx * shDx + shDz * shDz > SHADOW_UPDATE_THRESHOLD_SQ) {
      dirLight.position.set(
        camera.position.x + sunDir.x * 200,
        camera.position.y + sunDir.y * 200,
        camera.position.z + sunDir.z * 200,
      );
      dirLight.target.position.set(camera.position.x, camera.position.y, camera.position.z);
      dirLight.target.updateMatrixWorld();
      _lastShadowX = camera.position.x;
      _lastShadowZ = camera.position.z;
      renderer.shadowMap.needsUpdate = true; // shadow map is autoUpdate=false → refresh only when the light moved
    }
  }

  // Animate traffic light colors (red/yellow/green cycling)
  if (CONFIG.ENABLE_ROAD_INFRA) {
    updateTrafficLights(time / 1000, CONFIG.ENABLE_DAY_NIGHT && timeSystem.isNight());
  }

  // Blink red beacon lights on communication towers
  updateTowerBeacons(time / 1000);

  if (CONFIG.DEBUG_COLLIDERS) {
    updateDebugColliders(scene, world);
  }

  // Phase 0 tunnel diagnostic overlay (?debug=tunnel) — flag-gated, no cost when off.
  updateTunnelDebug(scene, world, camera);
  updateCollisionDebug(scene, world, camera);

  // Animate grass + tree wind (same time base for spatial coherence)
  updateGrassWind(time / 1000);
  updateTreeWind(time / 1000);
  cpuTimer.lap('ui'); // hud/minimap/shadow-follow/wind/infra since the last lap

  // Radial edge blur scales with speed — skip the full-screen pass entirely below ~30 km/h (a free frame).
  const blurSpd = Math.abs(speedKmh || 0);
  // Top speed is now 110, so the cue is recalibrated into 30-95: it starts sooner and hits FULL strength by
  // ~95 km/h, so the trimmed top end still reads as genuinely fast (bought-back sense of speed).
  radialBlurPass.uniforms.strength.value = Math.max(0, Math.min(1, (blurSpd - 30) / 65));
  radialBlurPass.enabled = blurSpd > 30;
  renderer.info.reset();
  gpuTimer.poll();       // read back a previously-issued GPU timer query (async, resolves a few frames later)
  gpuTimer.begin();      // time the actual GPU work this frame → "capable FPS" even when vsync caps display at 60
  // GPU pre-upload: force a few queued (prefetched, off-screen) tile meshes through this render so their
  // vertex buffers upload NOW, spread over frames — instead of all at once when the tile reveals (the
  // "stutter driving into a new tile"). Restore culling right after. See map/gpuWarmup.js.
  warmupBegin(3);
  composer.render();
  warmupEnd();
  gpuTimer.end();
  cpuTimer.lap('rend'); // CPU cost of submitting draws (not GPU exec — that's the gpuTimer)
  if (perfLogger.recording) {
    perfLogger.sample({
      t: Math.round(time),
      ms: +(frameDt * 1000).toFixed(2),        // total frame time (incl. GC/browser gaps not in cpu sections)
      gpu: gpuTimer.getMs() != null ? +gpuTimer.getMs().toFixed(2) : null,
      cpu: cpuTimer.snapshot(),                 // { phys, ent, tiles, ui, rend } — sum vs ms gap = GC/present stall
      halloc: cpuTimer.heapSnapshot(),          // MB allocated per section this frame — the garbage source
      draws: renderer.info.render.calls,
      tris: renderer.info.render.triangles,
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      x: viewerWx != null ? +viewerWx.toFixed(1) : null,
      z: viewerWz != null ? +viewerWz.toFixed(1) : null,
      spd: speedKmh != null ? Math.round(speedKmh) : null,
      hdg: headingDeg != null ? Math.round(headingDeg) : null,   // heading delta between frames = turning
    });
  }
  // Screenshot capture must read the canvas in the SAME tick as the render (the WebGL drawing buffer is
  // cleared before the next frame; we don't set preserveDrawingBuffer, so reading here is the reliable path).
  if (_captureRequested) { _captureRequested = false; captureScreenshot(); }
  adaptiveRes.tick(frameDt);
  performancePanel?.tick(time, frameDt, { cameraY: camera.position.y, renderScale: adaptiveRes.getScale(), gpuMs: gpuTimer.getMs(), cpuTimer });
}

window.addEventListener('resize', () => {
  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  adaptiveRes.setSize(w, h); // owns renderer/composer pixel-ratio + size + bloom resolution
});

// ── Photo Mode (press P) — clean fly-through screenshots ─────────────────────────────────────────
// Full-detail render (no LOD / no distance culling, wider tile radius), full resolution (no adaptive
// downscale), and a hidden HUD. Best used in fly mode. Toggle again to restore.
const _photoStyle = document.createElement('style');
_photoStyle.textContent =
  'body.dd-photo #compass-bar, body.dd-photo #street-display, body.dd-photo #minimap-frame, ' +
  'body.dd-photo #minimap-wrapper, body.dd-photo #env-toggle, body.dd-photo #performance-panel, ' +
  'body.dd-photo .dd-esc-fab, body.dd-photo #controls-strip { display: none !important; }';
document.head.appendChild(_photoStyle);

// Capture button — visible only in Photo Mode. Downloads a PNG of the rendered frame (the canvas only,
// so no HUD/button ends up in the shot). Click sets the flag; the actual read happens in the render loop.
const _captureBtn = document.createElement('button');
_captureBtn.id = 'photo-capture-btn';
_captureBtn.textContent = '📷 Capture';
_captureBtn.style.cssText = 'position:fixed;bottom:26px;left:50%;transform:translateX(-50%);z-index:6000;display:none;' +
  'cursor:pointer;font:800 16px Poppins,system-ui,sans-serif;color:#141414;padding:12px 28px;border:none;border-radius:14px;' +
  'background:linear-gradient(#ffffff,#e4e4e4);box-shadow:0 6px 0 #b4b4b4,0 10px 18px rgba(0,0,0,.4);letter-spacing:.5px;';
_captureBtn.onmousedown = () => { _captureBtn.style.transform = 'translateX(-50%) translateY(4px)'; _captureBtn.style.boxShadow = '0 2px 0 #b4b4b4'; };
const _captureBtnUp = () => { _captureBtn.style.transform = 'translateX(-50%)'; _captureBtn.style.boxShadow = '0 6px 0 #b4b4b4,0 10px 18px rgba(0,0,0,.4)'; };
_captureBtn.onmouseup = _captureBtnUp; _captureBtn.onmouseleave = _captureBtnUp;
_captureBtn.onclick = () => { _captureRequested = true; };
document.body.appendChild(_captureBtn);

// Live area readout ( +/- adjusts the load radius ). Shown only in Photo Mode.
const _photoInfo = document.createElement('div');
_photoInfo.id = 'photo-info';
_photoInfo.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:6000;display:none;' +
  'font:700 13px Poppins,system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.55);padding:8px 16px;border-radius:12px;' +
  'pointer-events:none;user-select:none;letter-spacing:.3px;text-align:center;';
document.body.appendChild(_photoInfo);
function _updatePhotoInfo() {
  const r = tileManager?.getPhotoRadius?.() ?? 4; const n = 2 * r + 1;
  _photoInfo.innerHTML = `📷 PHOTO MODE &nbsp;·&nbsp; area ${n}×${n} &nbsp;·&nbsp; <b>+ / −</b> resize &nbsp;·&nbsp; <b>P</b> exit`;
}

function captureScreenshot() {
  try {
    const url = renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url; a.download = `barcelona-drive-${Date.now()}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    // Shutter flash for feedback.
    const f = document.createElement('div');
    f.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:9999;pointer-events:none;opacity:.8;transition:opacity .4s';
    document.body.appendChild(f);
    requestAnimationFrame(() => { f.style.opacity = '0'; setTimeout(() => f.remove(), 450); });
  } catch (e) { console.error('[capture] screenshot failed', e); }
}

let _photoOn = false;
function setPhotoMode(on) {
  _photoOn = on;
  document.body.classList.toggle('dd-photo', on);
  _captureBtn.style.display = on ? 'block' : 'none';
  _photoInfo.style.display = on ? 'block' : 'none';
  if (on) _updatePhotoInfo();
  try { tileManager?.setPhotoMode?.(on); } catch {}
  try { adaptiveRes.setPhotoMode(on); } catch {}
  if (speedDisplay?.element) speedDisplay.element.style.display = on ? 'none' : '';
  if (metricsPanel?.element) metricsPanel.element.style.display = on ? 'none' : '';
}
window.addEventListener('keydown', (e) => {
  if (isInputBlocked() || isTypingTarget(document.activeElement)) return;
  if (e.code === 'KeyP') { e.preventDefault(); setPhotoMode(!_photoOn); return; }
  if (e.code === 'KeyL') { e.preventDefault(); carDriver?.toggleHeadlights?.(); return; } // headlights: auto→on→off
  // While in Photo Mode, +/- grow/shrink the loaded area (push it up until your machine strains).
  if (_photoOn && (e.code === 'Equal' || e.code === 'NumpadAdd' || e.key === '+')) {
    e.preventDefault(); tileManager?.setPhotoRadius?.((tileManager.getPhotoRadius?.() ?? 4) + 1); _updatePhotoInfo();
  } else if (_photoOn && (e.code === 'Minus' || e.code === 'NumpadSubtract' || e.key === '-')) {
    e.preventDefault(); tileManager?.setPhotoRadius?.((tileManager.getPhotoRadius?.() ?? 4) - 1); _updatePhotoInfo();
  }
});

window._debugWorld = world;
