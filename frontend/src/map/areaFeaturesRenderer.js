/**
 * areaFeaturesRenderer — flat polygon meshes for v7 area features that had no renderer until now:
 * BEACHES (sand) and PEDESTRIAN AREAS (plaza paving). Baked since May 2026, parsed by
 * tileParserWorker (readAreaFeatures), and dropped on the floor — Barceloneta rendered as bare
 * terrain. Mirrors greensRenderer's lifecycle exactly: terrain-following flat ShapeGeometry merged
 * per kind, one material PER TILE (unload disposes geometry+material; programs are shared because
 * the patch source is identical), tracked in entry.greenMeshes so streaming/unload come free.
 *
 * Polygon coords are parser-convention {x, y} world objects (y = world Z) — same frame as greens.
 */
import * as THREE from 'three';
import { applyGroundLayer } from './groundLayers.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { worldToLatLon } from '../projection.js';
import { CONFIG } from '../config.js';
import { patchAoDarkening } from './aoSampler.js';

const AREA_OFFSET_Y = 0.02;   // above greens' 0.01 so shared-edge coast strips don't z-race

// Mid-dark, desaturated bases — the rally grade multiplies saturation ×1.52 and brightens, so
// palettes are tuned BELOW the target on-screen colour (same lesson as the roof palette).
const KINDS = {
  beach: {
    color: 0x9c8f68,          // dry Mediterranean sand (reads warm light sand after the grade)
    noise: 0.06,              // grain amplitude — sand wants visible mottle
    layer: 'beach',
  },
  pedArea: {
    color: 0x77746c,          // warm granite/panot plaza paving (sidewalk-adjacent, a hair warmer)
    noise: 0.03,              // subtle slab variation
    layer: 'pedArea',
  },
};

/** Deterministic value noise (same recipe as roadRenderer.roadNoise — stateless, seam-free). */
function areaNoise(x, z, seed) {
  const n = Math.sin(x * 0.11 + seed) * Math.cos(z * 0.13 + seed * 0.7)
          + Math.sin((x + z) * 0.045 + seed * 1.3) * 0.5;
  return n * 0.5; // ~-0.75..0.75 → scaled by kind.noise
}

/**
 * @param {Array<{ id:number, type:string, polygon:{x:number,y:number}[], isLine?:boolean }>} features
 * @param {'beach'|'pedArea'} kindName
 * @param {(lat:number, lon:number) => number} [getElevationAt]
 * @returns {THREE.Mesh[]} 0 or 1 merged mesh (array for uniform handling with greens)
 */
export function createAreaFeatureMeshes(features, kindName, getElevationAt) {
  const kind = KINDS[kindName];
  if (!kind || !features?.length) return [];

  const vertExag = (CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION))
    ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION : 1;

  const geometries = [];
  for (const f of features) {
    const poly = f.polygon;
    if (f.isLine || !poly || poly.length < 3) continue;

    let cx = 0, cz = 0;
    for (const p of poly) { cx += p.x; cz += p.y; }
    cx /= poly.length; cz /= poly.length;
    const { lat, lon } = worldToLatLon(cx, cz);
    const rawY = getElevationAt ? getElevationAt(lat, lon) : 0;
    const baseY = Number.isFinite(rawY) ? rawY : 0;
    const y = baseY * vertExag + AREA_OFFSET_Y;

    const shape = new THREE.Shape();
    shape.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i].x, poly[i].y);
    shape.closePath();

    const geom = new THREE.ShapeGeometry(shape);
    geom.rotateX(-Math.PI / 2);
    geom.translate(0, y, 0);
    geometries.push(geom);
  }
  if (geometries.length === 0) return [];

  const merged = mergeGeometries(geometries);
  geometries.forEach((g) => g.dispose());
  if (!merged) return [];

  // Per-vertex colour mottle — flat single-colour polygons read as untextured plastic.
  const pos = merged.getAttribute('position');
  const base = new THREE.Color(kind.color);
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const v = 1 + areaNoise(pos.getX(i), pos.getZ(i), kindName === 'beach' ? 5.0 : 9.0) * kind.noise;
    colors[i * 3] = base.r * v;
    colors[i * 3 + 1] = base.g * v;
    colors[i * 3 + 2] = base.b * v;
  }
  merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

  const material = patchAoDarkening(applyGroundLayer(new THREE.MeshLambertMaterial({
    color: 0xffffff,
    vertexColors: true,
  }), kind.layer));

  const mesh = new THREE.Mesh(merged, material);
  mesh.frustumCulled = true;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.userData = { type: 'areaFeature', areaKind: kindName };
  return [mesh];
}
