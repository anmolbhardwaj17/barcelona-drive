/**
 * cityMapLoader — one-time background load of the WHOLE city's 2D data into the custom minimap store, so
 * the zoomed-out map shows the entire street network (not just tiles you've driven through). Fetches the
 * tile manifest from the backend, then streams each tile through the existing parser (mapLoader.loadTile)
 * and ingests roads/water/parks LITE (no building footprints — far buildings never render, saves memory).
 *
 * Runs sequentially with a small yield between tiles so it never starves the gameplay tile loader that
 * shares the same parse worker. Tiles already loaded near the car (full, with buildings) are skipped.
 */
import { loadTile } from '../map/mapLoader.js';

const API_BASE = import.meta.env.VITE_MAP_API || 'http://localhost:4041';
const REGION = import.meta.env.VITE_TILE_REGION || 'barcelona';

let _started = false;

// Wait for the browser to be idle before doing the next tile — so the whole-city background load only runs
// in spare time and never competes with a gameplay frame. Falls back to a short timeout on a busy thread.
const idle = (timeout = 300) => new Promise((r) => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => r(), { timeout });
  else setTimeout(r, 40);
});

export async function loadCityMap(customMap, { onProgress } = {}) {
  if (_started || !customMap) return;
  _started = true;

  // Respect data-saver / very slow connections — skip the ~426-tile pull; the map still fills where you drive.
  try {
    const conn = navigator.connection;
    if (conn && (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || ''))) {
      console.info('[cityMap] slow/data-saver connection — skipping full-city preload');
      return;
    }
  } catch {}

  let tiles = [];
  try {
    const res = await fetch(`${API_BASE}/api/tile-manifest?region=${REGION}&zoom=16`);
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    tiles = (await res.json())?.tiles || [];
  } catch (e) {
    console.warn('[cityMap] manifest fetch failed — map will only show driven areas:', e?.message || e);
    return;
  }

  let done = 0;
  for (const id of tiles) {
    const m = /^\d+_(\d+)_(\d+)$/.exec(id);
    if (m) {
      const tx = +m[1], ty = +m[2];
      const key = `${tx}_${ty}`;
      if (!customMap.hasTile(key)) {
        try {
          const data = await loadTile(tx, ty, undefined, true);   // lite: 2D features only (no elevation/buildings)
          if (data && (data.roads?.length || data.water?.length || data.greens?.length)) {
            customMap.ingestTile(key, data, true);   // lite: roads/water/parks only
          }
        } catch { /* skip a bad tile */ }
      }
    }
    onProgress?.(++done, tiles.length);
    await idle();   // only continue when the main thread is idle → never steals a gameplay frame
  }
  console.log(`[cityMap] full city loaded (${done}/${tiles.length} tiles)`);
}
