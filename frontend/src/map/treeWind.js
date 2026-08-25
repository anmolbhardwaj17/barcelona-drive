/**
 * treeWind.js — the multi-frequency sway injected into every tree material.
 *
 * WHY THIS IS ITS OWN MODULE. There are two tree materials that must sway IDENTICALLY: the legacy
 * procedural blobs and the v3 P3-10 photographic cards. Only one is alive per run (a CONFIG switch
 * picks it), but the GLSL must not be duplicated — a copy would drift, and two trees swaying out of
 * phase across an A/B is exactly the kind of difference that gets misread as a card-path artefact.
 * vegetationRenderer.js and treeCards.js both import from here, which also keeps them acyclic.
 */

// Every patched material registers its uniforms here; updateTreeWind drives all of them. This is a
// LIST, not a single ref: the A/B switch can leave both materials compiled in one session (the boot
// warm-up touches the active one, but environmentClusterRenderer may hold the other), and a single
// ref would silently freeze the wind on whichever material registered first.
const _uniformSets = [];

/**
 * Inject the sway into a material's vertex shader. Call from inside patchMaterial's callback.
 * Vertex shader only — unused varyings cause linker warnings on some drivers.
 */
export function injectTreeWind(shader) {
  shader.uniforms.uTime         = { value: 0.0 };
  shader.uniforms.uWindStrength = { value: 0.6 };
  _uniformSets.push(shader.uniforms);

  shader.vertexShader = shader.vertexShader.replace(
    '#include <common>',
    `#include <common>
      uniform float uTime;
      uniform float uWindStrength;`
  );

  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>',
    `#include <begin_vertex>

      // Phase A.2 tree wind — reuses grass multi-frequency pattern.
      // Y-position proxy: transformed.y / 10 gives ~0 at trunk base, ~1 at foliage tip.
      // Quadratic ramp keeps the trunk base still while foliage tips sway fully.
      float treeH = clamp(transformed.y / 10.0, 0.0, 1.0);
      float windInfluence = treeH * treeH;

      // World-space phase derived from THIS INSTANCE's position (stable per tree, varies between).
      //
      // v3 P1-21: this used modelMatrix alone, and every tree in the city swayed in EXACT UNISON.
      // The vegetation pools are BatchedMeshes parented straight to the Scene (getVegPools), so
      // modelMatrix is identity and windOrigin evaluated to (0,0,0) for every vertex of every tree —
      // one global phase. The per-instance transform lives in batchingMatrix / instanceMatrix, and
      // neither is folded into transformed until <project_vertex>, which runs AFTER this chunk.
      // Both branches are needed: the pools are batched, but environmentClusterRenderer puts the
      // same material on an InstancedMesh.
      vec3 windOrigin = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      #ifdef USE_BATCHING
        windOrigin = (modelMatrix * batchingMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      #endif
      #ifdef USE_INSTANCING
        windOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      #endif

      float windPhase = windOrigin.x * 0.08 + windOrigin.z * 0.06 + uTime * 1.8;
      float windGust  = sin(windPhase) * 0.6 + sin(windPhase * 2.3 + 1.4) * 0.3 + sin(windPhase * 0.4 - 0.7) * 0.1;
      float swayPhase = windOrigin.x * 0.12 - windOrigin.z * 0.09 + uTime * 1.2;
      float windSway  = sin(swayPhase) * 0.3;

      transformed.x += windGust * windInfluence * uWindStrength;
      transformed.z += windSway * windInfluence * uWindStrength * 0.6;`
  );
}

/**
 * Update tree wind animation time. Call once per frame from the main render loop.
 * A no-op until at least one tree material has actually compiled (onBeforeCompile fires on first
 * render, not on material construction).
 */
export function updateTreeWind(timeSeconds) {
  for (let i = 0; i < _uniformSets.length; i++) _uniformSets[i].uTime.value = timeSeconds;
}

/** Test seam: how many tree materials have registered wind uniforms. */
export function _windUniformSetCount() { return _uniformSets.length; }
