/**
 * objectiveNav.js — the thing between "there is an objective" and "the player knows how to get there".
 *
 * Owns one route: plans it, replans when the player leaves it, tracks progress along it, hands the
 * minimap the polyline to draw and the HUD the next instruction. Modes call `setTarget()` and then
 * `update()` once a frame; they do not touch `router` or the minimap's route API themselves.
 *
 * ── WHY THE REPLAN IS THROTTLED AND CONDITIONAL ───────────────────────────────────────────────
 * A* over the road graph is not free — it builds a graph, and although that graph is clipped to the
 * trip it is still thousands of nodes. Planning every frame would be a permanent tax on the frame
 * for a line that changes only when the player leaves it. So: plan on a new target, replan when
 * more than OFF_ROUTE_M from the line, and retry on a slow clock while no route exists (the roads
 * for the far end may simply not have streamed in yet — a null here is often "not yet", not "never").
 *
 * World coordinates in road-point form, `{x: easting, y: northing}`. Modes think in `{wx, wz}`;
 * `wz → y`.
 */
import { planRoute, projectOnRoute } from './router.js';

const OFF_ROUTE_M = 38;      // beyond this the drawn line is describing a street you are not on
const MIN_REPLAN_S = 1.1;    // never two searches inside this window
const RETRY_S = 3.0;         // while there is NO route at all — the far end may still be streaming

export function createObjectiveNav({ getRoadSegments, getMinimap, color = null }) {
  let target = null;          // {x, y} world
  let route = null;           // planRoute() result
  let sinceReplan = 1e9;
  let along = 0;

  function push() {
    getMinimap?.()?.setRoute?.(route ? route.points : null, { alongM: along, color });
  }

  function replan(carX, carY) {
    sinceReplan = 0;
    if (!target) { route = null; along = 0; push(); return; }
    const r = planRoute(getRoadSegments?.() || [], { x: carX, y: carY }, target);
    route = r;
    along = 0;
    push();
  }

  return {
    /** @param {number|null} wx @param {number} [wz] — pass null to clear. */
    setTarget(wx, wz) {
      target = (wx === null || wx === undefined) ? null : { x: wx, y: wz };
      route = null; along = 0; sinceReplan = 1e9;
      push();
    },
    clear() { target = null; route = null; along = 0; getMinimap?.()?.setRoute?.(null); },

    /**
     * @returns {{
     *   hasRoute:boolean, remainingM:number, crowM:number, etaS:number,
     *   next:{dir:string, onto:string, inM:number}|null, offRoute:boolean
     * }}
     * `remainingM` is distance ALONG THE ROADS, which is the number worth showing: crow-flies goes
     * UP while you drive a correct route round a block, and a HUD that does that is worse than none.
     */
    update(carX, carY, dt) {
      sinceReplan += dt || 0;
      const crowM = target ? Math.hypot(target.x - carX, target.y - carY) : 0;
      if (!target) return { hasRoute: false, remainingM: 0, crowM: 0, etaS: 0, next: null, offRoute: false };

      if (!route) {
        if (sinceReplan >= RETRY_S) replan(carX, carY);
        return { hasRoute: false, remainingM: crowM, crowM, etaS: 0, next: null, offRoute: false };
      }

      const proj = projectOnRoute(route.points, carX, carY);
      along = proj.along;
      const offRoute = proj.offBy > OFF_ROUTE_M;
      if (offRoute && sinceReplan >= MIN_REPLAN_S) {
        replan(carX, carY);
        return { hasRoute: !!route, remainingM: route ? route.lengthM : crowM, crowM, etaS: route ? route.timeS : 0, next: null, offRoute: true };
      }
      getMinimap?.()?.setRouteProgress?.(along);

      let next = null;
      for (const m of route.legs) {
        // 6 m of slack so an instruction does not linger for the frame you are standing on it.
        if (m.distFromStart > along + 6) { next = { dir: m.dir, onto: m.onto, inM: m.distFromStart - along }; break; }
      }
      const frac = proj.total > 0 ? Math.max(0, 1 - along / proj.total) : 0;
      return {
        hasRoute: true,
        remainingM: Math.max(0, proj.total - along),
        // Scaled by how much of the route is left rather than re-planned: the remaining TIME tracks
        // the remaining DISTANCE on the same route, and re-running A* once a second to refine an
        // ETA would cost more than the ETA is worth.
        etaS: route.timeS * frac,
        crowM, next, offRoute: false,
      };
    },
  };
}
