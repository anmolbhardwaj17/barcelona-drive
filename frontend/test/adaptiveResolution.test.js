/**
 * adaptiveResolution — the controller must verify its OWN lever.
 *
 * Measured on a dense-Eixample drive 2026-08-26: it stepped 1.12 → 1.04 → 0.96 → 0.88 → 0.80, which
 * is 49% fewer pixels shaded, and the long frames stayed at 50-90 ms throughout. Five reallocations
 * cost ~590 ms of hitches, and the cost per resize GREW from 70 ms to 144 ms.
 *
 * The existing GPU_BOUND_SHARE gate was satisfied — the GPU really was busy. But "GPU-bound" is not
 * the same as "FILL-RATE-bound": a frame limited by draw calls and vertex processing shows a busy
 * GPU while being completely indifferent to resolution. These tests pin that lesson.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// The module reads window/location at import time; provide them before importing.
globalThis.window = { devicePixelRatio: 1.12 };
globalThis.location = { search: '' };
const { createAdaptiveResolution } = await import('../src/ui/adaptiveResolution.js');

function harness() {
  const resizes = [];
  const renderer = { setPixelRatio: (s) => resizes.push(s), setSize() {} };
  const composer = { setSize() {}, setPixelRatio() {} };
  const ctl = createAdaptiveResolution(renderer, composer, null, { width: 1280, height: 720 });
  // Sustained SLOW frames with a BUSY GPU — the exact trigger, and the exact trap: the frame never
  // improves however far resolution falls, because the constraint is geometry, not fill rate.
  const feedSlow = (frames) => { for (let i = 0; i < frames; i++) ctl.tick(30 / 1000, 27); };
  return { ctl, resizes, feedSlow };
}

test('a drop that does NOT improve the frame is detected and resolution restored', () => {
  const { ctl, feedSlow } = harness();
  const start = ctl.getScale();
  feedSlow(20000);
  assert.equal(ctl.getScale(), start,
    `settled at ${ctl.getScale()} instead of restoring ${start} — the controller kept paying ` +
    '~120ms reallocations for a lever that measurably does nothing');
});

test('reallocations are BOUNDED under sustained load', () => {
  const { resizes, feedSlow } = harness();
  const before = resizes.length;
  feedSlow(20000);
  const during = resizes.length - before;
  // At the measured 70-144 ms each, unbounded stepping is what burnt ~590 ms in a single drive.
  assert.ok(during <= 8,
    `${during} reallocations under sustained load ≈ ${during * 120}ms of self-inflicted hitches`);
});

test('a drop that DOES improve the frame keeps resolution as a live lever', () => {
  // The controller must not over-learn: when cutting pixels genuinely helps, it should keep cutting.
  globalThis.location = { search: '' };
  const resizes = [];
  const renderer = { setPixelRatio: (s) => resizes.push(s), setSize() {} };
  const composer = { setSize() {}, setPixelRatio() {} };
  const ctl = createAdaptiveResolution(renderer, composer, null, { width: 1280, height: 720 });
  const start = ctl.getScale();
  // Frame time falls as resolution falls — a real fill-rate-bound scene.
  for (let i = 0; i < 20000; i++) {
    const ms = 18 + (ctl.getScale() - 0.8) * 40;   // faster as scale drops
    ctl.tick(ms / 1000, ms * 0.9);
  }
  assert.ok(ctl.getScale() < start,
    'resolution never dropped even though dropping it demonstrably helped — the lockout is too eager');
});
