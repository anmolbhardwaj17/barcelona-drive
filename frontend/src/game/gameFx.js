/**
 * gameFx.js — lightweight juice for game-mode events: a screen flash, a confetti burst, and a big
 * animated centre banner ("MISSION COMPLETE" etc). Pure DOM + Web Animations API, no deps. All fired
 * as fire-and-forget; elements clean themselves up on animation end.
 */
let _layer = null;
function layer() {
  if (_layer) return _layer;
  _layer = document.createElement('div');
  _layer.style.cssText = 'position:fixed;inset:0;z-index:1350;pointer-events:none;overflow:hidden;';
  document.body.appendChild(_layer);
  return _layer;
}

/** Brief full-screen colour pulse. */
export function fxFlash(color = 'rgba(255,255,255,.26)', dur = 420) {
  const f = document.createElement('div');
  f.style.cssText = `position:absolute;inset:0;background:${color};`;
  layer().appendChild(f);
  f.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur, easing: 'ease-out' }).onfinish = () => f.remove();
}

const CONFETTI = ['#ffd23f', '#35e0ff', '#ff6b6b', '#2ee06a', '#ffffff', '#f5a623'];
/** Confetti burst from the centre (originY as a fraction of screen height). */
export function fxConfetti(n = 26, colors = CONFETTI, originY = 0.4) {
  const L = layer();
  const cx = window.innerWidth / 2, cy = window.innerHeight * originY;
  for (let i = 0; i < n; i++) {
    const p = document.createElement('div');
    const s = 6 + Math.random() * 8;
    p.style.cssText = `position:absolute;left:${cx}px;top:${cy}px;width:${s}px;height:${s * 0.6}px;background:${colors[i % colors.length]};border-radius:2px;will-change:transform,opacity;`;
    L.appendChild(p);
    const ang = Math.random() * Math.PI * 2, dist = 90 + Math.random() * 230;
    const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist - 50 - Math.random() * 90;
    p.animate([
      { transform: 'translate(-50%,-50%) rotate(0deg)', opacity: 1 },
      { transform: `translate(${dx}px,${dy}px) rotate(${Math.random() * 900 - 450}deg)`, opacity: 0 },
    ], { duration: 850 + Math.random() * 650, easing: 'cubic-bezier(.15,.7,.25,1)' }).onfinish = () => p.remove();
  }
}

/** Big animated centre banner. `html` is the styled inner content. */
export function fxBanner(html, { duration = 1800, top = '34%' } = {}) {
  const b = document.createElement('div');
  b.style.cssText = `position:absolute;top:${top};left:50%;transform:translate(-50%,-50%);text-align:center;` +
    "font-family:'Inter',system-ui,sans-serif;color:#fff;text-shadow:0 4px 16px rgba(0,0,0,.55);white-space:nowrap;line-height:1.15;";
  b.innerHTML = html;
  layer().appendChild(b);
  b.animate([
    { transform: 'translate(-50%,-50%) scale(.55)', opacity: 0 },
    { transform: 'translate(-50%,-50%) scale(1.14)', opacity: 1, offset: 0.18 },
    { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, offset: 0.82 },
    { transform: 'translate(-50%,-62%) scale(1)', opacity: 0 },
  ], { duration, easing: 'ease-out' }).onfinish = () => b.remove();
}

// ── STRUCTURED CENTRE BANNER ──────────────────────────────────────────────────────────────────
//
// `fxBanner` takes an HTML string, so every call site invented its own type: 24px mint here, 34px
// mint there, a 50px gold number below a 30px one, and an emoji standing in for an icon in all of
// them. Emoji are the worst part — they render as a different picture on every platform, they carry
// the OS's colour palette rather than the game's, and 🧍 in front of "Picking up…" is doing no work
// that the words are not already doing.
//
// This gives the same three slots to everyone: a small KICKER for context ("FARE 3"), a big TITLE
// for the event, and a quiet SUB for the detail. Copy stays in the caller; type does not.
import { injectHudTheme } from './hudTheme.js';

let _bannerStyle = false;
function bannerStyle() {
  if (_bannerStyle) return;
  _bannerStyle = true;
  injectHudTheme();
  const st = document.createElement('style');
  st.textContent = `
.ddb { text-align:center; font-family:Inter, system-ui, sans-serif; color:#fff; white-space:nowrap;
  text-shadow:0 4px 22px rgba(0,0,0,.75); }
.ddb-kicker { font:800 11px/1 Inter, sans-serif; letter-spacing:.28em; text-transform:uppercase;
  opacity:.9; }
.ddb-title { font:800 40px/1.05 Inter, sans-serif; letter-spacing:.06em; text-transform:uppercase;
  margin-top:9px; }
.ddb-rule { height:2px; width:0; margin:11px auto 0; border-radius:1px; }
.ddb-sub { font:600 13px/1.3 Inter, sans-serif; letter-spacing:.1em; text-transform:uppercase;
  color:rgba(255,255,255,.7); margin-top:10px; }
.ddb-amount { font:800 54px/1 Inter, sans-serif; font-variant-numeric:tabular-nums; margin-top:8px; }`;
  document.head.appendChild(st);
}

/**
 * @param {object} o
 * @param {string} [o.kicker]  small caps line above — context ("FARE 3", "CHECKPOINT 4 OF 9")
 * @param {string} [o.title]   the event, in caps
 * @param {string} [o.amount]  a money/score figure, shown large under the title
 * @param {string} [o.sub]     quiet detail line
 * @param {string} [o.color]   accent for the kicker, rule and amount
 * @param {number} [o.duration]
 */
export function fxEvent({ kicker = '', title = '', amount = '', sub = '', color = '#ffd23f', duration = 1900, top = '32%' } = {}) {
  bannerStyle();
  const b = document.createElement('div');
  b.className = 'ddb';
  b.style.cssText = `position:absolute;top:${top};left:50%;transform:translate(-50%,-50%);`;
  b.innerHTML =
    (kicker ? `<div class="ddb-kicker"></div>` : '') +
    (title ? `<div class="ddb-title"></div>` : '') +
    `<div class="ddb-rule"></div>` +
    (amount ? `<div class="ddb-amount"></div>` : '') +
    (sub ? `<div class="ddb-sub"></div>` : '');
  // textContent for every caller-supplied string: these carry street names straight out of OSM data,
  // and an apostrophe in "Carrer d'Aragó" has no business being parsed as markup.
  const set = (sel, txt) => { const el = b.querySelector(sel); if (el) el.textContent = txt; };
  set('.ddb-kicker', kicker); set('.ddb-title', title);
  set('.ddb-amount', amount); set('.ddb-sub', sub);
  const kEl = b.querySelector('.ddb-kicker'); if (kEl) kEl.style.color = color;
  const aEl = b.querySelector('.ddb-amount'); if (aEl) aEl.style.color = color;
  const rule = b.querySelector('.ddb-rule');
  rule.style.background = `linear-gradient(90deg, transparent, ${color}, transparent)`;

  layer().appendChild(b);
  b.animate([
    { transform: 'translate(-50%,-46%) scale(.94)', opacity: 0 },
    { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, offset: 0.14 },
    { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, offset: 0.78 },
    { transform: 'translate(-50%,-58%) scale(1)', opacity: 0 },
  ], { duration, easing: 'cubic-bezier(.16,.84,.34,1)' }).onfinish = () => b.remove();
  // The rule wipes out from the centre — the one bit of motion that makes this read as a title card
  // rather than a notification.
  rule.animate([{ width: '0px' }, { width: '260px' }],
    { duration: Math.min(700, duration * 0.4), delay: 90, easing: 'cubic-bezier(.16,.84,.34,1)', fill: 'both' });
}
