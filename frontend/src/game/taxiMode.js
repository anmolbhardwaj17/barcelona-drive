/**
 * taxiMode.js — "City Cab" delivery mode.
 *
 * Start Shift → a green PICK-UP marker appears on a nearby road. Reach it to collect the fare, then a
 * gold DROP-OFF marker appears — deliver against a decaying tip for the payout. Fares chain endlessly;
 * total earnings + fares are tracked (best payday saved to localStorage dd_taxiBest). End Shift shows the
 * summary.
 *
 * Same frames/helpers as dashMode: car pos is the physics frame (lp.lx, lp.lz); road points are WORLD;
 * px=-(wx-ox), pz=wz-oz; the marker lives in `scene` with the traffic so it sits on the road.
 */
import * as THREE from 'three';
import { fxFlash, fxConfetti, fxBanner } from './gameFx.js';

const HIT_RADIUS = 16;
const RING_R = 5.0;
const PICKUP_MIN = 120, PICKUP_MAX = 340;   // metres from the car to the next pickup
const TRIP_MIN = 180, TRIP_MAX = 520;       // pickup → dropoff distance range
const COL_PICKUP = 0x2ee06a;   // green
const COL_DROP = 0xffc233;     // gold

export function createTaxiMode({ scene, camera, getMinimap, getRoadSegments, getGroundY, getOrigin, audio }) {
  let state = 'idle';           // idle | toPickup | toDropoff
  let target = null;            // { wx, wz } active objective (world)
  let total = 0, fares = 0;
  let fareBase = 0, tip = 0, tripDist = 0, expectT = 1, fareT = 0;

  // ── coordinate helpers ──────────────────────────────────────────────────
  const sceneX = (wx) => -(wx - getOrigin().x);
  const sceneZ = (wz) => wz - getOrigin().z;
  const worldFromScene = (px, pz) => ({ wx: getOrigin().x - px, wz: pz + getOrigin().z });

  // ── single reusable marker (ring + road glow + light pillar) ────────────
  const ringGeo = new THREE.TorusGeometry(RING_R, 0.45, 8, 28);
  const groundRingGeo = new THREE.RingGeometry(RING_R * 0.9, RING_R * 1.25, 32);
  const beamGeo = new THREE.CylinderGeometry(RING_R * 0.55, RING_R * 0.9, 90, 18, 1, true);
  const ringMat = new THREE.MeshBasicMaterial({ color: COL_PICKUP, transparent: true, opacity: 0.98, fog: false });
  const glowMat = new THREE.MeshBasicMaterial({ color: COL_PICKUP, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, fog: false });
  const beamMat = new THREE.MeshBasicMaterial({ color: COL_PICKUP, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
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

  // Start/Quit is driven by the shared game launcher (main.js).
  const btn = { style: {}, remove() {} };   // harmless stub for the internal label writes

  const hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;top:88px;left:50%;transform:translateX(-50%);z-index:1290;display:none;' +
    'font-family:Poppins,system-ui,sans-serif;color:#fff;text-align:center;pointer-events:none;user-select:none;';
  document.body.appendChild(hud);

  // objective compass pill + on-marker tag
  const nav = document.createElement('div');
  nav.style.cssText = 'position:fixed;top:158px;left:50%;transform:translateX(-50%);z-index:1290;display:none;' +
    'pointer-events:none;user-select:none;text-align:center;background:rgba(8,26,16,.72);border:2px solid #2ee06a;' +
    'border-radius:16px;padding:8px 14px 10px;box-shadow:0 3px 12px rgba(0,0,0,.4)';
  nav.innerHTML =
    '<div class="t-tri" style="width:0;height:0;margin:0 auto 5px;border-left:8px solid transparent;' +
    'border-right:8px solid transparent;border-bottom:30px solid #2ee06a;filter:drop-shadow(0 0 5px #2ee06a);transition:transform .12s"></div>' +
    '<div class="t-lbl" style="font:800 11px Poppins,sans-serif;letter-spacing:1px;color:#bff5d1">PICK UP</div>' +
    '<div class="t-dist" style="font-family:\'Lilita One\',sans-serif;font-size:19px;color:#fff;line-height:1.1">0 m</div>';
  const navTri = nav.querySelector('.t-tri'), navLbl = nav.querySelector('.t-lbl'), navDist = nav.querySelector('.t-dist');
  document.body.appendChild(nav);

  const tag = document.createElement('div');
  tag.style.cssText = 'position:fixed;z-index:1291;display:none;pointer-events:none;user-select:none;transform:translate(-50%,-100%);text-align:center;font-family:Poppins,sans-serif;';
  document.body.appendChild(tag);

  const pop = document.createElement('div');
  pop.style.cssText = 'position:fixed;top:40%;left:50%;transform:translate(-50%,-50%);z-index:1300;display:none;' +
    "pointer-events:none;user-select:none;font-family:'Lilita One',sans-serif;font-size:56px;color:#8ef0b0;text-shadow:0 3px 12px rgba(0,0,0,.6)";
  document.body.appendChild(pop);
  const popStyle = document.createElement('style');
  popStyle.textContent = '@keyframes ddPay{0%{transform:translate(-50%,-40%) scale(.6);opacity:0}20%{transform:translate(-50%,-50%) scale(1.1);opacity:1}100%{transform:translate(-50%,-90%) scale(1);opacity:0}}';
  document.head.appendChild(popStyle);

  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;top:33%;left:50%;transform:translate(-50%,-50%);z-index:1300;display:none;' +
    "font:800 19px Poppins,system-ui,sans-serif;color:#fff;background:rgba(18,58,30,.92);border:2px solid #2ee06a;" +
    'padding:9px 18px;border-radius:14px;box-shadow:0 4px 16px rgba(0,0,0,.5);pointer-events:none;white-space:nowrap;';
  document.body.appendChild(toast);
  let _toastT = null;
  function showToast(msg) { toast.textContent = msg; toast.style.display = 'block'; if (_toastT) clearTimeout(_toastT); _toastT = setTimeout(() => { toast.style.display = 'none'; }, 2200); }

  const bestKey = 'dd_taxiBest';
  const getBest = () => { const v = parseFloat(localStorage.getItem(bestKey)); return Number.isFinite(v) ? v : 0; };

  function renderHud() {
    if (state === 'toPickup' || state === 'toDropoff') {
      const meter = state === 'toDropoff'
        ? `<div style="margin-top:5px;width:150px;height:6px;background:rgba(255,255,255,.2);border-radius:3px;overflow:hidden">
             <div style="height:100%;width:${Math.round(tip / 0.6 * 100)}%;background:#ffd23f"></div></div>
           <div style="font-size:11px;opacity:.8;margin-top:2px">tip +${Math.round(tip * 100)}%</div>`
        : '';
      hud.innerHTML =
        `<div style="font-family:'Lilita One',sans-serif;font-size:32px;color:#8ef0b0;text-shadow:0 2px 6px rgba(0,0,0,.6)">$${total}</div>` +
        `<div style="font-weight:700;font-size:14px;opacity:.9;text-shadow:0 1px 3px rgba(0,0,0,.7)">Fare ${fares + 1} · ${state === 'toPickup' ? 'PICK UP' : 'DROP OFF'}</div>` +
        meter;
      hud.style.display = 'block';
      btn.textContent = '✕ End shift';
    } else if (state === 'ended') {
      hud.innerHTML =
        `<div style="font-family:'Lilita One',sans-serif;font-size:24px;color:#8ef0b0">SHIFT OVER</div>` +
        `<div style="font-family:'Lilita One',sans-serif;font-size:40px;text-shadow:0 2px 6px rgba(0,0,0,.6)">$${total}</div>` +
        `<div style="font-weight:700;font-size:13px;opacity:.9">${fares} fares · best $${getBest()}</div>`;
      hud.style.display = 'block';
      btn.textContent = '🚕 Start Shift';
    } else {
      hud.style.display = 'none';   // idle: keep clear of the dash HUD
      btn.textContent = '🚕 Start Shift';
    }
    const active = state === 'toPickup' || state === 'toDropoff';
    nav.style.display = active ? 'block' : 'none';
    if (!active) tag.style.display = 'none';
  }

  // ── road-point picking ──────────────────────────────────────────────────
  function pickRoad(fromWx, fromWz, minD, maxD) {
    const segs = getRoadSegments ? getRoadSegments() : [];
    const pool = [];
    for (const s of segs) { const pts = s.points || []; for (let i = 0; i < pts.length; i += 2) {
      const d = Math.hypot(pts[i].x - fromWx, pts[i].y - fromWz);
      if (d >= minD && d <= maxD) pool.push({ wx: pts[i].x, wz: pts[i].y });
    } }
    if (!pool.length) {
      // widen once
      for (const s of segs) { const pts = s.points || []; for (let i = 0; i < pts.length; i += 3) {
        const d = Math.hypot(pts[i].x - fromWx, pts[i].y - fromWz);
        if (d >= minD * 0.5 && d <= maxD * 1.6) pool.push({ wx: pts[i].x, wz: pts[i].y });
      } }
    }
    return pool.length ? pool[(Math.random() * pool.length) | 0] : null;
  }

  function ding(f) {
    try { const c = audio?.ctx?.(); if (!c) return; const o = c.createOscillator(), g = c.createGain();
      o.type = 'triangle'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.4, c.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.35);
      o.connect(g); g.connect(audio.master?.() || c.destination); o.start(); o.stop(c.currentTime + 0.37);
    } catch {}
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  let _pending = false;
  function start() { _pending = true; state = 'toPickup'; total = 0; fares = 0; renderHud(); }
  function stop() {
    if (fares > 0 || total > 0) { if (total > getBest()) { try { localStorage.setItem(bestKey, String(total)); } catch {} } state = 'ended'; setTimeout(() => { if (state === 'ended') { state = 'idle'; renderHud(); } }, 9000); }
    else state = 'idle';
    target = null; markerGroup.visible = false; getMinimap?.()?.setObjectiveMarker?.(null); renderHud();
  }

  const _v = new THREE.Vector3(), _camDir = new THREE.Vector3();
  let _t = 0;
  function newPickup(carPx, carPz) {
    const from = worldFromScene(carPx, carPz);
    const p = pickRoad(from.wx, from.wz, PICKUP_MIN, PICKUP_MAX);
    if (!p) { flash('No roads nearby — drive into the city'); state = 'idle'; renderHud(); return; }
    target = p; state = 'toPickup'; placeMarker(p, COL_PICKUP);
    getMinimap?.()?.setObjectiveMarker?.(p.wx, p.wz);
  }
  function updateMarkerUi(carPx, carPz) {
    if (!target) { nav.style.display = 'none'; tag.style.display = 'none'; return; }
    const isPickup = state === 'toPickup';
    const col = isPickup ? '#2ee06a' : '#ffc233';
    nav.style.borderColor = col; navTri.style.borderBottomColor = col; navTri.style.filter = `drop-shadow(0 0 5px ${col})`;
    navLbl.textContent = isPickup ? 'PICK UP' : 'DROP OFF'; navLbl.style.color = isPickup ? '#bff5d1' : '#ffe6a8';
    const gx = sceneX(target.wx), gz = sceneZ(target.wz);
    const dist = Math.hypot(carPx - gx, carPz - gz);
    navDist.textContent = dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist)} m`;
    camera.getWorldDirection(_camDir);
    let rel = Math.atan2(gx - camera.position.x, gz - camera.position.z) - Math.atan2(_camDir.x, _camDir.z);
    while (rel > Math.PI) rel -= 2 * Math.PI; while (rel < -Math.PI) rel += 2 * Math.PI;
    navTri.style.transform = `rotate(${rel}rad)`;
    // on-screen tag
    _v.set(gx, markerGroup.position.y + RING_R + 0.6, gz).project(camera);
    if (Math.abs(rel) < Math.PI / 2 && Math.abs(_v.x) < 0.95 && Math.abs(_v.y) < 0.95) {
      tag.innerHTML = `<div style="display:inline-block;background:${col};color:#062;font-weight:800;font-size:11px;padding:3px 9px;border-radius:9px;box-shadow:0 2px 8px rgba(0,0,0,.45)">${isPickup ? 'PICK UP' : 'DROP OFF'}</div>` +
        `<div style="width:0;height:0;margin:0 auto;border-left:7px solid transparent;border-right:7px solid transparent;border-top:9px solid ${col}"></div>`;
      tag.style.left = `${(_v.x * 0.5 + 0.5) * window.innerWidth}px`; tag.style.top = `${(-_v.y * 0.5 + 0.5) * window.innerHeight}px`;
      tag.style.display = 'block';
    } else tag.style.display = 'none';
  }

  function update(carPx, carPz, dt) {
    if (state !== 'toPickup' && state !== 'toDropoff') return;
    if (_pending) { _pending = false; newPickup(carPx, carPz); if (state === 'idle') return; }

    _t += dt;
    if (markerGroup.visible) { const s = 1 + Math.sin(_t * 4) * 0.07; ringMesh.scale.set(s, s, s); ringMesh.rotateZ(dt * 1.4); }

    if (state === 'toDropoff') { fareT += dt; tip = Math.max(0, 0.6 * (1 - fareT / (expectT * 1.4))); }

    if (target) {
      const gx = sceneX(target.wx), gz = sceneZ(target.wz);
      if (Math.hypot(carPx - gx, carPz - gz) < HIT_RADIUS) {
        if (state === 'toPickup') {
          // got the fare → set dropoff
          const drop = pickRoad(target.wx, target.wz, TRIP_MIN, TRIP_MAX) || pickRoad(target.wx, target.wz, 80, 900);
          if (drop) {
            tripDist = Math.hypot(drop.wx - target.wx, drop.wz - target.wz);
            fareBase = Math.round(3 + tripDist * 0.02);
            expectT = Math.max(6, tripDist / 13); fareT = 0; tip = 0.6;
            target = drop; state = 'toDropoff'; placeMarker(drop, COL_DROP);
            getMinimap?.()?.setObjectiveMarker?.(drop.wx, drop.wz); ding(720);
            fxBanner('<span style="font-size:34px;color:#8ef0b0">🧍 PASSENGER ABOARD</span>', { duration: 1400, top: '32%' });
            fxConfetti(14, ['#2ee06a', '#8ef0b0', '#ffffff'], 0.4);
            fxFlash('rgba(46,224,106,.14)');
          }
        } else {
          // delivered → pay out (celebration)
          const payout = Math.round(fareBase * (1 + tip));
          const gold = tip > 0.45;   // fast delivery = big tip
          total += payout; fares += 1;
          fxBanner(`<div style="font-size:30px;color:#8ef0b0">${gold ? '⭐ FARE COMPLETE!' : '✅ DELIVERED!'}</div>` +
                   `<div style="font-size:50px;color:#ffd23f;margin-top:2px">+$${payout}</div>`, { duration: 1900, top: '32%' });
          fxConfetti(gold ? 40 : 26, undefined, 0.4);
          fxFlash(gold ? 'rgba(255,210,63,.2)' : 'rgba(255,210,63,.13)');
          ding(880); setTimeout(() => ding(1046), 110); if (gold) setTimeout(() => ding(1318), 220);
          newPickup(carPx, carPz);
        }
      }
    }

    updateMarkerUi(carPx, carPz);
    renderHud();
  }

  function flash(msg) {
    hud.innerHTML = `<div style="font-weight:700;font-size:14px;background:rgba(0,0,0,.6);padding:9px 15px;border-radius:10px">${msg}</div>`;
    hud.style.display = 'block'; setTimeout(renderHud, 2600);
  }

  renderHud();
  return {
    name: 'City Cab', icon: '🚕',
    update, start, stop,
    dispose() { stop(); hud.remove(); nav.remove(); tag.remove(); pop.remove(); popStyle.remove(); toast.remove(); scene.remove(markerGroup); ringGeo.dispose(); groundRingGeo.dispose(); beamGeo.dispose(); ringMat.dispose(); glowMat.dispose(); beamMat.dispose(); },
    isRunning: () => state === 'toPickup' || state === 'toDropoff',
  };
}
