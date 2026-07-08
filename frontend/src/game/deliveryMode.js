/**
 * deliveryMode.js — "Rush Hour" timed parcel delivery.
 *
 * Blue PICK-UP marker → grab the parcel → an ORANGE drop-off with a COUNTDOWN. Deliver before time runs
 * out for a payout that scales with your delivery STREAK and the parcel's INTEGRITY (hard crashes damage
 * it). Miss the deadline or wreck the parcel and the streak resets. Pays into the shared wallet.
 *
 * Frames match the other modes: car pos is the physics frame (lp.lx, lp.lz); road points are WORLD;
 * px=-(wx-ox), pz=wz-oz; the marker lives in `scene` with the traffic.
 */
import * as THREE from 'three';
import { fxFlash, fxConfetti, fxBanner } from './gameFx.js';
import { wallet } from './wallet.js';

const HIT_RADIUS = 15;
const PICKUP_MIN = 90, PICKUP_MAX = 260;
const TRIP_MIN = 160, TRIP_MAX = 480;
const RING_R = 5.0;
const COL_PICK = 0x35b0ff;   // blue depot
const COL_DROP = 0xff8a33;   // orange drop-off
const CRASH_DROP = 26;       // km/h lost in one frame ⇒ a hard hit (damages the parcel)
const SPEED_FACTOR = 13;     // deadline seconds ≈ tripDist / this

export function createDeliveryMode({ scene, getMinimap, getRoadSegments, getGroundY, getOrigin, audio }) {
  let state = 'idle';           // idle | toPickup | toDropoff | ended
  let target = null;
  let streak = 0, best = 0, earned = 0, deliveries = 0;
  let deadline = 0, timeLeft = 0, integrity = 1, tripDist = 0, basePay = 0;
  let lastSpeed = 0, _t = 0, _pending = false;

  const sceneX = (wx) => -(wx - getOrigin().x);
  const sceneZ = (wz) => wz - getOrigin().z;
  const worldFromScene = (px, pz) => ({ wx: getOrigin().x - px, wz: pz + getOrigin().z });
  const streakMult = () => 1 + Math.min(1.5, streak * 0.15);   // up to ×2.5

  // ── marker (ring + road glow + light pillar) ──
  const ringGeo = new THREE.TorusGeometry(RING_R, 0.45, 8, 28);
  const groundRingGeo = new THREE.RingGeometry(RING_R * 0.9, RING_R * 1.25, 32);
  const beamGeo = new THREE.CylinderGeometry(RING_R * 0.55, RING_R * 0.9, 90, 18, 1, true);
  const ringMat = new THREE.MeshBasicMaterial({ color: COL_PICK, transparent: true, opacity: 0.98, fog: false });
  const glowMat = new THREE.MeshBasicMaterial({ color: COL_PICK, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, fog: false });
  const beamMat = new THREE.MeshBasicMaterial({ color: COL_PICK, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const markerGroup = new THREE.Group();
  const ringMesh = new THREE.Mesh(ringGeo, ringMat); ringMesh.position.y = RING_R + 0.4; markerGroup.add(ringMesh);
  const beamMesh = new THREE.Mesh(beamGeo, beamMat); beamMesh.position.y = 45; markerGroup.add(beamMesh);
  const groundGlow = new THREE.Mesh(groundRingGeo, glowMat); groundGlow.rotation.x = -Math.PI / 2; groundGlow.position.y = 0.15; markerGroup.add(groundGlow);
  markerGroup.visible = false;
  scene.add(markerGroup);
  function placeMarker(world, hex) {
    ringMat.color.setHex(hex); glowMat.color.setHex(hex); beamMat.color.setHex(hex);
    const gy = getGroundY ? (getGroundY(world.wx, world.wz) || 0) : 0;
    markerGroup.position.set(sceneX(world.wx), gy, sceneZ(world.wz));
    markerGroup.visible = true;
  }

  // ── HUD (top-left card + big centre countdown) ──
  const hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;top:64px;left:12px;z-index:1000;font:600 13px Poppins,system-ui,sans-serif;color:#fff;background:rgba(0,0,0,0.5);padding:8px 12px;border-radius:10px;display:none;min-width:160px;';
  document.body.appendChild(hud);
  const timerEl = document.createElement('div');
  timerEl.style.cssText = 'position:fixed;top:76px;left:50%;transform:translateX(-50%);z-index:1000;font:800 44px Poppins,system-ui,sans-serif;text-shadow:0 3px 12px rgba(0,0,0,.5);display:none;';
  document.body.appendChild(timerEl);
  const bestKey = 'dd_deliveryBest';
  best = (() => { const v = parseFloat(localStorage.getItem(bestKey)); return Number.isFinite(v) ? v : 0; })();

  function renderHud() {
    const active = state === 'toPickup' || state === 'toDropoff';
    hud.style.display = active || state === 'ended' ? 'block' : 'none';
    timerEl.style.display = state === 'toDropoff' ? 'block' : 'none';
    if (state === 'ended') {
      hud.innerHTML = `<div style="font-size:15px;color:#ff8a33;font-weight:800">📦 Shift over</div>` +
        `<div style="margin-top:3px">${deliveries} deliveries · $${earned}</div>` +
        `<div style="opacity:.8;font-size:12px">best streak ${best}</div>`;
    }
  }
  function updateLiveHud() {
    if (state !== 'toPickup' && state !== 'toDropoff') return;
    const f = Math.round(integrity * 5);
    const bars = '▮'.repeat(f) + '▯'.repeat(5 - f);
    hud.innerHTML =
      `<div style="font-weight:800;color:#ff8a33">📦 RUSH HOUR</div>` +
      `<div style="margin-top:3px">${state === 'toPickup' ? 'Grab the parcel' : 'Deliver!'}</div>` +
      `<div style="margin-top:4px;opacity:.9">🔥 Streak ${streak}${streak > 1 ? ` ×${streakMult().toFixed(1)}` : ''}</div>` +
      (state === 'toDropoff' ? `<div style="opacity:.9">📦 Parcel ${bars}</div>` : '') +
      `<div style="opacity:.75;font-size:12px;margin-top:2px">$${earned}</div>`;
    if (state === 'toDropoff') {
      timerEl.textContent = Math.max(0, timeLeft).toFixed(1);
      timerEl.style.color = timeLeft < 5 ? '#ff5a5a' : '#fff';
    }
  }

  function pickRoad(fromWx, fromWz, minD, maxD) {
    const segs = getRoadSegments ? (getRoadSegments() || []) : [];
    const cand = [];
    for (const s of segs) {
      const pts = s.points || [];
      for (let i = 0; i < pts.length; i += 3) {
        const d = Math.hypot(pts[i].x - fromWx, pts[i].y - fromWz);
        if (d >= minD && d <= maxD) cand.push({ wx: pts[i].x, wz: pts[i].y });
      }
    }
    return cand.length ? cand[(Math.random() * cand.length) | 0] : null;
  }

  function ding(f) {
    try {
      const c = audio?.ctx?.(); if (!c) return;
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.18, c.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.35);
      o.connect(g); g.connect(audio.sfxBus?.() || c.destination); o.start(); o.stop(c.currentTime + 0.37);
    } catch {}
  }

  function start() { _pending = true; state = 'toPickup'; streak = 0; earned = 0; deliveries = 0; renderHud(); }
  function stop() {
    if (deliveries > 0) { state = 'ended'; renderHud(); setTimeout(() => { if (state === 'ended') { state = 'idle'; renderHud(); } }, 8000); }
    else { state = 'idle'; renderHud(); }
    target = null; markerGroup.visible = false; getMinimap?.()?.setObjectiveMarker?.(null);
  }

  function newPickup(carPx, carPz) {
    const w = worldFromScene(carPx, carPz);
    const p = pickRoad(w.wx, w.wz, PICKUP_MIN, PICKUP_MAX) || pickRoad(w.wx, w.wz, 40, 900);
    if (!p) { state = 'idle'; renderHud(); return; }
    target = p; state = 'toPickup'; integrity = 1;
    placeMarker(p, COL_PICK); getMinimap?.()?.setObjectiveMarker?.(p.wx, p.wz); renderHud();
  }

  function failDelivery(carPx, carPz) {
    streak = 0;
    fxBanner('<span style="font-size:30px;color:#ff5a5a">⏱️ TOO LATE!</span>', { duration: 1400, top: '30%' });
    fxFlash('rgba(255,60,60,.2)'); ding(160);
    newPickup(carPx, carPz);
  }

  function update(carPx, carPz, dt, speedKmh) {
    if (state !== 'toPickup' && state !== 'toDropoff') return;
    if (_pending) { _pending = false; newPickup(carPx, carPz); if (state === 'idle') return; }
    _t += dt;
    if (markerGroup.visible) { const s = 1 + Math.sin(_t * 4) * 0.07; ringMesh.scale.set(s, s, s); ringMesh.rotateZ(dt * 1.4); }

    if (state === 'toDropoff') {
      // Parcel damage from hard impacts (a big sudden speed loss = a crash).
      if ((lastSpeed || 0) - (speedKmh || 0) > CRASH_DROP) {
        integrity = Math.max(0.15, integrity - 0.2); ding(200); fxFlash('rgba(255,80,80,.14)');
      }
      timeLeft -= dt;
      if (timeLeft <= 0) { failDelivery(carPx, carPz); lastSpeed = speedKmh || 0; return; }
    }
    lastSpeed = speedKmh || 0;

    if (target) {
      const gx = sceneX(target.wx), gz = sceneZ(target.wz);
      if (Math.hypot(carPx - gx, carPz - gz) < HIT_RADIUS) {
        if (state === 'toPickup') {
          const drop = pickRoad(target.wx, target.wz, TRIP_MIN, TRIP_MAX) || pickRoad(target.wx, target.wz, 60, 900);
          if (drop) {
            tripDist = Math.hypot(drop.wx - target.wx, drop.wz - target.wz);
            deadline = Math.max(10, tripDist / SPEED_FACTOR); timeLeft = deadline;
            basePay = Math.round(5 + tripDist * 0.03); integrity = 1;
            target = drop; state = 'toDropoff'; placeMarker(drop, COL_DROP);
            getMinimap?.()?.setObjectiveMarker?.(drop.wx, drop.wz); ding(680);
            fxBanner('<span style="font-size:30px;color:#35b0ff">📦 PARCEL LOADED — GO!</span>', { duration: 1300, top: '30%' });
          }
        } else {
          // delivered on time
          const payout = Math.round(basePay * streakMult() * integrity);
          earned += payout; deliveries += 1; streak += 1;
          if (streak > best) { best = streak; try { localStorage.setItem(bestKey, String(best)); } catch {} }
          wallet.add(payout);
          const perfect = integrity > 0.95;
          fxBanner(`<div style="font-size:28px;color:#8ef0b0">${perfect ? '✨ PERFECT DELIVERY' : '📦 DELIVERED'}</div>` +
                   `<div style="font-size:46px;color:#ffd23f;margin-top:2px">+$${payout}</div>` +
                   (streak > 1 ? `<div style="font-size:18px;color:#ff8a33">🔥 ${streak} streak ×${streakMult().toFixed(1)}</div>` : ''), { duration: 1700, top: '30%' });
          fxConfetti(perfect ? 34 : 22, ['#ffd23f', '#8ef0b0', '#ffffff'], 0.4);
          fxFlash('rgba(255,210,63,.14)'); ding(880); setTimeout(() => ding(1046), 100);
          newPickup(carPx, carPz);
        }
      }
    }
    updateLiveHud();
  }

  renderHud();
  return {
    name: 'Rush Hour', icon: '📦', key: 'delivery',
    update, start, stop,
    dispose() { stop(); hud.remove(); timerEl.remove(); scene.remove(markerGroup); ringGeo.dispose(); groundRingGeo.dispose(); beamGeo.dispose(); ringMat.dispose(); glowMat.dispose(); beamMat.dispose(); },
    isRunning: () => state === 'toPickup' || state === 'toDropoff',
  };
}
