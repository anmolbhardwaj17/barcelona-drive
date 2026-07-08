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
import { fxFlash, fxBanner, fxConfetti } from './gameFx.js';
import { wallet } from './wallet.js';
import { loadCityCarTemplates } from '../car/carModels.js';

const N_COPS = 3;
const COP_SPEED = 27;        // m/s (~97 km/h) — a hair under the car's top speed, so you CAN pull away
const HEAT_DIST = 65;        // nearest cop within this ⇒ wanted rises
const BUST_DIST = 8;         // this close ⇒ busting
const BUST_HOLD = 2.6;       // s within BUST_DIST ⇒ busted
const ESCAPE_DIST = 135;     // every cop beyond this ⇒ escaping
const ESCAPE_HOLD = 7;       // s all cops beyond ESCAPE_DIST ⇒ escaped
const SPAWN_BEHIND = 42, SPAWN_SPREAD = 14;

export function createPoliceMode({ scene, getGroundY, getOrigin, audio }) {
  let state = 'idle';          // idle | chase | ended
  let cops = [];
  let wanted = 0, peakWanted = 0, elapsed = 0, escapeT = 0, bustT = 0;
  let _pending = false, _t = 0, best = 0;

  const worldFromScene = (px, pz) => ({ wx: getOrigin().x - px, wz: pz + getOrigin().z });
  const groundY = (px, pz) => { const w = worldFromScene(px, pz); return getGroundY ? (getGroundY(w.wx, w.wz) || 0) : 0; };

  const bestKey = 'dd_policeBest';
  best = (() => { const v = parseFloat(localStorage.getItem(bestKey)); return Number.isFinite(v) ? v : 0; })();

  // ── cop car resources ──
  let _tpl = null;
  const copMat = new THREE.MeshLambertMaterial({ color: 0x16233f });   // dark police blue
  const barMat = new THREE.MeshBasicMaterial({ color: 0xff2233, fog: false });
  loadCityCarTemplates().then((tpls) => { if (tpls && tpls.length) _tpl = tpls[(Math.random() * tpls.length) | 0]; }).catch(() => {});

  function makeCop() {
    const g = new THREE.Group();
    const carH = _tpl ? _tpl.dims.h : 1.3;
    const body = _tpl ? new THREE.Mesh(_tpl.geometry, copMat) : new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.2, 4.3), copMat);
    if (!_tpl) body.position.y = 0.6;
    body.castShadow = false; g.add(body);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.22, 0.32), barMat);
    bar.position.set(0, carH + 0.12, 0);
    g.add(bar);
    g.frustumCulled = false;
    scene.add(g);
    return { group: g, x: 0, z: 0, yaw: 0 };
  }

  // ── HUD ──
  const hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;top:112px;left:12px;z-index:1000;font:600 13px Poppins,system-ui,sans-serif;color:#fff;background:rgba(0,0,0,0.5);padding:9px 12px;border-radius:10px;display:none;min-width:190px;';
  document.body.appendChild(hud);
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:86px;left:50%;transform:translateX(-50%);z-index:1000;font:800 26px Poppins,system-ui,sans-serif;text-shadow:0 3px 12px rgba(0,0,0,.5);display:none;text-align:center;';
  document.body.appendChild(banner);

  function renderHud() {
    const active = state === 'chase';
    hud.style.display = active || state === 'ended' ? 'block' : 'none';
    banner.style.display = 'none';
    if (state === 'ended') {
      hud.innerHTML = `<div style="font-size:15px;color:#ff5a5a;font-weight:800">🚨 Pursuit over</div>` +
        `<div style="margin-top:3px">best escape ${Math.round(best)}s</div>`;
    }
  }

  function pips(v) { const n = Math.round(v / 20); return '★'.repeat(n) + '☆'.repeat(5 - n); }

  function updateHud(nearest) {
    if (state !== 'chase') return;
    const barW = Math.round(wanted);
    hud.innerHTML =
      `<div style="font-weight:800;color:#ff5a5a">🚨 WANTED ${pips(wanted)}</div>` +
      `<div style="margin-top:5px;height:8px;width:100%;background:rgba(255,255,255,.15);border-radius:4px;overflow:hidden">` +
        `<div style="height:100%;width:${barW}%;background:linear-gradient(90deg,#ffb347,#ff3b3b)"></div></div>` +
      `<div style="margin-top:6px;opacity:.9">⏱️ ${elapsed.toFixed(0)}s &nbsp; 🚓 ${cops.length} &nbsp; ${Math.round(nearest)}m</div>`;
    if (bustT > 0.3) {
      banner.style.display = 'block'; banner.style.color = '#ff4444';
      banner.textContent = `🚨 BUSTED IN ${Math.max(0, BUST_HOLD - bustT).toFixed(1)}s`;
    } else if (escapeT > 0.3) {
      banner.style.display = 'block'; banner.style.color = '#8ef0b0';
      banner.textContent = `🏁 LOSING THEM… ${Math.max(0, ESCAPE_HOLD - escapeT).toFixed(1)}s`;
    } else banner.style.display = 'none';
  }

  function ding(f, g = 0.16) {
    try { const c = audio?.ctx?.(); if (!c) return; const o = c.createOscillator(), gn = c.createGain();
      o.type = 'sawtooth'; o.frequency.value = f; gn.gain.setValueAtTime(0.0001, c.currentTime);
      gn.gain.exponentialRampToValueAtTime(g, c.currentTime + 0.02); gn.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.3);
      o.connect(gn); gn.connect(audio.sfxBus?.() || c.destination); o.start(); o.stop(c.currentTime + 0.32);
    } catch {}
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
      cop.group.position.set(cop.x, groundY(cop.x, cop.z), cop.z);
      cops.push(cop);
    }
  }
  function clearCops() { for (const c of cops) scene.remove(c.group); cops = []; }

  function start() { _pending = true; state = 'chase'; wanted = 0; peakWanted = 0; elapsed = 0; escapeT = 0; bustT = 0; renderHud(); }
  function stop() {
    if (state === 'chase' && elapsed > 3) { state = 'ended'; renderHud(); setTimeout(() => { if (state === 'ended') { state = 'idle'; renderHud(); } }, 7000); }
    else { state = 'idle'; renderHud(); }
    clearCops(); banner.style.display = 'none';
  }

  function escaped() {
    const payout = Math.round(25 + elapsed * 1.6 + peakWanted * 0.8);
    wallet.add(payout);
    if (elapsed > best) { best = elapsed; try { localStorage.setItem(bestKey, String(Math.round(best))); } catch {} }
    fxBanner(`<div style="font-size:30px;color:#8ef0b0">🏁 ESCAPED!</div>` +
             `<div style="font-size:46px;color:#ffd23f;margin-top:2px">+$${payout}</div>` +
             `<div style="font-size:16px;opacity:.85">${elapsed.toFixed(0)}s · wanted ${pips(peakWanted)}</div>`, { duration: 2200, top: '30%' });
    fxConfetti(34, ['#8ef0b0', '#ffd23f', '#ffffff'], 0.4); fxFlash('rgba(46,224,106,.16)'); ding(880);
    clearCops();
    setTimeout(() => { if (state === 'chase') { _pending = true; wanted = 0; peakWanted = 0; elapsed = 0; escapeT = 0; bustT = 0; } }, 1600);
  }
  function busted() {
    fxBanner('<div style="font-size:34px;color:#ff4444">🚨 BUSTED!</div>', { duration: 2000, top: '32%' });
    fxFlash('rgba(255,50,50,.25)'); ding(180, 0.22);
    clearCops();
    setTimeout(() => { if (state === 'chase') { _pending = true; wanted = 0; peakWanted = 0; elapsed = 0; escapeT = 0; bustT = 0; } }, 1800);
  }

  function update(playerPx, playerPz, dt, speedKmh, headingDeg) {
    if (state !== 'chase') return;
    if (_pending) { _pending = false; spawnCops(playerPx, playerPz, headingDeg); fxBanner('<span style="font-size:30px;color:#ff5a5a">🚨 BUSTED? NOT YET — RUN!</span>', { duration: 1500, top: '30%' }); ding(440); }
    _t += dt; elapsed += dt;
    if (!cops.length) return;

    // flashing light bar (shared material → all cops blink together)
    barMat.color.setHex(((_t * 5) | 0) % 2 ? 0xff2233 : 0x2a5cff);

    let nearest = Infinity;
    for (const cop of cops) {
      const dx = playerPx - cop.x, dz = playerPz - cop.z;
      const dl = Math.hypot(dx, dz) || 1;
      cop.x += (dx / dl) * COP_SPEED * dt;
      cop.z += (dz / dl) * COP_SPEED * dt;
      cop.yaw = Math.atan2(dx, dz);
      cop.group.position.set(cop.x, groundY(cop.x, cop.z), cop.z);
      cop.group.rotation.y = cop.yaw;
      if (dl < nearest) nearest = dl;
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
    dispose() { stop(); hud.remove(); banner.remove(); copMat.dispose(); barMat.dispose(); },
    isRunning: () => state === 'chase',
  };
}
