/**
 * mainMenu.js — the hub you land on after the world finishes loading. ETS2 garage-screen layout:
 * GAME MODES left · your car in the middle · the city map right · settings on its own screen.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────────
 * Modes used to be chosen in two places, and neither was right. The title screen asked you to
 * commit to a mode BEFORE the spawn area loaded, so you picked blind and then watched a progress
 * bar — and what that bar loads does not depend on the mode at all. The ESC menu offered the same
 * five choices again, filed under settings, which is not what a settings menu is for.
 *
 * So the order is inverted: PLAY → load → land here, with the world already built behind the
 * overlay. Modes live here and nowhere else; ESC is settings and only settings.
 *
 * ── MODE ART ──────────────────────────────────────────────────────────────────────────────────
 * Each row looks for `/modes/mode-<key>.webp` — the SAME five files the title screen already
 * preloads, not a new path. There is no error path on purpose: a missing image simply leaves the
 * CSS gradient and the glyph showing, which is a legible card rather than a broken one, so new art
 * can replace those files without a code change.
 */
import { uiSound } from './uiSound.js';
import { setInputBlocked } from '../inputGate.js';
import { createCarShowcase } from './carShowcase.js';
import { wallet } from '../game/wallet.js';
import { latLonToWorld, worldToLatLon } from '../projection.js';

/** The city, for framing the map panel. Matches the ESC menu's spawn bounds. */
const CITY = { minLat: 41.3580, minLon: 2.1198, maxLat: 41.4130, maxLon: 2.2230 };
const LOGO_URL = '/logo-barcelona-drive.webp';

/** Per-mode fallback tint, used until `/art/modes/<key>.webp` exists. Keyed to each mode's feel. */
const MODE_TINT = {
  free:     'linear-gradient(135deg,#2a3a4d,#16202b)',
  dash:     'linear-gradient(135deg,#4d3a1f,#1f1810)',
  taxi:     'linear-gradient(135deg,#4d431a,#201c0e)',
  delivery: 'linear-gradient(135deg,#2c4034,#141d18)',
  police:   'linear-gradient(135deg,#3d2430,#1a1016)',
};
const MODE_BLURB = {
  free:     'Cruise the open city',
  dash:     'Beat the clock, gate to gate',
  taxi:     'Pick up. Drop off. Get paid',
  delivery: 'Deliveries against the clock',
  police:   'Outrun the patrol',
};

const CSS = `
/* Shares the ESC menu's ETS2 tokens — squared plates, amber accent, the world blurred behind. */
#dd-mm {
  --e-plate:#1a212a; --e-plate-2:#222b35; --e-line:#35414e; --e-line-hi:#4a5765;
  --e-text:#d6dce3; --e-dim:#8a97a4; --e-accent:#e6a33c; --e-accent-d:#b87d24;
  position:fixed; inset:0; z-index:5200; display:none; color:var(--e-text);
  font-family:'Inter',-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
  background:linear-gradient(180deg, rgba(11,15,20,0.90), rgba(8,11,15,0.97));
  backdrop-filter:blur(13px) saturate(0.72); -webkit-backdrop-filter:blur(13px) saturate(0.72); }
#dd-mm::before { content:''; position:absolute; inset:0; pointer-events:none; opacity:0.5;
  background:repeating-linear-gradient(0deg, rgba(255,255,255,0.012) 0 1px, transparent 1px 3px); }
#dd-mm.open { display:flex; flex-direction:column; animation:ddMmIn .18s ease-out; }
@keyframes ddMmIn { from{opacity:0} to{opacity:1} }

.dd-mm-top { display:flex; align-items:center; justify-content:space-between; gap:18px;
  padding:16px 4vw 13px; border-bottom:1px solid var(--e-line); box-shadow:0 1px 0 rgba(230,163,60,0.28); }
.dd-mm-topleft { display:flex; align-items:center; gap:20px; min-width:0; }
.dd-mm-logo { height:46px; filter:drop-shadow(0 2px 4px rgba(0,0,0,0.6)); }
/* Money is a PLATE, not a number floating next to a button. Top-left, beside the logo, because
   that is where a player looks for their balance and because the right-hand side is for actions. */
.dd-mm-cash { display:flex; flex-direction:column; gap:3px; padding:9px 16px;
  background:linear-gradient(180deg,var(--e-plate-2),var(--e-plate));
  border:1px solid var(--e-line); border-left:3px solid var(--e-accent);
  box-shadow:inset 0 1px 0 rgba(255,255,255,0.05); }
.dd-mm-cash .lbl { font-size:9px; font-weight:700; letter-spacing:0.2em; text-transform:uppercase; color:var(--e-dim); }
.dd-mm-cash .amt { font:700 20px 'Inter',system-ui,sans-serif; color:var(--e-accent); letter-spacing:0.04em;
  font-variant-numeric:tabular-nums; line-height:1; }
/* Tabs, not a second screen. GARAGE and SETTINGS are two views of one menu — the whole reason
   the ESC overlay was folded in here was that two menus with two looks answering one key is
   duplication, not depth. */
.dd-mm-tab { cursor:pointer; user-select:none; padding:11px 22px; font-size:11px; font-weight:700;
  text-transform:uppercase; letter-spacing:0.16em; color:var(--e-dim);
  background:linear-gradient(180deg,#1d242d,#171d25); border:1px solid var(--e-line);
  border-bottom:2px solid transparent; transition:color .14s, background .14s, border-color .14s; }
.dd-mm-tab:hover { color:var(--e-text); background:linear-gradient(180deg,#242d38,#1b222b); }
.dd-mm-tab.on { color:var(--e-accent); border-bottom-color:var(--e-accent); background:linear-gradient(180deg,#2b2418,#1d1810); }
/* The re-parented settings page. Capped and centred so a long settings column does not become a
   full-width wall of toggles on a wide monitor. */
.dd-mm-settings { display:none; grid-column:1 / -1; overflow-y:auto; min-height:0; padding-right:12px; }
.dd-mm-settings.on { display:block; }
.dd-mm-settings > * { max-width:760px; }
.dd-mm-settings::-webkit-scrollbar { width:9px; }
.dd-mm-settings::-webkit-scrollbar-track { background:#111720; }
.dd-mm-settings::-webkit-scrollbar-thumb { background:var(--e-line); }
#dd-mm.settings .dd-mm-col { display:none; }
/* ☰ — opens the hub in-game. Moved here from the ESC menu, which no longer owns a screen. */
.dd-mm-fab { position:fixed; top:12px; left:12px; z-index:1500; width:40px; height:40px;
  display:flex; align-items:center; justify-content:center; font-size:16px; color:var(--e-text); cursor:pointer;
  background:rgba(22,28,35,0.72); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  border:1px solid rgba(74,87,101,0.85); border-left:2px solid rgba(230,163,60,0.75);
  box-shadow:inset 0 1px 0 rgba(255,255,255,0.06), 0 2px 8px rgba(0,0,0,0.35); }
.dd-mm-fab:hover { background:rgba(38,47,57,0.88); }
.dd-mm-btn { cursor:pointer; user-select:none; padding:11px 20px; font-size:11px; font-weight:700;
  text-transform:uppercase; letter-spacing:0.16em; color:var(--e-text);
  background:linear-gradient(180deg,#252e38,#1a212a); border:1px solid var(--e-line-hi);
  box-shadow:inset 0 1px 0 rgba(255,255,255,0.06); transition:background .14s, border-color .14s; }
.dd-mm-btn:hover { background:linear-gradient(180deg,#2e3945,#212a34); border-color:var(--e-accent-d); }
.dd-mm-btn:active { background:#171d25; box-shadow:inset 0 2px 4px rgba(0,0,0,0.4); }
.dd-mm-btn.primary { color:#161a1f; background:linear-gradient(180deg,#f2b555,var(--e-accent-d));
  border-color:#7d5415; box-shadow:inset 0 1px 0 rgba(255,255,255,0.28); }
.dd-mm-btn.primary:hover { background:linear-gradient(180deg,#f7c069,#c98b2a); }

.dd-mm-body { flex:1; display:grid; grid-template-columns:300px 1fr 330px; gap:20px;
  padding:18px 4vw 14px; min-height:0; box-sizing:border-box; }
.dd-mm-col { display:flex; flex-direction:column; min-height:0; min-width:0; }
.dd-mm-head { display:flex; align-items:center; gap:10px; padding:8px 13px; margin-bottom:10px;
  font-size:11px; font-weight:700; letter-spacing:0.2em; text-transform:uppercase; color:var(--e-text);
  background:linear-gradient(180deg,var(--e-plate-2),var(--e-plate));
  border:1px solid var(--e-line); border-left:3px solid var(--e-accent);
  box-shadow:inset 0 1px 0 rgba(255,255,255,0.05); flex:0 0 auto; }
.dd-mm-head::after { content:''; flex:1; height:1px; background:linear-gradient(90deg,var(--e-line),transparent); }

/* ── LEFT: game modes ── */
.dd-mm-modelist { flex:1 1 auto; overflow-y:auto; display:flex; flex-direction:column; gap:8px; padding-right:4px; }
/* ── FULL-BLEED CARDS ─────────────────────────────────────────────────────────────────────────
   Was a 78 px thumbnail with text beside it, which is a list row wearing a picture. These are the
   five things you can DO in the game, so each is a card: the art fills it and the text sits on top.
   The scrim is not decoration — white type over an arbitrary photograph is unreadable, so a
   bottom-weighted gradient guarantees contrast whatever art lands in the slot. */
.dd-mm-mode { position:relative; cursor:pointer; user-select:none; flex:0 0 auto;
  min-height:104px; display:flex; align-items:flex-end; overflow:hidden;
  border:1px solid var(--e-line); background-size:cover; background-position:center;
  transition:border-color .14s, transform .14s; }
.dd-mm-mode::after { content:''; position:absolute; inset:0; pointer-events:none;
  background:linear-gradient(180deg, rgba(8,11,15,0.10) 0%, rgba(8,11,15,0.55) 52%, rgba(8,11,15,0.90) 100%);
  transition:background .16s; }
.dd-mm-mode::before { content:''; position:absolute; left:0; top:0; bottom:0; width:3px; z-index:2;
  background:var(--e-accent); transform:scaleX(0); transform-origin:left; transition:transform .14s; }
.dd-mm-mode:hover { border-color:var(--e-line-hi); }
.dd-mm-mode:hover::after { background:linear-gradient(180deg, rgba(8,11,15,0.02) 0%, rgba(8,11,15,0.44) 52%, rgba(8,11,15,0.86) 100%); }
.dd-mm-mode:hover::before { transform:scaleX(1); }
.dd-mm-mode.sel { border-color:var(--e-accent); }
.dd-mm-mode.sel::before { transform:scaleX(1); }
.dd-mm-mode.sel::after { background:linear-gradient(180deg, rgba(40,26,6,0.10) 0%, rgba(20,14,4,0.52) 52%, rgba(12,9,4,0.90) 100%); }
.dd-mm-mtext { position:relative; z-index:1; width:100%; min-width:0; padding:11px 14px 12px;
  display:flex; flex-direction:column; gap:3px; }
.dd-mm-mname { font-size:13px; font-weight:700; letter-spacing:0.14em; text-transform:uppercase; color:#fff;
  text-shadow:0 1px 4px rgba(0,0,0,0.85); }
.dd-mm-mode.sel .dd-mm-mname { color:var(--e-accent); }
.dd-mm-mblurb { font-size:11px; letter-spacing:0.04em; color:rgba(255,255,255,0.78);
  text-shadow:0 1px 3px rgba(0,0,0,0.85); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
/* The emoji is the fallback badge — it only reads while there is no art under it. */
.dd-mm-glyph { position:absolute; top:9px; right:11px; z-index:1; font-size:17px; opacity:.55; }

/* ── CENTRE: the car ── */
.dd-mm-stage { flex:1 1 auto; position:relative; min-height:0; overflow:hidden;
  background:linear-gradient(180deg,#161d25,#10151b); border:1px solid var(--e-line); }
.dd-mm-stage canvas { position:absolute; inset:0; }
.dd-mm-stage::after { content:'DRAG TO SPIN'; position:absolute; left:0; right:0; bottom:8px; text-align:center;
  font-size:10px; font-weight:700; letter-spacing:0.22em; color:var(--e-dim); opacity:.7; pointer-events:none; }
/* Paint sits ABOVE the car as a thin bar. Below the stage it was a full-width block competing with
   the car for the column's height; the swatches are a strip, so they get a strip. */
.dd-mm-paintbar { flex:0 0 auto; display:flex; align-items:center; gap:12px; padding:8px 13px;
  background:var(--e-plate); border:1px solid var(--e-line); border-bottom:none; }
.dd-mm-paintbar .lbl { font-size:9px; font-weight:700; letter-spacing:0.2em; text-transform:uppercase;
  color:var(--e-dim); flex:0 0 auto; }
.dd-mm-paint { display:flex; align-items:center; gap:7px; min-width:0; flex-wrap:wrap; }
/* Higher specificity than escMenu's own #dd-car-color-panel rule, so the swatches shrink to bar size
   here without changing them anywhere else. */
#dd-mm .dd-mm-paint > div[style*="50%"] { width:26px !important; height:26px !important; }
.dd-mm-garage { flex:0 0 auto; display:flex; align-items:center; justify-content:center;
  padding:12px 14px; background:var(--e-plate); border:1px solid var(--e-line); border-top:none; }
.dd-mm-drive { flex:0 0 auto; padding:13px 44px; font-size:13px; letter-spacing:0.2em; }

/* ── RIGHT: the city map ── */
.dd-mm-mapwrap { flex:0 0 auto; position:relative; background:#10151b; border:1px solid var(--e-line); }
.dd-mm-mapwrap canvas { display:block; width:100%; height:auto; }
.dd-mm-search { flex:0 0 auto; margin-top:10px; width:100%; box-sizing:border-box; background:#12171e;
  border:1px solid var(--e-line); color:var(--e-text); padding:11px 13px; font-family:inherit;
  font-size:12px; letter-spacing:0.06em; outline:none; box-shadow:inset 0 1px 3px rgba(0,0,0,0.45);
  transition:border-color .14s; }
.dd-mm-search:focus { border-color:var(--e-accent); }
.dd-mm-search::placeholder { color:var(--e-dim); letter-spacing:0.05em; }
.dd-mm-listhead { flex:0 0 auto; margin:9px 0 6px; font-size:9px; font-weight:700; letter-spacing:0.2em;
  text-transform:uppercase; color:var(--e-dim); }
.dd-mm-places { flex:1 1 auto; overflow-y:auto; display:flex; flex-direction:column; gap:5px; padding-right:4px; }
.dd-mm-place .tier { float:right; font-size:9px; letter-spacing:0.14em; color:var(--e-dim); opacity:.8; }
.dd-mm-place { position:relative; cursor:pointer; user-select:none; padding:10px 13px; font-size:11px;
  font-weight:600; letter-spacing:0.1em; text-transform:uppercase; color:var(--e-dim);
  background:linear-gradient(180deg,#1d242d,#171d25); border:1px solid var(--e-line); transition:background .14s, color .14s; }
.dd-mm-place::before { content:''; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--e-accent);
  transform:scaleY(0); transition:transform .14s; }
.dd-mm-place:hover { color:var(--e-text); background:linear-gradient(180deg,#242d38,#1b222b); }
.dd-mm-place:hover::before { transform:scaleY(1); }

/* Bottom-centre nav. Garage / Settings / Resume are navigation, not header furniture — they belong
   where the thumbs and the eye end up, not tucked beside the logo. */
.dd-mm-foot { flex:0 0 auto; display:flex; flex-direction:column; align-items:center; gap:8px;
  padding:12px 4vw 16px; border-top:1px solid var(--e-line); }
.dd-mm-nav { display:flex; align-items:stretch; gap:10px; }
.dd-mm-hint { font-size:10px; font-weight:600; letter-spacing:0.16em; text-transform:uppercase; color:var(--e-dim); }

.dd-mm-modelist::-webkit-scrollbar, .dd-mm-places::-webkit-scrollbar { width:8px; }
.dd-mm-modelist::-webkit-scrollbar-track, .dd-mm-places::-webkit-scrollbar-track { background:#111720; }
.dd-mm-modelist::-webkit-scrollbar-thumb, .dd-mm-places::-webkit-scrollbar-thumb { background:var(--e-line); }

@media (max-width:1100px) {
  .dd-mm-body { grid-template-columns:1fr; grid-auto-rows:min-content; overflow-y:auto; }
  .dd-mm-stage { min-height:240px; }
}
`;

const PLACES = [
  { name: 'Eixample', lat: 41.3920, lon: 2.1650 },
  { name: 'Sagrada Família', lat: 41.4036, lon: 2.1744 },
  { name: 'Passeig de Gràcia', lat: 41.3948, lon: 2.1602 },
  { name: 'Barceloneta', lat: 41.3797, lon: 2.1899 },
  { name: 'Port Olímpic', lat: 41.3875, lon: 2.1969 },
  { name: 'Montjuïc', lat: 41.3641, lon: 2.1585 },
  { name: 'Gothic Quarter', lat: 41.3833, lon: 2.1777 },
  { name: 'Camp Nou', lat: 41.3809, lon: 2.1228 },
];

function el(t, c, h) { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; }

/**
 * @param {object} refs
 * @param {object[]} refs.gameModes  registered modes ({ name, icon, key, start, stop, isRunning })
 * @param {object}   refs.customMap  the shared city map store, for the right-hand panel
 * @param {Element}  refs.colorPanelElement  the paint picker, re-parented into the garage strip
 * @param {Function} refs.onOpenSettings
 */
export function createMainMenu(refs = {}) {
  document.head.appendChild(Object.assign(el('style'), { textContent: CSS }));

  const modes = (refs.gameModes || []).filter(Boolean);
  const entries = [{ key: 'free', name: 'Free Roam', icon: '🗺️', mode: null }]
    .concat(modes.map((m) => ({ key: m.key, name: m.name, icon: m.icon, mode: m })));

  let selected = entries[0];
  try {
    const saved = sessionStorage.getItem('dd_mode');
    const hit = entries.find((e) => e.key === saved);
    if (hit) selected = hit;
  } catch { /* private mode */ }

  const root = el('div'); root.id = 'dd-mm';

  // ── header ──
  const top = el('div', 'dd-mm-top');
  const topLeft = el('div', 'dd-mm-topleft');
  const logo = el('img', 'dd-mm-logo'); logo.src = LOGO_URL; logo.alt = 'Barcelona Drive';
  const cash = el('div', 'dd-mm-cash');
  cash.appendChild(el('div', 'lbl', 'Balance'));
  const cashAmt = el('div', 'amt', '0');
  cash.appendChild(cashAmt);
  topLeft.appendChild(logo); topLeft.appendChild(cash);
  top.appendChild(topLeft);
  // Nav is built here but lives in the FOOTER, centred — see below.
  const tabGarage = el('div', 'dd-mm-tab on', 'Garage');
  const tabSettings = el('div', 'dd-mm-tab', 'Settings');
  const resumeBtn = el('div', 'dd-mm-btn', 'Resume');
  tabGarage.addEventListener('click', () => { uiSound.click(); setTab('garage'); });
  tabSettings.addEventListener('click', () => { uiSound.click(); setTab('settings'); });
  resumeBtn.addEventListener('click', () => setOpen(false));
  root.appendChild(top);

  // Live, not read-once: a mode can pay out while the hub is open behind a result screen.
  const paintCash = () => { cashAmt.textContent = '€' + (wallet?.balance ? wallet.balance() : 0).toLocaleString('en-GB'); };
  paintCash();
  try { wallet?.onChange?.(paintCash); } catch { /* wallet optional */ }

  const body = el('div', 'dd-mm-body'); root.appendChild(body);

  // ── LEFT: modes ──
  const leftCol = el('div', 'dd-mm-col');
  leftCol.appendChild(el('div', 'dd-mm-head', 'Game Modes'));
  const modeList = el('div', 'dd-mm-modelist');
  const rowEls = new Map();
  for (const e of entries) {
    const row = el('div', 'dd-mm-mode');
    // No onerror path: a 404 falls through to the CSS gradient, so the card stays legible under its
    // scrim rather than breaking. Art can land later with no code change.
    row.style.backgroundImage = `url(/modes/mode-${e.key}.webp), ${MODE_TINT[e.key] || MODE_TINT.free}`;
    row.appendChild(el('div', 'dd-mm-glyph', e.icon));
    const txt = el('div', 'dd-mm-mtext');
    txt.appendChild(el('div', 'dd-mm-mname', e.name));
    txt.appendChild(el('div', 'dd-mm-mblurb', MODE_BLURB[e.key] || ''));
    row.appendChild(txt);
    row.addEventListener('click', () => { uiSound.click(); selected = e; repaint(); });
    row.addEventListener('dblclick', () => drive());
    rowEls.set(e.key, row);
    modeList.appendChild(row);
  }
  leftCol.appendChild(modeList);
  body.appendChild(leftCol);

  function repaint() {
    for (const [k, r] of rowEls) r.classList.toggle('sel', k === selected.key);
    driveBtn.textContent = selected.key === 'free' ? 'Drive' : `Start ${selected.name}`;
  }

  // ── CENTRE: the car ──
  const midCol = el('div', 'dd-mm-col');
  midCol.appendChild(el('div', 'dd-mm-head', 'Your Car'));
  const paintBar = el('div', 'dd-mm-paintbar');
  paintBar.appendChild(el('div', 'lbl', 'Paint'));
  const paint = el('div', 'dd-mm-paint'); paintBar.appendChild(paint);
  midCol.appendChild(paintBar);
  const stage = el('div', 'dd-mm-stage'); midCol.appendChild(stage);
  const garage = el('div', 'dd-mm-garage');
  const driveBtn = el('div', 'dd-mm-btn primary dd-mm-drive', 'Drive');
  driveBtn.addEventListener('click', () => drive());
  garage.appendChild(driveBtn);
  midCol.appendChild(garage);
  body.appendChild(midCol);
  let showcase = null;

  // ── RIGHT: the city ──
  const rightCol = el('div', 'dd-mm-col');
  rightCol.appendChild(el('div', 'dd-mm-head', 'Barcelona'));
  const mapWrap = el('div', 'dd-mm-mapwrap');
  const mapCanvas = el('canvas'); mapWrap.appendChild(mapCanvas);
  rightCol.appendChild(mapWrap);
  // ── SEARCH ────────────────────────────────────────────────────────────────────────────────
  // Local and instant, against the road names already resident in `customMap` (citymap.bin interns
  // a name table for the whole city). The old settings-menu search called Nominatim, which is a
  // network round-trip that can return a place this world does not contain. This one can only ever
  // return somewhere you can actually drive to.
  const search = el('input', 'dd-mm-search');
  search.type = 'search';
  search.placeholder = 'Search a street…';
  rightCol.appendChild(search);
  const listHead = el('div', 'dd-mm-listhead', 'Landmarks');
  rightCol.appendChild(listHead);
  const places = el('div', 'dd-mm-places');
  rightCol.appendChild(places);

  /** Re-basing the world live is impossible (spawnConfig applies at init), so travel is a reload. */
  function goTo(lat, lon) {
    uiSound.click();
    try { sessionStorage.setItem('dd_mode', selected.key); } catch { /* private mode */ }
    location.href = `/game?spawn=${lat.toFixed(5)},${lon.toFixed(5)}`;
  }

  function renderList() {
    const q = search.value.trim();
    places.textContent = '';
    if (q.length < 2) {
      listHead.textContent = 'Landmarks';
      for (const p of PLACES) {
        const row = el('div', 'dd-mm-place', p.name);
        row.addEventListener('click', () => goTo(p.lat, p.lon));
        places.appendChild(row);
      }
      return;
    }
    const hits = refs.customMap?.searchRoads?.(q, 14) || [];
    listHead.textContent = hits.length ? `${hits.length} street${hits.length === 1 ? '' : 's'}` : 'No match';
    if (!hits.length) {
      // Honest empty state. The city map has STREETS, not shops or building names — saying so beats
      // an empty box that reads as "search is broken".
      const none = el('div', 'dd-mm-place', 'No street by that name');
      none.style.cursor = 'default';
      places.appendChild(none);
      return;
    }
    for (const h of hits) {
      const row = el('div', 'dd-mm-place', `${h.name}<span class="tier">${h.tier}</span>`);
      row.addEventListener('click', () => {
        const ll = worldToLatLon(h.x, h.z);
        goTo(ll.lat, ll.lon);
      });
      places.appendChild(row);
    }
  }
  let _searchT = null;
  search.addEventListener('input', () => {
    // The store is tens of thousands of ways; debounce so a fast typist does not walk it per keypress.
    if (_searchT) clearTimeout(_searchT);
    _searchT = setTimeout(() => { _searchT = null; renderList(); }, 120);
  });
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); });  // Esc clears the field, not the menu
  renderList();
  body.appendChild(rightCol);

  // Settings lives in the same grid, spanning it, with the three garage columns hidden behind
  // `#dd-mm.settings`. The page itself is escMenu's, re-parented — the same move the paint picker
  // already makes — so there is exactly one implementation of every toggle.
  const settingsHost = el('div', 'dd-mm-settings');
  body.appendChild(settingsHost);
  let settingsMounted = false;
  let tab = 'garage';
  function setTab(t) {
    tab = t;
    tabGarage.classList.toggle('on', t === 'garage');
    tabSettings.classList.toggle('on', t === 'settings');
    settingsHost.classList.toggle('on', t === 'settings');
    root.classList.toggle('settings', t === 'settings');
    if (t !== 'settings') return;
    if (!settingsMounted && refs.settingsPage) { settingsHost.appendChild(refs.settingsPage); settingsMounted = true; }
    refs.onSettingsShown?.();   // re-sync toggles whose state can change outside this menu
  }

  const foot = el('div', 'dd-mm-foot');
  const nav = el('div', 'dd-mm-nav');
  nav.appendChild(tabGarage); nav.appendChild(tabSettings); nav.appendChild(resumeBtn);
  foot.appendChild(nav);
  foot.appendChild(el('div', 'dd-mm-hint', 'Esc — close · Double-click a mode to start it'));
  root.appendChild(foot);
  document.body.appendChild(root);

  const fab = el('div', 'dd-mm-fab', '☰'); fab.title = 'Menu (Esc)';
  fab.addEventListener('click', () => setOpen(true));
  document.body.appendChild(fab);

  /** Draw the whole city into the map panel. World bounds, because that is what drawTile takes. */
  function drawCityMap() {
    const cm = refs.customMap;
    if (!cm) return;
    const a = latLonToWorld(CITY.minLat, CITY.minLon);
    const b = latLonToWorld(CITY.maxLat, CITY.maxLon);
    const wb = [Math.min(a.x, b.x), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.z, b.z)];
    const px = Math.max(120, Math.round(mapWrap.clientWidth || 320));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    mapCanvas.width = Math.round(px * dpr);
    mapCanvas.height = Math.round(px * dpr);
    mapCanvas.style.height = px + 'px';
    const ctx = mapCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // noBuilds: at city scale footprints are sub-pixel noise and cost the whole store to walk.
    try { cm.drawTile(ctx, px, wb, 12, 0, true); } catch { /* store may still be filling */ }
  }

  let open = false;
  function drive() {
    if (!open) return;
    uiSound.click();
    try { sessionStorage.setItem('dd_mode', selected.key); } catch { /* private mode */ }
    // One at a time — the same rule the ESC menu enforced.
    for (const m of modes) if (m !== selected.mode) m.stop?.();
    if (selected.mode?.start && !selected.mode.isRunning?.()) selected.mode.start();
    setOpen(false);
  }

  function setOpen(v) {
    if (v === open) return;
    uiSound[v ? 'open' : 'back']?.();
    open = v;
    root.classList.toggle('open', v);
    fab.style.display = v ? 'none' : 'flex';
    setInputBlocked(v);          // pause car/recover/horn input — main.js reads isOpen() for the real pause
    if (!v) { showcase?.stop?.(); return; }
    setTab('garage');            // always land on the garage; settings is somewhere you go, not where you arrive
    paintCash();
    if (refs.colorPanelElement && refs.colorPanelElement.parentElement !== paint) paint.appendChild(refs.colorPanelElement);
    repaint();
    if (!showcase) { showcase = createCarShowcase(); stage.appendChild(showcase.element); }
    // One frame, so the grid has laid out before the showcase and the map measure themselves.
    requestAnimationFrame(() => {
      const r = stage.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) showcase.setSize?.(r.width, r.height);
      showcase.start?.();
      drawCityMap();
    });
  }

  window.addEventListener('resize', () => { if (open) drawCityMap(); });
  // The one ESC binding in the game now. escMenu drops its own in embedded mode.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (open && tab === 'settings') { setTab('garage'); return; }   // back out a level first
    setOpen(!open);
  });

  return { open: () => setOpen(true), close: () => setOpen(false), isOpen: () => open, element: root };
}
