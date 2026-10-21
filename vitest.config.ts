import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/till/src/**/*.test.{ts,tsx}'],
    setupFiles: ['./scripts/vitest-setup.ts'],
  },
});
