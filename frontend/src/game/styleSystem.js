/**
 * styleSystem — arcade "style" scoring that runs continuously while driving (all car modes, free-roam too).
 * Rewards the moment-to-moment fun a gamer wants: DRIFT, BIG AIR, NEAR MISS, and sustained SPEED build a
 * live combo multiplier with floating popups, screen shake, and sfx. When you ease off (or wreck), the combo
 * BANKS: style points convert to cash into the global wallet. Turns the whole city into a playground.
 *
 * Decoupled by design: reads car state (drift/skid/wheels/speed) via params, queries traffic & pedestrians
 * through injected getNearby() accessors, and pays out via the shared wallet. No physics/render coupling.
 *
 *   const style = createStyleSystem({ camera, wallet, audio, getTraffic, getPedestrians });
 *   style.update(px, pz, dt, speedKmh, { drift, skid, wheels });   // every frame in car mode (skip cinematics)
 */

// ── Tuning ──────────────────────────────────────────────────────────────────
const COMBO_WINDOW   = 3.2;   // s of no events before the combo banks
const MAX_MULT       = 10;
const EVENTS_PER_MULT = 2;    // +1x every N discrete events

const DRIFT_MIN_KMH  = 22;
const DRIFT_SLIDE    = 0.30;  // max(driftFactor, skidLevel) above this = drifting
const DRIFT_RATE     = 46;    // pts/s at the reference (scaled by speed & slide amount)
const DRIFT_END      = 0.32;  // s below threshold before a drift is considered "ended"
const DRIFT_MIN_PTS  = 60;    // don't emit a popup for a tiny twitch

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

const STYLE_TO_CASH  = 0.03;  // banked style points → dollars (keeps it a supplement, not a money printer)

const MAX_SHAKE_M    = 0.28;  // camera shake at full trauma
const TRAUMA_DECAY   = 1.9;   // trauma units per second

export function createStyleSystem({ camera, wallet, audio, getTraffic, getPedestrians }) {
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
      .dd-pop.wreck { color: #ff5b5b; }
      #dd-style-bank { position: fixed; left: 50%; top: 38%; transform: translate(-50%,-50%);
        z-index: 62; pointer-events: none; text-align: center; font-family: 'Lilita One', system-ui, sans-serif;
        opacity: 0; text-shadow: 0 3px 16px rgba(0,0,0,.6); }
      #dd-style-bank.show { animation: ddBank 1.4s ease forwards; }
      #dd-style-bank .big { font-size: 46px; color: #ffd21f; letter-spacing: 1px; }
      #dd-style-bank .cash { font-size: 26px; color: #7dff9a; font-family: 'Poppins',sans-serif; font-weight:800; }
      @keyframes ddMultBump { 0%{transform:scale(1)} 40%{transform:scale(1.28)} 100%{transform:scale(1)} }
      @keyframes ddPop { 0%{opacity:0; transform:translateY(14px) scale(.8)} 15%{opacity:1; transform:translateY(0) scale(1.05)}
        30%{transform:scale(1)} 100%{opacity:0; transform:translateY(-40px) scale(1)} }
      @keyframes ddBank { 0%{opacity:0; transform:translate(-50%,-50%) scale(.6)} 18%{opacity:1; transform:translate(-50%,-50%) scale(1.12)}
        30%{transform:translate(-50%,-50%) scale(1)} 78%{opacity:1} 100%{opacity:0; transform:translate(-50%,-58%) scale(1)} }
    `;
    document.head.appendChild(st);
  }
  const hud = document.createElement('div');
  hud.id = 'dd-style';
  hud.innerHTML = `<div class="mult">x1</div><div class="pts">0</div><div class="bar"><i></i></div>`;
  const elMult = hud.querySelector('.mult'), elPts = hud.querySelector('.pts'), elBar = hud.querySelector('.bar > i');
  const pops = document.createElement('div'); pops.id = 'dd-style-pops';
  const bank = document.createElement('div'); bank.id = 'dd-style-bank';
  document.body.append(hud, pops, bank);

  // ── State ───────────────────────────────────────────────────────────────────
  let pool = 0;             // un-banked style points
  let chain = 0;            // discrete events this combo → multiplier
  let mult = 1;
  let timer = 0;            // s left before bank
  let driftAccum = 0, driftBelow = 0;   // current drift run
  let airT = 0;             // current airborne time
  let prevSpeed = 0;
  let trauma = 0;
  let runCash = 0;          // cash earned this session (for possible HUD/debug)
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

  function doBank(wrecked) {
    if (pool <= 0) { reset(); return; }
    if (wrecked) {
      popup('WRECKED! COMBO LOST', null, 'wreck');
      sfxWreck(); addTrauma(0.9);
      reset();
      return;
    }
    const styled = Math.round(pool * mult);
    const cash = Math.max(1, Math.round(styled * STYLE_TO_CASH));
    wallet?.add?.(cash);
    runCash += cash;
    bank.innerHTML = `<div class="big">${fmt(styled)} STYLE</div><div class="cash">+ $${fmt(cash)}</div>`;
    bank.classList.remove('show'); void bank.offsetWidth; bank.classList.add('show');
    sfxBank();
    reset();
  }

  function reset() { pool = 0; chain = 0; mult = 1; timer = 0; driftAccum = 0; hud.classList.remove('on'); }

  // ── Per-frame ─────────────────────────────────────────────────────────────────
  function update(px, pz, dt, speedKmh, car) {
    const spd = Math.abs(speedKmh || 0);
    const slide = Math.max(car?.drift || 0, car?.skid || 0);
    const wheels = car?.wheels ?? 4;

    // WRECK — a big single-frame speed loss means we hit something hard.
    if (prevSpeed - spd > WRECK_DROP_KMH && pool > 0) doBank(true);
    prevSpeed = spd;

    // DRIFT — accumulate while sliding at speed; emit one popup when the slide ends.
    if (slide > DRIFT_SLIDE && spd > DRIFT_MIN_KMH && wheels >= 2) {
      driftAccum += DRIFT_RATE * (spd / 50) * slide * dt;
      driftBelow = 0;
      timer = Math.max(timer, 0.6);          // keep combo alive mid-drift
      hud.classList.add('on');
      addTrauma(0.06 * dt * 60 * slide * (spd / 90));   // subtle rumble while drifting
    } else if (driftAccum > 0) {
      driftBelow += dt;
      if (driftBelow >= DRIFT_END) {
        if (driftAccum >= DRIFT_MIN_PTS) score('DRIFT', driftAccum, null);
        driftAccum = 0;
      }
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

    // HUD refresh (live pool includes the in-progress drift)
    if (hud.classList.contains('on')) {
      elMult.textContent = 'x' + mult;
      elPts.textContent = fmt(pool + driftAccum);
      elBar.style.transform = `scaleX(${Math.max(0, Math.min(1, timer / COMBO_WINDOW))})`;
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
    hud.remove(); pops.remove(); bank.remove();
    tracked.clear();
  }

  return { update, dispose, addTrauma, getRunCash: () => runCash };
}
