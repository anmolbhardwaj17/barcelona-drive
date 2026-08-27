/**
 * driveReport — turns a drive into ONE small file instead of a console firehose.
 *
 * WHY THIS EXISTS. D-36 → D-38 each ended with "drive and paste the console output", and by D-38
 * that stopped being possible: 66 late shader programs plus 40 long-frame lines, each carrying a
 * full three.js cache key, is thousands of characters of output that nobody can copy out of a
 * DevTools pane. An instrument whose readings cannot leave the machine they are taken on is not
 * finished, and D-35 already cost a drive to exactly that class of mistake.
 *
 * So nothing is printed per event any more. Everything is ACCUMULATED here, and one keypress (F9,
 * or `window._ddReport()`) ships a compact report to the dev server, which writes it into the repo
 * where it can be read directly. No copying, no truncation, no "the interesting line scrolled away".
 *
 * The raw firehose is still there when a human wants to watch it live — `?debug=frames` and
 * `?debug=variants` restore the per-event lines. Off by default, which is the correct default for
 * output that is 90% duplicate.
 *
 * WHAT IT ADDS BEYOND CAPTURE. A list of 66 cache keys is not an answer either — it is the same
 * guessing problem in a bigger font. Two things turn it into one:
 *
 *   1. NOVEL-TOKEN DIFF. At drive start the boot warm-up's programs are tokenised into a baseline
 *      vocabulary. A late program is then described by the tokens it carries that NO warm program
 *      had. That names the differing feature — `numDirLights=2`, `fog`, `DoubleSide` — without this
 *      file needing to know three's cache-key schema, which is version-specific and would rot.
 *   2. GROUPING BY THAT DIFF. 66 programs collapse to a handful of causes, each with a count. The
 *      fix targets a cause, not a program.
 *
 * And because a variant is only worth chasing if it actually hurts, each one records whether it
 * landed inside a long frame — which is the direct evidence linking a compile to a stutter, rather
 * than the correlation D-38 had to argue for.
 */

// Caps. A bad drive must not grow the payload without bound; these keep the report in the tens of KB.
const MAX_VARIANTS = 400;
const MAX_LONG = 200;

let _armedAt = null;          // performance.now() at drive start — all times are relative to this
let _warmCount = 0;           // programs the boot warm-up produced (D-38 measured 153)
const _warmTokens = new Set();
const _warmKeys = [];         // the warm keys as TOKEN ARRAYS — see nearestWarmDiff()
const _variants = [];
const _long = [];
let _lastLongAt = -1e9;       // when the most recent long frame was seen, for the "during a stutter" tag
let _meta = {};               // whatever the call site knew at drive start (time-to-drive, mainly)

/**
 * Split a three.js program cache key into comparable features. Schema-agnostic on purpose.
 *
 * One wrinkle: the tail of the key is our own `customProgramCacheKey`, and after minification it
 * reads `(l,u)=>{a&&a(l,u),e(l,u)}|roadAO+lightGrid` — a function body containing COMMAS. Splitting
 * naively tore that into fragments and named a group `u)}|roadAO+lightGrid`, which is legible by
 * luck rather than design. The bodies carry no information (they are the same minified closure for
 * every patched material); the tag after the `|` is the whole point. So collapse the bodies first.
 */
function tokenise(key) {
  const cleaned = String(key || '')
    .replace(/\([^()]*\)\s*=>\s*\{[^{}]*\}/g, 'patched')     // (l,u)=>{...}  — a patched material
    .replace(/[A-Za-z_$][\w$]*\s*\([^()]*\)\s*\{[^{}]*\}/g, 'unpatched'); // onBeforeCompile(){}
  return cleaned.split(',').map((t) => t.trim()).filter(Boolean);
}

/**
 * Capture the warm-up baseline. Call at time-to-drive, next to cpuTimer.armLongFrames() — the same
 * instant D-38 measured "153 at time-to-drive", so the report's before/after split matches the
 * finding it exists to chase.
 */
export function armReport(programs, meta = {}) {
  _armedAt = performance.now();
  _meta = meta;
  _warmCount = programs?.length ?? 0;
  // ⚠ ARMING IS THE START OF MEASUREMENT, so it must also be the start of the DATA. Without this
  // the watcher's load-time records survived into the report and were counted as compiles that
  // happened while driving: a drive reported "+124 compiled while driving" when 92 of those were
  // the warm-up's own programs, recorded before arming, and only 32 were real. Every shader number
  // quoted from this instrument before this line existed was inflated by the size of the warm set.
  //
  // Same failure as D-35 and as the F9 crash: the collecting path worked perfectly and the thing it
  // reported was not the thing it claimed. An instrument's own semantics need a test.
  _variants.length = 0;
  _long.length = 0;
  _lastLongAt = -1e9;
  _warmTokens.clear();
  _warmKeys.length = 0;
  if (programs) {
    for (const p of programs) {
      const t = tokenise(p?.cacheKey);
      _warmKeys.push(t);
      for (const x of t) _warmTokens.add(x);
    }
  }
}

export function isArmed() { return _armedAt != null; }

/** One shader program that appeared AFTER the warm-up. `index` is its position in renderer.info.programs. */
export function noteVariant(index, cacheKey) {
  if (_variants.length >= MAX_VARIANTS) return;
  const now = performance.now();
  const raw = String(cacheKey || '');
  const tokens = tokenise(raw);
  const novel = tokens.filter((t) => !_warmTokens.has(t));
  _variants.push({
    n: index,
    atS: _armedAt == null ? null : +((now - _armedAt) / 1000).toFixed(2),
    // ⚠ Stored, not re-derived at report time. The grouping used to read `v.tokens`, which was
    // never on the record — so the report threw the instant it was asked for, which is the one
    // moment it must not. Same lesson as D-35: an instrument has to be tested for the path that
    // produces its output, not just the path that collects data.
    type: tokens[0] || '?',
    // Only computed when the vocabulary diff came up empty — that is exactly when it is needed,
    // and it costs a scan of the warm keys.
    fieldDiff: novel.length ? null : nearestWarmDiff(tokens),
    tag: raw.includes('|') ? raw.slice(raw.lastIndexOf('|') + 1) : '',
    novel,
    // Only kept when there is no novel token to explain it — otherwise the diff IS the answer and
    // the full key is 300 bytes of noise. When novel is empty the key is the only lead, so keep it.
    // Kept only when the diff found nothing to say — then the key is the sole remaining lead. When
    // novel tokens exist they ARE the answer and the key is 300 bytes of noise.
    key: novel.length ? undefined : raw,
    keyLen: raw.length,
    // Did this compile land in a frame we already flagged as long? 120 ms back-window: the compile
    // is reported on the frame AFTER the one that paid for it, so an exact match would miss it.
    inLongFrame: now - _lastLongAt < 120,
  });
}

/** One long frame, already broken down by cpuTimer. Everything optional except wall time. */
export function noteLongFrame({ wall, sections, async: asyncStr, gpu, heap, alloc, info }) {
  _lastLongAt = performance.now();
  if (_long.length >= MAX_LONG) return;
  _long.push({
    atS: _armedAt == null ? null : +((_lastLongAt - _armedAt) / 1000).toFixed(2),
    ms: +wall.toFixed(1),
    gpu: gpu == null ? null : +gpu.toFixed(1),
    heapMB: heap == null ? null : Math.round(heap),
    sections: sections || null,
    async: asyncStr || null,
    alloc: alloc || null,
    info: info || null,
  });
}

/**
 * Name a late program by POSITION, not by vocabulary.
 *
 * The novel-token diff answers "what value is here that the warm set never had", and it ran out of
 * road: a drive produced 124 late programs and every single one reported "no novel token". That is
 * not a failure to find a cause — it is the correct answer to the wrong question. Those keys carry
 * no new VALUE; they differ from a warm key by a COMBINATION, one field flipping to a value that
 * already appears in some other program. A set difference cannot see that, by construction.
 *
 * So line the late key up against each warm key of the same length and report the positions that
 * differ. When one field moved, this says exactly which — `#31 0→1` — and that is the whole answer.
 * Bail past 4 differing fields: beyond that the two keys are unrelated and the "diff" is noise.
 */
function nearestWarmDiff(tokens) {
  let best = null;
  for (const w of _warmKeys) {
    if (w.length !== tokens.length) continue;
    const at = [];
    for (let i = 0; i < w.length; i++) {
      if (w[i] !== tokens[i]) {
        at.push(i);
        if (at.length > 4) break;
      }
    }
    if (at.length && at.length <= 4 && (!best || at.length < best.at.length)) best = { w, at };
    if (best && best.at.length === 1) break;   // a single-field difference is the answer; stop looking
  }
  if (!best) return null;
  return best.at.map((i) => `#${i} ${best.w[i] || '∅'}→${tokens[i] || '∅'}`);
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  return +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1);
}

/** Group late variants by their novel-token signature — this is the line that names the cause. */
function groupVariants() {
  const groups = new Map();
  for (const v of _variants) {
    // ⚠ The novel-token diff degrades when the warm set is SMALL: with only a few dozen warm
    // programs the vocabulary is thin, every late key looks familiar, and everything lands in one
    // useless bucket. So fall back to the two fields that are always meaningful — the material TYPE
    // (first token) and our patch tag (after the last `|`) — and carry a sample key besides.
    const where = v.fieldDiff ? v.fieldDiff.join(' · ') : '';
    const sig = v.novel.length ? v.novel.join(',')
      : where ? `${v.type}${v.tag ? ' | ' + v.tag : ''}   ${where}`
      : `${v.type}${v.tag ? ' | ' + v.tag : ''} (identical to a warm key — recompiled, not new)`;
    let g = groups.get(sig);
    if (!g) groups.set(sig, (g = { cause: sig, count: 0, firstAtS: v.atS, lastAtS: v.atS, inLongFrames: 0, sampleKey: v.key }));
    if (!g.sampleKey && v.key) g.sampleKey = v.key;
    g.count++;
    g.lastAtS = v.atS;
    if (v.inLongFrame) g.inLongFrames++;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}


/**
 * RESIDENCY SAMPLER — the GC-independent half of task #39.
 *
 * `performance.memory.usedJSHeapSize` is coarse and moves when the collector feels like it, so a
 * per-tile heap delta is mostly noise. `renderer.info.memory.geometries` and `.textures` are EXACT
 * counts of live GPU resources, and they answer the leak question directly: if they climb while the
 * resident tile count is flat, tiles are not releasing what they allocated. D-37 said as much —
 * "climbing geom/tex is a LEAK" — but nothing ever recorded the series.
 *
 * Sampled on a timer rather than per frame: this is about drift over a drive, not per-frame cost.
 */
const _res = [];
export function noteResidency({ tiles, geometries, textures, heapMB, t }) {
  if (_armedAt == null) return;
  _res.push({ t: Math.round(t), tiles, geometries, textures, heapMB });
}

/** first/last + per-tile normalisation, which is what makes a leak legible. */
function residencySummary() {
  if (_res.length < 2) return null;
  // ⚠ THE FIRST SAMPLE IS NOT A BASELINE. It lands seconds after drive start while tiles are still
  // building, so their geometry count is incomplete — comparing it to a settled state manufactures a
  // leak that is not there. The first read of this report showed "29.6 -> 34.1 geometries per tile"
  // and the series then showed geometries rising AND FALLING with tile count, releasing correctly.
  // Skip the first 15 s, and if that leaves too little, say so rather than quoting a bad number.
  const settled = _res.filter((r) => r.t > (_res[0].t + 15000));
  if (settled.length < 2) {
    return { samples: _res.length, inconclusive: 'drive too short — no settled window after load-in',
             series: _res };
  }
  const a = settled[0], b = settled[settled.length - 1];
  const span = Math.max(1, (b.t - a.t) / 1000);
  const perTile = (v, s) => (s.tiles > 0 ? +(v / s.tiles).toFixed(1) : null);
  // A leak shows as geometries NOT returning when the tile count does. Compare only samples that
  // share a tile count, which removes the confound entirely.
  const byTiles = new Map();
  for (const r of settled) {
    const e = byTiles.get(r.tiles) || { first: r, last: r };
    e.last = r; byTiles.set(r.tiles, e);
  }
  const sameTileDrift = [...byTiles.entries()]
    .filter(([, e]) => e.last.t > e.first.t + 5000)
    .map(([tiles, e]) => ({ tiles, spanS: Math.round((e.last.t - e.first.t) / 1000),
                            geomDelta: e.last.geometries - e.first.geometries }));
  return {
    samples: _res.length,
    settledSamples: settled.length,
    seconds: Math.round(span),
    // THE honest leak test: at the same resident tile count, did geometries grow?
    sameTileCountDrift: sameTileDrift,
    tiles: { first: a.tiles, last: b.tiles },
    // The leak signal. Flat tiles + climbing geometries = tiles are not releasing.
    geometries: { first: a.geometries, last: b.geometries, delta: b.geometries - a.geometries,
                  perSec: +((b.geometries - a.geometries) / span).toFixed(2),
                  perTileFirst: perTile(a.geometries, a), perTileLast: perTile(b.geometries, b) },
    textures: { first: a.textures, last: b.textures, delta: b.textures - a.textures },
    heapMB: { first: a.heapMB, last: b.heapMB, perSec: +(((b.heapMB ?? 0) - (a.heapMB ?? 0)) / span).toFixed(2) },
    series: _res.filter((_, i) => i % Math.max(1, Math.floor(_res.length / 24)) === 0),
  };
}

export function buildReport(extra = {}) {
  const msSorted = _long.map((f) => f.ms).sort((a, b) => a - b);
  // Aggregate blame across every long frame, so one outlier cannot name the cause on its own.
  const blame = {};
  const allocBlame = {};
  for (const f of _long) {
    for (const k in (f.sections || {})) blame[k] = (blame[k] || 0) + f.sections[k];
    for (const k in (f.alloc || {})) allocBlame[k] = (allocBlame[k] || 0) + f.alloc[k];
  }
  const rank = (o, unit) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([k, v]) => `${k} ${v.toFixed(1)}${unit}`);
  return {
    meta: {
      savedAt: new Date().toISOString(),
      driveSeconds: _armedAt == null ? null : +((performance.now() - _armedAt) / 1000).toFixed(1),
      url: typeof location !== 'undefined' ? location.href : null,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      ..._meta,
      ...extra,
    },
    shaders: {
      warmAtDriveStart: _warmCount,
      compiledWhileDriving: _variants.length,
      compiledDuringLongFrames: _variants.filter((v) => v.inLongFrame).length,
      capped: _variants.length >= MAX_VARIANTS,
      byCause: groupVariants(),
    },
    residency: residencySummary(),
    frames: {
      longFrames: _long.length,
      capped: _long.length >= MAX_LONG,
      msP50: pct(msSorted, 0.5), msP95: pct(msSorted, 0.95), msMax: msSorted.length ? +msSorted[msSorted.length - 1].toFixed(1) : null,
      totalMsBySection: rank(blame, 'ms'),
      totalAllocBySection: rank(allocBlame, 'MB'),
      worst: [..._long].sort((a, b) => b.ms - a.ms).slice(0, 15),
    },
    variants: _variants,
  };
}

/** A human-readable digest — short enough to paste if the file route ever fails. */
export function digest(r) {
  const L = [];
  L.push(`── drive report · ${r.meta.driveSeconds}s · ${r.meta.savedAt}`);
  if (r.meta.timeToDriveMs != null) L.push(`LOAD     time-to-drive ${(r.meta.timeToDriveMs / 1000).toFixed(1)}s`);
  L.push(`SHADERS  warm ${r.shaders.warmAtDriveStart} → +${r.shaders.compiledWhileDriving} compiled while driving` +
         ` (${r.shaders.compiledDuringLongFrames} inside a long frame)`);
  for (const g of r.shaders.byCause.slice(0, 12)) {
    L.push(`  ×${String(g.count).padStart(3)}  ${g.cause}${g.inLongFrames ? `   [${g.inLongFrames} in long frames]` : ''}` +
           `   ${g.firstAtS}s→${g.lastAtS}s`);
    if (g.sampleKey && !/#\d+ /.test(g.cause)) {
      L.push(`         key: ${g.sampleKey.slice(0, 160)}${g.sampleKey.length > 160 ? '…' : ''}`);
    }
  }
  L.push(`FRAMES   ${r.frames.longFrames} long · p50 ${r.frames.msP50}ms · p95 ${r.frames.msP95}ms · max ${r.frames.msMax}ms`);
  L.push(`  time   ${r.frames.totalMsBySection.join(' · ') || '(none)'}`);
  L.push(`  alloc  ${r.frames.totalAllocBySection.join(' · ') || '(none)'}`);
  if (r.shaders.capped || r.frames.capped) L.push('  ⚠ CAPPED — the real counts are higher than shown');
  return L.join('\n');
}

// `??` (not `||`) so VITE_MAP_API="" means same-origin — matches mapLoader.js exactly.
const API_BASE = import.meta.env?.VITE_MAP_API ?? 'http://localhost:4041';   // `?.` so tests can import this outside Vite

/**
 * Ship the report. Preferred route is the dev server, which writes it into the repo — that is the
 * whole point, since a file on disk needs no copying and cannot be truncated by a console pane.
 *
 * Falls back to a download when there is no dev server (the deployed static build has none), and
 * always prints the digest, so the report is never lost to a failed POST.
 */
export async function shipReport(extra = {}) {
  const report = buildReport(extra);
  const text = digest(report);
  console.warn('%s\n', text);
  if (!report.frames.longFrames && !report.shaders.compiledWhileDriving) {
    console.warn('[report] nothing recorded yet — drive first, then press F9.');
    return { ok: false, reason: 'empty' };
  }
  try {
    const res = await fetch(`${API_BASE}/api/debug/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    });
    if (res.ok) {
      const { file } = await res.json();
      console.warn('[report] written to %s — nothing to copy, it is on disk.', file);
      return { ok: true, file };
    }
    console.warn('[report] server refused (%d) — falling back to download.', res.status);
  } catch (e) {
    console.warn('[report] no dev server (%s) — falling back to download.', e?.message || e);
  }
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `drive-report-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  console.warn('[report] downloaded to your Downloads folder.');
  return { ok: true, file: a.download };
}
