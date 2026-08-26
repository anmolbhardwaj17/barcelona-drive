/**
 * The grade's highlight rolloff. Writing to an LDR target clamps each channel INDEPENDENTLY, which
 * changes the ratio between them — and the ratio is the hue. Nothing errors; a saturated frond just
 * quietly turns lime. Only a test catches a regression here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync('src/ui/colorGradePass.js', 'utf8');

test('the grade rolls highlights off instead of letting them clip', () => {
  assert.match(SRC, /KNEE/, 'a knee is defined');
  assert.match(SRC, /rolled \/ peak/, 'the whole triplet is scaled by ONE factor');
  assert.doesNotMatch(SRC, /gl_FragColor = vec4\(max\(c, 0\.0\), col\.a\);/,
    'the bare max() output clipped per-channel at the LDR write');
});

test('the rolloff is hue-preserving by construction', () => {
  // Reimplement the shader maths and check the channel RATIOS survive — that is the whole property.
  const KNEE = 0.85;
  const roll = ([r, g, b]) => {
    const peak = Math.max(r, g, b);
    const over = Math.max(peak - KNEE, 0);
    const t = over / (1 - KNEE);
    const rolled = peak - over + (1 - KNEE) * (t / (1 + t));
    const f = peak > 1e-5 ? rolled / peak : 1;
    return [r * f, g * f, b * f];
  };
  // a saturated yellow-green frond pushed past 1.0 by rally saturation
  const frond = [0.72, 1.48, 0.31];
  const out = roll(frond);
  for (const c of out) assert.ok(c <= 1.0 + 1e-6, `channel ${c} still exceeds 1.0`);
  // ratios preserved to floating-point tolerance
  assert.ok(Math.abs(out[0] / out[1] - frond[0] / frond[1]) < 1e-9, 'R:G ratio (hue) preserved');
  assert.ok(Math.abs(out[2] / out[1] - frond[2] / frond[1]) < 1e-9, 'B:G ratio (hue) preserved');
  // what a per-channel clamp would have done, for contrast
  const clamped = frond.map((c) => Math.min(c, 1));
  const skew = Math.abs((clamped[0] / clamped[1]) / (frond[0] / frond[1]) - 1);
  assert.ok(skew > 0.4, `per-channel clamping shifts R:G by ${(skew * 100).toFixed(0)}% — the bug being fixed`);
});

test('midtones pass through the rolloff untouched', () => {
  const KNEE = 0.85;
  const roll = (c) => {
    const peak = Math.max(...c);
    const over = Math.max(peak - KNEE, 0);
    const t = over / (1 - KNEE);
    const rolled = peak - over + (1 - KNEE) * (t / (1 + t));
    return c.map((x) => x * (peak > 1e-5 ? rolled / peak : 1));
  };
  const mid = [0.42, 0.55, 0.31];
  for (const [i, v] of roll(mid).entries()) assert.equal(v, mid[i], 'below the knee, nothing changes');
});
