/**
 * audioManager — single shared WebAudio context + master bus for the whole game.
 *
 * Owns: the AudioContext (lazy, resumed on first user gesture), a master GainNode (volume + mute,
 * persisted), and a buffer loader that gracefully tolerates MISSING files (returns null so callers can
 * fall back to synthesis). Sample files live in /public/audio/ — see MANIFEST below. Everything (engine
 * sound, UI blips) routes through master, so the Settings volume slider controls it all.
 */

// name -> candidate URLs (first that decodes wins; .ogg preferred, .mp3 fallback)
const V = (n) => [`/audio/${n}.ogg`, `/audio/${n}.mp3`, `/audio/${n}.wav`]; // preferred order
export const MANIFEST = {
  engine_idle: V('engine_idle'), engine_mid: V('engine_mid'), engine_high: V('engine_high'),
  skid: V('skid'), ambience: V('ambience'), ambience_night: V('ambience_night'),
  horn: V('horn'), car_pass: V('car_pass'), shout: V('shout'),
};

let _ctx = null;
let _master = null;
let _carBus = null, _sfxBus = null;          // category sub-buses (car engine/skid vs everything else) → master
let _volume = 0.8;
let _carVol = 1.0, _sfxVol = 1.0;            // per-category multipliers (0..1), on top of master
let _muted = false;
let _whooshLast = 0, _whooshActive = 0;      // pass-by whoosh rate/voice cap
let _shoutLast = 0;                          // pedestrian-hit shout throttle
const WHOOSH_MIN_GAP = 0.06, WHOOSH_MAX = 4;
const _readVol = (k, d) => { try { const v = parseFloat(localStorage.getItem(k)); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d; } catch { return d; } };
_volume = _readVol('dd_soundVolume', 0.8);
_carVol = _readVol('dd_volCar', 1.0);
_sfxVol = _readVol('dd_volSfx', 1.0);
try { _muted = localStorage.getItem('dd_soundMuted') === 'true'; } catch {}

const _buffers = new Map();      // name -> AudioBuffer | null (null = confirmed missing)
const _loading = new Map();      // name -> Promise

function _applyGain() {
  if (_master && _ctx) _master.gain.setTargetAtTime(_muted ? 0 : _volume, _ctx.currentTime, 0.04);
  if (_carBus && _ctx) _carBus.gain.setTargetAtTime(_carVol, _ctx.currentTime, 0.04);
  if (_sfxBus && _ctx) _sfxBus.gain.setTargetAtTime(_sfxVol, _ctx.currentTime, 0.04);
}

let _bgSuspended = false;   // suspended because the tab is hidden (don't auto-resume until it's visible)
function ctx() {
  if (!_ctx) {
    try {
      _ctx = new (window.AudioContext || window.webkitAudioContext)();
      _master = _ctx.createGain();
      _master.gain.value = _muted ? 0 : _volume;
      _master.connect(_ctx.destination);
      // Category sub-buses → master. Car = engine/skid; SFX = UI, impacts, whoosh, horn, ambience, peds.
      _carBus = _ctx.createGain(); _carBus.gain.value = _carVol; _carBus.connect(_master);
      _sfxBus = _ctx.createGain(); _sfxBus.gain.value = _sfxVol; _sfxBus.connect(_master);
    } catch { return null; }
  }
  if (_ctx.state === 'suspended' && !_bgSuspended) _ctx.resume();
  return _ctx;
}

// Pause ALL game audio when the tab isn't focused (no engine/ambience leaking from a background tab).
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { _bgSuspended = true; if (_ctx && _ctx.state === 'running') _ctx.suspend(); }
    else { _bgSuspended = false; if (_ctx && _ctx.state === 'suspended') _ctx.resume(); }
  });
}

async function load(name, urls) {
  if (_buffers.has(name)) return _buffers.get(name);
  if (_loading.has(name)) return _loading.get(name);
  const p = (async () => {
    const c = ctx(); if (!c) { _buffers.set(name, null); return null; }
    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const buf = await c.decodeAudioData(await res.arrayBuffer());
        _buffers.set(name, buf);
        return buf;
      } catch { /* try next candidate */ }
    }
    _buffers.set(name, null); // graceful: file absent → callers fall back to synth
    return null;
  })();
  _loading.set(name, p);
  return p;
}

export const audio = {
  ctx,
  master() { ctx(); return _master; },
  carBus() { ctx(); return _carBus; },   // route car engine/skid here
  sfxBus() { ctx(); return _sfxBus; },   // route UI/impact/ambience/etc here

  /** Load every manifest entry; resolves to a { name: boolean } readiness map. */
  async preload() {
    const out = {};
    await Promise.all(Object.entries(MANIFEST).map(async ([name, urls]) => { out[name] = !!(await load(name, urls)); }));
    return out;
  },
  load,
  get(name) { return _buffers.get(name) || null; },

  setVolume(v) { _volume = Math.max(0, Math.min(1, v)); try { localStorage.setItem('dd_soundVolume', String(_volume)); } catch {} _applyGain(); },
  getVolume() { return _volume; },
  setCarVolume(v) { _carVol = Math.max(0, Math.min(1, v)); try { localStorage.setItem('dd_volCar', String(_carVol)); } catch {} _applyGain(); },
  getCarVolume() { return _carVol; },
  setSfxVolume(v) { _sfxVol = Math.max(0, Math.min(1, v)); try { localStorage.setItem('dd_volSfx', String(_sfxVol)); } catch {} _applyGain(); },
  getSfxVolume() { return _sfxVol; },
  setMuted(m) { _muted = !!m; try { localStorage.setItem('dd_soundMuted', _muted ? 'true' : 'false'); } catch {} _applyGain(); },
  isMuted() { return _muted; },

  /** Start a looping source routed to `dest` (default master). Returns { src, gain } (or null). */
  loop(buffer, { gain = 1, rate = 1, dest = null } = {}) {
    const c = ctx(); if (!c || !buffer) return null;
    const src = c.createBufferSource(); src.buffer = buffer; src.loop = true; src.playbackRate.value = rate;
    const g = c.createGain(); g.gain.value = gain;
    src.connect(g); g.connect(dest || _master); src.start();
    return { src, gain: g };
  },

  /** Fire a one-shot buffer (e.g. horn). */
  oneShot(buffer, { gain = 1, rate = 1 } = {}) {
    const c = ctx(); if (!c || !buffer) return;
    const src = c.createBufferSource(); src.buffer = buffer; src.playbackRate.value = rate;
    const g = c.createGain(); g.gain.value = gain;
    src.connect(g); g.connect(_sfxBus); src.start();
  },

  /** Panned pass-by "whoosh" for a car passing the player. Uses the car_pass sample, else a synth sweep. */
  whoosh(pan = 0, intensity = 1) {
    if (_muted || _volume <= 0) return;   // volume 0 == effectively muted → don't build inaudible graphs
    const c = ctx(); if (!c) return;
    // Global rate + voice cap so a burst of cars crossing in dense traffic can't stack into clipping.
    if (c.currentTime - _whooshLast < WHOOSH_MIN_GAP || _whooshActive >= WHOOSH_MAX) return;
    _whooshLast = c.currentTime; _whooshActive++;
    setTimeout(() => { _whooshActive = Math.max(0, _whooshActive - 1); }, 500);
    pan = Math.max(-1, Math.min(1, pan));
    const panner = c.createStereoPanner ? c.createStereoPanner() : null;
    if (panner) panner.pan.value = pan;
    const out = panner || _sfxBus;
    const sample = _buffers.get('car_pass');
    if (sample) {
      const src = c.createBufferSource(); src.buffer = sample; src.playbackRate.value = 0.9 + Math.random() * 0.3;
      const g = c.createGain(); g.gain.value = 0.35 * intensity;
      src.connect(g); g.connect(out); if (panner) panner.connect(_sfxBus); src.start();
      return;
    }
    // synth fallback: band-passed noise sweeping up then down = a doppler-ish "vroom"
    const dur = 0.42, t = c.currentTime;
    const src = c.createBufferSource(); src.buffer = _noise(c); src.loop = true;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.3;
    bp.frequency.setValueAtTime(280, t);
    bp.frequency.linearRampToValueAtTime(820, t + dur * 0.45);
    bp.frequency.linearRampToValueAtTime(220, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16 * intensity, t + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp); bp.connect(g); g.connect(out); if (panner) panner.connect(_sfxBus);
    src.start(t); src.stop(t + dur + 0.05);
  },

  /** Collision "thud + crunch", synthesised. intensity 0..1 scales loudness, low-end weight and duration. */
  impact(intensity = 0.5) {
    if (_muted || _volume <= 0) return;
    const c = ctx(); if (!c) return;
    const t = c.currentTime;
    const k = Math.max(0, Math.min(1, intensity));
    const level = 0.22 + k * 0.55;
    // Low body thud — a damped sine dropping in pitch (the "boom" of the chassis).
    const osc = c.createOscillator(); osc.type = 'sine';
    osc.frequency.setValueAtTime(150 - k * 40, t);
    osc.frequency.exponentialRampToValueAtTime(46, t + 0.14 + k * 0.06);
    const og = c.createGain();
    og.gain.setValueAtTime(level, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.20 + k * 0.12);
    osc.connect(og); og.connect(_sfxBus); osc.start(t); osc.stop(t + 0.36);
    // Crunch — a short low-passed noise transient (panel/scrape), brighter on harder hits.
    const src = c.createBufferSource(); src.buffer = _noise(c);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320 + k * 1100; lp.Q.value = 0.7;
    const ng = c.createGain();
    ng.gain.setValueAtTime(level * 0.75, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.07 + k * 0.05);
    src.connect(lp); lp.connect(ng); ng.connect(_sfxBus); src.start(t); src.stop(t + 0.16);
  },

  /** Short synthesized human shout/yelp — played when a pedestrian is hit. Formant-filtered sawtooth
   *  (glottal source → two vowel formants) with a quick pitch bend + vibrato. Randomised fundamental so
   *  voices vary. Self-throttled (~180ms) so a struck crowd doesn't stack into a wall of noise. */
  shout() {
    if (_muted || _volume <= 0) return;
    const c = ctx(); if (!c) return;
    const t = c.currentTime;
    if (t - _shoutLast < 0.18) return;
    _shoutLast = t;
    // Prefer a real sample if one was dropped in /public/audio/ (shout.ogg/mp3/wav); else synth below.
    const sample = _buffers.get('shout');
    if (sample) { this.oneShot(sample, { gain: 0.9, rate: 0.9 + Math.random() * 0.3 }); return; }
    const f0 = 165 + Math.random() * 165;                 // 165–330 Hz fundamental (male↔higher voices)
    const dur = 0.26 + Math.random() * 0.12;
    // Glottal source: a sawtooth with a rising-then-falling pitch ("hey!"/"oi!") + a little vibrato.
    const src = c.createOscillator(); src.type = 'sawtooth';
    src.frequency.setValueAtTime(f0 * 0.92, t);
    src.frequency.exponentialRampToValueAtTime(f0 * 1.28, t + 0.05);
    src.frequency.exponentialRampToValueAtTime(f0 * 0.82, t + dur);
    const vib = c.createOscillator(); vib.type = 'sine'; vib.frequency.value = 6.5;
    const vibG = c.createGain(); vibG.gain.value = f0 * 0.03;
    vib.connect(vibG); vibG.connect(src.frequency);
    // Two vowel formants (~"eh/ah") to make the buzz read as a voice.
    const f1 = c.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 720; f1.Q.value = 6;
    const f2 = c.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 1150; f2.Q.value = 8;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.012);   // fast vocal onset
    g.gain.setValueAtTime(0.5, t + dur * 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f1); src.connect(f2); f1.connect(g); f2.connect(g); g.connect(_sfxBus);
    src.start(t); vib.start(t); src.stop(t + dur + 0.02); vib.stop(t + dur + 0.02);
  },
};

// cached white-noise buffer for synth fallbacks
let _noiseBuf = null;
function _noise(c) {
  if (_noiseBuf) return _noiseBuf;
  const len = c.sampleRate * 1;
  _noiseBuf = c.createBuffer(1, len, c.sampleRate);
  const d = _noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return _noiseBuf;
}
