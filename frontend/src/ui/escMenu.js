/**
 * ESC menu — full-screen game settings, ETS2 style (squared plates, amber accent, the paused world
 * blurred behind). Restyled 2026-09-01: the previous art-of-rally treatment read "too websity".
 *
 * Single scrolling page: Spawn location (search + landmark buttons), Car colour, Display (Stats-for-nerds
 * toggle), Controls. Day/night stays in its top-right pill. Opens/closes on ESC. Changing spawn reloads
 * with ?spawn=lat,lon (spawnConfig applies it at init — the world can't be re-based live).
 */

const BOUNDS = { minLat: 41.3580, minLon: 2.1198, maxLat: 41.4130, maxLon: 2.2230 };
const PRESETS = [
  { name: 'Eixample', lat: 41.3920, lon: 2.1650 }, { name: 'Sagrada Família', lat: 41.4036, lon: 2.1744 },
  { name: 'Passeig de Gràcia', lat: 41.3948, lon: 2.1602 }, { name: 'Barceloneta', lat: 41.3797, lon: 2.1899 },
  { name: 'Port Olímpic', lat: 41.3875, lon: 2.1969 }, { name: 'Montjuïc', lat: 41.3641, lon: 2.1585 },
  { name: 'Gothic Quarter', lat: 41.3833, lon: 2.1777 }, { name: 'Camp Nou', lat: 41.3809, lon: 2.1228 },
];
const LOGO_URL = '/logo-barcelona-drive.webp';

import { uiSound } from './uiSound.js';
import { audio } from '../audio/audioManager.js';
import { setInputBlocked } from '../inputGate.js';
import { createCarShowcase } from './carShowcase.js';
import { wallet } from '../game/wallet.js';

const CSS = `
/* ── ETS2-STYLE PAUSE MENU ─────────────────────────────────────────────────────────────────────
   Replaced the art-of-rally styling (11-14px radii, iOS pill toggles, coral, soft shadows), which
   the user called "too websity". The four things that actually carry a sim-menu read, in order:

   1. NOTHING IS ROUNDED. Radius is the single strongest "this is an app" signal. Everything here is
      square or 2px. This one change does more than the palette.
   2. THE PAUSED WORLD SHOWS THROUGH. ETS2 darkens and blurs the game behind the menu instead of
      covering it. An opaque full-bleed gradient reads as a web page no matter how it is coloured.
   3. PANELS ARE PLATES WITH EDGES. 1px cool borders, a lit top edge, a flat fill — not floating
      cards with drop shadows.
   4. AMBER LEFT-ACCENT BARS mark section heads and the hovered/selected row. That vertical amber
      tick is the SCS signature more than the orange itself is.

   Type is uppercase and letterspaced for every label and control; sentence-case body text is what
   made this read as a settings webpage. */
#dd-esc-overlay {
  --e-bg:      rgba(11,15,20,0.94);
  --e-plate:   #1a212a;
  --e-plate-2: #222b35;
  --e-line:    #35414e;
  --e-line-hi: #4a5765;
  --e-text:    #d6dce3;
  --e-dim:     #8a97a4;
  --e-accent:  #e6a33c;
  --e-accent-d:#b87d24;
  position:fixed; inset:0; z-index:5000; display:none; color:var(--e-text);
  font-family:'Inter',-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
  background:linear-gradient(180deg, rgba(11,15,20,0.90), rgba(8,11,15,0.97));
  backdrop-filter:blur(13px) saturate(0.72); -webkit-backdrop-filter:blur(13px) saturate(0.72); }
/* Faint horizontal banding — SCS panels are textured, not flat fills. Cheap and only reads
   subliminally, which is the point. */
#dd-esc-overlay::before { content:''; position:absolute; inset:0; pointer-events:none; opacity:0.5;
  background:repeating-linear-gradient(0deg, rgba(255,255,255,0.012) 0 1px, transparent 1px 3px); }
#dd-esc-overlay.open { display:block; animation:ddPop .16s ease-out; }
@keyframes ddPop { from{opacity:0} to{opacity:1} }
.dd-esc-wrap { position:relative; height:100%; padding:0 5vw 22px; box-sizing:border-box; display:flex; flex-direction:column; }

/* ── header: logo, a hard amber rule under it ── */
.dd-esc-top { display:flex; align-items:center; justify-content:space-between; padding:18px 0 14px;
  border-bottom:1px solid var(--e-line); box-shadow:0 1px 0 rgba(230,163,60,0.28); }
.dd-esc-logoimg { height:54px; filter:drop-shadow(0 2px 4px rgba(0,0,0,0.6)); }
.dd-esc-topactions { display:flex; align-items:center; gap:10px; }

/* car paint swatches — squared off with the rest */
#dd-car-color-panel { gap:10px !important; align-items:center !important; }
#dd-car-color-panel span { display:none !important; }
#dd-car-color-panel > div[style*="50%"] { width:38px !important; height:38px !important; border-radius:2px !important;
  border:1px solid var(--e-line-hi) !important; box-shadow:inset 0 1px 0 rgba(255,255,255,0.10); transition:border-color .12s; }
#dd-car-color-panel > div[style*="50%"]:hover { border-color:var(--e-dim) !important; }
#dd-car-color-panel > div[style*="50%"].sel { border-color:var(--e-accent) !important; box-shadow:0 0 0 2px rgba(230,163,60,0.34) !important; }
#dd-car-color-panel > div:not([style*="50%"]) { display:none !important; }

/* ── slider: thin track, square handle ── */
.dd-esc-range { -webkit-appearance:none; appearance:none; width:230px; height:6px; border-radius:0;
  background:#131920; border:1px solid var(--e-line); outline:none; }
.dd-esc-range::-webkit-slider-thumb { -webkit-appearance:none; width:12px; height:22px; border-radius:1px;
  background:linear-gradient(180deg,#f2b555,var(--e-accent-d));
  border:1px solid #14191f; cursor:pointer; }
.dd-esc-range::-moz-range-thumb { width:12px; height:22px; border-radius:1px;
  background:linear-gradient(180deg,#f2b555,var(--e-accent-d)); border:1px solid #14191f; cursor:pointer; }
.dd-esc-val { min-width:50px; color:var(--e-accent); font-size:14px; font-weight:700; letter-spacing:0.06em;
  font-variant-numeric:tabular-nums; }

.dd-esc-body { flex:1; display:flex; gap:30px; min-height:0; padding:16px 0; }
.dd-esc-left { flex:1 1 54%; overflow-y:auto; overflow-x:hidden; padding-right:12px; min-width:0; }
.dd-esc-left::-webkit-scrollbar { width:9px; }
.dd-esc-left::-webkit-scrollbar-track { background:#111720; }
.dd-esc-left::-webkit-scrollbar-thumb { background:var(--e-line); border:1px solid #111720; }
.dd-esc-left::-webkit-scrollbar-thumb:hover { background:var(--e-line-hi); }
.dd-esc-page { width:100%; max-width:660px; }

/* right column — the car turntable, framed as a plate rather than floating */
.dd-esc-showcase { flex:1 1 46%; min-width:0; align-self:stretch; display:flex; flex-direction:column; }
.dd-esc-carstage { flex:1 1 auto; position:relative; min-height:0; overflow:hidden;
  background:linear-gradient(180deg,#161d25,#10151b); border:1px solid var(--e-line); }
.dd-esc-carstage::after { content:'DRAG TO SPIN'; position:absolute; left:0; right:0; bottom:8px; text-align:center;
  font-size:10px; font-weight:700; letter-spacing:0.22em; color:var(--e-dim); opacity:.7; pointer-events:none; }
.dd-esc-carstage canvas { position:absolute; inset:0; }
.dd-esc-garage { flex:0 0 auto; display:flex; flex-direction:column; align-items:center; gap:10px; padding:13px 10px 10px;
  background:var(--e-plate); border:1px solid var(--e-line); border-top:none; }
.dd-esc-glabel { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.2em; color:var(--e-dim); }
.dd-esc-wallet { font:700 17px 'Inter',system-ui,sans-serif; color:var(--e-accent); letter-spacing:0.06em;
  font-variant-numeric:tabular-nums; }
@media (max-width:900px){ .dd-esc-body{ flex-direction:column; } .dd-esc-showcase{ min-height:250px; flex:0 0 250px; } }

/* ── section head: a plate with an amber left tick. The SCS signature. ── */
.dd-esc-sec { display:flex; align-items:center; gap:12px; margin:22px 0 12px; padding:9px 14px;
  font-size:11px; font-weight:700; letter-spacing:0.2em; text-transform:uppercase; color:var(--e-text);
  background:linear-gradient(180deg,var(--e-plate-2),var(--e-plate));
  border:1px solid var(--e-line); border-left:3px solid var(--e-accent);
  box-shadow:inset 0 1px 0 rgba(255,255,255,0.05); }
.dd-esc-sec::after { content:''; flex:1; height:1px; background:linear-gradient(90deg,var(--e-line),transparent); }

.dd-esc-line { display:flex; align-items:center; gap:14px; margin:11px 0; }
.dd-esc-searchrow { display:flex; gap:10px; }
.dd-esc-input { flex:1; background:#12171e; border:1px solid var(--e-line); color:var(--e-text);
  border-radius:0; padding:12px 14px; font-family:inherit; font-size:14px; letter-spacing:0.05em; outline:none;
  box-shadow:inset 0 1px 3px rgba(0,0,0,0.45); transition:border-color .14s, background .14s; }
.dd-esc-input:focus { border-color:var(--e-accent); background:#151b23; }
.dd-esc-input::placeholder { color:var(--e-dim); letter-spacing:0.04em; }

.dd-esc-go, .dd-esc-chip, .dd-esc-x, .dd-esc-back, .dd-esc-fab { cursor:pointer; user-select:none;
  transition:background .14s, border-color .14s, color .14s; }
/* primary: amber plate, dark text — the one loud control on the page */
.dd-esc-go { display:flex; align-items:center; padding:0 26px; border-radius:0; font-family:inherit;
  font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.16em; color:#161a1f;
  background:linear-gradient(180deg,#f2b555,var(--e-accent-d)); border:1px solid #7d5415;
  box-shadow:inset 0 1px 0 rgba(255,255,255,0.28); }
.dd-esc-go:hover { background:linear-gradient(180deg,#f7c069,#c98b2a); }
.dd-esc-go:active { background:linear-gradient(180deg,#c98b2a,#a06c1c); box-shadow:inset 0 2px 4px rgba(0,0,0,0.4); }
.dd-esc-go:disabled { opacity:.35; }
.dd-esc-err { margin-top:10px; min-height:20px; font-size:12px; letter-spacing:0.08em; text-transform:uppercase;
  font-weight:600; color:#e07a5f; } .dd-esc-err.ok { color:#8fbf6a; }

/* ── list rows: full-width plates, amber tick slides in on hover/selection ── */
.dd-esc-chips { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:8px; margin-top:12px; }
.dd-esc-chip { position:relative; text-align:left; padding:12px 14px 12px 16px; border-radius:0;
  font-size:12px; font-weight:600; letter-spacing:0.1em; text-transform:uppercase; color:var(--e-dim);
  background:linear-gradient(180deg,#1d242d,#171d25); border:1px solid var(--e-line); }
.dd-esc-chip::before { content:''; position:absolute; left:0; top:0; bottom:0; width:3px;
  background:var(--e-accent); transform:scaleY(0); transform-origin:center; transition:transform .14s; }
.dd-esc-chip:hover { color:var(--e-text); background:linear-gradient(180deg,#242d38,#1b222b); border-color:var(--e-line-hi); }
.dd-esc-chip:hover::before { transform:scaleY(1); }
.dd-esc-chip.sel { color:#161a1f; background:linear-gradient(180deg,#f2b555,var(--e-accent-d));
  border-color:#7d5415; box-shadow:inset 0 1px 0 rgba(255,255,255,0.26); }
.dd-esc-chip.sel::before { transform:scaleY(1); background:#161a1f; }

/* ── toggle: a CHECKBOX, not an iOS pill. Nothing dated this menu harder. ── */
.dd-esc-toggle { width:22px; height:22px; border-radius:0; background:#12171e; border:1px solid var(--e-line);
  position:relative; cursor:pointer; transition:border-color .14s, background .14s; flex:0 0 auto;
  box-shadow:inset 0 1px 3px rgba(0,0,0,0.5); }
.dd-esc-toggle:hover { border-color:var(--e-line-hi); }
.dd-esc-toggle .k { position:absolute; inset:3px; border-radius:0; background:var(--e-accent);
  transform:scale(0); transition:transform .13s cubic-bezier(.2,.9,.3,1.2);
  box-shadow:0 0 7px rgba(230,163,60,0.55); }
.dd-esc-toggle.on { border-color:var(--e-accent-d); background:#1b1710; }
.dd-esc-toggle.on .k { transform:scale(1); }
.dd-esc-tlabel { font-size:12px; font-weight:600; letter-spacing:0.09em; text-transform:uppercase; color:var(--e-dim); }
.dd-esc-line:hover .dd-esc-tlabel { color:var(--e-text); }

.dd-esc-checkrow { display:flex; flex-wrap:wrap; gap:4px 24px; margin:6px 0 4px; }
.dd-esc-checkrow .dd-esc-line { margin:4px 0; gap:9px; }

/* ── keybind rows: label left, key cap right, hairline between ── */
.dd-esc-key { display:flex; align-items:center; justify-content:space-between; padding:9px 12px;
  border-bottom:1px solid rgba(53,65,78,0.55); }
.dd-esc-key:hover { background:rgba(255,255,255,0.022); }
.dd-esc-key .d { font-size:12px; font-weight:600; letter-spacing:0.09em; text-transform:uppercase; color:var(--e-dim); }
.dd-esc-key .k { background:linear-gradient(180deg,#2a333d,#1c232b); color:var(--e-text);
  border:1px solid var(--e-line-hi); border-bottom-width:2px; border-radius:2px; padding:5px 12px;
  font-size:11px; font-weight:700; letter-spacing:0.1em; min-width:26px; text-align:center;
  box-shadow:inset 0 1px 0 rgba(255,255,255,0.07); }

.dd-esc-bottom { padding-top:12px; border-top:1px solid var(--e-line); }
.dd-esc-back { display:inline-flex; align-items:center; gap:8px; padding:12px 22px; border-radius:0;
  font-family:inherit; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.16em;
  color:var(--e-text); background:linear-gradient(180deg,#252e38,#1a212a); border:1px solid var(--e-line-hi);
  box-shadow:inset 0 1px 0 rgba(255,255,255,0.06); }
.dd-esc-back:hover { background:linear-gradient(180deg,#2e3945,#212a34); border-color:var(--e-accent-d); }
.dd-esc-back:active { background:#171d25; box-shadow:inset 0 2px 4px rgba(0,0,0,0.4); }

.dd-esc-x { width:40px; height:40px; border-radius:0; display:flex; align-items:center; justify-content:center;
  font-size:17px; color:var(--e-dim); background:linear-gradient(180deg,#252e38,#1a212a); border:1px solid var(--e-line-hi); }
.dd-esc-x:hover { color:var(--e-text); border-color:var(--e-accent-d); background:linear-gradient(180deg,#2e3945,#212a34); }
.dd-esc-x:active { background:#171d25; }

.dd-esc-fab { position:fixed; top:12px; left:12px; z-index:1500; width:40px; height:40px; border-radius:0;
  display:flex; align-items:center; justify-content:center; font-size:16px; color:var(--e-text); cursor:pointer;
  background:rgba(22,28,35,0.72); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  border:1px solid rgba(74,87,101,0.85); border-left:2px solid rgba(230,163,60,0.75);
  box-shadow:inset 0 1px 0 rgba(255,255,255,0.06), 0 2px 8px rgba(0,0,0,0.35); }
.dd-esc-fab:hover { background:rgba(38,47,57,0.88); }
.dd-esc-fab:active { background:rgba(18,23,29,0.9); }
`;

function el(t, c, h) { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; }
function sec(t) { return el('div', 'dd-esc-sec', t); }
function ls(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } }
function ss(k, v) { try { localStorage.setItem(k, v); } catch {} }

function slider(label, value, fmt, onInput) {
  const line = el('div', 'dd-esc-line');
  const r = el('input', 'dd-esc-range'); r.type = 'range'; r.min = '0'; r.max = '100'; r.step = '1'; r.value = String(value);
  const v = el('span', 'dd-esc-val', fmt(value));
  r.addEventListener('input', () => { const n = parseInt(r.value, 10); v.textContent = fmt(n); onInput(n); });
  line.appendChild(r); line.appendChild(v); line.appendChild(el('span', 'dd-esc-tlabel', label));
  return line;
}

function check(label, checked, onChange, live, syncers) {
  const line = el('div', 'dd-esc-line');
  const tg = el('div', 'dd-esc-toggle' + (checked ? ' on' : ''));
  tg.appendChild(el('div', 'k'));
  tg.addEventListener('click', () => { checked = !checked; tg.classList.toggle('on', checked); uiSound.toggle(checked); onChange(checked); });
  line.appendChild(tg); line.appendChild(el('span', 'dd-esc-tlabel', label));
  // Optional live re-sync when the menu opens — keeps a toggle honest if its state can change elsewhere
  // (e.g. Collision wireframes via the K key or ?debug), instead of showing the stale build-time value.
  if (live && syncers) syncers.push(() => { checked = live(); tg.classList.toggle('on', checked); });
  return line;
}

export function createEscMenu(refs = {}) {
  document.head.appendChild(Object.assign(el('style'), { textContent: CSS }));
  const syncers = [];   // run on menu-open to refresh toggle states that can change elsewhere
  // ...and on any fullscreen change, which is the one state the player can alter without touching
  // this menu at all (Esc, F11, the macOS green button). Without this the Fullscreen toggle goes
  // stale the first time they leave fullscreen by any route but the toggle itself.
  document.addEventListener('fullscreenchange', () => { for (const s of syncers) s(); });

  const overlay = el('div'); overlay.id = 'dd-esc-overlay';
  const wrap = el('div', 'dd-esc-wrap'); overlay.appendChild(wrap);

  const top = el('div', 'dd-esc-top');
  const logo = el('img', 'dd-esc-logoimg'); logo.src = LOGO_URL; logo.alt = 'Barcelona Drive';
  top.appendChild(logo);
  // Right-hand cluster: back to the hub, then close. The hub is where modes and the city live now,
  // so settings needs a door to it or the only way back is a reload.
  const topActions = el('div', 'dd-esc-topactions');
  if (refs.onMainMenu && !refs.embedded) {
    const hubBtn = el('div', 'dd-esc-back', 'Main Menu');
    hubBtn.addEventListener('click', () => { uiSound.click(); setOpen(false); refs.onMainMenu(); });
    topActions.appendChild(hubBtn);
  }
  const xBtn = el('div', 'dd-esc-x', '✕'); xBtn.addEventListener('click', () => setOpen(false));
  topActions.appendChild(xBtn);
  top.appendChild(topActions);
  wrap.appendChild(top);

  const bodyEl = el('div', 'dd-esc-body'); wrap.appendChild(bodyEl);
  const leftCol = el('div', 'dd-esc-left'); bodyEl.appendChild(leftCol);
  const page = el('div', 'dd-esc-page'); leftCol.appendChild(page);
  // Right column — "your car": live 3D turntable (created lazily so its WebGL context only exists once
  // opened) up top, then the garage strip (paint swatches + wallet) below it.
  const showcaseCol = el('div', 'dd-esc-showcase'); bodyEl.appendChild(showcaseCol);
  const carStage = el('div', 'dd-esc-carstage'); showcaseCol.appendChild(carStage);
  const garagePanel = el('div', 'dd-esc-garage'); showcaseCol.appendChild(garagePanel);
  let showcase = null;

  // ── Game Mode (switch modes in-game; chosen first on the title screen) ──
  const gameModes = (refs.gameModes || []).filter(Boolean);
  if (gameModes.length) {
    page.appendChild(sec('Game Mode'));
    const modeRow = el('div', 'dd-esc-chips');
    // Free Roam (no active mode) + one chip per registered mode.
    const entries = [{ icon: '🗺️', label: 'Free Roam', mode: null }]
      .concat(gameModes.map((m) => ({ icon: m.icon, label: m.name, mode: m })));
    const chipEls = [];
    const repaint = () => {
      const running = gameModes.some((m) => m.isRunning && m.isRunning());
      entries.forEach((e, i) => {
        const active = e.mode ? (e.mode.isRunning && e.mode.isRunning()) : !running;
        chipEls[i].classList.toggle('sel', !!active);
      });
    };
    entries.forEach((e) => {
      const c = el('div', 'dd-esc-chip', `${e.icon} ${e.label}`);
      c.addEventListener('click', () => {
        uiSound.click();
        gameModes.forEach((m) => { if (m !== e.mode) m.stop && m.stop(); });  // one at a time
        if (e.mode && e.mode.start) e.mode.start();
        try { sessionStorage.setItem('dd_mode', e.mode ? (e.mode.key || 'free') : 'free'); } catch {}
        repaint();
        setOpen(false);  // drop back into the game to play the chosen mode
      });
      chipEls.push(c); modeRow.appendChild(c);
    });
    page.appendChild(modeRow);
    syncers.push(repaint);  // refresh the active highlight each time the menu opens
  }

  // ── Spawn location ──
  page.appendChild(sec('Spawn'));
  const searchRow = el('div', 'dd-esc-searchrow');
  const input = el('input', 'dd-esc-input'); input.placeholder = 'Search a place in Barcelona…';
  const go = el('button', 'dd-esc-go', 'GO'); searchRow.appendChild(input); searchRow.appendChild(go);
  page.appendChild(searchRow);
  const err = el('div', 'dd-esc-err'); page.appendChild(err);
  const chips = el('div', 'dd-esc-chips');
  for (const p of PRESETS) { const c = el('div', 'dd-esc-chip', p.name); c.addEventListener('click', () => { uiSound.click(); spawnAt(p.lat, p.lon); }); chips.appendChild(c); }
  page.appendChild(chips);

  // ── Garage — lives on the RIGHT, directly under the live car, so paint changes show on the model
  //    immediately (the swatch is right next to the thing it colours). Wallet balance sits below it.
  garagePanel.appendChild(el('div', 'dd-esc-glabel', 'Paint your car'));
  const colorPanel = refs.colorPanelElement || document.getElementById('dd-car-color-panel');
  if (colorPanel) {
    Object.assign(colorPanel.style, { position: 'static', top: 'auto', left: 'auto', background: 'transparent', padding: '0', flexWrap: 'wrap', justifyContent: 'center' });
    garagePanel.appendChild(colorPanel);
    // Selection + buying are handled by the car model's swatches; just add the menu click blip here.
    colorPanel.querySelectorAll('div[style*="50%"]').forEach((s) => s.addEventListener('click', () => uiSound.click()));
  } else {
    const hint = el('div');
    hint.textContent = 'Start driving to unlock paints.';
    hint.style.cssText = "opacity:.6;font:400 13px 'Inter',system-ui,sans-serif;text-align:center;";
    garagePanel.appendChild(hint);
  }
  const walletLine = el('div', 'dd-esc-wallet');
  const _updWallet = () => { walletLine.textContent = `💰 $${wallet.balance()}`; };
  _updWallet();
  wallet.onChange(_updWallet);
  garagePanel.appendChild(walletLine);

  // ── Display toggles (day/night stays in the top-right pill, not here) ──
  page.appendChild(sec('Display'));
  const dispRow = el('div', 'dd-esc-checkrow'); page.appendChild(dispRow);
  const metricsEls = (refs.metricsElements || []).filter(Boolean);
  let metricsOn = ls('dd_showMetrics', 'false') === 'true';   // OFF by default — it's a dev overlay; opt-in via the toggle
  const applyMetrics = () => { for (const e of metricsEls) e.style.display = metricsOn ? '' : 'none'; };
  applyMetrics();
  dispRow.appendChild(check('Stats for nerds', metricsOn, (v) => { metricsOn = v; ss('dd_showMetrics', v ? 'true' : 'false'); applyMetrics(); }));
  // Fullscreen. The click IS the user gesture the API requires, which is why this lives on a toggle
  // rather than being offered at load.
  //
  // ⚠ The toggle must not be the source of truth — the browser is. The user can leave fullscreen in
  // ways this code never sees (Esc, F11, the green macOS button, switching Spaces), and a toggle
  // that flipped optimistically would then sit there lying. So it reads document.fullscreenElement
  // via `live`, and a fullscreenchange listener re-runs the syncers so it corrects itself the moment
  // reality diverges — not merely the next time the menu happens to open.
  dispRow.appendChild(check('Fullscreen', !!document.fullscreenElement, (v) => {
    try {
      if (v) document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })?.catch(() => {});
      else document.exitFullscreen?.()?.catch(() => {});
    } catch { /* unsupported, or refused for want of a gesture — the syncer puts the toggle back */ }
  }, () => !!document.fullscreenElement, syncers));
  // Fly mode (free camera vs driving) — reloads to switch. Reflect the RESOLVED mode (a URL ?mode param
  // outranks dd_flyMode), and strip any mode param from the URL on reload so the toggle isn't a dead no-op.
  const flyInitial = refs.carMode != null ? !refs.carMode : (ls('dd_flyMode', 'false') === 'true');
  dispRow.appendChild(check('Fly mode', flyInitial, (v) => {
    ss('dd_flyMode', v ? 'true' : 'false');
    setTimeout(() => {
      try {
        const u = new URL(location.href);
        ['mode', 'car', 'fly', 'free', 'drone'].forEach((k) => u.searchParams.delete(k));
        location.replace(u.toString());
      } catch { location.reload(); }
    }, 120);
  }));

  // ── Sound ── (master on/off toggle first, then the volume sliders)
  page.appendChild(sec('Sound'));
  page.appendChild(check('Sound on', !audio.isMuted(), (v) => audio.setMuted(!v)));
  page.appendChild(slider('Master', Math.round(audio.getVolume() * 100), (n) => `${n}%`, (n) => audio.setVolume(n / 100)));
  page.appendChild(slider('Car', Math.round(audio.getCarVolume() * 100), (n) => `${n}%`, (n) => audio.setCarVolume(n / 100)));
  page.appendChild(slider('SFX', Math.round(audio.getSfxVolume() * 100), (n) => `${n}%`, (n) => audio.setSfxVolume(n / 100)));

  // ── Controls ──
  page.appendChild(sec('Controls'));
  const keys = [['W / ↑', 'Accelerate'], ['S / ↓', 'Brake · Reverse'], ['A / D', 'Steer'], ['Space', 'Handbrake · Drift'], ['H', 'Horn'], ['L', 'Headlights'], ['R', 'Recover'], ['M', 'Map'], ['Esc', 'Menu']];
  for (const [k, d] of keys) {
    const row = el('div', 'dd-esc-key');
    row.appendChild(el('span', 'd', d));
    row.appendChild(el('span', 'k', k));
    page.appendChild(row);
  }

  // (No BACK button — the ✕ top-right and Esc both close the menu.)

  document.body.appendChild(overlay);
  // ── EMBEDDED MODE ─────────────────────────────────────────────────────────────────────────────
  // When the hub hosts this page as its SETTINGS tab, this module must not also be a screen: no
  // overlay of its own, no ☰ button, no ESC binding. Two menus that both answer ESC is exactly the
  // duplication the hub was built to remove. Fly mode has no hub, so there it stays standalone.
  const embedded = !!refs.embedded;
  let fab = null;
  if (!embedded) {
    fab = el('div', 'dd-esc-fab', '☰'); fab.title = 'Settings (Esc)';
    fab.addEventListener('click', () => setOpen(true)); document.body.appendChild(fab);
  }

  // ── Spawn ──
  function spawnAt(lat, lon) { const u = new URL(window.location.href); u.searchParams.set('spawn', `${lat.toFixed(5)},${lon.toFixed(5)}`); window.location.href = u.toString(); }
  function inBounds(lat, lon) { return lat >= BOUNDS.minLat && lat <= BOUNDS.maxLat && lon >= BOUNDS.minLon && lon <= BOUNDS.maxLon; }
  let searching = false;
  async function doSearch() {
    const q = input.value.trim(); if (!q || searching) return;
    uiSound.confirm();
    searching = true; go.disabled = true; err.className = 'dd-esc-err'; err.textContent = 'Searching…';
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
      const data = await res.json();
      if (!data?.length) { err.textContent = `Couldn't find "${q}".`; return; }
      const lat = parseFloat(data[0].lat), lon = parseFloat(data[0].lon);
      if (!inBounds(lat, lon)) { err.textContent = `"${data[0].display_name?.split(',')[0] || q}" is outside the Barcelona map area.`; return; }
      err.className = 'dd-esc-err ok'; err.textContent = 'Found — loading…'; spawnAt(lat, lon);
    } catch { err.textContent = 'Search failed (no connection?). Try a button above.'; }
    finally { searching = false; go.disabled = false; }
  }
  go.addEventListener('click', doSearch);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
    else if (e.key === 'Escape') { input.blur(); setOpen(false); }  // Escape closes even while search is focused
    e.stopPropagation();
  });

  // ── Open / close ──
  let open = false;
  function sizeShowcase() {
    if (!showcase) return;
    const r = carStage.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) showcase.setSize(r.width, r.height);
  }
  function setOpen(v) {
    if (v !== open) (v ? uiSound.open() : uiSound.back());
    open = v; overlay.classList.toggle('open', v); if (fab) fab.style.display = v ? 'none' : 'flex';
    setInputBlocked(v);                    // pause car/recover/horn input while the menu is open
    if (v) {
      for (const s of syncers) s();        // refresh live toggle states on open
      if (!showcase) { showcase = createCarShowcase(); carStage.appendChild(showcase.element); }
      // wait a frame so the overlay is laid out before measuring the showcase panel
      requestAnimationFrame(() => { sizeShowcase(); showcase.start(); });
    } else if (showcase) {
      showcase.stop();                     // stop the turntable render loop while closed (zero cost in-game)
    }
  } // no auto-focus — search only focuses on click
  window.addEventListener('resize', () => { if (open) sizeShowcase(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) setOpen(false); });
  if (!embedded) {
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(!open); } });
  }

  return {
    open: () => setOpen(true), close: () => setOpen(false), isOpen: () => open,
    /** The settings page itself, for the hub to re-parent into its SETTINGS tab. */
    pageElement: page,
    /** Refresh toggles whose state can change outside this menu. The hub calls it on tab show. */
    runSyncers: () => { for (const sy of syncers) sy(); },
  };
}
