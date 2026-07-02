/**
 * collisionDebug.js — "what is stopping my car?" overlay.
 *
 * Activate with  ?debug=collision  (alias ?debug=walls). OFF by default, zero cost when absent.
 *
 * Unlike debugColliders.js (which only draws Box/Plane/Heightfield), this draws EVERY physics shape
 * within RANGE metres of the car — Box, ConvexPolyhedron (building corner-prisms), Trimesh, Cylinder
 * (tree/pole colliders) and Sphere — as bright depth-test-off wireframes that track the moving car.
 * The ground (Plane) and terrain (Heightfield) are skipped so only the things you can *hit* show up.
 *
 * Wireframes are added to `scene` at physics coords (same frame the bodies live in), matching
 * debugColliders — a body drawn where your car snags is the collider that stopped you.
 *
 * READ-ONLY: never mutates physics/geometry.
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';

let _active = false;
let _group = null;
let _scene = null;
let _frame = 0;
let _hud = null;
const RANGE = 50;            // metres around the car
const REBUILD_INTERVAL = 6;  // rebuild every N frames so it tracks motion + streaming

const COLORS = {
  box:     0x00ff5a, // green  — road/wall/building box colliders
  convex:  0xff2ecb, // magenta— building corner-prisms (ConvexPolyhedron)
  trimesh: 0xff8800, // orange — trimesh colliders
  cylinder:0x00d0ff, // cyan   — tree / pole / bollard cylinders
  sphere:  0xffe000, // yellow — sphere colliders
};

export function initCollisionDebug() {
  try {
    const parts = (new URLSearchParams(window.location.search).get('debug') || '').toLowerCase().split(',');
    _active = parts.includes('collision') || parts.includes('walls');
  } catch { _active = false; }
  if (_active) {
    // eslint-disable-next-line no-console
    console.log('[collisionDebug] ACTIVE (?debug=collision). Wireframes within ' + RANGE +
      'm of the car: green=box, magenta=building prism, orange=trimesh, cyan=cylinder, yellow=sphere.');
    _hud = document.createElement('div');
    _hud.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:9000;font:12px/1.5 monospace;' +
      'color:#fff;background:rgba(0,0,0,0.6);padding:8px 10px;border-radius:6px;pointer-events:none;white-space:pre;';
    document.body.appendChild(_hud);
  }
  return _active;
}

export function isCollisionDebugActive() { return _active; }

const _wpos = new CANNON.Vec3();
const _wquat = new CANNON.Quaternion();

function wireMesh(geom, color) {
  const mat = new THREE.MeshBasicMaterial({ color, wireframe: true, depthTest: false, transparent: true, opacity: 0.85 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.renderOrder = 1002;
  mesh.frustumCulled = false;
  return mesh;
}

function boxGeom(shape) {
  const he = shape.halfExtents;
  return new THREE.BoxGeometry(he.x * 2, he.y * 2, he.z * 2);
}

function convexGeom(shape) {
  // fan-triangulate each convex face; local coords (mesh gets the shape's world transform)
  const v = shape.vertices, faces = shape.faces;
  const pos = [];
  for (const f of faces) {
    for (let i = 1; i < f.length - 1; i++) {
      const a = v[f[0]], b = v[f[i]], c = v[f[i + 1]];
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

function trimeshGeom(shape) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(Array.from(shape.vertices), 3));
  g.setIndex(Array.from(shape.indices));
  return g;
}

function sphereGeom(shape) {
  return new THREE.SphereGeometry(shape.radius, 10, 8);
}

/** Per-frame update. Safe to call unconditionally — early-returns when inactive. */
export function updateCollisionDebug(scene, world) {
  if (!_active || !scene || !world) return;
  _scene = scene;
  _frame++;
  if (_group && _frame % REBUILD_INTERVAL !== 0) return;

  // car centre (the one dynamic body)
  let cx = 0, cz = 0, haveCar = false;
  for (const b of world.bodies) { if (b.mass > 0) { cx = b.position.x; cz = b.position.z; haveCar = true; break; } }

  if (_group) {
    scene.remove(_group);
    _group.traverse((c) => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
  }
  _group = new THREE.Group();
  _group.name = 'collisionDebug';

  const counts = { box: 0, convex: 0, trimesh: 0, cylinder: 0, sphere: 0 };
  const R2 = RANGE * RANGE;

  for (const body of world.bodies) {
    if (body.mass > 0) continue; // skip the car
    for (let si = 0; si < body.shapes.length; si++) {
      const s = body.shapes[si];
      const t = s.type;
      if (t === CANNON.Shape.types.PLANE || t === CANNON.Shape.types.HEIGHTFIELD) continue;

      // shape world transform
      const off = body.shapeOffsets[si];
      const ori = body.shapeOrientations[si];
      body.quaternion.vmult(off, _wpos); _wpos.vadd(body.position, _wpos);
      body.quaternion.mult(ori, _wquat);

      if (haveCar) {
        const dx = _wpos.x - cx, dz = _wpos.z - cz;
        if (dx * dx + dz * dz > R2) continue;
      }

      let geom = null, key = null;
      if (s instanceof CANNON.Box) { geom = boxGeom(s); key = 'box'; }
      else if (s instanceof CANNON.Trimesh) { geom = trimeshGeom(s); key = 'trimesh'; }
      else if (s instanceof CANNON.Sphere) { geom = sphereGeom(s); key = 'sphere'; }
      else if (s instanceof CANNON.Cylinder) { geom = convexGeom(s); key = 'cylinder'; } // Cylinder extends ConvexPolyhedron
      else if (s.vertices && s.faces) { geom = convexGeom(s); key = 'convex'; }
      if (!geom) continue;

      const mesh = wireMesh(geom, COLORS[key]);
      mesh.position.set(_wpos.x, _wpos.y, _wpos.z);
      mesh.quaternion.set(_wquat.x, _wquat.y, _wquat.z, _wquat.w);
      _group.add(mesh);
      counts[key]++;
    }
  }

  scene.add(_group);

  if (_hud) {
    _hud.textContent =
      `COLLISION DEBUG  (≤${RANGE}m)\n` +
      `box      ${counts.box}\n` +
      `prism    ${counts.convex}   (building corners)\n` +
      `trimesh  ${counts.trimesh}\n` +
      `cylinder ${counts.cylinder}\n` +
      `sphere   ${counts.sphere}`;
  }
}

export function disposeCollisionDebug() {
  if (_group && _scene) {
    _scene.remove(_group);
    _group.traverse((c) => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
    _group = null;
  }
  if (_hud) { _hud.remove(); _hud = null; }
}
