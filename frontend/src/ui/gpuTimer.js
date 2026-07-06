/**
 * gpuTimer — measures true GPU render time via EXT_disjoint_timer_query_webgl2.
 *
 * WHY: on a 60 Hz monitor vsync pins the displayed FPS at 60, so the frame counter can't tell you
 * whether the GPU is *comfortably* holding 60 or *barely* — both read "60". This times the actual GPU
 * work per frame, so the panel can show a "capable FPS" (1000 / gpu_ms) = what you'd get uncapped.
 *
 * Usage each frame:  timer.poll(); timer.begin(); composer.render(); timer.end();
 * Read smoothed result: timer.getMs()  (null until the first query resolves / if unsupported).
 *
 * Timer queries are asynchronous — the result for frame N is available a few frames later — and only ONE
 * TIME_ELAPSED query may be active at a time, so we run a single query and don't start the next until the
 * previous resolves. That's plenty for a panel that refreshes ~1 Hz.
 */
export function createGpuTimer(renderer) {
  const noop = { supported: false, begin() {}, end() {}, poll() {}, getMs() { return null; } };
  let gl;
  try { gl = renderer.getContext(); } catch { return noop; }
  const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  const ext = isWebGL2 ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  if (!ext) return noop;

  let query = null;      // the in-flight query object (null = none)
  let active = false;    // true between begin() and end()
  let pending = false;   // true after end(), until the result is read back
  let ema = null;        // exponential moving average of GPU ms (smooth readout)

  return {
    supported: true,

    begin() {
      if (pending || active) return;           // don't overlap queries
      query = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      active = true;
    },

    end() {
      if (!active) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      active = false;
      pending = true;
    },

    poll() {
      if (!pending || !query) return;
      const available = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE);
      if (!available) return;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);   // GPU changed clocks → this sample is garbage
      if (!disjoint) {
        const ms = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6; // ns → ms
        if (ms > 0 && ms < 1000) ema = ema == null ? ms : ema * 0.85 + ms * 0.15;
      }
      gl.deleteQuery(query);
      query = null;
      pending = false;
    },

    /** Smoothed GPU frame time in ms, or null if not yet available / unsupported. */
    getMs() { return ema; },
  };
}
