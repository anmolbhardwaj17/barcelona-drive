/**
 * Road infrastructure build smoke test.
 *
 * WHY THIS EXISTS. `buildDirectionBoardMeshes` shipped with `backGeometries` declared in a
 * DIFFERENT function — a scripted edit anchored on `const poleGeometries = [];`, which appears in
 * three builders, and the replacement landed in the first one. Every tile carrying a direction board
 * then died with `ReferenceError: backGeometries is not defined`, taking its roads, buildings and
 * colliders with it: 14 tiles failed to load.
 *
 * Nothing caught it. `vite build` does not resolve identifier scope, and 447 unit tests passed
 * because none of them CALLED this path. That is gotcha H16 — a ReferenceError inside a tile build
 * empties the world silently while the suite stays green.
 *
 * So this test does the one thing that would have caught it: it calls the real builder with data
 * that reaches the board code. It asserts almost nothing about the OUTPUT, on purpose — its whole
 * job is "does this throw".
 *
 * ⚠ VERIFIED TO FAIL WITHOUT THE FIX. The first version of this test used two roads crossing
 * mid-span, produced 0 meshes, and passed identically with the bug present — a test that could
 * never fail is worse than no test (D-23). findIntersections hashes shared ENDPOINTS, so the roads
 * must MEET.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** Minimal 2D-canvas stub — the board texture is drawn, and node has no canvas. */
function installCanvasStub() {
  const ctx = new Proxy({}, {
    get: (_, k) => {
      if (k === 'measureText') return () => ({ width: 40 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (k === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
      if (k === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
      return () => {};
    },
    set: () => true,
  });
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
  globalThis.window = globalThis.window || {};
}

const spoke = (pts, name) => ({
  type: 'primary', highwayType: 'primary', points: pts, name,
  layer: 0, lanes: 4, width: 14, kerbToKerbW: 14,
});

test('a tile with a signed junction builds without throwing', async () => {
  installCanvasStub();
  const { buildRoadInfrastructure } = await import('../src/map/roadInfraRenderer.js');

  // Four spokes MEETING at the origin — a shared endpoint is what makes a junction.
  const roads = [
    spoke([{ x: 0, y: 0 }, { x: 200, y: 0 }], 'Gran Via de les Corts Catalanes'),
    spoke([{ x: 0, y: 0 }, { x: -200, y: 0 }], 'Gran Via de les Corts Catalanes'),
    spoke([{ x: 0, y: 0 }, { x: 0, y: 200 }], 'Carrer de Balmes'),
    spoke([{ x: 0, y: 0 }, { x: 0, y: -200 }], 'Carrer de Balmes'),
  ];
  const junctionSigns = [{
    point: [0, 0],
    exits: [
      { bearing: 45, name: 'Passeig de Gracia', roadType: 'primary', distanceM: 500 },
      { bearing: -120, name: 'Arago', roadType: 'primary', distanceM: 480 },
    ],
  }];

  const res = buildRoadInfrastructure(roads, '16_33161_24477', null, junctionSigns);
  assert.ok(res && Array.isArray(res.meshes), 'returns a mesh list');
  // The guard against the test silently stopping short of the board code, which is exactly how the
  // first attempt fooled itself.
  assert.ok(res.meshes.length > 0, 'the junction actually produced infrastructure — if this is 0 the test proves nothing');
});

test('no junction data still builds', async () => {
  installCanvasStub();
  const { buildRoadInfrastructure } = await import('../src/map/roadInfraRenderer.js');
  const roads = [spoke([{ x: 0, y: 0 }, { x: 100, y: 0 }], 'Carrer Test')];
  assert.doesNotThrow(() => buildRoadInfrastructure(roads, '16_33161_24477', null, null));
});
