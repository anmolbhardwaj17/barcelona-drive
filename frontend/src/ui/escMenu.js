/**
 * ESC menu — full-screen game settings, art-of-rally style (blue-dark surface, Inter, flat controls, coral accent).
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
const LOGO_URL = '/logo-barcelona-drive.png';

import { uiSound } from './uiSound.js';
import { audio } from '../audio/audioManager.js';
import { setInputBlocked } from '../inputGate.js';
import { createCarShowcase } from './carShowcase.js';
import { wallet } from '../game/wallet.js';

const CSS = `
/* Art-of-rally ESC menu — cool blue-dark surface, Inter, flat controls, one coral accent. */
#dd-esc-overlay { position:fixed; inset:0; z-index:5000; display:none; color:#f3ede1;
  font-family:'Inter',-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
  background:radial-gradient(135% 105% at 50% -8%, #1e2637, #121a26 64%, #090d14); }
#dd-esc-overlay::before { content:''; position:absolute; inset:0; pointer-events:none;
  background:radial-gradient(60% 42% at 50% 4%, rgba(215,106,79,0.10), transparent 72%); }
#dd-esc-overlay.open { display:block; animation:ddPop .22s cubic-bezier(.2,.9,.25,1.05); }
@keyframes ddPop { from{opacity:0; transform:scale(.98)} to{opacity:1; transform:none} }
.dd-esc-wrap { position:relative; height:100%; padding:24px 6vw 28px; box-sizing:border-box; display:flex; flex-direction:column; }
.dd-esc-top { display:flex; align-items:center; justify-content:space-between; }
.dd-esc-logoimg { height:88px; filter:drop-shadow(0 4px 7px rgba(0,0,0,0.45)); }
/* car colour swatches (the re-parented picker) */
#dd-car-color-panel { gap:14px !important; align-items:center !important; }
#dd-car-color-panel span { display:none !important; }
#dd-car-color-panel > div[style*="50%"] { width:42px !important; height:42px !important; border:2px solid rgba(243,237,225,0.22) !important;
  box-shadow:0 2px 8px rgba(0,0,0,0.3); transition:transform .12s, box-shadow .12s, border-color .12s; }
#dd-car-color-panel > div[style*="50%"]:hover { transform:translateY(-2px); }
#dd-car-color-panel > div[style*="50%"].sel { border-color:#d76a4f !important; box-shadow:0 0 0 3px rgba(215,106,79,0.4) !important; }
#dd-car-color-panel > div:not([style*="50%"]) { display:none !important; }
.dd-esc-range { -webkit-appearance:none; appearance:none; width:240px; height:9px; border-radius:5px; background:rgba(243,237,225,0.18); border:none; outline:none; }
.dd-esc-range::-webkit-slider-thumb { -webkit-appearance:none; width:20px; height:20px; border-radius:50%; background:#d76a4f; border:2px solid #121a26; box-shadow:0 1px 4px rgba(0,0,0,0.4); cursor:pointer; }
.dd-esc-range::-moz-range-thumb { width:18px; height:18px; border-radius:50%; background:#d76a4f; border:2px solid #121a26; cursor:pointer; }
.dd-esc-val { min-width:52px; color:#e08a6f; font-size:17px; font-weight:600; }
.dd-esc-body { flex:1; display:flex; gap:34px; min-height:0; padding:12px 0; }
.dd-esc-left { flex:1 1 54%; overflow-y:auto; overflow-x:hidden; padding-right:10px; min-width:0; }
.dd-esc-page { width:100%; max-width:660px; }
/* Right column — "your car": the live turntable up top, then the paint + balance garage strip below. */
.dd-esc-showcase { flex:1 1 46%; min-width:0; align-self:stretch; display:flex; flex-direction:column; }
.dd-esc-carstage { flex:1 1 auto; position:relative; min-height:0; overflow:hidden; }
.dd-esc-carstage::after { content:'DRAG TO SPIN'; position:absolute; left:0; right:0; bottom:8px; text-align:center;
  font-size:11px; font-weight:600; letter-spacing:1.5px; color:rgba(243,237,225,0.34); pointer-events:none; }
.dd-esc-carstage canvas { position:absolute; inset:0; }
.dd-esc-garage { flex:0 0 auto; display:flex; flex-direction:column; align-items:center; gap:11px; padding:14px 0 4px; }
.dd-esc-glabel { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.08em; color:rgba(243,237,225,0.46); }
.dd-esc-wallet { font:600 18px 'Inter',system-ui,sans-serif; color:#e08a6f; }
@media (max-width:900px){ .dd-esc-body{ flex-direction:column; } .dd-esc-showcase{ min-height:260px; flex:0 0 260px; } }
.dd-esc-sec { display:flex; align-items:center; gap:14px; margin:24px 0 13px; font-size:14px; font-weight:600; letter-spacing:0.02em;
  text-transform:uppercase; color:#f3ede1; }
.dd-esc-sec::after { content:''; flex:1; height:1px; border-radius:1px; background:rgba(243,237,225,0.14); }
.dd-esc-line { display:flex; align-items:center; gap:16px; margin:14px 0; }
.dd-esc-searchrow { display:flex; gap:12px; }
.dd-esc-input { flex:1; background:rgba(243,237,225,0.06); border:1px solid rgba(243,237,225,0.18); color:#f3ede1;
  border-radius:11px; padding:14px 18px; font-family:inherit; font-size:17px; letter-spacing:0.3px; outline:none; transition:border-color .16s, background .16s; }
.dd-esc-input:focus { border-color:#d76a4f; background:rgba(243,237,225,0.09); }
.dd-esc-input::placeholder { color:rgba(243,237,225,0.4); }
/* flat buttons */
.dd-esc-go, .dd-esc-chip, .dd-esc-x, .dd-esc-back, .dd-esc-fab { cursor:pointer; user-select:none; transition:transform .1s, background .16s, border-color .16s, color .16s; }
.dd-esc-go { display:flex; align-items:center; padding:0 30px; border-radius:11px; font-family:inherit; font-size:16px; font-weight:600; text-transform:uppercase; letter-spacing:0.03em; color:#f3ede1;
  background:#d76a4f; border:1px solid transparent; }
.dd-esc-go:hover { background:#e0785c; }
.dd-esc-go:active { transform:scale(0.97); }
.dd-esc-go:disabled { opacity:.4; }
.dd-esc-err { margin-top:12px; min-height:22px; font-size:15px; color:#e88f76; } .dd-esc-err.ok { color:#93c47d; }
.dd-esc-chips { display:grid; grid-template-columns:repeat(auto-fill,minmax(184px,1fr)); gap:12px; margin-top:16px; }
.dd-esc-chip { text-align:center; padding:14px 12px; border-radius:11px; font-size:15px; font-weight:500; letter-spacing:0.3px; color:rgba(243,237,225,0.82);
  background:rgba(243,237,225,0.05); border:1px solid rgba(243,237,225,0.12); }
.dd-esc-chip:hover { border-color:rgba(215,106,79,0.6); color:#f3ede1; background:rgba(243,237,225,0.09); }
.dd-esc-chip:active { transform:scale(0.98); }
.dd-esc-chip.sel { border-color:#d76a4f; color:#f3ede1; background:rgba(215,106,79,0.18); }
.dd-esc-toggle { width:46px; height:26px; border-radius:14px; background:rgba(243,237,225,0.2); border:none;
  position:relative; cursor:pointer; transition:.16s; flex:0 0 auto; }
.dd-esc-toggle .k { position:absolute; top:3px; left:3px; width:20px; height:20px; border-radius:50%; background:#f3ede1; box-shadow:0 1px 3px rgba(0,0,0,0.4); transition:.16s; }
.dd-esc-toggle.on { background:#d76a4f; }
.dd-esc-toggle.on .k { left:23px; }
.dd-esc-tlabel { font-size:15px; color:rgba(243,237,225,0.82); }
/* Compact toggle grid — several per row to save vertical space */
.dd-esc-checkrow { display:flex; flex-wrap:wrap; gap:6px 26px; margin:8px 0 4px; }
.dd-esc-checkrow .dd-esc-line { margin:5px 0; gap:10px; }
.dd-esc-key { display:flex; align-items:center; justify-content:space-between; padding:10px 4px; }
.dd-esc-key .d { font-size:16px; color:rgba(243,237,225,0.82); }
.dd-esc-key .k { background:rgba(243,237,225,0.08); color:#f3ede1; border:1px solid rgba(243,237,225,0.2);
  border-radius:8px; padding:7px 15px; font-size:14px; font-weight:600; letter-spacing:0.02em; }
.dd-esc-bottom { padding-top:14px; }
.dd-esc-back { display:inline-flex; align-items:center; gap:8px; padding:13px 24px; border-radius:11px; font-family:inherit; font-size:15px; font-weight:600; text-transform:uppercase; letter-spacing:0.03em; color:#f3ede1;
  background:rgba(243,237,225,0.07); border:1px solid rgba(243,237,225,0.2); }
.dd-esc-back:hover { background:rgba(243,237,225,0.12); }
.dd-esc-back:active { transform:scale(0.97); }
.dd-esc-x { width:46px; height:46px; border-radius:13px; display:flex; align-items:center; justify-content:center; font-size:22px; color:#f3ede1;
  background:rgba(243,237,225,0.07); border:1px solid rgba(243,237,225,0.2); }
.dd-esc-x:hover { background:rgba(243,237,225,0.12); }
.dd-esc-x:active { transform:scale(0.95); }
.dd-esc-fab { position:fixed; top:14px; left:14px; z-index:1500; width:46px; height:46px; border-radius:13px; display:flex; align-items:center; justify-content:center; font-size:20px; color:#f3ede1; cursor:pointer;
  background:rgba(28,25,22,0.44); backdrop-filter:blur(15px) saturate(1.08); -webkit-backdrop-filter:blur(15px) saturate(1.08); border:1px solid rgba(243,237,225,0.16); box-shadow:0 3px 12px rgba(0,0,0,0.20); transition:background .18s ease, border-color .18s ease, transform .1s ease; }
.dd-esc-fab:hover { background:rgba(243,237,225,0.14); }
.dd-esc-fab:active { transform:translateY(1px) scale(0.97); }
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

  const overlay = el('div'); overlay.id = 'dd-esc-overlay';
  const wrap = el('div', 'dd-esc-wrap'); overlay.appendChild(wrap);

  const top = el('div', 'dd-esc-top');
  const logo = el('img', 'dd-esc-logoimg'); logo.src = LOGO_URL; logo.alt = 'Barcelona Drive';
  top.appendChild(logo);
  const xBtn = el('div', 'dd-esc-x', '✕'); xBtn.addEventListener('click', () => setOpen(false)); top.appendChild(xBtn);
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
  const fab = el('div', 'dd-esc-fab', '☰'); fab.title = 'Settings (Esc)';
  fab.addEventListener('click', () => setOpen(true)); document.body.appendChild(fab);

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
    open = v; overlay.classList.toggle('open', v); fab.style.display = v ? 'none' : 'flex';
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
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(!open); } });

  return { open: () => setOpen(true), close: () => setOpen(false), isOpen: () => open };
}
