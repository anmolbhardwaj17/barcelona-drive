/**
 * BMW M3 (G80) car model — loaded from GLB.
 * Physics chassis box: 1.90 × 1.43 × 4.79 m (real metres, honest coordinate system).
 * The GLB is auto-scaled at load so its body length matches M3_TARGET_LENGTH (visual ↔ collider agree).
 * Forward = +Z in physics world (Y-up).
 */
import * as THREE from 'three';
import { makeGLTFLoader } from '../loaders.js';
import { CONFIG } from '../config.js';
import { SKY_HORIZON, SKY_ZENITH } from '../scene.js';
import { audio } from '../audio/audioManager.js';
import { isRallyStyle } from '../rallyStyle.js';
import { wallet } from '../game/wallet.js';

const M3_TARGET_LENGTH = 4.79;  // m — real G80 M3 length; GLB scaled to this so it matches the physics box
// MUST match carPhysics CHASSIS_BOX_OFFSET_Y: the physics CoM/origin sits low and the collision box is
// lifted to body height; the visual body is lifted the same amount so it aligns with the box.
const CHASSIS_BOX_OFFSET_Y = 0.5;

// Load a GLB with a per-attempt timeout + retries. A stalled fetch (the car-model request getting
// starved behind the burst of tile/asset fetches at load — browsers cap ~6 connections/host) would
// otherwise leave loadAsync pending FOREVER, hanging the whole init downstream of it → black screen
// with no error. Racing a timeout turns a stall into a reject we can retry, and ultimately throw so
// the caller's fallback (free camera) runs and the world still renders.
async function loadGLBResilient(loader, url, { tries = 3, timeoutMs = 12000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await Promise.race([
        loader.loadAsync(url),
        new Promise((_, reject) => setTimeout(() => reject(new Error('GLB load timed out')), timeoutMs)),
      ]);
    } catch (e) {
      lastErr = e;
      if (attempt < tries) console.warn(`[CarModel] ${url} attempt ${attempt}/${tries} failed (${e.message}); retrying…`);
    }
  }
  throw lastErr;
}

export async function createCarModel(scene) {
  console.log('[CarModel] Loading BMW M3 GLB...');
  const loader = makeGLTFLoader();
  const gltf = await loadGLBResilient(loader, '/models/bmw_m3.glb');
  const model = gltf.scene;

  // ── Find nodes by name ───────────────────────────────────────────────────
  const wheelNodeNames = ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR'];
  const wheelNodes = {};
  let rearLightMesh = null;
  let dayLightsMesh = null;
  let carPaintMesh = null;

  model.traverse((n) => {
    if (wheelNodeNames.includes(n.name)) wheelNodes[n.name] = n;
    if (n.name === 'Body_RearLight_0' && n.isMesh) rearLightMesh = n;
    if (n.name === 'Body_DayLights_0' && n.isMesh) dayLightsMesh = n;
    if (n.name === 'Body_CarPaint_0' && n.isMesh) carPaintMesh = n;
  });

  // Remove decorative cylinders (brake discs with complex transforms)
  const toRemove = [];
  model.traverse((n) => {
    if (n.name === 'Cylinder' || n.name === 'Cylinder.001') toRemove.push(n);
  });
  for (const n of toRemove) n.parent?.remove(n);

  // Extract wheels from body hierarchy
  for (const name of wheelNodeNames) {
    if (wheelNodes[name]) wheelNodes[name].parent?.remove(wheelNodes[name]);
  }

  // ── BODY: bake world transforms into geometry ───────────────────────────
  model.updateMatrixWorld(true);

  const bodyMeshes = [];
  model.traverse((c) => { if (c.isMesh) bodyMeshes.push(c); });
  for (const mesh of bodyMeshes) {
    mesh.geometry = mesh.geometry.clone();
    mesh.geometry.applyMatrix4(mesh.matrixWorld);
    mesh.position.set(0, 0, 0);
    mesh.quaternion.identity();
    mesh.scale.set(1, 1, 1);
    mesh.updateMatrix();
  }

  // Auto-fit the GLB to real M3 length so the visual matches the physics box (no hardcoded scale).
  // Measure the native body bbox; the longest horizontal axis is the car length → scale to 4.79 m.
  const _nb = new THREE.Box3();
  for (const mesh of bodyMeshes) { mesh.geometry.computeBoundingBox(); if (mesh.geometry.boundingBox) _nb.union(mesh.geometry.boundingBox); }
  const _ns = _nb.getSize(new THREE.Vector3());
  const nativeLength = Math.max(_ns.x, _ns.z);
  const CAR_VISUAL_SCALE = nativeLength > 0.01 ? (M3_TARGET_LENGTH / nativeLength) : 0.75;
  console.log('[CarModel] native body size', _ns.toArray().map((v) => v.toFixed(2)),
    '→ CAR_VISUAL_SCALE', CAR_VISUAL_SCALE.toFixed(3), '(target length', M3_TARGET_LENGTH, 'm)');

  // Upgrade CarPaint to a physical material with a clearcoat — real automotive paint is a metallic base
  // under a glossy clear lacquer, which reads far more "premium" than flat MeshStandard paint.
  let carPaintMat = null;
  if (carPaintMesh) {
    const _src = carPaintMesh.material;
    const _rally = isRallyStyle();
    // Hero paint — punch the base colour's saturation in rally mode so the player car pops as the focal
    // point against the flat-shaded world (art-of-rally cars are vivid, clean-coated).
    const _paint = _src.color ? _src.color.clone() : new THREE.Color(0xff5a2a);
    if (_rally) {
      const _hsl = { h: 0, s: 0, l: 0 };
      _paint.getHSL(_hsl);
      _paint.setHSL(_hsl.h, Math.min(1, _hsl.s * 1.25 + 0.06), Math.min(0.62, _hsl.l * 1.05));
    }
    carPaintMat = new THREE.MeshPhysicalMaterial({
      color: _paint,
      map: _src.map || null,
      normalMap: _src.normalMap || null,
      metalness: _rally ? 0.28 : 0.35, // rally: keep more pure pigment (less sky-mirroring) so the colour reads bold
      roughness: _rally ? 0.30 : 0.36, // slightly cleaner coat → crisper highlight
      clearcoat: _rally ? 0.6 : 0.4,   // stronger clear-lacquer sheen for the hero look
      clearcoatRoughness: 0.2,
    });
    carPaintMesh.material = carPaintMat;
    // Generate a simple gradient env map for reflections (no external HDR needed)
    const _renderer = window._ddRenderer;
    if (!_renderer) console.warn('[CarModel] No renderer for env map');
    const pmremGen = _renderer ? new THREE.PMREMGenerator(_renderer) : null;
    if (pmremGen) {
      const envScene = new THREE.Scene();
      // Background tinted to sky horizon so IBL base matches the world sky
      envScene.background = new THREE.Color(SKY_HORIZON);
      const skyGeo = new THREE.SphereGeometry(100, 16, 8);
      const skyMat = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        uniforms: {
          uHorizon: { value: new THREE.Color(SKY_HORIZON) },
          uZenith:  { value: new THREE.Color(SKY_ZENITH)  },
        },
        vertexShader: `
          varying vec3 vWorldPos;
          void main() {
            vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 uHorizon;
          uniform vec3 uZenith;
          varying vec3 vWorldPos;
          void main() {
            float h = normalize(vWorldPos).y;
            gl_FragColor = vec4(mix(uHorizon, uZenith, smoothstep(-0.2, 0.8, h)), 1.0);
          }
        `,
      });
      const skyMesh = new THREE.Mesh(skyGeo, skyMat);
      envScene.add(skyMesh);
      const envMap = pmremGen.fromScene(envScene, 0, 0.1, 200).texture;
      pmremGen.dispose();
      skyGeo.dispose();
      skyMat.dispose();

      carPaintMat.envMap = envMap;
      carPaintMat.envMapIntensity = 0.5;   // subtle sky reflection — don't wash the paint to white
    }
  }

  // Apply uniform scale
  const scaleMatrix = new THREE.Matrix4().makeScale(CAR_VISUAL_SCALE, CAR_VISUAL_SCALE, CAR_VISUAL_SCALE);
  for (const mesh of bodyMeshes) {
    mesh.geometry.applyMatrix4(scaleMatrix);
    mesh.castShadow = !!CONFIG.ENABLE_SHADOWS;
    mesh.receiveShadow = false;
  }

  // Reparent into flat body group
  const bodyGroup = new THREE.Group();
  for (const mesh of bodyMeshes) {
    mesh.removeFromParent();
    bodyGroup.add(mesh);
  }

  // Center body vertically on chassis origin
  const bbox = new THREE.Box3().setFromObject(bodyGroup);
  const bodyCenter = bbox.getCenter(new THREE.Vector3());
  // Center on origin, then lift to body height so the visual matches the up-shifted collision box
  // (the bodyGroup follows the low CoM origin; the box centre is CHASSIS_BOX_OFFSET_Y above it).
  const yShift = -bodyCenter.y + CHASSIS_BOX_OFFSET_Y;
  for (const mesh of bodyMeshes) {
    mesh.geometry.translate(0, yShift, 0);
  }

  console.log('[CarModel] Body ready, bounds after centering:',
    new THREE.Box3().setFromObject(bodyGroup).min.toArray().map(v => v.toFixed(2)),
    'to', new THREE.Box3().setFromObject(bodyGroup).max.toArray().map(v => v.toFixed(2)));

  // ── LIGHTS: split rear light into L/R, each further split into
  //    main tail section (red) + outer indicator section (orange blinker) ──
  let rearLightL = null, rearLightR = null;
  let indicatorMeshL = null, indicatorMeshR = null;
  if (rearLightMesh && rearLightMesh.geometry) {
    const geo = rearLightMesh.geometry;
    const pos = geo.attributes.position;
    const idx = geo.index;

    // Collect triangles per side with their centroid X for further splitting
    const leftTris = [], rightTris = [];
    const leftCxs = [], rightCxs = [];

    const triCount = idx ? idx.count / 3 : pos.count / 3;
    for (let t = 0; t < triCount; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      const cx = (pos.getX(i0) + pos.getX(i1) + pos.getX(i2)) / 3;
      if (cx < 0) { leftTris.push([i0, i1, i2]); leftCxs.push(cx); }
      else        { rightTris.push([i0, i1, i2]); rightCxs.push(cx); }
    }

    // Split each side: outermost ~30% of triangles become the indicator
    const splitSide = (tris, cxs, outer) => {
      if (tris.length === 0) return { main: null, indicator: null };
      // Sort by |cx| — outer = further from center
      const sorted = tris.map((t, i) => ({ t, cx: cxs[i] }));
      sorted.sort((a, b) => Math.abs(b.cx) - Math.abs(a.cx));
      const splitAt = Math.max(1, Math.floor(sorted.length * 0.30));
      const indicTris = sorted.slice(0, splitAt).flatMap(s => s.t);
      const mainTris = sorted.slice(splitAt).flatMap(s => s.t);

      const makeMesh = (indices, emissiveColor, intensity) => {
        if (indices.length === 0) return null;
        const g = geo.clone();
        g.setIndex(indices);
        const mat = rearLightMesh.material.clone();
        mat.emissive = new THREE.Color(emissiveColor);
        mat.emissiveIntensity = intensity;
        const m = new THREE.Mesh(g, mat);
        m.position.copy(rearLightMesh.position);
        m.quaternion.copy(rearLightMesh.quaternion);
        m.scale.copy(rearLightMesh.scale);
        return m;
      };

      return {
        main: makeMesh(mainTris, 0xFF0000, 0.4),
        indicator: makeMesh(indicTris, 0xFF4400, 0.0),  // off by default
      };
    };

    const leftSplit = splitSide(leftTris, leftCxs, true);
    const rightSplit = splitSide(rightTris, rightCxs, true);

    rearLightL = leftSplit.main;
    rearLightR = rightSplit.main;
    indicatorMeshL = leftSplit.indicator;
    indicatorMeshR = rightSplit.indicator;

    if (rearLightL) bodyGroup.add(rearLightL);
    if (rearLightR) bodyGroup.add(rearLightR);
    if (indicatorMeshL) bodyGroup.add(indicatorMeshL);
    if (indicatorMeshR) bodyGroup.add(indicatorMeshR);
    // Hide original combined mesh
    rearLightMesh.visible = false;
  }

  if (dayLightsMesh && dayLightsMesh.material) {
    dayLightsMesh.material = dayLightsMesh.material.clone();
    dayLightsMesh.material.emissive = new THREE.Color(0xFFFFDD);
    dayLightsMesh.material.emissiveIntensity = 3.0;
  }

  // ── Headlight SpotLights ─────────────────────────────────────────────────
  const _headlightSpots = [];
  const HEADLIGHT_DAY = 6.0, HEADLIGHT_NIGHT = 24.0;  // soft DRL by day, warm beam at night (60 blew out to a total whiteout pool; 24 lights the road without nuking it)
  if (CONFIG.ENABLE_CAR_LIGHTS) {
    const spotTarget = new THREE.Object3D();
    spotTarget.position.set(0, -1, 20);
    bodyGroup.add(spotTarget);
    for (const xPos of [-0.55, 0.55]) {
      // BROAD warm cone (art-of-rally): wide angle (~56°) + long throw + soft edge → lights up the road
      // AND the ground/foliage on both sides with lots of coverage.
      const spot = new THREE.SpotLight(0xFFF0CC, HEADLIGHT_DAY, 520, Math.PI / 3.2, 0.55);
      spot.position.set(xPos, 0.30, 1.75);
      spot.target = spotTarget;
      spot.castShadow = false;
      bodyGroup.add(spot);
      _headlightSpots.push(spot);
    }
  }
  /** Day/night: headlights are a soft DRL by day, a strong beam at night — unless manually overridden. */
  let _isNight = false;
  let _lightsForced = null; // null = auto (follow day/night); true = forced ON; false = forced OFF
  function _applyLights() {
    const on = _lightsForced == null ? _isNight : _lightsForced;
    for (const s of _headlightSpots) s.intensity = on ? HEADLIGHT_NIGHT : HEADLIGHT_DAY;
  }
  function setNight(isNight) { _isNight = isNight; _applyLights(); }
  /** Cycle the headlights: auto -> ON -> OFF -> auto. Returns the new state label. */
  function toggleHeadlights() {
    _lightsForced = _lightsForced == null ? true : (_lightsForced ? false : null);
    _applyLights();
    return _lightsForced == null ? 'auto' : (_lightsForced ? 'on' : 'off');
  }

  scene.add(bodyGroup);

  // ── WHEELS: simple uniform scale, positioned by fixed body-local offsets ──
  const wheelPivots = [];
  const wheelOrder = ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR'];

  for (const name of wheelOrder) {
    const pivot = new THREE.Group();
    const wheelNode = wheelNodes[name];

    if (wheelNode) {
      const meshes = [];
      wheelNode.traverse((child) => { if (child.isMesh) meshes.push(child); });
      for (const child of meshes) {
        const mesh = child.clone();
        mesh.geometry = child.geometry.clone();
        // Rotate -90° X to convert FBX (Y=fwd, Z=up) to world (Y=up, Z=fwd)
        mesh.geometry.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
        mesh.geometry.scale(CAR_VISUAL_SCALE, CAR_VISUAL_SCALE, CAR_VISUAL_SCALE);
        // Re-center the wheel geometry on its pivot. The source tyre mesh is ASYMMETRIC in its
        // thickness axis (POSITION accessor −0.38…0, centroid offset ~0.19 → ~0.18m after scale),
        // which otherwise shifts the tyre laterally off WHEEL_LOCAL and pokes it past the arch.
        mesh.geometry.computeBoundingBox();
        const _wc = mesh.geometry.boundingBox.getCenter(new THREE.Vector3());
        mesh.geometry.translate(-_wc.x, -_wc.y, -_wc.z);
        mesh.position.set(0, 0, 0);
        mesh.quaternion.identity();
        mesh.scale.set(1, 1, 1);
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        pivot.add(mesh);
      }
    }

    scene.add(pivot);
    wheelPivots.push(pivot);
  }

  // ── Blob shadow ─────────────────────────────────────────────────────────
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = 128; shadowCanvas.height = 128;
  const sctx = shadowCanvas.getContext('2d');
  const sg = sctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  sg.addColorStop(0, 'rgba(0,0,0,0.50)');
  sg.addColorStop(0.45, 'rgba(0,0,0,0.42)');
  sg.addColorStop(0.70, 'rgba(0,0,0,0.18)');
  sg.addColorStop(0.90, 'rgba(0,0,0,0.04)');
  sg.addColorStop(1, 'rgba(0,0,0,0)');
  sctx.fillStyle = sg;
  sctx.fillRect(0, 0, 128, 128);
  const shadowTex = new THREE.CanvasTexture(shadowCanvas);
  const carShadowMat = new THREE.MeshBasicMaterial({
    map: shadowTex, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  const carShadowGeo = new THREE.PlaneGeometry(2.2, 4.4);
  carShadowGeo.rotateX(-Math.PI / 2);
  const carShadowMesh = new THREE.Mesh(carShadowGeo, carShadowMat);
  carShadowMesh.renderOrder = -1;
  carShadowMesh.castShadow = false;
  carShadowMesh.receiveShadow = false;
  scene.add(carShadowMesh);

  // ── Effects material refs ───────────────────────────────────────────────
  const defaultTlMat = new THREE.MeshStandardMaterial({ color: 0x880000, emissive: 0xFF0000, emissiveIntensity: 0.3 });
  const fakeTailMeshL = rearLightL || { material: defaultTlMat };
  const fakeTailMeshR = rearLightR || { material: defaultTlMat };

  const hlMat = dayLightsMesh?.material
    || new THREE.MeshStandardMaterial({ color: 0xFFFFDD, emissive: 0xFFFFAA, emissiveIntensity: 1.0 });
  const fakeHeadMeshL = dayLightsMesh || { material: hlMat };
  const fakeHeadMeshR = dayLightsMesh || { material: hlMat };

  // Indicators use the dedicated outer-section meshes
  const indicMatL = indicatorMeshL?.material || defaultTlMat;
  const indicMatR = indicatorMeshR?.material || defaultTlMat;
  // Reverse uses the main tail light materials
  const revMatL = rearLightL?.material || defaultTlMat;
  const revMatR = rearLightR?.material || defaultTlMat;

  // ── Fixed wheel offsets in body-local space — set to the PHYSICS wheel positions
  //    (real M3: track half ±0.81, wheelbase half ±1.43) so visual wheels sit exactly at
  //    the collider's wheels. Only Y (bounce) comes from physics suspension. ──
  const WHEEL_LOCAL = [
    { x: -0.78, z:  1.43 }, // FL  (track half ±0.78 — matches physics TRACK_HALF)
    { x:  0.78, z:  1.43 }, // FR
    { x: -0.78, z: -1.43 }, // RL
    { x:  0.78, z: -1.43 }, // RR
  ];

  // Wheels ride the terrain HEIGHTFIELD, but the visual road slab is drawn
  // ROAD_VISUAL_ABOVE_TERRAIN (~0.05m, more on curved/hill cells) above it, so the
  // tyres look sunk into the asphalt. Lift the whole car (body + wheels + shadow) by
  // this to sit it on the slab, preserving ride height. Keep in sync with
  // roadRenderer.ROAD_VISUAL_ABOVE_TERRAIN. See roadRenderer.js:24 / ADR D-16.
  const CAR_VISUAL_LIFT = 0.06;

  // ── Per-frame sync ──────────────────────────────────────────────────────
  const _chassisQ = new THREE.Quaternion();
  const _rollQ = new THREE.Quaternion();
  const _localForward = new THREE.Vector3();
  const _v = new THREE.Vector3();
  const _wheelSpinQ = new THREE.Quaternion();
  const _X_AXIS = new THREE.Vector3(1, 0, 0);   // constant — hoisted out of the per-frame wheel loop
  let _visualRoll = 0;
  let _wheelSpinAngle = 0;  // cumulative spin angle for visual wheel rotation
  const MAX_ROLL_ANGLE = 0.05;   // subtle body lean — matches stiffer suspension
  const ROLL_LERP_SPEED = 4;

  function update(chassisBody, vehicle, dt, steerValue, speedKmh) {
    // Render at the INTERPOLATED transform, not the raw one. Physics steps at a fixed 60 Hz; the render
    // runs at a different, wobbling rate — reading the raw (stepped) position makes the car micro-stutter
    // against the smoothly-rendered static world, and jump on load hitches. cannon-es fills
    // interpolatedPosition/Quaternion (we use the accumulator step form) for exactly this. Wheels below
    // take X/Z from `p` + a body-local offset (not the raycast world transform), so they follow for free;
    // only wheel Y stays raw for suspension bounce.
    const ip = chassisBody.interpolatedPosition, iq = chassisBody.interpolatedQuaternion;
    const p = (ip && (ip.x !== 0 || ip.y !== 0 || ip.z !== 0)) ? ip : chassisBody.position;
    const q = (iq && (iq.x !== 0 || iq.y !== 0 || iq.z !== 0 || iq.w !== 1)) ? iq : chassisBody.quaternion;

    bodyGroup.position.set(p.x, p.y + CAR_VISUAL_LIFT, p.z);
    bodyGroup.quaternion.set(q.x, q.y, q.z, q.w);

    // Visual body lean
    const spd = Math.abs(speedKmh || 0);
    const steer = steerValue || 0;
    const speedFactor = Math.min(1, spd / 60);
    const targetRoll = steer * speedFactor * MAX_ROLL_ANGLE;
    const frameDt = dt || 0.016;
    _visualRoll += (targetRoll - _visualRoll) * Math.min(1, ROLL_LERP_SPEED * frameDt);
    _localForward.set(0, 0, 1);
    bodyGroup.localToWorld(_localForward).sub(bodyGroup.position).normalize();
    _rollQ.setFromAxisAngle(_localForward, _visualRoll);
    bodyGroup.quaternion.premultiply(_rollQ);

    // Shadow
    carShadowMesh.position.set(p.x, p.y - 0.25 + CAR_VISUAL_LIFT, p.z);
    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
    carShadowMesh.rotation.y = yaw;
    _chassisQ.set(q.x, q.y, q.z, q.w);

    // Compute wheel spin from actual speed (not engine force)
    // This ensures wheels rotate when coasting, braking, or rolling downhill
    const wheelRadius = 0.34;  // m — match physics WHEEL_RADIUS so visual spin rate is correct
    const speedMs = (speedKmh || 0) / 3.6;
    _wheelSpinAngle += (speedMs / wheelRadius) * frameDt;
    // Keep angle in reasonable range to avoid precision loss
    if (_wheelSpinAngle > Math.PI * 200) _wheelSpinAngle -= Math.PI * 200;
    if (_wheelSpinAngle < -Math.PI * 200) _wheelSpinAngle += Math.PI * 200;

    // Wheels: use fixed body-local offsets for X/Z, physics Y for suspension
    for (let i = 0; i < 4; i++) {
      vehicle.updateWheelTransform(i);
      const t = vehicle.wheelInfos[i].worldTransform;
      const wl = WHEEL_LOCAL[i];

      // Transform body-local offset to world space using chassis quaternion
      _v.set(wl.x, 0, wl.z).applyQuaternion(_chassisQ);
      wheelPivots[i].position.set(
        p.x + _v.x,
        t.position.y + CAR_VISUAL_LIFT,  // physics Y for suspension bounce, + slab lift (D-16)
        p.z + _v.z,
      );
      // Start from physics quaternion (has steering angle for front wheels)
      wheelPivots[i].quaternion.set(
        t.quaternion.x, t.quaternion.y, t.quaternion.z, t.quaternion.w,
      );
      // Apply speed-based spin on top of steering
      _wheelSpinQ.setFromAxisAngle(_X_AXIS, _wheelSpinAngle);
      wheelPivots[i].quaternion.multiply(_wheelSpinQ);
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────
  function dispose() {
    scene.remove(bodyGroup);
    scene.remove(carShadowMesh);
    carShadowGeo.dispose(); carShadowMat.dispose(); shadowTex.dispose();
    wheelPivots.forEach((p) => {
      scene.remove(p);
      p.traverse((c) => {
        if (c.isMesh) { c.geometry?.dispose(); const mats = Array.isArray(c.material) ? c.material : [c.material]; mats.forEach(m => m?.dispose()); }
      });
    });
    bodyGroup.traverse((c) => {
      if (c.isMesh) { c.geometry?.dispose(); const mats = Array.isArray(c.material) ? c.material : [c.material]; mats.forEach(m => m?.dispose()); }
    });
  }

  // ── Car color picker UI ──────────────────────────────────────────────────
  function setCarColor(hexColor) {
    if (carPaintMat) {
      carPaintMat.color.set(hexColor);
      try { localStorage.setItem('dd_carColor', hexColor); } catch {}
    }
  }

  // Restore saved car color
  try {
    const saved = localStorage.getItem('dd_carColor');
    if (saved && carPaintMat) carPaintMat.color.set(saved);
  } catch {}

  // Create color picker panel
  const colorPanel = document.createElement('div');
  colorPanel.id = 'dd-car-color-panel';
  colorPanel.style.cssText = 'position:fixed;top:12px;left:12px;z-index:100;display:flex;gap:6px;align-items:center;background:rgba(0,0,0,0.5);padding:6px 10px;border-radius:8px;';
  const colorLabel = document.createElement('span');
  colorLabel.textContent = 'Car';
  colorLabel.style.cssText = 'color:#fff;font:12px sans-serif;';
  colorPanel.appendChild(colorLabel);

  // Colours: first four are free; the rest unlock with taxi earnings (price in $). Owned colours persist.
  const CAR_PRESETS = [
    { hex: '#0a0a0a', name: 'Black',  price: 0 },
    { hex: '#e8e8e8', name: 'White',  price: 0 },
    { hex: '#8c8c8c', name: 'Silver', price: 0 },
    { hex: '#1a3a6a', name: 'Blue',   price: 0 },
    { hex: '#6a1a1a', name: 'Red',    price: 40 },
    { hex: '#1a4a1a', name: 'Green',  price: 70 },
    { hex: '#f0c020', name: 'Yellow', price: 110 },
    { hex: '#f06020', name: 'Orange', price: 150 },
    { hex: '#5a2a8a', name: 'Purple', price: 200 },
    { hex: '#12b0c0', name: 'Cyan',   price: 260 },
    { hex: '#e05aa0', name: 'Pink',   price: 320 },
    { hex: '#d4af37', name: 'Gold',   price: 450 },
  ];
  const _savedColor = (() => { try { return (localStorage.getItem('dd_carColor') || '').toLowerCase(); } catch { return ''; } })();
  if (_savedColor) wallet.own(_savedColor);   // grandfather the player's current colour as owned
  colorPanel.style.position = 'relative';

  // Wallet balance chip
  const balChip = document.createElement('span');
  balChip.title = 'Wallet — earn by driving City Cab fares';
  balChip.style.cssText = 'color:#ffd23f;font:700 12px system-ui,sans-serif;margin:0 2px;white-space:nowrap;';
  const updateBalance = () => { balChip.textContent = `$${wallet.balance()}`; };
  updateBalance();
  colorPanel.appendChild(balChip);

  const isOwned = (p) => p.price === 0 || wallet.isOwned(p.hex);
  const selectColor = (hex, btn) => {
    setCarColor(hex);
    for (const s of colorPanel.querySelectorAll('.dd-swatch')) s.classList.remove('sel');
    btn.classList.add('sel');
  };
  const renderSwatch = (btn, p) => {
    const owned = isOwned(p);
    btn.className = 'dd-swatch' + (p.hex.toLowerCase() === _savedColor && owned ? ' sel' : '');
    btn.title = owned ? p.name : `${p.name} — $${p.price} (locked)`;
    btn.style.cssText = `position:relative;width:20px;height:20px;border-radius:50%;cursor:pointer;border:2px solid rgba(255,255,255,0.4);background:${p.hex};` + (owned ? '' : 'opacity:0.4;');
    btn.innerHTML = owned ? '' : '<span style="position:absolute;inset:-2px;display:flex;align-items:center;justify-content:center;font-size:10px;pointer-events:none">🔒</span>';
  };

  // Buy-confirmation popup — a centered overlay appended to <body> so it works both in-game and inside the
  // ESC menu (which would otherwise hide/clip a panel-child popup).
  const buyPop = document.createElement('div');
  buyPop.id = 'dd-buy-pop';
  buyPop.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:linear-gradient(#26314a,#161d2b);color:#fff;border:2px solid rgba(255,255,255,0.12);border-radius:18px;padding:0 0 20px;box-shadow:0 20px 60px rgba(0,0,0,0.7);display:none;z-index:100000;width:270px;text-align:center;overflow:hidden;';
  buyPop.addEventListener('click', (e) => e.stopPropagation());
  document.body.appendChild(buyPop);
  const closeBuy = () => { buyPop.style.display = 'none'; };
  const openBuy = (p, btn) => {
    const afford = wallet.balance() >= p.price;
    buyPop.innerHTML =
      // Branded header
      `<div style="background:linear-gradient(#ffd23f,#f0b31a);padding:9px 0 8px;position:relative">` +
        `<div style="font:800 13px 'Inter',system-ui;letter-spacing:2px;color:#3a2a00">🚗 BARCELONA DRIVE · GARAGE</div>` +
        `<div class="dd-buy-x" style="position:absolute;top:6px;right:12px;cursor:pointer;font:700 15px system-ui;color:#5a4200">✕</div>` +
      `</div>` +
      `<div style="padding:18px 20px 0;display:flex;flex-direction:column;align-items:center;gap:9px">` +
        `<div style="width:52px;height:52px;border-radius:50%;background:${p.hex};border:3px solid rgba(255,255,255,0.55);box-shadow:0 5px 0 rgba(0,0,0,0.4)"></div>` +
        `<div style="font:800 23px 'Inter',system-ui;letter-spacing:.5px">${p.name.toUpperCase()}</div>` +
        (afford
          ? `<button class="dd-buy" style="margin-top:4px;background:linear-gradient(#5fe790,#2ec46a);color:#08240f;border:none;border-radius:13px;padding:12px 26px;font:800 18px 'Inter',system-ui;letter-spacing:.5px;cursor:pointer;box-shadow:0 5px 0 #1c8f47">UNLOCK &nbsp;🪙 ${p.price}</button>`
          : `<div style="font:800 17px 'Inter',system-ui;color:#ff7d7d">NEED 🪙 ${p.price - wallet.balance()} MORE</div>` +
            `<div style="opacity:.6;font:12px system-ui">Drive City Cab fares to earn</div>`) +
      `</div>`;
    buyPop.style.display = 'block';
    buyPop.querySelector('.dd-buy-x')?.addEventListener('click', (e) => { e.stopPropagation(); closeBuy(); });
    buyPop.querySelector('.dd-buy')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (wallet.spend(p.price)) { wallet.own(p.hex); renderSwatch(btn, p); selectColor(p.hex, btn); closeBuy(); }
    });
  };
  // Close the popup on Escape (also the key that closes the ESC menu → no orphaned popup left behind).
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeBuy(); });

  for (const preset of CAR_PRESETS) {
    const btn = document.createElement('div');
    renderSwatch(btn, preset);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isOwned(preset)) { closeBuy(); selectColor(preset.hex, btn); }
      else openBuy(preset, btn);
    });
    colorPanel.appendChild(btn);
  }
  wallet.onChange(updateBalance);
  document.addEventListener('click', (e) => { if (!buyPop.contains(e.target) && !colorPanel.contains(e.target)) closeBuy(); });

  // Sound toggle button — single source of truth is audioManager (same as the ESC "Sound on" toggle),
  // so the two never desync and dd_soundMuted isn't written twice.
  const soundBtn = document.createElement('div');
  soundBtn.title = 'Toggle engine sound';
  soundBtn.style.cssText = 'cursor:pointer;font-size:16px;margin-left:6px;user-select:none;';
  const _syncSoundIcon = () => { soundBtn.textContent = audio.isMuted() ? '\u{1F507}' : '\u{1F50A}'; };
  _syncSoundIcon();
  soundBtn.addEventListener('click', () => {
    audio.setMuted(!audio.isMuted());   // audioManager persists dd_soundMuted
    _syncSoundIcon();
    if (colorPanel._onSoundToggle) colorPanel._onSoundToggle();
  });
  colorPanel.appendChild(soundBtn);
  document.body.appendChild(colorPanel);

  console.log('[CarModel] BMW M3 ready');
  return {
    update, dispose, setCarColor, setNight, toggleHeadlights,
    taillightMeshL: fakeTailMeshL, taillightMeshR: fakeTailMeshR,
    headlightMeshL: fakeHeadMeshL, headlightMeshR: fakeHeadMeshR,
    indicatorMatL: indicMatL, indicatorMatR: indicMatR,
    reverseMatL: revMatL, reverseMatR: revMatR,
    bodyGroup, wheelPivots,
  };
}
