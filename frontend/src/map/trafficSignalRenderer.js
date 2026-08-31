/**
 * trafficSignalRenderer.js — Barcelona traffic signals, from the BAKED OSM positions. T-2.
 *
 * ── WHY THIS REPLACES generateTrafficLights() RATHER THAN REVIVING IT ──────────────────────────
 * The old builder was disabled on sight — "in daylight the signal box just read as an ugly dark box
 * on a stick sitting in the driving path" — and reading it explains the second half of that
 * sentence exactly:
 *
 *     // Left side of road (India drives on the left, lights on the left facing oncoming)
 *     const nx = cr.tz, nz = -cr.tx;
 *
 * That is Delhi-era code. Barcelona drives on the RIGHT, so every signal was planted on the wrong
 * side of the carriageway — across the road, in the driving path. It also SYNTHESISED positions
 * from intersection geometry while the tiles already carry real OSM signal nodes: 4,225 of them
 * across the centre, 9.6 per tile, parsed all the way to `tileManager` and then dropped.
 *
 * So this takes the baked positions (they sit at the correct kerbs because a surveyor put them
 * there) and draws a slim pole rather than a box on a stick.
 *
 * ── ONE GLOBAL TWO-PHASE CLOCK, AND THAT IS NOT A SHORTCUT ────────────────────────────────────
 * Signals are grouped by APPROACH AXIS, not per junction, and every junction in the city runs the
 * same cycle. In a normal city that would be wrong; in the Eixample it is what actually happens —
 * the grid is signal-coordinated for green waves along the avenues. It also means the phase is ONE
 * uniform instead of per-junction state, so the whole city's signals cost a single draw and a
 * float.
 *
 * The lamp is chosen in the FRAGMENT shader from that uniform, so nothing is rebuilt when the phase
 * changes — no geometry churn, no per-frame JS beyond writing one number.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Full cycle, seconds. Both axes share it, offset by half. */
export const SIGNAL_CYCLE_S = 24;

const POLE_R = 0.055;      // m — a signal pole is slim; the old one read as a bollard
const POLE_H = 3.05;
const HEAD_W = 0.24, HEAD_H = 0.70, HEAD_D = 0.20;
const HEAD_Y = 2.30;       // centre of the head above the kerb
const LENS_R = 0.072;
const KERB_OFFSET = 0.45;  // m out from the baked point, away from the carriageway

const DARK = 0x24272b;     // housing + pole: Barcelona signals are near-black, not mid grey

/** Packed per-vertex id: axis * 4 + lamp (0 red, 1 amber, 2 green, 3 = housing/pole). */
const HOUSING = 3;

function lensGeo(x, y, z, lamp, axis) {
  const g = new THREE.CircleGeometry(LENS_R, 10);
  g.translate(x, y, z);
  tagGeo(g, axis * 4 + lamp);
  return g;
}
function tagGeo(g, id) {
  const n = g.attributes.position.count;
  const a = new Float32Array(n);
  a.fill(id);
  g.setAttribute('aSignal', new THREE.BufferAttribute(a, 1));
  return g;
}

let _material = null;
function getSignalMaterial() {
  if (_material) return _material;
  _material = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: false });
  _material.onBeforeCompile = (shader) => {
    shader.uniforms.uSignalTime = { value: 0 };
    _material.userData.uniforms = shader.uniforms;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSignal;\nvarying float vSignal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSignal = aSignal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nuniform float uSignalTime;\nvarying float vSignal;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        // 0-2 = red/amber/green on axis A, 4-6 the same on axis B, 3 and 7 = housing.
        float sid = vSignal;
        float axis = step(3.5, sid);
        float lamp = sid - axis * 4.0;
        if (lamp > 2.5) {
          diffuseColor.rgb = vec3(0.055, 0.061, 0.068);         // housing / pole
        } else {
          // Axis B runs half a cycle behind A. Phase: green, amber, then red for the rest.
          float t = mod(uSignalTime + axis * ${(SIGNAL_CYCLE_S / 2).toFixed(1)}, ${SIGNAL_CYCLE_S.toFixed(1)});
          float lit = 0.0;
          if (lamp < 0.5)      lit = step(12.0, t);                       // red   12..24
          else if (lamp < 1.5) lit = step(10.0, t) * (1.0 - step(12.0, t)); // amber 10..12
          else                 lit = 1.0 - step(10.0, t);                 // green  0..10
          vec3 hue = lamp < 0.5 ? vec3(0.95, 0.11, 0.07)
                   : lamp < 1.5 ? vec3(0.98, 0.62, 0.05)
                                : vec3(0.16, 0.88, 0.30);
          // An unlit lens is not black — it is a dark version of its own colour, which is what makes
          // a signal head readable in daylight even when only one lamp is on.
          diffuseColor.rgb = mix(hue * 0.14, hue, lit);
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float sid2 = vSignal;
          float axis2 = step(3.5, sid2);
          float lamp2 = sid2 - axis2 * 4.0;
          if (lamp2 < 2.5) {
            float t2 = mod(uSignalTime + axis2 * ${(SIGNAL_CYCLE_S / 2).toFixed(1)}, ${SIGNAL_CYCLE_S.toFixed(1)});
            float lit2 = lamp2 < 0.5 ? step(12.0, t2)
                       : lamp2 < 1.5 ? step(10.0, t2) * (1.0 - step(12.0, t2))
                                     : 1.0 - step(10.0, t2);
            vec3 hue2 = lamp2 < 0.5 ? vec3(0.95, 0.11, 0.07)
                      : lamp2 < 1.5 ? vec3(0.98, 0.62, 0.05)
                                    : vec3(0.16, 0.88, 0.30);
            // Emissive is what makes a lit lens read at distance and at night, and what bloom sees.
            totalEmissiveRadiance += hue2 * lit2 * 0.55;
          }
        }`);
  };
  _material.customProgramCacheKey = () => 'trafficSignal-v1';
  _material.userData.sharedMaterial = true;
  return _material;
}

let _signalNow = 0;

/** Advance every signal in the city. One uniform write — no geometry touched. */
export function updateSignals(timeSeconds) {
  _signalNow = timeSeconds;
  const u = _material?.userData?.uniforms;
  if (u && u.uSignalTime) u.uSignalTime.value = timeSeconds % SIGNAL_CYCLE_S;
}

/**
 * The clock the LAMPS are currently showing.
 *
 * The traffic AI must read this rather than sampling its own `performance.now()`. Both would be the
 * same clock today — the rAF timestamp shares performance.now's origin — but "same today" is how
 * two timings drift apart later, and the failure mode is cars stopping at green and driving through
 * red, which looks deliberate and would be hard to trace.
 */
export function signalNow() { return _signalNow; }

/**
 * Is this axis showing red (or amber) right now? T-3.
 *
 * ⚠ MUST MATCH THE SHADER ABOVE. The lamp a driver SEES is chosen in the fragment shader from
 * `uSignalTime`; this is what a traffic car OBEYS. If the two timings drift, cars stop at green and
 * sail through red — the worst kind of bug, because everything looks deliberate. Same constants,
 * same half-cycle offset, deliberately adjacent in this file so they are edited together.
 *
 * Amber counts as stop: a driver approaching an amber slows, and treating it as go would put cars
 * INTO the junction as the phase turns.
 */
export function isRedFor(axis, timeSeconds) {
  const t = (timeSeconds + axis * (SIGNAL_CYCLE_S / 2)) % SIGNAL_CYCLE_S;
  return t >= 10;   // green 0..10, amber 10..12, red 12..24 — stop from amber onward
}

/** Which phase group an approach belongs to, from its heading. 0 = A (N-S-ish), 1 = B (E-W-ish). */
export function axisForHeading(dx, dz) {
  return Math.abs(dx) > Math.abs(dz) ? 1 : 0;
}

/**
 * Build one tile's signals.
 * @param {{id:number, point:number[]}[]} signals baked OSM signal nodes
 * @param {Function} getGroundY (x, z) → surface height
 * @param {Function} nearestRoad (x, z) → { tx, tz } road tangent, or null
 */
export function buildTrafficSignals(signals, getGroundY, nearestRoad) {
  if (!signals || !signals.length) return null;
  const geos = [];
  for (const s of signals) {
    const wx = s.point[0], wz = s.point[1];
    const road = nearestRoad?.(wx, wz);
    // Heading of the road this signal governs; without it the head faces an arbitrary way and the
    // lenses are edge-on to the driver, which is most of what made the old ones read as boxes.
    const tx = road?.tx ?? 0, tz = road?.tz ?? 1;
    const axis = axisForHeading(tx, tz);
    // Step to the RIGHT of the carriageway — Barcelona drives on the right, and the old builder's
    // left-hand offset is exactly why signals ended up in the driving path.
    const nx = -tz, nz = tx;
    const px = wx + nx * KERB_OFFSET, pz = wz + nz * KERB_OFFSET;
    const baseY = getGroundY?.(px, pz) ?? 0;

    const pole = new THREE.CylinderGeometry(POLE_R, POLE_R * 1.25, POLE_H, 6);
    pole.translate(px, baseY + POLE_H / 2, pz);
    geos.push(tagGeo(pole, HOUSING));

    const head = new THREE.BoxGeometry(HEAD_W, HEAD_H, HEAD_D);
    head.translate(px, baseY + HEAD_Y, pz);
    head.rotateY(0);
    geos.push(tagGeo(head, HOUSING));

    // Lenses on the face pointing back down the road at oncoming traffic.
    const fx = -tx, fz = -tz;
    const lx = px + fx * (HEAD_D / 2 + 0.012), lz = pz + fz * (HEAD_D / 2 + 0.012);
    for (let lamp = 0; lamp < 3; lamp++) {
      const y = baseY + HEAD_Y + (0.21 - lamp * 0.21);
      const g = new THREE.CircleGeometry(LENS_R, 10);
      g.rotateY(Math.atan2(fx, fz));
      g.translate(lx, y, lz);
      geos.push(tagGeo(g, axis * 4 + lamp));
    }
  }
  if (!geos.length) return null;
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) return null;
  const mesh = new THREE.Mesh(merged, getSignalMaterial());
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.type = 'trafficSignal';
  mesh.userData.sharedMaterial = true;
  return mesh;
}
