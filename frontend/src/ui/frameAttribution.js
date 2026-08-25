/**
 * frameAttribution — names the async work that lands BETWEEN frames.
 *
 * WHY THIS EXISTS. The frame loop's cpuTimer sections only see work inside the rAF callback. The
 * tile build is deliberately NOT there: it runs in chunks separated by `await yieldToMain()`, so
 * each chunk executes as its own macrotask, in the gap between two frames. A 40 ms build chunk is
 * therefore invisible to every section timer and surfaces only as `other` — which reads exactly
 * like a GC pause. That ambiguity is why the long-frame p95 went a long time without an owner:
 * the two most likely causes were indistinguishable in the output.
 *
 * So chunks record themselves here with the wall time they finished at, and the long-frame reporter
 * asks which chunks overlapped the frame it is complaining about. `other 96ms` becomes
 * `other 96ms (build: roads 41 · buildings 33)`, or stays bare — which now genuinely means GC or
 * browser work rather than "we could not tell".
 *
 * Cost: one object push per build chunk into a fixed ring. Nothing is allocated per frame, and
 * nothing is computed unless a long frame actually asks.
 */
const RING = 64;
const _buf = new Array(RING).fill(null);
let _w = 0;

/** Record an async work chunk that ran outside the frame loop. `ms` is its own duration. */
export function recordChunk(label, ms, endedAt = performance.now()) {
  if (!(ms > 0)) return;
  _buf[_w % RING] = { label, ms, end: endedAt };
  _w++;
}

/**
 * Chunks that finished inside [t0, t1], largest first. Uses END time only: a chunk that STARTED
 * before the window but ended inside it still stole time from this frame, and that is the case we
 * most want to catch — a long chunk is exactly the one that spans a frame boundary.
 */
export function chunksIn(t0, t1, limit = 3) {
  const out = [];
  for (let i = 0; i < RING; i++) {
    const c = _buf[i];
    if (c && c.end >= t0 && c.end <= t1) out.push(c);
  }
  out.sort((a, b) => b.ms - a.ms);
  return out.slice(0, limit);
}

export function formatChunks(list) {
  return list.length ? list.map((c) => `${c.label} ${c.ms.toFixed(0)}`).join(' · ') : '';
}

/**
 * Attributed long frames, kept for the benchmark JSON.
 *
 * The console line is for a human watching a drive; this is for comparing runs. Without it, the
 * bench JSON records that p95 was 33 ms and nothing about WHY, which is how a gate ends up
 * measured for weeks with no owner. Capped so a bad run cannot grow the payload without bound.
 */
const LONG_CAP = 120;
const _long = [];

export function recordLongFrame(wallMs, breakdown, asyncStr) {
  if (_long.length >= LONG_CAP) return;
  _long.push({ ms: +wallMs.toFixed(1), sections: breakdown, async: asyncStr || null });
}

/** Longest first. Non-destructive: a bench run should not erase what the panel may still show. */
export function getLongFrames(limit = 40) {
  return [..._long].sort((a, b) => b.ms - a.ms).slice(0, limit);
}

/** Aggregate blame: total ms attributed to each section across every long frame. */
export function longFrameBlame() {
  const t = {};
  for (const f of _long) for (const k in f.sections) t[k] = (t[k] || 0) + f.sections[k];
  return Object.fromEntries(Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +v.toFixed(1)]));
}
