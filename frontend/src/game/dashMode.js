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

const N_CHECKPOINTS = 6;
const MIN_GAP = 70, MAX_GAP = 230;   // metres between gates
const HIT_RADIUS = 16;
const RING_R = 5.0;

const COL_NEXT = 0x35e0ff;   // active gate — cyan
const COL_AFTER = 0xffc233;  // the one after — gold

export function createDashMode({ scene, camera, getRoadSegments, getGroundY, getOrigin, audio }) {
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

  // ── HUD: Start/Quit button (top-left, clear of the compass) + centre timer/arrow ────────────────
  const btn = document.createElement('button');
  btn.style.cssText = 'position:fixed;top:92px;left:14px;z-index:1300;cursor:pointer;' +
    'font-family:Poppins,system-ui,sans-serif;font-weight:700;font-size:14px;color:#241a08;' +
    'background:linear-gradient(#ffd23f,#f5a623);border:none;border-radius:22px;padding:9px 18px;' +
    'box-shadow:0 5px 0 #b9791a,0 8px 14px rgba(0,0,0,.35);transition:transform .06s,box-shadow .06s;';
  btn.onmousedown = () => { btn.style.transform = 'translateY(4px)'; btn.style.boxShadow = '0 1px 0 #b9791a'; };
  btn.onmouseup = () => { btn.style.transform = ''; btn.style.boxShadow = '0 5px 0 #b9791a,0 8px 14px rgba(0,0,0,.35)'; };
  btn.onclick = () => { if (state === 'running') stop(); else start(); };
  document.body.appendChild(btn);

  const hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;top:88px;left:50%;transform:translateX(-50%);z-index:1290;' +
    'font-family:Poppins,system-ui,sans-serif;color:#fff;text-align:center;pointer-events:none;user-select:none;';
  document.body.appendChild(hud);

  // compass arrow to the next gate
  const arrow = document.createElement('div');
  arrow.style.cssText = 'position:fixed;top:150px;left:50%;transform:translateX(-50%);z-index:1290;' +
    'pointer-events:none;user-select:none;display:none;text-align:center;';
  arrow.innerHTML =
    '<div class="dd-dash-arrow" style="width:0;height:0;margin:0 auto;border-left:16px solid transparent;' +
    'border-right:16px solid transparent;border-bottom:28px solid #35e0ff;filter:drop-shadow(0 0 6px #35e0ff);transition:transform .1s"></div>' +
    '<div class="dd-dash-dist" style="font:700 13px Poppins,sans-serif;color:#eafcff;text-shadow:0 1px 3px rgba(0,0,0,.8);margin-top:4px"></div>';
  const arrowTri = arrow.querySelector('.dd-dash-arrow');
  const arrowDist = arrow.querySelector('.dd-dash-dist');
  document.body.appendChild(arrow);

  const bestKey = 'dd_dashBest';
  const getBest = () => { const v = parseFloat(localStorage.getItem(bestKey)); return Number.isFinite(v) ? v : null; };
  const fmt = (ms) => {
    const t = Math.max(0, ms), m = Math.floor(t / 60000), s = Math.floor((t % 60000) / 1000), cs = Math.floor((t % 1000) / 10);
    return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  };

  function renderHud() {
    if (state === 'running') {
      hud.innerHTML =
        `<div style="font-family:'Lilita One',sans-serif;font-size:34px;letter-spacing:1px;text-shadow:0 2px 6px rgba(0,0,0,.6)">${fmt(elapsed)}</div>` +
        `<div style="font-weight:700;font-size:15px;opacity:.9;text-shadow:0 1px 3px rgba(0,0,0,.7)">Checkpoint ${Math.min(activeIdx + 1, route.length)} / ${route.length}</div>`;
      btn.textContent = '✕ Quit';
    } else if (state === 'finished') {
      const best = getBest();
      hud.innerHTML =
        `<div style="font-family:'Lilita One',sans-serif;font-size:26px;color:#ffd23f;text-shadow:0 2px 6px rgba(0,0,0,.6)">FINISH!</div>` +
        `<div style="font-family:'Lilita One',sans-serif;font-size:36px;text-shadow:0 2px 6px rgba(0,0,0,.6)">${fmt(elapsed)}</div>` +
        `<div style="font-weight:700;font-size:14px;opacity:.9;text-shadow:0 1px 3px rgba(0,0,0,.7)">Best ${best != null ? fmt(best) : '—'}</div>`;
      btn.textContent = '🏁 Race again';
    } else {
      const best = getBest();
      hud.innerHTML = best != null ? `<div style="font-weight:700;font-size:12px;opacity:.7;text-shadow:0 1px 3px rgba(0,0,0,.7)">Dash best ${fmt(best)}</div>` : '';
      btn.textContent = '🏁 Start Dash';
    }
    arrow.style.display = state === 'running' ? 'block' : 'none';
  }

  // ── build the route from loaded roads (robust: relax the forward bias if a step stalls) ────────
  function buildRoute(carPx, carPz) {
    const segs = getRoadSegments ? getRoadSegments() : [];
    const cand = [];
    for (const s of segs) { const pts = s.points || []; for (let i = 0; i < pts.length; i += 2) cand.push({ wx: pts[i].x, wz: pts[i].y }); }
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
  function stop() { state = 'idle'; clearGates(); route = []; _pendingStart = false; renderHud(); }
  function finish() {
    state = 'finished';
    const best = getBest();
    if (best == null || elapsed < best) { try { localStorage.setItem(bestKey, String(Math.round(elapsed))); } catch {} }
    clearGates(); ding(880); setTimeout(() => ding(1174), 140); renderHud();
  }

  const _v = new THREE.Vector3(), _camDir = new THREE.Vector3();
  let _t = 0;
  function updateArrow(carPx, carPz) {
    const target = route[activeIdx]; if (!target) { arrow.style.display = 'none'; return; }
    arrow.style.display = 'block';
    const gx = sceneX(target.wx), gz = sceneZ(target.wz);
    const dist = Math.hypot(carPx - gx, carPz - gz);
    arrowDist.textContent = `${Math.round(dist)} m`;
    // relative bearing: camera heading vs direction to gate (horizontal)
    camera.getWorldDirection(_camDir);
    const camH = Math.atan2(_camDir.x, _camDir.z);
    const gateH = Math.atan2(gx - camera.position.x, gz - camera.position.z);
    let rel = gateH - camH;
    while (rel > Math.PI) rel -= 2 * Math.PI;
    while (rel < -Math.PI) rel += 2 * Math.PI;
    arrowTri.style.transform = `rotate(${rel}rad)`;   // 0 = straight ahead (points up)
  }

  function update(carPx, carPz, dt) {
    if (state !== 'running') return;

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
      elapsed = 0;
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
        ding(680 + activeIdx * 45); refreshGateColors();
      }
    }

    updateArrow(carPx, carPz);
    renderHud();
  }

  let _flash = null;
  function hudFlash(msg) {
    if (_flash) clearTimeout(_flash);
    arrow.style.display = 'none';
    hud.innerHTML = `<div style="font-weight:700;font-size:14px;background:rgba(0,0,0,.6);padding:9px 15px;border-radius:10px">${msg}</div>`;
    _flash = setTimeout(() => { _flash = null; renderHud(); }, 2800);
  }

  renderHud();
  return {
    update,
    dispose() { stop(); hud.remove(); btn.remove(); arrow.remove(); ringGeo.dispose(); groundRingGeo.dispose(); beamGeo.dispose(); },
    isRunning: () => state === 'running',
  };
}
