/**
 * Car visual effects — brake lights, turn indicators, skid marks, tire smoke.
 */
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { patchMaterial } from '../map/materialRegistry.js';

const SKID_POOL_SIZE = 200;
const SMOKE_POOL_SIZE = 90; // shared by drift smoke + rally speed-dust; bigger so neither starves the other

export function createCarEffects(scene, carModel, physics, camera) {
  // Art-of-rally dust: warm tan puffs kicked up behind the wheels, and dust trailing at speed (not just
  // on drift). The smoke pool is enabled in rally even when CONFIG.ENABLE_TIRE_SMOKE is off.
  const _rally = true;   // v3 P1-09
  const _smokeEnabled = CONFIG.ENABLE_TIRE_SMOKE || _rally;
  // ── Brake lights ──────────────────────────────────────────────────────────
  const tlMatL = carModel.taillightMeshL.material;
  const tlMatR = carModel.taillightMeshR.material;

  // ── Orange indicator materials ──────────────────────────────────────────
  const indMatL = carModel.indicatorMatL;
  const indMatR = carModel.indicatorMatR;

  // ── Reverse light materials ───────────────────────────────────────────
  const revMatL = carModel.reverseMatL;
  const revMatR = carModel.reverseMatR;

  // ── Turn indicator state ──────────────────────────────────────────────────
  let blinkTimer = 0;
  let blinkOn = false;

  // ── Skid marks ────────────────────────────────────────────────────────────
  let skidMarks = null;
  let skidIndex = 0;
  let skidSpawnTimer = 0;

  // ONE InstancedMesh for the whole pool — the old per-mark Mesh pool was up to 200 separate draw calls
  // (the top entry in the draw audit once a few drifts had happened). Same visuals, 1 draw.
  let skidIM = null;
  const _skidM = new THREE.Matrix4();
  if (CONFIG.ENABLE_SKID_MARKS) {
    const skidGeo = new THREE.PlaneGeometry(0.15, 1.0);
    skidGeo.rotateX(-Math.PI / 2);
    const skidMat = new THREE.MeshBasicMaterial({
      color: 0x111111, transparent: true, opacity: 0.4, depthWrite: false,
    });
    skidIM = new THREE.InstancedMesh(skidGeo, skidMat, SKID_POOL_SIZE);
    skidIM.count = 0;
    skidIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    skidIM.frustumCulled = false;   // marks trail far behind the camera target; skip stale-bounds culling
    skidIM.renderOrder = -1;
    scene.add(skidIM);
    skidMarks = skidIM;             // truthy flag for the update path below
  }

  // ── Tire smoke ────────────────────────────────────────────────────────────
  //
  // v3 P4-15a: was 90 THREE.Sprites, each with its OWN SpriteMaterial, all permanently in the scene
  // graph — 90 draw calls once a drift started, 90 children walked by projectObject on EVERY frame
  // whether or not a single puff was alive, and 90 materials to recolour on a day/night flip.
  //
  // Now: ONE InstancedMesh. A Sprite is a screen-aligned quad, so the billboard is just the camera's
  // world quaternion, computed ONCE per frame and shared by every puff. Per-puff opacity is the one
  // thing an InstancedMesh has no slot for, so it rides a custom instanced attribute (see the shader
  // patch below) rather than forcing 90 materials back.
  let smokePool = null;         // { im, alpha, alive } — null when smoke is disabled
  let smokeSprites = null;      // per-puff simulation state (position/velocity/life), pool-indexed
  let smokeIndex = 0;
  let smokeTexture = null;
  // True while the pool has anything to publish: something is alive, or something spawned this
  // frame. Cleared when the last puff dies (after one final upload, so the pool actually clears).
  // Without it the 90-slot walk ran every frame of every drive to write 90 zero-scale matrices.
  let smokeDirty = false;

  if (_smokeEnabled) {
    // Soft radial puff texture (bright centre → transparent edge) so puffs read as billowing dust, not discs.
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.65)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, 32);
    smokeTexture = new THREE.CanvasTexture(canvas);

    // Rally kicks up warm tan dust; the default look keeps neutral grey tyre smoke. At night the dust
    // catches far less light, so it should read much darker (setNight swaps to _puffNight).
    const puffColor = _rally ? 0xCFBB9C : 0xCCCCCC;
    const smokeMat = new THREE.MeshBasicMaterial({
      map: smokeTexture, color: puffColor, transparent: true, depthWrite: false, fog: true,
    });
    // Per-instance alpha. `opacity` is a uniform, so without this every puff in the pool would fade
    // in lockstep — the one property that makes a particle read as a particle. Goes through
    // patchMaterial (never a bare onBeforeCompile assignment, H9) so it carries a program cache key
    // and declares that the injected GLSL only compiles on an InstancedMesh.
    patchMaterial(smokeMat, (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aOpacity;\nvarying float vOpacity;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvOpacity = aOpacity;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vOpacity;')
        .replace('vec4 diffuseColor = vec4( diffuse, opacity );',
                 'vec4 diffuseColor = vec4( diffuse, opacity * vOpacity );');
    }, 'carSmokeAlpha', { requires: 'instancing' });

    const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), smokeMat, SMOKE_POOL_SIZE);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;   // puffs trail behind the car, outside its bounds
    im.castShadow = false;
    im.count = 0;
    const alpha = new THREE.InstancedBufferAttribute(new Float32Array(SMOKE_POOL_SIZE), 1);
    alpha.setUsage(THREE.DynamicDrawUsage);
    im.geometry.setAttribute('aOpacity', alpha);
    scene.add(im);
    smokePool = { im, alpha };

    smokeSprites = [];
    for (let i = 0; i < SMOKE_POOL_SIZE; i++) {
      smokeSprites.push({
        visible: false,
        x: 0, y: 0, z: 0,
        scale: 0.5,
        opacity: 0,
        life: 0,
        maxLife: 0.8,
        vx: 0, vy: 0, vz: 0,
        startOpacity: 0.3,
      });
    }
  }

  // Billboard scratch — the camera quaternion is the SAME for every puff, so it is read once a frame.
  const _puffQ = new THREE.Quaternion();
  const _puffP = new THREE.Vector3();
  const _puffS = new THREE.Vector3();
  const _puffM = new THREE.Matrix4();

  // ── Pre-allocated ─────────────────────────────────────────────────────────
  const _euler = new THREE.Euler();
  const _quat = new THREE.Quaternion();
  let dustTimer = 0;

  function update(dt, controlState) {
    const braking = physics.isBraking();
    // Skid level covers real sideways slide + hard braking, not just handbrake — so marks appear on
    // hard turns and braking again (regressed when steering-drift was reduced for stability).
    const driftFactor = physics.getSkidLevel ? physics.getSkidLevel() : physics.getDriftFactor();
    const steer = controlState.steer;

    // Turn indicators — blink when steering hard
    let blinkLeft = false;
    let blinkRight = false;
    if (Math.abs(steer) > 0.6) {
      blinkTimer += dt;
      if (blinkTimer >= 0.35) {
        blinkTimer -= 0.35;
        blinkOn = !blinkOn;
      }
      if (steer < -0.6) blinkLeft = true;
      if (steer > 0.6) blinkRight = true;
    } else {
      blinkTimer = 0;
      blinkOn = false;
    }

    const reversing = physics.isReversing();

    // Main tail lights — use bright pinkish-red so luminance exceeds bloom threshold
    tlMatL.emissive.setHex(braking ? 0xFF3333 : 0xFF0000);
    tlMatL.emissiveIntensity = braking ? 3.6 : 0.4;   // 8.0 bloomed into a bright red pool at night
    tlMatR.emissive.setHex(braking ? 0xFF3333 : 0xFF0000);
    tlMatR.emissiveIntensity = braking ? 3.6 : 0.4;

    // Indicator/reverse sections — outer strip
    // Priority: reverse (white) > indicator (orange blink) > off
    if (reversing) {
      indMatL.emissive.setHex(0xFFFFFF);
      indMatL.emissiveIntensity = 2.5;
      indMatR.emissive.setHex(0xFFFFFF);
      indMatR.emissiveIntensity = 2.5;
    } else {
      indMatL.emissive.setHex(blinkLeft && blinkOn ? 0xFF8800 : 0xFF0000);
      indMatL.emissiveIntensity = blinkLeft && blinkOn ? 6.0 : (braking ? 3.0 : 0.4);
      indMatR.emissive.setHex(blinkRight && blinkOn ? 0xFF8800 : 0xFF0000);
      indMatR.emissiveIntensity = blinkRight && blinkOn ? 6.0 : (braking ? 3.0 : 0.4);
    }

    // Skid marks
    if (skidMarks && driftFactor > 0.3) {
      skidSpawnTimer += dt;
      if (skidSpawnTimer >= 0.05) {
        skidSpawnTimer -= 0.05;
        // Spawn at rear wheel positions (wheels 2 and 3) — write an instance matrix into the pool.
        for (const wi of [2, 3]) {
          const hit = physics.vehicle.wheelInfos[wi].raycastResult?.hitPointWorld;
          if (!hit) continue;
          const idx = skidIndex % SKID_POOL_SIZE;
          skidIndex++;
          // Orient to chassis heading
          const cq = physics.chassisBody.quaternion;
          _quat.set(cq.x, cq.y, cq.z, cq.w);
          _euler.setFromQuaternion(_quat, 'YXZ');
          _skidM.makeRotationY(_euler.y);
          // hit.y is the TERRAIN heightfield contact; the visual asphalt floats ~0.11m above it
          // (ROAD_OFFSET + ROAD_VISUAL_ABOVE_TERRAIN). Sit the mark on the asphalt, under the paint (+0.19).
          _skidM.setPosition(hit.x, hit.y + 0.15, hit.z);
          skidIM.setMatrixAt(idx, _skidM);
          skidIM.count = Math.min(SKID_POOL_SIZE, skidIndex);
          skidIM.instanceMatrix.needsUpdate = true;
        }
      }
    } else {
      skidSpawnTimer = 0;
    }

    // Tire smoke
    if (smokeSprites && driftFactor > 0.5) {
      for (const wi of [2, 3]) {
        const hit = physics.vehicle.wheelInfos[wi].raycastResult?.hitPointWorld;
        if (!hit) continue;
        const s = smokeSprites[smokeIndex % SMOKE_POOL_SIZE];
        smokeIndex++;
        s.life = 0;
        s.maxLife = 0.8;
        s.startOpacity = 0.3;
        s.vx = (Math.random() - 0.5) * 2;
        s.vy = 1.5 + Math.random();
        s.vz = (Math.random() - 0.5) * 2;
        s.x = hit.x; s.y = hit.y + 0.1; s.z = hit.z;
        s.visible = true;
        s.opacity = s.startOpacity;
        s.scale = 0.5;
        smokeDirty = true;
      }
    }

    // Rally speed-dust — light warm dust kicked up behind the rear wheels while driving fast, even with
    // no drift. Reads as motion, not a dust storm: low opacity that scales with speed, short-lived, and
    // flung BACKWARD (opposite travel) + slightly out. Skipped when reversing or on the drift smoke above.
    if (_rally && smokeSprites && driftFactor <= 0.5 && !reversing) {
      const vel = physics.chassisBody.velocity;
      const spd = Math.hypot(vel.x, vel.z); // m/s
      if (spd > 12) { // ~43 km/h
        dustTimer += dt;
        if (dustTimer >= 0.045) {
          dustTimer -= 0.045;
          const inv = 1 / (spd || 1);
          const bx = -vel.x * inv, bz = -vel.z * inv; // unit vector opposite travel
          const op = Math.min(0.16, 0.05 + (spd - 12) * 0.006); // fade in with speed, capped subtle
          for (const wi of [2, 3]) {
            const hit = physics.vehicle.wheelInfos[wi].raycastResult?.hitPointWorld;
            if (!hit) continue;
            const s = smokeSprites[smokeIndex % SMOKE_POOL_SIZE];
            smokeIndex++;
            s.life = 0;
            s.maxLife = 0.55;
            s.startOpacity = op;
            s.vx = bx * (2.5 + Math.random() * 1.5) + (Math.random() - 0.5);
            s.vy = 0.5 + Math.random() * 0.5; // low rise — hugs the ground
            s.vz = bz * (2.5 + Math.random() * 1.5) + (Math.random() - 0.5);
            s.x = hit.x; s.y = hit.y + 0.06; s.z = hit.z;
            s.visible = true;
            s.opacity = op;
            s.scale = 0.4;
            smokeDirty = true;
          }
        }
      } else {
        dustTimer = 0;
      }
    }

    // Update smoke particles, then publish the whole pool in one pass.
    //
    // Every live puff is written into the SAME instance slot it occupies in `smokeSprites`, so a
    // puff dying in the middle of the pool leaves a hole. Holes are collapsed to a zero-scale
    // matrix rather than compacted: compaction would reorder the ring buffer that smokeIndex walks.
    //
    // The `smokeDirty` guard skips the whole walk when nothing is alive and nothing spawned — which
    // is every frame you are neither drifting nor above ~43 km/h, i.e. most of a drive.
    if (smokePool && smokeDirty) {
      let anyAlive = false;
      // One billboard rotation for all of them — a Sprite is screen-aligned, and so is this.
      if (camera) camera.getWorldQuaternion(_puffQ);
      for (let i = 0; i < SMOKE_POOL_SIZE; i++) {
        const s = smokeSprites[i];
        if (s.visible) {
          s.life += dt;
          if (s.life >= s.maxLife) {
            s.visible = false;
          } else {
            const t = s.life / s.maxLife;
            s.x += s.vx * dt;
            s.y += s.vy * dt;
            s.z += s.vz * dt;
            s.opacity = s.startOpacity * (1 - t);
            s.scale = 0.5 + t * 1.5;
            anyAlive = true;
          }
        }
        const sc = s.visible ? s.scale : 0;
        _puffP.set(s.x, s.y, s.z);
        _puffS.set(sc, sc, sc);
        _puffM.compose(_puffP, _puffQ, _puffS);
        smokePool.im.setMatrixAt(i, _puffM);
        smokePool.alpha.array[i] = s.visible ? s.opacity : 0;
      }
      smokePool.im.count = anyAlive ? SMOKE_POOL_SIZE : 0;
      smokePool.im.instanceMatrix.needsUpdate = true;
      smokePool.alpha.needsUpdate = true;
      smokeDirty = anyAlive;   // the last frame's upload above is what clears the pool
    }
  }

  function dispose() {
    if (skidIM) {
      scene.remove(skidIM);
      skidIM.geometry.dispose();
      skidIM.material.dispose();
      skidIM.dispose();
    }
    if (smokePool) {
      scene.remove(smokePool.im);
      smokePool.im.geometry.dispose();
      smokePool.im.material.dispose();
      smokePool.im.dispose();
      smokeTexture?.dispose();
    }
  }

  // Day/night dust colour. Night dust is much darker (keeps the warm hue but low value) so it doesn't
  // glow lightly against the deep-blue night — matches how little light kicked-up dust catches at night.
  const _puffDay = new THREE.Color(_rally ? 0xCFBB9C : 0xCCCCCC);
  const _puffNight = new THREE.Color(_rally ? 0x4A4235 : 0x565656);
  function setNight(isNight) {
    if (!smokePool) return;
    // One material now, not ninety.
    smokePool.im.material.color.copy(isNight ? _puffNight : _puffDay);
  }

  return { update, dispose, setNight };
}
