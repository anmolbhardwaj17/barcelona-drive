/**
 * Free camera controller for world-only mode (no car).
 * OrbitControls: orbit, pan, zoom with mouse. WASD: move camera and target over the ground.
 * main.js converts camera position to (wx, wz) for tileManager.update.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const WASD_SPEED = 120; // units per second (scene space)
const keys = { w: false, s: false, a: false, d: false };
const GAME_KEYS = new Set(['w', 'a', 's', 'd']);

function setupWASD() {
  const onKeyDown = (e) => {
    const k = e.key.toLowerCase();
    if (GAME_KEYS.has(k)) {
      e.preventDefault();
      if (k === 'w') keys.w = true;
      if (k === 's') keys.s = true;
      if (k === 'a') keys.a = true;
      if (k === 'd') keys.d = true;
    }
  };
  const onKeyUp = (e) => {
    const k = e.key.toLowerCase();
    if (GAME_KEYS.has(k)) {
      e.preventDefault();
      if (k === 'w') keys.w = false;
      if (k === 's') keys.s = false;
      if (k === 'a') keys.a = false;
      if (k === 'd') keys.d = false;
    }
  };
  document.addEventListener('keydown', onKeyDown, { capture: true });
  document.addEventListener('keyup', onKeyUp, { capture: true });
  window.addEventListener('blur', () => {
    keys.w = false;
    keys.s = false;
    keys.a = false;
    keys.d = false;
  });
}
setupWASD();

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();

/**
 * Apply WASD movement to camera and orbit target (horizontal plane). Call after controls.update().
 */
function applyWASD(camera, controls, dt) {
  if (!keys.w && !keys.s && !keys.a && !keys.d) return;
  _forward.subVectors(controls.target, camera.position);
  _forward.y = 0;
  if (_forward.lengthSq() < 1e-6) _forward.set(0, 0, 1);
  _forward.normalize();
  _right.set(-_forward.z, 0, _forward.x);
  _move.set(0, 0, 0);
  if (keys.w) _move.add(_forward);
  if (keys.s) _move.sub(_forward);
  if (keys.a) _move.sub(_right);
  if (keys.d) _move.add(_right);
  if (_move.lengthSq() > 0) {
    _move.normalize().multiplyScalar(WASD_SPEED * dt);
    camera.position.add(_move);
    controls.target.add(_move);
  }
}

/**
 * Create OrbitControls and set initial camera pose above spawn in scene coordinates.
 * Use updateFreeCamera(camera, controls, dt) each frame to run OrbitControls + WASD.
 * @param {THREE.PerspectiveCamera} camera
 * @param {HTMLCanvasElement} domElement
 * @param {{ x: number, z: number }} spawnCenter - world (latLonToWorld) spawn
 * @param {{ x: number, z: number }} originOffset - getOriginOffset()
 * @returns {{ controls: OrbitControls, update: (dt: number) => void }}
 */
export function createFreeCameraController(camera, domElement, spawnCenter, originOffset) {
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.screenSpacePanning = true;
  controls.minDistance = 2;
  controls.maxDistance = 4000;
  controls.maxPolarAngle = Math.PI / 2 - 0.05;

  const sceneX = originOffset.x - spawnCenter.x;
  const sceneZ = -originOffset.z + spawnCenter.z;
  const lookAt = new THREE.Vector3(sceneX, 0, sceneZ);
  controls.target.copy(lookAt);
  camera.position.set(sceneX - 80, 120, sceneZ + 80);
  camera.lookAt(lookAt);

  return {
    controls,
    update(dt) {
      controls.update();
      applyWASD(camera, controls, dt);
    },
  };
}

/**
 * Get (wx, wz) for tileManager.update from camera scene position.
 * Same convention as chassisBody: wx = -camera.position.x, wz = camera.position.z (scene coords).
 * @param {THREE.PerspectiveCamera} camera
 * @returns {{ wx: number, wz: number }}
 */
export function getStreamPositionFromCamera(camera) {
  const wx = -camera.position.x;
  const wz = camera.position.z;
  return {
    wx: Number.isFinite(wx) ? wx : 0,
    wz: Number.isFinite(wz) ? wz : 0,
  };
}
