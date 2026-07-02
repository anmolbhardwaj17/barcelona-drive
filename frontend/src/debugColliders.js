/**
 * Debug collider visualizer — renders colored wireframes for all physics bodies.
 *
 * Colors:
 *   Cyan      — ground plane (infinite CANNON.Plane)
 *   Orange    — heightfield terrain
 *   Green     — road box colliders (bridge/ramp/tunnel deck segments)
 *   Red       — tunnel wall colliders
 *   Yellow    — car chassis
 *   Magenta   — other / unknown bodies
 *
 * Call updateDebugColliders(scene, world) each frame to keep in sync.
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { getZones } from './tunnelZones.js';

let _group = null;
let _scene = null;
let _frameCount = 0;
let _logged = false;
const REBUILD_INTERVAL = 120; // rebuild wireframes every N frames

const COLORS = {
  plane:       0x00ffff, // cyan
  heightfield: 0xff8800, // orange
  box:         0x00ff00, // green
  vehicle:     0xffff00, // yellow
  other:       0xff00ff, // magenta
};

function classifyBody(body) {
  if (body.mass > 0) return 'vehicle';
  for (const s of body.shapes) {
    if (s.type === CANNON.Shape.types.PLANE) return 'plane';
    if (s.type === CANNON.Shape.types.HEIGHTFIELD) return 'heightfield';
  }
  return 'box'; // static body with box shapes = road/wall colliders
}

function createPlaneMesh(body, color) {
  // Visualize as a large flat quad at the plane's Y position
  const size = 1200;
  const geom = new THREE.PlaneGeometry(size, size, 20, 20);
  const mat = new THREE.MeshBasicMaterial({ color, wireframe: true, depthTest: false, transparent: true, opacity: 0.3 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.renderOrder = 999;
  mesh.frustumCulled = false;
  // CANNON.Plane with -PI/2 X rotation = horizontal at body.position.y
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(body.position.x, body.position.y, body.position.z);
  return mesh;
}

function createHeightfieldMesh(body, color) {
  const shape = body.shapes[0];
  if (!shape || shape.type !== CANNON.Shape.types.HEIGHTFIELD) return null;

  const data = shape.data;
  const es = shape.elementSize;
  const fullX = data.length;
  const fullY = data[0].length;

  // Downsample to max ~32x32 for performance
  const MAX_VIS = 32;
  const stepX = Math.max(1, Math.floor(fullX / MAX_VIS));
  const stepY = Math.max(1, Math.floor(fullY / MAX_VIS));

  const geom = new THREE.BufferGeometry();
  const verts = [];
  const indices = [];
  const cols = [];

  // Sample the grid
  const xSamples = [], ySamples = [];
  for (let xi = 0; xi < fullX; xi += stepX) xSamples.push(xi);
  if (xSamples[xSamples.length - 1] !== fullX - 1) xSamples.push(fullX - 1);
  for (let yi = 0; yi < fullY; yi += stepY) ySamples.push(yi);
  if (ySamples[ySamples.length - 1] !== fullY - 1) ySamples.push(fullY - 1);

  for (const xi of xSamples) {
    for (const yi of ySamples) {
      const h = data[xi][yi];
      verts.push(xi * es, yi * es, h);
      // Color carved cells (h < -0.1) differently
      if (h < -0.1) cols.push(1, 0, 0); // red for carved
      else cols.push(color === 0xff8800 ? 1 : 0, color === 0xff8800 ? 0.53 : 1, 0); // orange
    }
  }

  const w = ySamples.length;
  for (let xi = 0; xi < xSamples.length - 1; xi++) {
    for (let yi = 0; yi < ySamples.length - 1; yi++) {
      const a = xi * w + yi;
      const b = a + 1;
      const c = (xi + 1) * w + yi;
      const d = c + 1;
      indices.push(a, b, c);
      indices.push(b, d, c);
    }
  }

  geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geom.setIndex(indices);

  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true, wireframe: true, depthTest: false,
    transparent: true, opacity: 0.6,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.renderOrder = 999;
  mesh.frustumCulled = false;

  // Apply body transform (position + quaternion)
  mesh.position.set(body.position.x, body.position.y, body.position.z);
  mesh.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);

  return mesh;
}

function createBoxShapeMeshes(body, color) {
  const meshes = [];
  for (let si = 0; si < body.shapes.length; si++) {
    const s = body.shapes[si];
    if (!(s instanceof CANNON.Box)) continue;
    const off = body.shapeOffsets[si];
    const ori = body.shapeOrientations[si];
    const he = s.halfExtents;

    const geom = new THREE.BoxGeometry(he.x * 2, he.y * 2, he.z * 2);
    const mat = new THREE.MeshBasicMaterial({ color, wireframe: true, depthTest: false, transparent: true, opacity: 0.6 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.renderOrder = 999;
    mesh.frustumCulled = false;

    // Shape offset is in body-local space; transform to world
    const worldPos = new CANNON.Vec3();
    const worldQuat = new CANNON.Quaternion();

    // body.quaternion * shapeOffset + body.position
    body.quaternion.vmult(off, worldPos);
    worldPos.vadd(body.position, worldPos);

    // body.quaternion * shapeOrientation
    body.quaternion.mult(ori, worldQuat);

    mesh.position.set(worldPos.x, worldPos.y, worldPos.z);
    mesh.quaternion.set(worldQuat.x, worldQuat.y, worldQuat.z, worldQuat.w);

    meshes.push(mesh);
  }
  return meshes;
}

export function updateDebugColliders(scene, world) {
  if (!world || !scene) return;

  _scene = scene;
  _frameCount++;
  if (_group && _frameCount % REBUILD_INTERVAL !== 0) return;

  // Remove old
  if (_group) {
    scene.remove(_group);
    _group.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
  }

  _group = new THREE.Group();
  _group.name = 'debugColliders';

  if (!_logged) {
    _logged = true;
  }

  for (const body of world.bodies) {
    const type = classifyBody(body);
    const color = COLORS[type] || COLORS.other;

    if (type === 'plane') {
      _group.add(createPlaneMesh(body, color));
      continue;
    }

    if (type === 'heightfield') {
      const mesh = createHeightfieldMesh(body, color);
      if (mesh) _group.add(mesh);
      continue;
    }

    // Box shapes (road colliders, tunnel walls, car chassis, etc.)
    const boxMeshes = createBoxShapeMeshes(body, color);
    for (const m of boxMeshes) _group.add(m);
  }

  // Tunnel trigger zones (blue translucent boxes)
  const zones = getZones();
  for (const z of zones) {
    const w = z.maxX - z.minX;
    const d = z.maxZ - z.minZ;
    const h = 10; // arbitrary height for visibility
    const geom = new THREE.BoxGeometry(w, h, d);
    const mat = new THREE.MeshBasicMaterial({ color: 0x4444ff, wireframe: true, depthTest: false, transparent: true, opacity: 0.3 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.renderOrder = 998;
    mesh.frustumCulled = false;
    mesh.position.set((z.minX + z.maxX) / 2, h / 2 - 5, (z.minZ + z.maxZ) / 2);
    _group.add(mesh);
  }

  scene.add(_group);
}

export function disposeDebugColliders() {
  if (_group && _scene) {
    _scene.remove(_group);
    _group.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
    _group = null;
  }
}
