/**
 * uiSound — tiny synthesized UI blips (WebAudio, no asset files). Used by the settings menu for a bit of
 * game feel. Respects the global mute (localStorage 'dd_soundMuted', shared with the car engine sound).
 * The AudioContext is created lazily on the first call — always fired from a user gesture (click/keydown),
 * so it satisfies browser autoplay policy.
 */
let _ctx = null;

function ctx() {
  try {
    if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (_ctx.state === 'suspended') _ctx.resume();
  } catch { return null; }
  return _ctx;
}
function muted() { try { return localStorage.getItem('dd_soundMuted') === 'true'; } catch { return false; } }

// one short enveloped oscillator note
function note(freq, dur, { type = 'triangle', gain = 0.06, slideTo = null, delay = 0 } = {}) {
  if (muted()) return;
  const c = ctx(); if (!c) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(c.destination);
  o.start(t); o.stop(t + dur + 0.02);
}

export const uiSound = {
  click:  () => note(430, 0.07, { type: 'square',   gain: 0.05, slideTo: 300 }),
  toggle: (on) => note(on ? 520 : 360, 0.09, { type: 'triangle', gain: 0.05, slideTo: on ? 780 : 250 }),
  open:   () => note(300, 0.13, { type: 'sine',     gain: 0.05, slideTo: 520 }),
  back:   () => note(440, 0.10, { type: 'square',   gain: 0.045, slideTo: 240 }),
  // a two-note "go" chirp for spawn/search confirm
  confirm:() => { note(520, 0.08, { type: 'triangle', gain: 0.05, slideTo: 700 }); note(800, 0.12, { type: 'triangle', gain: 0.05, slideTo: 980, delay: 0.07 }); },
};
