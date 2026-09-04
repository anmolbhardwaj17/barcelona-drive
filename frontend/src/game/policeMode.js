/**
 * policeMode.js — "Heat" police pursuit.
 *
 * A squad of cop cars spawns behind you and gives chase. The WANTED meter climbs while they're on your
 * tail and cools when you open a gap. Shake every cop (open a big lead and hold it) to ESCAPE for a payout
 * that scales with how long you survived and how hot it got. Let them box you in and you get BUSTED.
 *
 * Cop cars are visual seekers (no physics) that reuse a city-car mesh in police livery. Frame: car pos is
 * the physics/scene frame (lp.lx, lp.lz); cops live in `scene` at that frame.
 */
import * as THREE from 'three';
import { fxFlash, fxEvent, fxConfetti } from './gameFx.js';
import { createStatCard, createResultCard } from './hudTheme.js';
import { pursuitPay } from './economy.js';
import { wallet } from './wallet.js';
import { loadCityCarTemplates } from '../car/carModels.js';

const N_COPS = 3;
const COP_SPEED = 27;        // m/s (~97 km/h) — a hair under the car's top speed, so you CAN pull away
const HEAT_DIST = 65;        // nearest cop within this ⇒ wanted rises
const BUST_DIST = 8;         // this close ⇒ busting
const BUST_HOLD = 2.6;       // s within BUST_DIST ⇒ busted
const ESCAPE_DIST = 135;     // every cop beyond this ⇒ escaping
const ESCAPE_HOLD = 7;       // s all cops beyond ESCAPE_DIST ⇒ escaped
const CATCH_GAP = 4.5;       // cops stop pushing once this close (tuck in behind — don't ram/stack)
const SLOW_RANGE = 16;       // within this they ease off full speed down to a stop at CATCH_GAP
const SEP_DIST = 7;          // min gap between two cops (separation so they don't merge)
const TURN_RATE = 2.6;       // rad/s max steering — cops can only drive FORWARD + turn (no sideways slide)
const ACCEL = 3.0;           // how fast a cop's speed eases to its target
const SPAWN_BEHIND = 42, SPAWN_SPREAD = 14;

export function createPoliceMode({ scene, getMinimap, getGroundY, getOrigin, audio }) {
  let state = 'idle';          // idle | chase | ended
  let cops = [];
  let wanted = 0, peakWanted = 0, elapsed = 0, escapeT = 0, bustT = 0;
  let _pending = false, _t = 0, best = 0;

  const worldFromScene = (px, pz) => ({ wx: getOrigin().x - px, wz: pz + getOrigin().z });
  const groundY = (px, pz) => { const w = worldFromScene(px, pz); return getGroundY ? (getGroundY(w.wx, w.wz) || 0) : 0; };

  const bestKey = 'dd_policeBest';
  best = (() => { const v = parseFloat(localStorage.getItem(bestKey)); return Number.isFinite(v) ? v : 0; })();

  // ── cop car resources ── use the actual police.glb (its own livery — no tint).
  let _tpl = null;
  const fallbackMat = new THREE.MeshLambertMaterial({ color: 0x2a3a6a });
  const redLightMat = new THREE.MeshBasicMaterial({ color: 0xff2233, fog: false });
  const blueLightMat = new THREE.MeshBasicMaterial({ color: 0x2a5cff, fog: false });
  const barGeo = new THREE.BoxGeometry(0.24, 0.16, 0.3);
  loadCityCarTemplates().then((tpls) => { _tpl = (tpls || []).find((t) => t.name === 'police') || (tpls || [])[0] || null; }).catch(() => {});

  function makeCop() {
    const g = new THREE.Group();
    const carH = _tpl ? _tpl.dims.h : 1.3;
    const body = _tpl ? new THREE.Mesh(_tpl.geometry, _tpl.material) : new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.2, 4.3), fallbackMat);
    // v3 P4-15a: car geometry is now SHARED and built once at CANON_LENGTH, so a loose Mesh has to
    // apply the template's scale itself. Skipping this silently renders cop cars at the wrong size.
    if (_tpl) body.scale.setScalar(_tpl.scale);
    if (!_tpl) body.position.y = 0.6;
    body.castShadow = false; g.add(body);
    // small flashing roof lights (red + blue) on top of the model's own bar
    const rl = new THREE.Mesh(barGeo, redLightMat); rl.position.set(-0.24, carH + 0.08, 0); g.add(rl);
    const bl = new THREE.Mesh(barGeo, blueLightMat); bl.position.set(0.24, carH + 0.08, 0); g.add(bl);
    g.frustumCulled = false;
    scene.add(g);
    return { group: g, x: 0, z: 0, yaw: 0, speed: 0 };
  }

  // ── HUD ────────────────────────────────────────────────────────────────────────────────────
  // Was a `rgba(0,0,0,.5)` box at top-left reading `🚨 WANTED ★★★☆☆` over `⏱️ 12s  🚓 3  20m` — four
  // emoji doing the work of labels, a star rating spelled out in ★/☆ code points, and a centre
  // banner in a fifth style. Shared cards now, in the same top-right rail as every other mode.
  const COL_HEAT = '#ff5a5a';
  const card = createStatCard({ label: 'WANTED', color: COL_HEAT, rail: true });
  const result = createResultCard({ color: COL_HEAT });

  // ⚠ NO CENTRE CARD IN HEAT — tried in M-8, removed the same day at the user's request: *"i dont
  // think i need this gaining and losing card at all"*. It showed an arrow pointing away from the
  // nearest unit and a Closing/Gaining kicker, and the honest read is that neither told you anything
  // the siren, the flashing lights in the mirror and the minimap blips were not already saying —
  // three cues for one fact, and the card was the only one you had to take your eyes off the road
  // to use. `objectiveHud.setInstruction()` went with it rather than being left as dead API.

  // The bust/escape countdown keeps its own centre slot: it is a LIVE timer, not an event, so it
  // cannot go through fxEvent (which plays once and leaves).
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:96px;left:50%;transform:translateX(-50%);z-index:1291;display:none;' +
    'font:800 13px/1 Inter,system-ui,sans-serif;letter-spacing:.22em;text-transform:uppercase;text-align:center;' +
    'padding:10px 18px;border-radius:14px;pointer-events:none;user-select:none;' +
    'background:linear-gradient(168deg,rgba(14,18,26,.93),rgba(9,12,18,.93));' +
    'border:1px solid rgba(255,255,255,.13);box-shadow:0 10px 30px rgba(0,0,0,.5);';
  document.body.appendChild(banner);

  function renderHud() {
    const active = state === 'chase';
    card.show(active);
    banner.style.display = 'none';
    if (state === 'ended') {
      result.show({
        kicker: 'Pursuit over',
        value: `${Math.round(elapsed)}s`,
        stats: [
          { label: 'peak wanted', value: `${stars(peakWanted)}/5` },
          { label: 'best escape', value: `${Math.round(Math.max(best, elapsed))}s` },
        ],
      });
    } else {
      result.hide();
    }
  }

  /** Wanted level 0-5 as a NUMBER, not a string of ★/☆ code points in whatever font the OS picks. */
  function stars(v) { return Math.round(v / 20); }

  function updateHud(nearest) {
    if (state !== 'chase') return;
    const n = stars(wanted);
    // The label IS the rating — "WANTED 3/5" — and the meter under it is the heat bar those five
    // ★/☆ glyphs were approximating.
    card.setLabel(`WANTED ${n}/5`);
    // The nearest-unit distance comes BACK here now the centre card is gone. Rounded to 5 m: at 46 m
    // the last digit changes every frame and reads as a fault, and nobody navigates by the metre
    // while being chased.
    card.set(`${elapsed.toFixed(0)}s`,
      `${cops.length} ${cops.length === 1 ? 'unit' : 'units'} · nearest ${Math.round(nearest / 5) * 5} m`);
    card.meter(wanted / 100, `${Math.round(wanted)}%`, n >= 4 ? '#ff3b3b' : n >= 2 ? '#ffb347' : '#ffd23f');

    if (bustT > 0.3) {
      banner.style.display = 'block'; banner.style.color = COL_HEAT;
      banner.textContent = `Busted in ${Math.max(0, BUST_HOLD - bustT).toFixed(1)}s`;
    } else if (escapeT > 0.3) {
      banner.style.display = 'block'; banner.style.color = '#2ee06a';
      banner.textContent = `Losing them — ${Math.max(0, ESCAPE_HOLD - escapeT).toFixed(1)}s`;
    } else banner.style.display = 'none';
  }

  function ding(f, g = 0.16) {
    try { const c = audio?.ctx?.(); if (!c) return; const o = c.createOscillator(), gn = c.createGain();
      o.type = 'sawtooth'; o.frequency.value = f; gn.gain.setValueAtTime(0.0001, c.currentTime);
      gn.gain.exponentialRampToValueAtTime(g, c.currentTime + 0.02); gn.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.3);
      o.connect(gn); gn.connect(audio.sfxBus?.() || c.destination); o.start(); o.stop(c.currentTime + 0.32);
    } catch {}
  }

  // Looping two-tone siren (played the whole pursuit; gets louder as the nearest cop closes in).
  let _siren = null;
  function startSiren() {
    const c = audio?.ctx?.(); if (!c || _siren) return;
    const osc = c.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 650;   // soft, not a harsh saw
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400; lp.Q.value = 0.7;
    const g = c.createGain(); g.gain.value = 0.0001;
    osc.connect(lp); lp.connect(g); g.connect(audio.sfxBus?.() || c.destination);
    try { osc.start(); } catch {}
    _siren = { osc, g };
  }
  function stopSiren() {
    const s = _siren; _siren = null; if (!s) return;
    const c = audio?.ctx?.(); if (!c) return;
    s.g.gain.cancelScheduledValues(c.currentTime); s.g.gain.setTargetAtTime(0.0001, c.currentTime, 0.12);
    try { s.osc.stop(c.currentTime + 0.35); } catch {}
  }

  function spawnCops(playerPx, playerPz, headingDeg) {
    clearCops();
    const h = (headingDeg || 0) * Math.PI / 180;
    const back = { x: -Math.sin(h), z: -Math.cos(h) };   // behind the car
    const side = { x: Math.cos(h), z: -Math.sin(h) };
    for (let i = 0; i < N_COPS; i++) {
      const off = (i - (N_COPS - 1) / 2) * SPAWN_SPREAD;
      const cop = makeCop();
      cop.x = playerPx + back.x * SPAWN_BEHIND + side.x * off;
      cop.z = playerPz + back.z * SPAWN_BEHIND + side.z * off;
      cop.yaw = Math.atan2(playerPx - cop.x, playerPz - cop.z);   // face the target
      cop.speed = COP_SPEED * 0.6;
      cop.group.position.set(cop.x, groundY(cop.x, cop.z), cop.z);
      cop.group.rotation.y = cop.yaw;
      cops.push(cop);
    }
  }
  function clearCops() { for (const c of cops) scene.remove(c.group); cops = []; getMinimap?.()?.setBlips?.([]); }

  function start() { _pending = true; state = 'chase'; wanted = 0; peakWanted = 0; elapsed = 0; escapeT = 0; bustT = 0; startSiren(); renderHud(); }
  function stop() {
    if (state === 'chase' && elapsed > 3) { state = 'ended'; renderHud(); setTimeout(() => { if (state === 'ended') { state = 'idle'; renderHud(); } }, 7000); }
    else { state = 'idle'; renderHud(); }
    clearCops(); stopSiren(); banner.style.display = 'none';
  }

  function escaped() {
    const payout = pursuitPay(elapsed, peakWanted);
    wallet.add(payout);
    if (elapsed > best) { best = elapsed; try { localStorage.setItem(bestKey, String(Math.round(best))); } catch {} }
    fxEvent({ kicker: 'Escaped', title: 'You lost them', amount: `+$${payout}`,
              sub: `${elapsed.toFixed(0)}s on the run · peak wanted ${stars(peakWanted)}/5`,
              color: '#2ee06a', duration: 2300 });
    fxConfetti(34, ['#8ef0b0', '#ffd23f', '#ffffff'], 0.4); fxFlash('rgba(46,224,106,.16)'); ding(880);
    clearCops();
    setTimeout(() => { if (state === 'chase') { _pending = true; wanted = 0; peakWanted = 0; elapsed = 0; escapeT = 0; bustT = 0; } }, 1600);
  }
  function busted() {
    fxEvent({ kicker: 'Pursuit over', title: 'Busted', sub: `${elapsed.toFixed(0)}s on the run`,
              color: COL_HEAT, duration: 2200 });
    fxFlash('rgba(255,50,50,.25)'); ding(180, 0.22);
    clearCops();
    setTimeout(() => { if (state === 'chase') { _pending = true; wanted = 0; peakWanted = 0; elapsed = 0; escapeT = 0; bustT = 0; } }, 1800);
  }

  function update(playerPx, playerPz, dt, speedKmh, headingDeg) {
    if (state !== 'chase') return;
    if (_pending) { _pending = false; spawnCops(playerPx, playerPz, headingDeg); fxEvent({ kicker: 'Heat', title: 'Police on you', sub: 'Lose them', color: COL_HEAT, duration: 1600 }); ding(440); }
    _t += dt; elapsed += dt;
    if (!cops.length) { if (_siren) { const c = audio.ctx(); _siren.g.gain.setTargetAtTime(0.015, c.currentTime, 0.2); } return; }

    // flashing roof lights (shared materials → all cops blink together)
    const on = ((_t * 4) | 0) % 2;
    redLightMat.color.setHex(on ? 0xff2233 : 0x3a0008);
    blueLightMat.color.setHex(on ? 0x081038 : 0x2a5cff);

    let nearest = Infinity;
    for (const cop of cops) {
      const dx = playerPx - cop.x, dz = playerPz - cop.z, dl = Math.hypot(dx, dz) || 1;
      // desired direction = toward the car + separation from nearby cops (so they spread, not merge)
      let tgx = dx / dl, tgz = dz / dl;
      for (const o of cops) {
        if (o === cop) continue;
        const ox = cop.x - o.x, oz = cop.z - o.z, od = Math.hypot(ox, oz);
        if (od > 0.01 && od < SEP_DIST) { const w = (SEP_DIST - od) / SEP_DIST * 1.3; tgx += (ox / od) * w; tgz += (oz / od) * w; }
      }
      // steer the heading toward the desired direction at a limited rate (a car can't snap sideways)
      const want = Math.atan2(tgx, tgz);
      let da = want - cop.yaw; da = ((da + Math.PI) % (Math.PI * 2)) - Math.PI; if (da < -Math.PI) da += Math.PI * 2;
      const maxTurn = TURN_RATE * dt;
      cop.yaw += Math.max(-maxTurn, Math.min(maxTurn, da));
      // target speed: full when far, ease to a stop as we tuck in behind; also back off when facing away
      let tsp = COP_SPEED;
      if (dl < SLOW_RANGE) tsp *= Math.max(0, (dl - CATCH_GAP) / (SLOW_RANGE - CATCH_GAP));
      tsp *= Math.max(0.25, Math.cos(da));   // slow through hard turns instead of drifting sideways
      cop.speed += (tsp - cop.speed) * Math.min(1, ACCEL * dt);
      // drive FORWARD along the heading
      cop.x += Math.sin(cop.yaw) * cop.speed * dt;
      cop.z += Math.cos(cop.yaw) * cop.speed * dt;
      cop.group.position.set(cop.x, groundY(cop.x, cop.z), cop.z);
      cop.group.rotation.y = cop.yaw;
      if (dl < nearest) nearest = dl;
    }
    // Show cops on the minimap (red blips).
    getMinimap?.()?.setBlips?.(cops.map((cop) => { const w = worldFromScene(cop.x, cop.z); return { wx: w.wx, wz: w.wz, color: '#ff3b3b' }; }));

    // siren — two-tone nee-naw, louder as the nearest cop closes in
    if (_siren) {
      const c = audio.ctx();
      _siren.osc.frequency.setTargetAtTime(((_t * 1.2) | 0) % 2 ? 820 : 600, c.currentTime, 0.06);   // gentle nee-naw
      _siren.g.gain.setTargetAtTime(0.014 + 0.028 * Math.max(0, 1 - nearest / 130), c.currentTime, 0.15);  // quiet
    }

    // wanted rises while a cop is in heat range (faster the closer); slowly cools otherwise.
    if (nearest < HEAT_DIST) wanted = Math.min(100, wanted + (1 - nearest / HEAT_DIST) * 26 * dt);
    else wanted = Math.max(0, wanted - 6 * dt);
    peakWanted = Math.max(peakWanted, wanted);

    // bust / escape timers
    if (nearest < BUST_DIST) { bustT += dt; if (bustT >= BUST_HOLD) { busted(); return; } }
    else bustT = Math.max(0, bustT - dt * 2);
    if (nearest > ESCAPE_DIST) { escapeT += dt; if (escapeT >= ESCAPE_HOLD) { escaped(); return; } }
    else escapeT = 0;

    updateHud(nearest);
  }

  renderHud();
  return {
    name: 'Heat', icon: '🚨', key: 'police',
    update, start, stop,
    dispose() { stop(); card.remove(); result.remove(); banner.remove(); fallbackMat.dispose(); redLightMat.dispose(); blueLightMat.dispose(); barGeo.dispose(); },
    isRunning: () => state === 'chase',
  };
}
