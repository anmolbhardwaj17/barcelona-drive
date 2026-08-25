/**
 * headlightCookie.js — a real low-beam pattern for the headlight SpotLights (v3 P2-07).
 *
 * WHY THIS IS THE CHEAPEST ETS2-IDENTIFIABLE WIN. A bare three SpotLight throws a smooth circular
 * cone: bright in the middle, fading evenly outward, symmetric top to bottom. No headlight on any
 * road looks like that. A dipped beam has a HARD HORIZONTAL CUT-OFF — that is the whole point of it,
 * the reason it does not blind oncoming traffic — with a hotspot pressed up under the cut line and
 * a kick-up on the kerb side to light signs and the verge. That silhouette is instantly readable as
 * "car headlight" and its absence is instantly readable as "game light".
 *
 * ECE (Europe/Spain, right-hand traffic): flat on the oncoming-traffic side, stepped up ~15 degrees
 * on the kerb side.
 *
 * PROCEDURAL, NOT AUTHORED. The plan called for a Blender-authored 512² map. This generates the
 * same shape in ~1 ms at startup, which keeps it tunable in one place, adds nothing to the art
 * budget, and does not consume a CanvasTexture allowance (see scripts/lint-canvas.mjs — the ratchet
 * is per-file and one-way).
 */
import * as THREE from 'three';

const SIZE = 256;   // a beam is all soft gradients; 512 buys nothing visible and 4x the VRAM

const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Beam intensity at a point in the cone's cross-section.
 * @param x -1..1 horizontal, 0 = straight ahead. POSITIVE = kerb side (the side that kicks up).
 * @param y -1..1 vertical, +1 = up.
 */
export function beamIntensity(x, y) {
  // The cut-off line. Flat across the oncoming side, stepping up on the kerb side.
  const CUT = 0.06;        // just above centre — the beam sits low
  const KICK = 0.30;       // kerb-side step (the ECE 15-degree shoulder)
  const cut = CUT + (x > 0 ? KICK * smoothstep(0.0, 0.35, x) : 0);

  const d = y - cut;
  let a;
  if (d > 0) {
    // ABOVE the cut-off. Not black: a real cut-off has a thin halo and a little stray light, and a
    // hard zero here reads as a cardboard cut-out sliding over the world.
    a = 0.02 + 0.35 * Math.exp(-((d / 0.045) ** 2));
  } else {
    // BELOW. Hotspot pressed up against the cut line, foreground kept lit so the road right in
    // front of the car does not fall into a hole.
    a = 0.25 + 0.75 * Math.exp(-((-d / 0.42) ** 2));
  }

  a *= Math.exp(-((x / 0.72) ** 2));                       // horizontal falloff
  a *= 1 - smoothstep(0.85, 1.05, Math.hypot(x, y));       // soft cone edge, no hard circle
  return Math.min(1, Math.max(0, a));
}

let _cookie = null;

/** The shared low-beam cookie. Built once; every headlight uses the same texture. */
export function getHeadlightCookie() {
  if (_cookie) return _cookie;
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let j = 0; j < SIZE; j++) {
    const y = ((j + 0.5) / SIZE - 0.5) * 2;
    for (let i = 0; i < SIZE; i++) {
      const x = ((i + 0.5) / SIZE - 0.5) * 2;
      const v = Math.round(beamIntensity(x, y) * 255);
      const o = (j * SIZE + i) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  _cookie = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  _cookie.colorSpace = THREE.SRGBColorSpace;
  _cookie.minFilter = _cookie.magFilter = THREE.LinearFilter;
  // ⚠ CLAMP, not repeat. The cone samples outside 0..1 at its edges; wrapping tiles the beam and
  // paints a second, mirrored headlight pattern around the rim of the cone.
  _cookie.wrapS = _cookie.wrapT = THREE.ClampToEdgeWrapping;
  _cookie.needsUpdate = true;
  _cookie.userData.sharedTexture = true;
  return _cookie;
}
