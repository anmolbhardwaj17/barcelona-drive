/**
 * ESC menu — full-screen game settings, Brawl-Stars style (chunky 3D buttons, Lilita One, bright colours).
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
import { setCollisionDebugActive, isCollisionDebugActive } from '../collisionDebug.js';

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Lilita+One&display=swap');
#dd-esc-overlay { position:fixed; inset:0; z-index:5000; display:none; color:#fff;
  font-family:'Lilita One',-apple-system,BlinkMacSystemFont,sans-serif;
  background:radial-gradient(130% 100% at 50% -5%, #1e2637, #121722 62%, #080a10); }
#dd-esc-overlay::before { content:''; position:absolute; inset:0; pointer-events:none;
  background:radial-gradient(55% 38% at 50% 6%, rgba(255,80,70,0.08), transparent 70%); }
#dd-esc-overlay.open { display:block; animation:ddPop .22s cubic-bezier(.2,.9,.25,1.15); }
@keyframes ddPop { from{opacity:0; transform:scale(.96)} to{opacity:1; transform:none} }
.dd-esc-wrap { position:relative; height:100%; padding:24px 6vw 28px; box-sizing:border-box; display:flex; flex-direction:column; }
.dd-esc-top { display:flex; align-items:center; justify-content:space-between; }
.dd-esc-logoimg { height:96px; filter:drop-shadow(0 5px 6px rgba(0,0,0,0.5)); }
/* proper car colour swatches (the re-parented picker, enlarged + game-styled) */
#dd-car-color-panel { gap:14px !important; align-items:center !important; }
#dd-car-color-panel span { display:none !important; } /* hide the small "Car" label — section header covers it */
#dd-car-color-panel > div[style*="50%"] { width:44px !important; height:44px !important; border:3px solid rgba(255,255,255,0.3) !important;
  box-shadow:0 5px 0 rgba(0,0,0,0.35); transition:transform .1s, box-shadow .1s; }
#dd-car-color-panel > div[style*="50%"]:hover { transform:translateY(-2px); }
#dd-car-color-panel > div[style*="50%"].sel { border-color:#ffd23f !important; box-shadow:0 0 0 4px rgba(255,210,63,0.4), 0 5px 0 rgba(0,0,0,0.35) !important; }
#dd-car-color-panel > div:not([style*="50%"]) { display:none !important; } /* hide the little speaker btn — Sound section handles it */
.dd-esc-range { -webkit-appearance:none; appearance:none; width:240px; height:10px; border-radius:6px; background:rgba(0,0,0,0.4); border:2px solid rgba(0,0,0,0.28); outline:none; }
.dd-esc-range::-webkit-slider-thumb { -webkit-appearance:none; width:26px; height:26px; border-radius:50%; background:linear-gradient(#ffe07a,#f5b32a); border:2px solid rgba(0,0,0,0.2); box-shadow:0 4px 0 #c88a10; cursor:pointer; }
.dd-esc-range::-moz-range-thumb { width:24px; height:24px; border-radius:50%; background:#f5b32a; border:2px solid rgba(0,0,0,0.2); cursor:pointer; }
.dd-esc-val { min-width:52px; color:#ffd23f; font-size:19px; text-shadow:0 2px 0 rgba(0,0,0,0.28); }
.dd-esc-body { flex:1; overflow:auto; padding:14px 0; }
.dd-esc-page { width:min(740px,100%); margin:0 auto; }
.dd-esc-sec { display:flex; align-items:center; gap:14px; margin:24px 0 13px; font-size:19px; letter-spacing:1.5px;
  text-transform:uppercase; color:#ffd23f; text-shadow:0 2px 0 rgba(0,0,0,0.3); }
.dd-esc-sec::after { content:''; flex:1; height:3px; border-radius:2px; background:rgba(255,210,63,0.2); }
.dd-esc-line { display:flex; align-items:center; gap:16px; margin:14px 0; }
.dd-esc-searchrow { display:flex; gap:12px; }
.dd-esc-input { flex:1; background:rgba(0,0,0,0.32); border:3px solid rgba(255,255,255,0.16); color:#fff;
  border-radius:18px; padding:15px 20px; font-family:inherit; font-size:19px; letter-spacing:0.5px; outline:none; }
.dd-esc-input:focus { border-color:#ffd23f; }
.dd-esc-input::placeholder { color:rgba(255,255,255,0.42); }
/* chunky 3D buttons (press = sink into the shadow) */
.dd-esc-go, .dd-esc-chip, .dd-esc-x, .dd-esc-back, .dd-esc-fab { cursor:pointer; user-select:none; transition:transform .05s, box-shadow .05s; }
.dd-esc-go { display:flex; align-items:center; padding:0 32px; border-radius:18px; font-family:inherit; font-size:21px; letter-spacing:1px; color:#123008;
  background:linear-gradient(#84e56f,#54c247); border:3px solid rgba(0,0,0,0.16); box-shadow:0 7px 0 #369a2c, 0 11px 16px rgba(0,0,0,0.4); text-shadow:0 2px 0 rgba(255,255,255,0.35); }
.dd-esc-go:active { transform:translateY(6px); box-shadow:0 1px 0 #369a2c; }
.dd-esc-go:disabled { opacity:.55; }
.dd-esc-err { margin-top:12px; min-height:22px; font-size:17px; color:#ff9a9a; text-shadow:0 2px 0 rgba(0,0,0,0.3); } .dd-esc-err.ok { color:#9dffb0; }
.dd-esc-chips { display:grid; grid-template-columns:repeat(auto-fill,minmax(184px,1fr)); gap:15px; margin-top:16px; }
.dd-esc-chip { text-align:center; padding:15px 12px; border-radius:16px; font-size:17px; letter-spacing:0.5px; color:#e9eef6; text-shadow:0 2px 0 rgba(0,0,0,0.4);
  background:linear-gradient(#3c4658,#2a323f); border:2px solid rgba(0,0,0,0.28); box-shadow:0 5px 0 #171d26, 0 8px 12px rgba(0,0,0,0.35); }
.dd-esc-chip:hover { border-color:#ffd23f; color:#fff; }
.dd-esc-chip:active { transform:translateY(5px); box-shadow:0 1px 0 #171d26; }
.dd-esc-toggle { width:80px; height:40px; border-radius:22px; background:#5a4a8a; border:3px solid rgba(0,0,0,0.2);
  position:relative; cursor:pointer; box-shadow:inset 0 3px 6px rgba(0,0,0,0.35); transition:.15s; }
.dd-esc-toggle .k { position:absolute; top:3px; left:3px; width:32px; height:30px; border-radius:18px; background:#fff; box-shadow:0 3px 5px rgba(0,0,0,0.35); transition:.15s; }
.dd-esc-toggle.on { background:linear-gradient(#84e56f,#54c247); border-color:rgba(0,0,0,0.16); }
.dd-esc-toggle.on .k { left:42px; }
.dd-esc-tlabel { font-size:20px; color:#fff; text-shadow:0 2px 0 rgba(0,0,0,0.28); }
.dd-esc-key { display:flex; align-items:center; justify-content:space-between; padding:11px 4px; }
.dd-esc-key .d { font-size:19px; color:rgba(255,255,255,0.88); text-shadow:0 2px 0 rgba(0,0,0,0.25); }
.dd-esc-key .k { background:linear-gradient(#ffe07a,#f5b32a); color:#3a2a00; border:3px solid rgba(0,0,0,0.15);
  box-shadow:0 5px 0 #c88a10; border-radius:14px; padding:9px 18px; font-size:17px; letter-spacing:1px; }
.dd-esc-bottom { padding-top:14px; }
.dd-esc-back { display:inline-flex; align-items:center; gap:8px; padding:14px 26px; border-radius:18px; font-family:inherit; font-size:20px; letter-spacing:1px; color:#fff; text-shadow:0 2px 0 rgba(0,0,0,0.35);
  background:linear-gradient(#ff8a63,#ff5a4d); border:3px solid rgba(0,0,0,0.16); box-shadow:0 7px 0 #c8342a, 0 11px 14px rgba(0,0,0,0.35); }
.dd-esc-back:active { transform:translateY(6px); box-shadow:0 1px 0 #c8342a; }
.dd-esc-x { width:52px; height:52px; border-radius:18px; display:flex; align-items:center; justify-content:center; font-size:26px; color:#fff;
  background:linear-gradient(#ff8a63,#ff5a4d); border:3px solid rgba(0,0,0,0.16); box-shadow:0 6px 0 #c8342a, 0 9px 12px rgba(0,0,0,0.35); }
.dd-esc-x:active { transform:translateY(5px); box-shadow:0 1px 0 #c8342a; }
.dd-esc-fab { position:fixed; top:12px; left:12px; z-index:1500; width:50px; height:50px; border-radius:18px; display:flex; align-items:center; justify-content:center; font-size:24px; color:#3a2a00;
  background:linear-gradient(#ffe07a,#f2a626); border:3px solid rgba(0,0,0,0.15); box-shadow:0 6px 0 #c88010, 0 9px 12px rgba(0,0,0,0.35); }
.dd-esc-fab:active { transform:translateY(5px); box-shadow:0 1px 0 #c88010; }
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

function check(label, checked, onChange) {
  const line = el('div', 'dd-esc-line');
  const tg = el('div', 'dd-esc-toggle' + (checked ? ' on' : ''));
  tg.appendChild(el('div', 'k'));
  tg.addEventListener('click', () => { checked = !checked; tg.classList.toggle('on', checked); uiSound.toggle(checked); onChange(checked); });
  line.appendChild(tg); line.appendChild(el('span', 'dd-esc-tlabel', label));
  return line;
}

export function createEscMenu(refs = {}) {
  document.head.appendChild(Object.assign(el('style'), { textContent: CSS }));

  const overlay = el('div'); overlay.id = 'dd-esc-overlay';
  const wrap = el('div', 'dd-esc-wrap'); overlay.appendChild(wrap);

  const top = el('div', 'dd-esc-top');
  const logo = el('img', 'dd-esc-logoimg'); logo.src = LOGO_URL; logo.alt = 'Barcelona Drive';
  top.appendChild(logo);
  const xBtn = el('div', 'dd-esc-x', '✕'); xBtn.addEventListener('click', () => setOpen(false)); top.appendChild(xBtn);
  wrap.appendChild(top);

  const bodyEl = el('div', 'dd-esc-body'); wrap.appendChild(bodyEl);
  const page = el('div', 'dd-esc-page'); bodyEl.appendChild(page);

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

  // ── Car colour (re-parented) ──
  const colorPanel = refs.colorPanelElement || document.getElementById('dd-car-color-panel');
  if (colorPanel) {
    page.appendChild(sec('Car'));
    Object.assign(colorPanel.style, { position: 'static', top: 'auto', left: 'auto', background: 'transparent', padding: '0', flexWrap: 'wrap' });
    const holder = el('div'); holder.style.padding = '6px 0 6px 2px'; holder.appendChild(colorPanel); page.appendChild(holder);
    // Highlight the active swatch (click + restore from saved colour).
    const hexToRgb = (h) => { h = (h || '').replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); const n = parseInt(h, 16); return Number.isFinite(n) ? `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})` : ''; };
    const savedRgb = hexToRgb(ls('dd_carColor', ''));
    const swatches = colorPanel.querySelectorAll('div[style*="50%"]');
    const markSel = (elm) => { swatches.forEach((s) => s.classList.remove('sel')); if (elm) elm.classList.add('sel'); };
    swatches.forEach((s) => {
      if (savedRgb && getComputedStyle(s).backgroundColor === savedRgb) markSel(s);
      s.addEventListener('click', () => { uiSound.click(); markSel(s); });
    });
  }

  // ── Display toggles (day/night stays in the top-right pill, not here) ──
  page.appendChild(sec('Display'));
  const metricsEls = (refs.metricsElements || []).filter(Boolean);
  let metricsOn = ls('dd_showMetrics', 'true') !== 'false';
  const applyMetrics = () => { for (const e of metricsEls) e.style.display = metricsOn ? '' : 'none'; };
  applyMetrics();
  page.appendChild(check('Stats for nerds', metricsOn, (v) => { metricsOn = v; ss('dd_showMetrics', v ? 'true' : 'false'); applyMetrics(); }));
  // Fly mode (free camera vs driving) — reloads to switch.
  page.appendChild(check('Fly mode', ls('dd_flyMode', 'false') === 'true', (v) => { ss('dd_flyMode', v ? 'true' : 'false'); setTimeout(() => location.reload(), 120); }));
  // Collision wireframes — debug overlay of every collider near the car (also toggles with the K key).
  page.appendChild(check('Collision wireframes', isCollisionDebugActive(), (v) => setCollisionDebugActive(v)));

  // ── Sound ──
  page.appendChild(sec('Sound'));
  page.appendChild(slider('Volume', Math.round(audio.getVolume() * 100), (n) => `${n}%`, (n) => audio.setVolume(n / 100)));
  page.appendChild(check('Sound on', !audio.isMuted(), (v) => audio.setMuted(!v)));

  // ── Controls ──
  page.appendChild(sec('Controls'));
  const keys = [['W / ↑', 'Accelerate'], ['S / ↓', 'Brake · Reverse'], ['A / D', 'Steer'], ['Space', 'Handbrake · Drift'], ['H', 'Horn'], ['Esc', 'Menu']];
  for (const [k, d] of keys) {
    const row = el('div', 'dd-esc-key');
    row.appendChild(el('span', 'd', d));
    row.appendChild(el('span', 'k', k));
    page.appendChild(row);
  }

  // Bottom
  const bottom = el('div', 'dd-esc-bottom');
  const back = el('div', 'dd-esc-back', '◄ BACK');
  back.addEventListener('click', () => setOpen(false)); bottom.appendChild(back);
  wrap.appendChild(bottom);

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
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); e.stopPropagation(); });

  // ── Open / close ──
  let open = false;
  function setOpen(v) {
    if (v !== open) (v ? uiSound.open() : uiSound.back());
    open = v; overlay.classList.toggle('open', v); fab.style.display = v ? 'none' : 'flex';
  } // no auto-focus — search only focuses on click
  overlay.addEventListener('click', (e) => { if (e.target === overlay) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(!open); } });

  return { open: () => setOpen(true), close: () => setOpen(false), isOpen: () => open };
}
