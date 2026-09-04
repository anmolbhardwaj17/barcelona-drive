/**
 * dashMode.js — "Checkpoint Dash" time-trial game mode.
 *
 * START → a chain of glowing gates is laid along the loaded road network. Each gate is a bright ring on
 * the road + a tall pillar of light, and a compass arrow (top-centre) points to the next one with its
 * distance. Drive through them in order against a running clock; clear the last to finish. Best time is
 * saved (localStorage dd_dashBest).
 *
 * Frames: the car position handed to update() is the PHYSICS/scene frame (lp.lx, lp.lz). Road points from
 * getRoadSegments() are WORLD coords. Conversion matches trafficSystem: px=-(wx-ox), pz=wz-oz. Gate meshes
 * live in `scene` (physics frame) like the traffic, so they sit on the road.
 */
import * as THREE from 'three';
import { fxFlash, fxConfetti, fxEvent } from './gameFx.js';
import { createStatCard, createResultCard, createCountdown } from './hudTheme.js';
import { createObjectiveMarker } from './objectiveMarker.js';
import { createObjectiveNav } from './objectiveNav.js';
import { createObjectiveHud } from './objectiveHud.js';

const N_CHECKPOINTS = 10;
const MIN_GAP = 45, MAX_GAP = 120;   // metres between gates (closer + more of them)
const HIT_RADIUS = 16;
const RING_R = 5.0;

const COL_DASH_CSS = '#35e0ff';
const COL_NEXT = 0x35e0ff;   // active gate — cyan
const COL_AFTER = 0xffc233;  // the one after — gold
// Wide carriageways where a 10m checkpoint ring fits centred (no clipping into buildings). Fallback set
// widens to all drivable roads when a location doesn't have enough big roads nearby.
const WIDE_ROADS = new Set(['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'trunk', 'trunk_link']);
const DRIVABLE_ROADS = new Set([...WIDE_ROADS, 'residential', 'living_street', 'unclassified']);

export function createDashMode({ scene, camera, getMinimap, getRoadSegments, getGroundY, getOrigin, audio }) {
  let state = 'idle';               // idle | running | finished
  let route = [];                   // [{wx, wz}]
  let activeIdx = 0;
  let elapsed = 0;
  const gates = [];                 // parallel to route: gate group or null once cleared

  // ── coordinate helpers ────────────────────────────────────────────────────
  const sceneX = (wx) => -(wx - getOrigin().x);
  const sceneZ = (wz) => wz - getOrigin().z;
  const worldFromScene = (px, pz) => ({ wx: getOrigin().x - px, wz: pz + getOrigin().z });

  // Start/Quit is driven by the shared game launcher (main.js), not a per-mode button.
  const btn = { style: {}, remove() {} };   // harmless stub for the internal label writes

  // ── Timer card + finish panel ────────────────────────────────────────────────────────────────
  // Was two bare text divs floating on the sky with a drop-shadow, plus a finish screen built by
  // reassigning `innerHTML` with six inline-styled spans. Shared cards now — see hudTheme.js.
  const card = createStatCard({ label: 'TIME', color: COL_DASH_CSS, rail: true });
  const result = createResultCard({ color: COL_DASH_CSS });
  const updateLiveHud = () => {
    card.set(fmt(elapsed), `Checkpoint ${Math.min(activeIdx + 1, route.length)} of ${route.length}`);
    // A route bar: how much of the run is behind you. "3 / 9" is the same fact as a fraction you
    // have to work out at 90 km/h.
    card.meter(route.length ? activeIdx / route.length : 0,
               `${route.length ? Math.round(activeIdx / route.length * 100) : 0}%`, COL_DASH_CSS);
  };

  // ── objective card + road routing ────────────────────────────────────────────────────────────
  // The gate chain is laid along the road network already, so a route to the NEXT gate is a route
  // the player can actually drive — the bearing arrow this replaces pointed through buildings.
  const navHud = createObjectiveHud({ label: 'NEXT CHECKPOINT', color: '#35e0ff' });
  const navRoute = createObjectiveNav({ getRoadSegments, getMinimap, color: '#35e0ff' });
  let _nav = null, _navTarget = null;

  const gateTag = document.createElement('div');
  gateTag.style.cssText = 'position:fixed;z-index:1291;display:none;pointer-events:none;user-select:none;' +
    'transform:translate(-50%,-100%);text-align:center;font-family:Inter,sans-serif;';
  gateTag.innerHTML =
    '<div style="display:inline-block;background:#35e0ff;color:#062430;font-weight:800;font-size:11px;letter-spacing:.5px;' +
    'padding:3px 9px;border-radius:9px;box-shadow:0 2px 8px rgba(0,0,0,.45)">NEXT</div>' +
    '<div style="width:0;height:0;margin:0 auto;border-left:7px solid transparent;border-right:7px solid transparent;border-top:9px solid #35e0ff"></div>';
  document.body.appendChild(gateTag);

  // big centre countdown (3·2·1·GO)
  const countdown = createCountdown({ color: COL_DASH_CSS });

  // contextual "Race again" — only on the finish screen (not a persistent button)
  const againBtn = document.createElement('button');
  againBtn.textContent = 'Race again';
  againBtn.style.cssText = 'position:fixed;top:236px;left:50%;transform:translateX(-50%);z-index:1295;display:none;cursor:pointer;' +
    'font-family:Inter,system-ui,sans-serif;font-weight:800;font-size:14px;color:#241a08;background:linear-gradient(#ffd23f,#f5a623);' +
    'border:none;border-radius:22px;padding:9px 20px;box-shadow:0 5px 0 #b9791a,0 8px 14px rgba(0,0,0,.35);';
  againBtn.onclick = () => start();
  document.body.appendChild(againBtn);

  function medalFor(ms, n) {
    const per = ms / Math.max(1, n);
    // No `emoji` field any more — it was the only consumer of these glyphs and both call sites now
    // use the label and the colour. A medal glyph is a different picture on every platform and
    // brings the OS's palette into a screen that has its own.
    if (per < 6500) return { label: 'GOLD', color: '#ffd23f' };
    if (per < 9000) return { label: 'SILVER', color: '#d7dee8' };
    if (per < 13000) return { label: 'BRONZE', color: '#e0955a' };
    return { label: 'FINISHED', color: '#9fe9ff' };
  }
  let _medal = null, _newBest = false;

  const bestKey = 'dd_dashBest';
  const getBest = () => { const v = parseFloat(localStorage.getItem(bestKey)); return Number.isFinite(v) ? v : null; };
  const fmt = (ms) => {
    const t = Math.max(0, ms), m = Math.floor(t / 60000), s = Math.floor((t % 60000) / 1000), cs = Math.floor((t % 1000) / 10);
    return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  };

  // Called only on STATE CHANGES (start/stop/finish/checkpoint) — not per frame. The per-frame timer/counter
  // are updated by updateLiveHud() via textContent, so no innerHTML churn while a mode is running.
  function renderHud() {
    const active = state === 'running' || state === 'countdown';
    card.show(active);
    if (active) {
      updateLiveHud();
      result.hide();
    } else if (state === 'finished') {
      const best = getBest();
      const m = _medal || medalFor(elapsed, route.length);
      // The medal is a COLOUR and a WORD now, not an emoji: a medal glyph renders as a different
      // picture on every platform and drags the OS palette into a screen that has its own.
      result.show({
        kicker: m.label,
        value: fmt(elapsed),
        color: m.color,
        stats: [
          { label: route.length === 1 ? 'checkpoint' : 'checkpoints', value: String(route.length) },
          _newBest ? { label: 'personal best', value: 'NEW' }
                   : { label: 'best', value: best != null ? fmt(best) : '—' },
        ],
      });
    } else {
      result.hide();
    }
    navHud.show(active);
    if (!active) gateTag.style.display = 'none';
    againBtn.style.display = state === 'finished' ? 'block' : 'none';
  }

  // ── build the route from loaded roads (robust: relax the forward bias if a step stalls) ────────
  function buildRoute(carPx, carPz) {
    const segs = getRoadSegments ? getRoadSegments() : [];
    // Prefer WIDE roads so the 10 m ring sits centred on the carriageway instead of clipping into buildings
    // on narrow streets. Fall back to all drivable roads if a spot doesn't have enough wide ones nearby.
    let cand = [];
    const collect = (allow, minW) => {
      cand = [];
      for (const s of segs) {
        if (allow && !allow.has(s.highwayType)) continue;
        if (minW && s.width && s.width < minW) continue;
        const pts = s.points || [];
        for (let i = 0; i < pts.length; i += 2) cand.push({ wx: pts[i].x, wz: pts[i].y });
      }
    };
    collect(WIDE_ROADS, 9);
    if (cand.length < N_CHECKPOINTS * 3) collect(DRIVABLE_ROADS, 0); // not enough wide roads here → relax
    if (cand.length < 2) collect(null, 0);                           // last resort: any road
    if (cand.length < 2) return { route: [], candCount: cand.length };

    const start = worldFromScene(carPx, carPz);
    let cur = start, heading = null;
    const chosen = [];
    for (let k = 0; k < N_CHECKPOINTS; k++) {
      let best = null, bestScore = -Infinity;
      // pass 1: forward-biased; pass 2: any direction (so a route always forms)
      for (let pass = 0; pass < 2 && !best; pass++) {
        for (const c of cand) {
          const dx = c.wx - cur.wx, dz = c.wz - cur.wz;
          const d = Math.hypot(dx, dz);
          if (d < MIN_GAP || d > MAX_GAP) continue;
          let tooClose = false;
          for (const ch of chosen) { if (Math.hypot(c.wx - ch.wx, c.wz - ch.wz) < MIN_GAP * 0.7) { tooClose = true; break; } }
          if (tooClose) continue;
          const nx = dx / d, nz = dz / d;
          const fwd = (heading && pass === 0) ? (nx * heading.x + nz * heading.z) : 0.3;
          if (pass === 0 && heading && fwd < 0.1) continue;   // pass 1: only forward-ish
          const score = fwd + (d / MAX_GAP) * 0.3 + Math.random() * 0.25;
          if (score > bestScore) { bestScore = score; best = { c, nx, nz }; }
        }
      }
      if (!best) break;
      chosen.push(best.c);
      heading = { x: best.nx, z: best.nz };
      cur = best.c;
    }
    return { route: chosen, candCount: cand.length };
  }

  // A gate is a shared objective halo, oriented to the direction you drive THROUGH it. This used to
  // be four hand-rolled additive materials per gate — a drifted superset of taxi's and delivery's
  // copies of the same idea, and the only one of the three with a bloom torus. See objectiveMarker.js.
  function makeGate(world, dirScene) {
    const m = createObjectiveMarker(scene, { radius: RING_R, driveThrough: true });
    const gy = getGroundY ? (getGroundY(world.wx, world.wz) || 0) : 0;
    // The ring faces along the route. Yaw only: a gate leaning with the road grade reads as broken,
    // and you drive through its middle either way.
    const face = Math.atan2(dirScene.x, dirScene.z);
    m.place(sceneX(world.wx), gy, sceneZ(world.wz), COL_AFTER, face);
    m.hide();                      // refreshGateColors decides which two are shown
    m.group.userData.world = world;
    return m;
  }

  function refreshGateColors() {
    for (let i = 0; i < gates.length; i++) {
      const g = gates[i]; if (!g) continue;
      // Two gates only: the one you are driving at and the one after it, so the route reads as a
      // direction rather than as a field of rings. The NEXT one is tinted and the one after is not.
      const show = i === activeIdx || i === activeIdx + 1;
      if (!show) { g.hide(); continue; }
      const p = g.group.position;
      g.place(p.x, p.y, p.z, i === activeIdx ? COL_NEXT : COL_AFTER);
    }
    const t = route[activeIdx];
    getMinimap?.()?.setObjectiveMarker?.(t ? t.wx : null, t ? t.wz : null);
  }
  function clearGates() { for (const g of gates) if (g) g.dispose(); gates.length = 0; }

  function ding(freq) {
    try {
      const c = audio?.ctx?.(); if (!c) return;
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'triangle'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.4, c.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.35);
      o.connect(g); g.connect(audio.master?.() || c.destination); o.start(); o.stop(c.currentTime + 0.37);
    } catch {}
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  let _pendingStart = false;
  function start() { _pendingStart = true; state = 'running'; activeIdx = 0; elapsed = 0; renderHud(); }
  function stop() { state = 'idle'; clearGates(); route = []; _pendingStart = false; countdown.hide(); getMinimap?.()?.setObjectiveMarker?.(null); renderHud(); }
  function finish() {
    state = 'finished';
    const best = getBest();
    _newBest = (best == null || elapsed < best);
    if (_newBest) { try { localStorage.setItem(bestKey, String(Math.round(elapsed))); } catch {} }
    _medal = medalFor(elapsed, route.length);
    clearGates(); navHud.show(false); gateTag.style.display = 'none'; getMinimap?.()?.setObjectiveMarker?.(null); navRoute.clear(); _nav = null; _navTarget = null;
    ding(880); setTimeout(() => ding(1174), 140); renderHud();
    // celebration
    // ⚠ NO finish BANNER. The result card already says FINISHED, the time, the checkpoint count
    // and the best — and it lands in the same place, so the two drew on top of each other showing
    // the same three facts twice. The card is the celebration; the confetti and the flash are the
    // punctuation.
    fxConfetti(46, undefined, 0.38); fxFlash('rgba(255,210,63,.16)');
    // auto-clear the result after a while if the player just drives off
    setTimeout(() => { if (state === 'finished') stop(); }, 12000);
  }

  const _v = new THREE.Vector3(), _camSpace = new THREE.Vector3(), _invQ = new THREE.Quaternion();
  let _t = 0;
  function updateArrow(carPx, carPz) {
    const target = route[activeIdx];
    const g = gates[activeIdx];
    if (!target || !g) { navHud.show(false); gateTag.style.display = 'none'; return; }
    navHud.show(true);
    navHud.update(_nav, `Checkpoint ${Math.min(activeIdx + 1, route.length)} of ${route.length}`);

    const gx = sceneX(target.wx), gz = sceneZ(target.wz);

    // The gate tag still needs the CAMERA-frame bearing — a world-bearing calc came out mirrored
    // L/R because the visual world is X-mirrored, and that mirror has not gone anywhere.
    _invQ.copy(camera.quaternion).invert();
    _camSpace.set(gx, camera.position.y, gz).sub(camera.position).applyQuaternion(_invQ);
    const rel = Math.atan2(_camSpace.x, -_camSpace.z);

    // floating "NEXT" tag over the gate when it's on screen
    // ⚠ `g` is an objectiveMarker API object, NOT a THREE.Group — its transform lives on `g.group`.
    // This read was `g.position.y` after the M-1 conversion and threw EVERY FRAME inside `animate`,
    // which killed the whole game loop: the car stopped responding and nothing else in the loop ran.
    // A per-frame throw in a mode update is indistinguishable from a frozen game.
    _v.set(gx, g.group.position.y + RING_R + 0.6, gz).project(camera);
    const inFront = Math.abs(rel) < Math.PI / 2;
    if (inFront && Math.abs(_v.x) < 0.95 && Math.abs(_v.y) < 0.95) {
      const sx = (_v.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-_v.y * 0.5 + 0.5) * window.innerHeight;
      gateTag.style.left = `${sx}px`; gateTag.style.top = `${sy}px`;
      gateTag.style.display = 'block';
    } else {
      gateTag.style.display = 'none';
    }
  }

  let _cd = 0;
  function update(carPx, carPz, dt) {
    if (state !== 'running' && state !== 'countdown') return;

    if (_pendingStart) {
      _pendingStart = false;
      const r = buildRoute(carPx, carPz);
      route = r.route;
      if (route.length < 1) { state = 'idle'; hudFlash(r.candCount < 2 ? 'No roads loaded — drive into the city and retry' : 'Could not lay a route here — try another spot'); return; }
      clearGates();
      for (let i = 0; i < route.length; i++) {
        const from = i === 0 ? worldFromScene(carPx, carPz) : route[i - 1];
        const dir = new THREE.Vector3(sceneX(route[i].wx) - sceneX(from.wx), 0, sceneZ(route[i].wz) - sceneZ(from.wz));
        if (dir.lengthSq() < 1e-3) dir.set(0, 0, 1);
        gates.push(makeGate(route[i], dir));
      }
      refreshGateColors();
      // 3·2·1·GO — timer + hit-testing start at GO
      state = 'countdown'; _cd = 3.0; elapsed = 0;
      countdown.set(3);
      renderHud();   // once — show the live wrap
    }

    // ── countdown phase: gates show + arrow points, but the clock doesn't run yet ──
    if (state === 'countdown') {
      const prev = Math.ceil(_cd);
      _cd -= dt;
      const n = Math.ceil(_cd);
      if (_cd > 0) {
        if (n !== prev) { ding(520); countdown.set(n); }
      } else {
        state = 'running'; elapsed = 0;
        countdown.go();
        ding(1046);
        setTimeout(() => { if (state === 'running') countdown.hide(); }, 900);
      }
      updateArrow(carPx, carPz);
      updateLiveHud();
      return;
    }

    elapsed += dt * 1000; _t += dt;

    // Retarget only when the active checkpoint CHANGES — setTarget throws the plan away, so calling
    // it every frame would replan continuously and never draw a stable line.
    const tgt = route[activeIdx];
    if (tgt && tgt !== _navTarget) { _navTarget = tgt; navRoute.setTarget(tgt.wx, tgt.wz); }
    { const w = worldFromScene(carPx, carPz); _nav = navRoute.update(w.wx, w.wz, dt); }

    // Animate the two visible gates. Both, not just the active one: the gate AFTER the next is what
    // tells you which way the route turns, and a dead ring beside a live one reads as already cleared.
    for (const i of [activeIdx, activeIdx + 1]) {
      const g = gates[i];
      if (!g || !g.visible) continue;
      const p = g.group.position;
      g.update(dt, Math.hypot(carPx - p.x, carPz - p.z));
    }

    // hit test
    const target = route[activeIdx];
    if (target) {
      const gx = sceneX(target.wx), gz = sceneZ(target.wz);
      if (Math.hypot(carPx - gx, carPz - gz) < HIT_RADIUS) {
        gates[activeIdx]?.hide();
        activeIdx++;
        if (activeIdx >= route.length) { finish(); return; }
        ding(680 + activeIdx * 45);
        fxConfetti(9, ['#35e0ff', '#8fdcff', '#ffffff'], 0.45); fxFlash('rgba(53,224,255,.1)', 260);
        refreshGateColors();
      }
    }

    updateArrow(carPx, carPz);
    updateLiveHud();
  }

  let _flash = null;
  function hudFlash(msg) {
    if (_flash) clearTimeout(_flash);
    navHud.show(false); gateTag.style.display = 'none';
    card.show(false);
    result.show({ kicker: 'Checkpoint Dash', value: '—', stats: [], color: COL_DASH_CSS });
    result.el.querySelector('.ddr-value').textContent = msg;
    result.el.querySelector('.ddr-value').style.font = '600 15px/1.35 Inter, sans-serif';
    _flash = setTimeout(() => { _flash = null; renderHud(); }, 2800);
  }

  renderHud();
  return {
    name: 'Checkpoint Dash', icon: '🏁', key: 'dash',
    update, start, stop,
    dispose() { stop(); card.remove(); result.remove(); navHud.remove(); gateTag.remove(); countdown.remove(); againBtn.remove(); },
    isRunning: () => state === 'running' || state === 'countdown',
  };
}
