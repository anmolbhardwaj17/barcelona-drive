/**
 * Car visual effects — brake lights, turn indicators, skid marks, tire smoke.
 */
import * as THREE from 'three';
import { CONFIG } from '../config.js';

const SKID_POOL_SIZE = 200;
const SMOKE_POOL_SIZE = 50;

export function createCarEffects(scene, carModel, physics) {
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

  if (CONFIG.ENABLE_SKID_MARKS) {
    const skidGeo = new THREE.PlaneGeometry(0.15, 1.0);
    skidGeo.rotateX(-Math.PI / 2);
    const skidMat = new THREE.MeshBasicMaterial({
      color: 0x111111, transparent: true, opacity: 0.4, depthWrite: false,
    });
    skidMarks = [];
    for (let i = 0; i < SKID_POOL_SIZE; i++) {
      const m = new THREE.Mesh(skidGeo, skidMat);
      m.visible = false;
      m.renderOrder = -1;
      scene.add(m);
      skidMarks.push(m);
    }
  }

  // ── Tire smoke ────────────────────────────────────────────────────────────
  let smokeSprites = null;
  let smokeIndex = 0;
  let smokeTexture = null;

  if (CONFIG.ENABLE_TIRE_SMOKE) {
    // Generate a simple circle texture
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.arc(16, 16, 14, 0, Math.PI * 2);
    ctx.fillStyle = 'white';
    ctx.fill();
    smokeTexture = new THREE.CanvasTexture(canvas);

    smokeSprites = [];
    for (let i = 0; i < SMOKE_POOL_SIZE; i++) {
      const mat = new THREE.SpriteMaterial({
        map: smokeTexture, transparent: true, opacity: 0,
        color: 0xCCCCCC, depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.scale.setScalar(0.5);
      scene.add(sprite);
      smokeSprites.push({
        sprite,
        life: 0,
        maxLife: 0.8,
        vx: 0, vy: 0, vz: 0,
        startOpacity: 0.3,
      });
    }
  }

  // ── Pre-allocated ─────────────────────────────────────────────────────────
  const _euler = new THREE.Euler();
  const _quat = new THREE.Quaternion();

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
    tlMatL.emissiveIntensity = braking ? 8.0 : 0.4;
    tlMatR.emissive.setHex(braking ? 0xFF3333 : 0xFF0000);
    tlMatR.emissiveIntensity = braking ? 8.0 : 0.4;

    // Indicator/reverse sections — outer strip
    // Priority: reverse (white) > indicator (orange blink) > off
    if (reversing) {
      indMatL.emissive.setHex(0xFFFFFF);
      indMatL.emissiveIntensity = 2.5;
      indMatR.emissive.setHex(0xFFFFFF);
      indMatR.emissiveIntensity = 2.5;
    } else {
      indMatL.emissive.setHex(blinkLeft && blinkOn ? 0xFF8800 : 0xFF0000);
      indMatL.emissiveIntensity = blinkLeft && blinkOn ? 8.0 : (braking ? 5.0 : 0.4);
      indMatR.emissive.setHex(blinkRight && blinkOn ? 0xFF8800 : 0xFF0000);
      indMatR.emissiveIntensity = blinkRight && blinkOn ? 8.0 : (braking ? 5.0 : 0.4);
    }

    // Skid marks
    if (skidMarks && driftFactor > 0.3) {
      skidSpawnTimer += dt;
      if (skidSpawnTimer >= 0.05) {
        skidSpawnTimer -= 0.05;
        // Spawn at rear wheel positions (wheels 2 and 3)
        for (const wi of [2, 3]) {
          const hit = physics.vehicle.wheelInfos[wi].raycastResult?.hitPointWorld;
          if (!hit) continue;
          const mark = skidMarks[skidIndex % SKID_POOL_SIZE];
          skidIndex++;
          mark.visible = true;
          // hit.y is the TERRAIN heightfield contact; the visual asphalt floats ~0.11m above it
          // (ROAD_OFFSET + ROAD_VISUAL_ABOVE_TERRAIN). Sit the mark on the asphalt, under the paint (+0.19).
          mark.position.set(hit.x, hit.y + 0.15, hit.z);
          // Orient to chassis heading
          const cq = physics.chassisBody.quaternion;
          _quat.set(cq.x, cq.y, cq.z, cq.w);
          _euler.setFromQuaternion(_quat, 'YXZ');
          mark.rotation.y = _euler.y;
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
        s.startOpacity = 0.3;
        s.vx = (Math.random() - 0.5) * 2;
        s.vy = 1.5 + Math.random();
        s.vz = (Math.random() - 0.5) * 2;
        s.sprite.position.set(hit.x, hit.y + 0.1, hit.z);
        s.sprite.visible = true;
        s.sprite.material.opacity = s.startOpacity;
        s.sprite.scale.setScalar(0.5);
      }
    }

    // Update smoke particles
    if (smokeSprites) {
      for (const s of smokeSprites) {
        if (!s.sprite.visible) continue;
        s.life += dt;
        if (s.life >= s.maxLife) {
          s.sprite.visible = false;
          continue;
        }
        const t = s.life / s.maxLife;
        s.sprite.position.x += s.vx * dt;
        s.sprite.position.y += s.vy * dt;
        s.sprite.position.z += s.vz * dt;
        s.sprite.material.opacity = s.startOpacity * (1 - t);
        s.sprite.scale.setScalar(0.5 + t * 1.5);
      }
    }
  }

  function dispose() {
    if (skidMarks) {
      for (const m of skidMarks) {
        scene.remove(m);
        m.geometry.dispose();
      }
      skidMarks[0]?.material?.dispose();
    }
    if (smokeSprites) {
      for (const s of smokeSprites) {
        scene.remove(s.sprite);
        s.sprite.material.dispose();
      }
      smokeTexture?.dispose();
    }
  }

  return { update, dispose };
}
