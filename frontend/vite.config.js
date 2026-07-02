import { defineConfig } from 'vite';
import arraybuffer from 'vite-plugin-arraybuffer';

export default defineConfig({
  plugins: [arraybuffer()],
  server: {
    port: 4040,
  },
});
