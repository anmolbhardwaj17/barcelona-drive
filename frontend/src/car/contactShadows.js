/**
 * Fake contact shadows — a single InstancedMesh of a soft dark disc laid flat on the ground under
 * cars/people. Grounds everything WITHOUT the real shadow-map pass (which tanked FPS with hundreds of
 * shadow-casters). Usage per frame: begin() → add(...) for each entity → commit().
 */
import * as THREE from 'three';

const YAXIS = new THREE.Vector3(0, 1, 0);

function softDiscTexture() {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.6, 'rgba(0,0,0,0.32)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createContactShadows({ scene, capacity = 700 }) {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2); // lie flat
  const mat = new THREE.MeshBasicMaterial({
    map: softDiscTexture(), transparent: true, depthWrite: false, opacity: 0.9,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1; // draw over the road
  mesh.count = 0;
  scene.add(mesh);

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
  let _n = 0;

  return {
    begin() { _n = 0; },
    /** Add a shadow blob at (x,y,z) sized sizeX×sizeZ (m), aligned to yaw. */
    add(x, y, z, sizeX, sizeZ, yaw = 0) {
      if (_n >= capacity) return;
      _q.setFromAxisAngle(YAXIS, yaw);
      _s.set(sizeX, 1, sizeZ);
      _p.set(x, y + 0.03, z);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(_n++, _m);
    },
    commit() { mesh.count = _n; mesh.instanceMatrix.needsUpdate = true; },
    setEnabled(on) { mesh.visible = on; },
    dispose() { scene.remove(mesh); geo.dispose(); mat.dispose(); },
  };
}
