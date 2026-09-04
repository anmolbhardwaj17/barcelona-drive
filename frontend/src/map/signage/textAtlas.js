/**
 * textAtlas.js — a BOUNDED page of rendered street-name text. v3 P4-11.
 *
 * ── WHAT THIS REPLACES, AND WHY IT IS THE FIRST PIECE ──────────────────────────────────────────
 *
 * `roadInfraRenderer` keeps three `Map`s of `CanvasTexture`s keyed by street name — one for
 * direction boards, one for gantries, one for speed plates — and **none of them evicts**. They are
 * marked `sharedMaterial`, so the tile-unload walk deliberately skips them: they live for the whole
 * session and grow with how far you drive.
 *
 * Measured against the shipped tiles (2026-09-05):
 *
 *   direction board  512×384 RGBA + mips = 1.00 MB  ← per DISTINCT STREET NAME
 *   gantry board     512×192 RGBA + mips = 0.50 MB  ← per distinct name+connections
 *   2,427 distinct street names exist in the region.
 *
 * So a drive touching 150 named streets is ~150 MB of direction boards alone, against a v3 budget of
 * 200 MiB for ALL textures. There is no ceiling — the cost is a function of how long you play.
 *
 * This page is 2048×1024 **R8** = 2.0 MB, fixed, forever. Text is a coverage mask; the colour comes
 * from a per-instance tint, which is why one channel is enough and why 4× the pixels cost half as
 * much. Cells are evicted by distance from the player, so the 128 resident cells are the 128 signs
 * you could actually read.
 *
 * ── WHY THE ALLOCATION LOGIC LIVES HERE, SEPARATE FROM THE GPU ─────────────────────────────────
 * Everything below is arithmetic on integers and a Map. No WebGL, no canvas, no three.js — so the
 * eviction policy, which is the part that can be subtly wrong, is testable in node. The upload is a
 * thin caller on top (`renderer.copyTextureToTexture` into the returned rect).
 */

export const PAGE_W = 2048;
export const PAGE_H = 1024;
export const CELL_W = 256;
export const CELL_H = 64;
export const COLS = PAGE_W / CELL_W;          // 8
export const ROWS = PAGE_H / CELL_H;          // 16
export const CELL_COUNT = COLS * ROWS;        // 128

/**
 * @typedef {{cell:number, u0:number, v0:number, u1:number, v1:number,
 *            x:number, y:number, fresh:boolean}} Slot
 */

export function createTextAtlas() {
  /** key → {cell, dist, seq} */
  const byKey = new Map();
  /** cell index → key, or null */
  const cellKey = new Array(CELL_COUNT).fill(null);
  let free = CELL_COUNT;
  let seq = 0;
  const stats = { acquires: 0, hits: 0, evictions: 0, refused: 0 };

  const rectOf = (cell) => {
    const cx = cell % COLS, cy = (cell / COLS) | 0;
    const x = cx * CELL_W, y = cy * CELL_H;
    return {
      cell, x, y,
      u0: x / PAGE_W, v0: y / PAGE_H,
      u1: (x + CELL_W) / PAGE_W, v1: (y + CELL_H) / PAGE_H,
    };
  };

  /**
   * Get a cell for `key`, evicting the furthest-away resident if the page is full.
   *
   * @param {string} key   the text to render (the street name)
   * @param {number} dist  metres from the player — the eviction key
   * @returns {Slot|null}  `fresh: true` means the caller must draw into the returned rect.
   *                       `null` means refused: the page is full of things NEARER than this one.
   */
  function acquire(key, dist) {
    stats.acquires++;
    const existing = byKey.get(key);
    if (existing) {
      // ⚠ Refresh the distance on a HIT. Without this an entry keeps the distance it had when it was
      // first drawn, so a sign you drove past an hour ago still claims to be 5 m away and can never
      // be evicted — the page fills with the first 128 names of the session and every later sign is
      // refused. That is the same shape of bug as the caches this replaces, in less memory.
      existing.dist = dist;
      existing.seq = ++seq;
      stats.hits++;
      return { ...rectOf(existing.cell), fresh: false };
    }

    let cell;
    if (free > 0) {
      cell = cellKey.indexOf(null);
      free--;
    } else {
      // Evict the furthest resident — but only if it is further than what is being asked for.
      let worstKey = null, worstDist = -Infinity;
      for (const [k, e] of byKey) {
        if (e.dist > worstDist) { worstDist = e.dist; worstKey = k; }
      }
      if (worstKey === null || worstDist <= dist) {
        // Everything resident is nearer than this request. Refusing is correct: thrashing the page
        // for a sign that is further away than all 128 already on it would evict something the
        // player can read to draw something they cannot.
        stats.refused++;
        return null;
      }
      cell = byKey.get(worstKey).cell;
      byKey.delete(worstKey);
      cellKey[cell] = null;
      stats.evictions++;
    }

    byKey.set(key, { cell, dist, seq: ++seq });
    cellKey[cell] = key;
    return { ...rectOf(cell), fresh: true };
  }

  /** Drop everything — used on a tile-set reset, not per frame. */
  function clear() {
    byKey.clear();
    cellKey.fill(null);
    free = CELL_COUNT;
  }

  return {
    acquire,
    clear,
    get size() { return CELL_COUNT - free; },
    get capacity() { return CELL_COUNT; },
    has: (key) => byKey.has(key),
    stats: () => ({ ...stats, resident: CELL_COUNT - free }),
    /** Bytes of GPU memory this page costs. Fixed — that is the entire point of it. */
    bytes: () => PAGE_W * PAGE_H,   // R8, no mips (text is sampled at its own scale)
  };
}
