import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The driver app had no test setup at all, so anything shipped here was covered
// only by tsc. This is deliberately narrow: plain-TypeScript modules under
// src/services, which is where the offline queues live and where a silent bug
// is most expensive. Component/hook testing would need a React Native renderer
// and is a separate decision.
export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
