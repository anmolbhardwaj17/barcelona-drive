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
import { fxFlash, fxConfetti, fxBanner } from './gameFx.js';

const N_CHECKPOINTS = 10;
const MIN_GAP = 45, MAX_GAP = 120;   // metres between gates (closer + more of them)
const HIT_RADIUS = 16;
const RING_R = 5.0;

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

  // ── shared geometry ────────────────────────────────────────────────────────
  const ringGeo = new THREE.TorusGeometry(RING_R, 0.45, 8, 28);          // upright ring you drive through
  const groundRingGeo = new THREE.RingGeometry(RING_R * 0.9, RING_R * 1.25, 32); // flat glow on the road
  const beamGeo = new THREE.CylinderGeometry(RING_R * 0.55, RING_R * 0.9, 90, 18, 1, true);

  const _up = new THREE.Vector3(0, 1, 0);

  // ── coordinate helpers ────────────────────────────────────────────────────
  const sceneX = (wx) => -(wx - getOrigin().x);
  const sceneZ = (wz) => wz - getOrigin().z;
  const worldFromScene = (px, pz) => ({ wx: getOrigin().x - px, wz: pz + getOrigin().z });

  // Start/Quit is driven by the shared game launcher (main.js), not a per-mode button.
  const btn = { style: {}, remove() {} };   // harmless stub for the internal label writes

  const hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;top:88px;left:50%;transform:translateX(-50%);z-index:1290;' +
    'font-family:Poppins,system-ui,sans-serif;color:#fff;text-align:center;pointer-events:none;user-select:none;';
  // Persistent live display (timer + counter) — updated via textContent each frame, NOT innerHTML,
  // so the running HUD doesn't re-parse HTML + reflow 60×/s (that tanked FPS while a mode was active).
  const liveWrap = document.createElement('div'); liveWrap.style.display = 'none';
  const liveTimer = document.createElement('div');
  liveTimer.style.cssText = "font-family:'Lilita One',sans-serif;font-size:34px;letter-spacing:1px;text-shadow:0 2px 6px rgba(0,0,0,.6)";
  const liveCount = document.createElement('div');
  liveCount.style.cssText = 'font-weight:700;font-size:15px;opacity:.9;text-shadow:0 1px 3px rgba(0,0,0,.7)';
  liveWrap.appendChild(liveTimer); liveWrap.appendChild(liveCount);
  const resultWrap = document.createElement('div'); resultWrap.style.display = 'none';
  hud.appendChild(liveWrap); hud.appendChild(resultWrap);
  document.body.appendChild(hud);
  const updateLiveHud = () => {
    liveTimer.textContent = fmt(elapsed);
    liveCount.textContent = `Checkpoint ${Math.min(activeIdx + 1, route.length)} / ${route.length}`;
  };

  // ── Objective marker: a labelled compass pill (top-centre) + a tag that floats over the gate ──
  const nav = document.createElement('div');
  nav.style.cssText = 'position:fixed;top:150px;left:50%;transform:translateX(-50%);z-index:1290;display:none;' +
    'pointer-events:none;user-select:none;text-align:center;background:rgba(8,20,30,.72);border:2px solid #35e0ff;' +
    'border-radius:16px;padding:8px 14px 10px;box-shadow:0 3px 12px rgba(0,0,0,.4)';
  nav.innerHTML =
    '<div class="nav-tri" style="width:0;height:0;margin:0 auto 5px;border-left:8px solid transparent;' +
    'border-right:8px solid transparent;border-bottom:30px solid #35e0ff;filter:drop-shadow(0 0 5px #35e0ff);transition:transform .12s"></div>' +
    '<div style="font:800 11px Poppins,sans-serif;letter-spacing:1px;color:#9fe9ff">NEXT CHECKPOINT</div>' +
    '<div class="nav-dist" style="font-family:\'Lilita One\',sans-serif;font-size:19px;color:#fff;line-height:1.1">0 m</div>';
  const navTri = nav.querySelector('.nav-tri');
  const navDist = nav.querySelector('.nav-dist');
  document.body.appendChild(nav);

  // floating "NEXT ▾" tag pinned over the gate when it's on screen
  const gateTag = document.createElement('div');
  gateTag.style.cssText = 'position:fixed;z-index:1291;display:none;pointer-events:none;user-select:none;' +
    'transform:translate(-50%,-100%);text-align:center;font-family:Poppins,sans-serif;';
  gateTag.innerHTML =
    '<div style="display:inline-block;background:#35e0ff;color:#062430;font-weight:800;font-size:11px;letter-spacing:.5px;' +
    'padding:3px 9px;border-radius:9px;box-shadow:0 2px 8px rgba(0,0,0,.45)">NEXT</div>' +
    '<div style="width:0;height:0;margin:0 auto;border-left:7px solid transparent;border-right:7px solid transparent;border-top:9px solid #35e0ff"></div>';
  document.body.appendChild(gateTag);

  // big centre countdown (3·2·1·GO)
  const countdownEl = document.createElement('div');
  countdownEl.style.cssText = 'position:fixed;top:44%;left:50%;transform:translate(-50%,-50%);z-index:1300;' +
    "display:none;pointer-events:none;user-select:none;font-family:'Lilita One',sans-serif;font-size:120px;" +
    'color:#fff;text-shadow:0 4px 20px rgba(0,0,0,.6),0 0 30px rgba(53,224,255,.5);';
  document.body.appendChild(countdownEl);
  const cdStyle = document.createElement('style');
  cdStyle.textContent = '@keyframes ddCdPop{0%{transform:translate(-50%,-50%) scale(.4);opacity:0}25%{transform:translate(-50%,-50%) scale(1.15);opacity:1}100%{transform:translate(-50%,-50%) scale(.85);opacity:.85}}';
  document.head.appendChild(cdStyle);

  // contextual "Race again" — only on the finish screen (not a persistent button)
  const againBtn = document.createElement('button');
  againBtn.textContent = '🏁 Race again';
  againBtn.style.cssText = 'position:fixed;top:236px;left:50%;transform:translateX(-50%);z-index:1295;display:none;cursor:pointer;' +
    'font-family:Poppins,system-ui,sans-serif;font-weight:800;font-size:14px;color:#241a08;background:linear-gradient(#ffd23f,#f5a623);' +
    'border:none;border-radius:22px;padding:9px 20px;box-shadow:0 5px 0 #b9791a,0 8px 14px rgba(0,0,0,.35);';
  againBtn.onclick = () => start();
  document.body.appendChild(againBtn);

  function medalFor(ms, n) {
    const per = ms / Math.max(1, n);
    if (per < 6500) return { emoji: '🥇', label: 'GOLD', color: '#ffd23f' };
    if (per < 9000) return { emoji: '🥈', label: 'SILVER', color: '#d7dee8' };
    if (per < 13000) return { emoji: '🥉', label: 'BRONZE', color: '#e0955a' };
    return { emoji: '🏁', label: 'FINISHED', color: '#9fe9ff' };
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
    liveWrap.style.display = active ? 'block' : 'none';
    // Only show the result on the finish screen — NOT when idle. The old idle "Dash best …" teaser
    // stayed painted at top-centre even while another mode (City Cab) was active → overlapping HUDs.
    resultWrap.style.display = state === 'finished' ? 'block' : 'none';
    if (active) {
      updateLiveHud();
    } else if (state === 'finished') {
      const best = getBest();
      const m = _medal || medalFor(elapsed, route.length);
      resultWrap.innerHTML =
        `<div style="font-size:52px;line-height:1;filter:drop-shadow(0 3px 6px rgba(0,0,0,.5))">${m.emoji}</div>` +
        `<div style="font-family:'Lilita One',sans-serif;font-size:22px;color:${m.color};letter-spacing:1px;text-shadow:0 2px 6px rgba(0,0,0,.6)">${m.label}</div>` +
        `<div style="font-family:'Lilita One',sans-serif;font-size:34px;text-shadow:0 2px 6px rgba(0,0,0,.6)">${fmt(elapsed)}</div>` +
        (_newBest ? `<div style="font-weight:800;font-size:13px;color:#ffd23f;letter-spacing:1px;text-shadow:0 1px 3px rgba(0,0,0,.7)">★ NEW BEST!</div>`
                  : `<div style="font-weight:700;font-size:13px;opacity:.85;text-shadow:0 1px 3px rgba(0,0,0,.7)">Best ${best != null ? fmt(best) : '—'}</div>`);
    } else {
      const best = getBest();
      resultWrap.innerHTML = best != null ? `<div style="font-weight:700;font-size:12px;opacity:.7;text-shadow:0 1px 3px rgba(0,0,0,.7)">Dash best ${fmt(best)}</div>` : '';
    }
    nav.style.display = active ? 'block' : 'none';
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

  function makeGate(world, dirScene) {
    const group = new THREE.Group();
    const ringMat = new THREE.MeshBasicMaterial({ color: COL_AFTER, transparent: true, opacity: 0.98, fog: false });
    const beamMat = new THREE.MeshBasicMaterial({ color: COL_AFTER, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const glowMat = new THREE.MeshBasicMaterial({ color: COL_AFTER, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false, fog: false });

    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dirScene.clone().normalize());
    ringMesh.quaternion.copy(q);
    ringMesh.position.y = RING_R + 0.4;
    group.add(ringMesh);

    const beamMesh = new THREE.Mesh(beamGeo, beamMat); beamMesh.position.y = 45; group.add(beamMesh);
    const groundGlow = new THREE.Mesh(groundRingGeo, glowMat); groundGlow.rotation.x = -Math.PI / 2; groundGlow.position.y = 0.15; group.add(groundGlow);

    const gy = getGroundY ? (getGroundY(world.wx, world.wz) || 0) : 0;
    group.position.set(sceneX(world.wx), gy, sceneZ(world.wz));
    group.userData = { ringMat, beamMat, glowMat, ringMesh, world };
    scene.add(group);
    return group;
  }

  function setGateColor(g, hex, active) {
    g.userData.ringMat.color.setHex(hex);
    g.userData.beamMat.color.setHex(hex); g.userData.beamMat.opacity = active ? 0.18 : 0.09;
    g.userData.glowMat.color.setHex(hex); g.userData.glowMat.opacity = active ? 0.6 : 0.3;
  }
  function refreshGateColors() {
    for (let i = 0; i < gates.length; i++) {
      const g = gates[i]; if (!g) continue;
      const show = i === activeIdx || i === activeIdx + 1;
      g.visible = show;
      setGateColor(g, i === activeIdx ? COL_NEXT : COL_AFTER, i === activeIdx);
    }
    const t = route[activeIdx];
    getMinimap?.()?.setObjectiveMarker?.(t ? t.wx : null, t ? t.wz : null);
  }
  function clearGates() { for (const g of gates) if (g) { scene.remove(g); const u = g.userData; u.ringMat.dispose(); u.beamMat.dispose(); u.glowMat.dispose(); } gates.length = 0; }

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
  function stop() { state = 'idle'; clearGates(); route = []; _pendingStart = false; countdownEl.style.display = 'none'; getMinimap?.()?.setObjectiveMarker?.(null); renderHud(); }
  function finish() {
    state = 'finished';
    const best = getBest();
    _newBest = (best == null || elapsed < best);
    if (_newBest) { try { localStorage.setItem(bestKey, String(Math.round(elapsed))); } catch {} }
    _medal = medalFor(elapsed, route.length);
    clearGates(); nav.style.display = 'none'; gateTag.style.display = 'none'; getMinimap?.()?.setObjectiveMarker?.(null);
    ding(880); setTimeout(() => ding(1174), 140); renderHud();
    // celebration
    const m = _medal || medalFor(elapsed, route.length);
    fxBanner(`<div style="font-size:60px">${m.emoji}</div><div style="font-size:32px;color:${m.color}">FINISH!</div>`, { duration: 2200, top: '30%' });
    fxConfetti(46, undefined, 0.38); fxFlash('rgba(255,210,63,.16)');
    // auto-clear the result after a while if the player just drives off
    setTimeout(() => { if (state === 'finished') stop(); }, 12000);
  }

  const _v = new THREE.Vector3(), _camSpace = new THREE.Vector3(), _invQ = new THREE.Quaternion();
  let _t = 0;
  function updateArrow(carPx, carPz) {
    const target = route[activeIdx];
    const g = gates[activeIdx];
    if (!target || !g) { nav.style.display = 'none'; gateTag.style.display = 'none'; return; }
    nav.style.display = 'block';

    const gx = sceneX(target.wx), gz = sceneZ(target.wz);
    const dist = Math.hypot(carPx - gx, carPz - gz);
    navDist.textContent = dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist)} m`;

    // rotating arrow in the CAMERA's frame (matches what's on screen — a world-bearing calc came out
    // mirrored L/R because the visual world is X-mirrored). 0 = straight ahead, +cw = to the right.
    _invQ.copy(camera.quaternion).invert();
    _camSpace.set(gx, camera.position.y, gz).sub(camera.position).applyQuaternion(_invQ);
    const rel = Math.atan2(_camSpace.x, -_camSpace.z);
    navTri.style.transform = `rotate(${rel}rad)`;

    // floating "NEXT" tag over the gate when it's on screen
    _v.set(gx, g.position.y + RING_R + 0.6, gz).project(camera);
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
      countdownEl.style.display = 'block';
      renderHud();   // once — show the live wrap
    }

    // ── countdown phase: gates show + arrow points, but the clock doesn't run yet ──
    if (state === 'countdown') {
      const prev = Math.ceil(_cd);
      _cd -= dt;
      const n = Math.ceil(_cd);
      if (_cd > 0) {
        if (n !== prev) { ding(520); countdownEl.style.animation = 'none'; void countdownEl.offsetWidth; countdownEl.style.animation = 'ddCdPop .9s ease-out'; }
        countdownEl.textContent = String(n);
      } else {
        state = 'running'; elapsed = 0;
        countdownEl.textContent = 'GO!'; countdownEl.style.animation = 'none'; void countdownEl.offsetWidth; countdownEl.style.animation = 'ddCdPop .6s ease-out';
        ding(1046);
        setTimeout(() => { if (state === 'running') countdownEl.style.display = 'none'; }, 550);
      }
      updateArrow(carPx, carPz);
      updateLiveHud();
      return;
    }

    elapsed += dt * 1000; _t += dt;

    // pulse/spin the active gate
    const g = gates[activeIdx];
    if (g) { const s = 1 + Math.sin(_t * 4) * 0.07; g.userData.ringMesh.scale.set(s, s, s); g.userData.ringMesh.rotateZ(dt * 1.4); }

    // hit test
    const target = route[activeIdx];
    if (target) {
      const gx = sceneX(target.wx), gz = sceneZ(target.wz);
      if (Math.hypot(carPx - gx, carPz - gz) < HIT_RADIUS) {
        if (gates[activeIdx]) gates[activeIdx].visible = false;
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
    nav.style.display = 'none'; gateTag.style.display = 'none';
    liveWrap.style.display = 'none'; resultWrap.style.display = 'block';
    resultWrap.innerHTML = `<div style="font-weight:700;font-size:14px;background:rgba(0,0,0,.6);padding:9px 15px;border-radius:10px">${msg}</div>`;
    _flash = setTimeout(() => { _flash = null; renderHud(); }, 2800);
  }

  renderHud();
  return {
    name: 'Checkpoint Dash', icon: '🏁',
    update, start, stop,
    dispose() { stop(); hud.remove(); nav.remove(); gateTag.remove(); countdownEl.remove(); againBtn.remove(); cdStyle.remove(); ringGeo.dispose(); groundRingGeo.dispose(); beamGeo.dispose(); },
    isRunning: () => state === 'running' || state === 'countdown',
  };
}
