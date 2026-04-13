import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Vitest config scoped to the unit-test corner of the web app.
// Tests run under Node with happy-dom disabled (we're only exercising
// pure helpers + permission logic right now, not component rendering).
// Full component testing via @testing-library/react lands in a later
// phase when we have Playwright e2e covering the interactive flows.

export default defineConfig({
  test: {
    environment: 'node',
    include: ['app/dashboard/_lib/**/*.test.ts', 'app/dashboard/_ui/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**', '**/e2e/**'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['app/dashboard/_lib/**/*.ts', 'app/dashboard/_ui/**/*.{ts,tsx}'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
