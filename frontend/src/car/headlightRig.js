/**
 * headlightRig.js — the car's two headlight SpotLights, owned ABOVE the car and permanently in the
 * scene (v3, D-39).
 *
 * WHY THESE ARE NOT IN carModel ANY MORE. three compiles the scene's LIGHT COUNTS into every shader:
 * `numDirLights, numPointLights, numSpotLights, numSpotLightMaps` are part of each program's cache
 * key. Add or remove one light and **every material in the scene is invalidated and recompiles**.
 *
 * The headlights used to be created inside carModel and added to `bodyGroup`, so the count moved:
 *
 *   boot / warm-up   1,0,0,0     the boot compileAsync warms the whole city against THIS
 *   car spawns       1,0,2,2     ...and every one of those programs is thrown away
 *   car disposed     1,0,0,0     mode switch or respawn — thrown away again
 *
 * A 2026-08-26 drive caught it exactly: programs #1-#49 carry `1,0,0,0`, and from #50 — the program
 * immediately after `[physics] Rapier enabled` — every key carries `1,0,2,2`. 72 programs compiled
 * after the warm-up, each a synchronous compile on the main thread, each a visible stutter (D-39).
 *
 * So the pair is created ONCE, at boot, BEFORE the warm-up, and never leaves the scene. The car
 * ADOPTS it: `attachTo(bodyGroup)` re-parents the lights and their aim target under the car body,
 * which changes where they hang in the graph but NOT how many lights the scene has. `detach()`
 * hands them back to the scene root at zero intensity. The count is `1,0,2,2` from the first frame
 * to the last, so the warm-up's output stays valid for the whole session.
 *
 * ⚠ Whatever you do here, do not add, remove, or conditionally create a light after boot. The same
 * rule already governs armLightGrid() (see main.js): patching or re-lighting AFTER the warm-up
 * discards the entire warm set. This module is the same lesson applied to lights.
 */
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { getHeadlightCookie } from './headlightCookie.js';

// Soft DRL by day, warm beam at night. 60 blew out to a total whiteout pool; 24 lights the road
// without nuking it. Kept here because the rig, not the car, now owns the lights.
export const HEADLIGHT_DAY = 6.0;
export const HEADLIGHT_NIGHT = 24.0;

let _rig = null;

/**
 * The session's one headlight rig. Call once at boot (before the warm-up) to fix the light count;
 * later calls return the same rig. Returns null when CONFIG.ENABLE_CAR_LIGHTS is off — in that case
 * the count is simply `1,0,0,0` for the whole session, which is equally stable.
 */
export function getHeadlightRig(scene) {
  if (_rig) return _rig;
  if (!CONFIG.ENABLE_CAR_LIGHTS) return null;

  const cookie = getHeadlightCookie();
  // The aim target. Local to whatever the lights are parented to, so it re-parents with them.
  const target = new THREE.Object3D();
  target.position.set(0, -1, 20);

  const spots = [];
  for (const xPos of [-0.55, 0.55]) {
    // v3 P2-07: a real dipped-beam pattern instead of a plain cone. The cookie supplies the hard
    // horizontal cut-off, so the cone is 45 degrees (less wasted spread) with penumbra 0.35 —
    // stacking cone softness on top of the pattern blurs the cut-off away again.
    const spot = new THREE.SpotLight(0xFFF0CC, 0, 520, Math.PI / 4, 0.35);
    // ⚠ Works with castShadow = false: WebGLLights calls shadow.updateMatrices() whenever light.map
    // is set, independently of shadow casting (WebGLLights.js:324-334). A cookie costs no shadow.
    //
    // It DOES cost a cache-key slot: `map` is what makes this `numSpotLightMaps: 2` rather than 0.
    // Setting it here, at construction, is what keeps that slot stable from the warm-up onward.
    spot.map = cookie;
    spot.position.set(xPos, 0.30, 1.75);
    spot.target = target;
    spot.castShadow = false;
    spots.push(spot);
  }

  // Parked at the scene root, dark, until a car adopts them. They are in the scene from this moment
  // for the rest of the session — that permanence IS the fix.
  scene.add(target);
  for (const s of spots) scene.add(s);

  _rig = {
    spots,
    target,
    /** Re-parent the pair under a car body. Same light count, new transform parent. */
    attachTo(group) {
      group.add(target);
      for (const s of spots) group.add(s);
    },
    /** Hand them back to the scene root, dark. Called when a car is disposed. */
    detach() {
      for (const s of spots) { s.intensity = 0; scene.add(s); }
      scene.add(target);
    },
    setIntensity(v) { for (const s of spots) s.intensity = v; },
  };
  return _rig;
}
