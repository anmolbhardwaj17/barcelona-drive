/**
 * styleSystem — arcade "style" scoring that runs continuously while driving (all car modes, free-roam too).
 * Rewards the moment-to-moment fun a gamer wants: DRIFT, BIG AIR, NEAR MISS, and sustained SPEED build a
 * live combo multiplier with floating popups, screen shake, and sfx. When you ease off (or wreck), the combo
 * BANKS: style points convert to driver XP (and can trigger a LEVEL UP). Turns the whole city into a playground.
 *
 * Decoupled by design: reads car state (drift/skid/wheels/speed) via params, queries traffic & pedestrians
 * through injected getNearby() accessors, and awards XP via the xp singleton. No physics/render coupling.
 *
 *   const style = createStyleSystem({ camera, audio, getTraffic, getPedestrians });
 *   style.update(px, pz, dt, speedKmh, { drift, skid, wheels });   // every frame in car mode (skip cinematics)
 *
 * Tricks pay XP (driver progression), NOT money — cash stays tied to actual jobs (taxi/delivery/police).
 */
import { xp } from './xp.js';
import { driftState } from './driftState.js';

// ── Tuning ──────────────────────────────────────────────────────────────────
const COMBO_WINDOW   = 3.2;   // s of no events before the combo banks
const MAX_MULT       = 10;
const EVENTS_PER_MULT = 2;    // +1x every N discrete events

const DRIFT_MIN_KMH  = 22;
const DRIFT_SLIDE    = 0.30;  // max(driftFactor, skidLevel) above this = drifting
const DRIFT_RATE     = 46;    // pts/s base (scaled by speed, slide amount, and the current tier multiplier)
const DRIFT_MIN_PTS  = 60;    // don't bank a chain for a tiny twitch

const AIR_MIN_T      = 0.35;  // s airborne to count as a jump
const AIR_RATE       = 300;   // pts per second of air time

const NEARMISS_R      = 5.2;  // m — enter the near-miss tracking zone
const NEARMISS_HIT_R  = 2.3;  // m — closer than this is a real contact, not a "miss"
const NEARMISS_MIN_KMH = 38;
const NEARMISS_CAR   = 200;
const NEARMISS_PED   = 130;

const SPEED_KMH      = 145;   // sustained speed keeps the combo warm (small trickle)
const SPEED_RATE     = 22;

const WRECK_DROP_KMH = 25;    // single-frame speed loss this big = a wreck (wall hit, not braking)

const MAX_SHAKE_M    = 0.28;  // camera shake at full trauma
const TRAUMA_DECAY   = 1.9;   // trauma units per second

// ── Drift chain — hold/link a slide to climb tiers; longer = exponentially more points ("keep it lit"). ──
const DRIFT_GRACE    = 1.25;  // s the chain survives a brief straighten → link corners without losing it
// [seconds-held threshold, name, points-multiplier, smoke colour]. Highest tier whose time ≤ held wins.
const DRIFT_TIERS = [
  { t: 0.0,  name: 'DRIFT',     mult: 1,   color: 0xffffff, hex: '#ffffff' },
  { t: 2.0,  name: 'NICE',      mult: 1.5, color: 0xfff07a, hex: '#fff07a' },
  { t: 4.0,  name: 'GREAT',     mult: 2,   color: 0xffc24a, hex: '#ffc24a' },
  { t: 6.5,  name: 'AWESOME',   mult: 3,   color: 0xff7a3a, hex: '#ff7a3a' },
  { t: 9.5,  name: 'INSANE',    mult: 4,   color: 0xff4db2, hex: '#ff4db2' },
  { t: 13.0, name: 'LEGENDARY', mult: 5,   color: 0xb06bff, hex: '#b06bff' },
];
function driftTierFor(heldSeconds) {
  let i = 0;
  for (let k = 1; k < DRIFT_TIERS.length; k++) if (heldSeconds >= DRIFT_TIERS[k].t) i = k; else break;
  return i;
}

export function createStyleSystem({ camera, audio, getTraffic, getPedestrians }) {
  // ── HUD ────────────────────────────────────────────────────────────────────
  if (!document.getElementById('dd-style-css')) {
    const st = document.createElement('style');
    st.id = 'dd-style-css';
    st.textContent = `
      #dd-style { position: fixed; right: 26px; top: 44%; transform: translateY(-50%);
        z-index: 60; text-align: right; pointer-events: none; font-family: 'Poppins', sans-serif;
        opacity: 0; transition: opacity .25s ease; text-shadow: 0 2px 10px rgba(0,0,0,.55); }
      #dd-style.on { opacity: 1; }
      #dd-style .mult { font-family: 'Lilita One', system-ui, sans-serif; font-size: 62px; line-height: .9;
        color: #ffd21f; letter-spacing: 1px; -webkit-text-stroke: 2px rgba(20,16,0,.35); }
      #dd-style .mult.bump { animation: ddMultBump .3s ease; }
      #dd-style .pts { font-size: 20px; font-weight: 700; color: #fff; margin-top: 2px; }
      #dd-style .bar { height: 5px; margin-top: 7px; margin-left: auto; width: 128px; border-radius: 3px;
        background: rgba(255,255,255,.18); overflow: hidden; }
      #dd-style .bar > i { display: block; height: 100%; width: 100%; transform-origin: right center;
        background: linear-gradient(90deg,#ff9d2f,#ffd21f); border-radius: 3px; }
      #dd-style-pops { position: fixed; right: 26px; top: 30%; z-index: 61; pointer-events: none;
        display: flex; flex-direction: column; align-items: flex-end; gap: 4px;
        font-family: 'Poppins', sans-serif; text-shadow: 0 2px 10px rgba(0,0,0,.6); }
      .dd-pop { font-weight: 800; font-size: 22px; color: #fff; white-space: nowrap;
        animation: ddPop 1.15s ease forwards; }
      .dd-pop b { color: #ffd21f; }
      .dd-pop.miss b { color: #4fd0ff; }
      .dd-pop.big { font-size: 30px; color: #ffd21f; -webkit-text-stroke: 1px rgba(30,20,0,.4); }
      .dd-pop.wreck { color: #ff5b5b; }
      #dd-style-bank { position: fixed; left: 50%; top: 38%; transform: translate(-50%,-50%);
        z-index: 62; pointer-events: none; text-align: center; font-family: 'Lilita One', system-ui, sans-serif;
        opacity: 0; text-shadow: 0 3px 16px rgba(0,0,0,.6); }
      #dd-style-bank.show { animation: ddBank 1.4s ease forwards; }
      #dd-style-bank .big { font-size: 46px; color: #ffd21f; letter-spacing: 1px; }
      #dd-style-bank .cash { font-size: 26px; color: #c9a3ff; font-family: 'Poppins',sans-serif; font-weight:800; }
      @keyframes ddMultBump { 0%{transform:scale(1)} 40%{transform:scale(1.28)} 100%{transform:scale(1)} }
      @keyframes ddPop { 0%{opacity:0; transform:translateY(14px) scale(.8)} 15%{opacity:1; transform:translateY(0) scale(1.05)}
        30%{transform:scale(1)} 100%{opacity:0; transform:translateY(-40px) scale(1)} }
      @keyframes ddBank { 0%{opacity:0; transform:translate(-50%,-50%) scale(.6)} 18%{opacity:1; transform:translate(-50%,-50%) scale(1.12)}
        30%{transform:translate(-50%,-50%) scale(1)} 78%{opacity:1} 100%{opacity:0; transform:translate(-50%,-58%) scale(1)} }
      #dd-drift { position: fixed; left: 50%; bottom: 16%; transform: translateX(-50%); z-index: 61;
        pointer-events: none; text-align: center; font-family: 'Poppins', sans-serif; opacity: 0;
        transition: opacity .18s ease; text-shadow: 0 2px 10px rgba(0,0,0,.6); min-width: 300px; }
      #dd-drift.on { opacity: 1; }
      #dd-drift .top { display: flex; justify-content: center; align-items: baseline; gap: 12px; }
      #dd-drift .tier { font-family: 'Lilita One', system-ui, sans-serif; font-size: 30px; letter-spacing: 1px; }
      #dd-drift .tier.bump { animation: ddMultBump .3s ease; }
      #dd-drift .xmult { font-size: 22px; font-weight: 800; color: #fff; }
      #dd-drift .bar { height: 8px; margin: 8px auto 5px; width: 300px; border-radius: 5px;
        background: rgba(255,255,255,.16); overflow: hidden; }
      #dd-drift .bar > i { display: block; height: 100%; width: 100%; transform-origin: left center; border-radius: 5px; }
      #dd-drift .pts { font-size: 17px; font-weight: 700; color: #fff; }
      #dd-drift .pts em { color: #ffd21f; font-style: normal; }
    `;
    document.head.appendChild(st);
  }
  const hud = document.createElement('div');
  hud.id = 'dd-style';
  hud.innerHTML = `<div class="mult">x1</div><div class="pts">0</div><div class="bar"><i></i></div>`;
  const elMult = hud.querySelector('.mult'), elPts = hud.querySelector('.pts'), elBar = hud.querySelector('.bar > i');
  const pops = document.createElement('div'); pops.id = 'dd-style-pops';
  const bank = document.createElement('div'); bank.id = 'dd-style-bank';
  const drift = document.createElement('div'); drift.id = 'dd-drift';
  drift.innerHTML = `<div class="top"><span class="tier">DRIFT</span><span class="xmult">x1</span></div>` +
                    `<div class="bar"><i></i></div><div class="pts"><em>0</em> pts — keep it lit!</div>`;
  const elTier = drift.querySelector('.tier'), elXmult = drift.querySelector('.xmult'),
        elDBar = drift.querySelector('.bar > i'), elDPts = drift.querySelector('.pts em');
  document.body.append(hud, pops, bank, drift);

  // ── State ───────────────────────────────────────────────────────────────────
  let pool = 0;             // un-banked style points
  let chain = 0;            // discrete events this combo → multiplier
  let mult = 1;
  let timer = 0;            // s left before bank
  // Drift chain — a held/linked slide. Accumulates points at a tier-scaled rate; survives brief straightens
  // (grace) so you can link corners; banks as one big DRIFT event when it finally ends; a wreck kills it.
  const dc = { active: false, time: 0, points: 0, tier: 0, grace: 0 };
  let airT = 0;             // current airborne time
  let prevSpeed = 0;
  let trauma = 0;
  let runXp = 0;            // style XP earned this session
  const tracked = new Map(); // entity -> min distance seen while in the near-miss zone

  // ── SFX (tiny synths on the sfx bus) ─────────────────────────────────────────
  function blip(f0, f1, dur, peak, type) {
    try {
      const busN = audio?.sfxBus?.(); if (!busN) return;
      const ac = busN.context; if (!ac || ac.state !== 'running') return;
      const t = ac.currentTime;
      const o = ac.createOscillator(); o.type = type || 'triangle';
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(busN);
      o.start(t); o.stop(t + dur + 0.03);
    } catch { /* audio not ready */ }
  }
  const sfxCombo = () => blip(300 + mult * 42, 640 + mult * 60, 0.12, 0.13, 'triangle');
  const sfxBank  = () => { blip(660, 660, 0.10, 0.15, 'sine'); blip(988, 990, 0.22, 0.16, 'sine'); };
  const sfxWreck = () => blip(230, 55, 0.42, 0.18, 'sawtooth');
  const sfxLevel = () => { blip(523, 523, 0.10, 0.16, 'sine'); blip(659, 659, 0.10, 0.16, 'sine'); blip(784, 784, 0.26, 0.17, 'sine'); }; // C-E-G rise

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function addTrauma(a) { trauma = Math.min(1, trauma + a); }
  function fmt(n) { return Math.round(n).toLocaleString(); }

  function popup(label, pts, cls) {
    const d = document.createElement('div');
    d.className = 'dd-pop' + (cls ? ' ' + cls : '');
    d.innerHTML = pts != null ? `${label} <b>+${fmt(pts)}</b>` : label;
    pops.appendChild(d);
    d.addEventListener('animationend', () => d.remove());
    // cap stacked popups
    while (pops.children.length > 6) pops.firstChild.remove();
  }

  // A discrete style event: add points, grow the combo, refresh the bank timer.
  function score(label, pts, cls) {
    pool += pts;
    chain++;
    const nm = Math.min(MAX_MULT, 1 + Math.floor(chain / EVENTS_PER_MULT));
    if (nm !== mult) { mult = nm; elMult.classList.remove('bump'); void elMult.offsetWidth; elMult.classList.add('bump'); sfxCombo(); }
    timer = COMBO_WINDOW;
    popup(label, pts, cls);
    hud.classList.add('on');
  }

  // End the drift chain: bank its points into the combo as one DRIFT event (tier-named), unless wrecked.
  function endDriftChain(wrecked) {
    if (!dc.active) return;
    const pts = dc.points, name = DRIFT_TIERS[dc.tier].name;
    dc.active = false; dc.time = 0; dc.points = 0; dc.tier = 0; dc.grace = 0;
    driftState.reset();
    drift.classList.remove('on');
    if (!wrecked && pts >= DRIFT_MIN_PTS) score(`${name} DRIFT`, pts, dc.tier >= 3 ? 'big' : null);
  }

  function doBank(wrecked) {
    if (wrecked) endDriftChain(true);          // a wreck forfeits the drift chain too
    if (pool <= 0) { reset(); return; }
    if (wrecked) {
      popup('WRECKED! COMBO LOST', null, 'wreck');
      sfxWreck(); addTrauma(0.9);
      reset();
      return;
    }
    const styled = Math.round(pool * mult);
    const res = xp.add(styled);        // tricks award XP (driver progression) — never cash
    runXp += styled;
    bank.innerHTML = res.leveledUp
      ? `<div class="big">LEVEL UP</div><div class="cash">Lv ${res.level} · +${fmt(styled)} XP</div>`
      : `<div class="big">+${fmt(styled)} XP</div><div class="cash">Lv ${res.level}</div>`;
    bank.classList.remove('show'); void bank.offsetWidth; bank.classList.add('show');
    if (res.leveledUp) { sfxLevel(); addTrauma(0.5); } else sfxBank();
    reset();
  }

  function reset() { pool = 0; chain = 0; mult = 1; timer = 0; hud.classList.remove('on'); }

  // ── Per-frame ─────────────────────────────────────────────────────────────────
  function update(px, pz, dt, speedKmh, car) {
    const spd = Math.abs(speedKmh || 0);
    const slide = Math.max(car?.drift || 0, car?.skid || 0);
    const wheels = car?.wheels ?? 4;

    // WRECK — a big single-frame speed loss means we hit something hard (kills combo AND drift chain).
    if (prevSpeed - spd > WRECK_DROP_KMH && (pool > 0 || dc.active)) doBank(true);
    prevSpeed = spd;

    // DRIFT CHAIN — hold/link a slide to climb tiers; longer = exponentially more. Grace links corners.
    const drifting = slide > DRIFT_SLIDE && spd > DRIFT_MIN_KMH && wheels >= 2;
    if (drifting) {
      if (!dc.active) { dc.active = true; dc.time = 0; dc.points = 0; dc.tier = 0; }
      dc.grace = DRIFT_GRACE;
      dc.time += dt;
      const nt = driftTierFor(dc.time);
      if (nt !== dc.tier) {
        dc.tier = nt;
        elTier.classList.remove('bump'); void elTier.offsetWidth; elTier.classList.add('bump');
        sfxCombo();
        addTrauma(0.22);                     // little kick on each tier-up
      }
      const T = DRIFT_TIERS[dc.tier];
      dc.points += DRIFT_RATE * (spd / 50) * Math.max(0.4, slide) * T.mult * dt;
      timer = Math.max(timer, 0.6);          // keep the outer combo alive mid-drift
      hud.classList.add('on');
      drift.classList.add('on');
      addTrauma(0.05 * dt * 60 * slide * (spd / 90));   // subtle rumble while sliding
      driftState.set(true, dc.tier, T.color, dc.time);
    } else if (dc.active) {
      dc.grace -= dt;
      driftState.set(true, dc.tier, DRIFT_TIERS[dc.tier].color, dc.time);  // keep smoke tinted through grace
      if (dc.grace <= 0) endDriftChain(false);
    }

    // BIG AIR — count airborne time; award on landing.
    if (wheels === 0 && spd > 8) {
      airT += dt;
    } else if (airT > 0) {
      if (airT >= AIR_MIN_T) {
        const pts = AIR_RATE * airT;
        score(airT > 1.1 ? 'HUGE AIR' : 'BIG AIR', pts, null);
        addTrauma(Math.min(0.85, 0.35 + airT * 0.4));   // landing thud
      }
      airT = 0;
    }

    // NEAR MISS — track closest approach to nearby cars/peds; award when they leave the zone close-but-clean.
    if (spd > NEARMISS_MIN_KMH) {
      const cars = getTraffic?.()?.getNearby?.(px, pz, NEARMISS_R) || [];
      const peds = getPedestrians?.()?.getNearby?.(px, pz, NEARMISS_R) || [];
      const here = new Set();
      const scan = (list) => {
        for (const e of list) {
          const p = e.mesh ? e.mesh.position : e;   // car: mesh.position, ped: {x,z}
          const d = Math.hypot(p.x - px, p.z - pz);
          here.add(e);
          const prev = tracked.get(e);
          if (prev === undefined || d < prev) tracked.set(e, d);
        }
      };
      scan(cars); scan(peds);
      // resolve entities that left the zone
      for (const [e, minD] of tracked) {
        if (here.has(e)) continue;
        if (minD > NEARMISS_HIT_R && minD < NEARMISS_R) {
          const isPed = !e.mesh;
          const base = isPed ? NEARMISS_PED : NEARMISS_CAR;
          const closeness = 1 - (minD - NEARMISS_HIT_R) / (NEARMISS_R - NEARMISS_HIT_R);
          const pts = base * (0.5 + 0.5 * closeness) * Math.min(1.6, spd / 70);
          score('NEAR MISS', pts, 'miss');
          audio?.whoosh?.(0, 0.6 + 0.4 * closeness);
          addTrauma(0.18 + 0.2 * closeness);
        }
        tracked.delete(e);
      }
    } else if (tracked.size) {
      tracked.clear();
    }

    // SPEED — sustained high speed keeps the combo warm with a small trickle.
    if (spd > SPEED_KMH) {
      pool += SPEED_RATE * dt;
      if (timer < COMBO_WINDOW * 0.4) timer = COMBO_WINDOW * 0.4;
      hud.classList.add('on');
    }

    // Combo countdown → bank when it runs out.
    if (timer > 0) {
      timer -= dt;
      if (timer <= 0) doBank(false);
    }

    // Combo HUD refresh (live pool includes the in-progress drift chain)
    if (hud.classList.contains('on')) {
      elMult.textContent = 'x' + mult;
      elPts.textContent = fmt(pool + dc.points);
      elBar.style.transform = `scaleX(${Math.max(0, Math.min(1, timer / COMBO_WINDOW))})`;
    }

    // Drift-chain HUD — tier name + colour, tier multiplier, fill toward the NEXT tier, and live points.
    if (dc.active) {
      const T = DRIFT_TIERS[dc.tier], next = DRIFT_TIERS[dc.tier + 1];
      elTier.textContent = T.name;
      elTier.style.color = T.hex;
      elXmult.textContent = 'x' + T.mult;
      elDPts.textContent = fmt(dc.points);
      const frac = next ? Math.max(0, Math.min(1, (dc.time - T.t) / (next.t - T.t))) : 1;
      elDBar.style.transform = `scaleX(${frac})`;
      elDBar.style.background = next ? `linear-gradient(90deg,${T.hex},${next.hex})` : T.hex;
    }

    // Screen shake — offset the camera AFTER carCam has positioned it this frame.
    if (trauma > 0 && camera) {
      const s = trauma * trauma * MAX_SHAKE_M;
      camera.position.x += (Math.random() * 2 - 1) * s;
      camera.position.y += (Math.random() * 2 - 1) * s * 0.7;
      camera.position.z += (Math.random() * 2 - 1) * s;
      trauma = Math.max(0, trauma - TRAUMA_DECAY * dt);
    }
  }

  function dispose() {
    hud.remove(); pops.remove(); bank.remove(); drift.remove();
    driftState.reset();
    tracked.clear();
  }

  return { update, dispose, addTrauma, getRunXp: () => runXp };
}
