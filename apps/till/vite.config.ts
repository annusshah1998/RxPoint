import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { devPrinterBridge } from './dev-printer-bridge';

// Tauri loads the dev server from a fixed port.
export default defineConfig({
  // The bridge lets the browser preview print in Network mode (development only).
  plugins: [react(), devPrinterBridge()],
  // When this build was made: the clock guard treats an earlier PC date as wrong.
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
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
