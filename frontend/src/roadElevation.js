/**
 * Shared road elevation normalization for physics and visual meshes.
 * Ensures deck colliders and road renderer use identical Y so ramps align.
 */
import { CONFIG } from './config.js';

/**
 * Convert a raw baked road elevation to physics/visual Y (same space as terrain and deck colliders).
 * Used by roadRenderer.getRoadPointHeights and tileManager.createDeckColliders so heights match exactly.
 *
 * @param {number} raw - Raw elevation from tile data (meters or already normalized)
 * @param {number} elevationOffset - World elevation offset (spawn-anchored getWorldElevationOffset; D-12 single baseline)
 * @param {number} vertExag - ELEVATION_VERTICAL_EXAGGERATION (default 1)
 * @returns {number} Y in physics/visual space
 */
export function toNormalizedRoadY(raw, elevationOffset, vertExag) {
  const scale = Number.isFinite(vertExag) ? vertExag : 1;
  const offset = Number.isFinite(elevationOffset) ? elevationOffset : 0;
  if (CONFIG.BAKED_ROAD_ELEVATION_IS_RAW) {
    return (raw - offset) * scale;
  }
  return raw * scale;
}
