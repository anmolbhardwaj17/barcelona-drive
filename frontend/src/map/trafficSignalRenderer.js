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
const HEAD_Y = 2.62;       // centre of the main head above the kerb
const REPEATER_Y = 1.22;   // low repeater — readable from the front of the queue
const LENS_R = 0.072;
const KERB_OFFSET = 0.45;  // m out from the baked point, away from the carriageway

const DARK = 0x24272b;     // housing + pole: Barcelona signals are near-black, not mid grey

/** Packed per-vertex id: axis * 4 + lamp (0 red, 1 amber, 2 green, 3 = housing/pole). */
const HOUSING = 3;

function tagGeo(g, id, phase = 0) {
  const n = g.attributes.position.count;
  const a = new Float32Array(n); a.fill(id);
  g.setAttribute('aSignal', new THREE.BufferAttribute(a, 1));
  // Per-junction place in the cycle, per vertex. A uniform would force one phase for the whole
  // city — which is exactly the artificial look this replaces — and a uniform ARRAY would cap how
  // many junctions can be resident.
  const ph = new Float32Array(n); ph.fill(phase);
  g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
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
      .replace('#include <common>',
        '#include <common>\nattribute float aSignal;\nattribute float aPhase;\n'
        + 'varying float vSignal;\nvarying float vPhase;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSignal = aSignal;\nvPhase = aPhase;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nuniform float uSignalTime;\nvarying float vSignal;\nvarying float vPhase;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        // 0-2 = red/amber/green on axis A, 4-6 the same on axis B, 3 and 7 = housing.
        float sid = vSignal;
        float axis = step(3.5, sid);
        float lamp = sid - axis * 4.0;
        if (lamp > 2.5) {
          diffuseColor.rgb = vec3(0.055, 0.061, 0.068);         // housing / pole
        } else {
          // Axis B runs half a cycle behind A. Phase: green, amber, then red for the rest.
          float t = mod(uSignalTime + vPhase + axis * ${(SIGNAL_CYCLE_S / 2).toFixed(1)}, ${SIGNAL_CYCLE_S.toFixed(1)});
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
            float t2 = mod(uSignalTime + vPhase + axis2 * ${(SIGNAL_CYCLE_S / 2).toFixed(1)}, ${SIGNAL_CYCLE_S.toFixed(1)});
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
export function isRedFor(axis, timeSeconds, phaseOffset = 0) {
  const t = (timeSeconds + phaseOffset + axis * (SIGNAL_CYCLE_S / 2)) % SIGNAL_CYCLE_S;
  return t >= 10;   // green 0..10, amber 10..12, red 12..24 — stop from amber onward
}

/**
 * Group signals into junctions and give each its own place in the cycle. T-4.
 *
 * A single global phase made every junction in Barcelona turn green in the same second, which is
 * the tell that a city is running one clock rather than many. Real junctions are independent (or
 * coordinated into waves, which is a phase OFFSET, not the same phase).
 *
 * Clustered by proximity: signals within JUNCTION_R of each other are the same crossing, which is
 * true because they are the surveyed corners of one intersection. The offset is derived from the
 * cluster's own position, so it is deterministic — a junction shows the same phase every time you
 * drive back to it, and two tiles that both contain a signal agree without sharing state.
 */
const JUNCTION_R = 26;   // m — corners of one crossing sit well inside this; the next junction does not
export function clusterJunctions(points) {
  const cluster = new Array(points.length).fill(-1);
  const centres = [];
  for (let i = 0; i < points.length; i++) {
    if (cluster[i] !== -1) continue;
    const cid = centres.length;
    let sx = 0, sz = 0, n = 0;
    for (let j = i; j < points.length; j++) {
      if (cluster[j] !== -1) continue;
      const dx = points[j].x - points[i].x, dz = points[j].z - points[i].z;
      if (dx * dx + dz * dz > JUNCTION_R * JUNCTION_R) continue;
      cluster[j] = cid; sx += points[j].x; sz += points[j].z; n++;
    }
    centres.push({ x: sx / n, z: sz / n });
  }
  // Offset from the centroid — stable across reloads and across the tile boundary, with no shared
  // counter to keep in sync. Quantised to whole seconds so a junction's phase reads as a decision
  // rather than as noise.
  return cluster.map((cid) => {
    const c = centres[cid];
    const h = Math.abs(Math.round(c.x * 0.7) * 73856093 ^ Math.round(c.z * 0.7) * 19349663);
    return { cluster: cid, offset: (h % SIGNAL_CYCLE_S) };
  });
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

  // Cluster FIRST, so the phase is a property of the junction rather than of each pole. Computed
  // once here and returned alongside the mesh: the traffic AI reads what was actually drawn instead
  // of recomputing it, which is how the axis and the lamp are kept from disagreeing.
  const pts = signals.map((sg) => ({ x: sg.point[0], z: sg.point[1] }));
  const groups = clusterJunctions(pts);

  const geos = [];
  const meta = [];
  for (let i = 0; i < signals.length; i++) {
    const wx = pts[i].x, wz = pts[i].z;
    const phase = groups[i].offset;
    const road = nearestRoad?.(wx, wz);
    // Heading of the road this signal governs. Without it the head faces an arbitrary way and the
    // lenses sit edge-on to the driver, which is most of what made the old ones read as boxes.
    const tx = road?.tx ?? 0, tz = road?.tz ?? 1;
    const axis = axisForHeading(tx, tz);
    // Step to the RIGHT of the carriageway — Barcelona drives on the right, and the old builder's
    // left-hand offset (written for Delhi) is exactly why signals ended up in the driving path.
    const nx = -tz, nz = tx;
    const px = wx + nx * KERB_OFFSET, pz = wz + nz * KERB_OFFSET;
    const baseY = getGroundY?.(px, pz) ?? 0;
    const facing = Math.atan2(-tx, -tz);          // back down the road, at oncoming traffic
    const fx = -tx, fz = -tz;

    const pole = new THREE.CylinderGeometry(POLE_R, POLE_R * 1.3, POLE_H, 6);
    pole.translate(px, baseY + POLE_H / 2, pz);
    geos.push(tagGeo(pole, HOUSING, phase));

    // ── TWO HEADS, WHICH IS THE BARCELONA TELL ────────────────────────────────────────────────
    // A main head high on the pole and a REPEATER at windscreen height. The low one is why you can
    // still read the signal from the front of the queue, and it is the detail that makes these
    // read as Barcelona rather than as generic three-lamp boxes.
    for (const h of [{ y: HEAD_Y, s: 1 }, { y: REPEATER_Y, s: 0.78 }]) {
      const head = new THREE.BoxGeometry(HEAD_W * h.s, HEAD_H * h.s, HEAD_D * h.s);
      head.rotateY(facing);
      head.translate(px, baseY + h.y, pz);
      geos.push(tagGeo(head, HOUSING, phase));

      const lz2 = HEAD_D * h.s / 2 + 0.012;
      for (let lamp = 0; lamp < 3; lamp++) {
        const y = baseY + h.y + (0.21 - lamp * 0.21) * h.s;
        const lens = new THREE.CircleGeometry(LENS_R * h.s, 10);
        lens.rotateY(facing);
        lens.translate(px + fx * lz2, y, pz + fz * lz2);
        geos.push(tagGeo(lens, axis * 4 + lamp, phase));

        // Visor: a short hood over each lens. Real signals have them so the sun does not wash the
        // lamp out, and they are most of the silhouette that says "traffic light" at a distance.
        const visor = new THREE.CylinderGeometry(LENS_R * h.s * 1.35, LENS_R * h.s * 1.35,
                                                 0.055 * h.s, 8, 1, true, Math.PI, Math.PI);
        visor.rotateX(Math.PI / 2);
        visor.rotateY(facing);
        visor.translate(px + fx * (lz2 + 0.02), y + LENS_R * h.s * 0.5, pz + fz * (lz2 + 0.02));
        geos.push(tagGeo(visor, HOUSING, phase));
      }
    }

    meta.push({ x: wx, z: wz, axis, phase });
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
  return { mesh, meta };
}
