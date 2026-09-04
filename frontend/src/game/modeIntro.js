/**
 * modeIntro.js — the card that names the mode you just picked, then gets out of the way.
 *
 * Play it between "the hub closed" and "the mode started". That ordering is the whole design: the
 * hub is gone, so you can see the city you are about to drive; the mode has not started, so nothing
 * is being timed while a logo is on screen. `playModeIntro()` resolves when the card has left, and
 * `mainMenu.drive()` starts the mode on that resolution rather than alongside it — otherwise this
 * would land on top of Checkpoint Dash's own 3-2-1, and the two would fight for the same 40% of the
 * screen with different type.
 *
 * ── ART ───────────────────────────────────────────────────────────────────────────────────────
 * Drop a logo at  `public/modes/logo-<key>.webp`  (or `.png`), keys: dash · taxi · delivery · police.
 * Transparent background, roughly 3:1 to 1:1, ideally ≥ 900 px on the long edge — it is drawn up to
 * 46vw and a small source will read soft on a 4K screen. These are NOT the existing
 * `mode-<key>.webp` files: those are the photographic backgrounds behind the hub's rows, and
 * stretching one across the middle of the screen is a picture, not a title.
 *
 * Until a logo exists the card falls back to the mode's icon and name, set in the hub's own type.
 * That fallback is not a placeholder to be tolerated — it is what ships if art never arrives, so it
 * is laid out properly.
 */

/** Where a mode's title art lives. Tried in order; anything missing falls through to type. */
const LOGO_SRC = (key) => [`/modes/logo-${key}.webp`, `/modes/logo-${key}.png`];
// Keys, and the art shipped for each: dash · taxi · delivery · police · free.

const T_IN = 460, T_HOLD = 1000, T_OUT = 520;      // ms
const REDUCED = () => typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;

// One probe per key per session. A missing logo 404s, and doing that on every mode start would put
// a red line in the console every time the player presses Drive.
const _logoCache = new Map();
function resolveLogo(key) {
  if (_logoCache.has(key)) return _logoCache.get(key);
  const p = new Promise((resolve) => {
    const srcs = LOGO_SRC(key);
    let i = 0;
    const tryNext = () => {
      if (i >= srcs.length) return resolve(null);
      const img = new Image();
      const src = srcs[i++];
      img.onload = () => resolve(src);
      img.onerror = tryNext;
      img.src = src;
    };
    tryNext();
  });
  _logoCache.set(key, p);
  return p;
}

let _styleInjected = false;
function injectStyle() {
  if (_styleInjected) return;
  _styleInjected = true;
  const st = document.createElement('style');
  st.textContent = `
@keyframes ddmi-scrim-in  { from { opacity:0 } to { opacity:1 } }
@keyframes ddmi-rule      { from { transform:scaleX(0) } to { transform:scaleX(1) } }
.ddmi-wrap { position:fixed; inset:0; z-index:1340; pointer-events:none; user-select:none;
  display:flex; align-items:center; justify-content:center; flex-direction:column; }
.ddmi-scrim { position:absolute; inset:0;
  /* Not a black-out. The city stays readable behind the card — this is a title over a shot, not a
     loading screen, and dimming it to nothing throws away the only thing that makes it feel like a
     game rather than a menu. */
  background:radial-gradient(ellipse at 50% 46%, rgba(6,9,13,.62) 0%, rgba(6,9,13,.42) 45%, rgba(6,9,13,.12) 100%); }
.ddmi-card { position:relative; text-align:center; width:min(58vw, 780px); }
.ddmi-logo { display:block; width:100%; height:auto;
  filter:drop-shadow(0 10px 30px rgba(0,0,0,.65)) drop-shadow(0 0 40px rgba(255,190,80,.18)); }
.ddmi-glyph { font-size:clamp(54px, 9vw, 104px); line-height:1; filter:drop-shadow(0 8px 22px rgba(0,0,0,.6)); }
.ddmi-name { margin-top:10px; font:800 clamp(24px, 3.4vw, 46px)/1.05 Inter, system-ui, sans-serif;
  letter-spacing:.12em; text-transform:uppercase; color:#fff; text-shadow:0 4px 18px rgba(0,0,0,.7); }
.ddmi-rule { height:2px; margin:12px auto 0; width:min(38vw, 420px); transform-origin:50% 50%;
  background:linear-gradient(90deg, rgba(255,190,80,0) 0%, rgba(255,190,80,.95) 50%, rgba(255,190,80,0) 100%); }
.ddmi-blurb { margin-top:9px; font:600 clamp(11px, 1.15vw, 15px)/1.3 Inter, system-ui, sans-serif;
  letter-spacing:.22em; text-transform:uppercase; color:rgba(255,255,255,.72);
  text-shadow:0 2px 10px rgba(0,0,0,.7); }`;
  document.head.appendChild(st);
}

/**
 * Show the mode card, then remove it.
 *
 * @param {string} key   mode key — dash | taxi | delivery | police
 * @param {{name?:string, icon?:string, blurb?:string}} meta
 * @returns {Promise<void>} resolves once the card has finished leaving
 */
export async function playModeIntro(key, { name = '', icon = '', blurb = '' } = {}) {
  if (typeof document === 'undefined') return;
  injectStyle();
  const reduced = REDUCED();
  const tIn = reduced ? 200 : T_IN, tOut = reduced ? 200 : T_OUT;

  const src = await resolveLogo(key);

  const wrap = document.createElement('div');
  wrap.className = 'ddmi-wrap';
  const scrim = document.createElement('div');
  scrim.className = 'ddmi-scrim';
  const card = document.createElement('div');
  card.className = 'ddmi-card';
  card.innerHTML =
    (src ? `<img class="ddmi-logo" src="${src}" alt="">`
         : `<div class="ddmi-glyph">${icon}</div><div class="ddmi-name">${name}</div>`) +
    '<div class="ddmi-rule"></div>' +
    (blurb ? `<div class="ddmi-blurb">${blurb}</div>` : '');
  wrap.appendChild(scrim); wrap.appendChild(card);
  document.body.appendChild(wrap);

  const rule = card.querySelector('.ddmi-rule');
  const blurbEl = card.querySelector('.ddmi-blurb');

  // ── in ──
  // The blur is what stops this reading as a DOM element appearing: a title that resolves into
  // focus reads as photographic, and it costs one composited filter for half a second.
  scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: tIn, easing: 'ease-out', fill: 'both' });
  card.animate(
    reduced
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ opacity: 0, transform: 'translateY(14px) scale(.86)', filter: 'blur(10px)' },
         { opacity: 1, transform: 'translateY(0) scale(1)', filter: 'blur(0px)' }],
    { duration: tIn, easing: 'cubic-bezier(.16,.84,.34,1)', fill: 'both' });
  if (rule && !reduced) rule.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
    { duration: tIn + 220, delay: 90, easing: 'cubic-bezier(.16,.84,.34,1)', fill: 'both' });
  if (blurbEl && !reduced) blurbEl.animate(
    [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }],
    { duration: 380, delay: 200, easing: 'ease-out', fill: 'both' });

  await new Promise((r) => setTimeout(r, tIn + (reduced ? 520 : T_HOLD)));

  // ── out ──
  // Scales UP on the way out, not down. Shrinking away reads as cancelled; drifting past the camera
  // reads as the card getting out of the way of the thing behind it, which is what is happening.
  const outAnim = card.animate(
    reduced
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [{ opacity: 1, transform: 'scale(1)', filter: 'blur(0px)' },
         { opacity: 0, transform: 'translateY(-10px) scale(1.09)', filter: 'blur(7px)' }],
    { duration: tOut, easing: 'cubic-bezier(.4,0,.7,.2)', fill: 'both' });
  scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: tOut, easing: 'ease-in', fill: 'both' });

  await new Promise((r) => { outAnim.onfinish = r; setTimeout(r, tOut + 400); });  // never hang the launch
  wrap.remove();
}
