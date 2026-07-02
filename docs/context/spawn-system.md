# Spawn System

## Overview

Player spawn location is controlled by a single module: `frontend/src/spawnConfig.js`. No other file hardcodes lat/lon spawn coordinates.

## The Module

```js
// frontend/src/spawnConfig.js
export const DEFAULT_SPAWN = { lat: 41.3915, lon: 2.1649, heading: null };

export function getActiveSpawn() { ... }   // returns current spawn (copy)
export function setActiveSpawn({ lat, lon, heading }) { ... }  // UI calls this
export function resetSpawn() { ... }

// Static re-exports for backward compat (always DEFAULT_SPAWN, not _activeSpawn)
export const START_LAT = DEFAULT_SPAWN.lat;
export const START_LON = DEFAULT_SPAWN.lon;
```

## Default Spawn Location

**Barcelona Eixample** — near Passeig de Gràcia / Carrer de Mallorca intersection:
```
lat: 41.3915°N
lon: 2.1649°E
heading: null (auto from findRoadSpawn)
```
`findRoadSpawn()` in `main.js` snaps this to the nearest major road and computes the heading from the road direction.

## How Data Flows

```
spawnConfig.js (source of truth)
    │
    ├─ main.js reads getActiveSpawn() → _spawnLat, _spawnLon
    │      ├─ latLonToTile(_spawnLat, _spawnLon) → spawn tile fetch
    │      ├─ getElevationFromGrid(data, _spawnLat, _spawnLon) → worldElevationOffset
    │      └─ findRoadSpawn(tileData, spawnCenter) → car spawn position + heading
    │
    └─ scene.js reads START_LAT, START_LON (static re-exports)
           └─ latLonToWorld(START_LAT, START_LON) → initial camera position
```

## Where a Future Spawn-Selector UI Plugs In

A spawn-selector UI (e.g., map click, dropdown of preset locations) should:

```js
import { setActiveSpawn } from './spawnConfig.js';

// Call this BEFORE app init (before spawnTileReady fires in main.js)
setActiveSpawn({ lat: 41.3833, lon: 2.1734 }); // e.g., Barceloneta waterfront
```

If called after init (at runtime, during gameplay): the app needs a full re-init:
1. `setActiveSpawn({ lat, lon })`
2. Dispose current `carDriver` + `tileManager`
3. Re-run the init sequence from `spawnTileReady` onward

A future implementation might expose a `reinitSpawn(lat, lon)` function in `main.js` that handles this teardown+restart. The spawn config module is already ready for this; only the teardown/restart logic needs to be written.

## Preset Locations (Barcelona)

Add presets here for the UI to offer:

| Name | Lat | Lon | Notes |
|---|---|---|---|
| Eixample (default) | 41.3915 | 2.1649 | Near Passeig de Gràcia |
| Barceloneta | 41.3800 | 2.1940 | Coastal, near beach |
| Montjuïc approach | 41.3700 | 2.1600 | Tests elevation |
| Port Olímpic | 41.3847 | 2.1972 | Ronda Litoral east |
| Diagonal Mar | 41.4097 | 2.2180 | NE coastal ring road |
| Camp Nou area | 41.3808 | 2.1228 | West Eixample |

## Relationship to Mercator Origin

`ORIGIN_LAT/ORIGIN_LON` in `projection.js` is NOT the spawn point — it is the Mercator projection reference origin. It stays fixed for the lifetime of the region.

The spawn controls WHICH tile loads first and where `worldElevationOffset` is sampled. The Mercator origin controls the coordinate space for all world → Mercator conversions. Both must be updated when migrating to a new city, but they are independent concepts.

## History

Before May 2026: `START_LAT/START_LON` were hardcoded in `frontend/src/projection.js` (28.5672°N, 77.2095°E — AIIMS Flyover, Delhi). They are now in `spawnConfig.js`. `projection.js` re-exports them from `spawnConfig.js` for backward compatibility.
