/**
 * Radial blur post-processing pass — blurs only screen edges.
 * Center stays sharp, blur increases toward periphery like a speed vignette.
 * Intensity controlled by `strength` uniform (0 = off, 1 = full).
 */
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

const RadialBlurShader = {
  uniforms: {
    tDiffuse: { value: null },
    strength: { value: 0.0 },    // 0–1, driven by speed
    samples: { value: 12 },      // blur sample count
    innerRadius: { value: 0.12 }, // blur starts closer to center
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
    uniform float strength;
    uniform float samples;
    uniform float innerRadius;
    varying vec2 vUv;

    void main() {
      vec2 center = vec2(0.5);
      vec2 dir = vUv - center;
      float dist = length(dir);

      // Vignette mask: 0 at center, 1 at edges
      // Vignette mask: 0 at center, ramps up toward edges
      float mask = smoothstep(innerRadius, 0.55, dist);
      float blurAmount = mask * strength * 0.15; // visible blur

      if (blurAmount < 0.0005) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }

      // Sample along radial direction from center (zoom blur)
      vec2 blurDir = dir * blurAmount; // use dir directly, not normalized — stronger at edges
      vec4 color = vec4(0.0);
      float total = 0.0;
      for (float i = 0.0; i < 12.0; i++) {
        if (i >= samples) break;
        float t = i / (samples - 1.0); // 0 to 1 — sample outward from pixel
        vec2 sampleUv = vUv - blurDir * t;
        float w = 1.0 - t * 0.6; // center samples weighted more
        color += texture2D(tDiffuse, sampleUv) * w;
        total += w;
      }
      gl_FragColor = color / total;
    }
  `,
};

export function createRadialBlurPass() {
  const pass = new ShaderPass(RadialBlurShader);
  return pass;
}
