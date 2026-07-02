/**
 * Load tile data from backend API via Web Worker (off main thread).
 * JSON parsing + coordinate conversion happen in the worker,
 * eliminating the biggest source of main-thread jank during tile loads.
 */
import { TILE_ZOOM, getOriginMercator } from '../projection.js';
import TileParserWorker from './tileParserWorker.js?worker';

const API_BASE = import.meta.env.VITE_MAP_API || 'http://localhost:4041';
const REGION = import.meta.env.VITE_TILE_REGION || 'barcelona';
const cache = new Map();  // only for placeholders (error cases)
const inFlight = new Map();

function tileKey(tx, ty) {
  return `${tx}_${ty}`;
}

const TILE_VERSION = 5; // Used for JSON fallback version check; binary v6 skips this

const PLACEHOLDER = {
  roads: [],
  buildings: [],
  railways: [],
  vegetation: { trees: [], greenAreas: [] },
  water: [],
  greens: [],
  barriers: [],
  elevation: null,
  parking: [],
  urbanFeatures: [],
};

// ── Worker pool (reuse a single worker for all tile requests) ────────────────
let _worker = null;
let _msgId = 0;
const _pending = new Map(); // msgId → { resolve, reject }

function getWorker() {
  if (_worker) return _worker;
  _worker = new TileParserWorker();
  _worker.onmessage = (e) => {
    const { id, result, error, status, version, message } = e.data;
    const p = _pending.get(id);
    if (!p) return;
    _pending.delete(id);
    if (error) {
      p.reject({ error, status, version, message });
    } else {
      p.resolve(result);
    }
  };
  _worker.onerror = (e) => {
    console.error('[TileWorker] Worker error:', e);
  };
  return _worker;
}

function workerFetchTile(url, originX, originY) {
  return new Promise((resolve, reject) => {
    const id = ++_msgId;
    _pending.set(id, { resolve, reject });
    getWorker().postMessage({ url, originX, originY, tileVersion: TILE_VERSION, id });
  });
}

/**
 * Load one tile. Returns { roads, buildings, vegetation } in world coordinates.
 * JSON parsing + coordinate conversion run in a Web Worker (no main-thread block).
 */
export async function loadTile(tx, ty, direction) {
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
    return PLACEHOLDER;
  }
  const key = tileKey(tx, ty);
  if (cache.has(key)) return cache.get(key);
  if (inFlight.has(key)) return inFlight.get(key);

  const promise = (async () => {
    const tileId = `${TILE_ZOOM}_${tx}_${ty}`;
    const params = new URLSearchParams();
    params.set('region', REGION);
    if (direction && Number.isFinite(direction.vx)) params.set('vx', String(direction.vx));
    if (direction && Number.isFinite(direction.vz)) params.set('vz', String(direction.vz));
    const url = `${API_BASE}/api/tiles/${tileId}?${params.toString()}`;

    const origin = getOriginMercator();
    try {
      const result = await workerFetchTile(url, origin.x, origin.y);
      return result;
    } catch (err) {
      if (err.error === 'not_found') {
        console.warn('[TileLoader] Tile not found — tileId:', tileId, 'status:', err.status);
        cache.set(key, PLACEHOLDER);
        return PLACEHOLDER;
      }
      if (err.error === 'bad_version') {
        console.error('[TileLoader] Unsupported tile version:', err.version, `— expected ${TILE_VERSION}.`);
        cache.set(key, PLACEHOLDER);
        return PLACEHOLDER;
      }
      console.warn('[TileLoader] Fetch failed:', err.message || err);
      cache.set(key, PLACEHOLDER);
      return PLACEHOLDER;
    }
  })().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, promise);
  return promise;
}

export function clearTileCache() {
  cache.clear();
  // Also clear IndexedDB persistent cache
  getWorker().postMessage({ action: 'clearCache' });
}
