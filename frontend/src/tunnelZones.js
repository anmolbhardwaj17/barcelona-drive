/**
 * Tunnel trigger zones — axis-aligned bounding boxes around the UNDERGROUND
 * portions of tunnel and approach roads. The car driver checks these each
 * frame: when the car is inside any zone the ground plane is removed so
 * the car can descend on box colliders.
 *
 * Only road points with elevation < UNDERGROUND_THRESHOLD are included,
 * so the zone doesn't cover surface-level road nearby.
 *
 * Zones are registered per-tile and unregistered on tile unload.
 */

import { kerbOffset } from './map/roadWidths.js';   // R-W1: one width, one meaning

const _zones = [];  // { minX, maxX, minZ, maxZ, tileKey }
/**
 * Register trigger zones for approach/tunnel roads in a tile.
 * Zone covers just the road corridor (road width + small buffer) so the
 * ground plane stays at Y=0 for flat areas beside ramps.
 *
 * @param {object[]} roads - roads with points {x, y, elevation}
 * @param {string} tileKey
 * @param {{ x: number, z: number }} physicsOrigin
 */
export function registerTunnelZones(roads, tileKey, physicsOrigin) {
  if (!roads?.length) return;

  for (const road of roads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;

    // Road half-width + buffer for the car to be slightly off-center and still trigger.
    // R-W1: this is an "am I inside the tunnel" test, so it wants the PAVED surface (kerb to kerb) —
    // the same number the ribbon is drawn at — not the running lanes.
    const roadHalfW = kerbOffset(road);
    const margin = roadHalfW + 5;  // road edge + 5m buffer

    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    for (const p of pts) {
      // Convert to physics-local coords (same as box colliders: negated X)
      const px = -(p.x - physicsOrigin.x);
      const pz = p.y - physicsOrigin.z;
      minX = Math.min(minX, px);
      maxX = Math.max(maxX, px);
      minZ = Math.min(minZ, pz);
      maxZ = Math.max(maxZ, pz);
    }

    minX -= margin;
    maxX += margin;
    minZ -= margin;
    maxZ += margin;

    _zones.push({ minX, maxX, minZ, maxZ, tileKey });
  }
}

/**
 * Unregister all zones for a tile (called on tile unload).
 */
export function unregisterTunnelZones(tileKey) {
  for (let i = _zones.length - 1; i >= 0; i--) {
    if (_zones[i].tileKey === tileKey) _zones.splice(i, 1);
  }
}

/**
 * Check if a physics-local position is inside any tunnel trigger zone.
 * @param {number} px - physics X
 * @param {number} pz - physics Z
 * @returns {boolean}
 */
/** Expose zones for debug visualization. */
export function getZones() { return _zones; }

export function isInTunnelZone(px, pz) {
  for (const z of _zones) {
    if (px >= z.minX && px <= z.maxX && pz >= z.minZ && pz <= z.maxZ) {
      return true;
    }
  }
  return false;
}
