/**
 * Top-right performance debug panel: FPS, draw calls, triangles, geometries, active tiles, active lights.
 * Updates every 1 second only. No per-frame DOM or traverse.
 */
import { CONFIG } from '../config.js';

const PANEL_UPDATE_INTERVAL_MS = 1000;

/**
 * Traverse scene once and count children, meshes, lights, instanced meshes, and shadow-casting lights.
 * @param {THREE.Object3D} obj
 * @param {{ meshes: number, lights: number, instanced: number, lightsShadow: number }} counts
 */
function traverseCounts(obj, counts) {
  if (obj.isMesh) {
    counts.meshes += 1;
    if (obj.isInstancedMesh) counts.instanced += 1;
  }
  if (obj.isLight) {
    counts.lights += 1;
    if (obj.castShadow) counts.lightsShadow += 1;
  }
  for (let i = 0; i < obj.children.length; i++) {
    traverseCounts(obj.children[i], counts);
  }
}

/**
 * Create performance panel and mount to body. If enabled is false, returns no-op tick and does not mount.
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} renderer
 * @param {{ getDebugMetrics: () => { activeTiles: number, buildingsCount: number, treesCount: number } }} tileManager
 * @param {boolean} [enabled=true]
 * @returns {{ element: HTMLElement|null, tick: (time: number, frameDt: number) => void }}
 */
export function createPerformancePanel(scene, renderer, tileManager, enabled = true) {
  if (!enabled) {
    return { element: null, tick() {} };
  }

  const el = document.createElement('div');
  el.id = 'performance-panel';
  el.innerHTML = `
    <div class="perf-row"><span class="perf-k">FPS</span><span class="perf-v" id="perf-fps">—</span></div>
    <div class="perf-row"><span class="perf-k">Draw calls</span><span class="perf-v" id="perf-calls">—</span></div>
    <div class="perf-row"><span class="perf-k">Triangles</span><span class="perf-v" id="perf-triangles">—</span></div>
    <div class="perf-row"><span class="perf-k">Geometries</span><span class="perf-v" id="perf-geometries">—</span></div>
    <div class="perf-row"><span class="perf-k">Textures</span><span class="perf-v" id="perf-textures">—</span></div>
    <div class="perf-row"><span class="perf-k">Scene children</span><span class="perf-v" id="perf-children">—</span></div>
    <div class="perf-row"><span class="perf-k">Meshes</span><span class="perf-v" id="perf-meshes">—</span></div>
    <div class="perf-row"><span class="perf-k">Lights</span><span class="perf-v" id="perf-lights">—</span></div>
    <div class="perf-row"><span class="perf-k">Instanced</span><span class="perf-v" id="perf-instanced">—</span></div>
    <div class="perf-row"><span class="perf-k">Tiles</span><span class="perf-v" id="perf-tiles">—</span></div>
    <div class="perf-row"><span class="perf-k">Roads (total)</span><span class="perf-v" id="perf-roads-total">—</span></div>
    <div class="perf-row"><span class="perf-k">Road meshes</span><span class="perf-v" id="perf-road-meshes">—</span></div>
    <div class="perf-row"><span class="perf-k">Buildings</span><span class="perf-v" id="perf-buildings">—</span></div>
    <div class="perf-row"><span class="perf-k">Building objs</span><span class="perf-v" id="perf-building-objs">—</span></div>
    <div class="perf-row"><span class="perf-k">Trees</span><span class="perf-v" id="perf-trees">—</span></div>
    <div class="perf-row"><span class="perf-k">Vegetation meshes</span><span class="perf-v" id="perf-veg-meshes">—</span></div>
    <div class="perf-row"><span class="perf-k">Road infra</span><span class="perf-v" id="perf-road-infra">—</span></div>
    <div class="perf-row"><span class="perf-k">Streetlights</span><span class="perf-v" id="perf-streetlights">—</span></div>
    <div class="perf-row"><span class="perf-k">Physics bodies</span><span class="perf-v" id="perf-physics">—</span></div>
    <div class="perf-row"><span class="perf-k">Heap (MB)</span><span class="perf-v" id="perf-heap">—</span></div>
    <div class="perf-row"><span class="perf-k">Camera Y</span><span class="perf-v" id="perf-camera-y">—</span></div>
  `;
  el.style.cssText = `
    position: fixed;
    top: 260px;
    right: 24px;
    padding: 10px 14px;
    background: rgba(0,0,0,0.65);
    color: #eee;
    font-family: monospace;
    font-size: 11px;
    border-radius: 8px;
    z-index: 10;
    pointer-events: none;
    line-height: 1.4;
    min-width: 160px;
  `;
  el.querySelectorAll('.perf-row').forEach((row) => {
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';
    row.style.gap = '12px';
  });
  el.querySelectorAll('.perf-k').forEach((k) => {
    k.style.color = 'rgba(255,255,255,0.7)';
  });
  document.body.appendChild(el);

  const vFps = el.querySelector('#perf-fps');
  const vCalls = el.querySelector('#perf-calls');
  const vTriangles = el.querySelector('#perf-triangles');
  const vGeometries = el.querySelector('#perf-geometries');
  const vTextures = el.querySelector('#perf-textures');
  const vChildren = el.querySelector('#perf-children');
  const vMeshes = el.querySelector('#perf-meshes');
  const vLights = el.querySelector('#perf-lights');
  const vInstanced = el.querySelector('#perf-instanced');
  const vTiles = el.querySelector('#perf-tiles');
  const vRoadsTotal = el.querySelector('#perf-roads-total');
  const vRoadMeshes = el.querySelector('#perf-road-meshes');
  const vBuildings = el.querySelector('#perf-buildings');
  const vBuildingObjs = el.querySelector('#perf-building-objs');
  const vTrees = el.querySelector('#perf-trees');
  const vVegMeshes = el.querySelector('#perf-veg-meshes');
  const vRoadInfra = el.querySelector('#perf-road-infra');
  const vStreetlights = el.querySelector('#perf-streetlights');
  const vPhysics = el.querySelector('#perf-physics');
  const vHeap = el.querySelector('#perf-heap');
  const vCameraY = el.querySelector('#perf-camera-y');

  let frameCount = 0;
  let lastPanelUpdate = 0;
  const sceneCounts = { meshes: 0, lights: 0, instanced: 0, lightsShadow: 0 };

  function tick(time, frameDt, context) {
    frameCount += 1;
    const now = time;

    if (now - lastPanelUpdate >= PANEL_UPDATE_INTERVAL_MS) {
      lastPanelUpdate = now;
      const fpsValue = frameCount;
      vFps.textContent = String(fpsValue);
      frameCount = 0;

      const info = renderer.info;
      vCalls.textContent = String(info.render.calls);
      vTriangles.textContent = String(info.render.triangles);
      vGeometries.textContent = String(info.memory.geometries);
      vTextures.textContent = String(info.memory.textures);

      sceneCounts.meshes = 0;
      sceneCounts.lights = 0;
      sceneCounts.instanced = 0;
      sceneCounts.lightsShadow = 0;
      traverseCounts(scene, sceneCounts);
      vChildren.textContent = String(scene.children.length);
      vMeshes.textContent = String(sceneCounts.meshes);
      vLights.textContent = `${sceneCounts.lights} / ${sceneCounts.lightsShadow}`;
      vInstanced.textContent = String(sceneCounts.instanced);

      const cameraY = context?.cameraY;
      const metrics = tileManager.getDebugMetrics(
        cameraY != null ? { cameraY } : undefined
      );
      vTiles.textContent = String(metrics.activeTiles);
      vRoadsTotal.textContent = String(metrics.totalRoads ?? 0);
      vRoadMeshes.textContent = String(metrics.totalRoadMeshes ?? 0);
      vBuildings.textContent = String(metrics.buildingsCount ?? 0);
      vBuildingObjs.textContent = String(metrics.totalBuildingObjects ?? 0);
      vTrees.textContent = String(metrics.treesCount ?? 0);
      vVegMeshes.textContent = String(metrics.vegetationMeshCount ?? 0);
      vRoadInfra.textContent = String(metrics.roadInfraCount ?? 0);
      vStreetlights.textContent = String(metrics.streetlightCount ?? 0);
      vPhysics.textContent = String(metrics.physicsBodyCount ?? 0);
      vCameraY.textContent = metrics.cameraY != null ? metrics.cameraY.toFixed(1) : '—';

      if (typeof performance !== 'undefined' && performance.memory && typeof performance.memory.usedJSHeapSize === 'number') {
        vHeap.textContent = (performance.memory.usedJSHeapSize / 1048576).toFixed(1) + ' MB';
      } else {
        vHeap.textContent = 'N/A';
      }

      const warnTri = CONFIG.PERF_WARN_TRIANGLES;
      const warnFps = CONFIG.PERF_WARN_FPS;
    }
  }

  return { element: el, tick };
}
