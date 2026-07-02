/**
 * Render OSM parking areas: concrete-gray surface polygons + white stall-divider lines.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { worldToLatLon } from '../projection.js';

const PARKING_Y_OFFSET = 0.04;    // above terrain
const STALL_WIDTH = 2.5;          // m per stall
const STALL_DEPTH = 5.0;          // m per stall
const MARKING_Y_ABOVE = 0.02;     // above parking surface
const MARKING_THICKNESS = 0.12;   // m
/** Max nodes for a polygon to be considered "rectangular enough" for stall markings. */
const MAX_NODES_FOR_STALLS = 6;

const parkingMat = new THREE.MeshStandardMaterial({
  color: 0x6b6b6b,   // concrete gray
  roughness: 0.9,
  metalness: 0,
});
const markingMat = new THREE.MeshStandardMaterial({
  color: 0xe8e8e8,
  roughness: 0.8,
});

/** Point-in-polygon (ray casting). poly = [{x,y},...] (y = world Z, parser convention) */
function pointInPoly(px, pz, poly) {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i].x, zi = poly[i].y;
    const xj = poly[j].x, zj = poly[j].y;
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi)
      inside = !inside;
  }
  return inside;
}

/**
 * Build merged parking surface + stall marking meshes for one tile.
 * @param {Array<{id, polygon: {x:number,y:number}[]}>} parkingAreas - polygon pts are {x,y} world objects (y = world Z)
 * @param {((lat: number, lon: number) => number)|null} getElevationAt
 */
export function buildParkingMeshes(parkingAreas, getElevationAt) {
  if (!parkingAreas?.length) return { surfaceMesh: null, markingMesh: null };

  const surfaceGeoms = [];
  const markingGeoms = [];

  for (const area of parkingAreas) {
    const poly = area.polygon; // [{x, y}, ...] (y = world Z)
    if (!poly || poly.length < 3) continue;

    // Centroid elevation: convert world coords to lat/lon like greensRenderer
    const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
    const cz = poly.reduce((s, p) => s + p.y, 0) / poly.length;
    let baseY = 0;
    if (getElevationAt) {
      const { lat, lon } = worldToLatLon(cx, cz);
      baseY = getElevationAt(lat, lon) ?? 0;
    }
    const y = baseY + PARKING_Y_OFFSET;

    // Surface — THREE.Shape → ShapeGeometry (earcut)
    const shape = new THREE.Shape();
    shape.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i].x, poly[i].y);
    shape.closePath();

    const geom = new THREE.ShapeGeometry(shape);
    geom.rotateX(-Math.PI / 2);
    geom.translate(0, y, 0);
    surfaceGeoms.push(geom);

    // Stall markings — only for simple (roughly rectangular) polygons
    // to avoid lines floating outside irregular shapes on the grass.
    const uniqueNodes = poly[0].x === poly[poly.length - 1].x && poly[0].y === poly[poly.length - 1].y
      ? poly.length - 1 : poly.length;
    if (uniqueNodes > MAX_NODES_FOR_STALLS) continue;

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of poly) {
      const px = p.x, pz = p.y; // parser delivers {x,y} objects (y = world Z), NOT [x,z] arrays — G-46
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
    }
    const spanX = maxX - minX;
    const spanZ = maxZ - minZ;
    const lineY = y + MARKING_Y_ABOVE;

    if (spanX >= STALL_WIDTH * 2 && spanZ >= STALL_DEPTH) {
      // Stalls along X — divider lines run in Z direction
      const lineLen = Math.min(spanZ * 0.85, STALL_DEPTH * 1.5);
      for (let lx = minX + STALL_WIDTH; lx < maxX - STALL_WIDTH * 0.5; lx += STALL_WIDTH) {
        const midZ = minZ + spanZ * 0.5;
        if (!pointInPoly(lx, midZ, poly)) continue;
        const g = new THREE.PlaneGeometry(MARKING_THICKNESS, lineLen);
        g.rotateX(-Math.PI / 2);
        g.translate(lx, lineY, midZ);
        markingGeoms.push(g);
      }
    } else if (spanZ >= STALL_WIDTH * 2 && spanX >= STALL_DEPTH) {
      // Stalls along Z — divider lines run in X direction
      const lineLen = Math.min(spanX * 0.85, STALL_DEPTH * 1.5);
      for (let lz = minZ + STALL_WIDTH; lz < maxZ - STALL_WIDTH * 0.5; lz += STALL_WIDTH) {
        const midX = minX + spanX * 0.5;
        if (!pointInPoly(midX, lz, poly)) continue;
        const g = new THREE.PlaneGeometry(lineLen, MARKING_THICKNESS);
        g.rotateX(-Math.PI / 2);
        g.translate(midX, lineY, lz);
        markingGeoms.push(g);
      }
    }
  }

  if (surfaceGeoms.length === 0) return { surfaceMesh: null, markingMesh: null };

  const surfaceMesh = new THREE.Mesh(mergeGeometries(surfaceGeoms), parkingMat);
  surfaceMesh.receiveShadow = true;

  const markingMesh = markingGeoms.length > 0
    ? new THREE.Mesh(mergeGeometries(markingGeoms), markingMat)
    : null;
  if (markingMesh) markingMesh.receiveShadow = true;

  return { surfaceMesh, markingMesh };
}
