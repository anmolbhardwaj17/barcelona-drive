/**
 * Art-of-rally style toggle — an opt-in flat/hazy/muted art direction for A/B evaluation.
 *
 * Enable with ?style=rally (read once at load). When off, the game renders in its normal style.
 * The flag is consulted by the building/terrain/fog/lighting/post code to swap surface treatment
 * without changing any geometry.
 */
let _rally = false;
try { _rally = new URLSearchParams(window.location.search).get('style') === 'rally'; } catch {}

export function isRallyStyle() { return _rally; }
