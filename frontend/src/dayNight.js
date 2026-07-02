/**
 * Day/night cycle: sun movement, sky color, ambient and sun light.
 * No skybox; only background color and light updates. Lightweight.
 */
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { getCurrentTime, isNight, isSunset, isSunrise } from './timeSystem.js';

const SUN_RADIUS = 1200;
const SUN_Z_OFFSET = 400;

// Sky phase colors (hex)
const COLOR_SUNRISE_START = 0x1a0a0a;
const COLOR_SUNRISE_END = 0xffaa66;
const COLOR_DAY = 0x87ceeb;
const COLOR_SUNSET_START = 0x87ceeb;
const COLOR_SUNSET_END = 0xff6633;
const COLOR_NIGHT = 0x0a0a1a;

const SUN_COLOR_DAY = 0xffffdd;
const SUN_COLOR_SUNSET = 0xffaa66;
const SUN_COLOR_NIGHT = 0x4444aa;

const AMBIENT_DAY = 0.45;
const AMBIENT_NIGHT = 0.12;
const AMBIENT_SUNSET = 0.4;

const SUN_INTENSITY_DAY = 3;
const SUN_INTENSITY_BELOW_HORIZON = 0.02;

const _skyColor = new THREE.Color();
const _sunColor = new THREE.Color();
const _ambientColor = new THREE.Color();

function getSkyColor(t) {
  if (t >= 5 && t < 7) {
    const u = (t - 5) / 2;
    return _skyColor.setHex(THREE.MathUtils.lerp(COLOR_SUNRISE_START, COLOR_SUNRISE_END, u));
  }
  if (t >= 7 && t < 17) return _skyColor.setHex(COLOR_DAY);
  if (t >= 17 && t < 19) {
    const u = (t - 17) / 2;
    return _skyColor.setHex(THREE.MathUtils.lerp(COLOR_SUNSET_START, COLOR_SUNSET_END, u));
  }
  return _skyColor.setHex(COLOR_NIGHT);
}

function getSunColorAndIntensity(t, sunY) {
  const isBelow = sunY < 0;
  const intensity = isBelow
    ? SUN_INTENSITY_BELOW_HORIZON
    : THREE.MathUtils.lerp(SUN_INTENSITY_BELOW_HORIZON, SUN_INTENSITY_DAY, Math.min(1, sunY / 200 + 0.5));
  if (t >= 17 && t < 19) _sunColor.setHex(SUN_COLOR_SUNSET);
  else if (t >= 5 && t < 7) _sunColor.setHex(SUN_COLOR_SUNSET);
  else if (isNight()) _sunColor.setHex(SUN_COLOR_NIGHT);
  else _sunColor.setHex(SUN_COLOR_DAY);
  return { color: _sunColor.clone(), intensity };
}

function getAmbientIntensityAndColor(t) {
  if (isNight()) {
    _ambientColor.setHex(0x4444aa);
    return { intensity: AMBIENT_NIGHT, color: _ambientColor.clone() };
  }
  if (isSunset() || isSunrise()) {
    _ambientColor.setHex(0xffddbb);
    return { intensity: AMBIENT_SUNSET, color: _ambientColor.clone() };
  }
  _ambientColor.setHex(0xffffff);
  return { intensity: AMBIENT_DAY, color: _ambientColor.clone() };
}

/**
 * Create sun (DirectionalLight) and ambient. Add to scene. Call update() each frame.
 * @param {THREE.Scene} scene
 * @param {THREE.Vector3} sceneCenter - e.g. spawn position for sun orbit center
 * @returns {{ sunLight: THREE.DirectionalLight, ambientLight: THREE.AmbientLight, update: (dt: number) => void }}
 */
export function createDayNight(scene, sceneCenter) {
  const sunLight = new THREE.DirectionalLight(0xffffdd, 1);
  sunLight.castShadow = !!CONFIG.ENABLE_SHADOWS;
  const shadowSize = Math.min(1024, CONFIG.SHADOW_MAP_SIZE ?? 1024);
  sunLight.shadow.mapSize.width = shadowSize;
  sunLight.shadow.mapSize.height = shadowSize;
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = 3000;
  sunLight.shadow.camera.left = -100;
  sunLight.shadow.camera.right = 100;
  sunLight.shadow.camera.top = 100;
  sunLight.shadow.camera.bottom = -100;
  scene.add(sunLight);
  scene.add(sunLight.target);

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  const hemiLight = new THREE.HemisphereLight(0x87CEEB, 0xC8A96E, 0.45);
  scene.add(hemiLight);

  const center = sceneCenter ? new THREE.Vector3(sceneCenter.x, 0, sceneCenter.z) : new THREE.Vector3(0, 0, 0);

  function update(dt) {
    if (!CONFIG.ENABLE_DAY_NIGHT) return;
    const t = getCurrentTime();
    const angle = (t / 24) * Math.PI * 2;
    const x = Math.cos(angle) * SUN_RADIUS;
    const y = Math.sin(angle) * SUN_RADIUS;
    const z = SUN_Z_OFFSET;
    sunLight.position.set(center.x + x, center.y + y, center.z + z);
    sunLight.target.position.copy(center);
    sunLight.target.updateMatrixWorld(true);

    const sunY = y;
    const { color: sunColor, intensity: sunIntensity } = getSunColorAndIntensity(t, sunY);
    sunLight.color.copy(sunColor);
    sunLight.intensity = sunIntensity;

    const { intensity: ambInt, color: ambColor } = getAmbientIntensityAndColor(t);
    ambientLight.intensity = ambInt;
    ambientLight.color.copy(ambColor);

    // Hemisphere fades at night, full during day
    const hemiIntensity = t >= 7 && t <= 17 ? 0.45
      : (t >= 5 && t < 7)  ? THREE.MathUtils.lerp(0, 0.45, (t - 5) / 2)
      : (t > 17 && t <= 19) ? THREE.MathUtils.lerp(0.45, 0, (t - 17) / 2)
      : 0;
    hemiLight.intensity = hemiIntensity;

    scene.background.copy(getSkyColor(t));
    if (CONFIG.ENABLE_FOG) {
      const fogColor = getSkyColor(t).clone();
      if (!scene.fog || scene.fog.isFogExp2) scene.fog = new THREE.Fog(fogColor, 200, 2000);
      else {
        scene.fog.color.copy(fogColor);
      }
    } else {
      scene.fog = null;
    }
  }

  return { sunLight, ambientLight, hemiLight, update };
}
