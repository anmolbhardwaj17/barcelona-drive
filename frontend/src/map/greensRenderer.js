/**
 * Greens renderer (tile v5): flat meshes for green areas (park, garden, forest, grass, etc.).
 * Follows terrain elevation; Y offset 0.05; merge geometry per tile by type; one material per type.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { worldToLatLon } from '../projection.js';
import { CONFIG } from '../config.js';

const GREEN_OFFSET_Y = 0.01;

const TYPE_COLORS = {
  park: 0x33591b,
  garden: 0x3f7020,
  forest: 0x2d5a1a,
  grass: 0x497328,
  playground: 0x568030,
  scrub: 0x3c6421,
  generic_green: 0x3c6421,
};

function getMaterialForType(type) {
  const color = TYPE_COLORS[type] ?? TYPE_COLORS.generic_green;
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.95,
    metalness: 0,
  });
}

/**
 * Centroid of polygon [{x, y}, ...] (world coords; parser delivers {x,y} objects, y = world Z).
 */
function polygonCentroid(polygon) {
  const n = polygon.length;
  if (n === 0) return { x: 0, z: 0 };
  let cx = 0;
  let cz = 0;
  const last = polygon[n - 1];
  const closed = polygon[0].x === last.x && polygon[0].y === last.y;
  const limit = closed ? n - 1 : n;
  for (let i = 0; i < limit; i++) {
    cx += polygon[i].x;
    cz += polygon[i].y;
  }
  cx /= limit;
  cz /= limit;
  return { x: cx, z: cz };
}

/**
 * Create green area meshes: one merged mesh per type, flat on terrain, Y offset 0.05.
 * @param {Array<{ id: number, polygon: {x:number,y:number}[], type: string }>} greens - greens; polygon pts are {x,y} world objects (y = world Z), parser convention
 * @param {(lat: number, lon: number) => number} [getElevationAt]
 * @returns {THREE.Mesh[]}
 */
export function createGreensMeshes(greens, getElevationAt) {
  if (!greens || greens.length === 0) return [];

  const byType = new Map();
  for (const g of greens) {
    const poly = g.polygon || [];
    if (poly.length < 3) continue;
    const type = g.type && TYPE_COLORS[g.type] ? g.type : 'generic_green';
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(g);
  }

  const vertExag =
    CONFIG.ELEVATION_VERTICAL_EXAGGERATION != null && Number.isFinite(CONFIG.ELEVATION_VERTICAL_EXAGGERATION)
      ? CONFIG.ELEVATION_VERTICAL_EXAGGERATION
      : 1;
  const meshes = [];
  for (const [type, list] of byType) {
    const geometries = [];
    for (const area of list) {
      const poly = area.polygon;
      const { x: cx, z: cz } = polygonCentroid(poly);
      const { lat, lon } = worldToLatLon(cx, cz);
      const rawY = getElevationAt ? getElevationAt(lat, lon) : 0;
      const baseY = Number.isFinite(rawY) ? rawY : 0; // guard: getElevationAt returns NaN from G-06 elevation grid cells
      const y = baseY * vertExag + GREEN_OFFSET_Y;

      const shape = new THREE.Shape();
      shape.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i].x, poly[i].y);
      shape.closePath();

      const geom = new THREE.ShapeGeometry(shape);
      geom.rotateX(-Math.PI / 2);
      geom.translate(0, y, 0);
      geometries.push(geom);
    }
    if (geometries.length === 0) continue;
    const merged = mergeGeometries(geometries);
    geometries.forEach((g) => g.dispose());
    const material = getMaterialForType(type);
    const mesh = new THREE.Mesh(merged, material);
    mesh.frustumCulled = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData = { type: 'greens', greenType: type };
    meshes.push(mesh);
  }
  return meshes;
}
