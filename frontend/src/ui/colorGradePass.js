/**
 * ColorGradePass — analytic warm grade + screen-edge vignette.
 * No LUT file required. All math runs in linear-light space, before OutputPass gamma.
 *
 * Tune live in DevTools:
 *   window._colorGradePass.uniforms.uGradeStrength.value = 0  // pass-through
 *   window._colorGradePass.uniforms.uGradeStrength.value = 1  // default (R+6%/G+2%/B-6%)
 *   window._colorGradePass.uniforms.uGradeStrength.value = 2  // double warm shift
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

    void main() {
      vec4 col = texture2D(tDiffuse, vUv);

      // Warm grade: R+6%, G+2%, B-6% at strength=1 — Barcelona golden afternoon
      vec3 grade = mix(vec3(1.0), vec3(1.06, 1.02, 0.94), uGradeStrength);
      col.rgb *= grade;

      // Shadow lift: prevents pure blacks, matches Mediterranean midday ambient
      vec3 lifted = col.rgb * 0.97 + 0.015;
      col.rgb = mix(col.rgb, lifted, uGradeStrength);

      // Vignette: 0% at center, 18% max at corners, smooth cubic falloff
      float dist = length(vUv - vec2(0.5));
      float vignette = 1.0 - smoothstep(0.38, 0.75, dist) * 0.18;
      col.rgb *= vignette;

      gl_FragColor = col;
    }
  `,
};

export function createColorGradePass() {
  return new ShaderPass(ColorGradeShader);
}
