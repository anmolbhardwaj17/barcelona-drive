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

export async function loadCityMap(customMap, { onProgress, yieldMs = 25 } = {}) {
  if (_started || !customMap) return;
  _started = true;

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
          const data = await loadTile(tx, ty);
          if (data && (data.roads?.length || data.water?.length || data.greens?.length)) {
            customMap.ingestTile(key, data, true);   // lite: roads/water/parks only
          }
        } catch { /* skip a bad tile */ }
      }
    }
    onProgress?.(++done, tiles.length);
    await new Promise((r) => setTimeout(r, yieldMs));   // let gameplay tile loads interleave
  }
  console.log(`[cityMap] full city loaded (${done}/${tiles.length} tiles)`);
}
