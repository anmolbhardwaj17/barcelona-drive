/**
 * Procedural engine sound — simulates 4-cylinder combustion engine.
 *
 * Key technique: amplitude modulation at the cylinder firing rate
 * creates the rhythmic "putt-putt-putt" of a real engine, unlike
 * steady oscillator tones that sound electric.
 *
 * Chain: oscillator → AM (firing pulse) → waveshaper (warmth) → filter → gain
 * Plus: shaped noise for exhaust rumble.
 */

const IDLE_RPM = 800;
const REDLINE_RPM = 5500;
const MASTER_VOLUME = 0.55;
const CYLINDERS = 4;

let _ctx = null;
let _started = false;

// Attempt to build a warm distortion curve
function makeDistortionCurve(amount) {
  const n = 256;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

export function createCarSound() {
  let master = null;
  // Engine tone nodes
  let eng1 = null, eng1Gain = null;
  let eng2 = null, eng2Gain = null;
  // AM modulator (cylinder firing pulse)
  let amOsc = null, amGain = null;
  // Exhaust noise
  let noiseNode = null, noiseGain = null, noiseBP = null, noiseLP = null;
  // Processing
  let shaper = null, preGain = null, engFilter = null;
  // Crackle/pop
  let crackleNoiseBuf = null;
  let _crackleTimer = 0;
  // Tire screech
  let screechNode = null, screechGain = null, screechBP = null, screechHP = null;
  // City ambience bed (constant low murmur) + wind (speed-driven) + impact thud
  let ambNode = null, ambGain = null, ambBP = null;
  let windNode = null, windGain = null, windHP = null;
  let thudBuf = null, _thudCooldown = 0, _prevSpeedKmh = 0;

  let _smoothRpm = IDLE_RPM;
  let _smoothThrottle = 0;
  let _prevThrottle = 0;

  function _init() {
    if (_ctx) return;
    _ctx = new (window.AudioContext || window.webkitAudioContext)();

    master = _ctx.createGain();
    master.gain.value = _muted ? 0 : MASTER_VOLUME;
    master.connect(_ctx.destination);

    // ── Engine tone (two detuned sawtooths for thickness) ──────────────
    preGain = _ctx.createGain();
    preGain.gain.value = 0.4;

    eng1 = _ctx.createOscillator();
    eng1.type = 'sawtooth';
    eng1.frequency.value = 55;
    eng1.connect(preGain);
    eng1.start();

    eng2 = _ctx.createOscillator();
    eng2.type = 'sawtooth';
    eng2.frequency.value = 55.5; // slightly detuned for chorus
    const eng2Mix = _ctx.createGain();
    eng2Mix.gain.value = 0.6;
    eng2.connect(eng2Mix);
    eng2Mix.connect(preGain);
    eng2.start();

    // ── Amplitude modulation — cylinder firing pulse ───────────────────
    // For 4-cyl, firing freq = RPM/60 * (cylinders/2) = RPM/30
    // This creates the rhythmic "putt" that makes it sound like combustion
    amOsc = _ctx.createOscillator();
    amOsc.type = 'sine'; // smoother pulse — less buzzy, more car-like thump
    amOsc.frequency.value = IDLE_RPM / 60; // half crank speed — slower, heavier pulse

    amGain = _ctx.createGain();
    amGain.gain.value = 0; // will be modulated

    // AM: multiply engine signal by (0.5 + 0.5 * modulator)
    // We achieve this by routing modulator to the gain's gain param
    const amDepth = _ctx.createGain();
    amDepth.gain.value = 0.25; // gentler modulation — less buzzy
    amOsc.connect(amDepth);

    // Route engine through AM gain
    preGain.connect(amGain);
    amGain.gain.value = 0.75; // base level (1 - depth)
    amDepth.connect(amGain.gain); // modulator adds to gain

    amOsc.start();

    // ── Waveshaper — adds harmonic warmth/grit ────────────────────────
    shaper = _ctx.createWaveShaper();
    shaper.curve = makeDistortionCurve(12);
    shaper.oversample = 'none';
    amGain.connect(shaper);

    // ── Engine filter — roll off harsh highs ──────────────────────────
    engFilter = _ctx.createBiquadFilter();
    engFilter.type = 'lowpass';
    engFilter.frequency.value = 300;
    engFilter.Q.value = 0.7;
    shaper.connect(engFilter);
    engFilter.connect(master);

    // ── Exhaust noise — bandpass-filtered noise for rumble ─────────────
    const bufLen = _ctx.sampleRate * 2;
    const noiseBuf = _ctx.createBuffer(1, bufLen, _ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    noiseNode = _ctx.createBufferSource();
    noiseNode.buffer = noiseBuf;
    noiseNode.loop = true;

    // Bandpass for meaty exhaust rumble
    noiseBP = _ctx.createBiquadFilter();
    noiseBP.type = 'bandpass';
    noiseBP.frequency.value = 80;
    noiseBP.Q.value = 0.4;

    // Extra lowpass to tame
    noiseLP = _ctx.createBiquadFilter();
    noiseLP.type = 'lowpass';
    noiseLP.frequency.value = 300;
    noiseLP.Q.value = 0.5;

    noiseGain = _ctx.createGain();
    noiseGain.gain.value = 0.06;

    noiseNode.connect(noiseBP);
    noiseBP.connect(noiseLP);
    noiseLP.connect(noiseGain);
    noiseGain.connect(master);
    noiseNode.start();

    // ── Crackle buffer — short burst of shaped noise for pops ───────
    const crackleLen = Math.round(_ctx.sampleRate * 0.06); // 60ms burst
    crackleNoiseBuf = _ctx.createBuffer(1, crackleLen, _ctx.sampleRate);
    const cData = crackleNoiseBuf.getChannelData(0);
    for (let i = 0; i < crackleLen; i++) {
      const env = 1 - i / crackleLen; // fast decay
      cData[i] = (Math.random() * 2 - 1) * env * env;
    }

    // ── Tire screech — highpass filtered noise for brake squeal ─────
    const screechLen = _ctx.sampleRate * 2;
    const screechBuf = _ctx.createBuffer(1, screechLen, _ctx.sampleRate);
    const sData = screechBuf.getChannelData(0);
    for (let i = 0; i < screechLen; i++) sData[i] = Math.random() * 2 - 1;
    screechNode = _ctx.createBufferSource();
    screechNode.buffer = screechBuf;
    screechNode.loop = true;
    // Screech: resonant peaks that simulate brake disc squeal
    screechHP = _ctx.createBiquadFilter();
    screechHP.type = 'peaking';
    screechHP.frequency.value = 3200;   // high-pitched squeal
    screechHP.gain.value = 12;
    screechHP.Q.value = 8;              // sharp resonance
    screechBP = _ctx.createBiquadFilter();
    screechBP.type = 'peaking';
    screechBP.frequency.value = 5500;   // second harmonic squeal
    screechBP.gain.value = 8;
    screechBP.Q.value = 6;
    screechGain = _ctx.createGain();
    screechGain.gain.value = 0; // silent until braking
    screechNode.connect(screechHP);
    screechHP.connect(screechBP);
    screechBP.connect(screechGain);
    screechGain.connect(master);
    screechNode.start();

    // ── City ambience bed — constant quiet murmur (distant traffic/city hum) ──
    const ambLen = _ctx.sampleRate * 3;
    const ambBuf = _ctx.createBuffer(1, ambLen, _ctx.sampleRate);
    const aData = ambBuf.getChannelData(0);
    for (let i = 0; i < ambLen; i++) aData[i] = Math.random() * 2 - 1;
    ambNode = _ctx.createBufferSource();
    ambNode.buffer = ambBuf;
    ambNode.loop = true;
    ambBP = _ctx.createBiquadFilter();
    ambBP.type = 'bandpass';
    ambBP.frequency.value = 380;   // low-mid city murmur
    ambBP.Q.value = 0.4;
    ambGain = _ctx.createGain();
    ambGain.gain.value = 0.022;     // quiet always-on bed
    ambNode.connect(ambBP);
    ambBP.connect(ambGain);
    ambGain.connect(master);
    ambNode.start();

    // ── Wind — airy highpass noise that rises with speed ──
    const windLen = _ctx.sampleRate * 2;
    const windBuf = _ctx.createBuffer(1, windLen, _ctx.sampleRate);
    const wData = windBuf.getChannelData(0);
    for (let i = 0; i < windLen; i++) wData[i] = Math.random() * 2 - 1;
    windNode = _ctx.createBufferSource();
    windNode.buffer = windBuf;
    windNode.loop = true;
    windHP = _ctx.createBiquadFilter();
    windHP.type = 'highpass';
    windHP.frequency.value = 700;
    windGain = _ctx.createGain();
    windGain.gain.value = 0;        // silent at rest
    windNode.connect(windHP);
    windHP.connect(windGain);
    windGain.connect(master);
    windNode.start();

    // ── Impact thud buffer — short low-frequency burst for collisions ──
    const thudLen = Math.round(_ctx.sampleRate * 0.18);
    thudBuf = _ctx.createBuffer(1, thudLen, _ctx.sampleRate);
    const tData = thudBuf.getChannelData(0);
    for (let i = 0; i < thudLen; i++) {
      const env = Math.pow(1 - i / thudLen, 2.5); // fast decay
      tData[i] = (Math.random() * 2 - 1) * env;
    }

    _started = true;
  }

  /** Play a one-shot impact thud (volume 0..1). Called by carDriver on a sharp deceleration. */
  function _fireThud(vol) {
    if (!_ctx || !thudBuf) return;
    const src = _ctx.createBufferSource();
    src.buffer = thudBuf;
    src.playbackRate.value = 0.7 + Math.random() * 0.3;
    const lp = _ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 180;     // deep, body-blow thud
    const g = _ctx.createGain();
    g.gain.value = Math.min(0.6, vol);
    src.connect(lp);
    lp.connect(g);
    g.connect(master);
    src.start();
  }

  function _fireCrackle() {
    if (!_ctx || !crackleNoiseBuf) return;
    const src = _ctx.createBufferSource();
    src.buffer = crackleNoiseBuf;
    // Randomize pitch for variety
    src.playbackRate.value = 0.6 + Math.random() * 0.8;
    const g = _ctx.createGain();
    g.gain.value = 0.2 + Math.random() * 0.15;
    const bp = _ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 150 + Math.random() * 200;
    bp.Q.value = 1.0;
    src.connect(bp);
    bp.connect(g);
    g.connect(master);
    src.start();
  }

  function ensureStarted() {
    if (!_started) _init();
    if (_ctx && _ctx.state === 'suspended') _ctx.resume();
  }

  /**
   * @param {number} rpm — 900–8500
   * @param {number} throttle — 0 or 1
   * @param {number} dt — frame delta
   */
  function update(rpm, throttle, dt, downshifted = false, brake = 0, speedKmh = 0) {
    if (!_started || !_ctx) return;

    // Smooth inputs
    _smoothRpm += (rpm - _smoothRpm) * Math.min(1, 8 * dt);
    _smoothThrottle += (throttle - _smoothThrottle) * Math.min(1, 6 * dt);

    const rpmNorm = Math.max(0, Math.min(1, (_smoothRpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM)));
    const t = _ctx.currentTime;

    // Engine tone pitch: low & bassy — old car rumble
    // ~35 Hz at idle, ~110 Hz at redline (much lower than sports car)
    const baseFreq = 35 + rpmNorm * 75;
    eng1.frequency.setTargetAtTime(baseFreq, t, 0.04);
    eng2.frequency.setTargetAtTime(baseFreq * 1.01, t, 0.04); // slight detune

    // AM frequency: half crank speed for heavier thump (RPM/60)
    const firingRate = _smoothRpm / 60;
    amOsc.frequency.setTargetAtTime(firingRate, t, 0.04);

    // Engine filter — keep it muffled like an old car, less bright
    engFilter.frequency.setTargetAtTime(250 + rpmNorm * 350, t, 0.06);

    // Volume: louder on throttle and higher RPM
    const idleVol = 0.35;
    const revVol = 0.7 + rpmNorm * 0.3;
    const targetVol = _smoothThrottle > 0.3 ? revVol : idleVol;
    preGain.gain.setTargetAtTime(targetVol, t, 0.08);

    // Exhaust noise: stays low and rumbly, old muffler
    noiseBP.frequency.setTargetAtTime(60 + rpmNorm * 80, t, 0.06);
    noiseLP.frequency.setTargetAtTime(200 + rpmNorm * 150 + _smoothThrottle * 100, t, 0.06);
    noiseGain.gain.setTargetAtTime(0.06 + _smoothThrottle * 0.08 + rpmNorm * 0.04, t, 0.08);

    // ── Tire screech on hard braking ──────────────────────────────────
    const absSpd = Math.abs(speedKmh);
    const hardBraking = brake > 0.5 && absSpd > 15;
    const screechVol = hardBraking ? Math.min(0.08, (absSpd - 15) / 80 * 0.08) : 0;
    screechGain.gain.setTargetAtTime(screechVol, t, hardBraking ? 0.12 : 0.05);
    // Squeal pitch rises slightly with speed
    screechHP.frequency.setTargetAtTime(2800 + absSpd * 5, t, 0.1);
    screechBP.frequency.setTargetAtTime(5000 + absSpd * 6, t, 0.1);

    // ── Wind — rises with speed (airy rush past ~40 km/h, loud at motorway speed) ──
    const windNorm = Math.min(1, absSpd / 150);
    windGain.gain.setTargetAtTime(windNorm * windNorm * 0.11, t, 0.12);
    windHP.frequency.setTargetAtTime(550 + absSpd * 7, t, 0.12);

    // ── Impact thud on a sharp single-frame speed drop (collision; skip frame hitches) ──
    _thudCooldown -= dt;
    if (_thudCooldown <= 0 && dt < 0.06 && _prevSpeedKmh - absSpd > 12) {
      _fireThud(Math.min(0.6, (_prevSpeedKmh - absSpd) / 60));
      _thudCooldown = 0.25;
    }
    _prevSpeedKmh = absSpd;

    // ── Exhaust crackle/pops ──────────────────────────────────────────
    _crackleTimer -= dt;

    if (downshifted && _crackleTimer <= 0) {
      // Burst of 3-5 pops on downshift
      const count = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i++) {
        setTimeout(() => _fireCrackle(), i * (30 + Math.random() * 70));
      }
      _crackleTimer = 0.4;
    } else if (throttle < 0.5 && _prevThrottle > 0.5 && rpmNorm > 0.3 && _crackleTimer <= 0) {
      // Pops when releasing throttle at high RPM
      const count = 2 + Math.floor(Math.random() * 2);
      for (let i = 0; i < count; i++) {
        setTimeout(() => _fireCrackle(), i * (50 + Math.random() * 80));
      }
      _crackleTimer = 0.3;
    } else if (throttle < 0.5 && rpmNorm > 0.2 && _crackleTimer <= 0 && Math.random() < 0.08) {
      // Occasional random pop while coasting
      _fireCrackle();
      _crackleTimer = 0.2 + Math.random() * 0.3;
    }
    _prevThrottle = throttle;
  }

  function dispose() {
    if (_ctx) {
      eng1?.stop();
      eng2?.stop();
      amOsc?.stop();
      noiseNode?.stop();
      screechNode?.stop();
      ambNode?.stop();
      windNode?.stop();
      _ctx.close();
      _ctx = null;
      _started = false;
    }
  }

  let _muted = false;
  try { _muted = localStorage.getItem('dd_soundMuted') === 'true'; } catch {}

  function setMuted(muted) {
    _muted = muted;
    if (master) master.gain.setTargetAtTime(_muted ? 0 : MASTER_VOLUME, _ctx.currentTime, 0.05);
    try { localStorage.setItem('dd_soundMuted', _muted ? 'true' : 'false'); } catch {}
  }
  function isMuted() { return _muted; }

  return { ensureStarted, update, dispose, setMuted, isMuted };
}
