/**
 * Shadow-map refresh requests (v3 P0-03).
 *
 * `renderer.shadowMap.autoUpdate` is FALSE (set in scene.js), so the directional light's depth pass
 * only re-renders on frames where something asked for it. Any subsystem that changes what a shadow
 * should look like — a tile revealing new geometry, the sun moving, the hero car moving — calls
 * `requestShadowRefresh()`. main.js drains the flag once per frame.
 *
 * ⚠ Do NOT set `renderer.shadowMap.needsUpdate` directly from subsystems: three clears it inside
 * render(), so a write that lands after render() in the same frame is silently lost. Going through
 * this flag means the request survives until the next drain regardless of call order.
 */
let _dirty = true;   // start true so the first frame after boot renders a shadow map

/** Ask for one shadow-map refresh on the next rendered frame. Cheap; call freely. */
export function requestShadowRefresh() { _dirty = true; }

/** main.js only: consume the request. Returns true if a refresh is owed. */
export function consumeShadowRefresh() { const d = _dirty; _dirty = false; return d; }
