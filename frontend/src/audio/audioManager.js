/**
 * audioManager — single shared WebAudio context + master bus for the whole game.
 *
 * Owns: the AudioContext (lazy, resumed on first user gesture), a master GainNode (volume + mute,
 * persisted), and a buffer loader that gracefully tolerates MISSING files (returns null so callers can
 * fall back to synthesis). Sample files live in /public/audio/ — see MANIFEST below. Everything (engine
 * sound, UI blips) routes through master, so the Settings volume slider controls it all.
 */

// name -> candidate URLs (first that decodes wins; .ogg preferred, .mp3 fallback)
export const MANIFEST = {
  engine_idle: ['/audio/engine_idle.ogg', '/audio/engine_idle.mp3'],
  engine_mid:  ['/audio/engine_mid.ogg',  '/audio/engine_mid.mp3'],
  engine_high: ['/audio/engine_high.ogg', '/audio/engine_high.mp3'],
  skid:        ['/audio/skid.ogg',        '/audio/skid.mp3'],
  ambience:    ['/audio/ambience.ogg',    '/audio/ambience.mp3'],
  horn:        ['/audio/horn.ogg',        '/audio/horn.mp3'],
};

let _ctx = null;
let _master = null;
let _volume = 0.8;
let _muted = false;
try { const v = parseFloat(localStorage.getItem('dd_soundVolume')); if (Number.isFinite(v)) _volume = v; } catch {}
try { _muted = localStorage.getItem('dd_soundMuted') === 'true'; } catch {}

const _buffers = new Map();      // name -> AudioBuffer | null (null = confirmed missing)
const _loading = new Map();      // name -> Promise

function _applyGain() {
  if (_master && _ctx) _master.gain.setTargetAtTime(_muted ? 0 : _volume, _ctx.currentTime, 0.04);
}

function ctx() {
  if (!_ctx) {
    try {
      _ctx = new (window.AudioContext || window.webkitAudioContext)();
      _master = _ctx.createGain();
      _master.gain.value = _muted ? 0 : _volume;
      _master.connect(_ctx.destination);
    } catch { return null; }
  }
  if (_ctx.state === 'suspended') _ctx.resume();
  return _ctx;
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
  setMuted(m) { _muted = !!m; try { localStorage.setItem('dd_soundMuted', _muted ? 'true' : 'false'); } catch {} _applyGain(); },
  isMuted() { return _muted; },

  /** Start a looping source routed to master. Returns { src, gain } for live control (or null). */
  loop(buffer, { gain = 1, rate = 1 } = {}) {
    const c = ctx(); if (!c || !buffer) return null;
    const src = c.createBufferSource(); src.buffer = buffer; src.loop = true; src.playbackRate.value = rate;
    const g = c.createGain(); g.gain.value = gain;
    src.connect(g); g.connect(_master); src.start();
    return { src, gain: g };
  },

  /** Fire a one-shot buffer (e.g. horn). */
  oneShot(buffer, { gain = 1, rate = 1 } = {}) {
    const c = ctx(); if (!c || !buffer) return;
    const src = c.createBufferSource(); src.buffer = buffer; src.playbackRate.value = rate;
    const g = c.createGain(); g.gain.value = gain;
    src.connect(g); g.connect(_master); src.start();
  },
};
