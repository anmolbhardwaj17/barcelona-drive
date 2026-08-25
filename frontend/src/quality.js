/**
 * quality.js — the device quality tier (v3 P1-08).
 *
 * Before v3 the ONLY device branching in the entire frontend was three copies of
 * `(pointer: coarse)` deciding HUD layout (minimap, speedDisplay, touchControls). There was no
 * quality system at all — `grep -i quality src/config.js` returned nothing.
 *
 * That matters more than it sounds. The v3 art library targets ~200 MiB of texture VRAM on top of
 * an ~800 MB heap. On unified-memory mobile, where Safari kills tabs around 1–1.5 GB, that is not a
 * "slightly worse frame rate" — it is a crash. Binding constraint 5 ("must scale DOWN to mobile,
 * never exclude it") assumed a mechanism that did not exist.
 *
 * ⚠ WHY THIS LANDS IN P1, BEFORE ANY ART. The pipeline has to EMIT half-res variants from the first
 * asset. Retrofitting variant emission across ~100 authored assets later is the same
 * "free today, unrecoverable after 100 assets" trap as the art direction and the region profile.
 *
 * Detection is deliberately conservative: misjudging a desktop as mobile is a visible downgrade for
 * a user who paid for the hardware, so LOW requires corroborating evidence, not one weak signal.
 */

function detectTier() {
  if (typeof window === 'undefined') return 'high';
  try {
    const params = new URLSearchParams(window.location.search);
    const forced = params.get('quality');
    if (forced === 'low' || forced === 'high') return forced;   // ?quality=low — test the tier on desktop

    const coarse = window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 1;
    const mem    = navigator.deviceMemory ?? 8;        // GiB, Chromium-only; absent → assume plenty
    const cores  = navigator.hardwareConcurrency ?? 8;

    // Two independent signals required. A touch-capable laptop is not a phone, and a Chromium
    // desktop that hides deviceMemory should never be demoted on that alone.
    const weak = (mem <= 4 ? 1 : 0) + (cores <= 4 ? 1 : 0) + (coarse ? 1 : 0);
    return weak >= 2 ? 'low' : 'high';
  } catch { return 'high'; }
}

export const QUALITY_TIER = detectTier();
export const IS_LOW_TIER = QUALITY_TIER === 'low';

/**
 * The tier's settings. Each is a knob the art pipeline or renderer already understands, so nothing
 * here needs a second code path — LOW picks different inputs, not a different renderer.
 */
export const QUALITY = {
  high: {
    textureVariant: null,     // full-res assets from the manifest
    useNormalMaps: true,
    shadowMapSize: 1024,
    lodTiers: 3,
    maxPixelRatio: 1.2,
  },
  low: {
    textureVariant: 'half',   // build-art.mjs emits these alongside every asset
    useNormalMaps: false,     // halves the map count AND the fragment cost of every world surface
    shadowMapSize: 512,
    lodTiers: 2,
    maxPixelRatio: 1.0,
  },
}[QUALITY_TIER];

if (typeof window !== 'undefined') {
  console.warn('[quality] tier=%s (normalMaps=%s, shadow=%d, dpr<=%s) — override with ?quality=low|high',
    QUALITY_TIER, QUALITY.useNormalMaps, QUALITY.shadowMapSize, QUALITY.maxPixelRatio);
}
