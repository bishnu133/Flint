import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Determinism: no watch, stable reporter output.
    reporters: ['default'],
    globals: false,
  },
});
