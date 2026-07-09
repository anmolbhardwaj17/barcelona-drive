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
  build: {
    // Split the big libraries into their own long-cached chunks. Three.js rarely changes, so a returning
    // player who already has it cached skips re-downloading ~half the bundle when we ship app changes; the
    // chunks also fetch in parallel. App code stays in the entry chunk.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/cannon-es')) return 'physics';
          if (id.includes('node_modules')) return 'vendor';
        },
      },
    },
  },
});
