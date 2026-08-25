/**
 * "Stats for nerds" — a compact, clean performance overlay (top-right). Shows only what's actually useful at
 * a glance: framerate + stutter, GPU headroom, CPU frame cost, draw calls, triangles, memory. Updates once a
 * second; no per-frame DOM and no scene traversal (the old 27-row version walked 2500+ meshes every 4s).
 */
const PANEL_UPDATE_INTERVAL_MS = 1000;

const fmt = (n) => (n || 0).toLocaleString('en-US');   // exact, thousands-separated (e.g. 2,412,336)

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
    <div class="perf-row"><span class="perf-k">Draw calls</span><span class="perf-v" id="perf-calls">—</span></div>
    <div class="perf-row"><span class="perf-k">Triangles</span><span class="perf-v" id="perf-tris">—</span></div>
    <div class="perf-row"><span class="perf-k">Memory</span><span class="perf-v" id="perf-mem">—</span></div>
    <div class="perf-sub" id="perf-cpu">cpu —</div>
    <div class="perf-sub" id="perf-alloc">alloc —</div>
    <div class="perf-sub" id="perf-worst">worst —</div>
    <div class="perf-sub" id="perf-build">build —</div>
  `;
  el.style.cssText = `
    position: fixed; top: 260px; right: 24px; z-index: 10; pointer-events: none;
    padding: 9px 12px 10px; width: max-content;
    background: rgba(10,14,22,0.72); backdrop-filter: blur(6px);
    border: 1px solid rgba(255,255,255,0.10); border-radius: 10px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.35);
    font-family: 'SF Mono', ui-monospace, Menlo, monospace; font-size: 12px; color: #e8ecf2;
  `;
  el.querySelector('.perf-hd').style.cssText = 'font:700 10px/1 system-ui,sans-serif;letter-spacing:2px;color:#ffd23f;margin-bottom:8px;';
  el.querySelectorAll('.perf-row').forEach((r) => { r.style.cssText = 'display:flex;justify-content:space-between;gap:18px;padding:2px 0;'; });
  el.querySelectorAll('.perf-k').forEach((k) => { k.style.color = 'rgba(255,255,255,0.55)'; });
  el.querySelectorAll('.perf-v').forEach((v) => { v.style.cssText = 'font-variant-numeric:tabular-nums;font-weight:400;'; });
  el.querySelectorAll('.perf-sub').forEach((s) => { s.style.cssText = 'margin-top:6px;padding-top:5px;border-top:1px solid rgba(255,255,255,0.08);color:rgba(255,255,255,0.5);font-size:10.5px;max-width:280px;line-height:1.5;'; });
  document.body.appendChild(el);

  const vFps = el.querySelector('#perf-fps');
  const vGpu = el.querySelector('#perf-gpu');
  const vCalls = el.querySelector('#perf-calls');
  const vTris = el.querySelector('#perf-tris');
  const vMem = el.querySelector('#perf-mem');
  const vCpu = el.querySelector('#perf-cpu');
  const vAlloc = el.querySelector('#perf-alloc');
  const vWorst = el.querySelector('#perf-worst');
  const vBuild = el.querySelector('#perf-build');

  let frameCount = 0, lastUpdate = 0, worstMs = 0;
  let capWindows = 0;   // consecutive 1s windows that look like an external 30Hz frame cap

  function tick(time, frameDt, context) {
    frameCount += 1;
    const ms = (frameDt || 0) * 1000;
    if (ms > worstMs) worstMs = ms;

    if (time - lastUpdate < PANEL_UPDATE_INTERVAL_MS) return;
    lastUpdate = time;

    const fps = frameCount;
    const minFps = worstMs > 0 ? Math.round(1000 / worstMs) : fps;
    const gpuMs = context?.gpuMs;

    // External frame-cap detector: low FPS while the frame interval dwarfs BOTH the GPU time and
    // our tracked CPU work = the browser/OS isn't scheduling frames (Chrome Energy Saver, macOS
    // Low Power Mode) — the machine is idling, not struggling. Ratio-based (v2 — the v1 hard
    // thresholds missed real captures at gpu 12.4/17ms): frame interval > 1.7× the busiest
    // measured component, sustained 3 windows so streaming hitches don't false-positive.
    const rep = context?.cpuTimer?.report?.();
    const cpuSum = rep?.avg ? (rep.avg.match(/\d+\.\d+/g) || []).reduce((s, n) => s + parseFloat(n), 0) : 0;
    const busiest = Math.max(typeof gpuMs === 'number' ? gpuMs : 0, cpuSum);
    const looksCapped = fps > 0 && fps < 46 && busiest > 0 && (1000 / fps) > busiest * 1.7;
    capWindows = looksCapped ? capWindows + 1 : 0;

    vFps.textContent = (minFps < fps - 2 ? `${fps}  (min ${minFps})` : `${fps}`)
      + (capWindows >= 3 ? '  ⚠ frames missing vsync (streaming?)' : '');
    // colour cue: green ≥55, amber ≥40, red below
    vFps.style.color = fps >= 55 ? '#7dff9a' : fps >= 40 ? '#ffd23f' : '#ff6b6b';
    frameCount = 0; worstMs = 0;

    vGpu.textContent = (typeof gpuMs === 'number' && gpuMs > 0) ? `~${Math.round(1000 / gpuMs)} fps · ${gpuMs.toFixed(1)}ms` : 'n/a';

    const info = renderer.info;
    vCalls.textContent = fmt(info.render.calls);
    vTris.textContent = fmt(info.render.triangles);

    vMem.textContent = (performance?.memory?.usedJSHeapSize)
      ? `${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)} MB`
      : 'n/a';

    // CPU section breakdown (ms/frame), per-section allocation (MB/frame — the GC-stutter culprit), and the
    // single worst frame this second (what a stutter was made of). Powered by cpuTimer.report()
    // (rep computed above for the frame-cap detector).
    if (rep) {
      vCpu.textContent = `cpu   ${rep.avg}`;
      vAlloc.textContent = `alloc ${rep.heap}`;
      vWorst.textContent = `worst ${rep.worst}`;
    }

    // Tile-build chunk overruns this window — names the phase behind the "other" stalls (worst ms
    // a build chunk of that phase held the main thread past its budget).
    const ov = tileManager?.takeBuildOverruns?.();
    const buildTop = ov ? Object.entries(ov).sort((a, b) => b[1] - a[1]).slice(0, 2) : [];
    const buildStr = buildTop.length ? buildTop.map(([k, v]) => `${k} ${v}`).join(' · ') : '—';

    // Long-task + GC forensics for UNATTRIBUTED stalls (build line empty but `other` huge):
    // longtask count/max this window, plus heap delta — a large NEGATIVE heap step alongside a
    // long task = major GC pause (the prime suspect at ~500 MB heaps); no heap drop = compile/upload.
    const heapNow = performance?.memory?.usedJSHeapSize ?? 0;
    const heapDropMB = _lastHeap > 0 ? Math.max(0, (_lastHeap - heapNow) / 1048576) : 0;
    _lastHeap = heapNow;
    let ltStr = '';
    if (_ltMax > 0) {
      ltStr = ` · longtask ×${_ltCount} max ${_ltMax.toFixed(0)}ms${heapDropMB > 20 ? ` (heap −${heapDropMB.toFixed(0)}MB → GC)` : ''}`;
      _ltCount = 0; _ltMax = 0;
    }
    // Shader-program counter: `prog +N` alongside a rend spike = a synchronous shader compile
    // slipped past the warm-up (tell Claude which area you entered when it happened).
    const progs = renderer.info?.programs?.length ?? 0;
    const progStr = progs !== _lastProgs && _lastProgs > 0 ? ` · prog +${progs - _lastProgs} (${progs})` : '';
    _lastProgs = progs;
    // Worst long-animation-frame this window with its top script — the `other` namer.
    let loafStr = '';
    if (_loafWorst > 0) {
      loafStr = ` · loaf ${_loafWorst.toFixed(0)}ms ${_loafStr}`;
      _loafWorst = 0; _loafStr = '';
    }
    vBuild.textContent = `build ${buildStr}${ltStr}${loafStr}${progStr}`;
  }

  return { element: el, tick };
}

// ── Long-task observer (module-level, one per page) ──────────────────────────
let _ltCount = 0, _ltMax = 0, _lastHeap = 0, _lastProgs = 0;
try {
  if (typeof PerformanceObserver !== 'undefined') {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        _ltCount++;
        if (e.duration > _ltMax) _ltMax = e.duration;
      }
    }).observe({ entryTypes: ['longtask'] });
  }
} catch { /* longtask API unavailable — line simply stays quiet */ }

// v3 — per-entry LoAF console output is OPT-IN via `?debug=loaf`.
//
// It fires on every frame over 25 ms, which during tile stream-in is a continuous wall of text that
// buries the lines you are actually reading (`[facadeArray]`, `[lightgrid]`, shader errors). It is
// NOT deleted: the same observer feeds `loaf …` in the STATS build line, and per-entry attribution
// is the instrument the open frame-pipeline work (#39) is measured with. Only the printing is gated.
const _LOAF_LOG = (() => {
  try { return new URLSearchParams(location.search).get('debug') === 'loaf'; } catch { return false; }
})();

// ── Long-Animation-Frame observer (Chrome 123+) — NAMES the `other` time ─────
// longtask only says "something took 92ms"; LoAF says WHICH script (file + invoker)
// owned a slow frame. Time NOT inside any script entry = GC / style / message
// deserialize — reported as "unattr". Worst entry per window also lands in the
// STATS build line as `loaf …`. Details console.warn'd (user's console hides log).
let _loafWorst = 0, _loafStr = '';
try {
  if (typeof PerformanceObserver !== 'undefined') {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < 25) continue;
        const scripts = (e.scripts || [])
          .filter((s) => s.duration >= 4)
          .sort((a, b) => b.duration - a.duration);
        const fmt = scripts.slice(0, 3).map((s) => {
          const src = (s.sourceURL || '').split('/').pop().split('?')[0] || '?';
          return `${src}${s.invoker ? ':' + s.invoker : ''} ${s.duration.toFixed(0)}`;
        });
        const scripted = scripts.reduce((a, s) => a + s.duration, 0);
        const unattr = e.duration - scripted;
        // Aggregation below is UNCONDITIONAL — STATS keeps working with the printing off.
        if (_LOAF_LOG) {
          console.warn(`[loaf] ${e.duration.toFixed(0)}ms (unattr ${unattr.toFixed(0)}ms) — ${fmt.join(' · ') || 'NO scripts ≥4ms (GC/clone/style)'}`);
        }
        if (e.duration > _loafWorst) {
          _loafWorst = e.duration;
          _loafStr = fmt[0] || `unattr ${unattr.toFixed(0)}`;
        }
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  }
} catch { /* LoAF unavailable (pre-123 Chrome) — line simply stays quiet */ }
