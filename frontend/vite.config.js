import { defineConfig } from 'vite';
import arraybuffer from 'vite-plugin-arraybuffer';

export default defineConfig({
  plugins: [arraybuffer()],
  server: {
    port: 4040,
  },
  // Prod builds also drop console.log/info/debug (pure → removed during minification). The dev server
  // isn't minified, so console silencing there is handled by the inline script in index.html. warn/error kept.
  esbuild: {
    pure: ['console.log', 'console.info', 'console.debug'],
  },
});
