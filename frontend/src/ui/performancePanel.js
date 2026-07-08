/**
 * "Stats for nerds" — a compact, clean performance overlay (top-right). Shows only what's actually useful at
 * a glance: framerate + stutter, GPU headroom, CPU frame cost, draw calls, triangles, memory. Updates once a
 * second; no per-frame DOM and no scene traversal (the old 27-row version walked 2500+ meshes every 4s).
 */
const PANEL_UPDATE_INTERVAL_MS = 1000;

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  return String(n);
}

/**
 * @param {THREE.Scene} scene              (unused — kept for signature compatibility)
 * @param {THREE.WebGLRenderer} renderer
 * @param {object} tileManager             (unused)
 * @param {boolean} [enabled=true]
 * @returns {{ element: HTMLElement|null, tick: (time:number, frameDt:number, ctx:object)=>void }}
 */
export function createPerformancePanel(scene, renderer, tileManager, enabled = true) {
  if (!enabled) return { element: null, tick() {} };

  const el = document.createElement('div');
  el.id = 'performance-panel';
  el.innerHTML = `
    <div class="perf-hd">STATS</div>
    <div class="perf-row"><span class="perf-k">FPS</span><span class="perf-v" id="perf-fps">—</span></div>
    <div class="perf-row"><span class="perf-k">GPU</span><span class="perf-v" id="perf-gpu">—</span></div>
    <div class="perf-row"><span class="perf-k">CPU</span><span class="perf-v" id="perf-cpu">—</span></div>
    <div class="perf-row"><span class="perf-k">Draw calls</span><span class="perf-v" id="perf-calls">—</span></div>
    <div class="perf-row"><span class="perf-k">Triangles</span><span class="perf-v" id="perf-tris">—</span></div>
    <div class="perf-row"><span class="perf-k">Memory</span><span class="perf-v" id="perf-mem">—</span></div>
  `;
  el.style.cssText = `
    position: fixed; top: 260px; right: 24px; z-index: 10; pointer-events: none;
    padding: 9px 12px 10px; min-width: 168px;
    background: rgba(10,14,22,0.72); backdrop-filter: blur(6px);
    border: 1px solid rgba(255,255,255,0.10); border-radius: 10px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.35);
    font-family: 'SF Mono', ui-monospace, Menlo, monospace; font-size: 12px; color: #e8ecf2;
  `;
  el.querySelector('.perf-hd').style.cssText = 'font:700 10px/1 system-ui,sans-serif;letter-spacing:2px;color:#ffd23f;margin-bottom:8px;';
  el.querySelectorAll('.perf-row').forEach((r) => { r.style.cssText = 'display:flex;justify-content:space-between;gap:16px;padding:2px 0;'; });
  el.querySelectorAll('.perf-k').forEach((k) => { k.style.color = 'rgba(255,255,255,0.55)'; });
  el.querySelectorAll('.perf-v').forEach((v) => { v.style.cssText = 'font-variant-numeric:tabular-nums;font-weight:600;'; });
  document.body.appendChild(el);

  const vFps = el.querySelector('#perf-fps');
  const vGpu = el.querySelector('#perf-gpu');
  const vCpu = el.querySelector('#perf-cpu');
  const vCalls = el.querySelector('#perf-calls');
  const vTris = el.querySelector('#perf-tris');
  const vMem = el.querySelector('#perf-mem');

  let frameCount = 0, lastUpdate = 0, worstMs = 0;

  function tick(time, frameDt, context) {
    frameCount += 1;
    const ms = (frameDt || 0) * 1000;
    if (ms > worstMs) worstMs = ms;

    if (time - lastUpdate < PANEL_UPDATE_INTERVAL_MS) return;
    lastUpdate = time;

    const fps = frameCount;
    const minFps = worstMs > 0 ? Math.round(1000 / worstMs) : fps;
    vFps.textContent = minFps < fps - 2 ? `${fps}  (min ${minFps})` : `${fps}`;
    // colour cue: green ≥55, amber ≥40, red below
    vFps.style.color = fps >= 55 ? '#7dff9a' : fps >= 40 ? '#ffd23f' : '#ff6b6b';
    frameCount = 0; worstMs = 0;

    const gpuMs = context?.gpuMs;
    vGpu.textContent = (typeof gpuMs === 'number' && gpuMs > 0) ? `~${Math.round(1000 / gpuMs)} fps · ${gpuMs.toFixed(1)}ms` : 'n/a';

    if (context?.cpuTimer) { const c = context.cpuTimer.report(); vCpu.textContent = c.avg; }

    const info = renderer.info;
    vCalls.textContent = fmt(info.render.calls);
    vTris.textContent = fmt(info.render.triangles);

    vMem.textContent = (performance?.memory?.usedJSHeapSize)
      ? `${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)} MB`
      : 'n/a';
  }

  return { element: el, tick };
}
