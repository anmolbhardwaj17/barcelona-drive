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

const ColorGradeShader = {
  uniforms: {
    tDiffuse:       { value: null },
    uGradeStrength: { value: 1.0 }, // 0=neutral, 1=default grade, scalable
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
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      vec3 c = col.rgb;
      float s = uGradeStrength;

      // 1. Saturation — richer streets (city read a bit flat/grey).
      float l0 = luma(c);
      c = mix(c, mix(vec3(l0), c, 1.15), s);

      // 2. Gentle contrast S-curve around a linear mid pivot — adds punch without crushing.
      const float pivot = 0.18;
      c = mix(c, (c - pivot) * 1.06 + pivot, s);

      // 3. Cinematic split-tone: warm golden highlights, faintly cool/teal shadows.
      float l1 = luma(c);
      vec3 warm = vec3(1.045, 1.01, 0.95);   // Barcelona afternoon (gentle warmth)
      vec3 cool = vec3(0.98, 1.00, 1.03);
      vec3 tone = mix(cool, warm, smoothstep(0.12, 0.65, l1));
      c *= mix(vec3(1.0), tone, s);

      // 4. Lift blacks so shadows stay open/readable (Mediterranean bounce light) — no crushed darks.
      c = mix(c, c * 0.965 + 0.024, s);

      // 5. Vignette — subtle, draws focus to the road ahead without darkening the scene.
      float dist = length(vUv - vec2(0.5));
      float vignette = 1.0 - smoothstep(0.36, 0.82, dist) * 0.15 * s;
      c *= vignette;

      gl_FragColor = vec4(max(c, 0.0), col.a);
    }
  `,
};

export function createColorGradePass() {
  return new ShaderPass(ColorGradeShader);
}
