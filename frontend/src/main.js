/**
 * Barcelona driving simulator: scene, tile streaming, UI, day/night cycle.
 */
import { initAnalytics } from './analytics.js';
initAnalytics();   // Cloudflare Web Analytics — no-op unless VITE_CF_BEACON is set at build time.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { createRadialBlurPass } from './ui/radialBlurPass.js';
import { warmupBegin, warmupEnd } from './map/gpuWarmup.js';

// DEV-only physics benchmark: cannon-es vs Rapier on a tile-world-like load. Dynamic import + DEV gate ⇒
// never in the production bundle. Trigger with ?bench=physics, or window._benchPhysics() from the console.
if (import.meta.env.DEV && new URLSearchParams(location.search).get('bench') === 'physics') {
  import('./bench/physicsBench.js').then((m) => m.benchPhysics()).catch((e) => console.warn('[bench] failed', e));
}
// DEV-only draw-call audit for the BatchedMesh migration: groups every visible mesh (≈1 draw each) by
// material signature so we know exactly which families dominate the ~700 draws. Run window._drawAudit().
if (import.meta.env.DEV) {
  window._drawAudit = () => {
    const by = new Map();
    let total = 0;
    scene.traverse((o) => {
      if ((!o.isMesh && !o.isSprite) || o.visible === false) return;
      total++;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const kind = o.isInstancedMesh ? 'INST ' : o.isBatchedMesh ? 'BATCH ' : '';
      const key = kind + (m?.type || '?')
        + (m?.map ? '+map' : '')
        + (m?.vertexColors ? '+vc' : '')
        + ' #' + (m?.color?.getHexString?.() || '------')
        + (o.name ? ' [' + o.name.slice(0, 24) + ']' : '');
      by.set(key, (by.get(key) || 0) + 1);
    });
    const top = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 35);
    console.warn('[drawAudit] total mesh/sprite objects:', total, '| distinct material signatures:', by.size);
    for (const [k, n] of top) console.warn(String(n).padStart(5), ' ', k);
    return { total, distinct: by.size, top };
  };
}
import { createColorGradePass } from './ui/colorGradePass.js';
import { createAdaptiveResolution } from './ui/adaptiveResolution.js';
import { createScene, updateClouds, updateMoon, updateStars } from './scene.js';
import { createTileManager, setMapTileCallbacks } from './map/tileManager.js';
import { updateTrafficLights } from './map/roadInfraRenderer.js';
import { createRoadMeshes, setRendererAnisotropy } from './map/roadRenderer.js';
import { setLampEmissiveIntensity } from './map/streetlightRenderer.js';
import { updateTowerBeacons } from './map/urbanFeatureRenderer.js';
import { createBoundaryHaze, isInsidePlayArea, outOfBoundsM, BOUNDARY_GRACE_M } from './map/worldBoundary.js';
import { createEnvToggle, onNightModeChange, getPresetFogDensity } from './ui/envToggle.js';
import { createBuildingMeshes } from './map/buildingRenderer.js';
import { preloadCardAtlases } from './map/cardMesh.js';
import { preloadRoadTextures } from './map/roadTexturePack.js';
import { setFacadeArrayRenderer } from './map/facadeArray.js';   // v3 P3-05
import { renderVegetation, preloadTreeModels, updateTreeWind, getTreeMaterial, getTreeBillboardMaterial, getBushCardsMaterial } from './map/vegetationRenderer.js';
import { createSpatialIndex, queryNearestRoadSegment } from './map/spatialIndex.js';
import { createStreetDisplay } from './ui/streetDisplay.js';
import { createSpeedDisplay } from './ui/speedDisplay.js';
import { createSpeedLines } from './ui/speedLines.js';
import { createMetricsPanel } from './ui/metricsPanel.js';
import { isInputBlocked, isTypingTarget } from './inputGate.js';
import { createMinimap } from './ui/minimap.js';
import { createCustomMap } from './ui/customMap.js';
import { loadCityMap } from './ui/cityMapLoader.js';
import { createCompassBar } from './ui/compassBar.js';
import { createPerformancePanel } from './ui/performancePanel.js';
import { createGpuTimer } from './ui/gpuTimer.js';
import { REGION } from './regions/index.js';
import { createCpuTimer } from './ui/cpuTimer.js';
import { chunksIn, formatChunks, recordLongFrame } from './ui/frameAttribution.js';
import { createPerfLogger } from './ui/perfLogger.js';
import { createEscMenu } from './ui/escMenu.js';
import { initTouchControls } from './ui/touchControls.js';
import { worldToLatLon, latLonToWorld, latLonToTile, tileToBBox, TILE_ZOOM } from './projection.js';
import { getActiveSpawn, START_LAT, START_LON } from './spawnConfig.js';
import { loadTile, clearTileCache } from './map/mapLoader.js';
import { getElevationFromGrid } from './map/terrainRenderer.js';
import { setWorldElevationOffset, getWorldElevationOffset } from './elevationOffset.js';
import { toNormalizedRoadY } from './roadElevation.js';
import { setOriginOffset, getOriginOffset } from './originOffset.js';
import { CONFIG } from './config.js';
import { requestShadowRefresh, consumeShadowRefresh } from './shadowRefresh.js';
import { isBenchMode, benchModeKind, startBenchRoute } from './bench/benchRoute.js';
import { initAssetRegistry } from './loaders.js';
import { getRegisteredMaterials, meshKindsFor, onMaterialRegistered } from './map/materialRegistry.js';   // v3 P1-03
import { getHeadlightRig } from './car/headlightRig.js';   // built before the warm-up — see D-39
import { probeRoadFit } from './ui/roadFitProbe.js';   // ?debug=roadfit — measurement only
import { armReport, noteVariant, noteLongFrame, noteResidency, shipReport } from './ui/driveReport.js';   // F9 → one file, see below
let _lastResidencySample = 0;   // task #39: residency series is sampled on a timer, not per frame
import { initLightGrid, setLights, updateLightGrid, patchLightGrid, lightGridABTick, lightGridUniforms, lightGridStats, assertLightingVisible, CELL_M, GRID_DIM } from './map/lightGrid.js';   // v3 P2
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
import { warmAllBuildingMaterials } from './workers/meshMaterializer.js';
import { getWaterMaterial } from './map/waterRenderer.js';

const container = document.getElementById('app');
container.tabIndex = 0;
container.addEventListener('click', () => container.focus(), { once: false });
const { scene, camera, renderer, world, groundBody, groundMesh, worldGroup, spawnCenter,
        ambientLight, hemiLight, dirLight, sky, sunDir } = createScene(container);

setRendererAnisotropy(renderer.capabilities.getMaxAnisotropy());
window._ddRenderer = renderer; // expose for env map generation in carModel
// v3 P1-01: one KTX2Loader + one MeshoptDecoder for the whole app. MUST run before any asset
// load — KTX2Loader cannot pick a transcode target without detectSupport(renderer).
initAssetRegistry(renderer);
window._clearTileCache = clearTileCache; // dev: call after re-bake to flush IndexedDB cache
// Dev: _identify() then CLICK any surface — logs what mesh/material it is (mystery-geometry killer:
// four look-alike "dark band" systems later, naming the thing beats guessing).
window._identify = () => {
  console.warn('[identify] click on the thing…');
  const rc = new THREE.Raycaster();
  const onClick = (e) => {
    window.removeEventListener('click', onClick, true);
    const mv = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    rc.setFromCamera(mv, camera);
    const hits = rc.intersectObjects(scene.children, true).slice(0, 6);
    if (!hits.length) { console.warn('[identify] nothing hit'); return; }
    for (const h of hits) {
      const o = h.object;
      o.geometry?.computeBoundingSphere?.();
      console.warn('[identify]', o.type, o.name || '',
        '| userData:', JSON.stringify(o.userData || {}),
        '| parent:', o.parent?.name || o.parent?.type || '-', JSON.stringify(o.parent?.userData || {}),
        '| mat:', o.material?.type || '-', o.material?.color ? '#' + o.material.color.getHexString() : '',
        o.material?.map ? '(textured)' : '', o.material?.vertexColors ? '(vtxcolor)' : '',
        '| verts', o.geometry?.attributes?.position?.count ?? '-',
        '| radius', o.geometry?.boundingSphere ? o.geometry.boundingSphere.radius.toFixed(0) : '-',
        '| meshPos', o.position.x.toFixed(0) + ',' + o.position.y.toFixed(0) + ',' + o.position.z.toFixed(0),
        '| dist', h.distance.toFixed(1));
    }
  };
  window.addEventListener('click', onClick, true);
};

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
// Attribute the hitches. LoAF reports "FrameRequestCallback 121ms" — one script entry for the whole
// loop, which names nothing. This prints the section breakdown for the same frame, so a stall can be
// pinned on a subsystem instead of guessed at. 50 ms = three missed vsyncs, i.e. visible.
cpuTimer.onLongFrame((wall, _b, str, t0, t1) => {
  // Ignore everything before the car is driveable. Loading is EXPECTED to produce long frames —
  // that is the whole tile build running flat out — and there are enough of them to consume the
  // report budget before the drive starts, leaving nothing for the hitches this exists to catch.
  // Load-time cost is not unmeasured: the time-to-drive gate owns it, and it is a different problem.
  if (_timeToDriveMs == null) return;
  // Async build chunks run between frames, so no section can see them and they land in `other`.
  // Naming them here is the difference between "other 96ms" (GC? build? unknowable) and an owner.
  const async_ = formatChunks(chunksIn(t0, t1));
  recordLongFrame(wall, _b, async_);   // kept for the bench JSON — see frameAttribution.js
  // ⚠ `other` IS NOT AN ANSWER — it is wall time minus every section, so it names nothing on its own.
  // A 2026-08-26 dense-Eixample drive read `other` at **94% of a 50-80 ms frame** with every named
  // section at ~0, no async chunks, and a rAF callback of only 5-15 ms. That is consistent with two
  // completely different causes, and the fix differs entirely between them:
  //
  //   GPU-bound  → gpu ms is near the frame time. The CPU is idle WAITING on the GPU.
  //   not GPU    → gpu ms is small. Then it is GC, compositing, or browser scheduling, and no amount
  //                of scene optimisation will touch it.
  //
  // Resolution was already falsified as the lever (D-33: 49% fewer pixels changed nothing), so if
  // this reads GPU-bound the cost is GEOMETRY — draw calls, vertices, shadow passes — not fill rate.
  // The shadow map is a fixed 1024² and re-renders every caster, which is exactly the kind of GPU
  // cost that is completely indifferent to pixel ratio.
  // ⚠ GPU IS RULED OUT — measured 2026-08-26 on a dense-Eixample drive: gpu 7.3-7.8 ms while the
  // frame took 50-76 ms, i.e. **12% of the frame on average**. Halving the pixels had already failed
  // (D-33); this is the direct confirmation. No scene optimisation — geometry, shadows, draw calls,
  // materials — can touch a bottleneck the GPU is not in.
  //
  // What the same drive DOES show: the JS heap sawtooths **405 ↔ 429 MB, repeatedly**, and LoAF
  // reports the long frames as "NO scripts ≥4ms (GC/clone/style)". A 24 MB swing recovered over and
  // over is allocation churn, and the pauses are the collector.
  //
  // So the question is no longer WHERE the time goes, it is WHO ALLOCATES. cpuTimer already measures
  // heap growth per section; it just was never printed. `heapSnapshot()` is still valid here because
  // finalizeFrame() invokes this callback BEFORE clearing the frame's counters.
  const heapBySection = cpuTimer.heapSnapshot?.() || {};
  const alloc = Object.entries(heapBySection).filter(([, mb]) => mb >= 0.05)
    .sort((a, b) => b[1] - a[1]).map(([k, mb]) => `${k} ${mb.toFixed(2)}MB`).join(' · ');
  // ⚠ `rend` ALLOCATING 7-13 MB PER FRAME is the finding — measured 2026-08-26. `rend` wraps
  // renderer.render(); rendering itself should allocate almost nothing steady-state. Two candidates,
  // and three.js already counts both, so this needs no new instrumentation:
  //
  //   SHADER RECOMPILES → `programs` CLIMBS while driving. Each compile builds large source strings,
  //     which explains both the megabytes and the 429 ms `rend 421.6` frame. Note the program count
  //     is NOT stable run to run (153 here vs 211/212/216 earlier), which is what this looks like.
  //   OBJECT CHURN → `programs` is flat but `calls` is huge, i.e. per-draw-call garbage.
  //
  // `geometries`/`textures` are printed alongside because a climb there is a LEAK, and a leak would
  // explain the heap drifting upward across a session.
  const _ri = renderer.info;
  const info = `  progs ${_ri.programs?.length ?? -1} · calls ${_ri.render.calls} · tris ${(_ri.render.triangles / 1000).toFixed(0)}k` +
    ` · geom ${_ri.memory.geometries} · tex ${_ri.memory.textures}`;
  const _g = gpuTimer.getMs();
  const gpuTag = _g != null ? `  gpu ${_g.toFixed(1)}ms (${Math.round(_g / wall * 100)}% of frame)` : '  gpu n/a';
  const heapMB = (typeof performance !== 'undefined' && performance.memory)
    ? `  heap ${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)}MB` : '';
  // ⚠ RECORDED, NEVER PRINTED. 40 of these lines, each carrying a section breakdown and a
  // renderer.info dump, is more console output than can be copied out of DevTools — which is
  // exactly how this investigation stalled at D-38. driveReport aggregates them; F9 ships the
  // aggregate to a file. There is deliberately no flag to print them per-frame: that output was
  // never readable and never shippable, and having it available is how it gets turned on again.
  noteLongFrame({ wall, sections: _b, async: async_, gpu: _g, heap: heapMB ? performance.memory.usedJSHeapSize / 1048576 : null, alloc: heapBySection, info });
}, 50);
// Hold the budget until the car is drivable — see cpuTimer.holdLongFrames(). Without this the load
// burns all 40 report slots on frames main.js then discards, and no [frame] line ever prints.
cpuTimer.holdLongFrames();

/**
 * compileAsync, bound to the render target we ACTUALLY draw into (D-40).
 *
 * three bakes the output colour space into every program's cache key and reads it from the bound
 * target: null (the canvas) gives `srgb`, a plain WebGLRenderTarget gives `srgb-linear`. Every frame
 * goes through `composer.render()`, into the composer's LINEAR target — so compiling with nothing
 * bound builds a parallel set of programs the session never draws, and the next real frame compiles
 * them all over again.
 *
 * ⚠ THIS IS THE ONLY PLACE ALLOWED TO CALL renderer.compileAsync. There were two call sites; the
 * boot warm-up was fixed and the debounced lightGrid recompile below was not, so the warm-up
 * compiled 150 programs correctly and 1.9 s later the other site recompiled THE WHOLE SCENE in the
 * wrong colour space — 224 programs in a single 50 ms burst, every one of them a duplicate.
 * test/compileTarget.test.js holds the "only one call site" rule.
 *
 * compile() runs synchronously inside compileAsync; only the readiness poll is async. So the target
 * is restored immediately and no frame ever renders with it bound.
 */
function compileForComposer() {
  const prev = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(composer.renderTarget1 ?? null);
    return renderer.compileAsync?.(scene, camera);
  } finally {
    renderer.setRenderTarget(prev);
  }
}

// ── SHADER-VARIANT WATCH (D-38) ────────────────────────────────────────────────────────────────
// 66 programs compiled WHILE DRIVING on a 2026-08-26 drive (153 at time-to-drive → 219), each a
// synchronous compile and each a visible stutter. We know the count climbs; we do NOT yet know WHICH
// variants arrive late, and guessing has been wrong three times today (D-33, D-36, and the
// shadow-map theory). three stores every program's cache key, so the answer is already in memory —
// this just reads it the moment the count grows. Zero cost when nothing is compiling.
//
// A "variant" is one compiled shader program. three derives its cache key from the material TYPE plus
// every feature that changes the generated GLSL — map / vertexColors / fog / side / transparent /
// LIGHT COUNTS / shadows — plus our own patch tags. Two materials sharing all of that share ONE
// program; differ in any one and it is a whole new compile.
let _progSeen = renderer.info.programs?.length ?? 0;
function watchShaderVariants() {
  const list = renderer.info.programs;
  if (!list || list.length <= _progSeen) return;
  for (let i = _progSeen; i < list.length; i++) {
    // Aggregated, never printed: 72 of these per drive, each a few hundred characters of cache key,
    // is unreadable AND unshippable. driveReport diffs each one against the warm-up's vocabulary so
    // the report names the FEATURE that differs, which is the thing a fix can target.
    noteVariant(i + 1, list[i]?.cacheKey ?? '(no cacheKey)');
  }
  _progSeen = list.length;
}

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
  0.28, // strength — restrained/clean bloom (v3 P1-09: was isRallyStyle() ? 0.28 : 0.5)
  0.15,   // radius — TIGHT: bright core with a crisp edge (reference-render glow character);
          // the old 0.4 smeared every emissive into a wide fuzzy orb
  1.1,    // threshold — above sky/clouds (~1.0 max) but reachable by car light emissives
);
composer.addPass(bloomPass);
const radialBlurPass = createRadialBlurPass();
composer.addPass(radialBlurPass);
const colorGradePass = createColorGradePass();
composer.addPass(colorGradePass);
window._colorGradePass = colorGradePass; // DevTools tuning: .uniforms.uGradeStrength.value
// v3 P1-07: SMAA — the largest hole in the corpus. There is NO anti-aliasing anywhere today:
// scene.js requests antialias:false (correct — the composer's HalfFloat targets never got the MSAA
// backbuffer anyway), EffectComposer allocates its targets with no `samples`, and no AA pass
// existed. Three separate v3 audits called AA a hard prerequisite and none of them owned it.
//
// It matters most for what comes NEXT: P4 replaces the solid low-poly foliage blobs with
// alpha-tested cards, and alpha-tested edges in a zero-AA forward pipeline crawl and shimmer at
// speed — visibly worse than the blobs they replace. SMAA rather than FXAA because FXAA smears
// the thin high-contrast lines this game is full of (lane paint, kerbs, window mullions).
//
// LAST before OutputPass: it must run on the graded image, in the same space the player sees.
const smaaPass = new SMAAPass();
composer.addPass(smaaPass);
composer.addPass(new OutputPass());

// Adaptive resolution — auto-drops pixel ratio when the GPU is behind, restores it when there's
// headroom. Owns renderer/composer pixel-ratio + sizing from here on (keeps framerate smooth).
// ── v3 P0-04: benchmark mode (?bench) ──────────────────────────────────────────────────────
// Pin everything that would otherwise silently change what we are measuring. adaptiveResolution
// trades resolution for frame time, so an unpinned run measures the CONTROLLER, not the frame.
const _BENCH = isBenchMode();
// ── v3 P2 LIGHT-GRID SPIKE (?lightgrid) ────────────────────────────────────────────────────────
// Measures the cost of clustered street lighting BEFORE committing the 8 days behind it.
// Kill criterion K-N: >3.0 ms for 32 lights means this approach is wrong and P2 stops here.
// v3 P2-04 SHIPPED 2026-08-25. The grid is ON by default — it is the night lighting, not an
// experiment. P2-06 deleted the fake-night stack (ground-pool decals, hero spill, road/vegetation
// night wash) in exchange for this, so with the grid OFF the city has no street lighting at all;
// "off" is the broken state now, not the safe one. Gate K-N passed on 172 real lamps at
// +0.45 ms mean / +1.51 ms p95 against a 3.0 ms budget.
//   ?nolightgrid  — escape hatch, kills the grid (use to A/B a suspected grid regression by hand)
//   ?lightgrid=ab — run the 40 s A/B harness. NOT on by default: it flips uLGEnabled every 2.5 s,
//                   which visibly strobes the whole scene. That strobe was reported as a bug twice.
const _LGPARAM = (() => { try { return new URLSearchParams(location.search); } catch { return null; } })();
const _LIGHTGRID = !_LGPARAM?.has('nolightgrid');
const _LIGHTGRID_AB = _LGPARAM?.get('lightgrid') === 'ab';

// ?debug=roadfit — measures drawn road vs drawn terrain and prints a distribution. Measurement only:
// renders nothing, changes nothing, costs nothing when the flag is absent. Also exposed as
// window._ddRoadFit() so it can be re-run after driving somewhere interesting without a reload.
const _ROADFIT = _LGPARAM?.get('debug') === 'roadfit';
let _roadFitDone = false;
let _lgArmed = false, _lgCellX = NaN, _lgCellZ = NaN;
let _benchRoute = null;
let _programsAtLoaderHide = null;
let _timeToDriveMs = null;
if (_BENCH) {
  renderer.setPixelRatio(1.0);
  console.warn('[bench] pixel ratio pinned to 1.0; adaptive resolution disabled; night forced');
}

const adaptiveRes = createAdaptiveResolution(renderer, composer, bloomPass, {
  width: container.clientWidth || window.innerWidth,
  height: container.clientHeight || window.innerHeight,
});


// Day / Night toggle — created immediately so the day preset is applied before tile loads.
const envToggle = createEnvToggle({
  scene, renderer, ambientLight, hemiLight, dirLight, sky,
  setLampEmissiveIntensity,
  // Day/night-aware bloom: lower threshold + more strength at night so lamps/windows/signs actually glow.
  setBloom: (strength, threshold) => { bloomPass.strength = strength; bloomPass.threshold = threshold; },
});

// Dynamic PointLights removed — emissive lamp material + ground pool decals
// provide the night streetlight look without per-frame multi-light overhead.


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
let rapierAdapter = null;   // set when Rapier physics is active (default) — streams the collider working set around the car
let boundaryHaze = null;    // world-edge haze curtains (worldBoundary.js)
let _boundaryCooldown = 0;  // seconds until the next out-of-bounds teleport may fire

// ── Live title screen ─────────────────────────────────────────────────────
// Once the spawn area has built, the static title artwork crossfades away (#dd-title.live) and a slow
// cinematic camera orbits the REAL city under the logo/PLAY. Picking a mode hands the camera to carCam,
// whose lerp glides it down behind the car (the "dive"). HUD elements are hidden while the title is live.
let _titleLive = false;
let _titleOrbit = null;     // { x, y, z } — point (physics/scene frame) the cinematic orbits — the CITY
                            //   view (old Diagonal spawn), independent of where the car spawns
let _titleT0 = 0;           // when the descent-from-the-clouds began (performance.now)
// The title cinematic always frames the classic city view even when the CAR spawns elsewhere (e.g. the
// beach). While the title is up, tile streaming follows this point instead of the car, and the car's
// physics is frozen (its own ground tiles may be unloaded); after PLAY the stream snaps back to the car
// and physics stays frozen until the ground under it has streamed back in.
const TITLE_ORBIT_LATLON = { lat: 41.3948, lon: 2.1602 };   // Avinguda Diagonal — the old spawn
let _carHold = false;       // car physics frozen (title up, or ground not yet rebuilt under the car)
let _carHoldT = 0;          // post-PLAY hold timer — safety cap so a missing tile can't freeze us forever
let _titleSky = null;       // saved sky-dome horizon/mid colors (biased bluer during the aerial title)
const _titleFogLanded = new THREE.Color(0x9fd0f2);   // light horizon haze the descent settles into
const TITLE_DESCENT_MS = 5200;   // fall time from cloud level to orbit height
const TITLE_HUD_SELECTOR = '#minimap-frame, #controls-strip, #street-display, #env-toggle, .dd-esc-fab, #performance-panel, #compass-bar, #metrics-panel, #speed-display';
function _setHudHidden(hidden) {
  document.querySelectorAll(TITLE_HUD_SELECTOR).forEach((el) => { el.style.visibility = hidden ? 'hidden' : ''; });
}
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

    // Live-title cinematic centre — the classic city view (old Diagonal spawn), NOT the car spawn
    // (they can be km apart). Set before car creation so the streaming override kicks in immediately.
    // y starts at 0 and is re-sampled from the loaded terrain each frame while the cinematic runs.
    if (ENABLE_CAR) {
      const _tow = latLonToWorld(TITLE_ORBIT_LATLON.lat, TITLE_ORBIT_LATLON.lon);
      _titleOrbit = { x: -(_tow.x - origin.x), y: 0, z: _tow.z - origin.z };
    }

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
        // ── Rapier (WASM) physics — the ONLY engine (cannon step path deleted 2026-07-16 after
        //    release soak; ?physics=cannon escape hatch removed with it). The cannon world is never
        //    stepped — cannon-es remains ONLY as the collider DESCRIPTOR layer: tileManager keeps
        //    adding CANNON bodies to `world`, and we MIRROR each into Rapier via the adapter —
        //    boxes/meshes 1:1, terrain as a NATIVE Rapier heightfield (convention probed at runtime,
        //    trimesh fallback). If Rapier init fails (no WASM), we throw → the outer catch drops to
        //    the free camera.
        const _rapier = (await import('@dimforge/rapier3d-compat')).default;
        await _rapier.init();
        const _physicsWorld = new _rapier.World({ x: 0, y: -9.82, z: 0 });
        _physicsWorld.timestep = 1 / 60;
        // Deep safety backstop only — terrain + road colliders are the real surface now. Placed far
        // below (−60 m) so it never lifts the car off a road/terrain that dips below spawn height; it
        // just catches a catastrophic fall (freefall-recovery is the primary backstop).
        const gb = _physicsWorld.createRigidBody(_rapier.RigidBodyDesc.fixed().setTranslation(spawnLocalPos.x, spawnLocalPos.y - 60, spawnLocalPos.z));
        _physicsWorld.createCollider(_rapier.ColliderDesc.cuboid(4000, 1, 4000).setFriction(1.0), gb);
        const { createRapierWorldAdapter } = await import('./physics/rapierWorldAdapter.js');
        const _adapter = createRapierWorldAdapter(_physicsWorld, _rapier);
        for (const b of [...world.bodies]) { try { _adapter.addBody(b); } catch {} }   // register already-loaded tiles
        const _oAdd = world.addBody.bind(world), _oRem = world.removeBody.bind(world);  // register future tiles
        world.addBody = (b) => { _oAdd(b); try { _adapter.addBody(b); } catch {} };
        world.removeBody = (b) => { _oRem(b); try { _adapter.removeBody(b); } catch {} };
        rapierAdapter = _adapter;   // animate() streams the working set around the car each frame
        window._rapierWorld = _physicsWorld;   // dev: _rapierWorld.colliders.len() shows the live working set
        // Frame-pipeline round 2 (fps-diagnosis): cannon never STEPS or RAYCASTS — its Trimesh
        // octree (built synchronously in the ctor, consumed only by cannon narrowphase/raycast)
        // is pure wasted main-thread time on every road-deck/terrain trimesh a streaming tile
        // creates. Stub it. AABB/bounding-sphere come from vertex scans (not the tree), so
        // addBody and the Rapier mirror are unaffected.
        const { Trimesh: _CTrimesh, Box: _CBox } = await import('cannon-es');
        _CTrimesh.prototype.updateTree = function () {};
        // Round 2b (allocation sample, user capture): also skip Trimesh edge/normal tables and
        // Box's ConvexPolyhedron representation — all narrowphase-only data cannon never uses.
        // The box convex rep alone was ~17MB of churn per streaming drive (makeCheapBox +
        // addShape + _ConvexPolyhedron in the profile). The adapter reads Box.halfExtents /
        // Trimesh.vertices+indices only; AABBs are computed independently.
        _CTrimesh.prototype.updateEdges = function () {};
        _CTrimesh.prototype.updateNormals = function () {};
        _CBox.prototype.updateConvexPolyhedronRepresentation = function () { this.convexPolyhedronRepresentation = null; };
        window._ddRapierActive = true;   // tileManager builds lean Box colliders when set
        if (CONFIG.DEBUG_INIT) console.warn(`[physics] Rapier enabled — streaming mirror over ${world.bodies.length} registered bodies (cannon BVH stubbed).`);
        carDriver = await createCarDriver(scene, _physicsWorld, groundMesh, camera, spawnLocalPos, renderer.domElement, groundBody, spawnResult.heading, {
          rapier: _rapier, cpuTimer,
          // World boundary: never record a recovery breadcrumb outside the baked region — the
          // out-of-bounds teleport returns to the crumb, so the crumb must stay in-bounds.
          // Physics → ABSOLUTE world uses the HUD convention (−lx + originOffset).
          isCrumbSafe: (lx, lz) => {
            const o = getOriginOffset();
            return isInsidePlayArea(-lx + o.x, lz + o.z);
          },
        });
        // Boundary haze curtains DISABLED (user, 2026-07-12): suspected source of the giant white
        // blur at certain fly-mode angles — the curtains use absolute world coords inside
        // worldGroup, which ALSO applies the floating-origin offset → likely displaced into the
        // map as huge white planes. The out-of-bounds RETURN below still works (its coordinate
        // conversion is HUD-verified). Re-enable only after re-parenting/offset-correcting them.
        // boundaryHaze = createBoundaryHaze(worldGroup);
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
        // Subtle controls hint, bottom-centre — thin uppercase, wide tracking (art-of-rally caption).
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
    // Touch driving controls (phones/tablets only — no-op on fine-pointer devices).
    // Buttons dispatch synthetic arrow-key events, so carControls/inputGate apply unchanged.
    if (ENABLE_CAR) initTouchControls();
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
    const _hideLoader = () => { const l = document.getElementById('dd-loading'); if (l && !l.classList.contains('hide')) {
      l.classList.add('hide'); setTimeout(() => l.remove(), 700); } };
    let _polls = 0;
    const _pollLoad = setInterval(() => {
      _polls++;
      window._ddGate = { polls: _polls, complete: !!(tileManager?.isInitialLoadComplete?.()), car: !!carDriver, orbit: !!_titleOrbit, title: document.getElementById('dd-title')?.className ?? 'gone' };
      const _done = tileManager?.isInitialLoadComplete?.();
      if (_done || _polls > 130) {
        clearInterval(_pollLoad);
        // ⚠ NOT GATED behind ?debug — a time-to-drive that is really a TIMEOUT is the difference
        // between "loading takes 20 s" and "loading finished and nobody noticed", and those have
        // nothing in common. Three drives on 2026-08-27 measured 19.4 / 20.0 / 21.3 s against a
        // ledger figure of 6.94 s, and the cap is 130 polls x 150 ms = 19.5 s. A number that lands
        // on its own timeout is usually the timeout.
        try {
          const st = tileManager?.getInitialLoadState?.() ?? {};
          if (_done) {
            console.warn('[perf] initial tile load COMPLETE after %d polls (~%d ms), %d tiles resident',
              _polls, Math.round(_polls * 150), st.resident ?? -1);
          } else {
            console.warn('[perf] initial tile load GAVE UP at the %d-poll cap (~%d ms) — still %d in flight, '
              + '%d queued, %d resident. time-to-drive is measuring this timeout, not the load.',
              _polls, Math.round(_polls * 150), st.inFlight ?? -1, st.pending ?? -1, st.resident ?? -1);
          }
          // WHERE THE LOAD ACTUALLY WENT. Ungated, for the same reason as the line above: this is the
          // largest single cost in the game and it has never been reported. `takeBuildOverruns()`
          // has been exported and unread since it was written; this is its total-per-phase sibling.
          const phases = tileManager?.getBuildPhaseTotals?.() ?? [];
          if (phases.length) {
            const total = phases.reduce((a, p) => a + p.ms, 0);
            console.warn('[perf] initial load, main-thread time by build phase (%d ms total): %s',
              Math.round(total),
              phases.slice(0, 8).map((p) => `${p.phase} ${Math.round(p.ms)}ms/${p.chunks}`).join(' · '));
          }
        } catch { /* diagnostics must never break the boot */ }
        _hideLoader();
        // Go LIVE behind the title: crossfade the static artwork to the real city + start the cinematic
        // orbit (only in car mode, and only if the player hasn't already entered the game).
        try { window._ddBootDone?.(); } catch {}   // boot loader → 100% + fade, reveal the title content
        try {
          const titleEl = document.getElementById('dd-title');
          if (titleEl && !titleEl.classList.contains('hide') && carDriver && _titleOrbit) {
            titleEl.classList.add('live');
            _titleLive = true;
            _titleT0 = performance.now();   // begin the descent from the clouds
            _setHudHidden(true);
            // Full-detail 3×3 set for the aerial shot (photo mode also disables the LOD/distance fades,
            // so the periphery isn't flat boxes). Was 5×5, but 25 full-detail tiles (geometry + physics
            // colliders) held ~1 GB while idling on the title; 3×3 keeps the framing — the camera orbits
            // looking at the CENTRE and the ring edge sits under the descent haze. Restored on entering.
            try { tileManager.setPhotoRadius(1); tileManager.setPhotoMode(true); } catch {}
            // From altitude the camera only sees the sky dome's near-white HORIZON band, and the street-level
            // pastel palette reads dead grey up there. Give the cinematic its own decisive blues (all three
            // stops saved + restored on entering the game).
            try {
              const su = sky?.material?.uniforms;
              if (su?.uHorizon && su?.uMid && su?.uZenith) {
                _titleSky = { h: su.uHorizon.value.clone(), m: su.uMid.value.clone(), z: su.uZenith.value.clone(),
                              f: scene.fog ? scene.fog.color.clone() : null };
                // NIGHT-AWARE: the day sky-blue haze against a near-black night sky read as a
                // frosted-glass band cutting the skyline. At night the aerial fades into deep
                // navy instead — buildings dissolve into darkness, lit windows punch through.
                if (envToggle?.isNight?.()) {
                  su.uHorizon.value.set(0x16263f);
                  su.uMid.value.set(0x0e1a30);
                  su.uZenith.value.set(0x070f1f);
                  if (scene.fog) scene.fog.color.set(0x131f36);
                } else {
                  su.uHorizon.value.set(0x9fd0f2);
                  su.uMid.value.set(0x54a4e8);
                  su.uZenith.value.set(0x2b78d2);
                  if (scene.fog) scene.fog.color.set(0x9fd0f2);   // haze reads as sky-blue, not grey
                }
              }
            } catch {}
          }
        } catch {}
        // Spawn-area material singletons now exist — re-apply night state so a night reload isn't half-day.
        try { envToggle?.reapply?.(); } catch {}
        // ⚠ MUST PRECEDE THE WARM-UP BELOW. Arming patches every registered material, which
        // invalidates its compiled program. Arm first and the warm-up compiles the grid-patched
        // variants; arm after (the pre-2026-08-25 order, from the animate loop) and the warm-up's
        // entire output is discarded — 864 ms arm frame, then lamps flickering off and on every
        // 3-4 s for the whole load as each tile burst triggered another recompile.
        try { armLightGrid(); } catch {}
        // ⚠ SAME RULE AS armLightGrid, FOR LIGHTS. three bakes the scene's light COUNTS into every
        // shader's cache key, so a light appearing later invalidates every material in the world.
        // The car's two headlight SpotLights used to be created with the car, which moved the count
        // 1,0,0,0 -> 1,0,2,2 the instant it spawned and threw the entire warm set away: a
        // 2026-08-26 drive measured 72 programs compiling after this point, each a synchronous
        // main-thread compile (D-39). Building the rig HERE — before compileAsync, and permanently —
        // means the warm-up compiles the light set the session actually runs with.
        try { getHeadlightRig(scene); } catch {}
        // Warm the GPU shader programs once now (materials are shared singletons, so this compiles almost
        // every program the session will ever use). Kills the first-render compile stall as new tiles
        // stream in at speed. compileAsync runs off the render path (KHR_parallel_shader_compile).
        // The warm set includes every buildable material VARIANT (all facade categories × hero,
        // roof, details) on tiny hidden triangles — otherwise the first tile introducing a new
        // variant sync-compiles mid-drive (one-off ~100 ms render frames, forensics-confirmed).
        try {
          // v3 P1-04: the warm set was buildings-only. Vegetation is the family that actually runs on
          // BatchedMesh (the veg pools), so its materials are the ones whose USE_BATCHING variant was
          // compiling mid-drive.
          //
          // ⚠ USE THE SEAMS. This warmed `getBushMaterial()` — the BLOB material — while the live
          // path had already switched to bush cards, so the material that actually renders was never
          // warmed at all. It also called getTreeBillboardMaterial(v) per variant, a signature that
          // stopped existing when P3-10(c) collapsed the impostors to one material. Warm what
          // getTreeMaterial/getBushCardsMaterial return, never a specific implementation.
          const _warmMats = [...warmAllBuildingMaterials(), getWaterMaterial()];
          try {
            _warmMats.push(getTreeMaterial(), getBushCardsMaterial(), getTreeBillboardMaterial());
          } catch {}
          // v3 P1-03: anything the material registry has patched is, by definition, a material with
          // a non-default shader — exactly the set that sync-compiles on first appearance. Pulling
          // from the registry means the warm list stops being a hand-maintained array that silently
          // falls behind (the P0-05 baseline measured 8 programs still compiling mid-drive).
          try {
            for (const m of getRegisteredMaterials()) if (m && !_warmMats.includes(m)) _warmMats.push(m);
          } catch {}
          const _wg = new THREE.BufferGeometry();
          _wg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0.01, 0, 0.01, 0, 0], 3));
          _wg.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
          _wg.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 0], 2));
          _wg.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
          _wg.setAttribute('aWash', new THREE.Float32BufferAttribute([0, 0, 0], 1));
          // v3 P1-04: the facade shader DECLARES `attribute float aAO` (patchRoadAO / the facade
          // injection), and this geometry did not provide it. A warm mesh missing a declared
          // attribute does not compile the same program the real mesh will.
          _wg.setAttribute('aAO', new THREE.Float32BufferAttribute([0, 0, 0], 1));
          // v3 P4-15a: the tire-smoke patch declares `attribute float aOpacity` (instanced-only).
          _wg.setAttribute('aOpacity', new THREE.Float32BufferAttribute([0, 0, 0], 1));
          const _warmGrp = new THREE.Group();
          // v3 P1-04: warm through the REAL mesh types, not just plain Mesh.
          //
          // three compiles a SEPARATE program per USE_BATCHING / USE_INSTANCING define. Warming
          // every material on a plain THREE.Mesh therefore compiled only the vanilla variant, and
          // the first BatchedMesh (vegetation pools) or InstancedMesh (parked cars, peds,
          // streetlight parts) to appear mid-drive still sync-compiled — which is exactly what the
          // P0-05 baseline caught: 141 -> 149 programs during a 90 s drive, against a gate of 0.
          //
          // Cost is a few more hidden triangles at boot, all through compileAsync, which is off the
          // render path (KHR_parallel_shader_compile). That is the trade this warm-up exists to make.
          for (const m of _warmMats) {
            // v3: ask the registry which mesh kinds this material is VALID on. A patch that reads
            // instanceMatrix (the cloud material) does not compile on a plain Mesh — warming it
            // that way produced "'instanceMatrix' : undeclared identifier" and a VALIDATE_STATUS
            // failure on every frame. Warming the wrong combination is worse than not warming.
            const kinds = meshKindsFor(m);
            if (kinds.includes('mesh')) {
              const wm = new THREE.Mesh(_wg, m); wm.frustumCulled = false; _warmGrp.add(wm);
            }
            if (kinds.includes('instanced')) {
              try {
                const im = new THREE.InstancedMesh(_wg, m, 1);
                im.setMatrixAt(0, new THREE.Matrix4());
                im.frustumCulled = false; _warmGrp.add(im);
              } catch {}
            }
            if (kinds.includes('batched')) {
              try {
                const bm = new THREE.BatchedMesh(1, 3, 3, m);
                const gid = bm.addGeometry(_wg);
                bm.addInstance(gid);
                bm.frustumCulled = false; _warmGrp.add(bm);
              } catch {}
            }
          }
          _warmGrp.position.set(0, -5000, 0);
          scene.add(_warmGrp);
          // Compiled against the composer's target, like every other compile — see
          // compileForComposer() for why that matters (D-40).
          // Force every vegetation atlas onto the GPU here, not on the frame that first draws it.
          // See preloadCardAtlases — this is a 100-200 ms mid-drive stall moved into boot, where a
          // stall is already expected and already measured by time-to-drive.
          // KTX2 transcoding picks its target format from the GPU's capabilities, so the facade
          // array loader needs the renderer before it can decode anything. Handed over here rather
          // than threaded through meshMaterializer, which constructs the arrays lazily per tile.
          try { setFacadeArrayRenderer(renderer); } catch {}
          try { preloadCardAtlases(renderer); } catch {}
          try { preloadRoadTextures(renderer); } catch {}   // road is drawn on frame 1 of every drive

          const _p = compileForComposer();
          // ⚠ The warm group MUST come back out, on every path. three's own readiness poll can die
          // mid-flight — a 2026-08-26 drive caught `Cannot read properties of undefined (reading
          // 'isReady')` thrown from inside compileAsync's setTimeout, which leaves the promise
          // permanently unsettled. That is not a rejection we can catch, so it left several hundred
          // hidden frustumCulled=false meshes in the scene, drawn every frame for the rest of the
          // session. The timeout is the backstop; whichever fires first wins.
          let _warmRemoved = false;
          const _dropWarmGroup = () => {
            if (_warmRemoved) return;
            _warmRemoved = true;
            scene.remove(_warmGrp);
          };
          if (_p?.then) _p.then(_dropWarmGroup, _dropWarmGroup); else _dropWarmGroup();
          setTimeout(_dropWarmGroup, 20000);
        } catch {}
        // Auto-start the chosen mode — but ONLY on reload flows where the title never existed
        // (/game path or ?spawn). On the fresh title flow the mode-select loader in animate()
        // starts the mode once the spawn area has streamed in (this gate fires while the player
        // is still on the title, before they've picked anything).
        try {
          if (!document.getElementById('dd-title')) {
            const chosen = sessionStorage.getItem('dd_mode');
            if (chosen === 'dash') dashMode?.start?.();
            else if (chosen === 'taxi') taxiMode?.start?.();
            else if (chosen === 'delivery') deliveryMode?.start?.();
            else if (chosen === 'police') policeMode?.start?.();
          }
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
let _lastCarShadowX = -Infinity, _lastCarShadowZ = -Infinity;
const CAR_SHADOW_THRESHOLD_SQ = 0.5 * 0.5; // hero car is the only dynamic caster — refresh its shadow every 0.5m
const SHADOW_UPDATE_THRESHOLD_SQ = 12 * 12; // update shadow camera every 12m (was 5) — fewer full shadow re-renders (less per-frame Three.js churn + GPU); imperceptible for a 200m-radius directional shadow


// ── v3 P2-04: real street lamps into the light grid ───────────────────────────────────────────────
//
// ⚠ COORDINATE FRAME — the landmine this whole function exists to defuse. tileManager is created
// with `worldGroup` as its scene, so every lamp position it returns is in worldGroup-LOCAL space.
// worldGroup carries BOTH `scale.x = -1` and the floating-origin translation, while the shader's
// `vLGWorldPos = modelMatrix * transformed` is in TRUE world space, and `camera` is a child of the
// scene (not worldGroup) so `camera.position` is true world too.
//
// Local and world are therefore DIFFERENT frames, and getting it wrong puts every lamp's pool on
// the wrong side of the street — symmetrically, so it reads as "the lighting is subtly off" rather
// than as an obvious bug. We do NOT hand-derive the signs (see CLAUDE.md's warning about exactly
// this): three's own matrices do it.
//
// The cull runs in LOCAL space on purpose: the mirror has |scale| = 1 and translation preserves
// distance, so local distances equal world distances — which lets us reject most lamps with two
// subtractions and convert only the survivors.
const _lgTmp = new THREE.Vector3();
const _lgCamLocal = new THREE.Vector3();
const _lgColor = new THREE.Color(REGION.night?.lampColor ?? 0xFFB25E);
let _lgLampCount = 0;
let _lgDirtyPrograms = false;   // a material was patched → its program needs rebuilding
let _lgLastCompile = 0;
let _lgTileEpoch = -1;

// Live tuning. Night lighting is a look decision, and a look decision made through edit-rebuild-
// reload cycles gets made badly — the previous value is gone by the time the new one renders.
// window._lg.set({ intensity: 0.8 }) applies on the next rebuild, which is one cell crossing away.
const _lgTune = { intensity: null, radius: null };
if (typeof window !== 'undefined') {
  window._lg = {
    set(o = {}) {
      if (o.intensity != null) _lgTune.intensity = o.intensity;
      if (o.radius != null) _lgTune.radius = o.radius;
      if (o.wrap != null) lightGridUniforms.uLGWrap.value = o.wrap;
      if (o.coneFloor != null) lightGridUniforms.uLGConeFloor.value = o.coneFloor;
      if (o.conePower != null) lightGridUniforms.uLGConePower.value = o.conePower;
      rebuildLightGrid();
      if (CONFIG.DEBUG_INIT) console.warn('[lightgrid] intensity %s · radius %s · wrap %s · %d lamps',
        _lgTune.intensity ?? REGION.night?.lampIntensity, _lgTune.radius ?? REGION.night?.lampRadiusM,
        lightGridUniforms.uLGWrap.value.toFixed(2), _lgLampCount);
    },
    stats: () => ({ ...lightGridStats, lamps: _lgLampCount }),
  };
}

function rebuildLightGrid() {
  const positions = tileManager.getStreetlightPositions();
  _lgCamLocal.copy(camera.position);
  worldGroup.worldToLocal(_lgCamLocal);

  const half = (GRID_DIM * CELL_M) / 2;      // 256 m — anything outside the window cannot contribute
  const half2 = half * half;
  const radius = _lgTune.radius ?? REGION.night?.lampRadiusM ?? 26;
  const intensity = _lgTune.intensity ?? REGION.night?.lampIntensity ?? 1.1;

  const lights = [];
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const dx = p.x - _lgCamLocal.x, dz = p.z - _lgCamLocal.z;
    if (dx * dx + dz * dz > half2) continue;
    _lgTmp.set(p.x, p.y, p.z);
    worldGroup.localToWorld(_lgTmp);
    lights.push({ x: _lgTmp.x, y: _lgTmp.y, z: _lgTmp.z, radius, color: _lgColor, intensity });
  }
  _lgLampCount = lights.length;
  setLights(lights, { x: camera.position.x, z: camera.position.z });
  updateLightGrid(camera.position.x, camera.position.z);
}

/**
 * Arm the light grid: patch every material the registry knows (and every one it learns about
 * later) so the clustered street lighting reaches them. Idempotent — safe to call from both the
 * boot path and the animate-loop fallback.
 *
 * ⚠ CALL THIS BEFORE THE BOOT SHADER WARM-UP. Patching a material invalidates its compiled
 * program. When this ran AFTER the warm-up (it did until 2026-08-25, from the animate loop) every
 * program the warm-up had just built was thrown away and recompiled on the next draw — a measured
 * 864 ms `rend` arm frame — and each subsequent tile burst registered more materials, so the
 * debounced compileAsync below fired again and again. The visible symptom was NOT a stall: the
 * lamps popped OFF and back ON every 3-4 seconds through the whole load, settling only when tile
 * streaming stopped. Arming first means the warm-up compiles the patched variants once.
 */
function armLightGrid() {
  // The flag guard lives HERE, not at the call sites: the boot call site runs before the animate
  // loop's `if (_LIGHTGRID && ...)` gate would ever be reached, and without this the grid would arm
  // for every player rather than only under ?lightgrid.
  if (!_LIGHTGRID || _lgArmed || !tileManager) return;
  _lgArmed = true;
  initLightGrid();
  // Subscribe rather than sweep once: tile materials are created lazily, so a one-time sweep
  // lights the spawn tiles and nothing you drive into afterwards — the lighting would appear
  // to stop working partway down the street, with no error to explain it. replayExisting
  // handles the already-built spawn tiles in the same call.
  let patched = 0;
  onMaterialRegistered((m) => { try { patchLightGrid(m); patched++; _lgDirtyPrograms = true; } catch { /* non-lit material */ } });
  rebuildLightGrid();
  const vis = assertLightingVisible({
    radius: _lgTune.radius ?? REGION.night?.lampRadiusM, intensity: _lgTune.intensity ?? REGION.night?.lampIntensity,
    wrap: lightGridUniforms.uLGWrap.value, coneFloor: lightGridUniforms.uLGConeFloor.value,
    conePower: lightGridUniforms.uLGConePower.value });
  if (CONFIG.DEBUG_INIT) console.warn('[lightgrid] armed — %d materials patched, %d lamps in range. Road under a lamp %s, at 15 m %s.',
    patched, _lgLampCount, vis.under.toFixed(3), vis.mid.toFixed(3));
}

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
    // Ground-level fog washes out the aerial title cinematic (camera at ~115m+ in 0.005 fog = white soup),
    // so it's nearly off while the title is live — like drone mode — and restored on entering the game.
    // ALTITUDE FADE (user report: "huge blur at certain angles" from the in-car drone view): the
    // same white-soup applies whenever the camera climbs, so full density only below ~40 m,
    // fading to near-none by ~180 m. Ground driving is unchanged (camera ≈ 5 m).
    // v3 D-06: modulate the ACTIVE day/night preset (DAY 0.0032 / NIGHT 0.0045) rather than a
    // hardcoded 0.005. The old constant overwrote envToggle every frame, so neither tuned value had
    // ever shipped. Drone/title/altitude behaviour below is unchanged — G-44's invariant holds.
    const _camAlt = camera?.position?.y ?? 0;
    const _fogAltFade = Math.max(0.08, Math.min(1, 1 - (_camAlt - 40) / 140));
    const _fogBase = getPresetFogDensity();
    scene.fog.density = carDriver ? (_titleLive ? _fogBase * 0.12 : _fogBase * _fogAltFade) : 0;
  }

  // Title-up detection: while the title screen is visible the world streams around the CINEMATIC
  // centre (see the viewer override below), so the car's own ground may be unloaded.
  const _titleEl = document.getElementById('dd-title');
  const _titleUp = !!(_titleEl && !_titleEl.classList.contains('hide'));

  if (carDriver) {
    // ── Car driving mode ──────────────────────────────────────────────────────
    // While the title is up the car's physics is frozen entirely (its ground may not exist). After
    // PLAY, stay frozen until the ground under the car has streamed back in (capped so it can't stick).
    if (_titleUp && _titleOrbit) { _carHold = true; _carHoldT = 0; }
    else if (_carHold) {
      _carHoldT += frameDt;
      const _clp = carDriver.getLocalPosition();
      const _cs = tileManager?.getSurfaceHeightAt?.(-_clp.lx, _clp.lz);
      if ((_cs && Number.isFinite(_cs.surfaceY)) || _carHoldT > 12) _carHold = false;
    }

    // Mode-select loader (created by the title's enter()): lift it only when the world around the
    // car is genuinely ready — car unfrozen (ground underneath) AND the streaming queue drained.
    // This is also the right moment to start the chosen game mode (roads exist for gates/fares).
    if (window._ddModeLoadDone && !_titleUp && !_carHold && tileManager?.isInitialLoadComplete?.()) {
      try { window._ddModeLoadDone(); } catch {}
      window._ddModeLoadDone = null;
      try {
        const _chosen = sessionStorage.getItem('dd_mode');
        if (_chosen === 'dash') dashMode?.start?.();
        else if (_chosen === 'taxi') taxiMode?.start?.();
        else if (_chosen === 'delivery') deliveryMode?.start?.();
        else if (_chosen === 'police') policeMode?.start?.();
      } catch {}
    }
    // Skip the chase camera while the taxi mode is playing a pickup/drop-off cinematic (it drives the
    // camera itself, in taxiMode.update below) or while the title cinematic owns the camera. The freeze
    // flag additionally skips the physics step (car pinned; carCam still glides post-PLAY).
    carDriver.update(frameDt, !!(taxiMode?.isCinematic?.() || deliveryMode?.isCinematic?.()) || _titleLive || _titleUp, _carHold);

    // Live title: descend FROM the cloud deck into the city (clouds part in sync), then settle into a
    // slow orbit under the logo/PLAY. Picking a mode releases the camera — carCam's lerp glides it down
    // behind the car (the dive-in).
    if (_titleLive) {
      // Orbit height rides on the real terrain under the cinematic centre (the centre is normalized to
      // the CAR spawn's elevation frame, so a hillside city view can sit tens of metres above y=0).
      const _ogy = tileManager?.getTerrainHeightAt?.(-_titleOrbit.x, _titleOrbit.z);
      if (Number.isFinite(_ogy)) _titleOrbit.y = _ogy;
      const _p = Math.min(1, (performance.now() - _titleT0) / TITLE_DESCENT_MS);
      const _ease = _p * _p * (3 - 2 * _p);              // smoothstep fall — quick drop, soft landing
      const _ta = time * 0.001 * 0.045;                  // ~2.3 min per orbit — unhurried
      const _tr = 200, _th = 115, _cloudAlt = 340;       // orbit height + starting altitude above it
      camera.position.set(
        _titleOrbit.x + Math.cos(_ta) * _tr,
        _titleOrbit.y + _th + (1 - _ease) * _cloudAlt + Math.sin(_ta * 0.5) * 8,
        _titleOrbit.z + Math.sin(_ta) * _tr,
      );
      // Aim slightly above the ground so the frame includes real sky + the drifting 3D clouds — pure
      // top-down framing showed only the dome's washed horizon band ("dead sky").
      camera.lookAt(_titleOrbit.x, _titleOrbit.y + 55, _titleOrbit.z);
      // Light altitude haze that clears as we land — kept SUBTLE (a heavy start read as a grey wall);
      // the city should be visible the whole way down, just softened at the top of the drop. The haze
      // COLOUR sweeps from a rich sunny sky-blue at the top of the fall to the light horizon haze on
      // landing, so the transition reads sky→ground instead of a grey veil.
      if (scene.fog) {
        scene.fog.density = 0.0006 + Math.pow(1 - _ease, 1.6) * 0.006;
        // Night-aware sweep: day falls sunny-blue → light horizon haze; night falls deep navy →
        // the pre-title night fog colour (captured in _titleSky.f), so the descent stays nocturnal.
        if (envToggle?.isNight?.()) {
          scene.fog.color.setHex(0x131f36).lerp(_titleSky?.f || _titleFogLanded, _ease);
        } else {
          scene.fog.color.setHex(0x62b4f0).lerp(_titleFogLanded, _ease);
        }
      }
      const _te = document.getElementById('dd-title');
      if (!_te || _te.classList.contains('hide')) {
        _titleLive = false;
        _setHudHidden(false);
        try { tileManager.setPhotoMode(false); } catch {}   // back to the normal streaming radius
        try {   // restore the gameplay sky gradient
          const su = sky?.material?.uniforms;
          if (_titleSky && su?.uHorizon && su?.uMid && su?.uZenith) {
            su.uHorizon.value.copy(_titleSky.h); su.uMid.value.copy(_titleSky.m); su.uZenith.value.copy(_titleSky.z);
            if (scene.fog && _titleSky.f) scene.fog.color.copy(_titleSky.f);
          }
        } catch {}
      }
    }
    cpuTimer.lap('phys');

    const lp = carDriver.getLocalPosition();
    rapierAdapter?.tick(lp.lx, lp.lz);   // stream the Rapier collider working set around the car
    // World boundary: past the haze curtains + grace band → return to the last in-bounds road
    // (breadcrumb teleport — same mechanism as the R key). Cooldown prevents rapid-fire loops.
    // ABSOLUTE world = HUD convention (−lx + originOffset) — v1 skipped the offset → respawn loop.
    _boundaryCooldown = Math.max(0, _boundaryCooldown - frameDt);
    if (_boundaryCooldown === 0) {
      const _bo = getOriginOffset();
      if (outOfBoundsM(-lp.lx + _bo.x, lp.lz + _bo.z) > BOUNDARY_GRACE_M) {
        _boundaryCooldown = 2.5;
        carDriver.recoverToCrumb?.();
      }
    }
    // Physics / scene X is mirrored relative to world/map X (worldGroup.scale.x = -1),
    // so convert back to world coordinates by negating X (same convention as free camera).
    viewerWx = -lp.lx;
    viewerWz = lp.lz;
    speedKmh = carDriver.getSpeedKmh();

    // AI traffic + parked cars + pedestrians — player position is in the physics frame (lp.lx, lp.lz).
    if (contactShadows) contactShadows.begin();
    if (trafficSystem) trafficSystem.update(lp.lx, lp.lz, frameDt, speedKmh);
    cpuTimer.lap('traffic');
    if (parkedCars) { parkedCars.update(lp.lx, lp.lz); parkedCars.drawShadows(contactShadows); }
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

  // While the title screen is up (car mode), stream tiles around the CINEMATIC centre — the classic
  // city view — not the car, which may be parked kilometres away (beach spawn) and sits frozen until
  // PLAY brings the stream back to it.
  if (_titleUp && _titleOrbit && ENABLE_CAR) {
    viewerWx = -_titleOrbit.x;
    viewerWz = _titleOrbit.z;
    headingDeg = 0;
    speedKmh = 0;
  }

  tileManager.update(viewerWx, viewerWz, { headingDeg, speedKmh: Math.abs(speedKmh || 0) });
  cpuTimer.lap('tiles');
  // v3 P0-13b: all three sky bodies are parented to `scene` (scene.js:288/372/492), i.e. the
  // UNMIRRORED frame — so all three need camera SCENE-frame coords. The moon was fixed for exactly
  // this in 2026-07-12; clouds and stars were left on viewerWx/Wz, which is `-lp.lx` (the mirrored
  // world convention used for tile streaming). updateStars assigns straight to position.x, so the
  // star field was offset by ~2x the viewer X and slid as you drove east/west.
  updateClouds(camera.position.x, camera.position.z);
  updateMoon(camera.position.x, camera.position.z);
  updateStars(camera.position.x, camera.position.z);

  cpuTimer.lap('sky');     // clouds / moon / stars

  const origin = getOriginOffset();
  const worldWx = viewerWx + origin.x;
  const worldWz = viewerWz + origin.z;

  // Throttle road segment lookup — only re-query when moved >10m
  const rdDx = worldWx - _lastRoadQueryX, rdDz = worldWz - _lastRoadQueryZ;
  if (rdDx * rdDx + rdDz * rdDz > ROAD_QUERY_THRESHOLD_SQ) {
    const segments = tileManager.getLoadedRoadSegments();
    _cachedNearestRoad = queryNearestRoadSegment(segments, worldWx, worldWz);
    _lastRoadQueryX = worldWx;
    _lastRoadQueryZ = worldWz;
  }
  cpuTimer.lap('roadq');   // nearest-road lookup — O(all roads in all tiles) when it fires
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
  cpuTimer.lap('hud');     // minimap / compass / metrics / speed lines — DOM + canvas work
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
      requestShadowRefresh();   // the shadow camera moved — its whole frustum is stale
    }
  }

  // v3 P0-03: the hero car is the only remaining DYNAMIC caster (traffic, peds and parked cars are
  // all castShadow:false). Its shadow must track it, so ask for a refresh whenever it has moved a
  // meaningful distance. NOTE this means that while driving we refresh most frames — the real
  // saving from autoUpdate=false lands when stationary, slow, or in fly mode, NOT at the 80 km/h
  // benchmark. See docs/context/v3-execution-tracker.md P0-03 for the measurement.
  if (dirLight && dirLight.castShadow && carDriver) {
    const cp = carDriver.getLocalPosition();          // physics coords; distance is mirror-invariant
    const cDx = cp.lx - _lastCarShadowX, cDz = cp.lz - _lastCarShadowZ;
    if (cDx * cDx + cDz * cDz > CAR_SHADOW_THRESHOLD_SQ) {
      _lastCarShadowX = cp.lx;
      _lastCarShadowZ = cp.lz;
      requestShadowRefresh();
    }
  }

  // Animate traffic light colors (red/yellow/green cycling)
  if (CONFIG.ENABLE_ROAD_INFRA) {
    // v3 P0-13: was `CONFIG.ENABLE_DAY_NIGHT && timeSystem.isNight()`, which was ALWAYS false
    // (the flag has been off since the auto-cycle was reverted). Behaviour preserved exactly.
    // TODO P2: wire envToggle.isNight() here — the real day/night authority — so traffic
    // lights finally get night treatment. Deliberately NOT done in P0: deletion phase only.
    updateTrafficLights(time / 1000, false);
  }

  // Blink red beacon lights on communication towers
  updateTowerBeacons(time / 1000);
  // World-edge curtains: drift + day/night colour + proximity fade (invisible past ~400m —
  // at full strength they read as a flashing white horizon wall from the coast).
  boundaryHaze?.update(frameDt, scene.fog?.color, worldWx, worldWz);

  if (CONFIG.DEBUG_COLLIDERS) {
    updateDebugColliders(scene, world);
  }

  // ?debug=roadfit — fire ONCE, 6 s after the car is driveable, so a useful set of tiles is resident.
  // Re-runnable by hand from the console via window._ddRoadFit() after driving somewhere else.
  if (_ROADFIT && !_roadFitDone && _timeToDriveMs != null && time - _timeToDriveMs > 6000 && tileManager) {
    _roadFitDone = true;
    const runProbe = () => probeRoadFit(tileManager, {
      offset: getWorldElevationOffset() ?? 0,
      vertExag: (CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1),
      bakedIsRaw: !!CONFIG.BAKED_ROAD_ELEVATION_IS_RAW,
    });
    window._ddRoadFit = runProbe;              // call it again after driving elsewhere
                                               // (results land on window._ddRoadFitResult)
    try { runProbe(); } catch (e) { console.warn('[roadfit] probe failed:', e); }
  }

  // Phase 0 tunnel diagnostic overlay (?debug=tunnel) — flag-gated, no cost when off.
  updateTunnelDebug(scene, world, camera);
  updateCollisionDebug(scene, world, camera);

  // Animate grass + tree wind (same time base for spatial coherence)
  updateTreeWind(time / 1000);
  // v3: `ui` was one lap over ~15 subsystems and a drive caught it at 54 ms with no owner. Split
  // into sky / roadq / hud / ui so the next long frame names the subsystem instead of the group.
  cpuTimer.lap('ui'); // shadow-follow / infra / beacons / haze / wind — the remainder

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
  // v3 P0-03: drain the shadow-refresh request. autoUpdate is false, so the directional light's
  // depth pass only re-renders on frames that asked for it. three clears needsUpdate inside
  // render(), so this must be set immediately before the render call, not after.
  renderer.shadowMap.needsUpdate = consumeShadowRefresh();
  warmupBegin(3);
  composer.render();
  warmupEnd();
  gpuTimer.end();
  cpuTimer.lap('rend');
  // ── Task #39 residency sample (every ~2 s, not per frame) ──────────────────────────────────────
  // The GC half of #39 cannot be answered with performance.memory alone: it is coarse and moves when
  // the collector decides to, so per-tile heap deltas are mostly noise. renderer.info.memory holds
  // EXACT live counts, and the leak question is whether they climb while the resident tile count is
  // flat. D-37 already said "climbing geom/tex is a LEAK" — nothing had ever recorded the series.
  if (time - _lastResidencySample > 2000) {
    _lastResidencySample = time;
    noteResidency({
      t: time,
      tiles: tileManager.getDebugMetrics ? (tileManager.getDebugMetrics({})?.activeTiles ?? -1) : -1,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    });
  }
  watchShaderVariants();   // D-38: name late-compiling variants (no-op unless the count grew) // CPU cost of submitting draws (not GPU exec — that's the gpuTimer)
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
  // v3 P0-04: time-to-drive — navigation start → the world is actually PLAYABLE. Deliberately not
  // hooked to a single loader-hide call site: there are three (#dd-loading via two paths, plus
  // #dd-modeload for the mode picker), and instrumenting one of them meant entering through the
  // picker never recorded anything. This tests the observable end state instead, so it is correct
  // for every entry path. Binding constraint 1 has never had a number; this is it.
  if (_timeToDriveMs == null && carDriver
      && !document.getElementById('dd-loading') && !document.getElementById('dd-modeload')) {
    _timeToDriveMs = Math.round(performance.now());
    cpuTimer.armLongFrames();   // fresh budget now that the measured thing has actually started
    // Same instant, same reason: adaptive resolution was probing during the LOAD, where the frame is
    // long because the world is streaming and no resolution change can reach it. It locked itself
    // out on four consecutive drives, correctly and expensively. See adaptiveResolution.js `_armed`.
    adaptiveRes?.arm?.();
    // Same instant, same reason: D-38 measured "153 programs at time-to-drive", so the report's
    // warm-vs-late split has to be taken here or it is measuring a different thing.
    armReport(renderer.info.programs, { timeToDriveMs: _timeToDriveMs });
    _programsAtLoaderHide = renderer.info.programs?.length ?? null;
    console.warn('[perf] time-to-drive %d ms · shader programs %s', _timeToDriveMs, _programsAtLoaderHide);
  }

  // v3 P2 spike: arm on first frame with a car, then rebuild the grid ONLY when the camera crosses
  // an 8 m cell — the rebuild is O(lights x cells) and has no business running every frame.
  // v3 P2: NOT gated on carDriver. It was, and fly mode has no carDriver — so the street lighting
  // simply never armed there and the roads stayed dark, which looked like the grid was broken
  // rather than absent. rebuildLightGrid() works off camera.position, which both modes have.
  if (_LIGHTGRID && tileManager) {
    // Fallback only. The boot path arms this BEFORE the shader warm-up (see armLightGrid); this
    // catches entry paths that never reach that call site. Idempotent, so it is a no-op normally.
    armLightGrid();
    // Patching a material invalidates its compiled program, so the NEXT draw pays for the
    // recompile — measured at `rend 340ms` on the arm frame, and again in smaller stalls as tiles
    // bring new materials in. compileAsync uses KHR_parallel_shader_compile to build them off the
    // critical path instead. Debounced: tiles register materials in bursts, and one compile per
    // material would be worse than the stall it replaces.
    if (_lgDirtyPrograms && time - _lgLastCompile > 500) {
      _lgDirtyPrograms = false; _lgLastCompile = time;
      compileForComposer()?.catch(() => { /* falls back to sync compile on first draw */ });
    }
    // ?lightgrid=ab ONLY. This flips the whole grid on and off every 2.5 s for 40 s; running it by
    // default made the entire scene strobe, which was reported as a rendering bug (twice) before
    // anyone connected it to the measurement harness.
    if (_LIGHTGRID_AB) lightGridABTick(gpuTimer.getMs());   // getMs is a cached EMA, no GPU sync
    const cxN = Math.floor(camera.position.x / CELL_M), czN = Math.floor(camera.position.z / CELL_M);
    // Rebuild on cell crossing OR when the tile set changed — a tile loading in brings new lamps
    // that would otherwise stay dark until the car happened to cross a cell boundary.
    const epoch = tileManager.getTileEpoch();
    if (cxN !== _lgCellX || czN !== _lgCellZ || epoch !== _lgTileEpoch) {
      _lgCellX = cxN; _lgCellZ = czN;
      _lgTileEpoch = epoch;
      rebuildLightGrid();
    }
  }

  cpuTimer.lap('lgrid');   // logger + time-to-drive + spike — split out so none of it hides in `post`

  // ⚠ adaptiveRes.tick() can call setSize(), which REALLOCATES the composer's render targets
  // (bloom chain included). That is a multi-megabyte GPU allocation in the middle of a frame, and
  // it is the prime suspect for the 46 ms `post`. Lapped separately so the next drive names it
  // instead of us guessing.
  if (!_BENCH) adaptiveRes.tick(frameDt, gpuTimer.getMs());   // v3 P0-04: pinned during a benchmark run
  cpuTimer.lap('adaptRes');

  // v3 P0-04: benchmark route — starts once the world is playable, drives itself, saves the JSON.
  if (_BENCH && _timeToDriveMs != null && carDriver) {
    if (!_benchRoute) {
      if (envToggle && !envToggle.isNight()) envToggle.element.click();   // force NIGHT: the binding regime
      _benchRoute = startBenchRoute({
        latLonToWorld,
        getCarPos: () => { const lp = carDriver.getLocalPosition(); const o = getOriginOffset();
                           return { wx: -lp.lx + o.x, wz: lp.lz + o.z }; },
        getSpeedKmh: () => Math.abs(carDriver.getSpeedKmh() || 0),
        getHeadingDeg: () => carDriver.getHeadingDeg(),
        renderer, gpuTimer,
        programsAtLoaderHide: _programsAtLoaderHide,
        timeToDriveMs: _timeToDriveMs,
        manual: benchModeKind() === 'manual',   // ?bench = you drive · ?bench=auto = scripted route
      });
    }
    _benchRoute.tick(frameDt * 1000);
  }
  cpuTimer.lap('bench');   // scripted-route stepping; inert without ?bench
  performancePanel?.tick(time, frameDt, { cameraY: camera.position.y, renderScale: adaptiveRes.getScale(), gpuMs: gpuTimer.getMs(), cpuTimer });
  cpuTimer.lap('panel');   // STATS panel DOM writes — closes the frame; nothing after this is unlapped
}

window.addEventListener('resize', () => {
  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  adaptiveRes.setSize(w, h); // owns renderer/composer pixel-ratio + size + bloom resolution
  // v3 P0-04: setSize() re-applies adaptiveRes's own CAP, which silently overrode the benchmark's
  // 1.0 pin — the first capture ran at 1.2 (≈44% more fragments) and its GPU numbers were void.
  if (_BENCH) renderer.setPixelRatio(1.0);
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
  'cursor:pointer;font:800 16px Inter,system-ui,sans-serif;color:#141414;padding:12px 28px;border:none;border-radius:14px;' +
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
  'font:700 13px Inter,system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.55);padding:8px 16px;border-radius:12px;' +
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
// Hand the tile builder's per-phase totals to the report. Nothing read them before: the load is the
// biggest cost in the game and it is ASYNC, so it can never appear in a frame section.
//
// ⚠ BOTH ENTRY POINTS GO THROUGH HERE. F9 and `window._ddReport()` are two ways to ship the same
// report, and wiring only one of them is how a report silently carries less than the other — the
// same shape as the two disposal branches (D-56) and the seven road-field copies (D-46).
const _reportWithBuild = (extra = {}) =>
  shipReport({ ...extra, buildPhases: tileManager?.getBuildPhaseTotals?.() ?? null });

window.addEventListener('keydown', (e) => {
  if (isInputBlocked() || isTypingTarget(document.activeElement)) return;
  // F9 — ship the drive report. The one keypress that ends "drive and paste the console output".
  if (e.code === 'F9') { e.preventDefault(); _reportWithBuild({ trigger: 'F9' }); return; }
  if (e.code === 'KeyP') { e.preventDefault(); setPhotoMode(!_photoOn); return; }
  if (e.code === 'KeyL') { e.preventDefault(); carDriver?.toggleHeadlights?.(); return; } // headlights: auto→on→off
  // While in Photo Mode, +/- grow/shrink the loaded area (push it up until your machine strains).
  if (_photoOn && (e.code === 'Equal' || e.code === 'NumpadAdd' || e.key === '+')) {
    e.preventDefault(); tileManager?.setPhotoRadius?.((tileManager.getPhotoRadius?.() ?? 4) + 1); _updatePhotoInfo();
  } else if (_photoOn && (e.code === 'Minus' || e.code === 'NumpadSubtract' || e.key === '-')) {
    e.preventDefault(); tileManager?.setPhotoRadius?.((tileManager.getPhotoRadius?.() ?? 4) - 1); _updatePhotoInfo();
  }
});

window._ddReport = _reportWithBuild;   // console equivalent of F9 — same path, same contents
window._debugWorld = world;
