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
import { fxFlash, fxConfetti, fxEvent } from './gameFx.js';
import { createStatCard, createResultCard } from './hudTheme.js';
import { taxiFare } from './economy.js';
import { createObjectiveMarker } from './objectiveMarker.js';
import { createObjectiveNav } from './objectiveNav.js';
import { createObjectiveHud } from './objectiveHud.js';
import { loadPeopleWalkTemplates } from '../car/carModels.js';
import { wallet } from './wallet.js';

const HIT_RADIUS = 16;
const STOP_SPEED = 6;                 // km/h — must be near-stopped at the marker to board/alight
const BOARD_DUR = 2.9, ALIGHT_DUR = 2.9;   // cinematic length (s)
const RING_R = 5.0;
const PICKUP_MIN = 120, PICKUP_MAX = 340;   // metres from the car to the next pickup
const TRIP_MIN = 180, TRIP_MAX = 520;       // pickup → dropoff distance range
const COL_PICKUP = 0x2ee06a;   // green
const COL_DROP = 0xffc233;     // gold
// CSS twins of the two marker colours. Named here rather than repeated as hex strings through the
// HUD, so the card, the banner and the halo cannot drift apart.
const COL_PICKUP_CSS = '#2ee06a';
const COL_DROP_CSS = '#ffc233';

export function createTaxiMode({ scene, camera, getMinimap, getRoadSegments, getGroundY, getOrigin, audio }) {
  let state = 'idle';           // idle | toPickup | toDropoff
  let target = null;            // { wx, wz } active objective (world)
  let total = 0, fares = 0;
  let fareBase = 0, tip = 0, tripDist = 0, expectT = 1, fareT = 0;

  // ── coordinate helpers ──────────────────────────────────────────────────
  const sceneX = (wx) => -(wx - getOrigin().x);
  const sceneZ = (wz) => wz - getOrigin().z;
  const worldFromScene = (px, pz) => ({ wx: getOrigin().x - px, wz: pz + getOrigin().z });

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

  // ── Passenger character (walks to/from the car during the pickup / drop-off cinematics) ───────────────
  //    One standalone walking mesh; geometry is swapped through the walk-cycle frames each update.
  let _pax = null;   // { tpl, mesh, FRAMES, phase }
  loadPeopleWalkTemplates().then((tpls) => {
    if (!tpls || !tpls.length) return;
    const tpl = tpls[(Math.random() * tpls.length) | 0];
    const mesh = new THREE.Mesh(tpl.frames[0], tpl.material);
    mesh.visible = false; mesh.frustumCulled = false; mesh.castShadow = false;
    scene.add(mesh);
    _pax = { tpl, mesh, FRAMES: tpl.frames.length, phase: 0 };
  }).catch(() => {});

  let cine = null;                 // active cinematic descriptor, or null
  let _lastPx = 0, _lastPz = 0;    // last known car scene pos (for newPickup after alighting)
  const _camTgt = new THREE.Vector3();

  // Begin the pickup ('board') or drop-off ('alight') cinematic: car is stopped, a passenger walks
  // curb↔door while the camera does a slow orbit b-roll.
  function startCinematic(mode, carPx, carPz, headingDeg) {
    const h = (headingDeg || 0) * Math.PI / 180;
    const side = { x: Math.cos(h), z: -Math.sin(h) };   // perpendicular to car heading (a "door" side)
    const fwd  = { x: Math.sin(h), z: Math.cos(h) };
    const w = worldFromScene(carPx, carPz);
    const carGY = getGroundY ? (getGroundY(w.wx, w.wz) || 0) : 0;
    cine = {
      mode, t: 0, dur: mode === 'board' ? BOARD_DUR : ALIGHT_DUR,
      carX: carPx, carZ: carPz, carGY,
      doorX: carPx + side.x * 2.0,               doorZ: carPz + side.z * 2.0,
      curbX: carPx + side.x * 6.5 + fwd.x * 0.6, curbZ: carPz + side.z * 6.5 + fwd.z * 0.6,
      baseAngle: h + Math.PI * 0.55,             // camera starts off to the side
    };
    state = mode === 'board' ? 'boarding' : 'alighting';
    marker.hide();
    if (_pax) { _pax.mesh.visible = true; _pax.phase = 0; }
    fxEvent({
      kicker: `Fare ${fares + 1}`,
      title: mode === 'board' ? 'Picking up' : 'Dropping off',
      color: mode === 'board' ? COL_PICKUP_CSS : COL_DROP_CSS,
      duration: 1200, top: '26%',
    });
  }

  function updateCinematic(dt) {
    const c = cine; c.t += dt;
    // Passenger walk (curb→door for board, door→curb for alight), over the middle of the cinematic.
    if (_pax) {
      const a = c.mode === 'board' ? { x: c.curbX, z: c.curbZ } : { x: c.doorX, z: c.doorZ };
      const b = c.mode === 'board' ? { x: c.doorX, z: c.doorZ } : { x: c.curbX, z: c.curbZ };
      const wk = Math.min(1, Math.max(0, (c.t - 0.3) / (c.dur - 0.7)));
      const hide = c.mode === 'board' ? wk >= 0.99 : c.t >= c.dur - 0.05;
      _pax.mesh.visible = !hide;
      if (!hide) {
        _pax.mesh.position.set(a.x + (b.x - a.x) * wk, c.carGY, a.z + (b.z - a.z) * wk);
        _pax.mesh.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
        _pax.phase = (_pax.phase + dt * 1.7) % 1;
        _pax.mesh.geometry = _pax.tpl.frames[Math.min(_pax.FRAMES - 1, (_pax.phase * _pax.FRAMES) | 0)];
      }
    }
    // Camera b-roll — slow orbit around the stopped car, framing car + passenger.
    const ang = c.baseAngle + c.t * 0.28;
    camera.position.set(c.carX + Math.sin(ang) * 8.5, c.carGY + 2.8, c.carZ + Math.cos(ang) * 8.5);
    _camTgt.set(c.carX + (c.doorX - c.carX) * 0.4, c.carGY + 0.9, c.carZ + (c.doorZ - c.carZ) * 0.4);
    camera.lookAt(_camTgt);

    if (c.t >= c.dur) finishCinematic();
  }

  function finishCinematic() {
    const mode = cine.mode; cine = null;
    if (_pax) _pax.mesh.visible = false;
    if (mode === 'board') {
      // Passenger aboard → set the drop-off and START the fare timer (runs in state 'toDropoff').
      const drop = pickRoad(target.wx, target.wz, TRIP_MIN, TRIP_MAX) || pickRoad(target.wx, target.wz, 80, 900);
      if (drop) {
        tripDist = Math.hypot(drop.wx - target.wx, drop.wz - target.wz);
        fareBase = taxiFare(tripDist);
        expectT = Math.max(6, tripDist / 13); fareT = 0; tip = 0.6;
        target = drop; state = 'toDropoff'; placeMarker(drop, COL_DROP);
        getMinimap?.()?.setObjectiveMarker?.(drop.wx, drop.wz);
        navRoute.setTarget(drop.wx, drop.wz); ding(720);
        // The kicker and sub carry what the player actually wants to know — how far, and what it is
        // worth — instead of an emoji standing in front of two words.
        fxEvent({
          kicker: `Fare ${fares + 1}`,
          title: 'Passenger aboard',
          sub: `${tripDist >= 1000 ? `${(tripDist / 1000).toFixed(1)} km` : `${Math.round(tripDist)} m`} · $${fareBase} base · tip decays`,
          color: COL_PICKUP_CSS, duration: 1700,
        });
        fxConfetti(14, ['#2ee06a', '#8ef0b0', '#ffffff'], 0.4); fxFlash('rgba(46,224,106,.14)');
      } else { state = 'toPickup'; }
      renderHud();
    } else {
      // Delivered → pay out.
      const payout = Math.round(fareBase * (1 + tip));
      const gold = tip > 0.45;
      total += payout; fares += 1;
      wallet.add(payout);   // → persistent balance you can spend in the colour shop
      fxEvent({
        kicker: gold ? 'Great fare' : 'Delivered',
        title: `Fare ${fares} complete`,
        amount: `+$${payout}`,
        sub: tip > 0.02 ? `$${fareBase} fare · +${Math.round(tip * 100)}% tip` : `$${fareBase} fare · no tip`,
        color: COL_DROP_CSS, duration: 2100,
      });
      fxConfetti(gold ? 40 : 26, undefined, 0.4); fxFlash(gold ? 'rgba(255,210,63,.2)' : 'rgba(255,210,63,.13)');
      ding(880); setTimeout(() => ding(1046), 110); if (gold) setTimeout(() => ding(1318), 220);
      newPickup(_lastPx, _lastPz);
    }
  }

  let _hintT = 0;
  function hintSlow() {
    if (_t - _hintT < 2.5) return; _hintT = _t;
    flash(state === 'toPickup' ? 'Slow to a stop to pick up' : 'Slow to a stop to drop off');
  }

  // Start/Quit is driven by the shared game launcher (main.js).
  const btn = { style: {}, remove() {} };   // harmless stub for the internal label writes

  // ── Earnings card (top-left) + end-of-shift panel ────────────────────────────────────────────
  // Was a green-bordered panel with a 💵 emoji and a mint number. Three problems, all fixed by
  // moving to the shared card (see hudTheme.js): the saturated all-round border is the browser's
  // WARNING idiom so a readout read as an alert; green panel + green border + mint number over a
  // park is invisible; and the emoji was doing no work the "$" in the number was not already doing.
  // Top-RIGHT. Every mode readout now lives in the same column — the minimap owns bottom-left, the
  // objective card owns top-centre, and the day/night button vacated this corner. A card in each
  // corner is three places to look while driving.
  const card = createStatCard({ label: 'EARNINGS', color: COL_PICKUP_CSS, rail: true });
  const result = createResultCard({ color: COL_PICKUP_CSS });

  const updateLiveHud = () => {
    const drop = state === 'toDropoff';
    // The sub-line no longer repeats the objective. It used to read "Fare 1 · Pick up" while the
    // objective card two inches away said PICK UP in 10px caps — the same word, twice, at the same
    // moment. The corner card's job is the MONEY; the centre card's job is where to go.
    card.setLabel(drop ? 'FARE IN PROGRESS' : 'EARNINGS');
    card.set(`$${total}`, drop ? `Fare ${fares + 1} · $${fareBase} base` : `${fares} completed`);
    card.meter(drop ? tip / 0.6 : null, `+${Math.round(tip * 100)}% TIP`);
  };

  // ── objective card + road routing ────────────────────────────────────────────────────────────
  // Was a hand-built pill with a CSS-triangle bearing arrow and a CROW-FLIES distance. On an
  // Eixample grid that number climbs while you drive the correct route round a block. Now: the next
  // turn, by name, over the distance remaining ALONG THE ROADS. See objectiveHud / objectiveNav.
  const navHud = createObjectiveHud({ label: 'PICK UP', color: '#2ee06a' });
  const navRoute = createObjectiveNav({ getRoadSegments, getMinimap, color: '#2ee06a' });
  let _nav = null;

  const tag = document.createElement('div');
  tag.style.cssText = 'position:fixed;z-index:1291;display:none;pointer-events:none;user-select:none;transform:translate(-50%,-100%);text-align:center;font-family:Inter,sans-serif;';
  document.body.appendChild(tag);

  const pop = document.createElement('div');
  pop.style.cssText = 'position:fixed;top:40%;left:50%;transform:translate(-50%,-50%);z-index:1300;display:none;' +
    "pointer-events:none;user-select:none;font-family:'Inter',sans-serif;font-size:56px;color:#8ef0b0;text-shadow:0 3px 12px rgba(0,0,0,.6)";
  document.body.appendChild(pop);
  const popStyle = document.createElement('style');
  popStyle.textContent = '@keyframes ddPay{0%{transform:translate(-50%,-40%) scale(.6);opacity:0}20%{transform:translate(-50%,-50%) scale(1.1);opacity:1}100%{transform:translate(-50%,-90%) scale(1);opacity:0}}';
  document.head.appendChild(popStyle);

  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;top:33%;left:50%;transform:translate(-50%,-50%);z-index:1300;display:none;' +
    "font:800 19px Inter,system-ui,sans-serif;color:#fff;background:rgba(18,58,30,.92);border:2px solid #2ee06a;" +
    'padding:9px 18px;border-radius:14px;box-shadow:0 4px 16px rgba(0,0,0,.5);pointer-events:none;white-space:nowrap;';
  document.body.appendChild(toast);
  let _toastT = null;
  function showToast(msg) { toast.textContent = msg; toast.style.display = 'block'; if (_toastT) clearTimeout(_toastT); _toastT = setTimeout(() => { toast.style.display = 'none'; }, 2200); }

  const bestKey = 'dd_taxiBest';
  const getBest = () => { const v = parseFloat(localStorage.getItem(bestKey)); return Number.isFinite(v) ? v : 0; };

  // State-change only (start/pickup/dropoff/end) — per-frame values go through updateLiveHud().
  function renderHud() {
    const active = state === 'toPickup' || state === 'toDropoff';
    card.show(active);
    if (active) {
      updateLiveHud();
      result.hide();
    } else if (state === 'ended') {
      const best = getBest();
      result.show({
        kicker: 'SHIFT OVER',
        value: `$${total}`,
        // "1 fares" shipped. A plural that is wrong exactly when the player has done the least is
        // the one they are most likely to see.
        stats: [
          { label: fares === 1 ? 'fare' : 'fares', value: String(fares) },
          { label: 'best shift', value: `$${Math.max(best, total)}` },
        ],
      });
    } else {
      result.hide();
    }
    navHud.show(active);
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
    cine = null; if (_pax) _pax.mesh.visible = false;   // abort any in-progress cinematic cleanly
    target = null; marker.hide(); getMinimap?.()?.setObjectiveMarker?.(null); navRoute.clear(); _nav = null; renderHud();
  }

  const _v = new THREE.Vector3(), _camSpace = new THREE.Vector3(), _invQ = new THREE.Quaternion();
  let _t = 0;
  function newPickup(carPx, carPz) {
    const from = worldFromScene(carPx, carPz);
    const p = pickRoad(from.wx, from.wz, PICKUP_MIN, PICKUP_MAX);
    if (!p) { flash('No roads nearby — drive into the city'); state = 'idle'; renderHud(); return; }
    target = p; state = 'toPickup'; placeMarker(p, COL_PICKUP);
    getMinimap?.()?.setObjectiveMarker?.(p.wx, p.wz);
    navRoute.setTarget(p.wx, p.wz);
  }
  function updateMarkerUi(carPx, carPz) {
    if (!target) { navHud.show(false); tag.style.display = 'none'; return; }
    const isPickup = state === 'toPickup';
    const col = isPickup ? '#2ee06a' : '#ffc233';
    navHud.setLabel(isPickup ? 'PICK UP' : 'DROP OFF', col);
    card.setAccent(col);
    navHud.update(_nav, isPickup ? `Fare ${fares + 1}` : `Tip +${Math.round(tip * 100)}%`);

    const gx = sceneX(target.wx), gz = sceneZ(target.wz);
    _invQ.copy(camera.quaternion).invert();
    _camSpace.set(gx, camera.position.y, gz).sub(camera.position).applyQuaternion(_invQ);
    const rel = Math.atan2(_camSpace.x, -_camSpace.z);

    // on-screen tag over the marker
    _v.set(gx, markerGroup.position.y + RING_R + 0.6, gz).project(camera);
    if (Math.abs(rel) < Math.PI / 2 && Math.abs(_v.x) < 0.95 && Math.abs(_v.y) < 0.95) {
      const km = _nav?.remainingM;
      const dtxt = km == null ? '' : (km >= 1000 ? `${(km / 1000).toFixed(1)} km` : `${Math.round(km)} m`);
      tag.innerHTML = `<div style="display:inline-block;background:${col};color:#062;font-weight:800;font-size:11px;padding:3px 9px;border-radius:9px;box-shadow:0 2px 8px rgba(0,0,0,.45)">${isPickup ? 'PICK UP' : 'DROP OFF'}${dtxt ? ` · ${dtxt}` : ''}</div>` +
        `<div style="width:0;height:0;margin:0 auto;border-left:7px solid transparent;border-right:7px solid transparent;border-top:9px solid ${col}"></div>`;
      tag.style.left = `${(_v.x * 0.5 + 0.5) * window.innerWidth}px`; tag.style.top = `${(-_v.y * 0.5 + 0.5) * window.innerHeight}px`;
      tag.style.display = 'block';
    } else tag.style.display = 'none';
  }

  function update(carPx, carPz, dt, speedKmh, headingDeg) {
    _lastPx = carPx; _lastPz = carPz;

    // Cinematic in progress → drive it (camera + passenger) and skip the normal loop.
    if (state === 'boarding' || state === 'alighting') { _t += dt; updateCinematic(dt); return; }

    if (state !== 'toPickup' && state !== 'toDropoff') return;
    if (_pending) { _pending = false; newPickup(carPx, carPz); if (state === 'idle') return; }

    _t += dt;
    // Route: the car's scene position back to world, because the router works in the world frame the
    // road points are stored in — no mirror, no physics origin.
    { const w = worldFromScene(carPx, carPz); _nav = navRoute.update(w.wx, w.wz, dt); }

    // The halo breathes and fades its beam by RANGE — the beam is a locator, so it is what tells you
    // the fare is behind that block, and it is in the way of the thing it points at once you arrive.
    marker.update(dt, marker.visible
      ? Math.hypot(carPx - markerGroup.position.x, carPz - markerGroup.position.z) : Infinity);

    if (state === 'toDropoff') { fareT += dt; tip = Math.max(0, 0.6 * (1 - fareT / (expectT * 1.4))); }

    if (target) {
      const gx = sceneX(target.wx), gz = sceneZ(target.wz);
      if (Math.hypot(carPx - gx, carPz - gz) < HIT_RADIUS) {
        // Must be near-stopped to board / alight — otherwise nudge the player to slow down.
        if ((speedKmh || 0) > STOP_SPEED) hintSlow();
        else startCinematic(state === 'toPickup' ? 'board' : 'alight', carPx, carPz, headingDeg);
      }
    }

    updateMarkerUi(carPx, carPz);
    updateLiveHud();
  }

  function isCinematic() { return state === 'boarding' || state === 'alighting'; }

  function flash(msg) { showToast(msg); }

  renderHud();
  return {
    name: 'City Cab', icon: '🚕', key: 'taxi',
    update, start, stop, isCinematic,
    dispose() { stop(); card.remove(); result.remove(); navHud.remove(); tag.remove(); pop.remove(); popStyle.remove(); toast.remove(); marker.dispose(); if (_pax) scene.remove(_pax.mesh); },
    isRunning: () => state === 'toPickup' || state === 'toDropoff' || state === 'boarding' || state === 'alighting',
  };
}
