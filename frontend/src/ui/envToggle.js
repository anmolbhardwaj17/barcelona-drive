/**
 * Day / Night environment toggle.
 * Mutates only lights, fog, sky visibility and material params — no geometry rebuild.
 */
import * as THREE from 'three';
import { setGuardRailNightMode, setBillboardNightMode, setRoadMarkingNightMode, setRoadDecalNightMode } from '../map/roadRenderer.js';
import { setCloudNightMode, setMoonNightMode, setStarsNightMode } from '../scene.js';
import { setAoNightScale } from '../map/aoSampler.js';
import { setBuildingNightMode } from '../map/buildingRenderer.js';
import { setFacadeNightMode } from '../workers/meshMaterializer.js';
import { setBusStopNightMode } from '../map/busStopRenderer.js';
import { setFuelStationNightMode } from '../map/urbanFeatureRenderer.js';
import { setBridgePoleNightMode, setStreetlightNightMode } from '../map/streetlightRenderer.js';
import { setTreeBillboardNightMode } from '../map/vegetationRenderer.js';
import { setTreeCardNightMode } from '../map/treeCards.js';
import { setBushCardNightMode } from '../map/bushCards.js';
import { setLightGridNightMode } from '../map/lightGrid.js';
import { setShopSignNightMode } from '../map/shopSignRenderer.js';
import { setShopfrontNightMode } from '../map/shopfrontRenderer.js';
import { UI, iconButton, injectUITheme } from './theme.js';

const _nightModeCallbacks = [];
/** Register a callback to be called on day/night toggle. cb(isNight: boolean) */
export function onNightModeChange(cb) { _nightModeCallbacks.push(cb); }

const DAY = {
  // L1 golden-hour split: the hemi (now a REAL light — cool sky fill + warm ground bounce) carries the
  // colour separation; ambient drops to a neutral base so the fill isn't doubled. Sun warmed slightly.
  ambientColor:     0xd4e2ec,
  ambientIntensity: 0.30,
  hemiSkyColor:     0xa3c0e4, // cool blue sky-light → shadows read cool
  hemiGroundColor:  0xc4966a, // warm ground bounce, eased (0xd08a4e washed facades too golden)
  hemiIntensity:    0.55,
  dirIntensity:     2.7,
  dirColor:         0xffe3c2, // warm key, one notch whiter (0xffdcae read too yellow on cream walls)
  fogColor:         0xc4dcea,  // brighter sky-matched haze (less grey)
  fogDensity:       0.0032,     // thinned (was 0.0052) — day haze was reading as a grey wash over the frame
  skyVisible:       true,
  bgColor:          null,
  toneMappingExposure: 1.6,   // pulled from 1.9 — the scene was overexposed, washing every surface colour pale
  lampEmissive:     0.25,   // subtle glow in daylight
  bloomStrength:    0.5,    // subtle bloom by day (only the sun/bright highlights)
  bloomThreshold:   1.1,    // high threshold → daytime scene doesn't bloom
  lightsOn:         false,
};

const NIGHT = {
  // Reference-matched night (low-poly cinematic renders): the WHOLE albedo palette collapses into a
  // narrow dark blue-charcoal band — day colours must NOT survive (no vivid greens / bright cream
  // facades after dark). Fill light is deep desaturated blue at LOW intensity; the warm emissives
  // (windows, streetlamps, signs) carry all the contrast and pop against it via bloom.
  ambientColor:     0x6b7a9e,  // desaturated blue fill — the blue TINT (not darkness) is what sells night
  ambientIntensity: 1.0,       // readable floor: geometry must survive as blue-charcoal masses, not voids
  hemiSkyColor:     0x46567e,  // dark blue sky dome light
  hemiGroundColor:  0x232a3a,  // dark ground bounce
  hemiIntensity:    0.6,
  dirIntensity:     0.7,       // soft moon — form on rooftops/facades
  dirColor:         0x8fa6d8,  // cool moonlight
  fogColor:         0x101a2e,  // deep navy haze
  fogDensity:       0.0045,    // thin night haze so the distance keeps depth, not grey murk
  skyVisible:       false,
  bgColor:          0x0a1224,  // deep navy sky
  toneMappingExposure: 1.5,    // 1.75 read as day; darkness now comes from the blue rig + grade, not exposure
  lampEmissive:     9.0,       // hotter streetlamp glow → warm pops punch through the deep blue
  bloomStrength:    0.55,      // soft halo only — 1.0 turned every window into a fuzzy ball
  bloomThreshold:   0.72,      // just the truly bright emissives bloom (lamps, window cores)
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
 * }} refs
 * @returns {{ element: HTMLButtonElement, isNight: () => boolean }}
 */
/**
 * The fog density the CURRENT day/night preset wants, tracked through transitions.
 *
 * v3 D-06: main.js modulates fog per camera situation (drone mode → 0, title cinematic → near-zero,
 * altitude fade above ~40 m) and used to write a hardcoded 0.005, which silently overwrote these
 * presets every frame — so DAY 0.0032 and NIGHT 0.0045 had never actually shipped. main.js now
 * multiplies THIS value instead of replacing it, so both systems keep their job: the preset owns
 * "what this time of day wants", main.js owns "what the camera situation allows".
 * Gotcha G-44's drive-mode-only invariant is preserved exactly.
 */
let _presetFogDensity = DAY.fogDensity;
export function getPresetFogDensity() { return _presetFogDensity; }

export function createEnvToggle(refs) {
  const { scene, renderer, ambientLight, hemiLight, dirLight, sky,
          setLampEmissiveIntensity, setBloom } = refs;

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
        _presetFogDensity = lerpNum(from.fogDensity, to.fogDensity, t);
        scene.fog.density = _presetFogDensity;   // main.js re-modulates this per camera situation
      }
    }

    // Background: lerp between day sky color and night bgColor
    const dayBg = from.bgColor != null ? from.bgColor : 0x9dc2db;
    const nightBg = to.bgColor != null ? to.bgColor : 0x9dc2db;
    scene.background = lerpColor(dayBg, nightBg, t).clone();

    renderer.toneMappingExposure = lerpNum(from.toneMappingExposure, to.toneMappingExposure, t);
    setLampEmissiveIntensity?.(lerpNum(from.lampEmissive, to.lampEmissive, t));
    setBloom?.(lerpNum(from.bloomStrength, to.bloomStrength, t), lerpNum(from.bloomThreshold, to.bloomThreshold, t));

    // Sky visibility toggles at midpoint
    if (sky && t >= 0.5) sky.visible = to.skyVisible;
  }

  function fireMaterialCallbacks(isNight) {
    setGuardRailNightMode(isNight);
    setBillboardNightMode(isNight);
    setRoadMarkingNightMode(isNight);
    setTreeBillboardNightMode(isNight);
    setTreeCardNightMode(isNight);   // lit cards need a LIFT at night; impostors need a tint
    setBushCardNightMode(isNight);   // undergrowth follows the canopy — same surface, same sky
    setLightGridNightMode(isNight);  // street lamps light the ground only after dark
    setShopSignNightMode(isNight);
    setShopfrontNightMode(isNight);
    setStreetlightNightMode(isNight);
    setCloudNightMode(isNight);
    setMoonNightMode(isNight);
    setStarsNightMode(isNight);
    setBuildingNightMode(isNight);
    setFacadeNightMode(isNight);   // the LIVE facade materials (worker/materializer path) — window glow
    setAoNightScale(isNight);      // soften baked sky-AO — the night rig is dark already
    setRoadDecalNightMode(isNight); // bike-lane green + blue-zone stripes crush to black otherwise
    setBusStopNightMode(isNight);
    setFuelStationNightMode(isNight);
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

  // ── Day / night toggle — flat frosted icon button (art-of-rally chrome) ─────
  injectUITheme();
  const toggle = document.createElement('div');
  toggle.id = 'env-toggle';
  toggle.className = 'dd-btn';
  toggle.title = 'Toggle day / night';
  toggle.style.cssText = iconButton({ size: 46 }) + 'position:fixed;top:14px;right:14px;z-index:1000;';

  function updateToggle() {
    const isNight = mode === 'night';
    // Simple, single-weight line icon in warm cream — sun by day, moon by night.
    toggle.innerHTML = isNight
      ? `<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="${UI.cream}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`
      : `<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="${UI.cream}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`;
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
