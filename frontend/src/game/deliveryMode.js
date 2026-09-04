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
import { fxFlash, fxConfetti, fxEvent } from './gameFx.js';
import { createStatCard, createResultCard } from './hudTheme.js';
import { deliveryBasePay, streakMultiplier } from './economy.js';
import { createObjectiveMarker } from './objectiveMarker.js';
import { createObjectiveNav } from './objectiveNav.js';
import { createObjectiveHud } from './objectiveHud.js';
import { wallet } from './wallet.js';

const HIT_RADIUS = 15;
const PICKUP_MIN = 90, PICKUP_MAX = 260;
const TRIP_MIN = 160, TRIP_MAX = 480;
const RING_R = 5.0;
const COL_PICK_CSS = '#35b0ff';
const COL_DROP_CSS = '#ff8a33';
const COL_PICK = 0x35b0ff;   // blue depot
const COL_DROP = 0xff8a33;   // orange drop-off
const CRASH_DROP = 26;       // km/h lost in one frame ⇒ a hard hit (damages the parcel)
const SPEED_FACTOR = 13;     // deadline seconds ≈ tripDist / this
const STOP_SPEED = 6;        // km/h — slow to a near-stop at the marker to load/drop

export function createDeliveryMode({ scene, camera, getMinimap, getRoadSegments, getGroundY, getOrigin, audio }) {
  let state = 'idle';           // idle | toPickup | toDropoff | ended
  let target = null;
  let streak = 0, best = 0, earned = 0, deliveries = 0;
  let deadline = 0, timeLeft = 0, integrity = 1, tripDist = 0, basePay = 0;
  let lastSpeed = 0, _t = 0, _pending = false, _lastPx = 0, _lastPz = 0, _hintT = 0;

  const sceneX = (wx) => -(wx - getOrigin().x);
  const sceneZ = (wz) => wz - getOrigin().z;
  const worldFromScene = (px, pz) => ({ wx: getOrigin().x - px, wz: pz + getOrigin().z });
  const streakMult = () => streakMultiplier(streak);   // economy.js owns the curve

  // ── objective halo ─────────────────────────────────────────────────────
  // Was a local torus + RingGeometry + additive beam, byte-for-byte the same code as deliveryMode's
  // and a drifted subset of dashMode's. All three are `objectiveMarker.js` now, which also gives
  // this mode a day/night profile and a distance-faded beam it never had.
  const marker = createObjectiveMarker(scene, { radius: RING_R });
  const markerGroup = marker.group;

  function placeMarker(world, hex) {
    const gy = getGroundY ? (getGroundY(world.wx, world.wz) || 0) : 0;
    marker.place(sceneX(world.wx), gy, sceneZ(world.wz), hex);
  }

  // ── HUD (top-left card + big centre countdown + direction arrow) ──
  // ── Cargo card + countdown + result panel ────────────────────────────────────────────────────
  // Was a `rgba(0,0,0,.5)` box with five text rows built from emoji — 📦 RUSH HOUR / 🔥 Streak /
  // 📦 Parcel ▮▮▮▯▯ — plus a bare 44px timer floating on the sky. Shared cards now (hudTheme.js);
  // the parcel's condition is a meter rather than a row of block characters, which is what those
  // ▮▯ glyphs were pretending to be.
  // Right-hand column, stacked under the clock — same corner as City Cab's earnings and Checkpoint
  // Dash's timer, so "how am I doing" is always in one place.
  const card = createStatCard({ label: 'DELIVERY', color: COL_PICK_CSS, rail: true, order: 1 });
  // Top-RIGHT, same corner as Checkpoint Dash's clock — one place for "how long have you got", now
  // that the day/night button has vacated it. A timer under the compass in the middle also sits
  // exactly where the result card lands, which is how the two ended up drawn over each other.
  const timerCard = createStatCard({ label: 'TIME LEFT', color: COL_DROP_CSS, rail: true, order: 0 });
  const result = createResultCard({ color: COL_DROP_CSS });

  // ── objective card + road routing ────────────────────────────────────────────────────────────
  // Was a hand-built pill: a CSS-triangle bearing arrow and a crow-flies distance that climbs while
  // you drive the correct way round a block. Shared card, real route. See objectiveHud/objectiveNav.
  const navHud = createObjectiveHud({ label: 'PICK UP', color: '#35b0ff' });
  const navRoute = createObjectiveNav({ getRoadSegments, getMinimap, color: '#35b0ff' });
  let _nav = null;
  const _v = new THREE.Vector3(), _camSpace = new THREE.Vector3(), _invQ = new THREE.Quaternion();
  function updateNav(carPx, carPz) {
    if (!target || (state !== 'toPickup' && state !== 'toDropoff')) { navHud.show(false); return; }
    const isPick = state === 'toPickup';
    navHud.show(true);
    navHud.setLabel(isPick ? 'PICK UP' : 'DELIVER', isPick ? '#35b0ff' : '#ff8a33');
    navHud.update(_nav, isPick ? 'Parcel waiting' : `Integrity ${Math.round(integrity * 100)}%`);
  }

  const bestKey = 'dd_deliveryBest';
  best = (() => { const v = parseFloat(localStorage.getItem(bestKey)); return Number.isFinite(v) ? v : 0; })();

  function renderHud() {
    const active = state === 'toPickup' || state === 'toDropoff';
    card.show(active);
    timerCard.show(state === 'toDropoff');
    if (active) {
      updateLiveHud();
      result.hide();
    } else if (state === 'ended') {
      result.show({
        kicker: 'Shift over',
        value: `$${earned}`,
        stats: [
          { label: deliveries === 1 ? 'delivery' : 'deliveries', value: String(deliveries) },
          { label: 'best streak', value: String(best) },
        ],
      });
    } else {
      result.hide();
    }
  }
  function updateLiveHud() {
    if (state !== 'toPickup' && state !== 'toDropoff') return;
    const drop = state === 'toDropoff';
    card.setLabel(drop ? 'CARGO' : 'DELIVERY');
    card.setAccent(drop ? COL_DROP_CSS : COL_PICK_CSS);
    card.set(`$${earned}`, streak > 1 ? `${streak} in a row · ×${streakMult().toFixed(1)}` : `${deliveries} completed`);
    // Parcel condition as a real bar. It was `'▮'.repeat(f) + '▯'.repeat(5 - f)` — a meter drawn out
    // of text glyphs, at five levels, in whatever font the OS picked for those code points.
    card.meter(drop ? integrity : null, `${Math.round(integrity * 100)}%`,
               integrity > 0.6 ? '#2ee06a' : integrity > 0.3 ? '#ffd23f' : '#ff5a5a');
    if (drop) {
      timerCard.set(`${Math.max(0, timeLeft).toFixed(1)}s`, timeLeft < 5 ? 'Hurry' : 'Remaining');
      // The whole card goes red under five seconds, not just the digits — at a glance you read the
      // colour long before you read the number.
      timerCard.setAccent(timeLeft < 5 ? '#ff5a5a' : COL_DROP_CSS);
    }
  }


  function renderHud() {
    const active = state === 'toPickup' || state === 'toDropoff';
    card.show(active);
    timerCard.show(state === 'toDropoff');
    if (active) {
      updateLiveHud();
      result.hide();
    } else if (state === 'ended') {
      result.show({
        kicker: 'Shift over',
        value: `$${earned}`,
        stats: [
          { label: deliveries === 1 ? 'delivery' : 'deliveries', value: String(deliveries) },
          { label: 'best streak', value: String(best) },
        ],
      });
    } else {
      result.hide();
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
    cine = null; parcelMesh.visible = false;
    target = null; marker.hide(); navHud.show(false); getMinimap?.()?.setObjectiveMarker?.(null); navRoute.clear(); _nav = null;
  }

  function newPickup(carPx, carPz) {
    const w = worldFromScene(carPx, carPz);
    const p = pickRoad(w.wx, w.wz, PICKUP_MIN, PICKUP_MAX) || pickRoad(w.wx, w.wz, 40, 900);
    if (!p) { state = 'idle'; renderHud(); return; }
    target = p; state = 'toPickup'; integrity = 1;
    placeMarker(p, COL_PICK); getMinimap?.()?.setObjectiveMarker?.(p.wx, p.wz); navRoute.setTarget(p.wx, p.wz); renderHud();
  }

  function failDelivery(carPx, carPz) {
    streak = 0;
    fxEvent({ kicker: 'Out of time', title: 'Parcel lost', sub: 'Streak reset', color: '#ff5a5a', duration: 1700 });
    fxFlash('rgba(255,60,60,.2)'); ding(160);
    newPickup(carPx, carPz);
  }

  // ── Cinematic b-roll for parcel load / drop-off (car freezes, camera orbits, a parcel box lifts/sets) ──
  const parcelGeo = new THREE.BoxGeometry(0.85, 0.72, 0.95);
  const parcelMat = new THREE.MeshLambertMaterial({ color: 0xb98a4e });
  const parcelMesh = new THREE.Mesh(parcelGeo, parcelMat);
  parcelMesh.visible = false; parcelMesh.frustumCulled = false; parcelMesh.castShadow = false;
  scene.add(parcelMesh);
  let cine = null;
  const _camTgt = new THREE.Vector3();

  function startCine(mode, carPx, carPz, headingDeg) {
    const h = (headingDeg || 0) * Math.PI / 180;
    const side = { x: Math.cos(h), z: -Math.sin(h) };
    const w = worldFromScene(carPx, carPz);
    const carGY = getGroundY ? (getGroundY(w.wx, w.wz) || 0) : 0;
    cine = { mode, t: 0, dur: 2.5, carX: carPx, carZ: carPz, carGY,
             dropX: carPx + side.x * 2.4, dropZ: carPz + side.z * 2.4, baseAngle: h + Math.PI * 0.5 };
    state = mode === 'load' ? 'loading' : 'unloading';
    marker.hide(); navHud.show(false); parcelMesh.visible = true;
    fxEvent({ kicker: `Run ${deliveries + 1}`, title: mode === 'load' ? 'Loading' : 'Delivering',
              color: mode === 'load' ? COL_PICK_CSS : COL_DROP_CSS, duration: 1200, top: '26%' });
  }
  function updateCine(dt) {
    const c = cine; c.t += dt;
    const k = Math.min(1, c.t / c.dur);
    if (c.mode === 'load') {   // parcel lifts from the kerb into the car, then hides (loaded)
      parcelMesh.position.set(c.dropX + (c.carX - c.dropX) * k, c.carGY + 0.4 + k * 0.7, c.dropZ + (c.carZ - c.dropZ) * k);
      parcelMesh.rotation.y = k * 3.2;
      parcelMesh.visible = k < 0.88;
    } else {                    // parcel set down at the kerb
      parcelMesh.position.set(c.dropX, c.carGY + 0.36, c.dropZ);
      parcelMesh.rotation.y = 0.3;
    }
    const ang = c.baseAngle + c.t * 0.3;
    camera.position.set(c.carX + Math.sin(ang) * 8, c.carGY + 2.7, c.carZ + Math.cos(ang) * 8);
    _camTgt.set(c.carX + (c.dropX - c.carX) * 0.4, c.carGY + 0.85, c.carZ + (c.dropZ - c.carZ) * 0.4);
    camera.lookAt(_camTgt);
    if (c.t >= c.dur) finishCine();
  }
  function finishCine() {
    const mode = cine.mode; cine = null; parcelMesh.visible = false;
    if (mode === 'load') beginDropoff(); else payoutDelivery();
  }
  function isCinematic() { return state === 'loading' || state === 'unloading'; }
  function hintSlow() { if (_t - _hintT < 2.5) return; _hintT = _t; fxEvent({ title: 'Slow to a stop', color: '#ffd23f', duration: 1000, top: '28%' }); }

  function beginDropoff() {
    const drop = pickRoad(target.wx, target.wz, TRIP_MIN, TRIP_MAX) || pickRoad(target.wx, target.wz, 60, 900);
    if (drop) {
      tripDist = Math.hypot(drop.wx - target.wx, drop.wz - target.wz);
      deadline = Math.max(10, tripDist / SPEED_FACTOR); timeLeft = deadline;
      basePay = deliveryBasePay(tripDist); integrity = 1;
      target = drop; state = 'toDropoff'; placeMarker(drop, COL_DROP);
      getMinimap?.()?.setObjectiveMarker?.(drop.wx, drop.wz); navRoute.setTarget(drop.wx, drop.wz); ding(680);
      fxEvent({ kicker: `Run ${deliveries + 1}`, title: 'Parcel loaded',
                sub: `${Math.round(timeLeft)} s to deliver`, color: COL_PICK_CSS, duration: 1500 });
    } else { state = 'toPickup'; }
    renderHud();
  }
  function payoutDelivery() {
    const payout = Math.round(basePay * streakMult() * integrity);
    earned += payout; deliveries += 1; streak += 1;
    if (streak > best) { best = streak; try { localStorage.setItem(bestKey, String(best)); } catch {} }
    wallet.add(payout);
    const perfect = integrity > 0.95;
    fxEvent({
      kicker: perfect ? 'Perfect delivery' : 'Delivered',
      title: `Run ${deliveries} complete`,
      amount: `+$${payout}`,
      sub: streak > 1 ? `${streak} in a row · ×${streakMult().toFixed(1)}` : `${Math.round(integrity * 100)}% intact`,
      color: COL_DROP_CSS, duration: 1900,
    });
    fxConfetti(perfect ? 34 : 22, ['#ffd23f', '#8ef0b0', '#ffffff'], 0.4);
    fxFlash('rgba(255,210,63,.14)'); ding(880); setTimeout(() => ding(1046), 100);
    renderHud(); newPickup(_lastPx, _lastPz);
  }

  function update(carPx, carPz, dt, speedKmh, headingDeg) {
    _lastPx = carPx; _lastPz = carPz;
    if (state === 'loading' || state === 'unloading') { _t += dt; updateCine(dt); return; }
    if (state !== 'toPickup' && state !== 'toDropoff') return;
    if (_pending) { _pending = false; newPickup(carPx, carPz); if (state === 'idle') return; }
    _t += dt;
    { const w = worldFromScene(carPx, carPz); _nav = navRoute.update(w.wx, w.wz, dt); }

    // The halo breathes and fades its beam by RANGE — the beam is a locator, so it is what tells you
    // the fare is behind that block, and it is in the way of the thing it points at once you arrive.
    marker.update(dt, marker.visible
      ? Math.hypot(carPx - markerGroup.position.x, carPz - markerGroup.position.z) : Infinity);

    if (state === 'toDropoff') {
      if ((lastSpeed || 0) - (speedKmh || 0) > CRASH_DROP) { integrity = Math.max(0.15, integrity - 0.2); ding(200); fxFlash('rgba(255,80,80,.14)'); }
      timeLeft -= dt;
      if (timeLeft <= 0) { failDelivery(carPx, carPz); lastSpeed = speedKmh || 0; return; }
    }
    lastSpeed = speedKmh || 0;

    if (target) {
      const gx = sceneX(target.wx), gz = sceneZ(target.wz);
      if (Math.hypot(carPx - gx, carPz - gz) < HIT_RADIUS) {
        if ((speedKmh || 0) > STOP_SPEED) hintSlow();
        else startCine(state === 'toPickup' ? 'load' : 'unload', carPx, carPz, headingDeg);
      }
    }
    updateLiveHud();
    updateNav(carPx, carPz);
  }

  renderHud();
  return {
    name: 'Rush Hour', icon: '📦', key: 'delivery',
    update, start, stop, isCinematic,
    dispose() { stop(); card.remove(); timerCard.remove(); result.remove(); navHud.remove(); marker.dispose(); scene.remove(parcelMesh); parcelGeo.dispose(); parcelMat.dispose(); },
    isRunning: () => state === 'toPickup' || state === 'toDropoff' || state === 'loading' || state === 'unloading',
  };
}
