/**
 * regions/index.js — region profile selection (v3 P1-26).
 *
 * `VITE_TILE_REGION` already existed, but only switched TILE PATHS (mapLoader, cityMapLoader) — a
 * data-source switch, not a styling one, while 31 source files named Barcelona directly. This makes
 * it select the LOOK as well.
 *
 * Adding a city is: write `regions/<id>.js`, register it below, bake its tiles. No renderer changes.
 */
import barcelona from './barcelona.js';

const PROFILES = { barcelona };

const REGION_ID = (import.meta.env?.VITE_TILE_REGION || 'barcelona').toLowerCase();

if (!PROFILES[REGION_ID]) {
  console.warn('[regions] no profile for "%s" — falling back to barcelona. Tiles may load, but the ' +
    'environment styling will be wrong for that city.', REGION_ID);
}

/** The active region profile. Import this; never inline a city-specific constant in a renderer. */
export const REGION = PROFILES[REGION_ID] || PROFILES.barcelona;

export function getRegionId() { return REGION.id; }
