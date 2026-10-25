import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';

// For the user guide's screenshots: its own port, and no live reload, so an edit saved
// while the screenshots are being taken doesn't reload the page and log the till out.
export default mergeConfig(base, defineConfig({ server: { port: 1430, hmr: false } }));
