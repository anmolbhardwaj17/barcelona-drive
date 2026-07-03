/**
 * Day / Night environment toggle.
 * Mutates only lights, fog, sky visibility and material params — no geometry rebuild.
 */
import * as THREE from 'three';
import { setGuardRailNightMode, setBillboardNightMode, setRoadMarkingNightMode } from '../map/roadRenderer.js';
import { setDividerNightMode } from '../map/dividerRenderer.js';
import { setShoulderNightMode } from '../map/shoulderRenderer.js';
import { setCloudNightMode, setMoonNightMode, setStarsNightMode } from '../scene.js';
import { setBuildingNightMode } from '../map/buildingRenderer.js';
import { setBusStopNightMode } from '../map/busStopRenderer.js';
import { setFuelStationNightMode } from '../map/urbanFeatureRenderer.js';
import { setVendorCartNightMode } from '../map/vendorCartRenderer.js';
import { setBridgePoleNightMode, setStreetlightNightMode } from '../map/streetlightRenderer.js';
import { setTreeBillboardNightMode } from '../map/vegetationRenderer.js';
import { setShopSignNightMode } from '../map/shopSignRenderer.js';

const _nightModeCallbacks = [];
/** Register a callback to be called on day/night toggle. cb(isNight: boolean) */
export function onNightModeChange(cb) { _nightModeCallbacks.push(cb); }

const DAY = {
  ambientColor:     0xc8dce8,
  ambientIntensity: 0.36,  // lowered (was 0.45) — shadows were washed out / scene too flat
  hemiSkyColor:     0xaab8d0,
  hemiGroundColor:  0xcc7733,
  hemiIntensity:    0.42,   // slightly down with ambient
  dirIntensity:     3.1,    // stronger sun (was 2.5) → firmer shadows + more contrast
  dirColor:         0xffeedd,
  fogColor:         0xaecadb,  // slightly lighter, warmer haze
  fogDensity:       0.0052,     // eased from 0.007 — keeps the city crisp, distance still hazes
  skyVisible:       true,
  bgColor:          null,
  toneMappingExposure: 1.0,
  lampEmissive:     0.25,   // subtle glow in daylight
  poolOpacity:      0.04,   // barely visible in daylight
  lightsOn:         false,
};

const NIGHT = {
  ambientColor:     0x6982b4,  // cool blue sky-bounce, lifted a touch for visibility
  ambientIntensity: 1.15,      // raised (was 0.75) — felt too dark to drive; still moody, not washed (1.6 was).
  hemiSkyColor:     0x2a3d60,
  hemiGroundColor:  0x141020,
  hemiIntensity:    0.20,      // more sky/ground fill so buildings + trees stay readable at night
  dirIntensity:     0.45,      // moonlight — a bit stronger for form
  dirColor:         0xc8d8ff,  // cool blue-white moonlight
  fogColor:         0x0a1020,
  fogDensity:       0.009,
  skyVisible:       false,
  bgColor:          0x121a2e,  // deep blue, not pure black — slightly lifted
  toneMappingExposure: 1.05,   // a touch more exposure at night
  lampEmissive:     5.0,       // streetlamp glow (bloom); a bit hotter so lamps read as the light source
  poolOpacity:      1.0,
  lightsOn:         true,
};

/**
 * @param {{
 *   scene: THREE.Scene,
 *   renderer: THREE.WebGLRenderer,
 *   ambientLight: THREE.AmbientLight,
 *   hemiLight: THREE.HemisphereLight,
 *   dirLight: THREE.DirectionalLight,
 *   sky: object,
 *   setLampEmissiveIntensity: (v: number) => void,
 *   setPoolOpacity: (v: number) => void,
 * }} refs
 * @returns {{ element: HTMLButtonElement, isNight: () => boolean }}
 */
export function createEnvToggle(refs) {
  const { scene, renderer, ambientLight, hemiLight, dirLight, sky,
          setLampEmissiveIntensity, setPoolOpacity } = refs;

  let mode = 'day';

  // ── Color / numeric helpers ────────────────────────────────────────────────
  const _c1 = new THREE.Color(), _c2 = new THREE.Color(), _cMix = new THREE.Color();
  function lerpColor(a, b, t) {
    _c1.set(a); _c2.set(b);
    _cMix.copy(_c1).lerp(_c2, t);
    return _cMix;
  }
  function lerpNum(a, b, t) { return a + (b - a) * t; }

  // ── Transition state ───────────────────────────────────────────────────────
  const TRANSITION_DURATION = 1.5; // seconds
  let _transFrom = DAY;
  let _transTo = DAY;
  let _transT = 1;         // 0→1 progress (1 = done)
  let _transActive = false;
  let _materialsSwitched = false;
  let _lastTransTime = 0;

  function applyLerp(t) {
    const from = _transFrom, to = _transTo;

    if (ambientLight) {
      ambientLight.color.copy(lerpColor(from.ambientColor, to.ambientColor, t));
      ambientLight.intensity = lerpNum(from.ambientIntensity, to.ambientIntensity, t);
    }
    if (hemiLight) {
      hemiLight.color.copy(lerpColor(from.hemiSkyColor, to.hemiSkyColor, t));
      hemiLight.groundColor.copy(lerpColor(from.hemiGroundColor, to.hemiGroundColor, t));
      hemiLight.intensity = lerpNum(from.hemiIntensity, to.hemiIntensity, t);
    }
    if (dirLight) {
      dirLight.color.copy(lerpColor(from.dirColor, to.dirColor, t));
      dirLight.intensity = lerpNum(from.dirIntensity, to.dirIntensity, t);
    }
    if (scene.fog) {
      scene.fog.color.copy(lerpColor(from.fogColor, to.fogColor, t));
      if (scene.fog.density !== undefined) {
        scene.fog.density = lerpNum(from.fogDensity, to.fogDensity, t);
      }
    }

    // Background: lerp between day sky color and night bgColor
    const dayBg = from.bgColor != null ? from.bgColor : 0x9dc2db;
    const nightBg = to.bgColor != null ? to.bgColor : 0x9dc2db;
    scene.background = lerpColor(dayBg, nightBg, t).clone();

    renderer.toneMappingExposure = lerpNum(from.toneMappingExposure, to.toneMappingExposure, t);
    setLampEmissiveIntensity?.(lerpNum(from.lampEmissive, to.lampEmissive, t));
    setPoolOpacity?.(lerpNum(from.poolOpacity, to.poolOpacity, t));

    // Sky visibility toggles at midpoint
    if (sky && t >= 0.5) sky.visible = to.skyVisible;
  }

  function fireMaterialCallbacks(isNight) {
    setGuardRailNightMode(isNight);
    setBillboardNightMode(isNight);
    setRoadMarkingNightMode(isNight);
    setTreeBillboardNightMode(isNight);
    setShopSignNightMode(isNight);
    setStreetlightNightMode(isNight);
    setDividerNightMode(isNight);
    setShoulderNightMode(isNight);
    setCloudNightMode(isNight);
    setMoonNightMode(isNight);
    setStarsNightMode(isNight);
    setBuildingNightMode(isNight);
    setBusStopNightMode(isNight);
    setFuelStationNightMode(isNight);
    setVendorCartNightMode(isNight);
    setBridgePoleNightMode(isNight);
    for (const cb of _nightModeCallbacks) cb(isNight);
  }

  function transitionTick(time) {
    if (!_transActive) return;
    const dt = _lastTransTime === 0 ? 0.016 : (time - _lastTransTime) / 1000;
    _lastTransTime = time;

    _transT = Math.min(1, _transT + dt / TRANSITION_DURATION);
    // Smooth ease-in-out
    const eased = _transT < 0.5
      ? 2 * _transT * _transT
      : 1 - Math.pow(-2 * _transT + 2, 2) / 2;

    applyLerp(eased);

    // Fire material switches at midpoint
    if (!_materialsSwitched && _transT >= 0.4) {
      _materialsSwitched = true;
      fireMaterialCallbacks(mode === 'night');
    }

    if (_transT >= 1) {
      _transActive = false;
    } else {
      requestAnimationFrame(transitionTick);
    }
  }

  function applyMode(m, instant) {
    const prev = mode;
    mode = m;
    const target = m === 'night' ? NIGHT : DAY;
    const from = prev === 'night' ? NIGHT : DAY;

    if (instant) {
      _transFrom = target;
      _transTo = target;
      _transT = 1;
      _transActive = false;
      applyLerp(1);
      if (sky) sky.visible = target.skyVisible;
      fireMaterialCallbacks(m === 'night');
      return;
    }

    _transFrom = from;
    _transTo = target;
    _transT = 0;
    _materialsSwitched = false;
    _lastTransTime = 0;
    _transActive = true;
    requestAnimationFrame(transitionTick);
  }

  // Restore saved mode or default to day
  const savedMode = (() => { try { return localStorage.getItem('dd_dayNight') || 'day'; } catch { return 'day'; } })();
  applyMode(savedMode, true);

  // ── Toggle switch (chunky gamified pill — matches the settings toggles) ─────
  const TRACK_W = 74, TRACK_H = 40, KNOB_SIZE = 32, KNOB_PAD = 4;

  // press-down effect (inline styles can't do :active)
  const _st = document.createElement('style');
  _st.textContent = '#env-toggle:active { transform: translateY(5px); }';
  document.head.appendChild(_st);

  const toggle = document.createElement('div');
  toggle.id = 'env-toggle';
  toggle.style.cssText = `
    position: fixed; top: 14px; right: 14px; z-index: 1000;
    width: ${TRACK_W}px; height: ${TRACK_H}px; border-radius: 22px;
    cursor: pointer; user-select: none;
    border: 3px solid rgba(0,0,0,0.18);
    transition: background .35s ease, box-shadow .06s, transform .06s;
  `;

  const knob = document.createElement('div');
  knob.style.cssText = `
    width: ${KNOB_SIZE}px; height: ${KNOB_SIZE}px; border-radius: 50%;
    position: absolute; top: ${(TRACK_H - KNOB_SIZE) / 2}px; background: #fff;
    transition: left .3s ease;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 2px 4px rgba(0,0,0,0.3);
  `;
  toggle.appendChild(knob);

  function updateToggle() {
    const isNight = mode === 'night';
    toggle.style.background = isNight ? 'linear-gradient(#4a6ea5,#284872)' : 'linear-gradient(#ffe07a,#f5b32a)';
    toggle.style.boxShadow = (isNight ? '0 6px 0 #16304f' : '0 6px 0 #c8871a') + ', 0 9px 12px rgba(0,0,0,0.35)';
    knob.style.left = isNight ? `${TRACK_W - KNOB_SIZE - KNOB_PAD}px` : `${KNOB_PAD}px`;
    knob.innerHTML = isNight
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="#3a5a8a"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f5931f" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
  }
  updateToggle();

  toggle.addEventListener('click', () => {
    const newMode = mode === 'day' ? 'night' : 'day';
    applyMode(newMode);
    updateToggle();
    try { localStorage.setItem('dd_dayNight', newMode); } catch {}
  });

  document.body.appendChild(toggle);

  return {
    element: toggle,
    isNight: () => mode === 'night',
    // Re-apply the current night state to all shared materials. Call once after the initial tiles have
    // built — at startup the callbacks fire before any tile material exists (no-ops), so loading straight
    // into night otherwise leaves shoulders/dividers/bus-stop glow/tree billboards etc. in day appearance.
    reapply: () => fireMaterialCallbacks(mode === 'night'),
  };
}
