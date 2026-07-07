/**
 * perfLogger — records per-frame performance to a JSON file for offline analysis.
 *
 * A floating "● REC PERF" button (bottom-left) toggles recording. While recording it captures one sample
 * per frame: frame ms, GPU ms, the CPU section breakdown (phys/ent/tiles/ui/rend), draws, triangles, heap,
 * position, speed, heading. Click again to stop → it downloads `perf-log-<t>.json` to the user's Downloads.
 *
 * WHY: reading spike numbers off the live panel mid-drive is impractical. A recorded log lets us pinpoint
 * exactly which frames stuttered, what section spiked, and what the player was doing (braking? turning? a
 * particular location?) — the section-sum-vs-total gap on a spike frame also reveals GC/browser stalls.
 *
 * The saved file has: meta, `worstFrames` (top 30 by frame ms, for a quick look), and `samples` (all frames).
 */
export function createPerfLogger() {
  let recording = false;
  let samples = [];
  let startPerf = 0;
  const CAP = 120000; // ~33 min at 60fps — safety cap on memory

  const btn = document.createElement('button');
  btn.id = 'perf-rec-btn';
  btn.textContent = '● REC PERF';
  btn.style.cssText = [
    'position:fixed', 'left:12px', 'bottom:12px', 'z-index:100000',
    'font:600 12px/1 ui-monospace,Menlo,monospace', 'padding:8px 12px',
    'border:1px solid rgba(255,255,255,0.25)', 'border-radius:6px', 'cursor:pointer',
    'background:#2b2b2b', 'color:#eee', 'letter-spacing:0.04em', 'user-select:none',
  ].join(';');

  function start() {
    recording = true;
    samples = [];
    startPerf = performance.now();
    btn.textContent = '■ STOP + SAVE';
    btn.style.background = '#c0392b';
  }

  function stop() {
    recording = false;
    btn.textContent = '● REC PERF';
    btn.style.background = '#2b2b2b';
    save();
  }

  function save() {
    if (!samples.length) return;
    const durationS = (performance.now() - startPerf) / 1000;
    const worstFrames = [...samples].sort((a, b) => b.ms - a.ms).slice(0, 30);
    // Section totals across the run (avg ms/frame) for a quick summary.
    const secSum = {}; let n = 0;
    for (const s of samples) { n++; for (const k in s.cpu) secSum[k] = (secSum[k] || 0) + s.cpu[k]; }
    const cpuAvg = {}; for (const k in secSum) cpuAvg[k] = +(secSum[k] / n).toFixed(2);
    const out = {
      meta: {
        durationS: +durationS.toFixed(1),
        frames: samples.length,
        avgFps: +(samples.length / durationS).toFixed(1),
        cpuAvgMsPerSection: cpuAvg,
        userAgent: navigator.userAgent,
        savedAt: new Date().toISOString(),
      },
      worstFrames,
      samples,
    };
    const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `perf-log-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  btn.addEventListener('click', () => (recording ? stop() : start()));
  // Hidden by default now the perf investigation is done — add ?perflog to the URL to show the button again.
  if (new URLSearchParams(location.search).has('perflog')) document.body.appendChild(btn);

  return {
    get recording() { return recording; },
    /** Push one frame sample (only stored while recording). */
    sample(d) {
      if (!recording) return;
      samples.push(d);
      if (samples.length > CAP) stop(); // auto-save if we hit the cap
    },
  };
}
