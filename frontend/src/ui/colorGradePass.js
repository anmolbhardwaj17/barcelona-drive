/**
 * ColorGradePass — analytic filmic grade: saturation + contrast S-curve + warm/cool split-tone + vignette.
 * No LUT file required. All math runs in linear-light space, before OutputPass gamma.
 *
 * Tune live in DevTools:
 *   window._colorGradePass.uniforms.uGradeStrength.value = 0    // pass-through (neutral)
 *   window._colorGradePass.uniforms.uGradeStrength.value = 1    // default cinematic grade
 *   window._colorGradePass.uniforms.uGradeStrength.value = 0.6  // subtler
 *   window._colorGradePass.uniforms.uGradeStrength.value = 1.6  // punchier
 */
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { isRallyStyle } from '../rallyStyle.js';

const ColorGradeShader = {
  uniforms: {
    tDiffuse:       { value: null },
    uGradeStrength: { value: 1.0 }, // 0=neutral, 1=default grade, scalable
    uRally:         { value: 0.0 }, // 1 = art-of-rally vivid/bright grade
    uNight:         { value: 0.0 }, // 1 = night: kill the black-lift + high-key brighten (they grey-wash the dark)
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uGradeStrength;
    uniform float uRally;
    uniform float uNight;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      vec3 c = col.rgb;
      float s = uGradeStrength;

      // 1. Saturation — RICHER streets (1.15); rally style is VIVID (art of rally is bright + saturated,
      //    NOT muted — the earlier "cohesive muted palette" was exactly backwards).
      //    NIGHT: keep saturation — the reference night is RICH saturated navy + warm amber, never
      //    grey. The night look comes from the blue light rig + the hue shift below, not from desat.
      float l0 = luma(c);
      float satAmt = mix(1.15, 1.52, uRally);   // a touch richer — counters ACES desaturating the highlights
      satAmt = mix(satAmt, 1.05, uNight * (1.0 - smoothstep(0.22, 0.65, l0)));
      c = mix(c, mix(vec3(l0), c, satAmt), s);

      // 2. Gentle contrast S-curve.
      const float pivot = 0.18;
      float con = mix(1.06, 1.03, uRally);
      c = mix(c, (c - pivot) * con + pivot, s);

      // 3. Split-tone: warm highlights, faintly cool shadows (kept gentle in rally so it stays bright).
      //    NIGHT: the warm side leans hard amber — everything a lamp or window touches glows warm
      //    against the blue (the warm-vs-cool contrast IS the reference night look).
      float l1 = luma(c);
      vec3 warm = mix(vec3(1.045, 1.01, 0.95), vec3(1.14, 1.02, 0.85), uNight);
      vec3 cool = vec3(0.98, 1.00, 1.03);
      vec3 tone = mix(cool, warm, smoothstep(0.12, 0.65, l1));
      c *= mix(vec3(1.0), tone, s);

      // 3b. Night: pull shadows/mids toward deep blue (low-poly cinematic night reference) —
      //     highlights untouched so streetlamp pools / lit windows stay warm against it.
      //     Gentle: this is a HUE shift, not a darkener (the R crush at 0.80 was eating the frame).
      vec3 nightCool = c * vec3(0.90, 0.95, 1.10);
      c = mix(c, nightCool, uNight * (1.0 - smoothstep(0.30, 0.75, l1)) * s * 0.8);

      // 4. Lift blacks — keep MINIMAL so shadows stay deep. A bigger lift (even 0.055 at night) reads as a
      //    flat grey haze layer over the whole frame — never do that. Brightness comes from real light
      //    (ambient/hemi), not a global additive. None at night.
      c = mix(c, c * 0.985 + mix(0.024, 0.018, uRally) * (1.0 - uNight), s);

      // 5. High-key brighten — a gentle airy lift by DAY. Kept modest (was 1.14 → washed the frame flat/faded
      //    under ACES); at night it only greyed the deep shadows, so killed there.
      c *= mix(1.0, 1.06, uRally * s * (1.0 - uNight));

      // 6. Vignette — subtle by default; rally keeps it minimal so the frame stays open + bright.
      //    Night leans darker at the edges (the reference renders vignette hard into near-black).
      float dist = length(vUv - vec2(0.5));
      float vignette = 1.0 - smoothstep(0.36, 0.82, dist) * (mix(0.15, 0.05, uRally) + uNight * 0.14) * s;
      c *= vignette;

      gl_FragColor = vec4(max(c, 0.0), col.a);
    }
  `,
};

export function createColorGradePass() {
  const pass = new ShaderPass(ColorGradeShader);
  if (isRallyStyle()) pass.uniforms.uRally.value = 1.0;
  return pass;
}
