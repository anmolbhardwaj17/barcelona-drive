/**
 * LayerResolver: vertex Y and base layer from OSM tags only. No DEM.
 * Flat world. Used by clean road pipeline and road graph.
 *
 * resolveBaseLayer: baseLayer from layer tag; bridge clamps ≥1, tunnel clamps ≤-1
 * resolveVertexY: delegates to resolveBaseLayer for consistent handling
 */
export const LAYER_STEP = 6;

function getTag(tags, key, def = '') {
  if (!tags) return def;
  const v = tags[key];
  return v != null ? String(v).trim() : def;
}

/**
 * Resolve base layer for graph (bridge/tunnel/layer logic).
 * @param {object} way - { tags, bridge, tunnel, layer }
 * @returns {{ baseLayer: number, baseHeight: number }}
 */
export function resolveBaseLayer(way) {
  let baseLayer = 0;
  const layerTag = getTag(way.tags, 'layer');
  if (layerTag) {
    const parsed = parseInt(layerTag, 10);
    if (Number.isFinite(parsed)) baseLayer += parsed;
  }
  if (way.bridge) baseLayer = Math.max(baseLayer, 1);
  if (way.tunnel) baseLayer = Math.min(baseLayer, -1);
  const baseHeight = baseLayer * LAYER_STEP;
  return { baseLayer, baseHeight };
}

/**
 * Resolve base height for a way (baseLayer * LAYER_STEP).
 * @param {object} way
 * @returns {number}
 */
export function resolveBaseHeight(way) {
  return resolveBaseLayer(way).baseHeight;
}

/**
 * Resolve vertex Y for a way. Returns single value for all vertices (flat way).
 * Uses resolveBaseLayer so bridge/tunnel/layer are handled consistently.
 * @param {object} way - { tags, bridge, tunnel, layer }
 * @returns {number}
 */
export function resolveVertexY(way) {
  return resolveBaseLayer(way).baseHeight;
}
