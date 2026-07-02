/**
 * Re-export earcut from Three.js's bundled copy.
 * Used by the building worker for roof triangulation.
 * This is the mapbox/earcut v3.0.2 algorithm — MIT licensed, pure JS, no DOM.
 */
export { default } from 'three/src/extras/lib/earcut.js';
