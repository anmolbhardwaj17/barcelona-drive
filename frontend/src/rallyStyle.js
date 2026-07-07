/**
 * Art-of-rally art direction — now the DEFAULT look of the game (bright/airy high-key grade, warm-key/
 * cool-shadow lighting, tire smoke, restrained bloom). Consulted by building/terrain/fog/lighting/post/car
 * code to swap surface treatment without changing geometry.
 *
 * Escape hatch: ?style=normal (or ?style=off) reverts to the old plain look for A/B debugging.
 */
let _rally = true;
try { const s = new URLSearchParams(window.location.search).get('style'); if (s === 'normal' || s === 'off') _rally = false; } catch {}

export function isRallyStyle() { return _rally; }
