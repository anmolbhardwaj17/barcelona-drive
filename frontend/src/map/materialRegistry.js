/**
 * materialRegistry.js — the material chokepoint (v3 P1-03).
 *
 * THE PROBLEM. Ten places assigned `material.onBeforeCompile = fn`. Assignment is destructive: the
 * last writer wins and every earlier shader patch vanishes silently — no error, no warning, just a
 * material that quietly stopped doing half its job. Today that mostly works because each material
 * happens to have one owner. It stops working the moment anything wants to patch a material someone
 * else already patched, which is precisely what the rest of v3 needs:
 *
 *   - scene-wide IBL              (P2/P3) — touches every lit material
 *   - lightGrid.js clustered light (P2)   — touches every lit material
 *   - the road detail/normal map   (P3)   — roads already carry patchRoadAO + the light grid
 *   - wet roads                    (P4)   — same material again
 *   - three's CSM                         — `CSM.js:443` ASSIGNS onBeforeCompile. Dropping CSM onto
 *     road materials as-is would delete the road night wash AND the baked v9 sky AO from every road
 *     in the city, and the only symptom would be "the roads look a bit flat now".
 *
 * So: nothing assigns any more. `patchMaterial()` CHAINS.
 *
 * ⚠ THE CACHE-KEY TRAP, which is why this is not just an array of callbacks. three caches compiled
 * programs per material configuration and does NOT know what `onBeforeCompile` did. Two materials
 * with identical properties but different patches hash to the same program, and whichever compiled
 * first is reused for both — so a road can silently render with a tree's shader. Every patch here
 * therefore contributes its TAG to `customProgramCacheKey`, which is what keeps the cache honest.
 */

const _registry = new Set();

/**
 * Chain a shader patch onto a material. Safe to call repeatedly, in any order, from any module.
 *
 * @param {THREE.Material} mat
 * @param {(shader: object, renderer: object) => void} patch
 * @param {string} tag  short, stable, unique per patch KIND (e.g. 'roadAO'). Feeds the program
 *                      cache key — two materials differing only in patches MUST differ in tag set.
 * @param {{requires?: 'instancing'|'batching'}} [opts]
 *   `requires` declares that the injected GLSL only compiles on that mesh kind — e.g. a patch that
 *   reads `instanceMatrix` is INVALID on a plain Mesh and will fail to compile with
 *   "'instanceMatrix' : undeclared identifier". The boot warm-up reads this so it cannot build an
 *   invalid material/mesh combination. (Learned the hard way: the warm list built a plain Mesh for
 *   the instanced cloud material and spammed VALIDATE_STATUS failures every frame.)
 */
export function patchMaterial(mat, patch, tag, opts = {}) {
  if (!mat || typeof patch !== 'function') return mat;
  const ud = (mat.userData ||= {});
  const tags = (ud._patchTags ||= []);
  if (tag) {
    if (tags.includes(tag)) return mat;   // idempotent: re-patching with the same tag is a no-op
    tags.push(tag);
  }

  if (opts.requires) ud._requires = opts.requires;

  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);     // earlier patches run FIRST, so later ones see their edits
    patch(shader, renderer);
  };
  // Remember the handler we installed. If anything later ASSIGNS onBeforeCompile instead of going
  // through here, the chain is gone and every patch on this material is silently dropped —
  // auditMaterialPatches() below is what turns that into a console line instead of an art bug.
  ud._ddPatchFn = mat.onBeforeCompile;

  // Keep the program cache honest (see the trap above). Preserve any key the material already had.
  const baseKey = ud._baseCacheKey ?? (ud._baseCacheKey = mat.customProgramCacheKey?.bind(mat) ?? null);
  mat.customProgramCacheKey = () => `${baseKey ? baseKey() : mat.type}|${tags.join('+')}`;

  const isNew = !_registry.has(mat);
  _registry.add(mat);
  if (isNew) _announce(mat);
  return mat;
}

/** Record a material without patching it — so the warm list and diagnostics can see it. */
export function registerMaterial(mat, kind) {
  if (!mat) return mat;
  (mat.userData ||= {})._kind = kind || mat.userData._kind || mat.type;
  const isNew = !_registry.has(mat);
  _registry.add(mat);
  if (isNew) _announce(mat);
  return mat;
}

/** Every material the registry knows about. Used by the boot shader warm-up (P1-04). */
export function getRegisteredMaterials() { return [..._registry]; }

// ── Late-registration hook ────────────────────────────────────────────────────────────────────
// Tile materials are created LAZILY as tiles build, so anything that patches "every material" at a
// single moment silently misses every material created afterwards. For the light grid that means
// driving into a new tile yields unlit geometry — the lighting appears to stop working partway
// down the street, with no error. Subscribers here get called for materials registered later too.
const _listeners = new Set();

/**
 * Call `cb(mat)` for every material registered from now on, and (by default) once for each one
 * already known — so a subscriber cannot miss materials merely because of when it subscribed.
 * Returns an unsubscribe function.
 */
export function onMaterialRegistered(cb, replayExisting = true) {
  _listeners.add(cb);
  if (replayExisting) for (const m of [..._registry]) { try { cb(m); } catch { /* one bad material must not stop the rest */ } }
  return () => _listeners.delete(cb);
}

function _announce(mat) {
  for (const cb of _listeners) { try { cb(mat); } catch { /* never let a listener break material creation */ } }
}

/**
 * Which mesh kinds it is VALID to compile this material on — the warm-up asks before building one.
 * Returns a subset of ['mesh','instanced','batched'].
 */
export function meshKindsFor(mat) {
  const req = mat?.userData?._requires;
  if (req === 'instancing') return ['instanced'];
  if (req === 'batching') return ['batched'];
  return ['mesh', 'instanced', 'batched'];
}

/** What patches a material carries — for debugging "why does this look wrong". */
export function describeMaterial(mat) {
  return { kind: mat?.userData?._kind ?? mat?.type, patches: mat?.userData?._patchTags ?? [] };
}

/**
 * Dev guard: catch anything that ASSIGNS onBeforeCompile after the registry has patched a material,
 * which is the exact failure this module exists to prevent. Warns rather than throws — a false
 * positive must not take the game down mid-drive.
 */
/**
 * Find materials whose patch chain was CLOBBERED by a raw `onBeforeCompile = ...` assignment.
 *
 * ⚠ THE PREDECESSOR OF THIS FUNCTION COULD NOT WORK, AND WAS NEVER CALLED. It tested
 * `!mat.onBeforeCompile` — but a clobber REPLACES the handler, so it stays truthy. It would have
 * reported nothing even if something called it, and nothing did.
 *
 * This compares against the handler patchMaterial actually installed, which is the only thing that
 * distinguishes "still chained" from "overwritten". It found the real case it was written for:
 * facadeArray assigned onBeforeCompile directly, dropping patchLightGrid from every building
 * facade — the lamps lit the pavement and not the wall above it, with nothing logged.
 *
 * Not gated behind DEBUG_INIT: a dropped patch is a silent FAILURE, not chatter.
 */
export function auditMaterialPatches() {
  const broken = [];
  for (const mat of _registry) {
    const ud = mat.userData;
    if (!ud?._ddPatchFn) continue;                 // never patched through here — nothing to lose
    if (mat.onBeforeCompile !== ud._ddPatchFn) {
      broken.push(`${ud._kind ?? mat.type}(${(ud._patchTags || []).join('+') || 'untagged'})`);
    }
  }
  if (broken.length) {
    console.warn('[materialRegistry] %d material(s) had their patch chain CLOBBERED — every patch on ' +
      'them was dropped (lighting, AO, wind...). Use patchMaterial() instead of assigning ' +
      'onBeforeCompile: %s', broken.length, broken.join(', '));
  }
  return broken;
}
