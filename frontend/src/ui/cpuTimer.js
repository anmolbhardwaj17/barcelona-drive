/**
 * cpuTimer — per-section main-thread timing for the frame loop.
 *
 * WHY: when the GPU timer shows big headroom (e.g. 8 ms GPU) but the frame is still slow, the bottleneck
 * is the CPU/main thread (physics, tile streaming, per-frame updates, draw submission). This splits the
 * JS frame into named sections so we can see which one eats the budget, instead of guessing.
 *
 * Usage in the frame loop:
 *   cpu.start();
 *   ...physics...      cpu.lap('phys');
 *   ...entities...     cpu.lap('ent');
 *   ...tiles...        cpu.lap('tiles');
 *   ...composer.render() cpu.lap('rend');
 * The panel calls cpu.report(frameCount) once per second → "phys 8.1 · tiles 5.4 · rend 3.2 ·  …" (avg ms/frame).
 */
export function createCpuTimer() {
  let t = 0;
  const acc = new Map();   // section name → summed ms over the window
  return {
    start() { t = performance.now(); },
    lap(name) {
      const now = performance.now();
      acc.set(name, (acc.get(name) || 0) + (now - t));
      t = now;
    },
    /** Avg ms/frame per section over `frames`, sorted high→low; resets the window. */
    report(frames) {
      if (!frames || acc.size === 0) { acc.clear(); return ''; }
      const parts = [...acc.entries()]
        .map(([k, v]) => [k, v / frames])
        .sort((a, b) => b[1] - a[1]);
      acc.clear();
      return parts.map(([k, v]) => `${k} ${v.toFixed(1)}`).join(' · ');
    },
  };
}
