/**
 * carShowcase — a small self-contained 3D "turntable" of the player's car for the ESC menu.
 *
 * Own tiny WebGLRenderer + scene + camera (isolated from the game renderer). The car slowly rotates on a
 * 360° turntable; drag to spin it manually (auto-resumes after release). Renders ONLY while the menu is
 * open (start()/stop()), so it costs nothing during play. Art-of-rally lighting: warm key + cool fill.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export function createCarShowcase() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  const canvas = renderer.domElement;
  canvas.style.cssText = 'width:100%;height:100%;display:block;cursor:grab;touch-action:none;';

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);

  // ── Lighting: bright airy art-of-rally key/fill ──
  scene.add(new THREE.AmbientLight(0xdfeaf7, 0.9));
  const key = new THREE.DirectionalLight(0xfff0d0, 2.1); key.position.set(4, 6, 5); scene.add(key);
  const fill = new THREE.DirectionalLight(0xbcd4ff, 0.7); fill.position.set(-5, 3, -4); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.6); rim.position.set(0, 2, -6); scene.add(rim);

  // ── Soft LIGHT glow-platform under the car (a dark shadow would be invisible on the dark menu bg, so we
  //    use a light radial glow that grounds the car and reads as a clean showroom base) ──
  const shadowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(226,235,248,0.42)'); g.addColorStop(0.5, 'rgba(200,214,236,0.18)'); g.addColorStop(1, 'rgba(200,214,236,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(4.2, 2.5).rotateX(-Math.PI / 2), // tight oval footprint right under the car (not full-width)
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }),
  );
  shadow.position.y = 0.01; scene.add(shadow);

  // ── Load the player car ──
  const pivot = new THREE.Group(); scene.add(pivot); // rotate this
  let carCenterY = 0.6;
  new GLTFLoader().load('/models/bmw_m3.glb', (gltf) => {
    const car = gltf.scene;
    car.traverse((c) => {
      if (!c.isMesh) return;
      c.castShadow = false;
      if (c.material && 'metalness' in c.material) { c.material.metalness = 0.35; c.material.roughness = 0.32; }
      // Light-coloured body paint (bright silver-white) for the showroom. Separate GLB instance → doesn't
      // affect the in-game car. Body_CarPaint_0 is the paint mesh (see carModel.js).
      if (c.name === 'Body_CarPaint_0' && c.material && c.material.color) { c.material.color.setHex(0xEDF0F4); if ('clearcoat' in c.material) c.material.clearcoat = 0.6; }
    });
    const bb = new THREE.Box3().setFromObject(car);
    const size = bb.getSize(new THREE.Vector3());
    const s = 2.7 / Math.max(size.x, size.z, 0.001); // fit ~2.7 units — smaller, sits calmly on the side
    car.scale.setScalar(s);
    const bb2 = new THREE.Box3().setFromObject(car);
    const cen = bb2.getCenter(new THREE.Vector3());
    car.position.set(-cen.x, -bb2.min.y, -cen.z); // center X/Z, sit on y=0
    carCenterY = (bb2.max.y - bb2.min.y) * 0.42;
    pivot.add(car);
  }, undefined, (e) => console.warn('[carShowcase] car load failed', e?.message || e));

  const RADIUS = 7.4;
  let angle = Math.PI * 0.75, autoVel = 0.0045, dragging = false, lastX = 0, running = false, w = 1, h = 1;

  function frame() {
    if (!running) return;
    requestAnimationFrame(frame);
    if (!dragging) angle += autoVel;
    pivot.rotation.y = angle;
    // Closer + a small downward tilt so the contact shadow reads and the car looks GROUNDED, not floating.
    camera.position.set(0, carCenterY + 1.05, RADIUS);
    camera.lookAt(0, carCenterY - 0.15, 0);
    renderer.render(scene, camera);
  }

  // drag to spin
  canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; canvas.style.cursor = 'grabbing'; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => { if (!dragging) return; angle -= (e.clientX - lastX) * 0.01; lastX = e.clientX; });
  const endDrag = () => { dragging = false; canvas.style.cursor = 'grab'; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  return {
    element: canvas,
    start() { if (running) return; running = true; frame(); },
    stop() { running = false; },
    setSize(nw, nh) { w = Math.max(1, nw | 0); h = Math.max(1, nh | 0); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); },
    dispose() { running = false; renderer.dispose(); },
  };
}
