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
    "font-family:'Lilita One',system-ui,sans-serif;color:#fff;text-shadow:0 4px 16px rgba(0,0,0,.55);white-space:nowrap;line-height:1.15;";
  b.innerHTML = html;
  layer().appendChild(b);
  b.animate([
    { transform: 'translate(-50%,-50%) scale(.55)', opacity: 0 },
    { transform: 'translate(-50%,-50%) scale(1.14)', opacity: 1, offset: 0.18 },
    { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, offset: 0.82 },
    { transform: 'translate(-50%,-62%) scale(1)', opacity: 0 },
  ], { duration, easing: 'ease-out' }).onfinish = () => b.remove();
}
