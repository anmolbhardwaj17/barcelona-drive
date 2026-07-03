/**
 * dashMode.js — "Checkpoint Dash" time-trial game mode.
 *
 * Press START → a chain of glowing gates is laid along the loaded road network. Drive through them in
 * order against a running clock; a pillar of light marks the next gate so it's findable from afar. Clear
 * the last gate to finish; your best time is saved (localStorage dd_dashBest).
 *
 * Frames: the car position handed to update() is in the PHYSICS/scene frame (lp.lx, lp.lz). Road points
 * from getRoadSegments() are WORLD coords. Conversion matches trafficSystem: px=-(wx-ox), pz=wz-oz. Gate
 * meshes live in `scene` (physics frame), same as the cars, so they sit on the road with the traffic.
 */
import * as THREE from 'three';

const N_CHECKPOINTS = 6;
const MIN_GAP = 90;      // metres between consecutive gates
const MAX_GAP = 210;
const HIT_RADIUS = 15;   // how close the car must get to clear a gate
const GATE_RING_R = 4.2; // ring radius (spans a lane-ish)

const COL_NEXT = 0x35e0ff;   // active gate — cyan
const COL_AFTER = 0xffc233;  // the one after — gold (dimmer)

export function createDashMode({ scene, getRoadSegments, getGroundY, getOrigin, audio }) {
  let state = 'idle';               // idle | running | finished
  let route = [];                   // [{wx, wz}]
  let activeIdx = 0;
  let startT = 0, elapsed = 0;
  const gates = [];                 // parallel to route: { group, world:{wx,wz} } | null once cleared

  // ── shared gate geometry/materials ────────────────────────────────────────
  const ringGeo = new THREE.TorusGeometry(GATE_RING_R, 0.35, 8, 24);
  const beamGeo = new THREE.CylinderGeometry(GATE_RING_R * 0.9, GATE_RING_R * 1.2, 60, 16, 1, true);

  function gateMaterials(hex) {
    const ring = new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.95, fog: false });
    const beam = new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    return { ring, beam };
  }

  // ── coordinate helpers ────────────────────────────────────────────────────
  const sceneX = (wx) => -(wx - getOrigin().x);
  const sceneZ = (wz) => wz - getOrigin().z;
  const worldFromScene = (px, pz) => ({ wx: getOrigin().x - px, wz: pz + getOrigin().z });

  // ── HUD ───────────────────────────────────────────────────────────────────
  const hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;top:70px;left:50%;transform:translateX(-50%);z-index:1200;' +
    'font-family:Poppins,system-ui,sans-serif;color:#fff;text-align:center;pointer-events:none;user-select:none;';
  document.body.appendChild(hud);

  const btn = document.createElement('button');
  btn.textContent = '🏁 Start Dash';
  btn.style.cssText = 'position:fixed;top:70px;left:50%;transform:translateX(-50%);z-index:1200;cursor:pointer;' +
    'font-family:Poppins,system-ui,sans-serif;font-weight:700;font-size:15px;color:#241a08;' +
    'background:linear-gradient(#ffd23f,#f5a623);border:none;border-radius:24px;padding:10px 22px;' +
    'box-shadow:0 5px 0 #b9791a,0 8px 14px rgba(0,0,0,.35);transition:transform .06s,box-shadow .06s;';
  btn.onmousedown = () => { btn.style.transform = 'translateX(-50%) translateY(4px)'; btn.style.boxShadow = '0 1px 0 #b9791a'; };
  btn.onmouseup = () => { btn.style.transform = 'translateX(-50%)'; btn.style.boxShadow = '0 5px 0 #b9791a,0 8px 14px rgba(0,0,0,.35)'; };
  btn.onclick = () => { if (state === 'running') stop(); else start(); };
  document.body.appendChild(btn);

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
        `<div style="font-weight:700;font-size:15px;opacity:.9;text-shadow:0 1px 3px rgba(0,0,0,.7)">Checkpoint ${activeIdx + 1} / ${route.length}</div>`;
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
      hud.innerHTML = best != null
        ? `<div style="font-weight:700;font-size:13px;opacity:.75;margin-top:-2px;text-shadow:0 1px 3px rgba(0,0,0,.7)">Best ${fmt(best)}</div>`
        : '';
      btn.textContent = '🏁 Start Dash';
    }
    // keep the button below the timer text
    btn.style.top = (state === 'idle') ? '70px' : (state === 'finished' ? '190px' : '150px');
  }

  // ── build the route from loaded roads ─────────────────────────────────────
  function buildRoute(carPx, carPz) {
    const segs = getRoadSegments ? getRoadSegments() : [];
    const cand = [];
    for (const s of segs) {
      const pts = s.points || [];
      for (let i = 0; i < pts.length; i += 2) cand.push({ wx: pts[i].x, wz: pts[i].y });
    }
    if (cand.length < 4) return [];

    const start = worldFromScene(carPx, carPz);
    let cur = start, heading = null;
    const chosen = [];
    for (let k = 0; k < N_CHECKPOINTS; k++) {
      let best = null, bestScore = -Infinity;
      for (const c of cand) {
        const dx = c.wx - cur.wx, dz = c.wz - cur.wz;
        const d = Math.hypot(dx, dz);
        if (d < MIN_GAP || d > MAX_GAP) continue;
        // avoid landing near an already-chosen gate
        let tooClose = false;
        for (const ch of chosen) { if (Math.hypot(c.wx - ch.wx, c.wz - ch.wz) < MIN_GAP * 0.7) { tooClose = true; break; } }
        if (tooClose) continue;
        const nx = dx / d, nz = dz / d;
        const fwd = heading ? (nx * heading.x + nz * heading.z) : 0.3;   // prefer continuing forward
        const score = fwd * 1.0 + (d / MAX_GAP) * 0.3 + Math.random() * 0.25;
        if (score > bestScore) { bestScore = score; best = { c, nx, nz }; }
      }
      if (!best) break;
      chosen.push(best.c);
      heading = { x: best.nx, z: best.nz };
      cur = best.c;
    }
    return chosen;
  }

  function makeGate(world, hex, dirWorld) {
    const group = new THREE.Group();
    const { ring, beam } = gateMaterials(hex);
    const ringMesh = new THREE.Mesh(ringGeo, ring);
    // orient the ring so its axis (local Z) points along the road → you drive THROUGH it
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dirWorld.clone().normalize());
    ringMesh.quaternion.copy(q);
    ringMesh.position.y = GATE_RING_R + 0.3;
    group.add(ringMesh);
    const beamMesh = new THREE.Mesh(beamGeo, beam);
    beamMesh.position.y = 30;
    group.add(beamMesh);
    const gy = getGroundY ? (getGroundY(world.wx, world.wz) || 0) : 0;
    group.position.set(sceneX(world.wx), gy, sceneZ(world.wz));
    group.userData = { ring, beam, ringMesh };
    scene.add(group);
    return group;
  }

  function clearGates() { for (const g of gates) { if (g) { scene.remove(g.group); g.group.userData.ring.dispose(); g.group.userData.beam.dispose(); } } gates.length = 0; }

  function refreshGateColors() {
    for (let i = 0; i < gates.length; i++) {
      const g = gates[i]; if (!g) continue;
      const isNext = i === activeIdx;
      const isAfter = i === activeIdx + 1;
      g.group.visible = isNext || isAfter;   // only show the next two to keep it readable
      g.group.userData.ring.color.setHex(isNext ? COL_NEXT : COL_AFTER);
      g.group.userData.beam.color.setHex(isNext ? COL_NEXT : COL_AFTER);
      g.group.userData.beam.opacity = isNext ? 0.16 : 0.08;
    }
  }

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
  let _pendingStart = false, _startPx = 0, _startPz = 0;
  function start() {
    // route is built on the next update() when we know the live car position
    _pendingStart = true;
    state = 'running'; activeIdx = 0; elapsed = 0;
    renderHud();
  }
  function stop() {
    state = 'idle'; clearGates(); route = []; _pendingStart = false;
    renderHud();
  }
  function finish() {
    state = 'finished';
    const best = getBest();
    if (best == null || elapsed < best) { try { localStorage.setItem(bestKey, String(Math.round(elapsed))); } catch {} }
    clearGates();
    ding(880); setTimeout(() => ding(1174), 140);
    renderHud();
  }

  let _t = 0;
  function update(carPx, carPz, dt) {
    if (state !== 'running') return;

    if (_pendingStart) {
      route = buildRoute(carPx, carPz);
      _pendingStart = false;
      if (route.length < 2) { state = 'idle'; hudFlash('No roads loaded here — drive into the city and retry'); renderHud(); return; }
      // build gate meshes, each oriented toward the next
      clearGates();
      for (let i = 0; i < route.length; i++) {
        const from = i === 0 ? worldFromScene(carPx, carPz) : route[i - 1];
        const dir = new THREE.Vector3(sceneX(route[i].wx) - sceneX(from.wx), 0, sceneZ(route[i].wz) - sceneZ(from.wz));
        if (dir.lengthSq() < 1e-3) dir.set(0, 0, 1);
        gates.push({ group: makeGate(route[i], i === 0 ? COL_NEXT : COL_AFTER, dir), world: route[i] });
      }
      refreshGateColors();
      startT = 0; elapsed = 0;
    }

    elapsed += dt * 1000;
    _t += dt;

    // animate the active gate (gentle pulse + spin)
    const g = gates[activeIdx];
    if (g) {
      const s = 1 + Math.sin(_t * 4) * 0.06;
      g.group.userData.ringMesh.scale.set(s, s, s);
      g.group.userData.ringMesh.rotateZ(dt * 1.2);
    }

    // hit test against the active gate
    const target = route[activeIdx];
    if (target) {
      const gx = sceneX(target.wx), gz = sceneZ(target.wz);
      if (Math.hypot(carPx - gx, carPz - gz) < HIT_RADIUS) {
        // clear it
        if (gates[activeIdx]) { scene.remove(gates[activeIdx].group); }
        activeIdx++;
        if (activeIdx >= route.length) { finish(); return; }
        ding(660 + activeIdx * 40);
        refreshGateColors();
      }
    }

    renderHud();
  }

  let _flash = null;
  function hudFlash(msg) {
    if (_flash) clearTimeout(_flash);
    hud.innerHTML = `<div style="font-weight:700;font-size:14px;background:rgba(0,0,0,.55);padding:8px 14px;border-radius:10px">${msg}</div>`;
    _flash = setTimeout(() => { _flash = null; renderHud(); }, 2600);
  }

  renderHud();
  return {
    update,
    dispose() { stop(); hud.remove(); btn.remove(); ringGeo.dispose(); beamGeo.dispose(); },
    isRunning: () => state === 'running',
  };
}
