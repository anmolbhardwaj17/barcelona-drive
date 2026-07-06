/**
 * cpuTimer — per-section main-thread timing for the frame loop, with worst-frame capture.
 *
 * WHY: when the GPU has headroom but the frame is slow, the CPU/main thread is the bottleneck. This splits
 * the JS frame into named sections. Crucially it reports BOTH the 1-second average AND the breakdown of the
 * single WORST frame in that window — because stutter is caused by occasional spikes (a tile materializing,
 * a GC pause), which a 1-second average smears into nothing. The worst-frame line is what diagnoses hitches.
 *
 * Usage in the frame loop:
 *   cpu.start();                       // finalizes the previous frame, begins a new one
 *   ...physics...      cpu.lap('phys');
 *   ...entities...     cpu.lap('ent');
 *   ...tiles...        cpu.lap('tiles');
 *   composer.render(); cpu.lap('rend');
 * The panel calls cpu.report() once per second.
 */
export function createCpuTimer() {
  let t = 0;
  let frame = {};                 // current frame's per-section ms
  const winSum = new Map();       // window: section → summed ms
  let winFrames = 0;
  let worstTotal = 0;             // worst single-frame total this window
  let worstBreakdown = {};        // that frame's per-section ms

  function finalizeFrame() {
    let total = 0;
    for (const k in frame) total += frame[k];
    if (total > 0) {
      winFrames += 1;
      for (const k in frame) winSum.set(k, (winSum.get(k) || 0) + frame[k]);
      if (total > worstTotal) { worstTotal = total; worstBreakdown = { ...frame }; }
    }
    frame = {};
  }

  const fmt = (obj) => Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v.toFixed(1)}`)
    .join(' · ');

  return {
    start() { finalizeFrame(); t = performance.now(); },
    lap(name) {
      const now = performance.now();
      frame[name] = (frame[name] || 0) + (now - t);
      t = now;
    },
    /** The CURRENT frame's per-section ms so far (for per-frame logging). Call after the last lap. */
    snapshot() { return { ...frame }; },
    /** { avg: "rend 3.6 · phys 3.3 …", worst: "22.0ms → tiles 18.4 · phys 3.1 …" } and resets the window. */
    report() {
      const avgObj = {};
      if (winFrames) for (const [k, v] of winSum) avgObj[k] = v / winFrames;
      const out = {
        avg: winFrames ? fmt(avgObj) : '—',
        worst: worstTotal > 0 ? `${worstTotal.toFixed(0)}ms → ${fmt(worstBreakdown)}` : '—',
      };
      winSum.clear(); winFrames = 0; worstTotal = 0; worstBreakdown = {};
      return out;
    },
  };
}
