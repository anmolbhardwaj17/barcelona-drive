import { defineConfig } from 'vite';
import arraybuffer from 'vite-plugin-arraybuffer';

export default defineConfig({
  plugins: [arraybuffer()],
  server: {
    port: 4040,
  },
  // Strip all status/debug logging from the console (dev + build). console.log/info/debug are marked
  // pure → esbuild drops them since their return value is unused. console.warn/error are kept so real
  // problems still surface. Reversible: delete `pure` to bring the source logs back.
  esbuild: {
    pure: ['console.log', 'console.info', 'console.debug'],
  },
});
