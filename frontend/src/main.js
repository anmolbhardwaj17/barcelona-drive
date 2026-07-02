/**
 * Barcelona driving simulator: scene, tile streaming, UI, day/night cycle.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { createRadialBlurPass } from './ui/radialBlurPass.js';
import { createColorGradePass } from './ui/colorGradePass.js';
import { createScene, updateClouds, updateMoon, updateStars } from './scene.js';
import { createTileManager } from './map/tileManager.js';
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
import { createMinimap } from './ui/minimap.js';
import { createCompassBar } from './ui/compassBar.js';
import { createPerformancePanel } from './ui/performancePanel.js';
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
import { createContactShadows } from './car/contactShadows.js';
import { updateDebugColliders } from './debugColliders.js';
import { initTunnelDebug, updateTunnelDebug } from './tunnelDebugOverlay.js';
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
// Bloom — makes lights, tail lights, headlights, streetlights glow
// Bloom at half resolution for performance — still looks great
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2)),
  0.5,    // strength — visible glow on car lights
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


// Day / Night toggle — created immediately so the day preset is applied before tile loads.
const envToggle = createEnvToggle({
  scene, renderer, ambientLight, hemiLight, dirLight, sky,
  setLampEmissiveIntensity, setPoolOpacity,
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
  } catch { /* no URL access */ }
  return CONFIG.ENABLE_CAR;
})();
if (ENABLE_CAR !== CONFIG.ENABLE_CAR) {
  console.log(`[main] mode override via URL: ${ENABLE_CAR ? 'CAR (drive)' : 'FLY (free camera)'} (CONFIG.ENABLE_CAR=${CONFIG.ENABLE_CAR})`);
}

let tileManager;
let freeCameraControls;
let carDriver = null;
let trafficSystem = null;
let parkedCars = null;
let pedestrians = null;
let contactShadows = null;
let streetDisplay;
let speedDisplay;
let speedLines;
let metricsPanel;
let minimap;
let compassBar;
let performancePanel;

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

  const injectPromise = spawnTileData && tileManager.injectSpawnTile
    ? tileManager.injectSpawnTile(tileKey(spawnTx, spawnTy), spawnTx, spawnTy, spawnTileData)
    : Promise.resolve();

  injectPromise.then(async () => {
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
        carDriver = await createCarDriver(scene, world, groundMesh, camera, spawnLocalPos, renderer.domElement, groundBody, spawnResult.heading);
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
        if (CONFIG.ENABLE_PARKED_CARS) {
          parkedCars = createParkedCars({
            scene,
            getRoadSegments: () => tileManager.getLoadedRoadSegments(),
            getGroundY: (wx, wz) => {
              const s = tileManager.getSurfaceHeightAt?.(wx, wz);
              if (s && Number.isFinite(s.surfaceY)) return s.surfaceY;
              const t = tileManager.getTerrainHeightAt?.(wx, wz);
              return Number.isFinite(t) ? t : 0;
            },
            getOrigin: getOriginOffset,
          });
        }
        if (CONFIG.ENABLE_PEDESTRIANS) {
          pedestrians = createPedestrians({
            scene, contactShadows,
            getRoadSegments: () => tileManager.getLoadedRoadSegments(),
            getGroundY: (wx, wz) => {
              const s = tileManager.getSurfaceHeightAt?.(wx, wz);
              if (s && Number.isFinite(s.surfaceY)) return s.surfaceY;
              const t = tileManager.getTerrainHeightAt?.(wx, wz);
              return Number.isFinite(t) ? t : 0;
            },
            getOrigin: getOriginOffset,
          });
        }
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
    minimap          = createMinimap(spawnCenter);
    if (minimap?.setNightMode) onNightModeChange((isNight) => minimap.setNightMode(isNight));
    minimap?.setMarkerMode(!!carDriver);
    compassBar       = createCompassBar();
    performancePanel = createPerformancePanel(scene, renderer, tileManager, CONFIG.ENABLE_PERFORMANCE_PANEL);
    initTunnelDebug(); // reads ?debug=tunnel; no-op when absent
    animate();
  });
});

let lastTime = 0;
const _camDir = new THREE.Vector3();

// ── Throttle caches for per-frame lookups ────────────────────────────────
let _lastRoadQueryX = -Infinity, _lastRoadQueryZ = -Infinity;
let _cachedNearestRoad = null;
const ROAD_QUERY_THRESHOLD_SQ = 10 * 10; // re-query every 10m of movement

let _lastShadowX = -Infinity, _lastShadowZ = -Infinity;
const SHADOW_UPDATE_THRESHOLD_SQ = 5 * 5; // update shadow camera every 5m

function animate(time = 0) {
  requestAnimationFrame(animate);
  const deltaTimeRaw = lastTime === 0 ? 16 : time - lastTime;
  const deltaTimeSeconds = Math.min(0.05, deltaTimeRaw / 1000);
  const frameDt = lastTime === 0 ? 0.016 : deltaTimeSeconds;
  lastTime = time;
  if (tileManager == null) return;

  let viewerWx, viewerWz, headingDeg, speedKmh;

  // Fog is atmospheric — only meaningful at ground level in drive mode.
  // In drone/free-camera mode, disable fog so the aerial view stays clear.
  if (CONFIG.ENABLE_FOG && scene.fog) {
    scene.fog.density = carDriver ? 0.005 : 0;
  }

  if (carDriver) {
    // ── Car driving mode ──────────────────────────────────────────────────────
    carDriver.update(frameDt);

    const lp = carDriver.getLocalPosition();
    // Physics / scene X is mirrored relative to world/map X (worldGroup.scale.x = -1),
    // so convert back to world coordinates by negating X (same convention as free camera).
    viewerWx = -lp.lx;
    viewerWz = lp.lz;
    speedKmh = carDriver.getSpeedKmh();

    // AI traffic + parked cars + pedestrians — player position is in the physics frame (lp.lx, lp.lz).
    if (contactShadows) contactShadows.begin();
    if (trafficSystem) trafficSystem.update(lp.lx, lp.lz, frameDt, speedKmh);
    if (parkedCars) parkedCars.update(lp.lx, lp.lz);
    if (pedestrians) pedestrians.update(lp.lx, lp.lz, frameDt, speedKmh);
    if (contactShadows) contactShadows.commit();
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

  tileManager.update(viewerWx, viewerWz, { headingDeg });
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

  // Animate grass + tree wind (same time base for spatial coherence)
  updateGrassWind(time / 1000);
  updateTreeWind(time / 1000);

  // Radial edge blur scales with speed
  const blurSpd = Math.abs(speedKmh || 0);
  radialBlurPass.uniforms.strength.value = Math.max(0, Math.min(1, (blurSpd - 40) / 80));
  renderer.info.reset();
  composer.render();
  performancePanel?.tick(time, frameDt, { cameraY: camera.position.y });
}

window.addEventListener('resize', () => {
  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloomPass.resolution.set(Math.floor(w / 2), Math.floor(h / 2));
});

window._debugWorld = world;  
