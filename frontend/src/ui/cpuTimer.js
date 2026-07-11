/**
 * cpuTimer — per-section main-thread timing AND per-section heap-allocation tracking for the frame loop.
 *
 * WHY: two things break a frame — CPU time (a section runs long) and ALLOCATION (a section creates garbage
 * that later triggers a GC pause). This times each named section and also records how much the JS heap grew
 * during it (via performance.memory), so we can see BOTH which section is slow AND which section allocates.
 * Heap deltas are noisy per-frame (GC interleaves), but summed over a window the real allocator stands out.
 *
 * Usage:  cpu.start(); ...phys... cpu.lap('phys'); ...ent... cpu.lap('ent'); ... composer.render() cpu.lap('rend');
 * The panel calls cpu.report() once per second.
 */
export function createCpuTimer() {
  const mem = () => (typeof performance !== 'undefined' && performance.memory) ? performance.memory.usedJSHeapSize : 0;
  let t = 0;
  let h = 0;
  let frame = {};        // current frame: name → ms
  let frameHeap = {};    // current frame: name → heap-growth bytes (clamped ≥0; GC drops ignored)
  const winSum = new Map();
  const winHeap = new Map();
  let winFrames = 0;
  let worstTotal = 0;
  let worstBreakdown = {};
  let lastStart = 0;

  // `interval` is the WALL time since the previous frame's start. The gap between it and the sum of
  // the measured sections ("other") is everything the section timers can't see: GC pauses, async
  // tile-build/materialize chunks between frames, GPU texture uploads, browser work — plus normal
  // vsync idle (~12ms at 60fps with light frames). A worst frame dominated by `other` means the
  // stall lives OUTSIDE the profiled loop; sections only ever see their own slice.
  function finalizeFrame(interval) {
    let total = 0;
    for (const k in frame) total += frame[k];
    if (total > 0) {
      winFrames += 1;
      for (const k in frame) winSum.set(k, (winSum.get(k) || 0) + frame[k]);
      for (const k in frameHeap) winHeap.set(k, (winHeap.get(k) || 0) + frameHeap[k]);
      // Ignore absurd intervals (tab backgrounded/throttled) so they don't own the worst slot all window.
      const wall = interval > 0 && interval < 500 ? interval : total;
      if (wall > worstTotal) {
        worstTotal = wall;
        worstBreakdown = { ...frame };
        const other = wall - total;
        if (other > 0.05) worstBreakdown.other = other;
      }
    }
    frame = {}; frameHeap = {};
  }

  const fmt = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(' · ');
  const fmtMB = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(' · ');

  return {
    start() {
      const now = performance.now();
      finalizeFrame(lastStart ? now - lastStart : 0);
      lastStart = now;
      t = now; h = mem();
    },
    lap(name) {
      const now = performance.now();
      const hm = mem();
      frame[name] = (frame[name] || 0) + (now - t);
      const dh = hm - h;
      if (dh > 0) frameHeap[name] = (frameHeap[name] || 0) + dh; // count growth; ignore GC drops
      t = now; h = hm;
    },
    snapshot() { return { ...frame }; },
    heapSnapshot() { const o = {}; for (const k in frameHeap) o[k] = +(frameHeap[k] / 1048576).toFixed(2); return o; }, // MB/section this frame
    report() {
      const avg = {}, heap = {};
      if (winFrames) {
        for (const [k, v] of winSum) avg[k] = v / winFrames;
        for (const [k, v] of winHeap) heap[k] = v / winFrames / 1048576; // MB/frame per section
      }
      const out = {
        avg: winFrames ? fmt(avg) : '—',
        heap: winFrames ? fmtMB(heap) : '—',        // MB/frame allocated per section — the allocation smoking gun
        worst: worstTotal > 0 ? `${worstTotal.toFixed(0)}ms → ${fmt(worstBreakdown)}` : '—',
      };
      winSum.clear(); winHeap.clear(); winFrames = 0; worstTotal = 0; worstBreakdown = {};
      return out;
    },
  };
}
