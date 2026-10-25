import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import base from './playwright.config';

// Takes the user guide's screenshots (e2e/guide-screenshots.ts) into docs/user-guide/images.
// Run with `pnpm docs:screenshots`; it is not part of the end-to-end tests. It starts its
// own preview server on port 1430 without live reload (vite.guide.config.ts) and keeps
// its traces out of test-results, so it can run while the end-to-end tests do.
export default defineConfig({
  ...base,
  testMatch: 'guide-screenshots.ts',
  outputDir: join(tmpdir(), 'till-guide-screenshots'),
  fullyParallel: false,
  reporter: 'list',
  use: { ...base.use, baseURL: 'http://localhost:1430', actionTimeout: 15_000 },
  webServer: {
    command: 'pnpm exec vite --config vite.guide.config.ts',
    url: 'http://localhost:1430',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
