/**
 * Fake contact shadows — a single InstancedMesh of a soft dark disc laid flat on the ground under
 * cars/people. Grounds everything WITHOUT the real shadow-map pass (which tanked FPS with hundreds of
 * shadow-casters). Usage per frame: begin() → add(...) for each entity → commit().
 */
import * as THREE from 'three';

const YAXIS = new THREE.Vector3(0, 1, 0);

// ── WHY 0.12 AND NOT 0.03 ─────────────────────────────────────────────────────────────────────
// The blob used +0.03, and the ground-layer table says exactly what that buys (groundLayers.js:64):
// the DRAWN asphalt sits at base + 0.07 plus a bump of 0.001-0.009, so a lift measured from the
// road heights value "must exceed ~0.020-0.029 before the paint is above the asphalt at all. A
// '0.03 lift' is really 1-10 mm of clearance, which is what left lane arrows buried wherever the
// surface bumped." The car shadows were losing the same fight — visible on a crosswalk, gone on
// plain asphalt a metre away, which is exactly what the user photographed.
//
// 0.12 clears the whole shipped paint stack (lane lines base+0.100, parking stripes base+0.105,
// crosswalks base+0.095) so the shadow falls ON the paint, which is what a real shadow does. The
// cost of being generous is 12 cm of float, invisible on a soft 4 m disc; the cost of being tight
// is a shadow that flickers in and out over road markings.
const SHADOW_LIFT = 0.12;

// ── DISTANCE CULL ─────────────────────────────────────────────────────────────────────────────
// ⚠ THESE BLOBS USED TO BE FREE BY ACCIDENT. At the old +0.03 lift every one of them was drawn and
// then depth-rejected by the road, so 347 transparent quads cost almost nothing. Lifting them to
// 0.12 made them RENDER — and 347 alpha-blended 2.3x4.5 m quads is real overdraw on a frame the
// project already treats as fill-bound (`?roadv2=0` exists for exactly this reason). The user felt
// it as lag the moment the shadows started working.
//
// The dump showed the waste directly: the first three instances sat 99 m, 140 m and 198 m from the
// camera, paying full blend cost for a soft grey smudge nobody can resolve. A contact shadow's
// whole job is grounding the thing in front of you.
const CULL_M = 70;            // beyond this a 4 m blob is a few pixels of grey
const CULL_FADE_M = 15;       // fade out over the last stretch so cars do not pop a shadow on
const _CULL2 = CULL_M * CULL_M;

/**
 * The soft disc, as a DataTexture rather than a CanvasTexture.
 *
 * ⚠ WHY NOT A CANVAS. Two reasons, and the second is why this changed. (1) The art bible bans
 * `new THREE.CanvasTexture` for any world-render surface (§3.3, "no exceptions, no waivers"); this
 * was one of the 48 remaining sites. (2) A canvas texture has a decode step that can silently
 * produce nothing — and the symptom of that is EXACTLY what was reported: 354 live instances, mesh
 * visible and in the scene, frustum culling off, and no shadow anywhere on screen. Bytes written
 * directly into a DataTexture have no decode step and no failure mode.
 *
 * Same falloff as before: 0.55 at the centre, 0.32 at 60% radius, 0 at the rim.
 */
function softDiscTexture() {
  const S = 64, data = new Uint8Array(S * S * 4);
  const c = (S - 1) / 2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const r = Math.hypot(x - c, y - c) / c;            // 0 at centre, 1 at the inscribed rim
      let a;
      if (r >= 1) a = 0;
      else if (r < 0.6) a = 0.55 + (0.32 - 0.55) * (r / 0.6);
      else a = 0.32 * (1 - (r - 0.6) / 0.4);
      const i = (y * S + x) * 4;
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;      // black ink; alpha carries the shape
      data[i + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;      // a 4 m disc seen from 100 m aliases hard without them
  tex.needsUpdate = true;
  return tex;
}

export function createContactShadows({ scene, capacity = 700 }) {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2); // lie flat
  const mat = new THREE.MeshBasicMaterial({
    map: softDiscTexture(), transparent: true, depthWrite: false, opacity: 0.9,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1; // draw over the road
  mesh.count = 0;
  scene.add(mesh);

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
  let _vx = 0, _vz = 0, _culled = 0;
  let _n = 0, _peak = 0, _overflow = 0, _dropped = 0;

  return {
    /** Viewer position for the distance cull. Call once per frame before the add()s. */
    setViewer(x, z) { _vx = x; _vz = z; },
    begin() { _n = 0; _culled = 0; },
    /** Add a shadow blob at (x,y,z) sized sizeX×sizeZ (m), aligned to yaw. */
    add(x, y, z, sizeX, sizeZ, yaw = 0) {
      if (_n >= capacity) { _dropped++; return; }
      const dx = x - _vx, dz = z - _vz;
      const d2 = dx * dx + dz * dz;
      if (d2 > _CULL2) { _culled++; return; }
      // Shrink to nothing over the last CULL_FADE_M so a shadow grows in rather than popping.
      const d = Math.sqrt(d2);
      const fade = d > CULL_M - CULL_FADE_M ? (CULL_M - d) / CULL_FADE_M : 1;
      sizeX *= fade; sizeZ *= fade;
      _q.setFromAxisAngle(YAXIS, yaw);
      _s.set(sizeX, 1, sizeZ);
      _p.set(x, y + SHADOW_LIFT, z);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(_n++, _m);
    },
    commit() {
      // D-23: `add()` drops silently past capacity, and a blob that was never drawn looks exactly
      // like one drawn too faint — the two need opposite fixes. `peak` is the honest number: if it
      // sits at `capacity` the pool is overflowing and somebody's shadows are missing.
      if (_n > _peak) _peak = _n;
      _overflow = _n >= capacity ? _overflow + 1 : _overflow;
      mesh.count = _n; mesh.instanceMatrix.needsUpdate = true;
    },
    setEnabled(on) { mesh.visible = on; },
    /** window._ddShadowStats() — is anything actually being drawn, and is the pool overflowing? */
    stats() { return { thisFrame: _n, peak: _peak, capacity, framesAtCapacity: _overflow,
                       droppedAdds: _dropped, culledFar: _culled, cullM: CULL_M }; },
    /**
     * window._ddShadowDump() — WHY are 374 submitted instances invisible?
     * stats() proved they are submitted. Count, capacity, lift, coordinate frame and the visible
     * flag are all eliminated by inspection, so what is left is runtime state: the material, and
     * where the matrices actually put the blobs. Prints both, plus the first instance's world
     * position so it can be compared against the camera.
     */
    dump(cameraPos) {
      const m0 = new THREE.Matrix4(), p0 = new THREE.Vector3(), s0 = new THREE.Vector3(), q0 = new THREE.Quaternion();
      const out = {
        count: mesh.count, visible: mesh.visible, inScene: !!mesh.parent,
        renderOrder: mesh.renderOrder, frustumCulled: mesh.frustumCulled,
        material: {
          type: mat.type, transparent: mat.transparent, opacity: mat.opacity,
          depthWrite: mat.depthWrite, depthTest: mat.depthTest,
          visible: mat.visible, colorHex: '#' + mat.color.getHexString(),
          hasMap: !!mat.map, mapImageOk: !!(mat.map && mat.map.image && mat.map.image.width),
          blending: mat.blending, side: mat.side,
        },
        instances: [],
      };
      for (let i = 0; i < Math.min(3, mesh.count); i++) {
        mesh.getMatrixAt(i, m0); m0.decompose(p0, q0, s0);
        const e = { pos: [+p0.x.toFixed(2), +p0.y.toFixed(2), +p0.z.toFixed(2)],
                    scale: [+s0.x.toFixed(2), +s0.y.toFixed(2), +s0.z.toFixed(2)] };
        if (cameraPos) e.distToCam = +p0.distanceTo(cameraPos).toFixed(1);
        out.instances.push(e);
      }
      return out;
    },
    dispose() { scene.remove(mesh); geo.dispose(); mat.dispose(); },
  };
}
