/**
 * gpuWarmup.js — eliminate the "stutter when a new tile appears" hitch.
 *
 * Three.js uploads a geometry's vertex buffers to the GPU lazily, on the first frame the mesh is
 * actually rendered (renderer.compile() only compiles shader PROGRAMS, not geometry — verified in
 * r183). So when you drive into a freshly-streamed tile and all its meshes enter the frustum on the
 * same frame, every one of their VBOs uploads at once → a main-thread stall → the stutter.
 *
 * Frame-budgeting the JS build can't catch this (the cost is at render time, not build time), and
 * batching scene.add() doesn't help (scene.add is cheap; the upload is deferred to first render).
 *
 * Fix: as each tile mesh is built (well before you reach it), queue it here. Each frame we take a
 * couple of queued meshes and briefly set `frustumCulled = false` around the main render, forcing
 * ONE real render — which uploads their VBOs — then restore. Because it renders through the real
 * scene/material/lights, it reuses the already-warmed shader program (no wasteful variant compile),
 * and because it's spread a few meshes per frame it never spikes. By the time the tile reveals, its
 * geometry is already resident → no upload hitch.
 */

const _queue = [];
let _active = null;

/** Queue a freshly-built, visible tile mesh for GPU pre-upload. Cheap; safe to call with anything. */
export function queueWarmup(mesh) {
  // Only full-detail, currently-visible meshes benefit. Invisible (LOD) meshes won't render (so won't
  // upload) anyway, and re-queuing something already uploaded is harmless but wasteful — skip both.
  if (mesh && mesh.geometry && mesh.visible !== false && !mesh._ddWarmed) {
    _queue.push(mesh);
  }
}

/**
 * Call immediately BEFORE the main composer.render(). Un-culls up to `k` queued meshes so this
 * frame's render uploads their geometry. Keep `k` small (2–3) so the extra draws stay negligible.
 */
export function warmupBegin(k = 3) {
  _active = null;
  // ADAPTIVE: at speed, a whole tile's meshes (~30) can queue at once and the frustum reaches
  // them before a 3/frame drain finishes — the leftovers then upload in ONE render (the measured
  // rend 102.6ms monster frame). Deep backlog -> drain faster; each warm draw is small.
  if (_queue.length > 24) k = 8;
  else if (_queue.length > 12) k = 5;
  let taken = 0;
  while (taken < k && _queue.length) {
    const m = _queue.shift();
    if (!m || !m.parent || m.visible === false) continue; // unloaded / hidden before its turn
    m._ddPrevCull = m.frustumCulled;
    m.frustumCulled = false;
    m._ddWarmed = true;
    (_active ||= []).push(m);
    taken++;
  }
}

/** Call immediately AFTER the main composer.render() to restore normal frustum culling. */
export function warmupEnd() {
  if (!_active) return;
  for (const m of _active) m.frustumCulled = m._ddPrevCull ?? true;
  _active = null;
}

/** Drop everything (e.g. on region reset) so we don't touch disposed meshes. */
export function clearWarmup() {
  _queue.length = 0;
  _active = null;
}

export function _warmupQueueLength() { return _queue.length; }
