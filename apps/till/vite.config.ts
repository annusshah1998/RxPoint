import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tauri loads the dev server from a fixed port.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  // The WebAssembly SQLite used in browser preview mode must not be pre-bundled.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
