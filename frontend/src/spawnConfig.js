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
  // Avinguda Diagonal near Passeig de Gràcia — wide central avenue (multi-lane), at-grade,
  // good for traffic + an Eixample showcase. (Was Sagrada Família 41.4036/2.1744.)
  lat: 41.3948,
  lon: 2.1602,
  heading: null,
};

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

// Flat re-exports so existing imports of START_LAT/START_LON from projection.js
// can be migrated one file at a time. These always reflect DEFAULT_SPAWN (static),
// not _activeSpawn (dynamic). For runtime-changed spawn, use getActiveSpawn().
export const START_LAT = DEFAULT_SPAWN.lat;
export const START_LON = DEFAULT_SPAWN.lon;
