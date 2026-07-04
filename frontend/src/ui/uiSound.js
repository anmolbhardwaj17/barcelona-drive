/**
 * uiSound — tiny synthesized UI blips (WebAudio, no asset files). Routes through the shared audioManager
 * master, so the Settings volume + mute control it. Fired from user gestures (click/keydown), satisfying
 * autoplay policy.
 */
import { audio } from '../audio/audioManager.js';

// one short enveloped oscillator note → shared master
function note(freq, dur, { type = 'triangle', gain = 0.16, slideTo = null, delay = 0 } = {}) {
  if (audio.isMuted()) return;
  const c = audio.ctx(); const master = audio.master(); if (!c || !master) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}

// Gains boosted ~2.7× — the engine on the shared master bus was drowning these blips out.
export const uiSound = {
  click:  () => note(430, 0.07, { type: 'square',   gain: 0.14, slideTo: 300 }),
  toggle: (on) => note(on ? 520 : 360, 0.09, { type: 'triangle', gain: 0.14, slideTo: on ? 780 : 250 }),
  open:   () => note(300, 0.13, { type: 'sine',     gain: 0.15, slideTo: 520 }),
  back:   () => note(440, 0.10, { type: 'square',   gain: 0.13, slideTo: 240 }),
  confirm:() => { note(520, 0.08, { type: 'triangle', gain: 0.14, slideTo: 700 }); note(800, 0.12, { type: 'triangle', gain: 0.14, slideTo: 980, delay: 0.07 }); },
};
