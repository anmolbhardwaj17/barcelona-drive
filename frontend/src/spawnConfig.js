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
  // GRAN VIA at Plaça Universitat, dense Eixample. The standing default.
  //
  // This is deliberately the same place as the v3 performance benchmark (P0-05) and the start of
  // `bench/benchRoute.js`: the densest thing the renderer has to survive. Frame lag is a p95
  // problem and p95 lives here — measuring stream-in anywhere quieter measures the wrong thing.
  //
  // For hillside vegetation, don't move this: use `?spawn=41.4180,2.1150` (Collserola),
  // `?spawn=41.3700,2.1600` (Montjuïc) or `?spawn=41.4145,2.1527` (Park Güell). The URL override
  // does the same job without making every later drive report incomparable to the earlier ones.
  lat: 41.3866,
  lon: 2.1640,
  heading: null,
};



/**
 * ── WHERE A FRESH LOAD STARTS ─────────────────────────────────────────────────────────────────
 *
 * One list, exported, and the hub's place picker reads THIS rather than keeping its own copy — a
 * second list of the same nine coordinates is the duplicate-constant failure this codebase has been
 * bitten by repeatedly (see groundLayers' TERRAIN_LIFT note).
 *
 * These are district centres, not surveyed kerbside points: `findRoadSpawn()` snaps to the nearest
 * drivable non-tunnel road, so being 100 m off a street is fine and being outside the baked extent
 * is not. `spawnAndEconomy.test.js` asserts every entry is inside SPAWN_BOUNDS — a coordinate that
 * is not boots the player into a blank world with no tiles, which looks like a broken game and
 * reads, in the console, like nothing at all.
 */
export const SPAWN_POOL = [
  { name: 'Gran Via',           lat: 41.3866, lon: 2.1640 },
  { name: 'Eixample',           lat: 41.3920, lon: 2.1650 },
  { name: 'Sagrada Família',    lat: 41.4036, lon: 2.1744 },
  { name: 'Passeig de Gràcia',  lat: 41.3948, lon: 2.1602 },
  { name: 'Barceloneta',        lat: 41.3797, lon: 2.1899 },
  { name: 'Port Olímpic',       lat: 41.3875, lon: 2.1969 },
  { name: 'Montjuïc',           lat: 41.3641, lon: 2.1585 },
  { name: 'Gothic Quarter',     lat: 41.3833, lon: 2.1777 },
  { name: 'Camp Nou',           lat: 41.3809, lon: 2.1228 },
  { name: 'Gràcia',             lat: 41.4045, lon: 2.1560 },
  { name: 'Poblenou',           lat: 41.3990, lon: 2.1995 },
  { name: 'Sants',              lat: 41.3755, lon: 2.1330 },
];

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

/**
 * ── LOAD-TIME SPAWN RESOLUTION ────────────────────────────────────────────────────────────────
 *
 * Priority, highest first:
 *   1. `?spawn=lat,lon`  — an explicit choice. The hub's place picker navigates with this, so
 *                          picking a place always wins and holds for that session.
 *   2. `?spawn=fixed`    — pin DEFAULT_SPAWN. For perf work: the v3 benchmark and `bench/benchRoute`
 *                          both start at Gran Via, and a randomised start makes every drive report
 *                          incomparable to the last one. Measure from the same place or do not
 *                          compare the numbers.
 *   3. RANDOM from SPAWN_POOL — the default. Every fresh load starts somewhere else.
 *
 * ⚠ This only moves `_activeSpawn`. `START_LAT`/`START_LON` stay pinned to DEFAULT_SPAWN because
 * they are static re-exports and the projection origin must not move — the same reason `?spawn=`
 * has always been safe.
 */
try {
  const sp = new URLSearchParams(globalThis.location?.search || '').get('spawn');
  if (sp === 'fixed') {
    // stay on DEFAULT_SPAWN
  } else if (sp) {
    const [la, lo] = sp.split(',').map(Number);
    // Reject out-of-area coords (e.g. ?spawn=0,0) — they'd boot into an empty world with no baked tiles.
    if (isSpawnInBounds(la, lo)) setActiveSpawn({ lat: la, lon: lo });
    else console.warn(`[spawn] ?spawn=${sp} is outside the Barcelona map area — using default spawn.`);
  } else {
    const pick = SPAWN_POOL[Math.floor(Math.random() * SPAWN_POOL.length)];
    if (pick && isSpawnInBounds(pick.lat, pick.lon)) {
      setActiveSpawn({ lat: pick.lat, lon: pick.lon });
      // Not gated behind ?debug: when a player says "it spawned me somewhere odd", this one line is
      // the difference between reproducing it and guessing.
      console.log(`[spawn] random start: ${pick.name} (${pick.lat}, ${pick.lon}) — ?spawn=fixed to pin`);
    }
  }
} catch { /* no window (SSR/worker) */ }

// Flat re-exports so existing imports of START_LAT/START_LON from projection.js
// can be migrated one file at a time. These always reflect DEFAULT_SPAWN (static),
// not _activeSpawn (dynamic). For runtime-changed spawn, use getActiveSpawn().
export const START_LAT = DEFAULT_SPAWN.lat;
export const START_LON = DEFAULT_SPAWN.lon;
