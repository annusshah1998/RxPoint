import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/till/src/**/*.test.{ts,tsx}',
      'scripts/**/*.test.ts',
    ],
    setupFiles: ['./scripts/vitest-setup.ts'],
  },
});
