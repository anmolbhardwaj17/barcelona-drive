/**
 * spawnConfig.js — Single source of truth for the player spawn location.
 *
 * HOW TO CHANGE THE SPAWN:
 *   • Default (hardcoded start): edit DEFAULT_SPAWN below and re-deploy.
 *   • Runtime (future spawn-selector UI): call setActiveSpawn({ lat, lon })
 *     before main.js calls spawnTileReady / createTileManager.
 *     The UI should write here; main.js and scene.js both read getActiveSpawn().
 *
 * CONTRACT:
 *   • main.js reads getActiveSpawn() for: spawn tile fetch, elevation offset,
 *     findRoadSpawn(), and car spawn position.
 *   • scene.js reads START_LAT / START_LON for initial camera placement.
 *   • Neither projection.js nor tileManager.js imports this module.
 *     They receive spawn data as function arguments from main.js.
 */

/** Default spawn: Sant Gervasi / Ronda de Dalt trench portal (tile 16_33154_24471) — placed for the
 *  terrain-tunnel rework Phase 3 slice-② drive check: descend the authored open-cut trench into the
 *  tunnel on real ground (the trench is carved into the elevation grid; the car must not float over it).
 *  findRoadSpawn() snaps to the nearest drivable non-tunnel road, so this lands on a surface street
 *  beside the portal — drive toward the trench.
 *  (Previous spawns: 41.3700/2.1600 Montjuïc slope — Phase 0/1/2 gates; 41.40606/2.12031 Gran Via
 *  trunk-tunnel approach — old simple-tunnel testing.) */
export const DEFAULT_SPAWN = {
  // 2026-08-26 — COLLSEROLA, Carretera de les Aigües. Set to check v3 P3-10 HILLSIDE vegetation.
  //
  // The species classifier now routes background/hill cluster trees through a 'hill' set
  // (celtis/tipuana/plane — no palms, no ornamentals). That path is environmentClusterRenderer's
  // terrain scatter, which only has anything to show on non-urban ground with real elevation, so
  // it cannot be judged from the Eixample. Collserola is the wooded slope; Montjuïc (41.3700,
  // 2.1600) and Park Güell (41.4145, 2.1527) are the other two baked hills.
  //
  // ⚠ PERF WORK MUST MOVE THIS BACK. The frame-lag benchmark spawn is GRAN VIA at Plaça
  // Universitat — { lat: 41.3866, lon: 2.1640 } — deliberately the same place as the v3 benchmark
  // (P0-05) and the start of `bench/benchRoute.js`: the densest thing the renderer has to survive.
  // Lag is a p95 problem and p95 lives there; measuring stream-in on a quiet hillside measures the
  // wrong thing. Any A/B or drive report taken from Collserola is NOT comparable to earlier ones.
  lat: 41.4180,
  lon: 2.1150,
  heading: null,
};



// Rough baked Barcelona map extent — a spawn outside this has no tiles (blank/broken world).
const SPAWN_BOUNDS = { minLat: 41.28, maxLat: 41.47, minLon: 2.04, maxLon: 2.24 };
export function isSpawnInBounds(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= SPAWN_BOUNDS.minLat && lat <= SPAWN_BOUNDS.maxLat &&
    lon >= SPAWN_BOUNDS.minLon && lon <= SPAWN_BOUNDS.maxLon;
}

let _activeSpawn = { ...DEFAULT_SPAWN };

/** Returns the current active spawn. Always returns a copy. */
export function getActiveSpawn() {
  return { ..._activeSpawn };
}

/**
 * Override the active spawn location. Call before init (before spawnTileReady).
 * Future spawn-selector UI should call this, then trigger a page reload or
 * a full re-init sequence (reset tileManager, re-fetch spawn tile, re-place car).
 */
export function setActiveSpawn({ lat, lon, heading = null }) {
  _activeSpawn = { lat: Number(lat), lon: Number(lon), heading: heading ?? null };
}

/** Reset to default spawn. */
export function resetSpawn() {
  _activeSpawn = { ...DEFAULT_SPAWN };
}

// URL override: ?spawn=lat,lon (the ESC-menu place search reloads with this). Applied at module load,
// before main.js reads getActiveSpawn(), so the whole world inits at the chosen location.
try {
  const sp = new URLSearchParams(globalThis.location?.search || '').get('spawn');
  if (sp) {
    const [la, lo] = sp.split(',').map(Number);
    // Reject out-of-area coords (e.g. ?spawn=0,0) — they'd boot into an empty world with no baked tiles.
    if (isSpawnInBounds(la, lo)) setActiveSpawn({ lat: la, lon: lo });
    else if (sp) console.warn(`[spawn] ?spawn=${sp} is outside the Barcelona map area — using default spawn.`);
  }
} catch { /* no window (SSR/worker) */ }

// Flat re-exports so existing imports of START_LAT/START_LON from projection.js
// can be migrated one file at a time. These always reflect DEFAULT_SPAWN (static),
// not _activeSpawn (dynamic). For runtime-changed spawn, use getActiveSpawn().
export const START_LAT = DEFAULT_SPAWN.lat;
export const START_LON = DEFAULT_SPAWN.lon;
